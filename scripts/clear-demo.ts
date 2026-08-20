// ─────────────────────────────────────────────────────────────
// Remove the demo data.
//
//   node --experimental-sqlite scripts/clear-demo.ts          # say what would go
//   node --experimental-sqlite scripts/clear-demo.ts --yes    # do it
//
// Before a property goes live on real Beds24 data, Mellow Bay and its two weeks
// of invented bookings have to go — otherwise real arrivals appear alongside
// fictional ones and nobody can tell which is which.
//
// This deletes a whole property. So it is built to refuse rather than to
// destroy:
//
//   · It takes a backup first, always, even on a dry run of the real thing.
//   · It refuses any property that shows signs of real use — a booking made
//     from a channel, a real payment, a connected channel — unless you say
//     --force and mean it.
//   · It never touches users, so you do not lock yourself out.
//
// The demo is recognised by what `demo.ts` creates, not by a flag, because a
// property somebody has started using for real must not be deletable just
// because it was seeded from the demo.
// ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const CONFIRMED = args.includes('--yes');
const FORCE = args.includes('--force');
const CODE = args.find((a) => !a.startsWith('--'));

const { migrate, all, run, scalar, tx } = await import('../src/db.ts');
const { runBackup } = await import('../src/services/backup.ts');

function out(s = '') { process.stdout.write(`${s}\n`); }
function fail(s: string): never { throw new Error(s); }

interface Signals {
  channelBookings: number;
  payments: number;
  connectedChannels: number;
  recentBookings: number;
}

/** Evidence that somebody is actually trading on this property. */
function realUseSignals(propertyId: string): Signals {
  return {
    // A booking that came from an OTA cannot have been invented by the seeder.
    channelBookings: scalar<number>(
      `SELECT count(*) AS n FROM reservations
        WHERE property_id = ? AND origin = 'channel'`, propertyId),
    payments: scalar<number>(
      `SELECT count(*) AS n FROM folio_lines
        WHERE property_id = ? AND kind = 'payment' AND voided = 0`, propertyId),
    connectedChannels: scalar<number>(
      `SELECT count(*) AS n FROM channels
        WHERE property_id = ? AND status = 'connected'`, propertyId),
    // Anything created in the last day is unlikely to be two-week-old demo data.
    recentBookings: scalar<number>(
      `SELECT count(*) AS n FROM reservations
        WHERE property_id = ? AND created_at > ?`,
      propertyId, new Date(Date.now() - 86_400_000).toISOString()),
  };
}

function describe(propertyId: string) {
  const counts: Record<string, number> = {};
  for (const table of [
    'reservations', 'reservation_nights', 'folios', 'folio_lines', 'profiles',
    'rooms', 'room_types', 'rate_plans', 'rate_calendar', 'channels',
    'notifications', 'audit_log', 'daily_stats',
  ]) {
    counts[table] = scalar<number>(
      `SELECT count(*) AS n FROM ${table} WHERE property_id = ?`, propertyId);
  }
  return counts;
}

async function main() {
  out('\nClear demo data');
  out('═══════════════');
  migrate();

  const properties = all<{ id: string; code: string; name: string; business_date: string }>(
    'SELECT id, code, name, business_date FROM properties ORDER BY created_at');
  if (!properties.length) fail('There are no properties — nothing to clear.');

  const target = CODE
    ? properties.find((p) => p.code.toLowerCase() === CODE.toLowerCase())
    : properties.length === 1 ? properties[0] : undefined;

  if (!target) {
    out('\nWhich property? Pass its code:\n');
    for (const p of properties) out(`  ${p.code.padEnd(10)} ${p.name}`);
    out('\n  node --experimental-sqlite scripts/clear-demo.ts MELLOW --yes\n');
    return;
  }

  out(`\nProperty   ${target.name} (${target.code})`);
  out(`Business date  ${target.business_date}\n`);

  const counts = describe(target.id);
  out('This would delete:');
  for (const [table, n] of Object.entries(counts)) {
    if (n > 0) out(`  ${String(n).padStart(6)}  ${table}`);
  }

  // ── Refuse anything that looks like real trading ──────────
  const signals = realUseSignals(target.id);
  const looksReal = signals.channelBookings > 0 || signals.connectedChannels > 0
    || signals.recentBookings > 0;

  if (looksReal) {
    out('\n⚠  This property shows signs of real use:');
    if (signals.channelBookings) out(`     ${signals.channelBookings} booking(s) came from a channel`);
    if (signals.connectedChannels) out(`     ${signals.connectedChannels} channel(s) are connected`);
    if (signals.recentBookings) out(`     ${signals.recentBookings} booking(s) made in the last 24 hours`);
    if (signals.payments) out(`     ${signals.payments} payment(s) on file`);
    if (!FORCE) {
      fail('Refusing to delete a property that appears to be in use.\n'
        + '   If you are certain, re-run with --force --yes.');
    }
    out('\n   --force given: proceeding anyway.');
  }

  if (!CONFIRMED) {
    out('\nDry run. Nothing has been changed.');
    out(`Re-run to delete:\n\n  node --experimental-sqlite scripts/clear-demo.ts ${target.code} --yes\n`);
    return;
  }

  // ── A way back ────────────────────────────────────────────
  out('\nTaking a backup first…');
  const backup = runBackup('manual', 'before-clear-demo');
  if (backup.status !== 'verified') {
    fail(`The backup did not verify (${backup.error ?? 'unknown'}). Nothing was deleted.`);
  }
  out(`  ✓ ${backup.filename}`);
  out('    If this was a mistake, that file is the way back.\n');

  // ── Delete ────────────────────────────────────────────────
  // Most tables cascade from `properties`, but the ones that reference it only
  // by a plain column do not — those are cleared explicitly first.
  tx(() => {
    for (const table of [
      'notifications', 'alert_events', 'audit_log', 'daily_stats', 'sequences',
      'settings', 'channel_queue', 'channel_sync_log',
    ]) {
      run(`DELETE FROM ${table} WHERE property_id = ?`, target.id);
    }
    run('DELETE FROM properties WHERE id = ?', target.id);
  });

  const left = scalar<number>('SELECT count(*) AS n FROM properties WHERE id = ?', target.id);
  if (left !== 0) fail('The property is still there — nothing was committed.');

  out(`✓ ${target.name} and everything belonging to it has been removed.`);
  out('  User accounts were left alone, so you can still sign in.\n');

  const remaining = scalar<number>('SELECT count(*) AS n FROM properties');
  if (remaining === 0) {
    out('This installation now has no property. The app will open the setup wizard.');
    out('Create your real property, then:  npm run beds24:golive\n');
  } else {
    out(`${remaining} property(ies) remain.\n`);
  }
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\n✗ ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exitCode = 1;
}
