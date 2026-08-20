// ─────────────────────────────────────────────────────────────
// Price planning: previewing a rate change, seasons, scheduling a change for a
// future date, copying one period onto another, and the history of every cell.
//
// The organising idea is that **planning and applying are the same code path**.
// `planChange` works out every cell the change would touch and what each would
// go from and to; `applyChange` takes that plan and writes it. A preview can
// therefore never disagree with what actually happens — which is the only way a
// preview is worth showing. A scheduled change stores the same input and runs
// the same two steps when it falls due.
// ─────────────────────────────────────────────────────────────
import { all, get, run, tx, jsonCol, parseJson } from '../db.ts';
import { nudgeQueue } from './channels.ts';
import {
  id, nowIso, addDays, assertDate, dateRangeInclusive, nightsBetween, HttpError,
} from '../lib/util.ts';
import { resolveNightlyBase } from './pricing.ts';
import { audit } from './audit.ts';
import { type Actor } from './reservations.ts';

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface RateChangeInput {
  from: string;
  to: string;                       // inclusive
  roomTypeIds?: string[];
  ratePlanIds?: string[];
  daysOfWeek?: string[];            // ['fri','sat']
  /** Exactly one of these three decides the new price. */
  priceMinor?: number;
  adjustPercentBp?: number;
  adjustMinor?: number;
  /** Optional extras carried onto every touched cell. */
  occupancyPrices?: Record<string, number>;
  extraAdultMinor?: number;
  extraChildMinor?: number;
  losPrices?: Record<string, number>;
  reason?: string;
  /** Never move a price below this, whatever the adjustment works out at. */
  floorMinor?: number;
  /** Never move a price above this. */
  ceilingMinor?: number;
}

export interface PlannedCell {
  roomTypeId: string;
  roomType: string;
  ratePlanId: string;
  ratePlan: string;
  date: string;
  fromMinor: number;
  toMinor: number;
  /** The cell had no explicit price — it was inheriting from the plan or parent. */
  inherited: boolean;
}

export interface ChangePlan {
  cells: PlannedCell[];
  cellCount: number;
  changedCount: number;
  unchangedCount: number;
  dates: number;
  roomTypes: number;
  ratePlans: number;
  minFrom: number | null;
  maxFrom: number | null;
  minTo: number | null;
  maxTo: number | null;
  averageFromMinor: number;
  averageToMinor: number;
  /** The largest moves, so a fat-fingered adjustment is obvious at a glance. */
  biggestMovers: PlannedCell[];
  warnings: string[];
}

function targetDates(input: RateChangeInput): string[] {
  const from = assertDate(input.from, 'from');
  const to = assertDate(input.to, 'to');
  if (to < from) throw new HttpError(400, 'The end of the range cannot be before the start');
  if (nightsBetween(from, to) > 1095) {
    throw new HttpError(400, 'A single change cannot span more than three years');
  }
  const days = input.daysOfWeek;
  return dateRangeInclusive(from, to).filter((d) => {
    if (!days?.length) return true;
    return days.includes(DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]);
  });
}

function targetRoomTypes(propertyId: string, ids?: string[]) {
  const rows = ids?.length
    ? all<any>(
      `SELECT * FROM room_types WHERE property_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      propertyId, ...ids)
    : all<any>('SELECT * FROM room_types WHERE property_id = ? AND active = 1 ORDER BY sort_order', propertyId);
  if (!rows.length) throw new HttpError(400, 'No room type matches this change');
  return rows;
}

function targetRatePlans(propertyId: string, ids?: string[]) {
  // Derived plans are excluded by default: they recalculate from their parent,
  // so writing a price onto one is a change that the next parent edit silently
  // undoes. Naming one explicitly is still allowed.
  const rows = ids?.length
    ? all<any>(
      `SELECT * FROM rate_plans WHERE property_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
      propertyId, ...ids)
    : all<any>(
      'SELECT * FROM rate_plans WHERE property_id = ? AND active = 1 AND parent_id IS NULL', propertyId);
  if (!rows.length) throw new HttpError(400, 'No rate plan matches this change');
  return rows;
}

