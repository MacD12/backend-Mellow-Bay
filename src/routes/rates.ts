// Rates, inventory and the selling rules that sit on top of them:
// rate plans, the rate calendar, restrictions, yield rules and promotions.
import { router, type Ctx } from '../lib/http.ts';
import { all, get, run, tx, jsonCol, parseJson, scalar } from '../db.ts';
import {
  id, nowIso, str, int, slugCode, money, oneOf, boolIn, assertDate, addDays,
  dateRange, dateRangeInclusive, HttpError, notFound, nightsBetween,
} from '../lib/util.ts';
import { availabilityGrid, freeRooms, freeBeds, physicalCounts } from '../services/availability.ts';
import { quoteStay, resolveNightlyBase, eligiblePromotions, activeTaxes } from '../services/pricing.ts';
import { validateStay, restrictionGrid } from '../services/restrictions.ts';
import { closeDates, openDates, closeoutList, purgeExpiredCloseouts } from '../services/closeouts.ts';
import {
  planChange, applyChange, planCopy, applyCopy, listSeasons, upsertSeason, deleteSeason,
  scheduleChange, listScheduledChanges, cancelScheduledChange, runDueScheduledChanges,
  rateHistory, type RateChangeInput,
} from '../services/rateplanning.ts';
import { queueChannelPush } from '../services/reservations.ts';
import { audit } from '../services/audit.ts';

const pid = (ctx: Ctx) => ctx.auth.propertyId;

