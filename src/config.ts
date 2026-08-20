// ─────────────────────────────────────────────────────────────
// Every setting this server has.
//
// One declaration per variable: its type, its default, what it changes, and
// which environments have to supply it. Nothing else in the server reads
// `process.env` — a value that is not declared here does not exist, and a
// value that is declared here has already been checked by the time any code
// can see it.
//
// Importing this module loads the `.env` cascade and validates the result. If
// anything is wrong the process prints every problem at once and exits, rather
// than starting in a shape nobody chose and failing later somewhere unrelated.
//
// To add a setting: add an entry, use `config.yourSetting`, and run
// `npm run config:example` to refresh `.env.example`. There is no second place
// to update.
// ─────────────────────────────────────────────────────────────
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadEnv, modeFrom, resolve_, unknownVars, formatProblems,
  str, int, intOrOff, bool, url, list, path_, secret,
  type Schema, type Mode, type Problem, type Origin,
} from './lib/env.ts';

/** The `backend/` directory, so relative paths mean the same from any cwd. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const MODE: Mode = modeFrom(process.env.NODE_ENV);

/**
 * Where the `.env` cascade is read from. Defaults to `backend/`.
 *
 * Read straight from `process.env` rather than through the schema below,
 * because it decides where the schema's own values come from — it cannot be
 * one of them. Set it when the files live somewhere other than the source
 * tree: a mounted secrets volume, `/etc/helio`, or a test fixture directory.
 */
const ENV_DIR = resolve(ROOT, process.env.HELIO_ENV_DIR?.trim() || '.');

const loaded = loadEnv(ENV_DIR, MODE);

// A browser blocks a cross-origin call in a way the app cannot tell apart from
// the API being down, so the defaults cover every port the front end is served
// on: `vite dev` (3000), `vite preview` (4173) and Vite's own default (5173).
const DEFAULT_ORIGINS = [
  'http://localhost:3000', 'http://127.0.0.1:3000',
  'http://localhost:4173', 'http://127.0.0.1:4173',
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'https://main.d2ghlmlthkq8hn.amplifyapp.com',
];

