// ─────────────────────────────────────────────────────────────
// Guest messaging, including conversations that belong to an OTA.
//
// The point of this is that a receptionist should be able to read and answer a
// Booking.com guest without logging in to the Booking.com extranet. Beds24
// relays those conversations, so Helio polls them in and sends replies back out
// through the same connector the rest of the channel work uses.
//
// Two honesty rules run through the whole file:
//
//   · **Not every channel carries messages.** Booking.com and Airbnb do;
//     several do not, and Beds24 will accept a message for a channel that
//     cannot deliver it. A message is therefore never marked `delivered` —
//     `accepted` is the strongest claim available, and the screen says which
//     channels can carry a reply at all.
//
//   · **A failure is a failure.** As with the no-show report, Beds24 answers a
//     write with a per-item result inside a 200, so the body decides the
//     outcome, not the HTTP status.
// ─────────────────────────────────────────────────────────────
import { all, get, run, scalar, tx } from '../db.ts';
import { id, nowIso, addDays, HttpError } from '../lib/util.ts';
import { ChannelApiError } from '../channels/beds24.ts';
import { audit } from './audit.ts';
import { logSync, beds24ClientFor } from './channels.ts';
import { notify } from './notify.ts';
import { type Actor } from './reservations.ts';

/**
 * Which channels Beds24 can relay guest messages for.
 *
 * 🔌 Written from the documented integrations and not confirmed against a live
 * account. It is used to *withhold* a claim, never to make one: a channel that
 * is not on this list cannot be replied to from here, and the screen says so
 * rather than offering a reply box that quietly goes nowhere.
 */
const MESSAGE_CAPABLE = new Set([
  // Codes the channel catalogue actually issues — see CATALOGUE in
  // routes/channels.ts. `AIR` was previously written as `AIRBNB`, which matched
  // nothing the UI can create, so every Airbnb conversation was silently
  // unreplyable while the screen told the operator Airbnb "does not carry guest
  // messages". `messaging-check.ts` now asserts these against the catalogue so
  // the two cannot drift apart again.
  'BDC', 'AIR',
  // Accepted as aliases because a property may have typed its own code when the
  // channel was created by hand rather than chosen from the catalogue.
  'BOOKING', 'AIRBNB', 'ABNB',
]);

export const MESSAGE_CAPABLE_CODES: ReadonlySet<string> = MESSAGE_CAPABLE;

export function channelCarriesMessages(code: string | null | undefined): boolean {
  return !!code && MESSAGE_CAPABLE.has(code.toUpperCase());
}

export type MessageStatus = 'draft' | 'queued' | 'accepted' | 'failed' | 'received';

// ─── Templates ───────────────────────────────────────────────

const MERGE_FIELDS = [
  '{{guest}}', '{{firstName}}', '{{room}}', '{{roomType}}', '{{arrival}}',
  '{{departure}}', '{{nights}}', '{{confirmation}}', '{{property}}', '{{checkInTime}}',
];

export function listTemplates(propertyId: string) {
  return all<any>(
    `SELECT * FROM message_templates WHERE property_id = ? ORDER BY sort_order, name`, propertyId,
  ).map((t) => ({
    id: t.id, code: t.code, name: t.name, body: t.body,
    sortOrder: t.sort_order, active: t.active === 1,
    createdBy: t.created_by, createdAt: t.created_at,
  }));
}

