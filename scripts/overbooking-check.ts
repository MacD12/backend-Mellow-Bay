// ─────────────────────────────────────────────────────────────
// Exercises overbooking detection.
//
//   node --experimental-sqlite scripts/overbooking-check.ts
//
// Detection is the part that has to be exactly right, in both directions. A
// missed overbooking becomes a guest with nowhere to sleep. A false one sends
// somebody hunting for a problem that is not there, and the third time that
// happens they stop looking — which is how the real one gets missed.
//
// So every case below asserts both: that the problem is found, and that
// everything which merely resembles it is not.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-ovb-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run, get, all } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const ovb = await import('../src/services/overbooking.ts');

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
const WINDOW = { from: TODAY, to: addDays(TODAY, 90), today: TODAY };

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'mixed','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'OVB', 'Overbook Test Hotel', TODAY, nowIso(),
  );
  // Two private rooms of one type, plus a 4-bed dorm.
  const stdId = id('rt');
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                            max_adults, max_children, default_rate_minor, extra_adult_minor,
                            extra_child_minor, sort_order, active, created_at)
     VALUES(?,?,'STD','Standard','room',2,2,2,0,10000,0,0,1,1,?)`,
    stdId, propertyId, nowIso(),
  );
  const dormId = id('rt');
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                            max_adults, max_children, default_rate_minor, extra_adult_minor,
                            extra_child_minor, sort_order, active, created_at)
     VALUES(?,?,'DRM','4-bed Dorm','dorm',4,4,4,0,3000,0,0,2,1,?)`,
    dormId, propertyId, nowIso(),
  );
  const rooms: string[] = [];
  for (const number of ['101', '102']) {
    const rid = id('rm');
    run(
      `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
       VALUES(?,?,?,?,1,'Vacant Clean',1,?)`,
      rid, propertyId, stdId, number, nowIso(),
    );
    rooms.push(rid);
  }
  const dormRoomId = id('rm');
  run(
    `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
     VALUES(?,?,?,'201',2,'Vacant Clean',1,?)`,
    dormRoomId, propertyId, dormId, nowIso(),
  );
  const beds: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const bid = id('bed');
    run(
      `INSERT INTO beds(id, property_id, room_id, code, bunk, status, active)
       VALUES(?,?,?,?,'single','Vacant Clean',1)`,
      bid, propertyId, dormRoomId, `201-${i}`,
    );
    beds.push(bid);
  }
  const ratePlanId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, active, created_at)
     VALUES(?,?,'BAR','Best Available',1,?)`,
    ratePlanId, propertyId, nowIso(),
  );
  return { propertyId, stdId, dormId, rooms, dormRoomId, beds, ratePlanId };
}

let seq = 0;

/** A booking that holds inventory, written directly so each test is exact. */
function book(ctx: any, opts: {
  date: string; nights?: number; roomTypeId?: string; roomId?: string | null;
  bedId?: string | null; status?: string; guest?: string;
  origin?: string; channelCode?: string | null; createdAt?: string;
  totalMinor?: number; vip?: boolean; groupId?: string | null; eta?: string | null;
}) {
  const resId = id('res');
  seq++;
  const nights = opts.nights ?? 1;
  const roomTypeId = opts.roomTypeId ?? ctx.stdId;
  const createdAt = opts.createdAt ?? nowIso();
  run(
    `INSERT INTO reservations(id, property_id, confirmation, status, guest_name, arrival, departure,
                              nights, adults, children, room_type_id, room_id, bed_id, rate_plan_id,
                              currency, total_minor, deposit_required_minor, commission_minor,
                              source, origin, channel_code, eta, group_id, vip, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,1,0,?,?,?,?,'USD',?,0,0,?,?,?,?,?,?,?,?)`,
    resId, ctx.propertyId, `OVB-${String(seq).padStart(4, '0')}`,
    opts.status ?? 'Confirmed', opts.guest ?? `Guest ${seq}`,
    opts.date, addDays(opts.date, nights), nights,
    roomTypeId, opts.roomId ?? null, opts.bedId ?? null, ctx.ratePlanId,
    opts.totalMinor ?? 10000 * nights,
    opts.channelCode ? 'OTA' : 'Direct', opts.origin ?? 'desk',
    opts.channelCode ?? null, opts.eta ?? null, opts.groupId ?? null,
    opts.vip ? 1 : 0, createdAt, createdAt,
  );
  for (let i = 0; i < nights; i++) {
    run(
      `INSERT INTO reservation_nights(id, reservation_id, property_id, date, room_type_id, room_id,
                                      bed_id, rate_plan_id, rate_minor, adults, children, posted)
       VALUES(?,?,?,?,?,?,?,?,?,1,0,0)`,
      id('rn'), resId, ctx.propertyId, addDays(opts.date, i), roomTypeId,
      opts.roomId ?? null, opts.bedId ?? null, ctx.ratePlanId, 10000,
    );
  }
  return resId;
}

function clear(ctx: any) {
  run('DELETE FROM reservation_nights WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM reservations WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM overbookings WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM room_blocks WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM channel_queue WHERE property_id = ?', ctx.propertyId);
  run('DELETE FROM inventory_adjustments WHERE property_id = ?', ctx.propertyId);
}

const find = (list: any[], kind: string, date: string) =>
  list.find((f) => f.kind === kind && f.date === date);

async function main() {
  process.stdout.write(`\nOverbooking detection checks\n${'─'.repeat(28)}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;
  const P = ctx.propertyId;
  const scan = () => ovb.scan(P, WINDOW.from, WINDOW.to, TODAY);

  section('1 · A property that is not oversold');
  book(ctx, { date: addDays(TODAY, 10) });
  let f = scan();
  check('one booking in two rooms is not an overbooking',
    !f.some((x) => x.kind === 'type'), f.filter((x) => x.kind === 'type'));
  check('and is not even at risk', !f.some((x) => x.kind === 'at-risk'), f);

  section('2 · Type-level oversell');
  clear(ctx);
  const day = addDays(TODAY, 10);
  book(ctx, { date: day });
  book(ctx, { date: day });
  f = scan();
  check('two bookings in two rooms is sold out, not oversold',
    !f.some((x) => x.kind === 'type'), f.filter((x) => x.kind === 'type'));
  check('but it is flagged at risk', !!find(f, 'at-risk', day), f);

  book(ctx, { date: day });
  f = scan();
  const over = find(f, 'type', day);
  check('a third booking is an overbooking', !!over, f.filter((x) => x.kind === 'type'));
  check('oversold by exactly one', over?.oversold === 1, over);
  check('the sold count is right', over?.sold === 3, over);
  check('the sellable count is right', over?.sellable === 2, over);
  check('all three bookings are named', over?.reservationIds.length === 3, over?.reservationIds);
  check('the at-risk finding is replaced by the real one',
    !find(f, 'at-risk', day), f);

  section('3 · Only live bookings hold a room');
  clear(ctx);
  book(ctx, { date: day });
  book(ctx, { date: day });
  for (const status of ['Cancelled', 'No-show', 'Checked-out']) {
    book(ctx, { date: day, status });
  }
  f = scan();
  check('cancelled, no-show and checked-out bookings do not oversell',
    !f.some((x) => x.kind === 'type'), f.filter((x) => x.kind === 'type'));

  clear(ctx);
  book(ctx, { date: day });
  book(ctx, { date: day });
  book(ctx, { date: day, status: 'Checked-in' });
  f = scan();
  check('a checked-in guest does hold a room', !!find(f, 'type', day), f);

  section('4 · Room-level clash');
  clear(ctx);
  // Both on room 101, while 102 sits empty — the type has space and this is
  // still an overbooking for the guest who opens the door.
  book(ctx, { date: day, roomId: ctx.rooms[0] });
  book(ctx, { date: day, roomId: ctx.rooms[0] });
  f = scan();
  check('two bookings on one room is found', !!find(f, 'room', day), f);
  check('even though the room type is not oversold',
    !f.some((x) => x.kind === 'type'), f.filter((x) => x.kind === 'type'));
  check('the room is named', find(f, 'room', day)?.roomId === ctx.rooms[0]);
  check('and the cause is an assignment mistake',
    find(f, 'room', day)?.cause === 'assignment');

  clear(ctx);
  book(ctx, { date: day, roomId: ctx.rooms[0] });
  book(ctx, { date: day, roomId: ctx.rooms[1] });
  f = scan();
  check('two bookings in two different rooms is fine',
    !f.some((x) => x.kind === 'room'), f);

  section('5 · Dorms are not room clashes');
  clear(ctx);
  // Four guests in a four-bed dorm is a full dorm, not four overbookings.
  for (let i = 0; i < 4; i++) {
    book(ctx, { date: day, roomTypeId: ctx.dormId, roomId: ctx.dormRoomId, bedId: ctx.beds[i] });
  }
  f = scan();
  check('a full dorm is not a room clash', !f.some((x) => x.kind === 'room'), f);
  check('nor a bed clash', !f.some((x) => x.kind === 'bed'), f);

  book(ctx, { date: day, roomTypeId: ctx.dormId, roomId: ctx.dormRoomId, bedId: ctx.beds[0] });
  f = scan();
  check('two guests in one bed is found', !!find(f, 'bed', day), f);
  check('the bed is named', find(f, 'bed', day)?.bedId === ctx.beds[0]);
  check('and it is still not a room clash', !f.some((x) => x.kind === 'room'), f);

  section('6 · Severity is by time, not size');
  clear(ctx);
  for (let i = 0; i < 3; i++) book(ctx, { date: TODAY });
  for (let i = 0; i < 3; i++) book(ctx, { date: addDays(TODAY, 3) });
  for (let i = 0; i < 5; i++) book(ctx, { date: addDays(TODAY, 60) });
  f = scan();
  check('tonight is critical', find(f, 'type', TODAY)?.severity === 'critical',
    find(f, 'type', TODAY));
  check('this week is urgent',
    find(f, 'type', addDays(TODAY, 3))?.severity === 'urgent');
  check('two months out is a warning',
    find(f, 'type', addDays(TODAY, 60))?.severity === 'warning');
  check('the bigger, later problem is not ranked above tonight',
    find(f, 'type', addDays(TODAY, 60))!.oversold > find(f, 'type', TODAY)!.oversold
    && find(f, 'type', TODAY)!.severity === 'critical');

  section('7 · Working out the cause');
  clear(ctx);
  // A room taken out of order over dates that were already sold.
  book(ctx, { date: day });
  book(ctx, { date: day });
  run(
    `INSERT INTO room_blocks(id, property_id, room_id, kind, from_date, to_date, reason, created_at)
     VALUES(?,?,?,'OOO',?,?,'Burst pipe',?)`,
    id('blk'), P, ctx.rooms[0], day, addDays(day, 1), nowIso(),
  );
  f = scan();
  check('a block over sold dates is detected as the cause',
    find(f, 'type', day)?.cause === 'blocked-room', find(f, 'type', day));
  check('and it explains what to do',
    /releasing the block/i.test(ovb.describeCause('blocked-room')));

  clear(ctx);
  book(ctx, { date: day });
  book(ctx, { date: day });
  book(ctx, { date: day });
  run(
    `INSERT INTO channel_queue(id, property_id, channel_id, room_type_id, date_from, date_to,
                               scope, reason, status, created_at)
     VALUES(?,?,NULL,?,?,?,'availability','test','failed',?)`,
    id('cq'), P, ctx.stdId, day, addDays(day, 1), nowIso(),
  );
  f = scan();
  check('a failing push is detected as the cause',
    find(f, 'type', day)?.cause === 'failed-push', find(f, 'type', day));
  check('and is called out as recurring',
    /keep happening/i.test(ovb.describeCause('failed-push')));

  clear(ctx);
  run(
    `INSERT INTO inventory_adjustments(id, property_id, room_type_id, date, overbook, hold, updated_at)
     VALUES(?,?,?,?,2,0,?)`,
    id('inv'), P, ctx.stdId, day, nowIso(),
  );
  for (let i = 0; i < 5; i++) book(ctx, { date: day });
  f = scan();
  check('a deliberate allowance is named as the cause, not a fault',
    find(f, 'type', day)?.cause === 'allowance', find(f, 'type', day));
  check('the allowance is counted as sellable',
    find(f, 'type', day)?.sellable === 4, find(f, 'type', day));

  clear(ctx);
  const t0 = new Date(Date.parse('2026-06-10T10:00:00Z'));
  book(ctx, { date: day, origin: 'channel', channelCode: 'BDC', createdAt: t0.toISOString() });
  book(ctx, { date: day, origin: 'channel', channelCode: 'EXP',
    createdAt: new Date(t0.getTime() + 4000).toISOString() });
  book(ctx, { date: day, origin: 'channel', channelCode: 'BDC',
    createdAt: new Date(t0.getTime() + 6000).toISOString() });
  f = scan();
  check('two channel bookings seconds apart is recognised as the race',
    find(f, 'type', day)?.cause === 'race', find(f, 'type', day));
  check('and the explanation says nothing was misconfigured',
    /nothing was misconfigured/i.test(ovb.describeCause('race')));

  section('8 · Findings are stable across scans');
  clear(ctx);
  for (let i = 0; i < 3; i++) book(ctx, { date: day });
  const first = ovb.scanAndRecord(P, ACTOR, WINDOW);
  check('the first scan creates the finding', first.created === 1, first);
  const second = ovb.scanAndRecord(P, ACTOR, WINDOW);
  check('scanning again creates nothing new', second.created === 0, second);
  check('and does not duplicate it',
    all<any>(`SELECT * FROM overbookings WHERE property_id = ? AND kind = 'type'`, P).length === 1);

  const open = ovb.listFindings(P, TODAY);
  check('the desk shows one finding', open.length === 1, open.length);
  check('with the bookings attached', open[0].reservations.length === 3, open[0].reservations.length);
  check('and how far away it is', open[0].daysAway === 10, open[0].daysAway);

  section('9 · Acknowledging, worsening and fixing');
  const findingId = open[0].id;
  ovb.acknowledge(P, ACTOR, findingId);
  check('a finding can be acknowledged',
    !!get<any>('SELECT acknowledged_at FROM overbookings WHERE id = ?', findingId)?.acknowledged_at);

  book(ctx, { date: day });
  const worse = ovb.scanAndRecord(P, ACTOR, WINDOW);
  check('a worsening finding is reported as worsened', worse.worsened === 1, worse);
  // Somebody silenced an alarm about one oversold room; two is a new problem.
  check('and it stops being acknowledged',
    !get<any>('SELECT acknowledged_at FROM overbookings WHERE id = ?', findingId)?.acknowledged_at);
  check('the count went up',
    get<any>('SELECT oversold FROM overbookings WHERE id = ?', findingId)?.oversold === 2);

  run(`UPDATE reservations SET status = 'Cancelled' WHERE property_id = ? AND arrival = ?`, P, day);
  run(`DELETE FROM reservation_nights WHERE property_id = ? AND date = ?`, P, day);
  const fixed = ovb.scanAndRecord(P, ACTOR, WINDOW);
  check('a fixed problem is auto-resolved', fixed.autoResolved >= 1, fixed);
  check('and leaves the desk', ovb.listFindings(P, TODAY).length === 0);
  check('but is still on the record',
    get<any>('SELECT status FROM overbookings WHERE id = ?', findingId)?.status === 'auto-resolved');

  section('10 · A resolution that did not fix anything');
  clear(ctx);
  for (let i = 0; i < 3; i++) book(ctx, { date: day });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  const stillBroken = ovb.listFindings(P, TODAY)[0];
  ovb.resolveFinding(P, ACTOR, stillBroken.id, 'Moved a guest', 'Actually did nothing');
  check('it leaves the desk when resolved', ovb.listFindings(P, TODAY).length === 0);
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  check('but comes back on the next scan, because it is still true',
    ovb.listFindings(P, TODAY).length === 1, ovb.listFindings(P, TODAY));

  section('11 · The summary the alarm works from');
  clear(ctx);
  for (let i = 0; i < 3; i++) book(ctx, { date: TODAY });
  for (let i = 0; i < 4; i++) book(ctx, { date: addDays(TODAY, 40) });
  book(ctx, { date: addDays(TODAY, 5) });
  book(ctx, { date: addDays(TODAY, 5) });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  const sum = ovb.summary(P, TODAY);
  check('overbookings are counted', sum.total === 2, sum);
  check('tonight is counted on its own', sum.tonight === 1, sum);
  check('critical is counted', sum.critical === 1, sum);
  check('rooms oversold are totalled', sum.roomsOversold === 3, sum);
  check('sold-out dates are counted separately', sum.atRisk >= 1, sum);
  check('and at-risk is not mixed into the overbooking count',
    sum.total === 2 && sum.atRisk >= 1, sum);
  check('nothing is acknowledged yet', sum.unacknowledged === 2, sum);

  section('12 · Dates that must be shut on the OTAs');
  const toClose = ovb.datesNeedingClosure(P, TODAY);
  check('oversold dates need closing',
    toClose.some((d) => d.date === TODAY), toClose);
  check('sold-out dates need closing too',
    toClose.some((d) => d.date === addDays(TODAY, 5)), toClose);
  check('each says why',
    toClose.every((d) => !!d.reason), toClose);
  check('a sold-out reason explains the last room',
    toClose.find((d) => d.date === addDays(TODAY, 5))?.reason.includes('last room') === true,
    toClose.find((d) => d.date === addDays(TODAY, 5)));

  const closed = ovb.markClosed(P, ctx.stdId, [TODAY]);
  check('closing is recorded against the finding', closed >= 1, closed);
  check('and it is not offered for closing twice',
    !ovb.datesNeedingClosure(P, TODAY).some((d) => d.date === TODAY));

  section('13 · Past dates are left alone');
  clear(ctx);
  for (let i = 0; i < 3; i++) book(ctx, { date: addDays(TODAY, -5) });
  ovb.scanAndRecord(P, ACTOR, WINDOW);
  check('an overbooking last week is not on the desk',
    ovb.listFindings(P, TODAY).length === 0, ovb.listFindings(P, TODAY));

  process.stdout.write(`\n${checks - failures}/${checks} overbooking detection checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('All four kinds are found, and nothing that resembles them is.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
