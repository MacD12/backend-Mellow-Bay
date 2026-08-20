-- ══════════════════════════════════════════════════════════════════════════
-- Helio PMS — operational database schema
--
-- Conventions
--   · All money is stored in INTEGER MINOR UNITS (cents). Never floats.
--   · All percentages are stored in BASIS POINTS (1% = 100 bp). Never floats.
--   · Dates are 'YYYY-MM-DD' (business dates). Timestamps are ISO-8601 UTC.
--   · Every operational row carries property_id — the system is multi-property.
--   · Nothing here is seeded with demo content. The database starts empty and
--     is populated through the setup wizard / configuration screens.
-- ══════════════════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Tenancy & identity ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS properties (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  legal_name     TEXT,
  kind           TEXT NOT NULL DEFAULT 'hotel',      -- hotel | hostel | mixed
  address        TEXT,
  city           TEXT,
  country        TEXT,
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  currency       TEXT NOT NULL DEFAULT 'USD',
  locale         TEXT NOT NULL DEFAULT 'en',
  business_date  TEXT NOT NULL,                      -- the open operating day
  check_in_time  TEXT NOT NULL DEFAULT '14:00',
  check_out_time TEXT NOT NULL DEFAULT '11:00',
  phone          TEXT,
  email          TEXT,
  website        TEXT,
  tax_id         TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'front_office',
  phone          TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL
);

