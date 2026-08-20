// ─────────────────────────────────────────────────────────────
// Channel manager.
//
// The PMS is the source of truth. This service resolves availability, rates
// and restrictions into a per-date ARI grid, pushes it to Beds24, imports the
// bookings that come back, and records every attempt in the sync log.
//
// Nothing here fabricates state: with no credentials a channel sits at
// `not-configured` and every operation returns an actionable error.
// ─────────────────────────────────────────────────────────────
import { config, liveBool } from '../config.ts';
import { all, get, run, tx, scalar, jsonCol, parseJson } from '../db.ts';
import { id, nowIso, addDays, dateRange, HttpError, notFound } from '../lib/util.ts';
import { availabilityGrid } from './availability.ts';
import { quoteStay } from './pricing.ts';
import { restrictionGrid } from './restrictions.ts';
import { createReservation, type Actor } from './reservations.ts';
import { audit } from './audit.ts';
import { notify } from './notify.ts';
import { recordCatalogue, refreshFromBookings, listOtas } from './otas.ts';
import { recordExternalQty, notifyDrift } from './inventory.ts';
import {
  encryptSecret, decryptSecret, encryptionAvailable, redactSecrets,
} from '../lib/secrets.ts';
import {
  Beds24Client, ChannelNotConfigured, ChannelApiError, readWriteResult,
  compressCalendar, normaliseBooking, type Beds24Credentials, type Beds24CalendarEntry,
} from '../channels/beds24.ts';

export interface ChannelRow {
  id: string; property_id: string; code: string; name: string; kind: string;
  active: number; commission_bp: number; price_multiplier_bp: number;
  currency: string | null; allotment: number | null; external_property_id: string | null;
  status: string; last_sync_at: string | null; last_error: string | null;
  settings: string | null; created_at: string;
}

// ─── Registry ────────────────────────────────────────────────
export function listChannels(propertyId: string) {
  const rows = all<ChannelRow>(
    'SELECT * FROM channels WHERE property_id = ? ORDER BY name', propertyId);
  const since = addDays(new Date().toISOString().slice(0, 10), 0);
  return rows.map((c) => {
    const pushed = scalar<number>(
      `SELECT count(*) AS n FROM channel_sync_log
        WHERE channel_id = ? AND direction = 'push' AND status = 'success' AND ts >= ?`,
      c.id, since);
    const pulled = scalar<number>(
      `SELECT count(*) AS n FROM channel_sync_log
        WHERE channel_id = ? AND direction = 'pull' AND status = 'success' AND ts >= ?`,
      c.id, since);
    const failures = scalar<number>(
      `SELECT count(*) AS n FROM channel_sync_log
        WHERE channel_id = ? AND status = 'failed' AND ts >= ?`, c.id, since);
    const mappings = scalar<number>(
      'SELECT count(*) AS n FROM channel_mappings WHERE channel_id = ? AND active = 1', c.id);
    const queued = scalar<number>(
      `SELECT count(*) AS n FROM channel_queue WHERE channel_id = ? AND status = 'queued'`, c.id);
    return {
      id: c.id, code: c.code, name: c.name, kind: c.kind,
      active: c.active === 1,
      commissionBp: c.commission_bp,
      priceMultiplierBp: c.price_multiplier_bp,
      allotment: c.allotment,
      status: c.status,
      configured: hasCredentials(c),
      externalPropertyId: c.external_property_id,
      lastSyncAt: c.last_sync_at,
      lastError: c.last_error,
      mappings,
      pushedToday: pushed,
      pulledToday: pulled,
      failuresToday: failures,
      queued,
      // Redacted, always. This blob is where the Beds24 refresh token lives —
      // a working key to the property's whole OTA distribution — and this
      // endpoint is readable by seven of the eight roles. A screen needs to know
      // whether a credential exists — `configured`, above — never what it is.
      settings: redactSecrets(parseJson<Record<string, unknown>>(c.settings, {})),
    };
  });
}

function hasCredentials(c: ChannelRow): boolean {
  const stored = parseJson<Record<string, unknown>>(c.settings, {}).credentials;
  // Encrypted credentials are one opaque string; their presence is the answer,
  // and deciding `configured` must never require decrypting them.
  if (typeof stored === 'string') return stored.length > 0;
  const cr = (stored ?? {}) as Beds24Credentials;
  return Boolean(cr.refreshToken || cr.accessToken);
}

export function getChannel(propertyId: string, channelId: string): ChannelRow {
  const c = get<ChannelRow>('SELECT * FROM channels WHERE id = ? AND property_id = ?', channelId, propertyId);
  if (!c) notFound('Channel');
  return c;
}

export function upsertChannel(propertyId: string, actor: Actor, input: {
  id?: string; code: string; name: string; kind?: string; active?: boolean;
  commissionBp?: number; priceMultiplierBp?: number; allotment?: number | null;
  externalPropertyId?: string | null; settings?: Record<string, unknown>;
}) {
  const existing = input.id
    ? get<ChannelRow>('SELECT * FROM channels WHERE id = ? AND property_id = ?', input.id, propertyId)
    : get<ChannelRow>('SELECT * FROM channels WHERE property_id = ? AND code = ?', propertyId, input.code);

  if (existing) {
    const merged = { ...parseJson<Record<string, unknown>>(existing.settings, {}), ...(input.settings ?? {}) };
    run(
      `UPDATE channels SET name = ?, kind = ?, active = ?, commission_bp = ?, price_multiplier_bp = ?,
              allotment = ?, external_property_id = ?, settings = ? WHERE id = ?`,
      input.name, input.kind ?? existing.kind, input.active === undefined ? existing.active : (input.active ? 1 : 0),
      input.commissionBp ?? existing.commission_bp,
      input.priceMultiplierBp ?? existing.price_multiplier_bp,
      input.allotment === undefined ? existing.allotment : input.allotment,
      input.externalPropertyId ?? existing.external_property_id,
      jsonCol(merged), existing.id,
    );
    audit(actor, {
      action: 'channel.update', entity: 'CHANNEL', entityId: existing.id, entityRef: existing.code,
      channel: existing.code, before: { active: existing.active === 1 }, after: input,
    });
    return getChannel(propertyId, existing.id);
  }

  const chId = id('chn');
  run(
    `INSERT INTO channels(id, property_id, code, name, kind, active, commission_bp, price_multiplier_bp,
                          allotment, external_property_id, status, settings, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,'not-configured',?,?)`,
    chId, propertyId, input.code, input.name, input.kind ?? 'ota',
    input.active ? 1 : 0, input.commissionBp ?? 0, input.priceMultiplierBp ?? 10_000,
    input.allotment ?? null, input.externalPropertyId ?? null,
    jsonCol(input.settings ?? {}), nowIso(),
  );
  audit(actor, {
    action: 'channel.create', entity: 'CHANNEL', entityId: chId, entityRef: input.code,
    channel: input.code, after: input,
  });
  return getChannel(propertyId, chId);
}

// ─── Credentials & connection ────────────────────────────────

/**
 * Read a channel's settings with its credentials decrypted.
 *
 * The only place credentials are ever in the clear is inside the process, on
 * the way to the connector. Nothing that reaches an API response goes through
 * here — see `listChannels`, which reads the redacted form.
 */
/** The part of a channel row needed to build a connector for it. */
type ChannelCredentialSource = Pick<ChannelRow, 'id' | 'settings'>;