/**
 * Work out every cell the change touches, and what each goes from and to.
 * Writes nothing.
 */
export function planChange(propertyId: string, input: RateChangeInput): ChangePlan {
  const methods = [input.priceMinor, input.adjustPercentBp, input.adjustMinor]
    .filter((v) => v !== undefined && v !== null);
  if (methods.length === 0) {
    throw new HttpError(400, 'Provide a new price, a percentage or an amount to adjust by');
  }
  if (methods.length > 1) {
    throw new HttpError(400, 'Provide only one of price, percentage or amount — not several');
  }

  const dates = targetDates(input);
  const roomTypes = targetRoomTypes(propertyId, input.roomTypeIds);
  const ratePlans = targetRatePlans(propertyId, input.ratePlanIds);
  const warnings: string[] = [];

  if (!dates.length) {
    warnings.push('No dates match — the days of the week chosen do not occur in this range.');
  }
  const derived = ratePlans.filter((rp) => rp.parent_id);
  if (derived.length) {
    warnings.push(
      `${derived.map((rp) => rp.code).join(', ')} ${derived.length === 1 ? 'is a derived plan' : 'are derived plans'}`
      + ' — a price written here is recalculated the next time the parent changes.');
  }

  const cells: PlannedCell[] = [];
  for (const rt of roomTypes) {
    for (const rp of ratePlans) {
      for (const date of dates) {
        const existing = get<{ price_minor: number }>(
          `SELECT price_minor FROM rate_calendar
            WHERE property_id = ? AND room_type_id = ? AND rate_plan_id = ? AND date = ?`,
          propertyId, rt.id, rp.id, date,
        );
        // An unset cell still has an effective price — the plan's base, or its
        // parent's. That is what a percentage moves, and what the operator sees
        // on the calendar, so it is the honest "from".
        const fromMinor = existing?.price_minor
          ?? resolveNightlyBase(propertyId, rt, rp, date, 1).minor;

        let toMinor: number;
        if (input.priceMinor !== undefined) toMinor = input.priceMinor;
        else if (input.adjustPercentBp !== undefined) {
          toMinor = Math.round(fromMinor + (fromMinor * input.adjustPercentBp) / 10_000);
        } else {
          toMinor = fromMinor + (input.adjustMinor ?? 0);
        }

        if (input.floorMinor !== undefined) toMinor = Math.max(input.floorMinor, toMinor);
        if (input.ceilingMinor !== undefined) toMinor = Math.min(input.ceilingMinor, toMinor);
        toMinor = Math.max(0, Math.round(toMinor));

        cells.push({
          roomTypeId: rt.id, roomType: rt.name,
          ratePlanId: rp.id, ratePlan: rp.code,
          date, fromMinor, toMinor, inherited: !existing,
        });
      }
    }
  }

  const changed = cells.filter((c) => c.fromMinor !== c.toMinor);
  const froms = cells.map((c) => c.fromMinor);
  const tos = cells.map((c) => c.toMinor);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

  if (changed.some((c) => c.toMinor === 0)) {
    warnings.push('Some cells would be priced at zero. Rooms priced at zero are still sellable.');
  }
  const doubling = changed.filter((c) => c.fromMinor > 0 && c.toMinor >= c.fromMinor * 2);
  if (doubling.length) {
    warnings.push(`${doubling.length} cell(s) would more than double in price.`);
  }

  return {
    cells,
    cellCount: cells.length,
    changedCount: changed.length,
    unchangedCount: cells.length - changed.length,
    dates: dates.length,
    roomTypes: roomTypes.length,
    ratePlans: ratePlans.length,
    minFrom: froms.length ? Math.min(...froms) : null,
    maxFrom: froms.length ? Math.max(...froms) : null,
    minTo: tos.length ? Math.min(...tos) : null,
    maxTo: tos.length ? Math.max(...tos) : null,
    averageFromMinor: mean(froms),
    averageToMinor: mean(tos),
    biggestMovers: [...changed]
      .sort((a, b) => Math.abs(b.toMinor - b.fromMinor) - Math.abs(a.toMinor - a.fromMinor))
      .slice(0, 12),
    warnings,
  };
}

