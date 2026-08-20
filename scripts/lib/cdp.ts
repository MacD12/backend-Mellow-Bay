// ─────────────────────────────────────────────────────────────
// Driving a real browser, over Chrome's own DevTools Protocol.
//
// This is the harness the `*-ui.ts` scripts share. There is no Playwright and
// no Puppeteer: Node has a WebSocket, Chrome speaks CDP over one, and the whole
// need here is "open a page, run some JavaScript in it, read what came back".
// A browser-automation dependency for that would be several hundred megabytes
// to do what fits on a screen.
//
// Chrome has to be started with `--remote-debugging-port=9222`.
// ─────────────────────────────────────────────────────────────
export const APP = process.env.APP ?? 'https://main.d2ghlmlthkq8hn.amplifyapp.com';
export const API = process.env.API ?? 'https://u14kij0jkg.execute-api.eu-north-1.amazonaws.com';
export const CDP_URL = process.env.CDP ?? 'http://localhost:9222';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Cdp {
  readonly ws: WebSocket;
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

/**
 * Open a page, sign in, and start collecting console errors.
 *
 * The error collection matters as much as anything asserted afterwards: a React
 * screen that throws still renders its shell, so a check on visible text can
 * pass over a component that crashed.
 */
export async function openApp(opts: { email?: string; password?: string; path?: string } = {}) {
  const email = opts.email ?? process.env.SMOKE_EMAIL ?? 'hiran@mellowbay.com';
  const password = opts.password ?? process.env.SMOKE_PASSWORD ?? 'Mellow2026';

  const login: any = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })).json();
  if (!login.token) throw new Error(`Sign-in failed: ${JSON.stringify(login).slice(0, 200)}`);

  const propertyId = login.property?.id ?? login.properties?.[0]?.id;
  const target: any = await (await fetch(
    `${CDP_URL}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const consoleErrors: string[] = [];
  cdp.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
    }
  });

  await sleep(700);
  await cdp.evaluate(`
    localStorage.setItem('helio.pms.token', ${JSON.stringify(login.token)});
    localStorage.setItem('helio.pms.property', ${JSON.stringify(propertyId)});
    true;
  `);
  if (opts.path) {
    // Reload first so the app boots with the token just written, *then* set the
    // route. Navigating to the hash and reloading afterwards loses it — the
    // reload re-runs the router against the app's own restored state and lands
    // on the dashboard, which is a very confusing way for a UI check to fail.
    await cdp.send('Page.reload');
    await sleep(1200);
    await cdp.evaluate(`(() => { window.location.hash = ${JSON.stringify(opts.path)}; true; })()`);
    await sleep(600);
  }

  return { cdp, login, propertyId, consoleErrors, targetId: target.id as string };
}

/** Poll until the page's text matches, so a slow render is waited on, not raced. */
export async function waitFor(cdp: Cdp, what: RegExp, timeoutMs = 20_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < until) {
    try { text = await cdp.evaluate<string>('document.body.innerText'); } catch { /* navigating */ }
    if (what.test(text)) return text;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}. Last saw:\n${text.slice(0, 600)}`);
}
