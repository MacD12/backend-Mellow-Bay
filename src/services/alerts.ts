// ─────────────────────────────────────────────────────────────
// The alert feed — what the app polls, and what the alarms fire from.
//
// Three things are worth raising a noise about: an overbooking, a booking
// arriving, and a booking being cancelled. Everything else belongs in the
// notification list, which people read when they choose to.
//
// Two rules shape this file:
//
//   · **Only new things make a sound.** The feed is queried with a `since`, and
//     the browser seeds that with the moment the screen opened. An alarm that
//     goes off on every page refresh is how alarms get switched off for good.
//
//   · **Silence is a decision, not an accident.** Each alert can be turned off
//     on its own, and the settings say plainly what is currently muted. A
//     system that quietly stops alerting is worse than one that never did.
//
// The Actor type is taken from auth rather than from reservations, so raising an
// alert from inside the reservation service does not create an import cycle.
// ─────────────────────────────────────────────────────────────
import { all, get, run, scalar, jsonCol, parseJson } from '../db.ts';
import { id, nowIso, HttpError } from '../lib/util.ts';
import type { AuthContext } from '../auth.ts';

type Actor = Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>;

export type AlertKind = 'overbooking' | 'booking.new' | 'booking.cancelled';
export const ALERT_KINDS: AlertKind[] = ['overbooking', 'booking.new', 'booking.cancelled'];

export interface AlertSettings {
  overbooking: { enabled: boolean; repeat: 'once' | 'three' | 'until-acknowledged' };
  'booking.new': { enabled: boolean };
  'booking.cancelled': { enabled: boolean };
  volume: number;                       // 0–100
  quietHours: {
    enabled: boolean;
    from: string;                       // 'HH:MM'
    to: string;
    /** Overbooking is worth waking for even inside quiet hours. */
    allowOverbooking: boolean;
  };
}

const DEFAULTS: AlertSettings = {
  overbooking: { enabled: true, repeat: 'until-acknowledged' },
  'booking.new': { enabled: true },
  'booking.cancelled': { enabled: true },
  volume: 70,
  quietHours: { enabled: false, from: '22:00', to: '07:00', allowOverbooking: true },
};

const SETTINGS_KEY = 'alerts';

export function alertSettings(propertyId: string): AlertSettings {
  const row = get<{ value: string }>(
    'SELECT value FROM settings WHERE property_id = ? AND key = ?', propertyId, SETTINGS_KEY);
  const stored = parseJson<Partial<AlertSettings>>(row?.value, {});
  // Merged rather than replaced, so a setting added in a later version arrives
  // switched on instead of silently missing.
  return {
    ...DEFAULTS,
    ...stored,
    overbooking: { ...DEFAULTS.overbooking, ...(stored.overbooking ?? {}) },
    'booking.new': { ...DEFAULTS['booking.new'], ...(stored['booking.new'] ?? {}) },
    'booking.cancelled': { ...DEFAULTS['booking.cancelled'], ...(stored['booking.cancelled'] ?? {}) },
    quietHours: { ...DEFAULTS.quietHours, ...(stored.quietHours ?? {}) },
  };
}

export function saveAlertSettings(
  propertyId: string, actor: Actor, patch: Partial<AlertSettings>,
): AlertSettings {
  const current = alertSettings(propertyId);
  const next: AlertSettings = {
    ...current,
    ...patch,
    overbooking: { ...current.overbooking, ...(patch.overbooking ?? {}) },
    'booking.new': { ...current['booking.new'], ...(patch['booking.new'] ?? {}) },
    'booking.cancelled': { ...current['booking.cancelled'], ...(patch['booking.cancelled'] ?? {}) },
    quietHours: { ...current.quietHours, ...(patch.quietHours ?? {}) },
  };
  next.volume = Math.max(0, Math.min(100, Math.round(next.volume)));
  if (!/^\d{2}:\d{2}$/.test(next.quietHours.from) || !/^\d{2}:\d{2}$/.test(next.quietHours.to)) {
    throw new HttpError(400, 'Quiet hours must be times in HH:MM');
  }

  run(
    `INSERT INTO settings(property_id, key, value, updated_at, updated_by)
     VALUES(?,?,?,?,?)
     ON CONFLICT(property_id, key) DO UPDATE SET
       value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    propertyId, SETTINGS_KEY, jsonCol(next), nowIso(), actor.userName,
  );
  return next;
}

/**
 * Is the clock inside the quiet window?
 *
 * Handles a window that crosses midnight, which is the normal case — 22:00 to
 * 07:00 is two ranges, not one.
 */
export function inQuietHours(settings: AlertSettings, at = new Date()): boolean {
  if (!settings.quietHours.enabled) return false;
  const now = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const { from, to } = settings.quietHours;
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

// ─── Raising ─────────────────────────────────────────────────

/**
 * Record an alert. Always stored, whatever the settings say.
 *
 * Muting an alert silences the *sound*, not the record — a property that turned
 * the cancellation chime off still needs the cancellation in the feed. What the
 * settings control is what the browser does when it sees it.
 */
export function raise(propertyId: string, input: {
  kind: AlertKind;
  title: string;
  body?: string;
  severity?: 'info' | 'warn' | 'critical';
  reservationId?: string | null;
  overbookingId?: string | null;
}) {
  const eventId = id('alt');
  run(
    `INSERT INTO alert_events(id, property_id, ts, kind, severity, title, body,
                              reservation_id, overbooking_id)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    eventId, propertyId, nowIso(), input.kind, input.severity ?? 'info',
    input.title, input.body ?? null,
    input.reservationId ?? null, input.overbookingId ?? null,
  );
  return eventId;
}

