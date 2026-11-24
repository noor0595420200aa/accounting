'use strict';
const express = require('express');
const { db, nowISO } = require('../db');
const { bad, HttpError, toMinor, str, reqDate, today, nextNo, audit, markStale, LABELS, fmt } = require('../util');
const { assertFacility, assertCanCancel, isAdmin } = require('../auth');
const L = require('../ledger');

const r = express.Router();

const TXN_SELECT = `SELECT t.*, a.name AS account_name, a.type AS account_type, f.name AS facility_name, f.prefix,
    u.display_name AS user_name, cu.display_name AS cancelled_by_name
  FROM txns t JOIN accounts a ON a.id=t.account_id JOIN facilities f ON f.id=t.facility_id
  JOIN users u ON u.id=t.user_id LEFT JOIN users cu ON cu.id=t.cancelled_by`;

function scopeFacility(user, requested) {
  if (isAdmin(user)) return requested ? Number(requested) : null;
  return user.facility_id;
}

// ---------- سجل العمليات المالية ----------
r.get('/txns', (req, res) => {
  const fid = scopeFacility(req.user, req.query.facility_id);
  const where = ['1=1'];
  const args = [];
  if (fid) { where.push('t.facility_id=?'); args.push(fid); }
  const q = req.query;
  if (q.account_id) { where.push('t.account_id=?'); args.push(Number(q.account_id)); }
  if (q.kind) { where.push('t.kind=?'); args.push(q.kind); }
  if (q.direction) { where.push('t.direction=?'); args.push(q.direction); }
  if (q.user_id) { where.push('t.user_id=?'); args.push(Number(q.user_id)); }
  if (q.status) { where.push('t.status=?'); args.push(q.status); }
  if (q.from) { where.push('t.op_date>=?'); args.push(q.from); }
  if (q.to) { where.push('t.op_date<=?'); args.push(q.to); }
  if (q.q) {
    where.push('(t.no LIKE ? OR t.ref_no LIKE ? OR t.party LIKE ? OR t.notes LIKE ? OR t.category LIKE ?)');
    for (let i = 0; i < 5; i++) args.push(`%${q.q}%`);
  }
  const limit = Math.min(Number(q.limit) || 300, 2000);
  res.json(db.prepare(`${TXN_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.op_date DESC, t.id DESC LIMIT ${limit}`).all(...args));
});

r.get('/txns/:id', (req, res) => {
  const t = db.prepare(`${TXN_SELECT} WHERE t.id=?`).get(Number(req.params.id));
  if (!t) throw new HttpError(404, 'العملية غير موجودة');
  assertFacility(req.user, t.facility_id);
  res.json(t);
});

function checkBalance(user, account, amount, allowNegative) {
  const bal = L.accountBalance(account.id);
  if (bal < amount) {
    if (isAdmin(user) && allowNegative) return;
    throw bad(`رصيد ${account.name} الحالي ${fmt(bal)} لا يكفي.${isAdmin(user) ? ' يمكنك تأكيد التسجيل رغم ذلك.' : ' راجع المدير.'}`);
  }
}

// إيداع يدوي (إيراد غير مرتبط بحجز أو طلب)
r.post('/txns/income', (req, res) => {
  const B = req.body || {};
  const fid = Number(B.facility_id);
  assertFacility(req.user, fid);
  const amount = toMinor(B.amount, 'المبلغ');
  const out = db.transaction(() => {
    const t = L.postTxn(req.user, {
      facilityId: fid, accountId: B.account_id, direction: 'in', amount, kind: 'income',
      category: str(B.category, 'نوع العملية', { required: true, max: 100 }),
      party: str(B.party, 'مصدر المبلغ', { required: true, max: 200 }),
      notes: str(B.notes, 'ملاحظات'), extra: str(B.extra, 'تفاصيل أخرى'),
      opDate: reqDate(B.op_date, 'تاريخ الإيداع', today()),
    });
    return { id: t.id, no: t.no };
  })();
  res.json(out);
});

