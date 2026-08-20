// ─────────────────────────────────────────────────────────────
// Reporting & business intelligence.
//
// Past dates read the frozen daily_stats rows written by the night audit.
// Today and the future are computed live from the reservation ledger, so
// the forecast and the history line up on the same axis.
// ─────────────────────────────────────────────────────────────
import { all, get, scalar } from '../db.ts';
import { dateRange, addDays, nightsBetween } from '../lib/util.ts';
import { availabilityGrid } from './availability.ts';

export interface KpiPoint {
  date: string;
  roomsAvailable: number;
  roomsSold: number;
  occupancyBp: number;
  roomRevenueMinor: number;
  adrMinor: number;
  revparMinor: number;
  actual: boolean;          // true = closed day from daily_stats
}

function businessDate(propertyId: string): string {
  return get<{ business_date: string }>('SELECT business_date FROM properties WHERE id = ?', propertyId)
    ?.business_date ?? new Date().toISOString().slice(0, 10);
}

export function kpiSeries(propertyId: string, from: string, to: string): KpiPoint[] {
  const today = businessDate(propertyId);
  const dates = dateRange(from, addDays(to, 1));
  const closed = new Map<string, any>();
  for (const r of all<any>(
    'SELECT * FROM daily_stats WHERE property_id = ? AND date >= ? AND date <= ?',
    propertyId, from, to,
  )) closed.set(r.date, r);

  // A closed day is already answered by its daily_stats row — recomputing it
  // from the reservation nights costs the same as computing tomorrow's, and
  // over a year of history that dominates the whole report. Work out the
  // narrowest range that still needs computing and only do that.
  const live = dates.filter((d) => !(closed.has(d) && d < today));
  const futureByDate = new Map<string, { sold: number; avail: number; revenue: number }>();
  for (const d of dates) futureByDate.set(d, { sold: 0, avail: 0, revenue: 0 });

  if (live.length) {
    const liveFrom = live[0];
    const liveTo = live[live.length - 1];
    const grid = availabilityGrid(propertyId, liveFrom, addDays(liveTo, 1));
    for (const c of grid) {
      const agg = futureByDate.get(c.date);
      if (!agg) continue;
      agg.sold += c.sold;
      agg.avail += c.physical - c.blocked;
    }
    for (const r of all<{ date: string; revenue: number }>(
      `SELECT n.date, COALESCE(SUM(n.rate_minor),0) AS revenue
         FROM reservation_nights n JOIN reservations r ON r.id = n.reservation_id
        WHERE n.property_id = ? AND n.date >= ? AND n.date <= ?
          AND r.status IN ('Tentative','Confirmed','Guaranteed','Checked-in','Checked-out')
        GROUP BY n.date`,
      propertyId, liveFrom, liveTo,
    )) {
      const agg = futureByDate.get(r.date);
      if (agg) agg.revenue = r.revenue;
    }
  }

  return dates.map((date) => {
    const stat = closed.get(date);
    if (stat && date < today) {
      return {
        date,
        roomsAvailable: stat.rooms_total - stat.rooms_ooo,
        roomsSold: stat.rooms_sold,
        occupancyBp: stat.occupancy_bp,
        roomRevenueMinor: stat.room_revenue_minor,
        adrMinor: stat.adr_minor,
        revparMinor: stat.revpar_minor,
        actual: true,
      };
    }
    const agg = futureByDate.get(date) ?? { sold: 0, avail: 0, revenue: 0 };
    return {
      date,
      roomsAvailable: agg.avail,
      roomsSold: agg.sold,
      occupancyBp: agg.avail > 0 ? Math.round((agg.sold / agg.avail) * 10_000) : 0,
      roomRevenueMinor: agg.revenue,
      adrMinor: agg.sold > 0 ? Math.round(agg.revenue / agg.sold) : 0,
      revparMinor: agg.avail > 0 ? Math.round(agg.revenue / agg.avail) : 0,
      actual: false,
    };
  });
}

