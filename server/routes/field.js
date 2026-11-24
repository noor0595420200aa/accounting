'use strict';
const express = require('express');
const { db, nowISO } = require('../db');
const {
  bad, HttpError, toMinor, str, reqDate, today, nextNo, audit, markStale, LABELS, fmt, TIME_RE, addDays, getSetting,
} = require('../util');
const { assertFacility, assertCanCancel } = require('../auth');
const L = require('../ledger');
const N = require('../notify');

const r = express.Router();
const fieldId = () => {
  const f = db.prepare("SELECT id FROM facilities WHERE kind='field' ORDER BY id LIMIT 1").get();
  if (!f) throw bad('قسم الملعب غير موجود');
  return f.id;
};

function withMoney(b) {
  const m = L.refMoney('field', b.id);
  b.paid = m.paid;
  b.refunded = m.refunded;
  b.remaining = b.status === 'cancelled' ? 0 : Math.max(0, b.total - m.paid);
  return b;
}

function recompute(id) {
  const b = db.prepare('SELECT * FROM field_bookings WHERE id=?').get(id);
  if (!b || b.status === 'cancelled') return;
  const { paid } = L.refMoney('field', id);
  const st = paid >= b.total ? 'paid' : 'confirmed';
  if (st !== b.status) db.prepare('UPDATE field_bookings SET status=? WHERE id=?').run(st, id);
}

// يحسب البداية والنهاية والدقائق — الحجز الذي ينتهي بعد منتصف الليل ينتقل لليوم التالي تلقائياً
function timing(playDate, start, end) {
  if (!TIME_RE.test(start || '')) throw bad('ساعة البداية غير صحيحة');
  if (!TIME_RE.test(end || '')) throw bad('ساعة النهاية غير صحيحة');
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  let minutes = toMin(end) - toMin(start);
  const endDate = minutes <= 0 ? addDays(playDate, 1) : playDate;
  if (minutes <= 0) minutes += 1440;
  if (minutes > 24 * 60) throw bad('مدة غير صحيحة');
  return { start_at: `${playDate}T${start}`, end_at: `${endDate}T${end}`, minutes };
}

function checkConflict(startAt, endAt, exceptId = 0) {
  const c = db.prepare(`SELECT no, customer_name, start_time, end_time FROM field_bookings
    WHERE facility_id=? AND status<>'cancelled' AND id<>? AND start_at < ? AND end_at > ? LIMIT 1`)
    .get(fieldId(), exceptId, endAt, startAt);
  if (c) throw bad(`يتعارض مع حجز ${c.no} (${c.customer_name}) من ${c.start_time} إلى ${c.end_time}`);
}

function parse(B, base = {}) {
  const v = (k) => (B[k] !== undefined ? B[k] : base[k]);
  const d = {
    customer_name: str(v('customer_name'), 'اسم الشخص', { required: true, max: 200 }),
    phone: str(v('phone'), 'رقم الهاتف', { max: 50 }),
    reg_date: reqDate(v('reg_date'), 'تاريخ التسجيل', today()),
    play_date: reqDate(v('play_date'), 'تاريخ اللعب'),
    start_time: v('start_time'),
    end_time: v('end_time'),
    hour_price: B.hour_price !== undefined ? toMinor(B.hour_price, 'سعر الساعة', { allowZero: true }) : base.hour_price,
    notes: str(v('notes'), 'الملاحظات'),
    extra: str(v('extra'), 'تفاصيل أخرى'),
  };
  if (d.hour_price === undefined) throw bad('سعر الساعة مطلوب');
  Object.assign(d, timing(d.play_date, d.start_time, d.end_time));
  const computed = Math.round((d.minutes / 60) * d.hour_price);
  d.total = B.total !== undefined && B.total !== null && B.total !== '' ? toMinor(B.total, 'الإجمالي') : computed;
  if (!(d.total > 0)) throw bad('الإجمالي يجب أن يكون أكبر من صفر');
  return d;
}

