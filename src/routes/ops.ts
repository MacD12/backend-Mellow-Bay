// Housekeeping, maintenance, night audit, notifications, tasks, audit trail
// and universal search.
import { router, type Ctx } from '../lib/http.ts';
import { all, get, run, scalar } from '../db.ts';
import {
  id, nowIso, str, int, oneOf, boolIn, assertDate, addDays, notFound, HttpError,
} from '../lib/util.ts';
import {
  roomBoard, setRoomStatus, generateTasks, listTasks, updateTask, blockRoom, releaseBlock,
  listBlocks, createWorkOrder, listWorkOrders, updateWorkOrder, createLostFound, listLostFound,
  updateLostFound, discrepancies, forecast, ROOM_STATUSES,
} from '../services/housekeeping.ts';
import { preflight, runNightAudit, auditHistory, dailyReport, snapshotStats } from '../services/nightaudit.ts';
import { auditTrail, audit } from '../services/audit.ts';
import {
  listNotifications, notificationsSince, markRead, markAllRead,
} from '../services/notify.ts';

const pid = (ctx: Ctx) => ctx.auth.propertyId;
const businessDate = (ctx: Ctx) =>
  get<{ business_date: string }>('SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;
const dateParam = (ctx: Ctx) => ctx.query.get('date') ?? businessDate(ctx);

// ─── Housekeeping ────────────────────────────────────────────
router.get('/api/housekeeping/board', (ctx: Ctx) => ({
  date: dateParam(ctx),
  statuses: ROOM_STATUSES,
  rooms: roomBoard(pid(ctx), dateParam(ctx)),
}), { perm: 'housekeeping.read' });

router.post('/api/rooms/:id/status', (ctx: Ctx) =>
  setRoomStatus(pid(ctx), ctx.auth, ctx.params.id,
    str(ctx.body.status, 'status'), ctx.body.note),
{ perm: 'housekeeping.write' });

router.get('/api/housekeeping/tasks', (ctx: Ctx) => listTasks(pid(ctx), dateParam(ctx), {
  assigneeId: ctx.query.get('assigneeId') ?? undefined,
  status: ctx.query.get('status') ?? undefined,
}), { perm: 'housekeeping.read' });

router.post('/api/housekeeping/tasks/generate', (ctx: Ctx) =>
  generateTasks(pid(ctx), ctx.auth, ctx.body.date ?? businessDate(ctx)),
{ perm: 'housekeeping.write' });

router.patch('/api/housekeeping/tasks/:id', (ctx: Ctx) =>
  updateTask(pid(ctx), ctx.auth, ctx.params.id, {
    status: ctx.body.status,
    assigneeId: ctx.body.assigneeId,
    notes: ctx.body.notes,
    priority: ctx.body.priority,
  }), { perm: 'housekeeping.write' });

router.get('/api/housekeeping/discrepancies', (ctx: Ctx) =>
  discrepancies(pid(ctx), dateParam(ctx)), { perm: 'housekeeping.read' });

router.get('/api/housekeeping/forecast', (ctx: Ctx) =>
  forecast(pid(ctx), dateParam(ctx)), { perm: 'housekeeping.read' });

// ─── Room blocks (OOO / OOS) ─────────────────────────────────
router.get('/api/room-blocks', (ctx: Ctx) =>
  listBlocks(pid(ctx), ctx.query.get('all') !== 'true'), { perm: 'housekeeping.read' });

router.post('/api/room-blocks', (ctx: Ctx) => blockRoom(pid(ctx), ctx.auth, {
  roomId: str(ctx.body.roomId, 'roomId'),
  kind: oneOf(ctx.body.kind, 'kind', ['OOO', 'OOS'] as const, 'OOO'),
  fromDate: assertDate(ctx.body.fromDate, 'fromDate'),
  toDate: assertDate(ctx.body.toDate, 'toDate'),
  reason: str(ctx.body.reason, 'reason', { max: 200 }),
}), { perm: 'housekeeping.write' });

router.delete('/api/room-blocks/:id', (ctx: Ctx) =>
  releaseBlock(pid(ctx), ctx.auth, ctx.params.id), { perm: 'housekeeping.write' });

// ─── Work orders ─────────────────────────────────────────────
router.get('/api/work-orders', (ctx: Ctx) =>
  listWorkOrders(pid(ctx), ctx.query.get('status') ?? undefined), { perm: 'housekeeping.read' });

router.post('/api/work-orders', (ctx: Ctx) => createWorkOrder(pid(ctx), ctx.auth, {
  roomId: ctx.body.roomId ?? null,
  location: ctx.body.location,
  category: str(ctx.body.category ?? 'maintenance', 'category', { max: 40 }),
  priority: oneOf(ctx.body.priority, 'priority', ['low', 'normal', 'high'] as const, 'normal'),
  title: str(ctx.body.title, 'title', { max: 160 }),
  description: ctx.body.description,
  blocksRoom: boolIn(ctx.body.blocksRoom),
  assignedTo: ctx.body.assignedTo ?? null,
}), { perm: 'housekeeping.write' });

router.patch('/api/work-orders/:id', (ctx: Ctx) =>
  updateWorkOrder(pid(ctx), ctx.auth, ctx.params.id, {
    status: ctx.body.status, assignedTo: ctx.body.assignedTo,
    resolution: ctx.body.resolution, priority: ctx.body.priority,
  }), { perm: 'housekeeping.write' });

// ─── Lost & found ────────────────────────────────────────────
router.get('/api/lost-found', (ctx: Ctx) => listLostFound(pid(ctx)), { perm: 'housekeeping.read' });

router.post('/api/lost-found', (ctx: Ctx) => createLostFound(pid(ctx), ctx.auth, {
  roomId: ctx.body.roomId ?? null,
  foundOn: ctx.body.foundOn ?? businessDate(ctx),
  description: str(ctx.body.description, 'description', { max: 300 }),
  storageRef: ctx.body.storageRef,
  note: ctx.body.note,
}), { perm: 'housekeeping.write' });

router.patch('/api/lost-found/:id', (ctx: Ctx) =>
  updateLostFound(pid(ctx), ctx.auth, ctx.params.id, {
    status: ctx.body.status, note: ctx.body.note, profileId: ctx.body.profileId,
  }), { perm: 'housekeeping.write' });

// ─── Night audit ─────────────────────────────────────────────
router.get('/api/night-audit/preflight', (ctx: Ctx) => preflight(pid(ctx)), { perm: 'nightaudit.read' });

router.post('/api/night-audit/run', (ctx: Ctx) => runNightAudit(pid(ctx), ctx.auth, {
  force: boolIn(ctx.body.force),
  noShowChargePolicy: ctx.body.noShowChargePolicy,
}), { perm: 'nightaudit.run' });

router.get('/api/night-audit/history', (ctx: Ctx) =>
  auditHistory(pid(ctx), int(ctx.query.get('limit') ?? 30, 'limit', { min: 1, max: 365 })),
{ perm: 'nightaudit.read' });

router.get('/api/night-audit/report', (ctx: Ctx) =>
  dailyReport(pid(ctx), ctx.query.get('date') ?? addDays(businessDate(ctx), -1)),
{ perm: 'nightaudit.read' });

router.post('/api/night-audit/snapshot', (ctx: Ctx) =>
  snapshotStats(pid(ctx), ctx.body.date ?? businessDate(ctx)), { perm: 'nightaudit.run' });

// ─── Notifications ───────────────────────────────────────────
router.get('/api/notifications', (ctx: Ctx) => listNotifications(pid(ctx), ctx.auth.userId, {
  source: ctx.query.get('source') ?? undefined,
  severity: ctx.query.get('severity') ?? undefined,
  unreadOnly: ctx.query.get('unread') === '1',
  limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
}), { perm: 'dashboard.read' });

/**
 * Only what is new.
 *
 * The bell polls this on a short interval, so it stays cheap: a range scan that
 * returns nothing most of the time, rather than the last hundred rows
 * re-serialised every few seconds.
 */
router.get('/api/notifications/since', (ctx: Ctx) => ({
  notifications: notificationsSince(
    pid(ctx), ctx.auth.userId, str(ctx.query.get('since'), 'since'),
  ),
  now: nowIso(),
}), { perm: 'dashboard.read' });

router.post('/api/notifications/:id/read', (ctx: Ctx) =>
  markRead(pid(ctx), ctx.params.id), { perm: 'dashboard.read' });

router.post('/api/notifications/read-all', (ctx: Ctx) =>
  markAllRead(pid(ctx), ctx.auth.userId, ctx.body.source), { perm: 'dashboard.read' });

// ─── Tasks ───────────────────────────────────────────────────
router.get('/api/tasks', (ctx: Ctx) => all<any>(
  `SELECT t.*, u.name AS assignee_name FROM tasks t
     LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.property_id = ? AND t.status = ?
    ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.due_at`,
  pid(ctx), ctx.query.get('status') ?? 'open',
).map((t) => ({
  id: t.id, title: t.title, category: t.category, dueAt: t.due_at,
  assigneeId: t.assignee_id, assignee: t.assignee_name ?? 'Unassigned',
  priority: t.priority, status: t.status, link: t.link, createdAt: t.created_at,
})), { perm: 'dashboard.read' });

router.post('/api/tasks', (ctx: Ctx) => {
  const tId = id('tsk');
  run(
    `INSERT INTO tasks(id, property_id, title, category, due_at, assignee_id, priority, status,
                       link, created_by, created_at)
     VALUES(?,?,?,?,?,?,?,'open',?,?,?)`,
    tId, pid(ctx), str(ctx.body.title, 'title', { max: 200 }),
    ctx.body.category ?? 'Front Office', ctx.body.dueAt ?? null,
    ctx.body.assigneeId ?? ctx.auth.userId,
    oneOf(ctx.body.priority, 'priority', ['low', 'normal', 'high'] as const, 'normal'),
    ctx.body.link ?? null, ctx.auth.userName, nowIso(),
  );
  return { id: tId };
}, { perm: 'dashboard.read' });

router.patch('/api/tasks/:id', (ctx: Ctx) => {
  run(`UPDATE tasks SET status = COALESCE(?, status), assignee_id = COALESCE(?, assignee_id),
         priority = COALESCE(?, priority),
         done_at = CASE WHEN ? = 'done' THEN ? ELSE done_at END
        WHERE id = ? AND property_id = ?`,
    ctx.body.status ?? null, ctx.body.assigneeId ?? null, ctx.body.priority ?? null,
    ctx.body.status ?? '', nowIso(), ctx.params.id, pid(ctx));
  return { ok: true };
}, { perm: 'dashboard.read' });

// ─── Audit trail ─────────────────────────────────────────────
router.get('/api/audit-log', (ctx: Ctx) => auditTrail(pid(ctx), {
  entity: ctx.query.get('entity') ?? undefined,
  entityId: ctx.query.get('entityId') ?? undefined,
  since: ctx.query.get('since') ?? undefined,
  limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : 200,
}).map((a) => ({
  id: a.id, ts: a.ts, user: a.user_name, action: a.action, entity: a.entity,
  entityId: a.entity_id, entityRef: a.entity_ref, channel: a.channel,
  before: a.before_json ? JSON.parse(a.before_json) : null,
  after: a.after_json ? JSON.parse(a.after_json) : null,
  ip: a.ip, elevated: a.elevated === 1,
})), { perm: 'reports.read' });

// ─── Universal search ────────────────────────────────────────
router.get('/api/search', (ctx: Ctx) => {
  const q = (ctx.query.get('q') ?? '').trim();
  if (q.length < 2) return { query: q, results: [] };
  const like = `%${q}%`;

  const reservations = all<any>(
    `SELECT r.id, r.confirmation, r.guest_name, r.arrival, r.departure, r.status,
            rm.number AS room_number
       FROM reservations r LEFT JOIN rooms rm ON rm.id = r.room_id
      WHERE r.property_id = ?
        AND (r.guest_name LIKE ? OR r.confirmation LIKE ? OR r.email LIKE ?
             OR r.phone LIKE ? OR r.ota_reference LIKE ?)
      ORDER BY r.arrival DESC LIMIT 15`,
    pid(ctx), like, like, like, like, like,
  ).map((r) => ({
    kind: 'reservation', id: r.id,
    title: `${r.guest_name} · ${r.confirmation}`,
    subtitle: `${r.arrival} → ${r.departure} · ${r.status}${r.room_number ? ` · Room ${r.room_number}` : ''}`,
  }));

  const profiles = all<any>(
    `SELECT id, name, email, phone, loyalty_tier FROM profiles
      WHERE property_id = ? AND merged_into IS NULL
        AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)
      ORDER BY name LIMIT 10`,
    pid(ctx), like, like, like,
  ).map((p) => ({
    kind: 'profile', id: p.id, title: p.name,
    subtitle: [p.email, p.phone, p.loyalty_tier !== 'None' ? p.loyalty_tier : null].filter(Boolean).join(' · '),
  }));

  const rooms = all<any>(
    `SELECT r.id, r.number, r.status, rt.name AS room_type_name FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.property_id = ? AND r.number LIKE ? ORDER BY r.number LIMIT 10`,
    pid(ctx), like,
  ).map((r) => ({
    kind: 'room', id: r.id, title: `Room ${r.number}`,
    subtitle: `${r.room_type_name} · ${r.status}`,
  }));

  const companies = all<any>(
    `SELECT id, code, name FROM companies WHERE property_id = ? AND (name LIKE ? OR code LIKE ?)
      ORDER BY name LIMIT 10`,
    pid(ctx), like, like,
  ).map((c) => ({ kind: 'company', id: c.id, title: c.name, subtitle: c.code }));

  const groups = all<any>(
    `SELECT id, code, name, arrival FROM groups WHERE property_id = ? AND (name LIKE ? OR code LIKE ?)
      ORDER BY arrival DESC LIMIT 10`,
    pid(ctx), like, like,
  ).map((g) => ({ kind: 'group', id: g.id, title: g.name, subtitle: `${g.code} · ${g.arrival}` }));

  return { query: q, results: [...reservations, ...profiles, ...rooms, ...companies, ...groups] };
}, { perm: 'reservations.read' });