function range(ctx: Ctx, defaultDays = 30) {
  const from = ctx.query.get('from') ?? get<{ business_date: string }>(
    'SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;
  assertDate(from, 'from');
  const to = ctx.query.get('to') ?? addDays(from, defaultDays);
  assertDate(to, 'to');
  if (nightsBetween(from, to) > 400) throw new HttpError(400, 'Date range cannot exceed 400 days');
  if (to <= from) throw new HttpError(400, '`to` must be after `from`');
  return { from, to };
}

// ─── Availability ────────────────────────────────────────────
router.get('/api/availability', (ctx: Ctx) => {
  const { from, to } = range(ctx);
  return { from, to, cells: availabilityGrid(pid(ctx), from, to) };
}, { perm: 'reservations.read' });

router.get('/api/availability/free-rooms', (ctx: Ctx) => {
  const from = assertDate(ctx.query.get('from'), 'from');
  const to = assertDate(ctx.query.get('to'), 'to');
  const roomTypeId = ctx.query.get('roomTypeId');
  const exclude = ctx.query.get('excludeReservationId') ?? undefined;
  const rooms = freeRooms(pid(ctx), roomTypeId, from, to, exclude).map((r: any) => ({
    id: r.id, number: r.number, floor: r.floor, status: r.status,
    roomTypeId: r.room_type_id, roomType: r.room_type_name, roomTypeCode: r.room_type_code,
    features: parseJson<string[]>(r.features, []),
  }));
  const beds = roomTypeId
    ? freeBeds(pid(ctx), roomTypeId, from, to, exclude).map((b: any) => ({
      id: b.id, code: b.code, roomId: b.room_id, room: b.room_number, bunk: b.bunk,
    }))
    : [];
  return { rooms, beds };
}, { perm: 'reservations.read' });

/** The tape chart: every room with its reserved spans across the window. */
router.get('/api/calendar/tape', (ctx: Ctx) => {
  const { from, to } = range(ctx, 14);
  const rooms = all<any>(
    `SELECT r.id, r.number, r.floor, r.status, rt.id AS room_type_id, rt.name AS room_type_name,
            rt.code AS room_type_code, rt.kind
       FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.property_id = ? AND r.active = 1
      ORDER BY rt.sort_order, r.floor, r.number`,
    pid(ctx),
  );
  // Dorm rooms hold several guests at once, so the chart needs a line per bed
  // rather than per room — otherwise their stays draw on top of each other.
  const beds = all<any>(
    `SELECT b.id, b.code, b.room_id, b.bunk
       FROM beds b JOIN rooms r ON r.id = b.room_id
      WHERE b.property_id = ? AND b.active = 1 AND r.active = 1
      ORDER BY b.code`,
    pid(ctx),
  );
  const spans = all<any>(
    `SELECT r.id, r.confirmation, r.guest_name, r.status, r.arrival, r.departure, r.vip,
            r.source, r.channel_code, r.total_minor, r.nights, r.adults, r.children,
            n.room_id, n.bed_id, MIN(n.date) AS span_from, MAX(n.date) AS span_to
       FROM reservation_nights n JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.date >= ? AND n.date < ? AND n.room_id IS NOT NULL
        AND r.status IN ('Tentative','Confirmed','Guaranteed','Checked-in','Checked-out')
      GROUP BY n.room_id, n.bed_id, r.id`,
    pid(ctx), from, to,
  );
  const blocks = all<any>(
    `SELECT * FROM room_blocks WHERE property_id = ? AND released_at IS NULL
       AND from_date < ? AND to_date > ?`,
    pid(ctx), to, from,
  );
  const unassigned = all<any>(
    `SELECT r.id, r.confirmation, r.guest_name, r.status, r.arrival, r.departure, r.vip,
            rt.name AS room_type_name, rt.id AS room_type_id
       FROM reservations r JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.property_id = ? AND r.room_id IS NULL AND r.departure > ? AND r.arrival < ?
        AND r.status IN ('Tentative','Confirmed','Guaranteed')
      ORDER BY r.arrival`,
    pid(ctx), from, to,
  );

  return {
    from, to,
    dates: dateRange(from, to),
    rooms: rooms.map((r) => ({
      id: r.id, number: r.number, floor: r.floor, status: r.status,
      roomTypeId: r.room_type_id, roomType: r.room_type_name,
      roomTypeCode: r.room_type_code, kind: r.kind,
      beds: r.kind === 'dorm'
        ? beds.filter((b) => b.room_id === r.id)
          .map((b) => ({ id: b.id, code: b.code, bunk: b.bunk }))
        : [],
    })),
    spans: spans.map((s) => ({
      reservationId: s.id, roomId: s.room_id, bedId: s.bed_id, confirmation: s.confirmation,
      guest: s.guest_name, status: s.status, from: s.span_from, to: addDays(s.span_to, 1),
      arrival: s.arrival, departure: s.departure, vip: s.vip === 1,
      source: s.source, channel: s.channel_code, nights: s.nights,
      totalMinor: s.total_minor, adults: s.adults, children: s.children,
    })),
    blocks: blocks.map((b) => ({
      id: b.id, roomId: b.room_id, kind: b.kind, from: b.from_date, to: b.to_date, reason: b.reason,
    })),
    unassigned: unassigned.map((u) => ({
      reservationId: u.id, confirmation: u.confirmation, guest: u.guest_name,
      status: u.status, arrival: u.arrival, departure: u.departure,
      roomType: u.room_type_name, roomTypeId: u.room_type_id, vip: u.vip === 1,
    })),
    availability: availabilityGrid(pid(ctx), from, to),
  };
}, { perm: 'reservations.read' });

// ─── Rate plans ──────────────────────────────────────────────
function shapePlan(p: any) {
  return {
    id: p.id, code: p.code, name: p.name, description: p.description,
    parentId: p.parent_id, parentCode: p.parent_code ?? null,
    offsetType: p.offset_type, offsetValue: p.offset_value,
    refundable: p.refundable === 1, flexible: p.flexible === 1, kind: p.kind,
    marketSegment: p.market_segment, minLos: p.min_los, maxLos: p.max_los,
    minAdvance: p.min_advance, maxAdvance: p.max_advance,
    inclusions: parseJson<string[]>(p.inclusions, []),
    companyId: p.company_id, validFrom: p.valid_from, validTo: p.valid_to,
    depositPctBp: p.deposit_pct_bp, sortOrder: p.sort_order, active: p.active === 1,
    roomTypes: all<any>(
      `SELECT rprt.room_type_id, rprt.base_rate_minor, rt.name, rt.code
         FROM rate_plan_room_types rprt JOIN room_types rt ON rt.id = rprt.room_type_id
        WHERE rprt.rate_plan_id = ?`, p.id,
    ).map((r) => ({
      roomTypeId: r.room_type_id, roomType: r.name, roomTypeCode: r.code,
      baseRateMinor: r.base_rate_minor,
    })),
  };
}

router.get('/api/rate-plans', (ctx: Ctx) => all<any>(
  `SELECT rp.*, parent.code AS parent_code FROM rate_plans rp
     LEFT JOIN rate_plans parent ON parent.id = rp.parent_id
    WHERE rp.property_id = ? ORDER BY rp.sort_order, rp.name`,
  pid(ctx),
).map(shapePlan), { perm: 'rates.read' });

router.post('/api/rate-plans', (ctx: Ctx) => tx(() => {
  const b = ctx.body;
  const planId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, description, parent_id, offset_type,
                            offset_value, refundable, flexible, kind, market_segment, min_los, max_los,
                            min_advance, max_advance, inclusions, company_id, valid_from, valid_to,
                            deposit_pct_bp, sort_order, active, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    planId, pid(ctx), slugCode(b.code, 'code', 16), str(b.name, 'name', { max: 80 }),
    b.description ?? null, b.parentId ?? null,
    b.offsetType ? oneOf(b.offsetType, 'offsetType', ['percent', 'fixed'] as const) : null,
    int(b.offsetValue ?? 0, 'offsetValue'),
    b.refundable === false ? 0 : 1, b.flexible === false ? 0 : 1,
    oneOf(b.kind, 'kind', ['public', 'corporate', 'group', 'package', 'member'] as const, 'public'),
    b.marketSegment ?? null,
    b.minLos ?? null, b.maxLos ?? null, b.minAdvance ?? null, b.maxAdvance ?? null,
    jsonCol(b.inclusions ?? []), b.companyId ?? null, b.validFrom ?? null, b.validTo ?? null,
    int(b.depositPctBp ?? 0, 'depositPctBp', { min: 0, max: 10000 }),
    int(b.sortOrder ?? 0, 'sortOrder'), b.active === false ? 0 : 1, nowIso(),
  );
  for (const rt of b.roomTypes ?? []) {
    run(
      `INSERT INTO rate_plan_room_types(rate_plan_id, room_type_id, base_rate_minor) VALUES(?,?,?)
       ON CONFLICT(rate_plan_id, room_type_id) DO UPDATE SET base_rate_minor = excluded.base_rate_minor`,
      planId, rt.roomTypeId, money(rt.baseRateMinor ?? 0, 'baseRateMinor'),
    );
  }
  audit(ctx.auth, {
    action: 'rateplan.create', entity: 'RATE_PLAN', entityId: planId, entityRef: b.code, after: b,
  }, ctx.ip);
  return shapePlan(get<any>('SELECT * FROM rate_plans WHERE id = ?', planId));
}), { perm: 'rates.write' });

