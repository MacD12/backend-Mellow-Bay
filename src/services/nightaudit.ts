// ─────────────────────────────────────────────────────────────
// Night audit — the transaction that closes one business day and opens
// the next. It is the only operation allowed to move `business_date`.
//
// It runs inside a single database transaction: either the whole day rolls
// (charges posted, statistics frozen, date advanced) or nothing does.
// ─────────────────────────────────────────────────────────────
import { all, get, run, tx, scalar, jsonCol } from '../db.ts';
import { id, nowIso, addDays, HttpError } from '../lib/util.ts';
import { ensureFolio, postCharge } from './folio.ts';
import { availabilityGrid } from './availability.ts';
import { markNoShow, type Actor } from './reservations.ts';
import { generateTasks } from './housekeeping.ts';
import { audit } from './audit.ts';
import { backupAfterNightAudit } from './backup.ts';
import { nightlyMaintenance } from './database.ts';
import { runDueScheduledChanges } from './rateplanning.ts';

export interface PreflightIssue {
  kind: 'pending-arrival' | 'pending-departure' | 'unassigned-in-house' | 'open-shift' | 'unposted-night';
  severity: 'block' | 'warn';
  count: number;
  message: string;
  items: { id: string; label: string }[];
}

function property(propertyId: string) {
  const p = get<any>('SELECT * FROM properties WHERE id = ?', propertyId);
  if (!p) throw new HttpError(404, 'Property not found');
  return p;
}

