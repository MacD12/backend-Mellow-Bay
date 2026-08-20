// Tiny router + request plumbing on node:http (no framework dependency).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './util.ts';
import type { AuthContext } from '../auth.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  ip: string;
  /** Set for authenticated routes. */
  auth: AuthContext;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export interface RouteOpts {
  /** Permission required to call this route. `null` = public. */
  perm?: string | null;
  /** Route is reachable before any property exists (setup, login, health). */
  allowNoProperty?: boolean;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  opts: RouteOpts;
}

const routes: Route[] = [];

function add(method: string, path: string, handler: Handler, opts: RouteOpts = {}) {
  routes.push({ method, segments: path.split('/').filter(Boolean), handler, opts });
}

export const router = {
  get:    (p: string, h: Handler, o?: RouteOpts) => add('GET', p, h, o),
  post:   (p: string, h: Handler, o?: RouteOpts) => add('POST', p, h, o),
  put:    (p: string, h: Handler, o?: RouteOpts) => add('PUT', p, h, o),
  patch:  (p: string, h: Handler, o?: RouteOpts) => add('PATCH', p, h, o),
  delete: (p: string, h: Handler, o?: RouteOpts) => add('DELETE', p, h, o),
};

export function matchRoute(method: string, pathname: string) {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

export function listRoutes() {
  return routes.map((r) => `${r.method} /${r.segments.join('/')}`).sort();
}

const MAX_BODY = 4 * 1024 * 1024; // 4 MB

export async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}
