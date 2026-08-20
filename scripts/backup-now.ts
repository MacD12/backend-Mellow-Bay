// Take a verified backup from the command line — for cron, a scheduled task,
// or a quick snapshot before doing something risky.
//
//   node --experimental-sqlite scripts/backup-now.ts
import { runBackup, backupStatus } from '../src/services/backup.ts';
import { migrate } from '../src/db.ts';

migrate();
const result = runBackup('manual', 'cli');
const status = backupStatus();

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
process.stdout.write(
  `${result.status === 'verified' ? '✓' : '✗'} ${result.filename}\n`
  + `  ${kb(result.size_bytes)} from ${kb(result.source_size_bytes)} source · ${result.duration_ms}ms\n`
  + `  integrity: ${result.verification ?? '—'}\n`
  + (result.error ? `  error: ${result.error}\n` : '')
  + `  ${status.snapshotsOnDisk} snapshot(s) on disk · ${kb(status.totalBytes)} total · ${status.health}\n`,
);
// Set the code rather than calling process.exit() — the database handle is
// still open, and tearing the process down under it trips a libuv assertion
// on Windows that hides the output above.
if (result.status !== 'verified') process.exitCode = 1;
