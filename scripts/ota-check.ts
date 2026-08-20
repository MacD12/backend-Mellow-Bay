// ─────────────────────────────────────────────────────────────
// The OTAs behind the hub, and how confidently we claim to know them.
//
//   node --experimental-sqlite scripts/ota-check.ts
//
// Beds24 will not say which OTAs a property is connected to — `/channels`
// returns literal null and `/properties/channels` returns 500, with the
// `all:channels` scope granted. So the state is assembled from three signals of
// very different strength, and the whole risk lives in mixing them up:
//
//   · a **booking** is proof;
//   · a **rate code** is evidence — it shows a mapping exists on the Beds24
//     side, not that the channel is live, and it outlives the connection that
//     created it;
//   · a person **declaring** it is neither, but it is often the only thing
//     available.
//
// Getting this wrong in the flattering direction — showing "connected" for a
// channel that has never sold anything — is the green tick this codebase keeps
// taking out. So most of what follows asserts that a state is *not* claimed.
//
// It builds its own database. Nothing real is called.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-ota-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run } = await import('../src/db.ts');
const { id, nowIso } = await import('../src/lib/util.ts');
const otas = await import('../src/services/otas.ts');

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  if (ok) { process.stdout.write(`  ✓ ${name}\n`); return; }
  failures++;
  process.stdout.write(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`);
}
function section(title: string) {
  process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`);
}

const P = 'prp_test';
const ACTOR = { userId: 'u1', userName: 'Tester', propertyId: P };

/** The catalogue Beds24 actually returned for the live property. */
const CATALOGUE = [
  'agoda', 'airbnb', 'booking', 'expedia', 'hostelworld', 'hostelsclub', 'trip', 'vrbo',
];

function seed() {
  run(
    `INSERT INTO properties(id, code, name, timezone, currency, business_date, created_at)
     VALUES(?,'OTA','OTA Test','UTC','USD','2026-06-01',?)`, P, nowIso());
  run(
    `INSERT INTO channels(id, property_id, code, name, kind, active, commission_bp,
                          price_multiplier_bp, status, created_at)
     VALUES('chn1',?,'BEDS24','Beds24','ota',1,0,10000,'connected',?)`, P, nowIso());
  // A reservation needs something to point at — foreign keys are enforced here,
  // which is the whole reason this suite catches shape mistakes at all.
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, created_at)
     VALUES('rt1',?,'STD','Standard','room',?)`, P, nowIso());
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, created_at)
     VALUES('rp1',?,'STD','Standard Rate',?)`, P, nowIso());
}

/** A channel booking, the way `importBookings` files one. */
function booking(ota: string | null, channelCode = 'BEDS24') {
  const rid = id('res');
  run(
    `INSERT INTO reservations(id, property_id, confirmation, status, guest_name, arrival, departure,
                              nights, adults, children, room_type_id, rate_plan_id, source,
                              channel_code, ota_channel, origin, currency, total_minor, created_at, updated_at)
     VALUES(?,?,?,'Confirmed','Guest','2026-06-10','2026-06-12',2,1,0,'rt1','rp1','OTA',
            ?,?, 'channel','USD',1000,?,?)`,
    rid, P, rid.slice(-8), channelCode, ota, nowIso(), nowIso());
  return rid;
}

const stateOf = (code: string) => otas.listOtas(P).find((o) => o.code === code)?.state;
const rowOf = (code: string) => otas.listOtas(P).find((o) => o.code === code);

