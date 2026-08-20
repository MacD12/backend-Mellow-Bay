// ─────────────────────────────────────────────────────────────
// Exercises tenant isolation — the boundary between one property's data and
// another's.
//
//   node --experimental-sqlite scripts/isolation-check.ts
//
// An independent audit found that `x-property-id` was taken from the browser
// and used with no check that the signed-in user had any claim to that
// property. One header edit read another hotel's reservations, guest details,
// financials and channel credentials.
//
// This runs the **real server** against a throwaway database and forges the
// header over actual HTTP, because that is where the defect lived. Unit-testing
// the helpers alone would have passed both before and after the fix.
//
// It starts its own API on its own port; nothing else is touched.
// ─────────────────────────────────────────────────────────────
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-iso-'));
const dbPath = join(workdir, 'data', 'helio.db');
const PORT = 8231 + Math.floor(Number(process.env.ISO_PORT_OFFSET ?? 0));
const BASE = `http://localhost:${PORT}`;

process.env.HELIO_DB = dbPath;
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run } = await import('../src/db.ts');
const { id, nowIso } = await import('../src/lib/util.ts');
const { hashPassword, permissionsFor } = await import('../src/auth.ts');
const { database } = await import('../src/db.ts');

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}\n`);
  if (!ok) {
    failures++;
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 320)}\n`);
  }
}
function section(t: string) { process.stdout.write(`\n${t}\n${'─'.repeat(t.length)}\n`); }

const PASSWORD = 'Isolation2026!';

function makeProperty(code: string, name: string): string {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en','2026-06-01','14:00','11:00',1,?)`,
    propertyId, code, name, nowIso(),
  );
  return propertyId;
}

function makeUser(email: string, role: string, properties: Array<[string, string]> = []): string {
  const { hash, salt } = hashPassword(PASSWORD);
  const userId = id('usr');
  run(
    `INSERT INTO users(id, email, name, password_hash, password_salt, role, active,
                       must_change_pw, created_at)
     VALUES(?,?,?,?,?,?,1,0,?)`,
    userId, email, email.split('@')[0], hash, salt, role, nowIso(),
  );
  for (const [propertyId, propRole] of properties) {
    run('INSERT INTO user_properties(user_id, property_id, role) VALUES(?,?,?)',
      userId, propertyId, propRole);
  }
  return userId;
}

