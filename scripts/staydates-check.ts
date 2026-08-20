// ─────────────────────────────────────────────────────────────
// Exercises extending and shortening a stay.
//
//   node --experimental-sqlite scripts/staydates-check.ts
//
// The rules worth proving are the ones a general "amend the booking" path gets
// wrong: that adding a night must not re-price the nights already agreed, that
// a night the night audit has posted cannot be dropped, and that a room is
// never taken away from a guest without saying so.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-stay-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run, get, all } = await import('../src/db.ts');
const { id, nowIso } = await import('../src/lib/util.ts');
const stay = await import('../src/services/staydates.ts');
const reservations = await import('../src/services/reservations.ts');

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

const ACTOR = { userId: 'usr_test', userName: 'Test Operator', propertyId: '' };
const RATE = 10_000;      // $100 a night

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en','2026-06-01','14:00','11:00',1,?)`,
    propertyId, 'STY', 'Stay Test Hotel', nowIso(),
  );
  const roomTypeId = id('rt');
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                            max_adults, max_children, default_rate_minor, extra_adult_minor,
                            extra_child_minor, sort_order, active, created_at)
     VALUES(?,?,'STD','Standard','room',2,2,2,0,?,0,0,1,1,?)`,
    roomTypeId, propertyId, RATE, nowIso(),
  );
  const ratePlanId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, active, created_at)
     VALUES(?,?,'BAR','Best Available',1,?)`,
    ratePlanId, propertyId, nowIso(),
  );
  const rooms: string[] = [];
  for (const number of ['101', '102']) {
    const rid = id('rm');
    run(
      `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
       VALUES(?,?,?,?,1,'Vacant Clean',1,?)`,
      rid, propertyId, roomTypeId, number, nowIso(),
    );
    rooms.push(rid);
  }
  return { propertyId, roomTypeId, ratePlanId, rooms };
}

function book(ctx: any, arrival: string, departure: string, guest = 'Test Guest') {
  return reservations.createReservation(ctx.propertyId, ACTOR, {
    guestName: guest, arrival, departure,
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId,
    adults: 1, children: 0,
  } as any);
}

function nightsOf(reservationId: string) {
  return all<any>(
    'SELECT date, rate_minor, posted, room_id FROM reservation_nights WHERE reservation_id = ? ORDER BY date',
    reservationId,
  );
}

