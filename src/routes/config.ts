// Configuration: property, room types, rooms, beds, rate plans, taxes,
// transaction codes, policies and companies. This is where a new property is
// made operational — the app ships with none of it pre-filled.
import { router, type Ctx } from '../lib/http.ts';
import { all, get, run, tx, scalar, jsonCol, parseJson } from '../db.ts';
import {
  id, nowIso, str, int, slugCode, boolIn, money, oneOf, isDate, HttpError, notFound, dateRange,
  addDays,
} from '../lib/util.ts';
import { queueChannelPush } from '../services/reservations.ts';
import { parseBedConfig, describeBedConfig, checkCapacity, BED_KINDS } from '../lib/beds.ts';
import { audit } from '../services/audit.ts';
import { seedOperationalDefaults } from './auth.ts';

const pid = (ctx: Ctx) => ctx.auth.propertyId;

// ─── Property ────────────────────────────────────────────────
router.get('/api/property', (ctx: Ctx) => {
  const p = get<any>('SELECT * FROM properties WHERE id = ?', pid(ctx));
  if (!p) notFound('Property');
  return {
    id: p.id, code: p.code, name: p.name, legalName: p.legal_name, kind: p.kind,
    address: p.address, city: p.city, country: p.country, timezone: p.timezone,
    currency: p.currency, locale: p.locale, businessDate: p.business_date,
    checkInTime: p.check_in_time, checkOutTime: p.check_out_time,
    phone: p.phone, email: p.email, website: p.website, taxId: p.tax_id,
    rooms: scalar<number>('SELECT count(*) AS n FROM rooms WHERE property_id = ? AND active = 1', p.id),
    roomTypes: scalar<number>('SELECT count(*) AS n FROM room_types WHERE property_id = ? AND active = 1', p.id),
    ratePlans: scalar<number>('SELECT count(*) AS n FROM rate_plans WHERE property_id = ? AND active = 1', p.id),
    active: p.active === 1,
  };
}, { perm: 'config.read' });

router.patch('/api/property', (ctx: Ctx) => {
  const before = get<any>('SELECT * FROM properties WHERE id = ?', pid(ctx));
  const b = ctx.body;
  const map: Record<string, string> = {
    name: 'name', legalName: 'legal_name', kind: 'kind', address: 'address', city: 'city',
    country: 'country', timezone: 'timezone', currency: 'currency', locale: 'locale',
    checkInTime: 'check_in_time', checkOutTime: 'check_out_time', phone: 'phone',
    email: 'email', website: 'website', taxId: 'tax_id',
  };
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (b[k] !== undefined) { sets.push(`${col} = ?`); args.push(b[k]); }
  }
  // The business date only moves through the night audit.
  if (b.businessDate !== undefined && b.businessDate !== before.business_date) {
    throw new HttpError(409,
      'The business date is advanced by the night audit, not by editing the property',
      'business_date_locked');
  }
  if (!sets.length) return { ok: true };
  args.push(pid(ctx));
  run(`UPDATE properties SET ${sets.join(', ')} WHERE id = ?`, ...args);
  audit(ctx.auth, {
    action: 'property.update', entity: 'PROPERTY', entityId: pid(ctx), entityRef: before.code,
    before: { name: before.name, currency: before.currency }, after: b,
  }, ctx.ip);
  return { ok: true };
}, { perm: 'config.write' });

router.get('/api/properties', () => all<any>('SELECT * FROM properties ORDER BY name').map((p) => ({
  id: p.id, code: p.code, name: p.name, location: [p.city, p.country].filter(Boolean).join(', '),
  businessDate: p.business_date, currency: p.currency, kind: p.kind,
  rooms: scalar<number>('SELECT count(*) AS n FROM rooms WHERE property_id = ? AND active = 1', p.id),
  active: p.active === 1,
})), { perm: undefined, allowNoProperty: true });