-- Per-property role assignment (a user may work across a portfolio).
CREATE TABLE IF NOT EXISTS user_properties (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  PRIMARY KEY (user_id, property_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  property_id TEXT REFERENCES properties(id),
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  last_seen_at TEXT,
  ip          TEXT,
  user_agent  TEXT,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  property_id TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,           -- JSON
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (property_id, key)
);

CREATE TABLE IF NOT EXISTS sequences (
  property_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  next_value  INTEGER NOT NULL,
  PRIMARY KEY (property_id, name)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  property_id TEXT,
  ts          TEXT NOT NULL,
  user_id     TEXT,
  user_name   TEXT,
  action      TEXT NOT NULL,           -- reservation.create, rate.bulk-update …
  entity      TEXT NOT NULL,           -- RESERVATION | RATE_PLAN | CHANNEL …
  entity_id   TEXT,
  entity_ref  TEXT,
  channel     TEXT,
  before_json TEXT,
  after_json  TEXT,
  ip          TEXT,
  elevated    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_audit_prop_ts ON audit_log(property_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_audit_entity  ON audit_log(entity, entity_id);

-- ─── Physical inventory ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS room_types (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  kind            TEXT NOT NULL DEFAULT 'room',      -- room | dorm
  base_occupancy  INTEGER NOT NULL DEFAULT 2,
  max_occupancy   INTEGER NOT NULL DEFAULT 2,
  max_adults      INTEGER NOT NULL DEFAULT 2,
  max_children    INTEGER NOT NULL DEFAULT 0,
  default_rate_minor INTEGER NOT NULL DEFAULT 0,
  extra_adult_minor  INTEGER NOT NULL DEFAULT 0,
  extra_child_minor  INTEGER NOT NULL DEFAULT 0,
  amenities       TEXT,                              -- JSON array
  -- What is physically in the room: [{"kind":"king","count":1},…]. Sleeping
  -- capacity is derived from this, not from max_occupancy, which only says how
  -- many guests are permitted rather than where they would sleep.
  bed_config      TEXT,
  gender_policy   TEXT,                              -- dorms: male | female | mixed
  sort_order      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  -- Rooms held back from the channels so the last one cannot be sold twice by
  -- two OTAs racing each other. Zero sells everything, which is the default —
  -- the protection costs occupancy, and that trade is the property's to make.
  protect_last_rooms INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  UNIQUE (property_id, code)
);

CREATE TABLE IF NOT EXISTS rooms (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_type_id TEXT NOT NULL REFERENCES room_types(id),
  number       TEXT NOT NULL,
  floor        INTEGER NOT NULL DEFAULT 0,
  wing         TEXT,
  status       TEXT NOT NULL DEFAULT 'Vacant Clean',
  hk_section   TEXT,
  attendant_id TEXT REFERENCES users(id),
  last_cleaned_at TEXT,
  features     TEXT,                                 -- JSON array
  -- Overrides the type's configuration for this one room. Real properties have
  -- a room with a different bed; without this they need a second room type.
  bed_config   TEXT,
  notes        TEXT,
  connecting_to TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  UNIQUE (property_id, number)
);
CREATE INDEX IF NOT EXISTS ix_rooms_type ON rooms(room_type_id);

-- Individually sellable beds inside a dorm room (hostel inventory).
CREATE TABLE IF NOT EXISTS beds (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  bunk        TEXT NOT NULL DEFAULT 'single',        -- top | bottom | single
  status      TEXT NOT NULL DEFAULT 'Vacant Clean',
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (property_id, code)
);

-- Out-of-order (not sellable, not countable) / out-of-service (not sellable,
-- still counted in inventory) periods — kept as dated rows so availability and
-- statistics are correct historically, not just "right now".
CREATE TABLE IF NOT EXISTS room_blocks (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                         -- OOO | OOS
  from_date   TEXT NOT NULL,
  to_date     TEXT NOT NULL,                         -- exclusive
  reason      TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_room_blocks_dates ON room_blocks(property_id, from_date, to_date);
-- Housekeeping asks "is this specific room blocked right now?" per room.
CREATE INDEX IF NOT EXISTS ix_room_blocks_room ON room_blocks(room_id, released_at);

-- ─── Commercial: rate plans, calendar, restrictions, promos, taxes ───────

CREATE TABLE IF NOT EXISTS rate_plans (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  parent_id     TEXT REFERENCES rate_plans(id),      -- derived / linked rates
  offset_type   TEXT,                                -- percent | fixed
  offset_value  INTEGER NOT NULL DEFAULT 0,          -- bp when percent, minor when fixed
  refundable    INTEGER NOT NULL DEFAULT 1,
  flexible      INTEGER NOT NULL DEFAULT 1,
  kind          TEXT NOT NULL DEFAULT 'public',      -- public | corporate | group | package | member
  market_segment TEXT,
  min_los       INTEGER,
  max_los       INTEGER,
  min_advance   INTEGER,
  max_advance   INTEGER,
  inclusions    TEXT,                                -- JSON array
  company_id    TEXT,                                -- negotiated / corporate owner
  valid_from    TEXT,
  valid_to      TEXT,
  deposit_pct_bp INTEGER NOT NULL DEFAULT 0,
  cancel_policy_id TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (property_id, code)
);

-- Which room types a rate plan sells, and its base price for that type.
CREATE TABLE IF NOT EXISTS rate_plan_room_types (
  rate_plan_id    TEXT NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  room_type_id    TEXT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  base_rate_minor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rate_plan_id, room_type_id)
);

-- One row per (room type, rate plan, date). Absent row = fall back to the
-- rate plan's base rate (or its parent, recursively).
CREATE TABLE IF NOT EXISTS rate_calendar (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_type_id  TEXT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  rate_plan_id  TEXT NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  price_minor   INTEGER NOT NULL,
  occupancy_prices TEXT,                             -- JSON {"1":9000,"2":12000}
  extra_adult_minor INTEGER,
  extra_child_minor INTEGER,
  los_prices    TEXT,                                -- JSON {"7":11000}
  updated_at    TEXT NOT NULL,
  updated_by    TEXT,
  UNIQUE (property_id, room_type_id, rate_plan_id, date)
);
CREATE INDEX IF NOT EXISTS ix_rate_cal_date ON rate_calendar(property_id, date);

-- Inventory the property deliberately holds back or oversells, per date.
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_type_id TEXT NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  overbook     INTEGER NOT NULL DEFAULT 0,           -- extra rooms allowed to sell
  hold         INTEGER NOT NULL DEFAULT 0,           -- rooms withheld from sale
  note         TEXT,
  updated_at   TEXT NOT NULL,
  UNIQUE (property_id, room_type_id, date)
);

CREATE TABLE IF NOT EXISTS restrictions (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_type_id TEXT REFERENCES room_types(id) ON DELETE CASCADE,   -- NULL = all
  rate_plan_id TEXT REFERENCES rate_plans(id) ON DELETE CASCADE,   -- NULL = all
  channel_code TEXT,                                               -- NULL = all
  date_from    TEXT NOT NULL,
  date_to      TEXT NOT NULL,                                      -- inclusive
  type         TEXT NOT NULL,   -- stop-sell|min-stay|max-stay|min-stay-through|cta|ctd|min-advance|max-advance|release
  value        INTEGER,
  note         TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_restr_dates ON restrictions(property_id, date_from, date_to);

CREATE TABLE IF NOT EXISTS yield_rules (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  metric        TEXT NOT NULL,        -- occupancy | lead_time | dow | los
  operator      TEXT NOT NULL,        -- gt | lt | eq | in
  threshold     TEXT NOT NULL,        -- number, or CSV for dow/in
  secondary_metric TEXT,              -- optional AND condition
  secondary_operator TEXT,
  secondary_threshold TEXT,
  adjust_type   TEXT NOT NULL,        -- percent | fixed
  adjust_value  INTEGER NOT NULL,     -- bp when percent, minor when fixed
  rate_plan_id  TEXT REFERENCES rate_plans(id) ON DELETE CASCADE,  -- NULL = all
  room_type_id  TEXT REFERENCES room_types(id) ON DELETE CASCADE,
  priority      INTEGER NOT NULL DEFAULT 0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS promotions (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'basic',  -- basic|early_bird|last_minute|long_stay
  discount_type TEXT NOT NULL,                  -- percent | fixed
  discount_value INTEGER NOT NULL,              -- bp | minor
  stay_from     TEXT,
  stay_to       TEXT,
  book_from     TEXT,
  book_to       TEXT,
  min_los       INTEGER,
  max_los       INTEGER,
  min_advance   INTEGER,
  max_advance   INTEGER,
  rate_plan_ids TEXT,                           -- JSON array; empty = all
  channels      TEXT,                           -- JSON array of channel codes
  delivery_mode TEXT NOT NULL DEFAULT 'price',  -- price | native_promo (OTA rule)
  usage_limit   INTEGER NOT NULL DEFAULT 0,     -- 0 = unlimited
  used_count    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (property_id, code)
);

CREATE TABLE IF NOT EXISTS taxes (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  mode          TEXT NOT NULL,   -- percent | per_night | per_person_night | flat
  value         INTEGER NOT NULL,-- bp when percent, minor otherwise
  applies_to    TEXT NOT NULL DEFAULT 'room',    -- room | fnb | all
  inclusive     INTEGER NOT NULL DEFAULT 0,
  compound_on   TEXT,                            -- CSV of tax codes applied first
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (property_id, code)
);

CREATE TABLE IF NOT EXISTS policies (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'property',
  scope_ref    TEXT,
  summary      TEXT,
  details      TEXT,
  channels     TEXT,                             -- JSON array
  active       INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
);

-- ─── CRM ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS profiles (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'guest',   -- guest | company | agent
  first_name    TEXT,
  last_name     TEXT,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  nationality   TEXT,
  language      TEXT,
  dob           TEXT,
  id_type       TEXT,
  id_number     TEXT,
  id_expiry     TEXT,
  address       TEXT,                            -- JSON
  company_id    TEXT,
  loyalty_tier  TEXT NOT NULL DEFAULT 'None',
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  vip           INTEGER NOT NULL DEFAULT 0,
  blacklist     INTEGER NOT NULL DEFAULT 0,
  blacklist_reason TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  consent_at    TEXT,
  preferences   TEXT,                            -- JSON array
  notes         TEXT,
  merged_into   TEXT REFERENCES profiles(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_profiles_name  ON profiles(property_id, name);
CREATE INDEX IF NOT EXISTS ix_profiles_email ON profiles(property_id, email);

CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'company', -- company | travel_agent | tour_operator | ota
  contact_name  TEXT,
  email         TEXT,
  phone         TEXT,
  address       TEXT,
  tax_id        TEXT,
  ar_enabled    INTEGER NOT NULL DEFAULT 0,
  credit_limit_minor INTEGER NOT NULL DEFAULT 0,
  commission_bp INTEGER NOT NULL DEFAULT 0,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (property_id, code)
);

-- ─── Groups & blocks ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS groups (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  company_id    TEXT REFERENCES companies(id),
  contact_name  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  arrival       TEXT NOT NULL,
  departure     TEXT NOT NULL,
  cutoff_date   TEXT,
  rate_plan_id  TEXT REFERENCES rate_plans(id),
  status        TEXT NOT NULL DEFAULT 'tentative', -- tentative|definite|cancelled|closed
  master_folio  INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (property_id, code)
);

CREATE TABLE IF NOT EXISTS group_blocks (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  room_type_id TEXT NOT NULL REFERENCES room_types(id),
  date         TEXT NOT NULL,
  blocked      INTEGER NOT NULL DEFAULT 0,
  rate_minor   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (group_id, room_type_id, date)
);

CREATE TABLE IF NOT EXISTS waitlist (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  guest_name   TEXT NOT NULL,
  email        TEXT,
  phone        TEXT,
  arrival      TEXT NOT NULL,
  departure    TEXT NOT NULL,
  room_type_id TEXT REFERENCES room_types(id),
  adults       INTEGER NOT NULL DEFAULT 1,
  children     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'waiting',   -- waiting|offered|converted|expired
  note         TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);

-- ─── Reservations ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reservations (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  confirmation   TEXT NOT NULL,
  status         TEXT NOT NULL,        -- Tentative|Confirmed|Guaranteed|Checked-in|Checked-out|Cancelled|No-show
  profile_id     TEXT REFERENCES profiles(id),
  guest_name     TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  arrival        TEXT NOT NULL,
  departure      TEXT NOT NULL,        -- exclusive (departure date, not a night)
  nights         INTEGER NOT NULL,
  adults         INTEGER NOT NULL DEFAULT 1,
  children       INTEGER NOT NULL DEFAULT 0,
  room_type_id   TEXT NOT NULL REFERENCES room_types(id),
  room_id        TEXT REFERENCES rooms(id),
  bed_id         TEXT REFERENCES beds(id),
  rate_plan_id   TEXT NOT NULL REFERENCES rate_plans(id),
  source         TEXT NOT NULL DEFAULT 'Direct',
  channel_code   TEXT,
  ota_reference  TEXT,
  segment        TEXT,
  company_id     TEXT REFERENCES companies(id),
  group_id       TEXT REFERENCES groups(id),
  vip            INTEGER NOT NULL DEFAULT 0,
  eta            TEXT,
  etd            TEXT,
  special_requests TEXT,
  preferences    TEXT,                 -- JSON array
  payment_method TEXT,
  card_last4     TEXT,
  deposit_required_minor INTEGER NOT NULL DEFAULT 0,
  commission_minor INTEGER NOT NULL DEFAULT 0,
  total_minor    INTEGER NOT NULL DEFAULT 0,   -- room revenue for the stay
  promotion_id   TEXT REFERENCES promotions(id),
  currency       TEXT NOT NULL DEFAULT 'USD',
  origin         TEXT NOT NULL DEFAULT 'pms',  -- pms | channel | booking_engine
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  checked_in_at  TEXT,
  checked_out_at TEXT,
  cancelled_at   TEXT,
  cancel_reason  TEXT,
  no_show_at     TEXT,
  parent_id      TEXT REFERENCES reservations(id),   -- split / shared bookings
  UNIQUE (property_id, confirmation)
);
CREATE INDEX IF NOT EXISTS ix_res_dates  ON reservations(property_id, arrival, departure);
-- The two trailing columns are the list's sort order, so a status-filtered page
-- is walked rather than sorted. Widening this again means updating the matching
-- ensureIndex() call in db.ts — otherwise existing databases keep the old one.
CREATE INDEX IF NOT EXISTS ix_res_status ON reservations(property_id, status, arrival, guest_name);
CREATE INDEX IF NOT EXISTS ix_res_room   ON reservations(room_id);
CREATE INDEX IF NOT EXISTS ix_res_profile ON reservations(profile_id);
-- Group operations and the "is this room type still in use?" guard both scanned
-- the whole table before these existed. See `npm run query-plan`.
CREATE INDEX IF NOT EXISTS ix_res_group  ON reservations(group_id);
CREATE INDEX IF NOT EXISTS ix_res_rtype  ON reservations(room_type_id);
-- The reservation list sorts by (arrival, guest_name). Without guest_name in an
-- index SQLite cannot satisfy that ordering by walking, so it materialised every
-- reservation for the property into a temp b-tree, sorted it, and threw away all
-- but the fifty rows the page asked for — and because it had to sort anyway it
-- was free to drive the join from `rate_plans`, scanning reservations once per
-- rate plan. This index makes the ordering walkable, so the planner starts at
-- `reservations` and stops after the page is full. See `npm run bench -- --profile`.
CREATE INDEX IF NOT EXISTS ix_res_list ON reservations(property_id, arrival, guest_name);

-- One row per night: the unit of availability, pricing and posting.
-- Supports multi-rate stays, mid-stay room moves and per-night yield.
CREATE TABLE IF NOT EXISTS reservation_nights (
  id             TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  property_id    TEXT NOT NULL,
  date           TEXT NOT NULL,
  room_type_id   TEXT NOT NULL REFERENCES room_types(id),
  room_id        TEXT REFERENCES rooms(id),
  bed_id         TEXT REFERENCES beds(id),
  rate_plan_id   TEXT NOT NULL REFERENCES rate_plans(id),
  rate_minor     INTEGER NOT NULL,
  adults         INTEGER NOT NULL DEFAULT 1,
  children       INTEGER NOT NULL DEFAULT 0,
  posted         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (reservation_id, date)
);
CREATE INDEX IF NOT EXISTS ix_resn_date ON reservation_nights(property_id, date);
-- Deleting or deactivating a room or bed checks whether it was ever slept in.
CREATE INDEX IF NOT EXISTS ix_resn_room ON reservation_nights(room_id);
CREATE INDEX IF NOT EXISTS ix_resn_bed  ON reservation_nights(bed_id);
-- The tape chart and the per-reservation night list both read by reservation.
CREATE INDEX IF NOT EXISTS ix_resn_res  ON reservation_nights(reservation_id, date);

CREATE TABLE IF NOT EXISTS reservation_guests (
  id             TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  profile_id     TEXT REFERENCES profiles(id),
  name           TEXT NOT NULL,
  is_primary     INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL DEFAULT 'adult',   -- adult | child
  registered     INTEGER NOT NULL DEFAULT 0,
  id_number      TEXT,
  created_at     TEXT NOT NULL
);

-- Scanned identity documents and the signature taken at check-in.
--
-- `data` holds the image, encrypted at rest by lib/secrets.ts exactly as
-- channel credentials are: a copy of the database file, or of any backup made
-- from it, is not a folder of readable passport photographs.
--
-- Rows are deleted automatically once the reservation has departed and the
-- retention window has passed — see services/documents.ts. Holding a passport
-- scan for ever is a liability rather than an asset.
CREATE TABLE IF NOT EXISTS reservation_documents (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  guest_name     TEXT,
  kind           TEXT NOT NULL,          -- identity | signature
  label          TEXT,                   -- "Passport", "Driving licence"
  mime           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  data           TEXT NOT NULL,          -- encrypted; never returned in a list
  uploaded_at    TEXT NOT NULL,
  uploaded_by    TEXT
);

CREATE INDEX IF NOT EXISTS ix_resdoc_reservation
  ON reservation_documents(property_id, reservation_id);

CREATE TABLE IF NOT EXISTS reservation_notes (
  id             TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  ts             TEXT NOT NULL,
  user_name      TEXT,
  category       TEXT NOT NULL DEFAULT 'general',
  body           TEXT NOT NULL
);

-- ─── Folios / cashiering ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transaction_codes (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,  -- room | fnb | tax | payment | misc | commission
  default_price_minor INTEGER NOT NULL DEFAULT 0,
  taxable       INTEGER NOT NULL DEFAULT 1,
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (property_id, code)
);

CREATE TABLE IF NOT EXISTS folios (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  reservation_id TEXT REFERENCES reservations(id) ON DELETE CASCADE,
  group_id       TEXT REFERENCES groups(id),
  company_id     TEXT REFERENCES companies(id),
  number         TEXT NOT NULL,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'guest',   -- guest | master | company | house
  window_no      INTEGER NOT NULL DEFAULT 1,      -- split folio window
  status         TEXT NOT NULL DEFAULT 'open',    -- open | closed
  opened_at      TEXT NOT NULL,
  closed_at      TEXT,
  UNIQUE (property_id, number)
);
CREATE INDEX IF NOT EXISTS ix_folio_res ON folios(reservation_id);
CREATE INDEX IF NOT EXISTS ix_folio_group ON folios(group_id);

CREATE TABLE IF NOT EXISTS folio_lines (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL,
  folio_id       TEXT NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  reservation_id TEXT,
  business_date  TEXT NOT NULL,
  posted_at      TEXT NOT NULL,
  kind           TEXT NOT NULL,   -- charge | tax | payment | adjustment | transfer
  code           TEXT NOT NULL,
  description    TEXT NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 1,
  unit_minor     INTEGER NOT NULL DEFAULT 0,
  amount_minor   INTEGER NOT NULL,   -- +charge, −payment/credit
  method         TEXT,               -- payment method
  reference      TEXT,
  parent_line_id TEXT,               -- tax lines point at the charge they tax
  posted_by      TEXT,
  voided         INTEGER NOT NULL DEFAULT 0,
  void_of        TEXT,
  routed_from    TEXT,
  UNIQUE (id)
);
CREATE INDEX IF NOT EXISTS ix_lines_folio ON folio_lines(folio_id);
CREATE INDEX IF NOT EXISTS ix_lines_date  ON folio_lines(property_id, business_date);
-- Voiding a charge has to find the tax and fee lines derived from it.
CREATE INDEX IF NOT EXISTS ix_lines_parent ON folio_lines(parent_line_id);

-- Automatic charge routing (guest folio → company / master folio).
CREATE TABLE IF NOT EXISTS folio_routing (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  target_folio_id TEXT NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  codes          TEXT NOT NULL,     -- JSON array of transaction codes, ["*"] = all
  limit_minor    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  folio_id      TEXT NOT NULL REFERENCES folios(id),
  number        TEXT NOT NULL,
  issued_at     TEXT NOT NULL,
  due_at        TEXT,
  bill_to       TEXT NOT NULL,
  bill_address  TEXT,
  company_id    TEXT REFERENCES companies(id),
  net_minor     INTEGER NOT NULL,
  tax_minor     INTEGER NOT NULL,
  total_minor   INTEGER NOT NULL,
  paid_minor    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'issued',  -- issued | paid | void | ar
  currency      TEXT NOT NULL,
  created_by    TEXT,
  UNIQUE (property_id, number)
);

-- City ledger / accounts receivable.
CREATE TABLE IF NOT EXISTS ar_transactions (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL REFERENCES companies(id),
  invoice_id   TEXT REFERENCES invoices(id),
  date         TEXT NOT NULL,
  kind         TEXT NOT NULL,     -- charge | payment | adjustment
  amount_minor INTEGER NOT NULL,
  reference    TEXT,
  note         TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cashier_shifts (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  opened_at    TEXT NOT NULL,
  closed_at    TEXT,
  opening_float_minor INTEGER NOT NULL DEFAULT 0,
  counted_minor INTEGER,
  expected_minor INTEGER,
  variance_minor INTEGER,
  note         TEXT
);

-- ─── Housekeeping & maintenance ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hk_tasks (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'stayover',  -- departure|stayover|deep|turndown|inspection
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending|in-progress|done|inspected|blocked
  assignee_id  TEXT REFERENCES users(id),
  section      TEXT,
  priority     TEXT NOT NULL DEFAULT 'normal',
  credits      INTEGER NOT NULL DEFAULT 1,
  started_at   TEXT,
  finished_at  TEXT,
  inspected_by TEXT,
  inspected_at TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (property_id, date, room_id, type)
);
CREATE INDEX IF NOT EXISTS ix_hk_date ON hk_tasks(property_id, date);

CREATE TABLE IF NOT EXISTS work_orders (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id      TEXT REFERENCES rooms(id),
  location     TEXT,
  category     TEXT NOT NULL DEFAULT 'maintenance',
  priority     TEXT NOT NULL DEFAULT 'normal',
  status       TEXT NOT NULL DEFAULT 'open',   -- open|assigned|in-progress|resolved|closed
  title        TEXT NOT NULL,
  description  TEXT,
  reported_by  TEXT,
  assigned_to  TEXT REFERENCES users(id),
  blocks_room  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT,
  resolution   TEXT
);

CREATE TABLE IF NOT EXISTS lost_found (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id      TEXT REFERENCES rooms(id),
  found_on     TEXT NOT NULL,
  found_by     TEXT,
  description  TEXT NOT NULL,
  storage_ref  TEXT,
  status       TEXT NOT NULL DEFAULT 'stored',  -- stored|returned|disposed
  profile_id   TEXT REFERENCES profiles(id),
  returned_at  TEXT,
  note         TEXT
);

-- ─── Night audit & statistics ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_runs (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  business_date TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running', -- running|completed|failed
  user_id       TEXT,
  user_name     TEXT,
  summary       TEXT,                            -- JSON
  error         TEXT,
  UNIQUE (property_id, business_date)
);

CREATE TABLE IF NOT EXISTS daily_stats (
  id                  TEXT PRIMARY KEY,
  property_id         TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  date                TEXT NOT NULL,
  rooms_total         INTEGER NOT NULL,
  rooms_ooo           INTEGER NOT NULL,
  rooms_sold          INTEGER NOT NULL,
  occupancy_bp        INTEGER NOT NULL,
  room_revenue_minor  INTEGER NOT NULL,
  other_revenue_minor INTEGER NOT NULL,
  tax_minor           INTEGER NOT NULL,
  payments_minor      INTEGER NOT NULL,
  adr_minor           INTEGER NOT NULL,
  revpar_minor        INTEGER NOT NULL,
  arrivals            INTEGER NOT NULL,
  departures          INTEGER NOT NULL,
  no_shows            INTEGER NOT NULL,
  cancellations       INTEGER NOT NULL,
  in_house            INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (property_id, date)
);

CREATE TABLE IF NOT EXISTS budgets (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  rooms_sold   INTEGER NOT NULL DEFAULT 0,
  room_revenue_minor INTEGER NOT NULL DEFAULT 0,
  UNIQUE (property_id, date)
);

-- ─── Channel manager ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'ota',   -- ota|metasearch|hostel|wholesaler|direct|ical
  active         INTEGER NOT NULL DEFAULT 0,
  commission_bp  INTEGER NOT NULL DEFAULT 0,
  price_multiplier_bp INTEGER NOT NULL DEFAULT 10000,  -- channel uplift (10000 = ×1.0)
  currency       TEXT,
  allotment      INTEGER,                       -- NULL = pooled inventory
  external_property_id TEXT,
  status         TEXT NOT NULL DEFAULT 'not-configured', -- not-configured|connected|error|paused
  last_sync_at   TEXT,
  last_error     TEXT,
  settings       TEXT,                          -- JSON, per-channel options
  created_at     TEXT NOT NULL,
  UNIQUE (property_id, code)
);

CREATE TABLE IF NOT EXISTS channel_mappings (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL,
  channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  room_type_id   TEXT REFERENCES room_types(id) ON DELETE CASCADE,
  rate_plan_id   TEXT REFERENCES rate_plans(id) ON DELETE CASCADE,
  external_room_id TEXT,
  external_rate_id TEXT,
  external_name  TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_map_channel ON channel_mappings(channel_id);

CREATE TABLE IF NOT EXISTS channel_sync_log (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL,
  channel_id   TEXT REFERENCES channels(id) ON DELETE CASCADE,
  channel_code TEXT,
  ts           TEXT NOT NULL,
  direction    TEXT NOT NULL,        -- push | pull
  action       TEXT NOT NULL,
  status       TEXT NOT NULL,        -- success | failed | pending | skipped
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  attempt      INTEGER NOT NULL DEFAULT 1,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS ix_synclog_ts ON channel_sync_log(property_id, ts DESC);
-- Channel health counts push/pull success and failure per channel over a
-- window. This log is append-only and grows fastest of any table.
CREATE INDEX IF NOT EXISTS ix_synclog_channel ON channel_sync_log(channel_id, ts DESC);

CREATE TABLE IF NOT EXISTS channel_queue (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL,
  channel_id   TEXT REFERENCES channels(id) ON DELETE CASCADE,
  room_type_id TEXT,
  date_from    TEXT NOT NULL,
  date_to      TEXT NOT NULL,
  scope        TEXT NOT NULL,        -- availability | rates | restrictions | all
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',  -- queued|sent|failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  sent_at      TEXT
);

CREATE TABLE IF NOT EXISTS channel_conflicts (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL,
  channel_code  TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  ota_reference TEXT,
  guest_name    TEXT,
  raw_payload   TEXT,
  room_type_raw TEXT,
  rate_plan_raw TEXT,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',   -- open|resolved|ignored
  resolved_at   TEXT,
  resolved_by   TEXT
);

CREATE TABLE IF NOT EXISTS channel_content (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL,
  channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  short_name    TEXT,
  description   TEXT,
  amenities     TEXT,                            -- JSON array
  photo_count   INTEGER NOT NULL DEFAULT 0,
  cancellation_policy TEXT,
  max_occupancy INTEGER,
  min_stay      INTEGER,
  max_stay      INTEGER,
  deposit_pct_bp INTEGER NOT NULL DEFAULT 0,
  language      TEXT NOT NULL DEFAULT 'en',
  updated_at    TEXT NOT NULL,
  UNIQUE (channel_id, language)
);

-- ─── Notifications & tasks (operational, generated from real state) ──────

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ts          TEXT NOT NULL,
  title       TEXT NOT NULL,
  message     TEXT,
  source      TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'info',
  read_at     TEXT,
  user_id     TEXT,
  link        TEXT
);
CREATE INDEX IF NOT EXISTS ix_notif ON notifications(property_id, ts DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Front Office',
  due_at      TEXT,
  assignee_id TEXT REFERENCES users(id),
  priority    TEXT NOT NULL DEFAULT 'normal',
  status      TEXT NOT NULL DEFAULT 'open',
  link        TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  done_at     TEXT
);

-- ─── Guest messaging (unified thread per reservation/profile) ────────────

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  reservation_id TEXT REFERENCES reservations(id) ON DELETE CASCADE,
  profile_id     TEXT REFERENCES profiles(id),
  channel        TEXT NOT NULL DEFAULT 'internal', -- email|sms|whatsapp|ota|internal
  direction      TEXT NOT NULL,                    -- in | out
  subject        TEXT,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'sent',     -- draft|queued|sent|failed|read
  author         TEXT,
  ts             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_msg_res ON messages(reservation_id, ts);
-- The inbox reads `WHERE property_id = ? ORDER BY ts DESC LIMIT 200`. Without
-- this it scanned every message and sorted the lot to show the newest page —
-- harmless at today's volume, and not harmless at all once OTA conversations
-- are flowing through here. SQLite walks the index backwards for DESC, so the
-- ordinary ascending form is enough.
CREATE INDEX IF NOT EXISTS ix_msg_inbox ON messages(property_id, ts);

-- Canned replies. A front desk sends the same handful of messages fifty times a
-- week; retyping them is where typos and inconsistent tone come from.
CREATE TABLE IF NOT EXISTS message_templates (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,           -- may contain {{guest}}, {{room}}, {{arrival}} …
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (property_id, code)
);

-- ─── Overbooking control ─────────────────────────────────────

-- One row per distinct problem, not per scan. The natural key below is what
-- makes a finding stable: the same oversell seen twenty times is one finding
-- that has been seen twenty times, not twenty findings. Without that, a desk
-- that scans every minute drowns.
CREATE TABLE IF NOT EXISTS overbookings (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,        -- type | room | bed | at-risk
  date           TEXT NOT NULL,
  room_type_id   TEXT REFERENCES room_types(id) ON DELETE CASCADE,
  room_id        TEXT,                 -- room-level clash
  bed_id         TEXT,                 -- bed-level clash
  oversold       INTEGER NOT NULL DEFAULT 0,
  sellable       INTEGER,
  sold           INTEGER,
  cause          TEXT,                 -- failed-push|blocked-room|allowance|race|assignment|unknown
  severity       TEXT NOT NULL,        -- critical | urgent | warning | info
  status         TEXT NOT NULL DEFAULT 'open',   -- open|resolved|auto-resolved|ignored
  reservations   TEXT,                 -- JSON array of the bookings involved
  resolution     TEXT,
  note           TEXT,
  channels_closed_at TEXT,             -- when the dates were shut on the OTAs
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  resolved_at    TEXT,
  resolved_by    TEXT,
  UNIQUE (property_id, kind, date, room_type_id, room_id, bed_id)
);
CREATE INDEX IF NOT EXISTS ix_overbook_open
  ON overbookings(property_id, status, date);

-- Every overbooking fixed without walking anybody, and what the courtesy cost.
-- A property that knows a season of upgrades cost less than two walks can argue
-- for the upgrade policy with numbers rather than instinct.
CREATE TABLE IF NOT EXISTS overbooking_fixes (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  overbooking_id TEXT,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,        -- reassign | upgrade | downgrade
  from_room_type_id TEXT,
  to_room_type_id   TEXT,
  room_id        TEXT,
  rate_difference_minor INTEGER NOT NULL DEFAULT 0,
  compensation_minor    INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  applied_by     TEXT,
  applied_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ovb_fixes ON overbooking_fixes(property_id, applied_at);

-- A guest who had to be sent elsewhere, and what it cost. The point of keeping
-- this is that a property which cannot say what overbooking cost it last year
-- cannot decide what allowance is sensible.
CREATE TABLE IF NOT EXISTS walked_guests (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  overbooking_id TEXT,
  walked_on      TEXT NOT NULL,        -- the night they could not stay
  nights         INTEGER NOT NULL DEFAULT 1,
  hotel_name     TEXT,
  hotel_phone    TEXT,
  room_cost_minor      INTEGER NOT NULL DEFAULT 0,
  transport_cost_minor INTEGER NOT NULL DEFAULT 0,
  compensation_minor   INTEGER NOT NULL DEFAULT 0,
  returns_later  INTEGER NOT NULL DEFAULT 0,   -- coming back for the later nights
  reason         TEXT,
  authorised_by  TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_walked ON walked_guests(property_id, walked_on);

-- The feed the app polls, and what the alarms fire from.
CREATE TABLE IF NOT EXISTS alert_events (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  ts             TEXT NOT NULL,
  kind           TEXT NOT NULL,        -- overbooking | booking.new | booking.cancelled
  severity       TEXT NOT NULL DEFAULT 'info',
  title          TEXT NOT NULL,
  body           TEXT,
  reservation_id TEXT,
  overbooking_id TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_alert_feed ON alert_events(property_id, ts);

-- ─── Price planning ──────────────────────────────────────────

-- A named, reusable date range that rates hang off — High, Shoulder, Low.
-- Seasons do not price anything by themselves; they are the vocabulary a
-- property already thinks in, so a rate change can say "High season" instead of
-- a date range retyped from memory every time.
CREATE TABLE IF NOT EXISTS rate_seasons (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  colour      TEXT,
  date_from   TEXT NOT NULL,
  date_to     TEXT NOT NULL,                 -- inclusive
  priority    INTEGER NOT NULL DEFAULT 0,    -- higher wins where seasons overlap
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_season_dates ON rate_seasons(property_id, date_from, date_to);

-- A rate change with an effective date, applied by the scheduler rather than
-- by somebody remembering. The payload is the same input the immediate bulk
-- change takes, so a scheduled change and a manual one cannot drift apart.
CREATE TABLE IF NOT EXISTS scheduled_rate_changes (
  id             TEXT PRIMARY KEY,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  payload        TEXT NOT NULL,                       -- bulk-change input as JSON
  status         TEXT NOT NULL DEFAULT 'scheduled',   -- scheduled|applied|cancelled|failed
  cells_changed  INTEGER,
  error          TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL,
  applied_at     TEXT,
  cancelled_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_sched_due
  ON scheduled_rate_changes(property_id, status, effective_date);

-- Every price movement, so "who changed this, when, and from what" has an
-- answer. The audit log records that a bulk edit happened; this records what it
-- did to each cell, which is the question actually asked when a rate looks wrong.
CREATE TABLE IF NOT EXISTS rate_history (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_type_id TEXT NOT NULL,
  rate_plan_id TEXT NOT NULL,
  date         TEXT NOT NULL,
  old_minor    INTEGER,                      -- NULL when the cell was inherited
  new_minor    INTEGER NOT NULL,
  source       TEXT NOT NULL,                -- bulk|scheduled|copy|single|clear
  reason       TEXT,
  changed_by   TEXT,
  changed_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rate_hist_cell
  ON rate_history(property_id, room_type_id, rate_plan_id, date, changed_at);
CREATE INDEX IF NOT EXISTS ix_rate_hist_when ON rate_history(property_id, changed_at);

-- ─── Authentication extras ───────────────────────────────────

-- Single-use recovery codes for two-factor authentication. Only a hash is
-- stored, so the list cannot be read back out of the database.
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_recovery_user ON mfa_recovery_codes(user_id);

-- Password reset requests. The raw token is shown once to whoever issues it;
-- only its hash is kept.
CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  requested_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  requested_ip TEXT,
  issued_by   TEXT
);
CREATE INDEX IF NOT EXISTS ix_reset_user ON password_resets(user_id);

-- Every sign-in attempt, successful or not — the security log.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  user_id    TEXT,
  ts         TEXT NOT NULL,
  outcome    TEXT NOT NULL,   -- success | bad-password | unknown-user | locked | disabled | mfa-failed
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS ix_login_ts ON login_attempts(ts DESC);
CREATE INDEX IF NOT EXISTS ix_login_email ON login_attempts(email, ts DESC);
-- A user's own security log reads by user_id, newest first.
CREATE INDEX IF NOT EXISTS ix_login_user ON login_attempts(user_id, ts DESC);

-- ─── Backups ─────────────────────────────────────────────────

-- One row per snapshot taken. A backup that was not verified after writing is
-- recorded as such rather than counted as a good one.
CREATE TABLE IF NOT EXISTS backups (
  id                TEXT PRIMARY KEY,
  filename          TEXT NOT NULL,
  path              TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  source_size_bytes INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'running',  -- running|verified|failed
  verification      TEXT,                             -- integrity_check result
  row_checks        TEXT,                             -- JSON of table counts proved readable
  reason            TEXT NOT NULL,                    -- scheduled|night-audit|manual|pre-restore
  triggered_by      TEXT,
  error             TEXT,
  pruned_at         TEXT
);
CREATE INDEX IF NOT EXISTS ix_backups_started ON backups(started_at DESC);

-- Structural checks of the database itself. One row per run, kept a year, so
-- "when did this last pass?" has an answer that is not a guess.
CREATE TABLE IF NOT EXISTS db_checks (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  ok            INTEGER NOT NULL DEFAULT 0,
  integrity     TEXT,                             -- 'ok' or SQLite's complaint
  fk_violations TEXT,                             -- JSON array, empty when clean
  triggered_by  TEXT
);
CREATE INDEX IF NOT EXISTS ix_db_checks_at ON db_checks(at DESC);

-- ─── Schema versioning ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
