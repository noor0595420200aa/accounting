'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { bad, HttpError, today, getSetting, audit, LABELS, daysBetween, str } = require('../util');
const { isAdmin } = require('../auth');
const L = require('../ledger');

const r = express.Router();

r.get('/me', (req, res) => {
  const u = { ...req.user };
  delete u.token;
  res.json({
    user: u,
    today: today(),
    currency: getSetting('currency') || '',
    staff_can_cancel: getSetting('staff_can_cancel') === '1',
    labels: LABELS,
  });
});

r.post('/me/password', (req, res) => {
  const { current, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) throw bad('كلمة المرور الحالية غير صحيحة');
  if (String(password || '').length < 6) throw bad('كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل');
  db.prepare('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?').run(bcrypt.hashSync(password, 10), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, req.user.token);
  audit(req.user, 'update', 'user', u.id, { summary: 'تغيير كلمة المرور' });
  res.json({ ok: true });
});

// بيانات مرجعية: المنشآت والحسابات والتصنيفات
r.get('/meta', (req, res) => {
  const admin = isAdmin(req.user);
  const facs = db.prepare('SELECT * FROM facilities WHERE active=1 ORDER BY sort').all()
    .filter((f) => admin || f.id === req.user.facility_id);
  for (const f of facs) {
    f.accounts = db.prepare('SELECT id, name, type FROM accounts WHERE facility_id=? AND active=1 ORDER BY id').all(f.id);
    f.expense_categories = db.prepare("SELECT name FROM categories WHERE facility_id=? AND kind='expense' AND active=1 ORDER BY id").all(f.id).map((x) => x.name);
    f.income_categories = db.prepare("SELECT name FROM categories WHERE facility_id=? AND kind='income' AND active=1 ORDER BY id").all(f.id).map((x) => x.name);
  }
  const users = admin ? db.prepare('SELECT id, display_name, username FROM users ORDER BY id').all() : [];
  const allAccounts = admin ? db.prepare(`SELECT a.id, a.name, a.facility_id, f.name AS facility_name FROM accounts a
    JOIN facilities f ON f.id=a.facility_id WHERE a.active=1 ORDER BY f.sort, a.id`).all() : [];
  res.json({
    facilities: facs, users, all_accounts: allAccounts,
    field: { open: getSetting('field_open'), close: getSetting('field_close'), hour_price: Number(getSetting('field_hour_price') || 0) },
  });
});

