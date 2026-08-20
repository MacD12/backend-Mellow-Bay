// ─────────────────────────────────────────────────────────────
// Pricing engine.
//
// A nightly rate is resolved in this order:
//   1. rate_calendar cell for (room type, rate plan, date)
//   2. …otherwise the parent rate plan's resolved rate ± the derived offset
//   3. …otherwise the rate plan's base rate for that room type
//   4. …otherwise the room type's default rate
// then adjusted for occupancy, length of stay, active yield rules, an applied
// promotion, and finally the channel's price multiplier.
// ─────────────────────────────────────────────────────────────
import { all, get, parseJson } from '../db.ts';
import { applyBp, scaleBp, dateRange, dowName, nightsBetween, HttpError } from '../lib/util.ts';
import { availabilityGrid } from './availability.ts';

export interface RatePlanRow {
  id: string; property_id: string; code: string; name: string;
  parent_id: string | null; offset_type: string | null; offset_value: number;
  refundable: number; flexible: number; kind: string;
  min_los: number | null; max_los: number | null;
  min_advance: number | null; max_advance: number | null;
  inclusions: string | null; active: number; deposit_pct_bp: number;
  valid_from: string | null; valid_to: string | null; company_id: string | null;
}

export interface RoomTypeRow {
  id: string; code: string; name: string; kind: string;
  base_occupancy: number; max_occupancy: number; max_adults: number; max_children: number;
  default_rate_minor: number; extra_adult_minor: number; extra_child_minor: number;
}

export interface NightQuote {
  date: string;
  baseMinor: number;        // resolved rate plan price before adjustments
  occupancyMinor: number;   // extra adult / child supplements
  yieldMinor: number;       // yield rule adjustment (+/−)
  promoMinor: number;       // promotion discount (negative)
  channelMinor: number;     // channel multiplier delta
  rateMinor: number;        // what the guest pays for the night
  appliedRules: string[];
}

export interface StayQuote {
  roomTypeId: string;
  ratePlanId: string;
  arrival: string;
  departure: string;
  nights: NightQuote[];
  roomTotalMinor: number;
  taxes: { code: string; name: string; amountMinor: number }[];
  taxTotalMinor: number;
  grandTotalMinor: number;
  currency: string;
  promotionId?: string;
  promotionCode?: string;
}

// ─── Rate resolution ─────────────────────────────────────────

function calendarCell(propertyId: string, roomTypeId: string, ratePlanId: string, date: string) {
  return get<any>(
    `SELECT * FROM rate_calendar
      WHERE property_id = ? AND room_type_id = ? AND rate_plan_id = ? AND date = ?`,
    propertyId, roomTypeId, ratePlanId, date,
  );
}

function planBaseRate(ratePlanId: string, roomTypeId: string): number | null {
  const row = get<{ base_rate_minor: number }>(
    'SELECT base_rate_minor FROM rate_plan_room_types WHERE rate_plan_id = ? AND room_type_id = ?',
    ratePlanId, roomTypeId,
  );
  return row ? row.base_rate_minor : null;
}

/**
 * Resolve the pre-occupancy nightly price for a rate plan.
 * `seen` guards against a cycle in the derived-rate graph.
 */
