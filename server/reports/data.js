'use strict';
const { db } = require('../db');
const { bad, today, addDays, isDate, daysBetween, LABELS } = require('../util');
const L = require('../ledger');

const TXN_SELECT = `SELECT t.*, a.name AS account_name, a.type AS account_type, f.name AS facility_name,
    u.display_name AS user_name, cu.display_name AS cancelled_by_name
  FROM txns t JOIN accounts a ON a.id=t.account_id JOIN facilities f ON f.id=t.facility_id
  JOIN users u ON u.id=t.user_id LEFT JOIN users cu ON cu.id=t.cancelled_by`;

function firstDate() {
  const r = db.prepare(`SELECT MIN(d) d FROM (
    SELECT MIN(op_date) d FROM txns UNION ALL SELECT MIN(reg_date) FROM hall_bookings
    UNION ALL SELECT MIN(reg_date) FROM field_bookings UNION ALL SELECT MIN(order_date) FROM orders
    UNION ALL SELECT MIN(opening_date) FROM accounts)`).get();
  return r.d || today();
}

/** يحول اختيار المستخدم إلى فترة من/إلى */
function resolvePeriod(q = {}) {
  const t = today();
  const p = q.preset || 'day';
  let from;
  let to;
  let title;
  switch (p) {
    case 'day': {
      const d = q.date && isDate(q.date) ? q.date : t;
      from = to = d;
      title = `التقرير اليومي ${d}`;
      break;
    }
    case 'last7':
    case 'week': {
      to = q.date && isDate(q.date) ? q.date : t;
      from = addDays(to, -6);
      title = `تقرير آخر 7 أيام (${from} — ${to})`;
      break;
    }
    case 'month': {
      const m = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : t.slice(0, 7);
      from = `${m}-01`;
      const [y, mo] = m.split('-').map(Number);
      to = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      title = `التقرير الشهري ${m}`;
      break;
    }
    case 'year': {
      const y = /^\d{4}$/.test(String(q.year || '')) ? String(q.year) : t.slice(0, 4);
      from = `${y}-01-01`;
      to = `${y}-12-31`;
      title = `التقرير السنوي ${y}`;
      break;
    }
    case 'range': {
      if (!isDate(q.from) || !isDate(q.to)) throw bad('حدد تاريخ البداية والنهاية');
      from = q.from;
      to = q.to;
      if (from > to) throw bad('تاريخ البداية بعد تاريخ النهاية');
      title = `تقرير من ${from} إلى ${to}`;
      break;
    }
    case 'all': {
      from = firstDate();
      to = t;
      if (from > to) from = to;
      title = `التقرير الشامل من بداية النشاط حتى ${to}`;
      break;
    }
    default:
      throw bad('نوع تقرير غير معروف');
  }
  return { preset: p, from, to, title };
}

function sumKinds(rows) {
  const s = { tin: 0, tout: 0, revenue: 0, refunds: 0, expenses: 0, funding_in: 0, funding_out: 0, funding_repay: 0, funding_repay_in: 0 };
  for (const t of rows) {
    if (t.status !== 'active') continue;
    if (t.direction === 'in') s.tin += t.amount; else s.tout += t.amount;
    if (t.kind === 'payment' || t.kind === 'income') s.revenue += t.amount;
    if (t.kind === 'refund') s.refunds += t.amount;
    if (t.kind === 'expense') s.expenses += t.amount;
    if (t.kind === 'funding') s.funding_in += t.amount;
    if (t.kind === 'funding_out') s.funding_out += t.amount;
    if (t.kind === 'funding_repay') s.funding_repay += t.amount;
    if (t.kind === 'funding_repay_in') s.funding_repay_in += t.amount;
  }
  s.net = s.tin - s.tout;
  return s;
}

