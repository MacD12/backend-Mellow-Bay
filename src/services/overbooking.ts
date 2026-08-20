// ─────────────────────────────────────────────────────────────
// Overbooking detection and control.
//
// The arithmetic is trivial — rooms minus bookings. What is hard is that the
// count is right in two places at once and still wrong, because between Helio
// deciding a room is free and Booking.com being told it is not, somebody bought
// it. Each OTA sells from its own cached copy of availability; it does not ask
// the PMS at the moment of sale. There is no lock to hold across other
// companies' websites.
//
// So this module does the three things that *are* possible:
//
//   1. Detect all four kinds of overbooking, not just the obvious one.
//   2. Work out the likely cause, because the fix differs completely.
//   3. Shut the door the moment availability reaches zero, so the room that is
//      already gone cannot be raced for.
//
// See docs/overbooking-and-alerts.md for why each of those is shaped this way.
// ─────────────────────────────────────────────────────────────
import { all, get, run, scalar, tx, jsonCol, parseJson } from '../db.ts';
import { id, nowIso, addDays, nightsBetween, HttpError } from '../lib/util.ts';
import { availabilityGrid } from './availability.ts';
import { audit } from './audit.ts';
import { raise } from './alerts.ts';
import { notify } from './notify.ts';
import { closeDates } from './closeouts.ts';
// Taken from auth rather than from reservations, so the reservation service can
// call the guard below without the two importing each other.
import type { AuthContext } from '../auth.ts';

type Actor = Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>;

/** Statuses that actually hold a room. Anything else is not an overbooking. */
const LIVE = ['Tentative', 'Confirmed', 'Guaranteed', 'Checked-in'];
const LIVE_SQL = `('Tentative','Confirmed','Guaranteed','Checked-in')`;

export type OverbookingKind = 'type' | 'room' | 'bed' | 'at-risk';
export type Severity = 'critical' | 'urgent' | 'warning' | 'info';
export type Cause =
  | 'failed-push' | 'blocked-room' | 'allowance' | 'race' | 'assignment' | 'unknown';

export interface Finding {
  kind: OverbookingKind;
  date: string;
  roomTypeId: string | null;
  roomId: string | null;
  bedId: string | null;
  oversold: number;
  sellable: number;
  sold: number;
  cause: Cause;
  severity: Severity;
  reservationIds: string[];
}

/**
 * Severity is by *time*, not size.
 *
 * One room oversold tonight is worse than three oversold next month: tonight
 * there is a guest in a taxi, next month there is a free upgrade waiting to be
 * arranged. Sorting by how many rooms are over buries the urgent one.
 */
function severityFor(kind: OverbookingKind, date: string, today: string): Severity {
  if (kind === 'at-risk') return 'info';
  if (date <= today) return 'critical';
  if (nightsBetween(today, date) <= 7) return 'urgent';
  return 'warning';
}

// ─── Cause inference ─────────────────────────────────────────

/**
 * Why did this happen? The fix depends entirely on the answer, so a finding
 * without a cause is only half a finding.
 *
 * The order below is by confidence, not by likelihood: a room blocked over an
 * existing booking is a certainty, whereas "race" is what is left when nothing
 * else explains it.
 */
