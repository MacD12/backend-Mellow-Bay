// ─────────────────────────────────────────────────────────────
// Extending and shortening a stay.
//
// `updateReservation` can already move dates, but it is the general amend path:
// it re-prices every unposted night, and if the room is no longer free it
// quietly drops the assignment. Neither is what the desk wants when a guest
// says "can I stay one more night?".
//
// Two differences matter here:
//
//   · Nights the guest already agreed keep their rate. Adding a fourth night
//     must not silently re-price the first three because a yield rule moved in
//     the meantime — the guest was quoted a number and expects to pay it.
//
//   · The room is never dropped behind the operator's back. If it is not free
//     for the extra nights, that is said plainly and the rooms that *are* free
//     are offered.
//
// Everything is previewable: `previewStayChange` answers the same questions
// `changeStayDates` will act on, without writing anything.
// ─────────────────────────────────────────────────────────────
import { all, get, run, scalar, tx } from '../db.ts';
import {
  id, nowIso, addDays, assertDate, dateRange, nightsBetween, HttpError, conflict, notFound,
} from '../lib/util.ts';
import { checkAvailability, isRoomFree, freeRooms } from './availability.ts';
import { quoteStay } from './pricing.ts';
import { validateStay } from './restrictions.ts';
import { audit } from './audit.ts';
import { type Actor, queueChannelPush } from './reservations.ts';

export interface StayChangeInput {
  arrival?: string;
  departure?: string;
  /** Chosen when the current room cannot cover the new dates. */
  roomId?: string | null;
  /** Continue with no room assigned rather than picking one. */
  releaseRoom?: boolean;
  reason?: string;
}

interface NightRow {
  id: string; date: string; rate_minor: number; posted: number;
  room_id: string | null; bed_id: string | null;
  room_type_id: string; rate_plan_id: string; adults: number; children: number;
}

function loadReservation(propertyId: string, reservationId: string) {
  const res = get<any>(
    `SELECT r.*, rt.name AS room_type_name, rt.kind AS room_type_kind, rm.number AS room_number
       FROM reservations r
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
      WHERE r.id = ? AND r.property_id = ?`,
    reservationId, propertyId,
  );
  if (!res) notFound('Reservation');
  return res;
}

function nightsOf(reservationId: string): NightRow[] {
  return all<NightRow>(
    'SELECT * FROM reservation_nights WHERE reservation_id = ? ORDER BY date', reservationId);
}

/** What the amended stay is allowed to be, given where the reservation stands. */
function assertChangeable(res: any, arrival: string, departure: string) {
  if (['Checked-out', 'Cancelled', 'No-show'].includes(res.status)) {
    throw new HttpError(409,
      `A ${res.status.toLowerCase()} reservation's dates can no longer be changed`);
  }
  if (nightsBetween(arrival, departure) < 1) {
    throw new HttpError(400, 'A stay must be at least one night — cancel the booking instead');
  }
  if (res.status === 'Checked-in' && arrival !== res.arrival) {
    throw new HttpError(409,
      'Arrival cannot change after check-in. Shorten from the departure end, or move the room.');
  }
}

export interface StayChangePreview {
  ok: boolean;
  kind: 'extend' | 'shorten' | 'move' | 'none';
  current: { arrival: string; departure: string; nights: number; totalMinor: number };
  proposed: { arrival: string; departure: string; nights: number; totalMinor: number };
  addedNights: Array<{ date: string; rateMinor: number }>;
  removedNights: Array<{ date: string; rateMinor: number; posted: boolean }>;
  keptNights: number;
  deltaMinor: number;
  currency: string;
  /** The current room covers the new dates. */
  roomKept: boolean;
  roomNumber: string | null;
  alternativeRooms: Array<{ id: string; number: string; floor: number | null; status: string }>;
  /** Reasons the change cannot proceed as asked. */
  blockers: string[];
  /** Selling rules the new dates break, in words. */
  violations: Array<{ type: string; date: string; message: string }>;
}

