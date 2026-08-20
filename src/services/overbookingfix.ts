// ─────────────────────────────────────────────────────────────
// Fixing an overbooking without turning anybody away.
//
// Most overbookings never need a walk. The order below is the one every good
// duty manager already follows, and it is worth writing down because the
// cheapest fix is also the one nobody notices:
//
//   1. **Reassign** — is a room of the same type actually free and just
//      unassigned? Nine times out of ten this is it, and no guest ever knows.
//   2. **Upgrade** — a better room sitting empty costs the rate difference. A
//      walk costs a night at another hotel, the taxi, the refund and the
//      review. The upgrade wins every time it is available.
//   3. **Downgrade with compensation** — worth offering to the right guest
//      before anyone is walked, with the credit recorded rather than promised.
//
// Only when all three are exhausted does anybody get walked, and that is a
// different file.
//
// Every option is offered per guest rather than per finding, because "which
// room is free" is the wrong question — the right one is "who can I move, and
// where to, for the whole of their remaining stay".
// ─────────────────────────────────────────────────────────────
import { all, get, run, tx } from '../db.ts';
import { id, nowIso, addDays, HttpError, notFound } from '../lib/util.ts';
import { freeRooms, checkAvailability } from './availability.ts';
import { moveRoom } from './reservations.ts';
import { ensureFolio, postCharge } from './folio.ts';
import { audit } from './audit.ts';
import { getFinding, listFindings, scanAndRecord } from './overbooking.ts';
import type { AuthContext } from '../auth.ts';

type Actor = Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>;

export interface RoomOption {
  roomId: string;
  number: string;
  floor: number | null;
  status: string;
  roomTypeId: string;
  roomType: string;
  /** Positive when the new room is dearer than the one booked. */
  rateDiffMinor: number;
}

export interface GuestOptions {
  reservationId: string;
  confirmation: string;
  guest: string;
  status: string;
  arrival: string;
  departure: string;
  nights: number;
  room: string | null;
  roomType: string;
  totalMinor: number;
  /** Cannot be moved at all, and why. */
  movable: boolean;
  blockedReason?: string;
  sameType: RoomOption[];
  upgrades: RoomOption[];
  downgrades: RoomOption[];
}

/**
 * Room types ordered by what they normally sell for.
 *
 * `default_rate_minor` is the honest proxy for "better": it is the property's
 * own statement of what each type is worth, kept current because it is what
 * gets charged. Anything else — occupancy, a name containing "Deluxe" — is a
 * guess about somebody else's inventory.
 */
function typeValue(propertyId: string): Map<string, { rate: number; name: string; kind: string }> {
  const map = new Map<string, { rate: number; name: string; kind: string }>();
  for (const rt of all<any>(
    'SELECT id, name, kind, default_rate_minor FROM room_types WHERE property_id = ?', propertyId)) {
    map.set(rt.id, { rate: rt.default_rate_minor, name: rt.name, kind: rt.kind });
  }
  return map;
}

/**
 * What can be done about a finding, guest by guest.
 *
 * A room only counts as an option if it is free for the guest's **whole
 * remaining stay** — offering a room that is free tonight and sold tomorrow
 * turns one problem into two.
 */
