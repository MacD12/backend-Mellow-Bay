// ─────────────────────────────────────────────────────────────
// Availability engine — the single arbiter of "can we sell this?".
//
// For each room type and date:
//   physical  = active rooms (or beds, for dorms) of that type
//   blocked   = rooms out of order / out of service on that date
//   sold      = reservation nights holding inventory on that date
//   groupHeld = unpicked group block still inside its cutoff
//   hold      = manually withheld inventory
//   overbook  = deliberate oversell allowance
//   available = physical − blocked − sold − groupHeld − hold + overbook
//
// Occupancy statistics use a different denominator to availability:
// out-of-order rooms leave the denominator, out-of-service rooms stay in it.
// ─────────────────────────────────────────────────────────────
import { all, get } from '../db.ts';
import { dateRange, addDays } from '../lib/util.ts';

/** Reservation statuses that consume inventory. */
export const LIVE_STATUSES = ['Tentative', 'Confirmed', 'Guaranteed', 'Checked-in'] as const;
const LIVE_SQL = `('Tentative','Confirmed','Guaranteed','Checked-in')`;

export interface AvailabilityCell {
  roomTypeId: string;
  roomTypeCode: string;
  roomTypeName: string;
  kind: 'room' | 'dorm';
  date: string;
  physical: number;
  blocked: number;
  sold: number;
  groupHeld: number;
  hold: number;
  overbook: number;
  available: number;
  occupancyBp: number;
}

interface RoomTypeRow {
  id: string; code: string; name: string; kind: string;
}

export function roomTypes(propertyId: string): RoomTypeRow[] {
  return all<RoomTypeRow>(
    `SELECT id, code, name, kind FROM room_types
      WHERE property_id = ? AND active = 1
      ORDER BY sort_order, name`,
    propertyId,
  );
}

/** Physical sellable units per room type (rooms, or beds for dorm types). */
export function physicalCounts(propertyId: string): Map<string, number> {
  const out = new Map<string, number>();
  const rooms = all<{ room_type_id: string; n: number }>(
    `SELECT r.room_type_id, count(*) AS n
       FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.property_id = ? AND r.active = 1 AND rt.kind = 'room'
      GROUP BY r.room_type_id`,
    propertyId,
  );
  for (const r of rooms) out.set(r.room_type_id, r.n);

  const beds = all<{ room_type_id: string; n: number }>(
    `SELECT r.room_type_id, count(*) AS n
       FROM beds b
       JOIN rooms r ON r.id = b.room_id
       JOIN room_types rt ON rt.id = r.room_type_id
      WHERE b.property_id = ? AND b.active = 1 AND r.active = 1 AND rt.kind = 'dorm'
      GROUP BY r.room_type_id`,
    propertyId,
  );
  for (const b of beds) out.set(b.room_type_id, b.n);

  // Dorm room types with no beds configured yet still exist — report 0 rather
  // than silently omitting them.
  for (const rt of roomTypes(propertyId)) if (!out.has(rt.id)) out.set(rt.id, 0);
  return out;
}

function key(rt: string, date: string) { return `${rt}|${date}`; }

/**
 * Availability grid for [from, to) across every active room type.
 * One query per dimension — the grid is assembled in memory.
 */
