'use strict';
const express = require('express');
const { db, nowISO } = require('../db');
const { bad, HttpError, toMinor, str, reqDate, today, nextNo, audit, markStale, LABELS, fmt } = require('../util');
const { assertFacility, assertCanCancel, isAdmin } = require('../auth');
const L = require('../ledger');
const N = require('../notify');

const r = express.Router();
const laundryId = () => {
  const f = db.prepare("SELECT id FROM facilities WHERE kind='laundry' ORDER BY id LIMIT 1").get();
  if (!f) throw bad('قسم المغسلة غير موجود');
  return f.id;
};

function withMoney(o) {
  const m = L.refMoney('order', o.id);
  o.paid = m.paid;
  o.refunded = m.refunded;
  o.remaining = o.status === 'cancelled' ? 0 : Math.max(0, o.price - m.paid);
  return o;
}

function recompute(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o || o.status === 'cancelled') return;
  const { paid } = L.refMoney('order', id);
  const st = paid >= o.price ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  if (st !== o.status) db.prepare('UPDATE orders SET status=? WHERE id=?').run(st, id);
}

const ORDER_SELECT = `SELECT o.*, c.name AS customer_name, c.tag AS customer_tag, u.display_name AS user_name
  FROM orders o JOIN customers c ON c.id=o.customer_id JOIN users u ON u.id=o.created_by`;

// ---------- الخدمات ----------
r.get('/services', (req, res) => {
  const all = req.query.all === '1' && isAdmin(req.user);
  res.json(db.prepare(`SELECT * FROM services WHERE facility_id=? ${all ? '' : 'AND active=1'} ORDER BY id`).all(laundryId()));
});

r.post('/services', (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'للمدير فقط');
  const name = str(req.body.name, 'اسم الخدمة', { required: true, max: 100 });
  const price = toMinor(req.body.default_price, 'السعر الافتراضي', { allowZero: true });
  const info = db.prepare('INSERT INTO services (facility_id, name, default_price) VALUES (?,?,?)').run(laundryId(), name, price);
  audit(req.user, 'create', 'service', info.lastInsertRowid, { facilityId: laundryId(), summary: `إضافة خدمة: ${name}` });
  res.json({ id: info.lastInsertRowid });
});

r.put('/services/:id', (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'للمدير فقط');
  const s = db.prepare('SELECT * FROM services WHERE id=?').get(Number(req.params.id));
  if (!s) throw new HttpError(404, 'غير موجودة');
  const name = str(req.body.name ?? s.name, 'اسم الخدمة', { required: true, max: 100 });
  const price = req.body.default_price !== undefined ? toMinor(req.body.default_price, 'السعر', { allowZero: true }) : s.default_price;
  const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : s.active;
  db.prepare('UPDATE services SET name=?, default_price=?, active=? WHERE id=?').run(name, price, active, s.id);
  audit(req.user, 'update', 'service', s.id, { facilityId: s.facility_id, summary: `تعديل خدمة: ${name}`, details: { before: s } });
  res.json({ ok: true });
});

// ---------- الزبائن ----------
function customerDebt(customerId) {
  const orders = db.prepare("SELECT * FROM orders WHERE customer_id=? AND status<>'cancelled'").all(customerId).map(withMoney);
  return orders.reduce((s, o) => s + o.remaining, 0);
}

r.get('/customers', (req, res) => {
  assertFacility(req.user, laundryId());
  const q = String(req.query.q || '').trim();
  const rows = db.prepare(`SELECT * FROM customers WHERE facility_id=? AND (name LIKE ? OR tag LIKE ?)
    ORDER BY name LIMIT 50`).all(laundryId(), `%${q}%`, `%${q}%`);
  res.json(rows.map((c) => ({ ...c, debt: customerDebt(c.id) })));
});

