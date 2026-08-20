// ─────────────────────────────────────────────────────────────
// End-to-end check: drives a complete business day through the real API.
//
//   1. bootstrap a property + admin
//   2. configure room types, rooms, taxes, rate plans, rates
//   3. quote and book, verifying availability and restriction gates
//   4. check in, post charges and a payment
//   5. run the night audit and verify the ledger balances
//   6. check out, invoice, and read the reports back
//
//   node --experimental-sqlite scripts/smoke.ts        (server must be running)
//
// Every assertion below is a business rule that must hold.
// ─────────────────────────────────────────────────────────────
const BASE = process.env.API ?? 'http://localhost:8080';

let token = '';
let propertyId = '';
let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  checks++;
  if (condition) {
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failures++;
    process.stdout.write(`  ✗ ${name}\n`);
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail)}\n`);
  }
}

function section(title: string) {
  process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
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
  const parsed = text ? JSON.parse(text) : null;
  return { status: res.status, body: parsed };
}

async function must(method: string, path: string, body?: unknown): Promise<any> {
  const r = await api(method, path, body);
  if (r.status >= 400) {
    throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.body)}`);
  }
  return r.body;
}

const money = (minor: number) => `${(minor / 100).toFixed(2)}`;

async function main() {
  const health = await must('GET', '/health');
  process.stdout.write(`API: ${BASE} · setupRequired=${health.setupRequired}\n`);

  // ── 1. Bootstrap ────────────────────────────────────────────
  section('1 · Setup');
  const stamp = Date.now().toString(36).toUpperCase().slice(-5);
  let boot = await api('POST', '/api/setup/bootstrap', {
    property: {
      code: `SMOKE${stamp}`, name: 'Smoke Test Hotel', city: 'Colombo', country: 'LK',
      currency: 'USD', timezone: 'Asia/Colombo', businessDate: '2026-06-01', kind: 'mixed',
    },
    admin: { name: 'Smoke Admin', email: `smoke${stamp}@helio.test`, password: 'smoke12345' },
  });

  if (boot.status === 409) {
    // Already set up — sign in with the seeded admin instead.
    const email = process.env.SMOKE_EMAIL;
    const password = process.env.SMOKE_PASSWORD;
    if (!email || !password) {
      process.stdout.write(
        '  ! Installation already set up. Re-run against a clean database, or set '
        + 'SMOKE_EMAIL / SMOKE_PASSWORD to sign in.\n');
      // Set the code and unwind rather than calling process.exit() — exiting
      // with an in-flight socket trips a libuv assertion on Windows, which
      // buries this message under a crash dump.
      process.exitCode = 1;
      return;
    }
    const login = await must('POST', '/api/auth/login', { email, password });
    token = login.token;
    propertyId = login.property?.id ?? login.properties[0].id;
  } else if (boot.status >= 400) {
    throw new Error(`bootstrap failed: ${JSON.stringify(boot.body)}`);
  } else {
    token = boot.body.token;
    propertyId = boot.body.property.id;
    check('bootstrap returns a session token', !!token);
    check('bootstrap creates the property', !!propertyId);
  }

  const me = await must('GET', '/api/auth/me');
  check('admin has full permissions', me.user.permissions.includes('*'));

  const secondBoot = await api('POST', '/api/setup/bootstrap', {
    property: { code: 'X2', name: 'X', currency: 'USD' },
    admin: { name: 'X', email: 'x@x.test', password: 'password1' },
  });
  check('bootstrap cannot run twice', secondBoot.status === 409);

  const weakPw = await api('POST', '/api/users', {
    name: 'Weak', email: `weak${stamp}@helio.test`, role: 'front_office', password: 'short',
  });
  check('weak passwords are rejected', weakPw.status === 400, weakPw.body);

  // ── 2. Configuration ────────────────────────────────────────
  section('2 · Configuration');
  const deluxe = await must('POST', '/api/room-types', {
    code: 'DLX', name: 'Deluxe King', kind: 'room',
    baseOccupancy: 2, maxOccupancy: 3, maxAdults: 3, maxChildren: 2,
    defaultRateMinor: 20000, extraAdultMinor: 3000, extraChildMinor: 1500,
  });
  const dorm = await must('POST', '/api/room-types', {
    code: 'DORM6', name: '6-bed Mixed Dorm', kind: 'dorm',
    baseOccupancy: 1, maxOccupancy: 1, maxAdults: 1, defaultRateMinor: 3500,
    genderPolicy: 'mixed',
  });
  check('room types created', !!deluxe.id && !!dorm.id);

  const bulk = await must('POST', '/api/rooms/bulk', {
    roomTypeId: deluxe.id, floorFrom: 1, floorTo: 2, roomsPerFloor: 3, startAt: 1, pad: 2,
  });
  check('bulk room creation made 6 rooms', bulk.created.length === 6, bulk);

  await must('POST', '/api/rooms', { roomTypeId: dorm.id, number: 'D1', floor: 0, bedCount: 6 });
  const beds = await must('GET', '/api/beds');
  check('dorm room auto-created 6 sellable beds', beds.length === 6, beds.length);

  // Service charge and VAT apply to everything; city tax only to rooms.
  await must('POST', '/api/taxes', { code: 'SVC', name: 'Service charge', mode: 'percent', value: 1000, appliesTo: 'all', sortOrder: 1 });
  await must('POST', '/api/taxes', { code: 'VAT', name: 'VAT', mode: 'percent', value: 800, appliesTo: 'all', sortOrder: 2 });
  await must('POST', '/api/taxes', { code: 'CITY', name: 'City tax', mode: 'per_person_night', value: 200, appliesTo: 'room', sortOrder: 3 });

  const bar = await must('POST', '/api/rate-plans', {
    code: 'BAR', name: 'Best Available Rate',
    roomTypes: [
      { roomTypeId: deluxe.id, baseRateMinor: 20000 },
      { roomTypeId: dorm.id, baseRateMinor: 3500 },
    ],
  });
  const nref = await must('POST', '/api/rate-plans', {
    code: 'NREF', name: 'Non-refundable', parentId: bar.id,
    offsetType: 'percent', offsetValue: -1000, refundable: false,
  });
  check('derived rate plan created', nref.parentId === bar.id);

  await must('POST', '/api/rates/bulk', {
    from: '2026-06-01', to: '2026-06-30', roomTypeIds: [deluxe.id], ratePlanIds: [bar.id],
    priceMinor: 25000,
  });
  await must('POST', '/api/rates/bulk', {
    from: '2026-06-01', to: '2026-06-30', roomTypeIds: [deluxe.id], ratePlanIds: [bar.id],
    priceMinor: 32000, daysOfWeek: ['fri', 'sat'],
  });

  const cal = await must('GET',
    `/api/rates/calendar?from=2026-06-01&to=2026-06-08&roomTypeId=${deluxe.id}&ratePlanId=${bar.id}`);
  const monday = cal.rows[0].cells.find((c: any) => c.date === '2026-06-01');
  const friday = cal.rows[0].cells.find((c: any) => c.date === '2026-06-05');
  check('weekday rate is 250.00', monday.priceMinor === 25000, monday);
  check('weekend override is 320.00', friday.priceMinor === 32000, friday);
  check('availability shows all 6 deluxe rooms', monday.available === 6, monday);

  const nrefCal = await must('GET',
    `/api/rates/calendar?from=2026-06-01&to=2026-06-02&roomTypeId=${deluxe.id}&ratePlanId=${nref.id}`);
  check('derived rate is parent −10% (225.00)',
    nrefCal.rows[0].cells[0].priceMinor === 22500, nrefCal.rows[0].cells[0]);

  // ── 3. Quote, restrictions, booking ─────────────────────────
  section('3 · Quote & restrictions');
  const quote = await must('POST', '/api/rates/quote', {
    arrival: '2026-06-01', departure: '2026-06-04', adults: 2, children: 0,
    roomTypeId: deluxe.id, ratePlanId: bar.id,
  });
  const opt = quote.options[0];
  check('3-night quote = 250+250+250 = 750.00', opt.roomTotalMinor === 75000, opt.roomTotalMinor);
  // 10% service on 750 = 75; VAT 8% on 825 = 66; city tax 2.00 × 3 nights × 2 people = 12
  check('compound tax computed correctly (153.00)', opt.taxTotalMinor === 15300, opt.taxes);
  check('grand total 903.00', opt.grandTotalMinor === 90300, opt.grandTotalMinor);
  check('stay is sellable', opt.sellable === true, opt.violations);

  const occQuote = await must('POST', '/api/rates/quote', {
    arrival: '2026-06-01', departure: '2026-06-02', adults: 3, children: 0,
    roomTypeId: deluxe.id, ratePlanId: bar.id,
  });
  check('third adult adds the 30.00 supplement',
    occQuote.options[0].roomTotalMinor === 28000, occQuote.options[0].roomTotalMinor);

  const minStay = await must('POST', '/api/restrictions', {
    roomTypeId: deluxe.id, dateFrom: '2026-06-10', dateTo: '2026-06-12',
    type: 'min-stay', value: 3,
  });
  const shortStay = await api('POST', '/api/reservations', {
    guestName: 'Too Short', arrival: '2026-06-10', departure: '2026-06-11',
    adults: 2, children: 0, roomTypeId: deluxe.id, ratePlanId: bar.id,
  });
  check('min-stay restriction blocks a 1-night booking', shortStay.status === 409, shortStay.body);
  check('violation explains why',
    shortStay.body?.details?.violations?.[0]?.message?.includes('Minimum stay'),
    shortStay.body?.details);
  await must('DELETE', `/api/restrictions/${minStay.id}`);

  section('4 · Booking');
  const res1 = await must('POST', '/api/reservations', {
    guestName: 'Amara Perera', email: 'amara@example.test', phone: '+94 77 000 0000',
    arrival: '2026-06-01', departure: '2026-06-04', adults: 2, children: 0,
    roomTypeId: deluxe.id, ratePlanId: bar.id, source: 'Direct', segment: 'Leisure',
    eta: '15:00',
  });
  check('reservation gets a confirmation number', /-\d{4}-\d{5}$/.test(res1.confirmation), res1.confirmation);
  check('reservation totals match the quote', res1.totalMinor === 75000, res1.totalMinor);
  check('reservation has one row per night', res1.nightRows.length === 3, res1.nightRows.length);
  check('night count and night rows agree', res1.nights === res1.nightRows.length, res1.nights);
  check('a folio opened automatically', res1.folios.length === 1, res1.folios);

  const availAfter = await must('GET',
    `/api/availability?from=2026-06-01&to=2026-06-02`);
  const cell = availAfter.cells.find((c: any) => c.roomTypeId === deluxe.id);
  check('availability dropped to 5 after booking', cell.available === 5, cell);

  // Fill the house, then prove the 7th booking is refused.
  for (let i = 0; i < 5; i++) {
    await must('POST', '/api/reservations', {
      guestName: `Filler ${i + 1}`, arrival: '2026-06-01', departure: '2026-06-02',
      adults: 1, children: 0, roomTypeId: deluxe.id, ratePlanId: bar.id,
    });
  }
  const oversell = await api('POST', '/api/reservations', {
    guestName: 'One Too Many', arrival: '2026-06-01', departure: '2026-06-02',
    adults: 1, children: 0, roomTypeId: deluxe.id, ratePlanId: bar.id,
  });
  check('booking past capacity is refused', oversell.status === 409, oversell.body);

  const forced = await api('POST', '/api/reservations', {
    guestName: 'Deliberate Oversell', arrival: '2026-06-01', departure: '2026-06-02',
    adults: 1, children: 0, roomTypeId: deluxe.id, ratePlanId: bar.id, force: true,
  });
  check('a manager can deliberately oversell', forced.status === 200, forced.body);
  await must('POST', `/api/reservations/${forced.body.id}/cancel`, { reason: 'smoke cleanup' });

  const overOcc = await api('POST', '/api/reservations', {
    guestName: 'Too Many Guests', arrival: '2026-06-20', departure: '2026-06-21',
    adults: 6, children: 0, roomTypeId: deluxe.id, ratePlanId: bar.id,
  });
  check('over-occupancy is refused', overOcc.status === 400, overOcc.body);

  // ── 5. Front desk ───────────────────────────────────────────
  section('5 · Front desk');
  const frontDesk = await must('GET', '/api/front-desk');
  check('arrivals list shows today\'s bookings', frontDesk.arrivals.length === 6, frontDesk.arrivals.length);

  const earlyCheckIn = await api('POST', `/api/reservations/${res1.id}/check-in`, {});
  check('check-in auto-assigns a room', earlyCheckIn.status === 200, earlyCheckIn.body);
  const checkedIn = earlyCheckIn.body;
  check('reservation is now in-house', checkedIn.status === 'Checked-in');
  check('a room number was assigned', !!checkedIn.room, checkedIn.room);

  const board = await must('GET', '/api/housekeeping/board');
  const occupiedRoom = board.rooms.find((r: any) => r.number === checkedIn.room);
  check('room shows as occupied on the housekeeping board',
    occupiedRoom.status.startsWith('Occupied') && occupiedRoom.occupied === true, occupiedRoom);
  check('no housekeeping discrepancies', board.rooms.filter((r: any) => r.discrepancy).length === 0);

  const badStatus = await api('POST', `/api/rooms/${occupiedRoom.id}/status`, { status: 'Vacant Clean' });
  check('an occupied room cannot be marked vacant', badStatus.status === 409, badStatus.body);

  // ── 6. Cashiering ───────────────────────────────────────────
  section('6 · Cashiering');
  const folioId = checkedIn.folios[0].id;
  const charge = await must('POST', `/api/folios/${folioId}/charges`, {
    code: 'FNB', description: 'Dinner — restaurant', unitMinor: 4500, qty: 2,
  });
  check('charge posts 90.00', charge.amountMinor === 9000, charge.amountMinor);
  check('tax lines posted with the charge', charge.taxLineIds.length > 0, charge.taxLineIds);
  // 10% service on 90 = 9; VAT 8% on 99 = 7.92 → 8 (rounded)
  check('F&B tax is 16.92', charge.taxMinor === 1692, charge.taxMinor);

  await must('POST', `/api/folios/${folioId}/payments`, {
    method: 'Visa', amountMinor: 10000, reference: 'auth 4421',
  });
  const folio = await must('GET', `/api/folios/${folioId}`);
  check('folio balance = charges + tax − payment',
    folio.balanceMinor === 9000 + 1692 - 10000, folio.balanceMinor);

  const voidRes = await must('POST', `/api/folio-lines/${charge.lineId}/void`, { reason: 'wrong folio' });
  check('voiding a charge also voids its tax lines', voidRes.voided === 3, voidRes);
  const afterVoid = await must('GET', `/api/folios/${folioId}`);
  check('a void reverses the money exactly once',
    afterVoid.balanceMinor === -10000, afterVoid.balanceMinor);
  check('voided lines stay visible in the ledger',
    afterVoid.lines.filter((l: any) => l.voided).length === 3,
    afterVoid.lines.length);

  const badCheckout = await api('POST', `/api/reservations/${res1.id}/check-out`, {});
  check('check-out is blocked while the folio is unbalanced',
    badCheckout.status === 409, badCheckout.body?.code);

  // ── 7. Night audit ──────────────────────────────────────────
  section('7 · Night audit');
  const pre = await must('GET', '/api/night-audit/preflight');
  check('preflight sees 5 arrivals that never checked in',
    pre.issues.find((i: any) => i.kind === 'pending-arrival')?.count === 5, pre.issues);
  check('preflight allows the run', pre.canRun === true, pre.issues);

  const auditRun = await must('POST', '/api/night-audit/run', {});
  check('business date rolled to 2026-06-02', auditRun.newBusinessDate === '2026-06-02', auditRun.newBusinessDate);
  check('one room charge posted (only one guest in-house)',
    auditRun.roomChargesPosted === 1, auditRun.roomChargesPosted);
  check('room revenue posted = 250.00', auditRun.roomRevenueMinor === 25000, auditRun.roomRevenueMinor);
  check('no-shows were processed', auditRun.noShows === 5, auditRun.noShows);
  // A no-show releases the room, so only the one occupied room counts as sold:
  // 1 of 12 sellable units (6 deluxe rooms + 6 dorm beds) = 8.33%.
  check('statistics count only genuinely occupied rooms',
    auditRun.stats.rooms_sold === 1 && auditRun.stats.occupancy_bp === 833, auditRun.stats);
  check('no-show charges are recorded as other revenue',
    auditRun.stats.other_revenue_minor === 125000, auditRun.stats.other_revenue_minor);

  const folioAfterAudit = await must('GET', `/api/folios/${folioId}`);
  const roomLine = folioAfterAudit.lines.find((l: any) => l.code === 'ROOM');
  check('room charge landed on the guest folio', !!roomLine, folioAfterAudit.lines.map((l: any) => l.code));
  check('room charge carries its own tax lines',
    folioAfterAudit.lines.filter((l: any) => l.parentLineId === roomLine.id).length === 3);

  // Running the audit again rolls the *next* day (catching up after downtime)
  // and must never post the already-closed day a second time.
  const rerun = await must('POST', '/api/night-audit/run', {});
  check('a second run advances to the next day', rerun.newBusinessDate === '2026-06-03', rerun.newBusinessDate);
  const folioAfterSecond = await must('GET', `/api/folios/${folioId}`);
  const june1Charges = folioAfterSecond.lines
    .filter((l: any) => l.code === 'ROOM' && l.businessDate === '2026-06-01' && !l.voided);
  check('the closed day was not posted twice', june1Charges.length === 1, june1Charges.length);
  const history = await must('GET', '/api/night-audit/history');
  check('both audit runs are recorded', history.filter((h: any) => h.status === 'completed').length === 2,
    history.map((h: any) => h.businessDate));

  // ── 8. Departure ────────────────────────────────────────────
  section('8 · Departure');
  const dueFolio = await must('GET', `/api/folios/${folioId}`);
  const balanceDue = dueFolio.balanceMinor;
  check('two nights and their taxes are owed', balanceDue > 50000, balanceDue);
  await must('POST', `/api/folios/${folioId}/payments`, { method: 'Cash', amountMinor: balanceDue });

  const out = await must('POST', `/api/reservations/${res1.id}/check-out`, {});
  check('guest checked out', out.status === 'Checked-out', out.status);
  // Booked 1→4 June, departing on the 3rd: the unstayed night is dropped.
  check('early departure shortened the 3-night stay to 2', out.nights === 2, out.nightRows);
  check('departure date moved to the actual departure', out.departure === '2026-06-03', out.departure);

  const boardAfter = await must('GET', '/api/housekeeping/board');
  const vacated = boardAfter.rooms.find((r: any) => r.number === checkedIn.room);
  check('vacated room is dirty and awaiting a clean', vacated.status === 'Vacant Dirty', vacated.status);
  check('a departure clean was queued', vacated.task?.type === 'departure', vacated.task);

  const finalFolio = await must('GET', `/api/folios/${folioId}`);
  check('folio settled to zero', finalFolio.balanceMinor === 0, finalFolio.balanceMinor);
  check('folio closed on check-out', finalFolio.status === 'closed', finalFolio.status);

  const invoice = await must('POST', `/api/folios/${folioId}/invoice`, { billTo: 'Amara Perera' });
  check('invoice issued', /^INV-/.test(invoice.number), invoice.number);
  check('invoice total = net + tax',
    invoice.total_minor === invoice.net_minor + invoice.tax_minor, invoice);

  // ── 9. Reporting ────────────────────────────────────────────
  section('9 · Reporting');
  const stats = await must('GET', '/api/reports/daily-stats?from=2026-06-01&to=2026-06-01');
  check('closed day is in the statistics table', stats.length === 1, stats);
  check('ADR = room revenue ÷ rooms sold',
    stats[0].adrMinor === Math.round(stats[0].roomRevenueMinor / stats[0].roomsSold), stats[0]);
  check('RevPAR = room revenue ÷ available rooms',
    stats[0].revparMinor === Math.round(stats[0].roomRevenueMinor / (stats[0].roomsTotal - stats[0].roomsOoo)),
    stats[0]);

  const dash = await must('GET', '/api/dashboard');
  check('dashboard reads the current business date after two audits',
    dash.businessDate === '2026-06-03', dash.businessDate);
  check('dashboard counts no one still in-house', dash.snapshot.inHouse === 0, dash.snapshot.inHouse);

  const prod = await must('GET', '/api/reports/production?from=2026-06-01&to=2026-06-05&dimension=source');
  check('production report attributes revenue by source', prod.rows.length > 0, prod.rows);

  const audit = await must('GET', '/api/audit-log?limit=500');
  check('every operation was recorded in the audit trail', audit.length > 20, audit.length);
  check('elevated actions are flagged', audit.some((a: any) => a.elevated === true));

  // ── 10. Access control ──────────────────────────────────────
  section('10 · Access control');
  await must('POST', '/api/users', {
    name: 'Housekeeper', email: `hk${stamp}@helio.test`, role: 'housekeeping',
    password: 'cleaning123', mustChangePassword: false,
  });
  const hkLogin = await must('POST', '/api/auth/login',
    { email: `hk${stamp}@helio.test`, password: 'cleaning123' });
  const adminToken = token;
  token = hkLogin.token;
  const denied = await api('POST', '/api/rates/bulk', {
    from: '2026-06-01', to: '2026-06-02', priceMinor: 1,
  });
  check('housekeeping cannot change rates', denied.status === 403, denied.body);
  const allowed = await api('GET', '/api/housekeeping/board');
  check('housekeeping can read its own board', allowed.status === 200);
  token = adminToken;

  const noAuth = await fetch(`${BASE}/api/reservations`, { headers: { 'x-property-id': propertyId } });
  check('unauthenticated requests are rejected', noAuth.status === 401, noAuth.status);

  // ── 11. Channel manager honesty ─────────────────────────────
  section('11 · Channel manager');
  const channel = await must('POST', '/api/channels', {
    code: 'BDC', name: 'Booking.com', kind: 'ota', active: true,
    commissionBp: 1800, priceMultiplierBp: 10000,
  });
  check('new channel starts not-configured', channel.status === 'not-configured', channel.status);
  const pushWithoutCreds = await api('POST', `/api/channels/${channel.id}/push`, {});
  check('pushing without credentials fails loudly, not silently',
    pushWithoutCreds.status >= 400, pushWithoutCreds.body);
  const log = await must('GET', '/api/channels/sync-log');
  check('the failed attempt is in the sync log',
    log.length > 0 && log[0].status !== 'success', log[0]);

  const ari = await must('GET',
    `/api/channels/ari?from=2026-06-02&to=2026-06-05&roomTypeId=${deluxe.id}&ratePlanId=${bar.id}`);
  check('ARI resolves availability and price per date', ari.cells.length === 3, ari.cells.length);
  check('ARI price matches the rate calendar', ari.cells[0].priceMinor === 25000, ari.cells[0]);

  // ── Summary ─────────────────────────────────────────────────
  section('Result');
  process.stdout.write(`${checks - failures}/${checks} checks passed\n`);
  if (failures > 0) {
    process.stdout.write(`${failures} FAILED\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('All business rules verified.\n');
}

main().catch((e) => {
  process.stderr.write(`\nSmoke test aborted: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
