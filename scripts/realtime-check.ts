// ─────────────────────────────────────────────────────────────
// Real-time inbound: the webhook, and the watermark that keeps polling honest.
//
//   node --experimental-sqlite scripts/realtime-check.ts
//
// Two failures are being guarded against, and neither announces itself:
//
//   · **An open door.** This endpoint creates reservations and has no session
//     behind it, because Beds24 does not sign in. If the shared secret is
//     missing, weak or compared carelessly, anyone who guesses the path can
//     write bookings into the property.
//   · **A silent gap in the poll.** The import asks for bookings changed since
//     its own last success. If that watermark is advanced by something that did
//     not read bookings — a connection test, a discover — every booking
//     modified in between is never asked for again. Nothing errors. The
//     bookings simply are not there.
//
// Builds its own database and speaks to a local stub. Nothing real is called.
// ─────────────────────────────────────────────────────────────
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-rt-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';
process.env.HELIO_WEBHOOK_SECRET = 'a-secret-at-least-16-chars';

/** Bookings the stub will hand back, and what it was asked for. */
let bookings: any[] = [];
const asked: string[] = [];
/**
 * Make the stub refuse booking reads.
 *
 * Repointing `BEDS24_API` mid-run does not work: the connector reads it once
 * when its module loads, so a later change is ignored and the "failed" call
 * quietly succeeds — which is how this check first passed for the wrong reason.
 */
let failBookings = false;

function startStub(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.url?.startsWith('/authentication/token')) {
          return send(200, { token: 'stub-token', expiresIn: 3600 });
        }
        if (req.url?.startsWith('/bookings')) {
          asked.push(req.url);
          if (failBookings) return send(500, { success: false, error: 'Beds24 is having a moment' });
          return send(200, { success: true, data: bookings });
        }
        if (req.url?.startsWith('/properties')) {
          return send(200, { success: true, data: [{ id: 346677, name: 'Stub' }] });
        }
        send(200, { success: true, data: [] });
      });
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, base: `http://localhost:${port}` });
    });
  });
}

const stub = await startStub();
process.env.BEDS24_API = stub.base;

const { migrate, run, get, scalar } = await import('../src/db.ts');
const { nowIso } = await import('../src/lib/util.ts');
const channels = await import('../src/services/channels.ts');
await import('../src/routes/index.ts');
const { matchRoute } = await import('../src/lib/http.ts');

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  if (ok) { process.stdout.write(`  ✓ ${name}\n`); return; }
  failures++;
  process.stdout.write(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`);
}
function section(t: string) { process.stdout.write(`\n${t}\n${'─'.repeat(t.length)}\n`); }

const P = 'prp_rt';
const CH = 'chn_rt';
const ACTOR = { userId: 'system', userName: 'Test', propertyId: P };

function seed() {
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,'RT','Realtime','hostel','UTC','USD','en','2026-06-01','14:00','11:00',1,?)`,
    P, nowIso());
  run(
    `INSERT INTO channels(id, property_id, code, name, kind, active, status,
                          external_property_id, settings, created_at)
     VALUES(?,?,'BEDS24','Beds24','ota',1,'connected','346677',?,?)`,
    CH, P, JSON.stringify({ credentials: { refreshToken: 'stub' } }), nowIso());
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                            max_adults, max_children, default_rate_minor, active, created_at)
     VALUES('rt1',?,'DORM','Dorm','dorm',1,1,1,0,800,1,?)`, P, nowIso());
  run(
    `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
     VALUES('rm1',?,'rt1','D-1',1,'Vacant Clean',1,?)`, P, nowIso());
  for (let i = 1; i <= 4; i++) {
    run(
      `INSERT INTO beds(id, property_id, room_id, code, bunk, status, active)
       VALUES(?,?,'rm1',?,'single','Vacant Clean',1)`, `bed${i}`, P, `D-1-0${i}`);
  }
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, active, created_at)
     VALUES('rp1',?,'STD','Standard',1,?)`, P, nowIso());
  run(
    `INSERT INTO channel_mappings(id, property_id, channel_id, room_type_id, rate_plan_id,
                                  external_room_id, external_name, active, created_at)
     VALUES('map1',?,?, 'rt1','rp1','715747','Dorm',1,?)`, P, CH, nowIso());
}

/** A Beds24 booking as the connector normalises it. */
function beds24Booking(over: Record<string, unknown> = {}) {
  return {
    id: 90001, roomId: 715747, status: 'confirmed',
    firstName: 'Ayesha', lastName: 'Silva', email: 'a@example.com',
    arrival: '2026-06-10', departure: '2026-06-12',
    numAdult: 1, numChild: 0, price: 16, commission: 2,
    referer: 'Hostelworld', apiReference: 'HW-90001',
    ...over,
  };
}