function groupSum(rows, key) {
  const m = new Map();
  for (const t of rows) {
    if (t.status !== 'active') continue;
    const k = t[key] || '—';
    m.set(k, (m.get(k) || 0) + t.amount);
  }
  return [...m.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
}

function paidUpTo(refType, refId, to) {
  return db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM txns WHERE ref_type=? AND ref_id=? AND kind='payment'
    AND status='active' AND op_date<=?`).get(refType, refId, to).s;
}

// ديون زبائن المغسلة كما هي في تاريخ معين (ليست نقداً في الخزنة)
function laundryDebtsAsOf(fid, to) {
  const orders = db.prepare(`SELECT o.*, c.name AS customer_name, c.tag AS customer_tag FROM orders o JOIN customers c ON c.id=o.customer_id
    WHERE o.facility_id=? AND o.order_date<=? AND (o.status<>'cancelled' OR o.cancelled_at > ?) ORDER BY o.order_date`)
    .all(fid, to, `${to}T23:59:59.999Z`);
  const list = [];
  for (const o of orders) {
    const paid = paidUpTo('order', o.id, to);
    const remaining = o.price - paid;
    if (remaining > 0) list.push({ ...o, paid, remaining });
  }
  return list;
}

// المبالغ المتبقية على حجوزات قائمة (مستحقة لاحقاً — ليست نقداً)
function bookingRemainingAsOf(refType, tbl, fid, to) {
  const rows = db.prepare(`SELECT id, total FROM ${tbl} WHERE facility_id=? AND reg_date<=? AND status<>'cancelled'`).all(fid, to);
  return rows.reduce((s, b) => s + Math.max(0, b.total - paidUpTo(refType, b.id, to)), 0);
}

function fundingsAsOf(to, fid = null) {
  const rows = db.prepare(`SELECT fu.*, f.name AS facility_name, a.name AS account_name, sa.name AS source_account_name,
      u.display_name AS user_name
    FROM fundings fu JOIN facilities f ON f.id=fu.facility_id JOIN accounts a ON a.id=fu.account_id
    LEFT JOIN accounts sa ON sa.id=fu.source_account_id JOIN users u ON u.id=fu.created_by
    WHERE fu.status='active' AND fu.op_date<=? ${fid ? 'AND fu.facility_id=?' : ''} ORDER BY fu.op_date`)
    .all(...(fid ? [to, fid] : [to]));
  for (const f of rows) {
    f.repaid = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM txns WHERE ref_type='funding' AND ref_id=? AND kind='funding_repay'
      AND status='active' AND op_date<=?`).get(f.id, to).s;
    f.outstanding = f.amount - f.repaid;
    f.external = !f.source_account_id;
  }
  return rows;
}

