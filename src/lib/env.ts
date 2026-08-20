// ─────────────────────────────────────────────────────────────
// Environment loading and validation.
//
// This exists because configuration used to be read wherever it was needed:
// `Number(process.env.PORT ?? 8080)` in one file, `process.env.HELIO_DB ?? …`
// in another, roughly thirty of them across the server and its scripts. That
// arrangement has three failure modes and the server hit all three:
//
//   · **A bad value is accepted.** `PORT=80a0` parses to `NaN` and the server
//     binds something nobody asked for. `HELIO_NIGHT_AUDIT_HOUR=25` schedules a
//     job for an hour that does not exist.
//   · **A typo is silent.** `HELIO_BACKUP_ENABLE=false` — one letter short of
//     `..._ENABLED` — leaves backups on while the operator believes they are
//     off. Nothing reads the misspelled name, so nothing complains.
//   · **A missing secret downgrades security quietly.** A `HELIO_SECRET_KEY`
//     under sixteen characters turns off encryption at rest and the server
//     keeps running. That is the correct behaviour for a developer laptop and
//     the wrong one for a machine holding real card tokens.
//
// So: every variable is declared once, with a type, a default, documentation
// and — where it matters — a rule about which environments must supply it.
// Everything is checked on the way up, every problem is reported together
// rather than one per restart, and a server that cannot be configured
// correctly refuses to start instead of running in a shape nobody chose.
//
// No dependencies. The dotenv format is small enough to parse honestly, and a
// config loader is the wrong place to inherit somebody else's supply chain.
// ─────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

// ─── Types ───────────────────────────────────────────────────

/** A value type: how to turn the raw string into `T`, and how to say so. */
export interface Kind<T> {
  /** Human phrasing for an error message: "an integer between 1 and 65535". */
  readonly describe: string;
  /** Throws an `Error` whose message completes "must be …". */
  readonly parse: (raw: string) => T;
}

/** When a variable has to be present rather than falling back to a default. */
export type Requirement = 'always' | 'production' | 'never';

export interface Entry<T> {
  /** The variable name, exactly as it appears in the environment. */
  readonly env: string;
  readonly kind: Kind<T>;
  /** One or two sentences: what this changes, in terms of behaviour. */
  readonly doc: string;
  /** Heading it is filed under in `.env.example` and the doctor report. */
  readonly group: string;
  /** Used when the variable is absent. Absent `fallback` means "undefined". */
  readonly fallback?: T;
  /** Default `'never'`: absent is fine everywhere. */
  readonly required?: Requirement;
  /** Never printed, never logged — reported as a length and a fingerprint. */
  readonly secret?: boolean;
  /** Shown in `.env.example`. Must never be a real credential. */
  readonly example?: string;
  /**
   * A second opinion once the value has parsed: range checks that depend on
   * other settings, or advice that is not an outright error. Return a string
   * to warn, or throw to reject.
   */
  readonly review?: (value: T, mode: Mode) => string | void;
}

export type Schema = Record<string, Entry<any>>;

/**
 * A variable with a fallback, or one required everywhere, always has a value.
 * Anything else may legitimately be absent, and the type says so rather than
 * letting a `string` sit there being `undefined` at runtime.
 */
export type Values<S extends Schema> = {
  readonly [K in keyof S]: S[K] extends Entry<infer T>
    ? S[K] extends { fallback: any } ? T
      : S[K] extends { required: 'always' } ? T
        : T | undefined
    : never;
};

export type Mode = 'development' | 'test' | 'production';

/** Where a value came from, for the doctor report. */
export interface Origin {
  readonly env: string;
  readonly from: 'shell' | 'file' | 'default' | 'unset';
  /** Which file, when `from` is `'file'`. */
  readonly file?: string;
}

export interface Problem {
  readonly env: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly hint?: string;
}

// ─── The .env file format ────────────────────────────────────

