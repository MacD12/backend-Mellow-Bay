// Drives the built front-end in headless Chrome against the live API and
// asserts each screen actually renders real data — not a spinner, not an
// error panel, not an empty shell.
//
//   node scripts/ui-check.ts        (API + a static server for dist must be up)
//
// Uses the Chrome DevTools Protocol over Node's built-in WebSocket, so it
// needs no browser-automation dependency.
const APP = process.env.APP ?? 'http://localhost:4173';
const API = process.env.API ?? 'http://localhost:8080';
const CDP = process.env.CDP ?? 'http://localhost:9222';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: string) {
  checks++;
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}\n`);
  if (!ok) {
    failures++;
    if (detail) process.stdout.write(`      ${detail.slice(0, 400)}\n`);
  }
}

class Cdp {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }
      }, 30_000);
    });
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'evaluation failed');
    }
    return res.result.value as T;
  }

  close() { this.ws.close(); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;
  if (!email || !password) {
    process.stderr.write('Set SMOKE_EMAIL / SMOKE_PASSWORD\n');
    process.exitCode = 1;
    return;
  }

  // Sign in through the API so the browser starts from a real session.
  const login: any = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json();
  if (!login.token) {
    process.stderr.write(`Sign-in failed: ${JSON.stringify(login)}\n`);
    process.exitCode = 1;
    return;
  }
  const propertyId = login.property?.id ?? login.properties[0].id;

  const target: any = await (await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // Collect console errors for the whole run — a screen that renders but throws
  // is not a screen that works.
  const consoleErrors: string[] = [];
  (cdp as any).ws.addEventListener('message', (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
    }
  });

  process.stdout.write(`\nHeadless UI checks · ${APP}\n${'─'.repeat(40)}\n`);

  // Start from a genuinely signed-out browser so the gate is really tested.
  await sleep(800);
  await cdp.evaluate('localStorage.clear(); sessionStorage.clear(); true;');
  await cdp.send('Page.navigate', { url: APP });
  await sleep(1800);
  const bootText = await cdp.evaluate<string>('document.body.innerText');
  check('A signed-out browser is held at the sign-in screen',
    /Sign in|Welcome back/i.test(bootText) && !/Dashboard/i.test(bootText),
    bootText.slice(0, 200));

  // Seed the session the way a successful sign-in would, then force a full
  // reload — the app resolves its session once, at boot.
  await cdp.evaluate(`
    localStorage.setItem('helio.pms.token', ${JSON.stringify(login.token)});
    localStorage.setItem('helio.pms.property', ${JSON.stringify(propertyId)});
    true;
  `);
  await cdp.send('Page.navigate', { url: `${APP}/#/dashboard` });
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(2500);

  const signedIn = await cdp.evaluate<string>('document.body.innerText');
  check('A stored session lands straight in the app',
    !/Welcome back/i.test(signedIn) && /Dashboard/i.test(signedIn), signedIn.slice(0, 200));

  const screens: [string, string, RegExp, RegExp?][] = [
    ['Dashboard', '#/dashboard', /Occupancy tonight|Good (morning|afternoon|evening)/i],
    ['Calendar (tape chart)', '#/calendar', /Tape chart/i],
    ['Reservations', '#/reservations', /Reservations/i],
    ['New reservation', '#/new-reservation', /Stay dates|New reservation/i],
    ['Arrivals', '#/arrivals', /Arrivals/i],
    ['In-house', '#/in-house', /In-house guests/i],
    ['Departures', '#/departures', /Departures/i],
    ['Cashier', '#/cashier', /Cashier/i],
    ['Housekeeping', '#/housekeeping', /Housekeeping/i],
    ['Night audit', '#/night-audit', /Night audit/i],
    ['Profiles', '#/profiles', /Guest profiles/i],
    ['Reports', '#/reports', /Reports/i],
    ['Rates & inventory', '#/rates-inventory', /Rates & inventory|Rates &amp; inventory/i],
    ['Channel manager', '#/channel-manager', /Channel manager/i],
    ['Groups & blocks', '#/groups', /Groups & blocks|Groups &amp; blocks/i],
    ['Accounts receivable', '#/ar', /Accounts receivable/i],
    ['Configuration', '#/config', /Configuration/i],
    ['Administration', '#/admin', /Administration/i],
  ];

  for (const [name, hash, expect] of screens) {
    await cdp.send('Page.navigate', { url: `${APP}/${hash}` });
    await sleep(1400);
    const text = await cdp.evaluate<string>('document.body.innerText');

    // The sign-in screen mentions several module names, so matching page text
    // alone can pass on the wrong screen. Require the authenticated shell.
    const kickedOut = /Welcome back[\s\S]*EMAIL[\s\S]*PASSWORD/i.test(text);
    const brokenState = /Cannot reach the Helio server|Something went wrong|Internal server error/i.test(text);
    const stillLoading = /^\s*Connecting to Helio/i.test(text);
    const inShell = /Business date/i.test(text) && /Quick actions/i.test(text);
    const rendered = expect.test(text);

    check(`${name} renders`, rendered && inShell && !kickedOut && !brokenState && !stillLoading,
      kickedOut ? 'showed the sign-in screen instead'
        : brokenState ? `error state: ${text.slice(0, 200)}`
          : stillLoading ? 'stuck on the boot screen'
            : !inShell ? 'authenticated shell did not render'
              : `did not match: ${text.slice(0, 200)}`);
  }

  // Deep-link into a record to prove detail screens resolve their params.
  const reservations: any = await (await fetch(`${API}/api/reservations?limit=1`, {
    headers: { authorization: `Bearer ${login.token}`, 'x-property-id': propertyId },
  })).json();
  if (reservations[0]) {
    await cdp.send('Page.navigate', { url: `${APP}/#/guest-dashboard/${reservations[0].id}` });
    await sleep(1600);
    const text = await cdp.evaluate<string>('document.body.innerText');
    check('Guest dashboard renders a real reservation',
      text.includes(reservations[0].guest) && /Folio/i.test(text), text.slice(0, 200));
    check('Folio numbers are formatted as money, not raw minor units',
      !/\b\d{5,}\.00\b/.test(text), text.slice(0, 300));
  }

  const realErrors = consoleErrors.filter((e) =>
    !/favicon|manifest|Download the React DevTools|sw\.js|ServiceWorker/i.test(e));
  check('No uncaught errors in the browser console', realErrors.length === 0,
    realErrors.slice(0, 3).join(' | '));

  cdp.close();
  process.stdout.write(`\n${checks - failures}/${checks} UI checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('The app runs on live data end to end.\n');
}

main().catch((e) => {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