function inferCause(
  propertyId: string, date: string, roomTypeId: string | null,
  reservationIds: string[], kind: OverbookingKind,
): Cause {
  if (kind === 'room' || kind === 'bed') return 'assignment';

  // A room taken out of service over bookings that already existed. Certain,
  // because the block carries its own creation time.
  if (roomTypeId) {
    const blockedOver = scalar<number>(
      `SELECT count(*) AS n
         FROM room_blocks b
         JOIN rooms r ON r.id = b.room_id
        WHERE b.property_id = ? AND r.room_type_id = ?
          AND b.released_at IS NULL AND b.from_date <= ? AND b.to_date > ?`,
      propertyId, roomTypeId, date, date,
    );
    if (blockedOver > 0) return 'blocked-room';
  }

  // A push that has been failing leaves stale availability on the OTA. This is
  // the cause worth catching, because it keeps producing bookings until fixed.
  const failedPush = scalar<number>(
    `SELECT count(*) AS n FROM channel_queue
      WHERE property_id = ? AND status = 'failed'
        AND date_from <= ? AND date_to > ?`,
    propertyId, date, date,
  );
  if (failedPush > 0) return 'failed-push';

  // A deliberate oversell that did not pay off is not a fault, and should not
  // be reported as one.
  if (roomTypeId) {
    const allowance = scalar<number>(
      `SELECT COALESCE(MAX(overbook), 0) AS n FROM inventory_adjustments
        WHERE property_id = ? AND room_type_id = ? AND date = ?`,
      propertyId, roomTypeId, date,
    );
    if (allowance > 0) return 'allowance';
  }

  // Two channel bookings landing close together, with nothing else to explain
  // it, is the race. Ten minutes is generous — it covers a push that was in
  // flight plus the OTA's own reporting delay.
  if (reservationIds.length >= 2) {
    const rows = all<{ created_at: string; origin: string }>(
      `SELECT created_at, origin FROM reservations
        WHERE id IN (${reservationIds.map(() => '?').join(',')})
        ORDER BY created_at DESC LIMIT 2`,
      ...reservationIds,
    );
    if (rows.length === 2 && rows.every((r) => r.origin === 'channel')) {
      const gapMs = Date.parse(rows[0].created_at) - Date.parse(rows[1].created_at);
      if (Number.isFinite(gapMs) && Math.abs(gapMs) < 10 * 60_000) return 'race';
    }
  }

  return 'unknown';
}

// ─── The four scans ──────────────────────────────────────────

/** Reservations holding a room of this type on this date. */
function holdersOfType(propertyId: string, roomTypeId: string, date: string): string[] {
  return all<{ reservation_id: string }>(
    `SELECT DISTINCT n.reservation_id
       FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.room_type_id = ? AND n.date = ?
        AND r.status IN ${LIVE_SQL}`,
    propertyId, roomTypeId, date,
  ).map((r) => r.reservation_id);
}

/**
 * Scan a window and return everything wrong with it.
 *
 * Writes nothing — `scanAndRecord` does that. Kept separate so the scan can be
 * run and inspected without leaving a trail of findings behind it.
 */
/**
 * `to` is **exclusive**, matching `availabilityGrid` and the departure-date
 * convention used everywhere else. `guardInventory` converts for callers who
 * are thinking in nights.
 */
/** How many rooms of each type are held back from the channels. */
export function lastRoomProtection(propertyId: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const rt of all<{ id: string; protect_last_rooms: number }>(
    'SELECT id, protect_last_rooms FROM room_types WHERE property_id = ?', propertyId)) {
    map.set(rt.id, rt.protect_last_rooms ?? 0);
  }
  return map;
}

