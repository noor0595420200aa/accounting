/* المغسلة والزبائن والديون */
'use strict';

function laundryTabs(active) {
  const f = facOf('laundry');
  return h('div', { class: 'tabs' }, [
    ['#/laundry', 'طلب جديد + طلبات اليوم'], ['#/laundry/orders', 'كل الطلبات'], ['#/laundry/customers', 'الزبائن'],
    ['#/debts', 'الديون'], [`#/finance/${f.id}`, 'الإيداعات والمصروفات'], [`#/treasury/${f.id}`, 'الخزنة'],
  ].map(([href, l]) => h('a', { href, class: href === active ? 'on' : '' }, l)));
}

const custName = (o) => o.customer_name + (o.customer_tag ? ` - ${o.customer_tag}` : '');

function ordersTable(rows) {
  return table(['الرقم', 'التاريخ', 'الخدمة', 'الزبون', 'السعر', 'المدفوع', 'المتبقي', 'الحالة', 'سجله'],
    rows.map((o) => [noTag(o.no), o.order_date, o.service_name, custName(o), money(o.price), money(o.paid, 'c-in'), money(o.remaining, 'c-debt'), oStatus(o.status), o.user_name]),
    { onRow: (i) => go(`#/laundry/o/${rows[i].id}`), empty: 'لا توجد طلبات', rowClass: (i) => (rows[i].status === 'cancelled' ? 'cancelled' : ''),
      foot: rows.length ? ['', '', '', 'الإجمالي', money(rows.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.price, 0)),
        money(rows.reduce((s, o) => s + o.paid, 0), 'c-in'), money(rows.reduce((s, o) => s + o.remaining, 0), 'c-debt'), '', ''] : null });
}

// اختيار الزبون: بحث في الزبائن الموجودين، أو إضافة زبون جديد مع وصف مميز عند تشابه الأسماء
function customerPicker() {
  const hidden = h('input', { type: 'hidden', name: 'customer_id' });
  const name = h('input', { name: 'customer_name', placeholder: 'اكتب اسم الزبون…', autocomplete: 'off', required: true });
  const tag = h('input', { name: 'customer_tag', placeholder: 'مثال: السوق، أبو محمد' });
  const tagBox = h('div', { class: 'hide' }, field('وصف مميز للزبون الجديد (اختياري)', tag, { hint: 'يُستخدم للتفريق بين زبونين بنفس الاسم' }));
  const info = h('div', { class: 'hint' });
  const list = h('div', { class: 'ac-list hide' });
  let timer;
  const pick = (c) => {
    hidden.value = c.id;
    name.value = c.name + (c.tag ? ` - ${c.tag}` : '');
    list.classList.add('hide');
    tagBox.classList.add('hide');
    info.innerHTML = '';
    info.append('زبون مسجل', c.debt ? h('span', { class: 'c-debt' }, ` — عليه دين ${fmt(c.debt)}`) : '');
  };
  name.oninput = () => {
    hidden.value = '';
    info.textContent = name.value.trim() ? 'زبون جديد — سيتم إنشاؤه' : '';
    tagBox.classList.toggle('hide', !name.value.trim());
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = name.value.trim();
      if (!q) { list.classList.add('hide'); return; }
      const rows = await GET(`/laundry/customers${qs({ q })}`);
      list.innerHTML = '';
      for (const c of rows) {
        list.append(h('div', { onmousedown: (e) => { e.preventDefault(); pick(c); } },
          h('span', null, c.name, c.tag ? h('span', { class: 'c-muted' }, ` - ${c.tag}`) : ''), c.debt ? h('span', { class: 'c-debt num' }, fmt(c.debt)) : ''));
      }
      list.classList.toggle('hide', !rows.length);
    }, 200);
  };
  name.onblur = () => setTimeout(() => list.classList.add('hide'), 150);
  return h('div', null, h('div', { class: 'ac' }, field('اسم الزبون', name, { req: true }), list), hidden, info, tagBox);
}