export function resolutionOptions(propertyId: string, findingId: string, today: string) {
  const finding = getFinding(propertyId, findingId);
  const values = typeValue(propertyId);
  const bookings = all<any>(
    `SELECT r.*, rt.name AS room_type_name, rm.number AS room_number
       FROM reservations r
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
      WHERE r.property_id = ?
        AND r.status IN ('Tentative','Confirmed','Guaranteed','Checked-in')
        AND r.arrival <= ? AND r.departure > ?
        AND (? IS NULL OR r.room_type_id = ?)
      ORDER BY r.arrival`,
    propertyId, finding.date, finding.date, finding.room_type_id, finding.room_type_id,
  );

  const guests: GuestOptions[] = bookings.map((res) => {
    const booked = values.get(res.room_type_id);
    // A checked-in guest is asleep in the room. Moving them mid-stay is a
    // different, much bigger conversation than reassigning an arrival.
    const blocked = res.status === 'Checked-in'
      ? 'Already checked in — moving them means moving their belongings'
      : undefined;

    const free = blocked ? [] : freeRooms(propertyId, null, finding.date, res.departure, res.id);

    // A physically empty room is not the same as a sellable one. A Deluxe with
    // no name on it is still spoken for if a Deluxe booking exists without a
    // room assigned — moving somebody into it would solve this overbooking by
    // creating another one next door. So the room type has to have real
    // capacity as well, for the whole of the remaining stay.
    const typeHasRoom = new Map<string, boolean>();
    const sellable = (roomTypeId: string): boolean => {
      if (roomTypeId === res.room_type_id) return true;   // the type they already hold
      let ok = typeHasRoom.get(roomTypeId);
      if (ok === undefined) {
        ok = checkAvailability(
          propertyId, roomTypeId, finding.date, res.departure, 1, res.id).ok;
        typeHasRoom.set(roomTypeId, ok);
      }
      return ok;
    };

    const options: RoomOption[] = free
      .filter((room: any) => values.get(room.room_type_id)?.kind !== 'dorm')
      .filter((room: any) => sellable(room.room_type_id))
      .map((room: any) => {
        const target = values.get(room.room_type_id);
        return {
          roomId: room.id,
          number: room.number,
          floor: room.floor ?? null,
          status: room.status,
          roomTypeId: room.room_type_id,
          roomType: target?.name ?? 'Unknown',
          rateDiffMinor: (target?.rate ?? 0) - (booked?.rate ?? 0),
        };
      });

    return {
      reservationId: res.id,
      confirmation: res.confirmation,
      guest: res.guest_name,
      status: res.status,
      arrival: res.arrival,
      departure: res.departure,
      nights: res.nights,
      room: res.room_number ?? null,
      roomType: res.room_type_name,
      totalMinor: res.total_minor,
      movable: !blocked,
      blockedReason: blocked,
      sameType: options.filter((o) => o.roomTypeId === res.room_type_id),
      upgrades: options
        .filter((o) => o.roomTypeId !== res.room_type_id && o.rateDiffMinor > 0)
        .sort((a, b) => a.rateDiffMinor - b.rateDiffMinor),
      downgrades: options
        .filter((o) => o.roomTypeId !== res.room_type_id && o.rateDiffMinor <= 0)
        .sort((a, b) => b.rateDiffMinor - a.rateDiffMinor),
    };
  });

  // A walk becomes real when there is nowhere for the *displaced* guests to go.
  //
  // Counting "does anybody have an option" is the wrong test: with three guests
  // and two rooms of their own type, two of them have somewhere to sleep and
  // the third still does not. What matters is how many rooms exist **outside**
  // the oversold type, against how many guests are over.
  const spareRooms = new Set<string>();
  for (const g of guests) {
    for (const o of [...g.upgrades, ...g.downgrades]) spareRooms.add(o.roomId);
  }

  return {
    findingId,
    date: finding.date,
    oversold: finding.oversold,
    guests,
    spareRooms: spareRooms.size,
    /** Nowhere left to put the guests who are over — a walk is now on the table. */
    walkLikely: spareRooms.size < finding.oversold,
    today,
  };
}

// ─── Applying a fix ──────────────────────────────────────────

type FixKind = 'reassign' | 'upgrade' | 'downgrade';

const FIX_LABEL: Record<FixKind, string> = {
  reassign: 'Reassigned to a free room',
  upgrade: 'Guest upgraded',
  downgrade: 'Guest downgraded with compensation',
};

