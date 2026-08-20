// ─────────────────────────────────────────────────────────────
// Empty a property of its demo content, without deleting the property.
//
//   node --experimental-sqlite scripts/clear-demo-inventory.ts          (dry run)
//   node --experimental-sqlite scripts/clear-demo-inventory.ts --yes    (do it)
//
// `clear-demo.ts` deletes a whole property. That is the right tool for a
// throwaway installation and the wrong one here: once Beds24 is connected, the
// property row owns the channel and its encrypted refresh token, and dropping
// it would mean re-authorising the OTA connection just to get rid of some
// sample bookings.
//
// So this clears the *contents* and keeps the shell:
//
//   kept   the property, every user and role assignment, connected channels and
//          their credentials, tax rules, policies, transaction codes, document
//          number sequences, and the audit log
//   gone   room types, rooms, beds, bookings, guest profiles, folios, rates,
//          housekeeping, and every record derived from them
//
// **The clearable set is derived from the schema, not listed by hand.** Any
// table carrying a `property_id` is content unless it appears in `KEEP` below.
// A hand-written list silently misses whatever table was added last, which is
// how "cleared" databases keep their old room types.
//
// Three safety rules, the same as `clear-demo.ts`:
//   · a verified backup is taken first, always;
//   · it refuses if the property shows signs of real trading;
//   · nothing happens without `--yes`.
// ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const CONFIRM = args.includes('--yes');
const FORCE = args.includes('--force');
const propertyArg = args.find((a) => !a.startsWith('--'));

const { migrate, all, get, run, tx } = await import('../src/db.ts');
const { runBackup } = await import('../src/services/backup.ts');

function out(s = '') { process.stdout.write(`${s}\n`); }
function fail(s: string): never { throw new Error(s); }

/**
 * Tables that survive a clear.
 *
 * The test for membership is: *would a person have to set this up again, or is
 * it a credential or a record of what happened?* Room rates fail that test —
 * they come back from Beds24. Tax rules pass it: someone entered them, they
 * reference no inventory, and re-typing them is how a property ends up billing
 * the wrong VAT.
 */
const KEEP = new Set([
  // The property itself.
  'properties',
  // Accounts, roles and everything authentication touches.
  'users', 'user_properties', 'sessions', 'password_resets', 'login_attempts',
  'mfa_recovery_codes',
  // Channel connections hold encrypted credentials, so they are never deleted
  // wholesale — see PARTIAL below, which drops only the ones never configured.
  'channels',
  // Configured rules that reference no inventory.
  'settings', 'policies', 'taxes', 'transaction_codes', 'sequences',
  'message_templates',
  // Records of what happened. Deleting an audit trail to tidy up is exactly
  // what an audit trail exists to prevent.
  'audit_log', 'audit_runs', 'backups', 'db_checks', 'schema_meta',
]);

/**
 * Tables that are kept, but not entirely.
 *
 * A channel row that was never configured is a demo placeholder — a name in a
 * list with no credential behind it, offering to sync a property that has not
 * agreed to sync with it. Those go. A *connected* channel is the one thing in
 * this database that cannot be recreated from a script, so it stays.
 */
const PARTIAL: Record<string, { where: string; describe: string }> = {
  channels: {
    where: `status <> 'connected'`,
    describe: 'channels that were never configured',
  },
};

/**
 * Join tables that belong to the content but carry no `property_id` of their
 * own, so the derivation cannot find them. Each is scoped through its parent.
 */
const SCOPED_BY_PARENT: Record<string, { via: string; parent: string }> = {
  reservation_guests: { via: 'reservation_id', parent: 'reservations' },
  rate_plan_room_types: { via: 'rate_plan_id', parent: 'rate_plans' },
  group_blocks: { via: 'group_id', parent: 'groups' },
};

interface Col { name: string }
interface Fk { table: string }

function tables(): string[] {
  return all<{ name: string }>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .map((r) => r.name);
}

function hasPropertyId(table: string): boolean {
  return all<Col>(`PRAGMA table_info(${table})`).some((c) => c.name === 'property_id');
}

/**
 * Order the deletes so a table goes before anything it points at.
 *
 * Derived from the foreign keys rather than hand-sequenced, because a hand
 * sequence is correct only until the next table is added — and the failure is a
 * constraint error halfway through a delete, on a database someone is waiting on.
 */
function deletionOrder(targets: string[]): string[] {
  const set = new Set(targets);
  const deps = new Map<string, string[]>();
  for (const t of targets) {
    const refs = all<Fk>(`PRAGMA foreign_key_list(${t})`)
      .map((f) => f.table).filter((r) => set.has(r) && r !== t);
    deps.set(t, [...new Set(refs)]);
  }
  const ordered: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (t: string) => {
    if (done.has(t) || visiting.has(t)) return;   // a cycle just keeps its order
    visiting.add(t);
    // Anything referencing t must be deleted first, so visit dependents first:
    for (const other of targets) {
      if (other !== t && deps.get(other)?.includes(t)) visit(other);
    }
    visiting.delete(t);
    done.add(t);
    ordered.push(t);
  };
  for (const t of targets) visit(t);
  return ordered;
}

