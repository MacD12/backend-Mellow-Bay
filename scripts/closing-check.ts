// ─────────────────────────────────────────────────────────────
// Closing rooms on the OTAs without closing them to the front desk.
//
//   node --experimental-sqlite scripts/closing-check.ts
//
// A property closes rooms for two quite different reasons, and Helio used to
// have one mechanism for both:
//
//   · "stop the OTAs selling this" — the room exists, the desk carries on, and
//     often that is the entire point: pull the last beds off Hostelworld so
//     they can be sold at the door;
//   · "nobody sells this" — a burst pipe, a repaint.
//
// A `stop-sell` with no channel scope matched a walk-in too, because a walk-in
// is simply a booking with no channel code. So closing rooms on the OTAs also
// stopped reception serving the guest standing in front of them — backwards,
// since the desk is the one seller who can see the room and has the guest in
// the building.
//
// The other half matters just as much: a closure aimed at the desk must not
// close dates on an OTA, and a closure aimed at one OTA must leave the others
// selling. Both directions are checked here.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-close-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run } = await import('../src/db.ts');
const { id, nowIso } = await import('../src/lib/util.ts');
const { validateStay, restrictionGrid } = await import('../src/services/restrictions.ts');

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  if (ok) { process.stdout.write(`  ✓ ${name}\n`); return; }
  failures++;
  process.stdout.write(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`);
}
function section(t: string) { process.stdout.write(`\n${t}\n${'─'.repeat(t.length)}\n`); }

const P = 'prp_close';

function seed() {
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,'CL','Closing','hostel','UTC','USD','en','2026-06-01','14:00','11:00',1,?)`,
    P, nowIso());
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                            max_adults, max_children, default_rate_minor, active, created_at)
     VALUES('rt1',?,'DORM','Dorm','dorm',1,1,1,0,800,1,?)`, P, nowIso());
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, active, created_at)
     VALUES('rp1',?,'STD','Standard',1,?)`, P, nowIso());
}

function close(appliesTo: string | null, channelCode: string | null = null) {
  const rid = id('rst');
  if (appliesTo === null) {
    // A row written before `applies_to` existed: the column takes its default.
    run(
      `INSERT INTO restrictions(id, property_id, room_type_id, rate_plan_id, channel_code,
                                date_from, date_to, type, active, created_at)
       VALUES(?,?, 'rt1', NULL, ?, '2026-06-10','2026-06-12','stop-sell',1,?)`,
      rid, P, channelCode, nowIso());
  } else {
    run(
      `INSERT INTO restrictions(id, property_id, room_type_id, rate_plan_id, channel_code,
                                date_from, date_to, type, applies_to, active, created_at)
       VALUES(?,?, 'rt1', NULL, ?, '2026-06-10','2026-06-12','stop-sell',?,1,?)`,
      rid, P, channelCode, appliesTo, nowIso());
  }
  return rid;
}

const clearRules = () => run('DELETE FROM restrictions WHERE property_id = ?', P);

/** Try to sell the closed dates through a channel, or at the desk. */
function sell(channelCode: string | null) {
  return validateStay(P, {
    roomTypeId: 'rt1', ratePlanId: 'rp1',
    arrival: '2026-06-10', departure: '2026-06-11',
    channelCode, bookedOn: '2026-06-01',
  });
}

/** Would the OTA be told these dates are shut? */
function otaClosed(channelCode: string | null = 'BEDS24') {
  const grid = restrictionGrid(P, 'rt1', 'rp1', '2026-06-10', '2026-06-11', channelCode);
  return grid.some((d: any) => d.stopSell === true || d.closed === true);
}