export function resolveNightlyBase(
  propertyId: string,
  roomType: RoomTypeRow,
  ratePlan: RatePlanRow,
  date: string,
  nights: number,
  seen: Set<string> = new Set(),
): { minor: number; source: string } {
  if (seen.has(ratePlan.id)) {
    throw new HttpError(500, `Rate plan ${ratePlan.code} has a circular parent reference`);
  }
  seen.add(ratePlan.id);

  const cell = calendarCell(propertyId, roomType.id, ratePlan.id, date);
  if (cell) {
    let price = cell.price_minor as number;
    // Length-of-stay pricing: the highest configured threshold ≤ nights wins.
    const los = parseJson<Record<string, number>>(cell.los_prices, {});
    let bestLos = 0;
    for (const k of Object.keys(los)) {
      const n = Number(k);
      if (Number.isFinite(n) && n <= nights && n > bestLos) bestLos = n;
    }
    if (bestLos > 0) price = los[String(bestLos)];
    return { minor: price, source: 'calendar' };
  }

  if (ratePlan.parent_id) {
    const parent = get<RatePlanRow>('SELECT * FROM rate_plans WHERE id = ?', ratePlan.parent_id);
    if (parent) {
      const base = resolveNightlyBase(propertyId, roomType, parent, date, nights, seen);
      let derived = base.minor;
      if (ratePlan.offset_type === 'percent') derived = base.minor + applyBp(base.minor, ratePlan.offset_value);
      else if (ratePlan.offset_type === 'fixed') derived = base.minor + ratePlan.offset_value;
      return { minor: Math.max(0, derived), source: `derived:${parent.code}` };
    }
  }

  const planBase = planBaseRate(ratePlan.id, roomType.id);
  if (planBase !== null && planBase > 0) return { minor: planBase, source: 'plan-base' };
  return { minor: roomType.default_rate_minor, source: 'room-type-default' };
}

// ─── Occupancy supplements ───────────────────────────────────
function occupancySupplement(
  propertyId: string,
  roomType: RoomTypeRow,
  ratePlanId: string,
  date: string,
  adults: number,
  children: number,
): { minor: number; note: string | null } {
  const cell = calendarCell(propertyId, roomType.id, ratePlanId, date);

  // Explicit per-occupancy pricing replaces the base entirely; handled by
  // the caller through `occupancyOverride`. Here we only add supplements.
  const extraAdultRate = cell?.extra_adult_minor ?? roomType.extra_adult_minor ?? 0;
  const extraChildRate = cell?.extra_child_minor ?? roomType.extra_child_minor ?? 0;

  const extraAdults = Math.max(0, adults - roomType.base_occupancy);
  const supplement = extraAdults * extraAdultRate + children * extraChildRate;
  const notes: string[] = [];
  if (extraAdults > 0 && extraAdultRate > 0) notes.push(`+${extraAdults} adult`);
  if (children > 0 && extraChildRate > 0) notes.push(`+${children} child`);
  return { minor: supplement, note: notes.length ? notes.join(', ') : null };
}

function occupancyOverride(
  propertyId: string, roomTypeId: string, ratePlanId: string, date: string, adults: number,
): number | null {
  const cell = calendarCell(propertyId, roomTypeId, ratePlanId, date);
  if (!cell) return null;
  const table = parseJson<Record<string, number>>(cell.occupancy_prices, {});
  const v = table[String(adults)];
  return typeof v === 'number' ? v : null;
}

// ─── Yield rules ─────────────────────────────────────────────
interface YieldRuleRow {
  id: string; name: string; active: number; metric: string; operator: string; threshold: string;
  secondary_metric: string | null; secondary_operator: string | null; secondary_threshold: string | null;
  adjust_type: string; adjust_value: number; rate_plan_id: string | null; room_type_id: string | null;
  priority: number;
}

function evalCondition(metric: string, operator: string, threshold: string, facts: {
  occupancyBp: number; leadDays: number; date: string; nights: number;
}): boolean {
  let actual: number;
  switch (metric) {
    case 'occupancy':  actual = facts.occupancyBp; break;
    case 'lead_time':  actual = facts.leadDays; break;
    case 'los':        actual = facts.nights; break;
    case 'dow': {
      const days = threshold.toLowerCase().split(',').map((s) => s.trim());
      return days.includes(dowName(facts.date));
    }
    default: return false;
  }
  const t = Number(threshold);
  if (!Number.isFinite(t)) return false;
  switch (operator) {
    case 'gt': return actual > t;
    case 'lt': return actual < t;
    case 'gte': return actual >= t;
    case 'lte': return actual <= t;
    case 'eq': return actual === t;
    default: return false;
  }
}

