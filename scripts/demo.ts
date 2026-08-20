// ─────────────────────────────────────────────────────────────
// Demo data for Mellow Bay.
//
//   node --experimental-sqlite scripts/demo.ts      (server must be running)
//
// Everything here is created by calling the real API in the same order an
// operator would, then advancing the business date day by day with the night
// audit. Nothing is written straight into tables — so the folios balance, the
// statistics are computed from actual postings, and the audit trail is real.
//
// Property : Mellow Bay
// Rooms    : 4 × single, 1 × family (two double beds), 3 × dorm
// Dorm beds: 24 in total (8 per dorm) — change DORM_BEDS_PER_ROOM for 24 each
// ─────────────────────────────────────────────────────────────
const BASE = process.env.API ?? 'http://localhost:8080';

const PROPERTY_CODE = 'MELLOW';
const PROPERTY_NAME = 'Mellow Bay';
const ADMIN_NAME = 'Hiran Pathirana';
const ADMIN_EMAIL = process.env.DEMO_EMAIL ?? 'hiran@mellowbay.com';
const ADMIN_PASSWORD = process.env.DEMO_PASSWORD ?? 'Mellow2026';
const CURRENCY = process.env.DEMO_CURRENCY ?? 'USD';
const TIMEZONE = process.env.DEMO_TIMEZONE ?? 'Asia/Colombo';

// The README has always said these could be changed to reshape the demo, and
// until now they were plain constants that ignored the environment entirely.
const DORM_ROOMS = num('DEMO_DORM_ROOMS', 3, 1, 20);
const DORM_BEDS_PER_ROOM = num('DEMO_DORM_BEDS_PER_ROOM', 8, 1, 40);   // 3 × 8 = 24 beds
const HISTORY_DAYS = num('DEMO_HISTORY_DAYS', 14, 0, 365);             // days of closed business to build

/**
 * A demo knob, refused rather than guessed at when it is nonsense.
 *
 * `Number(x ?? d)` would turn a typo into `NaN` and build a property with NaN
 * beds, which fails much later and somewhere unrelated.
 */
function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  }
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

let token = '';
let propertyId = '';

// ─── HTTP ────────────────────────────────────────────────────
async function call(method: string, path: string, body?: unknown): Promise<any> {
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
  if (res.status >= 400) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}
const get = (p: string) => call('GET', p);
const post = (p: string, b?: unknown) => call('POST', p, b ?? {});

/** Best-effort call: used where a failure is acceptable (e.g. a full house). */
async function tryPost(p: string, b?: unknown): Promise<any | null> {
  try { return await post(p, b); } catch { return null; }
}

// ─── Dates ───────────────────────────────────────────────────
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TODAY = new Date().toISOString().slice(0, 10);
const START = addDays(TODAY, -HISTORY_DAYS);
/** Offsets are relative to today: -3 is three days ago, +5 is next week. */
const day = (offset: number) => addDays(TODAY, offset);

