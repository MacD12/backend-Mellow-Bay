// ─────────────────────────────────────────────────────────────
// Closing and reopening dates for sale.
//
// The restrictions engine already stores a `stop-sell` as a dated range scoped
// to a room type, a rate plan and/or a channel. What it did not have was the
// operator's side of it: closing was a six-field form, and reopening meant
// finding the right row and deleting it. This module is the verbs — close,
// open, list — expressed the way the decision is actually made at the desk:
// "shut the 14th to the 16th" and "let the 15th back out".
//
// The interesting work is in `openDates`. Reopening is not "delete the rule",
// because the range being opened is usually a slice out of the middle of a
// longer closure. That has to split the row, not remove it.
// ─────────────────────────────────────────────────────────────
import { all, get, run, tx } from '../db.ts';
import { id, nowIso, addDays, assertDate, HttpError } from '../lib/util.ts';
import { audit } from './audit.ts';
import { type Actor, queueChannelPush } from './reservations.ts';

export interface CloseScope {
  roomTypeId?: string | null;
  ratePlanId?: string | null;
  channelCode?: string | null;
}

export interface CloseInput extends CloseScope {
  from: string;      // inclusive
  to: string;        // inclusive
  reason?: string;
}

interface StopSellRow {
  id: string;
  room_type_id: string | null;
  rate_plan_id: string | null;
  channel_code: string | null;
  date_from: string;
  date_to: string;
  note: string | null;
}

/** Two closures can be merged only when they close exactly the same thing. */
function sameScope(a: CloseScope, b: StopSellRow): boolean {
  return (a.roomTypeId ?? null) === b.room_type_id
    && (a.ratePlanId ?? null) === b.rate_plan_id
    && (a.channelCode ?? null) === b.channel_code;
}

/**
 * Is `row` closing something the caller is entitled to open?
 *
 * Opening one room type cannot carve a hole in a property-wide closure — that
 * closure is a single row covering everything, and honouring the request would
 * mean exploding it into one row per room type. Rather than do that silently,
 * or fail silently, rows broader than the request are reported back to the
 * caller so the screen can say which closure is still holding the dates shut.
 */
function withinScope(request: CloseScope, row: StopSellRow): boolean {
  // On both sides, NULL means "everything". A dimension is openable when the
  // request is at least as broad as the row on that dimension:
  //
  //   request NULL (all)      → any row qualifies
  //   request X, row NULL     → the row is broader; refuse, and report it
  //   request X, row X        → same thing; carve it
  //   request X, row Y        → unrelated; leave it alone
  const openable = (asked: string | null | undefined, rowValue: string | null) => {
    if ((asked ?? null) === null) return true;
    if (rowValue === null) return false;
    return rowValue === asked;
  };
  return openable(request.roomTypeId, row.room_type_id)
    && openable(request.ratePlanId, row.rate_plan_id)
    && openable(request.channelCode, row.channel_code);
}

function overlapping(propertyId: string, from: string, to: string): StopSellRow[] {
  return all<StopSellRow>(
    `SELECT id, room_type_id, rate_plan_id, channel_code, date_from, date_to, note
       FROM restrictions
      WHERE property_id = ? AND type = 'stop-sell' AND active = 1
        AND date_from <= ? AND date_to >= ?
      ORDER BY date_from`,
    propertyId, to, from,
  );
}

function validateRange(from: string, to: string) {
  assertDate(from, 'from');
  assertDate(to, 'to');
  if (to < from) throw new HttpError(400, 'The last closed date cannot be before the first');
}

/** Every room type the push queue needs to hear about for this scope. */
function affectedRoomTypes(propertyId: string, roomTypeId?: string | null): string[] {
  if (roomTypeId) return [roomTypeId];
  return all<{ id: string }>(
    'SELECT id FROM room_types WHERE property_id = ? AND active = 1', propertyId,
  ).map((r) => r.id);
}

/**
 * Queue an ARI push for every affected room type.
 *
 * `queueChannelPush` takes an exclusive end date, matching how the rest of the
 * system expresses a stay. A closure's `date_to` is inclusive — the last night
 * that is shut — so it is advanced by one here. Getting this wrong leaves the
 * final closed night still on sale, which is exactly the night that matters.
 */