export function preflight(propertyId: string): {
  businessDate: string; nextDate: string; issues: PreflightIssue[]; canRun: boolean;
  counts: { inHouse: number; arrivals: number; departures: number; roomsToPost: number };
} {
  const prop = property(propertyId);
  const date = prop.business_date;
  const issues: PreflightIssue[] = [];

  const pendingArrivals = all<any>(
    `SELECT id, confirmation, guest_name FROM reservations
      WHERE property_id = ? AND arrival <= ? AND status IN ('Tentative','Confirmed','Guaranteed')`,
    propertyId, date,
  );
  if (pendingArrivals.length) {
    issues.push({
      kind: 'pending-arrival', severity: 'warn', count: pendingArrivals.length,
      message: `${pendingArrivals.length} arrival(s) never checked in — they will be marked no-show`,
      items: pendingArrivals.map((r) => ({ id: r.id, label: `${r.confirmation} · ${r.guest_name}` })),
    });
  }

  const pendingDepartures = all<any>(
    `SELECT id, confirmation, guest_name, departure FROM reservations
      WHERE property_id = ? AND status = 'Checked-in' AND departure <= ?`,
    propertyId, date,
  );
  if (pendingDepartures.length) {
    issues.push({
      kind: 'pending-departure', severity: 'block', count: pendingDepartures.length,
      message: `${pendingDepartures.length} guest(s) are past their departure date and still in-house`,
      items: pendingDepartures.map((r) => ({ id: r.id, label: `${r.confirmation} · ${r.guest_name} (due ${r.departure})` })),
    });
  }

  const unassigned = all<any>(
    `SELECT id, confirmation, guest_name FROM reservations
      WHERE property_id = ? AND status = 'Checked-in' AND room_id IS NULL`,
    propertyId,
  );
  if (unassigned.length) {
    issues.push({
      kind: 'unassigned-in-house', severity: 'block', count: unassigned.length,
      message: `${unassigned.length} in-house reservation(s) have no room assigned`,
      items: unassigned.map((r) => ({ id: r.id, label: `${r.confirmation} · ${r.guest_name}` })),
    });
  }

  const openShifts = all<any>(
    `SELECT s.id, u.name FROM cashier_shifts s JOIN users u ON u.id = s.user_id
      WHERE s.property_id = ? AND s.closed_at IS NULL`,
    propertyId,
  );
  if (openShifts.length) {
    issues.push({
      kind: 'open-shift', severity: 'warn', count: openShifts.length,
      message: `${openShifts.length} cashier shift(s) are still open`,
      items: openShifts.map((s) => ({ id: s.id, label: s.name })),
    });
  }

  const roomsToPost = scalar<number>(
    `SELECT count(*) AS n FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.date = ? AND n.posted = 0
        AND r.status IN ('Checked-in')`,
    propertyId, date,
  );

  const inHouse = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND status = 'Checked-in'`,
    propertyId,
  );
  const arrivals = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND arrival = ?`, propertyId, date);
  const departures = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND departure = ?`, propertyId, date);

  return {
    businessDate: date,
    nextDate: addDays(date, 1),
    issues,
    canRun: !issues.some((i) => i.severity === 'block'),
    counts: { inHouse, arrivals, departures, roomsToPost },
  };
}

export interface AuditResult {
  businessDate: string;
  newBusinessDate: string;
  roomChargesPosted: number;
  roomRevenueMinor: number;
  taxPostedMinor: number;
  noShows: number;
  stats: any;
  warnings: string[];
  runId: string;
}

export function runNightAudit(
  propertyId: string, actor: Actor,
  opts: { force?: boolean; noShowChargePolicy?: 'first-night' | 'none' } = {},
): AuditResult {
  return tx(() => {
    const prop = property(propertyId);
    const date = prop.business_date;
    const next = addDays(date, 1);

    const pre = preflight(propertyId);
    if (!pre.canRun && !opts.force) {
      throw new HttpError(409, 'Night audit is blocked by open items', 'audit_blocked', {
        issues: pre.issues.filter((i) => i.severity === 'block'),
      });
    }

    const existing = get<any>(
      'SELECT * FROM audit_runs WHERE property_id = ? AND business_date = ?', propertyId, date);
    if (existing && existing.status === 'completed') {
      throw new HttpError(409, `Night audit for ${date} has already been completed`);
    }

    const runId = existing?.id ?? id('nau');
    if (existing) {
      run(`UPDATE audit_runs SET started_at = ?, status = 'running', user_name = ? WHERE id = ?`,
        nowIso(), actor.userName, runId);
    } else {
      run(
        `INSERT INTO audit_runs(id, property_id, business_date, started_at, status, user_id, user_name)
         VALUES(?,?,?,?,'running',?,?)`,
        runId, propertyId, date, nowIso(), actor.userId, actor.userName,
      );
    }

    const warnings: string[] = [];

    // ── 1. No-shows: arrivals due today that never checked in ────────────
    let noShows = 0;
    const pendingArrivals = all<any>(
      `SELECT id, confirmation, guest_name, total_minor, nights FROM reservations
        WHERE property_id = ? AND arrival <= ? AND status IN ('Tentative','Confirmed','Guaranteed')`,
      propertyId, date,
    );
    for (const r of pendingArrivals) {
      const charge = opts.noShowChargePolicy === 'none'
        ? 0
        : Math.round(r.total_minor / Math.max(1, r.nights));
      markNoShow(propertyId, actor, r.id, { chargeMinor: charge });
      noShows++;
    }

    // ── 2. Post room charges + taxes for tonight's occupied rooms ───────
    let posted = 0;
    let roomRevenue = 0;
    let taxTotal = 0;
    const nights = all<any>(
      `SELECT n.*, r.guest_name, r.confirmation, rt.name AS room_type_name
         FROM reservation_nights n
         JOIN reservations r ON r.id = n.reservation_id
         JOIN room_types rt ON rt.id = n.room_type_id
        WHERE n.property_id = ? AND n.date = ? AND n.posted = 0
          AND r.status = 'Checked-in'
        ORDER BY r.confirmation`,
      propertyId, date,
    );
    for (const n of nights) {
      const folio = ensureFolio(propertyId, n.reservation_id, n.guest_name);
      const result = postCharge(propertyId, actor, {
        folioId: folio.id,
        code: 'ROOM',
        description: `Room charge — ${n.room_type_name} — ${date}`,
        unitMinor: n.rate_minor,
        businessDate: date,
        reservationId: n.reservation_id,
        persons: n.adults + n.children,
        nights: 1,
        taxScope: 'room',
      });
      run('UPDATE reservation_nights SET posted = 1 WHERE id = ?', n.id);
      posted++;
      roomRevenue += result.amountMinor;
      taxTotal += result.taxMinor;
    }

    // ── 3. Freeze the day's statistics ──────────────────────────────────
    const stats = snapshotStats(propertyId, date);

    // ── 4. Housekeeping: a new day dirties every occupied room ──────────
    run(
      `UPDATE rooms SET status = 'Occupied Dirty'
        WHERE property_id = ? AND status = 'Occupied Clean'`,
      propertyId,
    );

    // ── 5. Release group blocks whose cutoff has passed ─────────────────
    const released = all<any>(
      `SELECT id, code FROM groups
        WHERE property_id = ? AND status = 'tentative' AND cutoff_date IS NOT NULL AND cutoff_date <= ?`,
      propertyId, date,
    );
    for (const g of released) {
      run(`UPDATE groups SET status = 'closed' WHERE id = ?`, g.id);
      run('DELETE FROM group_blocks WHERE group_id = ? AND date > ?', g.id, date);
      warnings.push(`Group ${g.code} passed its cutoff and its unsold block was released`);
    }

    // ── 6. Roll the business date ───────────────────────────────────────
    run('UPDATE properties SET business_date = ? WHERE id = ?', next, propertyId);

    // ── 7. Prepare the new day ──────────────────────────────────────────
    generateTasks(propertyId, actor, next);

    // Rate changes scheduled for the new business date take effect now — before
    // the desk opens and before the morning's channel push goes out. A change
    // that fails is recorded against its own row and does not stop the audit: a
    // mistyped rate plan must not block the close of business.
    const scheduled = runDueScheduledChanges(propertyId, actor, next);
    if (scheduled.due) {
      warnings.push(
        `${scheduled.applied} of ${scheduled.due} scheduled rate change(s) applied for ${next}`);
      for (const failed of scheduled.results.filter((r) => !r.ok)) {
        warnings.push(`Scheduled rate change "${failed.name}" failed: ${failed.error}`);
      }
    }

    const summary = {
      roomChargesPosted: posted,
      roomRevenueMinor: roomRevenue,
      taxPostedMinor: taxTotal,
      noShows,
      stats,
      warnings,
    };
    run(
      `UPDATE audit_runs SET finished_at = ?, status = 'completed', summary = ? WHERE id = ?`,
      nowIso(), jsonCol(summary), runId,
    );

    run(
      `INSERT INTO notifications(id, property_id, ts, title, message, source, severity)
       VALUES(?,?,?,?,?,'Night Audit','info')`,
      id('ntf'), propertyId, nowIso(),
      `Night audit completed for ${date}`,
      `${posted} room charge(s) posted · business date is now ${next}`,
    );

    audit(actor, {
      action: 'nightaudit.run', entity: 'PROPERTY', entityId: propertyId,
      entityRef: date, before: { businessDate: date }, after: { businessDate: next, ...summary },
      elevated: !!opts.force,
    });

    // The close of business is the natural point for both: the day's postings
    // are committed and the property is at its quietest. Queued rather than run
    // inline so neither a backup nor a maintenance problem can roll back a
    // completed audit.
    setImmediate(() => {
      try {
        // Check first — a snapshot of a corrupt database is worse than none,
        // because it looks like protection.
        const check = nightlyMaintenance(actor.userName);
        if (!check.check.ok) {
          process.stderr.write(
            `[database] integrity check FAILED after night audit: ${check.check.integrity}\n`);
        }
      } catch (e) {
        process.stderr.write(`[database] nightly maintenance failed: ${e}\n`);
      }
      try {
        backupAfterNightAudit(actor.userName);
      } catch (e) {
        process.stderr.write(`[backup] post-audit snapshot failed: ${e}\n`);
      }
    });

    return {
      businessDate: date,
      newBusinessDate: next,
      roomChargesPosted: posted,
      roomRevenueMinor: roomRevenue,
      taxPostedMinor: taxTotal,
      noShows,
      stats,
      warnings,
      runId,
    };
  });
}

/** Compute and persist the statistics row for a completed business date. */
export function snapshotStats(propertyId: string, date: string) {
  const grid = availabilityGrid(propertyId, date, addDays(date, 1));
  const roomsTotal = grid.reduce((s, c) => s + c.physical, 0);
  const roomsOoo = grid.reduce((s, c) => s + c.blocked, 0);
  const roomsSold = grid.reduce((s, c) => s + c.sold, 0);

  const revenue = get<any>(
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'charge' AND code = 'ROOM' THEN amount_minor ELSE 0 END), 0) AS room_rev,
       COALESCE(SUM(CASE WHEN kind = 'charge' AND code <> 'ROOM' THEN amount_minor ELSE 0 END), 0) AS other_rev,
       COALESCE(SUM(CASE WHEN kind = 'tax' THEN amount_minor ELSE 0 END), 0) AS tax,
       COALESCE(SUM(CASE WHEN kind = 'payment' THEN -amount_minor ELSE 0 END), 0) AS payments
     FROM folio_lines WHERE property_id = ? AND business_date = ? AND voided = 0`,
    propertyId, date,
  );

  const arrivals = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND arrival = ?
       AND status IN ('Checked-in','Checked-out')`, propertyId, date);
  const departures = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND departure = ?
       AND status = 'Checked-out'`, propertyId, date);
  const noShows = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND arrival = ? AND status = 'No-show'`,
    propertyId, date);
  const cancellations = scalar<number>(
    `SELECT count(*) AS n FROM reservations WHERE property_id = ? AND substr(cancelled_at,1,10) = ?`,
    propertyId, date);
  const inHouse = scalar<number>(
    `SELECT count(DISTINCT n.reservation_id) AS n FROM reservation_nights n
       JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.date = ? AND r.status IN ('Checked-in','Checked-out')`,
    propertyId, date);

  const denom = roomsTotal - roomsOoo;
  const occupancyBp = denom > 0 ? Math.round((roomsSold / denom) * 10_000) : 0;
  const roomRev = revenue?.room_rev ?? 0;
  const adr = roomsSold > 0 ? Math.round(roomRev / roomsSold) : 0;
  const revpar = denom > 0 ? Math.round(roomRev / denom) : 0;

  run(
    `INSERT INTO daily_stats(id, property_id, date, rooms_total, rooms_ooo, rooms_sold, occupancy_bp,
                             room_revenue_minor, other_revenue_minor, tax_minor, payments_minor,
                             adr_minor, revpar_minor, arrivals, departures, no_shows, cancellations,
                             in_house, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(property_id, date) DO UPDATE SET
       rooms_total = excluded.rooms_total, rooms_ooo = excluded.rooms_ooo,
       rooms_sold = excluded.rooms_sold, occupancy_bp = excluded.occupancy_bp,
       room_revenue_minor = excluded.room_revenue_minor,
       other_revenue_minor = excluded.other_revenue_minor,
       tax_minor = excluded.tax_minor, payments_minor = excluded.payments_minor,
       adr_minor = excluded.adr_minor, revpar_minor = excluded.revpar_minor,
       arrivals = excluded.arrivals, departures = excluded.departures,
       no_shows = excluded.no_shows, cancellations = excluded.cancellations,
       in_house = excluded.in_house`,
    id('ds'), propertyId, date, roomsTotal, roomsOoo, roomsSold, occupancyBp,
    roomRev, revenue?.other_rev ?? 0, revenue?.tax ?? 0, revenue?.payments ?? 0,
    adr, revpar, arrivals, departures, noShows, cancellations, inHouse, nowIso(),
  );

  return get<any>('SELECT * FROM daily_stats WHERE property_id = ? AND date = ?', propertyId, date);
}

export function auditHistory(propertyId: string, limit = 30) {
  return all<any>(
    `SELECT * FROM audit_runs WHERE property_id = ? ORDER BY business_date DESC LIMIT ?`,
    propertyId, limit,
  ).map((r) => ({
    id: r.id, businessDate: r.business_date, startedAt: r.started_at, finishedAt: r.finished_at,
    status: r.status, user: r.user_name,
    summary: r.summary ? JSON.parse(r.summary) : null,
    error: r.error,
  }));
}

/** The manager's daily report for a completed (or in-progress) date. */
export function dailyReport(propertyId: string, date: string) {
  const stats = get<any>('SELECT * FROM daily_stats WHERE property_id = ? AND date = ?', propertyId, date)
    ?? snapshotStats(propertyId, date);

  const revenueByCode = all<any>(
    `SELECT code, kind, COALESCE(SUM(amount_minor),0) AS total, count(*) AS lines
       FROM folio_lines
      WHERE property_id = ? AND business_date = ? AND voided = 0
      GROUP BY code, kind ORDER BY total DESC`,
    propertyId, date,
  );
  const paymentsByMethod = all<any>(
    `SELECT COALESCE(method,'—') AS method, COALESCE(SUM(-amount_minor),0) AS total, count(*) AS n
       FROM folio_lines
      WHERE property_id = ? AND business_date = ? AND kind = 'payment' AND voided = 0
      GROUP BY method ORDER BY total DESC`,
    propertyId, date,
  );
  const bySource = all<any>(
    `SELECT r.source, count(DISTINCT r.id) AS reservations, COALESCE(SUM(n.rate_minor),0) AS revenue
       FROM reservation_nights n JOIN reservations r ON r.id = n.reservation_id
      WHERE n.property_id = ? AND n.date = ?
      GROUP BY r.source ORDER BY revenue DESC`,
    propertyId, date,
  );

  return {
    date,
    stats,
    revenueByCode: revenueByCode.map((r) => ({
      code: r.code, kind: r.kind, totalMinor: r.total, lines: r.lines,
    })),
    paymentsByMethod: paymentsByMethod.map((p) => ({ method: p.method, totalMinor: p.total, count: p.n })),
    productionBySource: bySource.map((s) => ({
      source: s.source, reservations: s.reservations, revenueMinor: s.revenue,
    })),
  };
}