export function scan(propertyId: string, from: string, to: string, today: string): Finding[] {
  const findings: Finding[] = [];
  const protection = lastRoomProtection(propertyId);

  // ── 1. Type-level oversell ────────────────────────────────
  // `availabilityGrid` already nets off blocks, group holds, manual holds and
  // the deliberate allowance, so a negative number here is the real thing.
  for (const cell of availabilityGrid(propertyId, from, to)) {
    if (cell.available < 0) {
      const reservationIds = holdersOfType(propertyId, cell.roomTypeId, cell.date);
      findings.push({
        kind: 'type',
        date: cell.date,
        roomTypeId: cell.roomTypeId,
        roomId: null,
        bedId: null,
        oversold: -cell.available,
        sellable: cell.physical - cell.blocked - cell.groupHeld - cell.hold + cell.overbook,
        sold: cell.sold,
        cause: inferCause(propertyId, cell.date, cell.roomTypeId, reservationIds, 'type'),
        severity: severityFor('type', cell.date, today),
        reservationIds,
      });
    } else if (cell.available <= (protection.get(cell.roomTypeId) ?? 0)) {
      // Not an overbooking. But it is the state in which the race is live, and
      // it is what triggers the immediate close on the other OTAs.
      //
      // The threshold is normally zero: the last room is sold, so there is
      // nothing left to race for. A property that sets last-room protection
      // raises it, and closes while a room is still unsold — the only thing
      // that makes the simultaneous-OTA race impossible rather than merely
      // short. It costs occupancy, which is why it is off by default and the
      // property's own numbers sit beside the setting.
      findings.push({
        kind: 'at-risk',
        date: cell.date,
        roomTypeId: cell.roomTypeId,
        roomId: null,
        bedId: null,
        oversold: 0,
        sellable: cell.physical - cell.blocked - cell.groupHeld - cell.hold + cell.overbook,
        sold: cell.sold,
        cause: inferCause(propertyId, cell.date, cell.roomTypeId, [], 'at-risk'),
        severity: 'info',
        reservationIds: [],
      });
    }
  }

  // ── 2. Room-level clash ───────────────────────────────────
  // Two bookings on the same physical room on the same night. The room type can
  // have spare capacity and this still happens — it is an assignment mistake,
  // and the guest finds out by opening a door.
  //
  // Dorms are excluded: a dorm room holding six guests is not a clash, it is a
  // dorm. Those are checked per bed below.
  const roomClashes = all<{ room_id: string; date: string; n: number; ids: string }>(
    `SELECT n.room_id, n.date, count(DISTINCT n.reservation_id) AS n,
            group_concat(DISTINCT n.reservation_id) AS ids
       FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
       JOIN room_types rt ON rt.id = n.room_type_id
      WHERE n.property_id = ? AND n.room_id IS NOT NULL
        AND n.date >= ? AND n.date < ?
        AND r.status IN ${LIVE_SQL}
        AND rt.kind <> 'dorm'
      GROUP BY n.room_id, n.date
     HAVING count(DISTINCT n.reservation_id) > 1`,
    propertyId, from, to,
  );
  for (const clash of roomClashes) {
    const room = get<{ room_type_id: string }>(
      'SELECT room_type_id FROM rooms WHERE id = ?', clash.room_id);
    const reservationIds = (clash.ids ?? '').split(',').filter(Boolean);
    findings.push({
      kind: 'room',
      date: clash.date,
      roomTypeId: room?.room_type_id ?? null,
      roomId: clash.room_id,
      bedId: null,
      oversold: clash.n - 1,
      sellable: 1,
      sold: clash.n,
      cause: 'assignment',
      severity: severityFor('room', clash.date, today),
      reservationIds,
    });
  }

  // ── 3. Bed-level clash ────────────────────────────────────
  const bedClashes = all<{ bed_id: string; date: string; n: number; ids: string }>(
    `SELECT n.bed_id, n.date, count(DISTINCT n.reservation_id) AS n,
            group_concat(DISTINCT n.reservation_id) AS ids
       FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.bed_id IS NOT NULL
        AND n.date >= ? AND n.date < ?
        AND r.status IN ${LIVE_SQL}
      GROUP BY n.bed_id, n.date
     HAVING count(DISTINCT n.reservation_id) > 1`,
    propertyId, from, to,
  );
  for (const clash of bedClashes) {
    const bed = get<{ room_type_id: string }>(
      `SELECT r.room_type_id FROM beds b JOIN rooms r ON r.id = b.room_id WHERE b.id = ?`,
      clash.bed_id);
    findings.push({
      kind: 'bed',
      date: clash.date,
      roomTypeId: bed?.room_type_id ?? null,
      roomId: null,
      bedId: clash.bed_id,
      oversold: clash.n - 1,
      sellable: 1,
      sold: clash.n,
      cause: 'assignment',
      severity: severityFor('bed', clash.date, today),
      reservationIds: (clash.ids ?? '').split(',').filter(Boolean),
    });
  }

  return findings;
}

// ─── Recording findings ──────────────────────────────────────

/**
 * Run a scan and reconcile it against what is already recorded.
 *
 * A finding is keyed on what it *is* — kind, date, room type, room, bed — not
 * on when it was seen. The same oversell seen twenty times is one finding seen
 * twenty times. Anything previously open and no longer found is closed as
 * `auto-resolved`, because a problem that has gone away must not sit on the
 * desk pretending to still be there.
 */
