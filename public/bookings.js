/* الصالة والملعب */
'use strict';

const facOf = (kind) => S.meta.facilities.find((f) => f.kind === kind);
const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function sectionTabs(kind, active) {
  const f = facOf(kind);
  const tabs = kind === 'hall'
    ? [['#/hall', 'الحجوزات'], ['#/hall/new', '+ حجز جديد'], ['#/hall/calendar', 'التقويم'], [`#/finance/${f.id}`, 'الإيداعات والمصروفات'], [`#/treasury/${f.id}`, 'الخزنة'], ['#/fundings', 'الديون علينا']]
    : [['#/field', 'الحجوزات'], ['#/field/new', '+ حجز جديد'], ['#/field/schedule', 'الجدول'], [`#/finance/${f.id}`, 'الإيداعات والمصروفات'], [`#/treasury/${f.id}`, 'الخزنة'], ['#/fundings', 'الديون علينا']];
  return h('div', { class: 'tabs' }, tabs.map(([href, l]) => h('a', { href, class: href === active ? 'on' : '' }, l)));
}

function bookingFilters(onApply, { dateLabel }) {
  const q = h('input', { placeholder: 'بحث بالاسم أو الهاتف أو الرقم' });
  const st = sel('status', [['', 'كل الحالات'], ['confirmed', 'حجز مؤكد'], ['paid', 'مكتمل الدفع'], ['cancelled', 'ملغي']]);
  const df = sel('date_field', [['event', dateLabel], ['reg', 'تاريخ التسجيل']]);
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date' });
  const apply = () => onApply({ q: q.value, status: st.value, date_field: df.value, from: from.value, to: to.value });
  const form = h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); apply(); } },
    field('بحث', q), field('الحالة', st), field('حسب', df), field('من', from), field('إلى', to), h('button', { class: 'btn' }, 'عرض'));
  return form;
}

// ======================= الصالة =======================
route(/^\/hall$/, async () => {
  const listBox = h('div');
  const load = async (f = {}) => {
    const rows = await GET(`/hall/bookings${qs(f)}`);
    listBox.innerHTML = '';
    listBox.append(table(['الرقم', 'صاحب الحجز', 'الهاتف', 'تاريخ الفرح', 'الفترة', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة', 'سجله'],
      rows.map((b) => [noTag(b.no), b.customer_name, b.phone || '', b.event_date, S.L.period[b.period], money(b.total), money(b.paid, 'c-in'),
        money(b.remaining, 'c-debt'), bStatus(b.status), b.user_name]),
      { onRow: (i) => go(`#/hall/b/${rows[i].id}`), empty: 'لا توجد حجوزات', rowClass: (i) => (rows[i].status === 'cancelled' ? 'cancelled' : '') }));
  };
  await load({ from: addDays(today(), -30) });
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, '💍 صالة الأفراح'), h('a', { class: 'btn lg', href: '#/hall/new' }, '+ حجز جديد')),
    sectionTabs('hall', '#/hall'),
    h('div', { class: 'card' }, bookingFilters(load, { dateLabel: 'تاريخ الفرح' }), h('p', { class: 'hint' }, 'افتراضياً: الحجوزات من آخر 30 يوماً وما بعدها'), listBox));
});

function hallForm(b = {}, pre = {}) {
  const f = facOf('hall');
  const isNew = !b.id;
  const total = moneyInp('total', { required: true, value: b.total ? major(b.total) : '' });
  const deposit = moneyInp('deposit', { required: true });
  const remain = h('b', { class: 'c-debt' }, '0');
  const upd = () => { remain.textContent = fmt(Math.round((Number(total.value) || 0) * 100) - Math.round((Number(deposit.value) || 0) * 100)); };
  total.oninput = upd;
  deposit.oninput = upd;
  return [
    h('div', { class: 'grid g2' },
      field('اسم صاحب الحجز', inp('customer_name', { required: true, value: b.customer_name }), { req: true }),
      field('رقم الهاتف', inp('phone', { type: 'tel', value: b.phone, dir: 'ltr' })),
      field('تاريخ الفرح', dateInp('event_date', b.event_date || pre.date || ''), { req: true }),
      field('الفترة', sel('period', [['evening', 'مسائية'], ['morning', 'صباحية']], b.period || pre.period || 'evening')),
      field('تاريخ تسجيل الحجز', dateInp('reg_date', b.reg_date), { hint: 'يمكن تعديله لإدخال حجوزات قديمة' }),
      field('السعر الإجمالي المتفق عليه', total, { req: true })),
    isNew ? h('div', { class: 'card tight', style: { background: '#f7f9fc' } },
      h('h3', null, 'العربون (إلزامي)'),
      h('div', { class: 'grid g3' },
        field('قيمة العربون', deposit, { req: true }),
        field('تاريخ دفع العربون', dateInp('deposit_date')),
        field('وين وصل العربون', accountSel(f.id), { req: true })),
      h('div', null, 'المبلغ المتبقي: ', remain)) : '',
    field('ملاحظات', area('notes', b.notes)),
    extraBox(b.extra),
  ];
}

