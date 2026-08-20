// ─────────────────────────────────────────────────────────────
// Measures the hot paths against a property with years of history behind it.
//
//   node --experimental-sqlite scripts/bench.ts
//   node --experimental-sqlite scripts/bench.ts --years 5 --rooms 120
//   node --experimental-sqlite scripts/bench.ts --no-indexes   (the "before")
//
// The demo database has 66 reservations. Everything is fast at 66 reservations.
// The question this answers is whether it is still fast after three years of
// trading — which is when a missing index stops being theoretical and starts
// being a guest standing at the desk.
//
// It builds its own database in a temp directory and deletes it afterwards.
// The live database is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

const YEARS = arg('years', 3);
const ROOMS = arg('rooms', 60);
const DROP_INDEXES = process.argv.includes('--no-indexes');

const workdir = mkdtempSync(join(tmpdir(), 'helio-bench-'));
process.env.HELIO_DB = join(workdir, 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

const { migrate, run, get, all: allRows, exec, database, tx } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const availability = await import('../src/services/availability.ts');
const reservations = await import('../src/services/reservations.ts');
const reports = await import('../src/services/reports.ts');
const folio = await import('../src/services/folio.ts');
const housekeeping = await import('../src/services/housekeeping.ts');

function out(s: string) { process.stdout.write(s); }

const START = '2023-01-01';
const TODAY = addDays(START, YEARS * 365);

// ─── Build a property with history ───────────────────────────

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'mixed','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'BENCH', 'Benchmark Resort', TODAY, nowIso(),
  );

  const types = [
    { code: 'STD', name: 'Standard', kind: 'room', share: 0.45, rate: 12000 },
    { code: 'DLX', name: 'Deluxe', kind: 'room', share: 0.25, rate: 22000 },
    { code: 'FAM', name: 'Family', kind: 'room', share: 0.15, rate: 32000 },
    { code: 'DORM', name: 'Dorm', kind: 'dorm', share: 0.15, rate: 3500 },
  ];

  const roomTypeIds: string[] = [];
  const roomsByType = new Map<string, string[]>();
  let roomNumber = 100;

  for (const t of types) {
    const rtId = id('rt');
    roomTypeIds.push(rtId);
    run(
      `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                              max_adults, max_children, default_rate_minor, extra_adult_minor,
                              extra_child_minor, sort_order, active, created_at)
       VALUES(?,?,?,?,?,2,?,?,2,?,2000,1000,1,1,?)`,
      rtId, propertyId, t.code, t.name, t.kind,
      t.kind === 'dorm' ? 1 : 4, t.kind === 'dorm' ? 1 : 4, t.rate, nowIso(),
    );
    const count = Math.max(1, Math.round(ROOMS * t.share));
    const roomIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const rmId = id('rm');
      roomIds.push(rmId);
      run(
        `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
         VALUES(?,?,?,?,?,'Vacant Clean',1,?)`,
        rmId, propertyId, rtId, String(++roomNumber), Math.floor(roomNumber / 100), nowIso(),
      );
      if (t.kind === 'dorm') {
        for (let b = 1; b <= 8; b++) {
          run(
            `INSERT INTO beds(id, property_id, room_id, code, bunk, active)
             VALUES(?,?,?,?,?,1)`,
            id('bed'), propertyId, rmId, `${roomNumber}-${b}`, b % 2 ? 'bottom' : 'top',
          );
        }
      }
    }
    roomsByType.set(rtId, roomIds);
  }

  const ratePlanId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, kind, active, sort_order, created_at)
     VALUES(?,?,'BAR','Best Available','public',1,1,?)`,
    ratePlanId, propertyId, nowIso(),
  );
  for (const rtId of roomTypeIds) {
    run(
      `INSERT INTO rate_plan_room_types(rate_plan_id, room_type_id, base_rate_minor) VALUES(?,?,?)`,
      ratePlanId, rtId, 12000,
    );
  }

  // Rate calendar: one row per type per day for the whole period.
  const days = YEARS * 365 + 90;
  tx(() => {
    for (const rtId of roomTypeIds) {
      for (let d = 0; d < days; d++) {
        const date = addDays(START, d);
        const seasonal = 1 + 0.35 * Math.sin((d / 365) * Math.PI * 2);
        run(
          `INSERT INTO rate_calendar(id, property_id, room_type_id, rate_plan_id, date,
                                     price_minor, updated_at)
           VALUES(?,?,?,?,?,?,?)`,
          id('rc'), propertyId, rtId, ratePlanId, date,
          Math.round(12000 * seasonal), nowIso(),
        );
      }
    }
  });

  return { propertyId, roomTypeIds, roomsByType, ratePlanId };
}

/**
 * Deterministic pseudo-randomness — the benchmark has to compare like with
 * like across runs, and Math.random() would make every run a different shape.
 */
let seedState = 12345;
function rnd(): number {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}
function pick<T>(list: T[]): T { return list[Math.floor(rnd() * list.length)] ?? list[0]; }

function seedReservations(ctx: ReturnType<typeof seed>) {
  const { propertyId, roomTypeIds, roomsByType, ratePlanId } = ctx;
  const statuses = ['Checked-out', 'Checked-out', 'Checked-out', 'Cancelled', 'No-show'];
  const days = YEARS * 365;
  // Roughly 55% occupancy across the estate, which is a realistic mixed year.
  const perDay = Math.max(1, Math.round(ROOMS * 0.55 / 2.4));

  let made = 0;
  let nights = 0;
  let lines = 0;

  // One transaction per month keeps the WAL from exploding while still being
  // fast — 20,000 individual commits would take minutes and prove nothing.
  for (let d = 0; d < days; d += 30) {
    tx(() => {
      for (let offset = 0; offset < 30 && d + offset < days; offset++) {
        const arrival = addDays(START, d + offset);
        for (let n = 0; n < perDay; n++) {
          const rtId = pick(roomTypeIds);
          const roomId = pick(roomsByType.get(rtId) ?? []);
          const los = 1 + Math.floor(rnd() * 5);
          const departure = addDays(arrival, los);
          const resId = id('res');
          const profileId = id('pro');
          const past = arrival < TODAY;
          const status = past ? pick(statuses) : 'Confirmed';

          const guestName = `Guest ${made}`;
          run(
            `INSERT INTO profiles(id, property_id, name, email, phone, nationality, vip,
                                  created_at, updated_at)
             VALUES(?,?,?,?,?,'LK',0,?,?)`,
            profileId, propertyId, guestName, `guest${made}@bench.test`,
            `+9477${String(made).padStart(7, '0')}`, nowIso(), nowIso(),
          );

          const rate = 12000 + Math.floor(rnd() * 20000);
          run(
            `INSERT INTO reservations(id, property_id, confirmation, status, profile_id, guest_name,
                                      arrival, departure, nights, adults, children, room_type_id,
                                      room_id, rate_plan_id, source, total_minor,
                                      created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
            resId, propertyId, `BM${String(made).padStart(6, '0')}`, status, profileId, guestName,
            arrival, departure, los, 1 + Math.floor(rnd() * 2), rtId,
            roomId, ratePlanId, pick(['Direct', 'Booking.com', 'Expedia', 'Walk-in']),
            rate * los, nowIso(), nowIso(),
          );

          for (let k = 0; k < los; k++) {
            run(
              `INSERT INTO reservation_nights(id, reservation_id, property_id, date, room_type_id,
                                              room_id, rate_plan_id, rate_minor, adults, children, posted)
               VALUES(?,?,?,?,?,?,?,?,1,0,?)`,
              id('rn'), resId, propertyId, addDays(arrival, k), rtId, roomId,
              ratePlanId, rate, past ? 1 : 0,
            );
            nights++;
          }

          // Folio with room charges and a settlement, as a completed stay has.
          if (status === 'Checked-out') {
            const folioId = id('fol');
            run(
              `INSERT INTO folios(id, property_id, reservation_id, number, name, type,
                                  status, opened_at, closed_at)
               VALUES(?,?,?,?,?,'guest','closed',?,?)`,
              folioId, propertyId, resId, `F${made}`, guestName, nowIso(), nowIso(),
            );
            for (let k = 0; k < los; k++) {
              const chargeId = id('fl');
              run(
                `INSERT INTO folio_lines(id, property_id, folio_id, reservation_id, business_date,
                                         posted_at, kind, code, description, qty, unit_minor,
                                         amount_minor, voided, posted_by)
                 VALUES(?,?,?,?,?,?,'charge','ROOM','Room charge',1,?,?,0,'bench')`,
                chargeId, propertyId, folioId, resId, addDays(arrival, k), nowIso(), rate, rate,
              );
              // Every room charge carries its tax, pointing back at the charge
              // it taxes — that is what parent_line_id is for, and voiding the
              // charge has to find these.
              const tax = Math.round(rate * 0.15);
              run(
                `INSERT INTO folio_lines(id, property_id, folio_id, reservation_id, business_date,
                                         posted_at, kind, code, description, qty, unit_minor,
                                         amount_minor, parent_line_id, voided, posted_by)
                 VALUES(?,?,?,?,?,?,'tax','VAT','VAT 15%',1,?,?,?,0,'bench')`,
                id('fl'), propertyId, folioId, resId, addDays(arrival, k), nowIso(),
                tax, tax, chargeId,
              );
              lines += 2;
            }
            run(
              `INSERT INTO folio_lines(id, property_id, folio_id, reservation_id, business_date,
                                       posted_at, kind, code, description, qty, unit_minor,
                                       amount_minor, method, voided, posted_by)
               VALUES(?,?,?,?,?,?,'payment','CARD','Card payment',1,?,?,'Visa',0,'bench')`,
              id('fl'), propertyId, folioId, resId, departure, nowIso(),
              -rate * los, -rate * los,
            );
            lines++;
          }
          made++;
        }
      }
    });
  }
  return { made, nights, lines };
}

