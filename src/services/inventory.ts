// ─────────────────────────────────────────────────────────────
// How many rooms exist, on each side, and keeping the two the same.
//
// Beds24 sells `qty` units of a room. Helio holds rooms, and for a dorm, beds
// inside them. They are two numbers describing one physical property, and until
// now nothing compared them.
//
// That gap is not cosmetic. If Beds24 says 16 and the property has 8, the OTAs
// sell eight beds that do not exist, and nobody finds out until eight guests
// arrive. Drift on this number is an overbooking with a delay on it.
//
// So two things live here:
//
//   · **Comparison** — what Helio holds beside what Beds24 last said, per room
//     type, cheap enough to render on a screen.
//   · **Change** — editing the count in Helio and sending it to Beds24, with the
//     one guard that makes it safe to hand to a receptionist: you cannot delete
//     a bed somebody has booked.
// ─────────────────────────────────────────────────────────────
import { all, get, run, tx, scalar } from '../db.ts';
import { id, nowIso, HttpError, notFound } from '../lib/util.ts';
import { audit } from './audit.ts';
import { notify } from './notify.ts';
import type { AuthContext } from '../auth.ts';

type Actor = Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>;

export interface InventoryLine {
  roomTypeId: string;
  code: string;
  name: string;
  kind: 'room' | 'dorm';
  /** Physical rooms in Helio. */
  rooms: number;
  /** Beds per room, for a dorm. Zero for a private room. */
  bedsPerRoom: number;
  /** What Helio actually sells: beds for a dorm, rooms otherwise. */
  sellable: number;
  /** What Beds24 last said it sells. Null when never seen or unmapped. */
  externalQty: number | null;
  externalRoomId: string | null;
  externalSeenAt: string | null;
  /** sellable − externalQty. Zero, or the size of the problem. */
  drift: number | null;
  /** Units with a booking on them now or in the future. Cannot be removed. */
  sold: number;
}

/**
 * Both sides of the inventory, per room type.
 *
 * `sellable` is the number that matters: a dorm sells beds, not rooms, and
 * comparing Beds24's bed count against Helio's *room* count would report drift
 * on every dorm in the property while the two agree perfectly.
 */
export function inventoryLines(propertyId: string): InventoryLine[] {
  const types = all<any>(
    `SELECT rt.id, rt.code, rt.name, rt.kind,
            (SELECT COUNT(*) FROM rooms r WHERE r.room_type_id = rt.id AND r.active = 1) AS rooms,
            (SELECT COUNT(*) FROM beds b JOIN rooms r ON r.id = b.room_id
              WHERE r.room_type_id = rt.id AND b.active = 1 AND r.active = 1) AS beds
       FROM room_types rt
      WHERE rt.property_id = ? AND rt.active = 1
      ORDER BY rt.kind, rt.name`,
    propertyId);

  return types.map((t) => {
    const map = get<any>(
      `SELECT external_room_id, external_qty, external_seen_at
         FROM channel_mappings
        WHERE property_id = ? AND room_type_id = ? AND active = 1
        LIMIT 1`,
      propertyId, t.id);

    const isDorm = t.kind === 'dorm';
    const sellable = isDorm ? Number(t.beds) : Number(t.rooms);
    const externalQty = map?.external_qty ?? null;

    return {
      roomTypeId: t.id, code: t.code, name: t.name, kind: t.kind,
      rooms: Number(t.rooms),
      bedsPerRoom: isDorm && t.rooms ? Math.round(Number(t.beds) / Number(t.rooms)) : 0,
      sellable,
      externalQty,
      externalRoomId: map?.external_room_id ?? null,
      externalSeenAt: map?.external_seen_at ?? null,
      drift: externalQty === null ? null : sellable - externalQty,
      sold: soldUnits(propertyId, t.id),
    };
  });
}

/**
 * Units of this type with a booking on them from today onward.
 *
 * The floor below which the count cannot be reduced. Counted from
 * `reservation_nights` rather than reservations, because a stay occupies a
 * specific room or bed on specific dates and that is what would be orphaned.
 */
