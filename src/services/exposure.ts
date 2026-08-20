// ─────────────────────────────────────────────────────────────
// How exposed this property actually is to the simultaneous-OTA race.
//
// The race cannot be closed by a channel manager: each OTA sells from its own
// cached copy of availability and tells you afterwards. What *can* be done is
// hold the last room back — and that costs occupancy, so nobody should be asked
// to decide it on instinct.
//
// Everything below is measured from data the system already keeps. The queue
// records when a change was raised and when the push carrying it succeeded; the
// gap between those two is the window in which an OTA was selling a room that
// was already gone. That gap is the whole argument, in seconds.
// ─────────────────────────────────────────────────────────────
import { all, get, scalar } from '../db.ts';
import { nightsBetween } from '../lib/util.ts';

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export interface ExposureReport {
  from: string;
  to: string;
  /** Pushes that completed in the window. */
  pushes: number;
  /** Seconds between a change being raised and the channel being told. */
  medianSeconds: number;
  p95Seconds: number;
  worstSeconds: number;
  /** Total time the OTAs spent holding availability that was already stale. */
  totalExposureSeconds: number;
  /** Queued right now and not yet sent — live exposure. */
  queuedNow: number;
  /** Failed and never retried. These are exposed until somebody notices. */
  failedNow: number;
  oldestFailedAt: string | null;
  /** Nights that reached zero availability — every one was a race that could have gone wrong. */
  soldOutNights: number;
  /** Nights that actually went negative. */
  oversoldNights: number;
  /** Of those, the ones the cause engine attributed to the race. */
  racesLost: number;
  perChannel: Array<{
    channelId: string; name: string; code: string;
    pushes: number; medianSeconds: number; failed: number;
  }>;
  protection: Array<{
    roomTypeId: string; roomType: string; isDorm: boolean;
    units: number; rooms: number; protectLastRooms: number;
  }>;
  /** Plain-language reading of the numbers above. */
  verdict: string;
}

