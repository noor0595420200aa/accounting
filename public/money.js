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
// جدول التقسيم حسب الطريقة: كاش / بال باي / جوال باي
function methodTable(list) {
  return table(['الطريقة', 'انجمع', 'طلع', 'ضل'], list.map((m) => [h('b', null, m.label), money(m.tin, 'c-in'), money(m.tout, 'c-out'), money(m.balance)]),
    { foot: ['الإجمالي', money(list.reduce((x, m) => x + m.tin, 0), 'c-in'), money(list.reduce((x, m) => x + m.tout, 0), 'c-out'), money(list.reduce((x, m) => x + m.balance, 0))] });
}

// فترات الجرد السريعة
function quickRange(key) {
  const t = today();
  return {
    day: { from: t, to: t, label: 'جرد اليوم' },
    week: { from: addDays(t, -6), to: t, label: 'جرد آخر 7 أيام' },
    month: { from: `${t.slice(0, 7)}-01`, to: t, label: 'جرد هذا الشهر' },
    all: { from: '', to: '', label: 'من البداية حتى اليوم' },
  }[key];
}

// جرد حسابات الدفع: كل حساب (كاش، بال باي، جوال باي، بنك فلسطين — فلان...) كم دخل، كم خرج، كم ضايل
async function accountsInventory(box, range) {
  const d = await GET(`/accounts-summary${qs({ from: range.from, to: range.to })}`);
  const rows = d.rows;
  box.innerHTML = '';
  box.append(table(['الحساب', 'المنشأة', 'النوع', 'دخل عليه', 'خرج منه', 'ضايل فيه', 'عدد العمليات'],
    rows.map((a) => [h('b', null, a.label), a.facility_name, S.L.accountType[a.type] || a.type,
      money(a.tin, 'c-in'), money(a.tout, 'c-out'), money(a.closing), a.count]),
    { onRow: (i) => go(`#/account/${rows[i].id}${qs({ from: range.from, to: range.to })}`), empty: 'لا توجد حسابات',
      foot: ['الإجمالي', '', '', money(rows.reduce((x, a) => x + a.tin, 0), 'c-in'), money(rows.reduce((x, a) => x + a.tout, 0), 'c-out'),
        money(rows.reduce((x, a) => x + a.closing, 0)), rows.reduce((x, a) => x + a.count, 0)] }));
}

route(/^\/treasury$/, async () => {
  const list = await GET('/treasury');
  const total = list.reduce((s, t) => s + t.current, 0);
  const invBox = h('div');
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date' });
  const title = h('h2', { style: { margin: 0 } });
  const btns = h('div', { class: 'actions' });
  const run = async (key, custom) => {
    const r = custom || quickRange(key);
    title.textContent = `📋 جرد حسابات الدفع — ${r.label}`;
    btns.querySelectorAll('.btn').forEach((b) => b.classList.toggle('sec', b.dataset.k !== key));
    await accountsInventory(invBox, r);
  };
  for (const k of ['day', 'week', 'month', 'all']) {
    btns.append(h('button', { class: 'btn sm sec', 'data-k': k, onclick: () => run(k) }, quickRange(k).label));
  }
  await run('day');
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, '💰 الخزن والحسابات'),
      seesAll() ? h('div', { class: 'actions' },
        isAdmin() ? h('button', { class: 'btn', onclick: () => accountModal() }, '+ إضافة حساب دفع') : '',
        h('a', { class: 'btn sec', href: '#/fundings' }, 'الديون علينا'),
        h('a', { class: 'btn sec', href: '#/statement' }, 'كشف حساب شامل PDF')) : ''),
    h('div', { class: 'grid g3 kpis', style: { marginBottom: '16px' } }, kpi('إجمالي أرصدة كل الخزن الآن', money(total))),
    h('div', { class: 'card' }, title, h('div', { class: 'mt' }, btns),
      h('form', { class: 'filters mt', onsubmit: (e) => {
        e.preventDefault();
        run('custom', { from: from.value, to: to.value, label: `من ${from.value || 'البداية'} إلى ${to.value || 'اليوم'}` });
      } }, field('من', from), field('إلى', to), h('button', { class: 'btn' }, 'جرد فترة محددة')),
      invBox,
      h('p', { class: 'hint mt' }, 'اضغط على أي حساب لرؤية كل حركاته. "ضايل فيه" هو الرصيد الموجود في الحساب في نهاية الفترة.')),
    h('div', { class: 'grid g2' }, list.map((t) => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, `خزنة ${t.facility.name}`), h('span', { class: 'sp' }), noTag(t.facility.prefix)),
      h('div', { class: 'grid g3 kpis big mt' },
        kpi('إجمالي اللي انجمع', money(t.total_in), 'in'), kpi('إجمالي اللي طلع', money(t.total_out), 'out'), kpi('اللي ضل', money(t.current))),
      h('h3', { class: 'mt' }, 'حسابات الدفع'),
      table(['الحساب', 'دخل', 'خرج', 'ضايل'], t.accounts.filter((a) => a.active || a.balance).map((a) => [h('b', null, a.label || a.name),
        money(a.tin, 'c-in'), money(a.tout, 'c-out'), money(a.balance)]), { onRow: (i) => go(`#/account/${t.accounts.filter((a) => a.active || a.balance)[i].id}`) }),
      h('div', { class: 'actions mt' }, h('a', { class: 'btn sec', href: `#/treasury/${t.facility.id}` }, 'صفحة الخزنة وكشفها'))))));
});