export function upsertTemplate(propertyId: string, actor: Actor, input: {
  id?: string; code: string; name: string; body: string; sortOrder?: number; active?: boolean;
}) {
  if (!input.name?.trim()) throw new HttpError(400, 'A template needs a name');
  if (!input.body?.trim()) throw new HttpError(400, 'A template needs a body');
  if (input.id) {
    const before = get<any>('SELECT * FROM message_templates WHERE id = ? AND property_id = ?',
      input.id, propertyId);
    if (!before) throw new HttpError(404, 'Template not found');
    run(
      `UPDATE message_templates SET code = ?, name = ?, body = ?, sort_order = ?, active = ?
        WHERE id = ?`,
      input.code, input.name.trim(), input.body, input.sortOrder ?? before.sort_order,
      input.active === false ? 0 : 1, input.id,
    );
    audit(actor, { action: 'template.update', entity: 'PROPERTY', entityId: input.id, entityRef: input.name });
    return { id: input.id };
  }
  const templateId = id('tpl');
  run(
    `INSERT INTO message_templates(id, property_id, code, name, body, sort_order, active,
                                   created_by, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    templateId, propertyId, input.code, input.name.trim(), input.body,
    input.sortOrder ?? 0, input.active === false ? 0 : 1, actor.userName, nowIso(),
  );
  audit(actor, { action: 'template.create', entity: 'PROPERTY', entityId: templateId, entityRef: input.name });
  return { id: templateId };
}

export function deleteTemplate(propertyId: string, actor: Actor, templateId: string) {
  const before = get<any>('SELECT * FROM message_templates WHERE id = ? AND property_id = ?',
    templateId, propertyId);
  if (!before) throw new HttpError(404, 'Template not found');
  run('DELETE FROM message_templates WHERE id = ?', templateId);
  audit(actor, { action: 'template.delete', entity: 'PROPERTY', entityId: templateId, entityRef: before.name });
  return { ok: true };
}

/**
 * Fill a template's merge fields from a reservation.
 *
 * An unknown field is left as written rather than blanked. A message reading
 * "see you on {{arrivalDate}}" is obviously broken and gets fixed; one reading
 * "see you on " looks fine and goes out.
 */
export function renderTemplate(propertyId: string, body: string, reservationId?: string): string {
  if (!reservationId) return body;
  const res = get<any>(
    `SELECT r.*, rt.name AS room_type_name, rm.number AS room_number,
            p.name AS property_name, p.check_in_time
       FROM reservations r
       JOIN room_types rt ON rt.id = r.room_type_id
       JOIN properties p ON p.id = r.property_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
      WHERE r.id = ? AND r.property_id = ?`,
    reservationId, propertyId,
  );
  if (!res) return body;
  const values: Record<string, string> = {
    guest: res.guest_name ?? '',
    firstName: (res.guest_name ?? '').split(' ')[0] ?? '',
    room: res.room_number ?? 'your room',
    roomType: res.room_type_name ?? '',
    arrival: res.arrival ?? '',
    departure: res.departure ?? '',
    nights: String(res.nights ?? ''),
    confirmation: res.confirmation ?? '',
    property: res.property_name ?? '',
    checkInTime: res.check_in_time ?? '',
  };
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : whole);
}

export function mergeFields() {
  return MERGE_FIELDS;
}

// ─── Inbound: pulling channel messages in ────────────────────

interface RawMessage {
  id?: string | number;
  bookingId?: string | number;
  message?: string;
  time?: string;
  source?: string;
  read?: boolean;
}

/**
 * Pull recent guest messages from the channel and file them against bookings.
 *
 * Scoped to bookings that are still live — arriving, in-house, or departed in
 * the last fortnight. A property with years of history has no reason to ask the
 * channel about a conversation from 2019 every few minutes.
 */
export async function pollChannelMessages(
  propertyId: string, actor: Actor, today: string,
): Promise<{ polled: number; imported: number; skipped: number; errors: string[] }> {
  const channels = all<any>(
    `SELECT * FROM channels WHERE property_id = ? AND active = 1 AND status = 'connected'`,
    propertyId,
  ).filter((c) => channelCarriesMessages(c.code));

  const errors: string[] = [];
  let polled = 0;
  let imported = 0;
  let skipped = 0;

  if (!channels.length) {
    return { polled: 0, imported: 0, skipped: 0, errors: ['No connected channel carries messages'] };
  }

  const live = all<any>(
    `SELECT id, ota_reference, channel_code, profile_id, guest_name
       FROM reservations
      WHERE property_id = ? AND ota_reference IS NOT NULL
        AND departure >= ? AND arrival <= ?
        AND status NOT IN ('Cancelled')
      ORDER BY arrival DESC
      LIMIT 200`,
    propertyId, addDays(today, -14), addDays(today, 60),
  );
  const byReference = new Map(live.map((r) => [String(r.ota_reference), r]));

  for (const channel of channels) {
    // Never build this by hand: `channel.settings.credentials` is an encrypted
    // string once HELIO_SECRET_KEY is set, and passing it straight to the client
    // yields one that reports "not configured" on a channel that is connected
    // and working everywhere else. See `beds24ClientFor`.
    const client = beds24ClientFor(channel);

    const relevant = live.filter((r) => r.channel_code === channel.code);
    for (const res of relevant) {
      polled++;
      try {
        const raw = await client.getBookingMessages(String(res.ota_reference));
        const messages = (raw.data?.data ?? []) as RawMessage[];
        for (const m of messages) {
          const externalId = m.id === undefined || m.id === null ? null : String(m.id);
          if (!externalId || !m.message) { skipped++; continue; }
          // The poll window overlaps itself on purpose, so seeing a message
          // again is the normal case, not an error.
          const seen = scalar<number>(
            'SELECT count(*) AS n FROM messages WHERE property_id = ? AND external_id = ?',
            propertyId, externalId,
          );
          if (seen > 0) { skipped++; continue; }

          const fromGuest = (m.source ?? 'guest').toLowerCase() !== 'host';
          run(
            `INSERT INTO messages(id, property_id, reservation_id, profile_id, channel,
                                  channel_code, external_id, direction, subject, body, status,
                                  author, ts)
             VALUES(?,?,?,?,'ota',?,?,?,NULL,?,?,?,?)`,
            id('msg'), propertyId, res.id, res.profile_id ?? null,
            channel.code, externalId, fromGuest ? 'in' : 'out',
            m.message, fromGuest ? 'received' : 'accepted',
            fromGuest ? res.guest_name : channel.name,
            m.time ?? nowIso(),
          );
          imported++;
          // Only an inbound message. A reply Helio itself sent is not news to
          // the person who typed it.
          if (fromGuest) {
            notify(propertyId, {
              source: 'Guests',
              severity: 'info',
              title: `Message from ${res.guest_name}`,
              message: `${channel.name} · ${String(m.message ?? '').slice(0, 90)}`,
              link: '#/inbox',
            });
          }
        }
      } catch (e) {
        const message = e instanceof ChannelApiError
          ? `${channel.name} returned ${e.status}` : e instanceof Error ? e.message : String(e);
        errors.push(`${res.ota_reference}: ${message}`);
      }
    }

    logSync(propertyId, channel, {
      direction: 'pull',
      action: `Guest messages · ${relevant.length} booking(s)`,
      status: errors.length ? 'failed' : 'success',
      error: errors.length ? errors.slice(0, 3).join('; ') : undefined,
    });
  }

  if (imported) {
    audit(actor, {
      action: 'message.poll', entity: 'PROPERTY', entityId: propertyId,
      after: { polled, imported, skipped, errors: errors.length },
    });
  }
  return { polled, imported, skipped, errors };
}

// ─── Outbound: sending a reply ───────────────────────────────

export interface SendResult {
  id: string;
  status: MessageStatus;
  error?: string;
  /** True when the reply only exists in Helio — nobody outside has seen it. */
  localOnly: boolean;
}

export async function sendGuestMessage(
  propertyId: string, actor: Actor, input: { reservationId: string; body: string; templateId?: string },
): Promise<SendResult> {
  const body = input.body?.trim();
  if (!body) throw new HttpError(400, 'A message needs something in it');

  const res = get<any>(
    'SELECT * FROM reservations WHERE id = ? AND property_id = ?', input.reservationId, propertyId);
  if (!res) throw new HttpError(404, 'Reservation not found');

  const channel = res.channel_code
    ? get<any>(`SELECT * FROM channels WHERE property_id = ? AND code = ? AND active = 1`,
      propertyId, res.channel_code)
    : undefined;
  const viaChannel = !!channel && channel.status === 'connected'
    && channelCarriesMessages(channel.code);

  // Written first, whatever happens next. A reply that was typed and then failed
  // to send must still be on the thread — losing it is worse than failing to
  // deliver it, because nobody knows it was ever attempted.
  const messageId = id('msg');
  run(
    `INSERT INTO messages(id, property_id, reservation_id, profile_id, channel, channel_code,
                          direction, subject, body, status, author, ts, attempts)
     VALUES(?,?,?,?,?,?,'out',NULL,?,?,?,?,0)`,
    messageId, propertyId, res.id, res.profile_id ?? null,
    viaChannel ? 'ota' : 'internal', res.channel_code ?? null,
    body, viaChannel ? 'queued' : 'draft', actor.userName, nowIso(),
  );

  if (!viaChannel) {
    // Said plainly rather than shown as sent: this reply has not left the building.
    return {
      id: messageId,
      status: 'draft',
      localOnly: true,
      error: !res.channel_code
        ? 'This booking did not come from a channel, so there is nowhere to send it.'
        : !channel
          ? `${res.channel_code} is not set up here.`
          : !channelCarriesMessages(channel.code)
            ? `${channel.name} does not carry guest messages — reach the guest by email or phone.`
            : `${channel.name} is not connected.`,
    };
  }

  return deliverMessage(propertyId, actor, messageId);
}

/** Attempt (or retry) delivery of a message already on the thread. */
export async function deliverMessage(
  propertyId: string, actor: Actor, messageId: string,
): Promise<SendResult> {
  const msg = get<any>('SELECT * FROM messages WHERE id = ? AND property_id = ?',
    messageId, propertyId);
  if (!msg) throw new HttpError(404, 'Message not found');
  if (msg.direction !== 'out') throw new HttpError(400, 'Only an outgoing message can be sent');
  if (msg.status === 'accepted') throw new HttpError(409, 'That message has already gone');

  const res = get<any>('SELECT * FROM reservations WHERE id = ?', msg.reservation_id);
  const channel = get<any>(`SELECT * FROM channels WHERE property_id = ? AND code = ?`,
    propertyId, msg.channel_code);
  if (!res?.ota_reference || !channel) {
    throw new HttpError(409, 'This message has no channel booking to go to');
  }

  // Same trap as the poll above — the credentials field is encrypted at rest.
  const client = beds24ClientFor(channel);

  const attempts = (msg.attempts ?? 0) + 1;
  let status: MessageStatus = 'failed';
  let error: string | undefined;

  try {
    const raw = await client.sendBookingMessage(String(res.ota_reference), msg.body);
    const envelopeOk = raw.data?.success !== false;
    const item = raw.data?.data?.[0];
    const itemOk = item ? item.success !== false : false;
    const errors = [...(raw.data?.errors ?? []), ...(item?.errors ?? [])]
      .map((e) => e.error ?? JSON.stringify(e)).filter(Boolean);

    if (envelopeOk && itemOk && !errors.length) {
      // `accepted`, not `delivered`. Beds24 taking the message is not the guest
      // receiving it, and claiming otherwise would be inventing a fact.
      status = 'accepted';
    } else {
      error = errors.length ? errors.join('; ')
        : !item ? 'The channel accepted the request but said nothing about the message.'
          : 'The channel rejected the message without giving a reason.';
    }
    logSync(propertyId, channel, {
      direction: 'push',
      action: `Guest message · ${res.confirmation}`,
      status: status === 'accepted' ? 'success' : 'failed',
      bytes: raw.bytes, durationMs: raw.durationMs, error,
    });
  } catch (e) {
    error = e instanceof ChannelApiError
      ? `${channel.name} returned ${e.status}: ${e.body.slice(0, 200)}`
      : e instanceof Error ? e.message : String(e);
    logSync(propertyId, channel, {
      direction: 'push', action: `Guest message · ${res.confirmation}`,
      status: 'failed', error,
    });
  }

  run(
    `UPDATE messages SET status = ?, delivery_error = ?, accepted_at = ?, attempts = ?
      WHERE id = ?`,
    status, error ?? null, status === 'accepted' ? nowIso() : null, attempts, messageId,
  );

  audit(actor, {
    action: 'message.send', entity: 'RESERVATION', entityId: msg.reservation_id,
    entityRef: res.confirmation,
    after: { status, attempts, channel: channel.code, error },
    channel: channel.code,
  });

  return { id: messageId, status, error, localOnly: false };
}

// ─── The inbox ───────────────────────────────────────────────

export interface InboxFilters {
  unread?: boolean;
  inHouse?: boolean;
  arriving?: boolean;
  channelCode?: string;
  search?: string;
}

/**
 * One row per conversation, newest activity first.
 *
 * Grouped by reservation rather than by guest: the same person booking twice is
 * two conversations, and answering the wrong one is worse than having two.
 */
export function inbox(propertyId: string, today: string, filters: InboxFilters = {}) {
  const where = ['m.property_id = ?'];
  const params: unknown[] = [propertyId];

  if (filters.channelCode) { where.push('m.channel_code = ?'); params.push(filters.channelCode); }
  if (filters.search) {
    where.push('(r.guest_name LIKE ? OR r.confirmation LIKE ? OR m.body LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }

  const threads = all<any>(
    `SELECT m.reservation_id,
            max(m.ts) AS last_ts,
            count(*) AS total,
            sum(CASE WHEN m.direction = 'in' AND m.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
            sum(CASE WHEN m.status = 'failed' THEN 1 ELSE 0 END) AS failed,
            r.confirmation, r.guest_name, r.status AS reservation_status,
            r.arrival, r.departure, r.channel_code, r.ota_reference,
            rt.name AS room_type_name, rm.number AS room_number
       FROM messages m
       JOIN reservations r ON r.id = m.reservation_id
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
      WHERE ${where.join(' AND ')}
      GROUP BY m.reservation_id
      ORDER BY last_ts DESC
      LIMIT 200`,
    ...params,
  );

  return threads
    .filter((t) => {
      if (filters.unread && !t.unread) return false;
      if (filters.inHouse && t.reservation_status !== 'Checked-in') return false;
      if (filters.arriving && !(t.arrival === today && t.reservation_status !== 'Checked-in')) return false;
      return true;
    })
    .map((t) => {
      const last = get<any>(
        `SELECT body, direction, status, ts FROM messages
          WHERE reservation_id = ? ORDER BY ts DESC LIMIT 1`, t.reservation_id);
      return {
        reservationId: t.reservation_id,
        confirmation: t.confirmation,
        guest: t.guest_name,
        reservationStatus: t.reservation_status,
        arrival: t.arrival,
        departure: t.departure,
        room: t.room_number,
        roomType: t.room_type_name,
        channelCode: t.channel_code,
        otaReference: t.ota_reference,
        canReplyViaChannel: channelCarriesMessages(t.channel_code),
        total: t.total,
        unread: t.unread ?? 0,
        failed: t.failed ?? 0,
        lastAt: t.last_ts,
        lastBody: last?.body ?? '',
        lastDirection: last?.direction ?? 'in',
        lastStatus: last?.status ?? '',
        inHouse: t.reservation_status === 'Checked-in',
        arrivingToday: t.arrival === today,
      };
    });
}

export function thread(propertyId: string, reservationId: string) {
  return all<any>(
    `SELECT * FROM messages WHERE property_id = ? AND reservation_id = ? ORDER BY ts`,
    propertyId, reservationId,
  ).map((m) => ({
    id: m.id, direction: m.direction, body: m.body, status: m.status,
    channel: m.channel, channelCode: m.channel_code, externalId: m.external_id,
    author: m.author, ts: m.ts, readAt: m.read_at,
    acceptedAt: m.accepted_at, error: m.delivery_error, attempts: m.attempts ?? 0,
  }));
}

export function markThreadRead(propertyId: string, reservationId: string) {
  return tx(() => {
    const n = run(
      `UPDATE messages SET read_at = ?
        WHERE property_id = ? AND reservation_id = ? AND direction = 'in' AND read_at IS NULL`,
      nowIso(), propertyId, reservationId,
    );
    return { read: Number(n.changes ?? 0) };
  });
}

/** For the app shell's badge. */
export function unreadCount(propertyId: string): number {
  return scalar<number>(
    `SELECT count(*) AS n FROM messages
      WHERE property_id = ? AND direction = 'in' AND read_at IS NULL`,
    propertyId,
  );
}

/** Which connected channels a reply can actually be sent through. */
export function messagingChannels(propertyId: string) {
  return all<any>(
    `SELECT code, name, status, active FROM channels WHERE property_id = ? ORDER BY name`,
    propertyId,
  ).map((c) => ({
    code: c.code,
    name: c.name,
    connected: c.status === 'connected' && c.active === 1,
    carriesMessages: channelCarriesMessages(c.code),
  }));
}
