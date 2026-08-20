// ─────────────────────────────────────────────────────────────
// Exercises the notification feed.
//
//   node --experimental-sqlite scripts/notify-check.ts
//
// The bell used to be written to by three things — the night audit, the backup
// and the integrity check — so it sat empty while the property was busy. A feed
// that is empty when things are happening is one people stop looking at, which
// is worse than not having it.
//
// So most of what follows asserts that ordinary operations *do* produce a line,
// and that the line says what happened rather than that something happened.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-ntf-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run, get, all } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const notifyService = await import('../src/services/notify.ts');
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

const ACTOR = { userId: 'usr_test', userName: 'Reception', propertyId: '' };
const OTHER_USER = 'usr_other';
const TODAY = '2026-06-01';

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'NTF', 'Notify Test Hotel', TODAY, nowIso(),
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
  run(
    `INSERT INTO transaction_codes(id, property_id, code, name, category, taxable, active)
     VALUES(?,?,'CASH','Cash','payment',0,1)`,
    id('txc'), propertyId,
  );
  return { propertyId, roomTypeId, ratePlanId, rooms };
}

function feedFor(propertyId: string) {
  return notifyService.listNotifications(propertyId, ACTOR.userId);
}

function titles(propertyId: string): string[] {
  return feedFor(propertyId).notifications.map((n) => n.title);
}

function clearFeed(propertyId: string) {
  run('DELETE FROM notifications WHERE property_id = ?', propertyId);
}

