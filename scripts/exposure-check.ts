// ─────────────────────────────────────────────────────────────
// Exercises last-room protection and the exposure measurement behind it.
//
//   node --experimental-sqlite scripts/exposure-check.ts
//
// The claim being tested is the strong one: **with protection on, the
// simultaneous-OTA race has nothing to race for.** A property that holds back
// its last room closes the date while a room is still unsold, so two OTAs
// cannot both sell it. Everything else here — the latency figures, the verdict
// — exists so that decision is made against real numbers rather than a feeling.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-expo-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const ovb = await import('../src/services/overbooking.ts');
const exposure = await import('../src/services/exposure.ts');
const reservations = await import('../src/services/reservations.ts');

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

const ACTOR = { userId: 'usr_test', userName: 'Revenue Manager', propertyId: '' };
const TODAY = '2026-06-15';
const NIGHT = addDays(TODAY, 10);

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'EXP', 'Exposure Test Hotel', TODAY, nowIso(),
  );
  const roomTypeId = id('rt');
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                            max_adults, max_children, default_rate_minor, extra_adult_minor,
                            extra_child_minor, sort_order, active, created_at)
     VALUES(?,?,'STD','Standard','room',2,2,2,0,10000,0,0,1,1,?)`,
    roomTypeId, propertyId, nowIso(),
  );
  for (const n of ['101', '102', '103']) {
    run(
      `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
       VALUES(?,?,?,?,1,'Vacant Clean',1,?)`,
      id('rm'), propertyId, roomTypeId, n, nowIso(),
    );
  }
  const ratePlanId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, active, created_at)
     VALUES(?,?,'BAR','Best Available',1,?)`,
    ratePlanId, propertyId, nowIso(),
  );
  const channelId = id('chn');
  run(
    `INSERT INTO channels(id, property_id, code, name, kind, active, status, created_at)
     VALUES(?,?,'BDC','Booking.com','ota',1,'connected',?)`,
    channelId, propertyId, nowIso(),
  );
  return { propertyId, roomTypeId, ratePlanId, channelId };
}

let seq = 0;
function book(ctx: any, nights = 1) {
  seq++;
  return reservations.createReservation(ctx.propertyId, ACTOR, {
    guestName: `Guest ${seq}`, arrival: NIGHT, departure: addDays(NIGHT, nights),
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId,
    adults: 1, children: 0, force: true,
  } as any);
}

/** A push that took `seconds` to land. */
function recordPush(ctx: any, seconds: number, status = 'sent') {
  const created = new Date(Date.parse(`${TODAY}T10:00:00.000Z`));
  const sent = new Date(created.getTime() + seconds * 1000);
  run(
    `INSERT INTO channel_queue(id, property_id, channel_id, room_type_id, date_from, date_to,
                               scope, reason, status, created_at, sent_at)
     VALUES(?,?,?,?,?,?,'availability','test',?,?,?)`,
    id('cq'), ctx.propertyId, ctx.channelId, ctx.roomTypeId, NIGHT, addDays(NIGHT, 1),
    status, created.toISOString(), status === 'sent' ? sent.toISOString() : null,
  );
}

function reset(ctx: any) {
  run('DELETE FROM reservation_nights WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM reservations WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM overbookings WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM channel_queue WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM restrictions WHERE property_id = ?', ctx.propertyId);
}

