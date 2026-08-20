// ─────────────────────────────────────────────────────────────
// Housekeeping & maintenance: the room status board, daily task sheet,
// inspection flow, out-of-order blocks, work orders and lost & found.
//
// Room status is derived-checked against the reservation ledger, so a
// front-office / housekeeping discrepancy is detected rather than assumed.
// ─────────────────────────────────────────────────────────────
import { all, get, run, tx } from '../db.ts';
import { id, nowIso, HttpError, addDays, notFound } from '../lib/util.ts';
import { audit } from './audit.ts';
import type { Actor } from './reservations.ts';

export const ROOM_STATUSES = [
  'Vacant Clean', 'Vacant Dirty', 'Vacant Inspected',
  'Occupied Clean', 'Occupied Dirty', 'Out of Order', 'Out of Service',
] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

const LIVE = `('Tentative','Confirmed','Guaranteed','Checked-in')`;

export interface BoardRoom {
  id: string; number: string; floor: number; roomTypeId: string; roomType: string;
  status: string; hkSection: string | null; attendant: string | null;
  lastCleaned: string | null; notes: string | null;
  occupied: boolean; guest: string | null; reservationId: string | null;
  departing: boolean; arriving: boolean; arrivalGuest: string | null;
  discrepancy: string | null; blocked: { kind: string; reason: string | null; to: string } | null;
  openWorkOrders: number;
  task: { id: string; type: string; status: string; assignee: string | null; priority: string } | null;
}

export function roomBoard(propertyId: string, date: string): BoardRoom[] {
  const rooms = all<any>(
    `SELECT r.*, rt.name AS room_type_name, u.name AS attendant_name
       FROM rooms r
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN users u ON u.id = r.attendant_id
      WHERE r.property_id = ? AND r.active = 1
      ORDER BY r.floor, r.number`,
    propertyId,
  );

  const inHouse = new Map<string, any>();
  for (const r of all<any>(
    `SELECT id, room_id, guest_name, departure, status FROM reservations
      WHERE property_id = ? AND status = 'Checked-in' AND room_id IS NOT NULL`,
    propertyId,
  )) inHouse.set(r.room_id, r);

  const arrivals = new Map<string, any>();
  for (const r of all<any>(
    `SELECT id, room_id, guest_name FROM reservations
      WHERE property_id = ? AND arrival = ? AND room_id IS NOT NULL
        AND status IN ('Tentative','Confirmed','Guaranteed')`,
    propertyId, date,
  )) arrivals.set(r.room_id, r);

  const blocks = new Map<string, any>();
  for (const b of all<any>(
    `SELECT * FROM room_blocks WHERE property_id = ? AND released_at IS NULL
       AND from_date <= ? AND to_date > ?`,
    propertyId, date, date,
  )) blocks.set(b.room_id, b);

  const tasks = new Map<string, any>();
  for (const t of all<any>(
    `SELECT t.*, u.name AS assignee_name FROM hk_tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.property_id = ? AND t.date = ?`,
    propertyId, date,
  )) tasks.set(t.room_id, t);

  const woCounts = new Map<string, number>();
  for (const w of all<{ room_id: string; n: number }>(
    `SELECT room_id, count(*) AS n FROM work_orders
      WHERE property_id = ? AND status NOT IN ('resolved','closed') AND room_id IS NOT NULL
      GROUP BY room_id`,
    propertyId,
  )) woCounts.set(w.room_id, w.n);

  return rooms.map((r) => {
    const res = inHouse.get(r.id);
    const arr = arrivals.get(r.id);
    const block = blocks.get(r.id);
    const t = tasks.get(r.id);
    const statusOccupied = r.status.startsWith('Occupied');

    let discrepancy: string | null = null;
    if (res && !statusOccupied && !['Out of Order', 'Out of Service'].includes(r.status)) {
      discrepancy = `Front office shows ${res.guest_name} in-house, housekeeping shows ${r.status}`;
    } else if (!res && statusOccupied) {
      discrepancy = 'Housekeeping shows the room occupied but no guest is checked in';
    }

    return {
      id: r.id,
      number: r.number,
      floor: r.floor,
      roomTypeId: r.room_type_id,
      roomType: r.room_type_name,
      status: r.status,
      hkSection: r.hk_section,
      attendant: r.attendant_name ?? null,
      lastCleaned: r.last_cleaned_at,
      notes: r.notes,
      occupied: !!res,
      guest: res?.guest_name ?? null,
      reservationId: res?.id ?? null,
      departing: !!res && res.departure === date,
      arriving: !!arr,
      arrivalGuest: arr?.guest_name ?? null,
      discrepancy,
      blocked: block ? { kind: block.kind, reason: block.reason, to: block.to_date } : null,
      openWorkOrders: woCounts.get(r.id) ?? 0,
      task: t ? {
        id: t.id, type: t.type, status: t.status,
        assignee: t.assignee_name ?? null, priority: t.priority,
      } : null,
    };
  });
}

