// ─────────────────────────────────────────────────────────────
// Helio PMS API server.
//
//   node --experimental-sqlite src/index.ts        (Node 22.6+)
//
// The database is created and migrated on boot. A fresh install has no
// property, so every route except /health, /api/setup and /api/auth/* replies
// 428 "setup required" until the first-run wizard completes.
// ─────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
// First import on purpose: loading this reads the .env cascade and validates
// every setting, so a misconfigured server says so here rather than failing
// later somewhere that looks unrelated.
import { config, MODE } from './config.ts';
import { migrate, needsSetup, all, database } from './db.ts';
import { matchRoute, readBody, sendJson, clientIp, listRoutes, type Ctx } from './lib/http.ts';
import { HttpError, addDays } from './lib/util.ts';
import {
  resolveSession, can, purgeExpiredSessions, permissionsFor,
  userCanUseProperty, roleAtProperty, type AuthContext,
} from './auth.ts';
import { startBackupSchedule, backupStatus } from './services/backup.ts';
import { purgeExpiredDocuments } from './services/documents.ts';
import { runIntegrityCheck, lastCheck, databaseHealth } from './services/database.ts';
import {
  processQueue, readOnlyChannels, importBookings, setQueueNudge,
} from './services/channels.ts';
import { encryptionAvailable } from './lib/secrets.ts';
import { bootstrapBeds24 } from './services/beds24bootstrap.ts';
import { pollChannelMessages } from './services/messaging.ts';
import { preflight, runNightAudit } from './services/nightaudit.ts';
import { notify } from './services/notify.ts';
import './routes/index.ts';   // registers every route

migrate();
purgeExpiredSessions();

/*
 * Identity documents past their retention window, deleted on the way up and
 * once a day after that.
 *
 * A retention policy that only runs when somebody remembers is not a policy.
 * Doing it at startup means a server that has been off for a month catches up
 * the moment it returns, rather than waiting for the next tick.
 */
{
  const purged = purgeExpiredDocuments();
  if (purged.deleted > 0) {
    process.stdout.write(`  documents: purged ${purged.deleted} past retention
`);
  }
  setInterval(() => {
    try {
      purgeExpiredDocuments();
    } catch (e) {
      process.stderr.write(`document purge failed: ${(e as Error).message}
`);
    }
  }, 24 * 60 * 60 * 1000).unref();
}
startBackupSchedule();

// A database can be damaged while the process is not running — a bad disk, a
// half-finished copy, a machine losing power mid-write. Checking on the way up
// catches that before the front desk writes a booking into it. It is skipped
// when a check has already passed today, so a restart is never slow.
const previous = lastCheck();
const checkedToday = previous?.at.slice(0, 10) === new Date().toISOString().slice(0, 10);
if (!checkedToday) {
  const result = runIntegrityCheck('startup');
  if (!result.ok) {
    process.stderr.write(
      `\n*** DATABASE INTEGRITY CHECK FAILED ***\n`
      + `  ${result.integrity}\n`
      + (result.foreignKeyViolations.length
        ? `  ${result.foreignKeyViolations.length} foreign key violation(s)\n` : '')
      + `  Restore from the most recent verified backup: npm run restore\n\n`,
    );
  }
}

const PORT = config.port;
const ORIGINS = config.corsOrigins;

const ANON: AuthContext = {
  userId: '', userName: 'anonymous', email: '', role: 'anonymous',
  propertyId: '', sessionId: '', permissions: [],
};

