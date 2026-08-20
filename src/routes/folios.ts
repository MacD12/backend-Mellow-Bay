// Cashiering: folios, charge posting, payments, splits, routing, invoices,
// the city ledger and cashier shifts.
import { router, type Ctx } from '../lib/http.ts';
import { all, get, run, tx, scalar, jsonCol } from '../db.ts';
import {
  id, nowIso, str, int, money, boolIn, oneOf, notFound, HttpError, assertDate,
} from '../lib/util.ts';
import {
  openFolio, getFolio, folioLines, folioTotals, foliosForReservation, postCharge,
  postPayment, voidLine, transferLine, closeFolio, reopenFolio, createInvoice, folioBalance,
} from '../services/folio.ts';
import { audit } from '../services/audit.ts';

const pid = (ctx: Ctx) => ctx.auth.propertyId;
const businessDate = (ctx: Ctx) =>
  get<{ business_date: string }>('SELECT business_date FROM properties WHERE id = ?', pid(ctx))!.business_date;

function shapeFolio(ctx: Ctx, folioId: string) {
  const f = getFolio(pid(ctx), folioId);
  const totals = folioTotals(folioId);
  const res = f.reservation_id
    ? get<any>(
      `SELECT r.*, rt.name AS room_type_name, rm.number AS room_number
         FROM reservations r JOIN room_types rt ON rt.id = r.room_type_id
         LEFT JOIN rooms rm ON rm.id = r.room_id WHERE r.id = ?`, f.reservation_id)
    : null;
  return {
    id: f.id, number: f.number, name: f.name, type: f.type, windowNo: f.window_no,
    status: f.status, reservationId: f.reservation_id, groupId: f.group_id,
    companyId: f.company_id, openedAt: f.opened_at, closedAt: f.closed_at,
    ...totals,
    reservation: res ? {
      id: res.id, confirmation: res.confirmation, guest: res.guest_name, status: res.status,
      arrival: res.arrival, departure: res.departure, room: res.room_number,
      roomType: res.room_type_name, adults: res.adults, children: res.children,
      vip: res.vip === 1,
    } : null,
    lines: folioLines(folioId).map((l) => ({
      id: l.id, businessDate: l.business_date, postedAt: l.posted_at, kind: l.kind,
      code: l.code, description: l.description, qty: l.qty, unitMinor: l.unit_minor,
      amountMinor: l.amount_minor, method: l.method, reference: l.reference,
      parentLineId: l.parent_line_id, postedBy: l.posted_by, voided: l.voided === 1,
      voidOf: l.void_of,
    })),
  };
}

// ─── Folios ──────────────────────────────────────────────────
router.get('/api/folios', (ctx: Ctx) => {
  const status = ctx.query.get('status');
  const rows = all<any>(
    `SELECT f.*, r.guest_name, r.confirmation, r.status AS res_status, rm.number AS room_number
       FROM folios f
       LEFT JOIN reservations r ON r.id = f.reservation_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
      WHERE f.property_id = ? ${status ? 'AND f.status = ?' : ''}
      ORDER BY f.opened_at DESC LIMIT 500`,
    ...(status ? [pid(ctx), status] : [pid(ctx)]),
  );
  return rows.map((f) => ({
    id: f.id, number: f.number, name: f.name, type: f.type, windowNo: f.window_no,
    status: f.status, reservationId: f.reservation_id, confirmation: f.confirmation,
    guest: f.guest_name ?? f.name, room: f.room_number, reservationStatus: f.res_status,
    balanceMinor: folioBalance(f.id), openedAt: f.opened_at,
  }));
}, { perm: 'folio.read' });

router.get('/api/folios/:id', (ctx: Ctx) => shapeFolio(ctx, ctx.params.id), { perm: 'folio.read' });

router.get('/api/reservations/:id/folios', (ctx: Ctx) =>
  foliosForReservation(ctx.params.id).map((f) => ({
    id: f.id, number: f.number, name: f.name, type: f.type, windowNo: f.window_no,
    status: f.status, balanceMinor: f.balanceMinor,
  })), { perm: 'folio.read' });

