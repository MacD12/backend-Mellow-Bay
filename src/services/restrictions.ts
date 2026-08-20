// ─────────────────────────────────────────────────────────────
// Restrictions engine — min/max stay, stay-through, CTA/CTD, stop-sell,
// advance-booking windows and release deadlines.
//
// Rules are stored as dated ranges (inclusive) and may be scoped to a room
// type, a rate plan and/or a single channel. A rule with a NULL scope applies
// to everything, which is how a property-wide stop-sell is expressed.
// ─────────────────────────────────────────────────────────────
import { all, get } from '../db.ts';
import { dateRange, nightsBetween } from '../lib/util.ts';

export interface RestrictionRow {
  id: string; property_id: string;
  room_type_id: string | null; rate_plan_id: string | null; channel_code: string | null;
  date_from: string; date_to: string; type: string; value: number | null;
  note: string | null; active: number;
  /** channels | all | direct — see `matches`. Older rows have none and mean `all`. */
  applies_to?: string | null;
}

export interface RestrictionViolation {
  type: string;
  date: string;
  message: string;
  value?: number;
}

export interface StayContext {
  roomTypeId: string;
  ratePlanId: string;
  arrival: string;
  departure: string;
  channelCode?: string | null;
  bookedOn: string;
}

/**
 * Is this booking coming from a channel, or from the property itself?
 *
 * A walk-in, a phone call and anything typed at the desk carry no channel code.
 * That is the distinction `applies_to` turns on.
 */
function isDirect(ctx: StayContext): boolean {
  return !ctx.channelCode;
}

function matches(r: RestrictionRow, ctx: StayContext): boolean {
  if (r.active !== 1) return false;
  if (r.room_type_id && r.room_type_id !== ctx.roomTypeId) return false;
  if (r.rate_plan_id && r.rate_plan_id !== ctx.ratePlanId) return false;
  if (r.channel_code && r.channel_code !== (ctx.channelCode ?? null)) return false;

  // Who the rule is aimed at.
  //
  // This is the difference between "stop the OTAs selling this" and "nobody
  // sells this at all". Without it, a property closing rooms on Hostelworld
  // also stopped its own reception serving the guest standing in front of them
  // — precisely backwards, since the desk is the one seller who can see the
  // room, knows it is free, and has the guest in the building.
  //
  // `all` is the default, and is what every rule written before this meant.
  const appliesTo = r.applies_to ?? 'all';
  if (appliesTo === 'channels' && isDirect(ctx)) return false;
  if (appliesTo === 'direct' && !isDirect(ctx)) return false;

  return true;
}

function coversDate(r: RestrictionRow, date: string): boolean {
  return date >= r.date_from && date <= r.date_to;
}

export function loadRestrictions(propertyId: string, from: string, to: string): RestrictionRow[] {
  return all<RestrictionRow>(
    `SELECT * FROM restrictions
      WHERE property_id = ? AND active = 1 AND date_from <= ? AND date_to >= ?`,
    propertyId, to, from,
  );
}

/**
 * Validate a stay against every applicable restriction.
 * Returns an empty array when the stay is sellable.
 */
