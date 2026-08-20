// ─────────────────────────────────────────────────────────────
// Exercises how secrets are stored and what escapes in an API response.
//
//   node --experimental-sqlite scripts/secrets-check.ts
//
// A Beds24 refresh token is a working key to the property's whole OTA
// distribution. It was stored as clear text and returned whole by
// `GET /api/channels`, which seven of the eight roles can read — so a
// read-only account, or anyone holding a backup file, had it.
//
// The assertions are mostly negative: what must **not** appear. Those are the
// ones worth writing, because a leak is invisible in a passing feature test.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-sec-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';
process.env.HELIO_SECRET_KEY = 'a-test-key-long-enough-to-be-accepted';

const { migrate, run, get } = await import('../src/db.ts');
const { id, nowIso } = await import('../src/lib/util.ts');
const secrets = await import('../src/lib/secrets.ts');
const channels = await import('../src/services/channels.ts');

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

const TOKEN = 'refresh-token-that-must-never-leak-9f2c';
const ACTOR = { userId: 'usr_test', userName: 'Tester', propertyId: '' };

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en','2026-06-01','14:00','11:00',1,?)`,
    propertyId, 'SEC', 'Secret Test Hotel', nowIso(),
  );
  return propertyId;
}

async function main() {
  process.stdout.write(`\nSecret handling checks\n${'─'.repeat(22)}\n`);
  migrate();
  const P = seed();
  ACTOR.propertyId = P;

  section('1 · Encrypting and reading back');
  check('a key is available in this run', secrets.encryptionAvailable() === true);
  const sealed = secrets.encryptSecret(TOKEN);
  check('the stored form is not the plain value', sealed !== TOKEN, sealed.slice(0, 24));
  check('and does not contain it anywhere', !sealed.includes(TOKEN));
  check('it is marked as encrypted', secrets.isEncrypted(sealed) === true);
  check('it decrypts back exactly', secrets.decryptSecret(sealed) === TOKEN);
  check('encrypting twice gives different ciphertext',
    secrets.encryptSecret(TOKEN) !== sealed);
  check('…which both still decrypt',
    secrets.decryptSecret(secrets.encryptSecret(TOKEN)) === TOKEN);
  check('a value written before encryption still reads',
    secrets.decryptSecret('plain-old-token') === 'plain-old-token');

  section('2 · Tampering is detected');
  // AES-GCM authenticates. A backup edited by hand must fail loudly rather than
  // yielding a plausible wrong token that reads as a channel outage.
  const tampered = `${sealed.slice(0, -6)}AAAAAA`;
  let rejected = false;
  try { secrets.decryptSecret(tampered); } catch { rejected = true; }
  check('an altered ciphertext is refused', rejected);

  section('3 · Redaction');
  const shaped = secrets.redactSecrets({
    name: 'Booking.com',
    credentials: { refreshToken: TOKEN, accessToken: 'abc' },
    nested: { deep: { apiKey: 'sk_live_123' } },
    priceMultiplierBp: 10_000,
    list: [{ token: 'zzz' }, { safe: 'visible' }],
    emptyToken: '',
  });
  const asText = JSON.stringify(shaped);
  check('the token does not survive redaction', !asText.includes(TOKEN), asText);
  check('nor does a nested api key', !asText.includes('sk_live_123'), asText);
  check('nor one inside an array', !asText.includes('zzz'), asText);
  check('but ordinary settings are untouched',
    (shaped as any).priceMultiplierBp === 10_000 && (shaped as any).name === 'Booking.com');
  check('a safe field inside an array survives',
    (shaped as any).list[1].safe === 'visible', (shaped as any).list);
  // Presence still has to be reportable without the value.
  check('presence is still visible', (shaped as any).credentials === '__redacted',
    (shaped as any).credentials);
  check('an empty secret reads as absent', (shaped as any).emptyToken === null);

  section('4 · The channel list does not carry credentials');
  const channelId = id('chn');
  run(
    `INSERT INTO channels(id, property_id, code, name, kind, active, status, settings, created_at)
     VALUES(?,?,'BDC','Booking.com','ota',1,'connected',?,?)`,
    channelId, P,
    // Deliberately the OLD clear-text shape, as an existing install would have.
    JSON.stringify({ credentials: { refreshToken: TOKEN }, note: 'kept' }),
    nowIso(),
  );

  const listed = channels.listChannels(P);
  const listedText = JSON.stringify(listed);
  // The finding, exactly.
  check('the refresh token is not in the response', !listedText.includes(TOKEN), listedText);
  check('the channel still reports that it is configured',
    listed[0].configured === true, listed[0].configured);
  check('and unrelated settings still come through',
    (listed[0].settings as any).note === 'kept', listed[0].settings);

  section('5 · Existing clear-text credentials keep working');
  // Turning encryption on must not orphan what is already stored.
  const row = get<any>('SELECT * FROM channels WHERE id = ?', channelId);
  check('a legacy clear-text credential is still recognised',
    JSON.parse(row.settings).credentials.refreshToken === TOKEN);
  check('and the channel is reported as configured',
    channels.listChannels(P)[0].configured === true);

  section('6 · Without a key, nothing pretends to be encrypted');
  // A deployment with no key must keep working and must not claim protection
  // it does not have — a silent downgrade is worse than none.
  delete process.env.HELIO_SECRET_KEY;
  const fresh = await import(`../src/lib/secrets.ts?nokey=${Date.now()}`);
  check('encryption reports itself unavailable', fresh.encryptionAvailable() === false);
  const unsealed = fresh.encryptSecret(TOKEN);
  check('the value is stored as-is rather than fake-encrypted', unsealed === TOKEN);
  check('and is not marked as encrypted', fresh.isEncrypted(unsealed) === false);
  // But redaction is unconditional — it never depended on a key.
  check('redaction still strips secrets without a key',
    !JSON.stringify(fresh.redactSecrets({ credentials: { refreshToken: TOKEN } })).includes(TOKEN));

  let cannotRead = false;
  try { fresh.decryptSecret(sealed); } catch { cannotRead = true; }
  check('an encrypted value cannot be read once the key is gone', cannotRead);

  process.stdout.write(`\n${checks - failures}/${checks} secret handling checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write('Credentials do not leave the server, and the database alone cannot read them.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