route(/^\/hall\/new$/, async () => {
  const pre = hashQuery();
  const idem = uuid();
  const btn = h('button', { class: 'btn lg in' }, 'حفظ الحجز');
  const form = h('form', { class: 'card' }, hallForm({}, pre), btn);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const r = await api('POST', '/hall/bookings', formData(form), { idem });
      toast(`تم حفظ الحجز برقم ${r.no}`, 'ok');
      go(`#/hall/b/${r.id}`);
    } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
  };
  return h('div', null, h('div', { class: 'page-head' }, h('h1', null, 'حجز صالة جديد')), sectionTabs('hall', '#/hall/new'), form);
});

route(/^\/hall\/b\/(\d+)$/, async (id) => {
  const b = await GET(`/hall/bookings/${id}`);
  const f = facOf('hall');
  const live = b.status !== 'cancelled';
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, 'حجز الصالة ', noTag(b.no), ' ', bStatus(b.status)),
      h('div', { class: 'actions' },
        live && b.remaining > 0 ? h('button', { class: 'btn in', onclick: () => payModal({ title: `دفعة لحجز ${b.no}`, url: `/hall/bookings/${b.id}/payments`, facilityId: f.id, remaining: b.remaining }) }, '+ إضافة دفعة') : '',
        live ? h('button', { class: 'btn sec', onclick: () => editHall(b) }, 'تعديل') : '',
        live && canCancel() ? h('button', { class: 'btn danger', onclick: () => cancelRefModal({ title: `إلغاء الحجز ${b.no}`, url: `/hall/bookings/${b.id}/cancel`, facilityId: f.id, paid: b.paid - b.refunded }) }, 'إلغاء الحجز') : '')),
    h('div', { class: 'grid g4 kpis', style: { marginBottom: '16px' } },
      kpi('السعر الإجمالي', money(b.total)), kpi('المدفوع', money(b.paid), 'in'), kpi('المتبقي', money(b.remaining), 'debt'),
      b.refunded ? kpi('المرتجع', money(b.refunded), 'out') : kpi('تاريخ الفرح', `${b.event_date} — ${S.L.period[b.period]}`, 'plain')),
    h('div', { class: 'card' }, h('dl', { class: 'kv' },
      h('dt', null, 'صاحب الحجز'), h('dd', null, b.customer_name),
      h('dt', null, 'الهاتف'), h('dd', { dir: 'ltr', style: { textAlign: 'right' } }, b.phone || '—'),
      h('dt', null, 'تاريخ الفرح'), h('dd', null, `${b.event_date} — فترة ${S.L.period[b.period]}`),
      h('dt', null, 'تاريخ التسجيل'), h('dd', null, b.reg_date),
      h('dt', null, 'سجله'), h('dd', null, `${b.user_name} — ${dt(b.created_at)}`),
      h('dt', null, 'ملاحظات'), h('dd', null, b.notes || '—'),
      b.extra ? [h('dt', null, 'تفاصيل أخرى'), h('dd', null, b.extra)] : '',
      !live ? [h('dt', null, 'الإلغاء'), h('dd', { class: 'c-out' }, `${b.cancelled_by_name} — ${dt(b.cancelled_at)} — ${S.L.cancelAction[b.cancel_action] || ''} — ${b.cancel_reason}`)] : '')),
    h('div', { class: 'card' }, h('h3', null, 'كشف الدفعات'), paymentsTable(b.payments)),
    h('div', { class: 'card' }, h('h3', null, 'سجل التعديلات'), historyList(b.history)));
});

function editHall(b) {
  modal(`تعديل الحجز ${b.no}`, hallForm(b), async (d, idem) => {
    await api('PUT', `/hall/bookings/${b.id}`, d, { idem });
    closeModal();
    toast('تم التعديل', 'ok');
    reload();
  }, { wide: true });
}

