// ─────────────────────────────────────────────────────────────
// Reservation lifecycle: quote → book → amend → assign → check in →
// check out, plus cancellation, no-show and room moves.
//
// Every reservation owns one row per night (reservation_nights). That is the
// unit availability counts, pricing writes and the night audit posts, which
// is what makes multi-rate stays and mid-stay room moves correct instead of
// approximated.
// ─────────────────────────────────────────────────────────────
import { all, get, run, tx, jsonCol, parseJson, nextSequence, scalar } from '../db.ts';
import {
  id, nowIso, HttpError, dateRange, nightsBetween, addDays, conflict, notFound,
} from '../lib/util.ts';
import { checkAvailability, isRoomFree, freeRooms, freeBeds } from './availability.ts';
import { validateStay } from './restrictions.ts';
import { quoteStay } from './pricing.ts';
import { ensureFolio, foliosForReservation, postCharge, postPayment } from './folio.ts';
import { audit } from './audit.ts';
import { notify, reservationLink } from './notify.ts';
import { raise } from './alerts.ts';
import { nudgeQueue } from './channels.ts';
import type { AuthContext } from '../auth.ts';

export type Actor = Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>;

export const OPEN_STATUSES = ['Tentative', 'Confirmed', 'Guaranteed'] as const;

export interface ReservationRow {
  id: string; property_id: string; confirmation: string; status: string;
  profile_id: string | null; guest_name: string; email: string | null; phone: string | null;
  arrival: string; departure: string; nights: number; adults: number; children: number;
  room_type_id: string; room_id: string | null; bed_id: string | null; rate_plan_id: string;
  source: string; channel_code: string | null; ota_channel: string | null;
  ota_reference: string | null; segment: string | null;
  company_id: string | null; group_id: string | null; vip: number; eta: string | null; etd: string | null;
  special_requests: string | null; preferences: string | null; payment_method: string | null;
  deposit_required_minor: number; commission_minor: number; total_minor: number;
  promotion_id: string | null; currency: string; origin: string;
  created_by: string | null; created_at: string; updated_at: string;
  checked_in_at: string | null; checked_out_at: string | null;
  cancelled_at: string | null; cancel_reason: string | null; no_show_at: string | null;
  parent_id: string | null; card_last4: string | null;
}

function property(propertyId: string) {
  const p = get<any>('SELECT * FROM properties WHERE id = ?', propertyId);
  if (!p) throw new HttpError(404, 'Property not found');
  return p;
}

export function nextConfirmation(propertyId: string): string {
  const p = property(propertyId);
  const seq = nextSequence(propertyId, 'confirmation', 1);
  return `${p.code}-${new Date().getUTCFullYear()}-${String(seq).padStart(5, '0')}`;
}

// ─── Guest profile linking ───────────────────────────────────
export function findOrCreateProfile(propertyId: string, actor: Actor, input: {
  profileId?: string | null; name: string; email?: string; phone?: string;
  nationality?: string; vip?: boolean;
}): string | null {
  if (input.profileId) {
    const p = get<any>('SELECT id FROM profiles WHERE id = ? AND property_id = ?', input.profileId, propertyId);
    if (p) return p.id;
  }
  if (input.email) {
    const byEmail = get<any>(
      'SELECT id FROM profiles WHERE property_id = ? AND lower(email) = lower(?) AND merged_into IS NULL',
      propertyId, input.email,
    );
    if (byEmail) return byEmail.id;
  }
  if (!input.name) return null;
  const pid = id('pro');
  const parts = input.name.trim().split(/\s+/);
  run(
    `INSERT INTO profiles(id, property_id, type, first_name, last_name, name, email, phone,
                          nationality, vip, created_at, updated_at)
     VALUES(?,?,'guest',?,?,?,?,?,?,?,?,?)`,
    pid, propertyId, parts[0] ?? null, parts.slice(1).join(' ') || null, input.name,
    input.email ?? null, input.phone ?? null, input.nationality ?? null,
    input.vip ? 1 : 0, nowIso(), nowIso(),
  );
  audit(actor, { action: 'profile.create', entity: 'PROFILE', entityId: pid, entityRef: input.name });
  return pid;
}

// ─── Create ──────────────────────────────────────────────────
export interface CreateReservationInput {
  guestName: string;
  email?: string;
  phone?: string;
  profileId?: string | null;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  roomTypeId: string;
  ratePlanId: string;
  roomId?: string | null;
  bedId?: string | null;
  status?: string;
  source?: string;
  channelCode?: string | null;
  /**
   * The OTA the booking actually came from, when `channelCode` is a hub.
   *
   * Beds24 sends "Hostelworld", "Booking.com", "Airbnb" and so on as `referer`.
   * Kept separate from `channelCode`, which names the connection that rate rules
   * and mappings are keyed on.
   */
  otaChannel?: string | null;
  otaReference?: string | null;
  segment?: string | null;
  companyId?: string | null;
  groupId?: string | null;
  vip?: boolean;
  eta?: string | null;
  etd?: string | null;
  specialRequests?: string | null;
  preferences?: string[];
  paymentMethod?: string | null;
  cardLast4?: string | null;
  promotionCode?: string | null;
  /** Manual per-night override, e.g. a negotiated rate. */
  rateOverrideMinor?: number | null;
  overrideReason?: string | null;
  depositRequiredMinor?: number | null;
  commissionMinor?: number | null;
  origin?: string;
  /** Skip availability/restriction gates — requires elevated permission. */
  force?: boolean;
}