export function scanAndRecord(
  propertyId: string, actor: Actor, opts: { from?: string; to?: string; today: string },
) {
  const from = opts.from ?? opts.today;
  const to = opts.to ?? addDays(opts.today, 180);

  return tx(() => {
    const findings = scan(propertyId, from, to, opts.today);
    const now = nowIso();
    const seen = new Set<string>();
    const created: string[] = [];
    const worsened: string[] = [];

    for (const f of findings) {
      const existing = get<any>(
        `SELECT * FROM overbookings
          WHERE property_id = ? AND kind = ? AND date = ?
            AND room_type_id IS ? AND room_id IS ? AND bed_id IS ?`,
        propertyId, f.kind, f.date, f.roomTypeId, f.roomId, f.bedId,
      );

      if (existing) {
        seen.add(existing.id);
        const gotWorse = f.oversold > (existing.oversold ?? 0);
        run(
          `UPDATE overbookings
              SET oversold = ?, sellable = ?, sold = ?, cause = ?, severity = ?,
                  reservations = ?, last_seen_at = ?,
                  status = CASE WHEN status IN ('resolved','auto-resolved') THEN 'open' ELSE status END,
                  acknowledged_at = CASE WHEN ? THEN NULL ELSE acknowledged_at END
            WHERE id = ?`,
          f.oversold, f.sellable, f.sold, f.cause, f.severity,
          jsonCol(f.reservationIds), now,
          // Getting worse un-acknowledges it. Somebody silenced an alarm about
          // one oversold room; two is a different problem.
          gotWorse ? 1 : 0,
          existing.id,
        );
        if (gotWorse) worsened.push(existing.id);
      } else {
        const findingId = id('ovb');
        run(
          `INSERT INTO overbookings(id, property_id, kind, date, room_type_id, room_id, bed_id,
                                    oversold, sellable, sold, cause, severity, status,
                                    reservations, first_seen_at, last_seen_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?,?)`,
          findingId, propertyId, f.kind, f.date, f.roomTypeId, f.roomId, f.bedId,
          f.oversold, f.sellable, f.sold, f.cause, f.severity,
          jsonCol(f.reservationIds), now, now,
        );
        seen.add(findingId);
        created.push(findingId);
      }
    }

    // Anything open that this scan did not find has been fixed — by a
    // cancellation, a reassignment, or somebody doing their job.
    const stale = all<{ id: string }>(
      `SELECT id FROM overbookings WHERE property_id = ? AND status = 'open'`, propertyId,
    ).filter((row) => !seen.has(row.id));
    for (const row of stale) {
      run(
        `UPDATE overbookings SET status = 'auto-resolved', resolved_at = ?,
                                 resolution = 'No longer present at scan'
          WHERE id = ?`,
        now, row.id,
      );
    }

    if (created.length || worsened.length) {
      audit(actor, {
        action: 'overbooking.detected', entity: 'PROPERTY', entityId: propertyId,
        after: { created: created.length, worsened: worsened.length, window: `${from}→${to}` },
      });

      // One alert per newly-found or worsened overbooking, naming the date and
      // the room type. An alert that says "3 problems" makes somebody go and
      // look; one that says "2 rooms oversold on 14 Aug, Deluxe King" does not.
      for (const findingId of [...created, ...worsened]) {
        const row = get<any>(
          `SELECT o.*, rt.name AS room_type_name FROM overbookings o
             LEFT JOIN room_types rt ON rt.id = o.room_type_id WHERE o.id = ?`,
          findingId,
        );
        if (!row || row.kind === 'at-risk') continue;
        const what = row.kind === 'room' ? 'Two bookings on the same room'
          : row.kind === 'bed' ? 'Two guests in the same bed'
            : `${row.oversold} room(s) oversold`;
        raise(propertyId, {
          kind: 'overbooking',
          severity: row.severity === 'critical' ? 'critical' : 'warn',
          title: `${what} · ${row.date}`,
          body: `${row.room_type_name ?? 'Unknown room type'} — ${describeCause(row.cause)}`,
          overbookingId: findingId,
        });
        // The alarm wakes somebody now; this is the record they find afterwards,
        // with the cause already worked out and a way through to the desk.
        notify(propertyId, {
          source: 'Reservations',
          severity: row.severity === 'critical' ? 'critical' : 'warn',
          title: `${what} · ${row.date}`,
          message: `${row.room_type_name ?? 'Unknown room type'} — ${describeCause(row.cause)}`,
          link: '#/overbooking',
        });
      }
    }

    return {
      found: findings.length,
      created: created.length,
      worsened: worsened.length,
      autoResolved: stale.length,
      createdIds: created,
      worsenedIds: worsened,
    };
  });
}