function createCustomer(user, name, tag, notes) {
  const fid = laundryId();
  name = str(name, 'اسم الزبون', { required: true, max: 150 });
  tag = str(tag, 'الوصف المميز', { max: 100 }) || '';
  const ex = db.prepare('SELECT id FROM customers WHERE facility_id=? AND name=? AND tag=?').get(fid, name, tag);
  if (ex) throw bad('يوجد زبون بنفس الاسم والوصف. اختره من القائمة أو أضف وصفاً مميزاً مختلفاً');
  const info = db.prepare('INSERT INTO customers (facility_id, name, tag, notes, created_by, created_at) VALUES (?,?,?,?,?,?)')
    .run(fid, name, tag, str(notes, 'ملاحظات'), user.id, nowISO());
  audit(user, 'create', 'customer', info.lastInsertRowid, { facilityId: fid, summary: `زبون جديد: ${name}${tag ? ' - ' + tag : ''}` });
  return info.lastInsertRowid;
}

r.post('/customers', (req, res) => {
  assertFacility(req.user, laundryId());
  const id = db.transaction(() => createCustomer(req.user, req.body.name, req.body.tag, req.body.notes))();
  res.json({ id });
});

r.put('/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(req.params.id));
  if (!c) throw new HttpError(404, 'الزبون غير موجود');
  assertFacility(req.user, c.facility_id);
  const name = str(req.body.name ?? c.name, 'اسم الزبون', { required: true, max: 150 });
  const tag = str(req.body.tag ?? c.tag, 'الوصف', { max: 100 }) || '';
  const ex = db.prepare('SELECT id FROM customers WHERE facility_id=? AND name=? AND tag=? AND id<>?').get(c.facility_id, name, tag, c.id);
  if (ex) throw bad('يوجد زبون آخر بنفس الاسم والوصف');
  db.prepare('UPDATE customers SET name=?, tag=?, notes=? WHERE id=?').run(name, tag, str(req.body.notes ?? c.notes, 'ملاحظات'), c.id);
  audit(req.user, 'update', 'customer', c.id, { facilityId: c.facility_id, summary: `تعديل زبون: ${name}`, details: { before: c } });
  res.json({ ok: true });
});

// ملف الزبون: كل طلباته ودفعاته وديونه
r.get('/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(req.params.id));
  if (!c) throw new HttpError(404, 'الزبون غير موجود');
  assertFacility(req.user, c.facility_id);
  c.orders = db.prepare(`${ORDER_SELECT} WHERE o.customer_id=? ORDER BY o.order_date DESC, o.id DESC`).all(c.id).map(withMoney);
  c.payments = db.prepare(`SELECT t.*, a.label AS account_name, u.display_name AS user_name FROM txns t
    JOIN accounts a ON a.id=t.account_id JOIN users u ON u.id=t.user_id
    WHERE t.ref_type='order' AND t.ref_id IN (SELECT id FROM orders WHERE customer_id=?) ORDER BY t.op_date DESC, t.id DESC`).all(c.id);
  const active = c.orders.filter((o) => o.status !== 'cancelled');
  c.total = active.reduce((s, o) => s + o.price, 0);
  c.paid = active.reduce((s, o) => s + o.paid, 0);
  c.debt = active.reduce((s, o) => s + o.remaining, 0);
  res.json(c);
});

