// ─────────────────────────────────────────────────────────────
// The registration record: an identity document and a signature.
//
// Two rules govern everything in this file, and they pull in opposite
// directions on purpose.
//
//   1. **Keep it, because the property must be able to prove who stayed.**
//      A scanned passport and a signed registration are what a police check, a
//      chargeback dispute or a damage claim turn on. Losing them is a real
//      cost.
//
//   2. **Get rid of it, because holding it is a liability.** A passport scan is
//      sensitive personal data. Sri Lanka's Personal Data Protection Act, like
//      the GDPR it is modelled on, says it may not be kept longer than the
//      purpose needs. A folder of passport photographs going back five years is
//      not an archive, it is a breach waiting for somebody to find it.
//
// So: encrypted at rest with the same key as the channel credentials, held
// inside the database so it is covered by the backups that already run, and
// deleted automatically once the guest has departed and the retention window
// has passed. The default window is 90 days and it is a setting, because what
// a property is obliged to keep varies by country and none of it is our call.
//
// The bytes never leave in a list. Reading one document is a separate,
// deliberate request that is written to the audit trail, because "who looked at
// a guest's passport, and when" is a question worth being able to answer.
// ─────────────────────────────────────────────────────────────
import { all, get, run, scalar } from '../db.ts';
import { id, nowIso, addDays, HttpError, notFound } from '../lib/util.ts';
import { encryptSecret, decryptSecret, encryptionAvailable } from '../lib/secrets.ts';
import { audit } from './audit.ts';
import { config } from '../config.ts';
import type { AuthContext } from '../auth.ts';

type Actor = Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>;

