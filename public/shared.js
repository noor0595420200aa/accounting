/* مكونات مشتركة: لوحة التحكم، الدفعات، الإلغاء، الإيداع والمصروف */
'use strict';

// جدول الدفعات/الحركات المرتبطة بحجز أو طلب
function paymentsTable(list, onChange) {
  return table(['الرقم', 'تاريخ الدفع', 'نوع المعاملة', 'المبلغ', 'وين وصلت', 'الموظف', 'ملاحظات', ''],
    list.map((t) => [
      noTag(t.no), t.op_date, txnLabel(t), money(t.amount, t.direction === 'in' ? 'c-in' : 'c-out'), t.account_name, t.user_name,
      t.status === 'cancelled' ? `ملغاة: ${t.cancel_reason || ''}` : (t.notes || ''),
      t.status === 'active' && t.kind === 'payment' && canCancel() ? h('button', { class: 'btn sm danger', onclick: (e) => { e.stopPropagation(); cancelTxn(t, onChange); } }, 'إلغاء') : '',
    ]), { empty: 'لا توجد دفعات', rowClass: (i) => (list[i].status === 'cancelled' ? 'cancelled' : '') });
}
const canCancel = () => isAdmin() || S.me.staff_can_cancel;

function cancelTxn(t, onDone) {
  modal(`إلغاء العملية ${t.no}`, [
    h('p', null, `${txnLabel(t)} بمبلغ `, money(t.amount), ` — ${t.account_name}`),
    h('p', { class: 'hint' }, 'لا يتم حذف العملية نهائياً؛ تبقى في السجل مع سبب الإلغاء ولا تدخل في الأرصدة.'),
    field('سبب الإلغاء', area('reason'), { req: true }),
  ], async (d, idem) => {
    await api('POST', `/txns/${t.id}/cancel`, d, { idem });
    closeModal();
    toast('تم إلغاء العملية', 'ok');
    (onDone || reload)();
  }, { submitText: 'تأكيد الإلغاء', submitClass: 'out' });
}

// نافذة إضافة دفعة لحجز أو طلب
function payModal({ title, url, facilityId, remaining, payTypes, onDone }) {
  const body = [
    h('p', null, 'المتبقي: ', money(remaining, 'c-debt')),
    field('المبلغ المدفوع', moneyInp('amount', { value: major(remaining), required: true }), { req: true }),
    payTypes ? field('نوع الدفعة', sel('pay_type', payTypes)) : '',
    field('وين وصل المبلغ', accountSel(facilityId), { req: true }),
    field('تاريخ الدفعة', dateInp('op_date')),
    field('ملاحظات', area('notes')),
  ];
  modal(title, body, async (d, idem) => {
    const r = await api('POST', url, d, { idem });
    closeModal();
    toast(`تم تسجيل الدفعة ${r.no || (r.nos || []).join('، ')}`, 'ok');
    (onDone || reload)();
  }, { submitText: 'تسجيل الدفعة', submitClass: 'in' });
}

// نافذة إلغاء حجز/طلب: إرجاع كامل، احتفاظ، أو خصم وإرجاع الباقي
function cancelRefModal({ title, url, facilityId, paid, onDone }) {
  const net = paid;
  const partialBox = h('div', { class: 'hide' }, field('المبلغ المخصوم (يبقى للمنشأة)', moneyInp('kept_amount', { value: 0 }), { hint: 'والباقي يُرجع للزبون' }));
  const refundBox = h('div', { class: 'hide' }, field('من وين يطلع المبلغ المرتجع', accountSel(facilityId, 'refund_account_id')), field('تاريخ الإرجاع', dateInp('refund_date')));
  const update = (v) => {
    partialBox.classList.toggle('hide', v !== 'partial');
    refundBox.classList.toggle('hide', v === 'keep' || !v);
  };
  const radio = (v, l) => h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'cancel_action', value: v, onchange: () => update(v) }), l);
  const body = [
    net > 0 ? [
      h('p', null, 'المبلغ المدفوع على هذه العملية: ', money(net, 'c-in')),
      h('div', { class: 'card tight', style: { background: '#f7f9fc' } }, h('b', null, 'ماذا نفعل بالمبلغ المدفوع؟'),
        radio('refund_all', 'إرجاع كامل المبلغ للزبون'), radio('keep', 'الاحتفاظ بكامل المبلغ'), radio('partial', 'خصم جزء وإرجاع الباقي')),
      partialBox, refundBox,
    ] : h('p', { class: 'hint' }, 'لا توجد مبالغ مدفوعة.'),
    field('سبب الإلغاء', area('cancel_reason'), { req: true }),
    isAdmin() ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'allow_negative' }), 'السماح بالإرجاع حتى لو كان رصيد الحساب غير كافٍ') : '',
  ];
  modal(title, body, async (d, idem) => {
    const r = await api('POST', url, d, { idem });
    closeModal();
    toast(`تم الإلغاء${r.refund ? ` — تم إرجاع ${fmt(r.refund)}` : ''}`, 'ok');
    (onDone || reload)();
  }, { submitText: 'تأكيد الإلغاء', submitClass: 'out' });
}

