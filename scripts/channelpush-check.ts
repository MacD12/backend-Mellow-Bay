// ─────────────────────────────────────────────────────────────
// Exercises the availability/rate push, and specifically what happens when the
// channel rejects part of it.
//
//   node --experimental-sqlite scripts/channelpush-check.ts
//
// Beds24 answers a write with a 200 whose body carries per-item results. The
// push path used to read only the envelope, so a response saying "these rooms
// were rejected" was recorded as a clean success: the channel flipped to
// `connected`, the previous error was wiped, and the queued change was dropped
// without retry.
//
// The consequence is the one thing this whole system exists to prevent —
// Booking.com carries on selling a room the property has closed, and Helio
// shows green. So the assertions below are mostly about *not* claiming success.
//
// It builds its own database and speaks to a local stub; nothing real is called.
// ─────────────────────────────────────────────────────────────
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-push-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

type Mode = 'ok' | 'item-rejected' | 'envelope-error' | 'envelope-false' | 'empty' | 'multi-property';
let mode: Mode = 'ok';

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
        // Listing properties is what `testConnection` calls, and what the
        // connection learns its property id from.
        if (req.url?.startsWith('/properties')) {
          return send(200, {
            success: true,
            data: mode === 'multi-property'
              ? [{ id: 111, name: 'First' }, { id: 222, name: 'Second' }]
              : [{ id: 346677, name: 'Stub Property' }],
          });
        }
        if (req.url?.startsWith('/inventory/rooms/calendar')) {
          switch (mode) {
            case 'item-rejected':
              // The dangerous shape: 200, envelope success, room rejected.
              return send(200, {
                success: true,
                data: [
                  { success: true, roomId: '1' },
                  { success: false, roomId: '2', errors: [{ error: 'Rate below channel minimum' }] },
                ],
              });
            case 'envelope-error':
              return send(200, { success: true, errors: [{ error: 'Property is locked' }], data: [] });
            case 'envelope-false':
              return send(200, { success: false, data: [{ success: true }] });
            case 'empty':
              return send(200, { success: true, data: [] });
            default:
              return send(200, { success: true, data: [{ success: true, roomId: '1' }] });
          }
        }
        send(404, { error: 'not found' });
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

const { migrate, run, get, all } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const { readWriteResult } = await import('../src/channels/beds24.ts');
const channels = await import('../src/services/channels.ts');

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

const ACTOR = { userId: 'usr_test', userName: 'Revenue', propertyId: '' };
const TODAY = '2026-06-01';

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'PSH', 'Push Test Hotel', TODAY, nowIso(),
  );
  const roomTypeId = id('rt');
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                            max_adults, max_children, default_rate_minor, extra_adult_minor,
                            extra_child_minor, sort_order, active, created_at)
     VALUES(?,?,'STD','Standard','room',2,2,2,0,10000,0,0,1,1,?)`,
    roomTypeId, propertyId, nowIso(),
  );
  const ratePlanId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, active, created_at)
     VALUES(?,?,'BAR','Best Available',1,?)`,
    ratePlanId, propertyId, nowIso(),
  );
  run(
    `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
     VALUES(?,?,?,'101',1,'Vacant Clean',1,?)`,
    id('rm'), propertyId, roomTypeId, nowIso(),
  );
  const channelId = id('chn');
  run(
    `INSERT INTO channels(id, property_id, code, name, kind, active, status, settings, created_at)
     VALUES(?,?,'BDC','Booking.com','ota',1,'connected',?,?)`,
    channelId, propertyId, JSON.stringify({ credentials: { refreshToken: 'stub' } }), nowIso(),
  );
  run(
    `INSERT INTO channel_mappings(id, property_id, channel_id, room_type_id, rate_plan_id,
                                  external_room_id, active, created_at)
     VALUES(?,?,?,?,?,'1',1,?)`,
    id('cm'), propertyId, channelId, roomTypeId, ratePlanId, nowIso(),
  );
  return { propertyId, roomTypeId, ratePlanId, channelId };
}

function channelRow(channelId: string) {
  return get<any>('SELECT * FROM channels WHERE id = ?', channelId);
}

function queueOne(ctx: any, reason: string) {
  const qid = id('cq');
  run(
    `INSERT INTO channel_queue(id, property_id, channel_id, room_type_id, date_from, date_to,
                               scope, reason, status, created_at)
     VALUES(?,?,?,?,?,?,'rates',?,'queued',?)`,
    qid, ctx.propertyId, ctx.channelId, ctx.roomTypeId, TODAY, addDays(TODAY, 3), reason, nowIso(),
  );
  return qid;
}