function settingsWithCredentials(channel: ChannelCredentialSource): {
  settings: Record<string, unknown>; credentials: Beds24Credentials;
} {
  const settings = parseJson<Record<string, unknown>>(channel.settings, {});
  const stored = settings.credentials;
  if (typeof stored === 'string') {
    // Encrypted: one opaque string in place of the credentials object.
    return { settings, credentials: JSON.parse(decryptSecret(stored)) as Beds24Credentials };
  }
  return { settings, credentials: (stored ?? {}) as Beds24Credentials };
}

/** Write credentials back, encrypted when a key is configured. */
function storeCredentials(
  channelId: string, settings: Record<string, unknown>, credentials: Beds24Credentials,
): void {
  const payload = JSON.stringify(credentials);
  run('UPDATE channels SET settings = ? WHERE id = ?',
    jsonCol({
      ...settings,
      credentials: encryptionAvailable() ? encryptSecret(payload) : credentials,
    }),
    channelId);
}

/**
 * Build a connector for a channel. **The only correct way to make one.**
 *
 * Three other modules used to construct `Beds24Client` themselves, straight from
 * `parseJson(channel.settings).credentials`. That field is not an object once a
 * `HELIO_SECRET_KEY` is configured — it is the opaque `enc.v1.…` string written
 * by `storeCredentials`. Handing that string over as the credentials object gave
 * a client whose `refreshToken` was `undefined`, so `configured` was false and
 * every call died with "Beds24 credentials are not configured".
 *
 * The damage was in how convincing that lie was. Rates, availability, open/close
 * and the booking import all came through here and worked perfectly, while guest
 * messages in, guest messages out and the channel reports failed on the same
 * channel row, in the same process, blaming a credential that was demonstrably
 * fine. Turning encryption on is what switched them off, and nothing connected
 * the two.
 *
 * Their token-refresh callbacks were the second half of it: each wrote the
 * credentials back as plain JSON, so any refresh reached through one of those
 * paths would have quietly undone the encryption for every other path too.
 *
 * Exported so there is one door. A caller that only has a channel row cannot
 * accidentally take the raw field again.
 */
export function beds24ClientFor(channel: ChannelCredentialSource): Beds24Client {
  const { settings, credentials } = settingsWithCredentials(channel);
  return new Beds24Client(credentials, (creds) => {
    // The connector refreshes its own access token; that refresh must be
    // stored the same way as the original, not silently in the clear.
    storeCredentials(channel.id, settings, creds);
  });
}

function clientFor(_propertyId: string, channel: ChannelRow): Beds24Client {
  return beds24ClientFor(channel);
}

export async function connectBeds24(
  propertyId: string, actor: Actor, channelId: string,
  input: { inviteCode?: string; refreshToken?: string; externalPropertyId?: string },
) {
  const channel = getChannel(propertyId, channelId);

  // Reading the existing credential must not stop a *new* one being entered.
  // A credential encrypted under a key that has since changed cannot be read,
  // and if that threw here the channel could never be reconnected — the one
  // moment somebody is trying to fix exactly that problem.
  let settings: Record<string, unknown>;
  let credentials: Beds24Credentials;
  try {
    ({ settings, credentials } = settingsWithCredentials(channel));
  } catch {
    settings = parseJson<Record<string, unknown>>(channel.settings, {});
    credentials = {};
  }
  const previousSettings = parseJson<Record<string, unknown>>(channel.settings, {});
  const client = new Beds24Client(credentials, () => {});

  let creds: Beds24Credentials;
  if (input.refreshToken) {
    creds = { ...credentials, refreshToken: input.refreshToken };
  } else if (input.inviteCode) {
    creds = await client.setup(input.inviteCode);
  } else {
    throw new HttpError(400, 'Provide either an invite code or a refresh token');
  }

  // The credential has to be stored before it can be tested, because the client
  // reads it back from the row. But a token Beds24 rejects must not be left
  // behind: it would sit there looking configured, poison the next attempt, and
  // — if it were encrypted under a key that later changed — be unreadable.
  storeCredentials(channelId, settings, creds);

  let verified: Awaited<ReturnType<typeof testConnection>>;
  try {
    verified = await testConnection(propertyId, actor, channelId);
  } catch (e) {
    run('UPDATE channels SET settings = ? WHERE id = ?', jsonCol(previousSettings), channelId);
    throw e;
  }
  if (!verified.ok) {
    run('UPDATE channels SET settings = ? WHERE id = ?', jsonCol(previousSettings), channelId);
  }
  // Which property on the channel's side this is.
  //
  // Taken from the caller when given, and otherwise learned from the connection
  // that was just proved: `testConnection` lists the properties the token can
  // see, and when there is exactly one there is nothing to guess.
  //
  // Leaving it null looks harmless — reads work without it, because the token
  // already scopes them — and then the first *write* that needs to name a
  // property fails with "this channel has no property id", long after anyone
  // would connect the two events. Several rooms is a different matter and is
  // left for a person, since picking the wrong one writes inventory to somebody
  // else's property.
  if (input.externalPropertyId) {
    run('UPDATE channels SET external_property_id = ? WHERE id = ?', input.externalPropertyId, channelId);
  } else if (verified.ok && verified.properties?.length === 1) {
    run('UPDATE channels SET external_property_id = ? WHERE id = ?',
      verified.properties[0].id, channelId);
  }
  audit(actor, {
    action: 'channel.connect', entity: 'CHANNEL', entityId: channelId, entityRef: channel.code,
    channel: channel.code, after: { connected: verified.ok }, elevated: true,
  });
  return verified;
}

