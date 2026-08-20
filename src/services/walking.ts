// ─────────────────────────────────────────────────────────────
// Walking a guest — sending somebody to another hotel because there is no room.
//
// This is the last resort, and the worst thing a property does to a person. The
// software's job is not to make it easy; it is to make it *considered*: suggest
// who is least harmed, say plainly why, and record what it cost so the property
// can see the true price of overbooking rather than remembering it as "rare".
//
// The ranking below is the one experienced duty managers use. It is offered as
// a suggestion with its reasoning shown, never as an automatic decision — who
// gets walked is a judgement about people, and it stays with the human.
// ─────────────────────────────────────────────────────────────
import { all, get, run, scalar, tx } from '../db.ts';
import { id, nowIso, addDays, nightsBetween, HttpError, notFound } from '../lib/util.ts';
import { ensureFolio, postCharge } from './folio.ts';
import { audit } from './audit.ts';
import { getFinding } from './overbooking.ts';
import type { AuthContext } from '../auth.ts';

type Actor = Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>;

export interface WalkCandidate {
  reservationId: string;
  confirmation: string;
  guest: string;
  status: string;
  arrival: string;
  departure: string;
  nights: number;
  roomType: string;
  room: string | null;
  totalMinor: number;
  rateMinor: number;
  vip: boolean;
  source: string;
  channelCode: string | null;
  groupId: string | null;
  previousStays: number;
  bookedAt: string;
  eta: string | null;
  /** Higher means "walk this one first". */
  score: number;
  /** Why they are ranked where they are, in words. */
  reasons: string[];
  /** Must not be walked, and why. */
  protectedFrom?: string;
}

/**
 * Rank who to walk.
 *
 * Two ideas do the work. **Protections** are absolute: a guest already asleep in
 * the room cannot be walked, and a long stay or a group means walking one person
 * unpicks a much larger booking. **Preferences** are about limiting harm: a
 * one-night guest who booked last week through an OTA and has never stayed
 * before loses the least by being sent up the road; a returning guest on night
 * four of seven loses a great deal.
 *
 * The scores are deliberately coarse. They exist to put the least-harmed guest
 * at the top of a list a person then reads — precision here would imply a
 * confidence the reasoning does not have.
 */
export function walkCandidates(
  propertyId: string, date: string, roomTypeId: string | null, today: string,
): WalkCandidate[] {
  const rows = all<any>(
    `SELECT r.*, rt.name AS room_type_name, rm.number AS room_number,
            (SELECT count(*) FROM reservations prev
              WHERE prev.property_id = r.property_id
                AND prev.profile_id IS NOT NULL
                AND prev.profile_id = r.profile_id
                AND prev.status = 'Checked-out') AS previous_stays
       FROM reservations r
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
      WHERE r.property_id = ?
        AND r.status IN ('Tentative','Confirmed','Guaranteed','Checked-in')
        AND r.arrival <= ? AND r.departure > ?
        AND (? IS NULL OR r.room_type_id = ?)`,
    propertyId, date, date, roomTypeId, roomTypeId,
  );

  return rows.map((res): WalkCandidate => {
    const reasons: string[] = [];
    let score = 0;
    let protectedFrom: string | undefined;

    // ── Absolute protections ──────────────────────────────────
    if (res.status === 'Checked-in') {
      protectedFrom = 'Already checked in — they are in the room tonight';
    } else if (res.vip === 1) {
      protectedFrom = 'VIP guest';
    } else if (res.group_id) {
      protectedFrom = 'Part of a group — walking one splits the booking';
    } else if (res.nights >= 4) {
      protectedFrom = `${res.nights}-night stay — walking a long stay means moving them back again`;
    } else if (res.previous_stays >= 3) {
      protectedFrom = `Returning guest — ${res.previous_stays} previous stays`;
    }

    // ── Preferences, least harm first ─────────────────────────
    if (res.nights === 1) {
      score += 40;
      reasons.push('One night only — the least disruption');
    } else {
      score += Math.max(0, 30 - res.nights * 8);
      reasons.push(`${res.nights}-night stay`);
    }

    if (res.previous_stays === 0) {
      score += 15;
      reasons.push('First stay — no relationship to damage');
    } else {
      score -= res.previous_stays * 10;
      reasons.push(`${res.previous_stays} previous stay(s)`);
    }

    // The lowest-value booking loses the least revenue and is cheapest to
    // rehouse. Scaled so a rate ten times another does not swamp everything.
    const perNight = res.nights > 0 ? Math.round(res.total_minor / res.nights) : res.total_minor;
    score += Math.max(-20, 20 - Math.round(perNight / 2000));
    reasons.push(`${Math.round(perNight / 100)} per night`);

    // A guest who booked yesterday has planned less around this hotel than one
    // who booked six months ago.
    const leadDays = nightsBetween(res.created_at.slice(0, 10), res.arrival);
    if (leadDays <= 7) {
      score += 10;
      reasons.push('Booked recently');
    } else if (leadDays > 60) {
      score -= 10;
      reasons.push(`Booked ${leadDays} days ahead`);
    }

    // Somebody who has said when they are arriving has made a plan.
    if (res.eta) {
      score -= 5;
      reasons.push(`Told us they arrive at ${res.eta}`);
    }

    if (protectedFrom) score = -1000;

    return {
      reservationId: res.id,
      confirmation: res.confirmation,
      guest: res.guest_name,
      status: res.status,
      arrival: res.arrival,
      departure: res.departure,
      nights: res.nights,
      roomType: res.room_type_name,
      room: res.room_number ?? null,
      totalMinor: res.total_minor,
      rateMinor: perNight,
      vip: res.vip === 1,
      source: res.source,
      channelCode: res.channel_code,
      groupId: res.group_id,
      previousStays: res.previous_stays,
      bookedAt: res.created_at,
      eta: res.eta ?? null,
      score,
      reasons,
      protectedFrom,
    };
  }).sort((a, b) => b.score - a.score);
}