export function validateStay(propertyId: string, ctx: StayContext): RestrictionViolation[] {
  const nights = nightsBetween(ctx.arrival, ctx.departure);
  const stayDates = dateRange(ctx.arrival, ctx.departure);
  const lastNight = stayDates[stayDates.length - 1] ?? ctx.arrival;
  const leadDays = nightsBetween(ctx.bookedOn, ctx.arrival);
  const rules = loadRestrictions(propertyId, ctx.arrival, ctx.departure)
    .filter((r) => matches(r, ctx));
  const out: RestrictionViolation[] = [];

  for (const r of rules) {
    switch (r.type) {
      case 'stop-sell':
        for (const d of stayDates) {
          if (coversDate(r, d)) {
            out.push({ type: r.type, date: d, message: `Sales are closed on ${d}` });
          }
        }
        break;

      case 'cta':
        if (coversDate(r, ctx.arrival)) {
          out.push({ type: r.type, date: ctx.arrival, message: `${ctx.arrival} is closed to arrival` });
        }
        break;

      case 'ctd':
        if (coversDate(r, ctx.departure)) {
          out.push({ type: r.type, date: ctx.departure, message: `${ctx.departure} is closed to departure` });
        }
        break;

      case 'min-stay':
        if (coversDate(r, ctx.arrival) && r.value && nights < r.value) {
          out.push({ type: r.type, date: ctx.arrival, value: r.value,
            message: `Minimum stay on ${ctx.arrival} is ${r.value} night(s) — this stay is ${nights}` });
        }
        break;

      case 'max-stay':
        if (coversDate(r, ctx.arrival) && r.value && nights > r.value) {
          out.push({ type: r.type, date: ctx.arrival, value: r.value,
            message: `Maximum stay on ${ctx.arrival} is ${r.value} night(s) — this stay is ${nights}` });
        }
        break;

      case 'min-stay-through':
        for (const d of stayDates) {
          if (coversDate(r, d) && r.value && nights < r.value) {
            out.push({ type: r.type, date: d, value: r.value,
              message: `${d} requires a minimum stay of ${r.value} night(s) for any stay covering it` });
            break;
          }
        }
        break;

      case 'min-advance':
      case 'release':
        if (coversDate(r, ctx.arrival) && r.value !== null && leadDays < r.value) {
          out.push({ type: r.type, date: ctx.arrival, value: r.value,
            message: `Must be booked at least ${r.value} day(s) before arrival` });
        }
        break;

      case 'max-advance':
        if (coversDate(r, ctx.arrival) && r.value !== null && leadDays > r.value) {
          out.push({ type: r.type, date: ctx.arrival, value: r.value,
            message: `Cannot be booked more than ${r.value} day(s) before arrival` });
        }
        break;

      default:
        break;
    }
  }

  // Rate plan's own booking window / stay-length limits.
  const plan = get<any>('SELECT * FROM rate_plans WHERE id = ?', ctx.ratePlanId);
  if (plan) {
    if (plan.active !== 1) {
      out.push({ type: 'rate-plan', date: ctx.arrival, message: `Rate plan ${plan.code} is inactive` });
    }
    if (plan.valid_from && ctx.arrival < plan.valid_from) {
      out.push({ type: 'rate-plan', date: ctx.arrival, message: `Rate plan ${plan.code} is not valid before ${plan.valid_from}` });
    }
    if (plan.valid_to && lastNight > plan.valid_to) {
      out.push({ type: 'rate-plan', date: lastNight, message: `Rate plan ${plan.code} is not valid after ${plan.valid_to}` });
    }
    if (plan.min_los && nights < plan.min_los) {
      out.push({ type: 'min-stay', date: ctx.arrival, value: plan.min_los,
        message: `Rate plan ${plan.code} requires at least ${plan.min_los} night(s)` });
    }
    if (plan.max_los && nights > plan.max_los) {
      out.push({ type: 'max-stay', date: ctx.arrival, value: plan.max_los,
        message: `Rate plan ${plan.code} allows at most ${plan.max_los} night(s)` });
    }
    if (plan.min_advance !== null && plan.min_advance !== undefined && leadDays < plan.min_advance) {
      out.push({ type: 'min-advance', date: ctx.arrival, value: plan.min_advance,
        message: `Rate plan ${plan.code} must be booked ${plan.min_advance} day(s) ahead` });
    }
    if (plan.max_advance !== null && plan.max_advance !== undefined && leadDays > plan.max_advance) {
      out.push({ type: 'max-advance', date: ctx.arrival, value: plan.max_advance,
        message: `Rate plan ${plan.code} cannot be booked more than ${plan.max_advance} day(s) ahead` });
    }
  }

  // De-duplicate identical messages (overlapping rules are common).
  const seen = new Set<string>();
  return out.filter((v) => {
    const k = `${v.type}|${v.date}|${v.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Per-date restriction summary — what the rates calendar and the channel
 * manager push out.
 */
export interface RestrictionSummary {
  date: string;
  stopSell: boolean;
  /** Why the date is shut, so the calendar can say so on hover. */
  closeReason: string | null;
  cta: boolean;
  ctd: boolean;
  minStay: number | null;
  maxStay: number | null;
  minStayThrough: number | null;
  minAdvance: number | null;
  maxAdvance: number | null;
}

export function restrictionGrid(
  propertyId: string,
  roomTypeId: string,
  ratePlanId: string | null,
  from: string,
  to: string,
  channelCode?: string | null,
): RestrictionSummary[] {
  const rules = loadRestrictions(propertyId, from, to).filter((r) => {
    if (r.room_type_id && r.room_type_id !== roomTypeId) return false;
    if (r.rate_plan_id && ratePlanId && r.rate_plan_id !== ratePlanId) return false;
    if (r.channel_code && r.channel_code !== (channelCode ?? null)) return false;
    // This grid is what gets sent *out*. A rule aimed only at the desk has no
    // business closing dates on an OTA — that would be the mirror image of the
    // bug this scoping exists to fix.
    if ((r.applies_to ?? 'all') === 'direct') return false;
    return true;
  });

  return dateRange(from, to).map((date) => {
    const active = rules.filter((r) => coversDate(r, date));
    const pick = (type: string) => {
      const vals = active.filter((r) => r.type === type && r.value !== null).map((r) => r.value as number);
      return vals.length ? Math.max(...vals) : null;
    };
    const closures = active.filter((r) => r.type === 'stop-sell');
    return {
      date,
      stopSell: closures.length > 0,
      // With several closures on one date, the first that gives a reason wins —
      // any of them is a true answer to "why is this shut?".
      closeReason: closures.find((r) => r.note)?.note ?? null,
      cta: active.some((r) => r.type === 'cta'),
      ctd: active.some((r) => r.type === 'ctd'),
      minStay: pick('min-stay'),
      maxStay: active.filter((r) => r.type === 'max-stay' && r.value !== null).length
        ? Math.min(...active.filter((r) => r.type === 'max-stay').map((r) => r.value as number))
        : null,
      minStayThrough: pick('min-stay-through'),
      minAdvance: pick('min-advance'),
      maxAdvance: active.filter((r) => r.type === 'max-advance' && r.value !== null).length
        ? Math.min(...active.filter((r) => r.type === 'max-advance').map((r) => r.value as number))
        : null,
    };
  });
}