async function orderForm(onSaved) {
  const f = facOf('laundry');
  const services = await GET('/laundry/services');
  const svcId = h('input', { type: 'hidden', name: 'service_id' });
  const price = moneyInp('price', { required: true });
  const paid = moneyInp('paid_now', { value: 0 });
  const status = h('b');
  const upd = () => {
    const p = Math.round((Number(price.value) || 0) * 100);
    const d = Math.round((Number(paid.value) || 0) * 100);
    status.className = d >= p && p > 0 ? 'c-in' : d > 0 ? 'c-debt' : 'c-out';
    status.textContent = p <= 0 ? '' : d >= p ? 'مدفوع' : d > 0 ? `دفع جزئي — المتبقي ${fmt(p - d)} يسجل ديناً` : `غير مدفوع — ${fmt(p)} يسجل ديناً على الزبون`;
  };
  price.oninput = paid.oninput = upd;
  const btns = h('div', { class: 'svc-btns' }, services.map((s) => h('button', {
    type: 'button', class: 'btn lg sec',
    onclick: (e) => {
      svcId.value = s.id;
      btns.querySelectorAll('.btn').forEach((b) => b.classList.remove('sel'));
      e.currentTarget.classList.add('sel');
      if (s.default_price && !price.value) price.value = major(s.default_price);
      upd();
    },
  }, s.name)));
  const full = h('button', { type: 'button', class: 'btn sm sec', onclick: () => { paid.value = price.value; upd(); } }, 'دفع كامل');
  let idem = uuid();
  const btn = h('button', { class: 'btn lg in' }, 'حفظ الطلب');
  const form = h('form', { class: 'card' },
    h('h3', null, 'طلب جديد'),
    h('div', { class: 'hint', style: { marginBottom: '6px' } }, 'اختر نوع الخدمة:'), btns, svcId,
    h('div', { class: 'grid g2' }, customerPicker(), field('السعر', price, { req: true })),
    h('div', { class: 'grid g2' },
      field('المبلغ المدفوع الآن (مقدماً)', h('div', { class: 'row' }, h('div', { style: { flex: 1 } }, paid), full)),
      field('وين وصل المبلغ', accountSel(f.id))),
    h('p', null, status),
    h('div', { class: 'grid g2' }, field('تاريخ الطلب', dateInp('order_date')), field('ملاحظات', area('notes'))),
    extraBox(), btn);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    const d = formData(form);
    if (!d.service_id) return toast('اختر نوع الخدمة', 'err');
    btn.disabled = true;
    try {
      const r = await api('POST', '/laundry/orders', d, { idem });
      toast(`تم حفظ الطلب برقم ${r.no}`, 'ok');
      idem = uuid();
      onSaved(r);
    } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
  };
  return form;
}

route(/^\/laundry$/, async () => {
  const listBox = h('div');
  const load = async () => {
    const rows = await GET(`/laundry/orders${qs({ from: today(), to: today() })}`);
    listBox.innerHTML = '';
    listBox.append(ordersTable(rows));
  };
  const formBox = h('div');
  const mkForm = async () => { formBox.innerHTML = ''; formBox.append(await orderForm(async () => { await mkForm(); await load(); })); };
  await Promise.all([mkForm(), load()]);
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, '🚗 المغسلة والخدمات'),
      isAdmin() ? h('a', { class: 'btn sec', href: '#/settings?tab=services' }, 'إدارة أنواع الخدمات') : ''),
    laundryTabs('#/laundry'), formBox,
    h('div', { class: 'card' }, h('h3', null, `طلبات اليوم (${today()})`), listBox));
});

route(/^\/laundry\/orders$/, async () => {
  const listBox = h('div');
  const q = h('input', { placeholder: 'اسم الزبون أو رقم الطلب أو الخدمة' });
  const st = sel('status', [['', 'كل الحالات'], ['paid', 'مدفوع'], ['unpaid', 'غير مدفوع'], ['partial', 'دفع جزئي'], ['cancelled', 'ملغي']]);
  const from = h('input', { type: 'date', value: addDays(today(), -30) });
  const to = h('input', { type: 'date' });
  const load = async () => {
    const rows = await GET(`/laundry/orders${qs({ q: q.value, status: st.value, from: from.value, to: to.value })}`);
    listBox.innerHTML = '';
    listBox.append(ordersTable(rows));
  };
  await load();
  return h('div', null, h('div', { class: 'page-head' }, h('h1', null, 'طلبات المغسلة')), laundryTabs('#/laundry/orders'),
    h('div', { class: 'card' }, h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); load(); } },
      field('بحث', q), field('الحالة', st), field('من', from), field('إلى', to), h('button', { class: 'btn' }, 'عرض')), listBox));
});

