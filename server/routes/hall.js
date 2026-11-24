'use strict';
const express = require('express');
const { db, nowISO } = require('../db');
const { bad, HttpError, toMinor, str, reqDate, today, nextNo, audit, markStale, LABELS, fmt } = require('../util');
const { assertFacility, assertCanCancel } = require('../auth');
const L = require('../ledger');

const r = express.Router();
const hallId = () => {
  const f = db.prepare("SELECT id FROM facilities WHERE kind='hall' ORDER BY id LIMIT 1").get();
  if (!f) throw bad('قسم الصالة غير موجود');
  return f.id;
};

function withMoney(b) {
  const m = L.refMoney('hall', b.id);
  b.paid = m.paid;
  b.refunded = m.refunded;
  b.remaining = b.status === 'cancelled' ? 0 : Math.max(0, b.total - m.paid);
  return b;
}

function recompute(id) {
  const b = db.prepare('SELECT * FROM hall_bookings WHERE id=?').get(id);
  if (!b || b.status === 'cancelled') return;
  const { paid } = L.refMoney('hall', id);
  const st = paid >= b.total ? 'paid' : 'confirmed';
  if (st !== b.status) db.prepare('UPDATE hall_bookings SET status=? WHERE id=?').run(st, id);
}

function checkConflict(eventDate, period, exceptId = 0) {
  const c = db.prepare(`SELECT no, customer_name FROM hall_bookings
    WHERE facility_id=? AND event_date=? AND period=? AND status<>'cancelled' AND id<>?`)
    .get(hallId(), eventDate, period, exceptId);
  if (c) throw bad(`الفترة ${LABELS.period[period]} بتاريخ ${eventDate} محجوزة مسبقاً (${c.no} - ${c.customer_name})`);
}

