// First-run setup, sign-in, session and property selection.
import { router, type Ctx } from '../lib/http.ts';
import { all, get, run, tx, needsSetup, scalar } from '../db.ts';
import {
  id, nowIso, todayIso, str, email as emailField, slugCode, int, HttpError, isDate,
} from '../lib/util.ts';
import {
  authenticate, createSession, revokeSession, setSessionProperty, hashPassword,
  assertPasswordStrength, propertiesForUser, permissionsFor, ROLES, ROLE_LABELS,
  completeMfaChallenge, resolvePendingSession, revokeOtherSessions, verifyPassword,
} from '../auth.ts';
import {
  beginEnrolment, completeEnrolment, disableMfa, verifyTotp, consumeRecoveryCode,
  recoveryCodesRemaining, issueRecoveryCodes, createPasswordReset, resolvePasswordReset,
  consumePasswordReset, pendingResets, recordLoginAttempt, loginHistory,
} from '../mfa.ts';
import { audit } from '../services/audit.ts';

function shapeProperty(p: any) {
  return {
    id: p.id, code: p.code, name: p.name, legalName: p.legal_name, kind: p.kind,
    address: p.address, city: p.city, country: p.country, timezone: p.timezone,
    currency: p.currency, locale: p.locale, businessDate: p.business_date,
    checkInTime: p.check_in_time, checkOutTime: p.check_out_time,
    phone: p.phone, email: p.email, website: p.website, taxId: p.tax_id,
    rooms: scalar<number>('SELECT count(*) AS n FROM rooms WHERE property_id = ? AND active = 1', p.id),
    active: p.active === 1,
  };
}

// ─── Setup ───────────────────────────────────────────────────
router.get('/api/setup/status', () => ({
  setupRequired: needsSetup(),
  userCount: scalar<number>('SELECT count(*) AS n FROM users'),
  propertyCount: scalar<number>('SELECT count(*) AS n FROM properties'),
}), { perm: null, allowNoProperty: true });

/**
 * Create the first property and its administrator. Only callable while the
 * installation is empty — afterwards properties and users are managed from
 * Configuration / Administration by an authenticated admin.
 */