// مصروف: يخصم مباشرة من الحساب المحدد
r.post('/txns/expense', (req, res) => {
  const B = req.body || {};
  const fid = Number(B.facility_id);
  assertFacility(req.user, fid);
  const amount = toMinor(B.amount, 'المبلغ');
  const account = L.getAccountFor(B.account_id, fid);
  const out = db.transaction(() => {
    checkBalance(req.user, account, amount, B.allow_negative);
    const t = L.postTxn(req.user, {
      facilityId: fid, accountId: account.id, direction: 'out', amount, kind: 'expense',
      category: str(B.category, 'تصنيف المصروف', { required: true, max: 100 }),
      party: str(B.party, 'الجهة المستلمة', { required: true, max: 200 }),
      notes: str(B.notes, 'ملاحظات'), extra: str(B.extra, 'تفاصيل أخرى'),
      opDate: reqDate(B.op_date, 'تاريخ المصروف', today()),
    });
    return { id: t.id, no: t.no };
  })();
  res.json(out);
});

// إلغاء عملية مالية (لا يوجد حذف نهائي)
r.post('/txns/:id/cancel', (req, res) => {
  const t = db.prepare('SELECT * FROM txns WHERE id=?').get(Number(req.params.id));
  if (!t) throw new HttpError(404, 'العملية غير موجودة');
  assertCanCancel(req.user, t.facility_id);
  if (t.kind.startsWith('funding')) throw bad('عمليات التمويل تُلغى من صفحة التمويل');
  if (t.kind === 'refund') throw bad('المرتجع مرتبط بإلغاء الحجز ولا يُلغى منفصلاً');
  const reason = str(req.body.reason, 'سبب الإلغاء', { required: true });
  db.transaction(() => {
    if (t.ref_type) {
      const tbl = { hall: 'hall_bookings', field: 'field_bookings', order: 'orders' }[t.ref_type];
      const ref = tbl && db.prepare(`SELECT status FROM ${tbl} WHERE id=?`).get(t.ref_id);
      if (ref && ref.status === 'cancelled') throw bad('لا يمكن إلغاء دفعة لحجز/طلب ملغي');
    }
    L.cancelTxnRow(req.user, t, reason);
    if (t.ref_type === 'hall') require('./hall').recompute(t.ref_id);
    if (t.ref_type === 'field') require('./field').recompute(t.ref_id);
    if (t.ref_type === 'order') require('./laundry').recompute(t.ref_id);
  })();
  res.json({ ok: true });
});

// ---------- الحسابات وأماكن حفظ الأموال ----------
function accountRow(a) {
  a.balance = L.accountBalance(a.id);
  return a;
}

r.get('/accounts', (req, res) => {
  const fid = scopeFacility(req.user, req.query.facility_id);
  const rows = db.prepare(`SELECT a.*, f.name AS facility_name FROM accounts a JOIN facilities f ON f.id=a.facility_id
    WHERE ${fid ? 'a.facility_id=?' : '1=1'} ${req.query.all === '1' ? '' : 'AND a.active=1'} ORDER BY f.sort, a.id`)
    .all(...(fid ? [fid] : []));
  res.json(rows.map(accountRow));
});

