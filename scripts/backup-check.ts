// ─────────────────────────────────────────────────────────────
// Exercises the backup system end to end on a throwaway database:
// snapshot, verify, tamper detection, retention, reconciliation and a full
// restore round-trip.
//
//   node --experimental-sqlite scripts/backup-check.ts
//
// It never touches the live database — it builds its own in a temp directory.
// ─────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-backup-'));
const dbPath = join(workdir, 'data', 'helio.db');
const backupDir = join(workdir, 'backups');

// The backup module reads these at import time, so they must be set first.
process.env.HELIO_DB = dbPath;
process.env.HELIO_BACKUP_DIR = backupDir;
process.env.HELIO_BACKUP_ENABLED = 'false';   // no timers in a test run

const { migrate, run, get, all, database } = await import('../src/db.ts');
const backup = await import('../src/services/backup.ts');
const { id, nowIso } = await import('../src/lib/util.ts');

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}\n`);
  if (!ok) {
    failures++;
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 300)}\n`);
  }
}
function section(t: string) { process.stdout.write(`\n${t}\n${'─'.repeat(t.length)}\n`); }

function seedProperty(name: string) {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en','2026-01-01','14:00','11:00',1,?)`,
    propertyId, 'TEST', name, nowIso(),
  );
  run(
    `INSERT INTO users(id, email, name, password_hash, password_salt, role, active, created_at)
     VALUES(?,?,?,'x','y','admin',1,?)`,
    id('usr'), 'test@helio.test', 'Test Admin', nowIso(),
  );
  return propertyId;
}

function addRoom(propertyId: string, number: string) {
  const rtId = get<{ id: string }>('SELECT id FROM room_types WHERE property_id = ?', propertyId)?.id
    ?? (() => {
      const newId = id('rt');
      run(
        `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                                max_adults, max_children, default_rate_minor, extra_adult_minor,
                                extra_child_minor, sort_order, active, created_at)
         VALUES(?,?,'STD','Standard','room',2,2,2,0,10000,0,0,1,1,?)`,
        newId, propertyId, nowIso(),
      );
      return newId;
    })();
  run(
    `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
     VALUES(?,?,?,?,1,'Vacant Clean',1,?)`,
    id('rm'), propertyId, rtId, number, nowIso(),
  );
}

