// ─────────────────────────────────────────────────────────────
// Take this property live on Beds24.
//
//   BEDS24_REFRESH_TOKEN=… node --experimental-sqlite scripts/beds24-golive.ts
//   …                                                  --import   also pull bookings
//   …                                                  --push     also send rates/availability
//
// One command, six steps, each one proved before the next is attempted:
//
//   1 · Exchange the refresh token for an access token
//   2 · Read the Beds24 property and confirm which one it is
//   3 · List the rooms Beds24 holds
//   4 · Map them to this PMS's room types
//   5 · Import the real bookings           (--import)
//   6 · Push rates and availability out    (--push)
//
// Nothing is destructive. It maps by exact name and leaves anything ambiguous
// for a person, because a wrong mapping sends one room type's prices to another
// room's calendar — which is worse than no mapping at all, and harder to notice.
//
// The token is stored the way every credential is: encrypted at rest when
// HELIO_SECRET_KEY is set, and never returned by the API.
// ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DO_IMPORT = args.includes('--import');
const DO_PUSH = args.includes('--push');
const CREATE_TYPES = args.includes('--create-room-types');

const { migrate, all, get, run } = await import('../src/db.ts');
const { encryptionAvailable } = await import('../src/lib/secrets.ts');
const channels = await import('../src/services/channels.ts');
const { bootstrapBeds24 } = await import('../src/services/beds24bootstrap.ts');
const { addDays, id, nowIso } = await import('../src/lib/util.ts');

function out(s = '') { process.stdout.write(`${s}\n`); }
function step(n: number | string, title: string) { out(`\n${n} · ${title}\n${'─'.repeat(title.length + 4)}`); }
function ok(s: string) { out(`   ✓ ${s}`); }
function warn(s: string) { out(`   ! ${s}`); }
function fail(s: string): never { throw new Error(s); }

/**
 * Stamped into a room type's description when this script creates it.
 *
 * It is how a later run tells "I generated this and may refresh its rate" from
 * "a person set this up and I must not touch it". Changing the text orphans
 * every type created before the change, which then stop being refreshed.
 */
const BEDS24_ORIGIN = 'From Beds24 room ';

