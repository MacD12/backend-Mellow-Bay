// ─────────────────────────────────────────────────────────────
// Beds24 calling us.
//
// Polling closes the gap; a webhook closes the delay. Beds24 will POST to a URL
// of the property's choosing whenever a booking is made, changed or cancelled,
// which turns "within a minute" into "within a second" — and, more usefully,
// means the front desk sees a booking at the same moment the OTA does.
//
// Two things make this endpoint different from every other route here:
//
//   · **It has no session.** Beds24 does not sign in. So it is authenticated by
//     a shared secret instead — Beds24's `customHeader`, set when the webhook
//     is registered and checked on every call. An unauthenticated endpoint that
//     creates reservations is not an endpoint, it is a way in.
//   · **It must never be trusted for content.** The payload names a booking; it
//     is not taken as the booking. Helio re-reads that booking from the API and
//     imports what Beds24 actually holds, so a forged or stale body cannot
//     write anything the account does not already say.
//
// It always answers 200 once the secret checks out. A webhook that returns an
// error gets retried, and then disabled — losing real-time entirely because one
// booking could not be parsed is a bad trade. Failures are recorded and the
// poll picks them up.
// ─────────────────────────────────────────────────────────────
import { router, type Ctx } from '../lib/http.ts';
import { all, get } from '../db.ts';
import { secretsMatch } from '../lib/secrets.ts';
import { importBookings } from '../services/channels.ts';
// Imported for its side effect: loading the config validates
// HELIO_WEBHOOK_SECRET, so a secret too short to verify anything is rejected at
// startup. The value itself is read live in `webhookSecret()` below.
import '../config.ts';

/**
 * The secret Beds24 must present.
 *
 * Held in the environment rather than the database: it is a credential, it is
 * needed before any property lookup can happen, and putting it in `.env` keeps
 * it out of the API surface entirely.
 */
function webhookSecret(): string | null {
  // Read live rather than from the frozen config, for the same reason as the
  // encryption key in lib/secrets.ts: whether signatures are being verified is
  // a fact about now, not about boot time. The config schema still enforces the
  // sixteen-character floor on the way up, so a value too short to be worth
  // checking is reported at startup instead of quietly disabling verification.
  const s = process.env.HELIO_WEBHOOK_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}

/**
 * Beds24 sends its `customHeader` verbatim, and different Beds24 versions have
 * put it in different places, so every plausible carrier is checked. The
 * comparison is constant-time — a timing oracle on a shared secret is a slow
 * way to leak it.
 */
function presentedSecret(ctx: Ctx): string {
  const h = ctx.req.headers;
  const candidates = [
    h['x-helio-secret'], h['x-beds24-secret'], h['x-webhook-secret'], h.authorization,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c.replace(/^Bearer\s+/i, '').trim();
  }
  return '';
}

router.post('/api/webhooks/beds24', async (ctx: Ctx) => {
  const secret = webhookSecret();
  if (!secret) {
    // Refusing is the safe default. Accepting anonymous calls because nobody
    // configured a secret would mean the endpoint's protection depends on
    // somebody having remembered.
    ctx.res.writeHead(503, { 'content-type': 'application/json' });
    ctx.res.end(JSON.stringify({
      ok: false,
      error: 'This installation has no HELIO_WEBHOOK_SECRET, so webhooks are refused.',
    }));
    return;
  }

  if (!secretsMatch(presentedSecret(ctx), secret)) {
    ctx.res.writeHead(401, { 'content-type': 'application/json' });
    ctx.res.end(JSON.stringify({ ok: false, error: 'Bad or missing secret' }));
    return;
  }

  // Which property. Beds24 sends its own property id; when it does not, and
  // this installation has exactly one connected channel, there is nothing to
  // guess.
  const externalId = String(
    ctx.body?.propertyId ?? ctx.body?.property?.id ?? ctx.body?.booking?.propertyId ?? '');

  const channels = all<{ id: string; property_id: string; external_property_id: string | null }>(
    `SELECT id, property_id, external_property_id FROM channels
      WHERE active = 1 AND status = 'connected'`);

  const channel = externalId
    ? channels.find((c) => c.external_property_id === externalId)
    : channels.length === 1 ? channels[0] : undefined;

  if (!channel) {
    // Still a 200: Beds24 disables a webhook that keeps erroring, and losing
    // real-time for every property because one call named an unknown one is a
    // bad trade. The poll will catch whatever this was.
    return {
      ok: true, imported: 0,
      note: externalId
        ? `No connected channel for property ${externalId}`
        : 'Could not tell which property this was for',
    };
  }

  const actor = {
    userId: 'system', userName: 'Beds24 webhook', propertyId: channel.property_id,
  };

  try {
    // Deliberately re-read from the API rather than trusting the body. The
    // payload is a nudge — "something changed" — and `importBookings` is
    // already idempotent on the OTA reference, so the same booking arriving
    // here and again on the next poll updates once rather than twice.
    const result: any = await importBookings(channel.property_id, actor, channel.id);
    return {
      ok: true,
      imported: result.imported ?? 0,
      updated: result.updated ?? 0,
      conflicts: result.conflicts?.length ?? 0,
    };
  } catch (e) {
    // Recorded by `importBookings` in the sync log. Answer 200 anyway, for the
    // same reason as above.
    return { ok: true, imported: 0, error: e instanceof Error ? e.message : String(e) };
  }
}, { perm: null, allowNoProperty: true });

/** Is real-time inbound actually configured? Shown on the Channel Manager. */
router.get('/api/webhooks/beds24/status', (ctx: Ctx) => {
  const configured = webhookSecret() !== null;
  const channel = get<{ external_property_id: string | null }>(
    `SELECT external_property_id FROM channels
      WHERE property_id = ? AND status = 'connected' LIMIT 1`, ctx.auth.propertyId);
  return {
    secretConfigured: configured,
    externalPropertyId: channel?.external_property_id ?? null,
    // Registering the URL with Beds24 is a separate, deliberate step — see
    // `scripts/beds24-webhook.ts`. Whether Beds24 is actually calling is only
    // knowable from Beds24, so this reports readiness, not success.
    ready: configured && !!channel?.external_property_id,
  };
}, { perm: 'channels.read' });
