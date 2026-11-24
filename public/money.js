/* الخزن والحسابات والإيداعات والمصروفات والتمويل */
'use strict';

// صفحة الإيداعات والمصروفات لمنشأة
route(/^\/finance\/(\d+)$/, async (fid) => {
  const f = S.meta.facilities.find((x) => x.id === Number(fid));
  if (!f) throw new Error('لا تملك صلاحية على هذا القسم');
  const listBox = h('div');
  const kind = sel('kind', [['', 'كل العمليات'], ['income', 'إيداعات'], ['expense', 'مصروفات'], ['payment', 'دفعات حجوزات/طلبات'], ['refund', 'مرتجعات']]);
  const from = h('input', { type: 'date', value: today().slice(0, 8) + '01' });
  const to = h('input', { type: 'date' });
  const q = h('input', { placeholder: 'رقم، اسم، ملاحظة…' });
  const acc = sel('account_id', [['', 'كل الحسابات'], ...f.accounts.map((a) => [a.id, a.name])]);
  const load = async () => {
    const rows = await GET(`/txns${qs({ facility_id: fid, kind: kind.value, from: from.value, to: to.value, q: q.value, account_id: acc.value })}`);
    const act = rows.filter((t) => t.status === 'active');
    listBox.innerHTML = '';
    listBox.append(h('div', { class: 'grid g3 kpis', style: { marginBottom: '12px' } },
      kpi('إجمالي الداخل', money(act.filter((t) => t.direction === 'in').reduce((s, t) => s + t.amount, 0)), 'in'),
      kpi('إجمالي الخارج', money(act.filter((t) => t.direction === 'out').reduce((s, t) => s + t.amount, 0)), 'out'),
      kpi('عدد العمليات', rows.length, 'plain')), txnsTable(rows, { onChange: load }));
  };
  await load();
  const back = { hall: '#/hall', laundry: '#/laundry', field: '#/field' }[f.kind];
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, `الإيداعات والمصروفات — ${f.name}`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn lg in', onclick: () => moneyModal('income', f.id, load) }, '+ إيداع'),
        h('button', { class: 'btn lg out', onclick: () => moneyModal('expense', f.id, load) }, '+ مصروف'))),
    back ? h('div', { class: 'tabs' }, h('a', { href: back }, `→ العودة إلى ${f.name}`), h('a', { href: `#/treasury/${f.id}` }, 'الخزنة')) : '',
    h('div', { class: 'card' }, h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); load(); } },
      field('النوع', kind), field('الحساب', acc), field('من', from), field('إلى', to), field('بحث', q), h('button', { class: 'btn' }, 'عرض')), listBox));
});

// ---------- الخزن ----------
route(/^\/treasury$/, async () => {
  const list = await GET('/treasury');
  const total = list.reduce((s, t) => s + t.current, 0);
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, '💰 الخزن والحسابات'),
      isAdmin() ? h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => accountModal() }, '+ إضافة حساب / مكان حفظ'),
        h('a', { class: 'btn sec', href: '#/fundings' }, 'التمويل والديون الخارجية'),
        h('a', { class: 'btn sec', href: '#/statement' }, 'كشف حساب شامل PDF')) : ''),
    h('div', { class: 'grid g3 kpis', style: { marginBottom: '16px' } }, kpi('إجمالي أرصدة كل الخزن', money(total))),
    h('div', { class: 'grid g2' }, list.map((t) => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, `خزنة ${t.facility.name}`), h('span', { class: 'sp' }), noTag(t.facility.prefix)),
      h('div', { class: 'grid g3 mt' },
        kpi('الرصيد الافتتاحي', money(t.opening), 'plain'), kpi('إجمالي الداخل', money(t.total_in), 'in'), kpi('إجمالي الخارج', money(t.total_out), 'out')),
      h('div', { class: 'kpi', style: { marginTop: '10px' } }, h('div', { class: 'l' }, 'الرصيد الحالي'), h('div', { class: 'v' }, money(t.current))),
      h('h3', { class: 'mt' }, 'أين يوجد المال'),
      table(['الحساب', 'النوع', 'الرصيد'], t.accounts.filter((a) => a.active || a.balance).map((a) => [
        h('span', null, '📍 ', a.name, a.active ? '' : ' (معطل)'), S.L.accountType[a.type], money(a.balance)]),
      { onRow: (i) => go(`#/account/${t.accounts.filter((a) => a.active || a.balance)[i].id}`) }),
      h('div', { class: 'actions mt' }, h('a', { class: 'btn sec', href: `#/treasury/${t.facility.id}` }, 'صفحة الخزنة وكشفها'))))));
});