async function main() {
  process.stdout.write(`\nExposure and last-room protection\n${'─'.repeat(33)}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;
  const P = ctx.propertyId;
  const WINDOW = { from: TODAY, to: addDays(TODAY, 60), today: TODAY };

  section('1 · Without protection, the door shuts only when the last room goes');
  // Three rooms, two booked — one still on sale, and that is the one two OTAs
  // can both sell.
  book(ctx); book(ctx);
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  check('one room left is not yet flagged',
    !ovb.listFindings(P, TODAY, { includeAtRisk: true }).some((f) => f.date === NIGHT),
    ovb.listFindings(P, TODAY, { includeAtRisk: true }).map((f) => f.date));

  book(ctx);
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  const soldOut = ovb.listFindings(P, TODAY, { includeAtRisk: true })
    .find((f) => f.date === NIGHT && f.kind === 'at-risk');
  check('selling the last room raises the at-risk flag', !!soldOut, soldOut);
  check('and the reason says the room has gone',
    /sold out/i.test(ovb.datesNeedingClosure(P, TODAY).find((d) => d.date === NIGHT)?.reason ?? ''),
    ovb.datesNeedingClosure(P, TODAY).find((d) => d.date === NIGHT));

  section('2 · With protection, the door shuts before the last room goes');
  reset(ctx);
  run('UPDATE room_types SET protect_last_rooms = 1 WHERE id = ?', ctx.roomTypeId);
  check('the setting is readable',
    ovb.lastRoomProtection(P).get(ctx.roomTypeId) === 1,
    [...ovb.lastRoomProtection(P)]);

  book(ctx); book(ctx);       // two of three sold — one left
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  const early = ovb.listFindings(P, TODAY, { includeAtRisk: true })
    .find((f) => f.date === NIGHT && f.kind === 'at-risk');
  // This is the whole claim: the date is shut while a room is still unsold, so
  // there is nothing for two OTAs to race over.
  check('the date is flagged with a room still unsold', !!early, early);
  check('it is flagged as at-risk, not as an overbooking', early?.kind === 'at-risk', early?.kind);
  check('nothing is actually oversold',
    !ovb.listFindings(P, TODAY).some((f) => f.kind === 'type'),
    ovb.listFindings(P, TODAY).map((f) => f.kind));
  check('the date is queued for closing on the channels',
    ovb.datesNeedingClosure(P, TODAY).some((d) => d.date === NIGHT),
    ovb.datesNeedingClosure(P, TODAY));

  section('3 · Protection does not stop the front desk');
  // The protected room is still there; it is only withheld from the OTAs. A
  // walk-in must still be sellable, which is the point of protecting it.
  const walkIn = book(ctx);
  check('the last room can still be sold directly', !!walkIn.id);
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  check('and selling it does not create an overbooking',
    !ovb.listFindings(P, TODAY).some((f) => f.kind === 'type'),
    ovb.listFindings(P, TODAY).map((f) => `${f.kind}:${f.oversold}`));

  run('UPDATE room_types SET protect_last_rooms = 0 WHERE id = ?', ctx.roomTypeId);

  section('4 · Push latency is measured, not guessed');
  reset(ctx);
  for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9, 40]) recordPush(ctx, s);
  let report = exposure.exposureReport(P, addDays(TODAY, -30), addDays(TODAY, 30));
  check('every completed push is counted', report.pushes === 10, report.pushes);
  check('the median is the middle, not the average',
    report.medianSeconds === 6, report.medianSeconds);
  check('the worst case is reported separately',
    report.worstSeconds === 40, report.worstSeconds);
  check('total exposure is the sum of every window',
    report.totalExposureSeconds === 85, report.totalExposureSeconds);
  check('the channel is broken out',
    report.perChannel.find((c) => c.code === 'BDC')?.pushes === 10, report.perChannel);

  section('5 · A failed push is the biggest exposure there is');
  recordPush(ctx, 0, 'failed');
  report = exposure.exposureReport(P, addDays(TODAY, -30), addDays(TODAY, 30));
  check('a failed push is counted', report.failedNow === 1, report.failedNow);
  check('and does not flatter the median',
    report.pushes === 10 && report.medianSeconds === 6, report);
  check('when it is oldest is reported', !!report.oldestFailedAt, report.oldestFailedAt);
  check('the verdict leads with it',
    /failed/i.test(report.verdict), report.verdict);
  check('and says it is fixable', /fixable/i.test(report.verdict), report.verdict);

  section('6 · The verdict is honest about what it knows');
  reset(ctx);
  for (const s of [2, 3]) recordPush(ctx, s);
  report = exposure.exposureReport(P, addDays(TODAY, -30), addDays(TODAY, 30));
  check('too little data says so rather than guessing',
    /not enough/i.test(report.verdict), report.verdict);

  reset(ctx);
  for (let i = 0; i < 12; i++) recordPush(ctx, 3);
  report = exposure.exposureReport(P, addDays(TODAY, -30), addDays(TODAY, 30));
  check('with no sold-out nights it says the race had nothing to win',
    /never had anything to race for/i.test(report.verdict), report.verdict);

  book(ctx); book(ctx); book(ctx);
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  report = exposure.exposureReport(P, addDays(TODAY, -30), addDays(TODAY, 60));
  check('a sold-out night is counted', report.soldOutNights === 1, report.soldOutNights);
  check('the verdict now names the trade-off',
    /last-room protection would make those impossible/i.test(report.verdict), report.verdict);
  check('and states the cost in occupancy',
    /one fewer room/i.test(report.verdict), report.verdict);

  run('UPDATE room_types SET protect_last_rooms = 1 WHERE id = ?', ctx.roomTypeId);
  report = exposure.exposureReport(P, addDays(TODAY, -30), addDays(TODAY, 60));
  check('with protection on the verdict says the race cannot happen',
    /cannot happen/i.test(report.verdict), report.verdict);
  run('UPDATE room_types SET protect_last_rooms = 0 WHERE id = ?', ctx.roomTypeId);

  section('7 · The setting sits beside the numbers');
  report = exposure.exposureReport(P, addDays(TODAY, -30), addDays(TODAY, 60));
  const std = report.protection.find((p) => p.roomTypeId === ctx.roomTypeId)!;
  check('every room type is listed', report.protection.length === 1, report.protection);
  check('with how many rooms it has', std.rooms === 3, std.rooms);
  check('and what is currently held back', std.protectLastRooms === 0, std.protectLastRooms);

  section('8 · Oversold nights and lost races are counted');
  reset(ctx);
  for (let i = 0; i < 4; i++) book(ctx);      // three rooms, four bookings
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  report = exposure.exposureReport(P, addDays(TODAY, -30), addDays(TODAY, 60));
  check('the oversold night is counted', report.oversoldNights === 1, report.oversoldNights);
  check('races are counted separately from other causes',
    typeof report.racesLost === 'number', report.racesLost);

  process.stdout.write(`\n${checks - failures}/${checks} exposure checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('Protection shuts the door early, and the numbers behind the decision are real.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
