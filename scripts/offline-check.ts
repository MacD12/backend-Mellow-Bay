// ─────────────────────────────────────────────────────────────
// Exercises the front-end's offline rules.
//
//   node --no-warnings scripts/offline-check.ts
//
// This checks a *front-end* module from the API's test harness because the
// decision it encodes is a business rule, not a UI detail: which operations may
// be queued on a device and replayed later, and which must refuse.
//
// Getting it wrong is not a cosmetic bug. Queueing a booking offline would
// destroy the no-overbooking guarantee the whole system is built on — two
// devices each take "the last room", both replay, and the property is oversold
// with a clean sync log. So the assertions below are mostly about what must
// **not** be queueable, and they are written to fail if somebody widens the
// list without thinking.
//
// Nothing here touches a database or a network.
// ─────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A tiny localStorage so the module under test can run outside a browser.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
// Node 24 defines `navigator` as a getter-only global, so it is redefined
// rather than assigned. The module reads `navigator.onLine` as a hint.
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true }, configurable: true, writable: true,
});

const SRC = join(import.meta.dirname, '..', '..', 'frontend', 'src', 'offline.ts');
const offline = await import(`file://${SRC.replace(/\\/g, '/')}`);

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}\n`);
  if (!ok) {
    failures++;
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 320)}\n`);
  }
}
function section(t: string) { process.stdout.write(`\n${t}\n${'─'.repeat(t.length)}\n`); }

