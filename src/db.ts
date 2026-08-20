// ─────────────────────────────────────────────────────────────
// SQLite persistence layer (node:sqlite — no external deps).
//
// Every write in this API goes through here. The database file is the
// system of record: restart the process and the hotel's state is intact.
// ─────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DB_PATH = config.databasePath;

mkdirSync(dirname(DB_PATH), { recursive: true });

export const database = new DatabaseSync(DB_PATH);

// Durability and contention settings. These are per-connection, so they are set
// here rather than in schema.sql — that file only runs its PRAGMAs once, at
// migration time.
//
//   busy_timeout  wait rather than failing instantly when another connection
//                 (a backup, a verification script, a second process) holds the
//                 write lock. The default of 0 turns a momentary overlap into
//                 an error.
//   synchronous   FULL: a committed transaction has reached the disk. This is a
//                 money system; the throughput cost is not worth the risk.
//   foreign_keys  enforced, not advisory.
database.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = FULL;
  PRAGMA foreign_keys = ON;
`);

// ─── Value binding ───────────────────────────────────────────
// SQLite accepts null / number / bigint / string / Uint8Array only.
// Normalise the JS values we actually use (booleans, undefined, Date).
export type Bindable = null | number | bigint | string | Uint8Array;

function bindValue(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Cannot bind non-finite number: ${v}`);
    return v;
  }
  if (typeof v === 'bigint' || typeof v === 'string') return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  // Objects / arrays are stored as JSON by explicit callers; guard here.
  throw new Error(`Cannot bind value of type ${typeof v} — JSON.stringify it first`);
}

function bindAll(params: unknown[]): Bindable[] {
  return params.map(bindValue);
}

// Statement cache — prepared statements are reused across requests.
const stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
function prep(sql: string) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = database.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

/** Rows as plain objects (node:sqlite returns null-prototype objects). */
export function all<T = any>(sql: string, ...params: unknown[]): T[] {
  return prep(sql).all(...bindAll(params)) as T[];
}

export function get<T = any>(sql: string, ...params: unknown[]): T | undefined {
  return prep(sql).get(...bindAll(params)) as T | undefined;
}

export function run(sql: string, ...params: unknown[]) {
  return prep(sql).run(...bindAll(params));
}

export function exec(sql: string) {
  database.exec(sql);
}

/** Scalar helper: SELECT count(*) … */
export function scalar<T = number>(sql: string, ...params: unknown[]): T {
  const row = get<Record<string, T>>(sql, ...params);
  if (!row) return 0 as unknown as T;
  return Object.values(row)[0] as T;
}

let txDepth = 0;

/**
 * Run `fn` inside a transaction. Nested calls join the outer transaction
 * (SQLite has no real nesting for our purposes — savepoints are used).
 * Any throw rolls the whole thing back: a half-posted folio or a half-run
 * night audit must never survive.
 */
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) {
    const sp = `sp_${txDepth}`;
    database.exec(`SAVEPOINT ${sp}`);
    txDepth++;
    try {
      const out = fn();
      database.exec(`RELEASE ${sp}`);
      return out;
    } catch (e) {
      database.exec(`ROLLBACK TO ${sp}`);
      database.exec(`RELEASE ${sp}`);
      throw e;
    } finally {
      txDepth--;
    }
  }
  database.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const out = fn();
    database.exec('COMMIT');
    return out;
  } catch (e) {
    try { database.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  } finally {
    txDepth = 0;
  }
}

// ─── Migration ───────────────────────────────────────────────
const SCHEMA_VERSION = '11';

/**
 * Add a column to an existing table if it is not already there.
 * `CREATE TABLE IF NOT EXISTS` cannot evolve a table that already exists, so
 * every column added after v1 goes through here — that keeps an installation
 * with live data upgradeable rather than needing a rebuild.
 */