export function availabilityGrid(
  propertyId: string,
  from: string,
  to: string,
  opts: { excludeReservationId?: string } = {},
): AvailabilityCell[] {
  const dates = dateRange(from, to);
  if (dates.length === 0) return [];
  const types = roomTypes(propertyId);
  const physical = physicalCounts(propertyId);

  // Blocked rooms/beds per type per date.
  const blocked = new Map<string, number>();
  const blocks = all<{ room_type_id: string; from_date: string; to_date: string; units: number }>(
    `SELECT r.room_type_id, rb.from_date, rb.to_date,
            CASE WHEN rt.kind = 'dorm'
                 THEN (SELECT count(*) FROM beds b WHERE b.room_id = r.id AND b.active = 1)
                 ELSE 1 END AS units
       FROM room_blocks rb
       JOIN rooms r ON r.id = rb.room_id
       JOIN room_types rt ON rt.id = r.room_type_id
      WHERE rb.property_id = ? AND rb.released_at IS NULL
        AND rb.from_date < ? AND rb.to_date > ?`,
    propertyId, to, from,
  );
  for (const b of blocks) {
    for (const d of dateRange(
      b.from_date > from ? b.from_date : from,
      b.to_date < to ? b.to_date : to,
    )) {
      blocked.set(key(b.room_type_id, d), (blocked.get(key(b.room_type_id, d)) ?? 0) + b.units);
    }
  }

  // Sold nights per type per date.
  const sold = new Map<string, number>();
  const soldRows = all<{ room_type_id: string; date: string; n: number }>(
    `SELECT n.room_type_id, n.date, count(*) AS n
       FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.date >= ? AND n.date < ?
        AND r.status IN ${LIVE_SQL}
        ${opts.excludeReservationId ? 'AND r.id <> ?' : ''}
      GROUP BY n.room_type_id, n.date`,
    ...(opts.excludeReservationId
      ? [propertyId, from, to, opts.excludeReservationId]
      : [propertyId, from, to]),
  );
  for (const s of soldRows) sold.set(key(s.room_type_id, s.date), s.n);

  // Group blocks still held (blocked minus already picked up), inside cutoff.
  const held = new Map<string, number>();
  const blockRows = all<{ room_type_id: string; date: string; blocked: number; group_id: string }>(
    `SELECT gb.room_type_id, gb.date, gb.blocked, gb.group_id
       FROM group_blocks gb
       JOIN groups g ON g.id = gb.group_id
      WHERE g.property_id = ? AND gb.date >= ? AND gb.date < ?
        AND g.status IN ('tentative','definite')
        AND (g.cutoff_date IS NULL OR gb.date >= g.cutoff_date OR g.cutoff_date >= date('now'))`,
    propertyId, from, to,
  );
  const picked = new Map<string, number>();
  const pickRows = all<{ group_id: string; room_type_id: string; date: string; n: number }>(
    `SELECT r.group_id, n.room_type_id, n.date, count(*) AS n
       FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.date >= ? AND n.date < ?
        AND r.group_id IS NOT NULL AND r.status IN ${LIVE_SQL}
      GROUP BY r.group_id, n.room_type_id, n.date`,
    propertyId, from, to,
  );
  for (const p of pickRows) picked.set(`${p.group_id}|${p.room_type_id}|${p.date}`, p.n);
  for (const b of blockRows) {
    const up = picked.get(`${b.group_id}|${b.room_type_id}|${b.date}`) ?? 0;
    const remaining = Math.max(0, b.blocked - up);
    held.set(key(b.room_type_id, b.date), (held.get(key(b.room_type_id, b.date)) ?? 0) + remaining);
  }

  // Manual holds / overbooking allowance.
  const adjust = new Map<string, { hold: number; overbook: number }>();
  const adjRows = all<{ room_type_id: string; date: string; hold: number; overbook: number }>(
    `SELECT room_type_id, date, hold, overbook FROM inventory_adjustments
      WHERE property_id = ? AND date >= ? AND date < ?`,
    propertyId, from, to,
  );
  for (const a of adjRows) adjust.set(key(a.room_type_id, a.date), { hold: a.hold, overbook: a.overbook });

  const cells: AvailabilityCell[] = [];
  for (const rt of types) {
    const phys = physical.get(rt.id) ?? 0;
    for (const d of dates) {
      const k = key(rt.id, d);
      const bl = blocked.get(k) ?? 0;
      const sd = sold.get(k) ?? 0;
      const gh = held.get(k) ?? 0;
      const adj = adjust.get(k) ?? { hold: 0, overbook: 0 };
      const available = phys - bl - sd - gh - adj.hold + adj.overbook;
      const denom = phys - bl;
      cells.push({
        roomTypeId: rt.id,
        roomTypeCode: rt.code,
        roomTypeName: rt.name,
        kind: rt.kind as 'room' | 'dorm',
        date: d,
        physical: phys,
        blocked: bl,
        sold: sd,
        groupHeld: gh,
        hold: adj.hold,
        overbook: adj.overbook,
        available,
        occupancyBp: denom > 0 ? Math.round((sd / denom) * 10_000) : 0,
      });
    }
  }
  return cells;
}

/** Property-level occupancy for a single date, in basis points. */
export function occupancyBp(propertyId: string, date: string): number {
  const cells = availabilityGrid(propertyId, date, addDays(date, 1));
  const sold = cells.reduce((s, c) => s + c.sold, 0);
  const denom = cells.reduce((s, c) => s + c.physical - c.blocked, 0);
  return denom > 0 ? Math.round((sold / denom) * 10_000) : 0;
}

export interface AvailabilityCheck {
  ok: boolean;
  shortfall: { date: string; available: number }[];
}