async function main() {
  process.stdout.write(`\nOffline rule checks\n${'─'.repeat(19)}\n`);

  section('1 · The dangerous writes refuse');
  // Each of these, if queued, produces a specific real-world failure.
  const mustRefuse: Array<[string, string]> = [
    ['/api/reservations', 'a booking — two devices could sell the same room'],
    ['/api/reservations/res_1/cancel', 'a cancellation'],
    ['/api/folios/fol_1/payment', 'a payment'],
    ['/api/rates/bulk', 'a rate change that goes to the OTAs'],
    ['/api/closeouts/close', 'closing dates on the channels'],
    ['/api/night-audit/run', 'the night audit'],
    ['/api/inventory/adjust', 'an inventory adjustment'],
  ];
  for (const [path, what] of mustRefuse) {
    const reason = offline.offlineRefusal(path);
    check(`${what} is refused`, typeof reason === 'string' && reason.length > 20, path);
    check(`…and never queueable`, offline.isQueueable('POST', path) === false, path);
  }

  section('2 · Refusals explain what to do instead');
  const booking = offline.offlineRefusal('/api/reservations') ?? '';
  check('the booking refusal names the real risk',
    /same room|sell/i.test(booking), booking);
  check('and tells the operator what to do',
    /write .* down|when the connection/i.test(booking), booking);
  const payment = offline.offlineRefusal('/api/folios/f1/payment') ?? '';
  check('the payment refusal suggests the terminal',
    /terminal/i.test(payment), payment);

  section('3 · Only the genuinely safe writes queue');
  check('a room status change queues',
    offline.isQueueable('PATCH', '/api/rooms/rm_1') === true);
  check('a housekeeping task update queues',
    offline.isQueueable('POST', '/api/housekeeping/tasks/t1/complete') === true);
  // The list is a allowlist, not a denylist — anything unrecognised refuses.
  check('an unlisted write does not queue',
    offline.isQueueable('POST', '/api/groups') === false);
  check('reading a room is not a queueable write',
    offline.isQueueable('GET', '/api/rooms/rm_1') === false);
  check('deleting a room is not queueable',
    offline.isQueueable('DELETE', '/api/rooms/rm_1') === false);

  section('4 · Cached reads are per property');
  const A = 'prp_alpha';
  const B = 'prp_beta';
  offline.cacheRead('/api/front-desk', A, { rows: ['alpha guest'] });
  const forA = offline.cachedRead('/api/front-desk', A);
  check('the cache answers for the property that wrote it', !!forA, forA);
  check('with the body intact',
    (forA as any)?.body.rows[0] === 'alpha guest', forA);
  // The cross-property leak, arriving by a different route.
  check('another property gets nothing',
    offline.cachedRead('/api/front-desk', B) === null);
  check('and neither does no property at all',
    offline.cachedRead('/api/front-desk', null) === null);
  check('an uncached path returns nothing',
    offline.cachedRead('/api/reports/kpis', A) === null);

  section('5 · Only operational reads are cached');
  check('the arrivals list is cacheable', offline.isCacheable('/api/front-desk') === true);
  check('housekeeping is cacheable', offline.isCacheable('/api/housekeeping') === true);
  // A cached report is stale numbers somebody will act on.
  check('reports are not cached', offline.isCacheable('/api/reports/kpis') === false);
  check('the audit trail is not cached', offline.isCacheable('/api/audit') === false);
  offline.cacheRead('/api/reports/kpis', A, { adr: 1 });
  check('and writing an uncacheable path stores nothing',
    offline.cachedRead('/api/reports/kpis', A) === null);

  section('6 · Signing out takes the guest data with it');
  offline.cacheRead('/api/front-desk', A, { rows: ['alpha guest'] });
  offline.enqueueWrite('PATCH', '/api/rooms/rm_1', { status: 'Vacant Clean' }, A);
  check('there is something to clear',
    !!offline.cachedRead('/api/front-desk', A) && offline.readQueue().length > 0);
  offline.clearOfflineCache();
  check('the cached guest list is gone',
    offline.cachedRead('/api/front-desk', A) === null);
  check('and so is the queue', offline.readQueue().length === 0);

  section('7 · The queue');
  const item = offline.enqueueWrite('PATCH', '/api/rooms/rm_9', { status: 'Vacant Clean' }, A);
  check('a queued write is described for a person',
    /Vacant Clean/.test(item.description), item.description);
  check('it survives a reload', offline.readQueue().length === 1);
  check('and reports as pending', offline.offlineState().pending === 1);

  // Replay order matters: two changes to one room must land as made.
  offline.clearOfflineCache();
  offline.enqueueWrite('PATCH', '/api/rooms/rm_1', { status: 'Vacant Dirty' }, A);
  offline.enqueueWrite('PATCH', '/api/rooms/rm_1', { status: 'Vacant Clean' }, A);
  const order: string[] = [];
  await offline.replayQueue(async (q: any) => { order.push(q.body.status); });
  check('replay is oldest first',
    order.join(',') === 'Vacant Dirty,Vacant Clean', order);
  check('a sent item leaves the queue', offline.readQueue().length === 0);

  section('8 · A refused replay is not silently dropped');
  offline.clearOfflineCache();
  offline.enqueueWrite('PATCH', '/api/rooms/rm_2', { status: 'Vacant Clean' }, A);
  const rejected = await offline.replayQueue(async () => {
    const e: any = new Error('That room was taken out of service');
    e.status = 409;
    throw e;
  });
  check('it counts as failed', rejected.failed === 1, rejected);
  // The work stays visible rather than vanishing.
  check('the item is still in the queue', offline.readQueue().length === 1);
  check('carrying the reason',
    /out of service/.test(offline.readQueue()[0].error ?? ''), offline.readQueue()[0]);
  check('and it is reported as needing a person',
    offline.offlineState().failed === 1);
  check('a failed item is not retried',
    (await offline.replayQueue(async () => { throw new Error('should not be called'); })).sent === 0);

  section('9 · A connection failure stops, it does not burn the queue');
  offline.clearOfflineCache();
  for (const room of ['rm_1', 'rm_2', 'rm_3']) {
    offline.enqueueWrite('PATCH', `/api/rooms/${room}`, { status: 'Vacant Clean' }, A);
  }
  let attempts = 0;
  await offline.replayQueue(async () => {
    attempts++;
    const e: any = new Error('Network down');
    e.status = 0;
    throw e;
  });
  // Stopping after the first is the point: the rest fail for the same reason,
  // and marking them all failed would send somebody hunting three problems.
  check('it stops after the first failure', attempts === 1, attempts);
  check('everything is still queued', offline.readQueue().length === 3);
  check('and nothing is marked as needing a person',
    offline.offlineState().failed === 0);

  section('10 · Connectivity is judged by the server, not the browser');
  offline.markServerReachable(true);
  check('reachable means online', offline.isOffline() === false);
  offline.markServerReachable(false);
  // Hostel wifi routinely reports `onLine` while routing nowhere.
  check('unreachable means offline even when the browser says online',
    offline.isOffline() === true);
  offline.markServerReachable(true);

  section('11 · The source itself');
  // A guard against the list quietly growing. Widening what may be queued is a
  // decision that needs a person to think, not a convenient edit.
  const source = readFileSync(SRC, 'utf8');
  const queueable = source.match(/const QUEUEABLE[\s\S]*?\n\];/)?.[0] ?? '';
  // Counting `pattern: /` rather than `pattern:` — the type annotation on the
  // declaration line carries the word too, and counting it made this read 3.
  const patterns = (queueable.match(/pattern: \//g) ?? []).length;
  check('only two operations are queueable', patterns === 2, patterns);
  check('neither of them touches reservations',
    !/reservations/.test(queueable), queueable.slice(0, 200));
  check('nor folios', !/folio/i.test(queueable));

  process.stdout.write(`\n${checks - failures}/${checks} offline rule checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('Reads work offline; only safe writes queue; the rest refuse and say why.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
}