export async function testConnection(propertyId: string, actor: Actor, channelId: string) {
  const channel = getChannel(propertyId, channelId);
  const client = clientFor(propertyId, channel);
  const started = Date.now();
  try {
    const res = await client.listProperties();
    const properties = (res.data as any)?.data ?? [];
    run(
      `UPDATE channels SET status = 'connected', last_sync_at = ?, last_error = NULL WHERE id = ?`,
      nowIso(), channelId,
    );
    logSync(propertyId, channel, {
      direction: 'pull', action: 'connection test', status: 'success',
      bytes: res.bytes, durationMs: res.durationMs,
    });
    return {
      ok: true,
      properties: properties.map((p: any) => ({ id: String(p.id), name: p.name })),
      rateLimit: res.rateLimit,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof ChannelNotConfigured ? 'not-configured' : 'error';
    run('UPDATE channels SET status = ?, last_error = ? WHERE id = ?', status, message, channelId);
    logSync(propertyId, channel, {
      direction: 'pull', action: 'connection test', status: 'failed',
      durationMs: Date.now() - started, error: message,
    });
    return { ok: false, error: message, status };
  }
}

// ─── Sync log ────────────────────────────────────────────────
export function logSync(propertyId: string, channel: ChannelRow | null, entry: {
  direction: 'push' | 'pull'; action: string; status: 'success' | 'failed' | 'pending' | 'skipped';
  bytes?: number; durationMs?: number; attempt?: number; error?: string;
}) {
  run(
    `INSERT INTO channel_sync_log(id, property_id, channel_id, channel_code, ts, direction, action,
                                  status, payload_bytes, duration_ms, attempt, error)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id('syn'), propertyId, channel?.id ?? null, channel?.code ?? null, nowIso(),
    entry.direction, entry.action, entry.status,
    entry.bytes ?? 0, entry.durationMs ?? 0, entry.attempt ?? 1, entry.error ?? null,
  );
}

export function syncLog(propertyId: string, limit = 100, channelId?: string) {
  return all<any>(
    `SELECT l.*, c.name AS channel_name FROM channel_sync_log l
       LEFT JOIN channels c ON c.id = l.channel_id
      WHERE l.property_id = ? ${channelId ? 'AND l.channel_id = ?' : ''}
      ORDER BY l.ts DESC LIMIT ?`,
    ...(channelId ? [propertyId, channelId, limit] : [propertyId, limit]),
  ).map((l) => ({
    id: l.id, ts: l.ts, direction: l.direction, channel: l.channel_name ?? l.channel_code ?? '—',
    channelCode: l.channel_code, action: l.action, status: l.status,
    payloadBytes: l.payload_bytes, durationMs: l.duration_ms, attempt: l.attempt, error: l.error,
  }));
}

// ─── Mappings ────────────────────────────────────────────────
export function listMappings(propertyId: string, channelId?: string) {
  return all<any>(
    `SELECT m.*, c.code AS channel_code, c.name AS channel_name,
            rt.code AS room_type_code, rt.name AS room_type_name,
            rp.code AS rate_plan_code, rp.name AS rate_plan_name
       FROM channel_mappings m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN room_types rt ON rt.id = m.room_type_id
       LEFT JOIN rate_plans rp ON rp.id = m.rate_plan_id
      WHERE m.property_id = ? ${channelId ? 'AND m.channel_id = ?' : ''}
      ORDER BY c.name, rt.name`,
    ...(channelId ? [propertyId, channelId] : [propertyId]),
  ).map((m) => ({
    id: m.id, channelId: m.channel_id, channelCode: m.channel_code, channelName: m.channel_name,
    roomTypeId: m.room_type_id, roomType: m.room_type_name, roomTypeCode: m.room_type_code,
    ratePlanId: m.rate_plan_id, ratePlan: m.rate_plan_name, ratePlanCode: m.rate_plan_code,
    externalRoomId: m.external_room_id, externalRateId: m.external_rate_id,
    externalName: m.external_name, active: m.active === 1,
  }));
}

export function upsertMapping(propertyId: string, actor: Actor, input: {
  id?: string; channelId: string; roomTypeId?: string | null; ratePlanId?: string | null;
  externalRoomId?: string | null; externalRateId?: string | null; externalName?: string | null;
  active?: boolean;
}) {
  // One PMS room type may back only one channel room.
  //
  // Two channel rooms sharing a type means their availability is pushed from a
  // single pool: sell one bed and both listings drop, sell out one and the
  // other keeps selling. On a live hostel that is an immediate overbooking, and
  // for a female-only dorm mapped to a mixed one it is worse than that.
  //
  // Enforced here as well as in the suggestion logic, because a mapping can be
  // written by hand from the channel manager, by an import, or by a script.
  if (input.roomTypeId) {
    const clash = get<{ id: string; external_name: string | null }>(
      `SELECT id, external_name FROM channel_mappings
        WHERE property_id = ? AND channel_id = ? AND room_type_id = ? AND active = 1
          AND (? IS NULL OR id <> ?)
          AND (external_room_id IS NULL OR external_room_id <> ?)`,
      propertyId, input.channelId, input.roomTypeId,
      input.id ?? null, input.id ?? null, input.externalRoomId ?? null,
    );
    if (clash) {
      const roomType = get<{ name: string }>('SELECT name FROM room_types WHERE id = ?',
        input.roomTypeId);
      throw new HttpError(409,
        `${roomType?.name ?? 'That room type'} is already mapped to `
        + `"${clash.external_name ?? 'another channel room'}". Two channel rooms sharing one room `
        + 'type would sell the same beds twice. Create a separate room type first.',
        'mapping_conflict');
    }
  }
  const channel = getChannel(propertyId, input.channelId);
  if (input.id) {
    run(
      `UPDATE channel_mappings SET room_type_id = ?, rate_plan_id = ?, external_room_id = ?,
              external_rate_id = ?, external_name = ?, active = ? WHERE id = ? AND property_id = ?`,
      input.roomTypeId ?? null, input.ratePlanId ?? null, input.externalRoomId ?? null,
      input.externalRateId ?? null, input.externalName ?? null, input.active === false ? 0 : 1,
      input.id, propertyId,
    );
    audit(actor, {
      action: 'mapping.update', entity: 'CHANNEL_MAPPING', entityId: input.id,
      entityRef: `${channel.code}`, channel: channel.code, after: input,
    });
    return get<any>('SELECT * FROM channel_mappings WHERE id = ?', input.id);
  }
  const mid = id('map');
  run(
    `INSERT INTO channel_mappings(id, property_id, channel_id, room_type_id, rate_plan_id,
                                  external_room_id, external_rate_id, external_name, active, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    mid, propertyId, input.channelId, input.roomTypeId ?? null, input.ratePlanId ?? null,
    input.externalRoomId ?? null, input.externalRateId ?? null, input.externalName ?? null,
    input.active === false ? 0 : 1, nowIso(),
  );
  audit(actor, {
    action: 'mapping.create', entity: 'CHANNEL_MAPPING', entityId: mid,
    entityRef: channel.code, channel: channel.code, after: input,
  });
  return get<any>('SELECT * FROM channel_mappings WHERE id = ?', mid);
}

export function deleteMapping(propertyId: string, actor: Actor, mappingId: string) {
  const m = get<any>('SELECT * FROM channel_mappings WHERE id = ? AND property_id = ?', mappingId, propertyId);
  if (!m) notFound('Mapping');
  run('DELETE FROM channel_mappings WHERE id = ?', mappingId);
  audit(actor, { action: 'mapping.delete', entity: 'CHANNEL_MAPPING', entityId: mappingId });
  return { ok: true };
}

/** Pull the room list from Beds24 and match it against PMS room types. */
/**
 * Refresh what is known about the OTAs behind this channel.
 *
 * Two sources, kept apart on purpose: what Beds24 says about itself, and what
 * bookings prove. The booking side runs even when the Beds24 read fails —
 * losing the network is no reason to forget which OTAs have sent business.
 */
export async function refreshOtas(propertyId: string, channelId: string) {
  const channel = getChannel(propertyId, channelId);
  try {
    const client = clientFor(propertyId, channel);
    const res = await client.listChannelCatalogue(channel.external_property_id ?? undefined);
    const { codes, rateCodes } = (res.data as any) ?? { codes: [], rateCodes: {} };
    if (codes?.length) recordCatalogue(propertyId, channelId, codes, rateCodes ?? {});
  } catch {
    // Beds24 unreachable, or answering oddly. The booking-derived truth below
    // is the part that must not be skipped.
  }
  refreshFromBookings(propertyId);
  return listOtas(propertyId);
}

/**
 * Send a room type's unit count to the channel.
 *
 * Separate from the ARI push because it is a different kind of write: ARI says
 * "these dates cost this much and this many are free", while this says "this
 * room has this many units at all". Getting the second one wrong does not
 * misprice a night, it invents beds.
 *
 * Honours the read-only switch, is read per item, and records the outcome
 * either way — a refusal has to look like a refusal.
 */
export async function pushRoomQuantity(
  propertyId: string, actor: Actor, channelId: string, roomTypeId: string, qty: number,
) {
  const channel = getChannel(propertyId, channelId);

  if (readOnlyChannels()) {
    logSync(propertyId, channel, {
      direction: 'push', action: `quantity ${qty}`, status: 'skipped',
      error: 'HELIO_CHANNEL_READONLY is set — outbound pushes are disabled',
    });
    throw new HttpError(409,
      'Outbound channel pushes are switched off (HELIO_CHANNEL_READONLY). '
      + 'The count was changed in Helio but not sent to the channel.',
      'channel_readonly');
  }

  const mapping = listMappings(propertyId, channelId)
    .find((m) => m.roomTypeId === roomTypeId && m.active && m.externalRoomId);
  if (!mapping) {
    throw new HttpError(409,
      'That room type is not mapped to a channel room, so there is nowhere to send the count.',
      'no_mapping');
  }
  if (!channel.external_property_id) {
    throw new HttpError(409, 'This channel has no property id — reconnect it first.');
  }

  const started = Date.now();
  const client = clientFor(propertyId, channel);
  try {
    const res = await client.setRoomQuantity(channel.external_property_id, [
      { roomId: mapping.externalRoomId!, qty },
    ]);
    const result = readWriteResult(res);
    logSync(propertyId, channel, {
      direction: 'push',
      action: `quantity ${mapping.externalName ?? mapping.externalRoomId} → ${qty}`,
      status: result.ok ? 'success' : 'failed',
      durationMs: Date.now() - started,
      error: result.ok ? undefined : result.errors.join('; '),
    });
    if (!result.ok) {
      throw new HttpError(502,
        `The channel refused the change: ${result.errors.join('; ') || 'no reason given'}`,
        'channel_rejected');
    }
    // Believe it only now that it was accepted.
    run(
      `UPDATE channel_mappings SET external_qty = ?, external_seen_at = ?
        WHERE id = ?`, qty, nowIso(), mapping.id);
    audit(actor, {
      action: 'channel.quantity', entity: 'CHANNEL', entityId: channelId,
      entityRef: mapping.externalName ?? mapping.externalRoomId!, after: { qty },
    });
    return { ok: true, qty, externalRoomId: mapping.externalRoomId };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    logSync(propertyId, channel, {
      direction: 'push', action: `quantity ${qty}`, status: 'failed',
      durationMs: Date.now() - started, error: message,
    });
    throw new HttpError(502, message);
  }
}

export async function discoverUnits(propertyId: string, actor: Actor, channelId: string) {
  const channel = getChannel(propertyId, channelId);
  const client = clientFor(propertyId, channel);
  const res = await client.listRooms(channel.external_property_id ?? undefined);
  const rooms = (res.data as any)?.data ?? [];
  const pmsTypes = all<any>(
    'SELECT id, code, name, kind FROM room_types WHERE property_id = ? AND active = 1', propertyId);
  const mapped = new Map(
    listMappings(propertyId, channelId).map((m) => [m.externalRoomId, m]),
  );

  logSync(propertyId, channel, {
    direction: 'pull', action: `discover units (${rooms.length})`, status: 'success',
    bytes: res.bytes, durationMs: res.durationMs,
  });

  // Remember what the channel says it sells, against what we hold. This is the
  // only moment the two numbers are both in hand, and comparing them later is
  // what turns a silent oversell into a warning.
  recordExternalQty(propertyId, channelId,
    rooms.map((r: any) => ({ externalId: r.id, quantity: r.qty, maxPeople: r.maxPeople })));
  notifyDrift(propertyId);

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Exact name, and nothing else.
  //
  // This used to fall back to "the Beds24 name contains the PMS type's code",
  // which on a real hostel matched three different rooms — an 8-bed mixed dorm,
  // a 6-bed female dorm and a female bunk room — to the single type whose code
  // was `DORM`. Mapping several Beds24 rooms onto one PMS type means their
  // availability is pushed from one pool: the property oversells threefold and
  // sells female beds to anyone. A guess that confident has to be right, and a
  // substring is not.
  const exact = (r: any) =>
    pmsTypes.find((t) => norm(t.name) === norm(String(r.name ?? '')));

  // A suggestion that two rooms share is not a suggestion. If the same PMS type
  // is the best guess for more than one Beds24 room, none of them is offered.
  const guessCounts = new Map<string, number>();
  for (const r of rooms) {
    const g = exact(r);
    if (g) guessCounts.set(g.id, (guessCounts.get(g.id) ?? 0) + 1);
  }

  return rooms.map((r: any) => {
    const externalId = String(r.id);
    const existing = mapped.get(externalId);
    const candidate = exact(r);
    const guess = candidate && guessCounts.get(candidate.id) === 1 ? candidate : undefined;
    return {
      externalId,
      name: String(r.name ?? ''),
      // Beds24 says so itself. The old test — "maxPeople > 6" — got every real
      // dorm wrong, because a dorm bed is sold as a one-person unit with
      // `qty` set to the number of beds: an eight-bed dorm arrives as
      // maxPeople 1, qty 16, and looked like a private single room.
      kind: String(r.roomType ?? '').toLowerCase().includes('dormitory')
        || String(r.roomType ?? '').toLowerCase() === 'dorm'
        ? 'dorm' : 'room',
      /** Beds24's own classification, kept for anything that needs the detail. */
      externalRoomType: String(r.roomType ?? ''),
      quantity: Number(r.qty ?? r.roomQty ?? 0) || 0,
      maxPeople: Number(r.maxPeople ?? 0) || 0,
      status: existing ? 'mapped' : (guess ? 'suggested' : 'unmapped'),
      mappedRoomTypeId: existing?.roomTypeId ?? null,
      suggestedRoomTypeId: guess?.id ?? null,
      suggestedRoomType: guess?.name ?? null,
    };
  });
}

/**
 * Ask for the push queue to be drained soon.
 *
 * The server owns the timer, and this service must not import it — so the
 * server hands in a callback instead. Nothing here depends on it being set: the
 * queue is drained on a schedule regardless, and this only makes it happen
 * sooner. A price change waiting a full minute to reach an OTA is a poor
 * experience; a price change that never arrives because the nudge was the only
 * mechanism would be a defect.
 */
let queueNudge: (() => void) | null = null;
export function setQueueNudge(fn: (() => void) | null) { queueNudge = fn; }
export function nudgeQueue() {
  try { queueNudge?.(); } catch { /* never let a nudge break the write that queued it */ }
}

/**
 * True when this installation must not write anything to a channel.
 *
 * Read per call rather than cached, so it can be turned on for a running
 * process without a restart — the moment it is needed is usually the moment
 * something is already going out wrong.
 */
export function readOnlyChannels(): boolean {
  return liveBool('HELIO_CHANNEL_READONLY', config.channelReadonly);
}

// ─── ARI resolution ──────────────────────────────────────────
export interface AriCell {
  roomTypeId: string;
  roomTypeCode: string;
  ratePlanId: string;
  ratePlanCode: string;
  date: string;
  available: number;
  priceMinor: number;
  minStay: number | null;
  maxStay: number | null;
  cta: boolean;
  ctd: boolean;
  stopSell: boolean;
}

/**
 * Resolve what a channel should be told for a date range: pooled availability
 * (capped by any per-channel allotment), the channel-adjusted price, and the
 * effective restrictions.
 */
export function buildAri(propertyId: string, opts: {
  roomTypeId?: string; ratePlanId?: string; from: string; to: string; channelCode?: string | null;
  allotment?: number | null;
}): AriCell[] {
  const grid = availabilityGrid(propertyId, opts.from, opts.to);
  const types = opts.roomTypeId
    ? all<any>('SELECT * FROM room_types WHERE id = ? AND property_id = ?', opts.roomTypeId, propertyId)
    : all<any>('SELECT * FROM room_types WHERE property_id = ? AND active = 1', propertyId);

  const plans = opts.ratePlanId
    ? all<any>('SELECT * FROM rate_plans WHERE id = ? AND property_id = ?', opts.ratePlanId, propertyId)
    : all<any>('SELECT * FROM rate_plans WHERE property_id = ? AND active = 1', propertyId);

  const cells: AriCell[] = [];
  for (const rt of types) {
    for (const rp of plans) {
      const restrictions = restrictionGrid(propertyId, rt.id, rp.id, opts.from, opts.to, opts.channelCode);
      const byDate = new Map(restrictions.map((r) => [r.date, r]));
      // One quote for the whole window prices every date in a single pass.
      const quote = quoteStay(propertyId, {
        roomTypeId: rt.id, ratePlanId: rp.id, arrival: opts.from, departure: opts.to,
        adults: rt.base_occupancy, children: 0, channelCode: opts.channelCode ?? null,
        applyYield: true,
      });
      const priceByDate = new Map(quote.nights.map((n) => [n.date, n.rateMinor]));

      for (const date of dateRange(opts.from, opts.to)) {
        const av = grid.find((c) => c.roomTypeId === rt.id && c.date === date);
        const r = byDate.get(date);
        let available = Math.max(0, av?.available ?? 0);
        if (opts.allotment !== null && opts.allotment !== undefined) {
          available = Math.min(available, opts.allotment);
        }
        cells.push({
          roomTypeId: rt.id,
          roomTypeCode: rt.code,
          ratePlanId: rp.id,
          ratePlanCode: rp.code,
          date,
          available: r?.stopSell ? 0 : available,
          priceMinor: priceByDate.get(date) ?? 0,
          minStay: r?.minStay ?? r?.minStayThrough ?? null,
          maxStay: r?.maxStay ?? null,
          cta: r?.cta ?? false,
          ctd: r?.ctd ?? false,
          stopSell: r?.stopSell ?? false,
        });
      }
    }
  }
  return cells;
}

// ─── Push ────────────────────────────────────────────────────
export async function pushToChannel(
  propertyId: string, actor: Actor, channelId: string,
  opts: { roomTypeId?: string; from: string; to: string; scope?: string },
) {
  const channel = getChannel(propertyId, channelId);

  // Outbound writes can be switched off for the whole installation.
  //
  // Connecting a live channel manager makes every ordinary action outward-
  // facing: taking one booking enqueues an ARI push, and the background drain
  // sends it to the OTAs within seconds. That is right in production and wrong
  // while a property is still checking that its imported inventory and rates
  // look correct — the first mistake is published before anyone has seen it.
  //
  // Reads are unaffected: bookings still import, so the PMS can be verified
  // against live data without touching what guests can see or pay.
  if (readOnlyChannels()) {
    logSync(propertyId, channel, {
      direction: 'push', action: 'ARI push', status: 'skipped',
      error: 'HELIO_CHANNEL_READONLY is set — outbound pushes are disabled',
    });
    throw new HttpError(409,
      'Outbound channel pushes are switched off (HELIO_CHANNEL_READONLY). '
      + 'Rates and availability were not sent. Unset it to publish again.',
      'channel_readonly');
  }

  if (channel.active !== 1) {
    // Record the refusal — an operator pushing a paused channel needs to see
    // why nothing happened, not just an error toast that disappears.
    logSync(propertyId, channel, {
      direction: 'push', action: 'ARI push', status: 'skipped',
      error: 'Channel is paused',
    });
    throw new HttpError(409, `Channel ${channel.name} is paused — activate it before pushing`);
  }
  const mappings = listMappings(propertyId, channelId)
    .filter((m) => m.active && m.externalRoomId
      && (!opts.roomTypeId || m.roomTypeId === opts.roomTypeId));
  if (!mappings.length) {
    const message = 'No active room mappings — map PMS room types to Beds24 rooms first';
    logSync(propertyId, channel, { direction: 'push', action: 'ARI push', status: 'skipped', error: message });
    throw new HttpError(409, message, 'no_mappings');
  }

  const client = clientFor(propertyId, channel);
  const currencyDivisor = 100;
  const entries: Beds24CalendarEntry[] = [];

  for (const m of mappings) {
    if (!m.roomTypeId) continue;
    const cells = buildAri(propertyId, {
      roomTypeId: m.roomTypeId,
      ratePlanId: m.ratePlanId ?? undefined,
      from: opts.from,
      to: opts.to,
      channelCode: channel.code,
      allotment: channel.allotment,
    });
    // A room type maps to one Beds24 room; when several rate plans are mapped
    // the first mapping's plan drives the pushed price.
    const primary = cells.filter((c) => !m.ratePlanId || c.ratePlanId === m.ratePlanId);
    const calendar = compressCalendar(primary.map((c) => ({
      date: c.date,
      numAvail: c.available,
      priceMajor: Math.round(c.priceMinor) / currencyDivisor,
      minStay: c.minStay ?? undefined,
      maxStay: c.maxStay ?? undefined,
      cta: c.cta,
      ctd: c.ctd,
      stopSell: c.stopSell,
    })));
    if (calendar.length) entries.push({ roomId: m.externalRoomId!, calendar });
  }

  const started = Date.now();
  try {
    const res = await client.setCalendar(entries);
    // Envelope *and* per-item — see `readWriteResult`. Checking only the
    // envelope marked this channel healthy while individual rooms were being
    // rejected, which is an overbooking with a paper trail saying all was well.
    const { ok, errors, failedItems } = readWriteResult(res);
    const detail = errors.length ? JSON.stringify(errors).slice(0, 500) : null;

    // A rejected push must not claim the channel is connected, and must not
    // wipe an earlier error — the next drain has to know something is wrong.
    if (ok) {
      run(`UPDATE channels SET status = 'connected', last_sync_at = ?, last_error = NULL WHERE id = ?`,
        nowIso(), channelId);
    } else {
      run(`UPDATE channels SET status = 'error', last_error = ? WHERE id = ?`, detail, channelId);
      // The failure that used to be invisible. Somebody has to know that the
      // OTA is still selling what the property thinks it changed.
      notify(propertyId, {
        source: 'Channels',
        severity: 'critical',
        title: `${channel.name} rejected an update`,
        message: `${failedItems} room(s) refused for ${opts.from} → ${opts.to}. Those dates may `
          + 'still be selling at the old price or availability.',
        link: '#/channel-manager',
      });
    }

    logSync(propertyId, channel, {
      direction: 'push',
      action: `ARI ${opts.from} → ${opts.to} · ${entries.length} room(s)`
        + (failedItems ? ` · ${failedItems} rejected` : ''),
      status: ok ? 'success' : 'failed',
      bytes: res.bytes, durationMs: res.durationMs,
      error: ok ? undefined : (detail ?? undefined),
    });
    audit(actor, {
      action: 'channel.push', entity: 'CHANNEL', entityId: channelId, entityRef: channel.code,
      channel: channel.code,
      after: { from: opts.from, to: opts.to, rooms: entries.length, ok, failedItems },
    });
    return { ok, rooms: entries.length, rateLimit: res.rateLimit, errors, failedItems };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof ChannelNotConfigured ? 'not-configured' : 'error';
    run('UPDATE channels SET status = ?, last_error = ? WHERE id = ?', status, message, channelId);
    logSync(propertyId, channel, {
      direction: 'push', action: `ARI ${opts.from} → ${opts.to}`, status: 'failed',
      durationMs: Date.now() - started, error: message,
    });
    throw new HttpError(e instanceof ChannelApiError ? 502 : 409, message, status);
  }
}

/** Rapid attempts before a row is parked to cool off. */
const FAST_ATTEMPTS = 5;

/** How long a parked row waits before its next try, and the ceiling on that. */
const RETRY_BASE_MINUTES = config.channelRetryMinutes;
const RETRY_MAX_MINUTES = 6 * 60;

/**
 * Put parked pushes back in the queue once they have cooled off.
 *
 * A failed row used to be the end of the line. Five attempts — five transient
 * `fetch failed`s, or five minutes of an expired token — flipped it to `failed`,
 * and `processQueue` only ever selects `queued`. Nothing anywhere moved it back.
 *
 * So the change was not delayed, it was **abandoned**: Helio held one price and
 * the OTA went on selling another, for ever, with no error on any screen because
 * the failure had already been reported and filed days earlier. The next time
 * anybody happened to edit that same date it would correct itself, which is what
 * makes it look intermittent rather than broken.
 *
 * Parked rows now come back with a widening delay — 15 minutes, then 30, then an
 * hour, capped at six. A channel that is down for a morning catches up by itself
 * when it returns, and one that is genuinely misconfigured is not hammered while
 * it stays that way. There is deliberately no give-up point: an unsent price is
 * wrong until it is sent, however long that takes. `notify` fires once, when the
 * row first parks, so the operator hears about it exactly one time.
 */
function reviveParkedPushes(propertyId: string): number {
  const rows = all<{ id: string; attempts: number; last_attempt_at: string | null }>(
    `SELECT id, attempts, last_attempt_at FROM channel_queue
      WHERE property_id = ? AND status = 'failed'`,
    propertyId,
  );
  if (!rows.length) return 0;

  const now = Date.now();
  let revived = 0;
  for (const r of rows) {
    // Each parked round doubles the wait: attempts 5 → 15m, 6 → 30m, 7 → 60m…
    const rounds = Math.max(0, (r.attempts ?? 0) - FAST_ATTEMPTS);
    const waitMinutes = Math.min(RETRY_BASE_MINUTES * 2 ** rounds, RETRY_MAX_MINUTES);
    // A row parked before this column existed has no stamp; retry it now rather
    // than leaving it stuck for ever on account of a missing timestamp.
    const since = r.last_attempt_at ? now - Date.parse(r.last_attempt_at) : Infinity;
    if (since < waitMinutes * 60_000) continue;
    run(`UPDATE channel_queue SET status = 'queued' WHERE id = ?`, r.id);
    revived++;
  }
  return revived;
}

/**
 * Record a push failure against every row in the batch.
 *
 * Shared by both failure paths — a rejection reported in the response body and
 * an exception thrown on the way — because they were drifting apart and only one
 * of them stamped the retry clock.
 */
function recordPushFailure(propertyId: string, ids: string[], detail: string) {
  for (const qid of ids) {
    run(
      `UPDATE channel_queue SET attempts = attempts + 1, last_error = ?, last_attempt_at = ?,
              status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'queued' END
        WHERE id = ?`,
      detail, nowIso(), FAST_ATTEMPTS, qid,
    );
  }
  // Announce the parking once, on the row that crosses the line. Retries after
  // this are quiet by design — the operator has already been told.
  const justParked = scalar<number>(
    `SELECT count(*) AS n FROM channel_queue
      WHERE property_id = ? AND status = 'failed' AND attempts = ?`,
    propertyId, FAST_ATTEMPTS,
  );
  if (justParked > 0) {
    notify(propertyId, {
      source: 'Channels',
      severity: 'critical',
      title: 'A rate or availability change has not reached the channel',
      message: `${justParked} queued change(s) failed ${FAST_ATTEMPTS} times and are waiting to retry. `
        + `Until one lands, the OTAs are selling on older values. Last error: ${detail.slice(0, 160)}`,
      link: '#/channel-manager',
    });
  }
}

/**
 * Drain the push queue. Each queued range is collapsed per channel so a busy
 * day of bookings produces a handful of calls, not hundreds.
 */
export async function processQueue(propertyId: string, actor: Actor, maxBatches = 10) {
  // Read-only installations queue but never send. The rows are deliberately
  // left `queued` rather than discarded: when pushing is switched back on, the
  // property's real state goes out on the next drain instead of the channels
  // sitting on whatever they last heard.
  if (readOnlyChannels()) return { sent: 0, failed: 0, remaining: scalar<number>(
    `SELECT count(*) AS n FROM channel_queue WHERE property_id = ? AND status = 'queued'`,
    propertyId) };

  // Bring back anything parked whose cooldown has elapsed, before deciding
  // there is nothing to do.
  const revived = reviveParkedPushes(propertyId);

  const queued = all<any>(
    `SELECT * FROM channel_queue WHERE property_id = ? AND status = 'queued' ORDER BY created_at LIMIT 500`,
    propertyId,
  );
  if (!queued.length) {
    return {
      processed: 0, batches: 0, results: [] as any[], stillQueued: 0,
      parked: scalar<number>(
        `SELECT count(*) AS n FROM channel_queue WHERE property_id = ? AND status = 'failed'`,
        propertyId),
      revived, notes: [] as string[],
    };
  }

  // Collapse to one date window per (channel, room type).
  const groups = new Map<string, { channelId: string; roomTypeId: string | null; from: string; to: string; ids: string[] }>();
  for (const q of queued) {
    const key = `${q.channel_id}|${q.room_type_id ?? ''}`;
    const g = groups.get(key);
    if (g) {
      if (q.date_from < g.from) g.from = q.date_from;
      if (q.date_to > g.to) g.to = q.date_to;
      g.ids.push(q.id);
    } else {
      groups.set(key, {
        channelId: q.channel_id, roomTypeId: q.room_type_id,
        from: q.date_from, to: q.date_to, ids: [q.id],
      });
    }
  }

  const results: any[] = [];
  const log: string[] = [];
  let batches = 0;
  for (const g of groups.values()) {
    if (batches >= maxBatches) {
      // Never let a cap look like completion.
      log.push(`Stopped at the ${maxBatches}-batch limit with ${groups.size - batches} group(s) still queued`);
      break;
    }
    batches++;
    try {
      const r = await pushToChannel(propertyId, actor, g.channelId, {
        roomTypeId: g.roomTypeId ?? undefined, from: g.from, to: g.to,
      });
      // Only a push the channel actually accepted clears the queue. A rejected
      // one previously landed here as 'sent' — the rows were dropped, nothing
      // retried, and the dates stayed stale on the OTA for good.
      if (r.ok) {
        for (const qid of g.ids) {
          run(`UPDATE channel_queue SET status = 'sent', sent_at = ? WHERE id = ?`, nowIso(), qid);
        }
      } else {
        const detail = JSON.stringify(r.errors ?? []).slice(0, 400);
        recordPushFailure(propertyId, g.ids, detail);
        log.push(`${g.ids.length} queued change(s) rejected by the channel: ${detail}`);
      }
      results.push({ channelId: g.channelId, ...r });

      // Respect the five-minute credit budget rather than getting throttled:
      // the allowance Beds24 returned on this very push is the live figure.
      const remaining = r.rateLimit?.fiveMinRemaining ?? null;
      if (remaining !== null && remaining < 10) {
        log.push(`Paused after ${batches} batch(es): ${remaining} Beds24 credits left in this window`);
        break;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      recordPushFailure(propertyId, g.ids, message);
      results.push({ channelId: g.channelId, ok: false, error: message });
    }
  }
  const stillQueued = scalar<number>(
    `SELECT count(*) AS n FROM channel_queue WHERE property_id = ? AND status = 'queued'`, propertyId);
  const parked = scalar<number>(
    `SELECT count(*) AS n FROM channel_queue WHERE property_id = ? AND status = 'failed'`, propertyId);
  if (revived) log.unshift(`${revived} previously failed change(s) retried`);
  return { processed: queued.length, batches, results, stillQueued, parked, revived, notes: log };
}

export function queueStatus(propertyId: string) {
  return all<any>(
    `SELECT q.*, c.name AS channel_name, rt.name AS room_type_name
       FROM channel_queue q
       LEFT JOIN channels c ON c.id = q.channel_id
       LEFT JOIN room_types rt ON rt.id = q.room_type_id
      WHERE q.property_id = ? AND q.status IN ('queued','failed')
      ORDER BY q.created_at DESC LIMIT 200`,
    propertyId,
  ).map((q) => ({
    id: q.id, channel: q.channel_name, roomType: q.room_type_name, scope: q.scope,
    from: q.date_from, to: q.date_to, reason: q.reason, status: q.status,
    attempts: q.attempts, lastError: q.last_error, createdAt: q.created_at,
  }));
}

// ─── Booking import ──────────────────────────────────────────
export async function importBookings(
  propertyId: string, actor: Actor, channelId: string, opts: { since?: string } = {},
) {
  const channel = getChannel(propertyId, channelId);
  const client = clientFor(propertyId, channel);
  // Where to read from.
  //
  // The watermark must come from successful *booking imports* and nothing else.
  // It used to be the newest successful pull of any kind, which includes
  // connection tests, unit discovery and message polls — so testing the
  // connection at 14:00 moved the mark to 14:00, and the next import asked for
  // bookings changed since then. Anything modified between the last real import
  // and that test was never asked for again: a silent, permanent gap, and the
  // bookings it swallows are the ones nobody knows to look for.
  const since = opts.since
    ?? get<{ v: string }>(
      `SELECT MAX(ts) AS v FROM channel_sync_log
        WHERE channel_id = ? AND direction = 'pull' AND status = 'success'
          AND action LIKE 'import bookings%'`,
      channelId,
    )?.v
    ?? addDays(new Date().toISOString().slice(0, 10), -7);

  const started = Date.now();
  let payload: any;
  try {
    payload = await client.getBookings({
      modifiedFrom: since.slice(0, 10),
      propertyId: channel.external_property_id ?? undefined,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof ChannelNotConfigured ? 'not-configured' : 'error';
    run('UPDATE channels SET status = ?, last_error = ? WHERE id = ?', status, message, channelId);
    logSync(propertyId, channel, {
      direction: 'pull', action: 'import bookings', status: 'failed',
      durationMs: Date.now() - started, error: message,
    });
    throw new HttpError(e instanceof ChannelApiError ? 502 : 409, message, status);
  }

  const bookings = ((payload.data as any)?.data ?? []).map(normaliseBooking);
  const mappings = listMappings(propertyId, channelId).filter((m) => m.active);
  const byExternalRoom = new Map(mappings.map((m) => [m.externalRoomId, m]));

  let created = 0;
  let updated = 0;
  let conflicts = 0;

  for (const b of bookings) {
    const existing = get<any>(
      'SELECT * FROM reservations WHERE property_id = ? AND ota_reference = ?',
      propertyId, b.externalId,
    );

    if (existing) {
      if (b.status === 'Cancelled' && existing.status !== 'Cancelled') {
        run(`UPDATE reservations SET status = 'Cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
              WHERE id = ?`,
          nowIso(), `Cancelled at ${b.channel}`, nowIso(), existing.id);
        run('DELETE FROM reservation_nights WHERE reservation_id = ? AND posted = 0', existing.id);
        updated++;
      }
      continue;
    }
    if (b.status === 'Cancelled') continue;

    const mapping = byExternalRoom.get(b.externalRoomId);
    if (!mapping || !mapping.roomTypeId) {
      run(
        `INSERT INTO channel_conflicts(id, property_id, channel_code, received_at, ota_reference,
                                       guest_name, raw_payload, room_type_raw, rate_plan_raw, reason, status)
         VALUES(?,?,?,?,?,?,?,?,?,'unmapped-room-type','open')`,
        id('cfl'), propertyId, channel.code, nowIso(), b.externalId, b.guestName,
        jsonCol(b.raw), b.externalRoomId, b.externalRateId,
      );
      conflicts++;
      continue;
    }

    const ratePlanId = mapping.ratePlanId
      ?? get<{ id: string }>(
        `SELECT id FROM rate_plans WHERE property_id = ? AND active = 1 ORDER BY sort_order LIMIT 1`,
        propertyId)?.id;
    if (!ratePlanId) {
      run(
        `INSERT INTO channel_conflicts(id, property_id, channel_code, received_at, ota_reference,
                                       guest_name, raw_payload, room_type_raw, rate_plan_raw, reason, status)
         VALUES(?,?,?,?,?,?,?,?,?,'unmapped-rate-plan','open')`,
        id('cfl'), propertyId, channel.code, nowIso(), b.externalId, b.guestName,
        jsonCol(b.raw), b.externalRoomId, b.externalRateId,
      );
      conflicts++;
      continue;
    }

    try {
      createReservation(propertyId, actor, {
        guestName: b.guestName,
        email: b.email || undefined,
        phone: b.phone || undefined,
        arrival: b.arrival,
        departure: b.departure,
        adults: b.adults,
        children: b.children,
        roomTypeId: mapping.roomTypeId,
        ratePlanId,
        status: 'Confirmed',
        source: 'OTA',
        channelCode: channel.code,
        // Beds24 is a hub: the connection is BEDS24, but this booking came from
        // one specific OTA and that is the one worth reporting on.
        otaChannel: b.channel || null,
        otaReference: b.externalId,
        segment: 'Leisure',
        specialRequests: b.notes || undefined,
        commissionMinor: Math.round(b.commissionMajor * 100),
        origin: 'channel',
        // An OTA booking already sold the room — inventory must not block it.
        force: true,
      });
      created++;
    } catch (e) {
      run(
        `INSERT INTO channel_conflicts(id, property_id, channel_code, received_at, ota_reference,
                                       guest_name, raw_payload, room_type_raw, rate_plan_raw, reason, status)
         VALUES(?,?,?,?,?,?,?,?,?,?,'open')`,
        id('cfl'), propertyId, channel.code, nowIso(), b.externalId, b.guestName,
        jsonCol(b.raw), b.externalRoomId, b.externalRateId,
        `import-failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
      );
      conflicts++;
    }
  }

  run(`UPDATE channels SET status = 'connected', last_sync_at = ?, last_error = NULL WHERE id = ?`,
    nowIso(), channelId);

  // A short read must not move the watermark.
  //
  // `since` above is the newest *successful* booking import, so recording a
  // truncated page walk as a success would advance the mark past pages that
  // were never fetched — the same silent, permanent gap that comment warns
  // about, arriving through a different door. Logged as skipped, the mark stays
  // put and the next poll asks from the same place. The rows already written
  // are kept, so the retry recognises most of what it re-reads and converges
  // rather than starting over.
  const truncated = payload.truncated === true;
  logSync(propertyId, channel, {
    direction: 'pull',
    action: `import bookings · ${created} new, ${updated} updated, ${conflicts} conflict(s)`
      + (truncated ? ' · PARTIAL: more pages on the channel, watermark held' : ''),
    status: truncated ? 'skipped' : 'success',
    bytes: payload.bytes,
    durationMs: payload.durationMs,
  });
  return { fetched: bookings.length, created, updated, conflicts, truncated };
}

export function listConflicts(propertyId: string, status = 'open') {
  return all<any>(
    `SELECT * FROM channel_conflicts WHERE property_id = ? AND status = ? ORDER BY received_at DESC`,
    propertyId, status,
  ).map((c) => ({
    id: c.id, channel: c.channel_code, receivedAt: c.received_at, otaReference: c.ota_reference,
    guest: c.guest_name, roomTypeRaw: c.room_type_raw, ratePlanRaw: c.rate_plan_raw,
    reason: c.reason, status: c.status, raw: parseJson<any>(c.raw_payload, null),
  }));
}

/** Resolve a conflict by mapping the unit and re-importing that one booking. */
export function resolveConflict(
  propertyId: string, actor: Actor, conflictId: string,
  input: { roomTypeId: string; ratePlanId: string; createMapping?: boolean },
) {
  return tx(() => {
    const c = get<any>('SELECT * FROM channel_conflicts WHERE id = ? AND property_id = ?',
      conflictId, propertyId);
    if (!c) notFound('Conflict');
    const channel = get<ChannelRow>('SELECT * FROM channels WHERE property_id = ? AND code = ?',
      propertyId, c.channel_code);

    if (input.createMapping && channel && c.room_type_raw) {
      upsertMapping(propertyId, actor, {
        channelId: channel.id, roomTypeId: input.roomTypeId, ratePlanId: input.ratePlanId,
        externalRoomId: c.room_type_raw, externalRateId: c.rate_plan_raw,
      });
    }

    const raw = parseJson<any>(c.raw_payload, null);
    if (raw) {
      const b = normaliseBooking(raw);
      const exists = get<any>('SELECT id FROM reservations WHERE property_id = ? AND ota_reference = ?',
        propertyId, b.externalId);
      if (!exists) {
        createReservation(propertyId, actor, {
          guestName: b.guestName, email: b.email || undefined, phone: b.phone || undefined,
          arrival: b.arrival, departure: b.departure, adults: b.adults, children: b.children,
          roomTypeId: input.roomTypeId, ratePlanId: input.ratePlanId,
          status: 'Confirmed', source: 'OTA', channelCode: c.channel_code,
          otaReference: b.externalId, commissionMinor: Math.round(b.commissionMajor * 100),
          origin: 'channel', force: true,
        });
      }
    }

    run(`UPDATE channel_conflicts SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?`,
      nowIso(), actor.userName, conflictId);
    audit(actor, {
      action: 'channel.conflict-resolve', entity: 'CHANNEL', entityId: conflictId,
      entityRef: c.ota_reference, channel: c.channel_code, after: input,
    });
    return { ok: true };
  });
}

// ─── Drift detection ─────────────────────────────────────────
/** Compare what Beds24 currently holds against the PMS source of truth. */
export async function detectDrift(
  propertyId: string, actor: Actor, channelId: string, opts: { from: string; to: string },
) {
  const channel = getChannel(propertyId, channelId);
  const client = clientFor(propertyId, channel);
  const mappings = listMappings(propertyId, channelId).filter((m) => m.active && m.externalRoomId);
  const drift: any[] = [];

  for (const m of mappings) {
    if (!m.roomTypeId) continue;
    const res = await client.getCalendar(m.externalRoomId!, opts.from, opts.to);
    const remote = ((res.data as any)?.data ?? []) as any[];
    const remoteByDate = new Map<string, any>();
    for (const entry of remote) {
      for (const day of entry.calendar ?? []) {
        for (const d of dateRange(day.from, addDays(day.to, 1))) remoteByDate.set(d, day);
      }
    }
    const local = buildAri(propertyId, {
      roomTypeId: m.roomTypeId, ratePlanId: m.ratePlanId ?? undefined,
      from: opts.from, to: opts.to, channelCode: channel.code, allotment: channel.allotment,
    });
    for (const cell of local) {
      const r = remoteByDate.get(cell.date);
      if (!r) continue;
      const remotePriceMinor = Math.round(Number(r.price1 ?? 0) * 100);
      if (remotePriceMinor && remotePriceMinor !== cell.priceMinor) {
        drift.push({
          date: cell.date, roomType: m.roomType, channel: channel.code, field: 'rate',
          pmsValue: cell.priceMinor, channelValue: remotePriceMinor,
          severity: Math.abs(remotePriceMinor - cell.priceMinor) > cell.priceMinor * 0.05 ? 'high' : 'low',
        });
      }
      const remoteAvail = Number(r.numAvail ?? -1);
      if (remoteAvail >= 0 && remoteAvail !== cell.available) {
        drift.push({
          date: cell.date, roomType: m.roomType, channel: channel.code, field: 'inventory',
          pmsValue: cell.available, channelValue: remoteAvail,
          severity: Math.abs(remoteAvail - cell.available) > 2 ? 'high' : 'med',
        });
      }
    }
  }

  logSync(propertyId, channel, {
    direction: 'pull', action: `drift check ${opts.from} → ${opts.to} · ${drift.length} difference(s)`,
    status: 'success',
  });
  return { channel: channel.code, checked: mappings.length, drift };
}

export function channelHealth(propertyId: string) {
  const channels = listChannels(propertyId);
  // Whether this installation is allowed to publish at all. Read once for the
  // whole report so every channel row agrees.
  const publishing = !readOnlyChannels();

  return channels.map((c) => {
    const recent = all<any>(
      `SELECT status, ts FROM channel_sync_log WHERE channel_id = ? ORDER BY ts DESC LIMIT 20`, c.id);
    const failures = recent.filter((r) => r.status === 'failed').length;

    // The oldest thing waiting. A backlog of three minutes is a busy drain; a
    // backlog of three hours is a channel that has stopped listening, and the
    // count alone cannot tell those apart.
    const oldestQueuedAt = get<{ ts: string }>(
      `SELECT MIN(created_at) AS ts FROM channel_queue
       WHERE property_id = ? AND channel_id = ? AND status = 'queued'`,
      propertyId, c.id,
    )?.ts ?? null;

    let health: 'healthy' | 'degraded' | 'down' | 'not-configured' = 'healthy';
    if (!c.configured) health = 'not-configured';
    else if (c.status === 'error') health = 'down';
    else if (failures >= 3) health = 'degraded';
    // Read-only with work waiting is not healthy, whatever the sync log says.
    //
    // This is the case that went unnoticed: HELIO_CHANNEL_READONLY was left on,
    // three dorm rate changes queued behind it, and every indicator in the app
    // still read "connected · healthy" because nothing had *failed*. Nothing
    // had been attempted either. A green tick over work that will never be sent
    // is worse than a red one — it is the reason the prices on the OTA were
    // wrong for hours without anybody having a reason to look.
    else if (!publishing && c.queued > 0) health = 'degraded';

    return {
      channelId: c.id, code: c.code, name: c.name, health, status: c.status,
      lastSyncAt: c.lastSyncAt, lastError: c.lastError, recentFailures: failures,
      queued: c.queued, mappings: c.mappings,
      /** False when HELIO_CHANNEL_READONLY is set: queued work will not be sent. */
      publishing,
      oldestQueuedAt,
    };
  });
}