router.patch('/api/rate-plans/:id', (ctx: Ctx) => tx(() => {
  const before = get<any>('SELECT * FROM rate_plans WHERE id = ? AND property_id = ?',
    ctx.params.id, pid(ctx));
  if (!before) notFound('Rate plan');
  if (ctx.body.parentId === ctx.params.id) {
    throw new HttpError(400, 'A rate plan cannot derive from itself');
  }
  const map: Record<string, string> = {
    name: 'name', description: 'description', parentId: 'parent_id', offsetType: 'offset_type',
    offsetValue: 'offset_value', kind: 'kind', marketSegment: 'market_segment',
    minLos: 'min_los', maxLos: 'max_los', minAdvance: 'min_advance', maxAdvance: 'max_advance',
    companyId: 'company_id', validFrom: 'valid_from', validTo: 'valid_to',
    depositPctBp: 'deposit_pct_bp', sortOrder: 'sort_order',
  };
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (ctx.body[k] !== undefined) { sets.push(`${col} = ?`); args.push(ctx.body[k]); }
  }
  if (ctx.body.refundable !== undefined) { sets.push('refundable = ?'); args.push(ctx.body.refundable ? 1 : 0); }
  if (ctx.body.flexible !== undefined) { sets.push('flexible = ?'); args.push(ctx.body.flexible ? 1 : 0); }
  if (ctx.body.active !== undefined) { sets.push('active = ?'); args.push(ctx.body.active ? 1 : 0); }
  if (ctx.body.inclusions !== undefined) { sets.push('inclusions = ?'); args.push(jsonCol(ctx.body.inclusions)); }
  if (sets.length) {
    args.push(ctx.params.id);
    run(`UPDATE rate_plans SET ${sets.join(', ')} WHERE id = ?`, ...args);
  }
  if (ctx.body.roomTypes) {
    run('DELETE FROM rate_plan_room_types WHERE rate_plan_id = ?', ctx.params.id);
    for (const rt of ctx.body.roomTypes) {
      run('INSERT INTO rate_plan_room_types(rate_plan_id, room_type_id, base_rate_minor) VALUES(?,?,?)',
        ctx.params.id, rt.roomTypeId, money(rt.baseRateMinor ?? 0, 'baseRateMinor'));
    }
  }
  audit(ctx.auth, {
    action: 'rateplan.update', entity: 'RATE_PLAN', entityId: ctx.params.id, entityRef: before.code,
    before: { name: before.name, offsetValue: before.offset_value }, after: ctx.body,
  }, ctx.ip);
  return shapePlan(get<any>('SELECT * FROM rate_plans WHERE id = ?', ctx.params.id));
}), { perm: 'rates.write' });

// ─── Rate calendar ───────────────────────────────────────────
/** Resolved nightly prices for the grid — including derived and default rates. */
router.get('/api/rates/calendar', (ctx: Ctx) => {
  const { from, to } = range(ctx);
  const roomTypes = all<any>(
    `SELECT * FROM room_types WHERE property_id = ? AND active = 1 ORDER BY sort_order, name`, pid(ctx));
  const plans = all<any>(
    `SELECT * FROM rate_plans WHERE property_id = ? AND active = 1 ORDER BY sort_order, name`, pid(ctx));
  const planFilter = ctx.query.get('ratePlanId');
  const typeFilter = ctx.query.get('roomTypeId');
  const grid = availabilityGrid(pid(ctx), from, to);
  const dates = dateRange(from, to);

  const rows: any[] = [];
  for (const rt of roomTypes) {
    if (typeFilter && rt.id !== typeFilter) continue;
    for (const rp of plans) {
      if (planFilter && rp.id !== planFilter) continue;
      const restrictions = restrictionGrid(pid(ctx), rt.id, rp.id, from, to);
      const byDate = new Map(restrictions.map((r) => [r.date, r]));
      const explicit = new Map(all<any>(
        `SELECT * FROM rate_calendar WHERE property_id = ? AND room_type_id = ? AND rate_plan_id = ?
           AND date >= ? AND date < ?`,
        pid(ctx), rt.id, rp.id, from, to,
      ).map((c) => [c.date, c]));

      rows.push({
        roomTypeId: rt.id, roomType: rt.name, roomTypeCode: rt.code,
        ratePlanId: rp.id, ratePlan: rp.name, ratePlanCode: rp.code,
        derived: !!rp.parent_id,
        cells: dates.map((date) => {
          const resolved = resolveNightlyBase(pid(ctx), rt, rp, date, 1);
          const av = grid.find((c) => c.roomTypeId === rt.id && c.date === date);
          const r = byDate.get(date);
          return {
            date,
            priceMinor: resolved.minor,
            source: explicit.has(date) ? 'calendar' : resolved.source,
            available: av?.available ?? 0,
            sold: av?.sold ?? 0,
            physical: av?.physical ?? 0,
            occupancyBp: av?.occupancyBp ?? 0,
            minStay: r?.minStay ?? null,
            maxStay: r?.maxStay ?? null,
            cta: r?.cta ?? false,
            ctd: r?.ctd ?? false,
            stopSell: r?.stopSell ?? false,
            closeReason: r?.closeReason ?? null,
          };
        }),
      });
    }
  }
  return { from, to, dates, rows };
}, { perm: 'rates.read' });

// ─── Price planning ──────────────────────────────────────────
// Every price change goes through the same two steps: plan it, then apply the
// plan. The preview endpoint runs step one and stops, so what an operator is
// shown and what happens next cannot differ.

function readChange(ctx: Ctx): RateChangeInput {
  const b = ctx.body;
  return {
    from: assertDate(b.from, 'from'),
    to: assertDate(b.to, 'to'),
    roomTypeIds: b.roomTypeIds?.length ? b.roomTypeIds : undefined,
    ratePlanIds: b.ratePlanIds?.length ? b.ratePlanIds : undefined,
    daysOfWeek: b.daysOfWeek?.length ? b.daysOfWeek : undefined,
    priceMinor: b.priceMinor === undefined ? undefined : money(b.priceMinor, 'priceMinor'),
    adjustPercentBp: b.adjustPercentBp === undefined ? undefined
      : int(b.adjustPercentBp, 'adjustPercentBp', { min: -9_900, max: 100_000 }),
    // money() allows negatives, which is what an amount adjustment needs — a
    // rate can be moved down as well as up.
    adjustMinor: b.adjustMinor === undefined ? undefined : money(b.adjustMinor, 'adjustMinor'),
    occupancyPrices: b.occupancyPrices,
    extraAdultMinor: b.extraAdultMinor,
    extraChildMinor: b.extraChildMinor,
    losPrices: b.losPrices,
    floorMinor: b.floorMinor === undefined ? undefined : money(b.floorMinor, 'floorMinor'),
    ceilingMinor: b.ceilingMinor === undefined ? undefined : money(b.ceilingMinor, 'ceilingMinor'),
    reason: b.reason ? str(b.reason, 'reason', { max: 200 }) : undefined,
  };
}