function corsHeaders(origin: string | undefined) {
  const allowed = origin && (ORIGINS.includes(origin) || ORIGINS.includes('*')) ? origin : ORIGINS[0];
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-property-id',
    'access-control-allow-credentials': 'true',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const started = Date.now();

  try {
    if (url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true, service: 'helio-pms-api', setupRequired: needsSetup(), time: new Date().toISOString(),
      });
    }
    if (url.pathname === '/routes') return sendJson(res, 200, listRoutes());

    const match = matchRoute(req.method ?? 'GET', url.pathname);
    if (!match) return sendJson(res, 404, { error: 'Not found', path: url.pathname });

    const { route, params } = match;

    // ── Authentication ────────────────────────────────────────
    let auth: AuthContext = ANON;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const resolved = resolveSession(header.slice(7));
      if (resolved) auth = resolved;
    }

    if (route.opts.perm !== null) {
      if (!auth.userId) {
        return sendJson(res, 401, { error: 'Sign in to continue', code: 'unauthenticated' });
      }
      if (route.opts.perm && !can(auth.role, route.opts.perm)) {
        return sendJson(res, 403, {
          error: `Your role (${auth.role}) is not allowed to do this`,
          code: 'forbidden', required: route.opts.perm,
        });
      }
    }

    // A property must be selected for every operational route.
    if (!route.opts.allowNoProperty) {
      if (needsSetup()) {
        return sendJson(res, 428, {
          error: 'This installation has not been set up yet',
          code: 'setup_required',
        });
      }
      // The browser names the property it is working on, because one signed-in
      // user may switch between several. That header is a *request*, not a
      // fact: it arrives from the client and must be checked against what the
      // user is actually entitled to before anything reads or writes with it.
      //
      // Two things have to happen together. Skipping the membership check hands
      // every property's data to anyone with a login. Skipping the role
      // re-resolution is subtler and just as wrong: the role in `auth` was
      // worked out for the *session's* property, so a manager at one property
      // would keep manager rights at another where they are housekeeping.
      const headerProperty = req.headers['x-property-id'];
      if (typeof headerProperty === 'string' && headerProperty
        && headerProperty !== auth.propertyId) {
        if (!userCanUseProperty(auth.userId, auth.role, headerProperty)) {
          return sendJson(res, 403, {
            error: 'You do not have access to that property',
            code: 'property_forbidden',
          });
        }
        const role = roleAtProperty(auth.userId, auth.role, headerProperty);
        auth = {
          ...auth,
          propertyId: headerProperty,
          role,
          permissions: permissionsFor(role),
        };
        // The permission gate above ran against the session's role. Re-run it
        // for the role that actually applies here, or a demotion at the target
        // property means nothing.
        if (route.opts.perm && !can(role, route.opts.perm)) {
          return sendJson(res, 403, {
            error: 'Your role at that property does not allow this',
            code: 'forbidden',
          });
        }
      }
      if (!auth.propertyId) {
        return sendJson(res, 409, {
          error: 'Select a property first', code: 'no_property_selected',
        });
      }
    }

    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')
      ? await readBody(req)
      : {};

    const ctx: Ctx = {
      req, res, params, query: url.searchParams, body, ip: clientIp(req), auth,
    };

    const result = await route.handler(ctx);
    if (res.writableEnded) return;              // handler wrote its own response
    return sendJson(res, result === undefined ? 204 : 200, result ?? null);
  } catch (e) {
    if (e instanceof HttpError) {
      return sendJson(res, e.status, {
        error: e.message, code: e.code, details: e.details ?? undefined,
      });
    }
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[${new Date().toISOString()}] ${req.method} ${url.pathname} failed after ${Date.now() - started}ms: ${message}\n`
      + (e instanceof Error && e.stack ? `${e.stack}\n` : ''),
    );
    // Constraint violations are almost always a client mistake, not a bug.
    if (/UNIQUE constraint failed/i.test(message)) {
      return sendJson(res, 409, { error: 'That record already exists', code: 'duplicate', details: message });
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
      return sendJson(res, 409, { error: 'Referenced record does not exist', code: 'bad_reference' });
    }
    return sendJson(res, 500, { error: 'Internal server error', code: 'internal' });
  }
});

// The banner belongs to the `listening` event rather than a `listen` callback,
// because a bind that has to be retried below still needs to announce itself.
server.on('listening', () => {
  const backups = backupStatus();
  const db = databaseHealth();
  process.stdout.write(
    `helio-pms-api listening on http://localhost:${PORT}\n`
    + (needsSetup() ? '  → no property configured yet; run the setup wizard in the app\n' : '')
    + `  database: ${(db.fileBytes / 1024 / 1024).toFixed(1)} MB · ${db.journalMode} · `
    + `${db.indexCount} indexes · integrity ${db.lastCheck?.ok ? 'ok' : db.lastCheck ? 'FAILED' : 'unchecked'}\n`
    // Said plainly on every boot. An installation that quietly stored channel
    // and payment credentials in the clear, while believing otherwise, is
    // exactly the failure this warning exists to prevent.
    + `  secrets: ${encryptionAvailable()
      ? 'encrypted at rest'
      : 'NOT ENCRYPTED — set HELIO_SECRET_KEY to protect channel credentials'}\n`
    + `  backups: ${backups.enabled
      ? `every ${backups.intervalHours}h → ${backups.directory} (${backups.health})`
      : 'disabled'}\n`
    // Only shown when it is on, and deliberately loud. Read-only is the right
    // setting while an installation is being checked and the wrong one to
    // discover a week later, wondering why the OTAs never got a rate change.
    + (readOnlyChannels()
      ? '  channels: READ-ONLY — bookings import, but no rates or availability are sent\n'
        + '            (unset HELIO_CHANNEL_READONLY to publish from Helio)\n'
      : ''),
  );
});

