// ─────────────────────────────────────────────────────────────
// Telling the channel what happened to a booking it sent us.
//
// Marking a guest as a no-show is only half the job. Until Booking.com is told,
// it still believes the guest arrived: the commission stands and the guest is
// not flagged. The same is true of a booking cancelled at the desk and of a
// card that turned out to be invalid.
//
// The governing rule in this file is that **it must never claim a success it
// did not get.** Beds24 answers a write with a per-item result rather than an
// HTTP error, so a 200 does not mean the booking changed; both the envelope and
// the item have to say so. Anything else is recorded as failed, with the raw
// request and response kept so the failure can be diagnosed rather than guessed
// at.
//
// 🔌 The exact payload and the channel's acceptance window are written from the
// documented behaviour and have not been confirmed against a funded Beds24
// account connected to a live Booking.com property. That uncertainty is carried
// through to the screen rather than hidden.
// ─────────────────────────────────────────────────────────────
import { all, get, run, jsonCol, parseJson } from '../db.ts';
import { nowIso, addDays, nightsBetween, HttpError } from '../lib/util.ts';
import { ChannelApiError, type Beds24BookingPatch } from '../channels/beds24.ts';
import { audit } from './audit.ts';
import { logSync, beds24ClientFor } from './channels.ts';
import { type Actor } from './reservations.ts';

export type ReportKind = 'no_show' | 'cancelled_at_property' | 'invalid_card';

/**
 * How each outcome is expressed to Beds24.
 *
 * 🔌 Unconfirmed. Beds24's booking status enum has no dedicated no-show value,
 * so a cancellation carrying a sub-status and a reason is the documented way to
 * express it. If a live account shows a different field is required, this table
 * is the only thing that changes — everything else works off it.
 */
const REPORT_ACTIONS: Record<ReportKind, {
  label: string;
  patch: Beds24BookingPatch;
  /** Days after arrival the channel is understood to still accept the report. */
  windowDays: number;
}> = {
  no_show: {
    label: 'No-show',
    patch: { status: 'cancelled', subStatus: 'noShow', cancelReason: 'Guest did not arrive' },
    windowDays: 2,
  },
  cancelled_at_property: {
    label: 'Cancelled at the property',
    patch: { status: 'cancelled', cancelReason: 'Cancelled at the property' },
    windowDays: 30,
  },
  invalid_card: {
    label: 'Invalid card',
    patch: { status: 'cancelled', subStatus: 'invalidCard', cancelReason: 'Card could not be charged' },
    windowDays: 7,
  },
};

export const REPORT_KINDS = Object.keys(REPORT_ACTIONS) as ReportKind[];

export interface ReportEligibility {
  reportable: boolean;
  /** Why not, in words, when `reportable` is false. */
  reason?: string;
  channelId?: string;
  channelName?: string;
  channelCode?: string;
  otaReference?: string;
  /** Days left in the window, negative once it has passed. */
  daysLeft?: number;
  windowDays?: number;
  windowClosesOn?: string;
  windowPassed?: boolean;
  /** True when nothing has been confirmed against a live channel account. */
  unconfirmed: boolean;
}

function reservation(propertyId: string, reservationId: string) {
  const res = get<any>(
    'SELECT * FROM reservations WHERE id = ? AND property_id = ?', reservationId, propertyId);
  if (!res) throw new HttpError(404, 'Reservation not found');
  return res;
}

/** The connected channel a booking arrived through, if any. */
function channelFor(propertyId: string, channelCode: string | null) {
  if (!channelCode) return undefined;
  return get<any>(
    `SELECT * FROM channels WHERE property_id = ? AND code = ? AND active = 1`,
    propertyId, channelCode,
  );
}

/**
 * Can this booking's outcome be reported, and if not, why not?
 *
 * Answered before anything is attempted so the screen can offer the action only
 * when it means something — and can say plainly why it is unavailable when it
 * does not.
 */