router.post('/api/properties', (ctx: Ctx) => tx(() => {
  const code = slugCode(ctx.body.code, 'code', 12);
  const name = str(ctx.body.name, 'name', { max: 120 });
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, city, country, timezone, currency, locale,
                            business_date, check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    propertyId, code, name, ctx.body.kind ?? 'hotel', ctx.body.city ?? null,
    ctx.body.country ?? null, ctx.body.timezone ?? 'UTC',
    slugCode(ctx.body.currency ?? 'USD', 'currency', 3), ctx.body.locale ?? 'en',
    isDate(ctx.body.businessDate) ? ctx.body.businessDate : new Date().toISOString().slice(0, 10),
    ctx.body.checkInTime ?? '14:00', ctx.body.checkOutTime ?? '11:00', nowIso(),
  );
  seedOperationalDefaults(propertyId);
  run('INSERT INTO user_properties(user_id, property_id, role) VALUES(?,?,?) ON CONFLICT DO NOTHING',
    ctx.auth.userId, propertyId, ctx.auth.role);
  audit(ctx.auth, {
    action: 'property.create', entity: 'PROPERTY', entityId: propertyId, entityRef: code,
    after: { name }, elevated: true,
  }, ctx.ip);
  return { id: propertyId, code, name };
}), { perm: 'admin.users', allowNoProperty: true });

// ─── Room types ──────────────────────────────────────────────
function shapeRoomType(rt: any) {
  return {
    id: rt.id, code: rt.code, name: rt.name, description: rt.description, kind: rt.kind,
    baseOccupancy: rt.base_occupancy, maxOccupancy: rt.max_occupancy,
    maxAdults: rt.max_adults, maxChildren: rt.max_children,
    defaultRateMinor: rt.default_rate_minor,
    extraAdultMinor: rt.extra_adult_minor, extraChildMinor: rt.extra_child_minor,
    amenities: parseJson<string[]>(rt.amenities, []),
    bedConfig: parseBedConfig(rt.bed_config),
    // Derived, never stored: capacity follows the beds, so the two can never
    // drift apart the way a duplicated number would.
    capacity: checkCapacity(parseBedConfig(rt.bed_config), {
      maxOccupancy: rt.max_occupancy, baseOccupancy: rt.base_occupancy, kind: rt.kind,
    }),
    genderPolicy: rt.gender_policy, sortOrder: rt.sort_order, active: rt.active === 1,
    rooms: scalar<number>('SELECT count(*) AS n FROM rooms WHERE room_type_id = ? AND active = 1', rt.id),
    beds: scalar<number>(
      `SELECT count(*) AS n FROM beds b JOIN rooms r ON r.id = b.room_id
        WHERE r.room_type_id = ? AND b.active = 1`, rt.id),
  };
}

/**
 * The bed vocabulary, so the builder offers exactly what the system understands
 * rather than a list typed into the front end that can drift out of step.
 */
router.get('/api/bed-kinds', () => ({
  kinds: BED_KINDS,
  note: 'A bunk is one piece of furniture and two berths — it sleeps two.',
}), { perm: 'config.read' });

router.get('/api/room-types', (ctx: Ctx) => all<any>(
  'SELECT * FROM room_types WHERE property_id = ? ORDER BY sort_order, name', pid(ctx),
).map(shapeRoomType), { perm: 'config.read' });