/** What a change would do. Writes nothing. */
router.post('/api/rates/preview', (ctx: Ctx) => {
  const plan = planChange(pid(ctx), readChange(ctx));
  // The full cell list can be tens of thousands of rows; the screen needs the
  // shape of the change, not every cell in it.
  const { cells, ...summary } = plan;
  return { ...summary, sample: cells.slice(0, 60) };
}, { perm: 'rates.read' });

router.post('/api/rates/bulk', (ctx: Ctx) =>
  applyChange(pid(ctx), ctx.auth, readChange(ctx)), { perm: 'rates.write' });

// ─── Copy one period onto another ────────────────────────────
function readCopy(ctx: Ctx) {
  const b = ctx.body;
  return {
    sourceFrom: assertDate(b.sourceFrom, 'sourceFrom'),
    sourceTo: assertDate(b.sourceTo, 'sourceTo'),
    targetFrom: assertDate(b.targetFrom, 'targetFrom'),
    roomTypeIds: b.roomTypeIds?.length ? b.roomTypeIds : undefined,
    ratePlanIds: b.ratePlanIds?.length ? b.ratePlanIds : undefined,
    multiplierBp: b.multiplierBp === undefined ? undefined
      : int(b.multiplierBp, 'multiplierBp', { min: 1, max: 1_000_000 }),
    reason: b.reason ? str(b.reason, 'reason', { max: 200 }) : undefined,
  };
}

router.post('/api/rates/copy/preview', (ctx: Ctx) => {
  const plan = planCopy(pid(ctx), readCopy(ctx));
  const { cells, ...summary } = plan;
  return { ...summary, sample: cells.slice(0, 60) };
}, { perm: 'rates.read' });

router.post('/api/rates/copy', (ctx: Ctx) =>
  applyCopy(pid(ctx), ctx.auth, readCopy(ctx)), { perm: 'rates.write' });

// ─── Seasons ─────────────────────────────────────────────────
router.get('/api/seasons', (ctx: Ctx) => listSeasons(pid(ctx)), { perm: 'rates.read' });

router.post('/api/seasons', (ctx: Ctx) => upsertSeason(pid(ctx), ctx.auth, {
  name: str(ctx.body.name, 'name', { max: 60 }),
  colour: ctx.body.colour,
  from: ctx.body.from, to: ctx.body.to,
  priority: ctx.body.priority === undefined ? undefined
    : int(ctx.body.priority, 'priority', { min: 0, max: 100 }),
  note: ctx.body.note,
  active: ctx.body.active,
}), { perm: 'rates.write' });

router.patch('/api/seasons/:id', (ctx: Ctx) => upsertSeason(pid(ctx), ctx.auth, {
  id: ctx.params.id,
  name: str(ctx.body.name, 'name', { max: 60 }),
  colour: ctx.body.colour,
  from: ctx.body.from, to: ctx.body.to,
  priority: ctx.body.priority === undefined ? undefined
    : int(ctx.body.priority, 'priority', { min: 0, max: 100 }),
  note: ctx.body.note,
  active: ctx.body.active,
}), { perm: 'rates.write' });

router.delete('/api/seasons/:id', (ctx: Ctx) =>
  deleteSeason(pid(ctx), ctx.auth, ctx.params.id), { perm: 'rates.write' });