export const DOCUMENT_KINDS = ['identity', 'signature'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** What a list returns: everything except the image itself. */
export interface DocumentSummary {
  id: string;
  reservationId: string;
  kind: DocumentKind;
  label: string | null;
  guestName: string | null;
  mime: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string | null;
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

function rowToSummary(r: any): DocumentSummary {
  return {
    id: r.id,
    reservationId: r.reservation_id,
    kind: r.kind,
    label: r.label,
    guestName: r.guest_name,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    uploadedAt: r.uploaded_at,
    uploadedBy: r.uploaded_by,
  };
}

export function listDocuments(propertyId: string, reservationId: string): DocumentSummary[] {
  return all<any>(
    `SELECT id, reservation_id, kind, label, guest_name, mime, size_bytes, uploaded_at, uploaded_by
     FROM reservation_documents
     WHERE property_id = ? AND reservation_id = ?
     ORDER BY uploaded_at`,
    propertyId, reservationId,
  ).map(rowToSummary);
}

export function storeDocument(
  propertyId: string, actor: Actor, reservationId: string,
  input: { kind: DocumentKind; mime: string; dataBase64: string; label?: string; guestName?: string },
): DocumentSummary {
  const reservation = get<{ id: string; confirmation: string }>(
    'SELECT id, confirmation FROM reservations WHERE id = ? AND property_id = ?',
    reservationId, propertyId,
  );
  if (!reservation) notFound('Reservation');

  if (!DOCUMENT_KINDS.includes(input.kind)) {
    throw new HttpError(400, `kind must be one of ${DOCUMENT_KINDS.join(', ')}`);
  }
  if (!ALLOWED_MIME.has(input.mime)) {
    throw new HttpError(400, `${input.mime} is not an accepted document type`);
  }

  // Measured on the decoded bytes, which is what the limit is actually about —
  // base64 inflates by a third and nobody thinks in encoded kilobytes.
  const sizeBytes = Math.floor((input.dataBase64.length * 3) / 4);
  const maxBytes = config.documentMaxKb * 1024;
  if (sizeBytes > maxBytes) {
    throw new HttpError(
      413,
      `That file is ${Math.round(sizeBytes / 1024)} KB; the limit is ${config.documentMaxKb} KB`,
    );
  }
  if (sizeBytes === 0) throw new HttpError(400, 'The document is empty');

  /*
   * Refusing rather than storing it readable.
   *
   * Everywhere else in this system an absent key degrades to clear text and
   * says so loudly. That is the right trade for a channel token, which the
   * property can rotate. It is the wrong trade for a passport photograph: the
   * guest cannot rotate their passport, and a database written without
   * encryption stays readable for as long as any copy of it exists.
   */
  if (!encryptionAvailable()) {
    throw new HttpError(
      503,
      'Identity documents cannot be stored without HELIO_SECRET_KEY set — refusing to '
      + 'write a passport scan in clear text. Set the key and restart the API.',
      'encryption_unavailable',
    );
  }

  const docId = id('doc');
  run(
    `INSERT INTO reservation_documents(
       id, property_id, reservation_id, guest_name, kind, label, mime, size_bytes,
       data, uploaded_at, uploaded_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    docId, propertyId, reservationId, input.guestName ?? null, input.kind,
    input.label ?? null, input.mime, sizeBytes,
    encryptSecret(input.dataBase64), nowIso(), actor.userName,
  );

  audit(actor, {
    action: input.kind === 'signature' ? 'document.signature' : 'document.identity',
    entity: 'reservation',
    entityId: reservationId,
    entityRef: reservation.confirmation,
    after: { kind: input.kind, label: input.label ?? null, sizeBytes },
  });

  return {
    id: docId, reservationId, kind: input.kind, label: input.label ?? null,
    guestName: input.guestName ?? null, mime: input.mime, sizeBytes,
    uploadedAt: nowIso(), uploadedBy: actor.userName,
  };
}

/**
 * The image itself.
 *
 * Audited on every read. A passport scan is exactly the sort of thing that
 * should not be viewable without a trace of who viewed it — the audit entry is
 * the difference between a record and a filing cabinet left unlocked.
 */
export function readDocument(propertyId: string, actor: Actor, documentId: string): {
  mime: string; dataBase64: string; kind: DocumentKind; label: string | null;
} {
  const row = get<any>(
    'SELECT * FROM reservation_documents WHERE id = ? AND property_id = ?',
    documentId, propertyId,
  );
  if (!row) notFound('Document');

  audit(actor, {
    action: 'document.view',
    entity: 'reservation',
    entityId: row.reservation_id,
    after: { documentId, kind: row.kind },
    // Reading somebody's identity document is not routine traffic.
    elevated: row.kind === 'identity',
  });

  return {
    mime: row.mime,
    dataBase64: decryptSecret(row.data),
    kind: row.kind,
    label: row.label,
  };
}

export function deleteDocument(propertyId: string, actor: Actor, documentId: string): void {
  const row = get<any>(
    'SELECT id, reservation_id, kind FROM reservation_documents WHERE id = ? AND property_id = ?',
    documentId, propertyId,
  );
  if (!row) notFound('Document');
  run('DELETE FROM reservation_documents WHERE id = ?', documentId);
  audit(actor, {
    action: 'document.delete',
    entity: 'reservation',
    entityId: row.reservation_id,
    before: { documentId, kind: row.kind },
    elevated: true,
  });
}

/**
 * Delete what is past its retention window.
 *
 * Counted from departure rather than from upload, because the purpose the
 * document was collected for lasts as long as the stay and the disputes that
 * can follow it. A reservation with no departure recorded — cancelled before
 * it began — is measured from when the document was uploaded instead, so
 * nothing can sit in the table for ever by having no date to compare against.
 */
export function purgeExpiredDocuments(): { deleted: number } {
  const days = config.documentRetentionDays;
  const cutoff = addDays(nowIso().slice(0, 10), -days);

  const deleted = scalar<number>(
    `SELECT count(*) AS n FROM reservation_documents d
     LEFT JOIN reservations r ON r.id = d.reservation_id
     WHERE COALESCE(r.departure, substr(d.uploaded_at, 1, 10)) < ?`,
    cutoff,
  );
  if (deleted > 0) {
    run(
      `DELETE FROM reservation_documents
       WHERE id IN (
         SELECT d.id FROM reservation_documents d
         LEFT JOIN reservations r ON r.id = d.reservation_id
         WHERE COALESCE(r.departure, substr(d.uploaded_at, 1, 10)) < ?
       )`,
      cutoff,
    );
    // Attributed to the system rather than to whoever happened to be signed in.
    audit(null, {
      action: 'document.purge',
      entity: 'property',
      after: { deleted, retentionDays: days, cutoff },
    });
  }
  return { deleted };
}

/** For the health line on startup and the configuration screen. */
export function documentStats(propertyId: string): { count: number; totalKb: number } {
  const row = get<{ n: number; bytes: number }>(
    `SELECT count(*) AS n, COALESCE(sum(size_bytes), 0) AS bytes
     FROM reservation_documents WHERE property_id = ?`, propertyId,
  );
  return { count: row?.n ?? 0, totalKb: Math.round((row?.bytes ?? 0) / 1024) };
}
