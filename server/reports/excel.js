'use strict';
const ExcelJS = require('exceljs');
const { LABELS, toMajor } = require('../util');

const label = (t) => (t.pay_type ? LABELS.payType[t.pay_type] : LABELS.kind[t.kind]);

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name.slice(0, 31), { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([header, key, width = 14, money = false]) => ({ header, key, width, style: money ? { numFmt: '#,##0.##' } : {} }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  for (const r of rows) ws.addRow(r);
  return ws;
}

const TXN_COLS = [
  ['الرقم', 'no', 10], ['التاريخ', 'op_date', 12], ['المنشأة', 'facility_name', 18], ['النوع', 'type', 16],
  ['التصنيف', 'category', 16], ['من / إلى', 'party', 22], ['المرجع', 'ref_no', 10], ['الحساب', 'account_name', 18],
  ['داخل', 'in', 12, true], ['خارج', 'out', 12, true], ['الرصيد', 'running', 13, true], ['الموظف', 'user_name', 14],
  ['الحالة', 'status', 10], ['ملاحظات', 'notes', 30],
];
const txnRow = (t) => ({
  ...t, type: label(t), in: t.direction === 'in' ? toMajor(t.amount) : null, out: t.direction === 'out' ? toMajor(t.amount) : null,
  running: t.running != null ? toMajor(t.running) : null, status: t.status === 'active' ? 'فعالة' : `ملغاة: ${t.cancel_reason || ''}`,
  notes: [t.notes, t.extra].filter(Boolean).join(' | '),
});

async function reportToExcel(R) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'accounting';
  if (R.type === 'statement') {
    sheet(wb, 'الملخص', [['البند', 'k', 40], ['القيمة', 'v', 18, true]], [
      { k: R.title }, { k: `الفترة ${R.from} — ${R.to}` },
      { k: 'الرصيد الافتتاحي', v: toMajor(R.opening) }, { k: 'إجمالي ما تم جمعه', v: toMajor(R.totals.tin) },
      { k: 'إجمالي ما تم صرفه', v: toMajor(R.totals.tout) }, { k: 'الرصيد المتبقي', v: toMajor(R.closing) },
      { k: 'ديون الزبائن', v: toMajor(R.receivables) }, { k: 'تمويل خارجي غير مسدد', v: toMajor(R.funding_external) },
      { k: 'صافي الأصول بعد الالتزامات', v: toMajor(R.net_assets) },
    ]);
    sheet(wb, 'الحسابات', [['الحساب', 'name', 22], ['المنشأة', 'facility_name', 18], ['النوع', 'type_label', 14], ['الهاتف', 'phone', 14],
      ['رصيد البداية', 'o', 14, true], ['الرصيد الحالي', 'c', 14, true]],
    R.accounts.map((a) => ({ ...a, o: toMajor(a.opening), c: toMajor(a.closing) })));
    sheet(wb, 'الحركات', TXN_COLS, R.rows.map(txnRow));
    if (R.debts.length) {
      sheet(wb, 'الديون', [['الطلب', 'no'], ['التاريخ', 'order_date'], ['الزبون', 'customer_name', 22], ['الخدمة', 'service_name', 16],
        ['السعر', 'p', 12, true], ['المدفوع', 'pd', 12, true], ['المتبقي', 'r', 12, true]],
      R.debts.map((o) => ({ ...o, p: toMajor(o.price), pd: toMajor(o.paid), r: toMajor(o.remaining) })));
    }
  } else {
    const S = R.summary;
    sheet(wb, 'الملخص', [['المنشأة', 'name', 24], ['رصيد البداية', 'o', 14, true], ['داخل', 'i', 14, true], ['خارج', 'x', 14, true],
      ['صافي', 'n', 14, true], ['الرصيد المتبقي', 'c', 14, true]], [
      ...R.sections.map((s) => ({ name: s.facility.name, o: toMajor(s.opening), i: toMajor(s.totals.tin), x: toMajor(s.totals.tout), n: toMajor(s.totals.net), c: toMajor(s.closing) })),
      { name: 'الإجمالي', o: toMajor(S.opening), i: toMajor(S.tin), x: toMajor(S.tout), n: toMajor(S.net), c: toMajor(S.balances) },
      {}, { name: 'ديون الزبائن', c: toMajor(S.receivables) }, { name: 'تمويل خارجي غير مسدد', c: toMajor(S.funding_external) },
      { name: 'صافي الأصول بعد الالتزامات', c: toMajor(S.net_assets) },
    ]);
    if (R.days) {
      sheet(wb, 'الأيام', [['التاريخ', 'date', 12], ['داخل', 'i', 14, true], ['خارج', 'x', 14, true], ['صافي', 'n', 14, true]],
        R.days.map((d) => ({ date: d.date, i: toMajor(d.tin), x: toMajor(d.tout), n: toMajor(d.tin - d.tout) })));
    }
    for (const s of R.sections) {
      sheet(wb, s.facility.name, TXN_COLS, [...s.ins, ...s.outs, ...s.cancelled].sort((a, b) => (a.op_date + a.no).localeCompare(b.op_date + b.no)).map(txnRow));
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { reportToExcel };