// إيداع أو مصروف لمنشأة
function moneyModal(kind, facilityId, onDone) {
  const f = S.meta.facilities.find((x) => x.id === Number(facilityId));
  const isExp = kind === 'expense';
  const cats = isExp ? f.expense_categories : f.income_categories;
  const body = [
    isAdmin() && S.meta.facilities.length > 1 ? h('p', { class: 'hint' }, `المنشأة: ${f.name}`) : '',
    field('المبلغ', moneyInp('amount', { required: true }), { req: true }),
    field(isExp ? 'تصنيف المصروف' : 'نوع العملية', sel('category', cats), { req: true }),
    field(isExp ? 'من وين طلع المبلغ' : 'وين وصل المبلغ', accountSel(facilityId), { req: true }),
    field(isExp ? 'الجهة أو الشخص المستلم' : 'مصدر المبلغ', inp('party', { required: true }), { req: true }),
    field('التاريخ', dateInp('op_date')),
    field('ملاحظات', area('notes')),
    extraBox(),
    isExp && isAdmin() ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'allow_negative' }), 'السماح بالتسجيل حتى لو كان الرصيد غير كافٍ') : '',
  ];
  modal(isExp ? `مصروف — ${f.name}` : `إيداع — ${f.name}`, body, async (d, idem) => {
    d.facility_id = facilityId;
    const r = await api('POST', `/txns/${kind}`, d, { idem });
    closeModal();
    toast(`تم التسجيل برقم ${r.no}`, 'ok');
    (onDone || reload)();
  }, { submitText: isExp ? 'تسجيل المصروف' : 'تسجيل الإيداع', submitClass: isExp ? 'out' : 'in' });
}

function txnsTable(rows, { onChange, showFacility = false } = {}) {
  return table(['الرقم', 'التاريخ', ...(showFacility ? ['المنشأة'] : []), 'النوع', 'من / إلى', 'المرجع', 'وين / من وين', 'داخل', 'خارج', 'الموظف', 'ملاحظات', ''],
    rows.map((t) => [
      noTag(t.no), t.op_date, ...(showFacility ? [t.facility_name] : []),
      txnLabel(t) + (t.category && t.kind !== 'payment' ? ` — ${t.category}` : ''), t.party || '',
      t.ref_no ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); lookup(t.ref_no); } }, noTag(t.ref_no)) : '',
      t.account_name,
      t.direction === 'in' ? money(t.amount, 'c-in') : '', t.direction === 'out' ? money(t.amount, 'c-out') : '',
      t.user_name, t.status === 'cancelled' ? `ملغاة: ${t.cancel_reason || ''}` : (t.notes || ''),
      t.status === 'active' && ['income', 'expense', 'payment'].includes(t.kind) && canCancel()
        ? h('button', { class: 'btn sm danger', onclick: (e) => { e.stopPropagation(); cancelTxn(t, onChange); } }, 'إلغاء') : '',
    ]), { empty: 'لا توجد عمليات', onRow: (i) => go(`#/txn/${rows[i].id}`), rowClass: (i) => (rows[i].status === 'cancelled' ? 'cancelled' : '') });
}

function historyList(list) {
  return table(['الوقت', 'الموظف', 'العملية', 'الرقم', 'التفاصيل'],
    list.map((a) => [dt(a.created_at), a.user_name || '—', ({ create: 'إضافة', update: 'تعديل', cancel: 'إلغاء', send: 'إرسال' })[a.action] || a.action, noTag(a.ref_no), a.summary || '']),
    { empty: 'لا يوجد سجل' });
}

