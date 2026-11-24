'use strict';
const fs = require('fs');
const path = require('path');
const { fmt, LABELS, getSetting } = require('../util');

let fontCss = null;
function fonts() {
  if (fontCss) return fontCss;
  const dir = path.join(path.dirname(require.resolve('@fontsource/cairo/package.json')), 'files');
  const face = (w) => {
    const parts = ['arabic', 'latin'].map((sub) => {
      const f = path.join(dir, `cairo-${sub}-${w}-normal.woff2`);
      return fs.existsSync(f) ? `url(data:font/woff2;base64,${fs.readFileSync(f).toString('base64')}) format('woff2')` : null;
    }).filter(Boolean);
    return parts.map((src) => `@font-face{font-family:'Cairo';font-weight:${w};src:${src};}`).join('\n');
  };
  fontCss = face(400) + face(700);
  return fontCss;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cur = () => getSetting('currency') || '';
const money = (m, cls = '') => `<span class="num ${cls}">${fmt(m)}</span>`;
const dt = (iso) => {
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: getSetting('timezone') || 'UTC', hour12: false }).replace(',', '');
  } catch { return iso; }
};

function table(headers, rows, { empty = 'لا توجد بيانات', foot = null } = {}) {
  if (!rows.length) return `<p class="empty">${empty}</p>`;
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${/^\d{4}-\d{2}-\d{2}$/.test(String(c)) ? `<span class="nw">${c}</span>` : c}</td>`).join('')}</tr>`).join('')}</tbody>
    ${foot ? `<tfoot><tr>${foot.map((c) => `<td>${c}</td>`).join('')}</tr></tfoot>` : ''}</table>`;
}

const kpi = (label, value, cls = '') => `<div class="kpi ${cls}"><div class="l">${label}</div><div class="v">${value}</div></div>`;

function txnLabel(t) {
  if (t.pay_type) return LABELS.payType[t.pay_type];
  return LABELS.kind[t.kind] || t.kind;
}

function insTable(rows) {
  return table(['الرقم', 'التاريخ', 'النوع', 'المصدر / الزبون', 'المرجع', 'الحساب المستلم', 'الموظف', 'المبلغ', 'ملاحظات'],
    rows.map((t) => [esc(t.no), t.op_date, esc(txnLabel(t)) + (t.category && t.kind === 'income' ? ` — ${esc(t.category)}` : ''),
      esc(t.party), esc(t.ref_no || ''), esc(t.account_name), esc(t.user_name), money(t.amount, 'in'), esc(t.notes || '')]),
    { empty: 'لا توجد مبالغ داخلة', foot: ['', '', '', '', '', '', 'الإجمالي', money(rows.reduce((s, t) => s + t.amount, 0), 'in'), ''] });
}

function outsTable(rows) {
  return table(['الرقم', 'التاريخ', 'النوع / التصنيف', 'الجهة المستلمة', 'المرجع', 'الحساب المصروف منه', 'الموظف', 'المبلغ', 'ملاحظات'],
    rows.map((t) => [esc(t.no), t.op_date, esc(LABELS.kind[t.kind]) + (t.category ? ` — ${esc(t.category)}` : ''),
      esc(t.party), esc(t.ref_no || ''), esc(t.account_name), esc(t.user_name), money(t.amount, 'out'),
      esc([t.notes, t.extra].filter(Boolean).join(' | '))]),
    { empty: 'لا توجد مبالغ خارجة', foot: ['', '', '', '', '', '', 'الإجمالي', money(rows.reduce((s, t) => s + t.amount, 0), 'out'), ''] });
}

function cancelledTable(rows) {
  if (!rows.length) return '';
  return `<h4>عمليات ملغاة (لا تدخل في الحساب)</h4>` + table(['الرقم', 'التاريخ', 'النوع', 'المبلغ', 'سجلها', 'ألغاها', 'السبب'],
    rows.map((t) => [esc(t.no), t.op_date, esc(txnLabel(t)), `<s>${fmt(t.amount)}</s>`, esc(t.user_name), esc(t.cancelled_by_name || ''), esc(t.cancel_reason || '')]));
}

function accountsTable(accounts) {
  return table(['الحساب / مكان المال', 'النوع', 'الهاتف', 'رصيد بداية الفترة', 'الرصيد في نهاية الفترة'],
    accounts.map((a) => [esc(a.name) + (a.active ? '' : ' (معطل)'), esc(a.type_label), esc(a.phone || ''), money(a.opening), money(a.closing, 'bal')]),
    { foot: ['الإجمالي', '', '', money(accounts.reduce((s, a) => s + a.opening, 0)), money(accounts.reduce((s, a) => s + a.closing, 0), 'bal')] });
}

const sumList = (title, list) => list.length
  ? `<div class="mini"><h4>${title}</h4>${table(['البند', 'المبلغ'], list.map((x) => [esc(x.name), money(x.amount)]))}</div>` : '';

function facilitySection(s) {
  const f = s.facility;
  let h = `<section class="fac"><h2>${esc(f.name)} <small>(${esc(f.prefix)})</small></h2>
    <div class="kpis">
      ${kpi('رصيد بداية الفترة', money(s.opening))}
      ${kpi('إجمالي الداخل', money(s.totals.tin, 'in'), 'in')}
      ${kpi('إجمالي الخارج', money(s.totals.tout, 'out'), 'out')}
      ${kpi('الرصيد المتبقي', money(s.closing, 'bal'), 'bal')}
    </div>
    <div class="kpis small">
      ${kpi('إيرادات تجارية', money(s.totals.revenue))}
      ${kpi('مصروفات', money(s.totals.expenses))}
      ${kpi('مرتجعات', money(s.totals.refunds))}
      ${kpi('تمويل وارد', money(s.totals.funding_in))}
      ${kpi('سداد تمويل', money(s.totals.funding_repay))}
    </div>`;

  if (f.kind === 'hall' || f.kind === 'field') {
    const isHall = f.kind === 'hall';
    h += `<h3>الحجوزات الجديدة المسجلة في الفترة: ${s.new_bookings_count}</h3>`;
    h += table(isHall
      ? ['الرقم', 'تاريخ التسجيل', 'صاحب الحجز', 'تاريخ الفرح', 'الفترة', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة', 'سجله']
      : ['الرقم', 'تاريخ التسجيل', 'الاسم', 'تاريخ اللعب', 'الوقت', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة', 'سجله'],
    s.new_bookings.map((b) => [esc(b.no), b.reg_date, esc(b.customer_name),
      isHall ? b.event_date : b.play_date,
      isHall ? LABELS.period[b.period] : `${b.start_time} - ${b.end_time}`,
      money(b.total), money(b.paid, 'in'), money(b.remaining, 'debt'), LABELS.bookingStatus[b.status], esc(b.user_name)]),
    { empty: 'لا توجد حجوزات جديدة' });
    h += `<div class="kpis small">${kpi('العربون المحصل', money(s.deposits, 'in'))}${kpi('دفعات التكملة والإضافية', money(s.completions, 'in'))}
      ${kpi('متبقٍ على الحجوزات (مستحق لاحقاً — ليس نقداً)', money(s.booking_remaining, 'debt'))}</div>`;
  }
  if (f.kind === 'laundry') {
    h += `<h3>الطلبات الجديدة: ${s.new_orders_count}</h3>
      <div class="kpis small">${kpi('إجمالي المبيعات', money(s.sales))}${kpi('المدفوع منها', money(s.sales_paid, 'in'))}
      ${kpi('غير المدفوع منها', money(s.sales_unpaid, 'debt'))}${kpi('إجمالي الديون على الزبائن', money(s.total_debts, 'debt'))}</div>`;
    if (s.by_service.length) h += table(['الخدمة', 'العدد', 'القيمة'], s.by_service.map((x) => [esc(x.name), x.count, money(x.amount)]));
    h += table(['الرقم', 'التاريخ', 'الخدمة', 'الزبون', 'السعر', 'المدفوع', 'المتبقي', 'الحالة', 'سجله'],
      s.new_orders.map((o) => [esc(o.no), o.order_date, esc(o.service_name), esc(o.customer_name + (o.customer_tag ? ` - ${o.customer_tag}` : '')),
        money(o.price), money(o.paid, 'in'), money(o.remaining, 'debt'), LABELS.orderStatus[o.status], esc(o.user_name)]),
      { empty: 'لا توجد طلبات جديدة' });
    h += `<h4>دفعات الديون المسددة في الفترة</h4>` + table(['الرقم', 'التاريخ', 'الزبون', 'الطلب', 'المبلغ', 'الحساب', 'الموظف'],
      s.debt_payments.map((t) => [esc(t.no), t.op_date, esc(t.party), esc(t.ref_no), money(t.amount, 'in'), esc(t.account_name), esc(t.user_name)]),
      { empty: 'لا توجد دفعات ديون' });
    h += `<h4>الزبائن المديونون (حتى نهاية الفترة)</h4>` + table(['الزبون', 'عدد الطلبات', 'الإجمالي', 'المدفوع', 'المتبقي عليه'],
      s.debtors.map((c) => [esc(c.name), c.orders.length, money(c.total), money(c.paid, 'in'), money(c.remaining, 'debt')]),
      { empty: 'لا توجد ديون', foot: ['الإجمالي', '', '', '', money(s.total_debts, 'debt')] });
  }

  h += `<h3>تفاصيل المبالغ الداخلة</h3>${insTable(s.ins)}`;
  h += `<h3>تفاصيل المبالغ الخارجة والمصروفات</h3>${outsTable(s.outs)}`;
  h += `<div class="grid3">${sumList('المصروفات حسب التصنيف', s.expense_by_category)}${sumList('الحسابات التي استقبلت الأموال', s.in_by_account)}${sumList('الحسابات التي خرجت منها الأموال', s.out_by_account)}</div>`;
  h += `<h3>أين يوجد المال (الحسابات)</h3>${accountsTable(s.accounts)}`;
  h += cancelledTable(s.cancelled);
  return h + '</section>';
}

function fundingTable(fundings) {
  return table(['الرقم', 'التاريخ', 'لصالح', 'الحساب المستلم', 'الجهة / المصدر', 'النوع', 'المبلغ', 'المسدد', 'المتبقي', 'ملاحظات'],
    fundings.map((f) => [esc(f.no), f.op_date, esc(f.facility_name), esc(f.account_name), esc(f.source_account_name || f.party),
      f.external ? 'خارجي' : 'من الاحتياطي', money(f.amount), money(f.repaid, 'in'), money(f.outstanding, 'debt'), esc(f.notes || '')]),
    { empty: 'لا يوجد تمويل قائم' });
}

function liabilitiesBlock(x) {
  return `<div class="kpis">
    ${kpi('الأرصدة النقدية الحالية', money(x.balances, 'bal'), 'bal')}
    ${kpi('ديون الزبائن المستحقة (+)', money(x.receivables, 'debt'), 'debt')}
    ${kpi('تمويل خارجي غير مسدد (−)', money(x.funding_external, 'out'), 'out')}
    ${kpi('صافي الأصول بعد الالتزامات', money(x.net_assets, 'bal'), 'bal')}
  </div>
  <p class="note">صافي الأصول = النقد الموجود فعلياً + ديون الزبائن − التمويل الخارجي غير المسدد${x.liabilities > x.funding_external ? ' − التمويل من الاحتياطي' : ''}.
  ديون الزبائن ليست أموالاً موجودة في الخزنة. المتبقي على الحجوزات (${fmt(x.booking_remaining)}) يُعرض للعلم ولا يدخل في الصافي.
  ${x.funding_internal ? `التمويل من الحساب الاحتياطي القائم: ${fmt(x.funding_internal)}.` : ''}</p>`;
}

function cumulativeBlock(c, label) {
  return `<div class="mini"><h4>${label} (${c.from} — ${c.to})</h4>` + table(['المنشأة', 'داخل', 'خارج', 'إيرادات', 'مصروفات'],
    c.rows.map((r) => [esc(r.facility.name), money(r.totals.tin, 'in'), money(r.totals.tout, 'out'), money(r.totals.revenue), money(r.totals.expenses)]),
    { foot: ['الإجمالي', money(c.total.tin, 'in'), money(c.total.tout, 'out'), money(c.total.revenue), money(c.total.expenses)] }) + '</div>';
}

function periodBody(R) {
  const S = R.summary;
  let h = `<section><h2>التقرير الإجمالي</h2>` + table(['المنشأة', 'رصيد البداية', 'إجمالي الداخل', 'إجمالي الخارج', 'صافي الحركة', 'المتبقي في الخزنة'],
    R.sections.map((s) => [esc(s.facility.name), money(s.opening), money(s.totals.tin, 'in'), money(s.totals.tout, 'out'), money(s.totals.net), money(s.closing, 'bal')]),
    { foot: ['الإجمالي', money(S.opening), money(S.tin, 'in'), money(S.tout, 'out'), money(S.net), money(S.balances, 'bal')] });
  h += `<div class="kpis small">
      ${kpi('إيرادات تجارية', money(S.revenue, 'in'))}${kpi('مرتجعات', money(S.refunds, 'out'))}${kpi('مصروفات', money(S.expenses, 'out'))}
      ${kpi('الصافي التجاري', money(S.commercial_net))}${kpi('تمويل وارد', money(S.funding_in))}${kpi('سداد تمويل', money(S.funding_repay))}
    </div>`;
  h += liabilitiesBlock(S);
  h += `<div class="grid2">${cumulativeBlock(R.cumulative.month, 'تراكمي الشهر')}${cumulativeBlock(R.cumulative.year, 'تراكمي السنة')}</div></section>`;
  if (R.days && R.days.length > 1) {
    const names = R.days[0].per.map((p) => p.name);
    h += `<section><h2>تفاصيل كل يوم</h2>` + table(['التاريخ', ...names.map((n) => `${esc(n)}<br>داخل / خارج`), 'إجمالي الداخل', 'إجمالي الخارج', 'الصافي'],
      R.days.map((d) => [d.date, ...d.per.map((p) => `${money(p.tin, 'in')} / ${money(p.tout, 'out')}`), money(d.tin, 'in'), money(d.tout, 'out'), money(d.tin - d.tout)])) + '</section>';
  }
  h += R.sections.map(facilitySection).join('');
  h += `<section><h2>التمويل والديون الخارجية</h2>${fundingTable(R.fundings)}</section>`;
  return h;
}

function statementBody(R) {
  let h = `<section><div class="kpis">
    ${kpi('1. الرصيد الافتتاحي', money(R.opening))}
    ${kpi('2. إجمالي ما تم جمعه', money(R.totals.tin, 'in'), 'in')}
    ${kpi('3. إجمالي ما تم صرفه', money(R.totals.tout, 'out'), 'out')}
    ${kpi('4. الرصيد المتبقي', money(R.closing, 'bal'), 'bal')}
  </div>
  ${R.user_filter ? `<p class="note">الكشف مفلتر على عمليات الموظف "${esc(R.user_filter)}" فقط؛ الأرصدة تمثل الحسابات كاملة.</p>` : ''}
  <div class="kpis small">${kpi('إيرادات تجارية', money(R.totals.revenue))}${kpi('مصروفات', money(R.totals.expenses))}${kpi('مرتجعات', money(R.totals.refunds))}
  ${kpi('تمويل وارد', money(R.totals.funding_in))}${kpi('سداد تمويل', money(R.totals.funding_repay))}</div></section>`;
  h += `<section><h2>5-6. مكان وجود الأموال وأسماء الحسابات</h2>` + table(['الحساب', 'المنشأة', 'النوع', 'الهاتف', 'ملاحظات', 'رصيد البداية', 'الرصيد الحالي'],
    R.accounts.map((a) => [esc(a.name), esc(a.facility_name), esc(a.type_label), esc(a.phone || ''), esc(a.notes || ''), money(a.opening), money(a.closing, 'bal')]),
    { foot: ['الإجمالي', '', '', '', '', money(R.opening), money(R.closing, 'bal')] }) + '</section>';
  h += `<section><h2>7-8. جميع الإيداعات والمصروفات مرتبة حسب التاريخ</h2>` + table(
    ['الرقم', 'التاريخ', 'المنشأة', 'النوع', 'من / إلى', 'المرجع', 'الحساب', 'داخل', 'خارج', R.user_filter ? '' : 'الرصيد', 'الموظف', 'ملاحظات'],
    R.rows.map((t) => {
      const c = t.status === 'cancelled';
      const w = (x) => (c ? `<s>${x}</s>` : x);
      return [esc(t.no), t.op_date, esc(t.facility_name), esc(txnLabel(t)) + (t.category && t.kind !== 'payment' ? ` — ${esc(t.category)}` : '') + (c ? ' <b class="out">(ملغاة)</b>' : ''),
        esc(t.party || ''), esc(t.ref_no || ''), esc(t.account_name),
        t.direction === 'in' ? w(money(t.amount, 'in')) : '', t.direction === 'out' ? w(money(t.amount, 'out')) : '',
        t.running === null ? '' : money(t.running, 'bal'), esc(t.user_name),
        esc([t.notes, t.extra, c ? `سبب الإلغاء: ${t.cancel_reason}` : ''].filter(Boolean).join(' | '))];
    }), { empty: 'لا توجد عمليات في الفترة' }) + '</section>';
  h += `<section><h2>9. الموظفون المسؤولون</h2><div class="grid2">${sumList('حجم العمليات حسب الموظف', R.by_user)}${sumList('المصروفات حسب التصنيف', R.expense_by_category)}</div></section>`;
  h += `<section><h2>10. الديون والالتزامات</h2>`;
  if (R.debts.length) {
    h += `<h4>ديون الزبائن (مستحقة للمنشأة)</h4>` + table(['الطلب', 'التاريخ', 'الزبون', 'الخدمة', 'السعر', 'المدفوع', 'المتبقي'],
      R.debts.map((o) => [esc(o.no), o.order_date, esc(o.customer_name + (o.customer_tag ? ` - ${o.customer_tag}` : '')), esc(o.service_name),
        money(o.price), money(o.paid, 'in'), money(o.remaining, 'debt')]), { foot: ['الإجمالي', '', '', '', '', '', money(R.receivables, 'debt')] });
  }
  h += liabilitiesBlock({ balances: R.closing, receivables: R.receivables, funding_external: R.funding_external, funding_internal: R.funding_internal,
    liabilities: R.liabilities, net_assets: R.net_assets, booking_remaining: R.booking_remaining });
  h += `</section><section><h2>11. تفاصيل التمويل الخارجي</h2>${fundingTable(R.fundings)}</section>`;
  return h;
}

function renderReport(R) {
  const body = R.type === 'statement' ? statementBody(R) : periodBody(R);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(R.title)}</title>
<style>${fonts()}
*{box-sizing:border-box}
body{font-family:'Cairo',sans-serif;margin:0;padding:16px;color:#1d2430;background:#fff;font-size:11.5px;line-height:1.5}
header.top{border-bottom:3px solid #1f4e79;padding-bottom:8px;margin-bottom:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
header.top h1{margin:0;font-size:19px;color:#1f4e79}
header.top .meta{font-size:11px;color:#555}
h2{font-size:15px;background:#1f4e79;color:#fff;padding:5px 10px;border-radius:4px;margin:18px 0 8px}
h2 small{font-weight:400;opacity:.8}
h3{font-size:13px;color:#1f4e79;border-bottom:1px solid #cdd8e4;margin:14px 0 6px;padding-bottom:2px}
h4{font-size:12px;margin:10px 0 4px;color:#333}
section{margin-bottom:10px}
section.fac{page-break-before:always}
table{width:100%;border-collapse:collapse;margin:4px 0 8px;font-size:10.5px}
th{background:#eef3f8;color:#1f4e79;font-weight:700;border:1px solid #cdd8e4;padding:4px 5px;text-align:right}
td{border:1px solid #dde3ea;padding:3px 5px;vertical-align:top}
tbody tr:nth-child(even) td{background:#fafbfd}
tfoot td{font-weight:700;background:#f2f5f8}
.nw{white-space:nowrap}
.num{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:700}
.in{color:#127a3a}.out{color:#b42318}.debt{color:#b45309}.bal{color:#1f4e79}
.kpis{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.kpi{flex:1 1 120px;border:1px solid #cdd8e4;border-radius:6px;padding:6px 8px;background:#f8fafc}
.kpi .l{font-size:10px;color:#555}.kpi .v{font-size:15px}
.kpis.small .kpi .v{font-size:12.5px}
.kpi.in{border-color:#9fd6b2}.kpi.out{border-color:#f1aaa3}.kpi.bal{border-color:#9db8d6}.kpi.debt{border-color:#f3c98b}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media (max-width:700px){.grid2,.grid3{grid-template-columns:1fr}}
.note{font-size:10.5px;color:#555;background:#fffbea;border:1px solid #f3e3a1;padding:5px 8px;border-radius:4px}
.empty{color:#888;font-style:italic;margin:4px 0}
footer{margin-top:16px;font-size:10px;color:#777;border-top:1px solid #ddd;padding-top:6px}
@page{size:A4;margin:10mm}
@media print{body{padding:0}}
</style></head><body>
<header class="top"><div><h1>${esc(R.title)}</h1>
<div class="meta">الفترة: ${R.from} — ${R.to} · العملة: ${esc(cur())}</div></div>
<div class="meta">تاريخ اليوم: ${R.today}${R.days_to_year_end !== undefined ? ` · متبقٍ لنهاية السنة: ${R.days_to_year_end} يوم` : ''}<br>
أُنشئ في: ${dt(R.generated_at)}</div></header>
${body}
<footer>نظام إدارة الصالة والمغسلة والملعب — جميع المبالغ بالعملة (${esc(cur())}). العمليات الملغاة محفوظة في السجل ولا تدخل في الأرصدة.</footer>
</body></html>`;
}

module.exports = { renderReport };