// ─── Reading the desk ────────────────────────────────────────

const CAUSE_TEXT: Record<Cause, string> = {
  'failed-push': 'A channel push has been failing for these dates, so the OTA has been selling '
    + 'availability that no longer exists. Fix the connection first — this will keep happening.',
  'blocked-room': 'A room was taken out of order over dates that were already sold. '
    + 'Releasing the block, or moving the maintenance, is the cheapest fix.',
  allowance: 'This is the deliberate oversell allowance not paying off — the no-shows expected '
    + 'when it was set did not happen.',
  race: 'Two channel bookings landed within minutes of each other. Each OTA sells from its own '
    + 'copy of availability and does not ask first, so both succeeded. Nothing was misconfigured.',
  assignment: 'Two bookings are assigned to the same room. The room type may still have space — '
    + 'this is a reassignment, not a capacity problem.',
  unknown: 'No single cause stands out. Check the bookings involved and recent channel activity.',
};

export function describeCause(cause: Cause | string): string {
  return CAUSE_TEXT[cause as Cause] ?? CAUSE_TEXT.unknown;
}

export function listFindings(propertyId: string, today: string, opts: {
  status?: string; includeAtRisk?: boolean;
} = {}) {
  const status = opts.status ?? 'open';
  const rows = all<any>(
    `SELECT o.*, rt.name AS room_type_name, rt.code AS room_type_code, rt.kind AS room_type_kind,
            rm.number AS room_number, b.code AS bed_code
       FROM overbookings o
       LEFT JOIN room_types rt ON rt.id = o.room_type_id
       LEFT JOIN rooms rm ON rm.id = o.room_id
       LEFT JOIN beds b ON b.id = o.bed_id
      WHERE o.property_id = ? AND o.status = ?
      ORDER BY o.date`,
    propertyId, status,
  ).filter((r) => opts.includeAtRisk || r.kind !== 'at-risk');

  const order: Record<string, number> = { critical: 0, urgent: 1, warning: 2, info: 3 };
  return rows
    .map((r) => {
      const reservationIds = parseJson<string[]>(r.reservations, []);
      return {
        id: r.id,
        kind: r.kind as OverbookingKind,
        date: r.date,
        roomTypeId: r.room_type_id,
        roomType: r.room_type_name,
        roomTypeCode: r.room_type_code,
        isDorm: r.room_type_kind === 'dorm',
        room: r.room_number,
        bed: r.bed_code,
        oversold: r.oversold,
        sellable: r.sellable,
        sold: r.sold,
        cause: r.cause as Cause,
        causeText: describeCause(r.cause),
        severity: r.severity as Severity,
        status: r.status,
        daysAway: nightsBetween(today, r.date),
        channelsClosedAt: r.channels_closed_at,
        acknowledgedAt: r.acknowledged_at,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        note: r.note,
        reservations: reservationIds.length ? bookingsInvolved(propertyId, reservationIds) : [],
      };
    })
    .sort((a, b) => (order[a.severity] - order[b.severity]) || a.date.localeCompare(b.date));
}

