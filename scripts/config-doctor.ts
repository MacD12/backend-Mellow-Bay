// ─────────────────────────────────────────────────────────────
// `npm run config` — what this installation is actually configured to do.
//
// The question an operator has at three in the morning is never "what does the
// documentation say the default is". It is "what is this machine using, and
// where did it get it from". So every setting is printed with its resolved
// value and its source: the shell, a named file, or the built-in default.
//
// Secrets are never printed. A length and a short fingerprint answer both
// questions worth asking — "is one set?" and "is it the same one as on the
// other machine?" — without putting a credential in a terminal, a screenshot
// or a support ticket.
//
//   npm run config           the report
//   npm run config:check     the same checks, no output unless something is
//                            wrong, non-zero exit — for CI and deploy scripts
//   npm run config:example   regenerate .env.example from the schema
// ─────────────────────────────────────────────────────────────

// Set before the import: `config.ts` exits the process when validation fails,
// which is right for the server and useless for the tool whose entire job is
// explaining the failure.
process.env.CONFIG_NO_EXIT = '1';

const { config, configReport, MODE } = await import('../src/config.ts');
const { fingerprint, renderExample, formatProblems } = await import('../src/lib/env.ts');

// `configReport.schema` rather than the `SCHEMA` export: the export keeps its
// literal type, so iterating it gives a union of thirty different shapes and
// `entry.secret` only exists on some of them. This one is typed as `Schema`.
const SCHEMA = configReport.schema;

/** `padEnd` that ignores colour codes, which are bytes but not columns. */
function pad(text: string, width: number): string {
  const visible = text.replace(/\[[0-9;]*m/g, '').length;
  return text + ' '.repeat(Math.max(1, width - visible));
}

const args = new Set(process.argv.slice(2));
const quiet = args.has('--check');
const writeExample = args.has('--example');

const RESET = '[0m', BOLD = '[1m', DIM = '[2m';
const GREEN = '[32m', YELLOW = '[33m', RED = '[31m', CYAN = '[36m';
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (tty ? code + s + RESET : s);

// ─── .env.example regeneration ───────────────────────────────
if (writeExample) {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const header = `# Helio PMS — API configuration
#
#   cp .env.example .env      then edit
#
# GENERATED FROM src/config.ts — do not edit by hand.
# Run \`npm run config:example\` after changing the schema.
#
# Every variable here has a working default except HELIO_SECRET_KEY, which has
# none and is the one you must set before going live.
#
# Files are read in this order, each overriding the one before it, and the real
# environment overrides all of them:
#
#     .env                .env.local            (this machine, never committed)
#     .env.<mode>         .env.<mode>.local     (mode is NODE_ENV)
#
# Check what the server resolved with:  npm run config`;

  const target = join(configReport.root, '.env.example');
  writeFileSync(target, renderExample(SCHEMA, header, configReport.root), 'utf8');
  process.stdout.write(`Wrote ${target}\n`);
  process.exit(0);
}

// ─── The report ──────────────────────────────────────────────
const errors = configReport.problems.filter((p) => p.severity === 'error');
const warnings = configReport.problems.filter((p) => p.severity === 'warning');

if (!quiet) {
  const out: string[] = [];
  out.push('');
  out.push(`${paint(BOLD, 'helio.pms configuration')}  ${paint(DIM, `· mode ${MODE}`)}`);
  out.push('');

  // Which files exist matters as much as the values: "I edited .env.local" is a
  // complete explanation of a surprise, and a file that was never read is the
  // other half of it.
  out.push(paint(BOLD, 'Files'));
  for (const f of configReport.files) {
    const name = f.path.replace(configReport.envDir + '\\', '').replace(configReport.envDir + '/', '');
    out.push(f.exists
      ? `  ${paint(GREEN, '✓')} ${name.padEnd(24)} ${paint(DIM, `${f.keys} value(s)`)}`
      : `  ${paint(DIM, '·')} ${paint(DIM, name.padEnd(24) + ' not present')}`);
  }
  out.push('');

  // Grouped exactly as the schema is, so this report and .env.example read the
  // same way round.
  const groups = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(SCHEMA)) {
    const origin = configReport.origins.get(name);
    const value = (config as Record<string, unknown>)[name];

    let shown: string;
    if (value === undefined) {
      shown = paint(DIM, 'not set');
    } else if (entry.secret) {
      shown = paint(CYAN, fingerprint(String(value)));
    } else if (Array.isArray(value)) {
      shown = value.length <= 2 ? value.join(', ') : `${value.length} entries`;
    } else {
      shown = String(value);
    }

    const from = origin?.from === 'file' ? (origin.file ?? 'file')
      : origin?.from === 'shell' ? 'environment'
        : origin?.from === 'default' ? 'default'
          // Not set and not defaulted, yet it has a value: something computed
          // it. Saying so beats a dash an operator has to go and investigate.
          : value !== undefined ? 'derived' : 'not set';
    const emphasis = origin?.from === 'file' || origin?.from === 'shell' ? BOLD : DIM;

    const list = groups.get(entry.group) ?? [];
    list.push(`  ${entry.env.padEnd(34)} ${pad(paint(emphasis, shown), 46)} ${paint(DIM, from)}`);
    groups.set(entry.group, list);
  }

  for (const [group, lines] of groups) {
    out.push(paint(BOLD, group));
    out.push(...lines);
    out.push('');
  }

  // The derived one. It has no variable of its own unless overridden, and an
  // operator hunting for "where are my backups" should not have to infer it.
  out.push(paint(BOLD, 'Resolved paths'));
  out.push(`  ${'database'.padEnd(34)} ${config.databasePath}`);
  out.push(`  ${'backups'.padEnd(34)} ${config.backupDir}`);
  out.push('');

  process.stdout.write(out.join('\n') + '\n');
}

if (configReport.problems.length) {
  process.stderr.write(formatProblems(configReport.problems, MODE));
} else if (!quiet) {
  process.stdout.write(paint(GREEN, '  No problems found.\n\n'));
}

if (errors.length) {
  process.stderr.write(
    `${paint(RED, `${errors.length} error(s)`)} — the server will not start with this configuration.\n\n`,
  );
  process.exit(78); // EX_CONFIG
}
if (warnings.length && quiet) {
  process.stderr.write(`${paint(YELLOW, `${warnings.length} warning(s)`)}.\n`);
}
process.exit(0);
