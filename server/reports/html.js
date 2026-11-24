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

// ============ 1) الرصيد: اللي انجمع — اللي طلع — اللي ضل (وبس) ============
function balanceBlock(tin, tout, closing, opening) {
  return `<section><h2>الرصيد</h2><div class="kpis big">
    ${kpi('إجمالي اللي انجمع', money(tin, 'in'), 'in')}
    ${kpi('إجمالي اللي طلع', money(tout, 'out'), 'out')}
    ${kpi('اللي ضل', money(closing, 'bal'), 'bal')}
  </div>${opening ? `<p class="note">اللي ضل يشمل رصيداً سابقاً من قبل هذه الفترة بقيمة ${fmt(opening)}.</p>` : ''}</section>`;
}

// ============ 2) وين المصاري: حسب طريقة الدفع ============
function methodBlock(methods, accounts) {
  let h = `<section><h2>وين وصلت المصاري</h2>` + table(['الطريقة', 'انجمع', 'طلع', 'ضل'],
    methods.map((m) => [`<b>${esc(m.label)}</b>`, money(m.tin, 'in'), money(m.tout, 'out'), money(m.closing, 'bal')]),
    { foot: ['الإجمالي', money(methods.reduce((s, m) => s + m.tin, 0), 'in'), money(methods.reduce((s, m) => s + m.tout, 0), 'out'),
      money(methods.reduce((s, m) => s + m.closing, 0), 'bal')] });
  // إذا كان أكثر من حساب لنفس الطريقة (مثلاً كاش في الخزنة وكاش مع موظف) نوضح كل حساب
  const shown = accounts.filter((a) => a.active || a.closing || a.tin || a.tout);
  if (shown.length > methods.length) {
    h += `<h4>تفصيل الحسابات</h4>` + table(['الحساب', 'النوع', 'انجمع', 'طلع', 'ضل'],
      shown.map((a) => [esc(a.name) + (a.phone ? ` <small>(${esc(a.phone)})</small>` : ''), esc(a.type_label), money(a.tin || 0, 'in'), money(a.tout || 0, 'out'), money(a.closing, 'bal')]));
  }
  return h + '</section>';
}

const eventHead = { hall: 'تاريخ الفرح', field: 'موعد اللعب', laundry: 'الخدمة' };

function insTable(rows, kind) {
  return table(['الرقم', 'نوع المعاملة', 'الاسم / المصدر', 'تاريخ الدفع', 'تاريخ الحجز', eventHead[kind] || 'التفاصيل', 'وين وصلت', 'الموظف', 'المبلغ'],
    rows.map((t) => [esc(t.no), esc(txnLabel(t)) + (t.kind === 'income' && t.category ? ` — ${esc(t.category)}` : ''), esc(t.party),
      t.op_date, t.booking_date || '', esc(t.event || t.notes || ''), esc(t.account_name), esc(t.user_name), money(t.amount, 'in')]),
    { empty: 'ما انجمع شيء في هذه الفترة', foot: ['', '', '', '', '', '', '', 'الإجمالي', money(rows.reduce((s, t) => s + t.amount, 0), 'in')] });
}

function outsTable(rows) {
  return table(['الرقم', 'النوع', 'التصنيف', 'لمين', 'التاريخ', 'من وين طلعت', 'الموظف', 'المبلغ', 'ملاحظات'],
    rows.map((t) => [esc(t.no), esc(LABELS.kind[t.kind]), esc(t.category || ''), esc(t.party), t.op_date, esc(t.account_name), esc(t.user_name),
      money(t.amount, 'out'), esc([t.notes, t.extra].filter(Boolean).join(' | '))]),
    { empty: 'ما طلع شيء في هذه الفترة', foot: ['', '', '', '', '', '', 'الإجمالي', money(rows.reduce((s, t) => s + t.amount, 0), 'out'), ''] });
}

function cancelledTable(rows) {
  if (!rows.length) return '';
  return `<h3>عمليات ملغاة (لا تدخل في الحساب)</h3>` + table(['الرقم', 'التاريخ', 'النوع', 'المبلغ', 'سجلها', 'ألغاها', 'السبب'],
    rows.map((t) => [esc(t.no), t.op_date, esc(txnLabel(t)), `<s>${fmt(t.amount)}</s>`, esc(t.user_name), esc(t.cancelled_by_name || ''), esc(t.cancel_reason || '')]));
}