/**
 * Close every past day, the way a property that has been running its night
 * audit every evening for three years would have. Without this the reports
 * recompute history from the reservation nights on every call, which is a
 * state that only exists on day one.
 */
function closePastDays(propertyId: string) {
  const roomsTotal = Number(
    get<{ n: number }>('SELECT count(*) AS n FROM rooms WHERE property_id = ?', propertyId)!.n);
  let closed = 0;
  tx(() => {
    for (const r of allRows<{ date: string; sold: number; revenue: number }>(
      `SELECT n.date AS date, count(*) AS sold, COALESCE(SUM(n.rate_minor),0) AS revenue
         FROM reservation_nights n JOIN reservations r ON r.id = n.reservation_id
        WHERE n.property_id = ? AND n.date < ?
          AND r.status IN ('Checked-in','Checked-out')
        GROUP BY n.date`,
      propertyId, TODAY,
    )) {
      const occupancy = roomsTotal ? Math.round((r.sold / roomsTotal) * 10_000) : 0;
      run(
        `INSERT INTO daily_stats(id, property_id, date, rooms_total, rooms_ooo, rooms_sold,
                                 occupancy_bp, room_revenue_minor, other_revenue_minor, tax_minor,
                                 payments_minor, adr_minor, revpar_minor, arrivals, departures,
                                 no_shows, cancellations, in_house, created_at)
         VALUES(?,?,?,?,0,?,?,?,0,0,?,?,?,0,0,0,0,?,?)`,
        id('ds'), propertyId, r.date, roomsTotal, r.sold, occupancy, r.revenue,
        r.revenue, r.sold ? Math.round(r.revenue / r.sold) : 0,
        roomsTotal ? Math.round(r.revenue / roomsTotal) : 0, r.sold, nowIso(),
      );
      closed++;
    }
  });
  return closed;
}

