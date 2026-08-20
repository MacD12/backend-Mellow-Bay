// ─────────────────────────────────────────────────────────────
// Bed configuration — what is actually in the room.
//
// Until now a room type said how many people were *permitted* (`max_occupancy`)
// but never where they would sleep. Those are different questions, and the
// second is the one that decides a booking: "sleeps 4" and "one king plus two
// singles" are not the same offer, and a family reading the first will ask the
// second before they book.
//
// The vocabulary is fixed rather than free text. Properties do not invent bed
// kinds, channels expect standard ones, and a free-text list cannot be filtered
// on, mapped to Booking.com, or used to work out whether five people fit.
// ─────────────────────────────────────────────────────────────
import { HttpError } from './util.ts';

export interface BedKind {
  code: string;
  label: string;
  /** How many adults can sleep in one of these. */
  sleeps: number;
  /** Dorm berths are counted and sold individually. */
  dorm: boolean;
  /** An extra bed brought in, not part of the room's standing furniture. */
  extra: boolean;
  description: string;
}

/**
 * The vocabulary.
 *
 * `sleeps` is the number the capacity calculation uses. A bunk sleeps two
 * because it is two berths in one frame — the single most common place to get
 * this wrong, and the reason a 6-bunk dorm holds 12 people rather than 6.
 */
export const BED_KINDS: BedKind[] = [
  { code: 'single', label: 'Single', sleeps: 1, dorm: false, extra: false,
    description: 'One adult. Sometimes called a twin when there are two.' },
  { code: 'double', label: 'Double', sleeps: 2, dorm: false, extra: false,
    description: 'Two adults, standard double.' },
  { code: 'queen', label: 'Queen', sleeps: 2, dorm: false, extra: false,
    description: 'Two adults, more comfortably than a double.' },
  { code: 'king', label: 'King', sleeps: 2, dorm: false, extra: false,
    description: 'Two adults, the largest standard bed.' },
  { code: 'bunk', label: 'Bunk bed', sleeps: 2, dorm: false, extra: false,
    description: 'Two berths, one above the other. Counts as two sleepers.' },
  { code: 'sofa_bed', label: 'Sofa bed', sleeps: 2, dorm: false, extra: false,
    description: 'Folds out. Usually sold as a supplement rather than a main bed.' },
  { code: 'futon', label: 'Futon', sleeps: 1, dorm: false, extra: false,
    description: 'One adult, on the floor or a low frame.' },

  // Dorm berths — sold one at a time. See I4 for their per-bed attributes.
  { code: 'dorm_bunk', label: 'Bunk berth', sleeps: 1, dorm: true, extra: false,
    description: 'One berth of a bunk, sold on its own.' },
  { code: 'dorm_single', label: 'Single berth', sleeps: 1, dorm: true, extra: false,
    description: 'A standalone bed in a shared room, nothing above it.' },
  { code: 'pod', label: 'Pod', sleeps: 1, dorm: true, extra: false,
    description: 'An enclosed berth with its own curtain or door.' },
  { code: 'capsule', label: 'Capsule', sleeps: 1, dorm: true, extra: false,
    description: 'A fully enclosed single berth.' },
  { code: 'double_berth', label: 'Double berth', sleeps: 2, dorm: true, extra: false,
    description: 'A berth wide enough for two, sold as one bed.' },

  // Extras. Excluded from standing capacity — they are brought in on request.
  { code: 'extra_bed', label: 'Extra bed', sleeps: 1, dorm: false, extra: true,
    description: 'A rollaway, added on request and usually charged.' },
  { code: 'cot', label: 'Cot / crib', sleeps: 1, dorm: false, extra: true,
    description: 'For an infant. Does not count towards adult capacity.' },
];

const BY_CODE = new Map(BED_KINDS.map((k) => [k.code, k]));

export function bedKind(code: string): BedKind | undefined {
  return BY_CODE.get(code);
}

export interface BedSpec {
  kind: string;
  count: number;
}

/**
 * Read and validate a stored configuration.
 *
 * Invalid entries throw rather than being dropped: a configuration that
 * silently loses a bed would understate capacity and refuse bookings the
 * property could have taken.
 */