async function login(email: string): Promise<string> {
  const r: any = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })).json();
  if (!r.token) throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(r)}`);
  return r.token;
}

/** A request exactly as a browser would make it, header and all. */
function asUser(token: string, propertyId: string) {
  return (path: string, init: RequestInit = {}) => fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'x-property-id': propertyId,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

let server: ChildProcess | undefined;

async function startServer() {
  server = spawn(process.execPath,
    ['--no-warnings', '--experimental-sqlite', join(import.meta.dirname, '..', 'src', 'index.ts')],
    {
      env: {
        ...process.env,
        HELIO_DB: dbPath,
        PORT: String(PORT),
        HELIO_BACKUP_ENABLED: 'false',
        HELIO_CHANNEL_DRAIN_SECONDS: '0',
      },
      stdio: 'ignore',
    });

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('The API did not start');
}

async function main() {
  process.stdout.write(`\nTenant isolation checks\n${'─'.repeat(23)}\n`);
  migrate();

  const alpha = makeProperty('ALPHA', 'Alpha Hotel');
  const beta = makeProperty('BETA', 'Beta Hotel');

  // Assigned to Alpha only, and demoted at Beta so the role question is real.
  makeUser('manager@alpha.test', 'manager', [[alpha, 'manager']]);
  makeUser('both@test.test', 'manager', [[alpha, 'manager'], [beta, 'housekeeping']]);
  makeUser('reader@alpha.test', 'readonly', [[alpha, 'readonly']]);
  makeUser('admin@test.test', 'admin', []);
  makeUser('unassigned@test.test', 'manager', []);

  // The helpers close so the server picks up the seeded database cleanly.
  database.close();
  await startServer();

  section('1 · A user cannot reach a property they are not assigned to');
  const managerToken = await login('manager@alpha.test');
  const atAlpha = asUser(managerToken, alpha);
  const atBeta = asUser(managerToken, beta);

  const ownRes = await atAlpha('/api/reservations');
  check('their own property answers normally', ownRes.status === 200, ownRes.status);

  // The defect, exactly as reported: one header edit.
  const forged = await atBeta('/api/reservations');
  check('another property is refused', forged.status === 403, forged.status);
  const forgedBody: any = await forged.json().catch(() => ({}));
  check('and the refusal names the reason',
    forgedBody.code === 'property_forbidden', forgedBody);

  for (const [label, path] of [
    ['guest profiles', '/api/profiles'],
    ['financial reports', '/api/reports/kpis'],
    ['channel settings', '/api/channels'],
  ] as const) {
    const r = await atBeta(path);
    check(`${label} are refused too`, r.status === 403, `${path} → ${r.status}`);
  }

  section('2 · The role is recomputed for the property being worked on');
  // Manager at Alpha, housekeeping at Beta. The old code kept the Alpha role.
  const bothToken = await login('both@test.test');
  const bothAtAlpha = asUser(bothToken, alpha);
  const bothAtBeta = asUser(bothToken, beta);

  const canWriteAlpha = await bothAtAlpha('/api/room-types', {
    method: 'POST',
    body: JSON.stringify({ code: 'ISO1', name: 'Isolation Test', kind: 'room' }),
  });
  check('a manager may configure their own property',
    canWriteAlpha.status < 400, canWriteAlpha.status);

  const canWriteBeta = await bothAtBeta('/api/room-types', {
    method: 'POST',
    body: JSON.stringify({ code: 'ISO2', name: 'Should Not Exist', kind: 'room' }),
  });
  check('but not one where they are housekeeping',
    canWriteBeta.status === 403, canWriteBeta.status);

  const readBeta = await bothAtBeta('/api/rooms');
  check('while reading what their lower role does allow still works',
    readBeta.status === 200, readBeta.status);

  section('3 · An administrator still reaches everything');
  const adminToken = await login('admin@test.test');
  for (const [label, propertyId] of [['Alpha', alpha], ['Beta', beta]] as const) {
    const r = await asUser(adminToken, propertyId)('/api/reservations');
    check(`an admin may read ${label}`, r.status === 200, r.status);
  }

  section('4 · The unassigned-user fallback');
  // Two properties exist, so the convenience has lapsed: somebody has to say
  // who works where.
  const unassignedToken = await login('unassigned@test.test');
  const unassignedAtAlpha = await asUser(unassignedToken, alpha)('/api/reservations');
  check('with two properties, an unassigned user reaches neither',
    unassignedAtAlpha.status === 403, unassignedAtAlpha.status);

  section('5 · Permissions fail closed');
  // `permissionsFor` used to fall back to the readonly grants for any role it
  // did not recognise — so a typo in a role column handed out read access to
  // reservations, folios and channel settings instead of denying.
  check('an unknown role gets no permissions at all',
    permissionsFor('wizard').length === 0, permissionsFor('wizard'));
  check('an empty role gets none either', permissionsFor('').length === 0);
  check('a known role still gets its grants', permissionsFor('readonly').length > 0);
  check('and admin still gets everything', permissionsFor('admin').includes('*'));

  section('6 · A manager cannot promote themselves to administrator');
  // `admin.users` lets a manager run the staff list. It must not let them mint
  // an administrator — otherwise the role hierarchy is decoration. There were
  // three ways through: create one, promote yourself, or take an admin's
  // account by resetting its password.
  const mgr = asUser(managerToken, alpha);

  const createAdmin = await mgr('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Backdoor', email: 'backdoor@test.test', role: 'admin', password: 'Backdoor2026!',
    }),
  });
  check('creating an admin account is refused', createAdmin.status === 403, createAdmin.status);

  const userList = await (await mgr("/api/users")).json() as any[];
  const managerId = userList.find((u) => u.email === 'manager@alpha.test')?.id;
  const adminId = userList.find((u) => u.email === 'admin@test.test')?.id;

  const selfPromote = await mgr(`/api/users/${managerId}`, {
    method: 'PATCH', body: JSON.stringify({ role: 'admin' }),
  });
  check('promoting themselves is refused', selfPromote.status >= 400, selfPromote.status);

  const stealAdmin = await mgr(`/api/users/${adminId}`, {
    method: 'PATCH', body: JSON.stringify({ password: 'Stolen2026!' }),
  });
  check("resetting an admin's password is refused", stealAdmin.status === 403, stealAdmin.status);

  const mintLink = await mgr(`/api/auth/reset-links/${adminId}`, { method: 'POST' });
  check('minting a reset link for an admin is refused', mintLink.status === 403, mintLink.status);

  const stillManager: any = await (await mgr('/api/auth/me')).json();
  check('the manager is still a manager',
    stillManager.user?.role === 'manager', stillManager.user?.role);

  section('7 · …but ordinary staff administration still works');
  const createStaff = await mgr('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      name: 'New Receptionist', email: 'recep@alpha.test', role: 'front_office',
      password: 'Reception2026!',
    }),
  });
  check('a manager may still create a receptionist',
    createStaff.status < 400, createStaff.status);

  const adminCreates = await asUser(adminToken, alpha)('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Second Admin', email: 'admin2@test.test', role: 'admin', password: 'Admin2026!',
    }),
  });
  check('an administrator may still create an administrator',
    adminCreates.status < 400, adminCreates.status);

  process.stdout.write(`\n${checks - failures}/${checks} isolation checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write(
    'One property cannot read another, the role follows the property, '
    + 'and nobody hands out authority they do not hold.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  server?.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