// ─── Timing ──────────────────────────────────────────────────

interface Timing { name: string; p50: number; p95: number; max: number; runs: number }
const timings: Timing[] = [];

function time(name: string, runs: number, fn: () => unknown) {
  // One untimed pass so the statement cache and page cache are warm — this
  // measures steady state, not first-call cost.
  try { fn(); } catch (e) {
    out(`  ! ${name} threw: ${e instanceof Error ? e.message : e}\n`);
    return;
  }
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  timings.push({ name, p50: at(0.5), p95: at(0.95), max: samples[samples.length - 1], runs });
}

function report() {
  out(`\n${'─'.repeat(72)}\n`);
  out(`${'Operation'.padEnd(42)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}\n`);
  out(`${'─'.repeat(72)}\n`);
  for (const t of timings) {
    const flag = t.p95 > 200 ? ' ✗' : t.p95 > 50 ? ' ⚠' : '';
    out(`${t.name.padEnd(42)}${t.p50.toFixed(1).padStart(8)}ms${t.p95.toFixed(1).padStart(8)}ms`
      + `${t.max.toFixed(1).padStart(8)}ms${flag}\n`);
  }
  out(`${'─'.repeat(72)}\n`);
}

/**
 * Break the reservation list into its parts.
 *
 * The list is the slowest read in the system and the table above only says so
 * — it does not say which half is to blame. Guessing at that is how you end up
 * optimising the wrong one, so `--profile` measures the SQL and the shaping
 * separately.
 */
