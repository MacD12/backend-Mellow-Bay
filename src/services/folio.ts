// ─────────────────────────────────────────────────────────────
// Guest ledger: folios, charge posting, taxes, payments, transfers,
// routing, invoicing and city-ledger settlement.
//
// Sign convention: charges and taxes are positive, payments and credits are
// negative. A folio's balance is the sum of its non-voided lines, so it is
// always reconstructable from the ledger — never stored as a mutable total.
// ─────────────────────────────────────────────────────────────
import { all, get, run, scalar, tx, parseJson, nextSequence } from '../db.ts';
import { id, nowIso, HttpError } from '../lib/util.ts';
import { computeTaxes } from './pricing.ts';
import { audit } from './audit.ts';
import { notify } from './notify.ts';
import type { AuthContext } from '../auth.ts';

export interface FolioRow {
  id: string; property_id: string; reservation_id: string | null; number: string;
  name: string; type: string; window_no: number; status: string;
  company_id: string | null; group_id: string | null;
  opened_at: string; closed_at: string | null;
}

export interface FolioLineRow {
  id: string; folio_id: string; business_date: string; posted_at: string;
  kind: string; code: string; description: string; qty: number;
  unit_minor: number; amount_minor: number; method: string | null;
  reference: string | null; parent_line_id: string | null; posted_by: string | null;
  voided: number; void_of: string | null; reservation_id: string | null;
}

export function folioBalance(folioId: string): number {
  return scalar<number>(
    'SELECT COALESCE(SUM(amount_minor), 0) AS total FROM folio_lines WHERE folio_id = ? AND voided = 0',
    folioId,
  );
}

export function folioTotals(folioId: string) {
  const rows = all<{ kind: string; total: number }>(
    `SELECT kind, COALESCE(SUM(amount_minor),0) AS total
       FROM folio_lines WHERE folio_id = ? AND voided = 0 GROUP BY kind`,
    folioId,
  );
  const by = (k: string) => rows.find((r) => r.kind === k)?.total ?? 0;
  const charges = by('charge');
  const taxes = by('tax');
  const payments = by('payment');
  const adjustments = by('adjustment') + by('transfer');
  return {
    chargesMinor: charges,
    taxesMinor: taxes,
    paymentsMinor: payments,
    adjustmentsMinor: adjustments,
    balanceMinor: charges + taxes + payments + adjustments,
  };
}

export function foliosForReservation(reservationId: string): (FolioRow & { balanceMinor: number })[] {
  return all<FolioRow>(
    'SELECT * FROM folios WHERE reservation_id = ? ORDER BY window_no',
    reservationId,
  ).map((f) => ({ ...f, balanceMinor: folioBalance(f.id) }));
}

export function folioLines(folioId: string): FolioLineRow[] {
  return all<FolioLineRow>(
    'SELECT * FROM folio_lines WHERE folio_id = ? ORDER BY business_date, posted_at, rowid',
    folioId,
  );
}

/** The reservation's primary (window 1) folio, created on first use. */
export function ensureFolio(propertyId: string, reservationId: string, guestName: string): FolioRow {
  const existing = get<FolioRow>(
    'SELECT * FROM folios WHERE reservation_id = ? AND window_no = 1',
    reservationId,
  );
  if (existing) return existing;
  return openFolio(propertyId, {
    reservationId, name: guestName, type: 'guest', windowNo: 1,
  });
}

export function openFolio(propertyId: string, opts: {
  reservationId?: string | null;
  groupId?: string | null;
  companyId?: string | null;
  name: string;
  type?: string;
  windowNo?: number;
}): FolioRow {
  const seq = nextSequence(propertyId, 'folio', 1);
  const windowNo = opts.windowNo ?? (opts.reservationId
    ? scalar<number>('SELECT COALESCE(MAX(window_no),0)+1 AS n FROM folios WHERE reservation_id = ?', opts.reservationId)
    : 1);
  const folioId = id('fol');
  run(
    `INSERT INTO folios(id, property_id, reservation_id, group_id, company_id, number, name,
                        type, window_no, status, opened_at)
     VALUES(?,?,?,?,?,?,?,?,?,'open',?)`,
    folioId, propertyId, opts.reservationId ?? null, opts.groupId ?? null, opts.companyId ?? null,
    `F${String(seq).padStart(6, '0')}`, opts.name, opts.type ?? 'guest', windowNo, nowIso(),
  );
  return get<FolioRow>('SELECT * FROM folios WHERE id = ?', folioId)!;
}

