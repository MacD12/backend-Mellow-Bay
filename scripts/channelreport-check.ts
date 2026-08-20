// ─────────────────────────────────────────────────────────────
// Exercises reporting a booking's outcome back to the channel it came from.
//
//   node --experimental-sqlite scripts/channelreport-check.ts
//
// There is no funded Beds24 account here, so this runs against a stub that
// speaks the documented protocol and can be told to answer in each of the ways
// a real channel does: cleanly, with a per-item rejection inside a 200, with an
// HTTP error, or by timing out.
//
// That last group is the point of the exercise. Beds24 reports write failures
// *inside* a successful HTTP response, so the temptation is to treat a 200 as
// done — which is exactly how a system ends up telling a receptionist a no-show
// was reported to Booking.com when it was not. Every case below asserts that a
// failure is recorded as a failure.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-report-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

// ─── The stub channel ────────────────────────────────────────
type Mode = 'ok' | 'item-error' | 'envelope-error' | 'http-error' | 'silent' | 'no-token';
let mode: Mode = 'ok';
const seen: Array<{ path: string; body: unknown }> = [];

function startStub(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        seen.push({ path: req.url ?? '', body });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (req.url?.startsWith('/authentication/token')) {
          if (mode === 'no-token') return send(401, { error: 'invalid refresh token' });
          return send(200, { token: 'stub-access-token', expiresIn: 3600 });
        }
        if (req.url?.startsWith('/bookings')) {
          switch (mode) {
            case 'http-error':
              return send(503, { error: 'Service unavailable' });
            case 'item-error':
              // A 200 whose body says the write failed — the dangerous shape.
              return send(200, { success: true, data: [{ success: false, errors: [{ error: 'Booking is already cancelled' }] }] });
            case 'envelope-error':
              return send(200, { success: false, errors: [{ error: 'Property not linked' }] });
            case 'silent':
              return send(200, { success: true, data: [] });
            default:
              return send(200, { success: true, data: [{ success: true, id: 99 }] });
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
const reports = await import('../src/services/channelreports.ts');

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

const ACTOR = { userId: 'usr_test', userName: 'Front Desk', propertyId: '' };
const TODAY = '2026-06-05';

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'RPT', 'Report Test Hotel', TODAY, nowIso(),
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
  const channelId = id('chn');
  run(
    `INSERT INTO channels(id, property_id, code, name, kind, active, status, settings, created_at)
     VALUES(?,?,'BDC','Booking.com','ota',1,'connected',?,?)`,
    channelId, propertyId,
    JSON.stringify({ credentials: { refreshToken: 'stub-refresh-token' } }), nowIso(),
  );
  return { propertyId, roomTypeId, ratePlanId, channelId };
}

let bookingSeq = 0;
function bookedThrough(ctx: any, opts: {
  channelCode?: string | null; otaReference?: string | null; arrival?: string;
} = {}) {
  const resId = id('res');
  bookingSeq++;
  const arrival = opts.arrival ?? addDays(TODAY, -1);
  run(
    `INSERT INTO reservations(id, property_id, confirmation, status, guest_name, arrival, departure,
                              nights, adults, children, room_type_id, rate_plan_id, currency,
                              total_minor, deposit_required_minor, commission_minor, source, origin,
                              channel_code, ota_reference, created_at, updated_at)
     VALUES(?,?,?,'No-show',?,?,?,1,1,0,?,?,'USD',10000,0,0,'OTA','channel',?,?,?,?)`,
    resId, ctx.propertyId, `RPT-${String(bookingSeq).padStart(4, '0')}`, 'Absent Guest',
    arrival, addDays(arrival, 1), ctx.roomTypeId, ctx.ratePlanId,
    opts.channelCode === undefined ? 'BDC' : opts.channelCode,
    opts.otaReference === undefined ? `BDC-${bookingSeq}` : opts.otaReference,
    nowIso(), nowIso(),
  );
  return resId;
}

function stored(resId: string) {
  return get<any>(
    `SELECT channel_report_status AS status, channel_reported_at AS at, channel_report_error AS error,
            channel_report_attempts AS attempts, channel_report_kind AS kind,
            channel_report_request AS request, channel_report_response AS response
       FROM reservations WHERE id = ?`,
    resId,
  );
}

async function main() {
  process.stdout.write(`\nChannel report checks\n${'─'.repeat(21)}\n`);
  process.stdout.write(`Stub channel on ${stub.base}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;

  section('1 · Eligibility is answered before anything is sent');
  const direct = bookedThrough(ctx, { channelCode: null, otaReference: null });
  const directElig = reports.reportEligibility(ctx.propertyId, direct, 'no_show', TODAY);
  check('a direct booking is not reportable', directElig.reportable === false);
  check('and says why in words',
    /did not come from a channel/i.test(directElig.reason ?? ''), directElig.reason);

  const otaRes = bookedThrough(ctx);
  const elig = reports.reportEligibility(ctx.propertyId, otaRes, 'no_show', TODAY);
  check('an OTA booking is reportable', elig.reportable === true, elig);
  check('the channel is named', elig.channelName === 'Booking.com', elig.channelName);
  check('the OTA reference is carried', !!elig.otaReference, elig.otaReference);
  check('the window is stated', elig.windowDays === 2, elig.windowDays);
  check('the closing date is worked out',
    elig.windowClosesOn === addDays(elig.otaReference ? addDays(TODAY, -1) : TODAY, 2),
    elig.windowClosesOn);
  check('nothing is claimed as confirmed', elig.unconfirmed === true);

  run(`UPDATE channels SET status = 'error' WHERE id = ?`, ctx.channelId);
  const broken = reports.reportEligibility(ctx.propertyId, otaRes, 'no_show', TODAY);
  check('a disconnected channel is not reportable', broken.reportable === false);
  check('and says so plainly, in words a receptionist can act on',
    /channel manager/i.test(broken.reason ?? '') && !/^\w+ is error/.test(broken.reason ?? ''),
    broken.reason);
  run(`UPDATE channels SET status = 'connected' WHERE id = ?`, ctx.channelId);

  section('2 · A clean success is recorded as one');
  mode = 'ok';
  const good = await reports.reportToChannel(ctx.propertyId, ACTOR, otaRes, 'no_show', TODAY);
  check('the report succeeds', good.status === 'reported', good);
  check('a timestamp is recorded', !!good.reportedAt);
  check('the attempt is counted', good.attempts === 1, good.attempts);
  const goodRow = stored(otaRes);
  check('the reservation carries the outcome', goodRow.status === 'reported', goodRow);
  check('…and the kind that was reported', goodRow.kind === 'no_show', goodRow.kind);
  check('…with no error', goodRow.error === null, goodRow.error);
  check('what was sent is kept', JSON.parse(goodRow.request).subStatus === 'noShow', goodRow.request);
  check('what came back is kept', !!goodRow.response, goodRow.response);

  const sentBody: any = seen.filter((s) => s.path.startsWith('/bookings')).pop()?.body;
  check('the channel was sent an array of bookings', Array.isArray(sentBody), sentBody);
  check('carrying the OTA reference, not our own id',
    typeof sentBody?.[0]?.id === 'string' && sentBody[0].id.startsWith('BDC-'), sentBody?.[0]?.id);
  check('and a cancellation reason', !!sentBody?.[0]?.cancelReason, sentBody?.[0]);

  section('3 · A 200 that says "no" is a failure');
  // The whole reason this check exists: Beds24 returns write failures inside a
  // successful HTTP response.
  mode = 'item-error';
  const itemFail = bookedThrough(ctx);
  const rejected = await reports.reportToChannel(ctx.propertyId, ACTOR, itemFail, 'no_show', TODAY);
  check('a per-item rejection is not called a success', rejected.status === 'failed', rejected);
  check('the channel\'s own words are kept',
    /already cancelled/i.test(rejected.error ?? ''), rejected.error);
  check('no reported-at timestamp is written', rejected.reportedAt === null);
  check('the reservation is left marked failed', stored(itemFail).status === 'failed');

  mode = 'envelope-error';
  const envFail = bookedThrough(ctx);
  const envelope = await reports.reportToChannel(ctx.propertyId, ACTOR, envFail, 'no_show', TODAY);
  check('an envelope-level rejection also fails', envelope.status === 'failed', envelope);
  check('with its reason kept', /not linked/i.test(envelope.error ?? ''), envelope.error);

  mode = 'silent';
  const silentRes = bookedThrough(ctx);
  const silent = await reports.reportToChannel(ctx.propertyId, ACTOR, silentRes, 'no_show', TODAY);
  check('a 200 that says nothing about the booking is not a success',
    silent.status === 'failed', silent);
  check('and says so honestly',
    /said nothing about the booking/i.test(silent.error ?? ''), silent.error);

  section('4 · Transport failures');
  mode = 'http-error';
  const httpFail = bookedThrough(ctx);
  const http = await reports.reportToChannel(ctx.propertyId, ACTOR, httpFail, 'no_show', TODAY);
  check('an HTTP error is a failure', http.status === 'failed', http);
  check('the status code is kept', /503/.test(http.error ?? ''), http.error);

  mode = 'no-token';
  // Drop the cached access token — otherwise the client never asks for a new
  // one and the refusal is never exercised.
  run(`UPDATE channels SET settings = ? WHERE id = ?`,
    JSON.stringify({ credentials: { refreshToken: 'stub-refresh-token' } }), ctx.channelId);
  const authFail = bookedThrough(ctx);
  const noAuth = await reports.reportToChannel(ctx.propertyId, ACTOR, authFail, 'no_show', TODAY);
  check('a token refusal is a failure, not a crash', noAuth.status === 'failed', noAuth);
  check('with the reason kept', !!noAuth.error, noAuth.error);

  section('5 · Retrying');
  mode = 'http-error';
  const retryRes = bookedThrough(ctx);
  await reports.reportToChannel(ctx.propertyId, ACTOR, retryRes, 'no_show', TODAY);
  check('the first attempt is counted', stored(retryRes).attempts === 1, stored(retryRes).attempts);
  await reports.reportToChannel(ctx.propertyId, ACTOR, retryRes, 'no_show', TODAY);
  check('a retry increments rather than resets', stored(retryRes).attempts === 2,
    stored(retryRes).attempts);
  check('still failed', stored(retryRes).status === 'failed');

  mode = 'ok';
  const recovered = await reports.reportToChannel(ctx.propertyId, ACTOR, retryRes, 'no_show', TODAY);
  check('a later success clears the failure', recovered.status === 'reported', recovered);
  check('the error is cleared with it', stored(retryRes).error === null, stored(retryRes).error);
  check('and the attempt count is kept', stored(retryRes).attempts === 3, stored(retryRes).attempts);

  section('6 · The reporting window');
  const stale = bookedThrough(ctx, { arrival: addDays(TODAY, -10) });
  const staleElig = reports.reportEligibility(ctx.propertyId, stale, 'no_show', TODAY);
  check('a passed window is flagged', staleElig.windowPassed === true, staleElig);
  check('the days left go negative', (staleElig.daysLeft ?? 0) < 0, staleElig.daysLeft);
  check('it explains what the limit is understood to be',
    /2 day\(s\) after arrival/.test(staleElig.reason ?? ''), staleElig.reason);
  // Refusing on an unverified number would be the wrong kind of confidence.
  check('but the attempt is still allowed', staleElig.reportable === true);
  const staleResult = await reports.reportToChannel(ctx.propertyId, ACTOR, stale, 'no_show', TODAY);
  check('and the channel gets the final word', staleResult.status === 'reported', staleResult);

  section('7 · The other channel actions');
  mode = 'ok';
  const cancelled = bookedThrough(ctx);
  const atProperty = await reports.reportToChannel(
    ctx.propertyId, ACTOR, cancelled, 'cancelled_at_property', TODAY);
  check('an at-property cancellation can be reported', atProperty.status === 'reported');
  check('it is stored under its own kind',
    stored(cancelled).kind === 'cancelled_at_property', stored(cancelled).kind);
  check('and carries no no-show sub-status',
    JSON.parse(stored(cancelled).request).subStatus === undefined,
    stored(cancelled).request);

  const badCard = bookedThrough(ctx);
  await reports.reportToChannel(ctx.propertyId, ACTOR, badCard, 'invalid_card', TODAY);
  check('an invalid card can be reported',
    JSON.parse(stored(badCard).request).subStatus === 'invalidCard', stored(badCard).request);

  section('8 · The work list');
  const untouched = bookedThrough(ctx);      // never reported at all
  const pending = reports.unreportedNoShows(ctx.propertyId, TODAY);
  check('a booking nobody has tried to report is listed',
    pending.some((p) => p.id === untouched), pending.map((p) => p.confirmation));
  check('reported bookings drop off the list',
    !pending.some((p) => p.id === otaRes), pending.map((p) => p.confirmation));
  check('failed ones stay on it',
    pending.some((p) => p.id === itemFail), pending.map((p) => p.confirmation));
  check('never-attempted ones are on it too',
    pending.some((p) => p.status === 'not-reported'), pending.map((p) => p.status));
  check('each entry carries its window',
    pending.every((p) => !!p.windowClosesOn), pending[0]);
  check('and whether the channel is connected',
    pending.every((p) => p.channelConnected === true), pending[0]);

  section('9 · The sync log and audit trail');
  const syncRows = all<any>(
    `SELECT * FROM channel_sync_log WHERE property_id = ? ORDER BY ts`, ctx.propertyId);
  check('every attempt is in the sync log', syncRows.length >= 8, syncRows.length);
  check('successes are logged as such',
    syncRows.some((r) => r.status === 'success' && /No-show report/.test(r.action)),
    syncRows.slice(0, 2));
  check('failures are logged with their error',
    syncRows.some((r) => r.status === 'failed' && !!r.error), syncRows.slice(0, 2));

  const auditRows = all<any>(
    `SELECT * FROM audit_log WHERE action = 'channel.report' ORDER BY ts`);
  check('every attempt is audited', auditRows.length >= 8, auditRows.length);
  check('and marked elevated', auditRows.every((r) => r.elevated === 1), auditRows[0]?.elevated);

  section('10 · Reservation state for the screen');
  const state = reports.reportState(ctx.propertyId, itemFail, TODAY);
  check('the screen can see the failure', state.status === 'failed', state);
  check('with the channel\'s reason', !!state.error, state.error);
  check('and the raw exchange for diagnosis', !!state.request && !!state.response);
  check('the available actions are offered', state.kinds.length === 3, state.kinds);
  check('nothing is presented as confirmed', state.unconfirmed === true);

  process.stdout.write(`\n${checks - failures}/${checks} channel report checks passed\n`);
  // `process.exit()` with the stub server still listening trips a libuv
  // assertion on Windows, which buries the results under a crash dump.
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write(
    'Reports are sent, and a failure is never recorded as a success.\n'
    + '🔌 The payload and window still need confirming against a live Beds24 account.\n');
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