// ---------- الطلبات ----------
r.get('/orders', (req, res) => {
  assertFacility(req.user, laundryId());
  const { status, q, from, to } = req.query;
  const where = ['o.facility_id=?'];
  const args = [laundryId()];
  if (status) { where.push('o.status=?'); args.push(status); }
  if (from) { where.push('o.order_date>=?'); args.push(from); }
  if (to) { where.push('o.order_date<=?'); args.push(to); }
  if (q) { where.push('(c.name LIKE ? OR o.no LIKE ? OR o.service_name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  res.json(db.prepare(`${ORDER_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.order_date DESC, o.id DESC LIMIT 500`)
    .all(...args).map(withMoney));
});

r.get('/orders/:id', (req, res) => {
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id=?`).get(Number(req.params.id));
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  assertFacility(req.user, o.facility_id);
  withMoney(o);
  o.payments = L.refTxns('order', o.id);
  o.history = db.prepare(`SELECT a.*, u.display_name AS user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id
    WHERE (entity='order' AND entity_id=?) OR (entity='txn' AND entity_id IN (SELECT id FROM txns WHERE ref_type='order' AND ref_id=?))
    ORDER BY a.id`).all(o.id, o.id);
  res.json(o);
});

r.post('/orders', (req, res) => {
  const fid = laundryId();
  assertFacility(req.user, fid);
  const B = req.body || {};
  const service = db.prepare('SELECT * FROM services WHERE id=? AND facility_id=?').get(Number(B.service_id), fid);
  if (!service) throw bad('اختر نوع الخدمة');
  const price = toMinor(B.price, 'السعر');
  const paidNow = toMinor(B.paid_now, 'المبلغ المدفوع', { allowZero: true });
  if (paidNow > price) throw bad('المبلغ المدفوع أكبر من السعر');
  const orderDate = reqDate(B.order_date, 'تاريخ الطلب', today());
  if (paidNow > 0) L.getAccountFor(B.account_id, fid);
  const out = db.transaction(() => {
    let customerId = Number(B.customer_id) || 0;
    if (customerId) {
      const c = db.prepare('SELECT id FROM customers WHERE id=? AND facility_id=?').get(customerId, fid);
      if (!c) throw bad('الزبون غير موجود');
    } else {
      customerId = createCustomer(req.user, B.customer_name, B.customer_tag);
    }
    const no = nextNo(fid);
    const info = db.prepare(`INSERT INTO orders (no, facility_id, service_id, service_name, customer_id, order_date, price, notes, extra,
        status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,'unpaid',?,?)`)
      .run(no, fid, service.id, service.name, customerId, orderDate, price, str(B.notes, 'ملاحظات'), str(B.extra, 'تفاصيل أخرى'),
        req.user.id, nowISO());
    const id = info.lastInsertRowid;
    const cust = db.prepare('SELECT name, tag FROM customers WHERE id=?').get(customerId);
    const custName = cust.name + (cust.tag ? ` - ${cust.tag}` : '');
    audit(req.user, 'create', 'order', id, {
      facilityId: fid, refNo: no, summary: `طلب ${service.name} للزبون ${custName} بقيمة ${fmt(price)}`,
    });
    if (paidNow > 0) {
      L.postTxn(req.user, {
        facilityId: fid, accountId: B.account_id, direction: 'in', amount: paidNow, kind: 'payment',
        payType: 'advance', category: service.name, refType: 'order', refId: id, refNo: no, party: custName, opDate: orderDate,
      });
    }
    markStale([orderDate]);
    recompute(id);
    N.queue(req.user, { icon: '🚗', title: 'طلب مغسلة جديد', no, facilityId: fid, lines: [
      `🧾 الخدمة: ${service.name}`,
      `👤 الزبون: ${custName}`,
      `💰 السعر: ${N.m(price)}`,
      paidNow > 0 ? `✅ المدفوع: ${N.m(paidNow)} ← ${N.accLabel(B.account_id)}` : '✅ المدفوع: 0',
      paidNow >= price ? '🟢 الحالة: مدفوع' : `🟠 الحالة: ${paidNow > 0 ? 'دفع جزئي' : 'غير مدفوع'} — دين على الزبون ${N.m(price - paidNow)}`,
      B.notes ? `📝 ${B.notes}` : null,
    ] });
    return { id, no, customer_id: customerId };
  })();
  res.json(out);
});

r.put('/orders/:id', (req, res) => {
  const id = Number(req.params.id);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  assertFacility(req.user, o.facility_id);
  if (o.status === 'cancelled') throw bad('الطلب ملغي');
  const price = req.body.price !== undefined ? toMinor(req.body.price, 'السعر') : o.price;
  const { paid } = L.refMoney('order', id);
  if (price < paid) throw bad(`السعر لا يمكن أن يكون أقل من المدفوع (${fmt(paid)})`);
  const orderDate = reqDate(req.body.order_date ?? o.order_date, 'تاريخ الطلب');
  db.transaction(() => {
    db.prepare('UPDATE orders SET price=?, order_date=?, notes=?, extra=? WHERE id=?')
      .run(price, orderDate, str(req.body.notes ?? o.notes, 'ملاحظات'), str(req.body.extra ?? o.extra, 'تفاصيل أخرى'), id);
    audit(req.user, 'update', 'order', id, { facilityId: o.facility_id, refNo: o.no, summary: 'تعديل بيانات الطلب', details: { before: o } });
    markStale([o.order_date, orderDate]);
    recompute(id);
  })();
  res.json({ ok: true });
});

r.post('/orders/:id/payments', (req, res) => {
  const id = Number(req.params.id);
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id=?`).get(id);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  assertFacility(req.user, o.facility_id);
  if (o.status === 'cancelled') throw bad('الطلب ملغي');
  const amount = toMinor(req.body.amount, 'المبلغ');
  const payType = req.body.pay_type === 'on_pickup' ? 'on_pickup' : 'debt';
  const out = db.transaction(() => {
    const { paid } = L.refMoney('order', id);
    const remaining = o.price - paid;
    if (remaining <= 0) throw bad('الطلب مدفوع بالكامل');
    if (amount > remaining) throw bad(`المبلغ أكبر من المتبقي (${fmt(remaining)})`);
    const t = L.postTxn(req.user, {
      facilityId: o.facility_id, accountId: req.body.account_id, direction: 'in', amount, kind: 'payment',
      payType, category: o.service_name, refType: 'order', refId: id, refNo: o.no,
      party: o.customer_name + (o.customer_tag ? ` - ${o.customer_tag}` : ''),
      notes: str(req.body.notes, 'ملاحظات'), opDate: reqDate(req.body.op_date, 'تاريخ الدفعة', today()),
    });
    recompute(id);
    N.queue(req.user, { icon: '💵', title: 'دفعة على طلب مغسلة', no: t.no, facilityId: o.facility_id, lines: [
      `🔖 الطلب: #${o.no} — ${o.service_name}`,
      `👤 الزبون: ${t.party}`,
      `🏷 النوع: ${LABELS.payType[payType]}`,
      `💵 المبلغ: ${N.m(amount)} ← ${N.accLabel(t.account_id)}`,
      `⏳ المتبقي: ${remaining - amount > 0 ? N.m(remaining - amount) : 'لا شيء — مدفوع ✔'}`,
    ] });
    return { ok: true, no: t.no };
  })();
  res.json(out);
});

