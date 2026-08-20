// Verifies that every endpoint the UI screens depend on answers with usable
// data after a real business day has been run through the API.
//
//   node --experimental-sqlite scripts/screens.ts     (after scripts/smoke.ts)
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

async function api(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(propertyId ? { 'x-property-id': propertyId } : {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  if (!email || !password) {
    process.stderr.write('Set SMOKE_EMAIL and SMOKE_PASSWORD to the admin created by scripts/smoke.ts\n');
    // Unwind rather than process.exit() — exiting with an in-flight socket
    // trips a libuv assertion on Windows that buries this message.
    process.exitCode = 1;
    return;
  }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session: any = await login.json();
  if (!session.token) {
    process.stderr.write(`Sign-in failed: ${JSON.stringify(session)}\n`);
    process.exitCode = 1;
    return;
  }
  token = session.token;
  propertyId = session.property?.id ?? session.properties[0].id;
  const businessDate = session.property?.businessDate ?? session.properties[0].businessDate;

  process.stdout.write(`\nScreen data checks · business date ${businessDate}\n${'─'.repeat(46)}\n`);

  // Each entry is: screen, endpoint, and what must be true for the screen to render.
  const cases: [string, string, (b: any) => boolean][] = [
    ['Dashboard', '/api/dashboard',
      (b) => typeof b.snapshot?.occupancyBp === 'number' && Array.isArray(b.forecast7) && b.forecast7.length === 7],
    ['Arrivals / In-house / Departures', '/api/front-desk',
      (b) => Array.isArray(b.arrivals) && Array.isArray(b.inHouse) && Array.isArray(b.departures)],
    ['Reservations list', '/api/reservations?limit=50',
      (b) => Array.isArray(b) && b.length > 0 && typeof b[0].balanceMinor === 'number'],
    ['Calendar tape chart', `/api/calendar/tape?from=${businessDate}&to=${addDays(businessDate, 14)}`,
      (b) => Array.isArray(b.rooms) && Array.isArray(b.dates) && b.dates.length === 14 && Array.isArray(b.availability)],
    ['Rate calendar', `/api/rates/calendar?from=${businessDate}&to=${addDays(businessDate, 7)}`,
      (b) => Array.isArray(b.rows) && b.rows.length > 0 && b.rows[0].cells.length === 7],
    ['Rate plans', '/api/rate-plans', (b) => Array.isArray(b) && b.length > 0],
    ['Restrictions', '/api/restrictions', (b) => Array.isArray(b)],
    ['Yield rules', '/api/yield-rules', (b) => Array.isArray(b)],
    ['Promotions', '/api/promotions', (b) => Array.isArray(b)],
    ['Availability grid', `/api/availability?from=${businessDate}&to=${addDays(businessDate, 7)}`,
      (b) => Array.isArray(b.cells) && b.cells.length > 0],
    ['Housekeeping board', '/api/housekeeping/board',
      (b) => Array.isArray(b.rooms) && b.rooms.length > 0 && Array.isArray(b.statuses)],
    ['Housekeeping tasks', '/api/housekeeping/tasks', (b) => Array.isArray(b)],
    ['Housekeeping forecast', '/api/housekeeping/forecast', (b) => typeof b.totalCredits === 'number'],
    ['Work orders', '/api/work-orders', (b) => Array.isArray(b)],
    ['Room blocks', '/api/room-blocks', (b) => Array.isArray(b)],
    ['Lost & found', '/api/lost-found', (b) => Array.isArray(b)],
    ['Cashier folio list', '/api/folios', (b) => Array.isArray(b) && b.length > 0],
    ['Cashier shift', '/api/cashier/shift', (b) => typeof b.open === 'boolean'],
    ['Outstanding balances', '/api/reports/outstanding', (b) => Array.isArray(b)],
    ['Invoices', '/api/invoices', (b) => Array.isArray(b) && b.length > 0],
    ['Companies', '/api/companies', (b) => Array.isArray(b)],
    ['Accounts receivable', '/api/ar', (b) => Array.isArray(b)],
    ['Night audit preflight', '/api/night-audit/preflight',
      (b) => typeof b.canRun === 'boolean' && Array.isArray(b.issues)],
    ['Night audit history', '/api/night-audit/history', (b) => Array.isArray(b) && b.length > 0],
    ['Night audit report', '/api/night-audit/report', (b) => !!b.stats && Array.isArray(b.revenueByCode)],
    ['Profiles', '/api/profiles', (b) => Array.isArray(b) && b.length > 0],
    ['Reports · KPIs', `/api/reports/kpis?from=${addDays(businessDate, -7)}&to=${businessDate}`,
      (b) => Array.isArray(b.series) && typeof b.occupancyBp === 'number'],
    ['Reports · production', `/api/reports/production?from=${addDays(businessDate, -7)}&to=${businessDate}&dimension=source`,
      (b) => Array.isArray(b.rows)],
    ['Reports · pace', `/api/reports/pace?from=${addDays(businessDate, -7)}&to=${businessDate}`,
      (b) => Array.isArray(b.buckets)],
    ['Reports · pickup vs last year', `/api/reports/pickup?from=${businessDate}&to=${addDays(businessDate, 7)}`,
      (b) => Array.isArray(b.rows)],
    ['Reports · revenue breakdown', `/api/reports/revenue?from=${addDays(businessDate, -7)}&to=${businessDate}`,
      (b) => Array.isArray(b.rows)],
    ['Reports · daily statistics', `/api/reports/daily-stats?from=${addDays(businessDate, -7)}&to=${businessDate}`,
      (b) => Array.isArray(b)],
    ['Reports · occupancy forecast', `/api/reports/occupancy-forecast?from=${businessDate}&to=${addDays(businessDate, 7)}`,
      (b) => Array.isArray(b.roomTypes)],
    ['Channel manager · channels', '/api/channels', (b) => Array.isArray(b)],
    ['Channel manager · health', '/api/channels/health', (b) => Array.isArray(b)],
    ['Channel manager · catalogue', '/api/channels/catalogue', (b) => Array.isArray(b) && b.length > 5],
    ['Channel manager · mappings', '/api/channel-mappings', (b) => Array.isArray(b)],
    ['Channel manager · sync log', '/api/channels/sync-log', (b) => Array.isArray(b)],
    ['Channel manager · queue', '/api/channels/queue', (b) => Array.isArray(b)],
    ['Channel manager · conflicts', '/api/channels/conflicts', (b) => Array.isArray(b)],
    ['Groups', '/api/groups', (b) => Array.isArray(b)],
    ['Waitlist', '/api/waitlist', (b) => Array.isArray(b)],
    ['Configuration · property', '/api/property', (b) => !!b.code && typeof b.rooms === 'number'],
    ['Configuration · room types', '/api/room-types', (b) => Array.isArray(b) && b.length > 0],
    ['Configuration · rooms', '/api/rooms', (b) => Array.isArray(b) && b.length > 0],
    ['Configuration · beds', '/api/beds', (b) => Array.isArray(b)],
    ['Configuration · taxes', '/api/taxes', (b) => Array.isArray(b) && b.length > 0],
    ['Configuration · transaction codes', '/api/transaction-codes', (b) => Array.isArray(b) && b.length > 0],
    ['Configuration · policies', '/api/policies', (b) => Array.isArray(b)],
    ['Administration · users', '/api/users', (b) => Array.isArray(b) && b.length > 0],
    ['Administration · roles', '/api/roles', (b) => Array.isArray(b) && b.length === 8],
    ['Administration · sessions', '/api/sessions', (b) => Array.isArray(b) && b.length > 0],
    ['Administration · audit trail', '/api/audit-log?limit=50', (b) => Array.isArray(b) && b.length > 0],
    // The feed now carries its own unread count and source breakdown, so the
    // bell does not derive them from a page of rows it may not have.
    ['Layout · notifications', '/api/notifications',
      (b) => Array.isArray(b.notifications) && typeof b.unread === 'number'
        && Array.isArray(b.sources)],
    ['Layout · tasks', '/api/tasks', (b) => Array.isArray(b)],
    ['Layout · global search', '/api/search?q=am', (b) => Array.isArray(b.results)],
  ];

  for (const [screen, path, predicate] of cases) {
    const res = await api(path);
    const ok = res.status === 200 && predicate(res.body);
    check(`${screen}  →  ${path.split('?')[0]}`, ok,
      ok ? undefined : { status: res.status, body: res.body });
  }

  // Detail routes need an id from the list routes.
  const reservations = await api('/api/reservations?limit=1');
  const reservationId = reservations.body?.[0]?.id;
  if (reservationId) {
    const detail = await api(`/api/reservations/${reservationId}`);
    check('Guest dashboard  →  /api/reservations/:id',
      detail.status === 200 && Array.isArray(detail.body.nightRows) && Array.isArray(detail.body.folios),
      detail.body);
    const folioId = detail.body?.folios?.[0]?.id;
    if (folioId) {
      const folio = await api(`/api/folios/${folioId}`);
      check('Cashier folio  →  /api/folios/:id',
        folio.status === 200 && Array.isArray(folio.body.lines) && typeof folio.body.balanceMinor === 'number',
        folio.body);
      // The ledger must reconcile: balance == charges + taxes + payments + adjustments.
      const f = folio.body;
      const computed = f.chargesMinor + f.taxesMinor + f.paymentsMinor + f.adjustmentsMinor;
      check('Folio totals reconcile with its balance', computed === f.balanceMinor,
        { computed, balance: f.balanceMinor });
      // …and with the sum of its own non-voided lines.
      const lineSum = f.lines.filter((l: any) => !l.voided)
        .reduce((s: number, l: any) => s + l.amountMinor, 0);
      check('Folio lines sum to the same balance', lineSum === f.balanceMinor,
        { lineSum, balance: f.balanceMinor });
    }
  }

  const profiles = await api('/api/profiles?limit=1');
  const profileId = profiles.body?.[0]?.id;
  if (profileId) {
    const detail = await api(`/api/profiles/${profileId}`);
    check('Profile detail  →  /api/profiles/:id',
      detail.status === 200 && Array.isArray(detail.body.stays) && typeof detail.body.lifetimeValueMinor === 'number',
      detail.body);
    const dupes = await api(`/api/profiles/${profileId}/duplicates`);
    check('Profile duplicates  →  /api/profiles/:id/duplicates', dupes.status === 200 && Array.isArray(dupes.body));
  }

  const roomTypes = await api('/api/room-types');
  const ratePlans = await api('/api/rate-plans');
  const rtId = roomTypes.body?.[0]?.id;
  const rpId = ratePlans.body?.[0]?.id;
  if (rtId && rpId) {
    const ari = await api(`/api/channels/ari?from=${businessDate}&to=${addDays(businessDate, 7)}&roomTypeId=${rtId}&ratePlanId=${rpId}`);
    check('Channel manager ARI  →  /api/channels/ari',
      ari.status === 200 && ari.body.cells.length === 7, ari.body);
    const free = await api(`/api/availability/free-rooms?from=${businessDate}&to=${addDays(businessDate, 1)}&roomTypeId=${rtId}`);
    check('Room assignment  →  /api/availability/free-rooms',
      free.status === 200 && Array.isArray(free.body.rooms), free.body);
  }

  process.stdout.write(`\n${checks - failures}/${checks} screen data checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('Every screen has real data to render.\n');
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

main().catch((e) => {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
