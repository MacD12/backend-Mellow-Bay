// Guest profiles: search, stay history, lifetime value, duplicate detection,
// merge, consent and messaging.
import { router, type Ctx } from '../lib/http.ts';
import { all, get, run, tx, scalar, jsonCol, parseJson } from '../db.ts';
import { id, nowIso, str, oneOf, boolIn, slugCode, notFound, HttpError } from '../lib/util.ts';
import { guestValue } from '../services/reports.ts';
import {
  sendGuestMessage, deliverMessage, pollChannelMessages, inbox, thread, markThreadRead,
  unreadCount, messagingChannels, listTemplates, upsertTemplate, deleteTemplate,
  renderTemplate, mergeFields,
} from '../services/messaging.ts';
import { audit } from '../services/audit.ts';

const pid = (ctx: Ctx) => ctx.auth.propertyId;

function shapeProfile(p: any, withStats = false) {
  const base = {
    id: p.id, type: p.type, name: p.name, firstName: p.first_name, lastName: p.last_name,
    email: p.email, phone: p.phone, nationality: p.nationality, language: p.language,
    dob: p.dob, idType: p.id_type, idNumber: p.id_number, idExpiry: p.id_expiry,
    address: parseJson<any>(p.address, null),
    loyalty: p.loyalty_tier, loyaltyPoints: p.loyalty_points,
    vip: p.vip === 1, blacklist: p.blacklist === 1, blacklistReason: p.blacklist_reason,
    marketingConsent: p.marketing_consent === 1, consentAt: p.consent_at,
    preferences: parseJson<string[]>(p.preferences, []),
    notes: p.notes, mergedInto: p.merged_into,
    createdAt: p.created_at, updatedAt: p.updated_at,
  };
  if (!withStats) return base;
  const stats = get<any>(
    `SELECT count(*) AS stays,
            COALESCE(SUM(CASE WHEN status = 'Checked-out' THEN nights ELSE 0 END),0) AS nights,
            MAX(CASE WHEN status = 'Checked-out' THEN departure END) AS last_stay
       FROM reservations WHERE profile_id = ?`, p.id);
  const revenue = scalar<number>(
    `SELECT COALESCE(SUM(l.amount_minor),0) AS t FROM folio_lines l
       JOIN folios f ON f.id = l.folio_id JOIN reservations r ON r.id = f.reservation_id
      WHERE r.profile_id = ? AND l.voided = 0 AND l.kind IN ('charge','tax')`, p.id);
  return {
    ...base,
    stays: stats?.stays ?? 0,
    totalNights: stats?.nights ?? 0,
    lastStay: stats?.last_stay ?? null,
    totalRevenueMinor: revenue,
  };
}