export function reportEligibility(
  propertyId: string, reservationId: string, kind: ReportKind, today: string,
): ReportEligibility {
  const res = reservation(propertyId, reservationId);
  const action = REPORT_ACTIONS[kind];
  const base = { unconfirmed: true, windowDays: action.windowDays };

  if (!res.channel_code || !res.ota_reference) {
    return {
      ...base, reportable: false,
      reason: 'This booking did not come from a channel — there is nobody to report it to.',
    };
  }
  const channel = channelFor(propertyId, res.channel_code);
  if (!channel) {
    return {
      ...base, reportable: false, channelCode: res.channel_code,
      reason: `${res.channel_code} is not connected here, so the report cannot be sent.`,
    };
  }
  if (channel.status !== 'connected') {
    // The stored status is a slug ('not-configured', 'error'), which reads badly
    // dropped into a sentence a receptionist has to act on.
    const explain: Record<string, string> = {
      'not-configured': `${channel.name} has never been connected here. Connect it in the channel `
        + 'manager before a report can be sent.',
      error: `${channel.name} is in error. Fix the connection in the channel manager, then report.`,
      paused: `${channel.name} is paused. Resume it before reporting.`,
    };
    return {
      ...base, reportable: false,
      channelId: channel.id, channelName: channel.name, channelCode: channel.code,
      reason: explain[channel.status]
        ?? `${channel.name} is not connected (${channel.status}). Reconnect it before reporting.`,
    };
  }

  const closesOn = addDays(res.arrival, action.windowDays);
  const daysLeft = nightsBetween(today, closesOn);
  const windowPassed = today > closesOn;

  return {
    ...base,
    reportable: true,
    channelId: channel.id,
    channelName: channel.name,
    channelCode: channel.code,
    otaReference: res.ota_reference,
    daysLeft,
    windowClosesOn: closesOn,
    windowPassed,
    // A passed window is not a hard block: the exact limit is one of the things
    // that needs a live account to confirm, so refusing outright on an
    // unverified number would be the wrong kind of confidence. It is surfaced
    // as a warning and the attempt is allowed.
    reason: windowPassed
      ? `${channel.name} is understood to stop accepting a ${action.label.toLowerCase()} `
        + `report ${action.windowDays} day(s) after arrival — that was ${closesOn}. `
        + 'The report will still be attempted, and the channel\'s answer recorded.'
      : undefined,
  };
}

export interface ReportResult {
  status: 'reported' | 'failed';
  kind: ReportKind;
  reportedAt: string | null;
  error?: string;
  attempts: number;
  /** What was sent and what came back — kept for both outcomes. */
  request: unknown;
  response: unknown;
}

/**
 * Report a booking's outcome to its channel.
 *
 * Deliberately not wrapped in a transaction around the network call: an HTTP
 * request inside `BEGIN IMMEDIATE` would hold SQLite's write lock for the
 * duration of somebody else's outage. The row is written after the call
 * returns, which is also the only moment its outcome is actually known.
 */
export async function reportToChannel(
  propertyId: string, actor: Actor, reservationId: string, kind: ReportKind, today: string,
): Promise<ReportResult> {
  const res = reservation(propertyId, reservationId);
  const action = REPORT_ACTIONS[kind];
  const eligibility = reportEligibility(propertyId, reservationId, kind, today);
  if (!eligibility.reportable) {
    throw new HttpError(409, eligibility.reason ?? 'This booking cannot be reported to a channel');
  }

  const channel = get<any>('SELECT * FROM channels WHERE id = ?', eligibility.channelId);

  // Both the client and the guard below used to read `settings.credentials`
  // directly. Encrypted at rest that field is a string, so `.refreshToken` was
  // undefined and this refused to report a no-show on a channel that was
  // connected and pushing rates fine — "no stored credentials" about a
  // credential sitting right there. `beds24ClientFor` decrypts it; `configured`
  // is then the honest answer to the same question.
  const client = beds24ClientFor(channel);
  if (!client.configured) {
    throw new HttpError(409,
      `${channel.name} has no stored credentials — connect it before reporting.`);
  }

  const request = { id: res.ota_reference, ...action.patch };
  const attempts = (res.channel_report_attempts ?? 0) + 1;
  const started = Date.now();

  let status: 'reported' | 'failed' = 'failed';
  let error: string | undefined;
  let response: unknown = null;

  try {
    const raw = await client.setBookingStatus(res.ota_reference, action.patch);
    response = raw.data;
    // A 200 is not a success. Beds24 reports per-item outcomes inside the body,
    // and treating the HTTP status as the answer is exactly how a system ends up
    // telling an operator a no-show was reported when it was not.
    const envelopeOk = raw.data?.success !== false;
    const item = raw.data?.data?.[0];
    const itemOk = item ? item.success !== false : false;
    const errors = [
      ...(raw.data?.errors ?? []),
      ...(item?.errors ?? []),
    ].map((e) => e.error ?? JSON.stringify(e)).filter(Boolean);

    if (envelopeOk && itemOk && !errors.length) {
      status = 'reported';
    } else {
      error = errors.length
        ? errors.join('; ')
        : !item
          ? 'The channel accepted the request but said nothing about the booking.'
          : 'The channel rejected the change without giving a reason.';
    }
    logSync(propertyId, channel, {
      direction: 'push',
      action: `${action.label} report · ${res.confirmation}`,
      status: status === 'reported' ? 'success' : 'failed',
      bytes: raw.bytes, durationMs: raw.durationMs,
      error,
    });
  } catch (e) {
    error = e instanceof ChannelApiError
      ? `${channel.name} returned ${e.status}: ${e.body.slice(0, 300)}`
      : e instanceof Error ? e.message : String(e);
    logSync(propertyId, channel, {
      direction: 'push',
      action: `${action.label} report · ${res.confirmation}`,
      status: 'failed', durationMs: Date.now() - started, error,
    });
  }

  const reportedAt = status === 'reported' ? nowIso() : null;
  run(
    `UPDATE reservations
        SET channel_report_kind = ?, channel_report_status = ?, channel_reported_at = ?,
            channel_report_error = ?, channel_report_attempts = ?,
            channel_report_request = ?, channel_report_response = ?, updated_at = ?
      WHERE id = ?`,
    kind, status, reportedAt, error ?? null, attempts,
    jsonCol(request), jsonCol(response), nowIso(), reservationId,
  );

  audit(actor, {
    action: 'channel.report', entity: 'RESERVATION', entityId: reservationId,
    entityRef: res.confirmation,
    after: { kind, status, attempts, error, channel: channel.code, otaReference: res.ota_reference },
    channel: channel.code,
    elevated: true,
  });

  return { status, kind, reportedAt, error, attempts, request, response };
}