async function main() {
  process.stdout.write(`\nStay date checks\n${'─'.repeat(16)}\nWorking in ${workdir}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;

  section('1 · Previewing an extension');
  const a = book(ctx, '2026-06-10', '2026-06-13');       // 3 nights
  reservations.assignRoom(ctx.propertyId, ACTOR, a.id, { roomId: ctx.rooms[0] });

  const p = stay.previewStayChange(ctx.propertyId, a.id, { departure: '2026-06-15' });
  check('the preview is allowed', p.ok === true, p.blockers);
  check('it is recognised as an extension', p.kind === 'extend', p.kind);
  check('two nights are added', p.addedNights.length === 2, p.addedNights);
  check('the added nights are the right dates',
    p.addedNights.map((n) => n.date).join(',') === '2026-06-13,2026-06-14',
    p.addedNights.map((n) => n.date));
  check('nothing is removed', p.removedNights.length === 0);
  check('the three existing nights are kept', p.keptNights === 3, p.keptNights);
  check('the extra cost is quoted before committing',
    p.deltaMinor === 2 * RATE, { delta: p.deltaMinor, expected: 2 * RATE });
  check('the new total is shown', p.proposed.totalMinor === 5 * RATE, p.proposed);
  check('the room is kept', p.roomKept === true);
  check('previewing wrote nothing', nightsOf(a.id).length === 3, nightsOf(a.id).length);

  section('2 · Extending keeps the rate the guest was quoted');
  // Move the market after the booking is made. A general re-price would sweep
  // the original nights up with the new one; an extension must not.
  run(
    `INSERT INTO rate_calendar(id, property_id, room_type_id, rate_plan_id, date, price_minor, updated_at)
     VALUES(?,?,?,?,?,?,?)`,
    id('rc'), ctx.propertyId, ctx.roomTypeId, ctx.ratePlanId, '2026-06-13', 25_000, nowIso(),
  );
  const extended = stay.changeStayDates(ctx.propertyId, ACTOR, a.id, { departure: '2026-06-14' });
  const nights = nightsOf(a.id);
  check('the stay is now four nights', extended.nights === 4, extended);
  check('the original three nights kept their rate',
    nights.slice(0, 3).every((n) => n.rate_minor === RATE),
    nights.map((n) => n.rate_minor));
  check('the new night is priced at the current rate',
    nights[3].rate_minor === 25_000, nights[3]);
  check('the total is the sum of the nights',
    extended.totalMinor === 3 * RATE + 25_000, extended.totalMinor);
  check('the reservation row agrees with its nights',
    get<any>('SELECT departure, nights, total_minor FROM reservations WHERE id = ?', a.id)?.total_minor
      === extended.totalMinor);
  check('the added night inherits the room',
    nights[3].room_id === ctx.rooms[0], nights[3].room_id);

  section('3 · A change is pushed to the channels');
  const pushes = all<any>(
    `SELECT * FROM channel_queue WHERE property_id = ? AND reason = 'reservation.extend'`, ctx.propertyId);
  // No channel is connected in this fixture, so nothing should be queued —
  // the point is that the call is made and does not throw.
  check('extending does not fail without a channel', Array.isArray(pushes));

  run(
    `INSERT INTO channels(id, property_id, code, name, kind, active, status, created_at)
     VALUES(?,?,'BDC','Booking.com','ota',1,'connected',?)`,
    id('chn'), ctx.propertyId, nowIso(),
  );
  stay.changeStayDates(ctx.propertyId, ACTOR, a.id, { departure: '2026-06-15' });
  const queued = all<any>(
    `SELECT * FROM channel_queue WHERE property_id = ? AND reason = 'reservation.extend'`, ctx.propertyId);
  check('with a channel connected, a push is queued', queued.length === 1, queued.length);
  check('the pushed window covers the changed dates',
    queued[0]?.date_from <= '2026-06-10' && queued[0]?.date_to >= '2026-06-15',
    `${queued[0]?.date_from}→${queued[0]?.date_to}`);

  section('4 · Shortening');
  const short = stay.previewStayChange(ctx.propertyId, a.id, { departure: '2026-06-12' });
  check('it is recognised as a shortening', short.kind === 'shorten', short.kind);
  check('three nights come off', short.removedNights.length === 3, short.removedNights);
  check('the refund is quoted as a negative delta', short.deltaMinor < 0, short.deltaMinor);
  check('the remaining stay is two nights', short.proposed.nights === 2, short.proposed);

  const shortened = stay.changeStayDates(ctx.propertyId, ACTOR, a.id, { departure: '2026-06-12' });
  check('the stay is now two nights', shortened.nights === 2, shortened);
  check('only two nights remain on the reservation', nightsOf(a.id).length === 2);
  check('a shortening queues its own push',
    all<any>(`SELECT * FROM channel_queue WHERE reason = 'reservation.shorten'`).length === 1);

  section('5 · A posted night cannot be dropped');
  const b = book(ctx, '2026-07-01', '2026-07-05');
  run(`UPDATE reservation_nights SET posted = 1 WHERE reservation_id = ? AND date IN ('2026-07-01','2026-07-02')`, b.id);
  const blocked = stay.previewStayChange(ctx.propertyId, b.id, { departure: '2026-07-02' });
  check('the preview refuses', blocked.ok === false, blocked.blockers);
  check('it says which nights are posted',
    blocked.blockers.some((x) => x.includes('2026-07-02')), blocked.blockers);
  check('it explains what to do instead',
    blocked.blockers.some((x) => /void the charges/i.test(x)), blocked.blockers);

  let refused = false;
  try {
    stay.changeStayDates(ctx.propertyId, ACTOR, b.id, { departure: '2026-07-02' });
  } catch { refused = true; }
  check('committing is refused too', refused);
  check('the nights are untouched', nightsOf(b.id).length === 4);

  // Shortening down to the last posted night is fine.
  const ok = stay.changeStayDates(ctx.propertyId, ACTOR, b.id, { departure: '2026-07-03' });
  check('shortening to just after the posted nights is allowed', ok.nights === 2, ok);

  section('6 · The room is never dropped silently');
  const c = book(ctx, '2026-08-01', '2026-08-03');
  reservations.assignRoom(ctx.propertyId, ACTOR, c.id, { roomId: ctx.rooms[0] });
  // Someone else takes that room for the night the guest wants to add.
  const blocker = book(ctx, '2026-08-03', '2026-08-04', 'Blocking Guest');
  reservations.assignRoom(ctx.propertyId, ACTOR, blocker.id, { roomId: ctx.rooms[0] });

  const clash = stay.previewStayChange(ctx.propertyId, c.id, { departure: '2026-08-04' });
  check('the preview says the room cannot be kept', clash.roomKept === false, clash);
  check('and names the room that is at risk', clash.roomNumber === '101', clash.roomNumber);
  check('it offers the rooms that are free',
    clash.alternativeRooms.some((r) => r.number === '102'), clash.alternativeRooms);
  check('the extension itself is still possible', clash.ok === true, clash.blockers);

  let roomRefusal: any = null;
  try {
    stay.changeStayDates(ctx.propertyId, ACTOR, c.id, { departure: '2026-08-04' });
  } catch (e: any) { roomRefusal = e; }
  check('committing without choosing a room is refused', !!roomRefusal);
  check('the refusal explains why', /not free for the new dates/i.test(roomRefusal?.message ?? ''),
    roomRefusal?.message);
  check('the stay is unchanged after the refusal',
    get<any>('SELECT departure FROM reservations WHERE id = ?', c.id)?.departure === '2026-08-03');

  const moved = stay.changeStayDates(ctx.propertyId, ACTOR, c.id, {
    departure: '2026-08-04', roomId: ctx.rooms[1],
  });
  check('choosing the offered room succeeds', moved.nights === 3, moved);
  check('the move is reported back', moved.roomChanged === true);
  check('every night moved, not just the new one',
    nightsOf(c.id).every((n) => n.room_id === ctx.rooms[1]),
    nightsOf(c.id).map((n) => n.room_id));

  // Releasing the room instead is allowed, but only when asked for explicitly.
  const d = book(ctx, '2026-09-01', '2026-09-03');
  reservations.assignRoom(ctx.propertyId, ACTOR, d.id, { roomId: ctx.rooms[0] });
  const blocker2 = book(ctx, '2026-09-03', '2026-09-04', 'Blocking Guest 2');
  reservations.assignRoom(ctx.propertyId, ACTOR, blocker2.id, { roomId: ctx.rooms[0] });
  const released = stay.changeStayDates(ctx.propertyId, ACTOR, d.id, {
    departure: '2026-09-04', releaseRoom: true,
  });
  check('releasing the room is allowed when asked for', released.roomId === null, released);

  section('7 · Availability and selling rules');
  // Fill the house for one night, then try to extend into it.
  const e = book(ctx, '2026-10-01', '2026-10-02');
  book(ctx, '2026-10-02', '2026-10-03', 'Guest A');
  book(ctx, '2026-10-02', '2026-10-03', 'Guest B');
  const full = stay.previewStayChange(ctx.propertyId, e.id, { departure: '2026-10-03' });
  check('extending into a full night is blocked', full.ok === false, full.blockers);
  check('the blocker names the date',
    full.blockers.some((x) => x.includes('2026-10-02')), full.blockers);

  // A minimum stay that the shortened stay would break.
  const f = book(ctx, '2026-11-01', '2026-11-05');
  run(
    `INSERT INTO restrictions(id, property_id, room_type_id, rate_plan_id, channel_code,
                              date_from, date_to, type, value, note, active, created_by, created_at)
     VALUES(?,?,NULL,NULL,NULL,'2026-11-01','2026-11-01','min-stay',3,'Peak weekend',1,'test',?)`,
    id('rst'), ctx.propertyId, nowIso(),
  );
  const tooShort = stay.previewStayChange(ctx.propertyId, f.id, { departure: '2026-11-03' });
  check('a min-stay breach is reported as a violation', tooShort.violations.length > 0, tooShort.violations);
  check('the violation is explained in words',
    /minimum stay/i.test(tooShort.violations[0]?.message ?? ''), tooShort.violations[0]);

  let violationRefused: any = null;
  try {
    stay.changeStayDates(ctx.propertyId, ACTOR, f.id, { departure: '2026-11-03' });
  } catch (e2: any) { violationRefused = e2; }
  check('the change is refused', !!violationRefused);
  check('and the reason travels with the refusal',
    !!violationRefused?.details?.violations?.length, violationRefused?.details);

  section('8 · Guardrails');
  const g = book(ctx, '2026-12-01', '2026-12-03');
  let sameDates = false;
  try { stay.changeStayDates(ctx.propertyId, ACTOR, g.id, { departure: '2026-12-03' }); }
  catch { sameDates = true; }
  check('changing to the dates it already has is refused', sameDates);

  let zeroNights = false;
  try { stay.changeStayDates(ctx.propertyId, ACTOR, g.id, { departure: '2026-12-01' }); }
  catch { zeroNights = true; }
  check('shortening to zero nights is refused', zeroNights);

  // Check-in only happens on the open business date, so the in-house cases need
  // a booking that arrives today rather than one of the future ones above.
  const h = book(ctx, '2026-06-01', '2026-06-03', 'In House Guest');
  reservations.checkIn(ctx.propertyId, ACTOR, h.id, { roomId: ctx.rooms[1] } as any);

  let arrivalLocked = false;
  try { stay.changeStayDates(ctx.propertyId, ACTOR, h.id, { arrival: '2026-06-02' }); }
  catch { arrivalLocked = true; }
  check('arrival cannot move after check-in', arrivalLocked);

  const inHouse = stay.changeStayDates(ctx.propertyId, ACTOR, h.id, { departure: '2026-06-05' });
  check('an in-house guest can still extend', inHouse.nights === 4, inHouse);

  reservations.checkOut(ctx.propertyId, ACTOR, h.id, {} as any);
  let afterCheckout = false;
  try { stay.changeStayDates(ctx.propertyId, ACTOR, h.id, { departure: '2026-06-06' }); }
  catch { afterCheckout = true; }
  check('a checked-out stay cannot be changed', afterCheckout);

  section('9 · The change is audited');
  const entries = all<any>(
    `SELECT action, entity_ref FROM audit_log
      WHERE action IN ('reservation.extend','reservation.shorten') ORDER BY ts`,
  );
  check('extensions are audited',
    entries.some((x) => x.action === 'reservation.extend'), entries.length);
  check('shortenings are audited',
    entries.some((x) => x.action === 'reservation.shorten'));
  check('the entry names the booking',
    entries.every((x) => !!x.entity_ref), entries.slice(0, 3));

  process.stdout.write(`\n${checks - failures}/${checks} stay date checks passed\n`);
  if (failures) process.exit(1);
  process.stdout.write('Stays extend and shorten without losing rates, rooms or posted nights.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
