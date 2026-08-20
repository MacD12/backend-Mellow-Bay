// ─────────────────────────────────────────────────────────────
// Exercises walking a guest — the last resort.
//
//   node --experimental-sqlite scripts/walking-check.ts
//
// Two things are being proved. First, that the *right* guest is suggested: a
// VIP, a group member, a long stay and somebody already checked in must never
// come top of the list, whatever the arithmetic says. Second, that a walked
// guest is not charged for the room they were sent away from — which is the
// mistake that turns a bad night into a complaint and a refund.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-walk-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run, get, all } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const walking = await import('../src/services/walking.ts');
const reservations = await import('../src/services/reservations.ts');
const folio = await import('../src/services/folio.ts');

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

const ACTOR = { userId: 'usr_test', userName: 'Night Manager', propertyId: '' };
const TODAY = '2026-06-15';

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'WLK', 'Walk Test Hotel', TODAY, nowIso(),
  );
  const roomTypeId = id('rt');
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                            max_adults, max_children, default_rate_minor, extra_adult_minor,
                            extra_child_minor, sort_order, active, created_at)
     VALUES(?,?,'STD','Standard','room',2,2,2,0,10000,0,0,1,1,?)`,
    roomTypeId, propertyId, nowIso(),
  );
  const rooms: string[] = [];
  for (const n of ['101', '102']) {
    const rid = id('rm');
    run(
      `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
       VALUES(?,?,?,?,1,'Vacant Clean',1,?)`,
      rid, propertyId, roomTypeId, n, nowIso(),
    );
    rooms.push(rid);
  }
  const ratePlanId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, active, created_at)
     VALUES(?,?,'BAR','Best Available',1,?)`,
    ratePlanId, propertyId, nowIso(),
  );
  run(
    `INSERT INTO transaction_codes(id, property_id, code, name, category, taxable, active)
     VALUES(?,?,'ADJ','Adjustment','misc',0,1)`,
    id('txc'), propertyId,
  );
  const groupId = id('grp');
  run(
    `INSERT INTO groups(id, property_id, code, name, arrival, departure, status, created_at)
     VALUES(?,?,'CONF','Conference block',?,?,'definite',?)`,
    groupId, propertyId, TODAY, addDays(TODAY, 2), nowIso(),
  );
  return { propertyId, roomTypeId, ratePlanId, rooms, groupId };
}

let seq = 0;
function book(ctx: any, opts: {
  guest?: string; nights?: number; date?: string; vip?: boolean;
  groupId?: string; bookedDaysAgo?: number; eta?: string; rateMinor?: number;
} = {}) {
  seq++;
  const res = reservations.createReservation(ctx.propertyId, ACTOR, {
    guestName: opts.guest ?? `Guest ${seq}`,
    arrival: opts.date ?? TODAY,
    departure: addDays(opts.date ?? TODAY, opts.nights ?? 1),
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId,
    adults: 1, children: 0, force: true,
    vip: opts.vip, eta: opts.eta,
    rateOverrideMinor: opts.rateMinor,
  } as any);
  if (opts.groupId) run('UPDATE reservations SET group_id = ? WHERE id = ?', opts.groupId, res.id);
  if (opts.bookedDaysAgo !== undefined) {
    run('UPDATE reservations SET created_at = ? WHERE id = ?',
      `${addDays(TODAY, -opts.bookedDaysAgo)}T10:00:00.000Z`, res.id);
  }
  return res;
}

function candidates(ctx: any) {
  return walking.walkCandidates(ctx.propertyId, TODAY, ctx.roomTypeId, TODAY);
}

function reset(ctx: any) {
  run('DELETE FROM reservation_nights WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM walked_guests WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM reservations WHERE property_id = ?', ctx.propertyId);
}

