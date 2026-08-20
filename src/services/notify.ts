// ─────────────────────────────────────────────────────────────
// The notification feed — what happened, across the whole property.
//
// This is not the alarm system. `alerts.ts` handles the three things worth
// making a *noise* about; this is the running record a person reads when they
// choose to: a booking came in, a guest checked out, a payment cleared, a
// channel push failed, the backup ran.
//
// Until now only three things wrote here — the night audit, the backup and the
// integrity check — so the bell was almost always empty while the property was
// busy. Everything significant now goes through `notify()`.
//
// Two rules keep the feed worth reading:
//
//   · **A notification says what happened, not that something happened.**
//     "Booking BK-0043 · Priya Ramanathan · 3 nights from 12 Aug" is useful.
//     "Reservation updated" is noise somebody learns to ignore.
//
//   · **Every notification can be opened.** A feed you cannot act from is a
//     log file with a bell on it, so each carries a link to the record.
// ─────────────────────────────────────────────────────────────
import { all, run, scalar } from '../db.ts';
import { id, nowIso } from '../lib/util.ts';

export type NotificationSeverity = 'info' | 'success' | 'warn' | 'critical';

/**
 * Where a notification came from. Used for filtering and for the icon, so it is
 * a closed set rather than free text — a feed with forty distinct sources
 * cannot be filtered by anybody.
 */
export type NotificationSource =
  | 'Reservations' | 'Front Desk' | 'Cashier' | 'Housekeeping'
  | 'Channels' | 'Guests' | 'Revenue' | 'Night Audit' | 'System';

export interface NotifyInput {
  source: NotificationSource;
  title: string;
  message?: string;
  severity?: NotificationSeverity;
  /** A hash route, so clicking opens the record rather than a list. */
  link?: string;
  /** Scoped to one user when it is genuinely personal; otherwise everyone sees it. */
  userId?: string | null;
}

/**
 * Record something that happened.
 *
 * Deliberately never throws. A notification is a side effect of real work — a
 * booking, a payment — and a failure to record the note must not roll back the
 * thing it was noting. That is the one place where swallowing an error is
 * correct rather than lazy.
 */
export function notify(propertyId: string, input: NotifyInput): string | null {
  try {
    const notificationId = id('ntf');
    run(
      `INSERT INTO notifications(id, property_id, ts, title, message, source, severity, user_id, link)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      notificationId, propertyId, nowIso(), input.title, input.message ?? null,
      input.source, input.severity ?? 'info', input.userId ?? null, input.link ?? null,
    );
    return notificationId;
  } catch (e) {
    process.stderr.write(
      `[notify] could not record "${input.title}": ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

/** A reservation's own page, so a notification opens the booking. */
export function reservationLink(reservationId: string): string {
  return `#/guest-dashboard/${reservationId}`;
}

// ─── Reading ─────────────────────────────────────────────────

export interface NotificationFilters {
  source?: string;
  unreadOnly?: boolean;
  severity?: string;
  limit?: number;
}

export function listNotifications(
  propertyId: string, userId: string, filters: NotificationFilters = {},
) {
  const where = ['n.property_id = ?'];
  const params: unknown[] = [propertyId];

  // A notification addressed to one person is theirs; everything else is the
  // property's. Without this a personal note would either leak or be invisible.
  where.push('(n.user_id IS NULL OR n.user_id = ?)');
  params.push(userId);

  if (filters.source) { where.push('n.source = ?'); params.push(filters.source); }
  if (filters.severity) { where.push('n.severity = ?'); params.push(filters.severity); }
  if (filters.unreadOnly) where.push('n.read_at IS NULL');

  const limit = Math.min(filters.limit ?? 100, 300);
  const rows = all<any>(
    `SELECT * FROM notifications n
      WHERE ${where.join(' AND ')}
      ORDER BY n.ts DESC LIMIT ${limit}`,
    ...params,
  );

  return {
    notifications: rows.map((n) => ({
      id: n.id, title: n.title, message: n.message, source: n.source,
      severity: n.severity, ts: n.ts, unread: !n.read_at, link: n.link,
    })),
    unread: scalar<number>(
      `SELECT count(*) AS n FROM notifications
        WHERE property_id = ? AND read_at IS NULL AND (user_id IS NULL OR user_id = ?)`,
      propertyId, userId,
    ),
    // The filter bar shows only sources that have actually produced something,
    // rather than nine tabs of which six are always empty.
    sources: all<{ source: string; n: number; unread: number }>(
      `SELECT source, count(*) AS n, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread
         FROM notifications
        WHERE property_id = ? AND (user_id IS NULL OR user_id = ?)
        GROUP BY source ORDER BY n DESC`,
      propertyId, userId,
    ),
    now: nowIso(),
  };
}

/** Everything since a timestamp — what makes the bell update without a refresh. */
export function notificationsSince(propertyId: string, userId: string, since: string) {
  return all<any>(
    `SELECT * FROM notifications
      WHERE property_id = ? AND (user_id IS NULL OR user_id = ?) AND ts > ?
      ORDER BY ts`,
    propertyId, userId, since,
  ).map((n) => ({
    id: n.id, title: n.title, message: n.message, source: n.source,
    severity: n.severity, ts: n.ts, unread: !n.read_at, link: n.link,
  }));
}

export function markRead(propertyId: string, notificationId: string) {
  run('UPDATE notifications SET read_at = ? WHERE id = ? AND property_id = ?',
    nowIso(), notificationId, propertyId);
  return { ok: true };
}

export function markAllRead(propertyId: string, userId: string, source?: string) {
  const n = source
    ? run(
      `UPDATE notifications SET read_at = ?
        WHERE property_id = ? AND read_at IS NULL AND source = ?
          AND (user_id IS NULL OR user_id = ?)`,
      nowIso(), propertyId, source, userId,
    )
    : run(
      `UPDATE notifications SET read_at = ?
        WHERE property_id = ? AND read_at IS NULL AND (user_id IS NULL OR user_id = ?)`,
      nowIso(), propertyId, userId,
    );
  return { read: Number(n.changes ?? 0) };
}

/**
 * The feed is a running record, not an archive.
 *
 * Read notifications older than the cutoff go; unread ones stay however old,
 * because deleting something nobody has looked at is deleting the message.
 */
export function purgeOldNotifications(propertyId: string, before: string): number {
  const n = run(
    `DELETE FROM notifications
      WHERE property_id = ? AND ts < ? AND read_at IS NOT NULL`,
    propertyId, before,
  );
  return Number(n.changes ?? 0);
}

/** Used by the check suite and the dashboard tile. */
export function unreadCount(propertyId: string, userId: string): number {
  return scalar<number>(
    `SELECT count(*) AS n FROM notifications
      WHERE property_id = ? AND read_at IS NULL AND (user_id IS NULL OR user_id = ?)`,
    propertyId, userId,
  );
}