function facilityPeriod(f, from, to) {
  const accounts = db.prepare('SELECT * FROM accounts WHERE facility_id=? ORDER BY id').all(f.id);
  for (const a of accounts) {
    a.opening = L.accountBalance(a.id, addDays(from, -1));
    a.closing = L.accountBalance(a.id, to);
    a.type_label = LABELS.accountType[a.type] || a.type;
  }
  const all = db.prepare(`${TXN_SELECT} WHERE t.facility_id=? AND t.op_date>=? AND t.op_date<=? ORDER BY t.op_date, t.id`).all(f.id, from, to);
  const active = all.filter((t) => t.status === 'active');
  const out = {
    facility: f,
    accounts: accounts.filter((a) => a.active || a.opening || a.closing),
    opening: accounts.reduce((s, a) => s + a.opening, 0),
    closing: accounts.reduce((s, a) => s + a.closing, 0),
    totals: sumKinds(all),
    ins: active.filter((t) => t.direction === 'in'),
    outs: active.filter((t) => t.direction === 'out'),
    cancelled: all.filter((t) => t.status === 'cancelled'),
    expense_by_category: groupSum(active.filter((t) => t.kind === 'expense'), 'category'),
    in_by_account: groupSum(active.filter((t) => t.direction === 'in'), 'account_name'),
    out_by_account: groupSum(active.filter((t) => t.direction === 'out'), 'account_name'),
    by_user: groupSum(active, 'user_name'),
  };
  const pt = (types) => active.filter((t) => t.kind === 'payment' && types.includes(t.pay_type)).reduce((s, t) => s + t.amount, 0);

  if (f.kind === 'hall' || f.kind === 'field') {
    const tbl = f.kind === 'hall' ? 'hall_bookings' : 'field_bookings';
    const bookings = db.prepare(`SELECT b.*, u.display_name AS user_name FROM ${tbl} b JOIN users u ON u.id=b.created_by
      WHERE b.facility_id=? AND b.reg_date>=? AND b.reg_date<=? ORDER BY b.reg_date, b.id`).all(f.id, from, to);
    for (const b of bookings) {
      b.paid = paidUpTo(f.kind, b.id, to);
      b.remaining = b.status === 'cancelled' ? 0 : Math.max(0, b.total - b.paid);
    }
    out.new_bookings = bookings;
    out.new_bookings_count = bookings.filter((b) => b.status !== 'cancelled').length;
    out.deposits = pt(['deposit', 'full']);
    out.completions = pt(['completion', 'extra']);
    out.booking_remaining = bookingRemainingAsOf(f.kind, tbl, f.id, to);
  }
  if (f.kind === 'laundry') {
    const orders = db.prepare(`SELECT o.*, c.name AS customer_name, c.tag AS customer_tag, u.display_name AS user_name
      FROM orders o JOIN customers c ON c.id=o.customer_id JOIN users u ON u.id=o.created_by
      WHERE o.facility_id=? AND o.order_date>=? AND o.order_date<=? ORDER BY o.order_date, o.id`).all(f.id, from, to);
    for (const o of orders) {
      o.paid = paidUpTo('order', o.id, to);
      o.remaining = o.status === 'cancelled' ? 0 : Math.max(0, o.price - o.paid);
    }
    const live = orders.filter((o) => o.status !== 'cancelled');
    out.new_orders = orders;
    out.new_orders_count = live.length;
    out.sales = live.reduce((s, o) => s + o.price, 0);
    out.sales_paid = live.reduce((s, o) => s + o.paid, 0);
    out.sales_unpaid = live.reduce((s, o) => s + o.remaining, 0);
    out.by_service = (() => {
      const m = new Map();
      for (const o of live) {
        const x = m.get(o.service_name) || { name: o.service_name, count: 0, amount: 0 };
        x.count += 1;
        x.amount += o.price;
        m.set(o.service_name, x);
      }
      return [...m.values()];
    })();
    out.debt_payments = active.filter((t) => t.kind === 'payment' && ['debt', 'on_pickup'].includes(t.pay_type));
    const debts = laundryDebtsAsOf(f.id, to);
    out.debtors = (() => {
      const m = new Map();
      for (const o of debts) {
        const k = o.customer_id;
        const x = m.get(k) || { name: o.customer_name + (o.customer_tag ? ` - ${o.customer_tag}` : ''), orders: [], total: 0, paid: 0, remaining: 0 };
        x.orders.push(o);
        x.total += o.price;
        x.paid += o.paid;
        x.remaining += o.remaining;
        m.set(k, x);
      }
      return [...m.values()].sort((a, b) => b.remaining - a.remaining);
    })();
    out.total_debts = debts.reduce((s, o) => s + o.remaining, 0);
  }
  return out;
}

function quickTotals(from, to) {
  const facs = db.prepare('SELECT * FROM facilities WHERE active=1 ORDER BY sort').all();
  return facs.map((f) => {
    const rows = db.prepare("SELECT * FROM txns WHERE facility_id=? AND op_date>=? AND op_date<=? AND status='active'").all(f.id, from, to);
    return { facility: f, totals: sumKinds(rows) };
  });
}