export function applyYieldRules(
  propertyId: string,
  roomTypeId: string,
  ratePlanId: string,
  date: string,
  baseMinor: number,
  facts: { occupancyBp: number; leadDays: number; nights: number },
): { delta: number; applied: string[]; ruleIds: string[] } {
  const rules = all<YieldRuleRow>(
    `SELECT * FROM yield_rules
      WHERE property_id = ? AND active = 1
        AND (rate_plan_id IS NULL OR rate_plan_id = ?)
        AND (room_type_id IS NULL OR room_type_id = ?)
      ORDER BY priority DESC`,
    propertyId, ratePlanId, roomTypeId,
  );
  let delta = 0;
  const applied: string[] = [];
  const ruleIds: string[] = [];
  for (const r of rules) {
    const f = { ...facts, date };
    if (!evalCondition(r.metric, r.operator, r.threshold, f)) continue;
    if (r.secondary_metric && r.secondary_operator && r.secondary_threshold !== null) {
      if (!evalCondition(r.secondary_metric, r.secondary_operator, r.secondary_threshold, f)) continue;
    }
    const d = r.adjust_type === 'percent' ? applyBp(baseMinor, r.adjust_value) : r.adjust_value;
    delta += d;
    applied.push(r.name);
    ruleIds.push(r.id);
  }
  return { delta, applied, ruleIds };
}

// ─── Promotions ──────────────────────────────────────────────
export interface PromotionRow {
  id: string; code: string; name: string; kind: string;
  discount_type: string; discount_value: number;
  stay_from: string | null; stay_to: string | null;
  book_from: string | null; book_to: string | null;
  min_los: number | null; max_los: number | null;
  min_advance: number | null; max_advance: number | null;
  rate_plan_ids: string | null; channels: string | null;
  delivery_mode: string; usage_limit: number; used_count: number; active: number;
}

export function eligiblePromotions(propertyId: string, opts: {
  ratePlanId: string; arrival: string; departure: string; channelCode?: string | null; bookedOn: string;
}): PromotionRow[] {
  const nights = nightsBetween(opts.arrival, opts.departure);
  const lead = nightsBetween(opts.bookedOn, opts.arrival);
  return all<PromotionRow>(
    'SELECT * FROM promotions WHERE property_id = ? AND active = 1',
    propertyId,
  ).filter((p) => {
    if (p.usage_limit > 0 && p.used_count >= p.usage_limit) return false;
    if (p.stay_from && opts.arrival < p.stay_from) return false;
    if (p.stay_to && opts.arrival > p.stay_to) return false;
    if (p.book_from && opts.bookedOn < p.book_from) return false;
    if (p.book_to && opts.bookedOn > p.book_to) return false;
    if (p.min_los !== null && nights < p.min_los) return false;
    if (p.max_los !== null && nights > p.max_los) return false;
    if (p.min_advance !== null && lead < p.min_advance) return false;
    if (p.max_advance !== null && lead > p.max_advance) return false;
    const plans = parseJson<string[]>(p.rate_plan_ids, []);
    if (plans.length && !plans.includes(opts.ratePlanId)) return false;
    const channels = parseJson<string[]>(p.channels, []);
    if (channels.length) {
      if (!opts.channelCode) return false;
      if (!channels.includes(opts.channelCode)) return false;
    }
    return true;
  });
}

function promoDiscount(p: PromotionRow, baseMinor: number): number {
  return p.discount_type === 'percent' ? -applyBp(baseMinor, p.discount_value) : -p.discount_value;
}

// ─── Taxes ───────────────────────────────────────────────────
export interface TaxRow {
  id: string; code: string; name: string; mode: string; value: number;
  applies_to: string; inclusive: number; sort_order: number;
  /**
   * CSV of tax codes this one compounds on. NULL means "everything before me in
   * sort order", which is the behaviour every existing property already has and
   * must keep — silently changing how tax is calculated is its own incident.
   */
  compound_on: string | null;
}

export interface TaxLine {
  code: string;
  name: string;
  amountMinor: number;
  /** Carried so callers can tell a once-per-stay fee from a per-night one. */
  mode: string;
}