async function main() {
  process.stdout.write(`\nClosing rooms · checks\n${'─'.repeat(22)}\n`);
  migrate();
  seed();

  section('1 · A channel closure leaves the desk selling');
  close('channels');
  check('the OTA is blocked', sell('BEDS24').length > 0, sell('BEDS24'));
  // The defect this whole change exists for.
  check('the walk-in is NOT blocked', sell(null).length === 0, sell(null));
  check('…and the OTA is still told the dates are shut', otaClosed(), otaClosed());
  clearRules();

  section('2 · A total closure stops everyone');
  close('all');
  check('the OTA is blocked', sell('BEDS24').length > 0);
  check('and so is the walk-in — nobody sells a flooded room', sell(null).length > 0, sell(null));
  check('the OTA is told', otaClosed());
  clearRules();

  section('3 · Rules written before this keep their old meaning');
  // Reinterpreting stored restrictions would silently open dates somebody
  // deliberately shut, which is the one outcome worse than the original bug.
  close(null);
  check('a row with no scope still blocks the OTA', sell('BEDS24').length > 0);
  check('…and still blocks the desk, exactly as it did before',
    sell(null).length > 0, sell(null));
  clearRules();

  section('4 · A desk-only closure does not reach the OTAs');
  // The mirror image: "stop selling this at the desk" must not shut the dates
  // on Hostelworld, or the property loses the sales it was trying to keep.
  close('direct');
  check('the desk is blocked', sell(null).length > 0);
  check('the OTA is not', sell('BEDS24').length === 0, sell('BEDS24'));
  check('…and nothing is pushed out closing it', otaClosed() === false, otaClosed());
  clearRules();

  section('5 · Closing one OTA leaves the others selling');
  close('channels', 'BEDS24');
  check('the named channel is blocked', sell('BEDS24').length > 0);
  check('another channel is not', sell('AIRBNB').length === 0, sell('AIRBNB'));
  check('the desk is not', sell(null).length === 0, sell(null));
  clearRules();

  section('6 · No closure at all sells to everyone');
  check('the OTA can sell', sell('BEDS24').length === 0);
  check('the desk can sell', sell(null).length === 0);
  check('and nothing is shut on the channel', otaClosed() === false);

  section('7 · Scoping does not leak into other restriction types');
  // A min-stay the front desk quietly ignores is a min-stay that does not
  // exist, so those keep the blanket meaning.
  run(
    `INSERT INTO restrictions(id, property_id, room_type_id, rate_plan_id, channel_code,
                              date_from, date_to, type, value, applies_to, active, created_at)
     VALUES(?,?, 'rt1', NULL, NULL, '2026-06-10','2026-06-12','min-stay',3,'all',1,?)`,
    id('rst'), P, nowIso());
  check('a min-stay binds the OTA', sell('BEDS24').some((v: any) => v.type === 'min-stay'));
  check('…and binds the desk too', sell(null).some((v: any) => v.type === 'min-stay'));

  section('8 · Closing dates actually reaches the channel');
  // The whole of "open/close does not work": closing dates wrote a row, Helio
  // refused to sell them, and *nothing was sent to Beds24* — so the OTAs
  // carried on selling rooms the property had shut. Reopening was worse: the
  // dates stayed closed on the OTAs and the property lost the sales silently.
  //
  // The routes start a server on import, so the wiring is asserted at source.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/routes/rates.ts', import.meta.url), 'utf8');

  check('the restriction routes push to the channel',
    (src.match(/pushRestriction\(/g) ?? []).length >= 4,
    `${(src.match(/pushRestriction\(/g) ?? []).length} call sites`);
  /**
   * One handler's body: from its route line to wherever the next route begins.
   *
   * A fixed slice is the wrong tool — the POST handler is long enough that its
   * push lands past any window short enough to keep PATCH from bleeding into
   * the next route.
   */
  const handler = (verb: string) => {
    const after = src.split(`router.${verb}('/api/restrictions`)[1] ?? '';
    const next = after.indexOf('\nrouter.');
    return next > 0 ? after.slice(0, next) : after;
  };

  for (const route of ['post', 'patch', 'delete']) {
    check(`…including ${route.toUpperCase()}`,
      handler(route).includes('pushRestriction('), route);
  }
  // Moving a closure has to reopen the dates it left, not only close the new
  // ones — otherwise the old range stays shut on the OTAs forever.
  const patchBody = handler('patch');
  check('a moved closure pushes its old range too',
    (patchBody.match(/pushRestriction\(/g) ?? []).length >= 2, patchBody.slice(0, 120));
  // And the delete must read the row before removing it, or there is nothing
  // left to say which dates to reopen.
  const deleteBody = handler('delete');
  check('deleting reads the dates before removing them',
    deleteBody.indexOf('SELECT * FROM restrictions') < deleteBody.indexOf('DELETE FROM restrictions'),
    deleteBody.slice(0, 120));

  // Queueing must survive a channel that is briefly in error, or a change made
  // in that window is lost rather than delayed.
  const resSrc = readFileSync(new URL('../src/services/reservations.ts', import.meta.url), 'utf8');
  const rateSrc = readFileSync(new URL('../src/services/rateplanning.ts', import.meta.url), 'utf8');
  check('availability changes queue even while the channel is in error',
    /status IN \('connected', 'error'\)/.test(resSrc));
  check('…and so do price changes', /status IN \('connected', 'error'\)/.test(rateSrc));

  process.stdout.write(`\n${checks - failures}/${checks} closing checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('Closing the OTAs no longer closes reception.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows locks */ }
}