/** The bookings caught up in a finding, with what each is worth. */
function bookingsInvolved(propertyId: string, reservationIds: string[]) {
  if (!reservationIds.length) return [];
  return all<any>(
    `SELECT r.id, r.confirmation, r.guest_name, r.status, r.arrival, r.departure, r.nights,
            r.total_minor, r.vip, r.source, r.channel_code, r.eta, r.group_id, r.room_id,
            r.adults, r.children, r.created_at,
            rt.name AS room_type_name, rm.number AS room_number,
            c.commission_bp,
            -- Repeat guests are protected from a walk, so the count has to be
            -- real rather than a flag somebody forgot to set.
            (SELECT count(*) FROM reservations prev
              WHERE prev.profile_id = r.profile_id AND prev.id <> r.id
                AND prev.status = 'Checked-out') AS previous_stays
       FROM reservations r
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
       LEFT JOIN channels c ON c.property_id = r.property_id AND c.code = r.channel_code
      WHERE r.property_id = ? AND r.id IN (${reservationIds.map(() => '?').join(',')})`,
    propertyId, ...reservationIds,
  ).map((r) => ({
    id: r.id,
    confirmation: r.confirmation,
    guest: r.guest_name,
    status: r.status,
    arrival: r.arrival,
    departure: r.departure,
    nights: r.nights,
    adults: r.adults,
    children: r.children,
    totalMinor: r.total_minor,
    vip: r.vip === 1,
    source: r.source,
    channelCode: r.channel_code,
    commissionBp: r.commission_bp ?? 0,
    eta: r.eta,
    groupId: r.group_id,
    roomId: r.room_id,
    room: r.room_number,
    roomType: r.room_type_name,
    previousStays: r.previous_stays ?? 0,
    bookedAt: r.created_at,
  }));
}

export function getFinding(propertyId: string, findingId: string) {
  const row = get<any>('SELECT * FROM overbookings WHERE id = ? AND property_id = ?',
    findingId, propertyId);
  if (!row) throw new HttpError(404, 'Overbooking not found');
  return row;
}

export function acknowledge(propertyId: string, actor: Actor, findingId: string) {
  getFinding(propertyId, findingId);
  run('UPDATE overbookings SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?',
    nowIso(), actor.userName, findingId);
  return { ok: true };
}

export function resolveFinding(
  propertyId: string, actor: Actor, findingId: string, resolution: string, note?: string,
) {
  const row = getFinding(propertyId, findingId);
  run(
    `UPDATE overbookings SET status = 'resolved', resolution = ?, note = ?,
                             resolved_at = ?, resolved_by = ?
      WHERE id = ?`,
    resolution, note ?? null, nowIso(), actor.userName, findingId,
  );
  audit(actor, {
    action: 'overbooking.resolved', entity: 'PROPERTY', entityId: propertyId,
    entityRef: `${row.date} · ${row.kind}`,
    after: { resolution, note, oversold: row.oversold },
  });
  // Deliberately not re-scanned here: the next scan decides whether it is
  // actually fixed. A resolution that did not fix anything reopens by itself.
  return { ok: true };
}

/** Nothing hidden — the counts the dashboard and the alarm work from. */
export function summary(propertyId: string, today: string) {
  const open = all<any>(
    `SELECT kind, severity, date, oversold, acknowledged_at, channels_closed_at FROM overbookings
      WHERE property_id = ? AND status = 'open'`,
    propertyId,
  );
  const real = open.filter((o) => o.kind !== 'at-risk');
  const atRisk = open.filter((o) => o.kind === 'at-risk');
  return {
    total: real.length,
    critical: real.filter((o) => o.severity === 'critical').length,
    urgent: real.filter((o) => o.severity === 'urgent').length,
    roomsOversold: real.reduce((sum, o) => sum + (o.oversold ?? 0), 0),
    tonight: real.filter((o) => o.date === today).length,
    atRisk: atRisk.length,
    // Split out, because "192 sold-out dates, closed on the channels" is a
    // claim about 192 dates when only some of them have actually been shut.
    // The number still on sale at zero is the one worth acting on.
    atRiskClosed: atRisk.filter((o) => o.channels_closed_at).length,
    atRiskOpen: atRisk.filter((o) => !o.channels_closed_at).length,
    unacknowledged: real.filter((o) => !o.acknowledged_at).length,
  };
}

// ─── Dates that must be shut on the OTAs ─────────────────────

/**
 * Every (room type, date) that should not be on sale through a channel right
 * now — because it is oversold, or because it has reached zero and the race for
 * the last room is live.
 *
 * Returned rather than acted on, so the caller decides whether this is a scan,
 * a preview, or the real thing.
 */