/** تقرير فترة كامل (يومي/أسبوعي/شهري/...) */
function buildPeriodReport(q = {}) {
  const period = resolvePeriod(q);
  const { from, to } = period;
  const facs = db.prepare('SELECT * FROM facilities WHERE active=1 ORDER BY sort').all()
    .filter((f) => !q.facility_id || f.id === Number(q.facility_id));
  const sections = facs.map((f) => facilityPeriod(f, from, to));

  const fundings = fundingsAsOf(to, q.facility_id ? Number(q.facility_id) : null);
  const sum = (fn) => sections.reduce((s, x) => s + fn(x), 0);
  const summary = {
    tin: sum((s) => s.totals.tin),
    tout: sum((s) => s.totals.tout),
    revenue: sum((s) => s.totals.revenue),
    refunds: sum((s) => s.totals.refunds),
    expenses: sum((s) => s.totals.expenses),
    funding_in: sum((s) => s.totals.funding_in),
    funding_repay: sum((s) => s.totals.funding_repay),
    opening: sum((s) => s.opening),
    balances: sum((s) => s.closing),
    receivables: sum((s) => s.total_debts || 0),
    booking_remaining: sum((s) => s.booking_remaining || 0),
    funding_external: fundings.filter((f) => f.external).reduce((s, f) => s + f.outstanding, 0),
    funding_internal: fundings.filter((f) => !f.external).reduce((s, f) => s + f.outstanding, 0),
  };
  summary.net = summary.tin - summary.tout;
  summary.commercial_net = summary.revenue - summary.refunds - summary.expenses;
  // صافي الأصول النقدية بعد الالتزامات = النقد + ديون الزبائن − التمويل الخارجي غير المسدد
  // (التمويل من الحساب الاحتياطي داخلي: النقد انتقل بين حسابات النظام فلا يُطرح مرتين)
  // عند عرض منشأة واحدة: التمويل من الاحتياطي التزام عليها أيضاً
  summary.liabilities = summary.funding_external + (q.facility_id ? summary.funding_internal : 0);
  summary.net_assets = summary.balances + summary.receivables - summary.liabilities;

  // تفاصيل كل يوم (للتقارير متعددة الأيام)
  let days = null;
  const span = daysBetween(from, to);
  if (span >= 1 && span <= 62) {
    days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const per = quickTotals(d, d).filter((x) => !q.facility_id || x.facility.id === Number(q.facility_id));
      days.push({
        date: d,
        per: per.map((x) => ({ name: x.facility.name, tin: x.totals.tin, tout: x.totals.tout })),
        tin: per.reduce((s, x) => s + x.totals.tin, 0),
        tout: per.reduce((s, x) => s + x.totals.tout, 0),
      });
    }
  }

  // ملخص تراكمي للشهر والسنة حتى نهاية الفترة
  const cumulative = {
    month: { from: `${to.slice(0, 7)}-01`, to, rows: quickTotals(`${to.slice(0, 7)}-01`, to) },
    year: { from: `${to.slice(0, 4)}-01-01`, to, rows: quickTotals(`${to.slice(0, 4)}-01-01`, to) },
  };
  for (const c of Object.values(cumulative)) {
    if (q.facility_id) c.rows = c.rows.filter((x) => x.facility.id === Number(q.facility_id));
    c.total = sumKinds([]);
    for (const r of c.rows) for (const k of Object.keys(c.total)) c.total[k] += r.totals[k];
  }

  return {
    type: 'period', ...period, sections, summary, fundings, days, cumulative,
    generated_at: new Date().toISOString(), today: today(),
    days_to_year_end: daysBetween(today(), `${today().slice(0, 4)}-12-31`),
  };
}