function profileReservationList(propertyId: string) {
  out(`\nWhere the reservation list spends its time\n${'─'.repeat(41)}\n`);

  const sql = `${reservations.RES_SELECT} WHERE r.property_id = ?
               ORDER BY r.arrival, r.guest_name LIMIT 50 OFFSET 0`;
  const bare = () => allRows<any>(sql, propertyId);

  const measure = (fn: () => unknown, runs = 30) => {
    fn();
    const s: number[] = [];
    for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); s.push(performance.now() - t); }
    s.sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const rows = bare();
  const sqlMs = measure(bare);
  const balancesMs = measure(() => reservations.reservationBalances(rows.map((r: any) => r.id)));
  const wholeMs = measure(() => reservations.listReservations(propertyId, { limit: 50 }));

  const plan = allRows<any>(`EXPLAIN QUERY PLAN ${sql}`, propertyId);

  out(`  the SELECT alone            ${sqlMs.toFixed(1).padStart(6)}ms\n`);
  out(`  balances for the page       ${balancesMs.toFixed(1).padStart(6)}ms\n`);
  out(`  shaping + everything else   ${(wholeMs - sqlMs - balancesMs).toFixed(1).padStart(6)}ms\n`);
  out(`  whole call                  ${wholeMs.toFixed(1).padStart(6)}ms\n\n`);
  for (const step of plan) out(`  ${step.detail}\n`);
}

// ─── Run ─────────────────────────────────────────────────────