/** Call a registered route directly, the way the server would. */
async function callRoute(method: string, path: string, opts: {
  headers?: Record<string, string>; body?: unknown;
} = {}) {
  const m = matchRoute(method, path);
  if (!m) throw new Error(`no route for ${method} ${path}`);
  let status = 200;
  let payload: any;
  const res: any = {
    writableEnded: false,
    writeHead(s: number) { status = s; return res; },
    end(b: string) { res.writableEnded = true; try { payload = JSON.parse(b); } catch { payload = b; } },
  };
  const ctx: any = {
    req: { headers: opts.headers ?? {} },
    res, params: m.params, query: new URLSearchParams(),
    body: opts.body ?? {}, ip: '127.0.0.1',
    auth: { userId: 'system', userName: 'test', propertyId: P, role: 'admin', permissions: [] },
  };
  const returned = await m.route.handler(ctx);
  return { status, body: res.writableEnded ? payload : returned };
}

const reservationCount = () =>
  scalar<number>('SELECT COUNT(*) AS n FROM reservations WHERE property_id = ?', P);

async function main() {
  process.stdout.write(`\nReal-time sync checks\n${'─'.repeat(21)}\nStub on ${stub.base}\n`);
  migrate();
  seed();

  section('1 · The webhook refuses anyone without the secret');
  bookings = [beds24Booking()];

  let r = await callRoute('POST', '/api/webhooks/beds24', { body: { propertyId: '346677' } });
  check('no header at all is refused', r.status === 401, r);
  check('…and nothing was imported', reservationCount() === 0, reservationCount());

  r = await callRoute('POST', '/api/webhooks/beds24', {
    headers: { 'x-helio-secret': 'wrong' }, body: { propertyId: '346677' },
  });
  check('a wrong secret is refused', r.status === 401, r);

  // Near-misses matter: a comparison that stops at the first difference, or one
  // that compares only a prefix, would let these through.
  r = await callRoute('POST', '/api/webhooks/beds24', {
    headers: { 'x-helio-secret': 'a-secret-at-least-16-char' }, body: {},
  });
  check('a secret one character short is refused', r.status === 401, r);
  r = await callRoute('POST', '/api/webhooks/beds24', {
    headers: { 'x-helio-secret': 'a-secret-at-least-16-chars-and-more' }, body: {},
  });
  check('a secret with extra on the end is refused', r.status === 401, r);
  check('still nothing imported', reservationCount() === 0);

  section('2 · With the secret, the booking lands');
  r = await callRoute('POST', '/api/webhooks/beds24', {
    headers: { 'x-helio-secret': process.env.HELIO_WEBHOOK_SECRET! },
    body: { propertyId: '346677' },
  });
  check('the call is accepted', r.status === 200, r);
  check('one reservation was created', reservationCount() === 1, reservationCount());
  const res1 = get<any>('SELECT * FROM reservations WHERE property_id = ?', P);
  check('…for the right guest', res1?.guest_name === 'Ayesha Silva', res1?.guest_name);
  // The whole reason `ota_channel` exists: through a hub the channel is BEDS24
  // for everything, and the OTA is what anyone actually wants to know.
  check('…and records which OTA it came from',
    res1?.ota_channel === 'Hostelworld', res1?.ota_channel);

  section('3 · The same booking twice is one reservation');
  // A booking arriving by webhook and again on the next poll must update, not
  // duplicate — otherwise real-time doubles the book.
  r = await callRoute('POST', '/api/webhooks/beds24', {
    headers: { 'x-helio-secret': process.env.HELIO_WEBHOOK_SECRET! },
    body: { propertyId: '346677' },
  });
  check('a repeat webhook does not duplicate it', reservationCount() === 1, reservationCount());

  await channels.importBookings(P, ACTOR, CH);
  check('…nor does a poll over the same booking', reservationCount() === 1, reservationCount());

  section('4 · Accepted even when it cannot be placed');
  // Beds24 disables a webhook that keeps erroring. Losing real-time for every
  // property because one call named an unknown one is the worse outcome.
  r = await callRoute('POST', '/api/webhooks/beds24', {
    headers: { 'x-helio-secret': process.env.HELIO_WEBHOOK_SECRET! },
    body: { propertyId: '999999' },
  });
  check('an unknown property still answers 200', r.status === 200, r);
  check('…and says why rather than pretending', !!r.body?.note, r.body);

  section('5 · The watermark only moves on a real import');
  const mark = () => get<{ v: string }>(
    `SELECT MAX(ts) AS v FROM channel_sync_log
      WHERE channel_id = ? AND direction = 'pull' AND status = 'success'
        AND action LIKE 'import bookings%'`, CH)?.v;

  const before = mark();
  check('an import leaves a watermark', !!before, before);

  // The defect: a connection test is a successful pull, and used to advance the
  // mark. Every booking modified between the last import and that test would
  // then never be asked for again.
  await new Promise((r2) => setTimeout(r2, 1100));
  await channels.testConnection(P, ACTOR, CH);
  await channels.discoverUnits(P, ACTOR, CH);
  check('a connection test does not move it', mark() === before, { before, after: mark() });
  check('…and neither does a discover', mark() === before);

  asked.length = 0;
  await channels.importBookings(P, ACTOR, CH);
  const query = asked[asked.length - 1] ?? '';
  check('the next import still asks from the last import, not the test',
    query.includes(encodeURIComponent(before!.slice(0, 10)))
    || query.includes(before!.slice(0, 10)), query);

  section('6 · A failed poll does not skip anything');
  const held = mark();
  bookings = [];
  failBookings = true;
  let threw = false;
  try { await channels.importBookings(P, ACTOR, CH); } catch { threw = true; }
  failBookings = false;
  check('a refused read is reported as a failure, not a quiet success', threw);
  check('a failure leaves the watermark where it was', mark() === held, { held, now: mark() });

  // The failed read above correctly marked the channel `error`, which is the
  // right thing for it to have done and means there is no *connected* channel
  // to report on. Prove the recovery, then carry on.
  check('a failure marks the channel in error',
    get<any>('SELECT status FROM channels WHERE id = ?', CH)?.status === 'error',
    get<any>('SELECT status FROM channels WHERE id = ?', CH)?.status);
  await channels.testConnection(P, ACTOR, CH);
  check('…and a good call clears it again',
    get<any>('SELECT status FROM channels WHERE id = ?', CH)?.status === 'connected');

  section('6b · A channel in error is still polled');
  // The fault this exists for, observed live: three good polls a minute apart,
  // one "fetch failed", then fifty-three minutes of silence with the API up and
  // Beds24 reachable. The loops selected `status = 'connected'`, so the failure
  // that set `error` also removed the channel from every future tick — nothing
  // succeeded, so nothing ever cleared the error. One blip, sync dead until
  // somebody noticed.
  //
  // The queries live in `index.ts`, which starts a server on import, so the
  // condition itself is asserted here rather than the loop.
  const { readFileSync } = await import('node:fs');
  const serverSrc = readFileSync(
    new URL('../src/index.ts', import.meta.url), 'utf8');

  const connectedOnly = serverSrc.match(/c\.status = 'connected'/g) ?? [];
  check('no sync loop selects only connected channels',
    connectedOnly.length === 0, `${connectedOnly.length} still do`);
  const recovering = serverSrc.match(/c\.status IN \('connected', 'error'\)/g) ?? [];
  check('the drain, booking poll and message poll all retry an errored channel',
    recovering.length >= 3, `${recovering.length} of 3`);

  // And prove the behaviour, not just the SQL: a channel left in error must
  // come back on its own once the far end recovers.
  run(`UPDATE channels SET status = 'error', last_error = 'fetch failed' WHERE id = ?`, CH);
  await channels.importBookings(P, ACTOR, CH);
  check('an errored channel recovers on the next successful import',
    get<any>('SELECT status FROM channels WHERE id = ?', CH)?.status === 'connected',
    get<any>('SELECT status FROM channels WHERE id = ?', CH)?.status);

  section('7 · Readiness is reported, not assumed');
  const status = await callRoute('GET', '/api/webhooks/beds24/status');
  check('the secret is seen as configured', status.body?.secretConfigured === true, status.body);
  check('the property id is known', status.body?.externalPropertyId === '346677', status.body);
  check('…so it reports ready', status.body?.ready === true, status.body);

  delete process.env.HELIO_WEBHOOK_SECRET;
  const noSecret = await callRoute('POST', '/api/webhooks/beds24', { body: {} });
  check('with no secret configured the endpoint refuses everything',
    noSecret.status === 503, noSecret);
  const st2 = await callRoute('GET', '/api/webhooks/beds24/status');
  check('…and readiness says so', st2.body?.ready === false, st2.body);

  process.stdout.write(`\n${checks - failures}/${checks} real-time checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('Bookings arrive on their own, and nothing is skipped.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  stub.server.close();
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows locks */ }
}
