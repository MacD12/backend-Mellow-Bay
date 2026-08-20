// Authentication, sessions and role-based access control.
//
// Passwords: scrypt (node:crypto) with a per-user random salt.
// Sessions:  opaque random token; only its SHA-256 hash is stored, so a
//            database leak cannot be replayed as a login.
import { scryptSync, timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { all, get, run } from './db.ts';
import { HttpError, id, nowIso, token, addDays } from './lib/util.ts';

const SCRYPT_KEYLEN = 64;
const SESSION_HOURS = 12;
/** "Keep me signed in" — a shift-long session becomes a fortnight. */
const REMEMBERED_HOURS = 24 * 14;
/** How long a half-finished sign-in may sit waiting for its 2FA code. */
const MFA_CHALLENGE_MINUTES = 10;

export const ROLES = [
  'admin', 'manager', 'front_office', 'reservations',
  'housekeeping', 'accounts', 'revenue', 'readonly',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'System Administrator',
  manager: 'General Manager',
  front_office: 'Front Office',
  reservations: 'Reservations',
  housekeeping: 'Housekeeping',
  accounts: 'Accounts / Finance',
  revenue: 'Revenue Manager',
  readonly: 'Read only',
};

// Permission grants per role. '*' = everything, 'x.*' = whole module.
const GRANTS: Record<Role, string[]> = {
  admin: ['*'],
  manager: [
    'dashboard.*', 'reservations.*', 'frontdesk.*', 'folio.*', 'housekeeping.*',
    'profiles.*', 'reports.*', 'rates.*', 'channels.*', 'nightaudit.*',
    'config.*', 'groups.*', 'ar.*', 'admin.users',
  ],
  front_office: [
    'dashboard.read', 'reservations.read', 'reservations.write', 'frontdesk.*',
    'folio.read', 'folio.post', 'folio.payment', 'profiles.read', 'profiles.write',
    'housekeeping.read', 'housekeeping.write', 'reports.read', 'groups.read',
    'rates.read', 'channels.read', 'config.read',
  ],
  reservations: [
    'dashboard.read', 'reservations.*', 'profiles.read', 'profiles.write',
    'groups.*', 'rates.read', 'reports.read', 'channels.read', 'folio.read',
    'frontdesk.read', 'config.read', 'housekeeping.read',
  ],
  housekeeping: [
    'dashboard.read', 'housekeeping.*', 'frontdesk.read', 'reservations.read',
    'config.read',
  ],
  accounts: [
    'dashboard.read', 'folio.*', 'ar.*', 'reports.*', 'nightaudit.*',
    'reservations.read', 'frontdesk.read', 'profiles.read', 'config.read',
    'housekeeping.read', 'rates.read', 'channels.read',
  ],
  revenue: [
    'dashboard.read', 'rates.*', 'channels.*', 'reports.*', 'reservations.read',
    'groups.read', 'profiles.read', 'config.read', 'frontdesk.read', 'folio.read',
    'housekeeping.read',
  ],
  readonly: [
    'dashboard.read', 'reservations.read', 'frontdesk.read', 'folio.read',
    'housekeeping.read', 'profiles.read', 'reports.read', 'rates.read',
    'channels.read', 'groups.read', 'ar.read', 'config.read', 'nightaudit.read',
  ],
};

/**
 * What a role may do. An unrecognised role gets **nothing**.
 *
 * This used to fall back to the `readonly` grants, which is fail-open: a typo in
 * a role column, or a role removed in a later version, silently handed out read
 * access to reservations, folios, reports and channel settings rather than
 * denying. A role the system does not recognise is not a role.
 */
export function permissionsFor(role: string): string[] {
  return GRANTS[role as Role] ?? [];
}

export function can(role: string, perm: string): boolean {
  const grants = permissionsFor(role);
  if (grants.includes('*')) return true;
  if (grants.includes(perm)) return true;
  const mod = perm.split('.')[0];
  return grants.includes(`${mod}.*`);
}

// ─── Passwords ───────────────────────────────────────────────
export function hashPassword(plain: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifyPassword(plain: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(plain, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function assertPasswordStrength(plain: string) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters', 'weak_password');
  }
  if (!/[a-zA-Z]/.test(plain) || !/[0-9]/.test(plain)) {
    throw new HttpError(400, 'Password must contain both letters and numbers', 'weak_password');
  }
}

// ─── Sessions ────────────────────────────────────────────────
function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

export interface UserRow {
  id: string; email: string; name: string; role: string; active: number;
  password_hash: string; password_salt: string; phone: string | null;
  failed_logins: number; locked_until: string | null; must_change_pw: number;
  mfa_enabled: number; mfa_secret: string | null; mfa_enrolled_at: string | null;
}

export interface AuthContext {
  userId: string;
  userName: string;
  email: string;
  role: string;
  propertyId: string;
  sessionId: string;
  permissions: string[];
}

export function createSession(
  userId: string,
  propertyId: string | null,
  ip: string,
  ua: string,
  opts: { remember?: boolean; mfaPending?: boolean } = {},
) {
  const raw = token();
  const hours = opts.mfaPending
    ? MFA_CHALLENGE_MINUTES / 60
    : opts.remember ? REMEMBERED_HOURS : SESSION_HOURS;
  const expires = new Date(Date.now() + hours * 3600_000).toISOString();
  const sid = id('ses');
  run(
    `INSERT INTO sessions(id, user_id, token_hash, property_id, created_at, expires_at,
                          last_seen_at, ip, user_agent, revoked, mfa_pending, remembered)
     VALUES(?,?,?,?,?,?,?,?,?,0,?,?)`,
    sid, userId, hashToken(raw), propertyId, nowIso(), expires, nowIso(), ip, ua.slice(0, 300),
    opts.mfaPending ? 1 : 0, opts.remember ? 1 : 0,
  );
  return { token: raw, sessionId: sid, expiresAt: expires };
}

/**
 * Promote a half-finished sign-in to a full session once its second factor has
 * been accepted. The token the client already holds stays valid, so the browser
 * never has to juggle two of them.
 */
export function completeMfaChallenge(sessionId: string, remember: boolean) {
  const hours = remember ? REMEMBERED_HOURS : SESSION_HOURS;
  const expires = new Date(Date.now() + hours * 3600_000).toISOString();
  run('UPDATE sessions SET mfa_pending = 0, remembered = ?, expires_at = ? WHERE id = ?',
    remember ? 1 : 0, expires, sessionId);
  return expires;
}

/** Resolve a session that is still waiting on its 2FA code. */
export function resolvePendingSession(rawToken: string) {
  const row = get<any>(
    `SELECT s.id AS sid, s.expires_at, s.revoked, s.mfa_pending,
            u.id AS uid, u.name, u.email, u.active, u.mfa_secret, u.must_change_pw
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    hashToken(rawToken),
  );
  if (!row || row.revoked === 1 || row.mfa_pending !== 1) return null;
  if (row.active !== 1 || row.expires_at <= nowIso()) return null;
  return row;
}

export function revokeOtherSessions(userId: string, keepSessionId: string) {
  run('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id <> ?', userId, keepSessionId);
}

export function revokeSession(sessionId: string) {
  run('UPDATE sessions SET revoked = 1 WHERE id = ?', sessionId);
}

export function setSessionProperty(sessionId: string, propertyId: string) {
  run('UPDATE sessions SET property_id = ? WHERE id = ?', propertyId, sessionId);
}

export function resolveSession(rawToken: string): AuthContext | null {
  const row = get<any>(
    `SELECT s.id AS sid, s.property_id, s.expires_at, s.revoked, s.mfa_pending,
            u.id AS uid, u.name, u.email, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    hashToken(rawToken),
  );
  if (!row) return null;
  if (row.revoked === 1) return null;
  if (row.active !== 1) return null;
  if (row.expires_at <= nowIso()) return null;
  // A sign-in that has not cleared its second factor is not a session yet.
  if (row.mfa_pending === 1) return null;

  run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', nowIso(), row.sid);

  // Per-property role override, when the user has one.
  const role = row.property_id
    ? roleAtProperty(row.uid, row.role as string, row.property_id)
    : (row.role as string);

  return {
    userId: row.uid,
    userName: row.name,
    email: row.email,
    role,
    propertyId: row.property_id ?? '',
    sessionId: row.sid,
    permissions: permissionsFor(role),
  };
}

export function purgeExpiredSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', addDays(nowIso().slice(0, 10), -2));
}

// ─── Login ───────────────────────────────────────────────────
const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export function authenticate(emailAddr: string, password: string): UserRow {
  const user = get<UserRow>('SELECT * FROM users WHERE email = ?', emailAddr.toLowerCase());
  const genericError = () => new HttpError(401, 'Invalid email or password', 'invalid_credentials');

  if (!user) {
    // Spend comparable effort on an unknown address so timing does not reveal
    // whether the account exists.
    scryptSync(password, 'placeholder-salt', SCRYPT_KEYLEN);
    throw genericError();
  }
  if (user.active !== 1) {
    throw new HttpError(403,
      'This account has been disabled — ask an administrator to re-enable it', 'account_disabled');
  }
  if (user.locked_until && user.locked_until > nowIso()) {
    const minutes = Math.max(1, Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60_000));
    throw new HttpError(423,
      `Too many failed attempts — this account is locked for another ${minutes} minute(s)`,
      'locked', { lockedUntil: user.locked_until, minutes });
  }
  if (!verifyPassword(password, user.password_hash, user.password_salt)) {
    const failed = user.failed_logins + 1;
    const lockUntil = failed >= MAX_FAILED
      ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
      : null;
    run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', failed, lockUntil, user.id);
    if (lockUntil) {
      throw new HttpError(423,
        `Too many failed attempts — this account is locked for ${LOCK_MINUTES} minutes`,
        'locked', { lockedUntil: lockUntil, minutes: LOCK_MINUTES });
    }
    // Warn only as the limit gets close; earlier than that it is noise, and it
    // would tell an attacker the address is real.
    const remaining = MAX_FAILED - failed;
    if (remaining <= 3) {
      throw new HttpError(401,
        `Invalid email or password — ${remaining} attempt(s) left before the account locks`,
        'invalid_credentials', { remainingAttempts: remaining });
    }
    throw genericError();
  }
  run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?',
    nowIso(), user.id);
  return user;
}