const SCHEMA = {
  // ─── Server ────────────────────────────────────────────────
  port: {
    env: 'PORT', kind: int({ min: 1, max: 65535 }), fallback: 8080,
    group: 'Server',
    doc: 'TCP port the API listens on.',
    example: '8080',
  },

  corsOrigins: {
    env: 'CORS_ORIGIN', kind: list(url(), { min: 1 }), fallback: DEFAULT_ORIGINS,
    group: 'Server',
    doc: 'Comma-separated list of web origins allowed to call this API. '
      + 'Set it to exactly the address the front end is served from; anything '
      + 'not on the list gets a browser CORS failure that looks, from the app, '
      + 'identical to the server being down.',
    example: 'https://pms.example.com',
    review(value: string[], mode: Mode) {
      if (mode !== 'production') return;
      const local = value.filter((o) => /localhost|127\.0\.0\.1/.test(o));
      if (local.length) {
        return `allows ${local.length} local origin(s) in production (${local.join(', ')}). `
          + 'Anything running on the operator\'s own machine can call this API with their cookies.';
      }
    },
  },

  // ─── Storage ───────────────────────────────────────────────
  databasePath: {
    env: 'HELIO_DB', kind: path_(ROOT), fallback: join(ROOT, 'data', 'helio.db'),
    group: 'Storage',
    doc: 'SQLite file holding everything — reservations, folios, audit trail. '
      + 'Relative paths resolve against the backend directory. The file and its '
      + 'directory are created on first boot.',
    example: './data/helio.db',
  },

  backupEnabled: {
    env: 'HELIO_BACKUP_ENABLED', kind: bool(), fallback: true,
    group: 'Storage',
    doc: 'Whether the scheduled snapshot job runs. Turning this off on a machine '
      + 'holding real bookings leaves the database as the only copy.',
    review(value: boolean, mode: Mode) {
      if (!value && mode === 'production') {
        return 'backups are disabled in production — the database is the only copy of the ledger.';
      }
    },
  },

  backupDir: {
    env: 'HELIO_BACKUP_DIR', kind: path_(ROOT),
    group: 'Storage',
    doc: 'Where snapshots are written. Defaults to a sibling of the database '
      + 'directory (so it follows HELIO_DB rather than staying put), which means '
      + 'a backup survives losing the data directory but not the disk — point it '
      + 'at other storage for that.',
    example: './backups',
  },

  backupIntervalHours: {
    env: 'HELIO_BACKUP_INTERVAL_HOURS', kind: int({ min: 1, max: 168 }), fallback: 6,
    group: 'Storage',
    doc: 'Hours between scheduled snapshots. This is also the worst-case amount '
      + 'of work a restore can lose.',
  },

  // ─── Secrets ───────────────────────────────────────────────
  secretKey: {
    env: 'HELIO_SECRET_KEY', kind: secret({ min: 16 }), required: 'production' as const,
    group: 'Secrets', secret: true,
    doc: 'Encrypts channel and payment credentials at rest. Without it they are '
      + 'stored as clear text in the database and therefore in every backup. '
      + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))". '
      + 'Losing it makes existing encrypted credentials unreadable, so keep it '
      + 'with your other secrets and not in the repository.',
    // Sixteen is the length the cipher code has always accepted, so raising it
    // to a hard error would lock out a working installation on upgrade. The
    // warning says the same thing without doing that.
    review(value: string, mode: Mode) {
      if (mode === 'production' && value.length < 32) {
        return `is only ${value.length} characters. Use 64 hex characters (32 random bytes) `
          + 'so the derived key has full strength.';
      }
    },
  },

  webhookSecret: {
    env: 'HELIO_WEBHOOK_SECRET', kind: secret({ min: 16 }),
    group: 'Secrets', secret: true,
    doc: 'Shared secret used to verify inbound channel webhooks. When it is '
      + 'absent, webhook signatures are not checked and anyone who can reach the '
      + 'endpoint can post a booking into your system.',
  },

  // ─── Channel manager ───────────────────────────────────────
  beds24Api: {
    env: 'BEDS24_API', kind: url(), fallback: 'https://api.beds24.com/v2',
    group: 'Channel manager',
    doc: 'Base URL of the channel manager API. Only worth changing to point at a '
      + 'sandbox or a recorded fixture server during testing.',
  },

  beds24RefreshToken: {
    env: 'BEDS24_REFRESH_TOKEN', kind: secret({ min: 8 }),
    group: 'Channel manager', secret: true,
    doc: 'A long-lived refresh token connects the channel on startup with no UI '
      + 'step. It controls your entire OTA distribution — rates, availability and '
      + 'bookings — so treat it like a password. Only used when the installation '
      + 'has exactly one property; with several, connect from the channel manager '
      + 'screen so the right one is chosen.',
  },

  beds24TimeoutMs: {
    env: 'BEDS24_TIMEOUT_MS', kind: int({ min: 1000, max: 120_000 }), fallback: 20_000,
    group: 'Channel manager',
    doc: 'How long any single channel call may take before it is abandoned. Too '
      + 'low and a slow but healthy OTA looks like an outage; too high and a '
      + 'hung call holds up the queue behind it.',
  },

  channelReadonly: {
    env: 'HELIO_CHANNEL_READONLY', kind: bool(), fallback: false,
    group: 'Channel manager',
    doc: 'Stops the server pushing rates and availability to the OTAs. Use it on '
      + 'a staging copy of production data, where a push would overwrite the live '
      + 'property\'s inventory from a test machine.',
    review(value: boolean, mode: Mode) {
      if (value && mode === 'production') {
        return 'channel pushes are disabled — rates and availability will not reach the OTAs.';
      }
    },
  },

  channelHubName: {
    env: 'HELIO_CHANNEL_HUB_NAME', kind: str({ min: 1, max: 60 }), fallback: 'The channel manager',
    group: 'Channel manager',
    doc: 'What the distribution partner is called anywhere a user can read it. '
      + 'The default hides the supplier\'s name from customers; set it to the real '
      + 'name on an internal build where the setup instructions are easier to '
      + 'follow with it. Must match VITE_CHANNEL_HUB_NAME in the front end.',
  },

  channelName: {
    env: 'HELIO_CHANNEL_NAME', kind: str({ min: 1, max: 60 }), fallback: 'Distribution',
    group: 'Channel manager',
    doc: 'The label given to the automatically created channel record on a '
      + 'property that connects through a refresh token.',
  },

  channelRetryMinutes: {
    env: 'HELIO_CHANNEL_RETRY_MINUTES', kind: int({ min: 1, max: 360 }), fallback: 15,
    group: 'Channel manager',
    doc: 'Base wait before a parked channel update is retried. The wait backs off '
      + 'from here up to a six-hour ceiling.',
  },

  channelDrainSeconds: {
    env: 'HELIO_CHANNEL_DRAIN_SECONDS', kind: intOrOff({ min: 5, max: 3600 }), fallback: 60,
    group: 'Channel manager',
    doc: 'How often the queue of pending channel updates is drained. A property '
      + 'with no connected channel does no work here at all. Set it to 0 to stop '
      + 'the drain entirely, which is what the verification suite does so a '
      + 'background push cannot interfere with a test.',
  },

  // ─── Scheduled work ────────────────────────────────────────
  bookingPollSeconds: {
    env: 'HELIO_BOOKING_POLL_SECONDS', kind: intOrOff({ min: 10, max: 3600 }), fallback: 60,
    group: 'Scheduled work',
    doc: 'How often new and changed OTA bookings are imported. Each poll asks '
      + 'only for what changed since the last successful import, so a quiet '
      + 'minute costs one small call. Set it to 0 to stop importing.',
  },

  messagePollSeconds: {
    env: 'HELIO_MESSAGE_POLL_SECONDS', kind: intOrOff({ min: 30, max: 3600 }), fallback: 300,
    group: 'Scheduled work',
    doc: 'How often guest messages are pulled from the channels. Deliberately '
      + 'slower than the rate queue: messages are conversational rather than '
      + 'perishable, and each poll costs a channel credit per booking. Set it '
      + 'to 0 to stop polling.',
  },

  nightAuditAuto: {
    env: 'HELIO_NIGHT_AUDIT_AUTO', kind: bool(), fallback: true,
    group: 'Scheduled work',
    doc: 'Whether the night audit runs by itself. It never forces: a property '
      + 'with arrivals that were neither checked in nor cancelled is left alone '
      + 'and raises a notification, because that is a judgement for a person.',
  },

  nightAuditHour: {
    env: 'HELIO_NIGHT_AUDIT_HOUR', kind: int({ min: 0, max: 23 }), fallback: 3,
    group: 'Scheduled work',
    doc: 'Local hour, in each property\'s own timezone, after which the automatic '
      + 'night audit may run.',
  },

  nightAuditCheckMinutes: {
    env: 'HELIO_NIGHT_AUDIT_CHECK_MINUTES', kind: int({ min: 1, max: 1440 }), fallback: 10,
    group: 'Scheduled work',
    doc: 'How often the server checks whether any property is due its night audit.',
  },

  // ─── Guest documents ───────────────────────────────────────
  documentRetentionDays: {
    env: 'HELIO_DOCUMENT_RETENTION_DAYS', kind: int({ min: 1, max: 3650 }), fallback: 90,
    group: 'Guest documents',
    doc: 'How many days after a guest departs their scanned identity document and '
      + 'signature are kept, after which they are deleted automatically. A passport '
      + 'scan is sensitive personal data and most data-protection law requires that '
      + 'it is not held longer than the purpose needs — check what your jurisdiction '
      + 'obliges you to keep and for how long before raising this.',
  },

  documentMaxKb: {
    env: 'HELIO_DOCUMENT_MAX_KB', kind: int({ min: 64, max: 4096 }), fallback: 1536,
    group: 'Guest documents',
    doc: 'Largest single document the API will accept, in kilobytes, measured after '
      + 'encoding. The app shrinks a photo before sending it, so this is a backstop '
      + 'rather than the usual limit. Every document is stored inside the database '
      + 'and therefore inside every backup, so raising this raises the size of both.',
  },

  // ─── Development scripts ───────────────────────────────────
  // Read only by the scripts in backend/scripts. Declared here so they are
  // documented and spell-checked alongside everything else.
  demoEmail: {
    env: 'DEMO_EMAIL', kind: str({ min: 3 }), fallback: 'hiran@mellowbay.com',
    group: 'Development scripts',
    doc: 'Administrator account created by `npm run demo`.',
  },
  demoPassword: {
    env: 'DEMO_PASSWORD', kind: str({ min: 8 }), fallback: 'Mellow2026',
    group: 'Development scripts', secret: true,
    doc: 'Password for the demo administrator. Never reuse a real one: the '
      + 'default is published in this repository.',
  },
  demoCurrency: {
    env: 'DEMO_CURRENCY', kind: str({ min: 3, max: 3, pattern: /^[A-Z]{3}$/, patternLabel: 'a three-letter ISO currency code' }),
    fallback: 'USD',
    group: 'Development scripts',
    doc: 'Currency the demo property is created with.',
  },
  demoTimezone: {
    env: 'DEMO_TIMEZONE', kind: str({ min: 3 }), fallback: 'Asia/Colombo',
    group: 'Development scripts',
    doc: 'IANA timezone the demo property is created in.',
  },
  smokeEmail: {
    env: 'SMOKE_EMAIL', kind: str({ min: 3 }), fallback: 'hiran@mellowbay.com',
    group: 'Development scripts',
    doc: 'Account the smoke and check scripts sign in as.',
  },
  smokePassword: {
    env: 'SMOKE_PASSWORD', kind: str({ min: 8 }), fallback: 'Mellow2026',
    group: 'Development scripts', secret: true,
    doc: 'Password for the smoke-test account.',
  },
} satisfies Schema;