r.get('/bookings', (req, res) => {
  assertFacility(req.user, hallId());
  const { status, q, from, to, date_field } = req.query;
  const field = date_field === 'reg' ? 'reg_date' : 'event_date';
  const where = ['facility_id = ?'];
  const args = [hallId()];
  if (status) { where.push('status = ?'); args.push(status); }
  if (from) { where.push(`${field} >= ?`); args.push(from); }
  if (to) { where.push(`${field} <= ?`); args.push(to); }
  if (q) { where.push('(customer_name LIKE ? OR phone LIKE ? OR no LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT b.*, u.display_name AS user_name FROM hall_bookings b JOIN users u ON u.id=b.created_by
    WHERE ${where.join(' AND ')} ORDER BY event_date DESC, id DESC LIMIT 500`).all(...args);
  res.json(rows.map(withMoney));
});

r.get('/calendar', (req, res) => {
  assertFacility(req.user, hallId());
  const month = String(req.query.month || today().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) throw bad('شهر غير صحيح');
  const rows = db.prepare(`SELECT id, no, customer_name, event_date, period, status, total FROM hall_bookings
    WHERE facility_id=? AND event_date LIKE ? AND status<>'cancelled' ORDER BY event_date`).all(hallId(), `${month}-%`);
  res.json(rows);
});

r.get('/bookings/:id', (req, res) => {
  const b = db.prepare(`SELECT b.*, u.display_name AS user_name, cu.display_name AS cancelled_by_name
    FROM hall_bookings b JOIN users u ON u.id=b.created_by LEFT JOIN users cu ON cu.id=b.cancelled_by WHERE b.id=?`)
    .get(Number(req.params.id));
  if (!b) throw new HttpError(404, 'الحجز غير موجود');
  assertFacility(req.user, b.facility_id);
  withMoney(b);
  b.payments = L.refTxns('hall', b.id);
  b.history = db.prepare(`SELECT a.*, u.display_name AS user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id
    WHERE (entity='hall_booking' AND entity_id=?) OR (entity='txn' AND entity_id IN (SELECT id FROM txns WHERE ref_type='hall' AND ref_id=?))
    ORDER BY a.id`).all(b.id, b.id);
  res.json(b);
});

r.post('/bookings', (req, res) => {
  const fid = hallId();
  assertFacility(req.user, fid);
  const B = req.body || {};
  const d = {
    customer_name: str(B.customer_name, 'اسم صاحب الحجز', { required: true, max: 200 }),
    phone: str(B.phone, 'رقم الهاتف', { max: 50 }),
    reg_date: reqDate(B.reg_date, 'تاريخ التسجيل', today()),
    event_date: reqDate(B.event_date, 'تاريخ الفرح'),
    period: B.period === 'morning' ? 'morning' : 'evening',
    total: toMinor(B.total, 'السعر الإجمالي'),
    notes: str(B.notes, 'الملاحظات'),
    extra: str(B.extra, 'تفاصيل أخرى'),
  };
  // العربون إلزامي
  const deposit = toMinor(B.deposit, 'العربون (إلزامي)');
  if (deposit > d.total) throw bad('العربون أكبر من السعر الإجمالي');
  const depositDate = reqDate(B.deposit_date, 'تاريخ دفع العربون', d.reg_date);
  L.getAccountFor(B.account_id, fid);

  const out = db.transaction(() => {
    checkConflict(d.event_date, d.period);
    const no = nextNo(fid);
    const info = db.prepare(`INSERT INTO hall_bookings (no, facility_id, customer_name, phone, reg_date, event_date, period,
        total, notes, extra, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'confirmed', ?, ?)`)
      .run(no, fid, d.customer_name, d.phone, d.reg_date, d.event_date, d.period, d.total, d.notes, d.extra, req.user.id, nowISO());
    const id = info.lastInsertRowid;
    audit(req.user, 'create', 'hall_booking', id, {
      facilityId: fid, refNo: no,
      summary: `حجز صالة ${d.customer_name} بتاريخ ${d.event_date} (${LABELS.period[d.period]}) بقيمة ${fmt(d.total)}`,
    });
    L.postTxn(req.user, {
      facilityId: fid, accountId: B.account_id, direction: 'in', amount: deposit, kind: 'payment',
      payType: deposit >= d.total ? 'full' : 'deposit', category: 'حجز صالة',
      refType: 'hall', refId: id, refNo: no, party: d.customer_name, opDate: depositDate,
    });
    markStale([d.reg_date]);
    recompute(id);
    return { id, no };
  })();
  res.json(out);
});

r.put('/bookings/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare('SELECT * FROM hall_bookings WHERE id=?').get(id);
  if (!b) throw new HttpError(404, 'الحجز غير موجود');
  assertFacility(req.user, b.facility_id);
  if (b.status === 'cancelled') throw bad('لا يمكن تعديل حجز ملغي');
  const B = req.body || {};
  const d = {
    customer_name: str(B.customer_name ?? b.customer_name, 'اسم صاحب الحجز', { required: true, max: 200 }),
    phone: str(B.phone ?? b.phone, 'رقم الهاتف', { max: 50 }),
    reg_date: reqDate(B.reg_date ?? b.reg_date, 'تاريخ التسجيل'),
    event_date: reqDate(B.event_date ?? b.event_date, 'تاريخ الفرح'),
    period: (B.period ?? b.period) === 'morning' ? 'morning' : 'evening',
    total: B.total !== undefined ? toMinor(B.total, 'السعر الإجمالي') : b.total,
    notes: str(B.notes ?? b.notes, 'الملاحظات'),
    extra: str(B.extra ?? b.extra, 'تفاصيل أخرى'),
  };
  const { paid } = L.refMoney('hall', id);
  if (d.total < paid) throw bad(`السعر الإجمالي لا يمكن أن يكون أقل من المدفوع (${fmt(paid)})`);
  db.transaction(() => {
    checkConflict(d.event_date, d.period, id);
    db.prepare(`UPDATE hall_bookings SET customer_name=?, phone=?, reg_date=?, event_date=?, period=?, total=?, notes=?, extra=?
      WHERE id=?`).run(d.customer_name, d.phone, d.reg_date, d.event_date, d.period, d.total, d.notes, d.extra, id);
    const changes = {};
    for (const k of Object.keys(d)) if (d[k] !== b[k]) changes[k] = { from: b[k], to: d[k] };
    audit(req.user, 'update', 'hall_booking', id, { facilityId: b.facility_id, refNo: b.no, summary: 'تعديل بيانات الحجز', details: changes });
    markStale([b.reg_date, d.reg_date]);
    recompute(id);
  })();
  res.json({ ok: true });
});

r.post('/bookings/:id/payments', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare('SELECT * FROM hall_bookings WHERE id=?').get(id);
  if (!b) throw new HttpError(404, 'الحجز غير موجود');
  assertFacility(req.user, b.facility_id);
  if (b.status === 'cancelled') throw bad('الحجز ملغي');
  const amount = toMinor(req.body.amount, 'المبلغ');
  const out = db.transaction(() => {
    const { paid } = L.refMoney('hall', id);
    const remaining = b.total - paid;
    if (remaining <= 0) throw bad('الحجز مكتمل الدفع');
    if (amount > remaining) throw bad(`المبلغ أكبر من المتبقي (${fmt(remaining)})`);
    const t = L.postTxn(req.user, {
      facilityId: b.facility_id, accountId: req.body.account_id, direction: 'in', amount, kind: 'payment',
      payType: L.bookingPayType(b.total, paid, amount), category: 'حجز صالة',
      refType: 'hall', refId: id, refNo: b.no, party: b.customer_name,
      notes: str(req.body.notes, 'ملاحظات'), opDate: reqDate(req.body.op_date, 'تاريخ الدفعة', today()),
    });
    recompute(id);
    return { ok: true, no: t.no };
  })();
  res.json(out);
});

r.post('/bookings/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare('SELECT * FROM hall_bookings WHERE id=?').get(id);
  if (!b) throw new HttpError(404, 'الحجز غير موجود');
  assertCanCancel(req.user, b.facility_id);
  if (b.status === 'cancelled') throw bad('الحجز ملغي مسبقاً');
  const reason = str(req.body.cancel_reason, 'سبب الإلغاء', { required: true });
  const out = db.transaction(() => {
    const money = L.processCancelMoney(req.user, {
      facilityId: b.facility_id, refType: 'hall', refId: id, refNo: b.no, party: b.customer_name, body: req.body,
    });
    db.prepare(`UPDATE hall_bookings SET status='cancelled', cancel_reason=?, cancel_action=?, cancelled_by=?, cancelled_at=? WHERE id=?`)
      .run(reason, money.action, req.user.id, nowISO(), id);
    audit(req.user, 'cancel', 'hall_booking', id, {
      facilityId: b.facility_id, refNo: b.no,
      summary: `إلغاء الحجز — ${LABELS.cancelAction[money.action]}${money.refund ? ` (${fmt(money.refund)})` : ''} — السبب: ${reason}`,
      details: { original: b },
    });
    markStale([b.reg_date]);
    return { ok: true, ...money };
  })();
  res.json(out);
});

module.exports = { router: r, recompute };