export function kpiSummary(propertyId: string, from: string, to: string) {
  const series = kpiSeries(propertyId, from, to);
  const roomsSold = series.reduce((s, p) => s + p.roomsSold, 0);
  const roomsAvailable = series.reduce((s, p) => s + p.roomsAvailable, 0);
  const revenue = series.reduce((s, p) => s + p.roomRevenueMinor, 0);
  return {
    from, to,
    roomsSold,
    roomsAvailable,
    occupancyBp: roomsAvailable > 0 ? Math.round((roomsSold / roomsAvailable) * 10_000) : 0,
    roomRevenueMinor: revenue,
    adrMinor: roomsSold > 0 ? Math.round(revenue / roomsSold) : 0,
    revparMinor: roomsAvailable > 0 ? Math.round(revenue / roomsAvailable) : 0,
    series,
  };
}

/** Today's operational snapshot — what the dashboard is built from. */
export function todaySnapshot(propertyId: string) {
  const date = businessDate(propertyId);
  const grid = availabilityGrid(propertyId, date, addDays(date, 1));
  const physical = grid.reduce((s, c) => s + c.physical, 0);
  const blocked = grid.reduce((s, c) => s + c.blocked, 0);
  const sold = grid.reduce((s, c) => s + c.sold, 0);
  const available = grid.reduce((s, c) => s + c.available, 0);

  const arrivalsDue = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND arrival = ?
       AND status IN ('Tentative','Confirmed','Guaranteed')`, propertyId, date);
  const arrivalsDone = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND arrival = ? AND status = 'Checked-in'`,
    propertyId, date);
  const departuresDue = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND departure = ? AND status = 'Checked-in'`,
    propertyId, date);
  const departuresDone = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND departure = ? AND status = 'Checked-out'`,
    propertyId, date);
  const inHouse = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND status = 'Checked-in'`, propertyId);
  const inHouseGuests = scalar<number>(
    `SELECT COALESCE(SUM(adults + children),0) AS n FROM reservations
      WHERE property_id = ? AND status = 'Checked-in'`, propertyId);

  const revenue = get<any>(
    `SELECT
       COALESCE(SUM(CASE WHEN kind='charge' AND code='ROOM' THEN amount_minor ELSE 0 END),0) AS room_rev,
       COALESCE(SUM(CASE WHEN kind='charge' AND code<>'ROOM' THEN amount_minor ELSE 0 END),0) AS other_rev,
       COALESCE(SUM(CASE WHEN kind='payment' THEN -amount_minor ELSE 0 END),0) AS payments
     FROM folio_lines WHERE property_id = ? AND business_date = ? AND voided = 0`,
    propertyId, date,
  );

  // Expected room revenue for tonight, from the ledger rather than postings.
  const expectedRoomRevenue = scalar<number>(
    `SELECT COALESCE(SUM(n.rate_minor),0) AS t FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.date = ?
        AND r.status IN ('Tentative','Confirmed','Guaranteed','Checked-in')`,
    propertyId, date,
  );

  const outstanding = scalar<number>(
    `SELECT COALESCE(SUM(l.amount_minor),0) AS t
       FROM folio_lines l
       JOIN folios f ON f.id = l.folio_id
       JOIN reservations r ON r.id = f.reservation_id
      WHERE l.property_id = ? AND l.voided = 0 AND r.status = 'Checked-in'`,
    propertyId,
  );

  const denom = physical - blocked;
  return {
    businessDate: date,
    rooms: { physical, blocked, sold, available, denominator: denom },
    occupancyBp: denom > 0 ? Math.round((sold / denom) * 10_000) : 0,
    adrMinor: sold > 0 ? Math.round(expectedRoomRevenue / sold) : 0,
    revparMinor: denom > 0 ? Math.round(expectedRoomRevenue / denom) : 0,
    arrivals: { due: arrivalsDue, done: arrivalsDone, total: arrivalsDue + arrivalsDone },
    departures: { due: departuresDue, done: departuresDone, total: departuresDue + departuresDone },
    inHouse,
    inHouseGuests,
    roomRevenueMinor: revenue?.room_rev ?? 0,
    otherRevenueMinor: revenue?.other_rev ?? 0,
    paymentsMinor: revenue?.payments ?? 0,
    expectedRoomRevenueMinor: expectedRoomRevenue,
    outstandingBalanceMinor: outstanding,
  };
}

/** Rooms sold and revenue for a stay window, grouped by booking dimension. */
export function production(
  propertyId: string, from: string, to: string,
  dimension: 'source' | 'channel' | 'segment' | 'rate_plan' | 'room_type' | 'company',
) {
  const col = {
    source: 'r.source',
    channel: `COALESCE(r.channel_code, 'Direct')`,
    segment: `COALESCE(r.segment, 'Unspecified')`,
    rate_plan: 'rp.code',
    room_type: 'rt.name',
    company: `COALESCE(c.name, 'None')`,
  }[dimension];

  return all<any>(
    `SELECT ${col} AS dim,
            count(DISTINCT r.id) AS reservations,
            count(*) AS room_nights,
            COALESCE(SUM(n.rate_minor),0) AS revenue,
            COALESCE(SUM(r.commission_minor),0) AS commission
       FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
       JOIN rate_plans rp ON rp.id = n.rate_plan_id
       JOIN room_types rt ON rt.id = n.room_type_id
       LEFT JOIN companies c ON c.id = r.company_id
      WHERE n.property_id = ? AND n.date >= ? AND n.date <= ?
        AND r.status IN ('Tentative','Confirmed','Guaranteed','Checked-in','Checked-out')
      GROUP BY dim
      ORDER BY revenue DESC`,
    propertyId, from, to,
  ).map((r) => ({
    dimension: r.dim,
    reservations: r.reservations,
    roomNights: r.room_nights,
    revenueMinor: r.revenue,
    commissionMinor: r.commission,
    adrMinor: r.room_nights > 0 ? Math.round(r.revenue / r.room_nights) : 0,
  }));
}

/**
 * Booking pace: for a stay window, how the on-the-books position built up
 * by lead time. Bucketed by days between booking and arrival.
 */
export function bookingPace(propertyId: string, stayFrom: string, stayTo: string) {
  const rows = all<any>(
    `SELECT substr(r.created_at,1,10) AS booked_on, n.date AS stay_date,
            count(*) AS nights, COALESCE(SUM(n.rate_minor),0) AS revenue
       FROM reservation_nights n JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.date >= ? AND n.date <= ?
        AND r.status IN ('Tentative','Confirmed','Guaranteed','Checked-in','Checked-out')
      GROUP BY booked_on, stay_date`,
    propertyId, stayFrom, stayTo,
  );
  const buckets = [0, 1, 3, 7, 14, 30, 60, 90, 180, 365];
  const out = buckets.map((b, i) => ({
    leadDaysFrom: b,
    leadDaysTo: i < buckets.length - 1 ? buckets[i + 1] - 1 : 9999,
    roomNights: 0,
    revenueMinor: 0,
  }));
  for (const r of rows) {
    const lead = Math.max(0, nightsBetween(r.booked_on, r.stay_date));
    let idx = 0;
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (lead >= buckets[i]) { idx = i; break; }
    }
    out[idx].roomNights += r.nights;
    out[idx].revenueMinor += r.revenue;
  }
  return out;
}

/** Day-by-day on-the-books pickup versus the same window last year. */
export function pickup(propertyId: string, from: string, to: string) {
  const current = kpiSeries(propertyId, from, to);
  const lyFrom = addDays(from, -364);
  const lyTo = addDays(to, -364);
  const lastYear = new Map(kpiSeries(propertyId, lyFrom, lyTo).map((p, i) => [i, p]));
  return current.map((p, i) => {
    const ly = lastYear.get(i);
    return {
      date: p.date,
      roomsSold: p.roomsSold,
      occupancyBp: p.occupancyBp,
      revenueMinor: p.roomRevenueMinor,
      lyRoomsSold: ly?.roomsSold ?? 0,
      lyOccupancyBp: ly?.occupancyBp ?? 0,
      lyRevenueMinor: ly?.roomRevenueMinor ?? 0,
      varianceRooms: p.roomsSold - (ly?.roomsSold ?? 0),
      varianceRevenueMinor: p.roomRevenueMinor - (ly?.roomRevenueMinor ?? 0),
    };
  });
}

export function revenueBreakdown(propertyId: string, from: string, to: string) {
  return all<any>(
    `SELECT l.code, tc.name AS code_name, tc.category, l.kind,
            COALESCE(SUM(l.amount_minor),0) AS total, count(*) AS lines
       FROM folio_lines l
       LEFT JOIN transaction_codes tc ON tc.code = l.code AND tc.property_id = l.property_id
      WHERE l.property_id = ? AND l.business_date >= ? AND l.business_date <= ? AND l.voided = 0
      GROUP BY l.code, l.kind
      ORDER BY total DESC`,
    propertyId, from, to,
  ).map((r) => ({
    code: r.code, name: r.code_name ?? r.code, category: r.category ?? r.kind,
    kind: r.kind, totalMinor: r.total, lines: r.lines,
  }));
}

/** Guest lifetime value and stay history, computed from the ledger. */
export function guestValue(propertyId: string, profileId: string) {
  const stays = all<any>(
    `SELECT r.id, r.confirmation, r.arrival, r.departure, r.nights, r.status,
            r.total_minor, rt.name AS room_type_name, rp.code AS rate_code, r.source
       FROM reservations r
       JOIN room_types rt ON rt.id = r.room_type_id
       JOIN rate_plans rp ON rp.id = r.rate_plan_id
      WHERE r.property_id = ? AND r.profile_id = ?
      ORDER BY r.arrival DESC`,
    propertyId, profileId,
  );
  const completed = stays.filter((s) => s.status === 'Checked-out');
  const revenue = scalar<number>(
    `SELECT COALESCE(SUM(l.amount_minor),0) AS t
       FROM folio_lines l JOIN folios f ON f.id = l.folio_id
       JOIN reservations r ON r.id = f.reservation_id
      WHERE r.profile_id = ? AND l.voided = 0 AND l.kind IN ('charge','tax')`,
    profileId,
  );
  const nights = completed.reduce((s, r) => s + r.nights, 0);
  return {
    stays: stays.map((s) => ({
      id: s.id, confirmation: s.confirmation, arrival: s.arrival, departure: s.departure,
      nights: s.nights, status: s.status, roomType: s.room_type_name, rateCode: s.rate_code,
      source: s.source, totalMinor: s.total_minor,
    })),
    completedStays: completed.length,
    totalNights: nights,
    lifetimeValueMinor: revenue,
    averageStayNights: completed.length ? Math.round((nights / completed.length) * 10) / 10 : 0,
    lastStay: completed[0]?.departure ?? null,
  };
}

/** In-house, arrivals and departures lists used by the front-desk screens. */
export function frontDeskLists(propertyId: string, date: string) {
  const shape = (rows: any[]) => rows.map((r) => ({
    id: r.id, confirmation: r.confirmation, guest: r.guest_name, status: r.status,
    arrival: r.arrival, departure: r.departure, nights: r.nights,
    adults: r.adults, children: r.children, roomType: r.room_type_name,
    room: r.room_number ?? undefined, roomId: r.room_id ?? undefined,
    roomStatus: r.room_status ?? undefined,
    rateCode: r.rate_code, vip: r.vip === 1, eta: r.eta, etd: r.etd,
    source: r.source, channel: r.channel_code,
    balanceMinor: r.balance ?? 0, totalMinor: r.total_minor,
    specialRequests: r.special_requests,
  }));

  const base = `
    SELECT r.*, rt.name AS room_type_name, rp.code AS rate_code,
           rm.number AS room_number, rm.status AS room_status,
           (SELECT COALESCE(SUM(l.amount_minor),0) FROM folio_lines l
              JOIN folios f ON f.id = l.folio_id
             WHERE f.reservation_id = r.id AND l.voided = 0) AS balance
      FROM reservations r
      JOIN room_types rt ON rt.id = r.room_type_id
      JOIN rate_plans rp ON rp.id = r.rate_plan_id
      LEFT JOIN rooms rm ON rm.id = r.room_id`;

  return {
    date,
    arrivals: shape(all<any>(
      `${base} WHERE r.property_id = ? AND r.arrival = ?
         AND r.status IN ('Tentative','Confirmed','Guaranteed')
       ORDER BY r.eta, r.guest_name`, propertyId, date)),
    arrived: shape(all<any>(
      `${base} WHERE r.property_id = ? AND r.arrival = ? AND r.status = 'Checked-in'
       ORDER BY r.checked_in_at DESC`, propertyId, date)),
    departures: shape(all<any>(
      `${base} WHERE r.property_id = ? AND r.departure = ? AND r.status = 'Checked-in'
       ORDER BY r.etd, r.guest_name`, propertyId, date)),
    departed: shape(all<any>(
      `${base} WHERE r.property_id = ? AND r.departure = ? AND r.status = 'Checked-out'
       ORDER BY r.checked_out_at DESC`, propertyId, date)),
    inHouse: shape(all<any>(
      `${base} WHERE r.property_id = ? AND r.status = 'Checked-in'
       ORDER BY rm.number, r.guest_name`, propertyId)),
  };
}
