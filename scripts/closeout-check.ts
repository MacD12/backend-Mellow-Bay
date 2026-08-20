// ─────────────────────────────────────────────────────────────
// Exercises closing and reopening dates for sale.
//
//   node --experimental-sqlite scripts/closeout-check.ts
//
// The arithmetic here is the whole point. Reopening three days out of the
// middle of a two-week closure has to leave two closures with a gap between
// them — not delete the rule, and not leave the gap one day wide at the wrong
// end. Every case below is checked against what the booking engine will
// actually refuse, not just against the rows in the table, because a closure
// that exists but does not block a sale is worse than no closure at all.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-closeout-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run, all } = await import('../src/db.ts');
const { id, nowIso } = await import('../src/lib/util.ts');
const closeouts = await import('../src/services/closeouts.ts');
const { validateStay } = await import('../src/services/restrictions.ts');

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

// ─── A property with two room types and one rate plan ────────
function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en','2026-06-01','14:00','11:00',1,?)`,
    propertyId, 'CLO', 'Closeout Test Hotel', nowIso(),
  );
  const roomTypes: string[] = [];
  for (const [code, name] of [['STD', 'Standard'], ['DLX', 'Deluxe']]) {
    const rtId = id('rt');
    run(
      `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                              max_adults, max_children, default_rate_minor, extra_adult_minor,
                              extra_child_minor, sort_order, active, created_at)
       VALUES(?,?,?,?,'room',2,2,2,0,10000,0,0,1,1,?)`,
      rtId, propertyId, code, name, nowIso(),
    );
    roomTypes.push(rtId);
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
  return { propertyId, roomTypes, ratePlanId };
}

/** Would the engine sell a one-night stay on this date? */
function sellable(
  propertyId: string, roomTypeId: string, ratePlanId: string, date: string, channelCode?: string,
): boolean {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return validateStay(propertyId, {
    roomTypeId, ratePlanId, arrival: date, departure: next,
    channelCode: channelCode ?? null, bookedOn: '2026-06-01',
  }).filter((v) => v.type === 'stop-sell').length === 0;
}

function closures(propertyId: string) {
  return all<any>(
    `SELECT date_from, date_to, room_type_id, channel_code FROM restrictions
      WHERE property_id = ? AND type = 'stop-sell' AND active = 1
      ORDER BY date_from`,
    propertyId,
  );
}

function reset(propertyId: string) {
  run(`DELETE FROM restrictions WHERE property_id = ?`, propertyId);
  run(`DELETE FROM channel_queue WHERE property_id = ?`, propertyId);
}