function assertOpen(folio: FolioRow) {
  if (folio.status !== 'open') {
    throw new HttpError(409, `Folio ${folio.number} is closed — reopen it before posting`, 'folio_closed');
  }
}

export function getFolio(propertyId: string, folioId: string): FolioRow {
  const f = get<FolioRow>('SELECT * FROM folios WHERE id = ? AND property_id = ?', folioId, propertyId);
  if (!f) throw new HttpError(404, 'Folio not found');
  return f;
}

/**
 * Resolve where a charge should actually land, honouring routing rules
 * (e.g. "all room charges go to the company master folio").
 */
function routeTarget(propertyId: string, folio: FolioRow, code: string): string {
  if (!folio.reservation_id) return folio.id;
  const routes = all<any>(
    'SELECT * FROM folio_routing WHERE property_id = ? AND reservation_id = ?',
    propertyId, folio.reservation_id,
  );
  for (const r of routes) {
    const codes = parseJson<string[]>(r.codes, []);
    if (codes.includes('*') || codes.includes(code)) {
      const target = get<FolioRow>('SELECT * FROM folios WHERE id = ?', r.target_folio_id);
      if (target && target.status === 'open') return target.id;
    }
  }
  return folio.id;
}

export interface PostChargeInput {
  folioId: string;
  code: string;
  description?: string;
  qty?: number;
  unitMinor: number;
  businessDate: string;
  applyTax?: boolean;
  reference?: string;
  reservationId?: string | null;
  persons?: number;
  nights?: number;
  taxScope?: 'room' | 'fnb' | 'all';
}

export function postCharge(
  propertyId: string,
  actor: Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>,
  input: PostChargeInput,
): { lineId: string; taxLineIds: string[]; amountMinor: number; taxMinor: number } {
  return tx(() => {
    const folio = getFolio(propertyId, input.folioId);
    assertOpen(folio);

    const txCode = get<any>(
      'SELECT * FROM transaction_codes WHERE property_id = ? AND code = ?',
      propertyId, input.code,
    );
    const qty = input.qty ?? 1;
    const amount = qty * input.unitMinor;
    const targetFolioId = routeTarget(propertyId, folio, input.code);
    const lineId = id('fl');

    run(
      `INSERT INTO folio_lines(id, property_id, folio_id, reservation_id, business_date, posted_at,
                               kind, code, description, qty, unit_minor, amount_minor, reference,
                               posted_by, voided, routed_from)
       VALUES(?,?,?,?,?,?,'charge',?,?,?,?,?,?,?,0,?)`,
      lineId, propertyId, targetFolioId, input.reservationId ?? folio.reservation_id,
      input.businessDate, nowIso(), input.code,
      input.description ?? txCode?.name ?? input.code,
      qty, input.unitMinor, amount, input.reference ?? null, actor.userName,
      targetFolioId === folio.id ? null : folio.id,
    );

    const taxLineIds: string[] = [];
    let taxTotal = 0;
    const taxable = input.applyTax ?? (txCode ? txCode.taxable === 1 : true);
    if (taxable && amount !== 0) {
      const scope = input.taxScope ?? (txCode?.category === 'fnb' ? 'fnb' : 'room');
      const taxes = computeTaxes(propertyId, amount, {
        nights: input.nights ?? 1,
        persons: input.persons ?? 1,
        appliesTo: scope,
      });
      // A `flat` tax is a fixed once-off for the whole stay — a booking fee, a
      // resort fee, a tourism levy. The quote adds it once. The folio, though,
      // is posted one night at a time, and every posting recomputed the full
      // amount: a 5.00 fee on a four-night stay was charged 20.00, and the
      // folio permanently disagreed with the confirmation the guest agreed to.
      //
      // Skipped by looking for the line rather than by trusting a "first night"
      // flag from the caller. Extending a stay, re-posting after a void, and
      // the check-out catch-up all post nights out of order or more than once —
      // a flag gets every one of those wrong, an existing-line check gets them
      // all right.
      const flatCodes = new Set(taxes.filter((t) => t.mode === 'flat').map((t) => t.code));
      const alreadyCharged = new Set<string>();
      const stayId = input.reservationId ?? folio.reservation_id;
      if (flatCodes.size && stayId) {
        for (const row of all<{ code: string }>(
          `SELECT DISTINCT l.code FROM folio_lines l
            WHERE l.reservation_id = ? AND l.kind = 'tax' AND l.voided = 0
              AND l.code IN (${[...flatCodes].map(() => '?').join(',')})`,
          stayId, ...flatCodes,
        )) alreadyCharged.add(row.code);
      }

      for (const t of taxes) {
        if (t.mode === 'flat' && alreadyCharged.has(t.code)) continue;
        const tid = id('fl');
        run(
          `INSERT INTO folio_lines(id, property_id, folio_id, reservation_id, business_date, posted_at,
                                   kind, code, description, qty, unit_minor, amount_minor,
                                   parent_line_id, posted_by, voided)
           VALUES(?,?,?,?,?,?,'tax',?,?,1,?,?,?,?,0)`,
          tid, propertyId, targetFolioId, input.reservationId ?? folio.reservation_id,
          input.businessDate, nowIso(), t.code, t.name, t.amountMinor, t.amountMinor,
          lineId, actor.userName,
        );
        taxLineIds.push(tid);
        taxTotal += t.amountMinor;
      }
    }

    audit(actor, {
      action: 'folio.charge',
      entity: 'FOLIO',
      entityId: targetFolioId,
      entityRef: `${folio.number} · ${input.code}`,
      after: { code: input.code, amountMinor: amount, taxMinor: taxTotal },
    });

    return { lineId, taxLineIds, amountMinor: amount, taxMinor: taxTotal };
  });
}