function ensureColumn(table: string, column: string, definition: string) {
  const columns = all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (columns.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Bring an index in line with its definition.
 *
 * `CREATE INDEX IF NOT EXISTS` does nothing when an index of that name already
 * exists — even if its columns have changed since. A widened index therefore
 * reaches new installations and silently skips every existing one, which is the
 * worst possible outcome: the query is fast on the developer's fresh database
 * and slow on the one with three years of bookings in it. This compares what is
 * actually there and rebuilds only when they differ.
 */
function ensureIndex(name: string, table: string, columns: string) {
  const wanted = `CREATE INDEX ${name} ON ${table}(${columns})`;
  const existing = get<{ sql: string | null }>(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, name,
  )?.sql;
  const normalise = (s: string) =>
    s.replace(/IF NOT EXISTS/i, '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
  if (existing && normalise(existing) === normalise(wanted)) return;
  database.exec(`DROP INDEX IF EXISTS ${name}`);
  database.exec(wanted);
}

export function migrate() {
  const sql = readFileSync(join(HERE, 'schema.sql'), 'utf8');
  database.exec(sql);

  // v2 — two-factor authentication, password resets and long-lived sessions.
  ensureColumn('users', 'mfa_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'mfa_secret', 'TEXT');
  ensureColumn('users', 'mfa_enrolled_at', 'TEXT');
  ensureColumn('users', 'password_changed_at', 'TEXT');
  ensureColumn('sessions', 'mfa_pending', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('sessions', 'remembered', 'INTEGER NOT NULL DEFAULT 0');

  // v3 — the reservation list sorted in memory. `ix_res_status` grew the two
  // sort columns so a status-filtered page can be walked rather than sorted;
  // existing databases need it rebuilt, not skipped. Keep this in step with
  // schema.sql.
  ensureIndex('ix_res_status', 'reservations', 'property_id, status, arrival, guest_name');

  // v4 — reporting a booking's fate back to the channel it came from. Kept on
  // the reservation rather than in a side table because "was this no-show ever
  // reported?" is a question asked while looking at the booking.
  ensureColumn('reservations', 'channel_report_kind', 'TEXT');
  ensureColumn('reservations', 'channel_report_status', 'TEXT');
  ensureColumn('reservations', 'channel_reported_at', 'TEXT');
  ensureColumn('reservations', 'channel_report_error', 'TEXT');
  ensureColumn('reservations', 'channel_report_attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('reservations', 'channel_report_request', 'TEXT');
  ensureColumn('reservations', 'channel_report_response', 'TEXT');

  // v5 — guest messaging through the channel. `messages` existed as a local
  // notes thread; these columns are what make it a conversation with somebody.
  ensureColumn('messages', 'channel_code', 'TEXT');
  ensureColumn('messages', 'external_id', 'TEXT');
  ensureColumn('messages', 'delivery_error', 'TEXT');
  ensureColumn('messages', 'accepted_at', 'TEXT');
  ensureColumn('messages', 'read_at', 'TEXT');
  ensureColumn('messages', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  // Dedup key for the poll: the same channel message must not land twice, and
  // a poll that overlaps its own window is normal rather than exceptional.
  ensureIndex('ix_msg_external', 'messages', 'property_id, external_id');

  // v6 — last-room protection. How many rooms of a type are held back from the
  // channels, so the last one cannot be sold twice by two OTAs at once. Zero
  // means sell everything, which is the default: the protection costs occupancy
  // and that is the property's call, not ours.
  ensureColumn('room_types', 'protect_last_rooms', 'INTEGER NOT NULL DEFAULT 0');

  // v7 — what is actually in the room. Sleeping capacity is derived from this;
  // max_occupancy only ever said how many guests were permitted.
  ensureColumn('room_types', 'bed_config', 'TEXT');
  ensureColumn('rooms', 'bed_config', 'TEXT');

  // v8 — which OTA a booking actually came from, when the channel is a hub.
  //
  // `channel_code` is the *connection* — BEDS24 — and rate rules and mappings
  // are keyed on it, so it cannot double as the OTA name. But a property
  // connected through Beds24 sells on Hostelworld, Booking.com and Airbnb at
  // once, and "every booking came from BEDS24" answers none of the questions
  // worth asking: which OTA produces, which cancels, which earns its
  // commission. Beds24 sends it as `referer` on every booking; it is kept here
  // rather than folded into `source`, which reports on business origin
  // (Direct / OTA / Corporate) and would lose that distinction.
  ensureColumn('reservations', 'ota_channel', 'TEXT');

  // v9 — the OTAs behind the hub.
  //
  // Beds24 is one connection but many shopfronts, and the questions a property
  // asks are per-shopfront: which OTA produces, which cancels, which has gone
  // quiet. Beds24's own API will not answer "which OTAs am I connected to" —
  // `/channels` returns literal null and `/properties/channels` 500s, with the
  // `all:channels` scope granted — so what is known about each OTA is kept here
  // along with *how* it came to be known, and the screen says which.
  database.exec(`
    CREATE TABLE IF NOT EXISTS channel_otas (
      id           TEXT PRIMARY KEY,
      property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      channel_id   TEXT REFERENCES channels(id) ON DELETE CASCADE,
      code         TEXT NOT NULL,               -- Beds24's own key: 'hostelworld'
      name         TEXT NOT NULL,               -- 'Hostelworld'
      -- How we know, weakest to strongest:
      --   available  nothing suggests it is in use
      --   declared   a person said so; the API cannot tell us
      --   evidence   Beds24 holds a rate code for it — a hint, not proof
      --   confirmed  a booking has arrived from it; not arguable
      state        TEXT NOT NULL DEFAULT 'available',
      rate_code    TEXT,
      bookings     INTEGER NOT NULL DEFAULT 0,
      last_booking_at TEXT,
      declared     INTEGER NOT NULL DEFAULT 0,  -- the operator's own switch
      first_seen_at TEXT,
      updated_at   TEXT NOT NULL,
      UNIQUE (property_id, code)
    );
    CREATE INDEX IF NOT EXISTS ix_otas_property ON channel_otas(property_id, state);
  `);

  // v10 — what the channel holds, kept beside what we hold.
  //
  // Beds24 sells `qty` units of a room; Helio holds rooms and beds. They are
  // two numbers for the same inventory and nothing has been comparing them, so
  // a change on either side drifts silently — and drift on this number is not a
  // cosmetic bug, it is selling a bed that does not exist. Recorded on the
  // mapping at discovery time so the comparison costs nothing to display.
  // v11 — who a closure applies to.
  //
  // A property closes rooms for two quite different reasons: "stop the OTAs
  // selling this, the desk carries on" and "nobody sells this, it is being
  // repainted". Helio had one mechanism for both, and a stop-sell with no
  // channel scope matched a walk-in too — so closing rooms on the OTAs also
  // stopped reception serving the guest standing in front of them.
  //
  // **Existing rows default to `all`**, which is what they have meant until
  // now. Silently reinterpreting stored restrictions would open dates somebody
  // deliberately shut.
  ensureColumn('restrictions', 'applies_to', `TEXT NOT NULL DEFAULT 'all'`);

  ensureColumn('channel_mappings', 'external_qty', 'INTEGER');
  ensureColumn('channel_mappings', 'external_max_people', 'INTEGER');
  ensureColumn('channel_mappings', 'external_seen_at', 'TEXT');

  // When a queued push was last tried, so a failed one can be retried on a
  // widening delay instead of being abandoned. `attempts` alone cannot say how
  // long a row has been waiting, and `created_at` is when it was queued, not
  // when it last went out. See `reviveParkedPushes`.
  ensureColumn('channel_queue', 'last_attempt_at', 'TEXT');

  run(
    `INSERT INTO schema_meta(key, value) VALUES('version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    SCHEMA_VERSION,
  );
  // v12 — the registration record: a scanned identity document and the guest's
  // signature, captured at check-in.
  //
  // Both are held in the database rather than on disk so they are covered by
  // the existing backup and restore, and both are encrypted at rest, because a
  // table of passport photographs is the single most sensitive thing this
  // system would hold.
  exec(`
    CREATE TABLE IF NOT EXISTS reservation_documents (
      id             TEXT PRIMARY KEY,
      property_id    TEXT NOT NULL,
      reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      guest_name     TEXT,
      kind           TEXT NOT NULL,
      label          TEXT,
      mime           TEXT NOT NULL,
      size_bytes     INTEGER NOT NULL,
      data           TEXT NOT NULL,
      uploaded_at    TEXT NOT NULL,
      uploaded_by    TEXT
    )`);
  ensureIndex('ix_resdoc_reservation', 'reservation_documents', 'property_id, reservation_id');
}

/** True when no property exists yet — the app must run first-time setup. */
export function needsSetup(): boolean {
  return scalar<number>('SELECT count(*) AS n FROM properties') === 0;
}

// ─── Sequence numbers (confirmations, folios, invoices) ──────
export function nextSequence(propertyId: string, name: string, start = 1): number {
  return tx(() => {
    const row = get<{ next_value: number }>(
      'SELECT next_value FROM sequences WHERE property_id = ? AND name = ?',
      propertyId, name,
    );
    if (!row) {
      run('INSERT INTO sequences(property_id, name, next_value) VALUES(?,?,?)',
        propertyId, name, start + 1);
      return start;
    }
    run('UPDATE sequences SET next_value = next_value + 1 WHERE property_id = ? AND name = ?',
      propertyId, name);
    return row.next_value;
  });
}

// ─── JSON column helpers ─────────────────────────────────────
export function jsonCol(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return JSON.stringify(v);
}

export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v === '') return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}