async function main() {
  process.stdout.write(`\nClose-out checks\n${'─'.repeat(16)}\nWorking in ${workdir}\n`);
  migrate();
  const { propertyId, roomTypes, ratePlanId } = seed();
  ACTOR.propertyId = propertyId;
  const [STD, DLX] = roomTypes;
  const sells = (d: string, rt = STD, ch?: string) => sellable(propertyId, rt, ratePlanId, d, ch);

  section('1 · Closing a range actually stops the sale');
  const first = closeouts.closeDates(propertyId, ACTOR, {
    from: '2026-07-10', to: '2026-07-12', reason: 'Refurbishment',
  });
  check('a closure was created', !!first.id);
  check('it covers the range asked for', first.from === '2026-07-10' && first.to === '2026-07-12', first);
  check('the first closed night will not sell', !sells('2026-07-10'));
  check('the middle night will not sell', !sells('2026-07-11'));
  check('the last closed night will not sell', !sells('2026-07-12'));
  check('the night before is unaffected', sells('2026-07-09'));
  check('the night after is unaffected', sells('2026-07-13'));

  section('2 · Closing is pushed to the channel');
  const queued = all<any>(
    `SELECT * FROM channel_queue WHERE property_id = ? AND reason = 'inventory.close'`, propertyId);
  check('an ARI push was queued', queued.length > 0, queued.length);
  check('one per room type, since the closure was property-wide',
    queued.length === roomTypes.length, { queued: queued.length, roomTypes: roomTypes.length });
  // date_to is inclusive on a closure and exclusive on a push window — the last
  // closed night has to be inside the pushed range or it stays on sale.
  check('the pushed window includes the final closed night',
    queued.every((q: any) => q.date_to > '2026-07-12'),
    queued.map((q: any) => `${q.date_from}→${q.date_to}`));

  section('3 · Adjacent and overlapping closes merge');
  const touching = closeouts.closeDates(propertyId, ACTOR, { from: '2026-07-13', to: '2026-07-14' });
  check('closing the next day extends rather than adds', touching.extended === true, touching);
  check('the range now spans both', touching.from === '2026-07-10' && touching.to === '2026-07-14', touching);
  check('there is still exactly one closure', closures(propertyId).length === 1, closures(propertyId));

  const overlap = closeouts.closeDates(propertyId, ACTOR, { from: '2026-07-08', to: '2026-07-11' });
  check('an overlapping close absorbs into one row', closures(propertyId).length === 1);
  check('and the span grows backwards', overlap.from === '2026-07-08', overlap);
  check('every night in the merged span is closed',
    !sells('2026-07-08') && !sells('2026-07-11') && !sells('2026-07-14'));

  section('4 · Reopening the middle splits the closure');
  reset(propertyId);
  closeouts.closeDates(propertyId, ACTOR, { from: '2026-08-01', to: '2026-08-14', reason: 'Owner stay' });
  const split = closeouts.openDates(propertyId, ACTOR, { from: '2026-08-06', to: '2026-08-08' });
  check('one closure was split', split.split === 1, split);
  check('two closures remain', closures(propertyId).length === 2, closures(propertyId));
  check('the head stops the day before the opened range',
    closures(propertyId)[0].date_to === '2026-08-05', closures(propertyId)[0]);
  check('the tail starts the day after',
    closures(propertyId)[1].date_from === '2026-08-09', closures(propertyId)[1]);
  check('the night before the gap is still closed', !sells('2026-08-05'));
  check('the first reopened night sells', sells('2026-08-06'));
  check('the middle reopened night sells', sells('2026-08-07'));
  check('the last reopened night sells', sells('2026-08-08'));
  check('the night after the gap is still closed', !sells('2026-08-09'));
  check('the far end of the closure is untouched', !sells('2026-08-14'));

  section('5 · Reopening an edge shrinks, it does not split');
  reset(propertyId);
  closeouts.closeDates(propertyId, ACTOR, { from: '2026-09-01', to: '2026-09-10' });
  closeouts.openDates(propertyId, ACTOR, { from: '2026-08-25', to: '2026-09-03' });
  check('the closure survives as one row', closures(propertyId).length === 1, closures(propertyId));
  check('it now starts after the opened range',
    closures(propertyId)[0].date_from === '2026-09-04', closures(propertyId)[0]);
  check('the reopened head sells', sells('2026-09-01') && sells('2026-09-03'));
  check('the remaining tail does not', !sells('2026-09-04') && !sells('2026-09-10'));

  closeouts.openDates(propertyId, ACTOR, { from: '2026-09-08', to: '2026-09-30' });
  check('opening past the end shrinks the tail',
    closures(propertyId)[0]?.date_to === '2026-09-07', closures(propertyId));
  check('the reopened tail sells', sells('2026-09-08') && sells('2026-09-10'));

  section('6 · Reopening the whole thing removes it');
  reset(propertyId);
  closeouts.closeDates(propertyId, ACTOR, { from: '2026-10-01', to: '2026-10-05' });
  const gone = closeouts.openDates(propertyId, ACTOR, { from: '2026-10-01', to: '2026-10-05' });
  check('the closure was removed, not shrunk', gone.removed === 1 && gone.split === 0, gone);
  check('no closures remain', closures(propertyId).length === 0);
  check('every night sells again',
    sells('2026-10-01') && sells('2026-10-03') && sells('2026-10-05'));

  section('7 · Scope is respected');
  reset(propertyId);
  closeouts.closeDates(propertyId, ACTOR, { roomTypeId: STD, from: '2026-11-01', to: '2026-11-03' });
  check('the closed room type will not sell', !sells('2026-11-02', STD));
  check('the other room type is unaffected', sells('2026-11-02', DLX));

  // Opening one room type out of a property-wide closure would mean exploding
  // that row into one per type. It is refused and reported instead.
  reset(propertyId);
  closeouts.closeDates(propertyId, ACTOR, { from: '2026-11-10', to: '2026-11-12', reason: 'Storm' });
  const partial = closeouts.openDates(propertyId, ACTOR, { roomTypeId: STD, from: '2026-11-10', to: '2026-11-12' });
  check('opening one type does not silently succeed', partial.opened === 0, partial);
  check('the broader closure is named back to the caller',
    partial.stillClosedBy.length === 1, partial.stillClosedBy);
  check('…with its reason, so the screen can explain why',
    partial.stillClosedBy[0]?.reason === 'Storm', partial.stillClosedBy[0]);
  check('and the dates really are still closed', !sells('2026-11-11', STD));

  section('8 · Closing a single channel');
  reset(propertyId);
  closeouts.closeDates(propertyId, ACTOR, {
    channelCode: 'BDC', from: '2026-12-01', to: '2026-12-02', reason: 'Rate parity',
  });
  check('the closed channel cannot sell', !sells('2026-12-01', STD, 'BDC'));
  check('the direct desk can still sell', sells('2026-12-01', STD));
  check('another channel can still sell', sells('2026-12-01', STD, 'EXP'));

  section('9 · The close-out list');
  reset(propertyId);
  closeouts.closeDates(propertyId, ACTOR, { from: '2026-05-01', to: '2026-05-03', reason: 'Past works' });
  closeouts.closeDates(propertyId, ACTOR, { from: '2026-06-01', to: '2026-06-04', reason: 'Live now' });
  closeouts.closeDates(propertyId, ACTOR, {
    roomTypeId: DLX, from: '2026-07-01', to: '2026-07-02', reason: 'Later',
  });
  const list = closeouts.closeoutList(propertyId, '2026-06-01');
  check('every closure is listed', list.length === 3, list.length);
  check('a finished closure is marked expired',
    list.find((c) => c.from === '2026-05-01')?.expired === true);
  check('a running closure is marked active',
    list.find((c) => c.from === '2026-06-01')?.active === true);
  check('a future closure is marked upcoming',
    list.find((c) => c.from === '2026-07-01')?.upcoming === true);
  check('the scope is written out for a person',
    list.find((c) => c.from === '2026-07-01')?.scope.startsWith('Deluxe') === true,
    list.find((c) => c.from === '2026-07-01')?.scope);
  check('a property-wide closure says so',
    list.find((c) => c.from === '2026-06-01')?.scope.startsWith('All room types') === true);
  check('the reason survives', list.find((c) => c.from === '2026-06-01')?.reason === 'Live now');
  check('nights are counted inclusively',
    list.find((c) => c.from === '2026-06-01')?.nights === 4,
    list.find((c) => c.from === '2026-06-01')?.nights);

  const purged = closeouts.purgeExpiredCloseouts(propertyId, '2026-06-01');
  check('only the expired closure is purged', purged === 1, purged);
  check('the live and future ones survive', closures(propertyId).length === 2);

  section('10 · Bad input is refused');
  let rejected = false;
  try {
    closeouts.closeDates(propertyId, ACTOR, { from: '2026-04-10', to: '2026-04-01' });
  } catch { rejected = true; }
  check('a backwards range is rejected', rejected);

  let badDate = false;
  try {
    closeouts.closeDates(propertyId, ACTOR, { from: 'not-a-date', to: '2026-04-01' });
  } catch { badDate = true; }
  check('a malformed date is rejected', badDate);

  section('11 · A single closed night');
  reset(propertyId);
  const oneNight = closeouts.closeDates(propertyId, ACTOR, { from: '2027-01-15', to: '2027-01-15' });
  check('a one-night closure is allowed', oneNight.from === oneNight.to);
  check('that night does not sell', !sells('2027-01-15'));
  check('its neighbours do', sells('2027-01-14') && sells('2027-01-16'));
  const undo = closeouts.openDates(propertyId, ACTOR, { from: '2027-01-15', to: '2027-01-15' });
  check('reopening one night removes it', undo.removed === 1 && closures(propertyId).length === 0);
  check('and it sells again', sells('2027-01-15'));

  process.stdout.write(`\n${checks - failures}/${checks} close-out checks passed\n`);
  if (failures) process.exit(1);
  process.stdout.write('Dates close, reopen, split and push correctly.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
