// ─────────────────────────────────────────────────────────────
// Is this installation connected to the channel, and does the channel hold
// the same prices we do?
//
//   npm run beds24:status
//   npm run beds24:status -- --from 2026-08-19 --to 2026-09-01
//
// **Read-only on both sides.** This is the difference between it and
// `beds24:verify`: that one proves the round trip by *making* a change 300 days
// out and putting it back, which is the stronger proof and the reason you would
// not run it casually against a trading property. This one only reads — a token
// refresh (which returns an access token and does not rotate the refresh token),
// then properties, rooms and the calendar. Nothing is written anywhere.
//
// It exists because "are we connected?" was previously answerable only by
// writing to the live account, or by reading a status column that says
// `connected` because that is what it was set to the last time anything worked.
// A stored status is a memory; this asks.
//
// What it can prove: Helio ↔ Beds24. What it cannot: Beds24 → Hostelworld or
// Booking.com. That hop belongs to Beds24 and only Beds24 can report it — but
// if the price is right here, the remaining hop is theirs, not yours.
// ─────────────────────────────────────────────────────────────
const { all, get } = await import('../src/db.ts');
const { beds24ClientFor } = await import('../src/services/channels.ts');
const { HUB } = await import('../src/channels/beds24.ts');

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const out = (s = '') => process.stdout.write(`${s}\n`);
const money = (m: number | null | undefined) => (m == null ? '—' : `${(m / 100).toFixed(2)}`);

let problems = 0;

const property = all<any>('SELECT id, name, currency FROM properties')[0];
if (!property) { out('No property on this installation.'); process.exit(1); }

const channel = get<any>(
  `SELECT * FROM channels WHERE code = 'BEDS24' AND property_id = ?`, property.id);
if (!channel) {
  out(`No ${HUB} connection on ${property.name}. Connect it from Channel Manager.`);
  process.exit(1);
}

const today = get<{ business_date: string }>(
  'SELECT business_date FROM properties WHERE id = ?', property.id)!.business_date;
const FROM = arg('from') ?? today;
const TO = arg('to') ?? new Date(Date.parse(FROM) + 13 * 864e5).toISOString().slice(0, 10);

out('');
out(`Property   ${property.name} (${property.currency})`);
out(`Channel    ${channel.name} · stored status "${channel.status}" · last sync ${channel.last_sync_at ?? 'never'}`);

const client = beds24ClientFor(channel);

// ── 1 · Does the stored credential still work, and for whose account? ──
//
// The first real call is the authentication test. `listProperties` cannot
// answer without exchanging the refresh token for an access token, so a
// successful reply proves the credential and tells us which account it belongs
// to in one round trip — and asking the token what it can see is a better
// question than asking whether it exists.
out('\n1 · Authentication and account');
let propsRes: any;
try {
  propsRes = await client.listProperties();
  out('   ✓ refresh token accepted');
} catch (e) {
  problems++;
  out(`   ✗ FAILED — ${(e as Error).message}`);
  out('');
  out('   Everything below depends on this, so nothing else was checked.');
  out('   Reconnect from Channel Manager with a fresh invite code, or set');
  out('   BEDS24_REFRESH_TOKEN and restart the API.');
  process.exit(1);
}

const remoteProps: any[] = propsRes?.data?.data ?? [];
for (const p of remoteProps) out(`   · ${p.name} — id ${p.id}, ${p.propertyType ?? 'property'}, ${p.currency ?? '?'}`);
if (!remoteProps.length) { problems++; out('   ✗ the token sees no properties'); }
// A currency mismatch silently sells rooms at the wrong number, and nothing
// downstream can detect it: 5.50 is a valid price in either currency.
for (const p of remoteProps) {
  if (p.currency && property.currency && p.currency !== property.currency) {
    problems++;
    out(`   ✗ currency mismatch — Helio is ${property.currency}, ${p.name} is ${p.currency}`);
  }
}

// ── 3 · Do the mapped rooms exist over there? ────────────────
out('\n2 · Room mappings');
const roomsRes: any = await client.listRooms();
const remoteRooms: any[] = roomsRes?.data?.data ?? [];
const byId = new Map(remoteRooms.map((r) => [String(r.id), r]));

const mappings = all<any>(`
  SELECT m.external_room_id, m.external_qty, rt.name AS room_type, rt.kind, rt.id AS rt_id
  FROM channel_mappings m JOIN room_types rt ON rt.id = m.room_type_id
  WHERE m.channel_id = ? AND m.active = 1
  ORDER BY rt.name`, channel.id);

if (!mappings.length) { problems++; out('   ✗ no active mappings — nothing can be published'); }

for (const m of mappings) {
  const r = byId.get(String(m.external_room_id));
  if (!r) {
    problems++;
    out(`   ✗ ${m.room_type} → ${m.external_room_id} does not exist on ${HUB}`);
    continue;
  }
  // Quantity drift is the one that oversells: Helio thinks it has six beds to
  // sell and the channel is selling eight.
  const qtyNote = r.qty != null && m.external_qty != null && Number(r.qty) !== Number(m.external_qty)
    ? `  ✗ quantity drift: Helio recorded ${m.external_qty}, ${HUB} says ${r.qty}` : '';
  if (qtyNote) problems++;
  out(`   ${qtyNote ? '✗' : '✓'} ${m.room_type.padEnd(38)} → ${m.external_room_id} "${r.name}" qty=${r.qty}${qtyNote}`);
}