/**
 * Parses dotenv text.
 *
 * Deliberately small and deliberately strict about the one thing that bites:
 * a double-quoted value expands `\n`, a single-quoted one does not, and an
 * unquoted one keeps neither its surrounding whitespace nor a trailing comment.
 * That is the behaviour every other dotenv implementation has, and a config
 * file that behaves differently here than in production is worse than no
 * config file at all.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  // A leading BOM survives a Windows editor and would otherwise become part of
  // the first key, producing a variable nothing can ever read.
  for (let line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    // `export FOO=bar` so the same file can be `source`d from a shell.
    if (line.startsWith('export ')) line = line.slice(7).trimStart();

    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    } else if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends at a ` #`. Requiring the space means a value
      // that legitimately contains a hash — plenty of generated secrets do —
      // survives, while `PORT=8080 # the api` does not keep the comment.
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out.set(key, value);
  }
  return out;
}

// ─── Loading ─────────────────────────────────────────────────

/**
 * The file cascade, lowest priority first — the same order Vite uses, so the
 * front end and the API behave identically and nobody has to remember two sets
 * of rules.
 *
 *   .env                  committed, safe defaults, no secrets
 *   .env.local            this machine, never committed
 *   .env.<mode>           committed, per-environment
 *   .env.<mode>.local     this machine, per-environment, never committed
 *
 * The real environment always wins over all of them. That is not a preference:
 * a container orchestrator, a systemd unit and a `HELIO_DB=… npm start` on the
 * command line all set variables that way, and a file that could quietly
 * override them would make a deployment unpredictable.
 */
export function envFilesFor(mode: Mode): string[] {
  return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
}

export interface LoadResult {
  readonly mode: Mode;
  /** Every candidate file, whether or not it existed. */
  readonly files: { path: string; exists: boolean; keys: number }[];
  /** Which file supplied each key that the shell did not already provide. */
  readonly fromFile: Map<string, string>;
  /** Keys the surrounding environment supplied directly. */
  readonly fromShell: Set<string>;
}

/**
 * Reads the cascade into `process.env`.
 *
 * Called once, by `config.ts`, before anything reads a value. Doing it here
 * rather than through `node --env-file` is what makes every one of the fifty
 * npm scripts see the same configuration: only seven of them passed the flag,
 * so `npm run restore` and `npm run backup` used to run without the secret key
 * that decrypts what they are handling.
 */
export function loadEnv(dir: string, mode: Mode): LoadResult {
  const files: LoadResult['files'] = [];
  const merged = new Map<string, string>();
  const source = new Map<string, string>();

  for (const name of envFilesFor(mode)) {
    const path = resolve(dir, name);
    if (!existsSync(path)) {
      files.push({ path, exists: false, keys: 0 });
      continue;
    }
    let parsed: Map<string, string>;
    try {
      parsed = parseEnvFile(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new Error(`Cannot read ${path}: ${(e as Error).message}`);
    }
    files.push({ path, exists: true, keys: parsed.size });
    for (const [k, v] of parsed) {
      merged.set(k, v);
      source.set(k, name);
    }
  }

  const fromShell = new Set<string>();
  const fromFile = new Map<string, string>();
  for (const [k, v] of merged) {
    // An empty string from the shell is treated as "not set". Docker and CI
    // both pass empty values for variables they have no answer for, and
    // letting that shadow a perfectly good file value produces an outage whose
    // cause is invisible in both places.
    const existing = process.env[k];
    if (existing !== undefined && existing !== '') {
      fromShell.add(k);
      continue;
    }
    process.env[k] = v;
    fromFile.set(k, source.get(k)!);
  }
  for (const k of Object.keys(process.env)) {
    if (!fromFile.has(k)) fromShell.add(k);
  }

  return { mode, files, fromFile, fromShell };
}

/** `NODE_ENV`, narrowed, because three spellings of "prod" is two too many. */
export function modeFrom(raw: string | undefined): Mode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'production' || v === 'prod') return 'production';
  if (v === 'test') return 'test';
  return 'development';
}

// ─── Value kinds ─────────────────────────────────────────────

export function str(opts: { min?: number; max?: number; pattern?: RegExp; patternLabel?: string } = {}): Kind<string> {
  const bits: string[] = [];
  if (opts.min !== undefined) bits.push(`at least ${opts.min} characters`);
  if (opts.max !== undefined) bits.push(`at most ${opts.max} characters`);
  if (opts.patternLabel) bits.push(opts.patternLabel);
  return {
    describe: bits.length ? `text (${bits.join(', ')})` : 'text',
    parse(raw) {
      if (opts.min !== undefined && raw.length < opts.min) {
        throw new Error(`be at least ${opts.min} characters (this one is ${raw.length})`);
      }
      if (opts.max !== undefined && raw.length > opts.max) {
        throw new Error(`be at most ${opts.max} characters (this one is ${raw.length})`);
      }
      if (opts.pattern && !opts.pattern.test(raw)) {
        throw new Error(`match ${opts.patternLabel ?? String(opts.pattern)}`);
      }
      return raw;
    },
  };
}

