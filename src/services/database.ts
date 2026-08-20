// ─────────────────────────────────────────────────────────────
// Database health and maintenance.
//
// SQLite asks for very little, but the little it asks for is not optional:
//
//   integrity_check     silent corruption is the failure mode that matters.
//                       A bad page does not raise an error — it returns a
//                       wrong number, and a wrong number in a folio is money.
//   foreign_key_check   `PRAGMA foreign_keys = ON` only guards new writes; it
//                       says nothing about rows written before it was set or
//                       imported from elsewhere.
//   ANALYZE             the query planner guesses without statistics. On a
//                       small database the guesses are right. They stop being
//                       right somewhere between "demo" and "second season".
//   checkpoint/VACUUM   WAL grows, deleted rows leave free pages. Neither is
//                       reclaimed on its own.
//
// Everything here is safe to run on a live system except `vacuum`, which
// rewrites the file and holds a write lock; that one says so.
// ─────────────────────────────────────────────────────────────
import { all, get, run, scalar, database, DB_PATH } from '../db.ts';
import { statSync } from 'node:fs';
import { id, nowIso, HttpError } from '../lib/util.ts';

/** Tables whose row counts are worth watching as the business runs. */
const WATCHED = [
  'reservations', 'reservation_nights', 'folio_lines', 'folios', 'profiles',
  'rate_calendar', 'audit_log', 'daily_stats', 'notifications', 'messages',
  'channel_sync_log', 'login_attempts', 'sessions', 'backups',
];

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function pragma<T = number>(name: string): T {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, T> | undefined;
  return row ? Object.values(row)[0] : (0 as unknown as T);
}

// ─── Health report ───────────────────────────────────────────

export interface TableSize { name: string; rows: number; indexes: number }

export function databaseHealth() {
  const pageSize = pragma('page_size');
  const pageCount = pragma('page_count');
  const freePages = pragma('freelist_count');

  const tables: TableSize[] = [];
  for (const name of WATCHED) {
    // A table can be missing on an installation that predates it.
    try {
      tables.push({
        name,
        rows: scalar<number>(`SELECT count(*) AS n FROM "${name}"`),
        indexes: all(`PRAGMA index_list("${name}")`).length,
      });
    } catch { /* table not present in this schema version */ }
  }

  const walBytes = fileSize(`${DB_PATH}-wal`);
  const fileBytes = fileSize(DB_PATH);
  const freeBytes = freePages * pageSize;

  const last = lastCheck();

  return {
    path: DB_PATH,
    fileBytes,
    walBytes,
    pageSize,
    pageCount,
    freePages,
    freeBytes,
    // Wasted space only matters as a proportion — 2 MB of slack in a 2 GB file
    // is nothing, the same 2 MB in a 4 MB file means half the reads are air.
    freePercent: pageCount ? Math.round((freePages / pageCount) * 100) : 0,
    journalMode: pragma<string>('journal_mode'),
    synchronous: pragma<number>('synchronous'),
    foreignKeys: pragma<number>('foreign_keys') === 1,
    busyTimeoutMs: pragma<number>('busy_timeout'),
    autoVacuum: pragma<number>('auto_vacuum'),
    cacheSize: pragma<number>('cache_size'),
    schemaVersion: get<{ value: string }>(
      `SELECT value FROM schema_meta WHERE key = 'version'`)?.value ?? '?',
    indexCount: scalar<number>(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`),
    tableCount: scalar<number>(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`),
    hasStatistics: scalar<number>(
      `SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'`) > 0,
    tables: tables.sort((a, b) => b.rows - a.rows),
    lastCheck: last,
    // WAL is checkpointed automatically at 1000 pages; a WAL that has grown far
    // past the main file means checkpoints are not completing.
    walOversized: walBytes > Math.max(16 * 1024 * 1024, fileBytes),
    needsVacuum: pageCount > 5000 && freePages / pageCount > 0.25,
    needsAnalyze: scalar<number>(
      `SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'`) === 0,
  };
}

// ─── Integrity ───────────────────────────────────────────────

export interface CheckResult {
  id: string;
  at: string;
  durationMs: number;
  ok: boolean;
  integrity: string;
  foreignKeyViolations: Array<{ table: string; rowid: number; parent: string }>;
  triggeredBy: string;
}

/**
 * Run both structural checks and record the result.
 *
 * `integrity_check` reads every page, so it is not free — on a database this
 * size it is milliseconds, and it is the only thing standing between a bad
 * disk and a wrong invoice.
 */