async function main() {
  out(`\nHelio performance benchmark\n${'═'.repeat(27)}\n`);
  out(`${YEARS} years · ${ROOMS} rooms · indexes ${DROP_INDEXES ? 'DROPPED (the "before")' : 'as shipped'}\n`);
  out(`Building the database — this takes a minute…\n`);

  const buildStart = Date.now();
  migrate();
  const ctx = seed();
  const counts = seedReservations(ctx);
  const closedDays = closePastDays(ctx.propertyId);
  out(`  ${counts.made.toLocaleString()} reservations · ${counts.nights.toLocaleString()} nights · `
    + `${counts.lines.toLocaleString()} folio lines · ${closedDays.toLocaleString()} closed days `
    + `in ${((Date.now() - buildStart) / 1000).toFixed(1)}s\n`);

  if (DROP_INDEXES) {
    // The indexes added by the R1 query-plan review. Dropping them shows what
    // the same queries cost before that work.
    const added = [
      'ix_res_group', 'ix_res_rtype', 'ix_res_list', 'ix_resn_room', 'ix_resn_bed', 'ix_resn_res',
      'ix_folio_group', 'ix_lines_parent', 'ix_synclog_channel', 'ix_room_blocks_room',
      'ix_login_user',
    ];
    for (const ix of added) exec(`DROP INDEX IF EXISTS ${ix}`);
    out(`  dropped ${added.length} indexes\n`);
  }

  database.exec('ANALYZE');
  const pageCount = (database.prepare('PRAGMA page_count').get() as any).page_count;
  const pageSize = (database.prepare('PRAGMA page_size').get() as any).page_size;
  out(`  database is ${(pageCount * pageSize / 1024 / 1024).toFixed(1)} MB\n`);

  const { propertyId } = ctx;
  const week = addDays(TODAY, 7);
  const month = addDays(TODAY, 30);
  const yearAgo = addDays(TODAY, -365);

  out(`\nMeasuring (business date ${TODAY})\n`);

  time('Availability grid · 7 days', 30,
    () => availability.availabilityGrid(propertyId, TODAY, week));
  time('Availability grid · 30 days', 20,
    () => availability.availabilityGrid(propertyId, TODAY, month));
  time('Availability grid · 90 days', 10,
    () => availability.availabilityGrid(propertyId, TODAY, addDays(TODAY, 90)));
  time('Free rooms for a stay', 30,
    () => availability.freeRooms(propertyId, ctx.roomTypeIds[0], TODAY, addDays(TODAY, 2)));

  time('Reservation list · first page', 30,
    () => reservations.listReservations(propertyId, { limit: 50 }));
  time('Reservation list · by status', 30,
    () => reservations.listReservations(propertyId, { status: ['Confirmed'], limit: 50 }));
  time('Reservation search · by name', 20,
    () => reservations.listReservations(propertyId, { search: 'Guest 1', limit: 50 }));
  time('Reservation count (pagination)', 30,
    () => reservations.countReservations(propertyId, {}));

  const someRes = get<{ id: string }>(
    `SELECT id FROM reservations WHERE property_id = ? AND status = 'Checked-out' LIMIT 1`, propertyId)!;
  time('Reservation detail (with nights + folio)', 30,
    () => reservations.getReservationDetail(propertyId, someRes.id));

  const someFolio = get<{ id: string }>('SELECT id FROM folios LIMIT 1')!;
  time('Folio balance', 50, () => folio.folioBalance(someFolio.id));
  time('Folio lines', 50, () => folio.folioLines(someFolio.id));

  time('Front desk lists (arrivals/departures/in-house)', 20,
    () => reports.frontDeskLists(propertyId, TODAY));
  time('Dashboard snapshot', 20, () => reports.todaySnapshot(propertyId));
  time('KPI series · 30 days', 20, () => reports.kpiSeries(propertyId, addDays(TODAY, -30), TODAY));
  time('KPI series · 365 days', 10, () => reports.kpiSeries(propertyId, yearAgo, TODAY));
  time('Production report · 90 days by source', 10,
    () => reports.production(propertyId, addDays(TODAY, -90), TODAY, 'source'));
  time('Production report · 90 days by room type', 10,
    () => reports.production(propertyId, addDays(TODAY, -90), TODAY, 'room_type'));
  time('Revenue breakdown · 90 days', 10,
    () => reports.revenueBreakdown(propertyId, addDays(TODAY, -90), TODAY));
  time('Booking pace · 30 days ahead', 10,
    () => reports.bookingPace(propertyId, TODAY, month));

  time('Housekeeping room board', 20, () => housekeeping.roomBoard(propertyId, TODAY));
  time('Housekeeping forecast', 20, () => housekeeping.forecast(propertyId, TODAY));

  // Paths the R1 index review fixed. They are not the busiest screens, but
  // they are the ones that were scanning, and --no-indexes shows what they
  // cost before.
  const someRoom = get<{ id: string }>('SELECT id FROM rooms LIMIT 1')!;
  const someLine = get<{ id: string }>(`SELECT id FROM folio_lines WHERE kind = 'charge' LIMIT 1`)!;
  time('Guard: is this room type still in use?', 30,
    () => get('SELECT count(*) AS n FROM reservations WHERE room_type_id = ?', ctx.roomTypeIds[0]));
  time('Guard: has this room ever been slept in?', 30,
    () => get('SELECT count(*) AS n FROM reservation_nights WHERE room_id = ?', someRoom.id));
  time('Void: find lines derived from a charge', 30,
    () => get('SELECT id FROM folio_lines WHERE parent_line_id = ? AND voided = 0', someLine.id));

  report();

  if (process.argv.includes('--profile')) profileReservationList(propertyId);

  const slow = timings.filter((t) => t.p95 > 200);
  const warn = timings.filter((t) => t.p95 > 50 && t.p95 <= 200);
  out(`\n${counts.made.toLocaleString()} reservations · ${(pageCount * pageSize / 1024 / 1024).toFixed(1)} MB\n`);
  if (slow.length) {
    out(`\n✗ ${slow.length} operation(s) over 200ms — the desk would feel these:\n`);
    for (const t of slow) out(`    ${t.name} — p95 ${t.p95.toFixed(0)}ms\n`);
    process.exitCode = 1;
  } else if (warn.length) {
    out(`\n⚠ ${warn.length} operation(s) between 50 and 200ms. Usable, worth watching.\n`);
    for (const t of warn) out(`    ${t.name} — p95 ${t.p95.toFixed(0)}ms\n`);
  } else {
    out(`\n✓ Every operation answers in under 50ms at this size.\n`);
  }
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nBenchmark aborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { database.close(); } catch { /* already closed */ }
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
