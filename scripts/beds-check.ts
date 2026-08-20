// ─────────────────────────────────────────────────────────────
// Exercises bed configuration and the capacity derived from it.
//
//   node --experimental-sqlite scripts/beds-check.ts
//
// The number that matters is **sleeps**. Get it wrong and the property either
// sells a room to more people than it can hold — a family arriving to find one
// bed short — or refuses a booking it could have taken. The single most common
// way to get it wrong is counting a bunk as one bed, so that case is checked
// from several directions.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-beds-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate } = await import('../src/db.ts');
const beds = await import('../src/lib/beds.ts');

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}\n`);
  if (!ok) {
    failures++;
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 320)}\n`);
  }
}
function section(t: string) { process.stdout.write(`\n${t}\n${'─'.repeat(t.length)}\n`); }

const cfg = (...specs: Array<[string, number]>) => specs.map(([kind, count]) => ({ kind, count }));

async function main() {
  process.stdout.write(`\nBed configuration checks\n${'─'.repeat(24)}\n`);
  migrate();

  section('1 · Sleeping capacity');
  check('a single sleeps one', beds.sleeps(cfg(['single', 1])) === 1);
  check('a double sleeps two', beds.sleeps(cfg(['double', 1])) === 2);
  check('a king sleeps two', beds.sleeps(cfg(['king', 1])) === 2);
  // The classic mistake: a bunk is one piece of furniture and two berths.
  check('a bunk sleeps TWO, not one', beds.sleeps(cfg(['bunk', 1])) === 2,
    beds.sleeps(cfg(['bunk', 1])));
  check('three bunks sleep six', beds.sleeps(cfg(['bunk', 3])) === 6,
    beds.sleeps(cfg(['bunk', 3])));
  check('a king and two singles sleep four',
    beds.sleeps(cfg(['king', 1], ['single', 2])) === 4,
    beds.sleeps(cfg(['king', 1], ['single', 2])));
  check('an empty configuration sleeps nobody', beds.sleeps([]) === 0);

  section('2 · Extra beds are not standing capacity');
  // A rollaway is brought in on request. Counting it as standing capacity would
  // sell a room as sleeping more than it does when nobody asked for the extra.
  check('a cot does not add to standing capacity',
    beds.sleeps(cfg(['double', 1], ['cot', 1])) === 2,
    beds.sleeps(cfg(['double', 1], ['cot', 1])));
  check('nor does a rollaway',
    beds.sleeps(cfg(['double', 1], ['extra_bed', 1])) === 2);
  check('but they count towards the most it could hold',
    beds.sleepsWithExtras(cfg(['double', 1], ['extra_bed', 1])) === 3,
    beds.sleepsWithExtras(cfg(['double', 1], ['extra_bed', 1])));
  check('a room of only extras has no standing bed',
    beds.sleeps(cfg(['extra_bed', 2])) === 0);

  section('3 · Berths — what a dorm sells');
  check('a bunk is two berths', beds.berths(cfg(['bunk', 1])) === 2);
  check('six bunks are twelve berths', beds.berths(cfg(['bunk', 6])) === 12,
    beds.berths(cfg(['bunk', 6])));
  check('a pod is one berth', beds.berths(cfg(['pod', 1])) === 1);
  check('a double berth is one berth that sleeps two',
    beds.berths(cfg(['double_berth', 1])) === 1
      && beds.sleeps(cfg(['double_berth', 1])) === 2,
    { berths: beds.berths(cfg(['double_berth', 1])), sleeps: beds.sleeps(cfg(['double_berth', 1])) });

  section('4 · The line a guest reads');
  check('one bed reads naturally',
    beds.describeBedConfig(cfg(['king', 1])) === '1 king', beds.describeBedConfig(cfg(['king', 1])));
  check('several are pluralised',
    beds.describeBedConfig(cfg(['single', 2])) === '2 singles',
    beds.describeBedConfig(cfg(['single', 2])));
  check('the biggest bed is named first',
    beds.describeBedConfig(cfg(['single', 2], ['king', 1])) === '1 king, 2 singles',
    beds.describeBedConfig(cfg(['single', 2], ['king', 1])));
  check('a word already ending in s is not doubled',
    beds.describeBedConfig(cfg(['sofa_bed', 2])) === '2 sofa beds',
    beds.describeBedConfig(cfg(['sofa_bed', 2])));
  check('nothing configured says so plainly',
    beds.describeBedConfig([]) === 'No beds configured');

  section('5 · Reading a stored configuration');
  check('JSON round-trips',
    beds.parseBedConfig('[{"kind":"king","count":1}]').length === 1);
  check('null is an empty configuration, not an error',
    beds.parseBedConfig(null).length === 0);
  check('an unreadable string is an empty configuration',
    beds.parseBedConfig('not json').length === 0);
  // Duplicates merged, so the summary reads the way somebody would say it.
  check('two entries of the same kind merge',
    beds.parseBedConfig([{ kind: 'single', count: 1 }, { kind: 'single', count: 1 }])[0].count === 2,
    beds.parseBedConfig([{ kind: 'single', count: 1 }, { kind: 'single', count: 1 }]));

  let unknownKind = false;
  try { beds.parseBedConfig([{ kind: 'waterbed', count: 1 }]); } catch { unknownKind = true; }
  check('an unknown bed kind is refused', unknownKind);

  let badCount = false;
  try { beds.parseBedConfig([{ kind: 'king', count: 0 }]); } catch { badCount = true; }
  check('a count of zero is refused', badCount);

  let fractional = false;
  try { beds.parseBedConfig([{ kind: 'king', count: 1.5 }]); } catch { fractional = true; }
  check('half a bed is refused', fractional);

  let notAList = false;
  try { beds.parseBedConfig({ kind: 'king' }); } catch { notAList = true; }
  check('a single object rather than a list is refused', notAList);

  section('6 · Capacity is checked against what the type claims');
  const ok = beds.checkCapacity(cfg(['king', 1], ['single', 2]),
    { maxOccupancy: 4, baseOccupancy: 2, kind: 'room' });
  check('a matching configuration has nothing to say', ok.warnings.length === 0, ok.warnings);
  check('and reports what it sleeps', ok.sleeps === 4, ok.sleeps);
  check('with the summary alongside', ok.summary === '1 king, 2 singles', ok.summary);

  // The failure that sends a family to reception at midnight.
  const short = beds.checkCapacity(cfg(['double', 1]),
    { maxOccupancy: 4, baseOccupancy: 2, kind: 'room' });
  check('admitting more guests than there are beds is flagged',
    short.warnings.some((w) => /nowhere to sleep/i.test(w)), short.warnings);
  check('and it says how many would be left standing',
    short.warnings.some((w) => /2 guest\(s\)/.test(w)), short.warnings);

  const wasted = beds.checkCapacity(cfg(['king', 1], ['single', 2]),
    { maxOccupancy: 2, baseOccupancy: 2, kind: 'room' });
  check('a bed going unsold is flagged too',
    wasted.warnings.some((w) => /going unsold/i.test(w)), wasted.warnings);

  const empty = beds.checkCapacity([], { maxOccupancy: 2, baseOccupancy: 2, kind: 'room' });
  check('no beds at all is flagged',
    empty.warnings.some((w) => /no beds are configured/i.test(w)), empty.warnings);

  const backwards = beds.checkCapacity(cfg(['double', 1]),
    { maxOccupancy: 2, baseOccupancy: 4, kind: 'room' });
  check('base occupancy above maximum is flagged',
    backwards.warnings.some((w) => /base occupancy/i.test(w)), backwards.warnings);

  section('7 · Dorms and private rooms are not interchangeable');
  const wrongForDorm = beds.checkCapacity(cfg(['king', 1]),
    { maxOccupancy: 2, baseOccupancy: 1, kind: 'dorm' });
  check('a private-room bed in a dorm is flagged',
    wrongForDorm.warnings.some((w) => /sold by the berth/i.test(w)), wrongForDorm.warnings);
  check('and it names the offending bed',
    wrongForDorm.warnings.some((w) => /King/.test(w)), wrongForDorm.warnings);

  const wrongForRoom = beds.checkCapacity(cfg(['pod', 4]),
    { maxOccupancy: 4, baseOccupancy: 1, kind: 'room' });
  check('dorm berths in a private room are flagged',
    wrongForRoom.warnings.some((w) => /private room/i.test(w)), wrongForRoom.warnings);

  const goodDorm = beds.checkCapacity(cfg(['dorm_bunk', 6]),
    { maxOccupancy: 6, baseOccupancy: 1, kind: 'dorm' });
  check('a properly configured dorm has nothing to say',
    goodDorm.warnings.length === 0, goodDorm.warnings);
  check('and sleeps one per berth', goodDorm.sleeps === 6, goodDorm.sleeps);

  section('8 · The vocabulary itself');
  check('every kind has a capacity',
    beds.BED_KINDS.every((k) => k.sleeps >= 1), beds.BED_KINDS.filter((k) => k.sleeps < 1));
  check('every kind is described for a person',
    beds.BED_KINDS.every((k) => k.description.length > 10));
  check('codes are unique',
    new Set(beds.BED_KINDS.map((k) => k.code)).size === beds.BED_KINDS.length);
  check('dorm berths are marked as such',
    beds.bedKind('pod')?.dorm === true && beds.bedKind('king')?.dorm === false);
  check('extras are marked as such',
    beds.bedKind('cot')?.extra === true && beds.bedKind('single')?.extra === false);
  check('an unknown code resolves to nothing', beds.bedKind('hammock') === undefined);

  section('9 · A real property, described');
  // The demo hotel, expressed properly for the first time.
  const family = beds.checkCapacity(cfg(['double', 2]),
    { maxOccupancy: 4, baseOccupancy: 2, kind: 'room' });
  check('the family room with two doubles sleeps four',
    family.sleeps === 4, family.sleeps);
  check('and reads as "2 doubles"', family.summary === '2 doubles', family.summary);
  check('with nothing to correct', family.warnings.length === 0, family.warnings);

  const dorm24 = beds.checkCapacity(cfg(['dorm_bunk', 24]),
    { maxOccupancy: 24, baseOccupancy: 1, kind: 'dorm' });
  check('a 24-bed dorm sleeps 24', dorm24.sleeps === 24, dorm24.sleeps);
  check('and sells 24 berths', dorm24.berths === 24, dorm24.berths);

  const single = beds.checkCapacity(cfg(['single', 1]),
    { maxOccupancy: 1, baseOccupancy: 1, kind: 'room' });
  check('a single room sleeps one', single.sleeps === 1 && single.warnings.length === 0,
    single);

  process.stdout.write(`\n${checks - failures}/${checks} bed configuration checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('Capacity follows the beds, and a bunk counts as two.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