router.post('/api/setup/bootstrap', ({ body, ip }: Ctx) => {
  if (!needsSetup()) {
    throw new HttpError(409, 'This installation is already set up', 'already_setup');
  }
  const p = body.property ?? {};
  const a = body.admin ?? {};

  const code = slugCode(p.code, 'property.code', 12);
  const name = str(p.name, 'property.name', { max: 120 });
  const currency = slugCode(p.currency ?? 'USD', 'property.currency', 3);
  const businessDate = isDate(p.businessDate) ? p.businessDate : todayIso();
  const adminName = str(a.name, 'admin.name', { max: 120 });
  const adminEmail = emailField(a.email, 'admin.email');
  assertPasswordStrength(a.password);

  return tx(() => {
    const propertyId = id('prp');
    run(
      `INSERT INTO properties(id, code, name, legal_name, kind, address, city, country, timezone,
                              currency, locale, business_date, check_in_time, check_out_time,
                              phone, email, website, tax_id, active, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      propertyId, code, name, p.legalName ?? null, p.kind ?? 'hotel',
      p.address ?? null, p.city ?? null, p.country ?? null, p.timezone ?? 'UTC',
      currency, p.locale ?? 'en', businessDate,
      p.checkInTime ?? '14:00', p.checkOutTime ?? '11:00',
      p.phone ?? null, p.email ?? null, p.website ?? null, p.taxId ?? null, nowIso(),
    );

    const { hash, salt } = hashPassword(a.password);
    const userId = id('usr');
    run(
      `INSERT INTO users(id, email, name, password_hash, password_salt, role, active, created_at)
       VALUES(?,?,?,?,?,'admin',1,?)`,
      userId, adminEmail, adminName, hash, salt, nowIso(),
    );
    run('INSERT INTO user_properties(user_id, property_id, role) VALUES(?,?,?)',
      userId, propertyId, 'admin');

    seedOperationalDefaults(propertyId);

    const actor = { userId, userName: adminName, propertyId };
    audit(actor, {
      action: 'setup.bootstrap', entity: 'PROPERTY', entityId: propertyId, entityRef: code,
      after: { name, currency, businessDate }, elevated: true,
    }, ip);

    const session = createSession(userId, propertyId, ip, 'setup');
    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: userId, name: adminName, email: adminEmail, role: 'admin', permissions: permissionsFor('admin') },
      property: shapeProperty(get<any>('SELECT * FROM properties WHERE id = ?', propertyId)),
    };
  });
}, { perm: null, allowNoProperty: true });

/**
 * Chart of accounts a hotel cannot operate without. These are configuration,
 * not sample data — every one is editable in Configuration → Transaction codes.
 */
export function seedOperationalDefaults(propertyId: string) {
  const codes: [string, string, string, number][] = [
    ['ROOM', 'Room charge', 'room', 1],
    ['FNB', 'Food & beverage', 'fnb', 1],
    ['MINIBAR', 'Minibar', 'fnb', 1],
    ['LAUNDRY', 'Laundry', 'misc', 1],
    ['PARKING', 'Parking', 'misc', 1],
    ['TELEPHONE', 'Telephone', 'misc', 1],
    ['EXTRABED', 'Extra bed', 'room', 1],
    ['LATECO', 'Late check-out', 'room', 1],
    ['EARLYCI', 'Early check-in', 'room', 1],
    ['MISC', 'Miscellaneous', 'misc', 1],
    ['CXL', 'Cancellation fee', 'misc', 0],
    ['NOSHOW', 'No-show charge', 'misc', 1],
    ['DISCOUNT', 'Discount / allowance', 'misc', 0],
    ['CITYLEDGER', 'Transfer to city ledger', 'misc', 0],
    ['PAYMENT', 'Payment', 'payment', 0],
  ];
  codes.forEach(([code, name, category, taxable], i) => {
    run(
      `INSERT INTO transaction_codes(id, property_id, code, name, category, taxable, active, sort_order)
       VALUES(?,?,?,?,?,?,1,?)
       ON CONFLICT(property_id, code) DO NOTHING`,
      id('txc'), propertyId, code, name, category, taxable, i,
    );
  });
}

// ─── Authentication ──────────────────────────────────────────
/** Everything the app needs once a sign-in is fully complete. */
function sessionPayload(user: any, session: { token: string; expiresAt: string }, propertyId: string | null) {
  const properties = propertiesForUser(user.id, user.role);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      roleLabel: ROLE_LABELS[user.role as keyof typeof ROLE_LABELS] ?? user.role,
      permissions: permissionsFor(user.role),
      mustChangePassword: user.must_change_pw === 1,
      mfaEnabled: user.mfa_enabled === 1,
    },
    properties: properties.map(shapeProperty),
    property: propertyId ? shapeProperty(properties.find((p: any) => p.id === propertyId)) : null,
  };
}

/**
 * Step one. Returns a finished session, or — when the account has two-factor
 * authentication switched on — a short-lived challenge that only the code can
 * complete.
 */
router.post('/api/auth/login', ({ body, ip, req }: Ctx) => {
  const emailAddr = emailField(body.email, 'email');
  const password = str(body.password, 'password', { max: 200 });
  const remember = body.remember === true;
  const agent = String(req.headers['user-agent'] ?? '');

  let user;
  try {
    user = authenticate(emailAddr, password);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 'error';
    recordLoginAttempt(emailAddr,
      code === 'locked' ? 'locked' : code === 'account_disabled' ? 'disabled' : 'bad-password',
      ip, agent);
    throw e;
  }

  if (user.mfa_enabled === 1 && user.mfa_secret) {
    const challenge = createSession(user.id, null, ip, agent, { mfaPending: true });
    return {
      mfaRequired: true,
      challengeToken: challenge.token,
      expiresAt: challenge.expiresAt,
      recoveryCodesRemaining: recoveryCodesRemaining(user.id),
      user: { name: user.name, email: user.email },
    };
  }

  const properties = propertiesForUser(user.id, user.role);
  const propertyId = properties.length === 1 ? properties[0].id : null;
  const session = createSession(user.id, propertyId, ip, agent, { remember });

  recordLoginAttempt(emailAddr, 'success', ip, agent, user.id);
  audit({ userId: user.id, userName: user.name, propertyId: propertyId ?? '' },
    { action: 'auth.login', entity: 'USER', entityId: user.id, entityRef: user.email,
      after: { remember, mfa: false } }, ip);

  return sessionPayload(user, session, propertyId);
}, { perm: null, allowNoProperty: true });

/** Step two: the authenticator code, or one of the recovery codes. */
router.post('/api/auth/mfa/verify', ({ body, ip, req }: Ctx) => {
  const challengeToken = str(body.challengeToken, 'challengeToken', { max: 200 });
  const code = str(body.code, 'code', { max: 40 });
  const remember = body.remember === true;
  const agent = String(req.headers['user-agent'] ?? '');

  const pending = resolvePendingSession(challengeToken);
  if (!pending) {
    throw new HttpError(401,
      'That sign-in has expired — enter your email and password again', 'challenge_expired');
  }

  const usedRecovery = !verifyTotp(pending.mfa_secret, code)
    && consumeRecoveryCode(pending.uid, code);

  if (!verifyTotp(pending.mfa_secret, code) && !usedRecovery) {
    recordLoginAttempt(pending.email, 'mfa-failed', ip, agent, pending.uid);
    throw new HttpError(401,
      'That code is not right. Check your authenticator, or use a recovery code.', 'mfa_invalid');
  }

  const user = get<any>('SELECT * FROM users WHERE id = ?', pending.uid);
  const properties = propertiesForUser(user.id, user.role);
  const propertyId = properties.length === 1 ? properties[0].id : null;

  const expiresAt = completeMfaChallenge(pending.sid, remember);
  if (propertyId) setSessionProperty(pending.sid, propertyId);

  recordLoginAttempt(user.email, usedRecovery ? 'mfa-recovery' : 'success', ip, agent, user.id);
  audit({ userId: user.id, userName: user.name, propertyId: propertyId ?? '' },
    { action: 'auth.login', entity: 'USER', entityId: user.id, entityRef: user.email,
      after: { remember, mfa: true, viaRecoveryCode: usedRecovery } }, ip);

  return {
    ...sessionPayload(user, { token: challengeToken, expiresAt }, propertyId),
    usedRecoveryCode: usedRecovery,
    recoveryCodesRemaining: recoveryCodesRemaining(user.id),
  };
}, { perm: null, allowNoProperty: true });

router.post('/api/auth/logout', ({ auth, ip }: Ctx) => {
  if (auth.sessionId) revokeSession(auth.sessionId);
  audit(auth, { action: 'auth.logout', entity: 'USER', entityId: auth.userId }, ip);
  return { ok: true };
}, { perm: undefined, allowNoProperty: true });

router.get('/api/auth/me', ({ auth }: Ctx) => {
  const user = get<any>('SELECT * FROM users WHERE id = ?', auth.userId);
  if (!user) throw new HttpError(401, 'Session is no longer valid');
  const properties = propertiesForUser(user.id, user.role);
  const current = auth.propertyId
    ? get<any>('SELECT * FROM properties WHERE id = ?', auth.propertyId)
    : null;
  return {
    user: {
      id: user.id, name: user.name, email: user.email, role: auth.role,
      roleLabel: ROLE_LABELS[auth.role as keyof typeof ROLE_LABELS] ?? auth.role,
      permissions: auth.permissions,
      mustChangePassword: user.must_change_pw === 1,
    },
    properties: properties.map(shapeProperty),
    property: current ? shapeProperty(current) : null,
  };
}, { perm: undefined, allowNoProperty: true });

router.post('/api/auth/select-property', ({ auth, body }: Ctx) => {
  const propertyId = str(body.propertyId, 'propertyId');
  const allowed = propertiesForUser(auth.userId, auth.role).some((p: any) => p.id === propertyId);
  if (!allowed) throw new HttpError(403, 'You do not have access to that property');
  setSessionProperty(auth.sessionId, propertyId);
  const p = get<any>('SELECT * FROM properties WHERE id = ?', propertyId);
  return { property: shapeProperty(p) };
}, { perm: undefined, allowNoProperty: true });

router.post('/api/auth/change-password', ({ auth, body, ip }: Ctx) => {
  const current = str(body.currentPassword, 'currentPassword', { max: 200 });
  assertPasswordStrength(body.newPassword);
  const user = get<any>('SELECT * FROM users WHERE id = ?', auth.userId);
  if (!verifyPassword(current, user.password_hash, user.password_salt)) {
    throw new HttpError(401, 'Your current password is not right', 'invalid_credentials');
  }
  if (verifyPassword(body.newPassword, user.password_hash, user.password_salt)) {
    throw new HttpError(400, 'The new password must be different from the old one', 'password_reused');
  }
  const { hash, salt } = hashPassword(body.newPassword);
  run(`UPDATE users SET password_hash = ?, password_salt = ?, must_change_pw = 0,
         password_changed_at = ? WHERE id = ?`,
    hash, salt, nowIso(), auth.userId);

  // Changing a password signs out everywhere else — that is the point of it.
  if (body.signOutOthers !== false) revokeOtherSessions(auth.userId, auth.sessionId);

  audit(auth, {
    action: 'auth.password-change', entity: 'USER', entityId: auth.userId,
    entityRef: user.email, elevated: true,
  }, ip);
  return { ok: true, otherSessionsRevoked: body.signOutOthers !== false };
}, { perm: undefined, allowNoProperty: true });

// ─── Two-factor authentication ───────────────────────────────
router.get('/api/auth/mfa', ({ auth }: Ctx) => {
  const user = get<any>('SELECT mfa_enabled, mfa_enrolled_at FROM users WHERE id = ?', auth.userId);
  return {
    enabled: user?.mfa_enabled === 1,
    enrolledAt: user?.mfa_enrolled_at ?? null,
    recoveryCodesRemaining: recoveryCodesRemaining(auth.userId),
  };
}, { perm: undefined, allowNoProperty: true });

/** Generate a secret and the details an authenticator app needs. */
router.post('/api/auth/mfa/setup', ({ auth, ip }: Ctx) => {
  const user = get<any>('SELECT * FROM users WHERE id = ?', auth.userId);
  if (user.mfa_enabled === 1) {
    throw new HttpError(409, 'Two-factor authentication is already on for this account', 'mfa_already_on');
  }
  const property = auth.propertyId
    ? get<{ name: string }>('SELECT name FROM properties WHERE id = ?', auth.propertyId)
    : null;
  const enrolment = beginEnrolment(auth.userId, user.email, property?.name ?? 'Helio PMS');
  audit(auth, { action: 'auth.mfa-setup-started', entity: 'USER', entityId: auth.userId }, ip);
  return enrolment;
}, { perm: undefined, allowNoProperty: true });

/** Prove the app is set up correctly, then switch 2FA on. */
router.post('/api/auth/mfa/enable', ({ auth, body, ip }: Ctx) => {
  const codes = completeEnrolment(auth.userId, str(body.code, 'code', { max: 10 }));
  audit(auth, {
    action: 'auth.mfa-enabled', entity: 'USER', entityId: auth.userId, elevated: true,
  }, ip);
  return { ok: true, recoveryCodes: codes };
}, { perm: undefined, allowNoProperty: true });

router.post('/api/auth/mfa/disable', ({ auth, body, ip }: Ctx) => {
  const user = get<any>('SELECT * FROM users WHERE id = ?', auth.userId);
  if (!verifyPassword(str(body.password, 'password', { max: 200 }),
    user.password_hash, user.password_salt)) {
    throw new HttpError(401, 'Password is not right', 'invalid_credentials');
  }
  disableMfa(auth.userId);
  audit(auth, {
    action: 'auth.mfa-disabled', entity: 'USER', entityId: auth.userId, elevated: true,
  }, ip);
  return { ok: true };
}, { perm: undefined, allowNoProperty: true });

router.post('/api/auth/mfa/recovery-codes', ({ auth, body, ip }: Ctx) => {
  const user = get<any>('SELECT * FROM users WHERE id = ?', auth.userId);
  if (user.mfa_enabled !== 1) {
    throw new HttpError(409, 'Two-factor authentication is not on for this account', 'mfa_off');
  }
  if (!verifyPassword(str(body.password, 'password', { max: 200 }),
    user.password_hash, user.password_salt)) {
    throw new HttpError(401, 'Password is not right', 'invalid_credentials');
  }
  const codes = issueRecoveryCodes(auth.userId);
  audit(auth, {
    action: 'auth.mfa-recovery-regenerated', entity: 'USER', entityId: auth.userId, elevated: true,
  }, ip);
  return { recoveryCodes: codes };
}, { perm: undefined, allowNoProperty: true });

// ─── Password reset ──────────────────────────────────────────
/**
 * Requesting a reset always answers the same way, so the form cannot be used
 * to discover which email addresses have accounts. There is no mail provider
 * wired up, so the live request is surfaced to administrators to action —
 * rather than claiming an email was sent.
 */
router.post('/api/auth/forgot-password', ({ body, ip }: Ctx) => {
  const emailAddr = emailField(body.email, 'email');
  const user = get<any>('SELECT id, name, email FROM users WHERE email = ? AND active = 1', emailAddr);
  if (user) {
    createPasswordReset(user.id, ip);
    audit(null, {
      action: 'auth.reset-requested', entity: 'USER', entityId: user.id, entityRef: user.email,
    }, ip);
  }
  return {
    ok: true,
    message: 'If that address has an account, an administrator can now issue a reset link for it '
      + 'from Administration → Security.',
  };
}, { perm: null, allowNoProperty: true });

/** An administrator hands the link to the person who asked for it. */
router.post('/api/auth/reset-links/:userId', ({ auth, params, ip }: Ctx) => {
  const user = get<any>('SELECT id, name, email, role FROM users WHERE id = ?', params.userId);
  if (!user) throw new HttpError(404, 'User not found');
  // A reset link is a working key to the account. Issuing one for an admin is
  // the same takeover as promoting yourself — the redeeming route is
  // unauthenticated and clears the lockout on the way through.
  assertMayGrantRole(auth, user.role);
  const reset = createPasswordReset(user.id, ip, auth.userName);
  audit(auth, {
    action: 'auth.reset-issued', entity: 'USER', entityId: user.id, entityRef: user.email,
    elevated: true,
  }, ip);
  return {
    token: reset.token,
    expiresAt: reset.expiresAt,
    user: { name: user.name, email: user.email },
  };
}, { perm: 'admin.users', allowNoProperty: true });

router.get('/api/auth/reset-requests', () => pendingResets(),
  { perm: 'admin.users', allowNoProperty: true });

router.post('/api/auth/reset-password', ({ body, ip }: Ctx) => {
  const token = str(body.token, 'token', { max: 200 });
  assertPasswordStrength(body.newPassword);
  const { userId, resetId } = resolvePasswordReset(token);
  const { hash, salt } = hashPassword(body.newPassword);
  run(`UPDATE users SET password_hash = ?, password_salt = ?, must_change_pw = 0,
         failed_logins = 0, locked_until = NULL, password_changed_at = ? WHERE id = ?`,
    hash, salt, nowIso(), userId);
  consumePasswordReset(resetId);
  // Every existing session is dropped: a reset means the old password is gone.
  run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', userId);
  const user = get<any>('SELECT email FROM users WHERE id = ?', userId);
  audit(null, {
    action: 'auth.password-reset', entity: 'USER', entityId: userId, entityRef: user?.email,
    elevated: true,
  }, ip);
  return { ok: true };
}, { perm: null, allowNoProperty: true });

// ─── Security log ────────────────────────────────────────────
router.get('/api/auth/activity', ({ auth, query }: Ctx) => {
  // Administrators see everyone's attempts; everyone else sees their own.
  const scopeAll = query.get('scope') === 'all'
    && auth.permissions.some((p) => p === '*' || p === 'admin.users');
  return loginHistory(scopeAll ? undefined : auth.userId, 100);
}, { perm: undefined, allowNoProperty: true });

router.post('/api/auth/sign-out-everywhere', ({ auth, ip }: Ctx) => {
  revokeOtherSessions(auth.userId, auth.sessionId);
  audit(auth, {
    action: 'auth.sign-out-everywhere', entity: 'USER', entityId: auth.userId, elevated: true,
  }, ip);
  return { ok: true };
}, { perm: undefined, allowNoProperty: true });

// ─── User administration ─────────────────────────────────────
router.get('/api/users', ({ auth }: Ctx) => all<any>(
  `SELECT u.*, (SELECT group_concat(property_id) FROM user_properties WHERE user_id = u.id) AS props
     FROM users u ORDER BY u.name`,
).map((u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  roleLabel: ROLE_LABELS[u.role as keyof typeof ROLE_LABELS] ?? u.role,
  phone: u.phone, active: u.active === 1, lastLoginAt: u.last_login_at,
  mustChangePassword: u.must_change_pw === 1,
  locked: !!u.locked_until && u.locked_until > nowIso(),
  properties: (u.props ?? '').split(',').filter(Boolean),
})), { perm: 'admin.users' });

/**
 * Nobody hands out authority they do not hold.
 *
 * `admin.users` lets a manager run the staff list — create a receptionist, reset
 * a forgotten password, deactivate a leaver. It must not let them mint an
 * administrator. Without this, the role hierarchy is decoration: a manager
 * creates an admin account, or simply promotes themselves, and owns the system
 * and every property on it.
 */
function assertMayGrantRole(auth: Ctx['auth'], role: string) {
  if (role === 'admin' && auth.role !== 'admin') {
    throw new HttpError(403,
      'Only an administrator can create or promote an administrator', 'role_forbidden');
  }
}

/** Guard the account you are signed in as — the one you can always reach. */
function assertNotSelf(auth: Ctx['auth'], targetUserId: string, what: string) {
  if (targetUserId === auth.userId) {
    throw new HttpError(400, `You cannot ${what} on your own account`);
  }
}

router.post('/api/users', ({ auth, body, ip }: Ctx) => {
  const name = str(body.name, 'name', { max: 120 });
  const mail = emailField(body.email, 'email');
  const role = str(body.role, 'role');
  if (!ROLES.includes(role as any)) throw new HttpError(400, `Unknown role "${role}"`);
  assertMayGrantRole(auth, role);
  assertPasswordStrength(body.password);
  const { hash, salt } = hashPassword(body.password);
  const userId = id('usr');
  run(
    `INSERT INTO users(id, email, name, password_hash, password_salt, role, phone, active,
                       must_change_pw, created_at)
     VALUES(?,?,?,?,?,?,?,1,?,?)`,
    userId, mail, name, hash, salt, role, body.phone ?? null,
    body.mustChangePassword === false ? 0 : 1, nowIso(),
  );
  for (const pid of (body.properties ?? [auth.propertyId]).filter(Boolean)) {
    run('INSERT INTO user_properties(user_id, property_id, role) VALUES(?,?,?) ON CONFLICT DO NOTHING',
      userId, pid, role);
  }
  audit(auth, {
    action: 'user.create', entity: 'USER', entityId: userId, entityRef: mail,
    after: { role }, elevated: true,
  }, ip);
  return { id: userId, name, email: mail, role };
}, { perm: 'admin.users' });

router.patch('/api/users/:id', ({ auth, params, body, ip }: Ctx) => {
  const user = get<any>('SELECT * FROM users WHERE id = ?', params.id);
  if (!user) throw new HttpError(404, 'User not found');
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); args.push(str(body.name, 'name')); }
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) throw new HttpError(400, `Unknown role "${body.role}"`);
    assertMayGrantRole(auth, body.role);
    // Changing your own role is never legitimate administration — it is either
    // a mistake or an escalation, and both are better refused.
    assertNotSelf(auth, params.id, 'change the role');
    // A demotion has to reach an existing admin's own account too.
    assertMayGrantRole(auth, user.role);
    sets.push('role = ?'); args.push(body.role);
    run('UPDATE user_properties SET role = ? WHERE user_id = ?', body.role, params.id);
  }
  if (body.phone !== undefined) { sets.push('phone = ?'); args.push(body.phone); }
  if (body.active !== undefined) {
    if (params.id === auth.userId && body.active === false) {
      throw new HttpError(400, 'You cannot disable your own account');
    }
    // Deactivating an administrator is an administrator's decision.
    assertMayGrantRole(auth, user.role);
    sets.push('active = ?'); args.push(body.active ? 1 : 0);
  }
  if (body.password) {
    // Setting somebody's password is taking their account. Doing it to an admin
    // is the same escalation as promoting yourself, by a longer route.
    assertMayGrantRole(auth, user.role);
    assertPasswordStrength(body.password);
    const { hash, salt } = hashPassword(body.password);
    sets.push('password_hash = ?', 'password_salt = ?', 'must_change_pw = ?');
    args.push(hash, salt, 1);
  }
  if (body.unlock) { sets.push('locked_until = NULL', 'failed_logins = 0'); }
  if (!sets.length) return { ok: true };
  args.push(params.id);
  run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...args);
  audit(auth, {
    action: 'user.update', entity: 'USER', entityId: params.id, entityRef: user.email,
    before: { role: user.role, active: user.active === 1 }, after: body, elevated: true,
  }, ip);
  return { ok: true };
}, { perm: 'admin.users' });

router.get('/api/roles', () => ROLES.map((r) => ({
  value: r, label: ROLE_LABELS[r], permissions: permissionsFor(r),
})), { perm: undefined, allowNoProperty: true });

router.get('/api/sessions', ({ auth }: Ctx) => all<any>(
  `SELECT s.id, s.created_at, s.last_seen_at, s.expires_at, s.ip, s.user_agent, s.revoked,
          u.name, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.expires_at > ? ORDER BY s.last_seen_at DESC LIMIT 100`,
  nowIso(),
).map((s) => ({
  id: s.id, user: s.name, email: s.email, createdAt: s.created_at,
  lastSeenAt: s.last_seen_at, expiresAt: s.expires_at, ip: s.ip,
  userAgent: s.user_agent, revoked: s.revoked === 1, current: s.id === auth.sessionId,
})), { perm: 'admin.users' });

router.delete('/api/sessions/:id', ({ auth, params }: Ctx) => {
  revokeSession(params.id);
  audit(auth, { action: 'session.revoke', entity: 'SESSION', entityId: params.id, elevated: true });
  return { ok: true };
}, { perm: 'admin.users' });