export function applyFix(propertyId: string, actor: Actor, input: {
  findingId: string;
  reservationId: string;
  roomId: string;
  kind: FixKind;
  /** Downgrades only — posted as a credit on the folio. */
  compensationMinor?: number;
  note?: string;
}) {
  const finding = getFinding(propertyId, input.findingId);
  const res = get<any>('SELECT * FROM reservations WHERE id = ? AND property_id = ?',
    input.reservationId, propertyId);
  if (!res) notFound('Reservation');
  const room = get<any>('SELECT * FROM rooms WHERE id = ? AND property_id = ?',
    input.roomId, propertyId);
  if (!room) notFound('Room');

  const values = typeValue(propertyId);
  const before = values.get(res.room_type_id);
  const after = values.get(room.room_type_id);
  const diff = (after?.rate ?? 0) - (before?.rate ?? 0);

  if (input.kind === 'upgrade' && diff <= 0) {
    throw new HttpError(400, `${room.number} is not an upgrade on ${before?.name ?? 'this room type'}`);
  }
  if (input.kind === 'downgrade' && diff > 0) {
    throw new HttpError(400, `${room.number} is dearer — that is an upgrade, not a downgrade`);
  }

  const result = tx(() => {
    // An upgrade keeps the rate the guest agreed. That is what makes it a
    // courtesy rather than a surprise bill — the property absorbs the
    // difference, which is still far cheaper than walking them.
    const keepRate = input.kind !== 'downgrade';
    moveRoom(propertyId, actor, input.reservationId, {
      roomId: input.roomId,
      reason: `Overbooking fix · ${FIX_LABEL[input.kind]}`,
      keepRate,
    });

    let creditMinor = 0;
    if (input.kind === 'downgrade' && (input.compensationMinor ?? 0) > 0) {
      creditMinor = input.compensationMinor!;
      const folio = ensureFolio(propertyId, input.reservationId, res.guest_name);
      postCharge(propertyId, actor, {
        folioId: folio.id,
        code: 'ADJ',
        description: `Compensation · moved to ${room.number} (overbooking)`,
        // Negative, because a compensation reduces what the guest owes. Posting
        // it now rather than promising it is the difference between a goodwill
        // gesture and an argument at check-out.
        unitMinor: -creditMinor,
        businessDate: get<{ business_date: string }>(
          'SELECT business_date FROM properties WHERE id = ?', propertyId)!.business_date,
        reservationId: input.reservationId,
        applyTax: false,
      });
    }

    run(
      `INSERT INTO overbooking_fixes(id, property_id, overbooking_id, reservation_id, kind,
                                     from_room_type_id, to_room_type_id, room_id,
                                     rate_difference_minor, compensation_minor, note,
                                     applied_by, applied_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id('ofx'), propertyId, input.findingId, input.reservationId, input.kind,
      res.room_type_id, room.room_type_id, input.roomId,
      diff, creditMinor, input.note ?? null, actor.userName, nowIso(),
    );

    audit(actor, {
      action: 'overbooking.fix', entity: 'RESERVATION', entityId: input.reservationId,
      entityRef: res.confirmation,
      before: { room: res.room_id, roomType: before?.name, date: finding.date },
      after: {
        kind: input.kind, room: room.number, roomType: after?.name,
        // What the courtesy cost, so the property can total it later.
        rateDifferenceMinor: diff, compensationMinor: creditMinor,
      },
      elevated: true,
    });

    return { kind: input.kind, room: room.number, rateDifferenceMinor: diff, creditMinor };
  });

  // Re-scan the affected date. If the move actually fixed it the finding
  // auto-resolves; if it did not, it stays — which is the honest outcome, and
  // the reason the screen can say "fixed" rather than "we did the thing you
  // asked for".
  //
  // `to` is exclusive here, as everywhere: passing the same date twice scans
  // nothing and would report every fix as successful.
  const today = get<{ business_date: string }>(
    'SELECT business_date FROM properties WHERE id = ?', propertyId)!.business_date;
  const rescan = scanAndRecord(propertyId, actor, {
    from: finding.date, to: addDays(finding.date, 1), today,
  });
  const stillOpen = listFindings(propertyId, today)
    .some((f) => f.id === input.findingId);

  return { ...result, fixed: !stillOpen, autoResolved: rescan.autoResolved };
}

/** What the property's courtesies and compensation have cost. */
export function fixCosts(propertyId: string, from: string, to: string) {
  const rows = all<any>(
    `SELECT f.*, rt_from.name AS from_type, rt_to.name AS to_type, o.date AS stay_date
       FROM overbooking_fixes f
       LEFT JOIN room_types rt_from ON rt_from.id = f.from_room_type_id
       LEFT JOIN room_types rt_to ON rt_to.id = f.to_room_type_id
       LEFT JOIN overbookings o ON o.id = f.overbooking_id
      WHERE f.property_id = ? AND f.applied_at >= ? AND f.applied_at <= ?
      ORDER BY f.applied_at DESC`,
    propertyId, from, `${to}T23:59:59Z`,
  );
  return {
    fixes: rows.map((r) => ({
      id: r.id, kind: r.kind, stayDate: r.stay_date,
      fromType: r.from_type, toType: r.to_type,
      rateDifferenceMinor: r.rate_difference_minor,
      compensationMinor: r.compensation_minor,
      note: r.note, appliedBy: r.applied_by, appliedAt: r.applied_at,
    })),
    reassigned: rows.filter((r) => r.kind === 'reassign').length,
    upgraded: rows.filter((r) => r.kind === 'upgrade').length,
    downgraded: rows.filter((r) => r.kind === 'downgrade').length,
    // Only upgrades give value away; a reassignment costs nothing at all, which
    // is exactly why it is tried first.
    givenAwayMinor: rows
      .filter((r) => r.kind === 'upgrade')
      .reduce((sum, r) => sum + (r.rate_difference_minor ?? 0), 0),
    compensationMinor: rows.reduce((sum, r) => sum + (r.compensation_minor ?? 0), 0),
  };
}