// ─── Validation ──────────────────────────────────────────────

const resolution = resolve_(SCHEMA, MODE, loaded);

/**
 * Anything with these prefixes was clearly meant for this server, so a name
 * that matches nothing in the schema is almost certainly a typo rather than
 * somebody else's variable.
 */
const OWNED_PREFIXES = ['HELIO_', 'BEDS24_', 'DEMO_', 'SMOKE_'];

/** Steer the loader itself, so they cannot be schema entries. */
const RESERVED = ['HELIO_ENV_DIR'];

const allProblems: Problem[] = [
  ...resolution.problems,
  ...unknownVars(SCHEMA, OWNED_PREFIXES, RESERVED),
];

// A secret that is simply absent outside production is normal and silent. One
// that is absent in production is an error, handled by `required`. What is
// worth saying out loud is the middle case: present but doing nothing.
if (!resolution.values.webhookSecret && MODE === 'production') {
  allProblems.push({
    env: 'HELIO_WEBHOOK_SECRET',
    severity: 'warning',
    message: 'is not set, so inbound webhook signatures are not verified',
    hint: 'Anyone who can reach the webhook endpoint can post a booking into this system.',
  });
}

const errors = allProblems.filter((p) => p.severity === 'error');
const warnings = allProblems.filter((p) => p.severity === 'warning');

