// ─────────────────────────────────────────────────────────────
// Exercises tax calculation and, more importantly, whether the folio agrees
// with the quote.
//
//   node --experimental-sqlite scripts/tax-check.ts
//
// An audit found a flat fee quoted once and charged once *per night* — a 5.00
// booking fee billed as 20.00 on a four-night stay, with the folio permanently
// disagreeing with the confirmation the guest signed. That is a dispute and a
// compliance problem, not a rounding nit.
//
// The load-bearing assertion here is therefore not "the tax maths is right" but
// **"the folio total equals the quoted total"**. Those are computed by different
// code down different paths, which is exactly how they drifted apart.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-tax-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run, get, all } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const pricing = await import('../src/services/pricing.ts');
const reservations = await import('../src/services/reservations.ts');
const nightaudit = await import('../src/services/nightaudit.ts');
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
const TODAY = '2026-06-01';
const RATE = 10_000;      // $100 a night

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'TAX', 'Tax Test Hotel', TODAY, nowIso(),
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
  for (const n of ['101', '102']) {
    run(
      `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
       VALUES(?,?,?,?,1,'Vacant Clean',1,?)`,
      id('rm'), propertyId, roomTypeId, n, nowIso(),
    );
  }
  run(
    `INSERT INTO transaction_codes(id, property_id, code, name, category, taxable, active)
     VALUES(?,?,'ROOM','Room charge','room',1,1)`,
    id('txc'), propertyId,
  );
  return { propertyId, roomTypeId, ratePlanId };
}

function addTax(propertyId: string, o: {
  code: string; name: string; mode: string; value: number;
  sortOrder?: number; compoundOn?: string | null; inclusive?: boolean;
}) {
  run(
    `INSERT INTO taxes(id, property_id, code, name, mode, value, applies_to, inclusive,
                       compound_on, sort_order, active, created_at)
     VALUES(?,?,?,?,?,?,'room',?,?,?,1,?)`,
    id('tax'), propertyId, o.code, o.name, o.mode, o.value,
    o.inclusive ? 1 : 0, o.compoundOn ?? null, o.sortOrder ?? 0, nowIso(),
  );
}

/** Wind the property back to a clean opening day, audits and all. */
function resetStays(propertyId: string) {
  run('DELETE FROM folio_lines WHERE property_id = ?', propertyId);
  run('DELETE FROM folios WHERE property_id = ?', propertyId);
  run('DELETE FROM reservation_nights WHERE property_id = ?', propertyId);
  run('DELETE FROM reservations WHERE property_id = ?', propertyId);
  // The audit refuses to run a day twice, so its history has to go back too.
  run('DELETE FROM audit_runs WHERE property_id = ?', propertyId);
  run('DELETE FROM daily_stats WHERE property_id = ?', propertyId);
  run('UPDATE properties SET business_date = ? WHERE id = ?', TODAY, propertyId);
}

function clearTaxes(propertyId: string) {
  run('DELETE FROM taxes WHERE property_id = ?', propertyId);
}

/**
 * Book, check in, then run the night audit forward so every night posts.
 *
 * The check-in is not incidental. Without it the guest is a no-show after the
 * first audit and nothing further posts — which made an earlier version of this
 * file report "exactly one fee line" as a pass when in truth only one night had
 * been billed at all. A test that passes for the wrong reason is worse than one
 * that fails.
 */
function stayAndPost(ctx: any, nights: number) {
  const res = reservations.createReservation(ctx.propertyId, ACTOR, {
    guestName: 'Tax Test Guest', arrival: TODAY, departure: addDays(TODAY, nights),
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId,
    adults: 2, children: 0, force: true,
  } as any);
  const room = get<{ id: string }>(
    'SELECT id FROM rooms WHERE property_id = ? LIMIT 1', ctx.propertyId)!;
  reservations.assignRoom(ctx.propertyId, ACTOR, res.id, { roomId: room.id });
  reservations.checkIn(ctx.propertyId, ACTOR, res.id, { roomId: room.id } as any);
  for (let i = 0; i < nights; i++) {
    nightaudit.runNightAudit(ctx.propertyId, ACTOR, { force: true } as any);
  }
  return res;
}

function folioTaxTotal(reservationId: string): number {
  return all<{ amount_minor: number }>(
    `SELECT amount_minor FROM folio_lines
      WHERE reservation_id = ? AND kind = 'tax' AND voided = 0`,
    reservationId,
  ).reduce((sum, l) => sum + l.amount_minor, 0);
}

