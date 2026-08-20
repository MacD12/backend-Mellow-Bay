// Overbooking control and the alert feed.
//
// The feed endpoint is the one the whole app polls, so it is deliberately
// cheap: a `since` timestamp in, the events after it out. Everything the
// browser needs to decide whether to make a noise comes back with it, so the
// alarm never needs a second round trip to find out whether it is muted.
import { router, type Ctx } from '../lib/http.ts';
import { get, run, scalar } from '../db.ts';
import { str, int, assertDate, addDays, notFound, HttpError } from '../lib/util.ts';
import {
  scan, scanAndRecord, listFindings, summary, acknowledge, resolveFinding,
  datesNeedingClosure, describeCause, getFinding, guardInventory,
} from '../services/overbooking.ts';
import { resolutionOptions, applyFix, fixCosts } from '../services/overbookingfix.ts';
import { walkCandidates, walkGuest, walkCosts } from '../services/walking.ts';
import { exposureReport } from '../services/exposure.ts';
import { audit } from '../services/audit.ts';
import {
  feed, alertSettings, saveAlertSettings, acknowledgeAlert, acknowledgeAll,
  ALERT_KINDS, type AlertKind,
} from '../services/alerts.ts';

const pid = (ctx: Ctx) => ctx.auth.propertyId;
const businessDate = (ctx: Ctx) => get<{ business_date: string }>(
  'SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;

// ─── Detection ───────────────────────────────────────────────

/** What is wrong right now, worst first. */
router.get('/api/overbookings', (ctx: Ctx) => {
  const today = businessDate(ctx);
  return {
    findings: listFindings(pid(ctx), today, {
      status: ctx.query.get('status') ?? 'open',
      includeAtRisk: ctx.query.get('includeAtRisk') === '1',
    }),
    summary: summary(pid(ctx), today),
  };
}, { perm: 'reservations.read' });

/** A dry look — writes nothing, records nothing. */
router.get('/api/overbookings/scan', (ctx: Ctx) => {
  const today = businessDate(ctx);
  const from = ctx.query.get('from') ? assertDate(ctx.query.get('from'), 'from') : today;
  const to = ctx.query.get('to') ? assertDate(ctx.query.get('to'), 'to') : addDays(today, 180);
  const findings = scan(pid(ctx), from, to, today);
  return {
    from, to,
    findings: findings.map((f) => ({ ...f, causeText: describeCause(f.cause) })),
  };
}, { perm: 'reservations.read' });

router.post('/api/overbookings/scan', (ctx: Ctx) => {
  const today = businessDate(ctx);
  return scanAndRecord(pid(ctx), ctx.auth, {
    from: ctx.body.from, to: ctx.body.to, today,
  });
}, { perm: 'reservations.write' });

router.post('/api/overbookings/:id/acknowledge', (ctx: Ctx) =>
  acknowledge(pid(ctx), ctx.auth, ctx.params.id), { perm: 'reservations.read' });

router.post('/api/overbookings/:id/resolve', (ctx: Ctx) =>
  resolveFinding(pid(ctx), ctx.auth, ctx.params.id,
    str(ctx.body.resolution, 'resolution', { max: 120 }),
    ctx.body.note ? str(ctx.body.note, 'note', { max: 400 }) : undefined),
  { perm: 'reservations.write' });

/** The dates that ought to be shut on the OTAs, and why. */
router.get('/api/overbookings/closures', (ctx: Ctx) =>
  ({ dates: datesNeedingClosure(pid(ctx), businessDate(ctx)) }), { perm: 'rates.read' });

// ─── Fixing without a walk ───────────────────────────────────

/** Who can be moved, and where to — per guest, for their whole remaining stay. */
router.get('/api/overbookings/:id/options', (ctx: Ctx) =>
  resolutionOptions(pid(ctx), ctx.params.id, businessDate(ctx)), { perm: 'frontdesk.read' });

router.post('/api/overbookings/:id/fix', (ctx: Ctx) => applyFix(pid(ctx), ctx.auth, {
  findingId: ctx.params.id,
  reservationId: str(ctx.body.reservationId, 'reservationId'),
  roomId: str(ctx.body.roomId, 'roomId'),
  kind: ctx.body.kind === 'upgrade' ? 'upgrade'
    : ctx.body.kind === 'downgrade' ? 'downgrade' : 'reassign',
  compensationMinor: ctx.body.compensationMinor === undefined
    ? undefined : int(ctx.body.compensationMinor, 'compensationMinor', { min: 0, max: 10_000_000 }),
  note: ctx.body.note ? str(ctx.body.note, 'note', { max: 300 }) : undefined,
}), { perm: 'frontdesk.write' });

/** What the courtesies have cost — upgrades given away and compensation paid. */
router.get('/api/overbookings/costs', (ctx: Ctx) => {
  const today = businessDate(ctx);
  return fixCosts(
    pid(ctx),
    ctx.query.get('from') ? assertDate(ctx.query.get('from'), 'from') : addDays(today, -90),
    ctx.query.get('to') ? assertDate(ctx.query.get('to'), 'to') : today,
  );
}, { perm: 'reports.read' });

// ─── Walking, the last resort ────────────────────────────────

/**
 * Who to walk, least-harmed first, with the reasoning shown.
 *
 * A suggestion, never a decision. Who gets sent to another hotel is a judgement
 * about people and it stays with the person making it.
 */
router.get('/api/overbookings/:id/walk-candidates', (ctx: Ctx) => {
  const finding = getFinding(pid(ctx), ctx.params.id);
  return {
    date: finding.date,
    oversold: finding.oversold,
    candidates: walkCandidates(pid(ctx), finding.date, finding.room_type_id, businessDate(ctx)),
  };
}, { perm: 'frontdesk.read' });

router.post('/api/reservations/:id/walk', (ctx: Ctx) => walkGuest(pid(ctx), ctx.auth, {
  reservationId: ctx.params.id,
  findingId: ctx.body.findingId ? str(ctx.body.findingId, 'findingId') : undefined,
  date: ctx.body.date ? assertDate(ctx.body.date, 'date') : undefined,
  nights: ctx.body.nights === undefined
    ? undefined : int(ctx.body.nights, 'nights', { min: 1, max: 30 }),
  hotelName: str(ctx.body.hotelName, 'hotelName', { max: 120 }),
  hotelPhone: ctx.body.hotelPhone ? str(ctx.body.hotelPhone, 'hotelPhone', { max: 40 }) : undefined,
  roomCostMinor: ctx.body.roomCostMinor === undefined
    ? undefined : int(ctx.body.roomCostMinor, 'roomCostMinor', { min: 0, max: 100_000_000 }),
  transportCostMinor: ctx.body.transportCostMinor === undefined
    ? undefined : int(ctx.body.transportCostMinor, 'transportCostMinor', { min: 0, max: 10_000_000 }),
  compensationMinor: ctx.body.compensationMinor === undefined
    ? undefined : int(ctx.body.compensationMinor, 'compensationMinor', { min: 0, max: 100_000_000 }),
  returnsLater: ctx.body.returnsLater === true,
  reason: ctx.body.reason ? str(ctx.body.reason, 'reason', { max: 300 }) : undefined,
}), { perm: 'frontdesk.write' });

/** What overbooking actually cost — the number that should set the allowance. */
router.get('/api/walks', (ctx: Ctx) => {
  const today = businessDate(ctx);
  return walkCosts(
    pid(ctx),
    ctx.query.get('from') ? assertDate(ctx.query.get('from'), 'from') : addDays(today, -365),
    ctx.query.get('to') ? assertDate(ctx.query.get('to'), 'to') : today,
  );
}, { perm: 'reports.read' });

// ─── Exposure and last-room protection ───────────────────────

/**
 * How exposed the property is to the race, measured rather than guessed.
 *
 * This exists so the last-room setting below is a decision against the
 * property's own numbers instead of a feeling about how often it happens.
 */
router.get('/api/exposure', (ctx: Ctx) => {
  const today = businessDate(ctx);
  return exposureReport(
    pid(ctx),
    ctx.query.get('from') ? assertDate(ctx.query.get('from'), 'from') : addDays(today, -90),
    ctx.query.get('to') ? assertDate(ctx.query.get('to'), 'to') : today,
  );
}, { perm: 'reports.read' });

/** Hold back the last N rooms of a type from the channels. 0 sells everything. */
router.put('/api/room-types/:id/protection', (ctx: Ctx) => {
  const roomType = get<{ id: string; name: string; protect_last_rooms: number }>(
    'SELECT id, name, protect_last_rooms FROM room_types WHERE id = ? AND property_id = ?',
    ctx.params.id, pid(ctx),
  );
  if (!roomType) notFound('Room type');
  const rooms = scalar<number>(
    'SELECT count(*) AS n FROM rooms WHERE room_type_id = ? AND active = 1', ctx.params.id);
  const protect = int(ctx.body.protectLastRooms, 'protectLastRooms', { min: 0, max: 99 });
  if (protect >= rooms && rooms > 0) {
    // Holding back every room is not protection, it is a stop-sell. If that is
    // what somebody wants, the close-out tools say so honestly.
    throw new HttpError(400,
      `${roomType.name} has ${rooms} room(s). Holding back ${protect} would take the type off `
      + 'sale entirely — close the dates instead if that is the intention.');
  }

  run('UPDATE room_types SET protect_last_rooms = ? WHERE id = ?', protect, ctx.params.id);
  audit(ctx.auth, {
    action: 'inventory.protection', entity: 'ROOM_TYPE', entityId: ctx.params.id,
    entityRef: roomType.name,
    before: { protectLastRooms: roomType.protect_last_rooms },
    after: { protectLastRooms: protect },
    elevated: true,
  }, ctx.ip);

  // Applying it now rather than at the next booking: a property that just
  // switched protection on expects the affected dates to shut immediately.
  const today = businessDate(ctx);
  const guarded = guardInventory(pid(ctx), ctx.auth, {
    roomTypeId: ctx.params.id, from: today, to: addDays(today, 180), today,
  });

  return { protectLastRooms: protect, rooms, datesClosed: guarded.datesClosed };
}, { perm: 'rates.write' });

// ─── Alerts ──────────────────────────────────────────────────

/**
 * The feed.
 *
 * Called with `?since=<iso>` the answer is only what is new, and the browser
 * may sound the alarm for it. Called without, it is a replay for display and
 * the browser stays silent — which is why refreshing the page does not set off
 * a klaxon for something that happened this morning.
 */
router.get('/api/alerts', (ctx: Ctx) => feed(pid(ctx), {
  since: ctx.query.get('since') ?? undefined,
  limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
}), { perm: 'reservations.read' });

router.post('/api/alerts/:id/acknowledge', (ctx: Ctx) =>
  acknowledgeAlert(pid(ctx), ctx.auth, ctx.params.id), { perm: 'reservations.read' });

/** Silences a repeating alarm in one action, which is what a person wants. */
router.post('/api/alerts/acknowledge-all', (ctx: Ctx) => acknowledgeAll(
  pid(ctx), ctx.auth,
  ctx.body.kind && ALERT_KINDS.includes(ctx.body.kind)
    ? (ctx.body.kind as AlertKind) : undefined,
), { perm: 'reservations.read' });

// ─── Alert settings ──────────────────────────────────────────

router.get('/api/alert-settings', (ctx: Ctx) =>
  alertSettings(pid(ctx)), { perm: 'config.read' });

router.put('/api/alert-settings', (ctx: Ctx) => saveAlertSettings(pid(ctx), ctx.auth, {
  overbooking: ctx.body.overbooking,
  'booking.new': ctx.body['booking.new'],
  'booking.cancelled': ctx.body['booking.cancelled'],
  volume: ctx.body.volume === undefined
    ? undefined : int(ctx.body.volume, 'volume', { min: 0, max: 100 }),
  quietHours: ctx.body.quietHours,
}), { perm: 'config.write' });