// ─── Binding the port ────────────────────────────────────────
// `--watch` restarts by killing this process and starting its successor, and
// the two overlap: the new process asks for the port while the old one is still
// letting go of it. Node emits that as an `error` event, and a server with no
// `error` listener does not fail — it throws an unhandled 'error' event and
// takes the process down with a net.js stack trace that names neither the port
// nor the cause. An ordinary file save then leaves no server running at all.
//
// So a bind conflict waits and asks again for a few seconds. That is long
// enough to outlast a restart handover and far too short to hide a real
// conflict: a port held by something else — an older `npm start` still running
// in a forgotten terminal is overwhelmingly the usual one — is never going to
// free itself, and a server that retried forever would be indistinguishable
// from one that is merely slow to start. When the grace period runs out it says
// which port, and how to find out what is holding it, and stops.
const BIND_GRACE_MS = 5_000;
const BIND_RETRY_MS = 400;
let bindWaited = 0;

server.on('error', (e: NodeJS.ErrnoException) => {
  // Anything that is not a bind conflict is a genuine fault and keeps its
  // stack: re-throwing from here is still an uncaught exception, which is the
  // correct outcome for an error this code does not claim to understand.
  if (e.code !== 'EADDRINUSE') throw e;

  if (bindWaited < BIND_GRACE_MS) {
    if (bindWaited === 0) {
      process.stdout.write(`port ${PORT} is busy — waiting for it to be released…\n`);
    }
    bindWaited += BIND_RETRY_MS;
    // Deliberately *not* unref'd. Every timer in this file is unref'd because
    // none of them should hold the process open; this one must, or the loop
    // empties while we are waiting to bind and the process exits 0 in silence.
    setTimeout(() => server.listen(PORT), BIND_RETRY_MS);
    return;
  }

  process.stderr.write(
    `\n*** PORT ${PORT} IS ALREADY IN USE ***\n`
    + `  Something else has held it for ${BIND_GRACE_MS / 1000}s, so it is not a restart handover.\n`
    + `  Almost always another copy of this API — check for a stray 'npm start'.\n\n`
    + `  Find it:   ${process.platform === 'win32'
      ? `netstat -ano | findstr :${PORT}`
      : `lsof -i :${PORT}`}\n`
    + `  Stop it:   ${process.platform === 'win32'
      ? 'taskkill /PID <pid> /F'
      : 'kill <pid>'}\n`
    + `  Or move:   PORT=8081 npm run dev\n\n`,
  );
  process.exit(1);
});

