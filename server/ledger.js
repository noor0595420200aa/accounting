'use strict';
const { db, nowISO } = require('./db');
const { bad, HttpError, nextNo, audit, today, markStale, LABELS, fmt } = require('./util');

const INFLOW_KINDS = ['payment', 'income', 'funding', 'funding_repay_in'];

function getFacility(id) {
  const f = db.prepare('SELECT * FROM facilities WHERE id = ?').get(id);
  if (!f) throw bad('المنشأة غير موجودة');
  return f;
}

function getAccountFor(accountId, facilityId) {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(accountId));
  if (!a) throw bad('يجب اختيار الحساب');
  if (!a.active) throw bad('الحساب معطل');
  if (facilityId != null && a.facility_id !== Number(facilityId)) throw bad('الحساب لا يتبع هذه المنشأة');
  return a;
}

function accountBalance(accountId, uptoDate = null) {
  const a = db.prepare('SELECT opening_balance FROM accounts WHERE id = ?').get(accountId);
  if (!a) return 0;
  const r = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) AS i,
      COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS o
    FROM txns WHERE account_id = ? AND status = 'active' ${uptoDate ? 'AND op_date <= ?' : ''}`)
    .get(...(uptoDate ? [accountId, uptoDate] : [accountId]));
  // الرصيد الافتتاحي هو نقطة البداية لكل الحساب (يُحسب دائماً)
  return a.opening_balance + r.i - r.o;
}

/**
 * تسجيل حركة مالية في الدفتر. يجب استدعاؤها داخل db.transaction.
 */
function postTxn(user, t) {
  const facility = getFacility(t.facilityId);
  const account = getAccountFor(t.accountId, facility.id);
  if (!['in', 'out'].includes(t.direction)) throw bad('اتجاه غير صحيح');
  if (!(t.amount > 0)) throw bad('المبلغ يجب أن يكون أكبر من صفر');
  const no = nextNo(facility.id);
  const now = nowISO();
  const info = db.prepare(`INSERT INTO txns (no, facility_id, account_id, direction, amount, kind, category, pay_type,
      ref_type, ref_id, ref_no, party, notes, extra, op_date, created_date, created_at, user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(no, facility.id, account.id, t.direction, t.amount, t.kind, t.category || null, t.payType || null,
      t.refType || null, t.refId || null, t.refNo || null, t.party || null, t.notes || null, t.extra || null,
      t.opDate, today(), now, user.id);
  const label = t.payType ? LABELS.payType[t.payType] : LABELS.kind[t.kind];
  audit(user, 'create', 'txn', info.lastInsertRowid, {
    facilityId: facility.id, refNo: no,
    summary: `${label} ${fmt(t.amount)} ${t.direction === 'in' ? 'إلى' : 'من'} ${account.name}${t.refNo ? ` (مرجع ${t.refNo})` : ''}`,
  });
  markStale([t.opDate]);
  return db.prepare('SELECT * FROM txns WHERE id = ?').get(info.lastInsertRowid);
}

function cancelTxnRow(user, txn, reason) {
  if (txn.status === 'cancelled') throw bad('العملية ملغاة مسبقاً');
  db.prepare(`UPDATE txns SET status='cancelled', cancel_reason=?, cancelled_by=?, cancelled_at=? WHERE id=?`)
    .run(reason, user.id, nowISO(), txn.id);
  audit(user, 'cancel', 'txn', txn.id, {
    facilityId: txn.facility_id, refNo: txn.no,
    summary: `إلغاء ${LABELS.kind[txn.kind]} ${fmt(txn.amount)} — السبب: ${reason}`,
    details: { original: txn },
  });
  markStale([txn.op_date]);
}

// ---------- ملخص المدفوعات لأي مرجع (حجز/طلب) ----------
function refMoney(refType, refId) {
  const r = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE 0 END),0) AS paid,
      COALESCE(SUM(CASE WHEN kind='refund' THEN amount ELSE 0 END),0) AS refunded
    FROM txns WHERE ref_type=? AND ref_id=? AND status='active'`).get(refType, refId);
  return r;
}

function refTxns(refType, refId) {
  return db.prepare(`SELECT t.*, a.name AS account_name, u.display_name AS user_name,
      cu.display_name AS cancelled_by_name
    FROM txns t JOIN accounts a ON a.id=t.account_id JOIN users u ON u.id=t.user_id
    LEFT JOIN users cu ON cu.id=t.cancelled_by
    WHERE t.ref_type=? AND t.ref_id=? ORDER BY t.op_date, t.id`).all(refType, refId);
}

/**
 * يحدد نوع الدفعة تلقائياً: عربون / دفع كامل / تكملة / إضافية
 */
function bookingPayType(total, paidBefore, amount) {
  if (paidBefore === 0) return amount >= total ? 'full' : 'deposit';
  return paidBefore + amount >= total ? 'completion' : 'extra';
}

/**
 * إلغاء حجز أو طلب مع معالجة المبالغ المدفوعة:
 * refund_all = إرجاع كامل، keep = الاحتفاظ بالمبلغ، partial = خصم مبلغ وإرجاع الباقي
 */
function processCancelMoney(user, { facilityId, refType, refId, refNo, party, body }) {
  const { paid, refunded } = refMoney(refType, refId);
  const net = paid - refunded;
  if (net <= 0) return { action: 'none', refund: 0 };
  const action = body.cancel_action;
  if (!['refund_all', 'keep', 'partial'].includes(action)) throw bad('حدد ماذا نفعل بالمبلغ المدفوع: إرجاع أو احتفاظ أو خصم');
  let refund = 0;
  if (action === 'refund_all') refund = net;
  if (action === 'partial') {
    const { toMinor } = require('./util');
    const kept = toMinor(body.kept_amount, 'المبلغ المخصوم', { allowZero: true });
    if (kept >= net) throw bad('المبلغ المخصوم يجب أن يكون أقل من المدفوع، أو اختر الاحتفاظ بالمبلغ');
    refund = net - kept;
  }
  if (refund > 0) {
    const acc = getAccountFor(body.refund_account_id, facilityId);
    const bal = accountBalance(acc.id);
    if (bal < refund && !(user.role === 'admin' && body.allow_negative)) {
      throw bad(`رصيد ${acc.name} (${fmt(bal)}) لا يكفي لإرجاع ${fmt(refund)}`);
    }
    postTxn(user, {
      facilityId, accountId: acc.id, direction: 'out', amount: refund, kind: 'refund',
      category: 'مرتجع إلغاء', refType, refId, refNo, party,
      notes: body.cancel_reason, opDate: body.refund_date || today(),
    });
  }
  return { action, refund };
}

module.exports = {
  INFLOW_KINDS, getFacility, getAccountFor, accountBalance, postTxn, cancelTxnRow, refMoney, refTxns,
  bookingPayType, processCancelMoney, HttpError,
};