function accountModal(a = null) {
  const facs = S.meta.facilities;
  modal(a ? `تعديل حساب: ${a.label || a.name}` : 'إضافة حساب دفع / مكان استلام الأموال', [
    h('div', { class: 'grid g2' },
      field('اسم الحساب', inp('name', { required: true, value: a?.name }), { req: true, hint: 'مثال: بنك فلسطين، بال باي، كاش المكتب' }),
      field('اسم صاحب الحساب (اختياري)', inp('holder', { value: a?.holder }), { hint: 'يظهر هكذا: بنك فلسطين — فلان' })),
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
        canWrite() ? h('button', { class: 'btn in', onclick: () => moneyModal('income', f.id) }, '+ إيداع') : '',
        canWrite() ? h('button', { class: 'btn out', onclick: () => moneyModal('expense', f.id) }, '+ مصروف') : '',
        h('a', { class: 'btn sec', href: `#/statement?facility_id=${f.id}` }, 'كشف الخزنة PDF'))),
    h('div', { class: 'card tight' }, h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); go(`#/treasury/${fid}${qs({ from: from.value, to: to.value })}`); } },
      field('من', from), field('إلى', to), h('button', { class: 'btn' }, 'عرض'), h('a', { class: 'btn ghost', href: `#/treasury/${fid}` }, 'كل الفترات'))),
    h('div', { class: 'grid g3 kpis big', style: { marginBottom: '8px' } },
      kpi('إجمالي اللي انجمع', money(t.total_in), 'in'), kpi('إجمالي اللي طلع', money(t.total_out), 'out'),
      kpi('اللي ضل', money(t.closing))),
    t.opening ? h('p', { class: 'hint' }, `اللي ضل يشمل رصيداً سابقاً بقيمة ${fmt(t.opening)}`) : '',
    h('div', { class: 'card' }, h('h3', null, 'وين المصاري'), methodTable(t.by_method),
      h('h3', { class: 'mt' }, 'تفصيل الحسابات'),
      table(['الحساب', 'النوع', 'انجمع', 'طلع', 'ضل', ''], t.accounts.map((a) => [
        h('span', null, '📍 ', a.label || a.name, a.active ? '' : ' (معطل)', a.phone ? h('span', { class: 'hint' }, ` ${a.phone}`) : ''), S.L.accountType[a.type],
        money(a.tin, 'c-in'), money(a.tout, 'c-out'), money(a.balance),
        isAdmin() ? h('button', { class: 'btn sm ghost', onclick: (e) => { e.stopPropagation(); accountModal(a); } }, 'تعديل') : '']),
      { onRow: (i) => go(`#/account/${t.accounts[i].id}`) })),
    h('h2', null, 'التوضيح'),
    h('div', { class: 'card' }, h('h3', null, 'جميع عمليات الإيداع والصرف'), txnsTable(t.txns)));
});