async function main() {
  process.stdout.write(`\nChannel push checks\n${'─'.repeat(19)}\nStub on ${stub.base}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;
  const P = ctx.propertyId;

  section('1 · Reading a write response');
  // The pure function, from every angle — this is the fix in one place.
  check('a clean success is a success',
    readWriteResult({ data: { success: true, data: [{ success: true }] } }).ok === true);
  check('an item failure is NOT a success',
    readWriteResult({
      data: { success: true, data: [{ success: true }, { success: false, errors: [{ error: 'no' }] }] },
    }).ok === false);
  check('and the item error is carried out',
    readWriteResult({
      data: { success: true, data: [{ success: false, errors: [{ error: 'Rate too low' }] }] },
    }).errors.length === 1);
  check('an item rejected without a reason still fails',
    readWriteResult({ data: { success: true, data: [{ success: false }] } }).ok === false);
  check('…and says so rather than reporting nothing',
    readWriteResult({ data: { success: true, data: [{ success: false }] } }).errors.length === 1);
  check('an envelope error fails even with good items',
    readWriteResult({
      data: { success: true, errors: [{ error: 'locked' }], data: [{ success: true }] },
    }).ok === false);
  check('success:false on the envelope fails',
    readWriteResult({ data: { success: false, data: [{ success: true }] } }).ok === false);
  check('the count of rejected items is reported',
    readWriteResult({
      data: { success: true, data: [{ success: true }, { success: false }, { success: false }] },
    }).failedItems === 2);

  section('2 · A rejected push does not claim the channel is healthy');
  run(`UPDATE channels SET status = 'error', last_error = 'Earlier problem' WHERE id = ?`,
    ctx.channelId);
  mode = 'item-rejected';
  const rejected: any = await channels.pushToChannel(P, ACTOR, ctx.channelId, {
    from: TODAY, to: addDays(TODAY, 3),
  });
  check('the push reports failure', rejected.ok === false, rejected);
  check('it counts what was rejected', rejected.failedItems === 1, rejected.failedItems);

  const afterReject = channelRow(ctx.channelId);
  // The three things the old code got wrong.
  check('the channel is NOT marked connected',
    afterReject.status !== 'connected', afterReject.status);
  check('the error is recorded rather than cleared',
    !!afterReject.last_error, afterReject.last_error);
  check('and it names what the channel objected to',
    /minimum/i.test(afterReject.last_error ?? ''), afterReject.last_error);

  const log = all<any>(
    `SELECT * FROM channel_sync_log WHERE property_id = ? ORDER BY ts DESC LIMIT 1`, P)[0];
  check('the sync log records a failure', log?.status === 'failed', log?.status);
  check('and mentions the rejected rooms', /rejected/i.test(log?.action ?? ''), log?.action);

  section('3 · A rejected push stays in the queue');
  run('DELETE FROM channel_queue WHERE property_id = ?', P);
  const qid = queueOne(ctx, 'rate.bulk');
  mode = 'item-rejected';
  await channels.processQueue(P, ACTOR, 5);
  const queued = get<any>('SELECT status, attempts, last_error FROM channel_queue WHERE id = ?', qid);
  // Previously this was marked 'sent' and the change was lost for good.
  check('the row is not marked sent', queued.status !== 'sent', queued.status);
  check('it is left queued for another attempt', queued.status === 'queued', queued.status);
  check('the attempt is counted', queued.attempts === 1, queued.attempts);
  check('and the reason is kept', !!queued.last_error, queued.last_error);

  section('4 · A clean push still works');
  mode = 'ok';
  run('DELETE FROM channel_queue WHERE property_id = ?', P);
  const okQid = queueOne(ctx, 'rate.bulk');
  const okPush: any = await channels.pushToChannel(P, ACTOR, ctx.channelId, {
    from: TODAY, to: addDays(TODAY, 3),
  });
  check('the push reports success', okPush.ok === true, okPush);
  const healthy = channelRow(ctx.channelId);
  check('the channel is marked connected', healthy.status === 'connected', healthy.status);
  check('and the old error is cleared', healthy.last_error === null, healthy.last_error);

  await channels.processQueue(P, ACTOR, 5);
  check('the queued change is marked sent',
    get<any>('SELECT status FROM channel_queue WHERE id = ?', okQid)?.status === 'sent');

  section('5 · Other rejection shapes');
  for (const [label, m] of [
    ['an envelope error', 'envelope-error'],
    ['success:false on the envelope', 'envelope-false'],
  ] as const) {
    mode = m;
    run(`UPDATE channels SET status = 'connected', last_error = NULL WHERE id = ?`, ctx.channelId);
    const r: any = await channels.pushToChannel(P, ACTOR, ctx.channelId, {
      from: TODAY, to: addDays(TODAY, 3),
    });
    check(`${label} is a failure`, r.ok === false, r);
    check(`…and does not leave the channel connected`,
      channelRow(ctx.channelId).status !== 'connected', channelRow(ctx.channelId).status);
  }

  // ── The property id the writes need ─────────────────────────
  section('5b · Connecting learns which property this is');
  // Reads work without it — the token already scopes them — so a null
  // `external_property_id` looks harmless right up until the first *write*,
  // which fails with "this channel has no property id" long after anyone would
  // connect that to the connection they made days earlier. It is filled in from
  // the connection that was just proved.
  run(`UPDATE channels SET external_property_id = NULL WHERE id = ?`, ctx.channelId);
  mode = 'ok';
  await channels.connectBeds24(P, ACTOR, ctx.channelId, { refreshToken: 'stub-token' });
  const learned = channelRow(ctx.channelId).external_property_id;
  check('a single property is adopted automatically', !!learned, learned);

  // Several is a different matter: writing inventory to the wrong property is
  // not a mistake anyone should make on the caller's behalf.
  run(`UPDATE channels SET external_property_id = NULL WHERE id = ?`, ctx.channelId);
  mode = 'multi-property';
  await channels.connectBeds24(P, ACTOR, ctx.channelId, { refreshToken: 'stub-token' });
  check('…but several are left for a person to choose',
    channelRow(ctx.channelId).external_property_id === null,
    channelRow(ctx.channelId).external_property_id);
  mode = 'ok';

  // ── Read-only mode ──────────────────────────────────────────
  // The catch that stops a freshly connected installation publishing its own
  // setup mistakes before anybody has looked at them. Worth asserting precisely
  // because it is a *negative*: "nothing was sent" looks identical to "the
  // guard is broken and the stub happened not to be called" unless the refusal
  // itself is checked.
  section('6 · Read-only installations never write outward');
  mode = 'ok';
  const priorReadOnly = process.env.HELIO_CHANNEL_READONLY;
  process.env.HELIO_CHANNEL_READONLY = '1';
  try {
    check('the switch is read', channels.readOnlyChannels() === true);

    run(`UPDATE channels SET status = 'connected', last_error = NULL WHERE id = ?`, ctx.channelId);
    let refused: any = null;
    try {
      await channels.pushToChannel(P, ACTOR, ctx.channelId, {
        from: TODAY, to: addDays(TODAY, 3), scope: 'rates',
      });
    } catch (e: any) { refused = e; }
    check('a push is refused outright', refused !== null, refused?.message);
    check('…and names the switch, so the cause is findable',
      /HELIO_CHANNEL_READONLY/.test(refused?.message ?? ''), refused?.message);

    // The queue must survive. Discarding it would leave the OTAs holding
    // whatever they last heard with nothing left to correct them — the exact
    // silent divergence the rest of this suite exists to prevent.
    const roQid = queueOne(ctx, 'while read-only');
    const drained: any = await channels.processQueue(P, ACTOR, 5);
    check('the background drain sends nothing', drained.sent === 0, drained);
    check('…and the work stays queued for when pushing resumes',
      get<any>('SELECT status FROM channel_queue WHERE id = ?', roQid)?.status === 'queued',
      get<any>('SELECT status FROM channel_queue WHERE id = ?', roQid)?.status);
  } finally {
    if (priorReadOnly === undefined) delete process.env.HELIO_CHANNEL_READONLY;
    else process.env.HELIO_CHANNEL_READONLY = priorReadOnly;
  }
  check('unsetting it restores normal pushing', channels.readOnlyChannels() === false);

  process.stdout.write(`\n${checks - failures}/${checks} channel push checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('A rejected push is recorded as rejected and stays queued for retry.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  stub.server.close();
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