route(/^\/hall\/calendar$/, async () => {
  const q = hashQuery();
  const month = q.m || today().slice(0, 7);
  const rows = await GET(`/hall/calendar?month=${month}`);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const shift = (n) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const grid = h('div', { class: 'cal' }, DAY_NAMES.map((d) => h('div', { class: 'dh' }, d)));
  for (let i = 0; i < first.getUTCDay(); i++) grid.append(h('div', { class: 'day other' }));
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const cell = h('div', { class: `day ${date === today() ? 'today' : ''}` }, h('div', { class: 'dn' }, d));
    for (const p of ['morning', 'evening']) {
      const b = rows.find((x) => x.event_date === date && x.period === p);
      cell.append(b
        ? h('div', { class: `slot busy ${b.status === 'paid' ? 'paid' : ''}`, title: `${b.no} ${b.customer_name}`, onclick: () => go(`#/hall/b/${b.id}`) }, `${S.L.period[p]}: ${b.customer_name}`)
        : h('div', { class: 'slot free', onclick: () => go(`#/hall/new?date=${date}&period=${p}`) }, `${S.L.period[p]}: متاح`));
    }
    grid.append(cell);
  }
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, 'تقويم الصالة')),
    sectionTabs('hall', '#/hall/calendar'),
    h('div', { class: 'card' },
      h('div', { class: 'row', style: { marginBottom: '10px' } },
        h('a', { class: 'btn sm sec', href: `#/hall/calendar?m=${shift(-1)}` }, '→ السابق'),
        h('h2', { style: { margin: 0, flex: 1, textAlign: 'center' } }, month),
        h('a', { class: 'btn sm sec', href: `#/hall/calendar?m=${shift(1)}` }, 'التالي ←')),
      h('p', { class: 'hint' }, 'اضغط على فترة متاحة لإضافة حجز. البرتقالي = حجز مؤكد، الأخضر = مكتمل الدفع.'),
      grid));
});

// ======================= الملعب =======================
route(/^\/field$/, async () => {
  const listBox = h('div');
  const load = async (f = {}) => {
    const rows = await GET(`/field/bookings${qs(f)}`);
    listBox.innerHTML = '';
    listBox.append(table(['الرقم', 'الاسم', 'تاريخ اللعب', 'الوقت', 'الساعات', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة', 'سجله'],
      rows.map((b) => [noTag(b.no), b.customer_name, b.play_date, `${b.start_time} - ${b.end_time}`, (b.minutes / 60).toFixed(2).replace(/\.?0+$/, ''),
        money(b.total), money(b.paid, 'c-in'), money(b.remaining, 'c-debt'), bStatus(b.status), b.user_name]),
      { onRow: (i) => go(`#/field/b/${rows[i].id}`), empty: 'لا توجد حجوزات', rowClass: (i) => (rows[i].status === 'cancelled' ? 'cancelled' : '') }));
  };
  await load({ from: addDays(today(), -7) });
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, '⚽ ملعب كرة القدم'), h('a', { class: 'btn lg', href: '#/field/new' }, '+ حجز جديد')),
    sectionTabs('field', '#/field'),
    h('div', { class: 'card' }, bookingFilters(load, { dateLabel: 'تاريخ اللعب' }), h('p', { class: 'hint' }, 'افتراضياً: الحجوزات من آخر 7 أيام وما بعدها'), listBox));
});