function accountModal(a = null) {
  const facs = S.meta.facilities;
  modal(a ? `تعديل حساب: ${a.name}` : 'إضافة حساب / مكان حفظ واستلام الأموال', [
    field('اسم الحساب أو الشخص', inp('name', { required: true, value: a?.name }), { req: true, hint: 'مثال: الحساب البنكي، خزنة المكتب، أسامة' }),
    h('div', { class: 'grid g2' },
      field('المنشأة التابع لها', a ? h('input', { value: facs.find((f) => f.id === a.facility_id)?.name || '', disabled: true }) : sel('facility_id', facs.map((f) => [f.id, f.name]))),
      field('نوع الحساب', sel('type', Object.entries(S.L.accountType), a?.type || 'safe')),
      field('رقم الهاتف (اختياري)', inp('phone', { type: 'tel', dir: 'ltr', value: a?.phone })),
      field('الرصيد الافتتاحي', moneyInp('opening_balance', { value: a ? major(a.opening_balance) : 0 })),
      field('تاريخ الرصيد الافتتاحي', dateInp('opening_date', a?.opening_date))),
    field('ملاحظات', area('notes', a?.notes)),
    a ? [h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: !!a.active }), 'الحساب فعّال'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'confirm_opening_change' }), 'أؤكد تغيير الرصيد الافتتاحي رغم وجود عمليات'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'confirm_deactivate' }), 'أؤكد تعطيل الحساب رغم وجود رصيد')] : '',
  ], async (d, idem) => {
    if (a) await api('PUT', `/accounts/${a.id}`, d, { idem }); else await api('POST', '/accounts', d, { idem });
    closeModal();
    await refreshMeta();
    toast('تم الحفظ', 'ok');
    reload();
  });
}

route(/^\/treasury\/(\d+)$/, async (fid) => {
  const q = hashQuery();
  const t = await GET(`/treasury/${fid}${qs({ from: q.from, to: q.to })}`);
  const from = h('input', { type: 'date', value: q.from || '' });
  const to = h('input', { type: 'date', value: q.to || '' });
  const f = t.facility;
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, `خزنة ${f.name}`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn in', onclick: () => moneyModal('income', f.id) }, '+ إيداع'),
        h('button', { class: 'btn out', onclick: () => moneyModal('expense', f.id) }, '+ مصروف'),
        h('a', { class: 'btn sec', href: `#/statement?facility_id=${f.id}` }, 'كشف الخزنة PDF'))),
    h('div', { class: 'card tight' }, h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); go(`#/treasury/${fid}${qs({ from: from.value, to: to.value })}`); } },
      field('من', from), field('إلى', to), h('button', { class: 'btn' }, 'عرض'), h('a', { class: 'btn ghost', href: `#/treasury/${fid}` }, 'كل الفترات'))),
    h('div', { class: 'grid g4 kpis', style: { marginBottom: '16px' } },
      kpi(q.from ? 'رصيد بداية الفترة' : 'الرصيد الافتتاحي', money(t.opening), 'plain'),
      kpi('إجمالي المبالغ الداخلة', money(t.total_in), 'in'), kpi('إجمالي المبالغ الخارجة', money(t.total_out), 'out'),
      kpi(q.to ? 'الرصيد في نهاية الفترة' : 'الرصيد الحالي', money(t.closing))),
    h('div', { class: 'card' }, h('h3', null, 'مكان وجود المال'),
      table(['الحساب', 'النوع', 'الهاتف', 'ملاحظات', 'الرصيد', ''], t.accounts.map((a) => [
        h('span', null, '📍 ', a.name, a.active ? '' : ' (معطل)'), S.L.accountType[a.type], a.phone || '', a.notes || '', money(a.balance),
        isAdmin() ? h('button', { class: 'btn sm ghost', onclick: (e) => { e.stopPropagation(); accountModal(a); } }, 'تعديل') : '']),
      { onRow: (i) => go(`#/account/${t.accounts[i].id}`) })),
    h('div', { class: 'card' }, h('h3', null, 'جميع عمليات الإيداع والصرف'), txnsTable(t.txns)));
});

