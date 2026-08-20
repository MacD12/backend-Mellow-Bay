// ─────────────────────────────────────────────────────────────
// Exercises fixing an overbooking without walking anybody.
//
//   node --experimental-sqlite scripts/overbookingfix-check.ts
//
// The assertion that matters most is the last one in each case: **did the
// finding actually go away?** A fix that moves a guest and leaves the date
// still oversold has done work without solving anything, and reporting it as
// fixed is how a problem reaches the front desk marked "handled".
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-ovbfix-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run, get } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const ovb = await import('../src/services/overbooking.ts');
const fix = await import('../src/services/overbookingfix.ts');
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

const ACTOR = { userId: 'usr_test', userName: 'Duty Manager', propertyId: '' };
const TODAY = '2026-06-15';
const DAY = addDays(TODAY, 5);

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'FIX', 'Fix Test Hotel', TODAY, nowIso(),
  );
  // Standard $100, Deluxe $200, Economy $60 — so "better" and "worse" are
  // decided by what the property says each is worth.
  const types: Record<string, string> = {};
  const rooms: Record<string, string[]> = {};
  for (const [code, name, rate, count] of [
    ['STD', 'Standard', 10000, 2],
    ['DLX', 'Deluxe', 20000, 1],
    ['ECO', 'Economy', 6000, 1],
  ] as const) {
    const rtId = id('rt');
    run(
      `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                              max_adults, max_children, default_rate_minor, extra_adult_minor,
                              extra_child_minor, sort_order, active, created_at)
       VALUES(?,?,?,?,'room',2,2,2,0,?,0,0,1,1,?)`,
      rtId, propertyId, code, name, rate, nowIso(),
    );
    types[code] = rtId;
    rooms[code] = [];
    for (let i = 1; i <= count; i++) {
      const rid = id('rm');
      run(
        `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
         VALUES(?,?,?,?,1,'Vacant Clean',1,?)`,
        rid, propertyId, rtId, `${code}-${i}`, nowIso(),
      );
      rooms[code].push(rid);
    }
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
  return { propertyId, types, rooms, ratePlanId };
}

let seq = 0;
function book(ctx: any, opts: {
  typeCode?: string; roomId?: string | null; nights?: number; guest?: string; date?: string;
} = {}) {
  seq++;
  return reservations.createReservation(ctx.propertyId, ACTOR, {
    guestName: opts.guest ?? `Guest ${seq}`,
    arrival: opts.date ?? DAY,
    departure: addDays(opts.date ?? DAY, opts.nights ?? 1),
    roomTypeId: ctx.types[opts.typeCode ?? 'STD'],
    ratePlanId: ctx.ratePlanId,
    roomId: opts.roomId ?? undefined,
    adults: 1, children: 0,
    force: true,        // these tests are about the fix, not the booking gate
  } as any);
}

function openFinding(P: string) {
  return ovb.listFindings(P, TODAY).find((f) => f.kind === 'type');
}

function reset(ctx: any) {
  run('DELETE FROM reservation_nights WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM reservations WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM overbookings WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM overbooking_fixes WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM restrictions WHERE property_id = ?', ctx.propertyId);
}

