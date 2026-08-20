// Drives the real front end and extends a stay the way an operator would:
// open the guest, press Extend, read the price, confirm.
//
//   node scripts/staydates-ui.ts    (API, app and Chrome with --remote-debugging-port must be up)
//
// staydates-check.ts proves the arithmetic. This proves the screen reaches it,
// and — the part that matters most — that the price is shown *before* the
// operator commits, not after.
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

async function waitFor(cdp: Cdp, what: RegExp, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    try {
      text = await cdp.evaluate<string>('document.body.innerText');
      if (what.test(text)) return text;
    } catch { /* the page is still settling */ }
    await sleep(250);
  }
  return text;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
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
  const auth = {
    authorization: `Bearer ${login.token}`, 'x-property-id': propertyId,
    'content-type': 'application/json',
  };

  // A booking of our own, so the run does not depend on demo data staying put.
  const property: any = await (await fetch(`${API}/api/property`, { headers: auth })).json();
  const arrival = addDays(property.businessDate, 30);
  const departure = addDays(arrival, 2);
  const types: any = await (await fetch(`${API}/api/room-types`, { headers: auth })).json();
  const plans: any = await (await fetch(`${API}/api/rate-plans`, { headers: auth })).json();
  const roomType = types.find((t: any) => t.kind === 'room') ?? types[0];
  const created: any = await (await fetch(`${API}/api/reservations`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      guestName: 'Stay Extension Test', arrival, departure,
      roomTypeId: roomType.id, ratePlanId: plans[0].id, adults: 1, children: 0,
    }),
  })).json();
  if (!created.id) {
    process.stderr.write(`Could not create the test booking: ${JSON.stringify(created)}\n`);
    process.exitCode = 1;
    return;
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

  process.stdout.write(`\nStay date UI checks · ${APP}\n${'─'.repeat(40)}\n`);

  await sleep(700);
  await cdp.evaluate(`
    localStorage.setItem('helio.pms.token', ${JSON.stringify(login.token)});
    localStorage.setItem('helio.pms.property', ${JSON.stringify(propertyId)});
    true;
  `);
  // Route params are path segments, not a query string.
  await cdp.send('Page.navigate', { url: `${APP}/#/guest-dashboard/${created.id}` });

  const guestText = await waitFor(cdp, /Stay Extension Test/i);
  check('the guest dashboard opens', /Stay Extension Test/i.test(guestText), guestText.slice(0, 200));
  check('an extend / shorten action is offered',
    /Extend \/ shorten/i.test(guestText), guestText.slice(0, 600));

  const opened = await cdp.evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => /Extend \\/ shorten/i.test(b.textContent || ''));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('the action opens the stay dialog', opened === true);

  const modalText = await waitFor(cdp, /Change stay/i);
  check('the dialog names the guest', /Change stay · Stay Extension Test/.test(modalText),
    modalText.slice(0, 300));
  check('it shows the dates as they stand', /currently/i.test(modalText), modalText.slice(-400));
  check('it prompts for a new departure before quoting',
    /Pick a new departure date/i.test(modalText), modalText.slice(-400));

  // ── Extend by two nights using the quick button ────────────
  const pressedPlus = await cdp.evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '+2');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('a quick +2 nights control is offered', pressedPlus === true);

  const quoted = await waitFor(cdp, /Nights added/i);
  check('the added nights are listed before committing',
    /Nights added/i.test(quoted), quoted.slice(-700));
  check('the price of the extension is shown',
    /Extra to pay/i.test(quoted), quoted.slice(-700));
  check('the new stay total is shown', /New stay total/i.test(quoted), quoted.slice(-700));
  check('it says the existing nights keep their rate',
    /keep the rate the guest was quoted/i.test(quoted), quoted.slice(-700));
  check('the night count change is stated', /2 → 4 nights/.test(quoted), quoted.slice(-700));

  // Nothing may have been written yet.
  const midway: any = await (await fetch(`${API}/api/reservations/${created.id}`, { headers: auth })).json();
  check('previewing has not changed the booking', midway.departure === departure,
    `${midway.departure} vs ${departure}`);

  const committed = await cdp.evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => /^Extend stay$/.test(b.textContent.trim()) && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('the extend button is enabled once a date is picked', committed === true);
  await sleep(2000);

  const after: any = await (await fetch(`${API}/api/reservations/${created.id}`, { headers: auth })).json();
  check('the stay was extended by two nights', after.departure === addDays(departure, 2),
    `${after.departure} vs ${addDays(departure, 2)}`);
  check('the reservation now has four nights', after.nights === 4, String(after.nights));

  const rates = (after.nightRows ?? []).map((n: any) => n.rateMinor);
  check('all four nights are on the booking', rates.length === 4, JSON.stringify(rates));
  check('the total matches the sum of the nights',
    after.totalMinor === rates.reduce((a: number, b: number) => a + b, 0),
    `${after.totalMinor} vs ${rates.reduce((a: number, b: number) => a + b, 0)}`);

  // ── Shorten it back ────────────────────────────────────────
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => /Extend \\/ shorten/i.test(b.textContent || ''));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await waitFor(cdp, /Change stay/i);
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '−1');
    if (btn) btn.click();
    return !!btn;
  })()`);
  const shortText = await waitFor(cdp, /Nights removed/i);
  check('shortening lists the nights coming off',
    /Nights removed/i.test(shortText), shortText.slice(-600));
  check('and shows the credit rather than a charge',
    /Comes off the folio/i.test(shortText), shortText.slice(-600));

  const shortened = await cdp.evaluate<boolean>(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => /^Shorten stay$/.test(b.textContent.trim()) && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('the button reads "Shorten stay" for a shortening', shortened === true);
  await sleep(2000);

  const final: any = await (await fetch(`${API}/api/reservations/${created.id}`, { headers: auth })).json();
  check('the stay is back to three nights', final.nights === 3, String(final.nights));

  const realErrors = consoleErrors.filter((e) => !/favicon|DevTools|Download the React/i.test(e));
  check('no console errors during the run', realErrors.length === 0, realErrors.join(' | '));

  // Clean up after ourselves — this runs against the live database.
  await fetch(`${API}/api/reservations/${created.id}/cancel`, {
    method: 'POST', headers: auth, body: JSON.stringify({ reason: 'UI check cleanup' }),
  });

  cdp.close();
  process.stdout.write(`\n${checks - failures}/${checks} stay date UI checks passed\n`);
  if (failures) process.exitCode = 1;
  else process.stdout.write('Stays can be extended and shortened from the screen, with the price shown first.\n');
}

main().catch((e) => {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