r.post('/accounts', (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'للمدير فقط');
  const B = req.body || {};
  L.getFacility(Number(B.facility_id));
  const type = Object.keys(LABELS.accountType).includes(B.type) ? B.type : 'other';
  const info = db.prepare(`INSERT INTO accounts (facility_id, name, type, phone, notes, opening_balance, opening_date, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(Number(B.facility_id), str(B.name, 'اسم الحساب', { required: true, max: 150 }), type,
    str(B.phone, 'الهاتف', { max: 50 }), str(B.notes, 'ملاحظات'), toMinor(B.opening_balance, 'الرصيد الافتتاحي', { allowZero: true }),
    reqDate(B.opening_date, 'تاريخ الرصيد الافتتاحي', today()), req.user.id, nowISO());
  audit(req.user, 'create', 'account', info.lastInsertRowid, {
    facilityId: Number(B.facility_id), summary: `إضافة حساب: ${B.name} برصيد افتتاحي ${fmt(toMinor(B.opening_balance, '', { allowZero: true }))}`,
  });
  res.json({ id: info.lastInsertRowid });
});

r.put('/accounts/:id', (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'للمدير فقط');
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(Number(req.params.id));
  if (!a) throw new HttpError(404, 'الحساب غير موجود');
  const B = req.body || {};
  const d = {
    name: str(B.name ?? a.name, 'اسم الحساب', { required: true, max: 150 }),
    type: Object.keys(LABELS.accountType).includes(B.type) ? B.type : a.type,
    phone: str(B.phone ?? a.phone, 'الهاتف', { max: 50 }),
    notes: str(B.notes ?? a.notes, 'ملاحظات'),
    opening_balance: B.opening_balance !== undefined ? toMinor(B.opening_balance, 'الرصيد الافتتاحي', { allowZero: true }) : a.opening_balance,
    opening_date: reqDate(B.opening_date ?? a.opening_date, 'تاريخ الرصيد الافتتاحي'),
    active: B.active !== undefined ? (B.active ? 1 : 0) : a.active,
  };
  const hasTxns = db.prepare('SELECT COUNT(*) c FROM txns WHERE account_id=?').get(a.id).c > 0;
  if (hasTxns && (d.opening_balance !== a.opening_balance || d.opening_date !== a.opening_date) && !B.confirm_opening_change) {
    throw bad('هذا الحساب عليه عمليات. تغيير الرصيد الافتتاحي سيغيّر كل الأرصدة اللاحقة — أكّد التغيير للمتابعة');
  }
  if (!d.active && L.accountBalance(a.id) !== 0 && !B.confirm_deactivate) {
    throw bad('رصيد الحساب ليس صفراً. أكّد التعطيل للمتابعة (سيبقى رصيده ظاهراً في التقارير)');
  }
  db.prepare('UPDATE accounts SET name=?, type=?, phone=?, notes=?, opening_balance=?, opening_date=?, active=? WHERE id=?')
    .run(d.name, d.type, d.phone, d.notes, d.opening_balance, d.opening_date, d.active, a.id);
  const changes = {};
  for (const k of Object.keys(d)) if (d[k] !== a[k]) changes[k] = { from: a[k], to: d[k] };
  audit(req.user, 'update', 'account', a.id, { facilityId: a.facility_id, summary: `تعديل حساب: ${d.name}`, details: changes });
  if (changes.opening_balance || changes.opening_date) markStale([a.opening_date, d.opening_date]);
  res.json({ ok: true });
});

// كشف حساب لحساب واحد مع رصيد متحرك
r.get('/accounts/:id/statement', (req, res) => {
  const a = db.prepare(`SELECT a.*, f.name AS facility_name FROM accounts a JOIN facilities f ON f.id=a.facility_id WHERE a.id=?`)
    .get(Number(req.params.id));
  if (!a) throw new HttpError(404, 'الحساب غير موجود');
  assertFacility(req.user, a.facility_id);
  const from = req.query.from ? reqDate(req.query.from, 'من') : null;
  const to = req.query.to ? reqDate(req.query.to, 'إلى') : null;
  const { addDays } = require('../util');
  const opening = from ? L.accountBalance(a.id, addDays(from, -1)) : a.opening_balance;
  const rows = db.prepare(`${TXN_SELECT} WHERE t.account_id=? ${from ? 'AND t.op_date>=?' : ''} ${to ? 'AND t.op_date<=?' : ''}
    ORDER BY t.op_date, t.id`).all(...[a.id, from, to].filter(Boolean));
  let run = opening;
  let tin = 0;
  let tout = 0;
  for (const t of rows) {
    if (t.status === 'active') {
      if (t.direction === 'in') { run += t.amount; tin += t.amount; } else { run -= t.amount; tout += t.amount; }
    }
    t.running = run;
  }
  res.json({ account: a, opening, total_in: tin, total_out: tout, closing: run, rows });
});

// ---------- الخزن: ملخص كل منشأة ----------
function treasury(fid, from, to) {
  const { addDays } = require('../util');
  const f = L.getFacility(fid);
  const accounts = db.prepare('SELECT * FROM accounts WHERE facility_id=? ORDER BY active DESC, id').all(fid);
  const opening = accounts.reduce((s, a) => s + (from ? L.accountBalance(a.id, addDays(from, -1)) : a.opening_balance), 0);
  const where = ["facility_id=? AND status='active'"];
  const args = [fid];
  if (from) { where.push('op_date>=?'); args.push(from); }
  if (to) { where.push('op_date<=?'); args.push(to); }
  const sums = db.prepare(`SELECT direction, kind, COALESCE(SUM(amount),0) s FROM txns WHERE ${where.join(' AND ')} GROUP BY direction, kind`).all(...args);
  const total_in = sums.filter((x) => x.direction === 'in').reduce((s, x) => s + x.s, 0);
  const total_out = sums.filter((x) => x.direction === 'out').reduce((s, x) => s + x.s, 0);
  const byKind = Object.fromEntries(sums.map((x) => [x.kind, x.s]));
  const perAcc = db.prepare(`SELECT account_id, direction, COALESCE(SUM(amount),0) s FROM txns WHERE ${where.join(' AND ')} GROUP BY account_id, direction`).all(...args);
  const { methodOf, LABELS: LB } = require('../util');
  for (const a of accounts) {
    a.balance = L.accountBalance(a.id, to);
    a.tin = perAcc.filter((x) => x.account_id === a.id && x.direction === 'in').reduce((t, x) => t + x.s, 0);
    a.tout = perAcc.filter((x) => x.account_id === a.id && x.direction === 'out').reduce((t, x) => t + x.s, 0);
    a.method = methodOf(a.type);
    a.method_label = LB.method[a.method];
  }
  // تقسيم حسب الطريقة: كاش / بال باي / جوال باي
  const mm = new Map();
  for (const a of accounts) {
    const x = mm.get(a.method) || { method: a.method, label: a.method_label, tin: 0, tout: 0, balance: 0 };
    x.tin += a.tin; x.tout += a.tout; x.balance += a.balance;
    mm.set(a.method, x);
  }
  return {
    by_method: [...mm.values()],
    facility: f, accounts, opening, total_in, total_out, by_kind: byKind,
    closing: opening + total_in - total_out,
    current: accounts.reduce((s, a) => s + L.accountBalance(a.id), 0),
  };
}

r.get('/treasury', (req, res) => {
  const fid = scopeFacility(req.user, null);
  const facs = db.prepare(`SELECT id FROM facilities WHERE active=1 ${fid ? 'AND id=?' : ''} ORDER BY sort`).all(...(fid ? [fid] : []));
  res.json(facs.map((f) => treasury(f.id)));
});

r.get('/treasury/:fid', (req, res) => {
  const fid = Number(req.params.fid);
  assertFacility(req.user, fid);
  const from = req.query.from ? reqDate(req.query.from, 'من') : null;
  const to = req.query.to ? reqDate(req.query.to, 'إلى') : null;
  const t = treasury(fid, from, to);
  const where = ['t.facility_id=?'];
  const args = [fid];
  if (from) { where.push('t.op_date>=?'); args.push(from); }
  if (to) { where.push('t.op_date<=?'); args.push(to); }
  t.txns = db.prepare(`${TXN_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.op_date DESC, t.id DESC LIMIT 1000`).all(...args);
  res.json(t);
});

// ---------- التمويل / الديون الخارجية ----------
function fundingRow(f) {
  const rep = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM txns WHERE ref_type='funding' AND ref_id=? AND kind='funding_repay' AND status='active'`).get(f.id).s;
  f.repaid = rep;
  f.outstanding = f.status === 'cancelled' ? 0 : f.amount - rep;
  return f;
}

const FUND_SELECT = `SELECT fu.*, f.name AS facility_name, a.name AS account_name, sa.name AS source_account_name, u.display_name AS user_name
  FROM fundings fu JOIN facilities f ON f.id=fu.facility_id JOIN accounts a ON a.id=fu.account_id
  LEFT JOIN accounts sa ON sa.id=fu.source_account_id JOIN users u ON u.id=fu.created_by`;

r.get('/fundings', (req, res) => {
  const fid = scopeFacility(req.user, req.query.facility_id);
  const rows = db.prepare(`${FUND_SELECT} ${fid ? 'WHERE fu.facility_id=?' : ''} ORDER BY fu.op_date DESC, fu.id DESC`)
    .all(...(fid ? [fid] : [])).map(fundingRow);
  for (const f of rows) f.txns = L.refTxns('funding', f.id);
  res.json(rows);
});

r.post('/fundings', (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'للمدير فقط');
  const B = req.body || {};
  const fid = Number(B.facility_id);
  const fac = L.getFacility(fid);
  const acc = L.getAccountFor(B.account_id, fid);
  const amount = toMinor(B.amount, 'المبلغ');
  const opDate = reqDate(B.op_date, 'التاريخ', today());
  const party = str(B.party, 'الجهة الممولة', { required: true, max: 200 });
  const notes = str(B.notes, 'ملاحظات');
  let src = null;
  if (B.source_account_id) {
    src = L.getAccountFor(B.source_account_id, null);
    if (src.id === acc.id) throw bad('الحساب المصدر هو نفس الحساب المستلم');
  }
  const out = db.transaction(() => {
    if (src) checkBalance(req.user, src, amount, B.allow_negative);
    const no = nextNo(fid);
    const info = db.prepare(`INSERT INTO fundings (no, facility_id, account_id, source_account_id, party, amount, op_date, notes, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(no, fid, acc.id, src ? src.id : null, party, amount, opDate, notes, req.user.id, nowISO());
    const id = info.lastInsertRowid;
    audit(req.user, 'create', 'funding', id, {
      facilityId: fid, refNo: no, summary: `تمويل ${fmt(amount)} لصالح ${fac.name} من ${src ? src.name : party}`,
    });
    L.postTxn(req.user, {
      facilityId: fid, accountId: acc.id, direction: 'in', amount, kind: 'funding', category: 'تمويل',
      refType: 'funding', refId: id, refNo: no, party, notes, opDate,
    });
    if (src) {
      L.postTxn(req.user, {
        facilityId: src.facility_id, accountId: src.id, direction: 'out', amount, kind: 'funding_out', category: 'تمويل',
        refType: 'funding', refId: id, refNo: no, party: fac.name, notes, opDate,
      });
    }
    return { id, no };
  })();
  res.json(out);
});

r.post('/fundings/:id/repay', (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'للمدير فقط');
  const f = db.prepare('SELECT * FROM fundings WHERE id=?').get(Number(req.params.id));
  if (!f) throw new HttpError(404, 'غير موجود');
  if (f.status === 'cancelled') throw bad('التمويل ملغي');
  const amount = toMinor(req.body.amount, 'المبلغ');
  const acc = L.getAccountFor(req.body.account_id, f.facility_id);
  const opDate = reqDate(req.body.op_date, 'التاريخ', today());
  const out = db.transaction(() => {
    fundingRow(f);
    if (amount > f.outstanding) throw bad(`المبلغ أكبر من المتبقي (${fmt(f.outstanding)})`);
    checkBalance(req.user, acc, amount, req.body.allow_negative);
    const notes = str(req.body.notes, 'ملاحظات');
    const t = L.postTxn(req.user, {
      facilityId: f.facility_id, accountId: acc.id, direction: 'out', amount, kind: 'funding_repay', category: 'سداد تمويل',
      refType: 'funding', refId: f.id, refNo: f.no, party: f.party, notes, opDate,
    });
    if (f.source_account_id) {
      const src = db.prepare('SELECT * FROM accounts WHERE id=?').get(f.source_account_id);
      L.postTxn(req.user, {
        facilityId: src.facility_id, accountId: src.id, direction: 'in', amount, kind: 'funding_repay_in', category: 'استرداد تمويل',
        refType: 'funding', refId: f.id, refNo: f.no, party: L.getFacility(f.facility_id).name, notes, opDate,
      });
    }
    return { ok: true, no: t.no };
  })();
  res.json(out);
});

r.post('/fundings/:id/cancel', (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'للمدير فقط');
  const f = db.prepare('SELECT * FROM fundings WHERE id=?').get(Number(req.params.id));
  if (!f) throw new HttpError(404, 'غير موجود');
  if (f.status === 'cancelled') throw bad('ملغي مسبقاً');
  const reason = str(req.body.reason, 'سبب الإلغاء', { required: true });
  db.transaction(() => {
    for (const t of db.prepare("SELECT * FROM txns WHERE ref_type='funding' AND ref_id=? AND status='active'").all(f.id)) {
      L.cancelTxnRow(req.user, t, reason);
    }
    db.prepare("UPDATE fundings SET status='cancelled', cancel_reason=?, cancelled_by=?, cancelled_at=? WHERE id=?")
      .run(reason, req.user.id, nowISO(), f.id);
    audit(req.user, 'cancel', 'funding', f.id, { facilityId: f.facility_id, refNo: f.no, summary: `إلغاء تمويل — ${reason}`, details: { original: f } });
  })();
  res.json({ ok: true });
});

module.exports = { router: r, fundingRow, treasury };