/** Split folio — open another window on the same reservation. */
router.post('/api/reservations/:id/folios', (ctx: Ctx) => {
  const res = get<any>('SELECT * FROM reservations WHERE id = ? AND property_id = ?',
    ctx.params.id, pid(ctx));
  if (!res) notFound('Reservation');
  const folio = openFolio(pid(ctx), {
    reservationId: ctx.params.id,
    name: str(ctx.body.name ?? `${res.guest_name} — window`, 'name', { max: 120 }),
    type: oneOf(ctx.body.type, 'type', ['guest', 'company', 'master', 'house'] as const, 'guest'),
    companyId: ctx.body.companyId ?? null,
  });
  audit(ctx.auth, {
    action: 'folio.split', entity: 'FOLIO', entityId: folio.id, entityRef: folio.number,
    after: { reservationId: ctx.params.id },
  }, ctx.ip);
  return { id: folio.id, number: folio.number, windowNo: folio.window_no };
}, { perm: 'folio.post' });

// ─── Posting ─────────────────────────────────────────────────
router.post('/api/folios/:id/charges', (ctx: Ctx) => {
  const b = ctx.body;
  const result = postCharge(pid(ctx), ctx.auth, {
    folioId: ctx.params.id,
    code: str(b.code, 'code', { max: 20 }).toUpperCase(),
    description: b.description,
    qty: int(b.qty ?? 1, 'qty', { min: 1, max: 999 }),
    unitMinor: money(b.unitMinor, 'unitMinor'),
    businessDate: b.businessDate ?? businessDate(ctx),
    applyTax: b.applyTax === undefined ? undefined : boolIn(b.applyTax),
    reference: b.reference,
    persons: b.persons,
    nights: b.nights,
  });
  return { ...result, folio: shapeFolio(ctx, ctx.params.id) };
}, { perm: 'folio.post' });

router.post('/api/folios/:id/payments', (ctx: Ctx) => {
  const b = ctx.body;
  const result = postPayment(pid(ctx), ctx.auth, {
    folioId: ctx.params.id,
    method: str(b.method, 'method', { max: 40 }),
    amountMinor: money(b.amountMinor, 'amountMinor'),
    businessDate: b.businessDate ?? businessDate(ctx),
    reference: b.reference,
    description: b.description,
  });
  return { ...result, folio: shapeFolio(ctx, ctx.params.id) };
}, { perm: 'folio.payment' });

router.post('/api/folio-lines/:id/void', (ctx: Ctx) => {
  const result = voidLine(pid(ctx), ctx.auth, ctx.params.id,
    ctx.body.businessDate ?? businessDate(ctx),
    str(ctx.body.reason, 'reason', { max: 200 }));
  return result;
}, { perm: 'folio.void' });

router.post('/api/folio-lines/:id/transfer', (ctx: Ctx) =>
  transferLine(pid(ctx), ctx.auth, ctx.params.id, str(ctx.body.targetFolioId, 'targetFolioId')),
{ perm: 'folio.post' });

router.post('/api/folios/:id/close', (ctx: Ctx) =>
  closeFolio(pid(ctx), ctx.auth, ctx.params.id, { allowBalance: boolIn(ctx.body.allowBalance) }),
{ perm: 'folio.post' });

router.post('/api/folios/:id/reopen', (ctx: Ctx) =>
  reopenFolio(pid(ctx), ctx.auth, ctx.params.id), { perm: 'folio.void' });

// ─── Routing rules ───────────────────────────────────────────
router.get('/api/reservations/:id/routing', (ctx: Ctx) => all<any>(
  `SELECT fr.*, f.number, f.name FROM folio_routing fr JOIN folios f ON f.id = fr.target_folio_id
    WHERE fr.reservation_id = ?`, ctx.params.id,
).map((r) => ({
  id: r.id, targetFolioId: r.target_folio_id, targetFolio: r.number, targetName: r.name,
  codes: JSON.parse(r.codes), limitMinor: r.limit_minor,
})), { perm: 'folio.read' });

router.post('/api/reservations/:id/routing', (ctx: Ctx) => {
  const rId = id('rt');
  run(
    `INSERT INTO folio_routing(id, property_id, reservation_id, target_folio_id, codes, limit_minor, created_at)
     VALUES(?,?,?,?,?,?,?)`,
    rId, pid(ctx), ctx.params.id, str(ctx.body.targetFolioId, 'targetFolioId'),
    jsonCol(ctx.body.codes ?? ['*']), money(ctx.body.limitMinor ?? 0, 'limitMinor'), nowIso(),
  );
  audit(ctx.auth, {
    action: 'folio.routing', entity: 'RESERVATION', entityId: ctx.params.id, after: ctx.body,
  }, ctx.ip);
  return { id: rId };
}, { perm: 'folio.post' });