export function postPayment(
  propertyId: string,
  actor: Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>,
  input: {
    folioId: string; method: string; amountMinor: number;
    businessDate: string; reference?: string; description?: string;
  },
): { lineId: string } {
  return tx(() => {
    const folio = getFolio(propertyId, input.folioId);
    assertOpen(folio);
    if (input.amountMinor <= 0) throw new HttpError(400, 'Payment amount must be positive');

    const lineId = id('fl');
    run(
      `INSERT INTO folio_lines(id, property_id, folio_id, reservation_id, business_date, posted_at,
                               kind, code, description, qty, unit_minor, amount_minor, method,
                               reference, posted_by, voided)
       VALUES(?,?,?,?,?,?,'payment','PAYMENT',?,1,?,?,?,?,?,0)`,
      lineId, propertyId, folio.id, folio.reservation_id, input.businessDate, nowIso(),
      input.description ?? `Payment — ${input.method}`,
      -input.amountMinor, -input.amountMinor, input.method,
      input.reference ?? null, actor.userName,
    );

    audit(actor, {
      action: 'folio.payment',
      entity: 'FOLIO',
      entityId: folio.id,
      entityRef: folio.number,
      after: { method: input.method, amountMinor: input.amountMinor },
    });

    // Money arriving is worth a line in the feed. A refund cannot come through
    // here — `postPayment` refuses a non-positive amount a few lines above, so
    // money going back out is a void or an adjustment, and is notified there.
    notify(propertyId, {
      source: 'Cashier',
      severity: 'success',
      title: `Payment ${(input.amountMinor / 100).toFixed(2)}`,
      message: `${folio.number} · ${input.method ?? 'payment'} · ${folio.name}`,
      link: folio.reservation_id ? `#/guest-dashboard/${folio.reservation_id}` : '#/cashier',
    });
    return { lineId };
  });
}

/**
 * Void a line and every tax line it generated.
 *
 * The rows stay in the ledger flagged `voided` — nothing is deleted, and the
 * folio still shows what was posted and struck out. They drop out of every
 * balance and revenue sum (all of which filter on `voided = 0`), so a void
 * reverses the money exactly once. Who voided it, when and why is in the
 * audit trail.
 */