server.listen(PORT);

// ─── Shutdown ────────────────────────────────────────────────
// The other half of the same problem. A keep-alive socket from the front-end
// outlives the last request on it, so `server.close()` waits for a browser that
// has no intention of saying anything else — the process lingers, the port
// stays bound, and the next `--watch` restart runs into the retry loop above
// for no reason. Closing the idle sockets explicitly is what makes a restart
// deterministic instead of lucky.
//
// Requests already running are allowed to finish, but not indefinitely: a
// shutdown that one slow handler can block is not a shutdown. The database is
// closed on the way out so SQLite checkpoints its WAL rather than leaving it
// for the next boot to recover.
let shuttingDown = false;

function shutdown(signal: string) {
  // A second Ctrl-C while the first is still draining means "I meant it", not
  // "start a second shutdown" — take the fast path out.
  if (shuttingDown) {
    server.closeAllConnections();
    process.exit(0);
  }
  shuttingDown = true;
  process.stdout.write(`\n${signal} — releasing port ${PORT}…\n`);

  const giveUp = setTimeout(() => {
    process.stderr.write('  a request is still running; closing it anyway\n');
    server.closeAllConnections();
    closeDatabase();
    process.exit(0);
  }, 3_000);
  giveUp.unref();

  server.close(() => {
    clearTimeout(giveUp);
    closeDatabase();
    process.exit(0);
  });
  // Sockets sitting idle between requests are holding nothing worth waiting on.
  server.closeIdleConnections();
}

function closeDatabase() {
  try {
    database.close();
  } catch {
    // Already closed, or mid-statement. Exiting regardless — a failure to close
    // cleanly must not turn a restart into a hang.
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => shutdown(signal));
}

setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

// ─── Channel push drain ──────────────────────────────────────
// Closing a date in Helio has to reach Booking.com without anyone remembering
// to press a button — otherwise the OTA keeps selling a room the property has
// shut, which is an overbooking with a paper trail showing it was closed.
//
// The queue is still the mechanism: writes enqueue, this drains. That keeps the
// retry and failure accounting, and means a channel outage delays the push
// instead of failing the close. Nothing is attempted for a property with no
// connected channel, so an installation that has never linked an OTA does no
// work here at all.
const DRAIN_SECONDS = config.channelDrainSeconds;

/**
 * A re-entry guard that cannot jam shut.
 *
 * The guard stops a slow run stacking up behind itself. It is released in a
 * `finally`, which is correct but not sufficient: a promise that never settles
 * never reaches its `finally`, and the flag then stays raised for the life of
 * the process — every later tick returns immediately and distribution stops
 * silently.
 *
 * Every outbound call now has a deadline, so that should not happen. This is
 * the second line: if a run has been in flight far longer than any timeout
 * allows, something unforeseen is stuck, and a stalled sync is worse than an
 * overlapping one. It says so on the way past rather than recovering quietly.
 */
function makeGuard(name: string, maxRunMs: number) {
  let running = false;
  let startedAt = 0;
  return {
    tryEnter(): boolean {
      if (running) {
        if (Date.now() - startedAt < maxRunMs) return false;
        process.stderr.write(
          `[${new Date().toISOString()}] ${name} has been running for `
          + `${Math.round((Date.now() - startedAt) / 1000)}s and is presumed stuck; starting a new run\n`);
      }
      running = true;
      startedAt = Date.now();
      return true;
    },
    leave() { running = false; },
  };
}

const drainGuard = makeGuard('the channel drain', 5 * 60_000);