async function main() {
  process.stdout.write(`\nBackup system checks\n${'─'.repeat(20)}\nWorking in ${workdir}\n`);

  migrate();
  const propertyId = seedProperty('Backup Test Hotel');
  addRoom(propertyId, '101');
  addRoom(propertyId, '102');

  section('1 · Taking a snapshot');
  const first = backup.runBackup('manual', 'test');
  check('the snapshot verifies', first.status === 'verified', first);
  check('the file is on disk', existsSync(first.path));
  check('it is smaller than the source (compacted)',
    first.size_bytes > 0 && first.size_bytes <= first.source_size_bytes,
    { size: first.size_bytes, source: first.source_size_bytes });
  check('integrity_check passed', first.verification === 'ok', first.verification);
  check('the core tables were proved readable',
    JSON.parse(first.row_checks ?? '{}').rooms === 2, first.row_checks);
  check('it completed quickly', first.duration_ms < 5000, `${first.duration_ms}ms`);

  section('2 · Status reporting');
  const status = backup.backupStatus();
  // Health is about whether the data is protected, not whether the timer is on.
  check('a fresh snapshot means healthy, even with the schedule off',
    status.health === 'healthy', status.health);
  check('the schedule being off is reported separately',
    status.scheduleEnabled === false, status.scheduleEnabled);
  check('…and is flagged as needing attention', status.needsAttention === true);
  check('the last good backup is named', status.lastGood?.id === first.id);
  check('the age is under an hour', (status.ageHours ?? 99) < 1, status.ageHours);
  check('one snapshot is counted on disk', status.snapshotsOnDisk === 1, status.snapshotsOnDisk);

  section('3 · A corrupt backup is not trusted');
  const corrupt = join(backupDir, 'helio-2020-01-01T00-00-00-000-manual.db');
  writeFileSync(corrupt, 'this is not a database');
  const corruptResult = backup.verifyBackupFile(corrupt);
  check('a damaged file fails verification', corruptResult.ok === false, corruptResult);
  check('the failure says why', !!corruptResult.error, corruptResult.error);

  const truncated = join(backupDir, 'helio-2020-01-02T00-00-00-000-manual.db');
  copyFileSync(first.path, truncated);
  const buf = Buffer.alloc(2048, 0);
  writeFileSync(truncated, buf);   // valid length, meaningless content
  check('a zeroed file fails verification', backup.verifyBackupFile(truncated).ok === false);
  rmSync(corrupt, { force: true });
  rmSync(truncated, { force: true });

  section('4 · Data changes are captured');
  addRoom(propertyId, '103');
  const second = backup.runBackup('manual', 'test');
  check('the later snapshot verifies', second.status === 'verified', second);
  check('it contains the new room',
    JSON.parse(second.row_checks ?? '{}').rooms === 3, second.row_checks);
  check('the earlier snapshot still has the old count',
    backup.verifyBackupFile(first.path).counts.rooms === 2);

  section('5 · Reconciliation');
  // Simulate what a restore always leaves behind: a row stuck mid-flight.
  const stuckId = id('bak');
  run(
    `INSERT INTO backups(id, filename, path, started_at, status, reason)
     VALUES(?,?,?,?,'running','manual')`,
    stuckId, first.filename, first.path, nowIso(),
  );
  // …and a snapshot on disk this database has never heard of.
  const orphan = join(backupDir, 'helio-2026-06-06T06-06-06-000-scheduled.db');
  copyFileSync(second.path, orphan);

  const reconciled = backup.reconcileBackups();
  check('the stuck row is resolved', reconciled.resolved >= 1, reconciled);
  check('…to verified, because its file is good',
    get<any>('SELECT status FROM backups WHERE id = ?', stuckId)?.status === 'verified');
  check('the unknown file on disk is adopted', reconciled.adopted >= 1, reconciled);
  check('adopted snapshots are marked as such',
    all<any>(`SELECT * FROM backups WHERE triggered_by = 'adopted-from-disk'`).length >= 1);

  section('6 · Retention never destroys a good backup');
  const before = readdirSync(backupDir).filter((f) => f.endsWith('.db')).length;
  // A row still in flight must survive pruning — this was a real bug once.
  const inFlightId = id('bak');
  const inFlightPath = join(backupDir, 'helio-2026-07-07T07-07-07-000-manual.db');
  copyFileSync(second.path, inFlightPath);
  run(
    `INSERT INTO backups(id, filename, path, started_at, status, reason)
     VALUES(?,?,?,?,'running','manual')`,
    inFlightId, 'helio-2026-07-07T07-07-07-000-manual.db', inFlightPath, nowIso(),
  );
  backup.prune();
  check('a backup still in flight is not pruned', existsSync(inFlightPath));
  check('recent verified snapshots are kept',
    existsSync(first.path) && existsSync(second.path),
    { first: existsSync(first.path), second: existsSync(second.path) });
  const after = readdirSync(backupDir).filter((f) => f.endsWith('.db')).length;
  check('nothing was lost in pruning', after >= before, { before, after });

  section('7 · Restore round-trip');
  // Record the state, change it, restore, and prove the change is gone.
  const roomsBefore = get<{ n: number }>('SELECT count(*) AS n FROM rooms')!.n;
  const snapshot = backup.runBackup('manual', 'pre-change');
  check('a snapshot was taken before the change', snapshot.status === 'verified');

  addRoom(propertyId, '999');
  const roomsAfter = get<{ n: number }>('SELECT count(*) AS n FROM rooms')!.n;
  check('the change is in the live database', roomsAfter === roomsBefore + 1);

  // Restore the way the script does: close, swap the file, drop the sidecars.
  database.close();
  for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  copyFileSync(snapshot.path, dbPath);

  const restored = new DatabaseSync(dbPath, { readOnly: true });
  const roomsRestored = (restored.prepare('SELECT count(*) AS n FROM rooms').get() as any).n;
  const marker = (restored.prepare(`SELECT count(*) AS n FROM rooms WHERE number = '999'`).get() as any).n;
  const integrity = String(Object.values(restored.prepare('PRAGMA integrity_check').get() ?? {})[0]);
  restored.close();

  check('the restored database has the pre-change room count',
    roomsRestored === roomsBefore, { expected: roomsBefore, actual: roomsRestored });
  check('the change made after the snapshot is gone', marker === 0);
  check('the restored database passes integrity_check', integrity === 'ok', integrity);

  process.stdout.write(`\n${checks - failures}/${checks} backup checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('Backups are taken, verified, retained and restorable.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
