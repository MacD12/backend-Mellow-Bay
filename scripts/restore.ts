// ─────────────────────────────────────────────────────────────
// Restore the database from a backup.
//
//   node --experimental-sqlite scripts/restore.ts                  # list backups
//   node --experimental-sqlite scripts/restore.ts <file|id>        # dry run
//   node --experimental-sqlite scripts/restore.ts <file|id> --yes  # do it
//
// Restoring is the one operation nobody has ever rehearsed when they need it,
// so this script is deliberately loud: it refuses to run while the API is up,
// verifies the backup *before* touching anything, and takes a snapshot of the
// current database first so a wrong restore is itself reversible.
// ─────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, rmSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';

const DB_PATH = resolve(process.env.HELIO_DB ?? join(import.meta.dirname, '..', 'data', 'helio.db'));
const BACKUP_DIR = resolve(
  process.env.HELIO_BACKUP_DIR ?? join(dirname(DB_PATH), '..', 'backups'),
);
const PORT = Number(process.env.PORT ?? 8080);

function out(s: string) { process.stdout.write(s + '\n'); }

/**
 * Stop with a message. This throws rather than calling `process.exit()` —
 * exiting while a socket or timer is still open trips a libuv assertion on
 * Windows, which buries the actual message under a crash dump.
 */
class RestoreStopped extends Error {}
function fail(s: string): never { throw new RestoreStopped(s); }

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Refuse to swap the file out from under a running server. */
async function apiIsRunning(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://localhost:${PORT}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    // Clear the timer explicitly so no handle outlives this call.
    clearTimeout(timer);
  }
}

function inspect(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = String(Object.values(db.prepare('PRAGMA integrity_check').get() ?? {})[0]);
    const fk = db.prepare('PRAGMA foreign_key_check').all().length;
    const property = db.prepare('SELECT name, code, business_date FROM properties LIMIT 1').get() as any;
    const counts: Record<string, number> = {};
    for (const t of ['reservations', 'reservation_nights', 'folio_lines', 'rooms', 'users', 'daily_stats']) {
      counts[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as any).n;
    }
    return { integrity, fk, property, counts };
  } finally {
    db.close();
  }
}

function listBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ file: f, path: join(BACKUP_DIR, f), stat: statSync(join(BACKUP_DIR, f)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

async function main() {
  const [target, ...flags] = process.argv.slice(2);
  const confirmed = flags.includes('--yes');

  out(`\nDatabase   ${DB_PATH}`);
  out(`Backups    ${BACKUP_DIR}\n`);

  const backups = listBackups();

  if (!target) {
    if (!backups.length) fail('No backups found. Has the API run yet?');
    out('Available backups (newest first):\n');
    for (const b of backups.slice(0, 20)) {
      out(`  ${b.file}`);
      out(`    ${human(b.stat.size).padStart(9)} · ${b.stat.mtime.toISOString()}`);
    }
    out('\nRestore with:');
    out(`  node --experimental-sqlite scripts/restore.ts ${backups[0].file} --yes\n`);
    return;
  }

  // Accept a filename, a full path, or the id embedded in the filename.
  const match = existsSync(target)
    ? target
    : backups.find((b) => b.file === target || b.file.includes(target))?.path;
  if (!match) fail(`No backup matching "${target}". Run without arguments to list them.`);

  out(`Restoring from  ${basename(match)}\n`);

  // ── 1. Verify the backup before anything is touched ────────
  out('1 · Verifying the backup');
  let source;
  try {
    source = inspect(match);
  } catch (e) {
    fail(`   ✗ Cannot read the backup: ${e instanceof Error ? e.message : e}`);
  }
  if (source.integrity !== 'ok') fail(`   ✗ integrity_check says: ${source.integrity}`);
  if (source.fk > 0) fail(`   ✗ ${source.fk} foreign key violation(s) in the backup`);
  if (!source.property) fail('   ✗ The backup contains no property — wrong file?');
  out(`   ✓ integrity ok · no foreign key violations`);
  out(`   ✓ ${source.property.name} (${source.property.code}) · business date ${source.property.business_date}`);
  out(`   ✓ ${Object.entries(source.counts).map(([k, v]) => `${k}=${v}`).join(' · ')}\n`);

  // ── 2. Show what is being replaced ─────────────────────────
  out('2 · Current database');
  if (existsSync(DB_PATH)) {
    try {
      const current = inspect(DB_PATH);
      out(`   ${current.property?.name ?? 'unknown'} · business date ${current.property?.business_date ?? '—'}`);
      out(`   ${Object.entries(current.counts).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
      const delta = source.counts.reservations - current.counts.reservations;
      if (delta < 0) {
        out(`\n   ⚠ The backup has ${Math.abs(delta)} FEWER reservations than the live database.`);
        out('     Restoring will discard work recorded since the backup was taken.');
      }
    } catch {
      out('   (unreadable — this is presumably why you are restoring)');
    }
  } else {
    out('   No current database — this will be a fresh restore.');
  }
  out('');

  if (!confirmed) {
    out('Dry run. Nothing has been changed.');
    out(`Re-run with --yes to replace the database:\n`);
    out(`  node --experimental-sqlite scripts/restore.ts ${basename(match)} --yes\n`);
    return;
  }

  // ── 3. Refuse to run against a live server ─────────────────
  out('3 · Checking the API is stopped');
  if (await apiIsRunning()) {
    fail(`   ✗ The API is still answering on port ${PORT}.\n`
      + '     Stop it first — swapping the file under a running server corrupts both.');
  }
  out('   ✓ Nothing listening\n');

  // ── 4. Snapshot what we are about to overwrite ─────────────
  out('4 · Saving the current database first');
  if (existsSync(DB_PATH)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const safety = join(BACKUP_DIR,
      `helio-${new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')}-pre-restore.db`);
    copyFileSync(DB_PATH, safety);
    out(`   ✓ ${basename(safety)}`);
    out('     If this restore was a mistake, that file is the way back.\n');
  } else {
    out('   (nothing to save)\n');
  }

  // ── 5. Swap it in ──────────────────────────────────────────
  out('5 · Restoring');
  // The WAL and shared-memory files belong to the old database. Leaving them
  // beside a different main file is how a restore corrupts itself.
  for (const suffix of ['-wal', '-shm']) {
    try { rmSync(`${DB_PATH}${suffix}`, { force: true }); } catch { /* not present */ }
  }
  copyFileSync(match, DB_PATH);
  out('   ✓ Database replaced\n');

  // ── 6. Prove the restored file works ───────────────────────
  out('6 · Verifying the restored database');
  const restored = inspect(DB_PATH);
  if (restored.integrity !== 'ok') {
    fail(`   ✗ The restored file fails integrity_check: ${restored.integrity}`);
  }
  out(`   ✓ integrity ok`);
  out(`   ✓ ${restored.property.name} · business date ${restored.property.business_date}`);
  out(`   ✓ ${Object.entries(restored.counts).map(([k, v]) => `${k}=${v}`).join(' · ')}\n`);

  out('Restore complete. Start the API and check the dashboard before taking bookings.\n');
}

main().catch((e) => {
  const message = e instanceof RestoreStopped
    ? e.message
    : `Restore failed: ${e instanceof Error ? e.message : String(e)}`;
  process.stderr.write(`\n${message}\n\n`);
  // Set the code and let the loop drain rather than tearing the process down.
  process.exitCode = 1;
});