export function activeTaxes(propertyId: string, appliesTo: 'room' | 'fnb' | 'all' = 'room'): TaxRow[] {
  return all<TaxRow>(
    `SELECT * FROM taxes WHERE property_id = ? AND active = 1
        AND (applies_to = 'all' OR applies_to = ?)
      ORDER BY sort_order, code`,
    propertyId, appliesTo,
  );
}

/**
 * Compute tax lines over a taxable base.
 *
 * **Compounding.** A tax may name the codes it applies on top of, in
 * `compound_on` — a service charge that is itself subject to VAT, say. When it
 * names nothing, it compounds on everything that came before it in `sort_order`,
 * which is what this function has always done and what every existing property
 * is already configured around. That default is load-bearing: changing the way
 * tax is computed underneath a live property is a billing incident, so only a
 * tax that explicitly states its base gets the explicit path.
 */
export function computeTaxes(
  propertyId: string,
  baseMinor: number,
  opts: { nights: number; persons: number; appliesTo?: 'room' | 'fnb' | 'all' },
): TaxLine[] {
  const taxes = activeTaxes(propertyId, opts.appliesTo ?? 'room');
  const lines: TaxLine[] = [];

  // What each tax charged, so a later one can compound on named codes.
  const charged = new Map<string, number>();
  let runningBase = baseMinor;

  for (const t of taxes) {
    const named = (t.compound_on ?? '')
      .split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);

    // Named: the room net plus only the taxes it says. Unnamed: the running
    // base, which is the room net plus every exclusive percentage tax so far.
    const base = named.length
      ? named.reduce((sum, code) => sum + (charged.get(code) ?? 0), baseMinor)
      : runningBase;

    let amount = 0;
    switch (t.mode) {
      case 'percent':          amount = applyBp(base, t.value); break;
      case 'per_night':        amount = t.value * opts.nights; break;
      case 'per_person_night': amount = t.value * opts.nights * Math.max(1, opts.persons); break;
      case 'flat':             amount = t.value; break;
      default: amount = 0;
    }
    if (t.inclusive === 1) continue;      // already inside the rate — not added
    if (amount === 0) continue;
    lines.push({ code: t.code, name: t.name, amountMinor: amount, mode: t.mode });
    charged.set(t.code.toUpperCase(), amount);
    if (t.mode === 'percent') runningBase += amount;
  }
  return lines;
}