export interface WalkInput {
  reservationId: string;
  findingId?: string;
  /** The night they cannot stay. Defaults to the finding's date. */
  date?: string;
  nights?: number;
  hotelName: string;
  hotelPhone?: string;
  roomCostMinor?: number;
  transportCostMinor?: number;
  compensationMinor?: number;
  /** Coming back for the rest of their stay. */
  returnsLater?: boolean;
  reason?: string;
}

/**
 * Record a walk and everything it cost.
 *
 * The costs are posted to the folio as credits rather than kept as a note,
 * because a guest who was walked should not be billed for the night they did not
 * stay, and the property should not have to remember that at check-out.
 */
export function walkGuest(propertyId: string, actor: Actor, input: WalkInput) {
  return tx(() => {
    const res = get<any>(
      `SELECT r.*, rt.name AS room_type_name FROM reservations r
         JOIN room_types rt ON rt.id = r.room_type_id
        WHERE r.id = ? AND r.property_id = ?`,
      input.reservationId, propertyId,
    );
    if (!res) notFound('Reservation');
    if (['Cancelled', 'No-show', 'Checked-out'].includes(res.status)) {
      throw new HttpError(409, `A ${res.status.toLowerCase()} booking cannot be walked`);
    }
    if (!input.hotelName?.trim()) {
      // Where the guest went is the one field that must not be blank: it is what
      // the night porter needs when the guest telephones at midnight.
      throw new HttpError(400, 'Record where the guest was sent');
    }

    const finding = input.findingId ? getFinding(propertyId, input.findingId) : null;
    const date = input.date ?? finding?.date ?? res.arrival;
    const nights = Math.max(1, input.nights ?? 1);
    const businessDate = get<{ business_date: string }>(
      'SELECT business_date FROM properties WHERE id = ?', propertyId)!.business_date;

    const walkId = id('wlk');
    run(
      `INSERT INTO walked_guests(id, property_id, reservation_id, overbooking_id, walked_on, nights,
                                 hotel_name, hotel_phone, room_cost_minor, transport_cost_minor,
                                 compensation_minor, returns_later, reason, authorised_by, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      walkId, propertyId, input.reservationId, input.findingId ?? null, date, nights,
      input.hotelName.trim(), input.hotelPhone ?? null,
      input.roomCostMinor ?? 0, input.transportCostMinor ?? 0, input.compensationMinor ?? 0,
      input.returnsLater ? 1 : 0, input.reason ?? null, actor.userName, nowIso(),
    );

    // The nights they cannot stay come off the booking. Charging somebody for a
    // room they were sent away from is the mistake that turns a bad night into a
    // complaint.
    const walkedDates: string[] = [];
    for (let i = 0; i < nights; i++) walkedDates.push(addDays(date, i));
    for (const d of walkedDates) {
      run(
        `DELETE FROM reservation_nights
          WHERE reservation_id = ? AND date = ? AND posted = 0`,
        input.reservationId, d,
      );
    }

    const remaining = scalar<number>(
      'SELECT count(*) AS n FROM reservation_nights WHERE reservation_id = ?', input.reservationId);

    if (remaining === 0 || !input.returnsLater) {
      // Nothing left of the stay — the booking is over, and saying so is more
      // honest than leaving a zero-night reservation on the arrivals list.
      run(
        `UPDATE reservations SET status = 'Cancelled', cancelled_at = ?, cancel_reason = ?,
                                 room_id = NULL, updated_at = ?
          WHERE id = ?`,
        nowIso(), `Walked to ${input.hotelName.trim()}`, nowIso(), input.reservationId,
      );
      if (remaining > 0) {
        run('DELETE FROM reservation_nights WHERE reservation_id = ? AND posted = 0',
          input.reservationId);
      }
    } else {
      const total = scalar<number>(
        'SELECT COALESCE(SUM(rate_minor),0) AS t FROM reservation_nights WHERE reservation_id = ?',
        input.reservationId,
      );
      const first = get<{ date: string }>(
        'SELECT MIN(date) AS date FROM reservation_nights WHERE reservation_id = ?',
        input.reservationId,
      );
      run(
        `UPDATE reservations SET arrival = ?, nights = ?, total_minor = ?, updated_at = ?
          WHERE id = ?`,
        first?.date ?? res.arrival, remaining, total, nowIso(), input.reservationId,
      );
    }

    // What the property owes the guest, posted rather than promised.
    const owed = (input.roomCostMinor ?? 0) + (input.transportCostMinor ?? 0)
      + (input.compensationMinor ?? 0);
    if (owed > 0) {
      const folio = ensureFolio(propertyId, input.reservationId, res.guest_name);
      postCharge(propertyId, actor, {
        folioId: folio.id,
        code: 'ADJ',
        description: `Walked to ${input.hotelName.trim()} — room, transport and compensation`,
        unitMinor: -owed,
        businessDate,
        reservationId: input.reservationId,
        applyTax: false,
      });
    }

    audit(actor, {
      action: 'reservation.walk', entity: 'RESERVATION', entityId: input.reservationId,
      entityRef: res.confirmation,
      before: { arrival: res.arrival, nights: res.nights, status: res.status },
      after: {
        walkedOn: date, nights, hotel: input.hotelName.trim(),
        roomCostMinor: input.roomCostMinor ?? 0,
        transportCostMinor: input.transportCostMinor ?? 0,
        compensationMinor: input.compensationMinor ?? 0,
        returnsLater: !!input.returnsLater, reason: input.reason,
      },
      elevated: true,
    });

    return {
      id: walkId,
      reservationId: input.reservationId,
      guest: res.guest_name,
      hotel: input.hotelName.trim(),
      nights,
      totalCostMinor: owed,
      returnsLater: !!input.returnsLater && remaining > 0,
      nightsRemaining: remaining,
    };
  });
}

/** What overbooking actually cost — the number that should decide the allowance. */
export function walkCosts(propertyId: string, from: string, to: string) {
  const rows = all<any>(
    `SELECT w.*, r.confirmation, r.guest_name, r.source, r.channel_code
       FROM walked_guests w
       JOIN reservations r ON r.id = w.reservation_id
      WHERE w.property_id = ? AND w.walked_on >= ? AND w.walked_on <= ?
      ORDER BY w.walked_on DESC`,
    propertyId, from, to,
  );
  const total = (pick: (r: any) => number) => rows.reduce((sum, r) => sum + pick(r), 0);
  return {
    walks: rows.map((w) => ({
      id: w.id, reservationId: w.reservation_id,
      confirmation: w.confirmation, guest: w.guest_name,
      walkedOn: w.walked_on, nights: w.nights,
      hotel: w.hotel_name, hotelPhone: w.hotel_phone,
      roomCostMinor: w.room_cost_minor,
      transportCostMinor: w.transport_cost_minor,
      compensationMinor: w.compensation_minor,
      totalCostMinor: w.room_cost_minor + w.transport_cost_minor + w.compensation_minor,
      returnsLater: w.returns_later === 1,
      reason: w.reason, authorisedBy: w.authorised_by, createdAt: w.created_at,
      source: w.source, channelCode: w.channel_code,
    })),
    count: rows.length,
    guestNights: total((r) => r.nights),
    roomCostMinor: total((r) => r.room_cost_minor),
    transportCostMinor: total((r) => r.transport_cost_minor),
    compensationMinor: total((r) => r.compensation_minor),
    totalCostMinor: total((r) => r.room_cost_minor + r.transport_cost_minor + r.compensation_minor),
    averageCostMinor: rows.length
      ? Math.round(total((r) => r.room_cost_minor + r.transport_cost_minor + r.compensation_minor)
        / rows.length)
      : 0,
  };
}