async function main() {
  out('\nBeds24 · go live');
  out('════════════════');
  migrate();

  if (!process.env.BEDS24_REFRESH_TOKEN?.trim()) {
    fail('Set BEDS24_REFRESH_TOKEN first.\n'
      + '   Beds24 → Settings → Apps & Integrations → API → invite code or refresh token.');
  }
  if (!encryptionAvailable()) {
    warn('HELIO_SECRET_KEY is not set, so the refresh token will be stored in clear text.');
    warn('That token controls your whole OTA distribution. Set a key before going live.');
  }

  // ── 1. The token ──────────────────────────────────────────
  step(1, 'Exchanging the refresh token');
  const boot = await bootstrapBeds24();
  if (!boot.connected) fail(boot.message);
  ok(boot.message);
  const propertyId = boot.propertyId!;
  const channelId = boot.channelId!;

  // ── 2. Which property ─────────────────────────────────────
  step(2, 'Confirming the Beds24 property');
  const test = await channels.testConnection(propertyId, systemActor(propertyId), channelId);
  ok(`Beds24 answered · ${JSON.stringify(test).slice(0, 160)}`);

  // ── 3. What Beds24 holds ──────────────────────────────────
  step(3, 'Reading the rooms Beds24 has');
  // `discoverUnits` returns a flat array and has already tried to match each
  // Beds24 room to a PMS room type by name — reuse that rather than repeating
  // the guess here with slightly different rules.
  let units = await channels.discoverUnits(propertyId, systemActor(propertyId), channelId);
  if (!units.length) {
    fail('Beds24 returned no rooms. Check that the token belongs to a property with rooms set up.');
  }
  ok(`${units.length} room(s) on the Beds24 side`);
  for (const u of units) {
    out(`     · ${String(u.externalId).padEnd(8)} ${u.name}`
      + `  (${u.kind}, ${u.quantity} unit${u.quantity === 1 ? '' : 's'}, sleeps ${u.maxPeople})`);
  }

  // ── 3b. Build the room types from what Beds24 holds ───────
  if (CREATE_TYPES) {
    step('3b', 'Creating room types from Beds24');
    await createRoomTypes(propertyId, units);
    // `units` carries the name match worked out in step 3 — against the room
    // types that existed *then*, which was none of the ones just created. Ask
    // again, or step 4 maps nothing and says the inventory is missing.
    units = await channels.discoverUnits(propertyId, systemActor(propertyId), channelId);
  }

  // ── 4. Mapping ────────────────────────────────────────────
  step(4, 'Mapping Beds24 rooms to this property');
  const pmsTypes = all<{ id: string; name: string; code: string }>(
    'SELECT id, name, code FROM room_types WHERE property_id = ? AND active = 1', propertyId);
  if (!pmsTypes.length) {
    fail('This property has no room types yet.\n'
      + '   Run again with --create-room-types to build them from your Beds24 inventory.');
  }

  const plan = get<{ id: string }>(
    `SELECT id FROM rate_plans WHERE property_id = ? AND active = 1 AND parent_id IS NULL
      ORDER BY sort_order LIMIT 1`, propertyId);

  let mapped = 0;
  const unmatched: Array<{ id: string; name: string; kind: string; quantity: number }> = [];

  for (const unit of units) {
    if (unit.status === 'mapped') {
      ok(`${unit.name} → already mapped`);
      mapped++;
      continue;
    }
    // Only a confident match is written. Anything else is left for a person:
    // putting "Deluxe Double" on the 8-bed dorm's calendar is not a
    // convenience, it is an incident that shows up as an overbooking later.
    if (unit.status !== 'suggested' || !unit.suggestedRoomTypeId) {
      unmatched.push({
        id: String(unit.externalId), name: unit.name,
        kind: unit.kind, quantity: unit.quantity,
      });
      continue;
    }

    channels.upsertMapping(propertyId, systemActor(propertyId), {
      channelId,
      roomTypeId: unit.suggestedRoomTypeId,
      ratePlanId: plan?.id ?? null,
      externalRoomId: String(unit.externalId),
      externalName: unit.name,
      active: true,
    });
    ok(`${unit.name} → ${unit.suggestedRoomType}`);
    mapped++;
  }

  if (unmatched.length) {
    out('');
    warn(`${unmatched.length} Beds24 room(s) have no matching room type here:`);
    for (const u of unmatched) {
      out(`     · ${u.id.padEnd(8)} ${u.name}  (${u.kind}, ${u.quantity} unit${u.quantity === 1 ? '' : 's'})`);
    }
    out('');
    warn('Create these as room types in Configuration, then run this again —');
    warn('or map them by hand in Channel Manager → Mappings. Nothing was guessed.');
  }
  if (!mapped) {
    out('');
    warn('Nothing was mapped, so importing would file bookings against no room type.');
    warn('Create room types matching the names above, then re-run.');
    return;
  }

  // ── 5. Real bookings ──────────────────────────────────────
  if (DO_IMPORT) {
    step(5, 'Importing bookings from Beds24');
    const since = addDays(new Date().toISOString().slice(0, 10), -30);
    const result: any = await channels.importBookings(
      propertyId, systemActor(propertyId), channelId, { since });
    ok(`${result.imported ?? 0} imported · ${result.updated ?? 0} updated · `
      + `${result.skipped ?? 0} skipped`);
    if (result.conflicts?.length) {
      warn(`${result.conflicts.length} booking(s) need a decision — see Channel Manager → Conflicts`);
    }
  } else {
    step(5, 'Importing bookings');
    out('   (skipped — re-run with --import once the mapping above looks right)');
  }

  // ── 6. Outbound ───────────────────────────────────────────
  if (DO_PUSH) {
    step(6, 'Pushing rates and availability');
    const today = get<{ business_date: string }>(
      'SELECT business_date FROM properties WHERE id = ?', propertyId)!.business_date;
    const pushed: any = await channels.pushToChannel(propertyId, systemActor(propertyId), channelId, {
      from: today, to: addDays(today, 90),
    });
    if (pushed.ok) ok(`${pushed.rooms} room(s) pushed for the next 90 days`);
    else fail(`Beds24 rejected the push: ${JSON.stringify(pushed.errors).slice(0, 300)}`);
  } else {
    step(6, 'Pushing rates and availability');
    out('   (skipped — re-run with --push when your rates are ready to go out)');
  }

  out('\n────────────────────────────────────────');
  out('Beds24 is connected and mapped.');
  if (!DO_IMPORT) out('Next:  npm run beds24:golive -- --import');
  else if (!DO_PUSH) out('Next:  npm run beds24:golive -- --import --push');
  out('');
}

function systemActor(propertyId: string) {
  return { userId: 'system', userName: 'Beds24 go-live', propertyId };
}

/**
 * Build this property's room types from what Beds24 actually holds.
 *
 * Two things about Beds24's model have to be translated, and getting either
 * wrong produces an inventory that looks plausible and oversells:
 *
 *   · **A dorm bed is sold as a one-person room.** "Bed in 8-Bed Mixed
 *     Dormitory Room" arrives as `maxPeople: 1, qty: 16` — sixteen *beds*, not
 *     sixteen rooms. Helio models a dorm natively, so 16 beds at 8 per room
 *     becomes 2 rooms of 8. The beds-per-room comes from the name when it says
 *     so, and otherwise the whole lot is treated as one room.
 *
 *   · **`qty` means different things by kind.** For a private room it is the
 *     number of rooms; for a dorm listing it is the number of beds.
 *
 * The price is read from the live calendar rather than invented. Where Beds24
 * has several prices across the window the median is used and the range is
 * printed, because a default rate is a starting point a human should confirm —
 * not a number to be silently chosen.
 */