export function voidLine(
  propertyId: string,
  actor: Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>,
  lineId: string,
  businessDate: string,
  reason: string,
) {
  return tx(() => {
    const line = get<FolioLineRow>(
      'SELECT * FROM folio_lines WHERE id = ? AND property_id = ?', lineId, propertyId,
    );
    if (!line) throw new HttpError(404, 'Folio line not found');
    if (line.voided === 1) throw new HttpError(409, 'Line is already voided');

    const folio = getFolio(propertyId, line.folio_id);
    if (folio.status !== 'open') {
      throw new HttpError(409, `Folio ${folio.number} is closed — reopen it before voiding`, 'folio_closed');
    }

    const children = all<FolioLineRow>(
      'SELECT * FROM folio_lines WHERE parent_line_id = ? AND voided = 0', lineId);
    const toVoid = [line, ...children];
    let reversedMinor = 0;
    for (const l of toVoid) {
      run(
        `UPDATE folio_lines SET voided = 1, description = ?
          WHERE id = ?`,
        `${l.description} · VOID (${reason}) by ${actor.userName} on ${businessDate}`,
        l.id,
      );
      reversedMinor += l.amount_minor;
    }

    // A voided room charge means that night is unpaid again, so it becomes
    // postable once more rather than silently vanishing from the stay.
    if (line.code === 'ROOM' && line.reservation_id) {
      run('UPDATE reservation_nights SET posted = 0 WHERE reservation_id = ? AND date = ?',
        line.reservation_id, line.business_date);
    }

    // Money coming back off a folio is the entry that gets questioned later, so
    // it is flagged rather than filed quietly alongside ordinary postings.
    notify(propertyId, {
      source: 'Cashier',
      severity: 'warn',
      title: `Voided ${(Math.abs(reversedMinor) / 100).toFixed(2)} · ${line.code}`,
      message: `${folio.number} · ${line.description}`
        + (reason ? ` · ${reason}` : '') + ` · by ${actor.userName}`,
      link: folio.reservation_id ? `#/guest-dashboard/${folio.reservation_id}` : '#/cashier',
    });

    audit(actor, {
      action: 'folio.void',
      entity: 'FOLIO',
      entityId: line.folio_id,
      entityRef: `${folio.number} · ${line.code}`,
      before: { amountMinor: line.amount_minor, description: line.description },
      after: { reason, linesVoided: toVoid.length, reversedMinor },
      elevated: true,
    });
    return { voided: toVoid.length, reversedMinor, balanceMinor: folioBalance(line.folio_id) };
  });
}

/** Move a posted line to another folio (split-folio / routing correction). */
export function transferLine(
  propertyId: string,
  actor: Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>,
  lineId: string,
  targetFolioId: string,
) {
  return tx(() => {
    const line = get<FolioLineRow>(
      'SELECT * FROM folio_lines WHERE id = ? AND property_id = ? AND voided = 0', lineId, propertyId,
    );
    if (!line) throw new HttpError(404, 'Folio line not found');
    const target = getFolio(propertyId, targetFolioId);
    assertOpen(target);
    if (line.folio_id === targetFolioId) return { moved: 0 };

    const ids = [line.id, ...all<{ id: string }>(
      'SELECT id FROM folio_lines WHERE parent_line_id = ? AND voided = 0', lineId,
    ).map((r) => r.id)];
    for (const i of ids) {
      run('UPDATE folio_lines SET folio_id = ?, routed_from = COALESCE(routed_from, ?) WHERE id = ?',
        targetFolioId, line.folio_id, i);
    }
    audit(actor, {
      action: 'folio.transfer', entity: 'FOLIO', entityId: targetFolioId,
      entityRef: line.description, before: { from: line.folio_id }, after: { to: targetFolioId },
    });
    return { moved: ids.length };
  });
}