function pushClosure(propertyId: string, scope: CloseScope, from: string, to: string, reason: string) {
  for (const rtId of affectedRoomTypes(propertyId, scope.roomTypeId)) {
    queueChannelPush(propertyId, rtId, from, addDays(to, 1), reason);
  }
}

// ─── Close ───────────────────────────────────────────────────

export function closeDates(propertyId: string, actor: Actor, input: CloseInput) {
  validateRange(input.from, input.to);

  return tx(() => {
    // Fold into an existing closure of the same scope when the ranges touch or
    // overlap, so closing three days in a row leaves one row rather than three.
    // `addDays(-1)` on each side makes "ends the day before this one starts"
    // count as touching.
    const neighbours = overlapping(propertyId, addDays(input.from, -1), addDays(input.to, 1))
      .filter((r) => sameScope(input, r));

    let closureId: string;
    let mergedFrom = input.from;
    let mergedTo = input.to;

    if (neighbours.length) {
      for (const n of neighbours) {
        if (n.date_from < mergedFrom) mergedFrom = n.date_from;
        if (n.date_to > mergedTo) mergedTo = n.date_to;
      }
      closureId = neighbours[0].id;
      run('UPDATE restrictions SET date_from = ?, date_to = ?, note = COALESCE(?, note) WHERE id = ?',
        mergedFrom, mergedTo, input.reason ?? null, closureId);
      for (const n of neighbours.slice(1)) {
        run('DELETE FROM restrictions WHERE id = ?', n.id);
      }
    } else {
      closureId = id('rst');
      run(
        `INSERT INTO restrictions(id, property_id, room_type_id, rate_plan_id, channel_code,
                                  date_from, date_to, type, value, note, active, created_by, created_at)
         VALUES(?,?,?,?,?,?,?,'stop-sell',NULL,?,1,?,?)`,
        closureId, propertyId, input.roomTypeId ?? null, input.ratePlanId ?? null,
        input.channelCode ?? null, input.from, input.to, input.reason ?? null,
        actor.userName, nowIso(),
      );
    }

    audit(actor, {
      action: 'inventory.close', entity: 'RESTRICTION', entityId: closureId,
      entityRef: `${mergedFrom} → ${mergedTo}`,
      after: { ...input, mergedFrom, mergedTo, absorbed: neighbours.length },
      channel: input.channelCode ?? undefined,
      elevated: true,
    });

    pushClosure(propertyId, input, mergedFrom, mergedTo, 'inventory.close');

    return {
      id: closureId,
      from: mergedFrom,
      to: mergedTo,
      absorbed: neighbours.length ? neighbours.length - 1 : 0,
      extended: neighbours.length > 0,
    };
  });
}

// ─── Open ────────────────────────────────────────────────────

export interface OpenResult {
  opened: number;          // rows changed
  removed: number;         // closures that disappeared entirely
  split: number;           // closures cut in two
  /** Closures too broad to carve — reported rather than silently ignored. */
  stillClosedBy: Array<{ id: string; from: string; to: string; scope: string; reason: string | null }>;
}