/** Bookings whose outcome the channel has not been told about. */
export function unreportedNoShows(propertyId: string, today: string) {
  const rows = all<any>(
    `SELECT r.*, c.name AS channel_name, c.status AS channel_status
       FROM reservations r
       LEFT JOIN channels c ON c.property_id = r.property_id AND c.code = r.channel_code
      WHERE r.property_id = ? AND r.status = 'No-show'
        AND r.channel_code IS NOT NULL AND r.ota_reference IS NOT NULL
        AND (r.channel_report_status IS NULL OR r.channel_report_status = 'failed')
      ORDER BY r.arrival DESC
      LIMIT 200`,
    propertyId,
  );
  return rows.map((r) => {
    const closesOn = addDays(r.arrival, REPORT_ACTIONS.no_show.windowDays);
    return {
      id: r.id,
      confirmation: r.confirmation,
      guest: r.guest_name,
      arrival: r.arrival,
      channelCode: r.channel_code,
      channelName: r.channel_name ?? r.channel_code,
      channelConnected: r.channel_status === 'connected',
      otaReference: r.ota_reference,
      noShowAt: r.no_show_at,
      status: r.channel_report_status ?? 'not-reported',
      error: r.channel_report_error,
      attempts: r.channel_report_attempts ?? 0,
      windowClosesOn: closesOn,
      daysLeft: nightsBetween(today, closesOn),
      windowPassed: today > closesOn,
    };
  });
}

/** What the reservation screen shows about reporting. */
export function reportState(propertyId: string, reservationId: string, today: string) {
  const res = reservation(propertyId, reservationId);
  const kind = (res.channel_report_kind as ReportKind | null) ?? 'no_show';
  const action = REPORT_ACTIONS[kind] ?? REPORT_ACTIONS.no_show;
  const closesOn = addDays(res.arrival, action.windowDays);
  return {
    kind,
    label: action.label,
    status: res.channel_report_status ?? 'not-reported',
    reportedAt: res.channel_reported_at,
    error: res.channel_report_error,
    attempts: res.channel_report_attempts ?? 0,
    request: parseJson<unknown>(res.channel_report_request, null),
    response: parseJson<unknown>(res.channel_report_response, null),
    windowClosesOn: closesOn,
    daysLeft: nightsBetween(today, closesOn),
    windowPassed: today > closesOn,
    unconfirmed: true,
    kinds: REPORT_KINDS.map((k) => ({
      kind: k, label: REPORT_ACTIONS[k].label, windowDays: REPORT_ACTIONS[k].windowDays,
    })),
  };
}