router.post('/api/room-types', (ctx: Ctx) => {
  const b = ctx.body;
  const rtId = id('rt');
  run(
    `INSERT INTO room_types(id, property_id, code, name, description, kind, base_occupancy,
                            max_occupancy, max_adults, max_children, default_rate_minor,
                            extra_adult_minor, extra_child_minor, amenities, bed_config,
                            gender_policy, sort_order, active, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    rtId, pid(ctx), slugCode(b.code, 'code', 12), str(b.name, 'name', { max: 80 }),
    b.description ?? null, oneOf(b.kind, 'kind', ['room', 'dorm'] as const, 'room'),
    int(b.baseOccupancy, 'baseOccupancy', { min: 1, max: 40, def: 2 }),
    int(b.maxOccupancy, 'maxOccupancy', { min: 1, max: 40, def: 2 }),
    int(b.maxAdults, 'maxAdults', { min: 0, max: 40, def: 2 }),
    int(b.maxChildren, 'maxChildren', { min: 0, max: 20, def: 0 }),
    money(b.defaultRateMinor ?? 0, 'defaultRateMinor'),
    money(b.extraAdultMinor ?? 0, 'extraAdultMinor'),
    money(b.extraChildMinor ?? 0, 'extraChildMinor'),
    jsonCol(b.amenities ?? []), jsonCol(parseBedConfig(b.bedConfig)), b.genderPolicy ?? null,
    int(b.sortOrder, 'sortOrder', { def: 0 }), b.active === false ? 0 : 1, nowIso(),
  );
  audit(ctx.auth, {
    action: 'roomtype.create', entity: 'ROOM_TYPE', entityId: rtId, entityRef: b.code, after: b,
  }, ctx.ip);
  return shapeRoomType(get<any>('SELECT * FROM room_types WHERE id = ?', rtId));
}, { perm: 'config.write' });

router.patch('/api/room-types/:id', (ctx: Ctx) => {
  const before = get<any>('SELECT * FROM room_types WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  if (!before) notFound('Room type');
  const map: Record<string, string> = {
    name: 'name', description: 'description', baseOccupancy: 'base_occupancy',
    maxOccupancy: 'max_occupancy', maxAdults: 'max_adults', maxChildren: 'max_children',
    defaultRateMinor: 'default_rate_minor', extraAdultMinor: 'extra_adult_minor',
    extraChildMinor: 'extra_child_minor', genderPolicy: 'gender_policy', sortOrder: 'sort_order',
  };
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (ctx.body[k] !== undefined) { sets.push(`${col} = ?`); args.push(ctx.body[k]); }
  }
  if (ctx.body.amenities !== undefined) { sets.push('amenities = ?'); args.push(jsonCol(ctx.body.amenities)); }
  if (ctx.body.bedConfig !== undefined) {
    sets.push('bed_config = ?');
    args.push(jsonCol(parseBedConfig(ctx.body.bedConfig)));
  }
  if (ctx.body.active !== undefined) { sets.push('active = ?'); args.push(ctx.body.active ? 1 : 0); }
  if (!sets.length) return shapeRoomType(before);
  args.push(ctx.params.id);
  run(`UPDATE room_types SET ${sets.join(', ')} WHERE id = ?`, ...args);
  audit(ctx.auth, {
    action: 'roomtype.update', entity: 'ROOM_TYPE', entityId: ctx.params.id,
    entityRef: before.code, before: { name: before.name }, after: ctx.body,
  }, ctx.ip);

  // Some of these fields decide what the OTAs sell and at what price, and none
  // of them told the channels anything.
  //
  // `default_rate_minor` is the price used for every date nobody has priced
  // explicitly, so changing it silently repriced the calendar in Helio while the
  // OTAs kept the old figure. `active` is worse: switching a room type off
  // removes it from Helio entirely and left it on sale everywhere else.
  //
  // Only queued when a value genuinely moved. Renaming a room type or nudging
  // its sort order changes nothing a channel can see, and a 180-day push on
  // every keystroke of an edit form would be a waste of the credit budget.
  const ARI_FIELDS: Record<string, string> = {
    defaultRateMinor: 'default_rate_minor', baseOccupancy: 'base_occupancy',
    extraAdultMinor: 'extra_adult_minor', extraChildMinor: 'extra_child_minor',
  };
  const moved = Object.entries(ARI_FIELDS).some(
    ([key, col]) => ctx.body[key] !== undefined && Number(ctx.body[key]) !== Number(before[col]),
  ) || (ctx.body.active !== undefined && (ctx.body.active ? 1 : 0) !== before.active);

  if (moved) {
    // No date range comes with a room-type edit — it applies from now on. 180
    // days is the forward window the rest of the system works to.
    const today = get<{ business_date: string }>(
      'SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;
    queueChannelPush(pid(ctx), ctx.params.id, today, addDays(today, 180), 'room-type.update');
  }
  return shapeRoomType(get<any>('SELECT * FROM room_types WHERE id = ?', ctx.params.id));
}, { perm: 'config.write' });

router.delete('/api/room-types/:id', (ctx: Ctx) => {
  const used = scalar<number>('SELECT count(*) AS n FROM reservations WHERE room_type_id = ?', ctx.params.id);
  if (used > 0) {
    run('UPDATE room_types SET active = 0 WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
    return { ok: true, deactivated: true, reason: 'Room type has reservations — deactivated instead of deleted' };
  }
  run('DELETE FROM room_types WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  audit(ctx.auth, { action: 'roomtype.delete', entity: 'ROOM_TYPE', entityId: ctx.params.id }, ctx.ip);
  return { ok: true, deactivated: false };
}, { perm: 'config.write' });

// ─── Rooms ───────────────────────────────────────────────────
function shapeRoom(r: any) {
  return {
    id: r.id, number: r.number, floor: r.floor, wing: r.wing,
    roomTypeId: r.room_type_id, roomType: r.room_type_name, roomTypeCode: r.room_type_code,
    status: r.status, hkSection: r.hk_section, attendantId: r.attendant_id,
    lastCleanedAt: r.last_cleaned_at, features: parseJson<string[]>(r.features, []),
    notes: r.notes, connectingTo: r.connecting_to, active: r.active === 1,
    beds: r.bed_count ?? 0,
    // A room may differ from its type. Which one is in force is reported, so a
    // screen never has to guess whether it is showing an override.
    bedConfig: parseBedConfig(r.bed_config ?? r.type_bed_config),
    bedConfigIsOverride: !!r.bed_config,
    bedSummary: describeBedConfig(parseBedConfig(r.bed_config ?? r.type_bed_config)),
  };
}

router.get('/api/rooms', (ctx: Ctx) => all<any>(
  `SELECT r.*, rt.name AS room_type_name, rt.code AS room_type_code,
          rt.bed_config AS type_bed_config,
          (SELECT count(*) FROM beds b WHERE b.room_id = r.id AND b.active = 1) AS bed_count
     FROM rooms r JOIN room_types rt ON rt.id = r.room_type_id
    WHERE r.property_id = ? ORDER BY r.floor, r.number`,
  pid(ctx),
).map(shapeRoom), { perm: 'config.read' });

router.post('/api/rooms', (ctx: Ctx) => tx(() => {
  const b = ctx.body;
  const roomType = get<any>('SELECT * FROM room_types WHERE id = ? AND property_id = ?',
    b.roomTypeId, pid(ctx));
  if (!roomType) notFound('Room type');
  const roomId = id('rm');
  run(
    `INSERT INTO rooms(id, property_id, room_type_id, number, floor, wing, status, hk_section,
                       features, bed_config, notes, connecting_to, active, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    roomId, pid(ctx), b.roomTypeId, str(b.number, 'number', { max: 12 }),
    int(b.floor, 'floor', { def: 0 }), b.wing ?? null,
    b.status ?? 'Vacant Clean', b.hkSection ?? null, jsonCol(b.features ?? []),
    // Null unless this room genuinely differs, so it keeps following its type.
    b.bedConfig === undefined ? null : jsonCol(parseBedConfig(b.bedConfig)),
    b.notes ?? null, b.connectingTo ?? null, b.active === false ? 0 : 1, nowIso(),
  );
  // Dorm rooms get their sellable beds created with them.
  if (roomType.kind === 'dorm') {
    const count = int(b.bedCount ?? roomType.max_occupancy, 'bedCount', { min: 1, max: 60 });
    for (let i = 1; i <= count; i++) {
      run(
        `INSERT INTO beds(id, property_id, room_id, code, bunk, status, active)
         VALUES(?,?,?,?,?,'Vacant Clean',1)`,
        id('bed'), pid(ctx), roomId, `${b.number}-${String(i).padStart(2, '0')}`,
        count === 1 ? 'single' : i % 2 === 1 ? 'bottom' : 'top',
      );
    }
  }
  audit(ctx.auth, {
    action: 'room.create', entity: 'ROOM', entityId: roomId, entityRef: b.number, after: b,
  }, ctx.ip);
  return { id: roomId, number: b.number };
}), { perm: 'config.write' });

