// Reservations and the front-desk day: arrivals, check-in, in-house,
// departures, check-out, walk-ins, room moves, groups and the waitlist.
import { router, type Ctx } from '../lib/http.ts';
import { all, get, run, tx, scalar, jsonCol, parseJson } from '../db.ts';
import {
  id, nowIso, str, int, money, boolIn, oneOf, assertDate, addDays, slugCode,
  HttpError, notFound, nightsBetween, dateRangeInclusive,
} from '../lib/util.ts';
import {
  createReservation, updateReservation, cancelReservation, listReservations,
  getReservationDetail, assignRoom, moveRoom, checkIn, checkOut, markNoShow,
  addNote, createWalkIn, postOutstandingNights, findOrCreateProfile,
} from '../services/reservations.ts';
import { previewStayChange, changeStayDates } from '../services/staydates.ts';
import {
  reportToChannel, reportEligibility, reportState, unreportedNoShows,
  REPORT_KINDS, type ReportKind,
} from '../services/channelreports.ts';
import { frontDeskLists } from '../services/reports.ts';
import {
  listDocuments, storeDocument, readDocument, deleteDocument, type DocumentKind,
} from '../services/documents.ts';
import { openFolio } from '../services/folio.ts';
import { audit } from '../services/audit.ts';

const pid = (ctx: Ctx) => ctx.auth.propertyId;
const actor = (ctx: Ctx) => ctx.auth;
const businessDate = (ctx: Ctx) =>
  get<{ business_date: string }>('SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;

// ─── List / read ─────────────────────────────────────────────
router.get('/api/reservations', (ctx: Ctx) => {
  const q = ctx.query;
  const statuses = q.get('status')?.split(',').filter(Boolean);
  return listReservations(pid(ctx), {
    status: statuses,
    arrivalFrom: q.get('arrivalFrom') ?? undefined,
    arrivalTo: q.get('arrivalTo') ?? undefined,
    arrivalOn: q.get('arrivalOn') ?? undefined,
    departureOn: q.get('departureOn') ?? undefined,
    inHouseOn: q.get('inHouseOn') ?? undefined,
    search: q.get('search') ?? undefined,
    roomTypeId: q.get('roomTypeId') ?? undefined,
    groupId: q.get('groupId') ?? undefined,
    companyId: q.get('companyId') ?? undefined,
    profileId: q.get('profileId') ?? undefined,
    channelCode: q.get('channelCode') ?? undefined,
    limit: q.get('limit') ? Number(q.get('limit')) : undefined,
    offset: q.get('offset') ? Number(q.get('offset')) : undefined,
  });
}, { perm: 'reservations.read' });

router.get('/api/reservations/:id', (ctx: Ctx) =>
  getReservationDetail(pid(ctx), ctx.params.id), { perm: 'reservations.read' });

// ─── Create / amend ──────────────────────────────────────────
function readCreateInput(ctx: Ctx) {
  const b = ctx.body;
  return {
    guestName: str(b.guestName, 'guestName', { max: 120 }),
    email: b.email ? String(b.email) : undefined,
    phone: b.phone ? String(b.phone) : undefined,
    profileId: b.profileId ?? null,
    arrival: assertDate(b.arrival, 'arrival'),
    departure: assertDate(b.departure, 'departure'),
    adults: int(b.adults ?? 1, 'adults', { min: 1, max: 40 }),
    children: int(b.children ?? 0, 'children', { min: 0, max: 20 }),
    roomTypeId: str(b.roomTypeId, 'roomTypeId'),
    ratePlanId: str(b.ratePlanId, 'ratePlanId'),
    roomId: b.roomId ?? null,
    bedId: b.bedId ?? null,
    status: b.status ? oneOf(b.status, 'status',
      ['Tentative', 'Confirmed', 'Guaranteed'] as const) : 'Confirmed',
    source: b.source ?? 'Direct',
    channelCode: b.channelCode ?? null,
    otaReference: b.otaReference ?? null,
    segment: b.segment ?? null,
    companyId: b.companyId ?? null,
    groupId: b.groupId ?? null,
    vip: boolIn(b.vip),
    eta: b.eta ?? null,
    etd: b.etd ?? null,
    specialRequests: b.specialRequests ?? null,
    preferences: Array.isArray(b.preferences) ? b.preferences : [],
    paymentMethod: b.paymentMethod ?? null,
    cardLast4: b.cardLast4 ?? null,
    promotionCode: b.promotionCode ?? null,
    rateOverrideMinor: b.rateOverrideMinor === undefined || b.rateOverrideMinor === null
      ? null : money(b.rateOverrideMinor, 'rateOverrideMinor'),
    overrideReason: b.overrideReason ?? null,
    depositRequiredMinor: b.depositRequiredMinor === undefined
      ? null : money(b.depositRequiredMinor, 'depositRequiredMinor'),
    commissionMinor: b.commissionMinor === undefined ? null : money(b.commissionMinor, 'commissionMinor'),
    force: boolIn(b.force),
  };
}

router.post('/api/reservations', (ctx: Ctx) => {
  const input = readCreateInput(ctx);
  // Overriding the rate or forcing past availability is a supervisor action.
  if ((input.rateOverrideMinor !== null || input.force)
      && !['admin', 'manager', 'revenue', 'reservations'].includes(ctx.auth.role)) {
    throw new HttpError(403, 'Your role cannot override rates or availability', 'forbidden');
  }
  return createReservation(pid(ctx), actor(ctx), input);
}, { perm: 'reservations.write' });

router.patch('/api/reservations/:id', (ctx: Ctx) => {
  const b = ctx.body;
  return updateReservation(pid(ctx), actor(ctx), ctx.params.id, {
    guestName: b.guestName, email: b.email, phone: b.phone,
    arrival: b.arrival, departure: b.departure,
    adults: b.adults, children: b.children,
    roomTypeId: b.roomTypeId, ratePlanId: b.ratePlanId,
    status: b.status, segment: b.segment, source: b.source,
    vip: b.vip, eta: b.eta, etd: b.etd,
    specialRequests: b.specialRequests, preferences: b.preferences,
    paymentMethod: b.paymentMethod, companyId: b.companyId,
    rateOverrideMinor: b.rateOverrideMinor === undefined || b.rateOverrideMinor === null
      ? undefined : money(b.rateOverrideMinor, 'rateOverrideMinor'),
    overrideReason: b.overrideReason,
    depositRequiredMinor: b.depositRequiredMinor,
    force: boolIn(b.force),
  });
}, { perm: 'reservations.write' });

router.post('/api/reservations/:id/cancel', (ctx: Ctx) =>
  cancelReservation(pid(ctx), actor(ctx), ctx.params.id, {
    reason: str(ctx.body.reason, 'reason', { max: 200 }),
    chargeMinor: ctx.body.chargeMinor === undefined ? 0 : money(ctx.body.chargeMinor, 'chargeMinor'),
  }), { perm: 'reservations.write' });

router.post('/api/reservations/:id/no-show', (ctx: Ctx) =>
  markNoShow(pid(ctx), actor(ctx), ctx.params.id, {
    chargeMinor: ctx.body.chargeMinor === undefined ? undefined : money(ctx.body.chargeMinor, 'chargeMinor'),
  }), { perm: 'frontdesk.write' });

// ─── Telling the channel what happened ───────────────────────
// Marking a no-show is the property's side. Until the channel is told, the OTA
// still believes the guest arrived — so these sit next to it rather than in the
// channel manager, which is not where the decision is made.

const reportKind = (v: unknown): ReportKind =>
  oneOf(v ?? 'no_show', 'kind', REPORT_KINDS as unknown as readonly string[]) as ReportKind;

router.get('/api/reservations/:id/channel-report', (ctx: Ctx) =>
  reportState(pid(ctx), ctx.params.id, businessDate(ctx)), { perm: 'reservations.read' });

router.get('/api/reservations/:id/channel-report/eligibility', (ctx: Ctx) =>
  reportEligibility(pid(ctx), ctx.params.id,
    reportKind(ctx.query.get('kind')), businessDate(ctx)), { perm: 'reservations.read' });

/** Retryable by design — calling it again after a failure is the retry. */
router.post('/api/reservations/:id/channel-report', async (ctx: Ctx) =>
  reportToChannel(pid(ctx), actor(ctx), ctx.params.id,
    reportKind(ctx.body.kind), businessDate(ctx)), { perm: 'frontdesk.write' });

/** The work list: no-shows the channel has not been told about. */
router.get('/api/channel-reports/pending', (ctx: Ctx) =>
  unreportedNoShows(pid(ctx), businessDate(ctx)), { perm: 'reservations.read' });

router.post('/api/reservations/:id/notes', (ctx: Ctx) =>
  addNote(pid(ctx), actor(ctx), ctx.params.id,
    str(ctx.body.body, 'body', { max: 2000 }), ctx.body.category ?? 'general'),
{ perm: 'reservations.write' });

// ─── Rooms ───────────────────────────────────────────────────
router.post('/api/reservations/:id/assign-room', (ctx: Ctx) =>
  assignRoom(pid(ctx), actor(ctx), ctx.params.id, {
    roomId: ctx.body.roomId ?? null,
    bedId: ctx.body.bedId ?? null,
    fromDate: ctx.body.fromDate,
    auto: boolIn(ctx.body.auto),
  }), { perm: 'frontdesk.write' });

router.post('/api/reservations/:id/move-room', (ctx: Ctx) =>
  moveRoom(pid(ctx), actor(ctx), ctx.params.id, {
    roomId: str(ctx.body.roomId, 'roomId'),
    fromDate: ctx.body.fromDate,
    reason: ctx.body.reason,
    keepRate: boolIn(ctx.body.keepRate, true),
  }), { perm: 'frontdesk.write' });

// ─── Extending and shortening a stay ─────────────────────────
// The preview is a GET so it can be called freely as the operator types a date
// — it writes nothing and holds nothing.
router.get('/api/reservations/:id/stay-preview', (ctx: Ctx) =>
  previewStayChange(pid(ctx), ctx.params.id, {
    arrival: ctx.query.get('arrival') ?? undefined,
    departure: ctx.query.get('departure') ?? undefined,
  }), { perm: 'reservations.read' });

router.post('/api/reservations/:id/stay-dates', (ctx: Ctx) =>
  changeStayDates(pid(ctx), actor(ctx), ctx.params.id, {
    arrival: ctx.body.arrival,
    departure: ctx.body.departure,
    roomId: ctx.body.roomId ?? undefined,
    releaseRoom: ctx.body.releaseRoom === true,
    reason: ctx.body.reason ? str(ctx.body.reason, 'reason', { max: 200 }) : undefined,
  }), { perm: 'reservations.write' });

// ─── Front desk transitions ──────────────────────────────────
router.post('/api/reservations/:id/check-in', (ctx: Ctx) =>
  checkIn(pid(ctx), actor(ctx), ctx.params.id, {
    roomId: ctx.body.roomId,
    bedId: ctx.body.bedId,
    paymentMinor: ctx.body.paymentMinor === undefined ? undefined : money(ctx.body.paymentMinor, 'paymentMinor'),
    paymentMethod: ctx.body.paymentMethod,
    idNumber: ctx.body.idNumber,
    idType: ctx.body.idType,
    registered: boolIn(ctx.body.registered, true),
  }), { perm: 'frontdesk.write' });

router.post('/api/reservations/:id/check-out', (ctx: Ctx) =>
  checkOut(pid(ctx), actor(ctx), ctx.params.id, {
    allowBalance: boolIn(ctx.body.allowBalance),
    toCityLedger: boolIn(ctx.body.toCityLedger),
  }), { perm: 'frontdesk.write' });

router.post('/api/reservations/:id/post-due-nights', (ctx: Ctx) => {
  const posted = postOutstandingNights(pid(ctx), actor(ctx), ctx.params.id, businessDate(ctx));
  return { posted };
}, { perm: 'folio.post' });

router.post('/api/walk-in', (ctx: Ctx) =>
  createWalkIn(pid(ctx), actor(ctx), readCreateInput(ctx)), { perm: 'frontdesk.write' });

// ─── The day's lists ─────────────────────────────────────────
router.get('/api/front-desk', (ctx: Ctx) =>
  frontDeskLists(pid(ctx), ctx.query.get('date') ?? businessDate(ctx)),
{ perm: 'frontdesk.read' });

// ─── Guests on a reservation (sharers, registration) ─────────
router.post('/api/reservations/:id/guests', (ctx: Ctx) => {
  const name = str(ctx.body.name, 'name', { max: 120 });
  const gId = id('rg');
  const profileId = ctx.body.createProfile
    ? findOrCreateProfile(pid(ctx), actor(ctx), { name, email: ctx.body.email })
    : ctx.body.profileId ?? null;
  run(
    `INSERT INTO reservation_guests(id, reservation_id, profile_id, name, is_primary, kind,
                                    registered, id_number, created_at)
     VALUES(?,?,?,?,0,?,?,?,?)`,
    gId, ctx.params.id, profileId, name,
    oneOf(ctx.body.kind, 'kind', ['adult', 'child'] as const, 'adult'),
    boolIn(ctx.body.registered) ? 1 : 0, ctx.body.idNumber ?? null, nowIso(),
  );
  return { id: gId };
}, { perm: 'reservations.write' });

// ─── Registration documents ──────────────────────────────────
//
// The identity scan and the signature taken at check-in. Listing returns
// metadata only; fetching the image is a separate call so that reading a
// guest's passport is a deliberate act with its own audit entry rather than a
// side effect of opening a screen.
router.get('/api/reservations/:id/documents', (ctx: Ctx) =>
  listDocuments(pid(ctx), ctx.params.id), { perm: 'reservations.read' });

router.post('/api/reservations/:id/documents', (ctx: Ctx) => {
  const b = ctx.body;
  // Accepts either a bare base64 payload or a full data URL, because the
  // browser produces the latter and stripping it there is one more thing to
  // get wrong.
  const raw = str(b.data, 'data');
  const comma = raw.indexOf(',');
  const dataBase64 = raw.startsWith('data:') && comma > 0 ? raw.slice(comma + 1) : raw;
  return storeDocument(pid(ctx), actor(ctx), ctx.params.id, {
    kind: oneOf(b.kind, 'kind', ['identity', 'signature'] as const) as DocumentKind,
    mime: str(b.mime, 'mime', { max: 60 }),
    dataBase64,
    label: b.label ? str(b.label, 'label', { max: 60 }) : undefined,
    guestName: b.guestName ? str(b.guestName, 'guestName', { max: 120 }) : undefined,
  });
}, { perm: 'reservations.write' });

router.get('/api/documents/:documentId', (ctx: Ctx) =>
  readDocument(pid(ctx), actor(ctx), ctx.params.documentId), { perm: 'reservations.read' });

router.delete('/api/documents/:documentId', (ctx: Ctx) => {
  deleteDocument(pid(ctx), actor(ctx), ctx.params.documentId);
}, { perm: 'reservations.write' });

router.delete('/api/reservations/:id/guests/:guestId', (ctx: Ctx) => {
  run('DELETE FROM reservation_guests WHERE id = ? AND reservation_id = ? AND is_primary = 0',
    ctx.params.guestId, ctx.params.id);
  return { ok: true };
}, { perm: 'reservations.write' });

// ─── Groups & blocks ─────────────────────────────────────────
router.get('/api/groups', (ctx: Ctx) => all<any>(
  `SELECT g.*, c.name AS company_name, rp.code AS rate_plan_code
     FROM groups g LEFT JOIN companies c ON c.id = g.company_id
     LEFT JOIN rate_plans rp ON rp.id = g.rate_plan_id
    WHERE g.property_id = ? ORDER BY g.arrival DESC`,
  pid(ctx),
).map((g) => {
  const blocked = scalar<number>(
    'SELECT COALESCE(SUM(blocked),0) AS n FROM group_blocks WHERE group_id = ?', g.id);
  const pickedUp = scalar<number>(
    `SELECT count(*) AS n FROM reservation_nights n JOIN reservations r ON r.id = n.reservation_id
      WHERE r.group_id = ? AND r.status IN ('Tentative','Confirmed','Guaranteed','Checked-in','Checked-out')`,
    g.id);
  const rooms = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE group_id = ? AND status <> 'Cancelled'`, g.id);
  return {
    id: g.id, code: g.code, name: g.name, companyId: g.company_id, company: g.company_name,
    contactName: g.contact_name, contactEmail: g.contact_email, contactPhone: g.contact_phone,
    arrival: g.arrival, departure: g.departure, cutoffDate: g.cutoff_date,
    ratePlanId: g.rate_plan_id, ratePlanCode: g.rate_plan_code, status: g.status,
    masterFolio: g.master_folio === 1, notes: g.notes,
    blockedNights: blocked, pickedUpNights: pickedUp, reservations: rooms,
    pickupBp: blocked > 0 ? Math.round((pickedUp / blocked) * 10_000) : 0,
  };
}), { perm: 'groups.read' });

router.post('/api/groups', (ctx: Ctx) => tx(() => {
  const b = ctx.body;
  const gId = id('grp');
  const arrival = assertDate(b.arrival, 'arrival');
  const departure = assertDate(b.departure, 'departure');
  run(
    `INSERT INTO groups(id, property_id, code, name, company_id, contact_name, contact_email,
                        contact_phone, arrival, departure, cutoff_date, rate_plan_id, status,
                        master_folio, notes, created_by, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    gId, pid(ctx), slugCode(b.code, 'code', 20), str(b.name, 'name', { max: 120 }),
    b.companyId ?? null, b.contactName ?? null, b.contactEmail ?? null, b.contactPhone ?? null,
    arrival, departure, b.cutoffDate ?? null, b.ratePlanId ?? null,
    oneOf(b.status, 'status', ['tentative', 'definite', 'cancelled', 'closed'] as const, 'tentative'),
    boolIn(b.masterFolio, true) ? 1 : 0, b.notes ?? null, ctx.auth.userName, nowIso(),
  );
  // Optional initial block: [{ roomTypeId, rooms, rateMinor }]
  for (const blk of b.blocks ?? []) {
    for (const date of dateRangeInclusive(arrival, addDays(departure, -1))) {
      run(
        `INSERT INTO group_blocks(id, group_id, room_type_id, date, blocked, rate_minor)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(group_id, room_type_id, date) DO UPDATE SET
           blocked = excluded.blocked, rate_minor = excluded.rate_minor`,
        id('gbl'), gId, blk.roomTypeId, date,
        int(blk.rooms, 'rooms', { min: 0, max: 500 }),
        money(blk.rateMinor ?? 0, 'rateMinor'),
      );
    }
  }
  if (boolIn(b.masterFolio, true)) {
    openFolio(pid(ctx), { groupId: gId, companyId: b.companyId ?? null, name: `${b.name} — master`, type: 'master' });
  }
  audit(ctx.auth, {
    action: 'group.create', entity: 'GROUP', entityId: gId, entityRef: b.code, after: b,
  }, ctx.ip);
  return { id: gId };
}), { perm: 'groups.write' });

router.get('/api/groups/:id', (ctx: Ctx) => {
  const g = get<any>('SELECT * FROM groups WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  if (!g) notFound('Group');
  const blocks = all<any>(
    `SELECT gb.*, rt.name AS room_type_name, rt.code AS room_type_code
       FROM group_blocks gb JOIN room_types rt ON rt.id = gb.room_type_id
      WHERE gb.group_id = ? ORDER BY gb.date, rt.name`,
    ctx.params.id,
  );
  const pickup = all<any>(
    `SELECT n.room_type_id, n.date, count(*) AS picked
       FROM reservation_nights n JOIN reservations r ON r.id = n.reservation_id
      WHERE r.group_id = ? AND r.status <> 'Cancelled'
      GROUP BY n.room_type_id, n.date`,
    ctx.params.id,
  );
  const pickMap = new Map(pickup.map((p) => [`${p.room_type_id}|${p.date}`, p.picked]));
  return {
    id: g.id, code: g.code, name: g.name, arrival: g.arrival, departure: g.departure,
    cutoffDate: g.cutoff_date, status: g.status, notes: g.notes,
    blocks: blocks.map((b) => ({
      id: b.id, roomTypeId: b.room_type_id, roomType: b.room_type_name,
      roomTypeCode: b.room_type_code, date: b.date, blocked: b.blocked,
      rateMinor: b.rate_minor, pickedUp: pickMap.get(`${b.room_type_id}|${b.date}`) ?? 0,
    })),
    reservations: listReservations(pid(ctx), { groupId: ctx.params.id }),
    folios: all<any>('SELECT * FROM folios WHERE group_id = ?', ctx.params.id).map((f) => ({
      id: f.id, number: f.number, name: f.name, type: f.type, status: f.status,
    })),
  };
}, { perm: 'groups.read' });

router.post('/api/groups/:id/blocks', (ctx: Ctx) => tx(() => {
  const b = ctx.body;
  const from = assertDate(b.from, 'from');
  const to = assertDate(b.to, 'to');
  let n = 0;
  for (const date of dateRangeInclusive(from, to)) {
    run(
      `INSERT INTO group_blocks(id, group_id, room_type_id, date, blocked, rate_minor)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(group_id, room_type_id, date) DO UPDATE SET
         blocked = excluded.blocked, rate_minor = excluded.rate_minor`,
      id('gbl'), ctx.params.id, str(b.roomTypeId, 'roomTypeId'), date,
      int(b.rooms, 'rooms', { min: 0, max: 500 }), money(b.rateMinor ?? 0, 'rateMinor'),
    );
    n++;
  }
  audit(ctx.auth, { action: 'group.block', entity: 'GROUP', entityId: ctx.params.id, after: b }, ctx.ip);
  return { updated: n };
}), { perm: 'groups.write' });

/** Rooming list upload — bulk-create the group's individual reservations. */
router.post('/api/groups/:id/rooming-list', (ctx: Ctx) => tx(() => {
  const group = get<any>('SELECT * FROM groups WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  if (!group) notFound('Group');
  const rows: any[] = ctx.body.rows ?? [];
  if (!rows.length) throw new HttpError(400, 'rooming list is empty');
  const created: any[] = [];
  const failed: any[] = [];
  for (const row of rows) {
    try {
      const res = createReservation(pid(ctx), actor(ctx), {
        guestName: str(row.guestName, 'guestName', { max: 120 }),
        email: row.email, phone: row.phone,
        arrival: row.arrival ?? group.arrival,
        departure: row.departure ?? group.departure,
        adults: int(row.adults ?? 1, 'adults', { min: 1, max: 20 }),
        children: int(row.children ?? 0, 'children', { min: 0, max: 20 }),
        roomTypeId: str(row.roomTypeId, 'roomTypeId'),
        ratePlanId: row.ratePlanId ?? group.rate_plan_id,
        groupId: group.id,
        status: 'Confirmed',
        source: 'Group',
        segment: 'Group',
        rateOverrideMinor: row.rateMinor === undefined ? null : money(row.rateMinor, 'rateMinor'),
        // Rooms are already held by the group block.
        force: true,
      });
      created.push({ guest: row.guestName, id: res.id, confirmation: res.confirmation });
    } catch (e) {
      failed.push({ guest: row.guestName, error: e instanceof Error ? e.message : String(e) });
    }
  }
  audit(ctx.auth, {
    action: 'group.rooming-list', entity: 'GROUP', entityId: group.id, entityRef: group.code,
    after: { created: created.length, failed: failed.length },
  }, ctx.ip);
  return { created, failed };
}), { perm: 'groups.write' });

// ─── Waitlist ────────────────────────────────────────────────
router.get('/api/waitlist', (ctx: Ctx) => all<any>(
  `SELECT w.*, rt.name AS room_type_name FROM waitlist w
     LEFT JOIN room_types rt ON rt.id = w.room_type_id
    WHERE w.property_id = ? AND w.status = ? ORDER BY w.arrival`,
  pid(ctx), ctx.query.get('status') ?? 'waiting',
).map((w) => ({
  id: w.id, guest: w.guest_name, email: w.email, phone: w.phone,
  arrival: w.arrival, departure: w.departure, roomTypeId: w.room_type_id,
  roomType: w.room_type_name, adults: w.adults, children: w.children,
  status: w.status, note: w.note, createdAt: w.created_at,
})), { perm: 'reservations.read' });

router.post('/api/waitlist', (ctx: Ctx) => {
  const b = ctx.body;
  const wId = id('wl');
  run(
    `INSERT INTO waitlist(id, property_id, guest_name, email, phone, arrival, departure,
                          room_type_id, adults, children, status, note, created_by, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,'waiting',?,?,?)`,
    wId, pid(ctx), str(b.guestName, 'guestName', { max: 120 }), b.email ?? null, b.phone ?? null,
    assertDate(b.arrival, 'arrival'), assertDate(b.departure, 'departure'),
    b.roomTypeId ?? null, int(b.adults ?? 1, 'adults', { min: 1 }),
    int(b.children ?? 0, 'children', { min: 0 }), b.note ?? null, ctx.auth.userName, nowIso(),
  );
  audit(ctx.auth, { action: 'waitlist.add', entity: 'WAITLIST', entityId: wId, entityRef: b.guestName }, ctx.ip);
  return { id: wId };
}, { perm: 'reservations.write' });

router.patch('/api/waitlist/:id', (ctx: Ctx) => {
  run(`UPDATE waitlist SET status = ?, note = COALESCE(?, note),
         resolved_at = CASE WHEN ? IN ('converted','expired') THEN ? ELSE resolved_at END
        WHERE id = ? AND property_id = ?`,
    str(ctx.body.status, 'status'), ctx.body.note ?? null,
    ctx.body.status, nowIso(), ctx.params.id, pid(ctx));
  return { ok: true };
}, { perm: 'reservations.write' });