route(/^\/account\/(\d+)$/, async (id) => {
  const q = hashQuery();
  const s = await GET(`/accounts/${id}/statement${qs({ from: q.from, to: q.to })}`);
  const a = s.account;
  const from = h('input', { type: 'date', value: q.from || '' });
  const to = h('input', { type: 'date', value: q.to || '' });
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, `📍 ${a.name}`), h('div', { class: 'hint' }, `${a.facility_name} · ${S.L.accountType[a.type]}${a.phone ? ` · ${a.phone}` : ''}`)),
      h('div', { class: 'actions' },
        isAdmin() ? h('button', { class: 'btn sec', onclick: () => accountModal(a) }, 'تعديل') : '',
        isAdmin() ? h('a', { class: 'btn', href: `#/statement?account_id=${a.id}` }, 'كشف الحساب PDF') : '')),
    a.notes ? h('div', { class: 'card tight' }, a.notes) : '',
    h('div', { class: 'card tight' }, h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); go(`#/account/${id}${qs({ from: from.value, to: to.value })}`); } },
      field('من', from), field('إلى', to), h('button', { class: 'btn' }, 'عرض'))),
    h('div', { class: 'grid g4 kpis', style: { marginBottom: '16px' } },
      kpi('رصيد البداية', money(s.opening), 'plain'), kpi('الداخل', money(s.total_in), 'in'), kpi('الخارج', money(s.total_out), 'out'), kpi('الرصيد', money(s.closing))),
    h('div', { class: 'card' }, table(['الرقم', 'التاريخ', 'النوع', 'من / إلى', 'المرجع', 'داخل', 'خارج', 'الرصيد', 'الموظف', 'ملاحظات'],
      s.rows.map((t) => [noTag(t.no), t.op_date, txnLabel(t) + (t.category && t.kind !== 'payment' ? ` — ${t.category}` : ''), t.party || '', noTag(t.ref_no),
        t.direction === 'in' ? money(t.amount, 'c-in') : '', t.direction === 'out' ? money(t.amount, 'c-out') : '', money(t.running), t.user_name,
        t.status === 'cancelled' ? `ملغاة: ${t.cancel_reason}` : (t.notes || '')]),
      { onRow: (i) => go(`#/txn/${s.rows[i].id}`), rowClass: (i) => (s.rows[i].status === 'cancelled' ? 'cancelled' : ''), empty: 'لا توجد عمليات' })));
});