export function datesNeedingClosure(propertyId: string, today: string) {
  return all<any>(
    `SELECT DISTINCT o.room_type_id, o.date, o.kind, o.oversold
       FROM overbookings o
      WHERE o.property_id = ? AND o.status = 'open'
        AND o.room_type_id IS NOT NULL
        AND o.kind IN ('type','at-risk')
        AND o.date >= ?
        AND o.channels_closed_at IS NULL
      ORDER BY o.date`,
    propertyId, today,
  ).map((r) => ({
    roomTypeId: r.room_type_id,
    date: r.date,
    reason: r.kind === 'at-risk'
      ? 'Sold out — closed so the last room cannot be sold twice'
      : `Oversold by ${r.oversold} — closed to stop it getting worse`,
  }));
}

export function markClosed(propertyId: string, roomTypeId: string, dates: string[]) {
  if (!dates.length) return 0;
  const n = run(
    `UPDATE overbookings SET channels_closed_at = ?
      WHERE property_id = ? AND room_type_id = ? AND status = 'open'
        AND date IN (${dates.map(() => '?').join(',')})`,
    nowIso(), propertyId, roomTypeId, ...dates,
  );
  return Number(n.changes ?? 0);
}

// ─── Shutting the door ───────────────────────────────────────

/**
 * Run after anything that consumes inventory: scan the affected dates, and shut
 * them on the channels if they are oversold or have reached zero.
 *
 * Closing **at zero, not at minus one**, is the whole point. The race exists
 * because two OTAs can each sell the same last room — neither asks first, both
 * succeed. Once availability is zero that room is already gone, so leaving it on
 * sale anywhere can only produce an overbooking. Nothing is withheld by this:
 * the room was sold, and the front desk can still sell over the top of it if a
 * human decides to.
 *
 * Deliberately not inside the caller's transaction. It performs channel writes
 * and a scan, and holding SQLite's write lock across those would make every
 * booking wait for them.
 */
export function guardInventory(propertyId: string, actor: Actor, opts: {
  /** `to` is the last night to check — inclusive, unlike the scan below. */
  roomTypeId?: string; from: string; to: string; today: string;
}) {
  // `scan` follows `availabilityGrid`, whose `to` is exclusive — the same
  // convention as a departure date. Callers here are talking about nights, so
  // the conversion happens once, here, rather than at every call site. Getting
  // this wrong scans an empty range and reports all clear, which is the worst
  // possible way to be wrong.
  const result = scanAndRecord(propertyId, actor, {
    from: opts.from, to: addDays(opts.to, 1), today: opts.today,
  });

  const wanted = datesNeedingClosure(propertyId, opts.today)
    .filter((c) => (!opts.roomTypeId || c.roomTypeId === opts.roomTypeId)
      && c.date >= opts.from && c.date <= opts.to);

  // Group contiguous dates per room type so one closure covers a run of nights
  // rather than leaving a row per night on the close-out list.
  const byType = new Map<string, { dates: string[]; reason: string }>();
  for (const c of wanted) {
    const entry = byType.get(c.roomTypeId) ?? { dates: [], reason: c.reason };
    entry.dates.push(c.date);
    byType.set(c.roomTypeId, entry);
  }

  let closed = 0;
  for (const [roomTypeId, entry] of byType) {
    const sorted = [...entry.dates].sort();
    for (const [start, end] of contiguousRuns(sorted)) {
      try {
        closeDates(propertyId, actor, {
          roomTypeId, from: start, to: end,
          reason: entry.reason,
        });
        closed += markClosed(propertyId, roomTypeId,
          sorted.filter((d) => d >= start && d <= end));
      } catch (e) {
        // A channel that will not take the close must not stop the booking that
        // triggered it. The finding stays open and unclosed, which is exactly
        // what the desk needs to see.
        process.stderr.write(
          `[overbooking] could not close ${roomTypeId} ${start}→${end}: `
          + `${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  }

  return { ...result, datesClosed: closed };
}

/** ['a','b','d'] → [['a','b'], ['d','d']] */
function contiguousRuns(dates: string[]): Array<[string, string]> {
  const runs: Array<[string, string]> = [];
  let start: string | null = null;
  let prev: string | null = null;
  for (const d of dates) {
    if (start === null) { start = d; prev = d; continue; }
    if (prev !== null && addDays(prev, 1) === d) { prev = d; continue; }
    runs.push([start, prev!]);
    start = d;
    prev = d;
  }
  if (start !== null) runs.push([start, prev!]);
  return runs;
}

export { LIVE, LIVE_SQL };