async function createRoomTypes(propertyId: string, units: any[]) {
  // What Beds24 is actually charging, read from its calendar rather than made
  // up. A rate invented at import time is the kind of wrong number that gets
  // discovered by a guest at the desk.
  //
  // Both shapes are kept: the flat list, to pick one sensible default rate per
  // room type, and the date→price map, so the calendar can carry the real
  // per-night prices instead of one number smeared across the year.
  const today = nowIso().slice(0, 10);
  const horizon = addDays(today, 365);
  const priceByRoom = new Map<string, number[]>();
  const dailyByRoom = new Map<string, Map<string, number>>();

  const tokenRes = await fetch('https://api.beds24.com/v2/authentication/token', {
    headers: { refreshToken: process.env.BEDS24_REFRESH_TOKEN ?? '' },
  });
  if (!tokenRes.ok) fail(`Beds24 refused the token while reading prices (${tokenRes.status}).`);
  const token = (await tokenRes.json() as any).token as string;

  const calRes = await fetch(
    'https://api.beds24.com/v2/inventory/rooms/calendar'
    + `?startDate=${today}&endDate=${horizon}&includePrices=true`,
    { headers: { token, accept: 'application/json' } },
  );
  if (!calRes.ok) fail(`Beds24 would not return its calendar (${calRes.status}).`);

  for (const room of ((await calRes.json() as any).data ?? [])) {
    const roomId = String(room.roomId);
    const flat: number[] = [];
    const byDate = new Map<string, number>();
    for (const d of (room.calendar ?? [])) {
      const price = Number(d.price1);
      if (!Number.isFinite(price) || price <= 0) continue;
      // Beds24 returns a range per entry, not one row per night.
      for (let day = d.from as string; day <= d.to; day = addDays(day, 1)) {
        byDate.set(day, price);
        flat.push(price);
      }
    }
    if (flat.length) {
      priceByRoom.set(roomId, flat);
      dailyByRoom.set(roomId, byDate);
    }
  }

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const targets: Array<{ rtId: string; name: string; externalId: string }> = [];

  for (const unit of units) {
    const externalId = String(unit.externalId);
    const name = unit.name as string;
    const isDorm = unit.kind === 'dorm';
    const qty = Math.max(1, Number(unit.quantity) || 1);

    const prices = priceByRoom.get(externalId) ?? [];
    const rateMinor = prices.length ? Math.round(median(prices) * 100) : 0;

    const existing = get<{ id: string; description: string | null }>(
      'SELECT id, description FROM room_types WHERE property_id = ? AND lower(name) = lower(?)',
      propertyId, name);

    if (existing) {
      // Already here. Its prices are still refreshed below, because that is
      // what this command is for — but the type's own shape is left alone.
      //
      // The default rate is only re-derived for a type this script created
      // itself. If a person has set one, Beds24's median is not better
      // information than their decision.
      const ours = (existing.description ?? '').startsWith(BEDS24_ORIGIN);
      if (ours && rateMinor) {
        run('UPDATE room_types SET default_rate_minor = ? WHERE id = ?', rateMinor, existing.id);
      }
      targets.push({ rtId: existing.id, name, externalId });
      warn(`${name} already exists — kept${ours && rateMinor
        ? `, rate refreshed to ${(rateMinor / 100).toFixed(2)}` : ''}`);
      continue;
    }

    // "8-Bed", "6-Bed" — Beds24 puts the dorm size in the name and nowhere else.
    const perRoom = isDorm
      ? (Number(/(\d+)\s*-?\s*bed/i.exec(name)?.[1]) || qty)
      : 1;
    const roomCount = isDorm ? Math.max(1, Math.round(qty / perRoom)) : qty;
    const bedsPerRoom = isDorm ? Math.min(perRoom, qty) : 0;

    const code = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || `RT${externalId}`;
    const rtId = id('rt');
    run(
      `INSERT INTO room_types(id, property_id, code, name, description, kind, base_occupancy,
                              max_occupancy, max_adults, max_children, default_rate_minor,
                              extra_adult_minor, extra_child_minor, amenities, bed_config,
                              gender_policy, sort_order, active, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,0,0,'[]',?,?,0,1,?)`,
      rtId, propertyId, code, name, `${BEDS24_ORIGIN}${externalId}`,
      isDorm ? 'dorm' : 'room',
      isDorm ? 1 : Math.max(1, Number(unit.maxPeople) || 1),
      isDorm ? 1 : Math.max(1, Number(unit.maxPeople) || 1),
      isDorm ? 1 : Math.max(1, Number(unit.maxPeople) || 1),
      0,
      rateMinor,
      isDorm
        ? JSON.stringify([{ kind: 'dorm_bunk', count: bedsPerRoom }])
        : JSON.stringify([{ kind: Number(unit.maxPeople) >= 2 ? 'double' : 'single', count: 1 }]),
      // Beds24 says "Female" in the name and nowhere machine-readable, so the
      // policy is taken from the name and left for a person to confirm.
      isDorm ? (/female/i.test(name) ? 'female' : /male/i.test(name) ? 'male' : 'mixed') : null,
      nowIso(),
    );

    // Physical rooms, and beds for a dorm.
    for (let i = 1; i <= roomCount; i++) {
      const roomId = id('rm');
      const number = roomCount === 1 ? code.slice(0, 6) : `${code.slice(0, 4)}-${i}`;
      run(
        `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
         VALUES(?,?,?,?,1,'Vacant Clean',1,?)`,
        roomId, propertyId, rtId, number, nowIso(),
      );
      if (isDorm) {
        for (let b = 1; b <= bedsPerRoom; b++) {
          run(
            `INSERT INTO beds(id, property_id, room_id, code, bunk, status, active)
             VALUES(?,?,?,?,?,'Vacant Clean',1)`,
            id('bed'), propertyId, roomId, `${number}-${String(b).padStart(2, '0')}`,
            bedsPerRoom === 1 ? 'single' : b % 2 === 1 ? 'bottom' : 'top',
          );
        }
      }
    }

    targets.push({ rtId, name, externalId });
    ok(`${name}`);
    out(`       ${isDorm ? `dorm · ${roomCount} room(s) × ${bedsPerRoom} beds = ${roomCount * bedsPerRoom}`
      : `private · ${roomCount} room(s), sleeps ${unit.maxPeople}`}`
      + `  ·  ${rateMinor ? `${(rateMinor / 100).toFixed(2)}` : 'no price found'}`
      + (prices.length > 1
        ? ` (Beds24 has ${Math.min(...prices).toFixed(2)}–${Math.max(...prices).toFixed(2)})` : ''));
  }

  if (targets.length) seedRatePlan(propertyId, targets, dailyByRoom);
}