router.delete('/api/routing/:id', (ctx: Ctx) => {
  run('DELETE FROM folio_routing WHERE id = ? AND property_id = ?', ctx.params.id, pid(ctx));
  return { ok: true };
}, { perm: 'folio.post' });

// ─── Invoices ────────────────────────────────────────────────
router.get('/api/invoices', (ctx: Ctx) => all<any>(
  `SELECT i.*, c.name AS company_name FROM invoices i
     LEFT JOIN companies c ON c.id = i.company_id
    WHERE i.property_id = ? ORDER BY i.issued_at DESC LIMIT 300`,
  pid(ctx),
).map((i) => ({
  id: i.id, number: i.number, folioId: i.folio_id, issuedAt: i.issued_at, dueAt: i.due_at,
  billTo: i.bill_to, company: i.company_name, netMinor: i.net_minor, taxMinor: i.tax_minor,
  totalMinor: i.total_minor, paidMinor: i.paid_minor, status: i.status, currency: i.currency,
})), { perm: 'folio.read' });

router.post('/api/folios/:id/invoice', (ctx: Ctx) => createInvoice(pid(ctx), ctx.auth, {
  folioId: ctx.params.id,
  billTo: str(ctx.body.billTo, 'billTo', { max: 200 }),
  billAddress: ctx.body.billAddress,
  companyId: ctx.body.companyId ?? null,
  toAr: boolIn(ctx.body.toAr),
  dueAt: ctx.body.dueAt ?? null,
}), { perm: 'folio.post' });

// ─── City ledger / accounts receivable ───────────────────────
router.get('/api/ar', (ctx: Ctx) => {
  const companies = all<any>(
    'SELECT * FROM companies WHERE property_id = ? AND ar_enabled = 1 ORDER BY name', pid(ctx));
  return companies.map((c) => {
    const balance = scalar<number>(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'payment' THEN -amount_minor ELSE amount_minor END),0) AS t
         FROM ar_transactions WHERE company_id = ?`, c.id);
    const oldest = get<{ d: string }>(
      `SELECT MIN(date) AS d FROM ar_transactions WHERE company_id = ? AND kind = 'charge'`, c.id);
    return {
      companyId: c.id, code: c.code, name: c.name, type: c.type,
      creditLimitMinor: c.credit_limit_minor, paymentTermsDays: c.payment_terms_days,
      balanceMinor: balance, oldestChargeDate: oldest?.d ?? null,
      overLimit: c.credit_limit_minor > 0 && balance > c.credit_limit_minor,
    };
  });
}, { perm: 'ar.read' });

router.get('/api/ar/:companyId', (ctx: Ctx) => {
  const company = get<any>('SELECT * FROM companies WHERE id = ? AND property_id = ?',
    ctx.params.companyId, pid(ctx));
  if (!company) notFound('Company');
  const txns = all<any>(
    `SELECT t.*, i.number AS invoice_number FROM ar_transactions t
       LEFT JOIN invoices i ON i.id = t.invoice_id
      WHERE t.company_id = ? ORDER BY t.date DESC, t.created_at DESC`,
    ctx.params.companyId,
  );
  return {
    company: { id: company.id, code: company.code, name: company.name },
    balanceMinor: txns.reduce((s, t) => s + (t.kind === 'payment' ? -t.amount_minor : t.amount_minor), 0),
    transactions: txns.map((t) => ({
      id: t.id, date: t.date, kind: t.kind, amountMinor: t.amount_minor,
      invoice: t.invoice_number, reference: t.reference, note: t.note, createdBy: t.created_by,
    })),
  };
}, { perm: 'ar.read' });

router.post('/api/ar/:companyId/payment', (ctx: Ctx) => {
  const amount = money(ctx.body.amountMinor, 'amountMinor');
  if (amount <= 0) throw new HttpError(400, 'Payment must be positive');
  const arId = id('ar');
  run(
    `INSERT INTO ar_transactions(id, property_id, company_id, invoice_id, date, kind, amount_minor,
                                 reference, note, created_by, created_at)
     VALUES(?,?,?,?,?,'payment',?,?,?,?,?)`,
    arId, pid(ctx), ctx.params.companyId, ctx.body.invoiceId ?? null,
    ctx.body.date ?? businessDate(ctx), amount, ctx.body.reference ?? null,
    ctx.body.note ?? null, ctx.auth.userName, nowIso(),
  );
  if (ctx.body.invoiceId) {
    run(`UPDATE invoices SET paid_minor = paid_minor + ?,
           status = CASE WHEN paid_minor + ? >= total_minor THEN 'paid' ELSE status END
          WHERE id = ?`, amount, amount, ctx.body.invoiceId);
  }
  audit(ctx.auth, {
    action: 'ar.payment', entity: 'COMPANY', entityId: ctx.params.companyId,
    after: { amountMinor: amount },
  }, ctx.ip);
  return { id: arId };
}, { perm: 'ar.write' });

// ─── Cashier shift ───────────────────────────────────────────
router.get('/api/cashier/shift', (ctx: Ctx) => {
  const shift = get<any>(
    'SELECT * FROM cashier_shifts WHERE property_id = ? AND user_id = ? AND closed_at IS NULL',
    pid(ctx), ctx.auth.userId,
  );
  if (!shift) return { open: false };
  const activity = get<any>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'payment' THEN -amount_minor ELSE 0 END),0) AS payments,
            COALESCE(SUM(CASE WHEN kind = 'charge' THEN amount_minor ELSE 0 END),0) AS charges,
            count(*) AS lines
       FROM folio_lines
      WHERE property_id = ? AND posted_by = ? AND posted_at >= ? AND voided = 0`,
    pid(ctx), ctx.auth.userName, shift.opened_at,
  );
  const byMethod = all<any>(
    `SELECT COALESCE(method,'—') AS method, COALESCE(SUM(-amount_minor),0) AS total
       FROM folio_lines
      WHERE property_id = ? AND posted_by = ? AND posted_at >= ? AND kind = 'payment' AND voided = 0
      GROUP BY method`,
    pid(ctx), ctx.auth.userName, shift.opened_at,
  );
  return {
    open: true, id: shift.id, openedAt: shift.opened_at,
    openingFloatMinor: shift.opening_float_minor,
    paymentsMinor: activity?.payments ?? 0,
    chargesMinor: activity?.charges ?? 0,
    lines: activity?.lines ?? 0,
    expectedCashMinor: shift.opening_float_minor + (byMethod.find((m) => /cash/i.test(m.method))?.total ?? 0),
    byMethod: byMethod.map((m) => ({ method: m.method, totalMinor: m.total })),
  };
}, { perm: 'folio.read' });