/** كشف حساب شامل: كل المنشآت / منشأة / حساب / موظف + فترة */
function buildStatement(q = {}) {
  const period = q.preset ? resolvePeriod(q) : resolvePeriod({ preset: 'all' });
  const { from, to } = period;
  let accounts;
  let scopeTitle = 'جميع المنشآت';
  if (q.account_id) {
    accounts = db.prepare(`SELECT a.*, f.name AS facility_name FROM accounts a JOIN facilities f ON f.id=a.facility_id WHERE a.id=?`).all(Number(q.account_id));
    if (!accounts.length) throw bad('الحساب غير موجود');
    scopeTitle = `حساب: ${accounts[0].name} (${accounts[0].facility_name})`;
  } else if (q.facility_id) {
    accounts = db.prepare(`SELECT a.*, f.name AS facility_name FROM accounts a JOIN facilities f ON f.id=a.facility_id WHERE a.facility_id=? ORDER BY a.id`)
      .all(Number(q.facility_id));
    const f = L.getFacility(Number(q.facility_id));
    scopeTitle = `منشأة: ${f.name}`;
  } else {
    accounts = db.prepare(`SELECT a.*, f.name AS facility_name FROM accounts a JOIN facilities f ON f.id=a.facility_id ORDER BY f.sort, a.id`).all();
  }
  let userName = null;
  if (q.user_id) {
    const u = db.prepare('SELECT display_name FROM users WHERE id=?').get(Number(q.user_id));
    if (!u) throw bad('الموظف غير موجود');
    userName = u.display_name;
    scopeTitle += ` — الموظف: ${userName}`;
  }
  for (const a of accounts) {
    a.opening = L.accountBalance(a.id, addDays(from, -1));
    a.closing = L.accountBalance(a.id, to);
    a.type_label = LABELS.accountType[a.type] || a.type;
  }
  const ids = accounts.map((a) => a.id);
  const rows = ids.length ? db.prepare(`${TXN_SELECT} WHERE t.account_id IN (${ids.map(() => '?').join(',')})
      AND t.op_date>=? AND t.op_date<=? ${q.user_id ? 'AND t.user_id=?' : ''} ORDER BY t.op_date, t.id`)
    .all(...ids, from, to, ...(q.user_id ? [Number(q.user_id)] : [])) : [];
  const opening = accounts.reduce((s, a) => s + a.opening, 0);
  let run = opening;
  for (const t of rows) {
    if (t.status === 'active') run += t.direction === 'in' ? t.amount : -t.amount;
    t.running = q.user_id ? null : run;
  }
  const totals = sumKinds(rows);
  const facIds = [...new Set(accounts.map((a) => a.facility_id))];
  const lf = db.prepare("SELECT id FROM facilities WHERE kind='laundry' LIMIT 1").get();
  const debts = lf && facIds.includes(lf.id) && !q.account_id ? laundryDebtsAsOf(lf.id, to) : [];
  const fundings = fundingsAsOf(to).filter((f) => q.account_id
    ? f.account_id === Number(q.account_id) || f.source_account_id === Number(q.account_id)
    : facIds.includes(f.facility_id));
  const bookingRemaining = q.account_id ? 0 : facIds.reduce((s, fid) => {
    const f = L.getFacility(fid);
    if (f.kind === 'hall') return s + bookingRemainingAsOf('hall', 'hall_bookings', fid, to);
    if (f.kind === 'field') return s + bookingRemainingAsOf('field', 'field_bookings', fid, to);
    return s;
  }, 0);
  const closing = accounts.reduce((s, a) => s + a.closing, 0);
  const receivables = debts.reduce((s, o) => s + o.remaining, 0);
  const fundingExternal = fundings.filter((f) => f.external).reduce((s, f) => s + f.outstanding, 0);
  const fundingInternal = fundings.filter((f) => !f.external).reduce((s, f) => s + f.outstanding, 0);
  const liabilities = fundingExternal + (q.facility_id || q.account_id ? fundingInternal : 0);
  return {
    type: 'statement', ...period, title: `كشف حساب شامل — ${scopeTitle}`, scope_title: scopeTitle, user_filter: userName,
    accounts, rows, opening, totals, closing,
    expense_by_category: groupSum(rows.filter((t) => t.kind === 'expense'), 'category'),
    by_user: groupSum(rows, 'user_name'),
    debts, receivables, fundings, funding_external: fundingExternal, funding_internal: fundingInternal, liabilities,
    booking_remaining: bookingRemaining,
    net_assets: closing + receivables - liabilities,
    generated_at: new Date().toISOString(), today: today(),
  };
}

module.exports = { resolvePeriod, buildPeriodReport, buildStatement, firstDate };