function soldUnits(propertyId: string, roomTypeId: string): number {
  return scalar<number>(
    `SELECT COUNT(DISTINCT COALESCE(n.bed_id, n.room_id)) AS n
       FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.room_type_id = ?
        AND n.date >= (SELECT business_date FROM properties WHERE id = ?)
        AND r.status IN ('Tentative','Confirmed','Guaranteed','Checked-in')`,
    propertyId, roomTypeId, propertyId) ?? 0;
}

/** Room types where the two sides disagree. */
export function inventoryDrift(propertyId: string) {
  return inventoryLines(propertyId).filter((l) => l.drift !== null && l.drift !== 0);
}

/**
 * Change how much of a room type exists.
 *
 * `rooms` is how many physical rooms; `bedsPerRoom` how many beds in each, for
 * a dorm. Growing adds; shrinking removes from the end — highest-numbered
 * first, so the rooms people know by name keep their names.
 *
 * Nothing that is sold is ever removed. That check is the difference between an
 * inventory editor and a way to lose a booking.
 */
export function setInventory(
  propertyId: string, actor: Actor,
  roomTypeId: string, want: { rooms: number; bedsPerRoom?: number },
) {
  const type = get<any>(
    'SELECT * FROM room_types WHERE id = ? AND property_id = ?', roomTypeId, propertyId);
  if (!type) notFound('Room type');

  const isDorm = type.kind === 'dorm';
  const rooms = Math.max(0, Math.floor(want.rooms));
  const bedsPerRoom = isDorm ? Math.max(1, Math.floor(want.bedsPerRoom ?? 1)) : 0;
  if (rooms > 500) throw new HttpError(400, 'That is more rooms than this supports (500 max)');
  if (isDorm && bedsPerRoom > 64) throw new HttpError(400, 'That is more beds than one room holds (64 max)');

  return tx(() => {
    const existing = all<any>(
      `SELECT id, number FROM rooms WHERE property_id = ? AND room_type_id = ? AND active = 1
        ORDER BY number`,
      propertyId, roomTypeId);

    const removing = existing.slice(rooms);
    // A room with a stay on it from today onward is not ours to delete.
    const blocked: string[] = [];
    for (const r of removing) {
      const n = scalar<number>(
        `SELECT COUNT(*) AS n FROM reservation_nights n
           JOIN reservations res ON res.id = n.reservation_id
          WHERE n.room_id = ?
            AND n.date >= (SELECT business_date FROM properties WHERE id = ?)
            AND res.status IN ('Tentative','Confirmed','Guaranteed','Checked-in')`,
        r.id, propertyId);
      if (n > 0) blocked.push(r.number);
    }
    if (blocked.length) {
      throw new HttpError(409,
        `Cannot remove ${blocked.join(', ')} — ${blocked.length === 1 ? 'it has' : 'they have'} `
        + 'bookings. Move or cancel those first.',
        'rooms_sold');
    }

    for (const r of removing) {
      run('DELETE FROM beds WHERE room_id = ?', r.id);
      run('DELETE FROM rooms WHERE id = ?', r.id);
    }

    // Grow to the wanted number.
    const prefix = (type.code || 'RM').slice(0, 4).toUpperCase();
    for (let i = existing.length; i < rooms; i++) {
      const roomId = id('rm');
      const number = rooms === 1 ? prefix : `${prefix}-${i + 1}`;
      run(
        `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
         VALUES(?,?,?,?,1,'Vacant Clean',1,?)`,
        roomId, propertyId, roomTypeId, number, nowIso());
    }

    // Beds, for a dorm — brought to `bedsPerRoom` in every room that survives.
    if (isDorm) {
      const kept = all<any>(
        `SELECT id, number FROM rooms WHERE property_id = ? AND room_type_id = ? AND active = 1
          ORDER BY number`,
        propertyId, roomTypeId);
      for (const room of kept) {
        const beds = all<any>(
          'SELECT id, code FROM beds WHERE room_id = ? AND active = 1 ORDER BY code', room.id);

        const surplus = beds.slice(bedsPerRoom);
        for (const b of surplus) {
          const n = scalar<number>(
            `SELECT COUNT(*) AS n FROM reservation_nights n
               JOIN reservations res ON res.id = n.reservation_id
              WHERE n.bed_id = ?
                AND n.date >= (SELECT business_date FROM properties WHERE id = ?)
                AND res.status IN ('Tentative','Confirmed','Guaranteed','Checked-in')`,
            b.id, propertyId);
          if (n > 0) {
            throw new HttpError(409,
              `Cannot remove bed ${b.code} — it has bookings. Move or cancel those first.`,
              'beds_sold');
          }
          run('DELETE FROM beds WHERE id = ?', b.id);
        }

        for (let i = beds.length; i < bedsPerRoom; i++) {
          run(
            `INSERT INTO beds(id, property_id, room_id, code, bunk, status, active)
             VALUES(?,?,?,?,?,'Vacant Clean',1)`,
            id('bed'), propertyId, room.id,
            `${room.number}-${String(i + 1).padStart(2, '0')}`,
            bedsPerRoom === 1 ? 'single' : i % 2 === 0 ? 'bottom' : 'top');
        }
      }
    }

    const line = inventoryLines(propertyId).find((l) => l.roomTypeId === roomTypeId)!;
    audit(actor, {
      action: 'inventory.set', entity: 'ROOM_TYPE', entityId: roomTypeId, entityRef: type.name,
      after: { rooms, bedsPerRoom, sellable: line.sellable },
    });
    return line;
  });
}