export function openDates(propertyId: string, actor: Actor, input: CloseInput): OpenResult {
  validateRange(input.from, input.to);

  return tx(() => {
    const rows = overlapping(propertyId, input.from, input.to);
    const carve = rows.filter((r) => withinScope(input, r));
    const blocked = rows.filter((r) => !withinScope(input, r));

    let removed = 0;
    let split = 0;

    for (const row of carve) {
      const startsBefore = row.date_from < input.from;
      const endsAfter = row.date_to > input.to;

      if (!startsBefore && !endsAfter) {
        // Wholly inside the opened range.
        run('DELETE FROM restrictions WHERE id = ?', row.id);
        removed++;
      } else if (startsBefore && endsAfter) {
        // The opened range is a hole in the middle: keep the head, add the tail.
        run('UPDATE restrictions SET date_to = ? WHERE id = ?', addDays(input.from, -1), row.id);
        run(
          `INSERT INTO restrictions(id, property_id, room_type_id, rate_plan_id, channel_code,
                                    date_from, date_to, type, value, note, active, created_by, created_at)
           VALUES(?,?,?,?,?,?,?,'stop-sell',NULL,?,1,?,?)`,
          id('rst'), propertyId, row.room_type_id, row.rate_plan_id, row.channel_code,
          addDays(input.to, 1), row.date_to, row.note, actor.userName, nowIso(),
        );
        split++;
      } else if (startsBefore) {
        run('UPDATE restrictions SET date_to = ? WHERE id = ?', addDays(input.from, -1), row.id);
      } else {
        run('UPDATE restrictions SET date_from = ? WHERE id = ?', addDays(input.to, 1), row.id);
      }
    }

    if (carve.length) {
      audit(actor, {
        action: 'inventory.open', entity: 'RESTRICTION',
        entityRef: `${input.from} → ${input.to}`,
        after: { ...input, cleared: carve.length, removed, split },
        channel: input.channelCode ?? undefined,
        elevated: true,
      });
      pushClosure(propertyId, input, input.from, input.to, 'inventory.open');
    }

    return {
      opened: carve.length,
      removed,
      split,
      stillClosedBy: blocked.map((r) => ({
        id: r.id,
        from: r.date_from,
        to: r.date_to,
        scope: describeScope(propertyId, r),
        reason: r.note,
      })),
    };
  });
}

// ─── The close-out list ──────────────────────────────────────

function describeScope(propertyId: string, row: StopSellRow): string {
  const parts: string[] = [];
  parts.push(row.room_type_id
    ? get<{ name: string }>('SELECT name FROM room_types WHERE id = ?', row.room_type_id)?.name
      ?? 'Unknown room type'
    : 'All room types');
  if (row.rate_plan_id) {
    parts.push(get<{ code: string }>('SELECT code FROM rate_plans WHERE id = ?', row.rate_plan_id)?.code
      ?? 'Unknown rate plan');
  }
  parts.push(row.channel_code
    ? get<{ name: string }>('SELECT name FROM channels WHERE property_id = ? AND code = ?',
      propertyId, row.channel_code)?.name ?? row.channel_code
    : 'All channels');
  return parts.join(' · ');
}

/**
 * Every active closure, newest expiry last, with enough context to decide
 * whether it should still be there.
 */
export function closeoutList(propertyId: string, today: string) {
  const rows = all<StopSellRow & { created_by: string | null; created_at: string }>(
    `SELECT id, room_type_id, rate_plan_id, channel_code, date_from, date_to, note,
            created_by, created_at
       FROM restrictions
      WHERE property_id = ? AND type = 'stop-sell' AND active = 1
      ORDER BY date_from`,
    propertyId,
  );

  return rows.map((r) => {
    const expired = r.date_to < today;
    const nights = Math.max(1, Math.round(
      (Date.parse(`${r.date_to}T00:00:00Z`) - Date.parse(`${r.date_from}T00:00:00Z`)) / 86_400_000,
    ) + 1);
    return {
      id: r.id,
      from: r.date_from,
      to: r.date_to,
      nights,
      roomTypeId: r.room_type_id,
      ratePlanId: r.rate_plan_id,
      channelCode: r.channel_code,
      scope: describeScope(propertyId, r),
      reason: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
      // An expired closure is not a problem, but it is clutter, and a list that
      // shows only what is live now is the one an operator can trust at a glance.
      expired,
      active: !expired && r.date_from <= today,
      upcoming: r.date_from > today,
    };
  });
}

/** Closures that have run their course and can be tidied away. */
export function purgeExpiredCloseouts(propertyId: string, before: string): number {
  const rows = all<{ id: string }>(
    `SELECT id FROM restrictions
      WHERE property_id = ? AND type = 'stop-sell' AND active = 1 AND date_to < ?`,
    propertyId, before,
  );
  for (const r of rows) run('DELETE FROM restrictions WHERE id = ?', r.id);
  return rows.length;
}