async function main() {
  process.stdout.write(`\nWalking checks\n${'─'.repeat(14)}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;
  const P = ctx.propertyId;

  section('1 · The least-harmed guest is suggested first');
  book(ctx, { guest: 'One Night OTA', nights: 1, bookedDaysAgo: 3 });
  book(ctx, { guest: 'Three Nights', nights: 3, bookedDaysAgo: 40 });
  let list = candidates(ctx);
  check('both are ranked', list.length === 2, list.length);
  check('the one-night guest is first', list[0].guest === 'One Night OTA', list.map((c) => c.guest));
  check('the reasoning is given', list[0].reasons.length > 0, list[0].reasons);
  check('and it says why they are easiest',
    list[0].reasons.some((r) => /one night/i.test(r)), list[0].reasons);
  check('the longer stay is ranked below',
    list[1].score < list[0].score, list.map((c) => c.score));

  section('2 · Some guests are never suggested');
  reset(ctx);
  book(ctx, { guest: 'Ordinary', nights: 1 });
  book(ctx, { guest: 'VIP Guest', nights: 1, vip: true });
  book(ctx, { guest: 'Group Member', nights: 1, groupId: ctx.groupId });
  book(ctx, { guest: 'Long Stayer', nights: 5 });
  list = candidates(ctx);

  const protectedNames = ['VIP Guest', 'Group Member', 'Long Stayer'];
  for (const name of protectedNames) {
    const c = list.find((x) => x.guest === name)!;
    check(`${name} is protected`, !!c.protectedFrom, c.protectedFrom);
  }
  check('the ordinary guest is not protected',
    !list.find((x) => x.guest === 'Ordinary')!.protectedFrom);
  check('a protected guest never ranks first', list[0].guest === 'Ordinary', list[0].guest);
  check('the VIP reason names the status',
    /vip/i.test(list.find((x) => x.guest === 'VIP Guest')!.protectedFrom ?? ''));
  check('the group reason explains the consequence',
    /splits the booking/i.test(list.find((x) => x.guest === 'Group Member')!.protectedFrom ?? ''));

  section('3 · A guest already in the room cannot be walked');
  reset(ctx);
  const inHouse = book(ctx, { guest: 'Sleeping Here', nights: 2 });
  book(ctx, { guest: 'Arriving Later', nights: 1 });
  reservations.assignRoom(P, ACTOR, inHouse.id, { roomId: ctx.rooms[0] });
  reservations.checkIn(P, ACTOR, inHouse.id, { roomId: ctx.rooms[0] } as any);
  list = candidates(ctx);
  const sleeping = list.find((c) => c.guest === 'Sleeping Here')!;
  check('a checked-in guest is protected', !!sleeping.protectedFrom, sleeping.protectedFrom);
  check('and it says they are in the room',
    /in the room/i.test(sleeping.protectedFrom ?? ''), sleeping.protectedFrom);
  check('the arriving guest ranks above them',
    list[0].guest === 'Arriving Later', list.map((c) => c.guest));

  section('4 · Returning guests are protected, first-timers are not');
  reset(ctx);
  const profileId = id('gp');
  run(
    `INSERT INTO profiles(id, property_id, type, name, created_at, updated_at)
     VALUES(?,?,'guest','Regular Guest',?,?)`,
    profileId, P, nowIso(), nowIso(),
  );
  const regular = book(ctx, { guest: 'Regular Guest', nights: 1 });
  run('UPDATE reservations SET profile_id = ? WHERE id = ?', profileId, regular.id);
  // Three completed stays on the same profile. Written straight in — the
  // booking path rightly refuses an arrival before the open business date.
  for (let i = 0; i < 3; i++) {
    run(
      `INSERT INTO reservations(id, property_id, confirmation, status, guest_name, profile_id,
                                arrival, departure, nights, adults, children,
                                room_type_id, rate_plan_id, total_minor, currency,
                                source, origin, segment, created_by, created_at, updated_at)
       VALUES(?,?,?,'Checked-out',?,?,?,?,1,1,0,?,?,10000,'USD','direct','desk','transient',
              'seed',?,?)`,
      id('res'), P, `PAST${i}`, 'Regular Guest', profileId,
      addDays(TODAY, -30 - i), addDays(TODAY, -29 - i),
      ctx.roomTypeId, ctx.ratePlanId, nowIso(), nowIso(),
    );
  }
  book(ctx, { guest: 'First Timer', nights: 1 });
  list = candidates(ctx);
  const returning = list.find((c) => c.guest === 'Regular Guest')!;
  check('the returning guest is counted', returning.previousStays === 3, returning.previousStays);
  check('and protected', !!returning.protectedFrom, returning.protectedFrom);
  check('the first-timer is suggested instead',
    list[0].guest === 'First Timer', list[0].guest);
  check('and the reason says so',
    list[0].reasons.some((r) => /first stay/i.test(r)), list[0].reasons);

  section('5 · Walking records where they went');
  reset(ctx);
  const victim = book(ctx, { guest: 'Walked Guest', nights: 1 });
  let refused = false;
  try {
    walking.walkGuest(P, ACTOR, { reservationId: victim.id, hotelName: '  ' });
  } catch { refused = true; }
  check('a walk with no hotel named is refused', refused);

  const walk = walking.walkGuest(P, ACTOR, {
    reservationId: victim.id,
    hotelName: 'The Grand Next Door',
    hotelPhone: '+94 11 555 0100',
    roomCostMinor: 12_000,
    transportCostMinor: 2_000,
    compensationMinor: 5_000,
    reason: 'Oversold — no room of any type',
  });
  check('the walk is recorded', !!walk.id, walk);
  check('the hotel is kept', walk.hotel === 'The Grand Next Door', walk.hotel);
  check('the total cost is added up', walk.totalCostMinor === 19_000, walk.totalCostMinor);

  const row = get<any>('SELECT * FROM walked_guests WHERE id = ?', walk.id);
  check('the phone number is kept for the night porter',
    row.hotel_phone === '+94 11 555 0100', row.hotel_phone);
  check('who authorised it is recorded', row.authorised_by === 'Night Manager', row.authorised_by);
  check('the reason is kept', /oversold/i.test(row.reason ?? ''), row.reason);

  section('6 · A walked guest is not charged for the room');
  check('the night is off the booking',
    all<any>('SELECT * FROM reservation_nights WHERE reservation_id = ?', victim.id).length === 0);
  check('the booking is closed rather than left at zero nights',
    get<any>('SELECT status FROM reservations WHERE id = ?', victim.id)?.status === 'Cancelled',
    get<any>('SELECT status FROM reservations WHERE id = ?', victim.id));
  check('and the cancellation says where they went',
    /grand next door/i.test(
      get<any>('SELECT cancel_reason FROM reservations WHERE id = ?', victim.id)?.cancel_reason ?? ''),
    get<any>('SELECT cancel_reason FROM reservations WHERE id = ?', victim.id));

  const folios = folio.foliosForReservation(victim.id);
  const lines = folio.folioLines(folios[0].id);
  const credit = lines.find((l: any) => /Walked to/.test(l.description ?? ''));
  check('what the property owes is posted to the folio', !!credit,
    lines.map((l: any) => l.description));
  check('as a credit, not a charge', (credit as any)?.amount_minor === -19_000,
    (credit as any)?.amount_minor);

  section('7 · A guest who comes back for the rest of the stay');
  reset(ctx);
  const returner = book(ctx, { guest: 'Back Tomorrow', nights: 3 });
  const partial = walking.walkGuest(P, ACTOR, {
    reservationId: returner.id,
    date: TODAY, nights: 1,
    hotelName: 'Overflow Inn',
    roomCostMinor: 9_000,
    returnsLater: true,
  });
  check('only the walked night comes off', partial.nightsRemaining === 2, partial);
  check('they are marked as returning', partial.returnsLater === true, partial);
  check('the booking is still live',
    get<any>('SELECT status FROM reservations WHERE id = ?', returner.id)?.status !== 'Cancelled');
  check('arrival moves to the night they come back',
    get<any>('SELECT arrival FROM reservations WHERE id = ?', returner.id)?.arrival
      === addDays(TODAY, 1),
    get<any>('SELECT arrival FROM reservations WHERE id = ?', returner.id));
  check('the total is re-cut to the nights they will stay',
    get<any>('SELECT nights FROM reservations WHERE id = ?', returner.id)?.nights === 2);

  section('8 · A posted night is not silently dropped');
  reset(ctx);
  const posted = book(ctx, { guest: 'Already Charged', nights: 2 });
  run(`UPDATE reservation_nights SET posted = 1 WHERE reservation_id = ? AND date = ?`,
    posted.id, TODAY);
  const withPosted = walking.walkGuest(P, ACTOR, {
    reservationId: posted.id, date: TODAY, nights: 1,
    hotelName: 'Overflow Inn', returnsLater: true,
  });
  // The charge stands, because the night audit already counted it in a closed
  // day. It has to be voided deliberately, not swept away by a walk.
  check('a posted night survives the walk', withPosted.nightsRemaining === 2, withPosted);
  check('and is still on the booking',
    all<any>(`SELECT * FROM reservation_nights WHERE reservation_id = ? AND posted = 1`,
      posted.id).length === 1);

  section('9 · Guardrails');
  reset(ctx);
  const cancelled = book(ctx, { guest: 'Already Gone', nights: 1 });
  reservations.cancelReservation(P, ACTOR, cancelled.id, { reason: 'test' } as any);
  let cannotWalk = false;
  try {
    walking.walkGuest(P, ACTOR, { reservationId: cancelled.id, hotelName: 'Anywhere' });
  } catch { cannotWalk = true; }
  check('a cancelled booking cannot be walked', cannotWalk);

  section('10 · What overbooking really cost');
  // Self-contained: the resets above delete reservations, and a walk record
  // cascades away with the booking it belongs to.
  reset(ctx);
  const w1 = book(ctx, { guest: 'Cost One', nights: 1 });
  const w2 = book(ctx, { guest: 'Cost Two', nights: 1 });
  walking.walkGuest(P, ACTOR, {
    reservationId: w1.id, hotelName: 'Overflow Inn',
    roomCostMinor: 12_000, transportCostMinor: 2_000, compensationMinor: 5_000,
  });
  walking.walkGuest(P, ACTOR, {
    reservationId: w2.id, hotelName: 'The Grand Next Door', roomCostMinor: 9_000,
  });

  const costs = walking.walkCosts(P, addDays(TODAY, -365), addDays(TODAY, 365));
  check('every walk is listed', costs.count === 2, costs.count);
  check('room costs are totalled', costs.roomCostMinor === 21_000, costs.roomCostMinor);
  check('transport is totalled separately', costs.transportCostMinor === 2_000, costs.transportCostMinor);
  check('compensation is totalled separately', costs.compensationMinor === 5_000, costs.compensationMinor);
  check('the grand total is the sum of the three',
    costs.totalCostMinor === costs.roomCostMinor + costs.transportCostMinor + costs.compensationMinor,
    costs);
  check('an average is given, for setting the allowance against',
    costs.averageCostMinor > 0, costs.averageCostMinor);
  check('each walk names the hotel and who authorised it',
    costs.walks.every((w) => !!w.hotel && !!w.authorisedBy), costs.walks[0]);

  process.stdout.write(`\n${checks - failures}/${checks} walking checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('The right guest is suggested, and a walked guest is not billed for the room.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