// ---------------- لوحة التحكم ----------------
route(/^\/$/, async () => {
  const d = await GET('/dashboard');
  const N = d.new_counts;
  const wrap = h('div');
  wrap.append(h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'الرئيسية'), h('div', { class: 'hint' }, `اليوم ${d.today} · متبقٍ لنهاية السنة ${d.days_to_year_end} يوم`)),
    isAdmin() ? h('button', { class: 'btn lg', onclick: () => go('#/statement') }, '📄 كشف حساب شامل PDF') : ''));

  if (d.alerts.length) {
    wrap.append(h('div', { class: 'card tight' }, h('h3', null, '⚠️ تنبيهات'), d.alerts.map((a) => h('div', { class: `alert ${a.type.includes('failed') ? 'err' : ''}` },
      h('span', null, a.message),
      h('span', { class: 'row' },
        a.type === 'stale_report' || a.type === 'telegram_failed' ? h('a', { class: 'btn sm sec', href: '#/reports' }, 'التقارير') : '',
        h('button', { class: 'btn sm ghost', onclick: async () => { await api('POST', `/alerts/${a.id}/resolve`); reload(); } }, 'تم'))))));
  }

  wrap.append(h('div', { class: 'grid g4 kpis', style: { marginBottom: '16px' } },
    kpi('إجمالي رصيد الخزن', money(d.total_balance)),
    kpi('إيرادات اليوم (داخل)', money(d.day.tin), 'in'),
    kpi('مصروفات اليوم (خارج)', money(d.day.tout), 'out'),
    kpi('صافي حركة اليوم', money(d.day.tin - d.day.tout), 'plain'),
    N.hall !== null ? kpi('حجوزات صالة جديدة اليوم', N.hall, 'plain') : '',
    N.field !== null ? kpi('حجوزات ملعب جديدة اليوم', N.field, 'plain') : '',
    N.laundry !== null ? kpi('طلبات المغسلة اليوم', N.laundry, 'plain') : '',
    N.laundry !== null ? kpi('إجمالي الديون على الزبائن', money(d.debts), 'debt') : '',
    h('a', { href: '#/fundings', style: { color: 'inherit' } }, kpi('ديون علينا لم تُسدد', money(d.owed_total), d.owed_total ? 'out' : 'plain')),
    kpi('إيرادات منذ بداية السنة', money(d.ytd.tin), 'in'),
    kpi('مصروفات منذ بداية السنة', money(d.ytd.tout), 'out'),
    kpi('صافي حركة السنة', money(d.ytd.tin - d.ytd.tout), 'plain'),
    kpi('أيام متبقية لنهاية السنة', d.days_to_year_end, 'plain')));

  // أزرار سريعة للموظف
  const quick = h('div', { class: 'actions', style: { marginBottom: '16px' } });
  for (const f of S.meta.facilities) {
    if (f.kind === 'hall') quick.append(h('a', { class: 'btn lg', href: '#/hall/new' }, '+ حجز صالة'));
    if (f.kind === 'laundry') quick.append(h('a', { class: 'btn lg', href: '#/laundry' }, '+ طلب مغسلة'));
    if (f.kind === 'field') quick.append(h('a', { class: 'btn lg', href: '#/field/new' }, '+ حجز ملعب'));
  }
  if (!isAdmin() && S.meta.facilities[0]) {
    const fid = S.meta.facilities[0].id;
    quick.append(h('button', { class: 'btn lg in', onclick: () => moneyModal('income', fid) }, '+ إيداع'));
    quick.append(h('button', { class: 'btn lg out', onclick: () => moneyModal('expense', fid) }, '+ مصروف'));
  }
  wrap.append(quick);

  wrap.append(h('div', { class: 'grid g3' }, d.facilities.map((f) => h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h3', null, f.name), h('span', { class: 'sp' }), noTag(f.prefix)),
    h('div', { class: 'kpi plain', style: { boxShadow: 'none', padding: '6px 0' } }, h('div', { class: 'l' }, 'الرصيد الحالي'), h('div', { class: 'v' }, money(f.balance))),
    h('div', { class: 'row hint' }, 'اليوم: ', money(f.today.tin, 'c-in'), ' داخل · ', money(f.today.tout, 'c-out'), ' خارج'),
    h('div', { class: 'list-acc' }, f.accounts.map((a) => h('div', null, h('span', null, '📍 ', a.name), money(a.balance)))),
    h('div', { class: 'actions mt' },
      h('a', { class: 'btn sm sec', href: `#/treasury/${f.id}` }, 'الخزنة'),
      ({ hall: h('a', { class: 'btn sm sec', href: '#/hall' }, 'الصالة'), laundry: h('a', { class: 'btn sm sec', href: '#/laundry' }, 'المغسلة'),
        field: h('a', { class: 'btn sm sec', href: '#/field' }, 'الملعب') })[f.kind] || '')))));

  if (d.today_events.hall.length || d.today_events.field.length) {
    wrap.append(h('div', { class: 'card' }, h('h3', null, 'مواعيد اليوم'),
      d.today_events.hall.map((b) => h('div', null, '💍 ', noTag(b.no), ` ${b.customer_name} — فترة ${S.L.period[b.period]} `, bStatus(b.status))),
      d.today_events.field.map((b) => h('div', null, '⚽ ', noTag(b.no), ` ${b.customer_name} — ${b.start_time} إلى ${b.end_time} `, bStatus(b.status)))));
  }

  wrap.append(h('div', { class: 'card' }, h('h3', null, 'آخر العمليات المالية'),
    table(['الرقم', 'التاريخ', 'المنشأة', 'النوع', 'من / إلى', 'الحساب', 'المبلغ', 'الموظف'],
      d.recent_txns.map((t) => [noTag(t.no), t.op_date, t.facility_name, txnLabel(t), t.party || '', t.account_name,
        money(t.amount, t.direction === 'in' ? 'c-in' : 'c-out'), t.user_name]),
      { onRow: (i) => go(`#/txn/${d.recent_txns[i].id}`), rowClass: (i) => (d.recent_txns[i].status === 'cancelled' ? 'cancelled' : '') })));
  if (isAdmin()) wrap.append(h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', null, 'آخر عمليات الموظفين'), h('span', { class: 'sp' }), h('a', { href: '#/audit' }, 'السجل الكامل')), historyList(d.recent_audit)));
  return wrap;
});