function taxLinesFor(reservationId: string, code: string) {
  return all<any>(
    `SELECT * FROM folio_lines WHERE reservation_id = ? AND kind = 'tax' AND code = ? AND voided = 0`,
    reservationId, code,
  );
}

async function main() {
  process.stdout.write(`\nTax checks\n${'─'.repeat(10)}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;
  const P = ctx.propertyId;

  section('1 · A flat fee is charged once, not once a night');
  clearTaxes(P);
  addTax(P, { code: 'BOOKFEE', name: 'Booking fee', mode: 'flat', value: 500, sortOrder: 1 });

  const quote = pricing.quoteStay(P, {
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId,
    arrival: TODAY, departure: addDays(TODAY, 4), adults: 2, children: 0,
  });
  const quotedFee = quote.taxes.find((t: any) => t.code === 'BOOKFEE');
  check('the quote charges the fee once', quotedFee?.amountMinor === 500, quote.taxes);

  const stay = stayAndPost(ctx, 4);
  const feeLines = taxLinesFor(stay.id, 'BOOKFEE');
  // This is the defect: four nights previously meant four fees.
  check('the folio has exactly one fee line', feeLines.length === 1,
    feeLines.map((l: any) => l.amount_minor));
  check('and it is the quoted amount', feeLines[0]?.amount_minor === 500,
    feeLines[0]?.amount_minor);
  check('so the guest is charged 5.00, not 20.00', folioTaxTotal(stay.id) === 500,
    folioTaxTotal(stay.id));

  section('2 · Per-night taxes still accumulate correctly');
  clearTaxes(P);
  resetStays(P);
  addTax(P, { code: 'CITY', name: 'City tax', mode: 'per_night', value: 200, sortOrder: 1 });

  const cityStay = stayAndPost(ctx, 3);
  check('a per-night tax posts once per night',
    taxLinesFor(cityStay.id, 'CITY').length === 3, taxLinesFor(cityStay.id, 'CITY').length);
  check('and totals the nights', folioTaxTotal(cityStay.id) === 600, folioTaxTotal(cityStay.id));

  section('3 · The folio agrees with the quote');
  // The assertion that matters: two different code paths, one answer.
  clearTaxes(P);
  resetStays(P);
  addTax(P, { code: 'BOOKFEE', name: 'Booking fee', mode: 'flat', value: 500, sortOrder: 1 });
  addTax(P, { code: 'CITY', name: 'City tax', mode: 'per_night', value: 200, sortOrder: 2 });
  addTax(P, { code: 'VAT', name: 'VAT', mode: 'percent', value: 1500, sortOrder: 3 });

  const mixedQuote = pricing.quoteStay(P, {
    roomTypeId: ctx.roomTypeId, ratePlanId: ctx.ratePlanId,
    arrival: TODAY, departure: addDays(TODAY, 4), adults: 2, children: 0,
  });
  const mixedStay = stayAndPost(ctx, 4);
  const quotedTax = mixedQuote.taxes.reduce((s: number, t: any) => s + t.amountMinor, 0);
  const postedTax = folioTaxTotal(mixedStay.id);

  check('the flat fee appears once across a mixed set',
    taxLinesFor(mixedStay.id, 'BOOKFEE').length === 1);
  check('the per-night tax appears every night',
    taxLinesFor(mixedStay.id, 'CITY').length === 4);
  check('the folio tax total matches the quoted tax total',
    postedTax === quotedTax, { quoted: quotedTax, posted: postedTax });

  section('4 · Extending a stay does not re-add the fee');
  // A caller-side "first night only" flag gets this wrong; an existing-line
  // check gets it right.
  const before = taxLinesFor(mixedStay.id, 'BOOKFEE').length;
  folio.postCharge(P, ACTOR, {
    folioId: folio.foliosForReservation(mixedStay.id)[0].id,
    code: 'ROOM', description: 'Extra night', unitMinor: RATE,
    businessDate: get<any>('SELECT business_date FROM properties WHERE id = ?', P)!.business_date,
    reservationId: mixedStay.id, applyTax: true, nights: 1, persons: 2,
  } as any);
  check('a later posting adds no second fee',
    taxLinesFor(mixedStay.id, 'BOOKFEE').length === before,
    taxLinesFor(mixedStay.id, 'BOOKFEE').length);
  check('but it does add another night of city tax',
    taxLinesFor(mixedStay.id, 'CITY').length === 5,
    taxLinesFor(mixedStay.id, 'CITY').length);

  section('5 · Compounding — the default is unchanged');
  clearTaxes(P);
  addTax(P, { code: 'SVC', name: 'Service charge', mode: 'percent', value: 1000, sortOrder: 1 });
  addTax(P, { code: 'VAT', name: 'VAT', mode: 'percent', value: 1500, sortOrder: 2 });

  // 10,000 → service 1,000 → VAT on 11,000 = 1,650. This is what every existing
  // property is already configured around and must not change.
  const compounded = pricing.computeTaxes(P, 10_000, { nights: 1, persons: 2 });
  check('a service charge takes the room net',
    compounded.find((t) => t.code === 'SVC')?.amountMinor === 1_000, compounded);
  check('and VAT compounds on top of it, as before',
    compounded.find((t) => t.code === 'VAT')?.amountMinor === 1_650, compounded);

  section('6 · Compounding — an explicit base is honoured');
  clearTaxes(P);
  addTax(P, { code: 'SVC', name: 'Service charge', mode: 'percent', value: 1000, sortOrder: 1 });
  // Two independent taxes that should each apply to the room net. Before this,
  // the second wrongly stacked on the first whatever the jurisdiction said.
  addTax(P, { code: 'VAT', name: 'VAT', mode: 'percent', value: 1500, sortOrder: 2, compoundOn: '' });
  addTax(P, { code: 'ECO', name: 'Eco levy', mode: 'percent', value: 500, sortOrder: 3, compoundOn: '' });

  const independent = pricing.computeTaxes(P, 10_000, { nights: 1, persons: 2 });
  check('an empty compound_on still means "everything before"',
    independent.find((t) => t.code === 'VAT')?.amountMinor === 1_650, independent);

  clearTaxes(P);
  addTax(P, { code: 'SVC', name: 'Service charge', mode: 'percent', value: 1000, sortOrder: 1 });
  addTax(P, { code: 'VAT', name: 'VAT', mode: 'percent', value: 1500, sortOrder: 2, compoundOn: 'SVC' });
  addTax(P, { code: 'ECO', name: 'Eco levy', mode: 'percent', value: 500, sortOrder: 3, compoundOn: 'NONE' });

  const explicit = pricing.computeTaxes(P, 10_000, { nights: 1, persons: 2 });
  check('a tax that names its base compounds on exactly that',
    explicit.find((t) => t.code === 'VAT')?.amountMinor === 1_650, explicit);
  check('a tax naming an unknown code falls back to the room net alone',
    explicit.find((t) => t.code === 'ECO')?.amountMinor === 500, explicit);

  section('7 · The mode travels with the line');
  clearTaxes(P);
  addTax(P, { code: 'BOOKFEE', name: 'Booking fee', mode: 'flat', value: 500, sortOrder: 1 });
  addTax(P, { code: 'VAT', name: 'VAT', mode: 'percent', value: 1500, sortOrder: 2 });
  const modes = pricing.computeTaxes(P, 10_000, { nights: 2, persons: 2 });
  check('a flat tax says it is flat',
    modes.find((t) => t.code === 'BOOKFEE')?.mode === 'flat', modes);
  check('a percentage says it is a percentage',
    modes.find((t) => t.code === 'VAT')?.mode === 'percent', modes);

  section('8 · Inclusive taxes are still excluded from the bill');
  clearTaxes(P);
  addTax(P, { code: 'INC', name: 'Included VAT', mode: 'percent', value: 1500, sortOrder: 1, inclusive: true });
  addTax(P, { code: 'CITY', name: 'City tax', mode: 'per_night', value: 200, sortOrder: 2 });
  const withInclusive = pricing.computeTaxes(P, 10_000, { nights: 1, persons: 1 });
  check('an inclusive tax adds no line',
    !withInclusive.find((t) => t.code === 'INC'), withInclusive);
  check('and does not inflate what follows',
    withInclusive.find((t) => t.code === 'CITY')?.amountMinor === 200, withInclusive);

  process.stdout.write(`\n${checks - failures}/${checks} tax checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('The folio charges what the guest was quoted.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