r.post('/orders/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id=?`).get(id);
  if (!o) throw new HttpError(404, 'الطلب غير موجود');
  assertCanCancel(req.user, o.facility_id);
  if (o.status === 'cancelled') throw bad('الطلب ملغي مسبقاً');
  const reason = str(req.body.cancel_reason, 'سبب الإلغاء', { required: true });
  const out = db.transaction(() => {
    const money = L.processCancelMoney(req.user, {
      facilityId: o.facility_id, refType: 'order', refId: id, refNo: o.no, party: o.customer_name, body: req.body,
    });
    db.prepare(`UPDATE orders SET status='cancelled', cancel_reason=?, cancel_action=?, cancelled_by=?, cancelled_at=? WHERE id=?`)
      .run(reason, money.action, req.user.id, nowISO(), id);
    audit(req.user, 'cancel', 'order', id, {
      facilityId: o.facility_id, refNo: o.no,
      summary: `إلغاء الطلب — ${LABELS.cancelAction[money.action]}${money.refund ? ` (${fmt(money.refund)})` : ''} — السبب: ${reason}`,
      details: { original: o },
    });
    markStale([o.order_date]);
    N.queue(req.user, { icon: '❌', title: 'إلغاء طلب مغسلة', no: o.no, facilityId: o.facility_id, lines: [
      `🧾 ${o.service_name} — ${o.customer_name}`,
      `💸 المبلغ المدفوع: ${LABELS.cancelAction[money.action]}${money.refund ? ` — تم إرجاع ${N.m(money.refund)}` : ''}`,
      `❓ السبب: ${reason}`,
    ] });
    return { ok: true, ...money };
  })();
  res.json(out);
});