export function previewStayChange(
  propertyId: string, reservationId: string, input: StayChangeInput,
): StayChangePreview {
  const res = loadReservation(propertyId, reservationId);
  const arrival = input.arrival ? assertDate(input.arrival, 'arrival') : res.arrival;
  const departure = input.departure ? assertDate(input.departure, 'departure') : res.departure;

  const blockers: string[] = [];
  try {
    assertChangeable(res, arrival, departure);
  } catch (e) {
    blockers.push(e instanceof HttpError ? e.message : String(e));
  }

  const existing = nightsOf(reservationId);
  const byDate = new Map(existing.map((n) => [n.date, n]));
  const newDates = nightsBetween(arrival, departure) >= 1 ? dateRange(arrival, departure) : [];
  const newDateSet = new Set(newDates);

  const removed = existing.filter((n) => !newDateSet.has(n.date));
  const addedDates = newDates.filter((d) => !byDate.has(d));
  const kept = newDates.length - addedDates.length;

  // A posted night has already been charged and counted in the day's revenue.
  // Removing it would silently unwind a closed business day.
  const postedRemoved = removed.filter((n) => n.posted === 1);
  if (postedRemoved.length) {
    blockers.push(
      `${postedRemoved.length} night(s) have already been posted by the night audit `
      + `(${postedRemoved.map((n) => n.date).join(', ')}). Void the charges first, or shorten to a later date.`,
    );
  }

  // Price only the new nights. The rest keep what the guest was quoted.
  const added: Array<{ date: string; rateMinor: number }> = [];
  if (addedDates.length) {
    const first = addedDates[0];
    const last = addedDates[addedDates.length - 1];
    const quote = quoteStay(propertyId, {
      roomTypeId: res.room_type_id, ratePlanId: res.rate_plan_id,
      arrival: first, departure: addDays(last, 1),
      adults: res.adults, children: res.children,
      channelCode: res.channel_code, bookedOn: res.created_at?.slice(0, 10),
      currency: res.currency,
    });
    const quoted = new Map(quote.nights.map((n: any) => [n.date, n.rateMinor]));
    for (const d of addedDates) added.push({ date: d, rateMinor: quoted.get(d) ?? 0 });
  }

  // Availability is only asked about the *added* nights. The nights already
  // held are this reservation's own — asking about them would have it compete
  // with itself.
  if (addedDates.length) {
    for (const d of addedDates) {
      const avail = checkAvailability(propertyId, res.room_type_id, d, addDays(d, 1), 1, reservationId);
      if (!avail.ok) {
        blockers.push(`No ${res.room_type_name} is free on ${d}.`);
        break;
      }
    }
  }

  const violations = newDates.length
    ? validateStay(propertyId, {
      roomTypeId: res.room_type_id, ratePlanId: res.rate_plan_id,
      arrival, departure, channelCode: res.channel_code,
      bookedOn: get<{ business_date: string }>(
        'SELECT business_date FROM properties WHERE id = ?', propertyId)!.business_date,
    })
    : [];

  // Dorm beds are held per bed, so "is the room free" is the wrong question.
  const roomKept = !res.room_id ? true
    : res.room_type_kind === 'dorm' ? true
      : isRoomFree(propertyId, res.room_id, arrival, departure, reservationId);

  const alternatives = roomKept || !res.room_id ? [] : freeRooms(
    propertyId, res.room_type_id, arrival, departure, reservationId,
  ).map((r: any) => ({ id: r.id, number: r.number, floor: r.floor ?? null, status: r.status }));

  const currentTotal = existing.reduce((sum, n) => sum + n.rate_minor, 0);
  const proposedTotal = newDates.reduce((sum, d) => {
    const held = byDate.get(d);
    if (held) return sum + held.rate_minor;
    return sum + (added.find((a) => a.date === d)?.rateMinor ?? 0);
  }, 0);

  const kind = addedDates.length && removed.length ? 'move'
    : addedDates.length ? 'extend'
      : removed.length ? 'shorten' : 'none';

  return {
    ok: blockers.length === 0,
    kind,
    current: {
      arrival: res.arrival, departure: res.departure,
      nights: existing.length, totalMinor: currentTotal,
    },
    proposed: { arrival, departure, nights: newDates.length, totalMinor: proposedTotal },
    addedNights: added,
    removedNights: removed.map((n) => ({
      date: n.date, rateMinor: n.rate_minor, posted: n.posted === 1,
    })),
    keptNights: kept,
    deltaMinor: proposedTotal - currentTotal,
    currency: res.currency,
    roomKept,
    roomNumber: res.room_number ?? null,
    alternativeRooms: alternatives,
    blockers,
    violations: violations.map((v) => ({ type: v.type, date: v.date, message: v.message })),
  };
}