/** Bulk room creation — the fastest way to stand up a floor plan. */
router.post('/api/rooms/bulk', (ctx: Ctx) => tx(() => {
  const b = ctx.body;
  const roomType = get<any>('SELECT * FROM room_types WHERE id = ? AND property_id = ?',
    b.roomTypeId, pid(ctx));
  if (!roomType) notFound('Room type');
  const floorFrom = int(b.floorFrom, 'floorFrom', { min: -5, max: 200 });
  const floorTo = int(b.floorTo, 'floorTo', { min: -5, max: 200 });
  const perFloor = int(b.roomsPerFloor, 'roomsPerFloor', { min: 1, max: 200 });
  const startAt = int(b.startAt ?? 1, 'startAt', { min: 0, max: 999 });
  const pad = int(b.pad ?? 2, 'pad', { min: 1, max: 4 });
  const created: string[] = [];
  const skipped: string[] = [];

  for (let floor = floorFrom; floor <= floorTo; floor++) {
    for (let i = 0; i < perFloor; i++) {
      const number = `${floor}${String(startAt + i).padStart(pad, '0')}`;
      const exists = get<any>('SELECT id FROM rooms WHERE property_id = ? AND number = ?', pid(ctx), number);
      if (exists) { skipped.push(number); continue; }
      const roomId = id('rm');
      run(
        `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, hk_section, active, created_at)
         VALUES(?,?,?,?,?,'Vacant Clean',?,1,?)`,
        roomId, pid(ctx), b.roomTypeId, number, floor, b.hkSection ?? `Floor ${floor}`, nowIso(),
      );
      if (roomType.kind === 'dorm') {
        const count = int(b.bedCount ?? roomType.max_occupancy, 'bedCount', { min: 1, max: 60 });
        for (let k = 1; k <= count; k++) {
          run(
            `INSERT INTO beds(id, property_id, room_id, code, bunk, status, active)
             VALUES(?,?,?,?,?,'Vacant Clean',1)`,
            id('bed'), pid(ctx), roomId, `${number}-${String(k).padStart(2, '0')}`,
            count === 1 ? 'single' : k % 2 === 1 ? 'bottom' : 'top',
          );
        }
      }
      created.push(number);
    }
  }
  audit(ctx.auth, {
    action: 'room.bulk-create', entity: 'ROOM', entityRef: roomType.code,
    after: { created: created.length, skipped: skipped.length },
  }, ctx.ip);
  return { created, skipped };
}), { perm: 'config.write' });