function fieldForm(b = {}, pre = {}) {
  const f = facOf('field');
  const isNew = !b.id;
  const start = inp('start_time', { type: 'time', required: true, value: b.start_time || pre.start || '' });
  const end = inp('end_time', { type: 'time', required: true, value: b.end_time || pre.end || '' });
  const price = moneyInp('hour_price', { required: true, value: b.id ? major(b.hour_price) : (S.meta.field.hour_price ? major(S.meta.field.hour_price) : '') });
  const total = moneyInp('total', { required: true, value: b.total ? major(b.total) : '' });
  const hours = h('b', null, '0');
  const deposit = moneyInp('deposit', { required: true });
  const remain = h('b', { class: 'c-debt' }, '0');
  const calc = (setTotal) => {
    if (start.value && end.value) {
      const toM = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      let mins = toM(end.value) - toM(start.value);
      if (mins <= 0) mins += 1440;
      hours.textContent = (mins / 60).toFixed(2).replace(/\.?0+$/, '') + (toM(end.value) <= toM(start.value) ? ' (ينتهي بعد منتصف الليل)' : '');
      if (setTotal && price.value !== '') total.value = Math.round((mins / 60) * Number(price.value) * 100) / 100;
    }
    remain.textContent = fmt(Math.round((Number(total.value) || 0) * 100) - Math.round((Number(deposit.value) || 0) * 100));
  };
  start.oninput = end.oninput = price.oninput = () => calc(true);
  total.oninput = deposit.oninput = () => calc(false);
  setTimeout(() => calc(!b.id), 0);
  return [
    h('div', { class: 'grid g2' },
      field('اسم الشخص الذي حجز', inp('customer_name', { required: true, value: b.customer_name }), { req: true }),
      field('رقم الهاتف', inp('phone', { type: 'tel', value: b.phone, dir: 'ltr' })),
      field('تاريخ اللعب', dateInp('play_date', b.play_date || pre.date || ''), { req: true }),
      field('تاريخ تسجيل الحجز', dateInp('reg_date', b.reg_date))),
    h('div', { class: 'grid g4' },
      field('ساعة البداية', start, { req: true }), field('ساعة النهاية', end, { req: true }),
      field('سعر الساعة', price, { req: true }), field('إجمالي السعر', total, { req: true, hint: 'يُحسب تلقائياً ويمكن تعديله' })),
    h('p', null, 'عدد الساعات: ', hours),
    isNew ? h('div', { class: 'card tight', style: { background: '#f7f9fc' } },
      h('h3', null, 'العربون (إلزامي)'),
      h('div', { class: 'grid g3' },
        field('قيمة العربون', deposit, { req: true }),
        field('تاريخ الدفع', dateInp('deposit_date')),
        field('وين وصل المبلغ', accountSel(f.id), { req: true })),
      h('div', null, 'المبلغ المتبقي: ', remain)) : '',
    field('ملاحظات', area('notes', b.notes)),
    extraBox(b.extra),
  ];
}

route(/^\/field\/new$/, async () => {
  const pre = hashQuery();
  const idem = uuid();
  const btn = h('button', { class: 'btn lg in' }, 'حفظ الحجز');
  const form = h('form', { class: 'card' }, fieldForm({}, pre), btn);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const r = await api('POST', '/field/bookings', formData(form), { idem });
      toast(`تم حفظ الحجز برقم ${r.no}`, 'ok');
      go(`#/field/b/${r.id}`);
    } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
  };
  return h('div', null, h('div', { class: 'page-head' }, h('h1', null, 'حجز ملعب جديد')), sectionTabs('field', '#/field/new'), form);
});

route(/^\/field\/b\/(\d+)$/, async (id) => {
  const b = await GET(`/field/bookings/${id}`);
  const f = facOf('field');
  const live = b.status !== 'cancelled';
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, 'حجز الملعب ', noTag(b.no), ' ', bStatus(b.status)),
      h('div', { class: 'actions' },
        live && b.remaining > 0 ? h('button', { class: 'btn in', onclick: () => payModal({ title: `دفعة لحجز ${b.no}`, url: `/field/bookings/${b.id}/payments`, facilityId: f.id, remaining: b.remaining }) }, '+ إضافة دفعة') : '',
        live ? h('button', { class: 'btn sec', onclick: () => modal(`تعديل الحجز ${b.no}`, fieldForm(b), async (d, idem) => {
          await api('PUT', `/field/bookings/${b.id}`, d, { idem }); closeModal(); toast('تم التعديل', 'ok'); reload();
        }, { wide: true }) }, 'تعديل') : '',
        live && canCancel() ? h('button', { class: 'btn danger', onclick: () => cancelRefModal({ title: `إلغاء الحجز ${b.no}`, url: `/field/bookings/${b.id}/cancel`, facilityId: f.id, paid: b.paid - b.refunded }) }, 'إلغاء الحجز') : '')),
    h('div', { class: 'grid g4 kpis', style: { marginBottom: '16px' } },
      kpi('إجمالي السعر', money(b.total)), kpi('المدفوع', money(b.paid), 'in'), kpi('المتبقي', money(b.remaining), 'debt'),
      kpi('الموعد', `${b.play_date} ${b.start_time}-${b.end_time}`, 'plain')),
    h('div', { class: 'card' }, h('dl', { class: 'kv' },
      h('dt', null, 'الاسم'), h('dd', null, b.customer_name),
      h('dt', null, 'الهاتف'), h('dd', null, b.phone || '—'),
      h('dt', null, 'عدد الساعات'), h('dd', null, (b.minutes / 60).toFixed(2).replace(/\.?0+$/, '')),
      h('dt', null, 'سعر الساعة'), h('dd', null, money(b.hour_price)),
      h('dt', null, 'تاريخ التسجيل'), h('dd', null, b.reg_date),
      h('dt', null, 'سجله'), h('dd', null, `${b.user_name} — ${dt(b.created_at)}`),
      h('dt', null, 'ملاحظات'), h('dd', null, b.notes || '—'),
      b.extra ? [h('dt', null, 'تفاصيل أخرى'), h('dd', null, b.extra)] : '',
      !live ? [h('dt', null, 'الإلغاء'), h('dd', { class: 'c-out' }, `${b.cancelled_by_name} — ${dt(b.cancelled_at)} — ${S.L.cancelAction[b.cancel_action] || ''} — ${b.cancel_reason}`)] : '')),
    h('div', { class: 'card' }, h('h3', null, 'كشف الدفعات'), paymentsTable(b.payments)),
    h('div', { class: 'card' }, h('h3', null, 'سجل التعديلات'), historyList(b.history)));
});