// ─── Scheduled changes ───────────────────────────────────────
router.get('/api/rates/scheduled', (ctx: Ctx) => listScheduledChanges(
  pid(ctx),
  get<{ business_date: string }>('SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date,
), { perm: 'rates.read' });

router.post('/api/rates/scheduled', (ctx: Ctx) => scheduleChange(pid(ctx), ctx.auth, {
  name: str(ctx.body.name, 'name', { max: 80 }),
  effectiveDate: ctx.body.effectiveDate,
  change: readChange(ctx),
}), { perm: 'rates.write' });

router.delete('/api/rates/scheduled/:id', (ctx: Ctx) =>
  cancelScheduledChange(pid(ctx), ctx.auth, ctx.params.id), { perm: 'rates.write' });

/** Run anything due now rather than waiting for the next night audit. */
router.post('/api/rates/scheduled/run', (ctx: Ctx) => runDueScheduledChanges(
  pid(ctx), ctx.auth,
  get<{ business_date: string }>('SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date,
), { perm: 'rates.write' });

// ─── Rate change history ─────────────────────────────────────
router.get('/api/rates/history', (ctx: Ctx) => rateHistory(pid(ctx), {
  roomTypeId: ctx.query.get('roomTypeId') ?? undefined,
  ratePlanId: ctx.query.get('ratePlanId') ?? undefined,
  date: ctx.query.get('date') ?? undefined,
  from: ctx.query.get('from') ?? undefined,
  to: ctx.query.get('to') ?? undefined,
  limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
}), { perm: 'rates.read' });

/** Set / clear inventory holds and overbooking allowance for a range. */
router.post('/api/inventory/adjust', (ctx: Ctx) => tx(() => {
  const b = ctx.body;
  const from = assertDate(b.from, 'from');
  const to = assertDate(b.to, 'to');
  const roomTypeId = str(b.roomTypeId, 'roomTypeId');
  let n = 0;
  for (const date of dateRangeInclusive(from, to)) {
    run(
      `INSERT INTO inventory_adjustments(id, property_id, room_type_id, date, overbook, hold, note, updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(property_id, room_type_id, date) DO UPDATE SET
         overbook = excluded.overbook, hold = excluded.hold, note = excluded.note,
         updated_at = excluded.updated_at`,
      id('iad'), pid(ctx), roomTypeId, date,
      int(b.overbook ?? 0, 'overbook', { min: 0, max: 500 }),
      int(b.hold ?? 0, 'hold', { min: 0, max: 500 }),
      b.note ?? null, nowIso(),
    );
    n++;
  }
  audit(ctx.auth, {
    action: 'inventory.adjust', entity: 'ROOM_TYPE', entityId: roomTypeId,
    after: { from, to, overbook: b.overbook, hold: b.hold },
  }, ctx.ip);
  // Tell the channels. A hold is not a note to ourselves — availability is
  // `physical − blocked − sold − groupHeld − hold + overbook`, so withholding
  // two beds here makes Helio sell six while the OTA carries on selling eight.
  // That gap closes itself the moment somebody books the beds that Helio does
  // not believe exist, which is the definition of an overbooking. The overbook
  // allowance has the same problem pointing the other way: rooms deliberately
  // released for oversell never reach the channel that was meant to sell them.
  //
  // `to` is inclusive here — `dateRangeInclusive` above writes a row for it —
  // and the queue's end is exclusive, so the last adjusted night needs the +1.
  queueChannelPush(pid(ctx), roomTypeId, from, addDays(to, 1), 'inventory.adjust');
  return { updated: n };
}), { perm: 'rates.write' });

// ─── Close-outs ──────────────────────────────────────────────
// Closing and reopening dates for sale. These sit on top of the same
// `stop-sell` restriction the engine already understands — what they add is
// the operator's vocabulary: a date range, a reason, and one action.

/** Scope is optional on every axis; omitting one means "all of them". */
function closeScope(ctx: Ctx) {
  const b = ctx.body;
  return {
    roomTypeId: b.roomTypeId ? str(b.roomTypeId, 'roomTypeId') : null,
    ratePlanId: b.ratePlanId ? str(b.ratePlanId, 'ratePlanId') : null,
    channelCode: b.channelCode ? str(b.channelCode, 'channelCode') : null,
    from: assertDate(b.from, 'from'),
    to: assertDate(b.to, 'to'),
    reason: b.reason ? str(b.reason, 'reason', { max: 200 }) : undefined,
  };
}

router.get('/api/closeouts', (ctx: Ctx) => {
  const today = get<{ business_date: string }>(
    'SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;
  const list = closeoutList(pid(ctx), today);
  return {
    closeouts: ctx.query.get('includeExpired') === '1' ? list : list.filter((c) => !c.expired),
    expiredCount: list.filter((c) => c.expired).length,
    // Anything still queued has not reached the OTAs yet. The screen says so
    // rather than implying a closure is live everywhere the moment it is saved.
    pendingPushes: scalar<number>(
      `SELECT count(*) AS n FROM channel_queue WHERE property_id = ? AND status = 'queued'`,
      pid(ctx),
    ),
    failedPushes: scalar<number>(
      `SELECT count(*) AS n FROM channel_queue WHERE property_id = ? AND status = 'failed'`,
      pid(ctx),
    ),
  };
}, { perm: 'rates.read' });

router.post('/api/closeouts/close', (ctx: Ctx) =>
  closeDates(pid(ctx), ctx.auth, closeScope(ctx)), { perm: 'rates.write' });

router.post('/api/closeouts/open', (ctx: Ctx) =>
  openDates(pid(ctx), ctx.auth, closeScope(ctx)), { perm: 'rates.write' });

/** Reopen exactly one closure, by id — the close-out list's one-click undo. */
router.post('/api/closeouts/:id/open', (ctx: Ctx) => {
  const row = get<any>(
    `SELECT * FROM restrictions WHERE id = ? AND property_id = ? AND type = 'stop-sell'`,
    ctx.params.id, pid(ctx),
  );
  if (!row) notFound('Closure');
  return openDates(pid(ctx), ctx.auth, {
    roomTypeId: row.room_type_id, ratePlanId: row.rate_plan_id, channelCode: row.channel_code,
    from: row.date_from, to: row.date_to,
  });
}, { perm: 'rates.write' });

router.post('/api/closeouts/purge-expired', (ctx: Ctx) => {
  const today = get<{ business_date: string }>(
    'SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;
  const removed = purgeExpiredCloseouts(pid(ctx), today);
  audit(ctx.auth, {
    action: 'inventory.open', entity: 'RESTRICTION',
    entityRef: `purged ${removed} expired closure(s)`, after: { removed, before: today },
  }, ctx.ip);
  return { removed };
}, { perm: 'rates.write' });

// ─── Restrictions ────────────────────────────────────────────
router.get('/api/restrictions', (ctx: Ctx) => all<any>(
  `SELECT r.*, rt.name AS room_type_name, rt.code AS room_type_code,
          rp.code AS rate_plan_code
     FROM restrictions r
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN rate_plans rp ON rp.id = r.rate_plan_id
    WHERE r.property_id = ? ORDER BY r.date_from DESC`,
  pid(ctx),
).map((r) => ({
  id: r.id, roomTypeId: r.room_type_id, roomType: r.room_type_name ?? 'All room types',
  ratePlanId: r.rate_plan_id, ratePlan: r.rate_plan_code ?? 'All rate plans',
  channelCode: r.channel_code, dateFrom: r.date_from, dateTo: r.date_to,
  type: r.type, value: r.value, note: r.note, active: r.active === 1,
  createdBy: r.created_by, createdAt: r.created_at,
})), { perm: 'rates.read' });

const RESTRICTION_TYPES = [
  'stop-sell', 'min-stay', 'max-stay', 'min-stay-through', 'cta', 'ctd',
  'min-advance', 'max-advance', 'release',
] as const;

router.post('/api/restrictions', (ctx: Ctx) => {
  const b = ctx.body;
  const type = oneOf(b.type, 'type', RESTRICTION_TYPES);
  const needsValue = ['min-stay', 'max-stay', 'min-stay-through', 'min-advance', 'max-advance', 'release'];
  if (needsValue.includes(type) && (b.value === undefined || b.value === null)) {
    throw new HttpError(400, `A ${type} restriction needs a value`);
  }
  const rId = id('rst');

  // Who the rule is aimed at.
  //
  // A stop-sell written from a calendar almost always means "take this off the
  // OTAs", not "nobody may sell this" — so that is the default for a closure.
  // The worst outcome then is a room the desk can still sell; the alternative
  // is a guest turned away from a room standing empty.
  //
  // Every other restriction type keeps the blanket meaning: a min-stay the
  // front desk quietly ignores is a min-stay that does not exist.
  const appliesTo = oneOf(
    b.appliesTo ?? (type === 'stop-sell' ? 'channels' : 'all'),
    'appliesTo', ['channels', 'all', 'direct'],
  );

  run(
    `INSERT INTO restrictions(id, property_id, room_type_id, rate_plan_id, channel_code,
                              date_from, date_to, type, value, note, applies_to,
                              active, created_by, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    rId, pid(ctx), b.roomTypeId ?? null, b.ratePlanId ?? null, b.channelCode ?? null,
    assertDate(b.dateFrom, 'dateFrom'), assertDate(b.dateTo, 'dateTo'), type,
    b.value === undefined || b.value === null ? null : int(b.value, 'value', { min: 0, max: 999 }),
    b.note ?? null, appliesTo, b.active === false ? 0 : 1, ctx.auth.userName, nowIso(),
  );
  audit(ctx.auth, {
    action: 'restriction.create', entity: 'RESTRICTION', entityId: rId,
    entityRef: `${type} ${b.dateFrom}→${b.dateTo}`, after: b, channel: b.channelCode,
  }, ctx.ip);
  pushRestriction(pid(ctx), b.roomTypeId ?? null, b.dateFrom, b.dateTo, `restriction.${type}`);
  return { id: rId };
}, { perm: 'rates.write' });

/**
 * Tell the channels a selling rule changed.
 *
 * This was missing entirely, and it is the whole of "open/close does not work":
 * closing dates wrote a row in `restrictions`, Helio refused to sell them, and
 * **nothing was ever sent to Beds24** — so the OTAs carried on selling rooms the
 * property had shut. The reverse was worse: reopening dates left them closed on
 * the OTAs, and the property silently lost the sales it had just reopened for.
 *
 * A rule with no room type applies to every room type, so every one of them has
 * to be pushed — the ARI grid is built per room type and there is no "all"
 * entry to send.
 */
function pushRestriction(
  propertyId: string, roomTypeId: string | null, from: string, to: string, reason: string,
) {
  const ids = roomTypeId
    ? [roomTypeId]
    : all<{ id: string }>(
      'SELECT id FROM room_types WHERE property_id = ? AND active = 1', propertyId,
    ).map((r) => r.id);
  for (const rtId of ids) {
    // `to` is inclusive on a restriction and exclusive on the queue.
    queueChannelPush(propertyId, rtId, from, addDays(to, 1), reason);
  }
}

router.patch('/api/restrictions/:id', (ctx: Ctx) => {
  const before = get<any>('SELECT * FROM restrictions WHERE id = ? AND property_id = ?',
    ctx.params.id, pid(ctx));
  if (!before) notFound('Restriction');
  const sets: string[] = [];
  const args: unknown[] = [];
  if (ctx.body.value !== undefined) { sets.push('value = ?'); args.push(ctx.body.value); }
  if (ctx.body.dateFrom !== undefined) { sets.push('date_from = ?'); args.push(ctx.body.dateFrom); }
  if (ctx.body.dateTo !== undefined) { sets.push('date_to = ?'); args.push(ctx.body.dateTo); }
  if (ctx.body.active !== undefined) { sets.push('active = ?'); args.push(ctx.body.active ? 1 : 0); }
  if (ctx.body.note !== undefined) { sets.push('note = ?'); args.push(ctx.body.note); }
  if (!sets.length) return { ok: true };
  args.push(ctx.params.id);
  run(`UPDATE restrictions SET ${sets.join(', ')} WHERE id = ?`, ...args);
  audit(ctx.auth, {
    action: 'restriction.update', entity: 'RESTRICTION', entityId: ctx.params.id,
    before: { active: before.active === 1, value: before.value }, after: ctx.body,
  }, ctx.ip);
  // Both ranges. Moving a closure from next week to this one has to reopen the
  // dates it left as well as close the ones it arrived on — pushing only the
  // new range leaves the old dates shut on the OTAs forever.
  pushRestriction(pid(ctx), before.room_type_id, before.date_from, before.date_to,
    'restriction.update');
  const nowFrom = ctx.body.dateFrom ?? before.date_from;
  const nowTo = ctx.body.dateTo ?? before.date_to;
  if (nowFrom !== before.date_from || nowTo !== before.date_to) {
    pushRestriction(pid(ctx), before.room_type_id, nowFrom, nowTo, 'restriction.update');
  }
  return { ok: true };
}, { perm: 'rates.write' });

router.delete('/api/restrictions/:id', (ctx: Ctx) => {
  // Read it before it is gone — the dates being reopened are the whole point of
  // the push, and after the DELETE there is nothing left to say which they were.
  const before = get<any>('SELECT * FROM restrictions WHERE id = ? AND property_id = ?',
    ctx.params.id, pid(ctx));
  run('DELETE FROM restrictions WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  audit(ctx.auth, { action: 'restriction.delete', entity: 'RESTRICTION', entityId: ctx.params.id }, ctx.ip);
  if (before) {
    pushRestriction(pid(ctx), before.room_type_id, before.date_from, before.date_to,
      'restriction.delete');
  }
  return { ok: true };
}, { perm: 'rates.write' });

router.get('/api/restrictions/grid', (ctx: Ctx) => {
  const { from, to } = range(ctx);
  const roomTypeId = str(ctx.query.get('roomTypeId'), 'roomTypeId');
  return restrictionGrid(pid(ctx), roomTypeId, ctx.query.get('ratePlanId'), from, to,
    ctx.query.get('channelCode'));
}, { perm: 'rates.read' });

// ─── Yield rules ─────────────────────────────────────────────
router.get('/api/yield-rules', (ctx: Ctx) => all<any>(
  `SELECT y.*, rp.code AS rate_plan_code, rt.name AS room_type_name
     FROM yield_rules y
     LEFT JOIN rate_plans rp ON rp.id = y.rate_plan_id
     LEFT JOIN room_types rt ON rt.id = y.room_type_id
    WHERE y.property_id = ? ORDER BY y.priority DESC, y.name`,
  pid(ctx),
).map((y) => ({
  id: y.id, name: y.name, active: y.active === 1, metric: y.metric, operator: y.operator,
  threshold: y.threshold, secondaryMetric: y.secondary_metric,
  secondaryOperator: y.secondary_operator, secondaryThreshold: y.secondary_threshold,
  adjustType: y.adjust_type, adjustValue: y.adjust_value,
  ratePlanId: y.rate_plan_id, ratePlan: y.rate_plan_code ?? 'All rate plans',
  roomTypeId: y.room_type_id, roomType: y.room_type_name ?? 'All room types',
  priority: y.priority, appliedCount: y.applied_count,
})), { perm: 'rates.read' });

router.post('/api/yield-rules', (ctx: Ctx) => {
  const b = ctx.body;
  const yId = id('yld');
  run(
    `INSERT INTO yield_rules(id, property_id, name, active, metric, operator, threshold,
                             secondary_metric, secondary_operator, secondary_threshold,
                             adjust_type, adjust_value, rate_plan_id, room_type_id, priority, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    yId, pid(ctx), str(b.name, 'name', { max: 80 }), b.active === false ? 0 : 1,
    oneOf(b.metric, 'metric', ['occupancy', 'lead_time', 'dow', 'los'] as const),
    oneOf(b.operator, 'operator', ['gt', 'lt', 'gte', 'lte', 'eq', 'in'] as const),
    String(b.threshold),
    b.secondaryMetric ?? null, b.secondaryOperator ?? null,
    b.secondaryThreshold === undefined || b.secondaryThreshold === null ? null : String(b.secondaryThreshold),
    oneOf(b.adjustType, 'adjustType', ['percent', 'fixed'] as const),
    int(b.adjustValue, 'adjustValue'),
    b.ratePlanId ?? null, b.roomTypeId ?? null, int(b.priority ?? 0, 'priority'), nowIso(),
  );
  audit(ctx.auth, { action: 'yield.create', entity: 'YIELD_RULE', entityId: yId, entityRef: b.name, after: b }, ctx.ip);
  return { id: yId };
}, { perm: 'rates.write' });

router.patch('/api/yield-rules/:id', (ctx: Ctx) => {
  const map: Record<string, string> = {
    name: 'name', metric: 'metric', operator: 'operator', threshold: 'threshold',
    adjustType: 'adjust_type', adjustValue: 'adjust_value', priority: 'priority',
    ratePlanId: 'rate_plan_id', roomTypeId: 'room_type_id',
  };
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (ctx.body[k] !== undefined) { sets.push(`${col} = ?`); args.push(String(ctx.body[k])); }
  }
  if (ctx.body.active !== undefined) { sets.push('active = ?'); args.push(ctx.body.active ? 1 : 0); }
  if (!sets.length) return { ok: true };
  args.push(ctx.params.id, pid(ctx));
  run(`UPDATE yield_rules SET ${sets.join(', ')} WHERE id = ? AND property_id = ?`, ...args);
  audit(ctx.auth, { action: 'yield.update', entity: 'YIELD_RULE', entityId: ctx.params.id, after: ctx.body }, ctx.ip);
  return { ok: true };
}, { perm: 'rates.write' });

router.delete('/api/yield-rules/:id', (ctx: Ctx) => {
  run('DELETE FROM yield_rules WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  return { ok: true };
}, { perm: 'rates.write' });

// ─── Promotions ──────────────────────────────────────────────
router.get('/api/promotions', (ctx: Ctx) => all<any>(
  'SELECT * FROM promotions WHERE property_id = ? ORDER BY active DESC, code', pid(ctx),
).map((p) => ({
  id: p.id, code: p.code, name: p.name, kind: p.kind,
  discountType: p.discount_type, discountValue: p.discount_value,
  stayFrom: p.stay_from, stayTo: p.stay_to, bookFrom: p.book_from, bookTo: p.book_to,
  minLos: p.min_los, maxLos: p.max_los, minAdvance: p.min_advance, maxAdvance: p.max_advance,
  ratePlanIds: parseJson<string[]>(p.rate_plan_ids, []),
  channels: parseJson<string[]>(p.channels, []),
  deliveryMode: p.delivery_mode, usageLimit: p.usage_limit, usedCount: p.used_count,
  active: p.active === 1,
})), { perm: 'rates.read' });

router.post('/api/promotions', (ctx: Ctx) => {
  const b = ctx.body;
  const promoId = id('pmo');
  run(
    `INSERT INTO promotions(id, property_id, code, name, kind, discount_type, discount_value,
                            stay_from, stay_to, book_from, book_to, min_los, max_los,
                            min_advance, max_advance, rate_plan_ids, channels, delivery_mode,
                            usage_limit, used_count, active, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    promoId, pid(ctx), slugCode(b.code, 'code', 24), str(b.name, 'name', { max: 80 }),
    oneOf(b.kind, 'kind', ['basic', 'early_bird', 'last_minute', 'long_stay'] as const, 'basic'),
    oneOf(b.discountType, 'discountType', ['percent', 'fixed'] as const),
    int(b.discountValue, 'discountValue', { min: 0 }),
    b.stayFrom ?? null, b.stayTo ?? null, b.bookFrom ?? null, b.bookTo ?? null,
    b.minLos ?? null, b.maxLos ?? null, b.minAdvance ?? null, b.maxAdvance ?? null,
    jsonCol(b.ratePlanIds ?? []), jsonCol(b.channels ?? []),
    // OTA discounts must be delivered as a price or a native promotion, never
    // as a discount rule the channel cannot interpret.
    oneOf(b.deliveryMode, 'deliveryMode', ['price', 'native_promo'] as const, 'price'),
    int(b.usageLimit ?? 0, 'usageLimit', { min: 0 }),
    b.active === false ? 0 : 1, nowIso(),
  );
  audit(ctx.auth, { action: 'promo.create', entity: 'PROMOTION', entityId: promoId, entityRef: b.code, after: b }, ctx.ip);
  return { id: promoId };
}, { perm: 'rates.write' });

router.patch('/api/promotions/:id', (ctx: Ctx) => {
  const before = get<any>('SELECT * FROM promotions WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  if (!before) notFound('Promotion');
  const map: Record<string, string> = {
    name: 'name', discountType: 'discount_type', discountValue: 'discount_value',
    stayFrom: 'stay_from', stayTo: 'stay_to', bookFrom: 'book_from', bookTo: 'book_to',
    minLos: 'min_los', maxLos: 'max_los', minAdvance: 'min_advance', maxAdvance: 'max_advance',
    deliveryMode: 'delivery_mode', usageLimit: 'usage_limit',
  };
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (ctx.body[k] !== undefined) { sets.push(`${col} = ?`); args.push(ctx.body[k]); }
  }
  if (ctx.body.channels !== undefined) { sets.push('channels = ?'); args.push(jsonCol(ctx.body.channels)); }
  if (ctx.body.ratePlanIds !== undefined) { sets.push('rate_plan_ids = ?'); args.push(jsonCol(ctx.body.ratePlanIds)); }
  if (ctx.body.active !== undefined) { sets.push('active = ?'); args.push(ctx.body.active ? 1 : 0); }
  if (!sets.length) return { ok: true };
  args.push(ctx.params.id);
  run(`UPDATE promotions SET ${sets.join(', ')} WHERE id = ?`, ...args);
  audit(ctx.auth, {
    action: 'promo.update', entity: 'PROMOTION', entityId: ctx.params.id, entityRef: before.code,
    before: { active: before.active === 1 }, after: ctx.body,
  }, ctx.ip);
  return { ok: true };
}, { perm: 'rates.write' });

// ─── Quote (the booking engine's price + rules check) ────────
router.post('/api/rates/quote', (ctx: Ctx) => {
  const b = ctx.body;
  const arrival = assertDate(b.arrival, 'arrival');
  const departure = assertDate(b.departure, 'departure');
  const prop = get<any>('SELECT * FROM properties WHERE id = ?', pid(ctx));
  const adults = int(b.adults ?? 1, 'adults', { min: 1, max: 40 });
  const children = int(b.children ?? 0, 'children', { min: 0, max: 20 });

  const roomTypes = b.roomTypeId
    ? all<any>('SELECT * FROM room_types WHERE id = ? AND property_id = ?', b.roomTypeId, pid(ctx))
    : all<any>('SELECT * FROM room_types WHERE property_id = ? AND active = 1 ORDER BY sort_order', pid(ctx));
  const plans = b.ratePlanId
    ? all<any>('SELECT * FROM rate_plans WHERE id = ? AND property_id = ?', b.ratePlanId, pid(ctx))
    : all<any>('SELECT * FROM rate_plans WHERE property_id = ? AND active = 1 ORDER BY sort_order', pid(ctx));

  const grid = availabilityGrid(pid(ctx), arrival, departure);
  const options: any[] = [];
  for (const rt of roomTypes) {
    const minAvailable = Math.min(
      ...grid.filter((c) => c.roomTypeId === rt.id).map((c) => c.available),
    );
    for (const rp of plans) {
      const violations = validateStay(pid(ctx), {
        roomTypeId: rt.id, ratePlanId: rp.id, arrival, departure,
        channelCode: b.channelCode ?? null, bookedOn: prop.business_date,
      });
      let quote;
      try {
        quote = quoteStay(pid(ctx), {
          roomTypeId: rt.id, ratePlanId: rp.id, arrival, departure, adults, children,
          channelCode: b.channelCode ?? null, promotionCode: b.promotionCode ?? null,
          bookedOn: prop.business_date, currency: prop.currency,
        });
      } catch (e) {
        continue;
      }
      options.push({
        roomTypeId: rt.id, roomType: rt.name, roomTypeCode: rt.code, kind: rt.kind,
        maxOccupancy: rt.max_occupancy,
        ratePlanId: rp.id, ratePlan: rp.name, ratePlanCode: rp.code,
        refundable: rp.refundable === 1,
        inclusions: parseJson<string[]>(rp.inclusions, []),
        available: Number.isFinite(minAvailable) ? minAvailable : 0,
        sellable: violations.length === 0 && minAvailable > 0
          && adults + children <= (rt.kind === 'dorm' ? 40 : rt.max_occupancy),
        violations,
        nights: quote.nights,
        roomTotalMinor: quote.roomTotalMinor,
        taxes: quote.taxes,
        taxTotalMinor: quote.taxTotalMinor,
        grandTotalMinor: quote.grandTotalMinor,
        averageNightlyMinor: quote.nights.length
          ? Math.round(quote.roomTotalMinor / quote.nights.length) : 0,
        promotionCode: quote.promotionCode,
      });
    }
  }
  return {
    arrival, departure, nights: nightsBetween(arrival, departure),
    adults, children, currency: prop.currency, options,
    availablePromotions: b.ratePlanId
      ? eligiblePromotions(pid(ctx), {
        ratePlanId: b.ratePlanId, arrival, departure,
        channelCode: b.channelCode ?? null, bookedOn: prop.business_date,
      }).map((p) => ({ code: p.code, name: p.name, discountType: p.discount_type, discountValue: p.discount_value }))
      : [],
    taxes: activeTaxes(pid(ctx)).map((t) => ({ code: t.code, name: t.name, mode: t.mode, value: t.value })),
  };
}, { perm: 'reservations.read' });