router.post('/api/cashier/shift/open', (ctx: Ctx) => {
  const existing = get<any>(
    'SELECT id FROM cashier_shifts WHERE property_id = ? AND user_id = ? AND closed_at IS NULL',
    pid(ctx), ctx.auth.userId);
  if (existing) throw new HttpError(409, 'You already have an open shift');
  const sId = id('shf');
  run(
    `INSERT INTO cashier_shifts(id, property_id, user_id, opened_at, opening_float_minor)
     VALUES(?,?,?,?,?)`,
    sId, pid(ctx), ctx.auth.userId, nowIso(), money(ctx.body.openingFloatMinor ?? 0, 'openingFloatMinor'),
  );
  audit(ctx.auth, { action: 'cashier.open', entity: 'SHIFT', entityId: sId }, ctx.ip);
  return { id: sId };
}, { perm: 'folio.payment' });

router.post('/api/cashier/shift/close', (ctx: Ctx) => tx(() => {
  const shift = get<any>(
    'SELECT * FROM cashier_shifts WHERE property_id = ? AND user_id = ? AND closed_at IS NULL',
    pid(ctx), ctx.auth.userId);
  if (!shift) throw new HttpError(409, 'No open shift to close');
  const cash = scalar<number>(
    `SELECT COALESCE(SUM(-amount_minor),0) AS t FROM folio_lines
      WHERE property_id = ? AND posted_by = ? AND posted_at >= ? AND kind = 'payment'
        AND voided = 0 AND method LIKE '%ash%'`,
    pid(ctx), ctx.auth.userName, shift.opened_at,
  );
  const expected = shift.opening_float_minor + cash;
  const counted = money(ctx.body.countedMinor ?? expected, 'countedMinor');
  run(
    `UPDATE cashier_shifts SET closed_at = ?, counted_minor = ?, expected_minor = ?,
            variance_minor = ?, note = ? WHERE id = ?`,
    nowIso(), counted, expected, counted - expected, ctx.body.note ?? null, shift.id,
  );
  audit(ctx.auth, {
    action: 'cashier.close', entity: 'SHIFT', entityId: shift.id,
    after: { expectedMinor: expected, countedMinor: counted, varianceMinor: counted - expected },
  }, ctx.ip);
  return { expectedMinor: expected, countedMinor: counted, varianceMinor: counted - expected };
}), { perm: 'folio.payment' });