export function int(opts: { min?: number; max?: number } = {}): Kind<number> {
  const range = opts.min !== undefined && opts.max !== undefined
    ? ` between ${opts.min} and ${opts.max}`
    : opts.min !== undefined ? ` of at least ${opts.min}`
      : opts.max !== undefined ? ` of at most ${opts.max}` : '';
  return {
    describe: `a whole number${range}`,
    parse(raw) {
      // `Number()` is too generous: it accepts '', '0x10' and ' 12 '. Every one
      // of those in a port or an interval is a mistake worth reporting, not
      // worth guessing at.
      if (!/^-?\d+$/.test(raw.trim())) throw new Error(`be a whole number (got ${JSON.stringify(raw)})`);
      const n = Number(raw.trim());
      if (!Number.isFinite(n)) throw new Error(`be a whole number (got ${JSON.stringify(raw)})`);
      if (opts.min !== undefined && n < opts.min) throw new Error(`be at least ${opts.min} (got ${n})`);
      if (opts.max !== undefined && n > opts.max) throw new Error(`be at most ${opts.max} (got ${n})`);
      return n;
    },
  };
}

/**
 * An interval that can also be switched off with `0`.
 *
 * Three of this server's timers are guarded by `if (SECONDS > 0)`, so zero has
 * always meant "do not schedule this at all" — the verification suite relies on
 * it to stop a background drain interfering with a test. A plain minimum would
 * make that documented, working value a startup error, which is how this type
 * came to exist: the schema has to describe the setting as it is used, not as
 * it would be tidier.
 */
