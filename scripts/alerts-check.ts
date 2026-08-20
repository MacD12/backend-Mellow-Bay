// ─────────────────────────────────────────────────────────────
// Exercises the alert feed, the alert settings, and the inventory guard that
// shuts dates on the OTAs the moment the last room goes.
//
//   node --experimental-sqlite scripts/alerts-check.ts
//
// Two behaviours here are worth more than the rest:
//
//   · **A refresh must not sound the alarm.** The feed distinguishes "what is
//     new since you were last here" from "what has happened recently", and only
//     the first may make a noise. Get this wrong and the alarms get switched
//     off within a week, which is the same as not having them.
//
//   · **Closing happens at zero, not at minus one.** By the time availability
//     is negative the guest already exists. Closing the moment it reaches zero
//     is what removes the room the two OTAs would otherwise race for.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-alert-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run, get, all } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const alerts = await import('../src/services/alerts.ts');
const ovb = await import('../src/services/overbooking.ts');
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ACTOR = { userId: 'usr_test', userName: 'Night Porter', propertyId: '' };
const TODAY = '2026-06-15';

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'ALR', 'Alert Test Hotel', TODAY, nowIso(),
  );
  const roomTypeId = id('rt');
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                            max_adults, max_children, default_rate_minor, extra_adult_minor,
                            extra_child_minor, sort_order, active, created_at)
     VALUES(?,?,'STD','Standard','room',2,2,2,0,10000,0,0,1,1,?)`,
    roomTypeId, propertyId, nowIso(),
  );
  for (const number of ['101', '102']) {
    run(
      `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
       VALUES(?,?,?,?,1,'Vacant Clean',1,?)`,
      id('rm'), propertyId, roomTypeId, number, nowIso(),
    );
  }
  const ratePlanId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, active, created_at)
     VALUES(?,?,'BAR','Best Available',1,?)`,
    ratePlanId, propertyId, nowIso(),
  );
  run(
    `INSERT INTO channels(id, property_id, code, name, kind, active, status, created_at)
     VALUES(?,?,'BDC','Booking.com','ota',1,'connected',?)`,
    id('chn'), propertyId, nowIso(),
  );
  return { propertyId, roomTypeId, ratePlanId };
}

let seq = 0;
function book(ctx: any, date: string, opts: { nights?: number; guest?: string } = {}) {
  seq++;
  return reservations.createReservation(ctx.propertyId, ACTOR, {
    guestName: opts.guest ?? `Guest ${seq}`,
    arrival: date, departure: addDays(date, opts.nights ?? 1),
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId,
    adults: 1, children: 0,
  } as any);
}

const closures = (P: string) => all<any>(
  `SELECT date_from, date_to, note FROM restrictions
    WHERE property_id = ? AND type = 'stop-sell' AND active = 1 ORDER BY date_from`, P);

