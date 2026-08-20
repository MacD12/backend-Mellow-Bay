// Dashboard and reporting endpoints. Every number here is derived from the
// ledger or the frozen night-audit statistics — none of it is stored twice.
import { router, type Ctx } from '../lib/http.ts';
import { all, get, scalar } from '../db.ts';
import { addDays, assertDate, oneOf, HttpError, nightsBetween } from '../lib/util.ts';
import {
  kpiSeries, kpiSummary, todaySnapshot, production, bookingPace, pickup,
  revenueBreakdown, frontDeskLists,
} from '../services/reports.ts';
import { availabilityGrid } from '../services/availability.ts';
import { forecast } from '../services/housekeeping.ts';
import { preflight } from '../services/nightaudit.ts';

const pid = (ctx: Ctx) => ctx.auth.propertyId;
const businessDate = (ctx: Ctx) =>
  get<{ business_date: string }>('SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;

function window(ctx: Ctx, defaultDays = 30) {
  const today = businessDate(ctx);
  const from = ctx.query.get('from') ?? today;
  const to = ctx.query.get('to') ?? addDays(from, defaultDays);
  assertDate(from, 'from');
  assertDate(to, 'to');
  if (nightsBetween(from, to) > 730) throw new HttpError(400, 'Range cannot exceed 730 days');
  return { from, to };
}

// ─── Dashboard ───────────────────────────────────────────────
router.get('/api/dashboard', (ctx: Ctx) => {
  const today = businessDate(ctx);
  const snapshot = todaySnapshot(pid(ctx));
  const next7 = kpiSeries(pid(ctx), today, addDays(today, 6));
  const lists = frontDeskLists(pid(ctx), today);

  const openWorkOrders = scalar<number>(
    `SELECT count(*) AS n FROM work_orders WHERE property_id = ? AND status NOT IN ('resolved','closed')`,
    pid(ctx));
  const dirtyRooms = scalar<number>(
    `SELECT count(*) AS n FROM rooms WHERE property_id = ? AND active = 1 AND status LIKE 'Vacant Dirty'`,
    pid(ctx));
  const unassigned = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND arrival = ? AND room_id IS NULL
       AND status IN ('Tentative','Confirmed','Guaranteed')`, pid(ctx), today);
  const openConflicts = scalar<number>(
    `SELECT count(*) AS n FROM channel_conflicts WHERE property_id = ? AND status = 'open'`, pid(ctx));

  return {
    businessDate: today,
    snapshot,
    forecast7: next7,
    housekeeping: forecast(pid(ctx), today),
    arrivalsToday: lists.arrivals.length,
    departuresToday: lists.departures.length,
    alerts: {
      unassignedArrivals: unassigned,
      dirtyRooms,
      openWorkOrders,
      channelConflicts: openConflicts,
      nightAuditBlockers: preflight(pid(ctx)).issues.filter((i) => i.severity === 'block').length,
    },
    topArrivals: lists.arrivals.slice(0, 8),
    topDepartures: lists.departures.slice(0, 8),
  };
}, { perm: 'dashboard.read' });

// ─── KPI series & summary ────────────────────────────────────
router.get('/api/reports/kpis', (ctx: Ctx) => {
  const { from, to } = window(ctx);
  return kpiSummary(pid(ctx), from, to);
}, { perm: 'reports.read' });

router.get('/api/reports/production', (ctx: Ctx) => {
  const { from, to } = window(ctx);
  const dimension = oneOf(ctx.query.get('dimension'), 'dimension',
    ['source', 'channel', 'segment', 'rate_plan', 'room_type', 'company'] as const, 'source');
  return { from, to, dimension, rows: production(pid(ctx), from, to, dimension) };
}, { perm: 'reports.read' });

router.get('/api/reports/pace', (ctx: Ctx) => {
  const { from, to } = window(ctx);
  return { from, to, buckets: bookingPace(pid(ctx), from, to) };
}, { perm: 'reports.read' });

router.get('/api/reports/pickup', (ctx: Ctx) => {
  const { from, to } = window(ctx);
  return { from, to, rows: pickup(pid(ctx), from, to) };
}, { perm: 'reports.read' });

router.get('/api/reports/revenue', (ctx: Ctx) => {
  const { from, to } = window(ctx);
  return { from, to, rows: revenueBreakdown(pid(ctx), from, to) };
}, { perm: 'reports.read' });

router.get('/api/reports/occupancy-forecast', (ctx: Ctx) => {
  const { from, to } = window(ctx);
  const cells = availabilityGrid(pid(ctx), from, addDays(to, 1));
  const byType = new Map<string, any>();
  for (const c of cells) {
    if (!byType.has(c.roomTypeId)) {
      byType.set(c.roomTypeId, {
        roomTypeId: c.roomTypeId, roomType: c.roomTypeName, code: c.roomTypeCode, cells: [],
      });
    }
    byType.get(c.roomTypeId).cells.push({
      date: c.date, physical: c.physical, blocked: c.blocked, sold: c.sold,
      available: c.available, occupancyBp: c.occupancyBp,
    });
  }
  return { from, to, roomTypes: [...byType.values()] };
}, { perm: 'reports.read' });

/** Every closed day's frozen statistics — the manager's history table. */
router.get('/api/reports/daily-stats', (ctx: Ctx) => {
  const { from, to } = window(ctx, -30);
  return all<any>(
    'SELECT * FROM daily_stats WHERE property_id = ? AND date >= ? AND date <= ? ORDER BY date DESC',
    pid(ctx), from < to ? from : to, from < to ? to : from,
  ).map((s) => ({
    date: s.date, roomsTotal: s.rooms_total, roomsOoo: s.rooms_ooo, roomsSold: s.rooms_sold,
    occupancyBp: s.occupancy_bp, roomRevenueMinor: s.room_revenue_minor,
    otherRevenueMinor: s.other_revenue_minor, taxMinor: s.tax_minor,
    paymentsMinor: s.payments_minor, adrMinor: s.adr_minor, revparMinor: s.revpar_minor,
    arrivals: s.arrivals, departures: s.departures, noShows: s.no_shows,
    cancellations: s.cancellations, inHouse: s.in_house,
  }));
}, { perm: 'reports.read' });

/** Guest ledger balances that are still open — the AR/credit watchlist. */
router.get('/api/reports/outstanding', (ctx: Ctx) => all<any>(
  `SELECT f.id, f.number, f.name, f.status, r.id AS reservation_id, r.confirmation,
          r.guest_name, r.status AS res_status, r.arrival, r.departure, rm.number AS room_number,
          (SELECT COALESCE(SUM(amount_minor),0) FROM folio_lines l
            WHERE l.folio_id = f.id AND l.voided = 0) AS balance
     FROM folios f
     LEFT JOIN reservations r ON r.id = f.reservation_id
     LEFT JOIN rooms rm ON rm.id = r.room_id
    WHERE f.property_id = ?
    ORDER BY balance DESC`,
  pid(ctx),
).filter((f) => f.balance !== 0).map((f) => ({
  folioId: f.id, number: f.number, name: f.name, folioStatus: f.status,
  reservationId: f.reservation_id, confirmation: f.confirmation, guest: f.guest_name,
  reservationStatus: f.res_status, arrival: f.arrival, departure: f.departure,
  room: f.room_number, balanceMinor: f.balance,
})), { perm: 'folio.read' });
