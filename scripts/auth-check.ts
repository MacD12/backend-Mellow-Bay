// ─────────────────────────────────────────────────────────────
// Exercises the whole sign-in system against a running server:
// credentials, lockout, two-factor enrolment and challenge, recovery codes,
// password change, reset links and session revocation.
//
//   SMOKE_EMAIL=… SMOKE_PASSWORD=… node --experimental-sqlite scripts/auth-check.ts
//
// It creates its own throwaway user, so it is safe to run against a property
// that has real data in it.
// ─────────────────────────────────────────────────────────────
import { totpCode } from '../src/mfa.ts';

const BASE = process.env.API ?? 'http://localhost:8080';
let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}\n`);
  if (!ok) {
    failures++;
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 300)}\n`);
  }
}
function section(t: string) { process.stdout.write(`\n${t}\n${'─'.repeat(t.length)}\n`); }

async function api(
  method: string, path: string, body?: unknown, token?: string, propertyId?: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(propertyId ? { 'x-property-id': propertyId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  const adminEmail = process.env.SMOKE_EMAIL;
  const adminPassword = process.env.SMOKE_PASSWORD;
  if (!adminEmail || !adminPassword) {
    process.stderr.write('Set SMOKE_EMAIL / SMOKE_PASSWORD to an administrator account\n');
    process.exitCode = 1;
    return;
  }

  const admin = await api('POST', '/api/auth/login', { email: adminEmail, password: adminPassword });
  if (!admin.body?.token) {
    process.stderr.write(`Administrator sign-in failed: ${JSON.stringify(admin.body)}\n`);
    process.exitCode = 1;
    return;
  }
  const adminToken = admin.body.token;
  const propertyId = (admin.body.property ?? admin.body.properties[0]).id;

  const stamp = Date.now().toString(36).slice(-6);
  const email = `authcheck${stamp}@helio.test`;
  const password = 'Initial123';

  section('1 · Password sign-in');
  const created = await api('POST', '/api/users', {
    name: 'Auth Check', email, role: 'front_office', password, mustChangePassword: false,
  }, adminToken, propertyId);
  check('administrator can create a user', created.status === 200, created.body);

  const good = await api('POST', '/api/auth/login', { email, password });
  check('correct credentials return a session', !!good.body?.token, good.body);
  check('session reports the role and permissions',
    good.body?.user?.role === 'front_office' && Array.isArray(good.body?.user?.permissions));
  check('two-factor is off for a new account', good.body?.user?.mfaEnabled === false);

  const bad = await api('POST', '/api/auth/login', { email, password: 'WrongPass9' });
  check('a wrong password is rejected', bad.status === 401, bad.body);
  check('the error does not reveal whether the address exists',
    /invalid email or password/i.test(bad.body?.error ?? ''), bad.body?.error);

  section('2 · Remember me');
  const short = await api('POST', '/api/auth/login', { email, password, remember: false });
  const long = await api('POST', '/api/auth/login', { email, password, remember: true });
  const shortMs = Date.parse(short.body.expiresAt) - Date.now();
  const longMs = Date.parse(long.body.expiresAt) - Date.now();
  check('a normal session lasts about a shift', shortMs > 10 * 3600_000 && shortMs < 13 * 3600_000,
    `${Math.round(shortMs / 3600_000)}h`);
  check('"keep me signed in" lasts about a fortnight', longMs > 13 * 24 * 3600_000,
    `${Math.round(longMs / 3600_000 / 24)}d`);

  section('3 · Two-factor authentication');
  const token = good.body.token;
  const setup = await api('POST', '/api/auth/mfa/setup', {}, token, propertyId);
  check('setup returns a secret and an otpauth URI',
    !!setup.body?.secret && String(setup.body?.otpauthUri).startsWith('otpauth://totp/'), setup.body);
  check('the secret is offered in readable blocks for manual entry',
    /^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/.test(setup.body?.manualKey ?? ''), setup.body?.manualKey);

  const wrongEnable = await api('POST', '/api/auth/mfa/enable', { code: '000000' }, token, propertyId);
  check('a wrong code will not switch 2FA on', wrongEnable.status === 400, wrongEnable.body);

  const secret: string = setup.body.secret;
  const enable = await api('POST', '/api/auth/mfa/enable', { code: totpCode(secret) }, token, propertyId);
  check('a valid code switches 2FA on', enable.status === 200, enable.body);
  check('ten recovery codes are issued', enable.body?.recoveryCodes?.length === 10);

  const state = await api('GET', '/api/auth/mfa', undefined, token, propertyId);
  check('the account now reports 2FA as on',
    state.body?.enabled === true && state.body?.recoveryCodesRemaining === 10, state.body);

  section('4 · Signing in with 2FA');
  const challenge = await api('POST', '/api/auth/login', { email, password });
  check('password alone no longer returns a session',
    challenge.body?.mfaRequired === true && !challenge.body?.token, challenge.body);
  check('a challenge token is issued instead', !!challenge.body?.challengeToken);

  const challengeToken = challenge.body.challengeToken;
  const blocked = await api('GET', '/api/auth/me', undefined, challengeToken);
  check('the challenge token cannot be used as a session', blocked.status === 401, blocked.body);

  const wrongCode = await api('POST', '/api/auth/mfa/verify', { challengeToken, code: '111111' });
  check('a wrong authenticator code is rejected', wrongCode.status === 401, wrongCode.body);

  const verified = await api('POST', '/api/auth/mfa/verify',
    { challengeToken, code: totpCode(secret), remember: false });
  check('the right code completes the sign-in', !!verified.body?.token, verified.body);
  check('the same token now works as a session',
    (await api('GET', '/api/auth/me', undefined, verified.body.token)).status === 200);

  section('5 · Recovery codes');
  const recovery: string[] = enable.body.recoveryCodes;
  const challenge2 = await api('POST', '/api/auth/login', { email, password });
  const usedRecovery = await api('POST', '/api/auth/mfa/verify', {
    challengeToken: challenge2.body.challengeToken, code: recovery[0],
  });
  check('a recovery code completes the sign-in',
    !!usedRecovery.body?.token && usedRecovery.body?.usedRecoveryCode === true, usedRecovery.body);
  check('the used code is spent', usedRecovery.body?.recoveryCodesRemaining === 9);

  const challenge3 = await api('POST', '/api/auth/login', { email, password });
  const reuse = await api('POST', '/api/auth/mfa/verify', {
    challengeToken: challenge3.body.challengeToken, code: recovery[0],
  });
  check('the same recovery code cannot be used twice', reuse.status === 401, reuse.body);

  section('6 · Changing a password');
  const session = verified.body.token;
  const weak = await api('POST', '/api/auth/change-password',
    { currentPassword: password, newPassword: 'short' }, session, propertyId);
  check('a weak password is refused', weak.status === 400, weak.body);

  const reused = await api('POST', '/api/auth/change-password',
    { currentPassword: password, newPassword: password }, session, propertyId);
  check('reusing the current password is refused', reused.status === 400, reused.body);

  const wrongCurrent = await api('POST', '/api/auth/change-password',
    { currentPassword: 'NotIt12345', newPassword: 'Changed456' }, session, propertyId);
  check('the current password must be right', wrongCurrent.status === 401, wrongCurrent.body);

  const otherSession = usedRecovery.body.token;
  const changed = await api('POST', '/api/auth/change-password',
    { currentPassword: password, newPassword: 'Changed456' }, session, propertyId);
  check('a valid change succeeds', changed.status === 200, changed.body);
  check('other sessions are signed out by the change',
    (await api('GET', '/api/auth/me', undefined, otherSession)).status === 401);
  check('the session that made the change keeps working',
    (await api('GET', '/api/auth/me', undefined, session)).status === 200);
  check('the old password no longer works',
    (await api('POST', '/api/auth/login', { email, password })).status === 401);

  section('7 · Turning 2FA off');
  const wrongPw = await api('POST', '/api/auth/mfa/disable', { password: 'nope12345' }, session, propertyId);
  check('2FA cannot be turned off without the password', wrongPw.status === 401, wrongPw.body);
  const disabled = await api('POST', '/api/auth/mfa/disable', { password: 'Changed456' }, session, propertyId);
  check('the password turns 2FA off', disabled.status === 200, disabled.body);
  const afterDisable = await api('POST', '/api/auth/login', { email, password: 'Changed456' });
  check('sign-in is back to one step', !!afterDisable.body?.token && !afterDisable.body?.mfaRequired);

  section('8 · Password reset');
  const forgot = await api('POST', '/api/auth/forgot-password', { email });
  check('a reset request is accepted', forgot.status === 200, forgot.body);
  const unknown = await api('POST', '/api/auth/forgot-password', { email: 'nobody@nowhere.test' });
  check('an unknown address gets the identical answer',
    unknown.status === 200 && unknown.body.message === forgot.body.message);

  const pending = await api('GET', '/api/auth/reset-requests', undefined, adminToken, propertyId);
  check('the request is visible to an administrator',
    Array.isArray(pending.body) && pending.body.some((r: any) => r.email === email), pending.body);

  const link = await api('POST', `/api/auth/reset-links/${created.body.id}`, {}, adminToken, propertyId);
  check('an administrator can issue a reset link', !!link.body?.token, link.body);

  const badToken = await api('POST', '/api/auth/reset-password',
    { token: 'not-a-real-token', newPassword: 'Brandnew123' });
  check('a bogus reset token is refused', badToken.status === 400, badToken.body);

  const reset = await api('POST', '/api/auth/reset-password',
    { token: link.body.token, newPassword: 'Brandnew123' });
  check('a valid reset token sets a new password', reset.status === 200, reset.body);
  check('the reset signs every session out',
    (await api('GET', '/api/auth/me', undefined, session)).status === 401);
  check('the new password works',
    !!(await api('POST', '/api/auth/login', { email, password: 'Brandnew123' })).body?.token);
  const replay = await api('POST', '/api/auth/reset-password',
    { token: link.body.token, newPassword: 'Another123' });
  check('a reset token cannot be replayed', replay.status === 400, replay.body);

  section('9 · Lockout');
  for (let i = 0; i < 8; i++) {
    await api('POST', '/api/auth/login', { email, password: `Wrong${i}0000` });
  }
  const locked = await api('POST', '/api/auth/login', { email, password: 'Brandnew123' });
  check('repeated failures lock the account', locked.status === 423, locked.body);
  check('the lock message says how long it lasts',
    /locked/i.test(locked.body?.error ?? '') && typeof locked.body?.details?.minutes === 'number',
    locked.body);

  const unlocked = await api('PATCH', `/api/users/${created.body.id}`, { unlock: true }, adminToken, propertyId);
  check('an administrator can unlock it', unlocked.status === 200, unlocked.body);
  check('sign-in works again after unlocking',
    !!(await api('POST', '/api/auth/login', { email, password: 'Brandnew123' })).body?.token);

  section('10 · Sessions and the security log');
  const fresh = await api('POST', '/api/auth/login', { email, password: 'Brandnew123' });
  const a = fresh.body.token;
  const b = (await api('POST', '/api/auth/login', { email, password: 'Brandnew123' })).body.token;
  check('two devices can be signed in at once',
    (await api('GET', '/api/auth/me', undefined, a)).status === 200
    && (await api('GET', '/api/auth/me', undefined, b)).status === 200);

  await api('POST', '/api/auth/sign-out-everywhere', {}, a, propertyId);
  check('"sign out everywhere" drops the other device',
    (await api('GET', '/api/auth/me', undefined, b)).status === 401);
  check('…and keeps the one that asked',
    (await api('GET', '/api/auth/me', undefined, a)).status === 200);

  const activity = await api('GET', '/api/auth/activity', undefined, a, propertyId);
  check('the account can see its own sign-in history',
    Array.isArray(activity.body) && activity.body.length > 0, activity.body);
  check('failures are recorded alongside successes',
    activity.body.some((r: any) => r.outcome === 'success')
    && activity.body.some((r: any) => r.outcome === 'bad-password'),
    activity.body?.slice(0, 4));
  check('a normal user cannot read everyone else\'s attempts',
    (await api('GET', '/api/auth/activity?scope=all', undefined, a, propertyId))
      .body.every((r: any) => r.email === email));

  // Tidy up the throwaway account.
  await api('PATCH', `/api/users/${created.body.id}`, { active: false }, adminToken, propertyId);

  process.stdout.write(`\n${checks - failures}/${checks} authentication checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('The sign-in system behaves correctly.\n');
}

main().catch((e) => {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