/** Write one cell and record what it moved from. */
function writeCell(
  propertyId: string, actor: Actor, cell: PlannedCell, input: RateChangeInput, source: string,
) {
  run(
    `INSERT INTO rate_calendar(id, property_id, room_type_id, rate_plan_id, date, price_minor,
                               occupancy_prices, extra_adult_minor, extra_child_minor, los_prices,
                               updated_at, updated_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(property_id, room_type_id, rate_plan_id, date) DO UPDATE SET
       price_minor = excluded.price_minor,
       occupancy_prices = COALESCE(excluded.occupancy_prices, rate_calendar.occupancy_prices),
       extra_adult_minor = COALESCE(excluded.extra_adult_minor, rate_calendar.extra_adult_minor),
       extra_child_minor = COALESCE(excluded.extra_child_minor, rate_calendar.extra_child_minor),
       los_prices = COALESCE(excluded.los_prices, rate_calendar.los_prices),
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    id('rc'), propertyId, cell.roomTypeId, cell.ratePlanId, cell.date, cell.toMinor,
    input.occupancyPrices ? jsonCol(input.occupancyPrices) : null,
    input.extraAdultMinor ?? null, input.extraChildMinor ?? null,
    input.losPrices ? jsonCol(input.losPrices) : null,
    nowIso(), actor.userName,
  );
  run(
    `INSERT INTO rate_history(id, property_id, room_type_id, rate_plan_id, date,
                              old_minor, new_minor, source, reason, changed_by, changed_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id('rh'), propertyId, cell.roomTypeId, cell.ratePlanId, cell.date,
    cell.inherited ? null : cell.fromMinor, cell.toMinor, source,
    input.reason ?? null, actor.userName, nowIso(),
  );
}

/** Any price movement is something the channels need to hear about. */
function queueRatePush(propertyId: string, roomTypeIds: string[], from: string, to: string, reason: string) {
  const channels = all<{ id: string }>(
    // Queue for channels in error too. A channel is marked `error` by one
    // failed call, and a price or availability change made in that window would
    // otherwise never be recorded at all — not delayed, *lost*. Queueing is
    // free; the drain retries until it lands.
    `SELECT id FROM channels WHERE property_id = ? AND active = 1
       AND status IN ('connected', 'error')`, propertyId);
  for (const rtId of roomTypeIds) {
    for (const c of channels) {
      run(
        `INSERT INTO channel_queue(id, property_id, channel_id, room_type_id, date_from, date_to,
                                   scope, reason, status, created_at)
         VALUES(?,?,?,?,?,?,'rates',?,'queued',?)`,
        id('cq'), propertyId, c.id, rtId, from, addDays(to, 1), reason, nowIso(),
      );
    }
  }
  // Ask for a drain rather than waiting for the next tick.
  nudgeQueue();
}

export function applyChange(
  propertyId: string, actor: Actor, input: RateChangeInput, source = 'bulk',
) {
  return tx(() => {
    const plan = planChange(propertyId, input);
    // Only cells that actually move are written. Rewriting a cell to the value
    // it already holds would fill the history with noise and tell the channels
    // about a change that did not happen.
    const moving = plan.cells.filter((c) => c.fromMinor !== c.toMinor || c.inherited);
    for (const cell of moving) writeCell(propertyId, actor, cell, input, source);

    if (moving.length) {
      queueRatePush(
        propertyId,
        [...new Set(moving.map((c) => c.roomTypeId))],
        input.from, input.to, `rate.${source}`,
      );
    }

    audit(actor, {
      action: 'rate.bulk-update', entity: 'RATE_PLAN', entityRef: `${input.from} → ${input.to}`,
      after: {
        source, written: moving.length, planned: plan.cellCount,
        priceMinor: input.priceMinor, adjustPercentBp: input.adjustPercentBp,
        adjustMinor: input.adjustMinor, reason: input.reason,
        averageFrom: plan.averageFromMinor, averageTo: plan.averageToMinor,
      },
    });

    return { written: moving.length, planned: plan.cellCount, dates: plan.dates };
  });
}

// ─── Copying one period onto another ─────────────────────────

export interface CopyPeriodInput {
  sourceFrom: string;
  sourceTo: string;              // inclusive
  targetFrom: string;
  roomTypeIds?: string[];
  ratePlanIds?: string[];
  /** 10_000 = same price; 11_000 = 10% more. */
  multiplierBp?: number;
  reason?: string;
}

/**
 * Map a source period onto a target period, day for day.
 *
 * The mapping is by offset, not by date arithmetic on the calendar: day 1 of
 * the source becomes day 1 of the target. That is what "take last December and
 * apply it to this December" means to the person asking, and it keeps weekend
 * shape intact only if they line the ranges up themselves — so the plan reports
 * the day-of-week drift rather than silently reshuffling.
 */
export function planCopy(propertyId: string, input: CopyPeriodInput): ChangePlan {
  const sourceFrom = assertDate(input.sourceFrom, 'sourceFrom');
  const sourceTo = assertDate(input.sourceTo, 'sourceTo');
  const targetFrom = assertDate(input.targetFrom, 'targetFrom');
  if (sourceTo < sourceFrom) throw new HttpError(400, 'The source period ends before it starts');

  const sourceDates = dateRangeInclusive(sourceFrom, sourceTo);
  const multiplier = input.multiplierBp ?? 10_000;
  const roomTypes = targetRoomTypes(propertyId, input.roomTypeIds);
  const ratePlans = targetRatePlans(propertyId, input.ratePlanIds);
  const warnings: string[] = [];

  const targetTo = addDays(targetFrom, sourceDates.length - 1);
  if (targetFrom <= sourceTo && sourceFrom <= targetTo) {
    warnings.push('The source and target periods overlap — prices would be copied onto themselves.');
  }
  const sourceDow = new Date(`${sourceFrom}T00:00:00Z`).getUTCDay();
  const targetDow = new Date(`${targetFrom}T00:00:00Z`).getUTCDay();
  if (sourceDow !== targetDow) {
    warnings.push(
      `The periods start on different days of the week (${DOW[sourceDow]} → ${DOW[targetDow]}), `
      + 'so weekend prices will land on weekdays. Shift the target date to line them up.');
  }

  const cells: PlannedCell[] = [];
  for (const rt of roomTypes) {
    for (const rp of ratePlans) {
      sourceDates.forEach((sourceDate, offset) => {
        const date = addDays(targetFrom, offset);
        const src = get<{ price_minor: number }>(
          `SELECT price_minor FROM rate_calendar
            WHERE property_id = ? AND room_type_id = ? AND rate_plan_id = ? AND date = ?`,
          propertyId, rt.id, rp.id, sourceDate,
        );
        const sourcePrice = src?.price_minor
          ?? resolveNightlyBase(propertyId, rt, rp, sourceDate, 1).minor;
        const existing = get<{ price_minor: number }>(
          `SELECT price_minor FROM rate_calendar
            WHERE property_id = ? AND room_type_id = ? AND rate_plan_id = ? AND date = ?`,
          propertyId, rt.id, rp.id, date,
        );
        const fromMinor = existing?.price_minor
          ?? resolveNightlyBase(propertyId, rt, rp, date, 1).minor;

        cells.push({
          roomTypeId: rt.id, roomType: rt.name,
          ratePlanId: rp.id, ratePlan: rp.code, date,
          fromMinor,
          toMinor: Math.max(0, Math.round((sourcePrice * multiplier) / 10_000)),
          inherited: !existing,
        });
      });
    }
  }

  const changed = cells.filter((c) => c.fromMinor !== c.toMinor);
  const froms = cells.map((c) => c.fromMinor);
  const tos = cells.map((c) => c.toMinor);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

  return {
    cells,
    cellCount: cells.length,
    changedCount: changed.length,
    unchangedCount: cells.length - changed.length,
    dates: sourceDates.length,
    roomTypes: roomTypes.length,
    ratePlans: ratePlans.length,
    minFrom: froms.length ? Math.min(...froms) : null,
    maxFrom: froms.length ? Math.max(...froms) : null,
    minTo: tos.length ? Math.min(...tos) : null,
    maxTo: tos.length ? Math.max(...tos) : null,
    averageFromMinor: mean(froms),
    averageToMinor: mean(tos),
    biggestMovers: [...changed]
      .sort((a, b) => Math.abs(b.toMinor - b.fromMinor) - Math.abs(a.toMinor - a.fromMinor))
      .slice(0, 12),
    warnings,
  };
}

export function applyCopy(propertyId: string, actor: Actor, input: CopyPeriodInput) {
  return tx(() => {
    const plan = planCopy(propertyId, input);
    const moving = plan.cells.filter((c) => c.fromMinor !== c.toMinor || c.inherited);
    const asInput: RateChangeInput = {
      from: input.targetFrom, to: addDays(input.targetFrom, plan.dates - 1),
      reason: input.reason,
    };
    for (const cell of moving) writeCell(propertyId, actor, cell, asInput, 'copy');

    if (moving.length) {
      queueRatePush(propertyId, [...new Set(moving.map((c) => c.roomTypeId))],
        asInput.from, asInput.to, 'rate.copy');
    }

    audit(actor, {
      action: 'rate.bulk-update', entity: 'RATE_PLAN',
      entityRef: `copy ${input.sourceFrom}→${input.sourceTo} onto ${asInput.from}`,
      after: { written: moving.length, multiplierBp: input.multiplierBp ?? 10_000, reason: input.reason },
    });

    return { written: moving.length, planned: plan.cellCount, dates: plan.dates };
  });
}

// ─── Seasons ─────────────────────────────────────────────────

export function listSeasons(propertyId: string) {
  return all<any>(
    `SELECT * FROM rate_seasons WHERE property_id = ? ORDER BY date_from`, propertyId,
  ).map((s) => ({
    id: s.id, name: s.name, colour: s.colour, from: s.date_from, to: s.date_to,
    nights: nightsBetween(s.date_from, s.date_to) + 1,
    priority: s.priority, note: s.note, active: s.active === 1,
    createdBy: s.created_by, createdAt: s.created_at,
  }));
}

export function upsertSeason(propertyId: string, actor: Actor, input: {
  id?: string; name: string; colour?: string; from: string; to: string;
  priority?: number; note?: string; active?: boolean;
}) {
  const from = assertDate(input.from, 'from');
  const to = assertDate(input.to, 'to');
  if (to < from) throw new HttpError(400, 'A season cannot end before it starts');
  if (!input.name?.trim()) throw new HttpError(400, 'A season needs a name');

  if (input.id) {
    const before = get<any>('SELECT * FROM rate_seasons WHERE id = ? AND property_id = ?',
      input.id, propertyId);
    if (!before) throw new HttpError(404, 'Season not found');
    run(
      `UPDATE rate_seasons SET name = ?, colour = ?, date_from = ?, date_to = ?,
                               priority = ?, note = ?, active = ?
        WHERE id = ?`,
      input.name.trim(), input.colour ?? null, from, to,
      input.priority ?? before.priority, input.note ?? null,
      input.active === false ? 0 : 1, input.id,
    );
    audit(actor, {
      action: 'season.update', entity: 'RATE_PLAN', entityId: input.id, entityRef: input.name,
      before: { from: before.date_from, to: before.date_to }, after: { from, to },
    });
    return { id: input.id };
  }

  const seasonId = id('sea');
  run(
    `INSERT INTO rate_seasons(id, property_id, name, colour, date_from, date_to,
                              priority, note, active, created_by, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    seasonId, propertyId, input.name.trim(), input.colour ?? null, from, to,
    input.priority ?? 0, input.note ?? null, input.active === false ? 0 : 1,
    actor.userName, nowIso(),
  );
  audit(actor, {
    action: 'season.create', entity: 'RATE_PLAN', entityId: seasonId,
    entityRef: input.name, after: { from, to },
  });
  return { id: seasonId };
}

export function deleteSeason(propertyId: string, actor: Actor, seasonId: string) {
  const before = get<any>('SELECT * FROM rate_seasons WHERE id = ? AND property_id = ?',
    seasonId, propertyId);
  if (!before) throw new HttpError(404, 'Season not found');
  run('DELETE FROM rate_seasons WHERE id = ?', seasonId);
  audit(actor, {
    action: 'season.delete', entity: 'RATE_PLAN', entityId: seasonId,
    entityRef: before.name, before: { from: before.date_from, to: before.date_to },
  });
  return { ok: true };
}

/** Which season a date falls in — highest priority wins where they overlap. */
export function seasonFor(propertyId: string, date: string) {
  return get<any>(
    `SELECT * FROM rate_seasons
      WHERE property_id = ? AND active = 1 AND date_from <= ? AND date_to >= ?
      ORDER BY priority DESC, date_from LIMIT 1`,
    propertyId, date, date,
  );
}

// ─── Scheduled changes ───────────────────────────────────────

export function scheduleChange(propertyId: string, actor: Actor, input: {
  name: string; effectiveDate: string; change: RateChangeInput;
}) {
  const effective = assertDate(input.effectiveDate, 'effectiveDate');
  if (!input.name?.trim()) throw new HttpError(400, 'A scheduled change needs a name');
  // Planning it now catches a broken change at the time it is written, rather
  // than at 3am on the day it fires with nobody watching.
  const plan = planChange(propertyId, input.change);

  const schedId = id('src');
  run(
    `INSERT INTO scheduled_rate_changes(id, property_id, name, effective_date, payload,
                                        status, created_by, created_at)
     VALUES(?,?,?,?,?,'scheduled',?,?)`,
    schedId, propertyId, input.name.trim(), effective, JSON.stringify(input.change),
    actor.userName, nowIso(),
  );
  audit(actor, {
    action: 'rate.schedule', entity: 'RATE_PLAN', entityId: schedId, entityRef: input.name,
    after: { effectiveDate: effective, cells: plan.cellCount, changed: plan.changedCount },
  });
  return { id: schedId, effectiveDate: effective, willChange: plan.changedCount };
}

export function listScheduledChanges(propertyId: string, today: string) {
  return all<any>(
    `SELECT * FROM scheduled_rate_changes WHERE property_id = ? ORDER BY effective_date DESC`,
    propertyId,
  ).map((s) => {
    const payload = parseJson<RateChangeInput>(s.payload, {} as RateChangeInput);
    return {
      id: s.id, name: s.name, effectiveDate: s.effective_date, status: s.status,
      cellsChanged: s.cells_changed, error: s.error,
      createdBy: s.created_by, createdAt: s.created_at,
      appliedAt: s.applied_at, cancelledAt: s.cancelled_at,
      due: s.status === 'scheduled' && s.effective_date <= today,
      change: {
        from: payload.from, to: payload.to,
        priceMinor: payload.priceMinor, adjustPercentBp: payload.adjustPercentBp,
        adjustMinor: payload.adjustMinor, daysOfWeek: payload.daysOfWeek,
        reason: payload.reason,
      },
    };
  });
}

export function cancelScheduledChange(propertyId: string, actor: Actor, schedId: string) {
  const row = get<any>('SELECT * FROM scheduled_rate_changes WHERE id = ? AND property_id = ?',
    schedId, propertyId);
  if (!row) throw new HttpError(404, 'Scheduled change not found');
  if (row.status !== 'scheduled') {
    throw new HttpError(409, `That change is already ${row.status} — there is nothing to cancel`);
  }
  run(`UPDATE scheduled_rate_changes SET status = 'cancelled', cancelled_at = ? WHERE id = ?`,
    nowIso(), schedId);
  audit(actor, {
    action: 'rate.schedule-cancel', entity: 'RATE_PLAN', entityId: schedId, entityRef: row.name,
  });
  return { ok: true };
}

/**
 * Apply everything that has fallen due.
 *
 * Called on startup and after the night audit rolls the business date. Each
 * change is applied in its own transaction, so one broken change is recorded as
 * failed and the rest still run.
 */
export function runDueScheduledChanges(propertyId: string, actor: Actor, today: string) {
  const due = all<any>(
    `SELECT * FROM scheduled_rate_changes
      WHERE property_id = ? AND status = 'scheduled' AND effective_date <= ?
      ORDER BY effective_date`,
    propertyId, today,
  );

  const results: Array<{ id: string; name: string; ok: boolean; written?: number; error?: string }> = [];
  for (const row of due) {
    try {
      const payload = parseJson<RateChangeInput>(row.payload, null as any);
      if (!payload) throw new Error('The stored change could not be read');
      const result = applyChange(propertyId, actor, payload, 'scheduled');
      run(
        `UPDATE scheduled_rate_changes SET status = 'applied', applied_at = ?, cells_changed = ?
          WHERE id = ?`,
        nowIso(), result.written, row.id,
      );
      results.push({ id: row.id, name: row.name, ok: true, written: result.written });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      run(
        `UPDATE scheduled_rate_changes SET status = 'failed', error = ?, applied_at = ? WHERE id = ?`,
        message.slice(0, 400), nowIso(), row.id,
      );
      // A failed change is left visible rather than retried forever: a rate
      // plan that has since been deleted will not start existing again.
      results.push({ id: row.id, name: row.name, ok: false, error: message });
    }
  }
  return { due: due.length, applied: results.filter((r) => r.ok).length, results };
}

// ─── History ─────────────────────────────────────────────────

export function rateHistory(propertyId: string, opts: {
  roomTypeId?: string; ratePlanId?: string; date?: string; from?: string; to?: string; limit?: number;
}) {
  const where = ['h.property_id = ?'];
  const params: unknown[] = [propertyId];
  if (opts.roomTypeId) { where.push('h.room_type_id = ?'); params.push(opts.roomTypeId); }
  if (opts.ratePlanId) { where.push('h.rate_plan_id = ?'); params.push(opts.ratePlanId); }
  if (opts.date) { where.push('h.date = ?'); params.push(opts.date); }
  if (opts.from) { where.push('h.date >= ?'); params.push(opts.from); }
  if (opts.to) { where.push('h.date <= ?'); params.push(opts.to); }
  const limit = Math.min(opts.limit ?? 200, 1000);

  return all<any>(
    `SELECT h.*, rt.name AS room_type_name, rp.code AS rate_plan_code
       FROM rate_history h
       LEFT JOIN room_types rt ON rt.id = h.room_type_id
       LEFT JOIN rate_plans rp ON rp.id = h.rate_plan_id
      WHERE ${where.join(' AND ')}
      ORDER BY h.changed_at DESC
      LIMIT ${limit}`,
    ...params,
  ).map((h) => ({
    id: h.id, date: h.date,
    roomTypeId: h.room_type_id, roomType: h.room_type_name,
    ratePlanId: h.rate_plan_id, ratePlan: h.rate_plan_code,
    fromMinor: h.old_minor, toMinor: h.new_minor,
    deltaMinor: h.old_minor === null ? null : h.new_minor - h.old_minor,
    source: h.source, reason: h.reason,
    changedBy: h.changed_by, changedAt: h.changed_at,
  }));
}
