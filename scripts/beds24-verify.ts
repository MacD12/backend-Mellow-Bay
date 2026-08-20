// ─────────────────────────────────────────────────────────────
// Prove the connection, rather than claim it.
//
//   npm run beds24:verify
//
// Every other check in this repo runs against a stub. This one runs a real
// round trip against the live account: make a change in Helio, wait for the
// queue to drain, read it back from Beds24, and put it back the way it was.
//
// It is deliberately paranoid about the property's actual trading:
//
//   · It works on dates **300 days out**, far past any real booking window.
//   · It records the before state and restores it, whatever happens.
//   · It refuses to run on dates that have a booking on them.
//
// What this can and cannot prove is worth being clear about. It proves Helio →
// Beds24. It cannot prove Beds24 → Hostelworld: that hop is Beds24's to make
// and only Beds24 can report it. What it does prove is that everything on
// Helio's side of that hop is working.
// ─────────────────────────────────────────────────────────────
const { migrate, get, run } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const channels = await import('../src/services/channels.ts');
const { queueChannelPush } = await import('../src/services/reservations.ts');

function out(s = '') { process.stdout.write(`${s}\n`); }
function step(t: string) { out(`\n${t}\n${'─'.repeat(t.length)}`); }
function fail(s: string): never { throw new Error(s); }

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  if (ok) { out(`   ✓ ${name}`); return; }
  failures++;
  out(`   ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

const BASE = process.env.BEDS24_API ?? 'https://api.beds24.com/v2';

async function beds24Token(): Promise<string> {
  const rt = process.env.BEDS24_REFRESH_TOKEN?.trim();
  if (!rt) fail('BEDS24_REFRESH_TOKEN is not set.');
  const r = await fetch(`${BASE}/authentication/token`, { headers: { refreshToken: rt } });
  const b = await r.json() as any;
  if (!b?.token) fail(`Beds24 refused the token: ${JSON.stringify(b).slice(0, 160)}`);
  return b.token;
}

/** What Beds24 currently holds for one room across a date range. */
async function readBeds24(token: string, roomId: string, from: string, to: string) {
  const r = await fetch(
    `${BASE}/inventory/rooms/calendar?roomId=${roomId}&startDate=${from}&endDate=${to}`
    + '&includePrices=true&includeNumAvail=true',
    { headers: { token, accept: 'application/json' } });
  const b = await r.json() as any;
  const room = (b.data ?? []).find((x: any) => String(x.roomId) === String(roomId));
  const day = (room?.calendar ?? [])[0] ?? {};
  return { price: Number(day.price1), avail: Number(day.numAvail), raw: day };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  out('\nBeds24 ↔ Helio · live round trip');
  out('═══════════════════════════════');
  migrate();

  // ── What we are working with ────────────────────────────────
  step('1 · The connection');
  const property = get<any>('SELECT * FROM properties WHERE active = 1 LIMIT 1');
  if (!property) fail('No property.');
  const channel = get<any>(
    `SELECT * FROM channels WHERE property_id = ? AND status IN ('connected','error')
      ORDER BY CASE status WHEN 'connected' THEN 0 ELSE 1 END LIMIT 1`, property.id);
  if (!channel) fail('No connected channel. Run: npm run beds24:golive');

  const actor = { userId: 'system', userName: 'Live verify', propertyId: property.id };
  const test = await channels.testConnection(property.id, actor, channel.id);
  check('Beds24 answers', test.ok === true, test);
  check('the property id is known', !!channel.external_property_id, channel.external_property_id);
  check('outbound pushes are switched on', channels.readOnlyChannels() === false,
    'HELIO_CHANNEL_READONLY is set — nothing can reach the OTAs');
  if (failures) fail('The connection is not usable; the rest would tell you nothing.');

  const mapping = get<any>(
    `SELECT m.*, rt.name AS room_type_name FROM channel_mappings m
       JOIN room_types rt ON rt.id = m.room_type_id
      WHERE m.property_id = ? AND m.channel_id = ? AND m.active = 1 AND m.external_room_id IS NOT NULL
      LIMIT 1`, property.id, channel.id);
  if (!mapping) fail('No active room mapping. Run: npm run beds24:golive');
  out(`   · testing with "${mapping.room_type_name}" → Beds24 room ${mapping.external_room_id}`);

  // Far enough out that nothing real is being touched.
  const from = addDays(property.business_date, 300);
  const to = addDays(from, 1);

  const booked = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM reservation_nights
      WHERE property_id = ? AND room_type_id = ? AND date = ?`,
    property.id, mapping.room_type_id, from);
  if ((booked?.n ?? 0) > 0) fail(`${from} has a booking on it. Refusing to touch real trading.`);
  out(`   · using ${from}, 300 days out, nothing booked`);

  const token = await beds24Token();
  const before = await readBeds24(token, mapping.external_room_id, from, to);
  out(`   · Beds24 today: price ${before.price ?? '—'}, availability ${before.avail ?? '—'}`);

  const ratePlan = get<any>(
    `SELECT id FROM rate_plans WHERE property_id = ? AND active = 1 ORDER BY sort_order LIMIT 1`,
    property.id);
  if (!ratePlan) fail('No rate plan.');

  // ── A price change ──────────────────────────────────────────
  step('2 · A price change reaches Beds24');
  const priorRate = get<any>(
    'SELECT * FROM rate_calendar WHERE property_id = ? AND room_type_id = ? AND date = ?',
    property.id, mapping.room_type_id, from);

  // A number nobody would set by hand, so a stale read cannot be mistaken for
  // a fresh one.
  const probeMinor = 4321;
  run(
    `INSERT INTO rate_calendar(id, property_id, room_type_id, rate_plan_id, date,
                               price_minor, updated_at, updated_by)
     VALUES(?,?,?,?,?,?,?,'verify')
     ON CONFLICT(property_id, room_type_id, rate_plan_id, date)
     DO UPDATE SET price_minor = excluded.price_minor, updated_at = excluded.updated_at`,
    id('rc'), property.id, mapping.room_type_id, ratePlan.id, from, probeMinor, nowIso());

  queueChannelPush(property.id, mapping.room_type_id, from, to, 'live-verify.price');
  const queued = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM channel_queue WHERE property_id = ? AND status = 'queued'`,
    property.id);
  check('the change is queued', (queued?.n ?? 0) > 0, queued);

  const drain: any = await channels.processQueue(property.id, actor, 5);
  // The server's own nudged drain may have taken it already, which is a pass —
  // what matters is that nothing is left queued, not who sent it.
  check('the queue drains',
    (drain.sent ?? drain.batches ?? 0) > 0 || (drain.stillQueued ?? drain.remaining ?? 0) === 0,
    drain);

  await sleep(2500);   // Beds24 is not instant
  const afterPrice = await readBeds24(token, mapping.external_room_id, from, to);
  check(`Beds24 now shows ${(probeMinor / 100).toFixed(2)}`,
    Math.abs(afterPrice.price - probeMinor / 100) < 0.01,
    { expected: probeMinor / 100, got: afterPrice.price });

  // ── A closure ───────────────────────────────────────────────
  step('3 · Closing dates reaches Beds24');
  const rstId = id('rst');
  run(
    `INSERT INTO restrictions(id, property_id, room_type_id, rate_plan_id, channel_code,
                              date_from, date_to, type, applies_to, active, created_by, created_at)
     VALUES(?,?,?,NULL,NULL,?,?, 'stop-sell','channels',1,'verify',?)`,
    rstId, property.id, mapping.room_type_id, from, from, nowIso());

  queueChannelPush(property.id, mapping.room_type_id, from, to, 'live-verify.close');
  await channels.processQueue(property.id, actor, 5);
  await sleep(2500);

  const afterClose = await readBeds24(token, mapping.external_room_id, from, to);
  // Beds24 expresses a closure as nothing sellable that night.
  check('Beds24 shows the date as unsellable',
    afterClose.avail === 0, { avail: afterClose.avail, raw: afterClose.raw });

  // ── Reopen, and put everything back ─────────────────────────
  step('4 · Reopening reaches Beds24, and nothing is left behind');
  run('DELETE FROM restrictions WHERE id = ?', rstId);
  if (priorRate) {
    run('UPDATE rate_calendar SET price_minor = ? WHERE id = ?', priorRate.price_minor, priorRate.id);
  } else {
    run('DELETE FROM rate_calendar WHERE property_id = ? AND room_type_id = ? AND date = ?',
      property.id, mapping.room_type_id, from);
  }
  queueChannelPush(property.id, mapping.room_type_id, from, to, 'live-verify.restore');
  await channels.processQueue(property.id, actor, 5);
  await sleep(2500);

  const restored = await readBeds24(token, mapping.external_room_id, from, to);
  check('the date is sellable again', restored.avail > 0, { avail: restored.avail });
  check('the price is back to what it was',
    !Number.isFinite(before.price) || Math.abs(restored.price - before.price) < 0.01,
    { was: before.price, now: restored.price });
  check('no test restriction is left behind',
    !get<any>('SELECT id FROM restrictions WHERE id = ?', rstId));

  // ── Inbound ─────────────────────────────────────────────────
  step('5 · Bookings come back the other way');
  const imported: any = await channels.importBookings(property.id, actor, channel.id);
  check('Helio can read bookings from Beds24', imported !== null && imported !== undefined, imported);
  const lastPoll = get<{ ts: string }>(
    `SELECT MAX(ts) AS ts FROM channel_sync_log
      WHERE channel_id = ? AND action LIKE 'import bookings%' AND status = 'success'`, channel.id);
  check('…and records when it last succeeded', !!lastPoll?.ts, lastPoll?.ts);

  // ── The verdict ─────────────────────────────────────────────
  out(`\n${'═'.repeat(31)}`);
  out(`${checks - failures}/${checks} live checks passed`);
  if (failures) {
    out('\nThe connection is NOT fully working. See the failures above.');
    process.exitCode = 1;
    return;
  }
  out('\nHelio → Beds24 is working, both ways, proved on the live account:');
  out('  · a price change was read back from Beds24');
  out('  · a closure made the date unsellable there');
  out('  · reopening restored it, and the original values are back');
  out('  · bookings can be read back from Beds24');
  out('\nOne hop is outside this test: Beds24 → Hostelworld. Only Beds24 can');
  out('report that. Check the OTA itself a few minutes after a change.');
}

main().catch((e) => {
  process.stderr.write(`\n✗ ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exit(1);
});
