// ─────────────────────────────────────────────────────────────
// Runs the whole verification suite against throwaway databases.
//
//   node --experimental-sqlite scripts/verify-all.ts
//
// The individual scripts each talk to a running API, which used to mean they
// could only be trusted once — against a virgin database, before anyone had
// used the system. That makes them useless as a regression suite, which is
// what they are for. This runner gives each one the clean instance it expects:
// its own temp database, its own port, its own server process, torn down
// afterwards. The live database is never touched.
//
//   Instance A (empty)          → smoke.ts       bootstraps and tests business rules
//   Instance B (demo seeded)    → screens, auth, concurrency
//   No server                   → backup-check   builds its own database
//
// ui-check.ts is not included: it drives a real browser against the front end,
// so it needs `npm run app` and is run on its own.
// ─────────────────────────────────────────────────────────────
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const API_DIR = join(import.meta.dirname, '..');
const NODE_FLAGS = ['--no-warnings', '--experimental-sqlite'];

const DEMO_EMAIL = 'hiran@mellowbay.com';
const DEMO_PASSWORD = 'Mellow2026';

const workdir = mkdtempSync(join(tmpdir(), 'helio-verify-'));
const servers: ChildProcess[] = [];

function out(s: string) { process.stdout.write(s); }

/** Ask the OS for a port nothing is using, so parallel runs never collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

type Instance = { base: string; env: Record<string, string> };

/** Start an API on its own database and wait until it answers. */
async function startInstance(name: string): Promise<Instance> {
  const port = await freePort();
  const env = {
    ...process.env,
    // The `.env` cascade is loaded by src/config.ts for every process now, not
    // just the seven npm scripts that used to pass `--env-file`. That is right
    // for the server and wrong here: a verification run must not inherit the
    // developer's real Beds24 refresh token and start talking to the live OTA
    // account. Pointing the loader at the empty temp directory gives each
    // instance a genuinely clean configuration instead of an accidental one.
    HELIO_ENV_DIR: join(workdir, name),
    NODE_ENV: 'test',
    HELIO_DB: join(workdir, name, 'helio.db'),
    HELIO_BACKUP_DIR: join(workdir, name, 'backups'),
    HELIO_BACKUP_ENABLED: 'false',      // no timers in a test run
    PORT: String(port),
  } as Record<string, string>;
  // Anything inherited from the shell would defeat the isolation above.
  delete env.BEDS24_REFRESH_TOKEN;
  delete env.HELIO_CHANNEL_READONLY;

  const child = spawn(process.execPath, [...NODE_FLAGS, 'src/index.ts'], {
    cwd: API_DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);

  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });
  child.stdout?.resume();

  const base = `http://localhost:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API for "${name}" exited with ${child.exitCode}\n${stderr}`);
    }
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        out(`  started ${name} on ${base}\n`);
        return { base, env };
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`API for "${name}" did not come up within 20s\n${stderr}`);
}

/** Run one check script and report whether it passed. */
function runScript(script: string, instance: Instance, extra: Record<string, string> = {}) {
  return new Promise<{ ok: boolean; tail: string }>((resolve) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, `scripts/${script}`], {
      cwd: API_DIR,
      env: { ...instance.env, API: instance.base, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (d) => { output += String(d); });
    child.stderr?.on('data', (d) => { output += String(d); });
    child.on('close', (code) => {
      // Keep the summary lines — the last few carry the counts and any failures.
      const lines = output.trimEnd().split('\n');
      const failed = lines.filter((l) => l.includes('✗'));
      const tail = [...failed.slice(0, 12), ...lines.slice(-3)].join('\n');
      resolve({ ok: code === 0, tail });
    });
  });
}

const results: Array<{ name: string; ok: boolean; tail: string }> = [];

async function step(name: string, script: string, instance: Instance, extra?: Record<string, string>) {
  out(`\n${name}\n${'─'.repeat(name.length)}\n`);
  const r = await runScript(script, instance, extra);
  out(`${r.tail}\n`);
  results.push({ name, ok: r.ok, tail: r.tail });
}

