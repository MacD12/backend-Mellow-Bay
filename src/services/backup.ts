// ─────────────────────────────────────────────────────────────
// Backups.
//
// The whole property is one SQLite file, which makes a good backup cheap — but
// only if three things are true, and this module enforces all three:
//
//   1. It is taken while the system is running, without blocking the front desk.
//      `VACUUM INTO` writes a compacted copy from a read transaction; in WAL
//      mode readers do not block the writer.
//   2. It is verified after writing. An unverified backup is not a backup, so
//      every snapshot is reopened, integrity-checked, and read from before it
//      is recorded as good.
//   3. Somebody notices when it stops working. A stale or failed backup raises
//      a notification rather than sitting quietly in a table.
// ─────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run, database, DB_PATH, jsonCol } from '../db.ts';
import { id, nowIso, HttpError } from '../lib/util.ts';
import { config } from '../config.ts';

/** Where snapshots are written — outside the database directory by default. */
export const BACKUP_DIR = config.backupDir;

export const BACKUP_ENABLED = config.backupEnabled;
export const BACKUP_INTERVAL_HOURS = config.backupIntervalHours;

/** A backup older than this is treated as a problem worth shouting about. */
const STALE_AFTER_HOURS = Math.max(24, BACKUP_INTERVAL_HOURS * 4);

// Retention: everything recent, thinning out with age.
const KEEP_LAST = 4;         // always keep the most recent few, whatever their age
const KEEP_DAILY = 7;        // one per day for a week
const KEEP_WEEKLY = 4;       // one per week for a month
const KEEP_MONTHLY = 6;      // one per month for half a year

export type BackupReason = 'scheduled' | 'night-audit' | 'manual' | 'pre-restore';