export function parseBedConfig(value: unknown, field = 'bedConfig'): BedSpec[] {
  if (value === null || value === undefined) return [];

  // A string came out of the database column; an array came out of a request
  // body. They are held to different standards on purpose: a column that will
  // not parse is one corrupt row, and throwing would take the whole room-types
  // page down with it, so it reads as "no beds configured" — which the capacity
  // check then flags. A caller submitting rubbish is refused outright.
  if (typeof value === 'string') {
    const stored = safeJson(value);
    return Array.isArray(stored) ? readEntries(stored, field) : [];
  }
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be a list of beds`);
  return readEntries(value, field);
}

function readEntries(raw: unknown[], field: string): BedSpec[] {

  const out: BedSpec[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      throw new HttpError(400, `${field} entries must be objects like {kind, count}`);
    }
    const kind = String((entry as any).kind ?? '');
    if (!BY_CODE.has(kind)) {
      throw new HttpError(400,
        `"${kind}" is not a bed kind. Use one of: ${BED_KINDS.map((k) => k.code).join(', ')}`);
    }
    const count = Number((entry as any).count ?? 0);
    if (!Number.isInteger(count) || count < 1 || count > 60) {
      throw new HttpError(400, `${field}: ${kind} needs a whole count between 1 and 60`);
    }
    // Merged rather than repeated, so two "1 single" entries become "2 singles"
    // and the summary reads the way a person would say it.
    const existing = out.find((b) => b.kind === kind);
    if (existing) existing.count += count;
    else out.push({ kind, count });
  }
  return out;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/** How many adults can sleep here, excluding beds brought in on request. */
export function sleeps(config: BedSpec[]): number {
  return config.reduce((total, b) => {
    const kind = BY_CODE.get(b.kind);
    if (!kind || kind.extra) return total;
    return total + kind.sleeps * b.count;
  }, 0);
}

/** Capacity including extras — the most the room could hold if asked. */
export function sleepsWithExtras(config: BedSpec[]): number {
  return config.reduce((total, b) => {
    const kind = BY_CODE.get(b.kind);
    return kind ? total + kind.sleeps * b.count : total;
  }, 0);
}

/** How many separate berths there are — what a dorm sells. */
export function berths(config: BedSpec[]): number {
  return config.reduce((total, b) => {
    const kind = BY_CODE.get(b.kind);
    if (!kind || kind.extra) return total;
    // A bunk is one piece of furniture and two berths.
    return total + (kind.code === 'bunk' ? b.count * 2 : b.count);
  }, 0);
}

/**
 * "1 king, 2 singles" — the line a guest reads.
 *
 * Pluralised properly and ordered by size, so the biggest bed is named first,
 * which is how people describe a room.
 */
export function describeBedConfig(config: BedSpec[]): string {
  if (!config.length) return 'No beds configured';
  const parts = [...config]
    .sort((a, b) => (BY_CODE.get(b.kind)?.sleeps ?? 0) - (BY_CODE.get(a.kind)?.sleeps ?? 0))
    .map((b) => {
      const kind = BY_CODE.get(b.kind)!;
      const label = kind.label.toLowerCase();
      if (b.count === 1) return `1 ${label}`;
      // "2 sofa beds", not "2 sofa bedss".
      return `${b.count} ${label.endsWith('s') ? label : `${label}s`}`;
    });
  return parts.join(', ');
}

export interface CapacityCheck {
  sleeps: number;
  sleepsWithExtras: number;
  berths: number;
  summary: string;
  /** Things the property should look at. Never blocks saving. */
  warnings: string[];
}

/**
 * Compare a configuration against the occupancy the type claims.
 *
 * Warnings rather than errors, deliberately. A property mid-way through setting
 * a room up should not be blocked from saving; it should be told what does not
 * add up so it can finish the job.
 */
export function checkCapacity(
  config: BedSpec[],
  claims: { maxOccupancy: number; baseOccupancy: number; kind: string },
): CapacityCheck {
  const warnings: string[] = [];
  const standing = sleeps(config);
  const withExtras = sleepsWithExtras(config);

  if (!config.length) {
    warnings.push('No beds are configured, so nobody can be told what they are booking.');
  } else if (standing === 0) {
    warnings.push('Only extra beds are configured — the room has no standing bed.');
  }

  if (config.length && claims.maxOccupancy > withExtras) {
    warnings.push(
      `This room admits ${claims.maxOccupancy} guests but sleeps ${withExtras}`
      + `${withExtras !== standing ? ' including extra beds' : ''}. `
      + `${claims.maxOccupancy - withExtras} guest(s) would have nowhere to sleep.`);
  }
  if (config.length && standing > claims.maxOccupancy) {
    warnings.push(
      `The beds sleep ${standing} but the room admits only ${claims.maxOccupancy}. `
      + 'A bed is going unsold.');
  }
  if (claims.baseOccupancy > claims.maxOccupancy) {
    warnings.push('Base occupancy is higher than maximum occupancy.');
  }

  // A dorm is sold by the berth, so a configuration of whole rooms is a sign
  // somebody has described the room rather than what is for sale in it.
  if (claims.kind === 'dorm' && config.some((b) => !BY_CODE.get(b.kind)?.dorm)) {
    const wrong = config.filter((b) => !BY_CODE.get(b.kind)?.dorm)
      .map((b) => BY_CODE.get(b.kind)!.label);
    warnings.push(
      `${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} a private-room bed. `
      + 'A dorm is sold by the berth — use bunk berth, pod or capsule.');
  }
  if (claims.kind !== 'dorm' && config.some((b) => BY_CODE.get(b.kind)?.dorm)) {
    warnings.push('This is a private room but it is configured with dorm berths.');
  }

  return {
    sleeps: standing,
    sleepsWithExtras: withExtras,
    berths: berths(config),
    summary: describeBedConfig(config),
    warnings,
  };
}