router.patch('/api/rooms/:id', (ctx: Ctx) => {
  const before = get<any>('SELECT * FROM rooms WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  if (!before) notFound('Room');
  const map: Record<string, string> = {
    number: 'number', floor: 'floor', wing: 'wing', roomTypeId: 'room_type_id',
    hkSection: 'hk_section', attendantId: 'attendant_id', notes: 'notes', connectingTo: 'connecting_to',
  };
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (ctx.body[k] !== undefined) { sets.push(`${col} = ?`); args.push(ctx.body[k]); }
  }
  if (ctx.body.features !== undefined) { sets.push('features = ?'); args.push(jsonCol(ctx.body.features)); }
  if (ctx.body.bedConfig !== undefined) {
    // Passing null clears the override and puts the room back on its type's
    // configuration — otherwise a one-off change could never be undone.
    sets.push('bed_config = ?');
    args.push(ctx.body.bedConfig === null ? null : jsonCol(parseBedConfig(ctx.body.bedConfig)));
  }
  if (ctx.body.active !== undefined) { sets.push('active = ?'); args.push(ctx.body.active ? 1 : 0); }
  if (!sets.length) return { ok: true };
  args.push(ctx.params.id);
  run(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`, ...args);
  audit(ctx.auth, {
    action: 'room.update', entity: 'ROOM', entityId: ctx.params.id, entityRef: before.number,
    before: { number: before.number }, after: ctx.body,
  }, ctx.ip);
  return { ok: true };
}, { perm: 'config.write' });

router.delete('/api/rooms/:id', (ctx: Ctx) => {
  const used = scalar<number>(
    `SELECT count(*) AS n FROM reservation_nights WHERE room_id = ?`, ctx.params.id);
  if (used > 0) {
    run('UPDATE rooms SET active = 0 WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
    return { ok: true, deactivated: true, reason: 'Room has stay history — deactivated instead of deleted' };
  }
  run('DELETE FROM rooms WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  audit(ctx.auth, { action: 'room.delete', entity: 'ROOM', entityId: ctx.params.id }, ctx.ip);
  return { ok: true, deactivated: false };
}, { perm: 'config.write' });

// ─── Beds (hostel inventory) ─────────────────────────────────
router.get('/api/beds', (ctx: Ctx) => all<any>(
  `SELECT b.*, r.number AS room_number, r.floor, rt.name AS room_type_name, rt.id AS room_type_id,
          rt.gender_policy
     FROM beds b JOIN rooms r ON r.id = b.room_id JOIN room_types rt ON rt.id = r.room_type_id
    WHERE b.property_id = ? ORDER BY r.floor, r.number, b.code`,
  pid(ctx),
).map((b) => ({
  id: b.id, code: b.code, roomId: b.room_id, room: b.room_number, floor: b.floor,
  roomTypeId: b.room_type_id, roomType: b.room_type_name, gender: b.gender_policy,
  bunk: b.bunk, status: b.status, active: b.active === 1,
})), { perm: 'config.read' });

router.post('/api/beds', (ctx: Ctx) => {
  const room = get<any>('SELECT * FROM rooms WHERE id = ? AND property_id = ?', ctx.body.roomId, pid(ctx));
  if (!room) notFound('Room');
  const bedId = id('bed');
  run(
    `INSERT INTO beds(id, property_id, room_id, code, bunk, status, active) VALUES(?,?,?,?,?,?,1)`,
    bedId, pid(ctx), ctx.body.roomId, str(ctx.body.code, 'code', { max: 20 }),
    oneOf(ctx.body.bunk, 'bunk', ['top', 'bottom', 'single'] as const, 'single'),
    ctx.body.status ?? 'Vacant Clean',
  );
  audit(ctx.auth, { action: 'bed.create', entity: 'BED', entityId: bedId, entityRef: ctx.body.code }, ctx.ip);
  return { id: bedId };
}, { perm: 'config.write' });

router.delete('/api/beds/:id', (ctx: Ctx) => {
  const used = scalar<number>('SELECT count(*) AS n FROM reservation_nights WHERE bed_id = ?', ctx.params.id);
  if (used > 0) {
    run('UPDATE beds SET active = 0 WHERE id = ?', ctx.params.id);
    return { ok: true, deactivated: true };
  }
  run('DELETE FROM beds WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  return { ok: true };
}, { perm: 'config.write' });

// ─── Taxes ───────────────────────────────────────────────────
router.get('/api/taxes', (ctx: Ctx) => all<any>(
  'SELECT * FROM taxes WHERE property_id = ? ORDER BY sort_order, code', pid(ctx),
).map((t) => ({
  id: t.id, code: t.code, name: t.name, mode: t.mode, value: t.value,
  appliesTo: t.applies_to, inclusive: t.inclusive === 1, sortOrder: t.sort_order,
  compoundOn: String(t.compound_on ?? '').split(',').map((c: string) => c.trim()).filter(Boolean),
  active: t.active === 1,
})), { perm: 'config.read' });

router.post('/api/taxes', (ctx: Ctx) => {
  const b = ctx.body;
  const taxId = id('tax');
  run(
    `INSERT INTO taxes(id, property_id, code, name, mode, value, applies_to, inclusive,
                       compound_on, sort_order, active, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    taxId, pid(ctx), slugCode(b.code, 'code', 12), str(b.name, 'name', { max: 80 }),
    oneOf(b.mode, 'mode', ['percent', 'per_night', 'per_person_night', 'flat'] as const),
    int(b.value, 'value', { min: 0 }),
    oneOf(b.appliesTo, 'appliesTo', ['room', 'fnb', 'all'] as const, 'room'),
    boolIn(b.inclusive) ? 1 : 0,
    // Null means "compound on everything before me", the long-standing default.
    // A property only opts into explicit bases by naming codes here.
    Array.isArray(b.compoundOn) ? b.compoundOn.join(',') : (b.compoundOn ?? null),
    int(b.sortOrder, 'sortOrder', { def: 0 }),
    b.active === false ? 0 : 1, nowIso(),
  );
  audit(ctx.auth, { action: 'tax.create', entity: 'TAX', entityId: taxId, entityRef: b.code, after: b }, ctx.ip);
  return { id: taxId };
}, { perm: 'config.write' });

router.patch('/api/taxes/:id', (ctx: Ctx) => {
  const before = get<any>('SELECT * FROM taxes WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  if (!before) notFound('Tax');
  const map: Record<string, string> = {
    name: 'name', mode: 'mode', value: 'value', appliesTo: 'applies_to', sortOrder: 'sort_order',
  };
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (ctx.body[k] !== undefined) { sets.push(`${col} = ?`); args.push(ctx.body[k]); }
  }
  if (ctx.body.inclusive !== undefined) { sets.push('inclusive = ?'); args.push(ctx.body.inclusive ? 1 : 0); }
  if (ctx.body.active !== undefined) { sets.push('active = ?'); args.push(ctx.body.active ? 1 : 0); }
  if (!sets.length) return { ok: true };
  args.push(ctx.params.id);
  run(`UPDATE taxes SET ${sets.join(', ')} WHERE id = ?`, ...args);
  audit(ctx.auth, {
    action: 'tax.update', entity: 'TAX', entityId: ctx.params.id, entityRef: before.code,
    before: { value: before.value }, after: ctx.body,
  }, ctx.ip);
  return { ok: true };
}, { perm: 'config.write' });

router.delete('/api/taxes/:id', (ctx: Ctx) => {
  run('UPDATE taxes SET active = 0 WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  audit(ctx.auth, { action: 'tax.delete', entity: 'TAX', entityId: ctx.params.id }, ctx.ip);
  return { ok: true };
}, { perm: 'config.write' });

// ─── Transaction codes ───────────────────────────────────────
router.get('/api/transaction-codes', (ctx: Ctx) => all<any>(
  'SELECT * FROM transaction_codes WHERE property_id = ? ORDER BY sort_order, code', pid(ctx),
).map((t) => ({
  id: t.id, code: t.code, name: t.name, category: t.category,
  defaultPriceMinor: t.default_price_minor, taxable: t.taxable === 1, active: t.active === 1,
})), { perm: 'config.read' });

router.post('/api/transaction-codes', (ctx: Ctx) => {
  const b = ctx.body;
  const tcId = id('txc');
  run(
    `INSERT INTO transaction_codes(id, property_id, code, name, category, default_price_minor,
                                   taxable, active, sort_order)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    tcId, pid(ctx), slugCode(b.code, 'code', 16), str(b.name, 'name', { max: 80 }),
    oneOf(b.category, 'category', ['room', 'fnb', 'tax', 'payment', 'misc', 'commission'] as const, 'misc'),
    money(b.defaultPriceMinor ?? 0, 'defaultPriceMinor'),
    b.taxable === false ? 0 : 1, b.active === false ? 0 : 1, int(b.sortOrder, 'sortOrder', { def: 99 }),
  );
  audit(ctx.auth, { action: 'txcode.create', entity: 'TRANSACTION_CODE', entityId: tcId, entityRef: b.code }, ctx.ip);
  return { id: tcId };
}, { perm: 'config.write' });

router.patch('/api/transaction-codes/:id', (ctx: Ctx) => {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (ctx.body.name !== undefined) { sets.push('name = ?'); args.push(ctx.body.name); }
  if (ctx.body.category !== undefined) { sets.push('category = ?'); args.push(ctx.body.category); }
  if (ctx.body.defaultPriceMinor !== undefined) { sets.push('default_price_minor = ?'); args.push(ctx.body.defaultPriceMinor); }
  if (ctx.body.taxable !== undefined) { sets.push('taxable = ?'); args.push(ctx.body.taxable ? 1 : 0); }
  if (ctx.body.active !== undefined) { sets.push('active = ?'); args.push(ctx.body.active ? 1 : 0); }
  if (!sets.length) return { ok: true };
  args.push(ctx.params.id, pid(ctx));
  run(`UPDATE transaction_codes SET ${sets.join(', ')} WHERE id = ? AND property_id = ?`, ...args);
  return { ok: true };
}, { perm: 'config.write' });

// ─── Policies ────────────────────────────────────────────────
router.get('/api/policies', (ctx: Ctx) => all<any>(
  'SELECT * FROM policies WHERE property_id = ? ORDER BY kind, name', pid(ctx),
).map((p) => ({
  id: p.id, kind: p.kind, name: p.name, scope: p.scope, scopeRef: p.scope_ref,
  summary: p.summary, details: p.details, channels: parseJson<string[]>(p.channels, []),
  active: p.active === 1, updatedAt: p.updated_at,
})), { perm: 'config.read' });

router.post('/api/policies', (ctx: Ctx) => {
  const b = ctx.body;
  const polId = b.id ?? id('pol');
  run(
    `INSERT INTO policies(id, property_id, kind, name, scope, scope_ref, summary, details,
                          channels, active, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name,
       scope = excluded.scope, scope_ref = excluded.scope_ref, summary = excluded.summary,
       details = excluded.details, channels = excluded.channels, active = excluded.active,
       updated_at = excluded.updated_at`,
    polId, pid(ctx), str(b.kind, 'kind'), str(b.name, 'name', { max: 120 }),
    b.scope ?? 'property', b.scopeRef ?? null, b.summary ?? null, b.details ?? null,
    jsonCol(b.channels ?? []), b.active === false ? 0 : 1, nowIso(),
  );
  audit(ctx.auth, { action: 'policy.upsert', entity: 'POLICY', entityId: polId, entityRef: b.name }, ctx.ip);
  return { id: polId };
}, { perm: 'config.write' });

router.delete('/api/policies/:id', (ctx: Ctx) => {
  run('DELETE FROM policies WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  return { ok: true };
}, { perm: 'config.write' });

// ─── Companies / travel agents (also the AR account holders) ──
router.get('/api/companies', (ctx: Ctx) => all<any>(
  'SELECT * FROM companies WHERE property_id = ? ORDER BY name', pid(ctx),
).map((c) => ({
  id: c.id, code: c.code, name: c.name, type: c.type, contactName: c.contact_name,
  email: c.email, phone: c.phone, address: c.address, taxId: c.tax_id,
  arEnabled: c.ar_enabled === 1, creditLimitMinor: c.credit_limit_minor,
  commissionBp: c.commission_bp, paymentTermsDays: c.payment_terms_days, active: c.active === 1,
  balanceMinor: scalar<number>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'payment' THEN -amount_minor ELSE amount_minor END),0) AS t
       FROM ar_transactions WHERE company_id = ?`, c.id),
})), { perm: 'config.read' });

router.post('/api/companies', (ctx: Ctx) => {
  const b = ctx.body;
  const cId = id('cmp');
  run(
    `INSERT INTO companies(id, property_id, code, name, type, contact_name, email, phone, address,
                           tax_id, ar_enabled, credit_limit_minor, commission_bp, payment_terms_days,
                           active, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    cId, pid(ctx), slugCode(b.code, 'code', 16), str(b.name, 'name', { max: 120 }),
    oneOf(b.type, 'type', ['company', 'travel_agent', 'tour_operator', 'ota'] as const, 'company'),
    b.contactName ?? null, b.email ?? null, b.phone ?? null, b.address ?? null, b.taxId ?? null,
    boolIn(b.arEnabled) ? 1 : 0, money(b.creditLimitMinor ?? 0, 'creditLimitMinor'),
    int(b.commissionBp ?? 0, 'commissionBp', { min: 0, max: 10000 }),
    int(b.paymentTermsDays ?? 30, 'paymentTermsDays', { min: 0, max: 365 }),
    b.active === false ? 0 : 1, nowIso(),
  );
  audit(ctx.auth, { action: 'company.create', entity: 'COMPANY', entityId: cId, entityRef: b.name }, ctx.ip);
  return { id: cId };
}, { perm: 'config.write' });

router.patch('/api/companies/:id', (ctx: Ctx) => {
  const map: Record<string, string> = {
    name: 'name', type: 'type', contactName: 'contact_name', email: 'email', phone: 'phone',
    address: 'address', taxId: 'tax_id', creditLimitMinor: 'credit_limit_minor',
    commissionBp: 'commission_bp', paymentTermsDays: 'payment_terms_days',
  };
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (ctx.body[k] !== undefined) { sets.push(`${col} = ?`); args.push(ctx.body[k]); }
  }
  if (ctx.body.arEnabled !== undefined) { sets.push('ar_enabled = ?'); args.push(ctx.body.arEnabled ? 1 : 0); }
  if (ctx.body.active !== undefined) { sets.push('active = ?'); args.push(ctx.body.active ? 1 : 0); }
  if (!sets.length) return { ok: true };
  args.push(ctx.params.id, pid(ctx));
  run(`UPDATE companies SET ${sets.join(', ')} WHERE id = ? AND property_id = ?`, ...args);
  return { ok: true };
}, { perm: 'config.write' });

// ─── Settings (free-form per-property configuration) ─────────
router.get('/api/settings', (ctx: Ctx) => {
  const rows = all<any>('SELECT key, value FROM settings WHERE property_id = ?', pid(ctx));
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = parseJson<unknown>(r.value, null);
  return out;
}, { perm: 'config.read' });

router.put('/api/settings/:key', (ctx: Ctx) => {
  run(
    `INSERT INTO settings(property_id, key, value, updated_at, updated_by) VALUES(?,?,?,?,?)
     ON CONFLICT(property_id, key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    pid(ctx), ctx.params.key, jsonCol(ctx.body.value ?? ctx.body), nowIso(), ctx.auth.userName,
  );
  audit(ctx.auth, {
    action: 'settings.update', entity: 'SETTINGS', entityRef: ctx.params.key, after: ctx.body,
  }, ctx.ip);
  return { ok: true };
}, { perm: 'config.write' });