route(/^\/laundry\/o\/(\d+)$/, async (id) => {
  const o = await GET(`/laundry/orders/${id}`);
  const f = facOf('laundry');
  const live = o.status !== 'cancelled';
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, 'الطلب ', noTag(o.no), ' ', oStatus(o.status)),
      h('div', { class: 'actions' },
        live && o.remaining > 0 ? h('button', { class: 'btn in', onclick: () => payModal({
          title: `دفعة للطلب ${o.no}`, url: `/laundry/orders/${o.id}/payments`, facilityId: f.id, remaining: o.remaining,
          payTypes: [['debt', 'سداد دين'], ['on_pickup', 'دفع عند الاستلام']],
        }) }, '+ تسجيل دفعة') : '',
        live ? h('button', { class: 'btn sec', onclick: () => modal(`تعديل الطلب ${o.no}`, [
          field('السعر', moneyInp('price', { value: major(o.price), required: true })),
          field('تاريخ الطلب', dateInp('order_date', o.order_date)),
          field('ملاحظات', area('notes', o.notes)), extraBox(o.extra),
        ], async (d, idem) => { await api('PUT', `/laundry/orders/${o.id}`, d, { idem }); closeModal(); toast('تم التعديل', 'ok'); reload(); }) }, 'تعديل') : '',
        live && canCancel() ? h('button', { class: 'btn danger', onclick: () => cancelRefModal({ title: `إلغاء الطلب ${o.no}`, url: `/laundry/orders/${o.id}/cancel`, facilityId: f.id, paid: o.paid - o.refunded }) }, 'إلغاء الطلب') : '')),
    h('div', { class: 'grid g3 kpis', style: { marginBottom: '16px' } },
      kpi('السعر', money(o.price)), kpi('المدفوع', money(o.paid), 'in'), kpi('المتبقي (دين)', money(o.remaining), 'debt')),
    h('div', { class: 'card' }, h('dl', { class: 'kv' },
      h('dt', null, 'الخدمة'), h('dd', null, o.service_name),
      h('dt', null, 'الزبون'), h('dd', null, h('a', { href: `#/laundry/c/${o.customer_id}` }, custName(o))),
      h('dt', null, 'تاريخ الطلب'), h('dd', null, o.order_date),
      h('dt', null, 'سجله'), h('dd', null, `${o.user_name} — ${dt(o.created_at)}`),
      h('dt', null, 'ملاحظات'), h('dd', null, o.notes || '—'),
      o.extra ? [h('dt', null, 'تفاصيل أخرى'), h('dd', null, o.extra)] : '',
      !live ? [h('dt', null, 'الإلغاء'), h('dd', { class: 'c-out' }, `${dt(o.cancelled_at)} — ${S.L.cancelAction[o.cancel_action] || ''} — ${o.cancel_reason}`)] : '')),
    h('div', { class: 'card' }, h('h3', null, 'سجل الدفعات'), paymentsTable(o.payments)),
    h('div', { class: 'card' }, h('h3', null, 'سجل التعديلات'), historyList(o.history)));
});

route(/^\/laundry\/customers$/, async () => {
  const listBox = h('div');
  const q = h('input', { placeholder: 'بحث باسم الزبون' });
  const load = async () => {
    const rows = await GET(`/laundry/customers${qs({ q: q.value })}`);
    listBox.innerHTML = '';
    listBox.append(table(['الزبون', 'الوصف المميز', 'الدين الحالي', 'ملاحظات'],
      rows.map((c) => [c.name, c.tag || '', money(c.debt, c.debt ? 'c-debt' : 'c-muted'), c.notes || '']),
      { onRow: (i) => go(`#/laundry/c/${rows[i].id}`) }));
  };
  await load();
  return h('div', null, h('div', { class: 'page-head' }, h('h1', null, 'زبائن المغسلة'),
    h('button', { class: 'btn', onclick: () => modal('زبون جديد', [
      field('اسم الزبون', inp('name', { required: true }), { req: true }),
      field('وصف مميز', inp('tag'), { hint: 'للتفريق بين الزبائن بنفس الاسم' }),
      field('ملاحظات', area('notes'))], async (d, idem) => {
      const r = await api('POST', '/laundry/customers', d, { idem }); closeModal(); go(`#/laundry/c/${r.id}`);
    }) }, '+ زبون جديد')),
  laundryTabs('#/laundry/customers'),
  h('div', { class: 'card' }, h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); load(); } }, field('بحث', q), h('button', { class: 'btn' }, 'بحث')), listBox));
});

function payDebtModal(c, onDone) {
  const f = facOf('laundry');
  payModal({ title: `تسديد دين ${c.name}${c.tag ? ` - ${c.tag}` : ''}`, url: `/laundry/customers/${c.customer_id || c.id}/pay`, facilityId: f.id, remaining: c.debt ?? c.remaining, onDone });
}