// ---------- لوحة التحكم ----------
function sumWhere(where, args) {
  return db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN direction='in' THEN amount END),0) AS tin,
      COALESCE(SUM(CASE WHEN direction='out' THEN amount END),0) AS tout,
      COALESCE(SUM(CASE WHEN kind IN ('payment','income') THEN amount END),0) AS revenue,
      COALESCE(SUM(CASE WHEN kind='refund' THEN amount END),0) AS refunds,
      COALESCE(SUM(CASE WHEN kind='expense' THEN amount END),0) AS expenses
    FROM txns WHERE status='active' AND ${where}`).get(...args);
}

r.get('/dashboard', (req, res) => {
  const admin = isAdmin(req.user);
  const fid = admin ? null : req.user.facility_id;
  const t = today();
  const year = t.slice(0, 4);
  const fW = fid ? ' AND facility_id=?' : '';
  const fA = fid ? [fid] : [];

  const facilities = db.prepare(`SELECT * FROM facilities WHERE active=1 ${fid ? 'AND id=?' : ''} ORDER BY sort`).all(...fA).map((f) => {
    const accounts = db.prepare('SELECT id, name, type FROM accounts WHERE facility_id=? ORDER BY id').all(f.id);
    for (const a of accounts) a.balance = L.accountBalance(a.id);
    const day = sumWhere('op_date=? AND facility_id=?', [t, f.id]);
    return { id: f.id, kind: f.kind, name: f.name, prefix: f.prefix, balance: accounts.reduce((s, a) => s + a.balance, 0), accounts, today: day };
  });

  const day = sumWhere(`op_date=?${fW}`, [t, ...fA]);
  const ytd = sumWhere(`op_date>=? AND op_date<=?${fW}`, [`${year}-01-01`, t, ...fA]);
  const yearEnd = `${year}-12-31`;

  const count = (tbl, col, kindCheck) => {
    if (fid && kindCheck !== db.prepare('SELECT kind FROM facilities WHERE id=?').get(fid).kind) return null;
    return db.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE ${col}=? AND status<>'cancelled'`).get(t).c;
  };

  let debts = 0;
  const lf = db.prepare("SELECT id FROM facilities WHERE kind='laundry' LIMIT 1").get();
  if (lf && (!fid || fid === lf.id)) {
    debts = db.prepare(`SELECT COALESCE(SUM(o.price - COALESCE((SELECT SUM(amount) FROM txns t WHERE t.ref_type='order' AND t.ref_id=o.id
      AND t.kind='payment' AND t.status='active'),0)),0) d FROM orders o WHERE o.status IN ('unpaid','partial')`).get().d;
  }

  const recentTxns = db.prepare(`SELECT t.id, t.no, t.direction, t.amount, t.kind, t.category, t.pay_type, t.party, t.op_date, t.status,
      t.ref_no, a.name AS account_name, f.name AS facility_name, u.display_name AS user_name
    FROM txns t JOIN accounts a ON a.id=t.account_id JOIN facilities f ON f.id=t.facility_id JOIN users u ON u.id=t.user_id
    ${fid ? 'WHERE t.facility_id=?' : ''} ORDER BY t.id DESC LIMIT 12`).all(...fA);
  const recentAudit = admin ? db.prepare(`SELECT a.*, u.display_name AS user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id
    WHERE a.action<>'login' ORDER BY a.id DESC LIMIT 12`).all() : [];
  const alerts = admin ? db.prepare('SELECT * FROM alerts WHERE resolved=0 ORDER BY id DESC LIMIT 20').all() : [];

  const todayEvents = {
    hall: (!fid || facilities[0]?.kind === 'hall') ? db.prepare(`SELECT id, no, customer_name, period, status FROM hall_bookings
      WHERE event_date=? AND status<>'cancelled'`).all(t) : [],
    field: (!fid || facilities[0]?.kind === 'field') ? db.prepare(`SELECT id, no, customer_name, start_time, end_time, status FROM field_bookings
      WHERE play_date=? AND status<>'cancelled' ORDER BY start_at`).all(t) : [],
  };

  res.json({
    today: t,
    days_to_year_end: daysBetween(t, yearEnd),
    total_balance: facilities.reduce((s, f) => s + f.balance, 0),
    day, ytd, debts, facilities,
    new_counts: {
      hall: count('hall_bookings', 'reg_date', 'hall'),
      field: count('field_bookings', 'reg_date', 'field'),
      laundry: count('orders', 'order_date', 'laundry'),
    },
    recent_txns: recentTxns, recent_audit: recentAudit, alerts, today_events: todayEvents,
  });
});

r.post('/alerts/:id/resolve', (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'للمدير فقط');
  db.prepare('UPDATE alerts SET resolved=1 WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// البحث برقم العملية أو المعاملة (مثل A105 أو U230)
r.get('/lookup', (req, res) => {
  const q = String(req.query.q || '').trim().toUpperCase();
  if (!q) throw bad('أدخل رقم العملية');
  const tries = [
    ['hall', 'hall_bookings'], ['field', 'field_bookings'], ['order', 'orders'], ['funding', 'fundings'], ['txn', 'txns'],
  ];
  for (const [type, tbl] of tries) {
    const row = db.prepare(`SELECT id, facility_id FROM ${tbl} WHERE UPPER(no)=?`).get(q);
    if (row) {
      if (!isAdmin(req.user) && row.facility_id !== req.user.facility_id) throw new HttpError(403, 'العملية تابعة لقسم آخر');
      return res.json({ type, id: row.id });
    }
  }
  throw new HttpError(404, `لا توجد عملية بالرقم ${q}`);
});

module.exports = { router: r, sumWhere };
