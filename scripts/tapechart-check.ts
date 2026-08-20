// ─────────────────────────────────────────────────────────────
// The tape chart scrolls sideways without end, which means time is fetched in
// chunks and stitched back together on the client. This checks the stitching.
//
//   node --no-warnings scripts/tapechart-check.ts
//
// The defect worth guarding against is quiet: a stay that crosses a chunk
// boundary comes back from the endpoint **clipped to each chunk**, because the
// span is computed as MIN/MAX of the reservation's nights within the range that
// was asked for. Concatenate those and a three-week booking draws as two bars
// with a seam through the middle — which reads, to anyone glancing at the
// chart, as two separate guests and a free night between them.
//
// It runs against the real frontend module (no browser, no React) and a second,
// independent model of the same data, so the merge is checked against what the
// answer *should* be rather than against itself.
// ─────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', 'frontend', 'src', 'tapechart.ts');
const tape = await import(pathToFileURL(SRC).href);

const {
  CHUNK_DAYS, chunkStart, chunksCovering, mergeChunks, laneKeyOf,
  activeFilterCount, spanMatches, spanMatchesSearch, roomMatches, visibleSlice, NO_FILTERS,
} = tape;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  if (ok) { process.stdout.write(`  ✓ ${name}\n`); return; }
  failures++;
  process.stdout.write(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`);
}
function section(title: string) {
  process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── A property, and a booking that crosses a seam ────────────
const ROOM = {
  id: 'rm1', number: '101', floor: 1, status: 'Vacant Clean',
  roomTypeId: 'rt1', roomType: 'Deluxe Double Room', roomTypeCode: 'DBL',
  kind: 'room', beds: [],
};

function span(over: Record<string, unknown> = {}) {
  return {
    reservationId: 'res1', roomId: 'rm1', bedId: null,
    confirmation: 'MELLOW-2026-00001', guest: 'Nadeeka Perera', status: 'Confirmed',
    from: '2026-08-01', to: '2026-08-21',
    arrival: '2026-08-01', departure: '2026-08-21', vip: false,
    source: 'OTA', channel: 'BEDS24', otaChannel: 'Hostelworld',
    nights: 20, totalMinor: 84000, adults: 2, children: 0,
    ...over,
  };
}

/** One chunk as the endpoint would return it: spans clipped to the window. */
function chunkOf(from: string, to: string, spans: any[]) {
  return {
    from, to, rooms: [ROOM], blocks: [], unassigned: [], availability: [],
    spans: spans
      .filter((s) => s.from < to && s.to > from)
      .map((s) => ({
        ...s,
        from: s.from < from ? from : s.from,   // ← the clipping this suite exists for
        to: s.to > to ? to : s.to,
      })),
  };
}

async function main() {
  process.stdout.write(`\nTape chart checks\n${'─'.repeat(17)}\n`);

  section('1 · Chunk boundaries are stable');
  check('a chunk start is aligned to the grid',
    chunkStart('2026-08-11') === chunkStart('2026-08-12'),
    [chunkStart('2026-08-11'), chunkStart('2026-08-12')]);
  check('…and every date in a chunk agrees on it',
    chunkStart(addDays(chunkStart('2026-08-11'), CHUNK_DAYS - 1)) === chunkStart('2026-08-11'));
  check('the next day after a chunk starts the next one',
    chunkStart(addDays(chunkStart('2026-08-11'), CHUNK_DAYS)) === addDays(chunkStart('2026-08-11'), CHUNK_DAYS));
  // Scrolling backwards past the epoch must not produce overlapping chunks.
  check('dates before the epoch round down, not toward zero',
    chunkStart('2019-06-15') < '2019-06-15' && chunkStart('2019-06-15') <= chunkStart('2019-08-15'),
    chunkStart('2019-06-15'));
  check('a covering set reaches the end of the range',
    chunksCovering('2026-08-11', '2026-11-01').at(-1)! < '2026-11-01');
  check('…and starts at or before the beginning',
    chunksCovering('2026-08-11', '2026-11-01')[0] <= '2026-08-11');

  // The whole point of chunking: never ask the server for more than it allows.
  section('2 · No request can breach the 400-day server cap');
  check(`a chunk is ${CHUNK_DAYS} days, well under 400`, CHUNK_DAYS < 400, CHUNK_DAYS);
  const wide = chunksCovering('2020-01-01', '2030-01-01');
  check('a ten-year span is many small requests, not one big one',
    wide.length > 50, wide.length);

  section('3 · A stay crossing a seam draws as one bar');
  const seam = addDays(chunkStart('2026-08-01'), CHUNK_DAYS);
  const long = span({ from: addDays(seam, -5), to: addDays(seam, 5) });
  const a = chunkOf(chunkStart('2026-08-01'), seam, [long]);
  const b = chunkOf(seam, addDays(seam, CHUNK_DAYS), [long]);

  check('the endpoint really does clip it (the premise holds)',
    a.spans[0].to === seam && b.spans[0].from === seam,
    [a.spans[0].to, b.spans[0].from]);

  const merged = mergeChunks([a, b]);
  check('merging yields exactly one span', merged.spans.length === 1, merged.spans);
  check('…spanning the whole stay',
    merged.spans[0].from === long.from && merged.spans[0].to === long.to,
    [merged.spans[0].from, merged.spans[0].to]);

  // Arrival order must not matter — chunks resolve as the network returns them.
  const reversed = mergeChunks([b, a]);
  check('the result does not depend on which chunk arrives first',
    reversed.spans[0].from === merged.spans[0].from
    && reversed.spans[0].to === merged.spans[0].to);

  section('4 · Ordinary stays are left alone');
  const inside = span({ reservationId: 'res2', from: '2026-08-05', to: '2026-08-09' });
  const one = mergeChunks([chunkOf(chunkStart('2026-08-01'), seam, [inside])]);
  check('a stay wholly inside one chunk keeps its dates',
    one.spans[0].from === '2026-08-05' && one.spans[0].to === '2026-08-09',
    one.spans[0]);
  check('a chunk still loading contributes nothing but does not break the merge',
    mergeChunks([a, undefined, null, b]).spans.length === 1);
  check('rooms survive even when one chunk is missing',
    mergeChunks([undefined, b]).rooms.length === 1);

  section('5 · Two guests in the same room are two bars');
  const first = span({ reservationId: 'r1', from: '2026-08-01', to: '2026-08-05' });
  const second = span({ reservationId: 'r2', from: '2026-08-05', to: '2026-08-10' });
  const two = mergeChunks([chunkOf(chunkStart('2026-08-01'), seam, [first, second])]);
  check('back-to-back stays are not merged into one', two.spans.length === 2, two.spans.length);

  // A dorm sells beds. Two guests in the same *room* on the same night is
  // normal there, and merging by room would silently collapse them.
  const bedA = span({ reservationId: 'r3', bedId: 'bed1', from: '2026-08-01', to: '2026-08-04' });
  const bedB = span({ reservationId: 'r4', bedId: 'bed2', from: '2026-08-01', to: '2026-08-04' });
  const dorm = mergeChunks([chunkOf(chunkStart('2026-08-01'), seam, [bedA, bedB])]);
  check('two beds in one dorm room stay separate', dorm.spans.length === 2, dorm.spans.length);
  check('a lane is the bed when there is one', laneKeyOf(bedA) === 'bed1');
  check('…and the room when there is not', laneKeyOf(first) === 'rm1');

  section('6 · Blocks, unassigned and availability');
  const blk = { id: 'b1', roomId: 'rm1', kind: 'Maintenance', from: '2026-08-02', to: '2026-08-04', reason: null };
  const un = {
    reservationId: 'u1', confirmation: 'C1', guest: 'X', status: 'Confirmed',
    arrival: '2026-08-02', departure: '2026-08-04', roomType: 'D', roomTypeId: 'rt1', vip: false,
  };
  const av = { roomTypeId: 'rt1', date: '2026-08-02', physical: 4, blocked: 0, sold: 1, available: 3 };
  const dup = mergeChunks([
    { from: 'x', to: 'y', rooms: [ROOM], spans: [], blocks: [blk], unassigned: [un], availability: [av] },
    { from: 'x', to: 'y', rooms: [ROOM], spans: [], blocks: [blk], unassigned: [un], availability: [av] },
  ]);
  check('a block seen in two chunks appears once', dup.blocks.length === 1);
  check('an unassigned booking seen twice appears once', dup.unassigned.length === 1);
  check('an availability cell seen twice appears once', dup.availability.length === 1);
  check('a room list is not duplicated either', dup.rooms.length === 1);

  section('6b · Merged availability equals one wide query');
  // The occupancy strip is summed from these cells. If stitching lost a date or
  // double-counted one, the chart would report an occupancy the property never
  // had — so the merge of two chunks is compared against the same range fetched
  // whole, cell for cell.
  const days = (from: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      roomTypeId: 'rt1', date: addDays(from, i),
      physical: 4, blocked: 0, sold: i % 3, available: 4 - (i % 3),
    }));
  const startA = chunkStart('2026-08-01');
  const wideQuery = days(startA, CHUNK_DAYS * 2);
  const asChunks = mergeChunks([
    { from: startA, to: seam, rooms: [ROOM], spans: [], blocks: [], unassigned: [],
      availability: days(startA, CHUNK_DAYS) },
    { from: seam, to: addDays(seam, CHUNK_DAYS), rooms: [ROOM], spans: [], blocks: [], unassigned: [],
      availability: days(seam, CHUNK_DAYS) },
  ]);
  check('every date is present exactly once',
    asChunks.availability.length === wideQuery.length,
    { merged: asChunks.availability.length, wide: wideQuery.length });

  const byDate = new Map<string, any>(asChunks.availability.map((a: any) => [a.date, a]));
  check('…and no date is missing', wideQuery.every((w) => byDate.has(w.date)));
  check('…and every value matches the wide query',
    wideQuery.every((w) => {
      const m = byDate.get(w.date);
      return m && m.sold === w.sold && m.available === w.available && m.physical === w.physical;
    }));
  const totalMerged = asChunks.availability.reduce((n: number, a: any) => n + a.sold, 0);
  const totalWide = wideQuery.reduce((n, a) => n + a.sold, 0);
  check('…so the occupancy strip sums to the same number',
    totalMerged === totalWide, { totalMerged, totalWide });

  section('7 · Filters');
  const f = { ...NO_FILTERS };
  check('no filters means nothing is filtered', activeFilterCount(f) === 0);
  check('a span passes when nothing is set', spanMatches(span(), f) === true);

  check('status filter excludes',
    spanMatches(span({ status: 'Tentative' }), { ...f, reservationStatus: ['Confirmed'] }) === false);
  check('…and includes',
    spanMatches(span({ status: 'Confirmed' }), { ...f, reservationStatus: ['Confirmed'] }) === true);

  // The reason `ota_channel` exists: through a hub, every booking's channel is
  // BEDS24, so filtering on that answers nothing.
  check('the OTA filter sees past the hub to the real OTA',
    spanMatches(span(), { ...f, otaChannels: ['Hostelworld'] }) === true);
  check('…and rejects a different OTA',
    spanMatches(span(), { ...f, otaChannels: ['Booking.com'] }) === false);
  check('a booking with no OTA falls back to its channel',
    spanMatches(span({ otaChannel: null }), { ...f, otaChannels: ['BEDS24'] }) === true);

  check('VIP only excludes non-VIPs', spanMatches(span(), { ...f, vipOnly: true }) === false);
  check('…and keeps VIPs', spanMatches(span({ vip: true }), { ...f, vipOnly: true }) === true);

  check('room type filter excludes',
    roomMatches(ROOM, { ...f, roomTypeIds: ['other'] }) === false);
  check('floor filter includes', roomMatches(ROOM, { ...f, floors: [1] }) === true);
  check('housekeeping filter excludes a clean room when asking for dirty',
    roomMatches(ROOM, { ...f, housekeeping: ['Occupied Dirty'] }) === false);

  check('filters compose — count reflects all of them',
    activeFilterCount({ ...f, floors: [1], vipOnly: true, search: 'x' }) === 3);

  // Search dims rather than hides, so it is kept out of spanMatches on purpose.
  check('search is not part of span filtering',
    spanMatches(span(), { ...f, search: 'nobody' }) === true);
  check('search matches a guest name, case-insensitively',
    spanMatchesSearch(span(), 'nadeeka') === true);
  check('…and a confirmation number', spanMatchesSearch(span(), '00001') === true);
  check('…and misses what is not there', spanMatchesSearch(span(), 'zzz') === false);
  check('an empty search matches nothing rather than everything',
    spanMatchesSearch(span(), '   ') === false);

  section('8 · X-axis virtualisation');
  const slice = visibleSlice(365, 0, 900, 46, 10);
  check('the first screen starts at zero', slice.startIndex === 0, slice);
  check('…and renders far fewer than every day',
    slice.endIndex - slice.startIndex < 60, slice);
  const mid = visibleSlice(365, 46 * 100, 900, 46, 10);
  check('scrolling moves the window', mid.startIndex === 90, mid);
  check('…and keeps it inside the range', mid.endIndex <= 365, mid);
  const end = visibleSlice(365, 46 * 400, 900, 46, 10);
  check('scrolling past the end is clamped, not negative',
    end.startIndex >= 0 && end.endIndex <= 365 && end.endIndex >= end.startIndex, end);
  check('a zero-width cell cannot divide by zero',
    visibleSlice(365, 0, 900, 0).endIndex === 0);
  check('an empty chart is handled', visibleSlice(0, 0, 900, 46).endIndex === 0);

  process.stdout.write(`\n${checks - failures}/${checks} tape chart checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('Chunks stitch back into one truthful chart.\n');
}

await main();