const money = (minor: number) => `${CURRENCY} ${(minor / 100).toFixed(2)}`;
function log(step: string, detail = '') {
  process.stdout.write(`  · ${step}${detail ? ` — ${detail}` : ''}\n`);
}
function section(title: string) {
  process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`);
}

// ─── Reservation plan ────────────────────────────────────────
// bookedOn is when the booking was taken (drives lead time and booking pace),
// arrive/depart are day offsets from today.
interface Booking {
  guest: string;
  email: string;
  phone?: string;
  nationality?: string;
  type: 'SGL' | 'FAM' | 'DORM';
  plan: 'BAR' | 'NREF' | 'CORP';
  bookedOn: number;
  arrive: number;
  depart: number;
  adults: number;
  children?: number;
  source: string;
  channel?: string;
  segment: string;
  vip?: boolean;
  company?: boolean;
  requests?: string;
  /** Deliberately never turns up, so the night audit has a no-show to process. */
  noShow?: boolean;
  /** Cancelled before arrival. */
  cancel?: { on: number; reason: string };
  eta?: string;
}

const BOOKINGS: Booking[] = [
  // ── Completed stays, earlier in the fortnight ──────────────
  { guest: 'Ayesha Fernando', email: 'ayesha.fernando@example.lk', phone: '+94 77 234 5566',
    nationality: 'Sri Lanka', type: 'SGL', plan: 'BAR', bookedOn: -21, arrive: -14, depart: -11,
    adults: 1, source: 'Direct', segment: 'Leisure' },
  { guest: 'Tom Whitfield', email: 'tom.whitfield@example.co.uk', phone: '+44 7700 900233',
    nationality: 'United Kingdom', type: 'DORM', plan: 'BAR', bookedOn: -18, arrive: -14, depart: -10,
    adults: 1, source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Lena Brandt', email: 'lena.brandt@example.de', phone: '+49 30 5550 8842',
    nationality: 'Germany', type: 'DORM', plan: 'BAR', bookedOn: -16, arrive: -13, depart: -9,
    adults: 1, source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'The Nakamura Family', email: 'k.nakamura@example.jp', phone: '+81 90 1122 3344',
    nationality: 'Japan', type: 'FAM', plan: 'BAR', bookedOn: -30, arrive: -12, depart: -8,
    adults: 2, children: 2, source: 'OTA', channel: 'BDC', segment: 'Family',
    requests: 'Cot for the youngest, high floor if possible' },
  { guest: 'Marcus Oduya', email: 'marcus.oduya@example.com', phone: '+254 700 112233',
    nationality: 'Kenya', type: 'SGL', plan: 'NREF', bookedOn: -12, arrive: -11, depart: -9,
    adults: 1, source: 'OTA', channel: 'BDC', segment: 'Business' },
  { guest: 'Sophie Lambert', email: 'sophie.lambert@example.fr', phone: '+33 6 12 34 56 78',
    nationality: 'France', type: 'DORM', plan: 'BAR', bookedOn: -14, arrive: -11, depart: -7,
    adults: 1, source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Dinesh Wickrama', email: 'dinesh.w@lankatea.example', phone: '+94 71 998 4400',
    nationality: 'Sri Lanka', type: 'SGL', plan: 'CORP', bookedOn: -20, arrive: -10, depart: -7,
    adults: 1, source: 'Corporate', segment: 'Corporate', company: true },
  { guest: 'Ingrid Solberg', email: 'ingrid.solberg@example.no', phone: '+47 900 11 223',
    nationality: 'Norway', type: 'DORM', plan: 'BAR', bookedOn: -9, arrive: -9, depart: -5,
    adults: 1, source: 'Walk-in', segment: 'Backpacker' },
  { guest: 'Paolo Ricci', email: 'paolo.ricci@example.it', phone: '+39 06 555 7788',
    nationality: 'Italy', type: 'SGL', plan: 'BAR', bookedOn: -15, arrive: -8, depart: -5,
    adults: 1, source: 'Direct', segment: 'Leisure', vip: true },
  { guest: 'Grace Mwangi', email: 'grace.mwangi@example.com', phone: '+254 733 445566',
    nationality: 'Kenya', type: 'DORM', plan: 'NREF', bookedOn: -11, arrive: -7, depart: -3,
    adults: 1, source: 'OTA', channel: 'BDC', segment: 'Backpacker' },
  { guest: 'Oliver Hart', email: 'oliver.hart@example.au', phone: '+61 412 667 889',
    nationality: 'Australia', type: 'DORM', plan: 'BAR', bookedOn: -10, arrive: -6, depart: -2,
    adults: 1, source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Rashmi & Anand Pillai', email: 'rashmi.pillai@example.in', phone: '+91 98200 45566',
    nationality: 'India', type: 'FAM', plan: 'BAR', bookedOn: -25, arrive: -6, depart: -2,
    adults: 2, children: 1, source: 'OTA', channel: 'AGD', segment: 'Family' },
  { guest: 'Nadia Haddad', email: 'nadia.haddad@example.com', phone: '+971 50 776 5544',
    nationality: 'United Arab Emirates', type: 'SGL', plan: 'BAR', bookedOn: -8, arrive: -5, depart: -2,
    adults: 1, source: 'Direct', segment: 'Leisure' },

  // ── Never turned up ────────────────────────────────────────
  { guest: 'Brian Kelleher', email: 'brian.kelleher@example.ie', phone: '+353 1 555 0221',
    nationality: 'Ireland', type: 'SGL', plan: 'NREF', bookedOn: -13, arrive: -6, depart: -4,
    adults: 1, source: 'OTA', channel: 'BDC', segment: 'Leisure', noShow: true },
  { guest: 'Wei Zhang', email: 'wei.zhang@example.cn', phone: '+86 138 0011 2233',
    nationality: 'China', type: 'DORM', plan: 'BAR', bookedOn: -7, arrive: -3, depart: -1,
    adults: 1, source: 'OTA', channel: 'AGD', segment: 'Backpacker', noShow: true },

  // ── Cancelled before arrival ───────────────────────────────
  { guest: 'Helena Costa', email: 'helena.costa@example.pt', phone: '+351 91 234 5678',
    nationality: 'Portugal', type: 'SGL', plan: 'BAR', bookedOn: -12, arrive: -1, depart: 2,
    adults: 1, source: 'Direct', segment: 'Leisure',
    cancel: { on: -4, reason: 'Change of travel plans' } },

  // ── Currently in-house ─────────────────────────────────────
  { guest: 'Emma Sinclair', email: 'emma.sinclair@example.ca', phone: '+1 604 555 0142',
    nationality: 'Canada', type: 'SGL', plan: 'BAR', bookedOn: -9, arrive: -3, depart: 2,
    adults: 1, source: 'Direct', segment: 'Leisure', vip: true,
    requests: 'Quiet room away from the road' },
  { guest: 'Jonas Vermeer', email: 'jonas.vermeer@example.nl', phone: '+31 6 2233 4455',
    nationality: 'Netherlands', type: 'DORM', plan: 'BAR', bookedOn: -6, arrive: -3, depart: 3,
    adults: 1, source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Sara Lindqvist', email: 'sara.lindqvist@example.se', phone: '+46 70 123 4567',
    nationality: 'Sweden', type: 'DORM', plan: 'BAR', bookedOn: -5, arrive: -2, depart: 4,
    adults: 1, source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Miguel Santos', email: 'miguel.santos@example.br', phone: '+55 11 98877 6655',
    nationality: 'Brazil', type: 'DORM', plan: 'NREF', bookedOn: -4, arrive: -2, depart: 1,
    adults: 1, source: 'OTA', channel: 'BDC', segment: 'Backpacker' },
  { guest: 'Priya Sharma', email: 'priya.sharma@example.in', phone: '+91 99300 22114',
    nationality: 'India', type: 'SGL', plan: 'CORP', bookedOn: -10, arrive: -1, depart: 3,
    adults: 1, source: 'Corporate', segment: 'Corporate', company: true },
  { guest: 'The Okonkwo Family', email: 'chidi.okonkwo@example.ng', phone: '+234 803 445 6677',
    nationality: 'Nigeria', type: 'FAM', plan: 'BAR', bookedOn: -18, arrive: -1, depart: 4,
    adults: 2, children: 2, source: 'Direct', segment: 'Family',
    requests: 'Late check-out on departure if possible' },

  // ── Arriving today ─────────────────────────────────────────
  { guest: 'Daniel Rossi', email: 'daniel.rossi@example.ch', phone: '+41 79 445 3322',
    nationality: 'Switzerland', type: 'SGL', plan: 'BAR', bookedOn: -6, arrive: 0, depart: 3,
    adults: 1, source: 'Direct', segment: 'Leisure', eta: '15:00' },
  { guest: 'Anika Rahman', email: 'anika.rahman@example.bd', phone: '+880 171 223 3445',
    nationality: 'Bangladesh', type: 'DORM', plan: 'BAR', bookedOn: -3, arrive: 0, depart: 5,
    adults: 1, source: 'OTA', channel: 'HW', segment: 'Backpacker', eta: '19:30' },
  { guest: 'Callum Reid', email: 'callum.reid@example.uk', phone: '+44 7700 900771',
    nationality: 'United Kingdom', type: 'DORM', plan: 'BAR', bookedOn: -2, arrive: 0, depart: 4,
    adults: 1, source: 'OTA', channel: 'BDC', segment: 'Backpacker', eta: '21:00' },

  // ── On the books for the weeks ahead ───────────────────────
  { guest: 'Yuki Tanaka', email: 'yuki.tanaka@example.jp', phone: '+81 80 3344 5566',
    nationality: 'Japan', type: 'SGL', plan: 'BAR', bookedOn: -4, arrive: 2, depart: 5,
    adults: 1, source: 'OTA', channel: 'AGD', segment: 'Leisure' },
  { guest: 'Freya Andersen', email: 'freya.andersen@example.dk', phone: '+45 30 22 11 44',
    nationality: 'Denmark', type: 'DORM', plan: 'BAR', bookedOn: -1, arrive: 3, depart: 8,
    adults: 1, source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Lucas Meyer', email: 'lucas.meyer@example.de', phone: '+49 151 2233 4455',
    nationality: 'Germany', type: 'DORM', plan: 'BAR', bookedOn: -1, arrive: 3, depart: 8,
    adults: 1, source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Isabel Moreno', email: 'isabel.moreno@example.es', phone: '+34 600 112 233',
    nationality: 'Spain', type: 'FAM', plan: 'BAR', bookedOn: -2, arrive: 5, depart: 9,
    adults: 2, children: 2, source: 'Direct', segment: 'Family' },
  { guest: 'Ravi Jayasuriya', email: 'ravi.j@lankatea.example', phone: '+94 76 554 3322',
    nationality: 'Sri Lanka', type: 'SGL', plan: 'CORP', bookedOn: -3, arrive: 6, depart: 9,
    adults: 1, source: 'Corporate', segment: 'Corporate', company: true },
  { guest: 'Chloe Dubois', email: 'chloe.dubois@example.fr', phone: '+33 7 55 66 77 88',
    nationality: 'France', type: 'DORM', plan: 'NREF', bookedOn: 0, arrive: 9, depart: 13,
    adults: 1, source: 'OTA', channel: 'BDC', segment: 'Backpacker' },
  { guest: 'Ahmed Al-Rashid', email: 'ahmed.alrashid@example.ae', phone: '+971 55 998 7766',
    nationality: 'United Arab Emirates', type: 'SGL', plan: 'BAR', bookedOn: 0, arrive: 12, depart: 15,
    adults: 1, source: 'Direct', segment: 'Leisure', vip: true },
  { guest: 'Hannah Brooks', email: 'hannah.brooks@example.nz', phone: '+64 21 445 667',
    nationality: 'New Zealand', type: 'FAM', plan: 'BAR', bookedOn: 0, arrive: 20, depart: 24,
    adults: 2, children: 1, source: 'OTA', channel: 'BDC', segment: 'Family' },

  // ── Dorm traffic: the volume a hostel actually runs on ─────
  { guest: 'Mateo Ferrari', email: 'mateo.ferrari@example.ar', nationality: 'Argentina',
    type: 'DORM', plan: 'BAR', bookedOn: -17, arrive: -14, depart: -11, adults: 1,
    source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Zoe Clarke', email: 'zoe.clarke@example.uk', nationality: 'United Kingdom',
    type: 'DORM', plan: 'BAR', bookedOn: -15, arrive: -13, depart: -8, adults: 1,
    source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Ben Kruger', email: 'ben.kruger@example.za', nationality: 'South Africa',
    type: 'DORM', plan: 'NREF', bookedOn: -14, arrive: -12, depart: -7, adults: 1,
    source: 'OTA', channel: 'BDC', segment: 'Backpacker' },
  { guest: 'Alina Popescu', email: 'alina.popescu@example.ro', nationality: 'Romania',
    type: 'DORM', plan: 'BAR', bookedOn: -13, arrive: -11, depart: -6, adults: 1,
    source: 'Walk-in', segment: 'Backpacker' },
  { guest: 'Hugo Martins', email: 'hugo.martins@example.br', nationality: 'Brazil',
    type: 'DORM', plan: 'BAR', bookedOn: -12, arrive: -10, depart: -4, adults: 1,
    source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Mia Petersen', email: 'mia.petersen@example.dk', nationality: 'Denmark',
    type: 'DORM', plan: 'BAR', bookedOn: -11, arrive: -9, depart: -4, adults: 1,
    source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Arjun Menon', email: 'arjun.menon@example.in', nationality: 'India',
    type: 'DORM', plan: 'BAR', bookedOn: -10, arrive: -8, depart: -3, adults: 1,
    source: 'OTA', channel: 'AGD', segment: 'Backpacker' },
  { guest: 'Elsa Johansson', email: 'elsa.johansson@example.se', nationality: 'Sweden',
    type: 'DORM', plan: 'BAR', bookedOn: -9, arrive: -7, depart: -1, adults: 1,
    source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Liam Gallagher', email: 'liam.gallagher@example.ie', nationality: 'Ireland',
    type: 'DORM', plan: 'BAR', bookedOn: -8, arrive: -6, depart: 1, adults: 1,
    source: 'Walk-in', segment: 'Backpacker' },
  { guest: 'Nina Kovacs', email: 'nina.kovacs@example.hu', nationality: 'Hungary',
    type: 'DORM', plan: 'NREF', bookedOn: -7, arrive: -5, depart: 2, adults: 1,
    source: 'OTA', channel: 'BDC', segment: 'Backpacker' },
  { guest: 'Kofi Boateng', email: 'kofi.boateng@example.gh', nationality: 'Ghana',
    type: 'DORM', plan: 'BAR', bookedOn: -6, arrive: -4, depart: 3, adults: 1,
    source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Julia Nowak', email: 'julia.nowak@example.pl', nationality: 'Poland',
    type: 'DORM', plan: 'BAR', bookedOn: -5, arrive: -3, depart: 4, adults: 1,
    source: 'Direct', segment: 'Backpacker' },
  { guest: 'Ryan Cooper', email: 'ryan.cooper@example.us', nationality: 'United States',
    type: 'DORM', plan: 'BAR', bookedOn: -4, arrive: -1, depart: 5, adults: 1,
    source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Sofia Hernandez', email: 'sofia.hernandez@example.mx', nationality: 'Mexico',
    type: 'DORM', plan: 'BAR', bookedOn: -2, arrive: 1, depart: 6, adults: 1,
    source: 'OTA', channel: 'HW', segment: 'Backpacker' },
  { guest: 'Noah Bergman', email: 'noah.bergman@example.no', nationality: 'Norway',
    type: 'DORM', plan: 'BAR', bookedOn: -1, arrive: 2, depart: 7, adults: 1,
    source: 'OTA', channel: 'BDC', segment: 'Backpacker' },
  { guest: 'Aiko Matsuda', email: 'aiko.matsuda@example.jp', nationality: 'Japan',
    type: 'DORM', plan: 'BAR', bookedOn: 0, arrive: 4, depart: 9, adults: 1,
    source: 'OTA', channel: 'AGD', segment: 'Backpacker' },
];

// Incidentals posted while guests are in-house, keyed by guest name.
const INCIDENTALS: Record<string, { code: string; description: string; unitMinor: number; qty?: number }[]> = {
  'Ayesha Fernando': [{ code: 'FNB', description: 'Breakfast', unitMinor: 950, qty: 3 }],
  'The Nakamura Family': [
    { code: 'FNB', description: 'Family dinner at the beach grill', unitMinor: 6800 },
    { code: 'LAUNDRY', description: 'Laundry service', unitMinor: 1500 },
  ],
  'Dinesh Wickrama': [{ code: 'FNB', description: 'Working lunch', unitMinor: 2200, qty: 2 }],
  'Paolo Ricci': [
    { code: 'FNB', description: 'Dinner and wine', unitMinor: 5400 },
    { code: 'MINIBAR', description: 'Minibar', unitMinor: 1200 },
  ],
  'Rashmi & Anand Pillai': [{ code: 'FNB', description: 'Half board supplement', unitMinor: 4200, qty: 2 }],
  'Emma Sinclair': [
    { code: 'FNB', description: 'Breakfast', unitMinor: 950, qty: 2 },
    { code: 'LAUNDRY', description: 'Express laundry', unitMinor: 1800 },
  ],
  'The Okonkwo Family': [{ code: 'FNB', description: 'Welcome dinner', unitMinor: 7600 }],
  'Jonas Vermeer': [{ code: 'FNB', description: 'Bar tab', unitMinor: 1600, qty: 2 }],
  'Sara Lindqvist': [{ code: 'FNB', description: 'Breakfast', unitMinor: 950, qty: 2 }],
  'Priya Sharma': [{ code: 'FNB', description: 'Room service', unitMinor: 2400 }],
};

const PAYMENT_METHODS = ['Visa', 'Mastercard', 'Cash', 'Bank transfer', 'Amex'];

// ─── Seed ────────────────────────────────────────────────────
async function main() {
  const health = await get('/health');
  if (!health.setupRequired) {
    process.stdout.write(
      '\nThis installation already has a property.\n'
      + 'The demo builds a property from scratch — stop the API, delete\n'
      + 'backend/data/helio.db (and its -wal / -shm files), start it again, then re-run.\n\n');
    process.exitCode = 1;
    return;
  }

  section(`Creating ${PROPERTY_NAME}`);
  const boot = await post('/api/setup/bootstrap', {
    property: {
      code: PROPERTY_CODE, name: PROPERTY_NAME, legalName: 'Mellow Bay Hospitality',
      kind: 'mixed', city: 'Colombo', country: 'Sri Lanka',
      currency: CURRENCY, timezone: TIMEZONE, businessDate: START,
      checkInTime: '14:00', checkOutTime: '11:00',
      phone: '+94 11 234 5678', email: 'stay@mellowbay.com',
    },
    admin: { name: ADMIN_NAME, email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  token = boot.token;
  propertyId = boot.property.id;
  log('Property created', `${PROPERTY_NAME} (${PROPERTY_CODE}) · opening business date ${START}`);
  log('Administrator created', `${ADMIN_NAME} <${ADMIN_EMAIL}>`);

  // ── Team ──────────────────────────────────────────────────
  const staff = [
    { name: 'Nadeeka Silva', email: 'nadeeka@mellowbay.com', role: 'front_office', password: 'Mellow2026' },
    { name: 'Sunil Perera', email: 'sunil@mellowbay.com', role: 'housekeeping', password: 'Mellow2026' },
    { name: 'Chamari Gunawardena', email: 'chamari@mellowbay.com', role: 'accounts', password: 'Mellow2026' },
    { name: 'Roshan De Silva', email: 'roshan@mellowbay.com', role: 'revenue', password: 'Mellow2026' },
  ];
  for (const s of staff) await post('/api/users', { ...s, mustChangePassword: false });
  log('Team created', staff.map((s) => `${s.name.split(' ')[0]} (${s.role})`).join(', '));

  // ── Room types ────────────────────────────────────────────
  section('Inventory');
  const single = await post('/api/room-types', {
    code: 'SGL', name: 'Single Room', kind: 'room',
    description: 'Compact room with one single bed, garden outlook.',
    baseOccupancy: 1, maxOccupancy: 1, maxAdults: 1, maxChildren: 0,
    defaultRateMinor: 6500, amenities: ['Air conditioning', 'En-suite', 'Desk', 'Free WiFi'],
    sortOrder: 1,
  });
  const family = await post('/api/room-types', {
    code: 'FAM', name: 'Family Room', kind: 'room',
    description: 'Two double beds, sleeps four comfortably.',
    baseOccupancy: 2, maxOccupancy: 4, maxAdults: 4, maxChildren: 2,
    defaultRateMinor: 14500, extraAdultMinor: 2000, extraChildMinor: 1000,
    amenities: ['Air conditioning', 'En-suite', 'Two double beds', 'Free WiFi', 'Sea view'],
    sortOrder: 2,
  });
  const dorm = await post('/api/room-types', {
    code: 'DORM', name: 'Mixed Dorm', kind: 'dorm',
    description: 'Bunk bed in a shared mixed dorm, locker included.',
    baseOccupancy: 1, maxOccupancy: 1, maxAdults: 1, maxChildren: 0,
    defaultRateMinor: 2200, genderPolicy: 'mixed',
    amenities: ['Air conditioning', 'Locker', 'Shared bathroom', 'Free WiFi'],
    sortOrder: 3,
  });
  log('Room types', 'Single · Family · Mixed Dorm');

  for (const n of ['101', '102', '103', '104']) {
    await post('/api/rooms', { roomTypeId: single.id, number: n, floor: 1, hkSection: 'Ground wing' });
  }
  await post('/api/rooms', { roomTypeId: family.id, number: '201', floor: 2, hkSection: 'Upper wing' });
  for (let i = 1; i <= DORM_ROOMS; i++) {
    await post('/api/rooms', {
      roomTypeId: dorm.id, number: `D${i}`, floor: 1,
      hkSection: 'Dorm wing', bedCount: DORM_BEDS_PER_ROOM,
    });
  }
  log('Rooms', `4 single · 1 family · ${DORM_ROOMS} dorms holding ${DORM_ROOMS * DORM_BEDS_PER_ROOM} beds`);

  // ── Taxes ─────────────────────────────────────────────────
  await post('/api/taxes', { code: 'SVC', name: 'Service charge', mode: 'percent', value: 1000, appliesTo: 'all', sortOrder: 1 });
  await post('/api/taxes', { code: 'VAT', name: 'VAT', mode: 'percent', value: 800, appliesTo: 'all', sortOrder: 2 });
  await post('/api/taxes', { code: 'CITY', name: 'Tourism levy', mode: 'per_person_night', value: 150, appliesTo: 'room', sortOrder: 3 });
  log('Taxes', '10% service charge → 8% VAT (compounding) → tourism levy per guest per night');

  // ── Rate plans ────────────────────────────────────────────
  section('Rates');
  const bar = await post('/api/rate-plans', {
    code: 'BAR', name: 'Best Available Rate', description: 'Flexible, cancel free up to 24h before arrival.',
    roomTypes: [
      { roomTypeId: single.id, baseRateMinor: 6500 },
      { roomTypeId: family.id, baseRateMinor: 14500 },
      { roomTypeId: dorm.id, baseRateMinor: 2200 },
    ],
    inclusions: ['Free WiFi', 'Breakfast'], sortOrder: 1,
  });
  const nref = await post('/api/rate-plans', {
    code: 'NREF', name: 'Non-refundable', description: 'Ten percent off, paid at booking, no changes.',
    parentId: bar.id, offsetType: 'percent', offsetValue: -1000, refundable: false, sortOrder: 2,
  });
  const corp = await post('/api/rate-plans', {
    code: 'CORP', name: 'Corporate Negotiated', kind: 'corporate',
    description: 'Contracted rate for corporate accounts.',
    roomTypes: [
      { roomTypeId: single.id, baseRateMinor: 5800 },
      { roomTypeId: family.id, baseRateMinor: 13000 },
    ],
    inclusions: ['Free WiFi', 'Breakfast', 'Late check-out'], sortOrder: 3,
  });
  log('Rate plans', 'BAR · NREF (BAR −10%, derived) · CORP');

  // Season pricing across the next six months: weekday base, weekend premium.
  const rateFrom = START;
  const rateTo = addDays(TODAY, 180);
  await post('/api/rates/bulk', {
    from: rateFrom, to: rateTo, roomTypeIds: [single.id], ratePlanIds: [bar.id], priceMinor: 6500,
  });
  await post('/api/rates/bulk', {
    from: rateFrom, to: rateTo, roomTypeIds: [family.id], ratePlanIds: [bar.id], priceMinor: 14500,
  });
  await post('/api/rates/bulk', {
    from: rateFrom, to: rateTo, roomTypeIds: [dorm.id], ratePlanIds: [bar.id], priceMinor: 2200,
  });
  await post('/api/rates/bulk', {
    from: rateFrom, to: rateTo, roomTypeIds: [single.id], ratePlanIds: [bar.id],
    priceMinor: 7900, daysOfWeek: ['fri', 'sat'],
  });
  await post('/api/rates/bulk', {
    from: rateFrom, to: rateTo, roomTypeIds: [family.id], ratePlanIds: [bar.id],
    priceMinor: 17500, daysOfWeek: ['fri', 'sat'],
  });
  await post('/api/rates/bulk', {
    from: rateFrom, to: rateTo, roomTypeIds: [dorm.id], ratePlanIds: [bar.id],
    priceMinor: 2600, daysOfWeek: ['fri', 'sat'],
  });
  // December peak.
  const decFrom = `${new Date(`${TODAY}T00:00:00Z`).getUTCFullYear()}-12-18`;
  if (decFrom <= rateTo) {
    await post('/api/rates/bulk', {
      from: decFrom, to: `${new Date(`${TODAY}T00:00:00Z`).getUTCFullYear()}-12-31`,
      roomTypeIds: [single.id, family.id, dorm.id], ratePlanIds: [bar.id], adjustPercentBp: 2500,
    });
    log('Season pricing', 'weekday / weekend rates loaded, +25% over the December peak');
  } else {
    log('Season pricing', 'weekday and weekend rates loaded for the next six months');
  }

  // ── Selling rules ─────────────────────────────────────────
  await post('/api/restrictions', {
    roomTypeId: family.id, dateFrom: day(3), dateTo: day(30),
    type: 'min-stay', value: 2, note: 'Family room is a two-night minimum in season',
  });
  await post('/api/restrictions', {
    roomTypeId: dorm.id, dateFrom: day(45), dateTo: day(47),
    type: 'stop-sell', note: 'Dorm deep clean and repaint',
  });
  await post('/api/yield-rules', {
    name: 'High occupancy uplift', metric: 'occupancy', operator: 'gt', threshold: '8000',
    adjustType: 'percent', adjustValue: 1000, priority: 10,
  });
  await post('/api/yield-rules', {
    name: 'Last-minute dorm fill', metric: 'lead_time', operator: 'lt', threshold: '3',
    adjustType: 'percent', adjustValue: -800, roomTypeId: dorm.id, priority: 5,
  });
  await post('/api/promotions', {
    code: 'EARLYBIRD', name: 'Early bird — 15% off', kind: 'early_bird',
    discountType: 'percent', discountValue: 1500, minAdvance: 30, usageLimit: 100, deliveryMode: 'price',
  });
  await post('/api/promotions', {
    code: 'STAY4PAY3', name: 'Stay 4 nights, pay for 3', kind: 'long_stay',
    discountType: 'percent', discountValue: 2500, minLos: 4, usageLimit: 0, deliveryMode: 'price',
  });
  log('Selling rules', '2 restrictions · 2 yield rules · 2 promotions');

  // ── Policies ──────────────────────────────────────────────
  await post('/api/policies', {
    kind: 'cancellation', name: 'Flexible', scope: 'property',
    summary: 'Free cancellation until 24 hours before arrival',
    details: 'Cancel free of charge up to 24 hours before the arrival date. After that the first night is charged.',
  });
  await post('/api/policies', {
    kind: 'children', name: 'Children in family rooms', scope: 'room-type', scopeRef: 'FAM',
    summary: 'Under-6s stay free, older children charged the child supplement',
    details: 'Up to two children under six stay free in a Family Room. Children six and over are charged the child supplement per night.',
  });
  await post('/api/policies', {
    kind: 'no-show', name: 'No-show', scope: 'property',
    summary: 'First night charged to the card on file',
    details: 'If a guest does not arrive and has not cancelled, the first night is charged and the remainder of the stay released.',
  });
  log('Policies', 'cancellation · children · no-show');

  // ── Companies & channels ──────────────────────────────────
  section('Accounts and distribution');
  const company = await post('/api/companies', {
    code: 'LANKATEA', name: 'Lanka Tea Exports Ltd', type: 'company',
    contactName: 'Malini Rajapaksa', email: 'travel@lankatea.example', phone: '+94 11 445 6677',
    arEnabled: true, creditLimitMinor: 500000, paymentTermsDays: 30,
  });
  await post('/api/companies', {
    code: 'ISLANDTRV', name: 'Island Travel Partners', type: 'travel_agent',
    contactName: 'Kasun Bandara', email: 'bookings@islandtravel.example',
    arEnabled: true, creditLimitMinor: 300000, commissionBp: 1000, paymentTermsDays: 45,
  });
  log('Accounts', 'Lanka Tea Exports (corporate) · Island Travel Partners (agent)');

  for (const c of [
    { code: 'BDC', name: 'Booking.com', kind: 'ota', commissionBp: 1500, priceMultiplierBp: 11800 },
    { code: 'HW', name: 'Hostelworld', kind: 'hostel', commissionBp: 1200, priceMultiplierBp: 11200 },
    { code: 'AGD', name: 'Agoda', kind: 'ota', commissionBp: 1500, priceMultiplierBp: 11500 },
  ]) {
    await post('/api/channels', { ...c, active: true });
  }
  log('Channels', 'Booking.com · Hostelworld · Agoda registered (awaiting Beds24 credentials)');

  // ── Group ─────────────────────────────────────────────────
  const group = await post('/api/groups', {
    code: 'SURFCAMP', name: 'Mellow Surf Camp — October intake',
    arrival: day(14), departure: day(18), cutoffDate: day(7),
    ratePlanId: bar.id, contactName: 'Tharindu Alwis',
    contactEmail: 'tharindu@surfcamp.example', contactPhone: '+94 77 889 9001',
    status: 'definite', masterFolio: true,
    blocks: [{ roomTypeId: dorm.id, rooms: 8, rateMinor: 2000 }],
  });
  await tryPost(`/api/groups/${group.id}/rooming-list`, {
    rows: [
      { guestName: 'Kyle Mensah', email: 'kyle.mensah@example.gh', adults: 1, roomTypeId: dorm.id },
      { guestName: 'Amelie Fischer', email: 'amelie.fischer@example.de', adults: 1, roomTypeId: dorm.id },
      { guestName: 'Diego Navarro', email: 'diego.navarro@example.ar', adults: 1, roomTypeId: dorm.id },
      { guestName: 'Sinead Byrne', email: 'sinead.byrne@example.ie', adults: 1, roomTypeId: dorm.id },
      { guestName: 'Tobias Nilsen', email: 'tobias.nilsen@example.no', adults: 1, roomTypeId: dorm.id },
    ],
  });
  log('Group', 'Mellow Surf Camp — 8 dorm beds held, 5 names on the rooming list');

  await post('/api/waitlist', {
    guestName: 'Marta Kowalska', email: 'marta.kowalska@example.pl', phone: '+48 601 223 344',
    arrival: day(5), departure: day(9), roomTypeId: family.id, adults: 2, children: 2,
    note: 'Wants the family room — call if a cancellation comes in',
  });

  // ── Maintenance ───────────────────────────────────────────
  await post('/api/work-orders', {
    title: 'Dorm D2 — bunk ladder loose', roomId: null, category: 'furniture', priority: 'high',
    description: 'Ladder on bed D2-05 wobbles, guest reported it at the desk.',
  });
  await post('/api/work-orders', {
    title: 'Room 103 — air conditioning noisy', category: 'hvac', priority: 'normal',
    description: 'Compressor rattles overnight; service due.',
  });
  await post('/api/lost-found', {
    description: 'Blue Patagonia rain jacket', foundOn: day(-4), storageRef: 'LF shelf 2',
  });

  const typeIds = { SGL: single.id, FAM: family.id, DORM: dorm.id };
  const planIds = { BAR: bar.id, NREF: nref.id, CORP: corp.id };

  // ── Run the fortnight ─────────────────────────────────────
  section('Running the business forward');
  const created = new Map<string, string>();   // guest → reservation id
  const rejected: string[] = [];               // anything the rules refused
  let auditsRun = 0;

  for (let offset = -HISTORY_DAYS; offset <= 0; offset++) {
    const date = day(offset);

    // Bookings taken today. Anything booked before the window opens is entered
    // on the first day, so long-lead reservations are not silently dropped.
    const takenToday = offset === -HISTORY_DAYS
      ? BOOKINGS.filter((x) => x.bookedOn <= offset)
      : BOOKINGS.filter((x) => x.bookedOn === offset);

    for (const b of takenToday) {
      try {
        const res = await post('/api/reservations', {
          guestName: b.guest, email: b.email, phone: b.phone,
          arrival: day(b.arrive), departure: day(b.depart),
          adults: b.adults, children: b.children ?? 0,
          roomTypeId: typeIds[b.type], ratePlanId: planIds[b.plan],
          source: b.source, channelCode: b.channel, segment: b.segment,
          vip: b.vip, eta: b.eta, specialRequests: b.requests,
          companyId: b.company ? company.id : undefined,
          status: b.plan === 'NREF' ? 'Guaranteed' : 'Confirmed',
          paymentMethod: b.channel ? 'OTA prepaid' : PAYMENT_METHODS[created.size % PAYMENT_METHODS.length],
        });
        created.set(b.guest, res.id);
      } catch (e) {
        // Usually the house is genuinely full for those dates — worth saying so
        // rather than quietly ending up with fewer bookings than intended.
        rejected.push(`booking refused · ${b.guest} (${b.type} ${day(b.arrive)}→${day(b.depart)})`);
      }
    }

    // Cancellations taken today.
    for (const b of BOOKINGS.filter((x) => x.cancel?.on === offset)) {
      const id = created.get(b.guest);
      if (id) await tryPost(`/api/reservations/${id}/cancel`, { reason: b.cancel!.reason });
    }

    // Departures settle and leave first — the day's real order of events.
    const frontDesk = await get('/api/front-desk');
    for (const dep of frontDesk.departures) {
      const detail = await get(`/api/reservations/${dep.id}`);
      const folio = detail.folios[0];
      if (folio) {
        if (detail.companyId) {
          // Corporate stays are invoiced to the company's account rather than
          // settled at the desk — that is what puts a balance on the city ledger.
          await tryPost(`/api/folios/${folio.id}/invoice`, {
            billTo: detail.company ?? 'Corporate account',
            companyId: detail.companyId,
            toAr: true,
            dueAt: addDays(date, 30),
          });
        } else {
          if (folio.balanceMinor > 0) {
            await tryPost(`/api/folios/${folio.id}/payments`, {
              amountMinor: folio.balanceMinor,
              method: PAYMENT_METHODS[dep.guest.length % PAYMENT_METHODS.length],
              reference: `Settled at departure ${date}`,
            });
          }
          // A printed invoice for the guests who ask for one.
          if (detail.vip || (INCIDENTALS[dep.guest]?.length ?? 0) > 0) {
            await tryPost(`/api/folios/${folio.id}/invoice`, { billTo: dep.guest });
          }
        }
      }
      await tryPost(`/api/reservations/${dep.id}/check-out`, {});
    }

    // Housekeeping turns the rooms round: departures cleaned and inspected,
    // stayovers serviced. This has to happen after check-out and before
    // check-in, or the next arrival walks into a dirty room and is refused.
    const board = await get('/api/housekeeping/board');
    for (const room of board.rooms) {
      if (room.status === 'Vacant Dirty') {
        await tryPost(`/api/rooms/${room.id}/status`, { status: 'Vacant Inspected' });
      } else if (room.status === 'Occupied Dirty') {
        await tryPost(`/api/rooms/${room.id}/status`, { status: 'Occupied Clean' });
      }
    }
    await tryPost('/api/housekeeping/tasks/generate', { date });

    // Arrivals check in — except the ones that never turn up.
    const noShowNames = new Set(BOOKINGS.filter((b) => b.noShow).map((b) => b.guest));
    const arrivalsNow = (await get('/api/front-desk')).arrivals;
    for (const arr of arrivalsNow) {
      if (noShowNames.has(arr.guest)) continue;
      // On the open day, guests with a late ETA have not turned up yet — they
      // are left on the arrivals list so the front desk has real work waiting.
      if (offset === 0 && arr.eta && arr.eta >= '17:00') continue;
      try {
        await post(`/api/reservations/${arr.id}/check-in`, {
          idType: 'passport',
          idNumber: `P${(arr.confirmation ?? '').replace(/\D/g, '').slice(-6)}`,
          registered: true,
        });
      } catch (e) {
        rejected.push(`check-in refused · ${arr.guest} on ${date}: `
          + `${e instanceof Error ? e.message.split(':').slice(2).join(':').trim() : e}`);
        continue;
      }

      // A deposit on arrival for direct bookings.
      if (!arr.channel) {
        const detail = await get(`/api/reservations/${arr.id}`);
        const folio = detail.folios[0];
        if (folio) {
          await tryPost(`/api/folios/${folio.id}/payments`, {
            amountMinor: Math.round(detail.totalMinor / 2),
            method: PAYMENT_METHODS[arr.guest.length % PAYMENT_METHODS.length],
            reference: 'Deposit on arrival',
          });
        }
      }

      // Incidentals for guests who spend at the property.
      const extras = INCIDENTALS[arr.guest];
      if (extras) {
        const detail = await get(`/api/reservations/${arr.id}`);
        const folio = detail.folios[0];
        if (folio) {
          for (const e of extras) {
            await tryPost(`/api/folios/${folio.id}/charges`, {
              code: e.code, description: e.description, unitMinor: e.unitMinor, qty: e.qty ?? 1,
            });
          }
        }
      }
    }

    // Close the day — except today, which stays open.
    if (offset < 0) {
      const audit = await tryPost('/api/night-audit/run', { force: true });
      if (audit) {
        auditsRun++;
        if (audit.roomChargesPosted > 0 || audit.noShows > 0) {
          log(`Night audit ${date}`,
            `${audit.roomChargesPosted} room charge(s) · ${money(audit.roomRevenueMinor)} room revenue`
            + (audit.noShows ? ` · ${audit.noShows} no-show` : ''));
        }
      }
    }
  }

  // A part-payment against the corporate account, so the ledger shows movement
  // rather than one untouched balance.
  const arAccounts = await get('/api/ar');
  const corporate = arAccounts.find((a: any) => a.code === 'LANKATEA');
  if (corporate && corporate.balanceMinor > 0) {
    await tryPost(`/api/ar/${corporate.companyId}/payment`, {
      amountMinor: Math.round(corporate.balanceMinor / 2),
      reference: 'Bank transfer — part settlement',
      note: 'Remainder due on 30-day terms',
    });
    log('City ledger', `${money(corporate.balanceMinor)} invoiced to Lanka Tea Exports, half settled`);
  }

  // ── Canned replies ────────────────────────────────────────
  // The handful of messages a front desk sends fifty times a week. Seeded so
  // the inbox is usable on day one rather than starting from a blank slate.
  section('Message templates');
  const templates = [
    {
      name: 'Booking confirmed',
      body: 'Hello {{firstName}}, thank you for booking with {{property}}. '
        + 'Your {{roomType}} is reserved for {{nights}} night(s) from {{arrival}}. '
        + 'Check-in is from {{checkInTime}}. Reference {{confirmation}}.',
    },
    {
      name: 'Arrival details',
      body: 'Hello {{firstName}}, we are looking forward to seeing you on {{arrival}}. '
        + 'Check-in opens at {{checkInTime}} — if you arrive earlier we can store your bags. '
        + 'Is there anything you would like us to have ready?',
    },
    {
      name: 'Early check-in',
      body: 'Hello {{firstName}}, we can offer an early check-in on {{arrival}} subject to the '
        + 'room being ready. We will message you as soon as room {{room}} is available.',
    },
    {
      name: 'Room ready',
      body: 'Hello {{firstName}}, your room ({{room}}) is ready whenever you are. '
        + 'Come to reception and we will take you up.',
    },
    {
      name: 'Thanks for staying',
      body: 'Thank you for staying with us, {{firstName}}. We hope the {{roomType}} was '
        + 'comfortable. If anything was not right, please tell us — we would rather hear it '
        + 'from you than read it later.',
    },
  ];
  for (const [i, t] of templates.entries()) {
    await post('/api/message-templates', { ...t, sortOrder: i });
  }
  log(`${templates.length} message templates`);

  // ── Summary ───────────────────────────────────────────────
  section('Result');
  const property = await get('/api/property');
  const dashboard = await get('/api/dashboard');
  const reservations = await get('/api/reservations?limit=500');
  const kpis = await get(`/api/reports/kpis?from=${START}&to=${day(-1)}`);
  const statuses = reservations.reduce((acc: Record<string, number>, r: any) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  process.stdout.write(`
  Property          ${property.name} (${property.code})
  Business date     ${property.businessDate}
  Rooms             ${property.rooms} rooms · ${DORM_ROOMS * DORM_BEDS_PER_ROOM} dorm beds
  Nights audited    ${auditsRun}

  Reservations      ${reservations.length} total
                    ${Object.entries(statuses).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ')}

  Tonight           ${(dashboard.snapshot.occupancyBp / 100).toFixed(1)}% occupancy · ${dashboard.snapshot.inHouse} rooms in-house
                    ADR ${money(dashboard.snapshot.adrMinor)} · RevPAR ${money(dashboard.snapshot.revparMinor)}
  Arrivals today    ${dashboard.snapshot.arrivals.due} due, ${dashboard.snapshot.arrivals.done} already in
  Departures today  ${dashboard.snapshot.departures.due} due, ${dashboard.snapshot.departures.done} gone
  Owed by in-house  ${money(dashboard.snapshot.outstandingBalanceMinor)}

  Closed fortnight  ${(kpis.occupancyBp / 100).toFixed(1)}% occupancy · ADR ${money(kpis.adrMinor)} · RevPAR ${money(kpis.revparMinor)}
                    ${money(kpis.roomRevenueMinor)} room revenue over ${kpis.roomsSold} room nights

${rejected.length ? `  Refused by rules  ${rejected.length}\n${rejected.map((r) => `                    ${r}`).join('\n')}\n` : ''}
  Sign in           ${ADMIN_EMAIL}
  Password          ${ADMIN_PASSWORD}

  Staff logins      ${staff.map((s) => s.email).join('\n                    ')}
                    (same password)

`);
}

main().catch((e) => {
  process.stderr.write(`\nDemo seed failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