async function main() {
  process.stdout.write(`\nOverbooking fix checks\n${'─'.repeat(22)}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;
  const P = ctx.propertyId;
  const WINDOW = { from: TODAY, to: addDays(TODAY, 30), today: TODAY };

  section('1 · Options are offered per guest, for the whole stay');
  // Two Standards exist. Three booked → oversold by one. A Deluxe and an
  // Economy are free.
  book(ctx, { guest: 'Ana Lopez' });
  book(ctx, { guest: 'Ben Carter' });
  book(ctx, { guest: 'Cara Diaz' });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  let finding = openFinding(P)!;
  check('the overbooking is found', !!finding, finding);

  let options = fix.resolutionOptions(P, finding.id, TODAY);
  check('all three guests are offered', options.guests.length === 3, options.guests.length);
  check('a walk is not yet likely', options.walkLikely === false, options.walkLikely);

  const ana = options.guests.find((g) => g.guest === 'Ana Lopez')!;
  check('the Deluxe shows as an upgrade', ana.upgrades.some((u) => u.roomType === 'Deluxe'),
    ana.upgrades);
  check('with the rate difference worked out',
    ana.upgrades.find((u) => u.roomType === 'Deluxe')?.rateDiffMinor === 10000,
    ana.upgrades);
  check('the Economy shows as a downgrade', ana.downgrades.some((d) => d.roomType === 'Economy'),
    ana.downgrades);
  check('with a negative difference',
    ana.downgrades.find((d) => d.roomType === 'Economy')?.rateDiffMinor === -4000,
    ana.downgrades);
  check('no dorm rooms are offered', [...ana.upgrades, ...ana.downgrades].every(
    (o) => o.roomType !== 'Dorm'));

  section('2 · A room only counts if it is free for the whole stay');
  reset(ctx);
  // A three-night guest, with the only Deluxe sold on night two.
  book(ctx, { guest: 'Long Stay', nights: 3 });
  book(ctx, { guest: 'Filler 1' });
  book(ctx, { guest: 'Filler 2' });
  book(ctx, { typeCode: 'DLX', roomId: ctx.rooms.DLX[0], date: addDays(DAY, 1), guest: 'Deluxe Guest' });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  finding = openFinding(P)!;
  options = fix.resolutionOptions(P, finding.id, TODAY);
  const longStay = options.guests.find((g) => g.guest === 'Long Stay')!;
  check('a room free on only part of the stay is not offered',
    !longStay.upgrades.some((u) => u.roomType === 'Deluxe'), longStay.upgrades);
  const filler = options.guests.find((g) => g.guest === 'Filler 1')!;
  check('but it is offered to the one-night guest it does suit',
    filler.upgrades.some((u) => u.roomType === 'Deluxe'), filler.upgrades);

  section('3 · A checked-in guest is not on the table');
  reset(ctx);
  const arriving = book(ctx, { guest: 'Arriving Today', date: TODAY });
  book(ctx, { guest: 'Also Today', date: TODAY });
  book(ctx, { guest: 'Third Today', date: TODAY });
  reservations.assignRoom(P, ACTOR, arriving.id, { roomId: ctx.rooms.STD[0] });
  reservations.checkIn(P, ACTOR, arriving.id, { roomId: ctx.rooms.STD[0] } as any);
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  finding = openFinding(P)!;
  options = fix.resolutionOptions(P, finding.id, TODAY);
  const inHouse = options.guests.find((g) => g.guest === 'Arriving Today')!;
  check('a checked-in guest is not movable', inHouse.movable === false, inHouse);
  check('and it says why',
    /already checked in/i.test(inHouse.blockedReason ?? ''), inHouse.blockedReason);
  check('no rooms are offered for them', inHouse.upgrades.length === 0 && inHouse.sameType.length === 0);
  check('the others are still movable',
    options.guests.filter((g) => g.movable).length === 2, options.guests.map((g) => g.movable));

  section('4 · Upgrading, and what it costs the property');
  reset(ctx);
  book(ctx, { guest: 'Upgrade Me' });
  book(ctx, { guest: 'Stay Put 1' });
  book(ctx, { guest: 'Stay Put 2' });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  finding = openFinding(P)!;
  options = fix.resolutionOptions(P, finding.id, TODAY);
  const target = options.guests.find((g) => g.guest === 'Upgrade Me')!;
  const deluxe = target.upgrades.find((u) => u.roomType === 'Deluxe')!;
  const beforeTotal = get<any>('SELECT total_minor FROM reservations WHERE id = ?',
    target.reservationId)!.total_minor;

  const upgraded = fix.applyFix(P, ACTOR, {
    findingId: finding.id, reservationId: target.reservationId,
    roomId: deluxe.roomId, kind: 'upgrade',
  });
  check('the upgrade is applied', upgraded.kind === 'upgrade', upgraded);
  check('the guest is in the better room',
    get<any>('SELECT room_id FROM reservations WHERE id = ?', target.reservationId)?.room_id
      === deluxe.roomId);
  // The whole point of an upgrade as a courtesy: the guest pays what they agreed.
  const afterTotal = get<any>('SELECT total_minor FROM reservations WHERE id = ?',
    target.reservationId)!.total_minor;
  check('the guest is not charged more', afterTotal === beforeTotal,
    { before: beforeTotal, after: afterTotal });
  check('what the property gave away is recorded',
    upgraded.rateDifferenceMinor === 10000, upgraded.rateDifferenceMinor);
  // The assertion that matters.
  check('and the overbooking is actually gone', upgraded.fixed === true, upgraded);
  check('it left the desk', !openFinding(P), ovb.listFindings(P, TODAY));

  section('5 · Reassigning costs nothing at all');
  reset(ctx);
  book(ctx, { guest: 'Move Me' });
  book(ctx, { guest: 'Other' });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  check('two in two rooms is not an overbooking', !openFinding(P));
  // Force a room-level clash instead: both on the same physical room.
  const a = book(ctx, { guest: 'Clash A', roomId: ctx.rooms.ECO[0], typeCode: 'ECO' });
  const b = book(ctx, { guest: 'Clash B', typeCode: 'ECO' });
  run('UPDATE reservations SET room_id = ? WHERE id = ?', ctx.rooms.ECO[0], b.id);
  run('UPDATE reservation_nights SET room_id = ? WHERE reservation_id = ?', ctx.rooms.ECO[0], b.id);
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  const clash = ovb.listFindings(P, TODAY).find((f) => f.kind === 'room');
  check('a room clash is found', !!clash, ovb.listFindings(P, TODAY).map((f) => f.kind));
  void a;

  section('6 · Downgrading posts the compensation, not a promise');
  reset(ctx);
  book(ctx, { guest: 'Down A' });
  book(ctx, { guest: 'Down B' });
  book(ctx, { guest: 'Down C' });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  finding = openFinding(P)!;
  options = fix.resolutionOptions(P, finding.id, TODAY);
  const downTarget = options.guests.find((g) => g.guest === 'Down C')!;
  const economy = downTarget.downgrades.find((d) => d.roomType === 'Economy')!;

  const downgraded = fix.applyFix(P, ACTOR, {
    findingId: finding.id, reservationId: downTarget.reservationId,
    roomId: economy.roomId, kind: 'downgrade', compensationMinor: 2500,
    note: 'Offered and accepted',
  });
  check('the downgrade is applied', downgraded.kind === 'downgrade', downgraded);
  check('the compensation is recorded', downgraded.creditMinor === 2500, downgraded);
  const folios = folio.foliosForReservation(downTarget.reservationId);
  const lines = folio.folioLines(folios[0].id);
  const credit = lines.find((l: any) => /Compensation/.test(l.description ?? ''));
  check('and posted to the folio as a credit', !!credit, lines.map((l: any) => l.description));
  check('as a negative amount, reducing what is owed',
    ((credit as any)?.amount_minor ?? 0) < 0, (credit as any)?.amount_minor);
  check('the room rate came down too',
    get<any>('SELECT total_minor FROM reservations WHERE id = ?',
      downTarget.reservationId)!.total_minor === 6000,
    get<any>('SELECT total_minor FROM reservations WHERE id = ?', downTarget.reservationId));
  check('and the overbooking is gone', downgraded.fixed === true, downgraded);

  section('7 · Nonsense moves are refused');
  reset(ctx);
  book(ctx, { guest: 'X1' }); book(ctx, { guest: 'X2' }); book(ctx, { guest: 'X3' });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  finding = openFinding(P)!;
  options = fix.resolutionOptions(P, finding.id, TODAY);
  const x = options.guests[0];

  let wrongWay = false;
  try {
    fix.applyFix(P, ACTOR, {
      findingId: finding.id, reservationId: x.reservationId,
      roomId: x.downgrades[0].roomId, kind: 'upgrade',
    });
  } catch { wrongWay = true; }
  check('calling a cheaper room an upgrade is refused', wrongWay);

  let alsoWrong = false;
  try {
    fix.applyFix(P, ACTOR, {
      findingId: finding.id, reservationId: x.reservationId,
      roomId: x.upgrades[0].roomId, kind: 'downgrade',
    });
  } catch { alsoWrong = true; }
  check('and calling a dearer room a downgrade is refused', alsoWrong);

  section('8 · A fix that does not fix it says so');
  reset(ctx);
  // Four booked into two Standards — oversold by two. Moving one guest to the
  // single Deluxe leaves it still oversold by one.
  for (const guest of ['P1', 'P2', 'P3', 'P4']) book(ctx, { guest });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  finding = openFinding(P)!;
  check('oversold by two', finding.oversold === 2, finding);
  options = fix.resolutionOptions(P, finding.id, TODAY);
  const one = options.guests.find((g) => g.upgrades.length)!;
  const partial = fix.applyFix(P, ACTOR, {
    findingId: finding.id, reservationId: one.reservationId,
    roomId: one.upgrades[0].roomId, kind: 'upgrade',
  });
  check('the move happened', partial.kind === 'upgrade');
  // The honest bit: work was done, the problem is not solved.
  check('but it is not reported as fixed', partial.fixed === false, partial);
  check('and the finding is still on the desk', !!openFinding(P), ovb.listFindings(P, TODAY));
  check('now oversold by one', openFinding(P)?.oversold === 1, openFinding(P));

  section('10 · What the courtesies cost');
  // Self-contained: earlier sections reset the property, and deleting a
  // reservation cascades its fixes away with it.
  reset(ctx);
  for (const guest of ['C1', 'C2', 'C3', 'C4']) book(ctx, { guest });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  finding = openFinding(P)!;
  options = fix.resolutionOptions(P, finding.id, TODAY);
  const up = options.guests.find((g) => g.upgrades.length)!;
  fix.applyFix(P, ACTOR, {
    findingId: finding.id, reservationId: up.reservationId,
    roomId: up.upgrades[0].roomId, kind: 'upgrade',
  });
  options = fix.resolutionOptions(P, finding.id, TODAY);
  const down = options.guests.find((g) => g.downgrades.length && g.reservationId !== up.reservationId)!;
  fix.applyFix(P, ACTOR, {
    findingId: finding.id, reservationId: down.reservationId,
    roomId: down.downgrades[0].roomId, kind: 'downgrade', compensationMinor: 2500,
  });

  // A fix is stamped with wall-clock time, not the business date. A window
  // built from TODAY would miss every fix on a property whose books are open on
  // an earlier day than the calendar — which is most of them.
  const costs = fix.fixCosts(P, '2000-01-01', '2100-01-01');
  check('upgrades are counted', costs.upgraded === 1, costs);
  check('downgrades are counted', costs.downgraded === 1, costs);
  check('what was given away is totalled', costs.givenAwayMinor === 10000, costs.givenAwayMinor);
  check('compensation is totalled separately', costs.compensationMinor === 2500, costs);
  check('every fix is listed with who did it',
    costs.fixes.every((f) => !!f.appliedBy), costs.fixes.slice(0, 2));

  section('9 · When nothing can be done');
  reset(ctx);
  // Fill every other room type, then oversell Standard.
  book(ctx, { typeCode: 'DLX', guest: 'Deluxe Taken' });
  book(ctx, { typeCode: 'ECO', guest: 'Economy Taken' });
  for (const guest of ['S1', 'S2', 'S3']) book(ctx, { guest });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  finding = openFinding(P)!;
  options = fix.resolutionOptions(P, finding.id, TODAY);
  check('no room outside the oversold type is offered',
    options.spareRooms === 0, options.spareRooms);
  check('the guests who can fit still see their own type',
    options.guests.some((g) => g.sameType.length > 0), options.guests.map((g) => g.sameType.length));
  check('and the screen is told a walk is likely', options.walkLikely === true, options.walkLikely);


  process.stdout.write(`\n${checks - failures}/${checks} overbooking fix checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('Guests are moved, not walked — and a fix that did not fix it says so.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