export function changeStayDates(
  propertyId: string, actor: Actor, reservationId: string, input: StayChangeInput,
) {
  return tx(() => {
    const res = loadReservation(propertyId, reservationId);
    const arrival = input.arrival ? assertDate(input.arrival, 'arrival') : res.arrival;
    const departure = input.departure ? assertDate(input.departure, 'departure') : res.departure;
    assertChangeable(res, arrival, departure);

    const preview = previewStayChange(propertyId, reservationId, input);
    if (preview.kind === 'none') {
      throw new HttpError(400, 'Those are already the stay dates');
    }
    if (preview.blockers.length) {
      conflict(preview.blockers[0], { blockers: preview.blockers });
    }
    if (preview.violations.length) {
      // Explained, not just refused — the caller gets every rule that objects.
      conflict('The new dates break a selling restriction', { violations: preview.violations });
    }

    // ── Decide the room before anything is written ────────────
    let roomId: string | null = res.room_id;
    if (res.room_id && !preview.roomKept) {
      if (input.roomId) {
        if (!isRoomFree(propertyId, input.roomId, arrival, departure, reservationId)) {
          conflict('That room is not free for the new dates either');
        }
        roomId = input.roomId;
      } else if (input.releaseRoom) {
        roomId = null;
      } else {
        // Refusing here is the whole point: the old amend path dropped the room
        // silently, and a guest with no room number is a guest nobody can find.
        conflict(
          `Room ${res.room_number} is not free for the new dates. Choose another room, or release it.`,
          { roomConflict: true, alternativeRooms: preview.alternativeRooms },
        );
      }
    } else if (input.roomId && input.roomId !== res.room_id) {
      if (!isRoomFree(propertyId, input.roomId, arrival, departure, reservationId)) {
        conflict('That room is not free for the new dates');
      }
      roomId = input.roomId;
    }

    // ── Rewrite only the nights that changed ──────────────────
    const newDates = dateRange(arrival, departure);
    const newDateSet = new Set(newDates);
    const existing = nightsOf(reservationId);

    for (const n of existing) {
      if (!newDateSet.has(n.date)) {
        run('DELETE FROM reservation_nights WHERE id = ?', n.id);
      }
    }

    // Nights inside both the old and new range are left exactly as they are —
    // that is what keeps the guest's agreed rate.
    for (const night of preview.addedNights) {
      run(
        `INSERT INTO reservation_nights(id, reservation_id, property_id, date, room_type_id, room_id,
                                        bed_id, rate_plan_id, rate_minor, adults, children, posted)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,0)`,
        id('rn'), reservationId, propertyId, night.date, res.room_type_id, roomId,
        res.bed_id, res.rate_plan_id, night.rateMinor, res.adults, res.children,
      );
    }

    // A room change applies to every night, not only the new ones.
    if (roomId !== res.room_id) {
      run('UPDATE reservation_nights SET room_id = ? WHERE reservation_id = ?', roomId, reservationId);
    }

    const total = scalar<number>(
      'SELECT COALESCE(SUM(rate_minor),0) AS t FROM reservation_nights WHERE reservation_id = ?',
      reservationId,
    );
    run(
      `UPDATE reservations SET arrival = ?, departure = ?, nights = ?, total_minor = ?,
                               room_id = ?, updated_at = ?
        WHERE id = ?`,
      arrival, departure, newDates.length, total, roomId, nowIso(), reservationId,
    );

    audit(actor, {
      action: preview.kind === 'shorten' ? 'reservation.shorten' : 'reservation.extend',
      entity: 'RESERVATION', entityId: reservationId,
      entityRef: res.confirmation,
      before: { arrival: res.arrival, departure: res.departure, totalMinor: preview.current.totalMinor,
                room: res.room_number },
      after: { arrival, departure, totalMinor: total, roomId, reason: input.reason },
    });

    // Push the whole span either side of the change, so the nights that were
    // released are re-opened on the channels as well as the ones now held.
    const from = arrival < res.arrival ? arrival : res.arrival;
    const to = departure > res.departure ? departure : res.departure;
    queueChannelPush(propertyId, res.room_type_id, from, to,
      preview.kind === 'shorten' ? 'reservation.shorten' : 'reservation.extend');

    return {
      id: reservationId,
      kind: preview.kind,
      arrival,
      departure,
      nights: newDates.length,
      totalMinor: total,
      deltaMinor: total - preview.current.totalMinor,
      roomId,
      roomChanged: roomId !== res.room_id,
    };
  });
}