// ── How many times is a pushed price actually charged? ───────
//
// A rate rule carries `priceFor`. Set to "up to 2 persons" on a room that
// sleeps four, Beds24 charges two units of whatever we send: a suite pushed at
// 74 is advertised at 148. The number leaves here correct, arrives correct, and
// is still wrong on the OTA — so a price comparison alone will never find it.
// This is the check that would have.
out('\n   Price basis');
try {
  const withRules: any[] = await client.listRoomsWithRules();
  const rulesById = new Map(withRules.map((r) => [r.id, r]));
  for (const m of mappings) {
    const info = rulesById.get(String(m.external_room_id));
    if (!info || !info.rules.length) continue;
    for (const rule of info.rules) {
      if (rule.priceForType !== 'upToPerson' || !rule.upToPersonValue) continue;
      const units = Math.ceil(info.maxPeople / rule.upToPersonValue);
      if (units <= 1) {
        out(`   ✓ ${m.room_type.padEnd(38)} "${rule.name}" covers all ${info.maxPeople} guest(s)`);
        continue;
      }
      problems++;
      out(`   ✗ ${m.room_type}`);
      out(`       "${rule.name}" is priced for up to ${rule.upToPersonValue} guest(s) but the room`);
      out(`       sleeps ${info.maxPeople}, so ${HUB} charges ${units}× — a price of X is advertised as ${units}X.`);
      out(`       Fix in ${HUB}: set this rate's "price for" to ${info.maxPeople} guests (one price per room).`);
    }
  }
} catch (e) {
  out(`   · could not read rate rules — ${(e as Error).message}`);
}

// ── 4 · Is the price the same on both sides? ─────────────────
out(`\n3 · Prices, ${FROM} → ${TO}`);
let compared = 0;
let differs = 0;

for (const m of mappings) {
  let cal: any;
  try {
    cal = await client.getCalendar(String(m.external_room_id), FROM, TO);
  } catch (e) {
    problems++;
    out(`   ✗ ${m.room_type}: calendar read failed — ${(e as Error).message}`);
    continue;
  }
  const entries: any[] = cal?.data?.data ?? [];
  // Beds24 returns ranges, not days. Expand them so a day-by-day comparison is
  // possible; a range that spans the whole fortnight is one row over there and
  // fourteen prices over here.
  const remote = new Map<string, number>();
  for (const e of entries) {
    for (const d of (e.calendar ?? [])) {
      const price = d.price1 ?? d.price;
      if (price == null) continue;
      let day: string = d.from ?? d.date;
      const last: string = d.to ?? d.date;
      while (day <= last) {
        remote.set(day, Math.round(Number(price) * 100));
        day = new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10);
      }
    }
  }

  const local = all<any>(
    `SELECT date, price_minor FROM rate_calendar
     WHERE room_type_id = ? AND date BETWEEN ? AND ? ORDER BY date`, m.rt_id, FROM, TO);

  const bad: string[] = [];
  for (const row of local) {
    const there = remote.get(row.date);
    compared++;
    if (there == null) { bad.push(`${row.date} missing on ${HUB}`); continue; }
    if (there !== row.price_minor) {
      bad.push(`${row.date} here ${money(row.price_minor)} / there ${money(there)}`);
    }
  }

  if (bad.length === 0) {
    out(`   ✓ ${m.room_type.padEnd(38)} ${local.length} date(s) match`);
  } else {
    differs += bad.length;
    problems++;
    out(`   ✗ ${m.room_type}`);
    for (const b of bad.slice(0, 6)) out(`       ${b}`);
    if (bad.length > 6) out(`       …and ${bad.length - 6} more`);
  }
}

// ── 5 · Is anything waiting to go out? ───────────────────────
out('\n4 · Outbound queue');
const queued = get<any>(
  `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM channel_queue
   WHERE property_id = ? AND status = 'queued'`, property.id);
const parked = get<any>(
  `SELECT COUNT(*) AS n FROM channel_queue WHERE property_id = ? AND status = 'failed'`, property.id);

const { readOnlyChannels } = await import('../src/services/channels.ts');
const publishing = !readOnlyChannels();

if (!publishing) {
  problems++;
  out('   ✗ HELIO_CHANNEL_READONLY is set — nothing queued will ever be sent.');
  out('     Bookings still import. Remove it from .env and restart to publish.');
} else {
  out('   ✓ publishing is enabled');
}
out(`   ${queued.n === 0 ? '✓' : '·'} ${queued.n} waiting${queued.oldest ? ` (oldest ${queued.oldest})` : ''}`);
if (parked.n > 0) { problems++; out(`   ✗ ${parked.n} parked after repeated failures — see Channel Manager → Sync log`); }

// ── Verdict ─────────────────────────────────────────────────
out('');
if (problems === 0) {
  out(`Connected. ${compared} date(s) checked across ${mappings.length} room type(s); everything matches.`);
} else {
  out(`${problems} problem(s) found${differs ? `, ${differs} date(s) out of step` : ''}.`);
}
out('Read-only: nothing was written to the channel or to the database.');
out(`This proves Helio ↔ ${HUB}. Whether ${HUB} has passed it on to each OTA is theirs to report.`);
process.exit(problems === 0 ? 0 : 1);
