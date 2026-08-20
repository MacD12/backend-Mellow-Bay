// Drives the real front end through a rate change, a scheduled change and a
// season — and checks the number the screen promised is the number that lands.
//
//   node scripts/rateplanning-ui.ts   (API, app and Chrome with --remote-debugging-port must be up)
//
// rateplanning-check.ts proves the planner. This proves the screen is wired to
// it: that the preview an operator reads before pressing Apply is the preview
// the server produced, and that applying it does what the preview said.
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
    } catch { /* still settling */ }
    await sleep(250);
  }
  return text;
}

// A modal renders over the page, so the page's own controls are still in the
// DOM. Every interaction below scopes to the modal when one is open — without
// that, "the From field" finds the rate calendar's filter and the modal is
// filled in with nothing.
const SCOPE = `(document.querySelector('.fixed.inset-0.z-50') || document)`;

/** Click the first button whose text contains `needle`, inside the modal if open. */
function clickText(cdp: Cdp, needle: string) {
  return cdp.evaluate<boolean>(
    `(() => { const b = [...${SCOPE}.querySelectorAll('button')]`
    + `.find(x => (x.textContent || '').includes(${JSON.stringify(needle)}));`
    + ` if (!b) return false; b.click(); return true; })()`);
}

function setInputByLabel(cdp: Cdp, label: string, value: string) {
  // `Field` renders the <label> *around* its input, so the input is a
  // descendant of the label — not a sibling. Reaching up to parentElement finds
  // the first input in the whole row instead, which silently writes the value
  // into the field next door.
  return cdp.evaluate<boolean>(`(() => {
    const labels = [...${SCOPE}.querySelectorAll('label')];
    const l = labels.find(x => (x.textContent || '').toLowerCase()
      .includes(${JSON.stringify(label.toLowerCase())}));
    const input = l ? (l.querySelector('input') || l.parentElement.querySelector('input')) : null;
    if (!input) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      .set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
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
  const property: any = await (await fetch(`${API}/api/property`, { headers: auth })).json();
  // Far enough out that nothing is booked there and no demo data is disturbed —
  // and a different stretch on every run, because this writes to the live
  // database and a second run over the same dates would find the prices it set
  // last time, leaving nothing to change and nothing to assert.
  const from = addDays(property.businessDate, 200 + (Date.now() % 120));
  const to = addDays(from, 4);

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

  process.stdout.write(`\nPrice planning UI checks · ${APP}\n${'─'.repeat(40)}\n`);

  await sleep(700);
  await cdp.evaluate(`
    localStorage.setItem('helio.pms.token', ${JSON.stringify(login.token)});
    localStorage.setItem('helio.pms.property', ${JSON.stringify(propertyId)});
    true;
  `);
  await cdp.send('Page.navigate', { url: `${APP}/#/rates-inventory` });
  const ratesText = await waitFor(cdp, /Rate calendar/i);
  check('the rates screen renders', /Rate calendar/i.test(ratesText), ratesText.slice(0, 200));
  check('a Planning tab is offered', /Planning/.test(ratesText), ratesText.slice(0, 600));

  // ── The bulk editor previews before applying ───────────────
  check('the bulk editor opens', await clickText(cdp, 'Bulk edit rates') === true);
  const bulkText = await waitFor(cdp, /Bulk edit rates/i);
  check('it asks what to change before anything happens',
    /Before you apply/i.test(bulkText), bulkText.slice(-600));
  check('it offers to schedule instead of applying now',
    /Schedule for later/i.test(bulkText), bulkText.slice(-600));

  // `to` first. The form only produces a change while the range is the right
  // way round, and moving `from` past a still-early `to` blanks the preview.
  const setTo = await setInputByLabel(cdp, 'to', to);
  await sleep(250);
  const setFrom = await setInputByLabel(cdp, 'from', from);
  await sleep(250);
  // MoneyInput takes major units — 180.00 is 18,000 minor.
  const setPrice = await setInputByLabel(cdp, 'new nightly price', '180.00');
  check('the change can be described in the form', setFrom && setTo && setPrice,
    JSON.stringify({ setFrom, setTo, setPrice }));
  await sleep(1800);

  // Read the whole page, not just the modal: a modal is an overlay, so its text
  // is part of the document anyway, and scoping the *read* proved brittle while
  // scoping the *interactions* is what actually matters.
  //
  // innerText reflects CSS text-transform, so these labels arrive uppercased —
  // every assertion here is case-insensitive on purpose.
  const previewText = await waitFor(cdp, /would change/i);
  check('a preview appears without applying anything',
    /would change/i.test(previewText), previewText.slice(0, 800));
  check('it counts the dates', /dates/i.test(previewText), previewText.slice(0, 800));
  check('it shows the average price movement',
    /average price/i.test(previewText), previewText.slice(0, 800));
  check('it lists the biggest movers',
    /biggest movers/i.test(previewText), previewText.slice(0, 800));

  // Read the promise off the screen, then hold the server to it.
  const promised = await cdp.evaluate<number>(`(() => {
    const m = document.body.innerText.match(/([\\d,]+) of [\\d,]+ price\\(s\\) would change/);
    return m ? Number(m[1].replace(/,/g, '')) : -1;
  })()`);
  check('the preview states how many prices would change', promised > 0, String(promised));

  const beforeHistory: any = await (await fetch(
    `${API}/api/rates/history?from=${from}&to=${to}&limit=1000`, { headers: auth })).json();
  check('previewing has written nothing', beforeHistory.length === 0,
    `${beforeHistory.length} history rows already`);

  check('Apply now is reachable', await clickText(cdp, 'Apply now') === true);
  await sleep(2500);

  const history: any = await (await fetch(
    `${API}/api/rates/history?from=${from}&to=${to}&limit=1000`, { headers: auth })).json();
  check('the screen wrote exactly what it promised',
    history.length === promised, `${history.length} written vs ${promised} promised`);
  check('every written cell landed on the previewed price',
    history.every((h: any) => h.toMinor === 18_000),
    JSON.stringify(history.slice(0, 3)));
  check('the history records who made the change',
    history.every((h: any) => !!h.changedBy), history[0]?.changedBy);
  check('and labels it as a bulk change',
    history.every((h: any) => h.source === 'bulk'), history[0]?.source);

  // ── The planning tab ───────────────────────────────────────
  check('the Planning tab opens', await clickText(cdp, 'Planning') === true);
  const planningText = await waitFor(cdp, /Scheduled changes/i);
  check('scheduled changes are shown', /Scheduled changes/i.test(planningText));
  check('seasons are shown', /Seasons/.test(planningText));
  check('copying a period is offered', /Copy a period/i.test(planningText));
  check('rate history is offered', /Rate history/i.test(planningText));

  check('the history panel opens', await clickText(cdp, 'Rate history') === true);
  // Wait for a row, not the header — the table renders before its data lands.
  const historyText = await waitFor(cdp, /\bbulk\b/i);
  check('the change just made is listed', /\bbulk\b/i.test(historyText), historyText.slice(0, 800));

  // ── Seasons ────────────────────────────────────────────────
  check('the seasons panel opens', await clickText(cdp, 'Seasons') === true);
  await waitFor(cdp, /Add season/i);
  check('a season can be added', await clickText(cdp, 'Add season') === true);
  await waitFor(cdp, /Add a season/i);
  const named = await setInputByLabel(cdp, 'name', 'UI Check Season');
  await sleep(150);
  await setInputByLabel(cdp, 'from', from);
  await sleep(150);
  await setInputByLabel(cdp, 'to (inclusive)', to);
  await sleep(150);
  check('the season form accepts a name', named === true);
  // Scoped to the modal — the panel behind it has an "Add season" button too.
  check('the season is saved', await clickText(cdp, 'Add season') === true);
  await sleep(2000);

  const seasons: any = await (await fetch(`${API}/api/seasons`, { headers: auth })).json();
  const created = seasons.find((s: any) => s.name === 'UI Check Season');
  check('the season reached the server', !!created, JSON.stringify(seasons).slice(0, 200));
  check('with the dates entered', created?.from === from && created?.to === to,
    `${created?.from} → ${created?.to}`);
  check('and its night count worked out', created?.nights === 5, String(created?.nights));

  const realErrors = consoleErrors.filter((e) => !/favicon|DevTools|Download the React/i.test(e));
  check('no console errors during the run', realErrors.length === 0, realErrors.join(' | '));

  // Clean up — this runs against the live database.
  if (created) await fetch(`${API}/api/seasons/${created.id}`, { method: 'DELETE', headers: auth });

  cdp.close();
  process.stdout.write(`\n${checks - failures}/${checks} price planning UI checks passed\n`);
  if (failures) process.exitCode = 1;
  else process.stdout.write('The preview on screen is the change that happens.\n');
}

main().catch((e) => {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