export function runIntegrityCheck(triggeredBy: string): CheckResult {
  const started = Date.now();

  const integrityRows = all<Record<string, string>>('PRAGMA integrity_check');
  const integrity = integrityRows.map((r) => Object.values(r)[0]).join('; ') || 'ok';

  const fkRows = all<any>('PRAGMA foreign_key_check');
  const foreignKeyViolations = fkRows.map((r) => ({
    table: String(r.table ?? r['table'] ?? '?'),
    rowid: Number(r.rowid ?? 0),
    parent: String(r.parent ?? '?'),
  }));

  const ok = integrity === 'ok' && foreignKeyViolations.length === 0;
  const result: CheckResult = {
    id: id('chk'),
    at: nowIso(),
    durationMs: Date.now() - started,
    ok,
    integrity,
    foreignKeyViolations,
    triggeredBy,
  };

  run(
    `INSERT INTO db_checks(id, at, duration_ms, ok, integrity, fk_violations, triggered_by)
     VALUES(?,?,?,?,?,?,?)`,
    result.id, result.at, result.durationMs, ok ? 1 : 0, integrity,
    JSON.stringify(foreignKeyViolations), triggeredBy,
  );

  if (!ok) {
    // Corruption is not something to leave in a table for somebody to find.
    for (const p of all<{ id: string }>('SELECT id FROM properties WHERE active = 1')) {
      run(
        `INSERT INTO notifications(id, property_id, ts, title, message, source, severity)
         VALUES(?,?,?,?,?,'Database','critical')`,
        id('ntf'), p.id, result.at,
        'Database integrity check FAILED',
        integrity !== 'ok'
          ? `SQLite reports: ${integrity.slice(0, 400)}. Restore from the most recent verified backup.`
          : `${foreignKeyViolations.length} foreign key violation(s) found. `
            + 'Records reference rows that no longer exist.',
      );
    }
  }

  // Keep a year of results; they are one row each.
  run(`DELETE FROM db_checks WHERE at < date('now', '-365 days')`);

  return result;
}

export function lastCheck(): CheckResult | null {
  const row = get<any>('SELECT * FROM db_checks ORDER BY at DESC LIMIT 1');
  if (!row) return null;
  return {
    id: row.id,
    at: row.at,
    durationMs: row.duration_ms,
    ok: row.ok === 1,
    integrity: row.integrity,
    foreignKeyViolations: JSON.parse(row.fk_violations || '[]'),
    triggeredBy: row.triggered_by,
  };
}

export function checkHistory(limit = 20): CheckResult[] {
  return all<any>('SELECT * FROM db_checks ORDER BY at DESC LIMIT ?', limit).map((row) => ({
    id: row.id,
    at: row.at,
    durationMs: row.duration_ms,
    ok: row.ok === 1,
    integrity: row.integrity,
    foreignKeyViolations: JSON.parse(row.fk_violations || '[]'),
    triggeredBy: row.triggered_by,
  }));
}

// ─── Maintenance ─────────────────────────────────────────────

export type MaintenanceAction = 'analyze' | 'checkpoint' | 'vacuum' | 'optimize';

export function runMaintenance(action: MaintenanceAction, triggeredBy: string) {
  const started = Date.now();
  const before = { pageCount: pragma<number>('page_count'), free: pragma<number>('freelist_count') };
  const walBefore = fileSize(`${DB_PATH}-wal`);
  const fileBefore = fileSize(DB_PATH);
  let detail = '';

  switch (action) {
    case 'analyze':
      // Gathers the statistics the planner uses to choose between indexes.
      database.exec('ANALYZE');
      detail = 'Query planner statistics rebuilt';
      break;

    case 'optimize':
      // The recommended routine call: ANALYZE, but only for tables where it
      // would actually change anything.
      database.exec('PRAGMA optimize');
      detail = 'Statistics refreshed where they were out of date';
      break;

    case 'checkpoint': {
      // TRUNCATE moves everything into the main file and resets the WAL to
      // zero. It waits for readers rather than forcing them out.
      const row = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as any;
      const walAfter = fileSize(`${DB_PATH}-wal`);
      detail = row?.busy === 1
        ? 'A reader was active — the WAL was checkpointed but not truncated'
        : `WAL reset (${Math.round((walBefore - walAfter) / 1024)} KB moved into the database)`;
      break;
    }

    case 'vacuum':
      // Rewrites the whole file. It needs room for a second copy and holds a
      // write lock throughout, so it is an explicit action, never scheduled.
      if (fileBefore > 512 * 1024 * 1024) {
        throw new HttpError(409,
          'This database is over 512 MB. VACUUM would lock it for a long time — '
          + 'run it out of hours from the command line instead.', 'too_large');
      }
      database.exec('VACUUM');
      detail = `Reclaimed ${Math.round((fileBefore - fileSize(DB_PATH)) / 1024)} KB`;
      break;

    default:
      throw new HttpError(400, `Unknown maintenance action "${action}"`, 'bad_action');
  }

  const after = { pageCount: pragma<number>('page_count'), free: pragma<number>('freelist_count') };

  return {
    action,
    detail,
    durationMs: Date.now() - started,
    triggeredBy,
    before: { ...before, fileBytes: fileBefore, walBytes: walBefore },
    after: { ...after, fileBytes: fileSize(DB_PATH), walBytes: fileSize(`${DB_PATH}-wal`) },
  };
}

/**
 * Called by the night audit, once a day, when nobody is at the desk.
 *
 * ANALYZE and a checkpoint are cheap and always worth doing. The integrity
 * check is the one that matters, and it runs here because this is the only
 * moment in the day the system is reliably quiet.
 */
export function nightlyMaintenance(triggeredBy: string) {
  const check = runIntegrityCheck(triggeredBy);
  const optimize = runMaintenance('optimize', triggeredBy);
  const checkpoint = runMaintenance('checkpoint', triggeredBy);
  return { check, optimize, checkpoint };
}