async function main() {
  process.stdout.write(`\nOTA detection checks\n${'─'.repeat(20)}\n`);
  migrate();
  seed();

  section('1 · The catalogue comes from Beds24');
  otas.recordCatalogue(P, 'chn1', CATALOGUE, {});
  check('every channel Beds24 listed is recorded',
    otas.listOtas(P).length === CATALOGUE.length, otas.listOtas(P).length);
  check('…and none of them is claimed as connected',
    otas.listOtas(P).every((o) => o.state === 'available'));
  check('a key is given a readable name', rowOf('booking')?.name === 'Booking.com',
    rowOf('booking')?.name);
  check('…including one with no entry in the list',
    otas.displayName('somenewchannel') === 'Somenewchannel', otas.displayName('somenewchannel'));

  section('2 · A rate code is evidence, never proof');
  otas.recordCatalogue(P, 'chn1', CATALOGUE, { booking: '31973989' });
  check('a rate code raises the channel to evidence', stateOf('booking') === 'evidence',
    stateOf('booking'));
  // The distinction this whole module exists to preserve.
  check('…and NOT to confirmed', stateOf('booking') !== 'confirmed');
  check('the reason says so in words',
    /not confirmed/i.test(rowOf('booking')?.because ?? ''), rowOf('booking')?.because);
  check('the rate code itself is shown', rowOf('booking')?.rateCode === '31973989');
  check('channels without a rate code are untouched', stateOf('hostelworld') === 'available');

  section('3 · A booking is proof');
  booking('Hostelworld');
  otas.refreshFromBookings(P);
  check('a booking confirms its OTA', stateOf('hostelworld') === 'confirmed', stateOf('hostelworld'));
  check('…and is counted', rowOf('hostelworld')?.bookings === 1, rowOf('hostelworld')?.bookings);
  check('…and dated', !!rowOf('hostelworld')?.lastBookingAt);
  check('other channels are not confirmed by it', stateOf('agoda') === 'available');

  // Beds24 sends the OTA's trading name, not its own settings key.
  check('"Booking.com" maps to the catalogue key', otas.codeForReferer('Booking.com') === 'booking');
  check('"Hostelworld" maps to its key', otas.codeForReferer('Hostelworld') === 'hostelworld');
  check('case and punctuation do not matter', otas.codeForReferer('booking.COM') === 'booking');

  section('4 · Nothing is ever quietly downgraded');
  // Beds24 tidying a rate mapping must not erase the fact that a booking came.
  otas.recordCatalogue(P, 'chn1', CATALOGUE, {});
  check('a confirmed OTA stays confirmed after a catalogue refresh with no rate code',
    stateOf('hostelworld') === 'confirmed', stateOf('hostelworld'));
  check('…and evidence falls back correctly when its rate code goes',
    stateOf('booking') === 'available', stateOf('booking'));

  section('5 · The operator can say what the API cannot see');
  otas.declareOta(P, ACTOR, 'airbnb', true);
  check('declaring marks it declared', stateOf('airbnb') === 'declared', stateOf('airbnb'));
  check('…and says it was a person, not the API',
    /staff/i.test(rowOf('airbnb')?.because ?? ''), rowOf('airbnb')?.because);
  otas.declareOta(P, ACTOR, 'airbnb', false);
  check('undeclaring returns it to available', stateOf('airbnb') === 'available');

  otas.recordCatalogue(P, 'chn1', CATALOGUE, { expedia: 'RATE-9' });
  otas.declareOta(P, ACTOR, 'expedia', true);
  otas.declareOta(P, ACTOR, 'expedia', false);
  check('undeclaring falls back to evidence when a rate code remains',
    stateOf('expedia') === 'evidence', stateOf('expedia'));

  // A person unticking a box cannot un-happen a booking.
  otas.declareOta(P, ACTOR, 'hostelworld', false);
  check('turning off a confirmed OTA does not un-confirm it',
    stateOf('hostelworld') === 'confirmed', stateOf('hostelworld'));
  check('…and keeps its bookings', rowOf('hostelworld')?.bookings === 1);

  section('6 · Counts follow the bookings, not a running total');
  booking('Hostelworld');
  booking('Booking.com');
  otas.refreshFromBookings(P);
  check('a second booking is counted', rowOf('hostelworld')?.bookings === 2,
    rowOf('hostelworld')?.bookings);
  check('a booking from another OTA confirms that one too',
    stateOf('booking') === 'confirmed', stateOf('booking'));

  run(`DELETE FROM reservations WHERE property_id = ? AND ota_channel = 'Booking.com'`, P);
  otas.refreshFromBookings(P);
  check('deleting the bookings drops the count to zero',
    rowOf('booking')?.bookings === 0, rowOf('booking')?.bookings);
  // The count is current; the state is history, and history does not un-happen.
  check('…but the OTA is still on record as having sold',
    stateOf('booking') === 'confirmed', stateOf('booking'));

  section('7 · A booking from outside the catalogue is still recorded');
  booking('SomeNewOta');
  otas.refreshFromBookings(P);
  check('an unlisted channel that sent a booking is added',
    !!rowOf('somenewota'), otas.listOtas(P).map((o) => o.code));
  check('…as confirmed, because it happened', stateOf('somenewota') === 'confirmed');

  section('8 · A booking with no OTA falls back to the connection');
  booking(null, 'BEDS24');
  otas.refreshFromBookings(P);
  check('it is attributed to the hub rather than dropped',
    (rowOf('beds24')?.bookings ?? 0) >= 1, otas.listOtas(P).map((o) => `${o.code}:${o.bookings}`));

  section('9 · The summary counts belief and proof apart');
  const s = otas.otaSummary(P);
  check('confirmed counts only what has sold',
    s.confirmed === otas.listOtas(P).filter((o) => o.state === 'confirmed').length, s);
  check('likely counts evidence and declared, not confirmed',
    s.likely === otas.listOtas(P).filter(
      (o) => o.state === 'evidence' || o.state === 'declared').length, s);
  check('the two never overlap', s.confirmed + s.likely <= s.total, s);

  section('10 · Inventory: the two sides compared');
  const inv = await import('../src/services/inventory.ts');

  // A dorm sells beds, not rooms. Comparing Beds24's bed count against Helio's
  // *room* count would report drift on every dorm in the property while the two
  // agree perfectly — so the comparison is against what is actually sellable.
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, created_at)
     VALUES('rtd',?,'DORM','Mixed Dorm','dorm',?)`, P, nowIso());
  run(
    `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
     VALUES('rm1',?, 'rtd','D-1',1,'Vacant Clean',1,?)`, P, nowIso());
  for (let i = 1; i <= 8; i++) {
    run(
      `INSERT INTO beds(id, property_id, room_id, code, bunk, status, active)
       VALUES(?,?, 'rm1', ?, 'single', 'Vacant Clean', 1)`,
      `bed${i}`, P, `D-1-0${i}`);
  }
  run(
    `INSERT INTO channel_mappings(id, property_id, channel_id, room_type_id, external_room_id,
                                  external_name, external_qty, active, created_at)
     VALUES('map1',?,'chn1','rtd','715747','Mixed Dorm',8,1,?)`, P, nowIso());

  let line = inv.inventoryLines(P).find((l) => l.roomTypeId === 'rtd')!;
  check('a dorm is measured in beds, not rooms', line.sellable === 8, line);
  check('…and agrees with the channel at 8', line.drift === 0, line.drift);
  check('beds per room is derived', line.bedsPerRoom === 8, line.bedsPerRoom);

  run(`UPDATE channel_mappings SET external_qty = 16 WHERE id = 'map1'`);
  line = inv.inventoryLines(P).find((l) => l.roomTypeId === 'rtd')!;
  check('a channel selling more than exists is drift', line.drift === -8, line.drift);
  // The direction that matters: negative means beds are being sold that are not
  // there, which is an overbooking with a delay on it.
  check('…and it is negative, the dangerous direction', line.drift! < 0);
  check('drift is listed', inv.inventoryDrift(P).some((d) => d.roomTypeId === 'rtd'));

  run(`UPDATE channel_mappings SET external_qty = 8 WHERE id = 'map1'`);
  check('agreement is not reported as drift',
    inv.inventoryDrift(P).every((d) => d.roomTypeId !== 'rtd'));

  section('11 · Inventory cannot delete what is sold');
  inv.setInventory(P, ACTOR, 'rtd', { rooms: 2, bedsPerRoom: 8 });
  line = inv.inventoryLines(P).find((l) => l.roomTypeId === 'rtd')!;
  check('growing adds rooms and beds', line.sellable === 16, line.sellable);

  inv.setInventory(P, ACTOR, 'rtd', { rooms: 1, bedsPerRoom: 8 });
  check('shrinking removes them again',
    inv.inventoryLines(P).find((l) => l.roomTypeId === 'rtd')!.sellable === 8);

  // Put a guest in a bed, then try to delete it. This is the guard that makes
  // the editor safe to hand to a receptionist.
  const rid = id('res');
  run(
    `INSERT INTO reservations(id, property_id, confirmation, status, guest_name, arrival, departure,
                              nights, adults, children, room_type_id, rate_plan_id, source, origin,
                              currency, total_minor, created_at, updated_at)
     VALUES(?,?,?,'Confirmed','Sleeper','2026-06-10','2026-06-12',2,1,0,'rtd','rp1','Direct','pms',
            'USD',1000,?,?)`, rid, P, rid.slice(-8), nowIso(), nowIso());
  run(
    `INSERT INTO reservation_nights(id, reservation_id, property_id, date, room_type_id, room_id,
                                    bed_id, rate_plan_id, rate_minor, adults, children, posted)
     VALUES(?,?,?, '2026-06-10','rtd','rm1','bed8','rp1',500,1,0,0)`,
    id('rn'), rid, P);

  let refused: any = null;
  try { inv.setInventory(P, ACTOR, 'rtd', { rooms: 1, bedsPerRoom: 4 }); }
  catch (e) { refused = e; }
  check('removing a booked bed is refused', refused !== null, refused?.message);
  check('…and names the bed', /D-1-08/.test(refused?.message ?? ''), refused?.message);
  check('…and nothing was removed',
    inv.inventoryLines(P).find((l) => l.roomTypeId === 'rtd')!.sellable === 8);

  refused = null;
  try { inv.setInventory(P, ACTOR, 'rtd', { rooms: 0 }); }
  catch (e) { refused = e; }
  check('removing a booked room is refused too', refused !== null, refused?.message);
  check('the booked count is reported', line.sold >= 0, line.sold);

  // Reducing to exactly what is booked is allowed — only what is sold is safe.
  check('reducing to the booked size is allowed',
    inv.setInventory(P, ACTOR, 'rtd', { rooms: 1, bedsPerRoom: 8 }).sellable === 8);

  section('12 · Auto-push is a choice, not a default');
  // Turning a configuration edit into a live OTA change is exactly the kind of
  // thing that must never arrive switched on: a property still setting up would
  // publish its half-finished inventory without ever deciding to.
  check('it is off on a fresh property', inv.autoPushEnabled(P) === false);
  inv.setAutoPush(P, ACTOR, true);
  check('it can be switched on', inv.autoPushEnabled(P) === true);
  inv.setAutoPush(P, ACTOR, false);
  check('…and off again', inv.autoPushEnabled(P) === false);
  check('the switch is per property, not global',
    inv.autoPushEnabled('some_other_property') === false);

  process.stdout.write(`\n${checks - failures}/${checks} OTA checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('An OTA is only called connected when something proves it.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows locks */ }
}