route(/^\/laundry\/c\/(\d+)$/, async (id) => {
  const c = await GET(`/laundry/customers/${id}`);
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, `ملف الزبون: ${c.name}${c.tag ? ` - ${c.tag}` : ''}`),
      h('div', { class: 'actions' },
        c.debt > 0 ? h('button', { class: 'btn in', onclick: () => payDebtModal(c) }, 'تسديد دين') : '',
        h('button', { class: 'btn sec', onclick: () => modal('تعديل بيانات الزبون', [
          field('الاسم', inp('name', { value: c.name, required: true })), field('وصف مميز', inp('tag', { value: c.tag })), field('ملاحظات', area('notes', c.notes))],
        async (d, idem) => { await api('PUT', `/laundry/customers/${c.id}`, d, { idem }); closeModal(); reload(); }) }, 'تعديل'))),
    h('div', { class: 'grid g3 kpis', style: { marginBottom: '16px' } },
      kpi('إجمالي الطلبات', money(c.total)), kpi('مجموع ما دفعه', money(c.paid), 'in'), kpi('المتبقي عليه', money(c.debt), 'debt')),
    c.notes ? h('div', { class: 'card tight' }, c.notes) : '',
    h('div', { class: 'card' }, h('h3', null, 'الطلبات'), ordersTable(c.orders)),
    h('div', { class: 'card' }, h('h3', null, 'كل الدفعات'), paymentsTable(c.payments)));
});

// ======================= الديون =======================
route(/^\/debts$/, async () => {
  const [d, owed] = await Promise.all([GET('/laundry/debts'), GET('/fundings')]);
  const owedOpen = owed.filter((f) => f.status === 'active' && f.outstanding > 0);
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, '📒 الديون')),
    h('div', { class: 'tabs' }, h('a', { href: '#/debts', class: 'on' }, 'ديون الزبائن لنا'), h('a', { href: '#/fundings' }, `الديون علينا (${owedOpen.length})`)),
    owedOpen.length ? h('a', { class: 'alert', href: '#/fundings', style: { display: 'flex' } },
      h('span', null, `علينا ${owedOpen.length} دين لم يُسدد بقيمة ${fmt(owedOpen.reduce((x, f) => x + f.outstanding, 0))}: `,
        owedOpen.map((f) => `${f.party} (${f.facility_name})`).join('، ')), h('span', { class: 'btn sm sec' }, 'عرض')) : '',
    h('div', { class: 'grid g3 kpis', style: { marginBottom: '16px' } },
      kpi('إجمالي الديون المستحقة', money(d.total), 'debt'), kpi('عدد الزبائن المديونين', d.customers.length, 'plain'),
      kpi('عدد الطلبات غير المسددة', d.orders.length, 'plain')),
    h('p', { class: 'hint' }, 'الديون أموال مستحقة على الزبائن وليست موجودة في الخزنة.'),
    h('div', { class: 'card' }, h('h3', null, 'الزبائن المديونون'),
      table(['الزبون', 'عدد الطلبات', 'الإجمالي', 'مجموع ما دفعه', 'المتبقي عليه', ''],
        d.customers.map((c) => [c.name + (c.tag ? ` - ${c.tag}` : ''), c.orders, money(c.total), money(c.paid, 'c-in'), money(c.remaining, 'c-debt'),
          canWrite() ? h('button', { class: 'btn sm in', onclick: (e) => { e.stopPropagation(); payDebtModal(c); } }, 'تسديد') : '']),
        { onRow: canWrite() ? (i) => go(`#/laundry/c/${d.customers[i].customer_id}`) : null, empty: 'لا توجد ديون 🎉' })),
    h('div', { class: 'card' }, h('h3', null, 'تفاصيل الطلبات غير المسددة'),
      table(['الطلب', 'الزبون', 'نوع الخدمة', 'تاريخ الطلب', 'المبلغ الإجمالي', 'مجموع المدفوع', 'المتبقي', 'الدفعات (التاريخ — المبلغ — الموظف)'],
        d.orders.map((o) => [noTag(o.no), custName(o), o.service_name, o.order_date, money(o.price), money(o.paid, 'c-in'), money(o.remaining, 'c-debt'),
          o.payments.length ? h('div', null, o.payments.map((p) => h('div', { class: 'hint' }, `${p.op_date} — ${fmt(p.amount)} — ${p.user_name}`))) : 'لا توجد دفعات']),
        { onRow: canWrite() ? (i) => go(`#/laundry/o/${d.orders[i].id}`) : null })));
});