async function main() {
  process.stdout.write(`\nAlert and guard checks\n${'─'.repeat(22)}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;
  const P = ctx.propertyId;

  section('1 · Settings arrive switched on');
  const defaults = alerts.alertSettings(P);
  check('overbooking alerts are on by default', defaults.overbooking.enabled === true);
  check('new bookings are on by default', defaults['booking.new'].enabled === true);
  check('cancellations are on by default', defaults['booking.cancelled'].enabled === true);
  check('the alarm repeats until acknowledged',
    defaults.overbooking.repeat === 'until-acknowledged', defaults.overbooking);
  check('quiet hours are off until asked for', defaults.quietHours.enabled === false);
  check('but would still let an overbooking through',
    defaults.quietHours.allowOverbooking === true);

  section('2 · Each alert can be silenced on its own');
  alerts.saveAlertSettings(P, ACTOR, { 'booking.new': { enabled: false } });
  let s = alerts.alertSettings(P);
  check('the new-booking chime can be turned off', s['booking.new'].enabled === false);
  check('without touching the overbooking alarm', s.overbooking.enabled === true, s.overbooking);
  check('or the cancellation tone', s['booking.cancelled'].enabled === true);

  alerts.saveAlertSettings(P, ACTOR, { volume: 40 });
  check('volume is saved', alerts.alertSettings(P).volume === 40);
  check('and silencing survived the volume change',
    alerts.alertSettings(P)['booking.new'].enabled === false);

  alerts.saveAlertSettings(P, ACTOR, { volume: 500 });
  check('an impossible volume is clamped, not stored',
    alerts.alertSettings(P).volume === 100, alerts.alertSettings(P).volume);

  let badTime = false;
  try { alerts.saveAlertSettings(P, ACTOR, { quietHours: { ...s.quietHours, from: '25 oclock' } }); }
  catch { badTime = true; }
  check('a nonsense quiet-hours time is refused', badTime);

  alerts.saveAlertSettings(P, ACTOR, { 'booking.new': { enabled: true }, volume: 70 });

  section('3 · Quiet hours, including across midnight');
  const night = alerts.alertSettings(P);
  night.quietHours = { enabled: true, from: '22:00', to: '07:00', allowOverbooking: true };
  const at = (h: number, m = 0) => new Date(2026, 5, 15, h, m);
  check('23:30 is inside a 22:00→07:00 window', alerts.inQuietHours(night, at(23, 30)));
  check('03:00 is inside it too', alerts.inQuietHours(night, at(3)));
  check('12:00 is not', !alerts.inQuietHours(night, at(12)));
  check('21:59 is not', !alerts.inQuietHours(night, at(21, 59)));
  check('07:00 is not — the window ends there', !alerts.inQuietHours(night, at(7)));
  const daytime = { ...night, quietHours: { ...night.quietHours, from: '13:00', to: '15:00' } };
  check('a same-day window works too', alerts.inQuietHours(daytime, at(14)));
  check('and excludes outside it', !alerts.inQuietHours(daytime, at(16)));
  const off = { ...night, quietHours: { ...night.quietHours, enabled: false } };
  check('quiet hours off means never quiet', !alerts.inQuietHours(off, at(3)));

  section('4 · A booking raises an alert');
  const before = alerts.feed(P, {}).events.length;
  const first = book(ctx, addDays(TODAY, 20), { guest: 'Ayesha Khan' });
  const afterBook = alerts.feed(P, {});
  check('a new booking is on the feed',
    afterBook.events.length === before + 1, afterBook.events.length);
  const newEvent = afterBook.events[afterBook.events.length - 1];
  check('it is the right kind', newEvent.kind === 'booking.new', newEvent);
  check('and names the guest', /Ayesha Khan/.test(newEvent.title), newEvent.title);
  check('with the dates in the body', /2026-07-05/.test(newEvent.body ?? ''), newEvent.body);

  reservations.cancelReservation(P, ACTOR, first.id, { reason: 'Changed plans' } as any);
  const afterCancel = alerts.feed(P, {});
  const cancelEvent = afterCancel.events[afterCancel.events.length - 1];
  check('a cancellation is on the feed too', cancelEvent.kind === 'booking.cancelled', cancelEvent);
  check('and carries the reason', /Changed plans/.test(cancelEvent.body ?? ''), cancelEvent.body);

  section('5 · A refresh does not sound the alarm');
  // This is the one that decides whether the alarms survive their first week.
  const replay = alerts.feed(P, {});
  check('a feed without a cursor is marked as a replay', replay.replay === true, replay.replay);
  check('and still returns the history to display', replay.events.length > 0);

  const cursor = replay.now;
  await sleep(1100);          // the feed is second-resolution
  const quiet = alerts.feed(P, { since: cursor });
  check('nothing new means nothing to sound', quiet.events.length === 0, quiet.events);
  check('and it is not a replay', quiet.replay === false);

  book(ctx, addDays(TODAY, 25), { guest: 'Tomas Berg' });
  const live = alerts.feed(P, { since: cursor });
  check('a booking after the cursor does come through', live.events.length === 1, live.events);
  check('it is the new one', /Tomas Berg/.test(live.events[0].title), live.events[0]);
  check('the settings ride along, so the alarm needs no second call',
    !!live.settings && typeof live.settings.volume === 'number', live.settings);

  section('6 · The guard closes at zero, not at minus one');
  run(`DELETE FROM restrictions WHERE property_id = ?`, P);
  const day = addDays(TODAY, 40);
  book(ctx, day);
  ovb.guardInventory(P, ACTOR, { roomTypeId: ctx.roomTypeId, from: day, to: day, today: TODAY });
  check('one booking of two rooms closes nothing', closures(P).length === 0, closures(P));

  book(ctx, day);       // now sold out — the contested last room is gone
  ovb.guardInventory(P, ACTOR, { roomTypeId: ctx.roomTypeId, from: day, to: day, today: TODAY });
  const closed = closures(P);
  check('selling the last room closes the date', closed.length === 1, closed);
  check('and says why', /last room/i.test(closed[0]?.note ?? ''), closed[0]?.note);
  check('the date is right', closed[0]?.date_from === day, closed[0]);

  ovb.guardInventory(P, ACTOR, { roomTypeId: ctx.roomTypeId, from: day, to: day, today: TODAY });
  check('running the guard again does not close it twice',
    closures(P).length === 1, closures(P));

  section('7 · A run of sold-out nights is one closure, not five');
  run(`DELETE FROM restrictions WHERE property_id = ?`, P);
  run(`DELETE FROM overbookings WHERE property_id = ?`, P);
  const runStart = addDays(TODAY, 60);
  for (let i = 0; i < 5; i++) { book(ctx, addDays(runStart, i)); book(ctx, addDays(runStart, i)); }
  ovb.guardInventory(P, ACTOR, {
    roomTypeId: ctx.roomTypeId, from: runStart, to: addDays(runStart, 4), today: TODAY,
  });
  const runs = closures(P);
  check('five contiguous sold-out nights make one closure', runs.length === 1, runs);
  check('spanning the whole run',
    runs[0]?.date_from === runStart && runs[0]?.date_to === addDays(runStart, 4), runs[0]);

  section('8 · An overbooking raises its own alert');
  run(`DELETE FROM alert_events WHERE property_id = ?`, P);
  const busy = addDays(TODAY, 80);
  book(ctx, busy); book(ctx, busy);
  reservations.createReservation(P, ACTOR, {
    guestName: 'Overflow Guest', arrival: busy, departure: addDays(busy, 1),
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId, adults: 1, children: 0,
    force: true,                 // the race, reproduced: a booking that ignores availability
  } as any);
  ovb.guardInventory(P, ACTOR, { roomTypeId: ctx.roomTypeId, from: busy, to: busy, today: TODAY });

  const events = alerts.feed(P, {}).events;
  const alarm = events.find((e) => e.kind === 'overbooking');
  check('an overbooking alert is raised', !!alarm, events.map((e) => e.kind));
  check('it says how many rooms', /1 room\(s\) oversold/.test(alarm?.title ?? ''), alarm?.title);
  check('and the date', new RegExp(busy).test(alarm?.title ?? ''), alarm?.title);
  check('the body explains the likely cause', (alarm?.body ?? '').length > 40, alarm?.body);
  check('it is linked to the finding', !!alarm?.overbookingId, alarm);
  check('and it is not acknowledged yet', alarm?.acknowledgedAt === null);
  check('the feed counts it as needing attention',
    alerts.feed(P, {}).unacknowledged >= 1, alerts.feed(P, {}).unacknowledged);

  section('9 · Acknowledging silences the alarm');
  alerts.acknowledgeAlert(P, ACTOR, alarm!.id);
  check('one alert can be acknowledged',
    alerts.feed(P, {}).events.find((e) => e.id === alarm!.id)?.acknowledgedAt !== null);
  check('the outstanding count drops', alerts.feed(P, {}).unacknowledged === 0);

  book(ctx, addDays(TODAY, 81));
  const bulk = alerts.acknowledgeAll(P, ACTOR);
  check('everything can be silenced in one action', bulk.acknowledged >= 1, bulk);
  check('and nothing is left outstanding', alerts.feed(P, {}).unacknowledged === 0);

  section('10 · Muting silences the sound, not the record');
  alerts.saveAlertSettings(P, ACTOR, { 'booking.cancelled': { enabled: false } });
  const beforeMuted = alerts.feed(P, {}).events.length;
  const doomed = book(ctx, addDays(TODAY, 90));
  reservations.cancelReservation(P, ACTOR, doomed.id, { reason: 'Test' } as any);
  const afterMuted = alerts.feed(P, {});
  check('a muted cancellation is still recorded',
    afterMuted.events.length > beforeMuted, afterMuted.events.length);
  check('and the settings say it is muted, so the browser stays silent',
    afterMuted.settings['booking.cancelled'].enabled === false);

  process.stdout.write(`\n${checks - failures}/${checks} alert and guard checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write(
    'Alerts fire for new things only, and the last room is taken off sale the moment it goes.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