/**
 * Give the new inventory a rate plan, and fill its calendar from Beds24.
 *
 * Room types alone cannot be sold: every quote resolves through a rate plan, so
 * a property with types but no plan books nothing and reports no price. One
 * public plan is created if none exists.
 *
 * The calendar is then filled **per date from Beds24's own figures** rather than
 * flattened to one default. Beds24 is charging 23.00 on some nights and 60.00 on
 * others for the same room; collapsing that to a single number would quietly
 * undercut the property on its best dates.
 */
function seedRatePlan(
  propertyId: string,
  created: Array<{ rtId: string; name: string; externalId: string }>,
  dailyByRoom: Map<string, Map<string, number>>,
) {
  let plan = get<{ id: string }>(
    `SELECT id FROM rate_plans WHERE property_id = ? AND active = 1 AND parent_id IS NULL
      ORDER BY sort_order LIMIT 1`, propertyId);

  if (!plan) {
    const planId = id('rp');
    run(
      `INSERT INTO rate_plans(id, property_id, code, name, description, refundable, flexible,
                              kind, sort_order, active, created_at)
       VALUES(?,?,'STD','Standard Rate','Rates as held by Beds24',1,1,'public',0,1,?)`,
      planId, propertyId, nowIso());
    plan = { id: planId };
    ok('Standard Rate plan created');
  }

  let nights = 0;
  for (const c of created) {
    const base = Number(get<{ r: number }>(
      'SELECT default_rate_minor r FROM room_types WHERE id = ?', c.rtId)?.r ?? 0);
    run(
      `INSERT INTO rate_plan_room_types(rate_plan_id, room_type_id, base_rate_minor)
       VALUES(?,?,?) ON CONFLICT(rate_plan_id, room_type_id)
       DO UPDATE SET base_rate_minor = excluded.base_rate_minor`,
      plan.id, c.rtId, base);

    for (const [date, price] of dailyByRoom.get(c.externalId) ?? []) {
      run(
        `INSERT INTO rate_calendar(id, property_id, room_type_id, rate_plan_id, date,
                                   price_minor, updated_at, updated_by)
         VALUES(?,?,?,?,?,?,?,'beds24')
         ON CONFLICT(property_id, room_type_id, rate_plan_id, date)
         DO UPDATE SET price_minor = excluded.price_minor, updated_at = excluded.updated_at`,
        id('rc'), propertyId, c.rtId, plan.id, date, Math.round(price * 100), nowIso());
      nights++;
    }
  }
  ok(`${created.length} room type(s) on the plan · ${nights} priced night(s) from Beds24`);
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\n✗ ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exitCode = 1;
}
