// ─────────────────────────────────────────────────────────────
// Secrets at rest.
//
// A Beds24 refresh token is not a setting — it is a working key to the
// property's entire OTA distribution: rates, availability, bookings. The same
// will shortly be true of payment-provider keys. Those were stored as clear
// text inside a JSON column and returned whole by the channel list endpoint,
// which meant a read-only staff account could read them, and so could anyone
// holding a copy of the database file or one of its backups.
//
// Two rules follow, and they are separate:
//
//   1. **Never leave the server.** A secret is stripped from every API
//      response. What a screen needs is "is this configured?", never the value.
//   2. **Never readable at rest.** Encrypted with a key supplied by the
//      environment, so the database file alone is not enough.
//
// The key lives in `HELIO_SECRET_KEY`. Without it, secrets are stored as they
// always were and the system says so loudly on startup — an installation that
// silently downgraded its own encryption would be worse than one that never
// had any.
// ─────────────────────────────────────────────────────────────
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
// Imported for its side effect: loading the config validates HELIO_SECRET_KEY,
// so a key too short to be worth using is rejected at startup rather than
// silently turning encryption off here. The value itself is read below.
import '../config.ts';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc.v1.';

/** Derived once. The salt is fixed so the same passphrase yields the same key. */
let cachedKey: Buffer | null | undefined;

function key(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  // Read from the live environment rather than the frozen config, and this is
  // the one place that difference matters. A module loaded with no key must
  // report no key — `encryptionAvailable()` is what tells an operator whether
  // their credentials are actually protected, and answering from a value
  // captured at boot would make it a claim about the past. The schema has
  // already enforced the minimum length by the time anything gets here.
  const raw = process.env.HELIO_SECRET_KEY;
  if (!raw || raw.length < 16) {
    cachedKey = null;
    return null;
  }
  // scrypt rather than the raw string: a passphrase somebody typed is not a
  // 256-bit key, and pretending otherwise weakens the cipher it feeds.
  cachedKey = scryptSync(raw, 'helio.secrets.v1', 32);
  return cachedKey;
}

/** True when secrets written from now on will actually be encrypted. */
export function encryptionAvailable(): boolean {
  return key() !== null;
}

/**
 * Encrypt a value for storage.
 *
 * Returns the input unchanged when no key is configured — an installation
 * without one keeps working exactly as before, and `encryptionAvailable()` is
 * what tells the operator the difference.
 */
export function encryptSecret(plain: string): string {
  const k = key();
  if (!k || !plain) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, k, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Decrypt a stored value.
 *
 * A value written before encryption was switched on is returned as-is, so
 * turning the key on does not orphan existing credentials. A value that *is*
 * encrypted but cannot be decrypted throws rather than returning something
 * plausible — a silently wrong token would be diagnosed as a channel outage.
 */
export function decryptSecret(stored: string): string {
  if (!stored?.startsWith(PREFIX)) return stored;
  const k = key();
  if (!k) {
    throw new Error(
      'This value is encrypted but HELIO_SECRET_KEY is not set. '
      + 'Restore the key to read it — it cannot be recovered without it.');
  }
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  try {
    const decipher = createDecipheriv(ALGORITHM, k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // AES-GCM fails the same way for a wrong key and for tampered data, and
    // Node's own message — "Unsupported state or unable to authenticate data" —
    // tells an operator nothing about either. The overwhelmingly likely cause
    // is a changed HELIO_SECRET_KEY, so say that and say what to do.
    throw new Error(
      'This value cannot be decrypted with the current HELIO_SECRET_KEY. '
      + 'Either the key has changed since it was stored, or the data was altered. '
      + 'Restore the original key, or clear the credential and enter it again.');
  }
}

export function isEncrypted(stored: unknown): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

/** Keys whose values must never appear in an API response. */
const SECRET_KEYS = [
  'credentials', 'refreshtoken', 'accesstoken', 'invitecode', 'token',
  'apikey', 'api_key', 'secret', 'password', 'privatekey', 'clientsecret',
  'webhooksecret', 'signingkey',
];

function looksSecret(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, '');
  return SECRET_KEYS.some((s) => k.includes(s.replace(/[_-]/g, '')));
}

/**
 * Strip secrets from anything on its way out of the API.
 *
 * Redacts by key name recursively rather than by naming the one field that
 * leaked. The channel settings blob is open-ended — a provider added later will
 * put its key somewhere new, and an allowlist of known-bad fields would miss it.
 * Presence is reported (`"__redacted"`) rather than the key being removed, so a
 * screen can still say "a token is configured" without ever holding one.
 */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (looksSecret(k)) {
        // Say whether something is there, never what it is.
        out[k] = v === null || v === undefined || v === '' ? null : '__redacted';
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/** Constant-time compare, for anything secret-shaped we ever have to match. */
export function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