// ---------- التمويل والديون الخارجية ----------
route(/^\/fundings$/, async () => {
  const rows = await GET('/fundings');
  const live = rows.filter((f) => f.status === 'active');
  const facs = S.meta.facilities;
  const addModal = () => {
    const facSel = sel('facility_id', facs.filter((f) => f.kind !== 'general').map((f) => [f.id, f.name]));
    const accBox = h('div');
    const setAcc = () => { accBox.innerHTML = ''; accBox.append(field('الحساب الذي استلم المبلغ', accountSel(facSel.value), { req: true })); };
    facSel.onchange = setAcc;
    setAcc();
    const srcSel = sel('source_account_id', [['', 'جهة خارجية (ليست من حسابات النظام)'], ...S.meta.all_accounts.map((a) => [a.id, `${a.name} — ${a.facility_name}`])],
      (S.meta.all_accounts.find((a) => facs.find((f) => f.id === a.facility_id)?.kind === 'general') || {}).id);
    modal('تسجيل تمويل / دين خارجي لصالح منشأة', [
      h('p', { class: 'hint' }, 'التمويل يظهر منفصلاً عن الإيرادات التجارية، ويبقى التزاماً حتى يُسدد.'),
      field('لصالح المنشأة', facSel, { req: true }), accBox,
      field('مصدر التمويل', srcSel, { hint: 'اختر الحساب الاحتياطي إذا كان المال منه، وسيُخصم منه تلقائياً' }),
      field('الجهة / اسم الممول', inp('party', { required: true }), { req: true }),
      h('div', { class: 'grid g2' }, field('المبلغ', moneyInp('amount', { required: true }), { req: true }), field('التاريخ', dateInp('op_date'))),
      field('ملاحظات', area('notes')),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'allow_negative' }), 'السماح حتى لو كان رصيد المصدر غير كافٍ'),
    ], async (d, idem) => {
      const r = await api('POST', '/fundings', d, { idem });
      closeModal(); toast(`تم التسجيل برقم ${r.no}`, 'ok'); reload();
    });
  };
  const repay = (f) => modal(`سداد التمويل ${f.no}`, [
    h('p', null, 'المتبقي: ', money(f.outstanding, 'c-debt')),
    field('المبلغ', moneyInp('amount', { value: major(f.outstanding), required: true }), { req: true }),
    field('الحساب الذي يخرج منه السداد', accountSel(f.facility_id), { req: true }),
    field('التاريخ', dateInp('op_date')), field('ملاحظات', area('notes')),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'allow_negative' }), 'السماح حتى لو كان الرصيد غير كافٍ'),
  ], async (d, idem) => { await api('POST', `/fundings/${f.id}/repay`, d, { idem }); closeModal(); toast('تم تسجيل السداد', 'ok'); reload(); }, { submitText: 'تسجيل السداد' });
  const cancel = (f) => modal(`إلغاء التمويل ${f.no}`, [h('p', { class: 'hint' }, 'سيتم إلغاء التمويل وكل حركاته مع الاحتفاظ بالسجل.'), field('سبب الإلغاء', area('reason'), { req: true })],
    async (d, idem) => { await api('POST', `/fundings/${f.id}/cancel`, d, { idem }); closeModal(); reload(); }, { submitText: 'تأكيد الإلغاء', submitClass: 'out' });
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, 'التمويل والديون الخارجية'), isAdmin() ? h('button', { class: 'btn', onclick: addModal }, '+ تسجيل تمويل') : ''),
    h('div', { class: 'grid g3 kpis', style: { marginBottom: '16px' } },
      kpi('تمويل خارجي غير مسدد', money(live.filter((f) => !f.source_account_id).reduce((s, f) => s + f.outstanding, 0)), 'out'),
      kpi('تمويل من الاحتياطي غير مسدد', money(live.filter((f) => f.source_account_id).reduce((s, f) => s + f.outstanding, 0)), 'debt'),
      kpi('إجمالي ما تم سداده', money(live.reduce((s, f) => s + f.repaid, 0)), 'in')),
    h('div', { class: 'card' }, table(['الرقم', 'التاريخ', 'لصالح', 'الحساب المستلم', 'المصدر / الجهة', 'المبلغ', 'المسدد', 'المتبقي', 'الحالة', 'ملاحظات', ''],
      rows.map((f) => [noTag(f.no), f.op_date, f.facility_name, f.account_name, f.source_account_name ? `${f.source_account_name} (${f.party})` : f.party,
        money(f.amount), money(f.repaid, 'c-in'), money(f.outstanding, 'c-debt'),
        f.status === 'cancelled' ? badge('cancelled', 'ملغي') : f.outstanding > 0 ? badge('partial', 'قائم') : badge('paid', 'مسدد'), f.notes || '',
        isAdmin() && f.status === 'active' ? h('div', { class: 'row' },
          f.outstanding > 0 ? h('button', { class: 'btn sm in', onclick: () => repay(f) }, 'سداد') : '',
          h('button', { class: 'btn sm danger', onclick: () => cancel(f) }, 'إلغاء')) : '']),
      { empty: 'لا يوجد تمويل مسجل', rowClass: (i) => (rows[i].status === 'cancelled' ? 'cancelled' : '') })));
});
