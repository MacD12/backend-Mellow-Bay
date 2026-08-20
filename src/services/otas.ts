// ─────────────────────────────────────────────────────────────
// The OTAs behind the hub.
//
// Beds24 is one connection and many shopfronts. Nobody sells on Beds24 — guests
// book on Hostelworld, Booking.com, Airbnb — and every question a property
// actually asks is per-shopfront: which one produces, which cancels, which has
// gone quiet, which is worth its commission.
//
// **Beds24's API will not answer "which OTAs am I connected to."** Probed on a
// live account with the `all:channels` scope granted: `/channels`,
// `/channels/booking`, `/channels/airbnb` all return HTTP 200 with a body of
// literally `null`, and `/properties/channels` returns 500. The routes exist,
// the scope is there, and nothing comes back.
//
// So this module assembles the answer from what *is* knowable, and — this is
// the part that matters — records **how** each answer was reached, because a
// screen that says "connected" without saying how it knows is exactly the green
// tick this codebase keeps taking out:
//
//   confirmed  a booking has arrived from it. Not arguable.
//   evidence   Beds24 holds a rate code for it. A hint: it shows a mapping
//              exists, not that the channel is live, and it can outlive the
//              connection that created it.
//   declared   a person ticked it, because the API cannot tell us and they know.
//   available  nothing suggests it is in use.
// ─────────────────────────────────────────────────────────────
import { all, get, run, tx } from '../db.ts';
import { id, nowIso } from '../lib/util.ts';
import { audit } from './audit.ts';
import type { AuthContext } from '../auth.ts';

type Actor = Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>;

export type OtaState = 'available' | 'declared' | 'evidence' | 'confirmed';

/**
 * Display names for Beds24's channel keys.
 *
 * Beds24 hands back keys like `bedandbreakfasteu`, which is not a name anybody
 * would recognise on a screen. Anything not listed is title-cased, so a channel
 * added by Beds24 tomorrow still appears — merely less prettily — rather than
 * being dropped for not being in a list.
 */
const DISPLAY: Record<string, string> = {
  agoda: 'Agoda',
  airbnb: 'Airbnb',
  atraveo: 'Atraveo',
  bedandbreakfasteu: 'Bed and Breakfast EU',
  bedandbreakfastnl: 'Bed and Breakfast NL',
  bookeasycomau: 'Bookeasy',
  booking: 'Booking.com',
  bookitconz: 'Bookit NZ',
  bookvisit: 'BookVisit',
  despegar: 'Despegar',
  edreamsodigeo: 'eDreams ODIGEO',
  expedia: 'Expedia',
  feratel: 'Feratel',
  flipkey: 'FlipKey',
  goibibo: 'Goibibo',
  guestlinkcouk: 'Guestlink',
  hometogo: 'HomeToGo',
  hostelinternational: 'Hostelling International',
  hostelsclub: 'Hostelsclub',
  hostelworld: 'Hostelworld',
  hotelbeds: 'Hotelbeds',
  hrs: 'HRS',
  jomres: 'Jomres',
  lastminute: 'lastminute.com',
  marriott: 'Marriott',
  ostrovokru: 'Ostrovok',
  ota: 'Other OTA',
  tablethotels: 'Tablet Hotels',
  tiket: 'tiket.com',
  tomastravel: 'Tomas Travel',
  traumferienwohnungen: 'Traum-Ferienwohnungen',
  traveloka: 'Traveloka',
  travia: 'Travia',
  trip: 'Trip.com',
  tripadvisorrentals: 'TripAdvisor Rentals',
  vacationstay: 'VacationStay',
  vrbo: 'Vrbo',
  webroomsconz: 'WebRooms NZ',
};

export function displayName(code: string): string {
  return DISPLAY[code]
    ?? code.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The reverse: a booking's `referer` back to a catalogue code.
 *
 * Beds24 sends the OTA's trading name on a booking ("Hostelworld",
 * "Booking.com"), not the key it uses in its own settings. Matching them up is
 * what lets one booking promote an OTA to `confirmed`.
 */
export function codeForReferer(referer: string): string {
  const norm = referer.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [code, name] of Object.entries(DISPLAY)) {
    if (code === norm) return code;
    if (name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm) return code;
  }
  // Booking.com arrives as "Booking.com" → "bookingcom", which is not the key.
  if (norm.startsWith('booking')) return 'booking';
  return norm || 'ota';
}

export interface OtaRow {
  code: string;
  name: string;
  state: OtaState;
  /** Plain English for why we believe the state. Shown, never inferred by the UI. */
  because: string;
  rateCode: string | null;
  bookings: number;
  lastBookingAt: string | null;
  declared: boolean;
}

/**
 * What Beds24 said, folded into the OTA table.
 *
 * `catalogue` is every channel key Beds24 knows for this property, read live
 * from `roomTypes[].priceRules[].channels` — not a hardcoded list, so a channel
 * Beds24 adds appears without a release here. `rateCodes` maps the few that
 * carry one.
 */
