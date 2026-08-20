// Small shared primitives: ids, dates, money, errors.
// Dates are handled as plain 'YYYY-MM-DD' strings with UTC arithmetic so a
// business date never shifts because of the server's timezone.
import { randomUUID, randomBytes } from 'node:crypto';

// ─── Identifiers ─────────────────────────────────────────────
export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// ─── Timestamps ──────────────────────────────────────────────
export function nowIso(): string {
  return new Date().toISOString();
}

// ─── Business dates ──────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function assertDate(s: unknown, field: string): string {
  if (!isDate(s)) throw new HttpError(400, `${field} must be a valid YYYY-MM-DD date`);
  return s;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Nights between arrival (inclusive) and departure (exclusive). */
export function nightsBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Every night date from `from` (inclusive) to `to` (exclusive). */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from;
  let guard = 0;
  while (cur < to && guard++ < 3650) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/** Inclusive range — for restriction rules which are stored inclusive. */
export function dateRangeInclusive(from: string, to: string): string[] {
  return dateRange(from, addDays(to, 1));
}

export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
}

const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function dowName(date: string): string {
  return DOW_NAMES[dayOfWeek(date)];
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Money (integer minor units) & basis points ──────────────
/** Apply a basis-point percentage: applyBp(10000, 1800) → 1800 (18% of 100.00). */
export function applyBp(amountMinor: number, bp: number): number {
  return Math.round((amountMinor * bp) / 10_000);
}

/** Scale by a multiplier expressed in bp (10000 = ×1.0). */
export function scaleBp(amountMinor: number, multiplierBp: number): number {
  return Math.round((amountMinor * multiplierBp) / 10_000);
}

export function money(v: unknown, field = 'amount'): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new HttpError(400, `${field} must be a number of minor units`);
  }
  return Math.round(n);
}

export function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 10_000); // basis points
}

// ─── Errors ──────────────────────────────────────────────────
export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(msg: string, details?: unknown): never {
  throw new HttpError(400, msg, 'bad_request', details);
}
export function notFound(what: string): never {
  throw new HttpError(404, `${what} not found`, 'not_found');
}
export function conflict(msg: string, details?: unknown): never {
  throw new HttpError(409, msg, 'conflict', details);
}
export function forbidden(msg = 'Not permitted'): never {
  throw new HttpError(403, msg, 'forbidden');
}

// ─── Input coercion ──────────────────────────────────────────
export function str(v: unknown, field: string, opts: { max?: number; optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    badRequest(`${field} is required`);
  }
  const s = String(v).trim();
  if (!opts.optional && s === '') badRequest(`${field} is required`);
  if (opts.max && s.length > opts.max) badRequest(`${field} must be at most ${opts.max} characters`);
  return s;
}

export function int(v: unknown, field: string, opts: { min?: number; max?: number; def?: number } = {}): number {
  if (v === undefined || v === null || v === '') {
    if (opts.def !== undefined) return opts.def;
    badRequest(`${field} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) badRequest(`${field} must be a number`);
  const i = Math.round(n);
  if (opts.min !== undefined && i < opts.min) badRequest(`${field} must be at least ${opts.min}`);
  if (opts.max !== undefined && i > opts.max) badRequest(`${field} must be at most ${opts.max}`);
  return i;
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[], def?: T): T {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  const s = String(v);
  if (!allowed.includes(s as T)) {
    badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return s as T;
}

export function boolIn(v: unknown, def = false): boolean {
  if (v === undefined || v === null || v === '') return def;
  return v === true || v === 1 || v === '1' || v === 'true';
}

export function email(v: unknown, field = 'email', optional = false): string {
  const s = str(v, field, { optional, max: 254 });
  if (!s && optional) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) badRequest(`${field} must be a valid email address`);
  return s.toLowerCase();
}

export function slugCode(v: unknown, field: string, max = 20): string {
  const s = str(v, field, { max }).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!s) badRequest(`${field} must contain letters or digits`);
  return s;
}