/** Everything the loader noticed, for the doctor and the health endpoint. */
export const configReport = {
  mode: MODE,
  root: ROOT,
  envDir: ENV_DIR,
  files: loaded.files,
  origins: resolution.origins as ReadonlyMap<string, Origin>,
  problems: allProblems as readonly Problem[],
  schema: SCHEMA as Schema,
};

// `CONFIG_NO_EXIT` lets the doctor import this module, print a full report and
// decide for itself what to do — a tool whose whole job is explaining a broken
// configuration is no use if loading it kills the process first.
if (errors.length && !process.env.CONFIG_NO_EXIT) {
  process.stderr.write(formatProblems(allProblems, MODE));
  process.exit(78); // EX_CONFIG
}
if (warnings.length && !process.env.CONFIG_QUIET && !process.env.CONFIG_NO_EXIT) {
  process.stderr.write(formatProblems(warnings, MODE));
}

/**
 * The settings, validated and frozen.
 *
 * Read this instead of `process.env` anywhere in the server. Values are already
 * the right type: `config.port` is a number, `config.corsOrigins` is an array,
 * `config.backupEnabled` is a boolean.
 */
export const config = Object.freeze({
  ...resolution.values,
  // One default that cannot be a constant: it follows the database rather than
  // the source tree, so moving HELIO_DB to a mounted volume takes the backups
  // with it instead of leaving them on the container's own disk.
  backupDir: resolution.values.backupDir
    ?? resolve(dirname(resolution.values.databasePath), '..', 'backups'),
});

export type Config = typeof config;
export { SCHEMA };

/**
 * Re-reads one boolean from the live environment instead of the frozen config.
 *
 * Almost nothing should use this. `HELIO_CHANNEL_READONLY` does, on purpose:
 * it is the switch that stops this installation writing to the OTAs, and the
 * moment you need it is usually the moment something is already going out
 * wrong — waiting for a restart to take effect is the wrong behaviour for a
 * kill switch.
 *
 * It still goes through the schema's parser, so a value the boot-time check
 * would have rejected is rejected here too, and falls back to what the server
 * actually started with rather than guessing.
 */
export function liveBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  try {
    return bool().parse(raw);
  } catch {
    return fallback;
  }
}
