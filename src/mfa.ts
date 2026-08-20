// ─────────────────────────────────────────────────────────────
// Two-factor authentication (TOTP, RFC 6238) and password resets.
//
// Implemented on node:crypto so it works with any authenticator app —
// Google Authenticator, 1Password, Authy, Microsoft Authenticator — with no
// third-party service and no dependency.
//
// Nothing reusable is stored in the clear: the TOTP secret is the only shared
// value (it has to be), recovery codes and reset tokens are kept as hashes.
// ─────────────────────────────────────────────────────────────
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { all, get, run } from './db.ts';
import { id, nowIso, HttpError } from './lib/util.ts';

const DIGITS = 6;
const PERIOD = 30;              // seconds per code
const DRIFT_WINDOWS = 1;        // accept the code either side, for clock skew
const RECOVERY_CODE_COUNT = 10;

// ─── Base32 (RFC 4648, no padding) ───────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = B32.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ─── TOTP ────────────────────────────────────────────────────
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totpCode(secretBase32: string, at = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(at / 1000 / PERIOD));
}

/** Constant-time comparison so a wrong code leaks nothing by timing. */
function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function verifyTotp(secretBase32: string, code: string, at = Date.now()): boolean {
  const cleaned = String(code ?? '').replace(/\D/g, '');
  if (cleaned.length !== DIGITS) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(at / 1000 / PERIOD);
  for (let drift = -DRIFT_WINDOWS; drift <= DRIFT_WINDOWS; drift++) {
    if (sameCode(hotp(secret, counter + drift), cleaned)) return true;
  }
  return false;
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The URI an authenticator app scans or accepts by hand. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Secret split into readable blocks, for typing in by hand. */
export function formatSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

// ─── Recovery codes ──────────────────────────────────────────
function hashCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
}

function readableCode(): string {
  // Ten characters, no vowels, so a code can never spell anything and cannot
  // be confused between O/0 or I/1.
  const alphabet = '23456789BCDFGHJKLMNPQRSTVWXZ';
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 4) out += '-';
  }
  return out;
}

export function issueRecoveryCodes(userId: string): string[] {
  run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = readableCode();
    codes.push(code);
    run(
      'INSERT INTO mfa_recovery_codes(id, user_id, code_hash, created_at) VALUES(?,?,?,?)',
      id('rec'), userId, hashCode(code), nowIso(),
    );
  }
  return codes;
}

/** Spend a recovery code. Each one works once. */
export function consumeRecoveryCode(userId: string, code: string): boolean {
  const row = get<{ id: string }>(
    'SELECT id FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    userId, hashCode(code),
  );
  if (!row) return false;
  run('UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ?', nowIso(), row.id);
  return true;
}

export function recoveryCodesRemaining(userId: string): number {
  const row = get<{ n: number }>(
    'SELECT count(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL', userId);
  return row?.n ?? 0;
}

// ─── Enrolment ───────────────────────────────────────────────
export function beginEnrolment(userId: string, account: string, issuer: string) {
  const secret = generateSecret();
  // Held against the user but not switched on until a code proves it works.
  run('UPDATE users SET mfa_secret = ?, mfa_enabled = 0 WHERE id = ?', secret, userId);
  return {
    secret,
    manualKey: formatSecret(secret),
    otpauthUri: otpauthUri(secret, account, issuer),
    digits: DIGITS,
    period: PERIOD,
  };
}

export function completeEnrolment(userId: string, code: string): string[] {
  const user = get<{ mfa_secret: string | null }>('SELECT mfa_secret FROM users WHERE id = ?', userId);
  if (!user?.mfa_secret) {
    throw new HttpError(409, 'Start the two-factor setup before confirming a code', 'mfa_not_started');
  }
  if (!verifyTotp(user.mfa_secret, code)) {
    throw new HttpError(400, 'That code is not right — check the clock on your phone and try again', 'mfa_invalid');
  }
  run('UPDATE users SET mfa_enabled = 1, mfa_enrolled_at = ? WHERE id = ?', nowIso(), userId);
  return issueRecoveryCodes(userId);
}

export function disableMfa(userId: string) {
  run('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_enrolled_at = NULL WHERE id = ?', userId);
  run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
}

// ─── Password resets ─────────────────────────────────────────
const RESET_TTL_MINUTES = 60;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createPasswordReset(userId: string, ip: string, issuedBy?: string) {
  // Only the newest request stays live.
  run(`UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL`, nowIso(), userId);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + RESET_TTL_MINUTES * 60_000).toISOString();
  run(
    `INSERT INTO password_resets(id, user_id, token_hash, requested_at, expires_at, requested_ip, issued_by)
     VALUES(?,?,?,?,?,?,?)`,
    id('pwr'), userId, hashToken(token), nowIso(), expires, ip, issuedBy ?? null,
  );
  return { token, expiresAt: expires };
}

export function resolvePasswordReset(token: string): { userId: string; resetId: string } {
  const row = get<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
    'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?',
    hashToken(token),
  );
  if (!row || row.used_at) {
    throw new HttpError(400, 'This reset link has already been used or is not valid', 'reset_invalid');
  }
  if (row.expires_at <= nowIso()) {
    throw new HttpError(400, 'This reset link has expired — request a new one', 'reset_expired');
  }
  return { userId: row.user_id, resetId: row.id };
}

export function consumePasswordReset(resetId: string) {
  run('UPDATE password_resets SET used_at = ? WHERE id = ?', nowIso(), resetId);
}

export function pendingResets() {
  return all<any>(
    `SELECT p.id, p.requested_at, p.expires_at, p.requested_ip, p.issued_by,
            u.name, u.email
       FROM password_resets p JOIN users u ON u.id = p.user_id
      WHERE p.used_at IS NULL AND p.expires_at > ?
      ORDER BY p.requested_at DESC`,
    nowIso(),
  ).map((r) => ({
    id: r.id, user: r.name, email: r.email, requestedAt: r.requested_at,
    expiresAt: r.expires_at, ip: r.requested_ip, issuedBy: r.issued_by,
  }));
}

// ─── Sign-in log ─────────────────────────────────────────────
export type LoginOutcome =
  | 'success' | 'bad-password' | 'unknown-user' | 'locked' | 'disabled' | 'mfa-failed' | 'mfa-recovery';

export function recordLoginAttempt(
  email: string, outcome: LoginOutcome, ip: string, userAgent: string, userId?: string,
) {
  // Attach failures to the account they targeted, so the owner can see someone
  // trying to get in. An address with no account simply has no id to attach.
  const resolved = userId
    ?? get<{ id: string }>('SELECT id FROM users WHERE email = ?', email.toLowerCase())?.id
    ?? null;
  run(
    `INSERT INTO login_attempts(id, email, user_id, ts, outcome, ip, user_agent)
     VALUES(?,?,?,?,?,?,?)`,
    id('lga'), email.toLowerCase(), resolved, nowIso(), outcome, ip, userAgent.slice(0, 300),
  );
}

export function loginHistory(userId?: string, limit = 50) {
  const rows = userId
    ? all<any>('SELECT * FROM login_attempts WHERE user_id = ? ORDER BY ts DESC LIMIT ?', userId, limit)
    : all<any>('SELECT * FROM login_attempts ORDER BY ts DESC LIMIT ?', limit);
  return rows.map((r) => ({
    id: r.id, email: r.email, ts: r.ts, outcome: r.outcome, ip: r.ip, userAgent: r.user_agent,
  }));
}