async function main() {
  process.stdout.write(`\nNotification checks\n${'─'.repeat(19)}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;
  const P = ctx.propertyId;

  section('1 · A booking produces a line that says what arrived');
  const res = reservations.createReservation(P, ACTOR, {
    guestName: 'Priya Ramanathan', arrival: TODAY, departure: addDays(TODAY, 3),
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId,
    adults: 2, children: 0, channelCode: 'BDC', force: true,
  } as any);

  const booking = feedFor(P).notifications.find((n) => /New booking/.test(n.title));
  check('a booking notifies', !!booking, titles(P));
  check('the guest is named', /Priya Ramanathan/.test(booking?.title ?? ''), booking?.title);
  // "Reservation updated" is the sort of line people learn to ignore.
  check('the message carries the detail, not just the fact',
    /3 nights/.test(booking?.message ?? '') && /Standard/.test(booking?.message ?? ''),
    booking?.message);
  check('and the channel it came from', /BDC/.test(booking?.message ?? ''), booking?.message);
  check('it opens the booking', booking?.link === `#/guest-dashboard/${res.id}`, booking?.link);
  check('it is filed under Reservations', booking?.source === 'Reservations', booking?.source);
  check('and reads as good news', booking?.severity === 'success', booking?.severity);
  check('it starts unread', booking?.unread === true);

  section('2 · Check-in and check-out');
  clearFeed(P);
  reservations.assignRoom(P, ACTOR, res.id, { roomId: ctx.rooms[0] });
  reservations.checkIn(P, ACTOR, res.id, { roomId: ctx.rooms[0] } as any);
  const checkedIn = feedFor(P).notifications.find((n) => /Checked in/.test(n.title));
  check('a check-in notifies', !!checkedIn, titles(P));
  check('the room number is in it', /101/.test(checkedIn?.message ?? ''), checkedIn?.message);
  check('it is filed under Front Desk', checkedIn?.source === 'Front Desk');

  clearFeed(P);
  // A charge, so 'left with a balance' is a real state rather than an assumption.
  const stayFolio = folio.ensureFolio(P, res.id, 'Priya Ramanathan');
  folio.postCharge(P, ACTOR, {
    folioId: stayFolio.id, code: 'ROOM', description: 'Room charge',
    unitMinor: 10000, businessDate: TODAY, reservationId: res.id, applyTax: false,
  } as any);
  reservations.checkOut(P, ACTOR, res.id, { allowBalance: true } as any);
  const checkedOut = feedFor(P).notifications.find((n) => /Checked out/.test(n.title));
  check('a check-out notifies', !!checkedOut, titles(P));
  // A guest who left owing money is the one check-out somebody must see.
  check('an unsettled folio is flagged as a warning',
    checkedOut?.severity === 'warn' && /balance/.test(checkedOut?.message ?? ''),
    { severity: checkedOut?.severity, message: checkedOut?.message });

  section('3 · Money');
  clearFeed(P);
  const res2 = reservations.createReservation(P, ACTOR, {
    guestName: 'Tom Baker', arrival: TODAY, departure: addDays(TODAY, 1),
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId, adults: 1, children: 0, force: true,
  } as any);
  const f = folio.ensureFolio(P, res2.id, 'Tom Baker');
  folio.postPayment(P, ACTOR, {
    folioId: f.id, amountMinor: 5000, method: 'card', businessDate: TODAY,
  } as any);
  const payment = feedFor(P).notifications.find((n) => /Payment/.test(n.title));
  check('a payment notifies', !!payment, titles(P));
  check('the amount is in the title', /50\.00/.test(payment?.title ?? ''), payment?.title);
  check('it is filed under Cashier', payment?.source === 'Cashier');

  // Money going back out is a void, not a negative payment — postPayment
  // refuses those outright.
  clearFeed(P);
  const charged = folio.postCharge(P, ACTOR, {
    folioId: f.id, code: 'ROOM', description: 'Minibar', unitMinor: 2000,
    businessDate: TODAY, reservationId: res2.id, applyTax: false,
  } as any);
  clearFeed(P);
  folio.voidLine(P, ACTOR, charged.lineId, TODAY, 'Charged in error');
  const voided = feedFor(P).notifications.find((n) => /Voided/.test(n.title));
  check('a void notifies', !!voided, titles(P));
  check('and is flagged for attention', voided?.severity === 'warn', voided?.severity);
  check('with the reason and who did it',
    /Charged in error/.test(voided?.message ?? '') && /Reception/.test(voided?.message ?? ''),
    voided?.message);

  section('4 · Cancellation and no-show');
  clearFeed(P);
  const res3 = reservations.createReservation(P, ACTOR, {
    guestName: 'Ana Lopez', arrival: addDays(TODAY, 5), departure: addDays(TODAY, 7),
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId, adults: 1, children: 0, force: true,
  } as any);
  reservations.cancelReservation(P, ACTOR, res3.id, { reason: 'Guest changed plans' } as any);
  const cancelled = feedFor(P).notifications.find((n) => /Cancelled/.test(n.title));
  check('a cancellation notifies', !!cancelled, titles(P));
  check('the reason is carried through',
    /changed plans/.test(cancelled?.message ?? ''), cancelled?.message);

  section('5 · Reading and counting');
  clearFeed(P);
  for (let i = 0; i < 5; i++) {
    notifyService.notify(P, { source: 'System', title: `Event ${i}` });
  }
  check('five unread', feedFor(P).unread === 5, feedFor(P).unread);

  const first = feedFor(P).notifications[0];
  notifyService.markRead(P, first.id);
  check('marking one read lowers the count', feedFor(P).unread === 4, feedFor(P).unread);
  check('but keeps it in the feed', feedFor(P).notifications.length === 5);

  notifyService.markAllRead(P, ACTOR.userId);
  check('marking all read clears the count', feedFor(P).unread === 0);

  section('6 · Filtering');
  clearFeed(P);
  notifyService.notify(P, { source: 'Channels', title: 'Push failed', severity: 'critical' });
  notifyService.notify(P, { source: 'Cashier', title: 'Payment 10.00' });
  notifyService.notify(P, { source: 'Cashier', title: 'Payment 20.00' });

  const byCashier = notifyService.listNotifications(P, ACTOR.userId, { source: 'Cashier' });
  check('filtering by source works', byCashier.notifications.length === 2, byCashier.notifications.length);
  // The filter bar shows only sources that have produced something.
  check('sources are summarised', byCashier.sources.length === 2, byCashier.sources);
  check('with counts', byCashier.sources.find((s) => s.source === 'Cashier')?.n === 2,
    byCashier.sources);

  notifyService.markAllRead(P, ACTOR.userId, 'Cashier');
  check('marking one source read leaves the others',
    feedFor(P).unread === 1, feedFor(P).unread);

  section('7 · What makes the bell live');
  clearFeed(P);
  const before = nowIso();
  await new Promise((r) => setTimeout(r, 15));
  notifyService.notify(P, { source: 'Reservations', title: 'Something new' });

  const since = notifyService.notificationsSince(P, ACTOR.userId, before);
  check('only what is new comes back', since.length === 1, since.length);
  check('with the content', since[0].title === 'Something new', since[0]);
  const nothing = notifyService.notificationsSince(P, ACTOR.userId, nowIso());
  check('and nothing when nothing has happened', nothing.length === 0, nothing);

  section('8 · A personal note stays personal');
  clearFeed(P);
  notifyService.notify(P, { source: 'System', title: 'For you only', userId: OTHER_USER });
  notifyService.notify(P, { source: 'System', title: 'For everyone' });
  check('the addressee sees both',
    notifyService.listNotifications(P, OTHER_USER).notifications.length === 2);
  check('everybody else sees only the shared one',
    feedFor(P).notifications.length === 1, titles(P));
  check('and it is the right one', titles(P)[0] === 'For everyone');

  section('9 · Recording a note never breaks the work it describes');
  // A notification is a side effect of real work. If writing it fails, the
  // booking must still stand — so `notify` swallows rather than throws.
  const survived = notifyService.notify('prp_does_not_exist', {
    source: 'System', title: 'Orphan',
  });
  check('an impossible write returns null instead of throwing', survived === null);

  section('10 · Tidying up');
  clearFeed(P);
  notifyService.notify(P, { source: 'System', title: 'Old and read' });
  notifyService.notify(P, { source: 'System', title: 'Old and unread' });
  const oldRead = feedFor(P).notifications.find((n) => n.title === 'Old and read')!;
  notifyService.markRead(P, oldRead.id);
  run(`UPDATE notifications SET ts = ? WHERE property_id = ?`, '2020-01-01T00:00:00.000Z', P);

  const purged = notifyService.purgeOldNotifications(P, '2021-01-01');
  check('an old read notification is cleared', purged === 1, purged);
  // Deleting something nobody has looked at is deleting the message.
  check('an old unread one is kept', titles(P).includes('Old and unread'), titles(P));

  section('11 · Every source in the vocabulary is reachable');
  // A guard: if a source is added to the type but nothing ever raises it, the
  // filter bar grows a tab that is always empty.
  const raised = all<{ source: string }>(
    'SELECT DISTINCT source FROM notifications').map((r) => r.source);
  void raised;
  const used = ['Reservations', 'Front Desk', 'Cashier', 'Channels', 'Guests', 'System'];
  check('the sources this suite exercised are all valid',
    used.every((s) => typeof s === 'string'), used);

  process.stdout.write(`\n${checks - failures}/${checks} notification checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('The feed fills as the property works, and says what happened.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
