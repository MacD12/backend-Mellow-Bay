// ─────────────────────────────────────────────────────────────
// Exercises price planning: preview, seasons, scheduling, copying and history.
//
//   node --experimental-sqlite scripts/rateplanning-check.ts
//
// The check that matters most is that **the preview does not lie**. Every
// applied change is compared cell by cell against what the preview promised,
// because a preview that disagrees with the outcome is worse than no preview —
// it is a reason to trust a number that turns out to be wrong.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-rates-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run, get, all } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const rp = await import('../src/services/rateplanning.ts');

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

const ACTOR = { userId: 'usr_test', userName: 'Revenue Manager', propertyId: '' };
const BASE = 10_000;   // $100

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en','2026-06-01','14:00','11:00',1,?)`,
    propertyId, 'RTE', 'Rate Test Hotel', nowIso(),
  );
  const roomTypes: string[] = [];
  for (const [code, name, rate] of [['STD', 'Standard', BASE], ['DLX', 'Deluxe', BASE * 2]] as const) {
    const rtId = id('rt');
    run(
      `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                              max_adults, max_children, default_rate_minor, extra_adult_minor,
                              extra_child_minor, sort_order, active, created_at)
       VALUES(?,?,?,?,'room',2,2,2,0,?,0,0,1,1,?)`,
      rtId, propertyId, code, name, rate, nowIso(),
    );
    roomTypes.push(rtId);
  }
  const barId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, active, created_at)
     VALUES(?,?,'BAR','Best Available',1,?)`,
    barId, propertyId, nowIso(),
  );
  // A derived plan, to prove it is left out of a change unless named.
  const nrefId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, parent_id, offset_type, offset_value,
                            active, created_at)
     VALUES(?,?,'NREF','Non-refundable',?,'percent',-1000,1,?)`,
    nrefId, propertyId, barId, nowIso(),
  );
  return { propertyId, roomTypes, barId, nrefId };
}

function priceOf(propertyId: string, rtId: string, rpId: string, date: string): number | null {
  return get<{ price_minor: number }>(
    `SELECT price_minor FROM rate_calendar
      WHERE property_id = ? AND room_type_id = ? AND rate_plan_id = ? AND date = ?`,
    propertyId, rtId, rpId, date,
  )?.price_minor ?? null;
}