// ---------- صفحة الديون ----------
r.get('/debts', (req, res) => {
  assertFacility(req.user, laundryId());
  const orders = db.prepare(`${ORDER_SELECT} WHERE o.facility_id=? AND o.status IN ('unpaid','partial') ORDER BY o.order_date`)
    .all(laundryId()).map(withMoney).filter((o) => o.remaining > 0);
  const lastPay = db.prepare(`SELECT t.op_date, t.amount, u.display_name AS user_name FROM txns t JOIN users u ON u.id=t.user_id
    WHERE t.ref_type='order' AND t.ref_id=? AND t.status='active' ORDER BY t.op_date DESC, t.id DESC`);
  for (const o of orders) o.payments = lastPay.all(o.id);
  const byCustomer = {};
  for (const o of orders) {
    const k = o.customer_id;
    byCustomer[k] = byCustomer[k] || { customer_id: k, name: o.customer_name, tag: o.customer_tag, total: 0, paid: 0, remaining: 0, orders: 0 };
    byCustomer[k].total += o.price;
    byCustomer[k].paid += o.paid;
    byCustomer[k].remaining += o.remaining;
    byCustomer[k].orders += 1;
  }
  const customers = Object.values(byCustomer).sort((a, b) => b.remaining - a.remaining);
  res.json({ orders, customers, total: customers.reduce((s, c) => s + c.remaining, 0) });
});

// تسديد دين الزبون دفعة واحدة على أقدم الطلبات أولاً
r.post('/customers/:id/pay', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(req.params.id));
  if (!c) throw new HttpError(404, 'الزبون غير موجود');
  assertFacility(req.user, c.facility_id);
  let amount = toMinor(req.body.amount, 'المبلغ');
  const opDate = reqDate(req.body.op_date, 'تاريخ الدفعة', today());
  const out = db.transaction(() => {
    const orders = db.prepare("SELECT * FROM orders WHERE customer_id=? AND status IN ('unpaid','partial') ORDER BY order_date, id")
      .all(c.id).map(withMoney).filter((o) => o.remaining > 0);
    const debt = orders.reduce((s, o) => s + o.remaining, 0);
    if (debt <= 0) throw bad('لا يوجد دين على هذا الزبون');
    if (amount > debt) throw bad(`المبلغ أكبر من الدين (${fmt(debt)})`);
    const nos = [];
    for (const o of orders) {
      if (amount <= 0) break;
      const part = Math.min(amount, o.remaining);
      const t = L.postTxn(req.user, {
        facilityId: c.facility_id, accountId: req.body.account_id, direction: 'in', amount: part, kind: 'payment',
        payType: 'debt', category: o.service_name, refType: 'order', refId: o.id, refNo: o.no,
        party: c.name + (c.tag ? ` - ${c.tag}` : ''), notes: str(req.body.notes, 'ملاحظات'), opDate,
      });
      nos.push(t.no);
      recompute(o.id);
      amount -= part;
    }
    const paidNow = toMinor(req.body.amount, 'المبلغ');
    N.queue(req.user, { icon: '💵', title: 'تسديد دين زبون', no: nos.join('، '), facilityId: c.facility_id, lines: [
      `👤 الزبون: ${c.name}${c.tag ? ` - ${c.tag}` : ''}`,
      `💵 المبلغ: ${N.m(paidNow)} ← ${N.accLabel(req.body.account_id)}`,
      `⏳ الدين المتبقي عليه: ${debt - paidNow > 0 ? N.m(debt - paidNow) : 'لا شيء — سدد كامل الدين ✔'}`,
    ] });
    return { ok: true, nos };
  })();
  res.json(out);
});

module.exports = { router: r, recompute, laundryId };