export function closeFolio(
  propertyId: string,
  actor: Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>,
  folioId: string,
  opts: { allowBalance?: boolean } = {},
) {
  const folio = getFolio(propertyId, folioId);
  const balance = folioBalance(folioId);
  if (balance !== 0 && !opts.allowBalance) {
    throw new HttpError(409,
      `Folio ${folio.number} cannot be closed with an outstanding balance`,
      'folio_has_balance', { balanceMinor: balance });
  }
  run(`UPDATE folios SET status = 'closed', closed_at = ? WHERE id = ?`, nowIso(), folioId);
  audit(actor, { action: 'folio.close', entity: 'FOLIO', entityId: folioId, entityRef: folio.number });
  return { ok: true, balanceMinor: balance };
}

export function reopenFolio(
  propertyId: string,
  actor: Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>,
  folioId: string,
) {
  const folio = getFolio(propertyId, folioId);
  run(`UPDATE folios SET status = 'open', closed_at = NULL WHERE id = ?`, folioId);
  audit(actor, {
    action: 'folio.reopen', entity: 'FOLIO', entityId: folioId,
    entityRef: folio.number, elevated: true,
  });
  return { ok: true };
}

// ─── Invoicing & city ledger ─────────────────────────────────
export function createInvoice(
  propertyId: string,
  actor: Pick<AuthContext, 'userId' | 'userName' | 'propertyId'>,
  input: { folioId: string; billTo: string; billAddress?: string; companyId?: string | null; toAr?: boolean; dueAt?: string | null },
) {
  return tx(() => {
    const folio = getFolio(propertyId, input.folioId);
    const totals = folioTotals(folio.id);
    const prop = get<{ currency: string }>('SELECT currency FROM properties WHERE id = ?', propertyId);
    const seq = nextSequence(propertyId, 'invoice', 1);
    const number = `INV-${new Date().getUTCFullYear()}-${String(seq).padStart(5, '0')}`;
    const invoiceId = id('inv');
    const net = totals.chargesMinor + totals.adjustmentsMinor;
    const total = net + totals.taxesMinor;

    run(
      `INSERT INTO invoices(id, property_id, folio_id, number, issued_at, due_at, bill_to, bill_address,
                            company_id, net_minor, tax_minor, total_minor, paid_minor, status, currency, created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      invoiceId, propertyId, folio.id, number, nowIso(), input.dueAt ?? null,
      input.billTo, input.billAddress ?? null, input.companyId ?? folio.company_id ?? null,
      net, totals.taxesMinor, total, -totals.paymentsMinor,
      input.toAr ? 'ar' : (totals.balanceMinor === 0 ? 'paid' : 'issued'),
      prop?.currency ?? 'USD', actor.userName,
    );

    // Settling to the city ledger clears the folio and opens a receivable.
    if (input.toAr) {
      const companyId = input.companyId ?? folio.company_id;
      if (!companyId) throw new HttpError(400, 'A company is required to bill to the city ledger');
      const balance = folioBalance(folio.id);
      if (balance !== 0) {
        run(
          `INSERT INTO folio_lines(id, property_id, folio_id, reservation_id, business_date, posted_at,
                                   kind, code, description, qty, unit_minor, amount_minor, reference, posted_by, voided)
           VALUES(?,?,?,?,?,?,'transfer','CITYLEDGER',?,1,?,?,?,?,0)`,
          id('fl'), propertyId, folio.id, folio.reservation_id,
          nowIso().slice(0, 10), nowIso(),
          `Transfer to city ledger — ${number}`, -balance, -balance, number, actor.userName,
        );
      }
      run(
        `INSERT INTO ar_transactions(id, property_id, company_id, invoice_id, date, kind, amount_minor, reference, created_by, created_at)
         VALUES(?,?,?,?,?,'charge',?,?,?,?)`,
        id('ar'), propertyId, companyId, invoiceId, nowIso().slice(0, 10),
        balance, number, actor.userName, nowIso(),
      );
    }

    audit(actor, {
      action: 'invoice.create', entity: 'INVOICE', entityId: invoiceId, entityRef: number,
      after: { totalMinor: total, ar: !!input.toAr },
    });
    return get<any>('SELECT * FROM invoices WHERE id = ?', invoiceId)!;
  });
}