router.get('/api/profiles', (ctx: Ctx) => {
  const search = ctx.query.get('search');
  const where = ['property_id = ?', 'merged_into IS NULL'];
  const params: unknown[] = [pid(ctx)];
  if (search) {
    where.push('(name LIKE ? OR email LIKE ? OR phone LIKE ? OR id_number LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (ctx.query.get('vip') === 'true') where.push('vip = 1');
  if (ctx.query.get('blacklist') === 'true') where.push('blacklist = 1');
  const limit = Math.min(Number(ctx.query.get('limit') ?? 200), 500);
  return all<any>(
    `SELECT * FROM profiles WHERE ${where.join(' AND ')} ORDER BY name LIMIT ${limit}`, ...params,
  ).map((p) => shapeProfile(p, true));
}, { perm: 'profiles.read' });

router.get('/api/profiles/:id', (ctx: Ctx) => {
  const p = get<any>('SELECT * FROM profiles WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  if (!p) notFound('Profile');
  return { ...shapeProfile(p, true), ...guestValue(pid(ctx), ctx.params.id) };
}, { perm: 'profiles.read' });

router.post('/api/profiles', (ctx: Ctx) => {
  const b = ctx.body;
  const name = str(b.name, 'name', { max: 120 });
  const parts = name.split(/\s+/);
  const profileId = id('pro');
  run(
    `INSERT INTO profiles(id, property_id, type, first_name, last_name, name, email, phone,
                          nationality, language, dob, id_type, id_number, id_expiry, address,
                          loyalty_tier, loyalty_points, vip, blacklist, marketing_consent,
                          consent_at, preferences, notes, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    profileId, pid(ctx), oneOf(b.type, 'type', ['guest', 'company', 'agent'] as const, 'guest'),
    b.firstName ?? parts[0] ?? null, b.lastName ?? (parts.slice(1).join(' ') || null), name,
    b.email ?? null, b.phone ?? null, b.nationality ?? null, b.language ?? null, b.dob ?? null,
    b.idType ?? null, b.idNumber ?? null, b.idExpiry ?? null, jsonCol(b.address ?? null),
    oneOf(b.loyalty, 'loyalty', ['None', 'Silver', 'Gold', 'Platinum'] as const, 'None'),
    b.loyaltyPoints ?? 0, boolIn(b.vip) ? 1 : 0, boolIn(b.blacklist) ? 1 : 0,
    boolIn(b.marketingConsent) ? 1 : 0, boolIn(b.marketingConsent) ? nowIso() : null,
    jsonCol(b.preferences ?? []), b.notes ?? null, nowIso(), nowIso(),
  );
  audit(ctx.auth, { action: 'profile.create', entity: 'PROFILE', entityId: profileId, entityRef: name }, ctx.ip);
  return shapeProfile(get<any>('SELECT * FROM profiles WHERE id = ?', profileId));
}, { perm: 'profiles.write' });

router.patch('/api/profiles/:id', (ctx: Ctx) => {
  const before = get<any>('SELECT * FROM profiles WHERE id = ? AND property_id = ?',
    ctx.params.id, pid(ctx));
  if (!before) notFound('Profile');
  const map: Record<string, string> = {
    name: 'name', firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone',
    nationality: 'nationality', language: 'language', dob: 'dob', idType: 'id_type',
    idNumber: 'id_number', idExpiry: 'id_expiry', loyalty: 'loyalty_tier',
    loyaltyPoints: 'loyalty_points', notes: 'notes', blacklistReason: 'blacklist_reason',
  };
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (ctx.body[k] !== undefined) { sets.push(`${col} = ?`); args.push(ctx.body[k]); }
  }
  if (ctx.body.vip !== undefined) { sets.push('vip = ?'); args.push(ctx.body.vip ? 1 : 0); }
  if (ctx.body.blacklist !== undefined) {
    sets.push('blacklist = ?'); args.push(ctx.body.blacklist ? 1 : 0);
  }
  if (ctx.body.preferences !== undefined) { sets.push('preferences = ?'); args.push(jsonCol(ctx.body.preferences)); }
  if (ctx.body.address !== undefined) { sets.push('address = ?'); args.push(jsonCol(ctx.body.address)); }
  if (ctx.body.marketingConsent !== undefined) {
    sets.push('marketing_consent = ?', 'consent_at = ?');
    args.push(ctx.body.marketingConsent ? 1 : 0, ctx.body.marketingConsent ? nowIso() : null);
  }
  sets.push('updated_at = ?'); args.push(nowIso());
  args.push(ctx.params.id);
  run(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`, ...args);
  audit(ctx.auth, {
    action: 'profile.update', entity: 'PROFILE', entityId: ctx.params.id, entityRef: before.name,
    before: { vip: before.vip === 1, blacklist: before.blacklist === 1 }, after: ctx.body,
    elevated: ctx.body.blacklist !== undefined,
  }, ctx.ip);
  return shapeProfile(get<any>('SELECT * FROM profiles WHERE id = ?', ctx.params.id), true);
}, { perm: 'profiles.write' });

/** Candidate duplicates: same email, same phone, or same normalised name. */
router.get('/api/profiles/:id/duplicates', (ctx: Ctx) => {
  const p = get<any>('SELECT * FROM profiles WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  if (!p) notFound('Profile');
  const rows = all<any>(
    `SELECT * FROM profiles
      WHERE property_id = ? AND id <> ? AND merged_into IS NULL
        AND ((email IS NOT NULL AND email <> '' AND lower(email) = lower(?))
          OR (phone IS NOT NULL AND phone <> '' AND replace(replace(phone,' ',''),'-','') =
              replace(replace(?,' ',''),'-',''))
          OR lower(name) = lower(?))`,
    pid(ctx), p.id, p.email ?? '', p.phone ?? '', p.name,
  );
  return rows.map((r) => ({
    ...shapeProfile(r, true),
    matchOn: [
      r.email && p.email && r.email.toLowerCase() === p.email.toLowerCase() ? 'email' : null,
      r.phone && p.phone && r.phone.replace(/[\s-]/g, '') === p.phone.replace(/[\s-]/g, '') ? 'phone' : null,
      r.name.toLowerCase() === p.name.toLowerCase() ? 'name' : null,
    ].filter(Boolean),
  }));
}, { perm: 'profiles.read' });

/** Merge `sourceId` into this profile: history moves, the source is tombstoned. */
router.post('/api/profiles/:id/merge', (ctx: Ctx) => tx(() => {
  const target = get<any>('SELECT * FROM profiles WHERE id = ? AND property_id = ?',
    ctx.params.id, pid(ctx));
  const sourceId = str(ctx.body.sourceId, 'sourceId');
  const source = get<any>('SELECT * FROM profiles WHERE id = ? AND property_id = ?', sourceId, pid(ctx));
  if (!target || !source) notFound('Profile');
  if (target.id === source.id) throw new HttpError(400, 'Cannot merge a profile into itself');

  run('UPDATE reservations SET profile_id = ? WHERE profile_id = ?', target.id, source.id);
  run('UPDATE reservation_guests SET profile_id = ? WHERE profile_id = ?', target.id, source.id);
  run('UPDATE messages SET profile_id = ? WHERE profile_id = ?', target.id, source.id);
  run('UPDATE lost_found SET profile_id = ? WHERE profile_id = ?', target.id, source.id);

  // Keep the richest field values and the union of preferences.
  const prefs = Array.from(new Set([
    ...parseJson<string[]>(target.preferences, []),
    ...parseJson<string[]>(source.preferences, []),
  ]));
  run(
    `UPDATE profiles SET
       email = COALESCE(NULLIF(email,''), ?), phone = COALESCE(NULLIF(phone,''), ?),
       nationality = COALESCE(nationality, ?), id_number = COALESCE(id_number, ?),
       loyalty_points = loyalty_points + ?, vip = MAX(vip, ?), blacklist = MAX(blacklist, ?),
       preferences = ?, updated_at = ?
     WHERE id = ?`,
    source.email, source.phone, source.nationality, source.id_number,
    source.loyalty_points, source.vip, source.blacklist, jsonCol(prefs), nowIso(), target.id,
  );
  run('UPDATE profiles SET merged_into = ?, updated_at = ? WHERE id = ?', target.id, nowIso(), source.id);

  audit(ctx.auth, {
    action: 'profile.merge', entity: 'PROFILE', entityId: target.id, entityRef: target.name,
    before: { source: source.name, sourceId: source.id }, after: { target: target.name },
    elevated: true,
  }, ctx.ip);
  return shapeProfile(get<any>('SELECT * FROM profiles WHERE id = ?', target.id), true);
}), { perm: 'profiles.write' });

// ─── Guest messaging ─────────────────────────────────────────
router.get('/api/messages', (ctx: Ctx) => {
  const where = ['property_id = ?'];
  const params: unknown[] = [pid(ctx)];
  if (ctx.query.get('reservationId')) {
    where.push('reservation_id = ?'); params.push(ctx.query.get('reservationId'));
  }
  if (ctx.query.get('profileId')) { where.push('profile_id = ?'); params.push(ctx.query.get('profileId')); }
  return all<any>(
    `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT 200`, ...params,
  ).map((m) => ({
    id: m.id, reservationId: m.reservation_id, profileId: m.profile_id, channel: m.channel,
    direction: m.direction, subject: m.subject, body: m.body, status: m.status,
    author: m.author, ts: m.ts,
  }));
}, { perm: 'profiles.read' });

/**
 * Send a message to a guest.
 *
 * When the booking came through a channel that carries messages, it goes out
 * through that channel. When it did not, the message stays on the thread as a
 * draft and the response says why — it is never shown as sent.
 */
router.post('/api/messages', async (ctx: Ctx) => sendGuestMessage(pid(ctx), ctx.auth, {
  reservationId: str(ctx.body.reservationId, 'reservationId'),
  body: str(ctx.body.body, 'body', { max: 4000 }),
}), { perm: 'profiles.write' });

/** Retry a message the channel refused. */
router.post('/api/messages/:id/send', async (ctx: Ctx) =>
  deliverMessage(pid(ctx), ctx.auth, ctx.params.id), { perm: 'profiles.write' });

// ─── The inbox ───────────────────────────────────────────────
router.get('/api/inbox', (ctx: Ctx) => {
  const today = get<{ business_date: string }>(
    'SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;
  return {
    threads: inbox(pid(ctx), today, {
      unread: ctx.query.get('unread') === '1',
      inHouse: ctx.query.get('inHouse') === '1',
      arriving: ctx.query.get('arriving') === '1',
      channelCode: ctx.query.get('channelCode') ?? undefined,
      search: ctx.query.get('search') ?? undefined,
    }),
    unread: unreadCount(pid(ctx)),
    channels: messagingChannels(pid(ctx)),
  };
}, { perm: 'profiles.read' });

router.get('/api/inbox/unread', (ctx: Ctx) =>
  ({ unread: unreadCount(pid(ctx)) }), { perm: 'profiles.read' });

router.get('/api/inbox/:reservationId', (ctx: Ctx) =>
  ({ messages: thread(pid(ctx), ctx.params.reservationId) }), { perm: 'profiles.read' });

router.post('/api/inbox/:reservationId/read', (ctx: Ctx) =>
  markThreadRead(pid(ctx), ctx.params.reservationId), { perm: 'profiles.read' });

/** Pull new channel messages now rather than waiting for the timer. */
router.post('/api/inbox/poll', async (ctx: Ctx) => {
  const today = get<{ business_date: string }>(
    'SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;
  return pollChannelMessages(pid(ctx), ctx.auth, today);
}, { perm: 'profiles.write' });

// ─── Templates ───────────────────────────────────────────────
router.get('/api/message-templates', (ctx: Ctx) =>
  ({ templates: listTemplates(pid(ctx)), mergeFields: mergeFields() }), { perm: 'profiles.read' });

router.post('/api/message-templates', (ctx: Ctx) => upsertTemplate(pid(ctx), ctx.auth, {
  code: slugCode(ctx.body.code ?? ctx.body.name, 'code'),
  name: str(ctx.body.name, 'name', { max: 60 }),
  body: str(ctx.body.body, 'body', { max: 4000 }),
  sortOrder: ctx.body.sortOrder,
  active: ctx.body.active,
}), { perm: 'profiles.write' });

router.patch('/api/message-templates/:id', (ctx: Ctx) => upsertTemplate(pid(ctx), ctx.auth, {
  id: ctx.params.id,
  code: slugCode(ctx.body.code ?? ctx.body.name, 'code'),
  name: str(ctx.body.name, 'name', { max: 60 }),
  body: str(ctx.body.body, 'body', { max: 4000 }),
  sortOrder: ctx.body.sortOrder,
  active: ctx.body.active,
}), { perm: 'profiles.write' });

router.delete('/api/message-templates/:id', (ctx: Ctx) =>
  deleteTemplate(pid(ctx), ctx.auth, ctx.params.id), { perm: 'profiles.write' });

/** Preview a template filled in for a real booking. */
router.post('/api/message-templates/render', (ctx: Ctx) => ({
  body: renderTemplate(pid(ctx), str(ctx.body.body, 'body', { max: 4000 }), ctx.body.reservationId),
}), { perm: 'profiles.read' });