export function createReservation(propertyId: string, actor: Actor, input: CreateReservationInput) {
  return tx(() => {
    const prop = property(propertyId);
    const nights = nightsBetween(input.arrival, input.departure);
    if (nights < 1) throw new HttpError(400, 'Departure must be at least one night after arrival');
    if (nights > 365) throw new HttpError(400, 'A single reservation cannot exceed 365 nights');
    if (input.arrival < addDays(prop.business_date, -1)) {
      throw new HttpError(400, `Arrival ${input.arrival} is before the open business date ${prop.business_date}`);
    }

    const roomType = get<any>('SELECT * FROM room_types WHERE id = ? AND property_id = ? AND active = 1',
      input.roomTypeId, propertyId);
    if (!roomType) notFound('Room type');
    const ratePlan = get<any>('SELECT * FROM rate_plans WHERE id = ? AND property_id = ?',
      input.ratePlanId, propertyId);
    if (!ratePlan) notFound('Rate plan');

    const guests = input.adults + input.children;
    if (roomType.kind === 'room' && guests > roomType.max_occupancy) {
      throw new HttpError(400,
        `${roomType.name} holds a maximum of ${roomType.max_occupancy} guest(s)`, 'over_occupancy');
    }

    // Gate 1 — inventory.
    if (!input.force) {
      const avail = checkAvailability(propertyId, input.roomTypeId, input.arrival, input.departure, 1);
      if (!avail.ok) {
        conflict(`${roomType.name} is not available for the whole stay`, { shortfall: avail.shortfall });
      }
    }

    // Gate 2 — restrictions.
    const bookedOn = prop.business_date;
    if (!input.force) {
      const violations = validateStay(propertyId, {
        roomTypeId: input.roomTypeId, ratePlanId: input.ratePlanId,
        arrival: input.arrival, departure: input.departure,
        channelCode: input.channelCode ?? null, bookedOn,
      });
      if (violations.length) {
        conflict('This stay breaks a selling restriction', { violations });
      }
    }

    // Price it.
    const quote = quoteStay(propertyId, {
      roomTypeId: input.roomTypeId, ratePlanId: input.ratePlanId,
      arrival: input.arrival, departure: input.departure,
      adults: input.adults, children: input.children,
      channelCode: input.channelCode ?? null,
      promotionCode: input.promotionCode ?? null,
      bookedOn, currency: prop.currency,
    });

    const override = input.rateOverrideMinor ?? null;
    const nightRates = quote.nights.map((n) => (override !== null ? override : n.rateMinor));
    const total = nightRates.reduce((s, r) => s + r, 0);

    // Room / bed assignment, when requested up-front.
    let roomId = input.roomId ?? null;
    let bedId = input.bedId ?? null;
    // Whole-room exclusivity does not apply to dorms — those are held per bed.
    if (roomId && roomType.kind !== 'dorm'
        && !isRoomFree(propertyId, roomId, input.arrival, input.departure)) {
      conflict('That room is already occupied or blocked for part of the stay');
    }
    if (roomType.kind === 'dorm' && bedId) {
      const free = freeBeds(propertyId, input.roomTypeId, input.arrival, input.departure)
        .some((b: any) => b.id === bedId);
      if (!free) conflict('That bed is already taken for part of the stay');
      const bed = get<any>('SELECT room_id FROM beds WHERE id = ?', bedId);
      roomId = bed?.room_id ?? null;
    }

    const profileId = findOrCreateProfile(propertyId, actor, {
      profileId: input.profileId, name: input.guestName, email: input.email,
      phone: input.phone, vip: input.vip,
    });

    const resId = id('res');
    const confirmation = nextConfirmation(propertyId);
    const status = input.status ?? 'Confirmed';

    run(
      `INSERT INTO reservations(
         id, property_id, confirmation, status, profile_id, guest_name, email, phone,
         arrival, departure, nights, adults, children, room_type_id, room_id, bed_id, rate_plan_id,
         source, channel_code, ota_channel, ota_reference, segment, company_id, group_id, vip, eta, etd,
         special_requests, preferences, payment_method, card_last4, deposit_required_minor,
         commission_minor, total_minor, promotion_id, currency, origin, created_by, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      resId, propertyId, confirmation, status, profileId, input.guestName,
      input.email ?? null, input.phone ?? null,
      input.arrival, input.departure, nights, input.adults, input.children,
      input.roomTypeId, roomId, bedId, input.ratePlanId,
      input.source ?? 'Direct', input.channelCode ?? null, input.otaChannel ?? null,
      input.otaReference ?? null,
      input.segment ?? null, input.companyId ?? null, input.groupId ?? null,
      input.vip ? 1 : 0, input.eta ?? null, input.etd ?? null,
      input.specialRequests ?? null, jsonCol(input.preferences ?? []),
      input.paymentMethod ?? null, input.cardLast4 ?? null,
      input.depositRequiredMinor ?? 0, input.commissionMinor ?? 0, total,
      quote.promotionId ?? null, prop.currency, input.origin ?? 'pms',
      actor.userName, nowIso(), nowIso(),
    );

    const dates = dateRange(input.arrival, input.departure);
    dates.forEach((date, i) => {
      run(
        `INSERT INTO reservation_nights(id, reservation_id, property_id, date, room_type_id, room_id,
                                        bed_id, rate_plan_id, rate_minor, adults, children, posted)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,0)`,
        id('rn'), resId, propertyId, date, input.roomTypeId, roomId, bedId,
        input.ratePlanId, nightRates[i], input.adults, input.children,
      );
    });

    run(
      `INSERT INTO reservation_guests(id, reservation_id, profile_id, name, is_primary, kind, created_at)
       VALUES(?,?,?,?,1,'adult',?)`,
      id('rg'), resId, profileId, input.guestName, nowIso(),
    );

    ensureFolio(propertyId, resId, input.guestName);

    if (quote.promotionId) {
      run('UPDATE promotions SET used_count = used_count + 1 WHERE id = ?', quote.promotionId);
    }

    audit(actor, {
      action: 'reservation.create', entity: 'RESERVATION', entityId: resId,
      entityRef: `${confirmation} · ${input.guestName}`,
      after: {
        arrival: input.arrival, departure: input.departure, roomType: roomType.code,
        ratePlan: ratePlan.code, totalMinor: total, status,
        override: override !== null ? { rateMinor: override, reason: input.overrideReason } : undefined,
      },
      elevated: override !== null || !!input.force,
    });

    queueChannelPush(propertyId, input.roomTypeId, input.arrival, input.departure, 'reservation.create');

    // Says what arrived, not that something arrived. The confirmation, guest,
    // dates and origin are the four things somebody glancing at the bell needs
    // before deciding whether to open it.
    notify(propertyId, {
      source: 'Reservations',
      severity: 'success',
      title: `New booking · ${input.guestName}`,
      message: `${confirmation} · ${nights} night${nights === 1 ? '' : 's'} from ${input.arrival}`
        + ` · ${roomType.name}${input.channelCode ? ` · ${input.channelCode}` : ''}`,
      link: reservationLink(resId),
    });

    raise(propertyId, {
      kind: 'booking.new',
      title: `New booking · ${input.guestName}`,
      body: `${roomType.name} · ${input.arrival} → ${input.departure} · ${confirmation}`
        + (input.channelCode ? ` · ${input.channelCode}` : ''),
      reservationId: resId,
    });

    // Check these dates and shut them on the OTAs if this booking took the last
    // room. Queued rather than run inline: it writes to the channels and must
    // not hold the write lock — or fail — while a booking is being confirmed.
    guardAfter(propertyId, actor, input.roomTypeId, input.arrival, input.departure, prop.business_date);

    return getReservationDetail(propertyId, resId);
  });
}

/**
 * Run the overbooking guard once the current transaction has committed.
 *
 * The import is dynamic because the guard reaches back into this module's
 * neighbours; loading it lazily keeps the module graph acyclic without moving
 * anything. Failures are logged and swallowed — a booking that succeeded must
 * not be reported as failed because a channel would not take a close.
 */
function guardAfter(
  propertyId: string, actor: Actor,
  roomTypeId: string, from: string, to: string, today: string,
) {
  setImmediate(() => {
    void import('./overbooking.ts')
      .then(({ guardInventory }) =>
        guardInventory(propertyId, actor, { roomTypeId, from, to: addDays(to, -1), today }))
      .catch((e) => process.stderr.write(
        `[overbooking] guard failed for ${roomTypeId} ${from}→${to}: `
        + `${e instanceof Error ? e.message : String(e)}\n`));
  });
}

// ─── Read ────────────────────────────────────────────────────
// Exported so the benchmark can profile the exact query the list runs, rather
// than a copy of it that has since drifted.
export const RES_SELECT = `
  SELECT r.*, rt.code AS room_type_code, rt.name AS room_type_name, rt.kind AS room_type_kind,
         rp.code AS rate_plan_code, rp.name AS rate_plan_name,
         rm.number AS room_number, b.code AS bed_code,
         g.code AS group_code, c.name AS company_name
    FROM reservations r
    JOIN room_types rt ON rt.id = r.room_type_id
    JOIN rate_plans rp ON rp.id = r.rate_plan_id
    LEFT JOIN rooms rm ON rm.id = r.room_id
    LEFT JOIN beds b   ON b.id = r.bed_id
    LEFT JOIN groups g ON g.id = r.group_id
    LEFT JOIN companies c ON c.id = r.company_id`;

export interface ListFilters {
  status?: string[];
  arrivalFrom?: string;
  arrivalTo?: string;
  inHouseOn?: string;
  departureOn?: string;
  arrivalOn?: string;
  search?: string;
  roomTypeId?: string;
  groupId?: string;
  companyId?: string;
  profileId?: string;
  channelCode?: string;
  limit?: number;
  offset?: number;
}

/**
 * Build the WHERE clause shared by the list and its count.
 *
 * These two must never drift apart: a filter honoured by one and not the other
 * gives a page of results with a total that does not match it.
 */
function buildFilter(propertyId: string, f: ListFilters) {
  const where: string[] = ['r.property_id = ?'];
  const params: unknown[] = [propertyId];

  if (f.status?.length) {
    where.push(`r.status IN (${f.status.map(() => '?').join(',')})`);
    params.push(...f.status);
  }
  if (f.arrivalFrom) { where.push('r.arrival >= ?'); params.push(f.arrivalFrom); }
  if (f.arrivalTo) { where.push('r.arrival <= ?'); params.push(f.arrivalTo); }
  if (f.arrivalOn) { where.push('r.arrival = ?'); params.push(f.arrivalOn); }
  if (f.departureOn) { where.push('r.departure = ?'); params.push(f.departureOn); }
  if (f.inHouseOn) {
    where.push('r.arrival <= ? AND r.departure > ?');
    params.push(f.inHouseOn, f.inHouseOn);
  }
  if (f.roomTypeId) { where.push('r.room_type_id = ?'); params.push(f.roomTypeId); }
  if (f.groupId) { where.push('r.group_id = ?'); params.push(f.groupId); }
  if (f.companyId) { where.push('r.company_id = ?'); params.push(f.companyId); }
  if (f.profileId) { where.push('r.profile_id = ?'); params.push(f.profileId); }
  if (f.channelCode) { where.push('r.channel_code = ?'); params.push(f.channelCode); }
  if (f.search) {
    where.push(`(r.guest_name LIKE ? OR r.confirmation LIKE ? OR r.email LIKE ?
                 OR r.phone LIKE ? OR r.ota_reference LIKE ? OR rm.number LIKE ?)`);
    const like = `%${f.search}%`;
    params.push(like, like, like, like, like, like);
  }

  // The search predicate is the only one that reaches outside `reservations`,
  // so it is the only thing that can make a bare count need the rooms join.
  return { clause: where.join(' AND '), params, needsRooms: !!f.search };
}

export function listReservations(propertyId: string, f: ListFilters = {}) {
  const { clause, params } = buildFilter(propertyId, f);
  const limit = Math.min(f.limit ?? 200, 1000);
  const offset = f.offset ?? 0;
  const rows = all<any>(
    `${RES_SELECT} WHERE ${clause}
      ORDER BY r.arrival, r.guest_name LIMIT ${limit} OFFSET ${offset}`,
    ...params,
  );
  // Balances for the whole page in one query rather than one per row — this was
  // the single slowest thing on the busiest screen.
  //
  // Note the explicit arrow: `rows.map(shapeReservation)` hands `map`'s index
  // argument to the balance parameter, which is a quiet way to print money that
  // is wrong by a row number.
  const balances = reservationBalances(rows.map((r) => r.id));
  return rows.map((r) => shapeReservation(r, balances.get(r.id) ?? 0));
}

export function countReservations(propertyId: string, f: ListFilters = {}): number {
  const { clause, params, needsRooms } = buildFilter(propertyId, f);
  // Counting by fetching rows was both slow — every row shaped, every balance
  // summed — and wrong: it stopped at 1000, so a property past its first
  // thousand bookings saw a total that never moved.
  //
  // The rooms join is carried only when the search predicate needs it; for the
  // ordinary paging count it is pure cost.
  return scalar<number>(
    `SELECT count(*) AS n
       FROM reservations r
       ${needsRooms ? 'LEFT JOIN rooms rm ON rm.id = r.room_id' : ''}
      WHERE ${clause}`,
    ...params,
  );
}

export function shapeReservation(r: any, balance: number = reservationBalance(r.id)) {
  return {
    id: r.id,
    confirmation: r.confirmation,
    status: r.status,
    guest: r.guest_name,
    profileId: r.profile_id,
    email: r.email ?? '',
    phone: r.phone ?? '',
    arrival: r.arrival,
    departure: r.departure,
    nights: r.nights,
    adults: r.adults,
    children: r.children,
    roomTypeId: r.room_type_id,
    roomType: r.room_type_name,
    roomTypeCode: r.room_type_code,
    roomTypeKind: r.room_type_kind,
    room: r.room_number ?? undefined,
    roomId: r.room_id ?? undefined,
    bed: r.bed_code ?? undefined,
    bedId: r.bed_id ?? undefined,
    ratePlanId: r.rate_plan_id,
    rateCode: r.rate_plan_code,
    ratePlanName: r.rate_plan_name,
    rateMinor: r.nights > 0 ? Math.round(r.total_minor / r.nights) : 0,
    totalMinor: r.total_minor,
    balanceMinor: balance,
    depositRequiredMinor: r.deposit_required_minor,
    commissionMinor: r.commission_minor,
    currency: r.currency,
    source: r.source,
    channel: r.channel_code ?? undefined,
    // The OTA behind a hub connection, when there is one. Falls back to the
    // connection so a screen showing "where did this come from" is never blank.
    otaChannel: r.ota_channel ?? r.channel_code ?? undefined,
    otaReference: r.ota_reference ?? undefined,
    segment: r.segment ?? '',
    company: r.company_name ?? undefined,
    companyId: r.company_id ?? undefined,
    groupId: r.group_id ?? undefined,
    group: r.group_code ?? undefined,
    vip: r.vip === 1,
    eta: r.eta ?? undefined,
    etd: r.etd ?? undefined,
    specialRequests: r.special_requests ?? undefined,
    preferences: parseJson<string[]>(r.preferences, []),
    paymentMethod: r.payment_method ?? undefined,
    cardLast4: r.card_last4 ?? undefined,
    origin: r.origin,
    createdBy: r.created_by ?? '',
    createdOn: (r.created_at ?? '').slice(0, 10),
    checkedInAt: r.checked_in_at ?? undefined,
    checkedOutAt: r.checked_out_at ?? undefined,
    cancelledAt: r.cancelled_at ?? undefined,
    cancelReason: r.cancel_reason ?? undefined,
  };
}

export function reservationBalance(reservationId: string): number {
  return scalar<number>(
    `SELECT COALESCE(SUM(l.amount_minor), 0) AS total
       FROM folio_lines l JOIN folios f ON f.id = l.folio_id
      WHERE f.reservation_id = ? AND l.voided = 0`,
    reservationId,
  );
}

/**
 * The same sum for many reservations at once.
 *
 * A reservation may carry more than one folio, so the grouping is by
 * reservation rather than by folio. The join is a LEFT one with `voided = 0`
 * in the ON clause, not the WHERE: a reservation whose only lines are voided
 * must still appear in the result with a balance of zero, and moving that
 * condition to the WHERE clause would drop the row instead.
 */
export function reservationBalances(ids: string[]): Map<string, number> {
  const balances = new Map<string, number>();
  if (!ids.length) return balances;
  // SQLite's default host-parameter ceiling is 999 and a page can ask for
  // 1000, so the IN list is chunked rather than trusted.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = all<{ reservation_id: string; total: number }>(
      `SELECT f.reservation_id AS reservation_id,
              COALESCE(SUM(l.amount_minor), 0) AS total
         FROM folios f
         LEFT JOIN folio_lines l ON l.folio_id = f.id AND l.voided = 0
        WHERE f.reservation_id IN (${chunk.map(() => '?').join(',')})
        GROUP BY f.reservation_id`,
      ...chunk,
    );
    for (const row of rows) balances.set(row.reservation_id, row.total);
  }
  return balances;
}

export function getReservation(propertyId: string, reservationId: string) {
  const row = get<any>(`${RES_SELECT} WHERE r.id = ? AND r.property_id = ?`, reservationId, propertyId);
  if (!row) notFound('Reservation');
  return row;
}

export function getReservationDetail(propertyId: string, reservationId: string) {
  const row = getReservation(propertyId, reservationId);
  const base = shapeReservation(row);
  // `nights` stays the count everywhere in the API; the per-night ledger is
  // `nightRows` so a caller never has to guess which shape it got.
  const nightRows = all<any>(
    `SELECT n.*, rt.name AS room_type_name, rp.code AS rate_plan_code, rm.number AS room_number
       FROM reservation_nights n
       JOIN room_types rt ON rt.id = n.room_type_id
       JOIN rate_plans rp ON rp.id = n.rate_plan_id
       LEFT JOIN rooms rm ON rm.id = n.room_id
      WHERE n.reservation_id = ? ORDER BY n.date`,
    reservationId,
  ).map((n) => ({
    id: n.id, date: n.date, roomTypeId: n.room_type_id, roomType: n.room_type_name,
    roomId: n.room_id, room: n.room_number ?? undefined, ratePlanId: n.rate_plan_id,
    rateCode: n.rate_plan_code, rateMinor: n.rate_minor, adults: n.adults,
    children: n.children, posted: n.posted === 1,
  }));
  const folios = foliosForReservation(reservationId).map((f) => ({
    id: f.id, number: f.number, name: f.name, type: f.type, windowNo: f.window_no,
    status: f.status, balanceMinor: f.balanceMinor,
  }));
  const guests = all<any>(
    'SELECT * FROM reservation_guests WHERE reservation_id = ? ORDER BY is_primary DESC, name',
    reservationId,
  ).map((g) => ({
    id: g.id, name: g.name, profileId: g.profile_id, isPrimary: g.is_primary === 1,
    kind: g.kind, registered: g.registered === 1,
  }));
  const notes = all<any>(
    'SELECT * FROM reservation_notes WHERE reservation_id = ? ORDER BY ts DESC',
    reservationId,
  ).map((n) => ({ id: n.id, ts: n.ts, user: n.user_name, category: n.category, body: n.body }));

  return { ...base, nightRows, folios, guests, notes };
}

// ─── Amend ───────────────────────────────────────────────────
export interface UpdateReservationInput {
  guestName?: string; email?: string; phone?: string;
  arrival?: string; departure?: string;
  adults?: number; children?: number;
  roomTypeId?: string; ratePlanId?: string;
  status?: string; segment?: string | null; source?: string;
  vip?: boolean; eta?: string | null; etd?: string | null;
  specialRequests?: string | null; preferences?: string[];
  paymentMethod?: string | null; companyId?: string | null;
  rateOverrideMinor?: number | null; overrideReason?: string | null;
  depositRequiredMinor?: number | null;
  force?: boolean;
}

export function updateReservation(
  propertyId: string, actor: Actor, reservationId: string, input: UpdateReservationInput,
) {
  return tx(() => {
    const before = getReservation(propertyId, reservationId);
    if (['Checked-out', 'Cancelled'].includes(before.status)) {
      throw new HttpError(409, `A ${before.status.toLowerCase()} reservation can no longer be amended`);
    }

    const arrival = input.arrival ?? before.arrival;
    const departure = input.departure ?? before.departure;
    const roomTypeId = input.roomTypeId ?? before.room_type_id;
    const ratePlanId = input.ratePlanId ?? before.rate_plan_id;
    const adults = input.adults ?? before.adults;
    const children = input.children ?? before.children;

    const stayChanged =
      arrival !== before.arrival || departure !== before.departure ||
      roomTypeId !== before.room_type_id || ratePlanId !== before.rate_plan_id ||
      adults !== before.adults || children !== before.children ||
      input.rateOverrideMinor !== undefined && input.rateOverrideMinor !== null;

    const nights = nightsBetween(arrival, departure);
    if (nights < 1) throw new HttpError(400, 'Departure must be after arrival');

    if (before.status === 'Checked-in' && arrival !== before.arrival) {
      throw new HttpError(409, 'Arrival cannot change after check-in — use a room move or early departure');
    }

    let total = before.total_minor;
    if (stayChanged) {
      if (!input.force) {
        const avail = checkAvailability(propertyId, roomTypeId, arrival, departure, 1, reservationId);
        if (!avail.ok) conflict('Not available for the amended stay', { shortfall: avail.shortfall });
        const violations = validateStay(propertyId, {
          roomTypeId, ratePlanId, arrival, departure,
          channelCode: before.channel_code, bookedOn: property(propertyId).business_date,
        });
        if (violations.length) conflict('The amended stay breaks a selling restriction', { violations });
      }

      const quote = quoteStay(propertyId, {
        roomTypeId, ratePlanId, arrival, departure, adults, children,
        channelCode: before.channel_code, bookedOn: before.created_at.slice(0, 10),
        currency: before.currency,
      });

      // Nights already posted by the night audit keep their rate; the rest are
      // re-priced. Room assignment survives where the room is still free.
      const posted = new Map<string, any>(
        all<any>('SELECT * FROM reservation_nights WHERE reservation_id = ? AND posted = 1', reservationId)
          .map((n) => [n.date, n]),
      );
      run('DELETE FROM reservation_nights WHERE reservation_id = ? AND posted = 0', reservationId);

      const keepRoom = before.room_id && roomTypeId === before.room_type_id
        && isRoomFree(propertyId, before.room_id, arrival, departure, reservationId)
        ? before.room_id : null;

      const dates = dateRange(arrival, departure);
      dates.forEach((date, i) => {
        if (posted.has(date)) return;
        const rate = input.rateOverrideMinor ?? quote.nights[i].rateMinor;
        run(
          `INSERT INTO reservation_nights(id, reservation_id, property_id, date, room_type_id, room_id,
                                          bed_id, rate_plan_id, rate_minor, adults, children, posted)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,0)`,
          id('rn'), reservationId, propertyId, date, roomTypeId,
          keepRoom, before.bed_id, ratePlanId, rate, adults, children,
        );
      });
      total = scalar<number>(
        'SELECT COALESCE(SUM(rate_minor),0) AS t FROM reservation_nights WHERE reservation_id = ?',
        reservationId,
      );
      if (!keepRoom && before.room_id) {
        run('UPDATE reservations SET room_id = NULL WHERE id = ?', reservationId);
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (col: string, val: unknown) => { sets.push(`${col} = ?`); params.push(val); };

    if (input.guestName !== undefined) put('guest_name', input.guestName);
    if (input.email !== undefined) put('email', input.email);
    if (input.phone !== undefined) put('phone', input.phone);
    if (input.status !== undefined) put('status', input.status);
    if (input.segment !== undefined) put('segment', input.segment);
    if (input.source !== undefined) put('source', input.source);
    if (input.vip !== undefined) put('vip', input.vip ? 1 : 0);
    if (input.eta !== undefined) put('eta', input.eta);
    if (input.etd !== undefined) put('etd', input.etd);
    if (input.specialRequests !== undefined) put('special_requests', input.specialRequests);
    if (input.preferences !== undefined) put('preferences', jsonCol(input.preferences));
    if (input.paymentMethod !== undefined) put('payment_method', input.paymentMethod);
    if (input.companyId !== undefined) put('company_id', input.companyId);
    if (input.depositRequiredMinor !== undefined) put('deposit_required_minor', input.depositRequiredMinor);

    put('arrival', arrival);
    put('departure', departure);
    put('nights', nights);
    put('adults', adults);
    put('children', children);
    put('room_type_id', roomTypeId);
    put('rate_plan_id', ratePlanId);
    put('total_minor', total);
    put('updated_at', nowIso());
    params.push(reservationId);

    run(`UPDATE reservations SET ${sets.join(', ')} WHERE id = ?`, ...params);

    audit(actor, {
      action: 'reservation.update', entity: 'RESERVATION', entityId: reservationId,
      entityRef: before.confirmation,
      before: {
        arrival: before.arrival, departure: before.departure,
        adults: before.adults, children: before.children, totalMinor: before.total_minor,
        status: before.status,
      },
      after: { arrival, departure, adults, children, totalMinor: total, status: input.status ?? before.status },
      elevated: input.rateOverrideMinor !== undefined && input.rateOverrideMinor !== null,
    });

    if (stayChanged) {
      queueChannelPush(propertyId, before.room_type_id, before.arrival, before.departure, 'reservation.update');
      if (roomTypeId !== before.room_type_id || arrival !== before.arrival) {
        queueChannelPush(propertyId, roomTypeId, arrival, departure, 'reservation.update');
      }
    }
    return getReservationDetail(propertyId, reservationId);
  });
}

export function cancelReservation(
  propertyId: string, actor: Actor, reservationId: string,
  opts: { reason: string; chargeMinor?: number },
) {
  return tx(() => {
    const res = getReservation(propertyId, reservationId);
    if (res.status === 'Cancelled') throw new HttpError(409, 'Reservation is already cancelled');
    if (res.status === 'Checked-in') {
      throw new HttpError(409, 'An in-house reservation cannot be cancelled — check the guest out instead');
    }
    if (res.status === 'Checked-out') throw new HttpError(409, 'A departed reservation cannot be cancelled');

    run(
      `UPDATE reservations SET status = 'Cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
        WHERE id = ?`,
      nowIso(), opts.reason, nowIso(), reservationId,
    );
    run('DELETE FROM reservation_nights WHERE reservation_id = ? AND posted = 0', reservationId);

    if (opts.chargeMinor && opts.chargeMinor > 0) {
      const folio = ensureFolio(propertyId, reservationId, res.guest_name);
      postCharge(propertyId, actor, {
        folioId: folio.id, code: 'CXL', description: `Cancellation fee — ${opts.reason}`,
        unitMinor: opts.chargeMinor, businessDate: property(propertyId).business_date,
        applyTax: false, reservationId,
      });
    }

    audit(actor, {
      action: 'reservation.cancel', entity: 'RESERVATION', entityId: reservationId,
      entityRef: res.confirmation, before: { status: res.status },
      after: { status: 'Cancelled', reason: opts.reason, chargeMinor: opts.chargeMinor ?? 0 },
    });
    queueChannelPush(propertyId, res.room_type_id, res.arrival, res.departure, 'reservation.cancel');

    notify(propertyId, {
      source: 'Reservations',
      severity: 'warn',
      title: `Cancelled · ${res.guest_name}`,
      message: `${res.confirmation} · was arriving ${res.arrival}`
        + (opts.reason ? ` · ${opts.reason}` : ''),
      link: reservationLink(reservationId),
    });

    raise(propertyId, {
      kind: 'booking.cancelled',
      title: `Cancelled · ${res.guest_name}`,
      body: `${res.arrival} → ${res.departure} · ${res.confirmation}`
        + (opts.reason ? ` · ${opts.reason}` : ''),
      reservationId,
    });
    return getReservationDetail(propertyId, reservationId);
  });
}

// ─── Room assignment & moves ─────────────────────────────────
export function assignRoom(
  propertyId: string, actor: Actor, reservationId: string,
  opts: { roomId?: string | null; bedId?: string | null; fromDate?: string; auto?: boolean },
) {
  return tx(() => {
    const res = getReservation(propertyId, reservationId);
    if (['Cancelled', 'Checked-out', 'No-show'].includes(res.status)) {
      throw new HttpError(409, `Cannot assign a room to a ${res.status.toLowerCase()} reservation`);
    }
    const from = opts.fromDate ?? (res.checked_in_at ? property(propertyId).business_date : res.arrival);
    const roomType = get<any>('SELECT * FROM room_types WHERE id = ?', res.room_type_id);

    let roomId = opts.roomId ?? null;
    let bedId = opts.bedId ?? null;

    if (roomType.kind === 'dorm') {
      if (!bedId && opts.auto) {
        const beds = freeBeds(propertyId, res.room_type_id, from, res.departure, reservationId);
        if (!beds.length) conflict('No free bed of this type for the remaining nights');
        bedId = beds[0].id;
        roomId = beds[0].room_id;
      } else if (bedId) {
        const ok = freeBeds(propertyId, res.room_type_id, from, res.departure, reservationId)
          .some((b: any) => b.id === bedId);
        if (!ok) conflict('That bed is not free for the remaining nights');
        roomId = get<any>('SELECT room_id FROM beds WHERE id = ?', bedId)?.room_id ?? null;
      }
    }

    if (!roomId) {
      if (opts.auto) {
        const candidates = freeRooms(propertyId, res.room_type_id, from, res.departure, reservationId);
        if (!candidates.length) conflict('No free room of this type for the remaining nights');
        // Prefer a clean, inspected room, then the lowest floor/number.
        const ranked = candidates.sort((a: any, b: any) => {
          const score = (r: any) =>
            (r.status === 'Vacant Inspected' ? 0 : r.status === 'Vacant Clean' ? 1 : 2);
          return score(a) - score(b) || a.floor - b.floor || a.number.localeCompare(b.number);
        });
        roomId = ranked[0].id;
      } else {
        throw new HttpError(400, 'roomId is required (or pass auto=true)');
      }
    }

    if (!roomId) throw new HttpError(409, 'Could not resolve a room to assign');
    const room = get<any>('SELECT * FROM rooms WHERE id = ? AND property_id = ?', roomId, propertyId);
    if (!room) notFound('Room');
    if (room.room_type_id !== res.room_type_id) {
      throw new HttpError(400, 'Room is a different room type — change the reservation type first');
    }
    // A dorm is shared: many guests occupy the same room at once, so
    // exclusivity is enforced per bed (freeBeds, above) rather than per room.
    if (roomType.kind !== 'dorm'
        && !isRoomFree(propertyId, roomId, from, res.departure, reservationId)) {
      conflict('That room is not free for the remaining nights');
    }

    run(
      'UPDATE reservation_nights SET room_id = ?, bed_id = ? WHERE reservation_id = ? AND date >= ?',
      roomId, bedId, reservationId, from,
    );
    run('UPDATE reservations SET room_id = ?, bed_id = ?, updated_at = ? WHERE id = ?',
      roomId, bedId, nowIso(), reservationId);

    audit(actor, {
      action: 'reservation.assign-room', entity: 'RESERVATION', entityId: reservationId,
      entityRef: res.confirmation,
      before: { room: res.room_id }, after: { room: roomId, bed: bedId, fromDate: from },
    });
    return getReservationDetail(propertyId, reservationId);
  });
}

/** Mid-stay transfer: nights from `fromDate` onwards move to the new room. */
export function moveRoom(
  propertyId: string, actor: Actor, reservationId: string,
  opts: { roomId: string; fromDate?: string; reason?: string; keepRate?: boolean },
) {
  return tx(() => {
    const res = getReservation(propertyId, reservationId);
    const prop = property(propertyId);
    const from = opts.fromDate ?? prop.business_date;
    const target = get<any>('SELECT * FROM rooms WHERE id = ? AND property_id = ?', opts.roomId, propertyId);
    if (!target) notFound('Room');
    const targetType = get<any>('SELECT kind FROM room_types WHERE id = ?', target.room_type_id);
    // Moving into a dorm needs a free bed, not an empty room.
    if (targetType?.kind === 'dorm') {
      const beds = freeBeds(propertyId, target.room_type_id, from, res.departure, reservationId)
        .filter((b: any) => b.room_id === opts.roomId);
      if (!beds.length) conflict('That dorm has no free bed for the remaining nights');
    } else if (!isRoomFree(propertyId, opts.roomId, from, res.departure, reservationId)) {
      conflict('Target room is not free for the remaining nights');
    }

    const oldRoomId = res.room_id;
    const newTypeId = target.room_type_id;

    // Re-price the moved nights unless the guest keeps the original rate.
    if (!opts.keepRate && newTypeId !== res.room_type_id) {
      const quote = quoteStay(propertyId, {
        roomTypeId: newTypeId, ratePlanId: res.rate_plan_id,
        arrival: from, departure: res.departure,
        adults: res.adults, children: res.children,
        channelCode: res.channel_code, bookedOn: res.created_at.slice(0, 10), currency: res.currency,
      });
      const byDate = new Map(quote.nights.map((n) => [n.date, n.rateMinor]));
      for (const [date, rate] of byDate) {
        run(
          `UPDATE reservation_nights SET room_id = ?, room_type_id = ?, rate_minor = ?
            WHERE reservation_id = ? AND date = ? AND posted = 0`,
          opts.roomId, newTypeId, rate, reservationId, date,
        );
      }
    } else {
      run(
        `UPDATE reservation_nights SET room_id = ?, room_type_id = ?
          WHERE reservation_id = ? AND date >= ? AND posted = 0`,
        opts.roomId, newTypeId, reservationId, from,
      );
    }

    const total = scalar<number>(
      'SELECT COALESCE(SUM(rate_minor),0) AS t FROM reservation_nights WHERE reservation_id = ?',
      reservationId,
    );
    run(
      'UPDATE reservations SET room_id = ?, room_type_id = ?, total_minor = ?, updated_at = ? WHERE id = ?',
      opts.roomId, newTypeId, total, nowIso(), reservationId,
    );

    // Housekeeping: vacate the old room, occupy the new one.
    if (res.status === 'Checked-in') {
      if (oldRoomId) {
        // Same rule as check-out: a shared dorm the guest has left may still
        // be occupied by others.
        const stillOccupied = scalar<number>(
          `SELECT count(*) AS n FROM reservations
            WHERE property_id = ? AND room_id = ? AND status = 'Checked-in' AND id <> ?`,
          propertyId, oldRoomId, reservationId,
        );
        run('UPDATE rooms SET status = ? WHERE id = ?',
          stillOccupied > 0 ? 'Occupied Dirty' : 'Vacant Dirty', oldRoomId);
      }
      run(`UPDATE rooms SET status = 'Occupied Dirty' WHERE id = ?`, opts.roomId);
    }

    audit(actor, {
      action: 'reservation.room-move', entity: 'RESERVATION', entityId: reservationId,
      entityRef: res.confirmation,
      before: { room: oldRoomId }, after: { room: opts.roomId, fromDate: from, reason: opts.reason },
    });
    return getReservationDetail(propertyId, reservationId);
  });
}

// ─── Front desk transitions ──────────────────────────────────
export function checkIn(
  propertyId: string, actor: Actor, reservationId: string,
  opts: { roomId?: string; bedId?: string; paymentMinor?: number; paymentMethod?: string;
          idNumber?: string; idType?: string; registered?: boolean } = {},
) {
  return tx(() => {
    const prop = property(propertyId);
    const res = getReservation(propertyId, reservationId);
    if (res.status === 'Checked-in') throw new HttpError(409, 'Guest is already checked in');
    if (!OPEN_STATUSES.includes(res.status as any)) {
      throw new HttpError(409, `Cannot check in a ${res.status.toLowerCase()} reservation`);
    }
    if (res.arrival > prop.business_date) {
      throw new HttpError(409,
        `Arrival is ${res.arrival}; the open business date is ${prop.business_date}`, 'early_arrival');
    }

    if (opts.roomId || opts.bedId) {
      assignRoom(propertyId, actor, reservationId, {
        roomId: opts.roomId ?? null, bedId: opts.bedId ?? null, fromDate: res.arrival,
      });
    }
    const current = getReservation(propertyId, reservationId);
    const roomType = get<any>('SELECT * FROM room_types WHERE id = ?', current.room_type_id);
    if (roomType.kind === 'dorm' && !current.bed_id) {
      assignRoom(propertyId, actor, reservationId, { auto: true, fromDate: res.arrival });
    } else if (!current.room_id) {
      assignRoom(propertyId, actor, reservationId, { auto: true, fromDate: res.arrival });
    }

    const assigned = getReservation(propertyId, reservationId);
    const room = get<any>('SELECT * FROM rooms WHERE id = ?', assigned.room_id);
    if (!room) throw new HttpError(409, 'No room assigned — assign a room before checking in');
    if (['Out of Order', 'Out of Service'].includes(room.status)) {
      throw new HttpError(409, `Room ${room.number} is ${room.status}`);
    }
    if (room.status === 'Vacant Dirty') {
      throw new HttpError(409,
        `Room ${room.number} has not been cleaned yet`, 'room_not_ready', { roomStatus: room.status });
    }

    run(
      `UPDATE reservations SET status = 'Checked-in', checked_in_at = ?, updated_at = ? WHERE id = ?`,
      nowIso(), nowIso(), reservationId,
    );
    run(`UPDATE rooms SET status = 'Occupied Clean' WHERE id = ?`, assigned.room_id);
    if (assigned.bed_id) run(`UPDATE beds SET status = 'Occupied' WHERE id = ?`, assigned.bed_id);

    if (opts.registered) {
      run('UPDATE reservation_guests SET registered = 1, id_number = ? WHERE reservation_id = ? AND is_primary = 1',
        opts.idNumber ?? null, reservationId);
    }
    if (opts.idNumber && assigned.profile_id) {
      run('UPDATE profiles SET id_number = ?, id_type = ?, updated_at = ? WHERE id = ?',
        opts.idNumber, opts.idType ?? 'passport', nowIso(), assigned.profile_id);
    }

    const folio = ensureFolio(propertyId, reservationId, assigned.guest_name);
    if (opts.paymentMinor && opts.paymentMinor > 0) {
      postPayment(propertyId, actor, {
        folioId: folio.id, method: opts.paymentMethod ?? 'Cash',
        amountMinor: opts.paymentMinor, businessDate: prop.business_date,
        description: 'Deposit / advance payment at check-in',
      });
    }

    audit(actor, {
      action: 'reservation.check-in', entity: 'RESERVATION', entityId: reservationId,
      entityRef: `${assigned.confirmation} · room ${room.number}`,
      after: { room: room.number, at: nowIso() },
    });
    notify(propertyId, {
      source: 'Front Desk',
      severity: 'success',
      title: `Checked in · ${assigned.guest_name}`,
      message: `Room ${room.number} · ${assigned.confirmation}`,
      link: reservationLink(reservationId),
    });
    return getReservationDetail(propertyId, reservationId);
  });
}

export function checkOut(
  propertyId: string, actor: Actor, reservationId: string,
  opts: { settlementMinor?: number; method?: string; allowBalance?: boolean; toCityLedger?: boolean } = {},
) {
  return tx(() => {
    const prop = property(propertyId);
    const res = getReservation(propertyId, reservationId);
    if (res.status !== 'Checked-in') {
      throw new HttpError(409, `Only an in-house reservation can be checked out (status: ${res.status})`);
    }

    // Any unposted night up to today must be charged before departure.
    postOutstandingNights(propertyId, actor, reservationId, prop.business_date);

    const folios = foliosForReservation(reservationId);
    const outstanding = folios.reduce((s, f) => s + f.balanceMinor, 0);
    if (outstanding !== 0 && !opts.allowBalance && !opts.toCityLedger) {
      throw new HttpError(409,
        'The folio still has an outstanding balance', 'folio_has_balance',
        { balanceMinor: outstanding, folios: folios.map((f) => ({ id: f.id, number: f.number, balanceMinor: f.balanceMinor })) });
    }

    // Early departure — drop the nights the guest is not staying.
    if (prop.business_date < res.departure) {
      run('DELETE FROM reservation_nights WHERE reservation_id = ? AND date >= ? AND posted = 0',
        reservationId, prop.business_date);
      const nights = scalar<number>(
        'SELECT count(*) AS n FROM reservation_nights WHERE reservation_id = ?', reservationId);
      const total = scalar<number>(
        'SELECT COALESCE(SUM(rate_minor),0) AS t FROM reservation_nights WHERE reservation_id = ?', reservationId);
      run('UPDATE reservations SET departure = ?, nights = ?, total_minor = ? WHERE id = ?',
        prop.business_date, nights, total, reservationId);
      queueChannelPush(propertyId, res.room_type_id, prop.business_date, res.departure, 'early-departure');
    }

    run(
      `UPDATE reservations SET status = 'Checked-out', checked_out_at = ?, updated_at = ? WHERE id = ?`,
      nowIso(), nowIso(), reservationId,
    );
    if (res.room_id) {
      // A dorm only becomes vacant when its last guest has gone; while others
      // are still in it the room needs servicing, not turning over.
      const stillOccupied = scalar<number>(
        `SELECT count(*) AS n FROM reservations
          WHERE property_id = ? AND room_id = ? AND status = 'Checked-in' AND id <> ?`,
        propertyId, res.room_id, reservationId,
      );
      run('UPDATE rooms SET status = ? WHERE id = ?',
        stillOccupied > 0 ? 'Occupied Dirty' : 'Vacant Dirty', res.room_id);
      // Queue the departure clean for today.
      run(
        `INSERT INTO hk_tasks(id, property_id, date, room_id, type, status, priority, created_at)
         VALUES(?,?,?,?,'departure','pending','high',?)
         ON CONFLICT(property_id, date, room_id, type) DO NOTHING`,
        id('hk'), propertyId, prop.business_date, res.room_id, nowIso(),
      );
    }
    if (res.bed_id) run(`UPDATE beds SET status = 'Vacant Dirty' WHERE id = ?`, res.bed_id);

    for (const f of folios) {
      if (f.balanceMinor === 0 && f.status === 'open') {
        run(`UPDATE folios SET status = 'closed', closed_at = ? WHERE id = ?`, nowIso(), f.id);
      }
    }

    if (res.profile_id) {
      run(`UPDATE profiles SET loyalty_points = loyalty_points + ?, updated_at = ? WHERE id = ?`,
        Math.max(0, Math.round(res.total_minor / 100)), nowIso(), res.profile_id);
    }

    audit(actor, {
      action: 'reservation.check-out', entity: 'RESERVATION', entityId: reservationId,
      entityRef: res.confirmation, after: { at: nowIso(), balanceMinor: outstanding },
      elevated: outstanding !== 0,
    });
    notify(propertyId, {
      source: 'Front Desk',
      // A guest who left owing money is the one check-out somebody must see.
      severity: outstanding !== 0 ? 'warn' : 'info',
      title: `Checked out · ${res.guest_name}`,
      message: outstanding !== 0
        ? `${res.confirmation} · left with a balance of ${(outstanding / 100).toFixed(2)}`
        : `${res.confirmation} · folio settled`,
      link: reservationLink(reservationId),
    });
    return getReservationDetail(propertyId, reservationId);
  });
}

/** Post any room night that is due but not yet charged (used at check-out). */
export function postOutstandingNights(
  propertyId: string, actor: Actor, reservationId: string, upToDate: string,
): number {
  const res = getReservation(propertyId, reservationId);
  const folio = ensureFolio(propertyId, reservationId, res.guest_name);
  const due = all<any>(
    `SELECT n.*, rt.name AS room_type_name FROM reservation_nights n
       JOIN room_types rt ON rt.id = n.room_type_id
      WHERE n.reservation_id = ? AND n.posted = 0 AND n.date < ?
      ORDER BY n.date`,
    reservationId, upToDate,
  );
  let posted = 0;
  for (const n of due) {
    postCharge(propertyId, actor, {
      folioId: folio.id,
      code: 'ROOM',
      description: `Room charge — ${n.room_type_name} — ${n.date}`,
      unitMinor: n.rate_minor,
      businessDate: n.date,
      reservationId,
      persons: n.adults + n.children,
      nights: 1,
      taxScope: 'room',
    });
    run('UPDATE reservation_nights SET posted = 1 WHERE id = ?', n.id);
    posted++;
  }
  return posted;
}

export function markNoShow(
  propertyId: string, actor: Actor, reservationId: string, opts: { chargeMinor?: number } = {},
) {
  return tx(() => {
    const prop = property(propertyId);
    const res = getReservation(propertyId, reservationId);
    if (!OPEN_STATUSES.includes(res.status as any)) {
      throw new HttpError(409, `Cannot mark a ${res.status.toLowerCase()} reservation as no-show`);
    }
    run(
      `UPDATE reservations SET status = 'No-show', no_show_at = ?, updated_at = ? WHERE id = ?`,
      nowIso(), nowIso(), reservationId,
    );
    run('DELETE FROM reservation_nights WHERE reservation_id = ? AND posted = 0', reservationId);

    const charge = opts.chargeMinor ?? 0;
    if (charge > 0) {
      const folio = ensureFolio(propertyId, reservationId, res.guest_name);
      postCharge(propertyId, actor, {
        folioId: folio.id, code: 'NOSHOW', description: 'No-show charge',
        unitMinor: charge, businessDate: prop.business_date, reservationId, applyTax: true,
      });
    }
    audit(actor, {
      action: 'reservation.no-show', entity: 'RESERVATION', entityId: reservationId,
      entityRef: res.confirmation, after: { chargeMinor: charge },
    });
    notify(propertyId, {
      source: 'Front Desk',
      severity: 'warn',
      title: `No-show · ${res.guest_name}`,
      message: `${res.confirmation} · was due ${res.arrival}`
        + (charge > 0 ? ` · charged ${(charge / 100).toFixed(2)}` : ' · not charged'),
      link: reservationLink(reservationId),
    });
    queueChannelPush(propertyId, res.room_type_id, res.arrival, res.departure, 'no-show');
    return getReservationDetail(propertyId, reservationId);
  });
}

export function addNote(propertyId: string, actor: Actor, reservationId: string, body: string, category = 'general') {
  getReservation(propertyId, reservationId);
  const noteId = id('rnote');
  run(
    'INSERT INTO reservation_notes(id, reservation_id, ts, user_name, category, body) VALUES(?,?,?,?,?,?)',
    noteId, reservationId, nowIso(), actor.userName, category, body,
  );
  return get<any>('SELECT * FROM reservation_notes WHERE id = ?', noteId);
}

// ─── Channel push queue ──────────────────────────────────────
/** Any inventory movement queues an ARI push for the affected dates. */
export function queueChannelPush(
  propertyId: string, roomTypeId: string, from: string, to: string, reason: string,
) {
  const channels = all<{ id: string }>(
    // Queue for channels in error too. A channel is marked `error` by one
    // failed call, and a price or availability change made in that window would
    // otherwise never be recorded at all — not delayed, *lost*. Queueing is
    // free; the drain retries until it lands.
    `SELECT id FROM channels WHERE property_id = ? AND active = 1
       AND status IN ('connected', 'error')`,
    propertyId,
  );
  for (const c of channels) {
    run(
      `INSERT INTO channel_queue(id, property_id, channel_id, room_type_id, date_from, date_to,
                                 scope, reason, status, created_at)
       VALUES(?,?,?,?,?,?,'availability',?,'queued',?)`,
      id('cq'), propertyId, c.id, roomTypeId, from, to, reason, nowIso(),
    );
  }
  // Ask for a drain rather than waiting for the next tick.
  nudgeQueue();
}

// ─── Walk-in helper ──────────────────────────────────────────
export function createWalkIn(propertyId: string, actor: Actor, input: CreateReservationInput) {
  const prop = property(propertyId);
  const res = createReservation(propertyId, actor, {
    ...input,
    arrival: prop.business_date,
    status: 'Confirmed',
    source: input.source ?? 'Walk-in',
    origin: 'pms',
  });
  return checkIn(propertyId, actor, res.id, {
    roomId: input.roomId ?? undefined,
    paymentMinor: input.depositRequiredMinor ?? undefined,
    paymentMethod: input.paymentMethod ?? 'Cash',
  });
}