export function exposureReport(propertyId: string, from: string, to: string): ExposureReport {
  const fromTs = `${from}T00:00:00.000Z`;
  const toTs = `${to}T23:59:59.999Z`;

  // The gap between raising a change and the channel being told. `sent_at` is
  // only set on success, so a failed push contributes to `failedNow` instead —
  // counting it here would flatter the median with a number that never landed.
  const sent = all<{ ms: number; channel_id: string }>(
    `SELECT channel_id,
            (julianday(sent_at) - julianday(created_at)) * 86400000 AS ms
       FROM channel_queue
      WHERE property_id = ? AND status = 'sent'
        AND sent_at IS NOT NULL AND created_at >= ? AND created_at <= ?`,
    propertyId, fromTs, toTs,
  ).filter((r) => Number.isFinite(r.ms) && r.ms >= 0);

  const seconds = sent.map((r) => r.ms / 1000).sort((a, b) => a - b);
  const totalExposure = seconds.reduce((sum, s) => sum + s, 0);

  const queuedNow = scalar<number>(
    `SELECT count(*) AS n FROM channel_queue WHERE property_id = ? AND status = 'queued'`,
    propertyId);
  const failedNow = scalar<number>(
    `SELECT count(*) AS n FROM channel_queue WHERE property_id = ? AND status = 'failed'`,
    propertyId);
  const oldestFailed = get<{ created_at: string }>(
    `SELECT MIN(created_at) AS created_at FROM channel_queue
      WHERE property_id = ? AND status = 'failed'`,
    propertyId)?.created_at ?? null;

  const soldOutNights = scalar<number>(
    `SELECT count(DISTINCT date || '|' || COALESCE(room_type_id,'')) AS n FROM overbookings
      WHERE property_id = ? AND kind = 'at-risk' AND date >= ? AND date <= ?`,
    propertyId, from, to);
  const oversoldNights = scalar<number>(
    `SELECT count(DISTINCT date || '|' || COALESCE(room_type_id,'')) AS n FROM overbookings
      WHERE property_id = ? AND kind = 'type' AND date >= ? AND date <= ?`,
    propertyId, from, to);
  const racesLost = scalar<number>(
    `SELECT count(*) AS n FROM overbookings
      WHERE property_id = ? AND kind = 'type' AND cause = 'race' AND date >= ? AND date <= ?`,
    propertyId, from, to);

  const byChannel = new Map<string, number[]>();
  for (const row of sent) {
    const list = byChannel.get(row.channel_id) ?? [];
    list.push(row.ms / 1000);
    byChannel.set(row.channel_id, list);
  }
  const channels = all<{ id: string; name: string; code: string }>(
    'SELECT id, name, code FROM channels WHERE property_id = ?', propertyId);

  const perChannel = channels.map((c) => {
    const list = (byChannel.get(c.id) ?? []).sort((a, b) => a - b);
    return {
      channelId: c.id, name: c.name, code: c.code,
      pushes: list.length,
      medianSeconds: Math.round(percentile(list, 50) * 10) / 10,
      failed: scalar<number>(
        `SELECT count(*) AS n FROM channel_queue
          WHERE property_id = ? AND channel_id = ? AND status = 'failed'`,
        propertyId, c.id),
    };
  });

  // A dorm's availability is counted in beds, not rooms — so that is the unit
  // the protection setting is really holding back, and the unit the screen has
  // to say. Offering to "hold back 1 room" of a dorm would be a different and
  // much larger thing than what actually happens.
  const protection = all<{
    id: string; name: string; kind: string; protect_last_rooms: number;
    rooms: number; beds: number;
  }>(
    `SELECT rt.id, rt.name, rt.kind, rt.protect_last_rooms,
            (SELECT count(*) FROM rooms r WHERE r.room_type_id = rt.id AND r.active = 1) AS rooms,
            (SELECT count(*) FROM beds b
               JOIN rooms r2 ON r2.id = b.room_id
              WHERE r2.room_type_id = rt.id AND b.active = 1 AND r2.active = 1) AS beds
       FROM room_types rt
      WHERE rt.property_id = ? AND rt.active = 1
      ORDER BY rt.sort_order`,
    propertyId,
    // A type with nothing physical behind it cannot be protected, and showing a
    // control for it is an invitation to a confusing error.
  ).filter((r) => (r.kind === 'dorm' ? r.beds : r.rooms) > 0)
    .map((r) => ({
      roomTypeId: r.id,
      roomType: r.name,
      isDorm: r.kind === 'dorm',
      /** Beds for a dorm, rooms otherwise — what `protectLastRooms` counts. */
      units: r.kind === 'dorm' ? r.beds : r.rooms,
      rooms: r.rooms,
      protectLastRooms: r.protect_last_rooms ?? 0,
    }));

  const median = Math.round(percentile(seconds, 50) * 10) / 10;
  const worst = Math.round(percentile(seconds, 100) * 10) / 10;

  return {
    from, to,
    pushes: sent.length,
    medianSeconds: median,
    p95Seconds: Math.round(percentile(seconds, 95) * 10) / 10,
    worstSeconds: worst,
    totalExposureSeconds: Math.round(totalExposure),
    queuedNow,
    failedNow,
    oldestFailedAt: oldestFailed,
    soldOutNights,
    oversoldNights,
    racesLost,
    perChannel,
    protection,
    verdict: verdictFor({
      pushes: sent.length, median, worst, failedNow, soldOutNights, oversoldNights, racesLost,
      protected: protection.some((p) => p.protectLastRooms > 0),
      days: Math.max(1, nightsBetween(from, to)),
    }),
  };
}

/**
 * Say what the numbers mean, in a sentence somebody can act on.
 *
 * Deliberately conservative: with too little data it says so rather than
 * producing a confident-sounding figure from four pushes.
 */
function verdictFor(x: {
  pushes: number; median: number; worst: number; failedNow: number;
  soldOutNights: number; oversoldNights: number; racesLost: number;
  protected: boolean; days: number;
}): string {
  if (x.failedNow > 0) {
    return `${x.failedNow} channel update(s) have failed and are still unsent. Until they go `
      + 'through, the OTAs are selling from stale availability — this is the largest exposure '
      + 'you have, and it is fixable.';
  }
  if (x.pushes < 10) {
    return 'Not enough channel activity yet to measure your exposure. Come back after a few '
      + 'days of live bookings.';
  }
  if (x.protected) {
    return `Last-room protection is on, so the simultaneous-OTA race cannot happen for the `
      + `protected types. Your pushes land in about ${x.median}s, which is what matters for `
      + 'everything else.';
  }
  const risky = x.soldOutNights;
  if (risky === 0) {
    return `Pushes land in about ${x.median}s (worst ${x.worst}s). Nothing sold out in this `
      + 'period, so the race never had anything to race for.';
  }
  return `Pushes land in about ${x.median}s, worst ${x.worst}s — that is how long an OTA can `
    + `keep selling a room that has gone. ${risky} night(s) reached zero availability, and `
    + `${x.oversoldNights} went over${x.racesLost ? ` (${x.racesLost} attributed to the race)` : ''}. `
    + 'Last-room protection would make those impossible, at the cost of selling one fewer room '
    + 'on the nights you sell out.';
}