/** Can we sell `units` of this room type for every night of the stay? */
export function checkAvailability(
  propertyId: string,
  roomTypeId: string,
  arrival: string,
  departure: string,
  units = 1,
  excludeReservationId?: string,
): AvailabilityCheck {
  const grid = availabilityGrid(propertyId, arrival, departure, { excludeReservationId });
  const shortfall = grid
    .filter((c) => c.roomTypeId === roomTypeId && c.available < units)
    .map((c) => ({ date: c.date, available: c.available }));
  return { ok: shortfall.length === 0, shortfall };
}

/**
 * Rooms of a type that are free for the whole stay — used by room assignment
 * and room moves. Excludes rooms blocked (OOO/OOS) or already assigned.
 */
export function freeRooms(
  propertyId: string,
  roomTypeId: string | null,
  arrival: string,
  departure: string,
  excludeReservationId?: string,
) {
  const params: unknown[] = [propertyId];
  let typeClause = '';
  if (roomTypeId) { typeClause = 'AND r.room_type_id = ?'; params.push(roomTypeId); }

  const rows = all<any>(
    `SELECT r.*, rt.code AS room_type_code, rt.name AS room_type_name
       FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.property_id = ? AND r.active = 1 ${typeClause}
      ORDER BY r.floor, r.number`,
    ...params,
  );

  const busy = new Set<string>(
    all<{ room_id: string }>(
      `SELECT DISTINCT n.room_id FROM reservation_nights n
         JOIN reservations r ON r.id = n.reservation_id
        WHERE n.property_id = ? AND n.room_id IS NOT NULL
          AND n.date >= ? AND n.date < ?
          AND r.status IN ${LIVE_SQL}
          ${excludeReservationId ? 'AND r.id <> ?' : ''}`,
      ...(excludeReservationId
        ? [propertyId, arrival, departure, excludeReservationId]
        : [propertyId, arrival, departure]),
    ).map((r) => r.room_id),
  );

  const blockedRooms = new Set<string>(
    all<{ room_id: string }>(
      `SELECT DISTINCT room_id FROM room_blocks
        WHERE property_id = ? AND released_at IS NULL
          AND from_date < ? AND to_date > ?`,
      propertyId, departure, arrival,
    ).map((r) => r.room_id),
  );

  return rows.filter((r) => !busy.has(r.id) && !blockedRooms.has(r.id));
}

/** Is a specific room free for the stay? */
export function isRoomFree(
  propertyId: string,
  roomId: string,
  arrival: string,
  departure: string,
  excludeReservationId?: string,
): boolean {
  const clash = get<{ n: number }>(
    `SELECT count(*) AS n FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.room_id = ?
        AND n.date >= ? AND n.date < ?
        AND r.status IN ${LIVE_SQL}
        ${excludeReservationId ? 'AND r.id <> ?' : ''}`,
    ...(excludeReservationId
      ? [propertyId, roomId, arrival, departure, excludeReservationId]
      : [propertyId, roomId, arrival, departure]),
  );
  if ((clash?.n ?? 0) > 0) return false;
  const blocked = get<{ n: number }>(
    `SELECT count(*) AS n FROM room_blocks
      WHERE property_id = ? AND room_id = ? AND released_at IS NULL
        AND from_date < ? AND to_date > ?`,
    propertyId, roomId, departure, arrival,
  );
  return (blocked?.n ?? 0) === 0;
}

/** Free beds inside dorm rooms of a type, for the whole stay. */
export function freeBeds(
  propertyId: string,
  roomTypeId: string,
  arrival: string,
  departure: string,
  excludeReservationId?: string,
) {
  const beds = all<any>(
    `SELECT b.*, r.number AS room_number, r.room_type_id
       FROM beds b JOIN rooms r ON r.id = b.room_id
      WHERE b.property_id = ? AND b.active = 1 AND r.active = 1 AND r.room_type_id = ?
      ORDER BY b.code`,
    propertyId, roomTypeId,
  );
  const busy = new Set<string>(
    all<{ bed_id: string }>(
      `SELECT DISTINCT n.bed_id FROM reservation_nights n
         JOIN reservations r ON r.id = n.reservation_id
        WHERE n.property_id = ? AND n.bed_id IS NOT NULL
          AND n.date >= ? AND n.date < ?
          AND r.status IN ${LIVE_SQL}
          ${excludeReservationId ? 'AND r.id <> ?' : ''}`,
      ...(excludeReservationId
        ? [propertyId, arrival, departure, excludeReservationId]
        : [propertyId, arrival, departure]),
    ).map((r) => r.bed_id),
  );
  return beds.filter((b) => !busy.has(b.id));
}