export interface BackupRow {
  id: string; filename: string; path: string;
  started_at: string; finished_at: string | null; duration_ms: number;
  size_bytes: number; source_size_bytes: number;
  status: string; verification: string | null; row_checks: string | null;
  reason: string; triggered_by: string | null; error: string | null; pruned_at: string | null;
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/** Source size counts the WAL too — that is data not yet in the main file. */
function sourceSize(): number {
  return fileSize(DB_PATH) + fileSize(`${DB_PATH}-wal`);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

/**
 * Take a snapshot, verify it, record it, prune old ones.
 * Never throws for an operational failure — a failed backup is recorded as
 * failed and reported, because a backup crashing the process would be worse
 * than a backup that did not happen.
 */
export function runBackup(
  reason: BackupReason,
  triggeredBy?: string,
): BackupRow {
  mkdirSync(BACKUP_DIR, { recursive: true });

  const backupId = id('bak');
  const filename = `helio-${stamp()}-${reason}.db`;
  const path = join(BACKUP_DIR, filename);
  const started = Date.now();

  run(
    `INSERT INTO backups(id, filename, path, started_at, source_size_bytes, status, reason, triggered_by)
     VALUES(?,?,?,?,?,'running',?,?)`,
    backupId, filename, path, nowIso(), sourceSize(), reason, triggeredBy ?? null,
  );

  try {
    // Fold the WAL into the main database first, so the copy is complete and
    // the snapshot does not silently omit recent commits.
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    // A single statement, from a read transaction: writers keep working.
    // The copy comes out defragmented and smaller than the live file.
    database.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

    const verification = verifyBackupFile(path);
    const durationMs = Date.now() - started;

    run(
      `UPDATE backups SET finished_at = ?, duration_ms = ?, size_bytes = ?,
              status = ?, verification = ?, row_checks = ?, error = ?
        WHERE id = ?`,
      nowIso(), durationMs, fileSize(path),
      verification.ok ? 'verified' : 'failed',
      verification.integrity, jsonCol(verification.counts),
      verification.ok ? null : verification.error, backupId,
    );

    if (!verification.ok) {
      notify('Backup failed verification',
        `${filename} was written but did not verify: ${verification.error}`, 'critical');
    }

    prune();
    return get<BackupRow>('SELECT * FROM backups WHERE id = ?', backupId)!;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    run(
      `UPDATE backups SET finished_at = ?, duration_ms = ?, status = 'failed', error = ?
        WHERE id = ?`,
      nowIso(), Date.now() - started, message, backupId,
    );
    try { rmSync(path, { force: true }); } catch { /* nothing to remove */ }
    notify('Backup failed', `Could not write ${filename}: ${message}`, 'critical');
    return get<BackupRow>('SELECT * FROM backups WHERE id = ?', backupId)!;
  }
}

/**
 * Reopen a snapshot and prove it is usable: structurally sound, foreign keys
 * intact, and its core tables actually readable.
 */
export function verifyBackupFile(path: string): {
  ok: boolean; integrity: string; counts: Record<string, number>; error?: string;
} {
  if (!existsSync(path)) {
    return { ok: false, integrity: 'missing', counts: {}, error: 'Backup file is not on disk' };
  }
  let copy: DatabaseSync | null = null;
  try {
    copy = new DatabaseSync(path, { readOnly: true });
    const integrity = String(Object.values(copy.prepare('PRAGMA integrity_check').get() ?? {})[0]);
    const fkRows = copy.prepare('PRAGMA foreign_key_check').all();

    // Reading the tables that carry the money and the inventory is the real
    // test — a file can pass integrity_check and still be the wrong file.
    const counts: Record<string, number> = {};
    for (const table of ['properties', 'reservations', 'reservation_nights', 'folio_lines', 'rooms', 'users']) {
      const row = copy.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      counts[table] = row.n;
    }

    const ok = integrity === 'ok' && fkRows.length === 0 && counts.properties > 0;
    return {
      ok,
      integrity,
      counts,
      error: ok
        ? undefined
        : integrity !== 'ok' ? `integrity_check: ${integrity}`
          : fkRows.length ? `${fkRows.length} foreign key violation(s)`
            : 'No property found in the backup',
    };
  } catch (e) {
    return {
      ok: false, integrity: 'unreadable', counts: {},
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    try { copy?.close(); } catch { /* already closed */ }
  }
}

/** Re-verify a snapshot already on disk, and update its record. */
export function reverify(backupId: string): BackupRow {
  const row = get<BackupRow>('SELECT * FROM backups WHERE id = ?', backupId);
  if (!row) throw new HttpError(404, 'Backup not found');
  const result = verifyBackupFile(row.path);
  run(
    `UPDATE backups SET status = ?, verification = ?, row_checks = ?, error = ?, size_bytes = ?
      WHERE id = ?`,
    result.ok ? 'verified' : 'failed', result.integrity, jsonCol(result.counts),
    result.ok ? null : result.error, fileSize(row.path), backupId,
  );
  return get<BackupRow>('SELECT * FROM backups WHERE id = ?', backupId)!;
}

/**
 * Thin out old snapshots: keep everything recent, then one a day, one a week,
 * one a month. Failed snapshots are removed once a later one has verified —
 * keeping a broken file helps nobody.
 */
export function prune(): { removed: number; kept: number } {
  const rows = all<BackupRow>(
    `SELECT * FROM backups WHERE pruned_at IS NULL ORDER BY started_at DESC`);
  const keep = new Set<string>();
  const verified = rows.filter((r) => r.status === 'verified');

  verified.slice(0, KEEP_LAST).forEach((r) => keep.add(r.id));

  const seen = { day: new Set<string>(), week: new Set<string>(), month: new Set<string>() };
  const now = Date.now();
  for (const row of verified) {
    const d = new Date(row.started_at);
    const ageDays = (now - d.getTime()) / 86_400_000;
    const dayKey = row.started_at.slice(0, 10);
    const weekKey = `${d.getUTCFullYear()}-W${Math.floor(d.getUTCDate() / 7)}-${d.getUTCMonth()}`;
    const monthKey = row.started_at.slice(0, 7);

    if (ageDays <= KEEP_DAILY && !seen.day.has(dayKey)) { seen.day.add(dayKey); keep.add(row.id); }
    else if (ageDays <= KEEP_WEEKLY * 7 && !seen.week.has(weekKey)) { seen.week.add(weekKey); keep.add(row.id); }
    else if (ageDays <= KEEP_MONTHLY * 31 && !seen.month.has(monthKey)) { seen.month.add(monthKey); keep.add(row.id); }
  }

  // Hold on to the most recent failure as evidence, unless a later one worked.
  const newestFailure = rows.find((r) => r.status === 'failed');
  if (newestFailure && (!verified[0] || newestFailure.started_at > verified[0].started_at)) {
    keep.add(newestFailure.id);
  }

  let removed = 0;
  for (const row of rows) {
    if (keep.has(row.id)) continue;
    // Never delete a snapshot that has not reached a final state. A row still
    // marked `running` is either in flight right now, or is the artifact a
    // restore always leaves behind — deleting either destroys a good backup.
    if (row.status === 'running') continue;
    try { rmSync(row.path, { force: true }); } catch { /* already gone */ }
    run('UPDATE backups SET pruned_at = ? WHERE id = ?', nowIso(), row.id);
    removed++;
  }
  return { removed, kept: keep.size };
}

/** Everything the operator needs to know at a glance. */
export function backupStatus() {
  const last = get<BackupRow>(
    `SELECT * FROM backups WHERE status = 'verified' AND pruned_at IS NULL
      ORDER BY started_at DESC LIMIT 1`);
  const lastAttempt = get<BackupRow>('SELECT * FROM backups ORDER BY started_at DESC LIMIT 1');
  const onDisk = all<BackupRow>(
    `SELECT * FROM backups WHERE pruned_at IS NULL ORDER BY started_at DESC`);
  const failures = all<BackupRow>(
    `SELECT * FROM backups WHERE status = 'failed' AND pruned_at IS NULL`).length;

  const ageHours = last ? (Date.now() - Date.parse(last.started_at)) / 3_600_000 : null;
  const stale = ageHours === null || ageHours > STALE_AFTER_HOURS;

  return {
    enabled: BACKUP_ENABLED,
    directory: BACKUP_DIR,
    intervalHours: BACKUP_INTERVAL_HOURS,
    staleAfterHours: STALE_AFTER_HOURS,
    lastGood: last
      ? {
        id: last.id, filename: last.filename, at: last.started_at,
        sizeBytes: last.size_bytes, durationMs: last.duration_ms, reason: last.reason,
      }
      : null,
    lastAttempt: lastAttempt
      ? { id: lastAttempt.id, at: lastAttempt.started_at, status: lastAttempt.status, error: lastAttempt.error }
      : null,
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    stale,
    // `health` answers one question only: is the data protected right now?
    // Whether the *schedule* is running is a separate fact — a manual backup
    // taken ten minutes ago protects the data whether or not automation is on,
    // and an enabled schedule that has never produced a good snapshot protects
    // nothing. Conflating the two hides both problems.
    health: !last ? 'never-run'
      : stale ? 'stale'
        : failures > 0 ? 'degraded' : 'healthy',
    scheduleEnabled: BACKUP_ENABLED,
    // True when someone should act: no protection, or automation silently off.
    needsAttention: !last || stale || !BACKUP_ENABLED,
    snapshotsOnDisk: onDisk.length,
    totalBytes: onDisk.reduce((s, r) => s + r.size_bytes, 0),
    failures,
    sourceBytes: sourceSize(),
    retention: { last: KEEP_LAST, daily: KEEP_DAILY, weekly: KEEP_WEEKLY, monthly: KEEP_MONTHLY },
  };
}

export function listBackups(limit = 50) {
  return all<BackupRow>(
    `SELECT * FROM backups WHERE pruned_at IS NULL ORDER BY started_at DESC LIMIT ?`, limit,
  ).map((r) => ({
    id: r.id, filename: r.filename, path: r.path, at: r.started_at,
    finishedAt: r.finished_at, durationMs: r.duration_ms,
    sizeBytes: r.size_bytes, sourceBytes: r.source_size_bytes,
    status: r.status, verification: r.verification, reason: r.reason,
    triggeredBy: r.triggered_by, error: r.error,
    rowChecks: r.row_checks ? JSON.parse(r.row_checks) : null,
    onDisk: existsSync(r.path),
  }));
}

export function deleteBackup(backupId: string) {
  const row = get<BackupRow>('SELECT * FROM backups WHERE id = ?', backupId);
  if (!row) throw new HttpError(404, 'Backup not found');
  try { rmSync(row.path, { force: true }); } catch { /* already gone */ }
  run('UPDATE backups SET pruned_at = ? WHERE id = ?', nowIso(), backupId);
  return { ok: true };
}

/** Snapshots present on disk that this database has no record of. */
export function orphanedFiles(): string[] {
  if (!existsSync(BACKUP_DIR)) return [];
  const known = new Set(all<{ filename: string }>('SELECT filename FROM backups').map((r) => r.filename));
  return readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db') && !known.has(f));
}

/**
 * Bring the backup table back in line with what is actually on disk.
 *
 * Two situations need this, and both are normal rather than exceptional:
 *
 *   · A snapshot can never contain its own completion record — the file is
 *     written before the row is marked verified. So a restored database always
 *     has one backup stuck at `running`. The same is true after a crash
 *     mid-backup.
 *   · A restored database knows nothing about snapshots taken after the one it
 *     came from, even though they are sitting in the directory. Without this,
 *     "no backups" would be reported while several were on disk.
 */
export function reconcileBackups(): { resolved: number; adopted: number } {
  let resolved = 0;
  let adopted = 0;

  for (const row of all<BackupRow>(`SELECT * FROM backups WHERE status = 'running'`)) {
    // A file that is simply not there any more was pruned or moved — that is
    // housekeeping, not a failure, and recording it as failed would raise a
    // false alarm.
    if (!existsSync(row.path)) {
      run(`UPDATE backups SET pruned_at = ?, status = 'failed',
                  error = 'File is no longer on disk' WHERE id = ?`,
        nowIso(), row.id);
      resolved++;
      continue;
    }
    const result = verifyBackupFile(row.path);
    run(
      `UPDATE backups SET status = ?, verification = ?, row_checks = ?, error = ?,
              size_bytes = ?, finished_at = COALESCE(finished_at, ?)
        WHERE id = ?`,
      result.ok ? 'verified' : 'failed', result.integrity, jsonCol(result.counts),
      result.ok ? null : (result.error ?? 'Interrupted before it finished'),
      fileSize(row.path), nowIso(), row.id,
    );
    resolved++;
  }

  for (const filename of orphanedFiles()) {
    const path = join(BACKUP_DIR, filename);
    const result = verifyBackupFile(path);
    let started: string;
    try {
      started = statSync(path).mtime.toISOString();
    } catch {
      continue;
    }
    // The reason is recoverable from the filename this module generates.
    const reason = /-(scheduled|night-audit|manual|pre-restore)\.db$/.exec(filename)?.[1] ?? 'manual';
    run(
      `INSERT INTO backups(id, filename, path, started_at, finished_at, size_bytes,
                           status, verification, row_checks, reason, triggered_by, error)
       VALUES(?,?,?,?,?,?,?,?,?,?,'adopted-from-disk',?)`,
      id('bak'), filename, path, started, started, fileSize(path),
      result.ok ? 'verified' : 'failed', result.integrity, jsonCol(result.counts),
      reason, result.ok ? null : result.error,
    );
    adopted++;
  }

  return { resolved, adopted };
}

// ─── Scheduling ──────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the schedule. Runs one backup shortly after boot so a fresh
 * installation is protected immediately rather than in six hours.
 */
export function startBackupSchedule() {
  // Always reconcile, even when the schedule is off — the table should reflect
  // the directory either way.
  try {
    reconcileBackups();
  } catch (e) {
    process.stderr.write(`[backup] reconcile failed: ${e}\n`);
  }
  if (!BACKUP_ENABLED || timer) return;

  const intervalMs = Math.max(1, BACKUP_INTERVAL_HOURS) * 3_600_000;
  setTimeout(() => {
    const status = backupStatus();
    if (status.stale) runBackup('scheduled', 'schedule');
  }, 30_000).unref();

  timer = setInterval(() => {
    try {
      runBackup('scheduled', 'schedule');
    } catch (e) {
      process.stderr.write(`[backup] scheduled run failed: ${e}\n`);
    }
  }, intervalMs);
  timer.unref();
}

export function stopBackupSchedule() {
  if (timer) { clearInterval(timer); timer = null; }
}

// ─── Notifications ───────────────────────────────────────────
function notify(title: string, message: string, severity: 'info' | 'warn' | 'critical') {
  // Raise against every property — a backup covers all of them.
  for (const p of all<{ id: string }>('SELECT id FROM properties WHERE active = 1')) {
    run(
      `INSERT INTO notifications(id, property_id, ts, title, message, source, severity)
       VALUES(?,?,?,?,?,'Backup',?)`,
      id('ntf'), p.id, nowIso(), title, message, severity,
    );
  }
}

/** Called by the night audit; also surfaces a stale-backup warning. */
export function backupAfterNightAudit(triggeredBy: string) {
  if (!BACKUP_ENABLED) return null;
  const result = runBackup('night-audit', triggeredBy);
  const status = backupStatus();
  if (status.health === 'stale' || status.health === 'never-run') {
    notify('Backups are not running',
      `The last verified backup is ${status.ageHours ?? '—'} hours old.`, 'critical');
  }
  return result;
}