export function recordCatalogue(
  propertyId: string, channelId: string | null,
  catalogue: string[], rateCodes: Record<string, string>,
) {
  const now = nowIso();
  tx(() => {
    for (const code of catalogue) {
      const rateCode = rateCodes[code] || null;
      const existing = get<{ id: string; state: string; declared: number }>(
        'SELECT id, state, declared FROM channel_otas WHERE property_id = ? AND code = ?',
        propertyId, code);

      if (!existing) {
        run(
          `INSERT INTO channel_otas(id, property_id, channel_id, code, name, state,
                                    rate_code, declared, first_seen_at, updated_at)
           VALUES(?,?,?,?,?,?,?,0,?,?)`,
          id('ota'), propertyId, channelId, code, displayName(code),
          rateCode ? 'evidence' : 'available', rateCode, now, now);
        continue;
      }

      // `confirmed` is history and is never revisited: a booking arrived, and
      // Beds24 tidying a rate mapping afterwards cannot un-happen it.
      //
      // Everything below `confirmed` is a statement about how things stand
      // *now*, and is recomputed rather than latched. `evidence` in particular
      // means "Beds24 currently holds a rate code" — keeping it after the rate
      // code is gone would leave the screen explaining itself with a code that
      // no longer exists, which is worse than saying nothing.
      const next: OtaState = existing.state === 'confirmed'
        ? 'confirmed'
        : rateCode ? 'evidence'
          : existing.declared ? 'declared' : 'available';

      run(
        `UPDATE channel_otas SET rate_code = ?, state = ?, channel_id = COALESCE(?, channel_id),
                                 name = ?, updated_at = ?
          WHERE id = ?`,
        rateCode, next, channelId, displayName(code), now, existing.id);
    }
  });
}

/**
 * Recount bookings per OTA and promote anything that has produced one.
 *
 * Driven off the reservations themselves rather than a counter kept in step by
 * hand — a counter drifts the first time a booking is imported by a path that
 * forgot to bump it, and then the screen is wrong in the one direction that
 * matters.
 */
export function refreshFromBookings(propertyId: string) {
  const rows = all<{ ota: string; n: number; last: string }>(
    `SELECT COALESCE(NULLIF(ota_channel, ''), channel_code) AS ota,
            COUNT(*) AS n, MAX(created_at) AS last
       FROM reservations
      WHERE property_id = ? AND origin = 'channel'
        AND COALESCE(NULLIF(ota_channel, ''), channel_code) IS NOT NULL
      GROUP BY ota`,
    propertyId);

  const now = nowIso();
  tx(() => {
    // Zero the counts first, so an OTA whose bookings were all deleted stops
    // claiming them — while keeping its state, which is a record of what did
    // once happen.
    run('UPDATE channel_otas SET bookings = 0 WHERE property_id = ?', propertyId);

    for (const r of rows) {
      const code = codeForReferer(r.ota);
      const existing = get<{ id: string }>(
        'SELECT id FROM channel_otas WHERE property_id = ? AND code = ?', propertyId, code);
      if (existing) {
        run(
          `UPDATE channel_otas SET bookings = ?, last_booking_at = ?, state = 'confirmed',
                                   updated_at = ?
            WHERE id = ?`,
          r.n, r.last, now, existing.id);
      } else {
        // A booking from a channel Beds24 never listed. It happened, so it is
        // recorded — the catalogue being incomplete is not a reason to lose it.
        run(
          `INSERT INTO channel_otas(id, property_id, code, name, state, bookings,
                                    last_booking_at, declared, first_seen_at, updated_at)
           VALUES(?,?,?,?, 'confirmed', ?,?,0,?,?)`,
          id('ota'), propertyId, code, displayName(code), r.n, r.last, now, now);
      }
    }
  });
}

function because(row: any): string {
  switch (row.state as OtaState) {
    case 'confirmed':
      return `${row.bookings} booking${row.bookings === 1 ? '' : 's'} received`;
    case 'evidence':
      return `Beds24 holds a rate code (${row.rate_code}) — likely live, not confirmed`;
    case 'declared':
      return 'Marked as live by staff — Beds24 cannot confirm it';
    default:
      return 'Supported by Beds24, nothing suggests it is in use';
  }
}

export function listOtas(propertyId: string): OtaRow[] {
  return all<any>(
    `SELECT * FROM channel_otas WHERE property_id = ?
      ORDER BY CASE state WHEN 'confirmed' THEN 0 WHEN 'evidence' THEN 1
                          WHEN 'declared' THEN 2 ELSE 3 END,
               bookings DESC, name`,
    propertyId,
  ).map((r) => ({
    code: r.code, name: r.name, state: r.state as OtaState, because: because(r),
    rateCode: r.rate_code, bookings: r.bookings,
    lastBookingAt: r.last_booking_at, declared: r.declared === 1,
  }));
}

/** Totals for the header — confirmed and merely believed are counted apart. */
export function otaSummary(propertyId: string) {
  const rows = listOtas(propertyId);
  return {
    total: rows.length,
    confirmed: rows.filter((r) => r.state === 'confirmed').length,
    likely: rows.filter((r) => r.state === 'evidence' || r.state === 'declared').length,
    bookings: rows.reduce((n, r) => n + r.bookings, 0),
  };
}

/**
 * The operator's own switch, for what the API cannot see.
 *
 * Turning one off never touches its bookings or its history — an OTA that has
 * sent business stays `confirmed`, because it did.
 */
export function declareOta(
  propertyId: string, actor: Actor, code: string, live: boolean,
): OtaRow {
  const row = get<any>(
    'SELECT * FROM channel_otas WHERE property_id = ? AND code = ?', propertyId, code);
  if (!row) throw new Error(`No such channel: ${code}`);

  const next: OtaState = row.state === 'confirmed' ? 'confirmed'
    : live ? 'declared'
      : row.rate_code ? 'evidence' : 'available';

  run(
    'UPDATE channel_otas SET declared = ?, state = ?, updated_at = ? WHERE id = ?',
    live ? 1 : 0, next, nowIso(), row.id);

  audit(actor, {
    action: live ? 'ota.declare' : 'ota.undeclare',
    entity: 'CHANNEL', entityId: row.id, entityRef: row.name,
    after: { code, live },
  });

  return listOtas(propertyId).find((r) => r.code === code)!;
}