const sumList = (title, list) => (list.length
  ? `<div class="mini"><h4>${title}</h4>${table(['البند', 'المبلغ'], list.map((x) => [esc(x.name), money(x.amount)]))}</div>` : '');

// ============ 3) التوضيح ============
function facilityDetails(s) {
  const f = s.facility;
  let h = `<section class="details"><h2>التوضيح</h2>`;
  h += `<h3>المبالغ اللي انجمعت</h3>${insTable(s.ins, f.kind)}`;
  h += `<h3>المبالغ اللي طلعت</h3>${outsTable(s.outs)}`;
  if (s.expense_by_category.length) h += sumList('المصروفات حسب التصنيف', s.expense_by_category);

  if (f.kind === 'hall' || f.kind === 'field') {
    const isHall = f.kind === 'hall';
    h += `<h3>الحجوزات الجديدة المسجلة في الفترة: ${s.new_bookings_count}</h3>`;
    h += table(['الرقم', 'تاريخ الحجز', 'الاسم', isHall ? 'تاريخ الفرح' : 'موعد اللعب', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة', 'سجله'],
      s.new_bookings.map((b) => [esc(b.no), b.reg_date, esc(b.customer_name),
        isHall ? `${b.event_date} (${LABELS.period[b.period]})` : `${b.play_date} ${b.start_time}-${b.end_time}`,
        money(b.total), money(b.paid, 'in'), money(b.remaining, 'debt'), LABELS.bookingStatus[b.status], esc(b.user_name)]),
      { empty: 'لا توجد حجوزات جديدة' });
    h += `<p class="note">متبقٍ على الحجوزات القائمة (يُدفع لاحقاً — ليس في الصندوق): <b>${fmt(s.booking_remaining)}</b></p>`;
  }
  if (f.kind === 'laundry') {
    h += `<h3>الطلبات الجديدة: ${s.new_orders_count} — المبيعات ${fmt(s.sales)} (مدفوع ${fmt(s.sales_paid)} / غير مدفوع ${fmt(s.sales_unpaid)})</h3>`;
    h += table(['الرقم', 'التاريخ', 'الخدمة', 'الزبون', 'السعر', 'المدفوع', 'المتبقي', 'الحالة', 'سجله'],
      s.new_orders.map((o) => [esc(o.no), o.order_date, esc(o.service_name), esc(o.customer_name + (o.customer_tag ? ` - ${o.customer_tag}` : '')),
        money(o.price), money(o.paid, 'in'), money(o.remaining, 'debt'), LABELS.orderStatus[o.status], esc(o.user_name)]),
      { empty: 'لا توجد طلبات جديدة' });
    h += `<h3>الديون على الزبائن (ليست في الصندوق)</h3>` + table(['الزبون', 'عدد الطلبات', 'الإجمالي', 'دفع', 'المتبقي عليه'],
      s.debtors.map((c) => [esc(c.name), c.orders.length, money(c.total), money(c.paid, 'in'), money(c.remaining, 'debt')]),
      { empty: 'لا توجد ديون', foot: ['الإجمالي', '', '', '', money(s.total_debts, 'debt')] });
  }
  h += cancelledTable(s.cancelled);
  return h + '</section>';
}

function fundingTable(fundings) {
  return table(['الرقم', 'التاريخ', 'لصالح', 'وين وصل', 'المصدر / الجهة', 'النوع', 'المبلغ', 'المسدد', 'المتبقي'],
    fundings.map((f) => [esc(f.no), f.op_date, esc(f.facility_name), esc(f.account_name), esc(f.source_account_name || f.party),
      f.external ? 'خارجي' : 'من الاحتياطي', money(f.amount), money(f.repaid, 'in'), money(f.outstanding, 'debt')]),
    { empty: 'لا يوجد تمويل قائم' });
}

// ============ كشف منشأة واحدة (ملف مستقل تماماً) ============
function facilityDoc(R, s) {
  return balanceBlock(s.totals.tin, s.totals.tout, s.closing, s.opening)
    + methodBlock(s.by_method, s.accounts)
    + facilityDetails(s)
    + (R.fundings.some((f) => f.facility_id === s.facility.id) ? `<section><h2>التمويل لصالح المنشأة</h2>${fundingTable(R.fundings.filter((f) => f.facility_id === s.facility.id))}</section>` : '');
}

// ============ الملخص الإجمالي (ملف مستقل) ============
function summaryDoc(R) {
  const S = R.summary;
  const methods = new Map();
  for (const s of R.sections) {
    for (const m of s.by_method) {
      const x = methods.get(m.method) || { label: m.label, tin: 0, tout: 0, closing: 0 };
      x.tin += m.tin; x.tout += m.tout; x.closing += m.closing;
      methods.set(m.method, x);
    }
  }
  let h = balanceBlock(S.tin, S.tout, S.balances, S.opening);
  h += `<section><h2>كل منشأة لحالها</h2>` + table(['المنشأة', 'انجمع', 'طلع', 'ضل'],
    R.sections.map((s) => [`<b>${esc(s.facility.name)}</b>`, money(s.totals.tin, 'in'), money(s.totals.tout, 'out'), money(s.closing, 'bal')]),
    { foot: ['الإجمالي', money(S.tin, 'in'), money(S.tout, 'out'), money(S.balances, 'bal')] }) + '</section>';
  h += `<section><h2>وين وصلت المصاري (كل المنشآت)</h2>` + table(['الطريقة', 'انجمع', 'طلع', 'ضل'],
    [...methods.values()].map((m) => [`<b>${esc(m.label)}</b>`, money(m.tin, 'in'), money(m.tout, 'out'), money(m.closing, 'bal')])) + '</section>';
  h += `<section class="details"><h2>التوضيح</h2>
    <div class="kpis small">${kpi('إيرادات تجارية', money(S.revenue, 'in'))}${kpi('مصروفات', money(S.expenses, 'out'))}${kpi('مرتجعات', money(S.refunds, 'out'))}
    ${kpi('تمويل وارد', money(S.funding_in))}${kpi('سداد تمويل', money(S.funding_repay))}</div>
    <h3>الديون والالتزامات (ليست في الصندوق)</h3>
    <div class="kpis small">${kpi('ديون الزبائن لنا', money(S.receivables, 'debt'))}${kpi('متبقٍ على الحجوزات', money(S.booking_remaining, 'debt'))}
    ${kpi('تمويل خارجي علينا', money(S.funding_external, 'out'))}${kpi('صافي الأصول بعد الالتزامات', money(S.net_assets, 'bal'))}</div>
    <p class="note">صافي الأصول = اللي ضل + ديون الزبائن − التمويل الخارجي غير المسدد.</p>`;
  for (const [c, label] of [[R.cumulative.month, 'تراكمي الشهر'], [R.cumulative.year, 'تراكمي السنة']]) {
    h += `<h3>${label} (${c.from} — ${c.to})</h3>` + table(['المنشأة', 'انجمع', 'طلع'],
      c.rows.map((r) => [esc(r.facility.name), money(r.totals.tin, 'in'), money(r.totals.tout, 'out')]),
      { foot: ['الإجمالي', money(c.total.tin, 'in'), money(c.total.tout, 'out')] });
  }
  if (R.days && R.days.length > 1) {
    h += `<h3>كل يوم لحاله</h3>` + table(['التاريخ', 'انجمع', 'طلع', 'الصافي'],
      R.days.map((d) => [d.date, money(d.tin, 'in'), money(d.tout, 'out'), money(d.tin - d.tout)]));
  }
  if (R.fundings.length) h += `<h3>التمويل</h3>${fundingTable(R.fundings)}`;
  return h + '</section>';
}

// ============ كشف حساب (منشأة أو حساب — مستقل تماماً) ============
function statementDoc(R) {
  let h = balanceBlock(R.totals.tin, R.totals.tout, R.closing, R.opening);
  if (R.user_filter) h += `<p class="note">الكشف يعرض عمليات الموظف "${esc(R.user_filter)}" فقط؛ "اللي ضل" هو رصيد الحسابات كاملة.</p>`;
  h += methodBlock(R.by_method, R.accounts);
  const kind = R.facility ? R.facility.kind : null;
  h += `<section class="details"><h2>التوضيح — كل الحركات حسب التاريخ</h2>` + table(
    ['الرقم', 'التاريخ', 'نوع المعاملة', 'الاسم / الجهة', 'تاريخ الحجز', eventHead[kind] || 'الموعد / الخدمة', 'وين وصلت / من وين', 'انجمع', 'طلع', R.user_filter ? '' : 'الرصيد', 'الموظف', 'ملاحظات'],
    R.rows.map((t) => {
      const c = t.status === 'cancelled';
      const w = (x) => (c ? `<s>${x}</s>` : x);
      return [esc(t.no), t.op_date, esc(txnLabel(t)) + (t.category && !['payment'].includes(t.kind) ? ` — ${esc(t.category)}` : '') + (c ? ' <b class="out">(ملغاة)</b>' : ''),
        esc(t.party || ''), t.booking_date || '', esc(t.event || ''), esc(t.account_name),
        t.direction === 'in' ? w(money(t.amount, 'in')) : '', t.direction === 'out' ? w(money(t.amount, 'out')) : '',
        t.running == null ? '' : money(t.running, 'bal'), esc(t.user_name),
        esc([t.notes, t.extra, c ? `سبب الإلغاء: ${t.cancel_reason}` : ''].filter(Boolean).join(' | '))];
    }), { empty: 'لا توجد حركات في الفترة' });
  if (R.expense_by_category.length) h += sumList('المصروفات حسب التصنيف', R.expense_by_category);
  if (R.debts.length) {
    h += `<h3>الديون على الزبائن (ليست في الصندوق)</h3>` + table(['الطلب', 'التاريخ', 'الزبون', 'الخدمة', 'السعر', 'دفع', 'المتبقي'],
      R.debts.map((o) => [esc(o.no), o.order_date, esc(o.customer_name + (o.customer_tag ? ` - ${o.customer_tag}` : '')), esc(o.service_name),
        money(o.price), money(o.paid, 'in'), money(o.remaining, 'debt')]), { foot: ['الإجمالي', '', '', '', '', '', money(R.receivables, 'debt')] });
  }
  if (R.booking_remaining) h += `<p class="note">متبقٍ على الحجوزات القائمة (يُدفع لاحقاً): <b>${fmt(R.booking_remaining)}</b></p>`;
  if (R.fundings.length) h += `<h3>التمويل</h3>${fundingTable(R.fundings)}`;
  return h + '</section>';
}

function docTitle(R, s) {
  if (R.type === 'statement') return R.title;
  if (R.part === 'summary') return `الملخص الإجمالي — ${R.title}`;
  return `${s.facility.name} — ${R.title}`;
}

function wrapDoc(title, R, body, first = true) {
  return `<div class="doc ${first ? '' : 'newdoc'}"><header class="top"><div><h1>${esc(title)}</h1>
<div class="meta">الفترة: ${R.from} — ${R.to} · العملة: ${esc(cur())}</div></div>
<div class="meta">تاريخ اليوم: ${R.today}${R.days_to_year_end !== undefined ? ` · متبقٍ لنهاية السنة: ${R.days_to_year_end} يوم` : ''}<br>
أُنشئ في: ${dt(R.generated_at)}</div></header>${body}</div>`;
}

/**
 * R.part: 'summary' => الملخص فقط، وإلا كل منشأة في R.sections كشف مستقل
 * (عند المعاينة على الشاشة لكل المنشآت تظهر الكشوفات متتالية وكل واحد يبدأ بصفحة جديدة)
 */
function renderReport(R) {
  let docs;
  if (R.type === 'statement') docs = [wrapDoc(R.title, R, statementDoc(R))];
  else if (R.part === 'summary') docs = [wrapDoc(docTitle(R), R, summaryDoc(R))];
  else {
    docs = R.sections.map((s, i) => wrapDoc(docTitle(R, s), R, facilityDoc(R, s), i === 0));
    if (R.sections.length > 1) docs.push(wrapDoc(`الملخص الإجمالي — ${R.title}`, R, summaryDoc(R), false));
  }
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
.newdoc{page-break-before:always;break-before:page;margin-top:24px;border-top:4px dashed #cdd8e4;padding-top:16px}
@media print{.newdoc{border-top:0;margin-top:0;padding-top:0}}
.kpis.big .kpi .v{font-size:22px}
.kpis.big .kpi{flex:1 1 150px;padding:10px 12px}
section.details h2{background:#475467}
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
</head><body>
${docs.join('\n')}
<footer>نظام إدارة الصالة والمغسلة والملعب — المبالغ بالعملة (${esc(cur())}). العمليات الملغاة محفوظة في السجل ولا تدخل في الحساب.</footer>
</body></html>`;
}

module.exports = { renderReport, docTitle };
