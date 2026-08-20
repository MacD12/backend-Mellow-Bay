// ─────────────────────────────────────────────────────────────
// Connecting Beds24 from the environment.
//
// A refresh token in `BEDS24_REFRESH_TOKEN` is enough to bring a property
// online without anybody opening the channel manager. That matters for a
// deployment: the operator sets one variable and the PMS is talking to
// Booking.com on the next restart.
//
// The token exchange itself already lives in `channels/beds24.ts` — refresh
// token in, short-lived access token out, cached until a minute before it
// expires and re-persisted whenever it rotates. This module is only the
// bootstrap: find or create the channel row, store the credential, and prove it
// works before claiming anything.
//
// Two rules, both learned the hard way in this codebase:
//
//   · **Never claim connected without a successful call.** A channel that says
//     "connected" because a token was *stored* is the green tick for something
//     that did not happen.
//   · **The token is a credential, not a setting.** It goes through
//     `lib/secrets.ts` like any other, so it is encrypted at rest and never
//     appears in an API response.
// ─────────────────────────────────────────────────────────────
import { config } from '../config.ts';
import { all, get, run } from '../db.ts';
import { HUB } from '../channels/beds24.ts';
import { upsertChannel, connectBeds24, getChannel } from './channels.ts';
import { notify } from './notify.ts';
import type { AuthContext } from '../auth.ts';

type Actor = Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>;

/**
 * The name this connection carries on screen.
 *
 * The `code` stays `BEDS24` — it is a stable internal key that mappings, the
 * queue and the sync log all join on, and renaming it would orphan them. Only
 * the label a person reads changes, so the supplier is not announced on every
 * property's Channel Manager. Set `HELIO_CHANNEL_NAME` to override.
 */
const CHANNEL_NAME = config.channelName;

const SYSTEM: Omit<Actor, 'propertyId'> = {
  userId: 'system',
  userName: 'Beds24 bootstrap',
};

export interface BootstrapResult {
  attempted: boolean;
  connected: boolean;
  channelId?: string;
  propertyId?: string;
  message: string;
}

/**
 * Connect Beds24 from the environment, if a token is present and the channel is
 * not already working.
 *
 * Deliberately idempotent: it runs on every startup, and on the second and
 * hundredth boot it finds the channel already connected and does nothing. A
 * bootstrap that re-authenticates on every restart burns API credits and
 * rotates the refresh token for no reason.
 */
export async function bootstrapBeds24(): Promise<BootstrapResult> {
  const refreshToken = config.beds24RefreshToken;
  if (!refreshToken) {
    return { attempted: false, connected: false, message: 'No BEDS24_REFRESH_TOKEN set' };
  }

  // One property is the normal case for an environment-driven connection. With
  // several, which one the token belongs to is not ours to guess.
  const properties = all<{ id: string; name: string }>(
    'SELECT id, name FROM properties WHERE active = 1 ORDER BY created_at');
  if (properties.length === 0) {
    return {
      attempted: true, connected: false,
      message: 'BEDS24_REFRESH_TOKEN is set but no property exists yet — run the setup wizard first',
    };
  }
  if (properties.length > 1) {
    return {
      attempted: true, connected: false,
      message: `BEDS24_REFRESH_TOKEN is set but this installation has ${properties.length} properties. `
        + 'Connect Beds24 from the channel manager so the right one is chosen.',
    };
  }

  const property = properties[0];
  const actor: Actor = { ...SYSTEM, propertyId: property.id };

  // The channel is **Beds24**, not any one OTA.
  //
  // Beds24 is a channel manager: it fronts whichever OTAs the property has
  // connected on its side — Hostelworld today, Booking.com and Airbnb later —
  // and Helio talks only to Beds24. Naming this connection "Booking.com" would
  // claim a relationship that may not exist, and would be wrong the moment the
  // property adds or drops an OTA without telling Helio.
  //
  // Which OTA a given booking actually came from arrives on the booking itself,
  // in its `referer`, and is recorded there.
  const existing = get<{ id: string; status: string; code: string }>(
    `SELECT id, status, code FROM channels
      WHERE property_id = ? AND code IN ('BEDS24','BDC')
      ORDER BY CASE code WHEN 'BEDS24' THEN 0 ELSE 1 END`,
    property.id);

  if (existing?.status === 'connected') {
    // An installation connected before this was named correctly still says
    // "Booking.com" on every screen. Correct it in place — re-authorising a
    // working channel to fix a label would be a poor trade.
    //
    // The uplift is reset with it, and that matters more than the name. A demo
    // "Booking.com" row is seeded with an OTA markup (×1.18); adopting that row
    // for Beds24 keeps the markup, and Beds24 is not an OTA — it is the hub the
    // prices were *read from*. Pushing through it would send every rate back
    // 18% higher than the property set, once per sync, silently.
    if (existing.code !== 'BEDS24') {
      run(`UPDATE channels SET code = 'BEDS24', name = ?,
                  price_multiplier_bp = 10000, commission_bp = 0
            WHERE id = ?`, CHANNEL_NAME, existing.id);
    }
    return {
      attempted: true, connected: true, channelId: existing.id, propertyId: property.id,
      message: `${HUB} is already connected`,
    };
  }

  const channel = upsertChannel(property.id, actor, {
    id: existing?.id,
    code: 'BEDS24',
    name: CHANNEL_NAME,
    kind: 'ota',
    active: true,
  });

  try {
    // `connectBeds24` stores the credential and then *proves* it by calling the
    // API. It only reports connected when that call succeeds.
    const result = await connectBeds24(property.id, actor, channel.id, { refreshToken });
    const after = getChannel(property.id, channel.id);
    const connected = after.status === 'connected';

    notify(property.id, {
      source: 'Channels',
      severity: connected ? 'success' : 'critical',
      title: connected ? `${HUB} connected` : `${HUB} could not be connected`,
      message: connected
        ? 'The refresh token from the environment was accepted. Map your room types next.'
        : `The token was refused: ${after.last_error ?? 'unknown error'}`,
      link: '#/channel-manager',
    });

    return {
      attempted: true, connected, channelId: channel.id, propertyId: property.id,
      message: connected
        ? `${HUB} connected for ${property.name}`
        : `The token was refused: ${after.last_error ?? 'unknown error'}`,
      ...(result ? {} : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    notify(property.id, {
      source: 'Channels',
      severity: 'critical',
      title: `${HUB} could not be connected`,
      message,
      link: '#/channel-manager',
    });
    return {
      attempted: true, connected: false, channelId: channel.id, propertyId: property.id,
      message: `Connection failed: ${message}`,
    };
  }
}