export function propertiesForUser(userId: string, role: string) {
  if (role === 'admin') {
    return all<any>('SELECT * FROM properties WHERE active = 1 ORDER BY name');
  }
  const rows = all<any>(
    `SELECT p.* FROM properties p
       JOIN user_properties up ON up.property_id = p.id
      WHERE up.user_id = ? AND p.active = 1
      ORDER BY p.name`,
    userId,
  );
  if (rows.length > 0) return rows;

  // A user with no explicit assignment sees everything — but **only while this
  // installation has one property**. That keeps the common single-property case
  // free of pointless admin, without the convenience quietly becoming a hole:
  // the moment a second property is created, an unassigned user can reach
  // neither, and somebody has to say who works where.
  const active = all<any>('SELECT * FROM properties WHERE active = 1 ORDER BY name');
  return active.length === 1 ? active : [];
}

/** Is this user entitled to operate on this property at all? */
export function userCanUseProperty(userId: string, role: string, propertyId: string): boolean {
  return propertiesForUser(userId, role).some((p) => p.id === propertyId);
}

/**
 * The role a user holds **at a particular property**.
 *
 * A user may be a manager at one property and housekeeping at another, so the
 * role cannot be read from `users.role` alone once a property is in play. This
 * is the same resolution `resolveSession` does for the session's own property,
 * extracted so the two can never disagree.
 */
export function roleAtProperty(userId: string, homeRole: string, propertyId: string): string {
  const assigned = get<{ role: string }>(
    'SELECT role FROM user_properties WHERE user_id = ? AND property_id = ?',
    userId, propertyId,
  );
  return assigned?.role ?? homeRole;
}