/** Signs the property is not a sandbox. */
function realUseSignals(propertyId: string) {
  const one = (sql: string, ...a: unknown[]) => safe(() =>
    Number(get<{ c: number }>(sql, ...a)?.c ?? 0));
  return {
    connectedChannels: one(
      `SELECT COUNT(*) c FROM channels WHERE property_id = ? AND status = 'connected'`, propertyId),
    // A booking that carries an OTA reference was created by an importer, not
    // by the seeder — the seeded rows have a source of 'OTA' but no reference,
    // because nothing ever imported them.
    channelBookings: one(
      `SELECT COUNT(*) c FROM reservations
        WHERE property_id = ? AND ota_reference IS NOT NULL AND ota_reference <> ''`,
      propertyId),
    recentBookings: one(
      `SELECT COUNT(*) c FROM reservations
        WHERE property_id = ? AND created_at > datetime('now','-1 day')`, propertyId),
    money: one(
      `SELECT COUNT(*) c FROM folio_lines
        WHERE property_id = ? AND kind = 'payment'`, propertyId),
  };
}

function safe(f: () => number): number {
  try { return f(); } catch { return 0; }
}

async function main() {
  out('\nClear demo inventory');
  out('════════════════════');
  migrate();

  const properties = all<{ id: string; code: string; name: string }>(
    'SELECT id, code, name FROM properties ORDER BY created_at');
  if (!properties.length) fail('There are no properties.');

  const target = propertyArg
    ? properties.find((p) => p.id === propertyArg || p.code === propertyArg)
    : properties.length === 1 ? properties[0] : undefined;
  if (!target) {
    fail(propertyArg
      ? `No property matches "${propertyArg}".`
      : `This installation has ${properties.length} properties — name the one to clear.`);
  }
  out(`\nProperty: ${target.name} (${target.code})`);

  // Derive what counts as content.
  const derived = tables().filter((t) => !KEEP.has(t) && hasPropertyId(t));
  const scoped = Object.keys(SCOPED_BY_PARENT).filter((t) => tables().includes(t));
  // Scoped tables first: each finds its rows through its parent, so deleting
  // the parent first would leave them orphaned and uncounted.
  const ordered = [...scoped, ...deletionOrder(derived), ...Object.keys(PARTIAL)];

  /** The WHERE clause for one table, and the single `property_id` it binds. */
  const clauseFor = (t: string) => {
    const sp = SCOPED_BY_PARENT[t];
    if (sp) return `${sp.via} IN (SELECT id FROM ${sp.parent} WHERE property_id = ?)`;
    const p = PARTIAL[t];
    return p ? `property_id = ? AND (${p.where})` : 'property_id = ?';
  };

  const counted: { table: string; rows: number }[] = [];
  for (const t of ordered) {
    const n = safe(() => Number(get<{ c: number }>(
      `SELECT COUNT(*) c FROM ${t} WHERE ${clauseFor(t)}`, target.id)?.c ?? 0));
    if (n) counted.push({ table: t, rows: n });
  }

  if (!counted.length) {
    out('\nNothing to clear — this property is already empty.');
    return;
  }

  out(`\nWould delete ${counted.reduce((a, b) => a + b.rows, 0)} row(s):`);
  for (const r of counted) {
    out(`   ${String(r.rows).padStart(6)}  ${r.table}`
      + (PARTIAL[r.table] ? `   (only ${PARTIAL[r.table].describe})` : ''));
  }
  out(`\nWould keep: the property, ${KEEP.size} configuration and account tables,`);
  out('            and every connected channel with its credentials.');

  // A connected channel is expected — this script exists to make room behind
  // one — so it is reported, not treated as a blocker. Money and real bookings
  // are blockers.
  const s = realUseSignals(target.id);
  const blockers: string[] = [];
  if (s.channelBookings) blockers.push(`${s.channelBookings} booking(s) that came from a channel`);
  if (s.money) blockers.push(`${s.money} recorded payment line(s)`);
  if (s.recentBookings) blockers.push(`${s.recentBookings} booking(s) created in the last 24 hours`);

  if (blockers.length) {
    out('\n⚠  This property shows signs of real use:');
    for (const b of blockers) out(`   · ${b}`);
    if (!FORCE) {
      fail('Refusing to clear a property that has been used for real.\n'
        + '   If you are certain these are demo records, add --force.\n'
        + '   A verified backup is taken either way.');
    }
    out('\n   --force given, continuing.');
  }
  if (s.connectedChannels) {
    out(`\n   ${s.connectedChannels} connected channel(s) — kept, credentials intact.`);
  }

  if (!CONFIRM) {
    out('\nDry run. Nothing was changed. Add --yes to go ahead.');
    return;
  }

  out('\nTaking a backup first…');
  const backup = runBackup('manual', 'before-clear-demo-inventory');
  if (backup.status !== 'verified') {
    fail(`The backup did not verify (${backup.error ?? 'unknown'}). Nothing was deleted.`);
  }
  out(`  ✓ ${backup.filename}`);

  // One transaction. A half-cleared property — rooms gone, bookings still
  // pointing at them — is worse than either state on its own.
  let deleted = 0;
  tx(() => {
    for (const t of ordered) {
      const r = run(`DELETE FROM ${t} WHERE ${clauseFor(t)}`, target.id);
      deleted += Number(r.changes ?? 0);
    }
  });

  out(`\n✓ Cleared ${deleted} row(s) from ${target.name}.`);
  out(`  Backup: ${backup.filename}`);
  out('\nNext — rebuild the inventory from Beds24:');
  out('  npm run beds24:golive -- --create-room-types --import');
}

main().catch((e) => {
  process.stderr.write(`\n✗ ${e instanceof Error ? e.message : String(e)}\n\n`);
  process.exit(1);
});