route(/^\/account\/(\d+)$/, async (id) => {
  const q = hashQuery();
  const s = await GET(`/accounts/${id}/statement${qs({ from: q.from, to: q.to })}`);
  const a = s.account;
  const from = h('input', { type: 'date', value: q.from || '' });
  const to = h('input', { type: 'date', value: q.to || '' });
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, `📍 ${a.label || a.name}`), h('div', { class: 'hint' }, `${a.facility_name} · ${S.L.accountType[a.type]}${a.phone ? ` · ${a.phone}` : ''}`)),
      h('div', { class: 'actions' },
        isAdmin() ? h('button', { class: 'btn sec', onclick: () => accountModal(a) }, 'تعديل') : '',
        seesAll() ? h('a', { class: 'btn', href: `#/statement?account_id=${a.id}` }, 'كشف الحساب PDF') : '')),
    a.notes ? h('div', { class: 'card tight' }, a.notes) : '',
    h('div', { class: 'card tight' }, h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); go(`#/account/${id}${qs({ from: from.value, to: to.value })}`); } },
      field('من', from), field('إلى', to), h('button', { class: 'btn' }, 'عرض'))),
    h('div', { class: 'grid g3 kpis big', style: { marginBottom: '16px' } },
      kpi('إجمالي اللي انجمع', money(s.total_in), 'in'), kpi('إجمالي اللي طلع', money(s.total_out), 'out'), kpi('اللي ضل', money(s.closing))),
    s.opening ? h('p', { class: 'hint' }, `يشمل رصيداً سابقاً بقيمة ${fmt(s.opening)}`) : '',
    h('div', { class: 'card' }, table(['الرقم', 'التاريخ', 'النوع', 'من / إلى', 'المرجع', 'داخل', 'خارج', 'الرصيد', 'الموظف', 'ملاحظات'],
      s.rows.map((t) => [noTag(t.no), t.op_date, txnLabel(t) + (t.category && t.kind !== 'payment' ? ` — ${t.category}` : ''), t.party || '', noTag(t.ref_no),
        t.direction === 'in' ? money(t.amount, 'c-in') : '', t.direction === 'out' ? money(t.amount, 'c-out') : '', money(t.running), t.user_name,
        t.status === 'cancelled' ? `ملغاة: ${t.cancel_reason}` : (t.notes || '')]),
      { onRow: (i) => go(`#/txn/${s.rows[i].id}`), rowClass: (i) => (s.rows[i].status === 'cancelled' ? 'cancelled' : ''), empty: 'لا توجد عمليات' })));
});

// ---------- الديون علينا (لمين ندين) ----------
const DEBT_ST = { open: ['partial', 'قائم'], partial: ['partial', 'مسدد جزئياً'], settled: ['paid', 'تم السداد ✔'], cancelled: ['cancelled', 'ملغي'] };

function addDebtModal(presetFid) {
  const facs = S.meta.facilities.filter((f) => f.kind !== 'general');
  const facSel = sel('facility_id', facs.map((f) => [f.id, f.name]), presetFid);
  const recv = sel('received', [['yes', 'نعم، استلمنا المبلغ'], ['no', 'لا — شراء أو خدمة بالدين']]);
  const accBox = h('div');
  const setAcc = () => {
    accBox.innerHTML = '';
    if (recv.value === 'yes') accBox.append(field('وين وصل المبلغ', accountSel(facSel.value), { req: true }));
  };
  facSel.onchange = setAcc;
  recv.onchange = setAcc;
  setAcc();
  modal('تسجيل دين على منشأة', [
    h('p', { class: 'hint' }, 'الدين يبقى ظاهراً على المنشأة حتى يُسدد بالكامل، ولا يُخصم تلقائياً من أي حساب.'),
    field('الدين على', facSel, { req: true }),
    field('لمين الدين (اسم الشخص أو الجهة)', inp('party', { required: true }), { req: true }),
    h('div', { class: 'grid g2' }, field('المبلغ', moneyInp('amount', { required: true }), { req: true }), field('التاريخ', dateInp('op_date'))),
    field('سبب الدين', area('reason'), { req: true }),
    field('هل استلمنا المبلغ كمصاري؟', recv), accBox,
    field('ملاحظات', area('notes')),
  ], async (d, idem) => {
    const r = await api('POST', '/fundings', d, { idem });
    closeModal(); toast(`تم تسجيل الدين برقم ${r.no}`, 'ok'); reload();
  });
}

function repayDebtModal(f) {
  modal(`سداد دين ${f.no} — ${f.party}`, [
    h('p', null, 'المتبقي: ', money(f.outstanding, 'c-debt')),
    field('المبلغ', moneyInp('amount', { value: major(f.outstanding), required: true }), { req: true }),
    field('من وين طلع المبلغ', accountSel(f.facility_id), { req: true }),
    field('التاريخ', dateInp('op_date')),
    field('سبب / تفاصيل السداد', area('reason'), { req: true }),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'allow_negative' }), 'السماح حتى لو كان الرصيد غير كافٍ'),
  ], async (d, idem) => {
    const r = await api('POST', `/fundings/${f.id}/repay`, d, { idem });
    closeModal(); toast(r.settled ? 'تم السداد بالكامل ✔' : `تم تسجيل السداد — المتبقي ${fmt(r.remaining)}`, 'ok'); reload();
  }, { submitText: 'تسجيل السداد' });
}