export function setRoomStatus(
  propertyId: string, actor: Actor, roomId: string, status: string, note?: string,
) {
  if (!ROOM_STATUSES.includes(status as RoomStatus)) {
    throw new HttpError(400, `Unknown room status "${status}"`);
  }
  const room = get<any>('SELECT * FROM rooms WHERE id = ? AND property_id = ?', roomId, propertyId);
  if (!room) notFound('Room');

  const occupied = get<{ n: number }>(
    `SELECT count(*) AS n FROM reservations
      WHERE property_id = ? AND room_id = ? AND status = 'Checked-in'`,
    propertyId, roomId,
  );
  if ((occupied?.n ?? 0) > 0 && status.startsWith('Vacant')) {
    throw new HttpError(409,
      `Room ${room.number} has an in-house guest — check them out before marking it vacant`,
      'room_occupied');
  }
  if (['Out of Order', 'Out of Service'].includes(status) && (occupied?.n ?? 0) > 0) {
    throw new HttpError(409, `Room ${room.number} is occupied and cannot be taken out of order`);
  }

  run(
    `UPDATE rooms SET status = ?, notes = COALESCE(?, notes),
            last_cleaned_at = CASE WHEN ? IN ('Vacant Clean','Vacant Inspected','Occupied Clean')
                                   THEN ? ELSE last_cleaned_at END
      WHERE id = ?`,
    status, note ?? null, status, nowIso(), roomId,
  );
  audit(actor, {
    action: 'room.status', entity: 'ROOM', entityId: roomId, entityRef: room.number,
    before: { status: room.status }, after: { status, note },
  });
  return get<any>('SELECT * FROM rooms WHERE id = ?', roomId);
}

/**
 * Build (or refresh) the day's task sheet from the reservation ledger:
 * a departure clean for every room checking out, a stayover for every room
 * staying, and a pre-arrival check for dirty rooms with an arrival today.
 */
export function generateTasks(propertyId: string, actor: Actor, date: string) {
  return tx(() => {
    const rooms = roomBoard(propertyId, date);
    let created = 0;
    for (const r of rooms) {
      if (r.blocked) continue;
      let type: string | null = null;
      let priority = 'normal';
      if (r.departing) { type = 'departure'; priority = 'high'; }
      else if (r.occupied) { type = 'stayover'; }
      else if (r.arriving && r.status === 'Vacant Dirty') { type = 'departure'; priority = 'high'; }
      else if (r.status === 'Vacant Dirty') { type = 'departure'; }
      if (!type) continue;

      const existing = get<{ id: string }>(
        'SELECT id FROM hk_tasks WHERE property_id = ? AND date = ? AND room_id = ? AND type = ?',
        propertyId, date, r.id, type,
      );
      if (existing) continue;
      run(
        `INSERT INTO hk_tasks(id, property_id, date, room_id, type, status, section, priority, credits, created_at)
         VALUES(?,?,?,?,?,'pending',?,?,?,?)`,
        id('hk'), propertyId, date, r.id, type, r.hkSection,
        priority, type === 'departure' ? 2 : 1, nowIso(),
      );
      created++;
    }
    audit(actor, {
      action: 'housekeeping.generate-tasks', entity: 'HOUSEKEEPING',
      entityRef: date, after: { created },
    });
    return { created, date };
  });
}

export function listTasks(propertyId: string, date: string, filters: { assigneeId?: string; status?: string } = {}) {
  const where = ['t.property_id = ?', 't.date = ?'];
  const params: unknown[] = [propertyId, date];
  if (filters.assigneeId) { where.push('t.assignee_id = ?'); params.push(filters.assigneeId); }
  if (filters.status) { where.push('t.status = ?'); params.push(filters.status); }
  return all<any>(
    `SELECT t.*, r.number AS room_number, r.floor, r.status AS room_status,
            rt.name AS room_type_name, u.name AS assignee_name
       FROM hk_tasks t
       JOIN rooms r ON r.id = t.room_id
       JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ${where.join(' AND ')}
      ORDER BY t.priority DESC, r.floor, r.number`,
    ...params,
  ).map((t) => ({
    id: t.id, date: t.date, roomId: t.room_id, room: t.room_number, floor: t.floor,
    roomStatus: t.room_status, roomType: t.room_type_name, type: t.type, status: t.status,
    assigneeId: t.assignee_id, assignee: t.assignee_name ?? null, section: t.section,
    priority: t.priority, credits: t.credits, startedAt: t.started_at, finishedAt: t.finished_at,
    inspectedBy: t.inspected_by, inspectedAt: t.inspected_at, notes: t.notes,
  }));
}