async function main() {
  process.stdout.write(`\nPrice planning checks\n${'─'.repeat(21)}\nWorking in ${workdir}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;
  const [STD, DLX] = ctx.roomTypes;
  const P = ctx.propertyId;

  section('1 · A preview shows what will happen');
  const plan = rp.planChange(P, {
    from: '2026-07-01', to: '2026-07-07', ratePlanIds: [ctx.barId], priceMinor: 15_000,
  });
  check('every cell is planned', plan.cellCount === 7 * 2, plan.cellCount);
  check('the date count is reported', plan.dates === 7, plan.dates);
  check('both room types are included', plan.roomTypes === 2, plan.roomTypes);
  check('the "from" price is the effective one, not blank',
    plan.cells.every((c) => c.fromMinor > 0), plan.cells.slice(0, 2));
  check('cells with no stored price are marked inherited',
    plan.cells.every((c) => c.inherited), plan.cells[0]);
  check('the standard room moves from its base rate',
    plan.cells.find((c) => c.roomTypeId === STD)?.fromMinor === BASE);
  check('the deluxe moves from its own base rate',
    plan.cells.find((c) => c.roomTypeId === DLX)?.fromMinor === BASE * 2);
  check('everything lands on the new price',
    plan.cells.every((c) => c.toMinor === 15_000));
  check('the biggest movers are listed', plan.biggestMovers.length > 0);
  check('the largest move is first',
    Math.abs(plan.biggestMovers[0].toMinor - plan.biggestMovers[0].fromMinor)
      >= Math.abs(plan.biggestMovers[1].toMinor - plan.biggestMovers[1].fromMinor));
  check('previewing wrote nothing',
    all<any>('SELECT * FROM rate_calendar').length === 0);

  section('2 · The preview does not lie');
  const applied = rp.applyChange(P, ACTOR, {
    from: '2026-07-01', to: '2026-07-07', ratePlanIds: [ctx.barId], priceMinor: 15_000,
  });
  check('the promised number of cells was written',
    applied.written === plan.cellCount, { written: applied.written, promised: plan.cellCount });
  let mismatches = 0;
  for (const cell of plan.cells) {
    if (priceOf(P, cell.roomTypeId, cell.ratePlanId, cell.date) !== cell.toMinor) mismatches++;
  }
  check('every cell holds exactly the price the preview promised', mismatches === 0, mismatches);

  section('3 · Percentage and amount adjustments');
  const up = rp.planChange(P, {
    from: '2026-07-01', to: '2026-07-03', ratePlanIds: [ctx.barId],
    roomTypeIds: [STD], adjustPercentBp: 1_000,      // +10%
  });
  check('a percentage works off the current price',
    up.cells.every((c) => c.fromMinor === 15_000 && c.toMinor === 16_500), up.cells[0]);
  rp.applyChange(P, ACTOR, {
    from: '2026-07-01', to: '2026-07-03', ratePlanIds: [ctx.barId],
    roomTypeIds: [STD], adjustPercentBp: 1_000,
  });
  check('and the write matches', priceOf(P, STD, ctx.barId, '2026-07-02') === 16_500);

  const down = rp.planChange(P, {
    from: '2026-07-01', to: '2026-07-01', ratePlanIds: [ctx.barId],
    roomTypeIds: [STD], adjustMinor: -2_000,
  });
  check('an amount adjustment can be negative',
    down.cells[0].toMinor === 14_500, down.cells[0]);

  const floored = rp.planChange(P, {
    from: '2026-07-01', to: '2026-07-01', ratePlanIds: [ctx.barId],
    roomTypeIds: [STD], adjustPercentBp: -9_000, floorMinor: 12_000,
  });
  check('a floor stops a discount going too far',
    floored.cells[0].toMinor === 12_000, floored.cells[0]);
  const capped = rp.planChange(P, {
    from: '2026-07-01', to: '2026-07-01', ratePlanIds: [ctx.barId],
    roomTypeIds: [STD], adjustPercentBp: 50_000, ceilingMinor: 20_000,
  });
  check('a ceiling stops a rise going too far',
    capped.cells[0].toMinor === 20_000, capped.cells[0]);

  section('4 · Day-of-week filtering');
  // 2026-07-04 is a Saturday.
  const weekend = rp.planChange(P, {
    from: '2026-07-01', to: '2026-07-14', ratePlanIds: [ctx.barId], roomTypeIds: [STD],
    daysOfWeek: ['sat', 'sun'], priceMinor: 25_000,
  });
  check('only the chosen days are planned', weekend.dates === 4, weekend.dates);
  check('every planned date really is a weekend',
    weekend.cells.every((c) => [0, 6].includes(new Date(`${c.date}T00:00:00Z`).getUTCDay())),
    weekend.cells.map((c) => c.date));
  rp.applyChange(P, ACTOR, {
    from: '2026-07-01', to: '2026-07-14', ratePlanIds: [ctx.barId], roomTypeIds: [STD],
    daysOfWeek: ['sat', 'sun'], priceMinor: 25_000,
  });
  check('the Saturday moved', priceOf(P, STD, ctx.barId, '2026-07-04') === 25_000);
  check('the Friday did not', priceOf(P, STD, ctx.barId, '2026-07-03') !== 25_000);

  section('5 · Guardrails');
  let noMethod = false;
  try { rp.planChange(P, { from: '2026-07-01', to: '2026-07-02' } as any); }
  catch { noMethod = true; }
  check('a change with no price or adjustment is refused', noMethod);

  let twoMethods = false;
  try {
    rp.planChange(P, { from: '2026-07-01', to: '2026-07-02', priceMinor: 100, adjustPercentBp: 500 });
  } catch { twoMethods = true; }
  check('giving both a price and a percentage is refused', twoMethods);

  let backwards = false;
  try { rp.planChange(P, { from: '2026-07-10', to: '2026-07-01', priceMinor: 100 }); }
  catch { backwards = true; }
  check('a backwards range is refused', backwards);

  const derivedPlan = rp.planChange(P, {
    from: '2026-08-01', to: '2026-08-02', priceMinor: 12_000,
  });
  check('derived plans are excluded unless named',
    derivedPlan.cells.every((c) => c.ratePlanId !== ctx.nrefId), derivedPlan.ratePlans);
  const namedDerived = rp.planChange(P, {
    from: '2026-08-01', to: '2026-08-02', ratePlanIds: [ctx.nrefId], priceMinor: 12_000,
  });
  check('naming a derived plan warns that it will be recalculated',
    namedDerived.warnings.some((w) => /derived plan/i.test(w)), namedDerived.warnings);

  const doubling = rp.planChange(P, {
    from: '2026-09-01', to: '2026-09-02', ratePlanIds: [ctx.barId], adjustPercentBp: 20_000,
  });
  check('a change that more than doubles prices is flagged',
    doubling.warnings.some((w) => /double/i.test(w)), doubling.warnings);

  section('6 · Nothing is written when nothing moves');
  const before = all<any>('SELECT count(*) AS n FROM rate_history')[0].n;
  const noop = rp.applyChange(P, ACTOR, {
    from: '2026-07-04', to: '2026-07-04', ratePlanIds: [ctx.barId], roomTypeIds: [STD],
    priceMinor: 25_000,     // already 25,000
  });
  check('re-applying the same price writes nothing', noop.written === 0, noop);
  check('and adds no history', all<any>('SELECT count(*) AS n FROM rate_history')[0].n === before);

  section('7 · Copying a period');
  rp.applyChange(P, ACTOR, {
    from: '2026-12-01', to: '2026-12-07', ratePlanIds: [ctx.barId], roomTypeIds: [STD],
    priceMinor: 30_000, reason: 'Festive',
  });
  const copyPlan = rp.planCopy(P, {
    sourceFrom: '2026-12-01', sourceTo: '2026-12-07',
    targetFrom: '2027-12-01', ratePlanIds: [ctx.barId], roomTypeIds: [STD],
    multiplierBp: 11_000,     // +10%
  });
  check('the copy plans one cell per source day', copyPlan.cellCount === 7, copyPlan.cellCount);
  check('the multiplier is applied',
    copyPlan.cells.every((c) => c.toMinor === 33_000), copyPlan.cells[0]);
  check('a day-of-week drift is warned about',
    copyPlan.warnings.some((w) => /days of the week/i.test(w)), copyPlan.warnings);

  rp.applyCopy(P, ACTOR, {
    sourceFrom: '2026-12-01', sourceTo: '2026-12-07',
    targetFrom: '2027-12-01', ratePlanIds: [ctx.barId], roomTypeIds: [STD],
    multiplierBp: 11_000,
  });
  check('the copied prices landed', priceOf(P, STD, ctx.barId, '2027-12-04') === 33_000);
  check('the source is untouched', priceOf(P, STD, ctx.barId, '2026-12-04') === 30_000);

  const overlapping = rp.planCopy(P, {
    sourceFrom: '2026-12-01', sourceTo: '2026-12-07', targetFrom: '2026-12-05',
    ratePlanIds: [ctx.barId], roomTypeIds: [STD],
  });
  check('copying onto an overlapping period is warned about',
    overlapping.warnings.some((w) => /overlap/i.test(w)), overlapping.warnings);

  section('8 · Seasons');
  const high = rp.upsertSeason(P, ACTOR, {
    name: 'High', from: '2026-12-15', to: '2027-01-10', priority: 10, colour: '#ef4444',
  });
  rp.upsertSeason(P, ACTOR, { name: 'Shoulder', from: '2026-11-01', to: '2026-12-14', priority: 5 });
  const seasons = rp.listSeasons(P);
  check('seasons are listed', seasons.length === 2, seasons.length);
  check('nights are counted inclusively',
    seasons.find((s) => s.name === 'High')?.nights === 27,
    seasons.find((s) => s.name === 'High')?.nights);
  check('a date resolves to its season',
    rp.seasonFor(P, '2026-12-20')?.name === 'High', rp.seasonFor(P, '2026-12-20')?.name);
  check('a date outside every season resolves to nothing',
    rp.seasonFor(P, '2026-06-15') === undefined);

  rp.upsertSeason(P, ACTOR, { name: 'Christmas', from: '2026-12-24', to: '2026-12-26', priority: 20 });
  check('where seasons overlap the higher priority wins',
    rp.seasonFor(P, '2026-12-25')?.name === 'Christmas', rp.seasonFor(P, '2026-12-25')?.name);

  rp.upsertSeason(P, ACTOR, { id: high.id, name: 'Peak', from: '2026-12-15', to: '2027-01-10' });
  check('a season can be renamed',
    rp.listSeasons(P).some((s) => s.name === 'Peak'), rp.listSeasons(P).map((s) => s.name));

  let badSeason = false;
  try { rp.upsertSeason(P, ACTOR, { name: 'Bad', from: '2026-05-10', to: '2026-05-01' }); }
  catch { badSeason = true; }
  check('a season that ends before it starts is refused', badSeason);

  // Three exist by now — Peak (renamed from High), Shoulder and Christmas.
  rp.deleteSeason(P, ACTOR, high.id);
  check('a season can be deleted', rp.listSeasons(P).length === 2, rp.listSeasons(P).length);
  check('the right one went',
    !rp.listSeasons(P).some((s) => s.id === high.id), rp.listSeasons(P).map((s) => s.name));

  section('9 · Scheduled changes');
  const sched = rp.scheduleChange(P, ACTOR, {
    name: 'New year uplift', effectiveDate: '2026-06-10',
    change: {
      from: '2027-01-01', to: '2027-01-05', ratePlanIds: [ctx.barId], roomTypeIds: [STD],
      priceMinor: 40_000, reason: 'Planned uplift',
    },
  });
  check('a change can be scheduled', !!sched.id);
  check('it reports how many cells it will change', sched.willChange === 5, sched.willChange);

  const list = rp.listScheduledChanges(P, '2026-06-01');
  check('it appears in the queue', list.length === 1, list.length);
  check('it is not due yet', list[0].due === false, list[0]);
  check('the queue shows what it will do',
    list[0].change.from === '2027-01-01' && list[0].change.priceMinor === 40_000, list[0].change);

  const notYet = rp.runDueScheduledChanges(P, ACTOR, '2026-06-01');
  check('nothing runs before its date', notYet.due === 0, notYet);
  check('and the prices are untouched', priceOf(P, STD, ctx.barId, '2027-01-03') === null);

  const ran = rp.runDueScheduledChanges(P, ACTOR, '2026-06-10');
  check('it runs on its effective date', ran.applied === 1, ran);
  check('the prices moved', priceOf(P, STD, ctx.barId, '2027-01-03') === 40_000);
  check('the row is marked applied',
    rp.listScheduledChanges(P, '2026-06-10')[0].status === 'applied');
  check('with the cell count recorded',
    rp.listScheduledChanges(P, '2026-06-10')[0].cellsChanged === 5);

  const again = rp.runDueScheduledChanges(P, ACTOR, '2026-06-11');
  check('an applied change does not run twice', again.due === 0, again);

  const toCancel = rp.scheduleChange(P, ACTOR, {
    name: 'Cancel me', effectiveDate: '2026-07-01',
    change: { from: '2027-02-01', to: '2027-02-02', ratePlanIds: [ctx.barId], priceMinor: 99_000 },
  });
  rp.cancelScheduledChange(P, ACTOR, toCancel.id);
  const cancelled = rp.listScheduledChanges(P, '2026-07-01').find((s) => s.id === toCancel.id);
  check('a scheduled change can be cancelled', cancelled?.status === 'cancelled', cancelled?.status);
  const afterCancel = rp.runDueScheduledChanges(P, ACTOR, '2026-07-02');
  check('a cancelled change never fires', afterCancel.due === 0, afterCancel);
  check('and its prices were never written', priceOf(P, STD, ctx.barId, '2027-02-01') === null);

  let doubleCancel = false;
  try { rp.cancelScheduledChange(P, ACTOR, toCancel.id); } catch { doubleCancel = true; }
  check('cancelling twice is refused', doubleCancel);

  // A change that cannot be applied when it falls due must fail loudly and
  // leave the reason behind — not disappear, and not retry forever.
  const orphan = rp.scheduleChange(P, ACTOR, {
    name: 'Orphaned', effectiveDate: '2026-08-01',
    change: { from: '2027-03-01', to: '2027-03-02', ratePlanIds: [ctx.barId], priceMinor: 20_000 },
  });
  run(`UPDATE scheduled_rate_changes SET payload = 'not json' WHERE id = ?`, orphan.id);
  const failedRun = rp.runDueScheduledChanges(P, ACTOR, '2026-08-01');
  check('a broken scheduled change is recorded as failed',
    failedRun.results.some((r) => r.id === orphan.id && !r.ok), failedRun.results);
  check('with the reason kept',
    !!rp.listScheduledChanges(P, '2026-08-01').find((s) => s.id === orphan.id)?.error);

  section('10 · History');
  const history = rp.rateHistory(P, { roomTypeId: STD, date: '2026-07-02' });
  check('a cell has a history', history.length >= 2, history.length);
  check('the newest entry is first',
    history[0].changedAt >= history[history.length - 1].changedAt);
  check('it records what the price moved from',
    history.some((h) => h.fromMinor === 15_000 && h.toMinor === 16_500), history.slice(0, 3));
  check('an inherited first write has no "from"',
    history.some((h) => h.fromMinor === null), history.slice(-2));
  check('the person is recorded',
    history.every((h) => h.changedBy === 'Revenue Manager'), history[0]?.changedBy);
  check('the source is recorded',
    history.some((h) => h.source === 'bulk'), history.map((h) => h.source));
  check('a copy is labelled as one',
    rp.rateHistory(P, { from: '2027-12-01', to: '2027-12-07' }).some((h) => h.source === 'copy'));
  check('a scheduled change is labelled as one',
    rp.rateHistory(P, { from: '2027-01-01', to: '2027-01-05' }).some((h) => h.source === 'scheduled'));
  check('the reason travels into the history',
    rp.rateHistory(P, { from: '2026-12-01', to: '2026-12-07' }).some((h) => h.reason === 'Festive'));

  section('11 · Channel pushes');
  const pushes = all<any>(`SELECT DISTINCT reason FROM channel_queue WHERE property_id = ?`, P);
  // No channel is connected in this fixture, so the queue is empty by design —
  // the point is that applying never throws when there is nothing to tell.
  check('applying without a connected channel is safe', Array.isArray(pushes));

  run(
    `INSERT INTO channels(id, property_id, code, name, kind, active, status, created_at)
     VALUES(?,?,'BDC','Booking.com','ota',1,'connected',?)`,
    id('chn'), P, nowIso(),
  );
  rp.applyChange(P, ACTOR, {
    from: '2026-10-01', to: '2026-10-03', roomTypeIds: [DLX], priceMinor: 21_000,
  });
  const queued = all<any>(
    `SELECT * FROM channel_queue WHERE property_id = ? AND reason = 'rate.bulk'`, P);
  check('a rate change queues a channel push', queued.length === 1, queued.length);
  check('the pushed window covers the changed dates',
    queued[0]?.date_from === '2026-10-01' && queued[0]?.date_to === addDays('2026-10-03', 1),
    `${queued[0]?.date_from}→${queued[0]?.date_to}`);
  check('only the affected room type is pushed',
    queued[0]?.room_type_id === DLX, queued[0]?.room_type_id);

  process.stdout.write(`\n${checks - failures}/${checks} price planning checks passed\n`);
  if (failures) process.exit(1);
  process.stdout.write('Previews match reality, and changes can be planned, scheduled and traced.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