async function main() {
  out(`\nHelio verification suite\n${'═'.repeat(24)}\n`);
  out(`Throwaway databases in ${workdir}\n\n`);

  // ── Self-contained suites: they build their own databases ───
  // Same isolation as an instance: these build their own databases, and they
  // have no more business reading the developer's `.env` than the servers do.
  const standaloneEnv = {
    ...process.env,
    HELIO_ENV_DIR: workdir,
    NODE_ENV: 'test',
  } as Record<string, string>;
  delete standaloneEnv.BEDS24_REFRESH_TOKEN;
  delete standaloneEnv.HELIO_CHANNEL_READONLY;
  const standalone = { base: '', env: standaloneEnv };

  out('Backup system\n─────────────\n');
  const backups = await runScript('backup-check.ts', standalone);
  out(`${backups.tail}\n`);
  results.push({ name: 'Backup system', ok: backups.ok, tail: backups.tail });

  out('\nClose-outs\n──────────\n');
  const closeouts = await runScript('closeout-check.ts', standalone);
  out(`${closeouts.tail}\n`);
  results.push({ name: 'Close-outs', ok: closeouts.ok, tail: closeouts.tail });

  out('\nStay date changes\n─────────────────\n');
  const staydates = await runScript('staydates-check.ts', standalone);
  out(`${staydates.tail}\n`);
  results.push({ name: 'Stay date changes', ok: staydates.ok, tail: staydates.tail });

  out('\nChannel reports\n───────────────\n');
  const creports = await runScript('channelreport-check.ts', standalone);
  out(`${creports.tail}\n`);
  results.push({ name: 'Channel reports', ok: creports.ok, tail: creports.tail });

  out('\nOverbooking detection\n─────────────────────\n');
  const overbook = await runScript('overbooking-check.ts', standalone);
  out(`${overbook.tail}\n`);
  results.push({ name: 'Overbooking detection', ok: overbook.ok, tail: overbook.tail });

  out('\nOverbooking fixes\n─────────────────\n');
  const ovbfix = await runScript('overbookingfix-check.ts', standalone);
  out(`${ovbfix.tail}\n`);
  results.push({ name: 'Overbooking fixes', ok: ovbfix.ok, tail: ovbfix.tail });

  // The audit's Critical and High findings. These run first: a tenant-isolation
  // or billing regression matters more than any feature below them.
  out('\nTenant isolation and privilege\n──────────────────────────────\n');
  const isolation = await runScript('isolation-check.ts', standalone);
  out(`${isolation.tail}\n`);
  results.push({ name: 'Isolation & privilege', ok: isolation.ok, tail: isolation.tail });

  out('\nSecret handling\n───────────────\n');
  const secretsSuite = await runScript('secrets-check.ts', standalone);
  out(`${secretsSuite.tail}\n`);
  results.push({ name: 'Secret handling', ok: secretsSuite.ok, tail: secretsSuite.tail });

  out('\nTax and folio agreement\n───────────────────────\n');
  const tax = await runScript('tax-check.ts', standalone);
  out(`${tax.tail}\n`);
  results.push({ name: 'Tax & folio', ok: tax.ok, tail: tax.tail });

  out('\nChannel push failures\n─────────────────────\n');
  const push = await runScript('channelpush-check.ts', standalone);
  out(`${push.tail}\n`);
  results.push({ name: 'Channel push', ok: push.ok, tail: push.tail });

  out('\nNotifications\n─────────────\n');
  const ntf = await runScript('notify-check.ts', standalone);
  out(`${ntf.tail}\n`);
  results.push({ name: 'Notifications', ok: ntf.ok, tail: ntf.tail });

  out('\nOffline rules\n─────────────\n');
  const offlineSuite = await runScript('offline-check.ts', standalone);
  out(`${offlineSuite.tail}\n`);
  results.push({ name: 'Offline rules', ok: offlineSuite.ok, tail: offlineSuite.tail });

  out('\nClosing rooms\n─────────────\n');
  const closeSuite = await runScript('closing-check.ts', standalone);
  out(`${closeSuite.tail}\n`);
  results.push({ name: 'Closing rooms', ok: closeSuite.ok, tail: closeSuite.tail });

  out('\nReal-time sync\n──────────────\n');
  const rtSuite = await runScript('realtime-check.ts', standalone);
  out(`${rtSuite.tail}\n`);
  results.push({ name: 'Real-time sync', ok: rtSuite.ok, tail: rtSuite.tail });

  out('\nOTA detection\n─────────────\n');
  const otaSuite = await runScript('ota-check.ts', standalone);
  out(`${otaSuite.tail}\n`);
  results.push({ name: 'OTA detection', ok: otaSuite.ok, tail: otaSuite.tail });

  out('\nTape chart\n──────────\n');
  const tapeSuite = await runScript('tapechart-check.ts', standalone);
  out(`${tapeSuite.tail}\n`);
  results.push({ name: 'Tape chart', ok: tapeSuite.ok, tail: tapeSuite.tail });

  out('\nBed configuration\n─────────────────\n');
  const bedcfg = await runScript('beds-check.ts', standalone);
  out(`${bedcfg.tail}\n`);
  results.push({ name: 'Bed configuration', ok: bedcfg.ok, tail: bedcfg.tail });

  out('\nWalking guests\n──────────────\n');
  const walking = await runScript('walking-check.ts', standalone);
  out(`${walking.tail}\n`);
  results.push({ name: 'Walking guests', ok: walking.ok, tail: walking.tail });

  out('\nExposure and protection\n───────────────────────\n');
  const expo = await runScript('exposure-check.ts', standalone);
  out(`${expo.tail}\n`);
  results.push({ name: 'Exposure and protection', ok: expo.ok, tail: expo.tail });

  out('\nAlerts and the inventory guard\n──────────────────────────────\n');
  const alerts = await runScript('alerts-check.ts', standalone);
  out(`${alerts.tail}\n`);
  results.push({ name: 'Alerts and guard', ok: alerts.ok, tail: alerts.tail });

  out('\nGuest messaging\n───────────────\n');
  const messaging = await runScript('messaging-check.ts', standalone);
  out(`${messaging.tail}\n`);
  results.push({ name: 'Guest messaging', ok: messaging.ok, tail: messaging.tail });

  out('\nPrice planning\n──────────────\n');
  const rates = await runScript('rateplanning-check.ts', standalone);
  out(`${rates.tail}\n`);
  results.push({ name: 'Price planning', ok: rates.ok, tail: rates.tail });

  // ── A: an empty installation for the business-rule checks ───
  out('\nStarting servers\n────────────────\n');
  const a = await startInstance('smoke');
  await step('Business rules', 'smoke.ts', a);

  // ── B: a demo-seeded installation for the read paths ────────
  const b = await startInstance('demo');
  await step('Demo seed', 'demo.ts', b);

  const creds = { SMOKE_EMAIL: DEMO_EMAIL, SMOKE_PASSWORD: DEMO_PASSWORD };
  await step('Screen data', 'screens.ts', b, creds);
  await step('Authentication', 'auth-check.ts', b, creds);
  await step('Booking concurrency', 'concurrency.ts', b, creds);

  // ── Summary ─────────────────────────────────────────────────
  out(`\n\nSummary\n${'═'.repeat(7)}\n`);
  for (const r of results) out(`  ${r.ok ? '✓' : '✗'} ${r.name}\n`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    out(`\n${failed.length} of ${results.length} suites FAILED\n`);
    process.exitCode = 1;
    return;
  }
  out(`\nAll ${results.length} suites passed against clean databases.\n`);
}

function cleanup() {
  for (const child of servers) {
    try { child.kill(); } catch { /* already gone */ }
  }
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nSuite aborted: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
} finally {
  cleanup();
  // Give the servers a moment to release their file handles before deleting —
  // Windows refuses to remove a directory with an open SQLite file in it.
  await new Promise((r) => setTimeout(r, 500));
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