// ─── Full stay quote ─────────────────────────────────────────
export function quoteStay(propertyId: string, opts: {
  roomTypeId: string;
  ratePlanId: string;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  channelCode?: string | null;
  promotionCode?: string | null;
  bookedOn?: string;
  currency?: string;
  applyYield?: boolean;
}): StayQuote {
  const roomType = get<RoomTypeRow>('SELECT * FROM room_types WHERE id = ? AND property_id = ?',
    opts.roomTypeId, propertyId);
  if (!roomType) throw new HttpError(404, 'Room type not found');
  const ratePlan = get<RatePlanRow>('SELECT * FROM rate_plans WHERE id = ? AND property_id = ?',
    opts.ratePlanId, propertyId);
  if (!ratePlan) throw new HttpError(404, 'Rate plan not found');

  const dates = dateRange(opts.arrival, opts.departure);
  if (dates.length === 0) throw new HttpError(400, 'Departure must be after arrival');
  const nights = dates.length;
  const bookedOn = opts.bookedOn ?? new Date().toISOString().slice(0, 10);

  // Channel multiplier (commission / FX uplift) — applied last.
  let channelMultiplierBp = 10_000;
  if (opts.channelCode) {
    const ch = get<{ price_multiplier_bp: number }>(
      'SELECT price_multiplier_bp FROM channels WHERE property_id = ? AND code = ?',
      propertyId, opts.channelCode,
    );
    if (ch) channelMultiplierBp = ch.price_multiplier_bp;
  }

  // Occupancy per date, for yield rules.
  const grid = availabilityGrid(propertyId, opts.arrival, opts.departure);
  const occByDate = new Map<string, number>();
  for (const d of dates) {
    const cells = grid.filter((c) => c.date === d);
    const sold = cells.reduce((s, c) => s + c.sold, 0);
    const denom = cells.reduce((s, c) => s + c.physical - c.blocked, 0);
    occByDate.set(d, denom > 0 ? Math.round((sold / denom) * 10_000) : 0);
  }

  // Promotion selection: explicit code, else the best eligible automatic one.
  let promotion: PromotionRow | undefined;
  if (opts.promotionCode) {
    promotion = get<PromotionRow>(
      'SELECT * FROM promotions WHERE property_id = ? AND code = ? AND active = 1',
      propertyId, opts.promotionCode.toUpperCase(),
    );
    if (!promotion) throw new HttpError(400, `Promotion ${opts.promotionCode} is not available`);
    const eligible = eligiblePromotions(propertyId, {
      ratePlanId: ratePlan.id, arrival: opts.arrival, departure: opts.departure,
      channelCode: opts.channelCode ?? null, bookedOn,
    });
    if (!eligible.some((p) => p.id === promotion!.id)) {
      throw new HttpError(400, `Promotion ${opts.promotionCode} does not apply to this stay`);
    }
  }

  const nightQuotes: NightQuote[] = [];
  for (const date of dates) {
    const applied: string[] = [];
    const override = occupancyOverride(propertyId, roomType.id, ratePlan.id, date, opts.adults);
    let base: number;
    if (override !== null) {
      base = override;
      applied.push(`occupancy price (${opts.adults} adults)`);
    } else {
      const resolved = resolveNightlyBase(propertyId, roomType, ratePlan, date, nights);
      base = resolved.minor;
      if (resolved.source.startsWith('derived')) applied.push(resolved.source);
    }

    let occ = 0;
    if (override === null) {
      const supp = occupancySupplement(propertyId, roomType, ratePlan.id, date, opts.adults, opts.children);
      occ = supp.minor;
      if (supp.note) applied.push(supp.note);
    }

    const preYield = base + occ;
    let yieldDelta = 0;
    if (opts.applyYield !== false) {
      const y = applyYieldRules(propertyId, roomType.id, ratePlan.id, date, preYield, {
        occupancyBp: occByDate.get(date) ?? 0,
        leadDays: nightsBetween(bookedOn, date),
        nights,
      });
      yieldDelta = y.delta;
      applied.push(...y.applied);
    }

    let promoDelta = 0;
    if (promotion) {
      promoDelta = promoDiscount(promotion, preYield + yieldDelta);
      applied.push(`promo ${promotion.code}`);
    }

    const preChannel = Math.max(0, preYield + yieldDelta + promoDelta);
    const withChannel = scaleBp(preChannel, channelMultiplierBp);
    const channelDelta = withChannel - preChannel;
    if (channelDelta !== 0) applied.push(`channel ${opts.channelCode}`);

    nightQuotes.push({
      date,
      baseMinor: base,
      occupancyMinor: occ,
      yieldMinor: yieldDelta,
      promoMinor: promoDelta,
      channelMinor: channelDelta,
      rateMinor: withChannel,
      appliedRules: applied,
    });
  }

  const roomTotal = nightQuotes.reduce((s, n) => s + n.rateMinor, 0);
  const taxes = computeTaxes(propertyId, roomTotal, {
    nights,
    persons: opts.adults + opts.children,
    appliesTo: 'room',
  });
  const taxTotal = taxes.reduce((s, t) => s + t.amountMinor, 0);

  return {
    roomTypeId: roomType.id,
    ratePlanId: ratePlan.id,
    arrival: opts.arrival,
    departure: opts.departure,
    nights: nightQuotes,
    roomTotalMinor: roomTotal,
    taxes,
    taxTotalMinor: taxTotal,
    grandTotalMinor: roomTotal + taxTotal,
    currency: opts.currency ?? 'USD',
    promotionId: promotion?.id,
    promotionCode: promotion?.code,
  };
}
