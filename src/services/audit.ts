// Immutable activity trail. Every state-changing operation writes one row.
import { all, run, jsonCol } from '../db.ts';
import { id, nowIso } from '../lib/util.ts';
import type { AuthContext } from '../auth.ts';

export interface AuditInput {
  action: string;
  entity: string;
  entityId?: string;
  entityRef?: string;
  channel?: string;
  before?: unknown;
  after?: unknown;
  elevated?: boolean;
}

export function audit(
  actor: Pick<AuthContext, 'userId' | 'userName' | 'propertyId'> | null,
  input: AuditInput,
  ip = 'internal',
) {
  run(
    `INSERT INTO audit_log(id, property_id, ts, user_id, user_name, action, entity,
                           entity_id, entity_ref, channel, before_json, after_json, ip, elevated)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id('aud'),
    actor?.propertyId ?? null,
    nowIso(),
    actor?.userId ?? null,
    actor?.userName ?? 'system',
    input.action,
    input.entity,
    input.entityId ?? null,
    input.entityRef ?? null,
    input.channel ?? null,
    jsonCol(input.before),
    jsonCol(input.after),
    ip,
    input.elevated ? 1 : 0,
  );
}

export function auditTrail(propertyId: string, opts: {
  entity?: string; entityId?: string; limit?: number; since?: string;
} = {}) {
  const where: string[] = ['property_id = ?'];
  const params: unknown[] = [propertyId];
  if (opts.entity) { where.push('entity = ?'); params.push(opts.entity); }
  if (opts.entityId) { where.push('entity_id = ?'); params.push(opts.entityId); }
  if (opts.since) { where.push('ts >= ?'); params.push(opts.since); }
  const limit = Math.min(opts.limit ?? 200, 1000);
  return all<any>(
    `SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`,
    ...params,
  );
}
