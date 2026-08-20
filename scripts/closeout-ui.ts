// Drives the real front end and closes a date the way an operator would:
// select it on the rate calendar, press Close, then reopen it from the
// close-out list.
//
//   node scripts/closeout-ui.ts     (API, app and Chrome with --remote-debugging-port must be up)
//
// The service-level checks in closeout-check.ts prove the date arithmetic. This
// proves the path a person actually takes reaches it.
const APP = process.env.APP ?? 'https://main.d2ghlmlthkq8hn.amplifyapp.com';
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
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }
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

/**
 * Poll until the page says what we are waiting for.
 *
 * A fixed sleep is a guess about how long a dev server takes to compile a route
 * and how long React takes to paint it. The guess is right until the machine is
 * busy, and then the check fails for a reason that has nothing to do with the
 * feature. Polling makes the wait as long as it needs to be and no longer.
 */
async function waitFor(
  cdp: Cdp, what: RegExp, timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    try {
      text = await cdp.evaluate<string>('document.body.innerText');
      if (what.test(text)) return text;
    } catch {
      // "Inspected target navigated" — the reload tore down the execution
      // context this poll was speaking to. That is expected while the page is
      // still settling, so wait and ask the new one.
    }
    await sleep(250);
  }
  return text;
}

async function main() {
  const email = process.env.SMOKE_EMAIL ?? 'hiran@mellowbay.com';
  const password = process.env.SMOKE_PASSWORD ?? 'Mellow2026';

  const login: any = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json();
  if (!login.token) {
    process.stderr.write(`Sign-in failed: ${JSON.stringify(login)}\n`);
    process.exitCode = 1;
    return;
  }
  const propertyId = login.property?.id ?? login.properties[0].id;
  const auth = { authorization: `Bearer ${login.token}`, 'x-property-id': propertyId };

  // Start clean so the assertions mean something.
  const before: any = await (await fetch(`${API}/api/closeouts`, { headers: auth })).json();
  for (const c of before.closeouts) {
    await fetch(`${API}/api/closeouts/${c.id}/open`, { method: 'POST', headers: auth });
  }

  const target: any = await (await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

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

  process.stdout.write(`\nClose-out UI checks · ${APP}\n${'─'.repeat(40)}\n`);

  await sleep(700);
  await cdp.evaluate(`
    localStorage.setItem('helio.pms.token', ${JSON.stringify(login.token)});
    localStorage.setItem('helio.pms.property', ${JSON.stringify(propertyId)});
    true;
  `);
  // Navigate only — no reload. Reloading immediately after a navigate tears the
  // execution context down twice, and every poll below then talks to a context
  // that is already gone.
  await cdp.send('Page.navigate', { url: `${APP}/#/rates-inventory` });

  const ratesText = await waitFor(cdp, /Rate calendar/i);
  check('the rates screen renders', /Rate calendar/i.test(ratesText), ratesText.slice(0, 200));
  check('a Close-outs tab is offered', /Close-outs/i.test(ratesText), ratesText.slice(0, 300));

  // The calendar paints before its data arrives; wait for a priced cell.
  await waitFor(cdp, /Available/i);

  // ── Select two dates by dragging across the first row ──────
  // Each event goes in its own evaluate with a pause between. Firing all three
  // in one tick makes React batch the state updates, so the mouseup handler
  // still sees `drag === null` and no selection is ever committed — an artefact
  // of driving the page synchronously, not something a real pointer can do.
  let found = 0;
  const cellDeadline = Date.now() + 15_000;
  while (Date.now() < cellDeadline) {
    found = await cdp.evaluate<number>(`(() => {
      window.__cells = [...document.querySelectorAll('[title]')]
        .filter(el => /select dates to close|Closed for sale/i.test(el.getAttribute('title') || ''));
      window.__fire = (el, type) => el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      return window.__cells.length;
    })()`);
    if (found >= 2) break;
    await sleep(300);
  }
  check('the calendar exposes selectable date cells', found >= 2, `found ${found}`);
  if (found < 2) throw new Error('No selectable calendar cells — nothing further can be checked');

  await cdp.evaluate(`window.__fire(window.__cells[0], 'mousedown'), true`);
  await sleep(150);
  // React derives onMouseEnter from mouseover, so that is the event to send.
  await cdp.evaluate(`window.__fire(window.__cells[1], 'mouseover'), true`);
  await sleep(150);
  await cdp.evaluate(`window.__fire(window.__cells[1], 'mouseup'), true`);
  await sleep(600);
  const barText = await cdp.evaluate<string>('document.body.innerText');
  // A placeholder is an attribute, not text — innerText will never contain it.
  const hasReasonBox = await cdp.evaluate<boolean>(`
    [...document.querySelectorAll('input')].some(i => (i.placeholder || '').startsWith('Reason'))`);
  check('selecting dates raises the close/open bar', hasReasonBox === true, barText.slice(-500));
  check('the bar counts the selected nights', /\d+ nights?/.test(barText), barText.slice(-400));
  check('the bar offers a per-channel choice', /All channels/i.test(barText), barText.slice(-400));

  // ── Type a reason and close ────────────────────────────────
  await cdp.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')]
      .find(i => (i.placeholder || '').startsWith('Reason'));
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Deep clean');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);

  const pressedClose = await cdp.evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Close' && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('the Close button is reachable', pressedClose === true);
  await sleep(1800);

  const afterClose: any = await (await fetch(`${API}/api/closeouts`, { headers: auth })).json();
  check('a closure was created through the UI', afterClose.closeouts.length === 1,
    JSON.stringify(afterClose.closeouts).slice(0, 300));
  check('the reason typed in the bar was saved',
    afterClose.closeouts[0]?.reason === 'Deep clean', afterClose.closeouts[0]?.reason);
  check('it covers the two selected nights', afterClose.closeouts[0]?.nights === 2,
    String(afterClose.closeouts[0]?.nights));

  const closedCalendar = await cdp.evaluate<string>('document.body.innerText');
  check('the calendar now shows the dates as closed', /closed/i.test(closedCalendar));

  const reasonOnHover = await cdp.evaluate<boolean>(`
    [...document.querySelectorAll('[title]')]
      .some(el => /Closed for sale — Deep clean/.test(el.getAttribute('title') || ''))`);
  check('hovering a closed cell explains why', reasonOnHover === true);

  // ── The close-out list ─────────────────────────────────────
  await cdp.evaluate(`(() => {
    const tab = [...document.querySelectorAll('button')]
      .find(b => /Close-outs/i.test(b.textContent || ''));
    if (tab) tab.click();
    return !!tab;
  })()`);
  await sleep(1200);
  const listText = await cdp.evaluate<string>('document.body.innerText');
  check('the close-out list shows the closure', /Deep clean/.test(listText), listText.slice(0, 600));
  check('it names what the closure applies to',
    /All channels|All room types/.test(listText), listText.slice(0, 600));
  check('it marks the closure live or upcoming',
    /closed now|upcoming/i.test(listText), listText.slice(0, 600));

  // ── Reopen from the list ───────────────────────────────────
  const pressedReopen = await cdp.evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Reopen');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('the list offers a one-click reopen', pressedReopen === true);
  await sleep(700);

  const confirmed = await cdp.evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Reopen' && b.closest('[role="dialog"], .fixed'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('reopening asks for confirmation first', confirmed === true);
  await sleep(1800);

  const afterOpen: any = await (await fetch(`${API}/api/closeouts`, { headers: auth })).json();
  check('the closure is gone after reopening', afterOpen.closeouts.length === 0,
    JSON.stringify(afterOpen.closeouts).slice(0, 300));

  const realErrors = consoleErrors.filter((e) => !/favicon|DevTools|Download the React/i.test(e));
  check('no console errors during the run', realErrors.length === 0, realErrors.join(' | '));

  cdp.close();
  process.stdout.write(`\n${checks - failures}/${checks} close-out UI checks passed\n`);
  if (failures) process.exitCode = 1;
  else process.stdout.write('Dates can be closed and reopened from the screen.\n');
}

main().catch((e) => {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
