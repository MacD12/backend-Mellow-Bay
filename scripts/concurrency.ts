// ─────────────────────────────────────────────────────────────
// Proves the system cannot be made to overbook by concurrent requests.
//
//   SMOKE_EMAIL=… SMOKE_PASSWORD=… node --experimental-sqlite scripts/concurrency.ts
//
// The classic failure in a booking system is check-then-act: two requests both
// read "1 room left", both pass the availability gate, both insert. This fires
// a burst of simultaneous bookings at the last remaining room and asserts that
// exactly one wins.
//
// It cleans up after itself: everything it books is cancelled at the end.
// ─────────────────────────────────────────────────────────────
const BASE = process.env.API ?? 'http://localhost:8080';

let token = '';
let propertyId = '';
let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}\n`);
  if (!ok) {
    failures++;
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 300)}\n`);
  }
}
function section(t: string) { process.stdout.write(`\n${t}\n${'─'.repeat(t.length)}\n`); }

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(propertyId ? { 'x-property-id': propertyId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  if (!email || !password) {
    process.stderr.write('Set SMOKE_EMAIL / SMOKE_PASSWORD\n');
    process.exitCode = 1;
    return;
  }
  const login = await api('POST', '/api/auth/login', { email, password });
  if (!login.body?.token) {
    process.stderr.write(`Sign-in failed: ${JSON.stringify(login.body)}\n`);
    process.exitCode = 1;
    return;
  }
  token = login.body.token;
  const property = login.body.property ?? login.body.properties[0];
  propertyId = property.id;

  // Book far enough ahead that the demo's own reservations are not in the way.
  const arrival = addDays(property.businessDate, 120);
  const departure = addDays(arrival, 1);

  const roomTypes = (await api('GET', '/api/room-types')).body;
  const ratePlans = (await api('GET', '/api/rate-plans')).body;
  // A private room type gives the tightest test — every unit is exclusive.
  const roomType = roomTypes.find((r: any) => r.kind === 'room' && r.rooms > 0);
  const ratePlan = ratePlans.find((r: any) => r.active);
  if (!roomType || !ratePlan) {
    process.stderr.write('Needs at least one private room type and an active rate plan\n');
    process.exitCode = 1;
    return;
  }

  const grid = await api('GET', `/api/availability?from=${arrival}&to=${departure}`);
  const cell = grid.body.cells.find((c: any) => c.roomTypeId === roomType.id);
  const capacity: number = cell.available;

  section(`Racing the last ${roomType.name}`);
  process.stdout.write(
    `  ${capacity} available on ${arrival} · filling to leave exactly one\n\n`);

  const created: string[] = [];

  // Fill everything but the last unit, one at a time.
  for (let i = 0; i < capacity - 1; i++) {
    const res = await api('POST', '/api/reservations', {
      guestName: `Filler ${i + 1}`, arrival, departure, adults: 1, children: 0,
      roomTypeId: roomType.id, ratePlanId: ratePlan.id, source: 'Direct',
    });
    if (res.status === 200) created.push(res.body.id);
  }

  const before = await api('GET', `/api/availability?from=${arrival}&to=${departure}`);
  const left = before.body.cells.find((c: any) => c.roomTypeId === roomType.id).available;
  check('exactly one unit is left before the race', left === 1, { left });

  // Fire a burst at the single remaining unit, all in flight together.
  const CONTENDERS = 12;
  const results = await Promise.all(
    Array.from({ length: CONTENDERS }, (_, i) =>
      api('POST', '/api/reservations', {
        guestName: `Racer ${i + 1}`, arrival, departure, adults: 1, children: 0,
        roomTypeId: roomType.id, ratePlanId: ratePlan.id, source: 'Direct',
      })),
  );

  const won = results.filter((r) => r.status === 200);
  const refused = results.filter((r) => r.status === 409);
  const other = results.filter((r) => r.status !== 200 && r.status !== 409);
  won.forEach((r) => created.push(r.body.id));

  process.stdout.write(
    `  ${CONTENDERS} simultaneous requests → ${won.length} booked, `
    + `${refused.length} refused, ${other.length} other\n\n`);

  check('exactly one request wins the last unit', won.length === 1,
    { won: won.length, refused: refused.length });
  check('every loser is told the room is unavailable, not an error',
    other.length === 0, other.map((r) => ({ status: r.status, body: r.body })));
  check('losers get a 409 with the sold-out dates',
    refused.every((r) => Array.isArray(r.body?.details?.shortfall)),
    refused[0]?.body);

  const after = await api('GET', `/api/availability?from=${arrival}&to=${departure}`);
  const cellAfter = after.body.cells.find((c: any) => c.roomTypeId === roomType.id);
  check('availability lands on exactly zero — never negative',
    cellAfter.available === 0, cellAfter);
  check('rooms sold never exceeds physical inventory',
    cellAfter.sold <= cellAfter.physical - cellAfter.blocked, cellAfter);

  // The ledger itself must agree — one night row per unit, no duplicates.
  const inventory = await api('GET',
    `/api/reservations?arrivalOn=${arrival}&status=Confirmed,Guaranteed,Tentative`);
  const forType = inventory.body.filter((r: any) => r.roomTypeId === roomType.id);
  check('reservation count matches the physical unit count',
    forType.length === cellAfter.physical - cellAfter.blocked,
    { reservations: forType.length, units: cellAfter.physical - cellAfter.blocked });

  section('Concurrent postings');
  // Money is the other place a race would show: many payments at once must sum
  // exactly, with no lost update.
  const target = created[0];
  if (target) {
    const detail = await api('GET', `/api/reservations/${target}`);
    const folioId = detail.body.folios[0].id;
    const PAYMENTS = 20;
    const AMOUNT = 137;   // an awkward number, so rounding errors would show
    await Promise.all(Array.from({ length: PAYMENTS }, (_, i) =>
      api('POST', `/api/folios/${folioId}/payments`,
        { amountMinor: AMOUNT, method: 'Cash', reference: `race ${i}` })));

    const folio = await api('GET', `/api/folios/${folioId}`);
    const paid = folio.body.paymentsMinor;
    check(`${PAYMENTS} simultaneous payments all land`, paid === -(PAYMENTS * AMOUNT),
      { expected: -(PAYMENTS * AMOUNT), actual: paid });

    const lineSum = folio.body.lines
      .filter((l: any) => !l.voided)
      .reduce((s: number, l: any) => s + l.amountMinor, 0);
    check('the balance still equals the sum of its lines',
      lineSum === folio.body.balanceMinor, { lineSum, balance: folio.body.balanceMinor });
  }

  // Put the property back as we found it.
  section('Cleanup');
  let removed = 0;
  for (const id of created) {
    const r = await api('POST', `/api/reservations/${id}/cancel`, { reason: 'concurrency test' });
    if (r.status === 200) removed++;
  }
  check('every test booking was cancelled', removed === created.length,
    { removed, created: created.length });

  const final = await api('GET', `/api/availability?from=${arrival}&to=${departure}`);
  const finalCell = final.body.cells.find((c: any) => c.roomTypeId === roomType.id);
  check('availability returns to where it started', finalCell.available === capacity,
    { before: capacity, after: finalCell.available });

  process.stdout.write(`\n${checks - failures}/${checks} concurrency checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('No overbooking and no lost updates under concurrent load.\n');
}

main().catch((e) => {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