// ─── Reading ─────────────────────────────────────────────────

export interface AlertRow {
  id: string;
  ts: string;
  kind: AlertKind;
  severity: string;
  title: string;
  body: string | null;
  reservationId: string | null;
  overbookingId: string | null;
  acknowledgedAt: string | null;
}

function shape(r: any): AlertRow {
  return {
    id: r.id, ts: r.ts, kind: r.kind, severity: r.severity,
    title: r.title, body: r.body,
    reservationId: r.reservation_id, overbookingId: r.overbooking_id,
    acknowledgedAt: r.acknowledged_at,
  };
}

/**
 * Everything since `since`, oldest first.
 *
 * Without `since` this returns the recent feed for display but marks it
 * `replay: true` — the browser shows those and stays silent. That distinction
 * is the whole reason a refresh does not set off the alarm.
 */
export function feed(propertyId: string, opts: { since?: string; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = opts.since
    ? all<any>(
      `SELECT * FROM alert_events WHERE property_id = ? AND ts > ?
        ORDER BY ts LIMIT ${limit}`,
      propertyId, opts.since,
    )
    : all<any>(
      `SELECT * FROM alert_events WHERE property_id = ?
        ORDER BY ts DESC LIMIT ${limit}`,
      propertyId,
    ).reverse();

  return {
    events: rows.map(shape),
    replay: !opts.since,
    now: nowIso(),
    settings: alertSettings(propertyId),
    quiet: inQuietHours(alertSettings(propertyId)),
    // Counted by distinct overbooking, not by event. One problem that got worse
    // twice raised three alerts, and telling somebody there are "3 overbookings"
    // when there is one is the sort of inaccuracy that makes people stop
    // believing the number.
    unacknowledged: scalar<number>(
      `SELECT count(DISTINCT COALESCE(overbooking_id, id)) AS n FROM alert_events
        WHERE property_id = ? AND kind = 'overbooking' AND acknowledged_at IS NULL`,
      propertyId,
    ),
  };
}

export function acknowledgeAlert(propertyId: string, actor: Actor, eventId: string) {
  const row = get<any>('SELECT * FROM alert_events WHERE id = ? AND property_id = ?',
    eventId, propertyId);
  if (!row) throw new HttpError(404, 'Alert not found');
  run('UPDATE alert_events SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?',
    nowIso(), actor.userName, eventId);
  return { ok: true };
}

/** Silences a repeating alarm in one action, which is what a person wants. */
export function acknowledgeAll(propertyId: string, actor: Actor, kind?: AlertKind) {
  const n = kind
    ? run(
      `UPDATE alert_events SET acknowledged_at = ?, acknowledged_by = ?
        WHERE property_id = ? AND kind = ? AND acknowledged_at IS NULL`,
      nowIso(), actor.userName, propertyId, kind,
    )
    : run(
      `UPDATE alert_events SET acknowledged_at = ?, acknowledged_by = ?
        WHERE property_id = ? AND acknowledged_at IS NULL`,
      nowIso(), actor.userName, propertyId,
    );
  return { acknowledged: Number(n.changes ?? 0) };
}

/** Housekeeping: the feed is a live signal, not an archive. */
export function purgeOldAlerts(propertyId: string, before: string) {
  const n = run('DELETE FROM alert_events WHERE property_id = ? AND ts < ?', propertyId, before);
  return Number(n.changes ?? 0);
}