export function updateTask(
  propertyId: string, actor: Actor, taskId: string,
  input: { status?: string; assigneeId?: string | null; notes?: string; priority?: string },
) {
  return tx(() => {
    const task = get<any>('SELECT * FROM hk_tasks WHERE id = ? AND property_id = ?', taskId, propertyId);
    if (!task) notFound('Task');
    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.assigneeId !== undefined) { sets.push('assignee_id = ?'); params.push(input.assigneeId); }
    if (input.notes !== undefined) { sets.push('notes = ?'); params.push(input.notes); }
    if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority); }

    if (input.status) {
      const allowed = ['pending', 'in-progress', 'done', 'inspected', 'blocked'];
      if (!allowed.includes(input.status)) throw new HttpError(400, `Unknown task status "${input.status}"`);
      sets.push('status = ?'); params.push(input.status);
      if (input.status === 'in-progress') { sets.push('started_at = ?'); params.push(nowIso()); }
      if (input.status === 'done') { sets.push('finished_at = ?'); params.push(nowIso()); }
      if (input.status === 'inspected') {
        sets.push('inspected_at = ?', 'inspected_by = ?');
        params.push(nowIso(), actor.userName);
      }
    }
    if (!sets.length) return listTasks(propertyId, task.date).find((t) => t.id === taskId);

    params.push(taskId);
    run(`UPDATE hk_tasks SET ${sets.join(', ')} WHERE id = ?`, ...params);

    // Completing a clean advances the room's status.
    if (input.status === 'done' || input.status === 'inspected') {
      const room = get<any>('SELECT * FROM rooms WHERE id = ?', task.room_id);
      const occupied = room.status.startsWith('Occupied');
      const next = input.status === 'inspected'
        ? (occupied ? 'Occupied Clean' : 'Vacant Inspected')
        : (occupied ? 'Occupied Clean' : 'Vacant Clean');
      if (!['Out of Order', 'Out of Service'].includes(room.status)) {
        run('UPDATE rooms SET status = ?, last_cleaned_at = ? WHERE id = ?', next, nowIso(), task.room_id);
      }
    }

    audit(actor, {
      action: 'housekeeping.task', entity: 'HK_TASK', entityId: taskId,
      entityRef: task.room_id, before: { status: task.status }, after: input,
    });
    return listTasks(propertyId, task.date).find((t) => t.id === taskId);
  });
}