// قائمة الديون علينا: كل دين مع سببه ودفعات سداده وأسبابها
function debtsOwedList(rows) {
  if (!rows.length) return h('div', { class: 'empty' }, 'لا توجد ديون علينا');
  return h('div', null, rows.map((f) => {
    const [cls, label] = DEBT_ST[f.status === 'cancelled' ? 'cancelled' : f.debt_status];
    const pays = f.txns.filter((t) => t.kind === 'funding_repay');
    return h('div', { class: 'card tight', style: { border: '1px solid var(--line)', boxShadow: 'none', opacity: f.status === 'cancelled' ? 0.6 : 1 } },
      h('div', { class: 'row' }, noTag(f.no), h('b', null, `دين على ${f.facility_name} لصالح ${f.party}`), badge(cls, label), h('span', { class: 'sp' }),
        canWrite() && f.status === 'active' && f.outstanding > 0 ? h('button', { class: 'btn sm in', onclick: () => repayDebtModal(f) }, 'سداد') : '',
        canCancel() && f.status === 'active' ? h('button', { class: 'btn sm danger', onclick: () => modal(`إلغاء الدين ${f.no}`, [
          h('p', { class: 'hint' }, 'للتصحيح فقط (دين مسجل بالغلط). يتم إلغاء الدين وكل حركاته مع الاحتفاظ بالسجل.'), field('سبب الإلغاء', area('reason'), { req: true })],
        async (d, idem) => { await api('POST', `/fundings/${f.id}/cancel`, d, { idem }); closeModal(); reload(); }, { submitText: 'تأكيد الإلغاء', submitClass: 'out' }) }, 'إلغاء') : ''),
      h('div', { class: 'grid g4 mt' },
        h('div', null, h('div', { class: 'hint' }, 'المبلغ'), money(f.amount)),
        h('div', null, h('div', { class: 'hint' }, 'تم سداده'), money(f.repaid, 'c-in')),
        h('div', null, h('div', { class: 'hint' }, 'المتبقي'), money(f.outstanding, 'c-debt')),
        h('div', null, h('div', { class: 'hint' }, 'التاريخ'), f.op_date)),
      h('p', null, h('b', null, 'سبب الدين: '), f.reason || f.notes || '—'),
      h('p', { class: 'hint' }, f.account_name ? `وصل المبلغ إلى: ${f.account_name}` : 'لم يدخل الصندوق (شراء/خدمة بالدين)', ` · سجله ${f.user_name}`),
      pays.length ? table(['الرقم', 'تاريخ السداد', 'المبلغ', 'من وين طلع', 'سبب السداد', 'الموظف'],
        pays.map((t) => [noTag(t.no), t.op_date, money(t.amount, 'c-out'), t.account_name, t.status === 'cancelled' ? `ملغاة: ${t.cancel_reason}` : (t.notes || ''), t.user_name]),
        { rowClass: (i) => (pays[i].status === 'cancelled' ? 'cancelled' : '') }) : h('p', { class: 'hint' }, 'لم يُسدد شيء بعد'),
      f.status === 'cancelled' ? h('p', { class: 'c-out' }, `ملغي: ${f.cancel_reason}`) : '');
  }));
}

route(/^\/fundings$/, async () => {
  const rows = await GET('/fundings');
  const live = rows.filter((f) => f.status === 'active');
  const open = live.filter((f) => f.outstanding > 0);
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, 'الديون علينا'), canWrite() ? h('button', { class: 'btn', onclick: () => addDebtModal() }, '+ تسجيل دين على منشأة') : ''),
    h('div', { class: 'grid g3 kpis', style: { marginBottom: '16px' } },
      kpi('ديون علينا لم تُسدد', money(open.reduce((x, f) => x + f.outstanding, 0)), 'out'),
      kpi('عدد الديون القائمة', open.length, 'plain'),
      kpi('إجمالي ما تم سداده', money(live.reduce((x, f) => x + f.repaid, 0)), 'in')),
    h('div', { class: 'tabs' }, h('a', { href: '#/debts' }, 'ديون الزبائن لنا'), h('a', { href: '#/fundings', class: 'on' }, 'الديون علينا')),
    debtsOwedList(rows));
});
