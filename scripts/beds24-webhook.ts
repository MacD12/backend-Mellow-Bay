// ─────────────────────────────────────────────────────────────
// Tell Beds24 where to call when a booking changes.
//
//   npm run beds24:webhook                          show what is set now
//   npm run beds24:webhook -- https://pms.example.com    register that URL
//   npm run beds24:webhook -- --clear               stop Beds24 calling
//
// Beds24 keeps a webhook per property: a URL, and a `customHeader` it sends
// with every call. That header is the only thing distinguishing Beds24 from
// anyone who guesses the path, so it is set to `HELIO_WEBHOOK_SECRET` and the
// endpoint refuses anything that does not present it.
//
// **The URL has to be reachable from the internet.** Beds24 cannot call
// `localhost`. Until this is deployed somewhere with a hostname — or put behind
// a tunnel — the booking poll is what keeps Helio current, which it does on its
// own every minute.
// ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const CLEAR = args.includes('--clear');
const target = args.find((a) => !a.startsWith('--'));

const { migrate, get } = await import('../src/db.ts');

function out(s = '') { process.stdout.write(`${s}\n`); }
function fail(s: string): never { throw new Error(s); }

const BASE = process.env.BEDS24_API ?? 'https://api.beds24.com/v2';

async function token(): Promise<string> {
  const refreshToken = process.env.BEDS24_REFRESH_TOKEN?.trim();
  if (!refreshToken) fail('BEDS24_REFRESH_TOKEN is not set.');
  const r = await fetch(`${BASE}/authentication/token`, { headers: { refreshToken } });
  const body = await r.json() as any;
  if (!body?.token) fail(`Beds24 refused the token: ${JSON.stringify(body).slice(0, 200)}`);
  return body.token as string;
}

async function main() {
  out('\nBeds24 · webhook');
  out('════════════════');
  migrate();

  const channel = get<{ external_property_id: string | null; name: string }>(
    `SELECT external_property_id, name FROM channels WHERE status = 'connected' LIMIT 1`);
  if (!channel?.external_property_id) {
    fail('No connected channel with a Beds24 property id. Connect it first:\n'
      + '   npm run beds24:golive');
  }
  const propertyId = channel.external_property_id;
  const t = await token();
  const H = { token: t, accept: 'application/json', 'content-type': 'application/json' };

  // What Beds24 holds right now.
  const read = await (await fetch(
    `${BASE}/properties?id=${propertyId}`, { headers: H })).json() as any;
  const current = read?.data?.[0]?.webhooks ?? {};
  out(`\nProperty ${propertyId} · ${read?.data?.[0]?.name ?? ''}`);
  out(`  url          ${current.url || '(none — Beds24 is not calling this installation)'}`);
  out(`  customHeader ${current.customHeader ? '(set)' : '(none)'}`);
  out(`  version      ${current.version ?? '—'}`);

  if (!target && !CLEAR) {
    out('\nPass a public base URL to register it, or --clear to stop Beds24 calling.');
    out('  npm run beds24:webhook -- https://pms.example.com');
    return;
  }

  const secret = process.env.HELIO_WEBHOOK_SECRET?.trim();
  if (!CLEAR) {
    if (!secret || secret.length < 16) {
      fail('Set HELIO_WEBHOOK_SECRET to at least 16 characters first.\n'
        + '   It is the only thing that distinguishes Beds24 from anyone who guesses the path,\n'
        + '   and the endpoint refuses every call without it.');
    }
    if (!/^https:\/\//i.test(target!)) {
      // The secret travels in a header on every call.
      fail('The URL must be https — the shared secret is sent with every request.');
    }
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(target!)) {
      fail('Beds24 cannot reach localhost. Deploy Helio, or put it behind a tunnel,\n'
        + '   and register that hostname instead. Until then the booking poll keeps Helio current.');
    }
  }

  const url = CLEAR ? '' : `${target!.replace(/\/+$/, '')}/api/webhooks/beds24`;
  const res = await fetch(`${BASE}/properties`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify([{
      id: Number(propertyId),
      webhooks: {
        version: current.version || 'one',
        url,
        additionalData: current.additionalData || 'none',
        customHeader: CLEAR ? '' : `X-Helio-Secret: ${secret}`,
      },
    }]),
  });

  // Beds24 answers a refused write with a success-shaped status and puts the
  // refusal in the body, so the body is what decides.
  const body = await res.json() as any;
  const items = Array.isArray(body) ? body : [body];
  const bad = items.filter((i) => i && i.success === false);
  if (bad.length) {
    fail(`Beds24 refused: ${bad.map((b) => (b.errors ?? [])
      .map((e: any) => e.message ?? e.error).join('; ')).join(' · ')}`);
  }

  out(CLEAR
    ? '\n✓ Beds24 will no longer call this installation. The booking poll still runs.'
    : `\n✓ Beds24 will now call ${url} when a booking changes.`);
  if (!CLEAR) {
    out('  It sends the secret as X-Helio-Secret; anything without it is refused.');
    out('  The booking poll stays on as the backstop.');
  }
}

main().catch((e) => {
  process.stderr.write(`\n✗ ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exit(1);
});
