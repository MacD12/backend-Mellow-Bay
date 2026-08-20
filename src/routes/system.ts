// System operations: backups and database health.
import { router, type Ctx } from '../lib/http.ts';
import { str, HttpError } from '../lib/util.ts';
import {
  runBackup, listBackups, backupStatus, reverify, deleteBackup, prune, orphanedFiles,
} from '../services/backup.ts';
import {
  databaseHealth, runIntegrityCheck, checkHistory, runMaintenance, type MaintenanceAction,
} from '../services/database.ts';
import { audit } from '../services/audit.ts';

// ─── Backups ─────────────────────────────────────────────────
router.get('/api/system/backups', () => ({
  status: backupStatus(),
  backups: listBackups(50),
  orphanedFiles: orphanedFiles(),
}), { perm: 'admin.users', allowNoProperty: true });

router.post('/api/system/backups', (ctx: Ctx) => {
  const result = runBackup('manual', ctx.auth.userName);
  audit(ctx.auth, {
    action: 'backup.run', entity: 'SYSTEM', entityId: result.id, entityRef: result.filename,
    after: { status: result.status, sizeBytes: result.size_bytes, durationMs: result.duration_ms },
    elevated: true,
  }, ctx.ip);
  return {
    id: result.id, filename: result.filename, status: result.status,
    sizeBytes: result.size_bytes, durationMs: result.duration_ms,
    verification: result.verification, error: result.error,
  };
}, { perm: 'admin.users', allowNoProperty: true });

router.post('/api/system/backups/:id/verify', (ctx: Ctx) => {
  const row = reverify(ctx.params.id);
  audit(ctx.auth, {
    action: 'backup.verify', entity: 'SYSTEM', entityId: row.id, entityRef: row.filename,
    after: { status: row.status, verification: row.verification },
  }, ctx.ip);
  return { id: row.id, status: row.status, verification: row.verification, error: row.error };
}, { perm: 'admin.users', allowNoProperty: true });

router.delete('/api/system/backups/:id', (ctx: Ctx) => {
  audit(ctx.auth, {
    action: 'backup.delete', entity: 'SYSTEM', entityId: ctx.params.id, elevated: true,
  }, ctx.ip);
  return deleteBackup(ctx.params.id);
}, { perm: 'admin.users', allowNoProperty: true });

router.post('/api/system/backups/prune', (ctx: Ctx) => {
  const result = prune();
  audit(ctx.auth, { action: 'backup.prune', entity: 'SYSTEM', after: result }, ctx.ip);
  return result;
}, { perm: 'admin.users', allowNoProperty: true });

// ─── Database health ─────────────────────────────────────────
router.get('/api/system/database', () => ({
  health: databaseHealth(),
  checks: checkHistory(20),
}), { perm: 'admin.users', allowNoProperty: true });

router.post('/api/system/database/check', (ctx: Ctx) => {
  const result = runIntegrityCheck(ctx.auth.userName);
  audit(ctx.auth, {
    action: 'database.check', entity: 'SYSTEM', entityId: result.id,
    after: {
      ok: result.ok, integrity: result.integrity,
      violations: result.foreignKeyViolations.length, durationMs: result.durationMs,
    },
  }, ctx.ip);
  return result;
}, { perm: 'admin.users', allowNoProperty: true });

const ALLOWED_ACTIONS: MaintenanceAction[] = ['analyze', 'optimize', 'checkpoint', 'vacuum'];

router.post('/api/system/database/maintenance', (ctx: Ctx) => {
  const action = str(ctx.body.action, 'action') as MaintenanceAction;
  if (!ALLOWED_ACTIONS.includes(action)) {
    throw new HttpError(400,
      `Unknown maintenance action. Expected one of: ${ALLOWED_ACTIONS.join(', ')}`, 'bad_action');
  }
  const result = runMaintenance(action, ctx.auth.userName);
  audit(ctx.auth, {
    action: `database.${action}`, entity: 'SYSTEM',
    after: { detail: result.detail, durationMs: result.durationMs },
    // VACUUM rewrites the file; the rest are routine.
    elevated: action === 'vacuum',
  }, ctx.ip);
  return result;
}, { perm: 'admin.users', allowNoProperty: true });