// ─── Out of order / out of service ───────────────────────────
export function blockRoom(
  propertyId: string, actor: Actor,
  input: { roomId: string; kind: 'OOO' | 'OOS'; fromDate: string; toDate: string; reason: string },
) {
  return tx(() => {
    const room = get<any>('SELECT * FROM rooms WHERE id = ? AND property_id = ?', input.roomId, propertyId);
    if (!room) notFound('Room');

    const clash = get<{ n: number }>(
      `SELECT count(*) AS n FROM reservation_nights n
         JOIN reservations r ON r.id = n.reservation_id
        WHERE n.room_id = ? AND n.date >= ? AND n.date < ? AND r.status IN ${LIVE}`,
      input.roomId, input.fromDate, input.toDate,
    );
    if ((clash?.n ?? 0) > 0) {
      throw new HttpError(409,
        `Room ${room.number} has reservations inside that window — move them first`,
        'room_has_reservations');
    }

    const blockId = id('blk');
    run(
      `INSERT INTO room_blocks(id, property_id, room_id, kind, from_date, to_date, reason, created_by, created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      blockId, propertyId, input.roomId, input.kind, input.fromDate, input.toDate,
      input.reason, actor.userName, nowIso(),
    );
    const today = new Date().toISOString().slice(0, 10);
    if (input.fromDate <= today && input.toDate > today) {
      run('UPDATE rooms SET status = ? WHERE id = ?',
        input.kind === 'OOO' ? 'Out of Order' : 'Out of Service', input.roomId);
    }
    audit(actor, {
      action: 'room.block', entity: 'ROOM', entityId: input.roomId, entityRef: room.number,
      after: input, elevated: true,
    });
    return get<any>('SELECT * FROM room_blocks WHERE id = ?', blockId);
  });
}

export function releaseBlock(propertyId: string, actor: Actor, blockId: string) {
  const block = get<any>('SELECT * FROM room_blocks WHERE id = ? AND property_id = ?', blockId, propertyId);
  if (!block) notFound('Room block');
  run('UPDATE room_blocks SET released_at = ? WHERE id = ?', nowIso(), blockId);
  const stillBlocked = get<{ n: number }>(
    `SELECT count(*) AS n FROM room_blocks WHERE room_id = ? AND released_at IS NULL
       AND from_date <= date('now') AND to_date > date('now')`,
    block.room_id,
  );
  if ((stillBlocked?.n ?? 0) === 0) {
    run(`UPDATE rooms SET status = 'Vacant Dirty' WHERE id = ? AND status IN ('Out of Order','Out of Service')`,
      block.room_id);
  }
  audit(actor, { action: 'room.unblock', entity: 'ROOM', entityId: block.room_id, entityRef: blockId });
  return { ok: true };
}

export function listBlocks(propertyId: string, activeOnly = true) {
  return all<any>(
    `SELECT b.*, r.number AS room_number, rt.name AS room_type_name
       FROM room_blocks b
       JOIN rooms r ON r.id = b.room_id
       JOIN room_types rt ON rt.id = r.room_type_id
      WHERE b.property_id = ? ${activeOnly ? 'AND b.released_at IS NULL' : ''}
      ORDER BY b.from_date DESC`,
    propertyId,
  ).map((b) => ({
    id: b.id, roomId: b.room_id, room: b.room_number, roomType: b.room_type_name,
    kind: b.kind, fromDate: b.from_date, toDate: b.to_date, reason: b.reason,
    createdBy: b.created_by, createdAt: b.created_at, releasedAt: b.released_at,
  }));
}

// ─── Work orders ─────────────────────────────────────────────
export function createWorkOrder(propertyId: string, actor: Actor, input: {
  roomId?: string | null; location?: string; category: string; priority: string;
  title: string; description?: string; blocksRoom?: boolean; assignedTo?: string | null;
}) {
  return tx(() => {
    const woId = id('wo');
    run(
      `INSERT INTO work_orders(id, property_id, room_id, location, category, priority, status,
                               title, description, reported_by, assigned_to, blocks_room, created_at)
       VALUES(?,?,?,?,?,?,'open',?,?,?,?,?,?)`,
      woId, propertyId, input.roomId ?? null, input.location ?? null, input.category,
      input.priority, input.title, input.description ?? null, actor.userName,
      input.assignedTo ?? null, input.blocksRoom ? 1 : 0, nowIso(),
    );
    audit(actor, {
      action: 'workorder.create', entity: 'WORK_ORDER', entityId: woId, entityRef: input.title,
      after: input,
    });
    return get<any>('SELECT * FROM work_orders WHERE id = ?', woId);
  });
}

export function listWorkOrders(propertyId: string, status?: string) {
  return all<any>(
    `SELECT w.*, r.number AS room_number, u.name AS assignee_name
       FROM work_orders w
       LEFT JOIN rooms r ON r.id = w.room_id
       LEFT JOIN users u ON u.id = w.assigned_to
      WHERE w.property_id = ? ${status ? 'AND w.status = ?' : ''}
      ORDER BY CASE w.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, w.created_at DESC`,
    ...(status ? [propertyId, status] : [propertyId]),
  ).map((w) => ({
    id: w.id, room: w.room_number ?? null, roomId: w.room_id, location: w.location,
    category: w.category, priority: w.priority, status: w.status, title: w.title,
    description: w.description, reportedBy: w.reported_by, assignee: w.assignee_name ?? null,
    assignedTo: w.assigned_to, blocksRoom: w.blocks_room === 1, createdAt: w.created_at,
    resolvedAt: w.resolved_at, resolution: w.resolution,
  }));
}

export function updateWorkOrder(propertyId: string, actor: Actor, woId: string, input: {
  status?: string; assignedTo?: string | null; resolution?: string; priority?: string;
}) {
  const wo = get<any>('SELECT * FROM work_orders WHERE id = ? AND property_id = ?', woId, propertyId);
  if (!wo) notFound('Work order');
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.status) {
    sets.push('status = ?'); params.push(input.status);
    if (['resolved', 'closed'].includes(input.status)) {
      sets.push('resolved_at = ?'); params.push(nowIso());
    }
  }
  if (input.assignedTo !== undefined) { sets.push('assigned_to = ?'); params.push(input.assignedTo); }
  if (input.resolution !== undefined) { sets.push('resolution = ?'); params.push(input.resolution); }
  if (input.priority !== undefined) { sets.push('priority = ?'); params.push(input.priority); }
  if (!sets.length) return wo;
  params.push(woId);
  run(`UPDATE work_orders SET ${sets.join(', ')} WHERE id = ?`, ...params);
  audit(actor, {
    action: 'workorder.update', entity: 'WORK_ORDER', entityId: woId, entityRef: wo.title,
    before: { status: wo.status }, after: input,
  });
  return get<any>('SELECT * FROM work_orders WHERE id = ?', woId);
}

// ─── Lost & found ────────────────────────────────────────────
export function createLostFound(propertyId: string, actor: Actor, input: {
  roomId?: string | null; foundOn: string; description: string; storageRef?: string; note?: string;
}) {
  const lfId = id('lf');
  run(
    `INSERT INTO lost_found(id, property_id, room_id, found_on, found_by, description, storage_ref, status, note)
     VALUES(?,?,?,?,?,?,?,'stored',?)`,
    lfId, propertyId, input.roomId ?? null, input.foundOn, actor.userName,
    input.description, input.storageRef ?? null, input.note ?? null,
  );
  audit(actor, { action: 'lostfound.create', entity: 'LOST_FOUND', entityId: lfId, entityRef: input.description });
  return get<any>('SELECT * FROM lost_found WHERE id = ?', lfId);
}

export function listLostFound(propertyId: string) {
  return all<any>(
    `SELECT lf.*, r.number AS room_number FROM lost_found lf
       LEFT JOIN rooms r ON r.id = lf.room_id
      WHERE lf.property_id = ? ORDER BY lf.found_on DESC`,
    propertyId,
  ).map((l) => ({
    id: l.id, room: l.room_number ?? null, foundOn: l.found_on, foundBy: l.found_by,
    description: l.description, storageRef: l.storage_ref, status: l.status,
    returnedAt: l.returned_at, note: l.note,
  }));
}

export function updateLostFound(propertyId: string, actor: Actor, lfId: string, input: {
  status?: string; note?: string; profileId?: string | null;
}) {
  const row = get<any>('SELECT * FROM lost_found WHERE id = ? AND property_id = ?', lfId, propertyId);
  if (!row) notFound('Lost & found item');
  run(
    `UPDATE lost_found SET status = COALESCE(?, status), note = COALESCE(?, note),
            profile_id = COALESCE(?, profile_id),
            returned_at = CASE WHEN ? = 'returned' THEN ? ELSE returned_at END
      WHERE id = ?`,
    input.status ?? null, input.note ?? null, input.profileId ?? null,
    input.status ?? '', nowIso(), lfId,
  );
  audit(actor, { action: 'lostfound.update', entity: 'LOST_FOUND', entityId: lfId, after: input });
  return get<any>('SELECT * FROM lost_found WHERE id = ?', lfId);
}

/** Rooms whose physical status contradicts the reservation ledger. */
export function discrepancies(propertyId: string, date: string) {
  return roomBoard(propertyId, date).filter((r) => r.discrepancy);
}

/** Forecast of rooms needing a clean tomorrow — used by the HK planner. */
export function forecast(propertyId: string, date: string) {
  const next = addDays(date, 1);
  const departures = get<{ n: number }>(
    `SELECT count(*) AS n FROM reservations
      WHERE property_id = ? AND departure = ? AND status = 'Checked-in'`,
    propertyId, next,
  );
  const stayovers = get<{ n: number }>(
    `SELECT count(*) AS n FROM reservations
      WHERE property_id = ? AND status = 'Checked-in' AND departure > ?`,
    propertyId, next,
  );
  const arrivals = get<{ n: number }>(
    `SELECT count(*) AS n FROM reservations
      WHERE property_id = ? AND arrival = ? AND status IN ('Tentative','Confirmed','Guaranteed')`,
    propertyId, next,
  );
  return {
    date: next,
    departureCleans: departures?.n ?? 0,
    stayoverCleans: stayovers?.n ?? 0,
    arrivals: arrivals?.n ?? 0,
    totalCredits: (departures?.n ?? 0) * 2 + (stayovers?.n ?? 0),
  };
}