const AUTO_PUSH_KEY = 'inventory.autoPush';

/**
 * Should a count change in Helio go straight out to the channel?
 *
 * **Off unless switched on.** With it on, editing a number on a configuration
 * screen becomes a live change to what the OTAs are selling, with no second
 * look — which is the right trade for a property that keeps Helio as its source
 * of truth, and the wrong one for anybody still setting up. Defaulting it on
 * would make that choice for them silently.
 */
export function autoPushEnabled(propertyId: string): boolean {
  const row = get<{ value: string }>(
    'SELECT value FROM settings WHERE property_id = ? AND key = ?', propertyId, AUTO_PUSH_KEY);
  if (!row) return false;
  try { return JSON.parse(row.value) === true; } catch { return false; }
}

export function setAutoPush(propertyId: string, actor: Actor, on: boolean): boolean {
  run(
    `INSERT INTO settings(property_id, key, value, updated_at, updated_by)
     VALUES(?,?,?,?,?)
     ON CONFLICT(property_id, key) DO UPDATE
       SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    propertyId, AUTO_PUSH_KEY, JSON.stringify(on), nowIso(), actor.userName);
  audit(actor, {
    action: on ? 'inventory.autopush.on' : 'inventory.autopush.off',
    entity: 'PROPERTY', entityId: propertyId, entityRef: 'inventory auto-push',
    elevated: true, after: { on },
  });
  return on;
}

/** Record what Beds24 last said, so drift can be shown without a live call. */
export function recordExternalQty(
  propertyId: string, channelId: string,
  units: Array<{ externalId: string | number; quantity?: number; maxPeople?: number }>,
) {
  const now = nowIso();
  for (const u of units) {
    run(
      `UPDATE channel_mappings
          SET external_qty = ?, external_max_people = ?, external_seen_at = ?
        WHERE property_id = ? AND channel_id = ? AND external_room_id = ?`,
      Number(u.quantity) || null, Number(u.maxPeople) || null, now,
      propertyId, channelId, String(u.externalId));
  }
}

/**
 * Tell somebody the two sides disagree.
 *
 * Raised on sync rather than waiting for the number to become an arriving guest
 * with nowhere to sleep.
 */
export function notifyDrift(propertyId: string) {
  const drift = inventoryDrift(propertyId);
  if (!drift.length) return drift;

  const worst = drift.slice(0, 3)
    .map((d) => `${d.name}: Helio ${d.sellable}, channel ${d.externalQty}`)
    .join(' · ');

  notify(propertyId, {
    source: 'Channels',
    severity: drift.some((d) => (d.drift ?? 0) < 0) ? 'critical' : 'warn',
    title: `${drift.length} room type${drift.length === 1 ? '' : 's'} out of step with the channel`,
    // Negative drift is the dangerous direction: the channel is selling more
    // than exists.
    message: `${worst}${drift.length > 3 ? ` · and ${drift.length - 3} more` : ''}`,
    link: '#/channel-manager',
  });
  return drift;
}