export function intOrOff(opts: { min: number; max: number }): Kind<number> {
  const inner = int(opts);
  return {
    describe: `a whole number between ${opts.min} and ${opts.max}, or 0 to switch it off`,
    parse(raw) {
      if (raw.trim() === '0') return 0;
      return inner.parse(raw);
    },
  };
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

export function bool(): Kind<boolean> {
  return {
    describe: 'true or false',
    parse(raw) {
      const v = raw.trim().toLowerCase();
      if (TRUE.has(v)) return true;
      if (FALSE.has(v)) return false;
      // The old code did `!== 'false'`, so `HELIO_BACKUP_ENABLED=no` quietly
      // meant *enabled*. Rejecting the ambiguous spelling is the only way the
      // operator finds out which way it went.
      throw new Error(`be one of 1/true/yes/on or 0/false/no/off (got ${JSON.stringify(raw)})`);
    },
  };
}

export function url(opts: { protocols?: string[] } = {}): Kind<string> {
  const protocols = opts.protocols ?? ['http:', 'https:'];
  return {
    describe: `a URL (${protocols.map((p) => p.replace(':', '')).join(' or ')})`,
    parse(raw) {
      let u: URL;
      try { u = new URL(raw.trim()); } catch { throw new Error(`be a valid URL (got ${JSON.stringify(raw)})`); }
      if (!protocols.includes(u.protocol)) {
        throw new Error(`use ${protocols.join(' or ')} (got ${u.protocol})`);
      }
      // A trailing slash turns every request path into a double slash once it
      // is concatenated. Normalising here means no caller has to remember.
      return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
    },
  };
}

/** A comma-separated list, each item parsed by `inner`, blanks discarded. */
export function list<T>(inner: Kind<T>, opts: { min?: number } = {}): Kind<T[]> {
  return {
    describe: `a comma-separated list of ${inner.describe}`,
    parse(raw) {
      const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (opts.min !== undefined && parts.length < opts.min) {
        throw new Error(`list at least ${opts.min} value(s)`);
      }
      return parts.map((p, i) => {
        try { return inner.parse(p); } catch (e) {
          throw new Error(`have every entry ${(e as Error).message} — item ${i + 1} (${JSON.stringify(p)}) does not`);
        }
      });
    },
  };
}

export function oneOf<const T extends readonly string[]>(...values: T): Kind<T[number]> {
  return {
    describe: `one of ${values.join(', ')}`,
    parse(raw) {
      const v = raw.trim();
      if (!values.includes(v as T[number])) {
        throw new Error(`be one of ${values.join(', ')} (got ${JSON.stringify(v)})`);
      }
      return v as T[number];
    },
  };
}

/** A filesystem path, resolved against `base` so relative values are stable. */
export function path_(base: string): Kind<string> {
  return {
    describe: 'a filesystem path',
    parse(raw) {
      const v = raw.trim();
      if (!v) throw new Error('not be empty');
      return resolve(base, v);
    },
  };
}

/**
 * A credential.
 *
 * The minimum length is the point. Both secrets in this server used to be
 * checked with `length < 16 → treat as absent`, which meant a short key
 * disabled encryption or webhook verification with no message anywhere. Here a
 * short value is an error the operator reads on the way up.
 */
export function secret(opts: { min?: number; pattern?: RegExp; patternLabel?: string } = {}): Kind<string> {
  const min = opts.min ?? 16;
  const inner = str({ min, pattern: opts.pattern, patternLabel: opts.patternLabel });
  return { describe: `a secret of at least ${min} characters`, parse: inner.parse };
}

// ─── Redaction ───────────────────────────────────────────────

/**
 * What a secret looks like in a report.
 *
 * Never the value. A length and a short fingerprint answer the two questions
 * an operator actually has — "is one set?" and "is it the same one as on the
 * other machine?" — without putting the credential in a terminal, a screenshot
 * or a support ticket.
 */
export function fingerprint(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `set · ${value.length} chars · sha256:${hash}`;
}

// ─── Resolution ──────────────────────────────────────────────

export interface Resolution<S extends Schema> {
  readonly values: Values<S>;
  readonly problems: Problem[];
  readonly origins: Map<string, Origin>;
}

export function resolve_<S extends Schema>(
  schema: S, mode: Mode, load: LoadResult,
): Resolution<S> {
  const values: Record<string, unknown> = {};
  const problems: Problem[] = [];
  const origins = new Map<string, Origin>();

  for (const [name, entry] of Object.entries(schema)) {
    const raw = process.env[entry.env];
    const present = raw !== undefined && raw.trim() !== '';
    const required = entry.required ?? 'never';

    if (!present) {
      const mustHave = required === 'always' || (required === 'production' && mode === 'production');
      if (mustHave) {
        problems.push({
          env: entry.env,
          severity: 'error',
          message: required === 'always'
            ? 'is required and is not set'
            : `is required in production and is not set (running as ${mode})`,
          hint: entry.doc,
        });
      }
      values[name] = entry.fallback;
      origins.set(name, {
        env: entry.env,
        from: entry.fallback !== undefined ? 'default' : 'unset',
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = entry.kind.parse(raw);
    } catch (e) {
      problems.push({
        env: entry.env,
        severity: 'error',
        message: `must ${(e as Error).message}`,
        hint: `Expected ${entry.kind.describe}. ${entry.doc}`,
      });
      values[name] = entry.fallback;
      origins.set(name, { env: entry.env, from: 'default' });
      continue;
    }

    if (entry.review) {
      try {
        const note = entry.review(parsed, mode);
        if (note) problems.push({ env: entry.env, severity: 'warning', message: note });
      } catch (e) {
        problems.push({ env: entry.env, severity: 'error', message: (e as Error).message, hint: entry.doc });
      }
    }

    values[name] = parsed;
    origins.set(name, load.fromFile.has(entry.env)
      ? { env: entry.env, from: 'file', file: load.fromFile.get(entry.env) }
      : { env: entry.env, from: 'shell' });
  }

  return { values: Object.freeze(values) as Values<S>, problems, origins };
}

// ─── Typo detection ──────────────────────────────────────────

function distance(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Finds variables that look like they were meant for this server but match
 * nothing in the schema.
 *
 * This is the check that would have caught `HELIO_BACKUP_ENABLE`. It is a
 * warning rather than an error: an operator is entitled to put their own
 * variables in the environment, and refusing to boot over one would be rude.
 * Restricted to the project's own prefixes so the machine's hundred unrelated
 * variables stay out of it.
 */
export function unknownVars(schema: Schema, prefixes: string[], reserved: string[] = []): Problem[] {
  const known = new Set(Object.values(schema).map((e) => e.env));
  // Variables that steer the loader itself rather than the server. They are
  // real and spelled correctly; they just have no schema entry because they
  // are read before the schema exists.
  const skip = new Set(reserved);
  const out: Problem[] = [];
  for (const key of Object.keys(process.env)) {
    if (known.has(key) || skip.has(key)) continue;
    if (!prefixes.some((p) => key.startsWith(p))) continue;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const k of known) {
      const d = distance(key, k);
      if (d < bestScore) { bestScore = d; best = k; }
    }
    // Three edits is about where "typo" stops and "different variable" starts.
    const near = best && bestScore <= 3 ? best : null;
    out.push({
      env: key,
      severity: 'warning',
      message: 'is set but nothing reads it',
      hint: near ? `Did you mean ${near}?` : 'Remove it, or check the spelling against .env.example.',
    });
  }
  return out;
}

// ─── Reporting ───────────────────────────────────────────────

const RED = '[31m', YELLOW = '[33m', DIM = '[2m', BOLD = '[1m', OFF = '[0m';
const colour = process.stderr.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (colour ? code + s + OFF : s);

export function formatProblems(problems: readonly Problem[], mode: Mode): string {
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const lines: string[] = [];

  lines.push('');
  lines.push(c(BOLD, `Configuration problems (${mode})`));
  lines.push('');

  for (const p of errors) {
    lines.push(`  ${c(RED, '✗')} ${c(BOLD, p.env)} ${p.message}`);
    if (p.hint) lines.push(`    ${c(DIM, p.hint)}`);
  }
  if (errors.length && warnings.length) lines.push('');
  for (const p of warnings) {
    lines.push(`  ${c(YELLOW, '!')} ${c(BOLD, p.env)} ${p.message}`);
    if (p.hint) lines.push(`    ${c(DIM, p.hint)}`);
  }

  lines.push('');
  if (errors.length) {
    lines.push(c(DIM, '  Every variable is documented in backend/.env.example.'));
    lines.push(c(DIM, '  Run `npm run config` to see what the server resolved.'));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The `.env.example` file, generated from the schema so it cannot drift.
 *
 * Two rules decide how a line comes out, and both exist to stop a copied
 * example becoming a configuration nobody chose:
 *
 *   · Anything with a working default is **commented out**. An operator who
 *     uncomments it is making a decision; one who leaves it alone keeps
 *     tracking the default instead of freezing today's copy of it. That
 *     matters most for `HELIO_BACKUP_DIR`, whose default follows `HELIO_DB` —
 *     writing it out would pin the backups to one place forever.
 *   · A required variable is left **uncommented and empty**, so it is
 *     obviously waiting for an answer.
 *
 * `root` shortens absolute paths back to the relative form they were written
 * as. Without it the generated file carries whatever directory the machine
 * that ran the generator happened to use.
 */
export function renderExample(schema: Schema, header: string, root?: string): string {
  const groups = new Map<string, Entry<any>[]>();
  for (const entry of Object.values(schema)) {
    const list_ = groups.get(entry.group) ?? [];
    list_.push(entry);
    groups.set(entry.group, list_);
  }

  const show = (v: unknown): string => {
    if (Array.isArray(v)) return v.join(',');
    const s = String(v);
    if (root && s.startsWith(root)) {
      return '.' + s.slice(root.length).replace(/\\/g, '/');
    }
    return s;
  };

  const out: string[] = [header.trimEnd(), ''];
  for (const [group, entries] of groups) {
    out.push(`# ─── ${group} ${'─'.repeat(Math.max(0, 58 - group.length))}`);
    out.push('');
    for (const e of entries) {
      for (const line of wrap(e.doc, 74)) out.push(`# ${line}`);
      const required = e.required === 'always' || e.required === 'production';
      const req = e.required === 'always' ? 'required'
        : e.required === 'production' ? 'required in production' : 'optional';
      out.push(`# ${req} · ${e.kind.describe}`);
      if (e.fallback !== undefined) out.push(`# default: ${show(e.fallback)}`);

      const value = required
        ? ''
        : e.example ?? (e.secret || e.fallback === undefined ? '' : show(e.fallback));
      out.push(`${required ? '' : '# '}${e.env}=${value}`);
      out.push('');
    }
  }
  return out.join('\n');
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) { lines.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  return lines;
}

export { join as joinPath };