r.get('/bookings', (req, res) => {
  assertFacility(req.user, fieldId());
  const { status, q, from, to, date_field } = req.query;
  const field = date_field === 'reg' ? 'reg_date' : 'play_date';
  const where = ['facility_id = ?'];
  const args = [fieldId()];
  if (status) { where.push('status = ?'); args.push(status); }
  if (from) { where.push(`${field} >= ?`); args.push(from); }
  if (to) { where.push(`${field} <= ?`); args.push(to); }
  if (q) { where.push('(customer_name LIKE ? OR no LIKE ? OR phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT b.*, u.display_name AS user_name FROM field_bookings b JOIN users u ON u.id=b.created_by
    WHERE ${where.join(' AND ')} ORDER BY start_at DESC LIMIT 500`).all(...args);
  res.json(rows.map(withMoney));
});

// جدول يومي/أسبوعي: الحجوزات التي تتقاطع مع الفترة
r.get('/schedule', (req, res) => {
  assertFacility(req.user, fieldId());
  const from = reqDate(req.query.from, 'من', today());
  const days = Math.min(Math.max(Number(req.query.days) || 1, 1), 31);
  const to = addDays(from, days + 1); // يوم إضافي لعرض الحجوزات بعد منتصف الليل
  const rows = db.prepare(`SELECT id, no, customer_name, play_date, start_time, end_time, start_at, end_at, minutes, status, total
    FROM field_bookings WHERE facility_id=? AND status<>'cancelled' AND start_at < ? AND end_at > ? ORDER BY start_at`)
    .all(fieldId(), `${to}T00:00`, `${from}T00:00`);
  res.json({
    from, days, bookings: rows.map(withMoney),
    open: getSetting('field_open') || '08:00', close: getSetting('field_close') || '02:00',
  });
});

r.get('/bookings/:id', (req, res) => {
  const b = db.prepare(`SELECT b.*, u.display_name AS user_name, cu.display_name AS cancelled_by_name
    FROM field_bookings b JOIN users u ON u.id=b.created_by LEFT JOIN users cu ON cu.id=b.cancelled_by WHERE b.id=?`)
    .get(Number(req.params.id));
  if (!b) throw new HttpError(404, 'الحجز غير موجود');
  assertFacility(req.user, b.facility_id);
  withMoney(b);
  b.payments = L.refTxns('field', b.id);
  b.history = db.prepare(`SELECT a.*, u.display_name AS user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id
    WHERE (entity='field_booking' AND entity_id=?) OR (entity='txn' AND entity_id IN (SELECT id FROM txns WHERE ref_type='field' AND ref_id=?))
    ORDER BY a.id`).all(b.id, b.id);
  res.json(b);
});

r.post('/bookings', (req, res) => {
  const fid = fieldId();
  assertFacility(req.user, fid);
  const B = req.body || {};
  const d = parse(B);
  const deposit = toMinor(B.deposit, 'العربون (إلزامي)');
  if (deposit > d.total) throw bad('العربون أكبر من الإجمالي');
  const depositDate = reqDate(B.deposit_date, 'تاريخ دفع العربون', d.reg_date);
  L.getAccountFor(B.account_id, fid);
  const out = db.transaction(() => {
    checkConflict(d.start_at, d.end_at);
    const no = nextNo(fid);
    const info = db.prepare(`INSERT INTO field_bookings (no, facility_id, customer_name, phone, reg_date, play_date, start_time, end_time,
        start_at, end_at, minutes, hour_price, total, notes, extra, status, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',?,?)`)
      .run(no, fid, d.customer_name, d.phone, d.reg_date, d.play_date, d.start_time, d.end_time, d.start_at, d.end_at,
        d.minutes, d.hour_price, d.total, d.notes, d.extra, req.user.id, nowISO());
    const id = info.lastInsertRowid;
    audit(req.user, 'create', 'field_booking', id, {
      facilityId: fid, refNo: no,
      summary: `حجز ملعب ${d.customer_name} يوم ${d.play_date} من ${d.start_time} إلى ${d.end_time} بقيمة ${fmt(d.total)}`,
    });
    L.postTxn(req.user, {
      facilityId: fid, accountId: B.account_id, direction: 'in', amount: deposit, kind: 'payment',
      payType: deposit >= d.total ? 'full' : 'deposit', category: 'حجز ملعب',
      refType: 'field', refId: id, refNo: no, party: d.customer_name, opDate: depositDate,
    });
    markStale([d.reg_date]);
    recompute(id);
    N.queue(req.user, { icon: '⚽', title: 'حجز ملعب جديد', no, facilityId: fid, lines: [
      `👤 الاسم: ${d.customer_name}${d.phone ? ` · 📞 ${d.phone}` : ''}`,
      `📅 موعد اللعب: ${d.play_date} من ${d.start_time} إلى ${d.end_time} (${d.minutes / 60} ساعة)`,
      `💰 السعر: ${N.m(d.total)}`,
      `✅ ${deposit >= d.total ? 'دفع كامل' : 'العربون'}: ${N.m(deposit)} ← ${N.accLabel(B.account_id)}`,
      `⏳ المتبقي: ${N.m(d.total - deposit)}`,
      d.reg_date !== today() ? `🗂 تاريخ التسجيل: ${d.reg_date} (إدخال قديم)` : null,
      d.notes ? `📝 ${d.notes}` : null,
    ] });
    return { id, no };
  })();
  res.json(out);
});

r.put('/bookings/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare('SELECT * FROM field_bookings WHERE id=?').get(id);
  if (!b) throw new HttpError(404, 'الحجز غير موجود');
  assertFacility(req.user, b.facility_id);
  if (b.status === 'cancelled') throw bad('لا يمكن تعديل حجز ملغي');
  const B = { ...req.body };
  if (B.hour_price === '') delete B.hour_price;
  const d = parse(B, b);
  const { paid } = L.refMoney('field', id);
  if (d.total < paid) throw bad(`الإجمالي لا يمكن أن يكون أقل من المدفوع (${fmt(paid)})`);
  db.transaction(() => {
    checkConflict(d.start_at, d.end_at, id);
    db.prepare(`UPDATE field_bookings SET customer_name=?, phone=?, reg_date=?, play_date=?, start_time=?, end_time=?, start_at=?, end_at=?,
      minutes=?, hour_price=?, total=?, notes=?, extra=? WHERE id=?`)
      .run(d.customer_name, d.phone, d.reg_date, d.play_date, d.start_time, d.end_time, d.start_at, d.end_at, d.minutes,
        d.hour_price, d.total, d.notes, d.extra, id);
    const changes = {};
    for (const k of Object.keys(d)) if (d[k] !== b[k]) changes[k] = { from: b[k], to: d[k] };
    audit(req.user, 'update', 'field_booking', id, { facilityId: b.facility_id, refNo: b.no, summary: 'تعديل بيانات الحجز', details: changes });
    if (Object.keys(changes).length) N.queue(req.user, { icon: '✏️', title: 'تعديل حجز ملعب', no: b.no, facilityId: b.facility_id, lines: [`👤 ${d.customer_name}`, ...N.changesLines(changes)] });
    markStale([b.reg_date, d.reg_date]);
    recompute(id);
  })();
  res.json({ ok: true });
});