// ---------------- تفاصيل عملية مالية ----------------
route(/^\/txn\/(\d+)$/, async (id) => {
  const t = await GET(`/txns/${id}`);
  const refLink = t.ref_no ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); lookup(t.ref_no); } }, noTag(t.ref_no)) : '—';
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, 'العملية ', noTag(t.no)),
      t.status === 'active' && ['income', 'expense', 'payment'].includes(t.kind) && canCancel()
        ? h('button', { class: 'btn danger', onclick: () => cancelTxn(t) }, 'إلغاء العملية') : ''),
    h('div', { class: 'card' }, h('dl', { class: 'kv' },
      h('dt', null, 'الحالة'), h('dd', null, t.status === 'active' ? badge('active', 'فعالة') : badge('cancelled', 'ملغاة')),
      h('dt', null, 'المنشأة'), h('dd', null, t.facility_name),
      h('dt', null, 'النوع'), h('dd', null, txnLabel(t), t.category ? ` — ${t.category}` : ''),
      h('dt', null, 'المبلغ'), h('dd', null, money(t.amount, t.direction === 'in' ? 'c-in' : 'c-out'), t.direction === 'in' ? ' (داخل)' : ' (خارج)'),
      h('dt', null, t.direction === 'in' ? 'الحساب المستلم' : 'الحساب المصروف منه'), h('dd', null, t.account_name),
      h('dt', null, t.direction === 'in' ? 'المصدر' : 'الجهة المستلمة'), h('dd', null, t.party || '—'),
      h('dt', null, 'المرجع'), h('dd', null, refLink),
      h('dt', null, 'تاريخ العملية'), h('dd', null, t.op_date),
      h('dt', null, 'وقت التسجيل'), h('dd', null, dt(t.created_at)),
      h('dt', null, 'سجلها'), h('dd', null, t.user_name),
      h('dt', null, 'ملاحظات'), h('dd', null, t.notes || '—'),
      t.extra ? [h('dt', null, 'تفاصيل أخرى'), h('dd', null, t.extra)] : '',
      t.status === 'cancelled' ? [h('dt', null, 'ألغاها'), h('dd', null, `${t.cancelled_by_name} — ${dt(t.cancelled_at)}`),
        h('dt', null, 'سبب الإلغاء'), h('dd', null, t.cancel_reason)] : '')));
});