async function drainChannelQueues() {
  if (!drainGuard.tryEnter()) return;
  try {
    const pending = all<{ property_id: string }>(
      `SELECT DISTINCT q.property_id
         FROM channel_queue q
         JOIN channels c ON c.id = q.channel_id
        -- Includes channels in error: queued work is exactly what should be
        -- retried, and a channel that can never drain never recovers either.
        WHERE q.status = 'queued' AND c.active = 1
          AND c.status IN ('connected', 'error')`,
    );
    for (const p of pending) {
      // A system actor, so the audit trail shows the push was automatic rather
      // than attributing it to whoever happened to close the dates.
      const actor = { userId: 'system', userName: 'Channel sync', propertyId: p.property_id };
      try {
        await processQueue(p.property_id, actor, 10);
      } catch (e) {
        // A failed push is already recorded against the queue row and the sync
        // log by processQueue. Log it once here and carry on to the next
        // property rather than letting one bad channel stop the timer.
        process.stderr.write(
          `[${new Date().toISOString()}] channel drain failed for ${p.property_id}: `
          + `${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  } finally {
    drainGuard.leave();
  }
}

// A refresh token in the environment brings the property online without anybody
// opening the channel manager. Deliberately after `listen`, and deliberately
// not awaited: a slow or unreachable Beds24 must not stop the PMS starting.
void bootstrapBeds24().then((r) => {
  if (r.attempted) {
    process.stdout.write(`  beds24: ${r.message}\n`);
  }
}).catch((e) => {
  process.stderr.write(`  beds24: bootstrap failed — ${e instanceof Error ? e.message : e}\n`);
});

if (DRAIN_SECONDS > 0) {
  setInterval(() => { void drainChannelQueues(); }, DRAIN_SECONDS * 1000).unref();
}

// A price change or a closure should reach the OTAs in seconds, not whenever
// the next tick comes round. Anything that queues work asks for a drain, and
// this coalesces those asks: a rate plan updated across forty dates raises
// forty requests and causes one call.
//
// The timer above stays exactly as it was. This only ever makes the queue drain
// *sooner* — if the nudge is lost, dropped or arrives during a drain already in
// flight, the tick still picks the work up.
let nudge: NodeJS.Timeout | null = null;
setQueueNudge(() => {
  if (nudge || DRAIN_SECONDS <= 0) return;
  nudge = setTimeout(() => {
    nudge = null;
    void drainChannelQueues();
  }, 1_500);
  nudge.unref();
});

// ─── Booking poll ────────────────────────────────────────────
//
// The one loop this system cannot do without.
//
// Everything else here is about latency; this is about a hole. Bookings were
// never fetched on a schedule at all — a guest booked on an OTA, Beds24 had it
// in seconds, and Helio did not know until somebody opened the Channel Manager
// and pressed Import. Between those two moments the front desk works from an
// inventory that is wrong and the tape chart shows a bed that is sold as free,
// with nothing on any screen suggesting otherwise.
//
// `importBookings` asks only for what changed since its own last successful
// import, so a quiet minute costs one small call.
const BOOKING_POLL_SECONDS = config.bookingPollSeconds;
const bookingGuard = makeGuard('the booking poll', 5 * 60_000);

async function pollBookings() {
  if (!bookingGuard.tryEnter()) return;
  try {
    // Deliberately **not** `status = 'connected'`.
    //
    // A failed import marks the channel `error`. Polling only connected
    // channels therefore means one transient network blip stops booking sync
    // permanently: the next tick finds nothing to do, so nothing ever succeeds,
    // so the status never returns to connected. Observed doing exactly that —
    // three good polls a minute apart, one "fetch failed", then fifty-three
    // minutes of silence with the API up and Beds24 reachable.
    //
    // A channel in error is precisely the one that needs retrying. Only a
    // channel with no credentials at all is skipped, because there is nothing
    // to retry with.
    const rows = all<{ propertyId: string; channelId: string }>(
      `SELECT c.property_id AS propertyId, c.id AS channelId
         FROM channels c JOIN properties p ON p.id = c.property_id
        WHERE p.active = 1 AND c.active = 1
          AND c.status IN ('connected', 'error')`,
    );
    for (const r of rows) {
      const actor = { userId: 'system', userName: 'Booking sync', propertyId: r.propertyId };
      try {
        await importBookings(r.propertyId, actor, r.channelId);
      } catch (e) {
        // Logged and carried on. One channel refusing must not stop the others,
        // and `importBookings` records the failure in the sync log — which is
        // also what keeps the watermark from moving, so nothing is skipped.
        process.stderr.write(
          `[${new Date().toISOString()}] booking poll failed for ${r.propertyId}: `
          + `${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  } finally {
    bookingGuard.leave();
  }
}

if (BOOKING_POLL_SECONDS > 0) {
  setInterval(() => { void pollBookings(); }, BOOKING_POLL_SECONDS * 1000).unref();
  // Once shortly after boot, so a restart catches up on anything that arrived
  // while the process was down rather than waiting for the first tick.
  setTimeout(() => { void pollBookings(); }, 5_000).unref();
}

// ─── Guest message poll ──────────────────────────────────────
// A guest asking "can I check in early?" through Booking.com is waiting on a
// person, so the inbox has to fill itself. The interval is deliberately slower
// than the ARI drain: messages are conversational, not perishable, and each
// poll costs a Beds24 credit per booking.
const MESSAGE_POLL_SECONDS = config.messagePollSeconds;
const pollGuard = makeGuard('the message poll', 10 * 60_000);

async function pollGuestMessages() {
  if (!pollGuard.tryEnter()) return;
  try {
    const properties = all<{ id: string; business_date: string }>(
      `SELECT DISTINCT p.id, p.business_date
         FROM properties p
         JOIN channels c ON c.property_id = p.id
        -- Same reasoning as the booking poll: an errored channel is the one
        -- that needs retrying, not the one to give up on.
        WHERE p.active = 1 AND c.active = 1
          AND c.status IN ('connected', 'error')`,
    );
    for (const p of properties) {
      const actor = { userId: 'system', userName: 'Message sync', propertyId: p.id };
      try {
        await pollChannelMessages(p.id, actor, p.business_date);
      } catch (e) {
        process.stderr.write(
          `[${new Date().toISOString()}] message poll failed for ${p.id}: `
          + `${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  } finally {
    pollGuard.leave();
  }
}

if (MESSAGE_POLL_SECONDS > 0) {
  setInterval(() => { void pollGuestMessages(); }, MESSAGE_POLL_SECONDS * 1000).unref();
}

// ─── The business date ───────────────────────────────────────
//
// Nothing moved it.
//
// `runNightAudit` is the only thing that advances a property's business date,
// and it was reachable only through `POST /api/night-audit/run` — a button. Miss
// a few days and the date simply stops, silently, while the calendar carries on.
// Found seven days behind on a live installation, which is not a cosmetic drift:
//
//   · Check-in is refused outright. `checkIn` throws 409 `early_arrival` for any
//     arrival later than the business date, so a guest standing at the desk
//     today cannot be checked in at all.
//   · Room charges stop accruing and no-shows are never flagged, so revenue and
//     statistics quietly stop at the last date somebody rolled.
//   · Scheduled rate changes never fire. `runDueScheduledChanges` runs from the
//     night audit; a price set to change on a date the system never reaches is
//     never applied, and therefore never pushed to the channels either.
//
// The roll happens in the **property's** timezone, not the server's — a hostel
// in Asia/Colombo closes its day on Colombo's clock wherever this is hosted.
// Until the local time passes the roll hour the target stays on yesterday, so a
// day that is still trading is never closed early.
//
// It never forces. `preflight` blocks the audit on arrivals that were neither
// checked in nor cancelled, and that is a judgement for a person: forcing past
// it would write a day's accounts over unresolved bookings. Blocked properties
// raise a notification and are left exactly as they are.
const NIGHT_AUDIT_AUTO = config.nightAuditAuto;
const NIGHT_AUDIT_HOUR = config.nightAuditHour;
const NIGHT_AUDIT_CHECK_MINUTES = config.nightAuditCheckMinutes;

/**
 * A catch-up ceiling for one tick.
 *
 * A date months behind should still converge, but it should do it across
 * several ticks with the log showing progress, rather than in one long
 * transaction nobody can watch or stop.
 */
const MAX_ROLLS_PER_TICK = 40;

/** Today's date and hour where the property actually is. */
function localNow(timeZone: string | null): { date: string; hour: number } {
  try {
    // en-CA formats as YYYY-MM-DD, which is the format used everywhere here.
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || 'UTC',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date()).map((p) => [p.type, p.value]),
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  } catch {
    // An unrecognised timezone must not stop the date rolling everywhere else.
    const now = new Date();
    return { date: now.toISOString().slice(0, 10), hour: now.getUTCHours() };
  }
}

/** Properties already reported as blocked, so it is said once and not every tick. */
const auditBlockedReported = new Set<string>();
const nightAuditGuard = makeGuard('the night audit', 15 * 60_000);

function rollBusinessDates() {
  if (!nightAuditGuard.tryEnter()) return;
  try {
    const properties = all<{ id: string; name: string; business_date: string; timezone: string | null }>(
      'SELECT id, name, business_date, timezone FROM properties WHERE active = 1',
    );
    for (const p of properties) {
      const { date: localToday, hour } = localNow(p.timezone);
      const target = hour >= NIGHT_AUDIT_HOUR ? localToday : addDays(localToday, -1);
      const actor = { userId: 'system', userName: 'Night audit (automatic)', propertyId: p.id };

      let date = p.business_date;
      let rolled = 0;
      while (date < target && rolled < MAX_ROLLS_PER_TICK) {
        const pre = preflight(p.id);
        if (!pre.canRun) {
          const key = `${p.id}|${date}`;
          if (!auditBlockedReported.has(key)) {
            auditBlockedReported.add(key);
            const blockers = pre.issues.filter((i) => i.severity === 'block');
            notify(p.id, {
              source: 'Night Audit',
              severity: 'critical',
              title: `The business date is stuck on ${date}`,
              message: `The night audit cannot close ${date} until ${blockers.length} open item(s) are `
                + 'resolved. Until it does, arrivals after this date cannot be checked in and scheduled '
                + 'rate changes will not run.',
              link: '#/night-audit',
            });
            process.stderr.write(
              `[${new Date().toISOString()}] night audit blocked for ${p.name} on ${date}: `
              + `${blockers.map((b) => b.message).join('; ')}\n`);
          }
          break;
        }

        try {
          runNightAudit(p.id, actor);
        } catch (e) {
          process.stderr.write(
            `[${new Date().toISOString()}] night audit failed for ${p.name} on ${date}: `
            + `${e instanceof Error ? e.message : String(e)}\n`);
          break;
        }

        // Read the date back rather than assuming it moved: the audit is the
        // authority on what it actually closed.
        const after = all<{ business_date: string }>(
          'SELECT business_date FROM properties WHERE id = ?', p.id)[0]?.business_date;
        if (!after || after === date) break;   // no progress; stop rather than spin
        auditBlockedReported.delete(`${p.id}|${date}`);
        date = after;
        rolled++;
      }

      if (rolled) {
        process.stdout.write(
          `[${new Date().toISOString()}] night audit rolled ${p.name} `
          + `${p.business_date} → ${date} (${rolled} day${rolled === 1 ? '' : 's'})\n`);
      }
    }
  } finally {
    nightAuditGuard.leave();
  }
}

if (NIGHT_AUDIT_AUTO) {
  setInterval(() => { rollBusinessDates(); }, NIGHT_AUDIT_CHECK_MINUTES * 60_000).unref();
  // Once shortly after boot too, so a restart after downtime catches up rather
  // than waiting out the first interval.
  setTimeout(() => { rollBusinessDates(); }, 10_000).unref();
}