r.post('/bookings/:id/payments', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare('SELECT * FROM field_bookings WHERE id=?').get(id);
  if (!b) throw new HttpError(404, 'الحجز غير موجود');
  assertFacility(req.user, b.facility_id);
  if (b.status === 'cancelled') throw bad('الحجز ملغي');
  const amount = toMinor(req.body.amount, 'المبلغ');
  const out = db.transaction(() => {
    const { paid } = L.refMoney('field', id);
    const remaining = b.total - paid;
    if (remaining <= 0) throw bad('الحجز مكتمل الدفع');
    if (amount > remaining) throw bad(`المبلغ أكبر من المتبقي (${fmt(remaining)})`);
    const t = L.postTxn(req.user, {
      facilityId: b.facility_id, accountId: req.body.account_id, direction: 'in', amount, kind: 'payment',
      payType: L.bookingPayType(b.total, paid, amount), category: 'حجز ملعب',
      refType: 'field', refId: id, refNo: b.no, party: b.customer_name,
      notes: str(req.body.notes, 'ملاحظات'), opDate: reqDate(req.body.op_date, 'تاريخ الدفعة', today()),
    });
    recompute(id);
    N.queue(req.user, { icon: '💵', title: 'دفعة على حجز ملعب', no: t.no, facilityId: b.facility_id, lines: [
      `🔖 الحجز: #${b.no} — ${b.customer_name}`,
      `🏷 النوع: ${LABELS.payType[t.pay_type]}`,
      `💵 المبلغ: ${N.m(amount)} ← ${N.accLabel(t.account_id)}`,
      `⏳ المتبقي: ${remaining - amount > 0 ? N.m(remaining - amount) : 'لا شيء — مكتمل الدفع ✔'}`,
    ] });
    return { ok: true, no: t.no };
  })();
  res.json(out);
});

r.post('/bookings/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const b = db.prepare('SELECT * FROM field_bookings WHERE id=?').get(id);
  if (!b) throw new HttpError(404, 'الحجز غير موجود');
  assertCanCancel(req.user, b.facility_id);
  if (b.status === 'cancelled') throw bad('الحجز ملغي مسبقاً');
  const reason = str(req.body.cancel_reason, 'سبب الإلغاء', { required: true });
  const out = db.transaction(() => {
    const money = L.processCancelMoney(req.user, {
      facilityId: b.facility_id, refType: 'field', refId: id, refNo: b.no, party: b.customer_name, body: req.body,
    });
    db.prepare(`UPDATE field_bookings SET status='cancelled', cancel_reason=?, cancel_action=?, cancelled_by=?, cancelled_at=? WHERE id=?`)
      .run(reason, money.action, req.user.id, nowISO(), id);
    audit(req.user, 'cancel', 'field_booking', id, {
      facilityId: b.facility_id, refNo: b.no,
      summary: `إلغاء الحجز — ${LABELS.cancelAction[money.action]}${money.refund ? ` (${fmt(money.refund)})` : ''} — السبب: ${reason}`,
      details: { original: b },
    });
    markStale([b.reg_date]);
    N.queue(req.user, { icon: '❌', title: 'إلغاء حجز ملعب', no: b.no, facilityId: b.facility_id, lines: [
      `👤 الاسم: ${b.customer_name}`,
      `💸 المبلغ المدفوع: ${LABELS.cancelAction[money.action]}${money.refund ? ` — تم إرجاع ${N.m(money.refund)} من ${N.accLabel(req.body.refund_account_id)}` : ''}`,
      `❓ السبب: ${reason}`,
    ] });
    return { ok: true, ...money };
  })();
  res.json(out);
});

module.exports = { router: r, recompute };