// جدول يومي/أسبوعي يوضح الأوقات المتاحة والمحجوزة
route(/^\/field\/schedule$/, async () => {
  const q = hashQuery();
  const mode = q.mode === 'week' ? 'week' : 'day';
  const from = q.d || today();
  const days = mode === 'week' ? 7 : 1;
  const data = await GET(`/field/schedule?from=${from}&days=${days}`);
  const toM = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const open = toM(data.open);
  let close = toM(data.close);
  if (close <= open) close += 1440;
  const slots = [];
  for (let m = open; m < close; m += 60) slots.push(m);
  const hhmm = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const findB = (date, m) => {
    const s = `${m >= 1440 ? addDays(date, 1) : date}T${hhmm(m)}`;
    const e = `${m + 60 >= 1440 ? addDays(date, 1) : date}T${hhmm(m + 60)}`;
    return data.bookings.find((b) => b.start_at < e && b.end_at > s);
  };
  const grid = h('div', { class: 'sched', style: { gridTemplateColumns: `70px repeat(${days}, minmax(${days > 1 ? '90px' : '160px'}, 1fr))` } },
    h('div', { class: 'h' }, 'الساعة'), dates.map((d) => h('div', { class: 'h' }, DAY_NAMES[new Date(d + 'T00:00:00Z').getUTCDay()], h('br'), d.slice(5))));
  for (const m of slots) {
    grid.append(h('div', { class: 'h' }, hhmm(m)));
    for (const d of dates) {
      const b = findB(d, m);
      grid.append(b
        ? h('div', { class: `cell busy ${b.status === 'paid' ? 'paid' : ''}`, title: `${b.no} ${b.customer_name} ${b.start_time}-${b.end_time}`, onclick: () => go(`#/field/b/${b.id}`) }, b.customer_name)
        : h('div', { class: 'cell', onclick: () => go(`#/field/new?date=${m >= 1440 ? addDays(d, 1) : d}&start=${hhmm(m)}&end=${hhmm(m + 60)}`) }, 'متاح'));
    }
  }
  const step = mode === 'week' ? 7 : 1;
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, 'جدول الملعب')),
    sectionTabs('field', '#/field/schedule'),
    h('div', { class: 'card' },
      h('div', { class: 'row', style: { marginBottom: '10px' } },
        h('a', { class: 'btn sm sec', href: `#/field/schedule?mode=${mode}&d=${addDays(from, -step)}` }, '→ السابق'),
        h('input', { type: 'date', value: from, style: { maxWidth: '170px' }, onchange: (e) => go(`#/field/schedule?mode=${mode}&d=${e.target.value}`) }),
        h('a', { class: 'btn sm sec', href: `#/field/schedule?mode=${mode}&d=${addDays(from, step)}` }, 'التالي ←'),
        h('span', { class: 'sp' }),
        h('a', { class: `btn sm ${mode === 'day' ? '' : 'ghost'}`, href: `#/field/schedule?mode=day&d=${from}` }, 'يومي'),
        h('a', { class: `btn sm ${mode === 'week' ? '' : 'ghost'}`, href: `#/field/schedule?mode=week&d=${from}` }, 'أسبوعي')),
      h('p', { class: 'hint' }, `ساعات العمل ${data.open} — ${data.close}. اضغط على وقت متاح لإضافة حجز.`),
      h('div', { class: 'tbl-wrap', style: { border: 0 } }, grid)));
});
