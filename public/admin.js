/* التقارير وكشف الحساب والمستخدمون والسجل والإعدادات */
'use strict';

function periodPicker(pre = {}) {
  const preset = sel('preset', [['day', 'تقرير يومي'], ['last7', 'آخر 7 أيام / أسبوعي'], ['month', 'تقرير شهري'], ['year', 'تقرير سنوي'],
    ['range', 'بين تاريخين'], ['all', 'شامل من بداية النشاط']], pre.preset || 'day');
  const date = field('التاريخ', h('input', { type: 'date', name: 'date', value: pre.date || today() }));
  const month = field('الشهر', h('input', { type: 'month', name: 'month', value: pre.month || today().slice(0, 7) }));
  const year = field('السنة', h('input', { type: 'number', name: 'year', value: pre.year || today().slice(0, 4), min: 2000, max: 2100 }));
  const from = field('من', h('input', { type: 'date', name: 'from', value: pre.from || today().slice(0, 8) + '01' }));
  const to = field('إلى', h('input', { type: 'date', name: 'to', value: pre.to || today() }));
  const sync = () => {
    const v = preset.value;
    date.classList.toggle('hide', !['day', 'last7'].includes(v));
    date.querySelector('span').textContent = v === 'last7' ? 'حتى تاريخ' : 'التاريخ';
    month.classList.toggle('hide', v !== 'month');
    year.classList.toggle('hide', v !== 'year');
    from.classList.toggle('hide', v !== 'range');
    to.classList.toggle('hide', v !== 'range');
  };
  preset.onchange = sync;
  sync();
  return [field('نوع التقرير / الفترة', preset), date, month, year, from, to];
}

function cleanParams(d) {
  const p = { ...d };
  const keep = { day: ['date'], last7: ['date'], month: ['month'], year: ['year'], range: ['from', 'to'], all: [] }[p.preset] || [];
  for (const k of ['date', 'month', 'year', 'from', 'to']) if (!keep.includes(k)) delete p[k];
  for (const k of Object.keys(p)) if (p[k] === '' || p[k] === false) delete p[k];
  return p;
}

// المدير يختار مين يوصله التقرير (هو، المالك، المجموعة...)
async function pickRecipients(title, onSend) {
  const list = await GET('/reports/recipients');
  if (!list.length) return toast('لا يوجد مستلمون: أدخل أرقام تيليجرام من صفحة المستخدمين', 'err');
  modal(title, [
    h('p', { class: 'hint' }, 'اختر مين يوصله التقرير على تيليجرام:'),
    ...list.map((r) => h('label', { class: 'chk', style: { fontSize: '16px' } }, h('input', { type: 'checkbox', name: `r_${r.id}`, checked: true }), `✈️ ${r.name}`)),
  ], async (d) => {
    const ids = list.filter((r) => d[`r_${r.id}`]).map((r) => r.id);
    if (!ids.length) throw new Error('اختر مستلماً واحداً على الأقل');
    closeModal();
    await onSend(ids);
  }, { submitText: '✈️ إرسال', submitClass: 'in' });
}

function reportActions(form, kind, preview) {
  const params = () => ({ kind, ...cleanParams(formData(form)) });
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; } };
  const view = h('button', { type: 'button', class: 'btn sec', onclick: () => { preview.src = `/api/reports/view${qs(params())}`; preview.classList.remove('hide'); } }, '👁 عرض');
  // كل منشأة ملف مستقل تماماً + الملخص ملف منفصل
  const filesModal = (items, sent) => modal(sent ? 'نتيجة الإرسال عبر Telegram' : 'الملفات الجاهزة', [
    h('p', { class: 'hint' }, items.length > 1 ? 'كل كشف ملف مستقل:' : ''),
    ...items.map((it) => h('div', { class: 'row', style: { borderBottom: '1px solid var(--line)', padding: '8px 0' } },
      h('span', { class: 'sp' }, '📄 ', it.title),
      sent ? (it.sent && it.sent.ok ? badge('sent', `وصل إلى: ${(it.sent.sent_to || []).join('، ') || 'الجميع'}`) : h('span', { class: 'c-out hint' }, `فشل: ${it.sent?.error || ''}`)) : '',
      h('a', { class: 'btn sm sec', href: `/api/reports/${it.id}/pdf`, target: '_blank' }, 'فتح'),
      h('a', { class: 'btn sm ghost', href: `/api/reports/${it.id}/pdf?dl=1` }, 'تنزيل'))),
  ]);
  const pdf = h('button', { type: 'button', class: 'btn', onclick: (e) => busy(e.currentTarget, async () => {
    toast('جارِ إنشاء الملفات…');
    const r = await api('POST', '/reports/generate', params());
    filesModal(r.items, false);
  }) }, '📄 إنشاء PDF');
  const xls = h('button', { type: 'button', class: 'btn sec', onclick: () => { location.href = `/api/reports/excel${qs(params())}`; } }, '📗 Excel');
  const tg = isAdmin() ? h('button', { type: 'button', class: 'btn in', onclick: () => pickRecipients('إرسال التقرير عبر Telegram', async (ids) => {
    toast('جارِ الإنشاء والإرسال…');
    try {
      const r = await api('POST', '/reports/generate', { ...params(), send: true, recipients: ids });
      filesModal(r.items, true);
    } catch (e) { toast(e.message, 'err'); }
  }) }, '✈️ إرسال للبوت (أختار المدة ومين يوصله)') : '';
  return h('div', { class: 'actions mt' }, view, pdf, xls, tg);
}

async function reportHistory() {
  const rows = await GET('/reports');
  const tgBadge = (r) => ({ sent: badge('sent', 'أُرسل'), failed: badge('failed', 'فشل الإرسال'), none: badge('none', 'لم يُرسل') })[r.telegram_status];
  return table(['التقرير', 'الفترة', 'أُنشئ', 'بواسطة', 'تيليجرام', ''],
    rows.map((r) => [
      h('span', null, r.title, r.auto ? badge('gray', ' تلقائي') : '', r.stale ? h('span', { class: 'badge b-partial' }, 'تغيّرت بياناته') : ''),
      `${r.period_from || ''} — ${r.period_to || ''}`, dt(r.created_at), r.user_name || 'النظام',
      h('span', { title: r.telegram_error || '' }, tgBadge(r), r.telegram_error ? h('div', { class: 'hint c-out' }, r.telegram_error.slice(0, 120)) : ''),
      h('div', { class: 'row' },
        r.file_name ? h('a', { class: 'btn sm sec', href: `/api/reports/${r.id}/pdf`, target: '_blank' }, 'فتح') : '',
        isAdmin() && r.file_name ? h('button', { class: 'btn sm in', onclick: () => pickRecipients(`إرسال: ${r.title}`, async (ids) => {
          try { const x = await api('POST', `/reports/${r.id}/send`, { recipients: ids }); toast(`وصل إلى: ${x.sent_to.join('، ')}`, 'ok'); } catch (err) { toast(err.message, 'err'); }
          reload();
        }) }, r.telegram_status === 'sent' ? 'إعادة إرسال' : 'إرسال') : '',
        isAdmin() ? h('button', { class: 'btn sm ghost', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { const x = await api('POST', `/reports/${r.id}/regenerate`, { send: true }); toast(x.sent?.ok ? 'تم التحديث والإرسال' : `تم التحديث${x.sent?.error ? ` — ${x.sent.error}` : ''}`, x.sent?.ok ? 'ok' : ''); } catch (err) { toast(err.message, 'err'); }
          reload();
        } }, 'تحديث وإرسال') : '')]),
    { empty: 'لا توجد تقارير محفوظة' });
}

route(/^\/reports$/, async () => {
  const preview = h('iframe', { class: 'preview hide', title: 'معاينة التقرير' });
  const facs = S.meta.facilities;
  const form = h('form', { class: 'card', onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'grid g3' }, periodPicker(),
      seesAll() ? field('المنشأة', sel('facility_id', [['', 'جميع المنشآت'], ...facs.map((f) => [f.id, f.name])])) : ''));
  form.append(reportActions(form, 'period', preview));
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, '📊 التقارير'), seesAll() ? h('a', { class: 'btn lg', href: '#/statement' }, '📄 كشف حساب شامل PDF') : ''),
    h('p', { class: 'hint' }, 'كل منشأة لها كشف مستقل تماماً (الصالة، المغسلة، الملعب) والملخص الإجمالي ملف منفصل. التقرير اليومي يُنشأ تلقائياً بعد منتصف الليل عن اليوم المنتهي (00:00 — 23:59) ويُرسل كل ملف لحاله عبر تيليجرام.'),
    form, preview,
    h('div', { class: 'card mt' }, h('h3', null, 'التقارير السابقة'), await reportHistory()));
});

route(/^\/statement$/, async () => {
  const pre = hashQuery();
  const preview = h('iframe', { class: 'preview hide', title: 'معاينة كشف الحساب' });
  const facs = S.meta.facilities;
  const scope = sel('scope', [['all', 'جميع المنشآت'], ['facility', 'منشأة / خزنة معينة'], ['account', 'حساب معين']], pre.account_id ? 'account' : pre.facility_id ? 'facility' : 'all');
  const facF = field('المنشأة', sel('facility_id', facs.map((f) => [f.id, f.name]), pre.facility_id));
  const accF = field('الحساب', sel('account_id', (seesAll() ? S.meta.all_accounts : facs.flatMap((f) => f.accounts.map((a) => ({ ...a, facility_name: f.name }))))
    .map((a) => [a.id, `${a.name} — ${a.facility_name}`]), pre.account_id));
  const sync = () => { facF.classList.toggle('hide', scope.value !== 'facility'); accF.classList.toggle('hide', scope.value !== 'account'); };
  scope.onchange = sync;
  const form = h('form', { class: 'card', onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'grid g3' }, field('النطاق', scope), facF, accF,
      seesAll() ? field('موظف معين', sel('user_id', [['', 'كل الموظفين'], ...S.meta.users.map((u) => [u.id, u.display_name])])) : '',
      periodPicker({ preset: 'all' })));
  sync();
  // نحذف حقول النطاق غير المختارة قبل الإرسال
  const actions = reportActions({ querySelectorAll: (s) => {
    const all = [...form.querySelectorAll(s)];
    return all.filter((el) => !(el.name === 'facility_id' && scope.value !== 'facility') && !(el.name === 'account_id' && scope.value !== 'account') && el.name !== 'scope');
  } }, 'statement', preview);
  form.append(actions);
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, '📄 كشف حساب شامل PDF')),
    h('p', { class: 'hint' }, 'الكشف يبدأ بالرصيد (اللي انجمع — اللي طلع — اللي ضل)، ثم وين وصلت المصاري (كاش / بال باي / جوال باي)، ثم التوضيح: كل معاملة بنوعها وتاريخ الدفع وتاريخ الحجز. عند اختيار "جميع المنشآت" يصدر كشف مستقل لكل منشأة.'),
    form, preview);
});

// ---------------- المستخدمون ----------------
const TG_HINT = 'ليصله التقرير: يرسل الشخص أي رسالة للبوت، ثم من الإعدادات ← تيليجرام اضغط "جلب المحادثات" وانسخ رقمه هنا';

route(/^\/users$/, async () => {
  const rows = await GET('/admin/users');
  const facs = S.meta.facilities.filter((f) => f.kind !== 'general');
  const edit = (u = null, presetRole = null) => {
    const role = sel('role', [['staff', 'موظف قسم — يسجل عمليات قسمه فقط'], ['admin', 'مدير — صلاحيات كاملة'], ['viewer', 'مشاهد (المالك) — إحصائيات وتقارير فقط بدون أدوات']], u?.role || presetRole || 'staff');
    const fac = field('القسم الذي يدخل إليه', sel('facility_id', facs.map((f) => [f.id, f.name]), u?.facility_id));
    const tg = field('رقم تيليجرام لاستلام التقارير', inp('telegram_chat_id', { dir: 'ltr', value: u?.telegram_chat_id || '', placeholder: 'مثال: 123456789' }), { hint: TG_HINT });
    const chk = (name, label, def) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', name, checked: u ? !!u[name] : def }), label);
    const subs = h('div', { class: 'card tight', style: { background: '#f7f9fc' } }, h('b', null, 'شو يوصله على تيليجرام؟'),
      chk('tg_daily', 'الجرد اليومي (كل ليلة عن اليوم المنتهي)', true),
      chk('tg_weekly', 'الجرد الأسبوعي (آخر 7 أيام)', true),
      chk('tg_monthly', 'الجرد الشهري (أول الشهر عن الشهر الماضي)', true),
      chk('tg_notify', 'رسالة فورية لكل عملية (حجز، دفعة، مصروف، إلغاء، دين…)', u ? false : (presetRole || 'staff') === 'admin'));
    const sync = () => {
      fac.classList.toggle('hide', role.value !== 'staff');
      tg.classList.toggle('hide', role.value === 'staff');
      subs.classList.toggle('hide', role.value === 'staff');
    };
    role.onchange = sync;
    sync();
    modal(u ? `تعديل المستخدم: ${u.display_name}` : 'إضافة مستخدم', [
      field('الاسم (يظهر في كل العمليات)', inp('display_name', { required: true, value: u?.display_name }), { req: true }),
      field('اسم المستخدم للدخول', inp('username', { required: true, value: u?.username, dir: 'ltr' }), { req: true, hint: 'أحرف إنجليزية وأرقام' }),
      field(u ? 'كلمة مرور جديدة (اتركها فارغة لعدم التغيير)' : 'كلمة المرور', inp('password', { type: 'password', dir: 'ltr', required: !u, minlength: 6 }), { req: !u }),
      field('نوع الحساب', role), fac, tg, subs,
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: u ? !!u.active : true }), 'الحساب فعّال'),
    ], async (d, idem) => {
      if (u) await api('PUT', `/admin/users/${u.id}`, d, { idem }); else await api('POST', '/admin/users', d, { idem });
      closeModal(); await refreshMeta(); toast('تم الحفظ', 'ok'); reload();
    });
  };
  const hasViewer = rows.some((u) => u.role === 'viewer');
  return h('div', null,
    h('div', { class: 'page-head' }, h('h1', null, '👥 المستخدمون'),
      h('div', { class: 'actions' },
        !hasViewer ? h('button', { class: 'btn sec', onclick: () => edit(null, 'viewer') }, '+ حساب مشاهدة للمالك') : '',
        h('button', { class: 'btn', onclick: () => edit() }, '+ إضافة مستخدم'))),
    h('div', { class: 'grid g3', style: { marginBottom: '16px' } },
      h('div', { class: 'card tight' }, h('b', null, 'مدير'), h('p', { class: 'hint' }, 'كل شيء: كل الأقسام، الإلغاء، الحسابات، المستخدمون، الإعدادات، إرسال التقارير.')),
      h('div', { class: 'card tight' }, h('b', null, 'موظف قسم'), h('p', { class: 'hint' }, 'يسجل حجوزات وطلبات ودفعات ومصروفات وديون قسمه فقط. الإلغاء للمدير إلا إذا سُمح له من الإعدادات.')),
      h('div', { class: 'card tight' }, h('b', null, 'مشاهد (المالك)'), h('p', { class: 'hint' }, 'يرى الإحصائيات والخزن والديون والتقارير وكشوفات الحساب لكل المنشآت، بدون أي تسجيل أو تعديل. تصله التقارير على تيليجرام مع المدير.'))),
    h('div', { class: 'card' }, table(['الاسم', 'اسم المستخدم', 'نوع الحساب', 'القسم', 'تيليجرام', 'الحالة', 'آخر نشاط', ''],
      rows.map((u) => [u.display_name, h('span', { dir: 'ltr' }, u.username), ROLE_NAMES[u.role], u.role === 'staff' ? u.facility_name : 'الكل',
        u.role === 'staff' ? '—' : (u.telegram_chat_id
          ? h('span', { class: 'hint' }, [u.tg_daily && 'يومي', u.tg_weekly && 'أسبوعي', u.tg_monthly && 'شهري', u.tg_notify && 'كل عملية'].filter(Boolean).join(' · ') || 'لا شيء')
          : badge('none', 'بدون رقم')),
        u.active ? badge('active', 'فعّال') : badge('cancelled', 'معطل'), dt(u.last_activity),
        h('div', { class: 'row' }, h('button', { class: 'btn sm sec', onclick: () => edit(u) }, 'تعديل'),
          h('a', { class: 'btn sm ghost', href: `#/audit?user_id=${u.id}` }, 'سجل نشاطه'))]))));
});

// ---------------- سجل النشاطات ----------------
route(/^\/audit$/, async () => {
  const pre = hashQuery();
  const listBox = h('div');
  const userS = sel('user_id', [['', 'كل الموظفين'], ...S.meta.users.map((u) => [u.id, u.display_name])], pre.user_id);
  const facS = sel('facility_id', [['', 'كل الأقسام'], ...S.meta.facilities.map((f) => [f.id, f.name])]);
  const actS = sel('action', [['', 'كل العمليات'], ['create', 'إضافة'], ['update', 'تعديل'], ['cancel', 'إلغاء'], ['login', 'دخول'], ['send', 'إرسال']]);
  const from = h('input', { type: 'date', value: addDays(today(), -7) });
  const to = h('input', { type: 'date' });
  const q = h('input', { placeholder: 'رقم أو نص' });
  const load = async () => {
    const rows = await GET(`/admin/audit${qs({ user_id: userS.value, facility_id: facS.value, action: actS.value, from: from.value, to: to.value, q: q.value })}`);
    listBox.innerHTML = '';
    listBox.append(table(['الوقت', 'الموظف', 'القسم', 'العملية', 'الرقم', 'التفاصيل'],
      rows.map((a) => [dt(a.created_at), a.user_name || 'النظام', a.facility_name || '—',
        ({ create: 'إضافة', update: 'تعديل', cancel: 'إلغاء', login: 'دخول', send: 'إرسال', download: 'تنزيل' })[a.action] || a.action,
        a.ref_no ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); lookup(a.ref_no); } }, noTag(a.ref_no)) : '',
        h('div', null, a.summary || '', a.details ? h('details', null, h('summary', { class: 'hint' }, 'التفاصيل'), h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '12px', direction: 'ltr', textAlign: 'left' } }, JSON.stringify(JSON.parse(a.details), null, 1))) : '')]),
      { empty: 'لا يوجد نشاط' }));
  };
  await load();
  return h('div', null, h('div', { class: 'page-head' }, h('h1', null, '🕑 سجل النشاطات والرقابة')),
    h('div', { class: 'card' }, h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); load(); } },
      field('الموظف', userS), field('القسم', facS), field('العملية', actS), field('من', from), field('إلى', to), field('بحث', q), h('button', { class: 'btn' }, 'عرض')), listBox));
});

// ---------------- الإعدادات ----------------
route(/^\/settings$/, async () => {
  const s = await GET('/admin/settings');
  const tab = hashQuery().tab || 'general';
  const tabs = h('div', { class: 'tabs' }, [['general', 'عام'], ['telegram', 'تيليجرام والتقارير'], ['facilities', 'المنشآت والترقيم'], ['categories', 'التصنيفات'],
    ['services', 'خدمات المغسلة'], ['backup', 'النسخ الاحتياطي']].map(([k, l]) => h('a', { href: `#/settings?tab=${k}`, class: tab === k ? 'on' : '' }, l)));
  const saveForm = (form, extra = () => ({})) => async (e) => {
    e.preventDefault();
    try { await api('PUT', '/admin/settings', { ...formData(form), ...extra() }); toast('تم الحفظ', 'ok'); S.me = await GET('/me'); await refreshMeta(); reload(); } catch (err) { toast(err.message, 'err'); }
  };
  let body;
  if (tab === 'general') {
    const form = h('form', { class: 'card' },
      h('div', { class: 'grid g2' },
        field('المنطقة الزمنية', inp('timezone', { value: s.timezone, dir: 'ltr' }), { hint: 'مثال: Asia/Hebron أو Asia/Amman' }),
        field('رمز العملة', inp('currency', { value: s.currency })),
        field('بداية عمل الملعب', inp('field_open', { type: 'time', value: s.field_open })),
        field('نهاية عمل الملعب', inp('field_close', { type: 'time', value: s.field_close }), { hint: 'يمكن أن تكون بعد منتصف الليل' }),
        field('سعر ساعة الملعب الافتراضي', moneyInp('field_hour_price', { value: s.field_hour_price }))),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'staff_can_cancel', checked: s.staff_can_cancel === '1' }), 'السماح للموظفين بإلغاء الحجوزات والعمليات في أقسامهم (مع ذكر السبب)'),
      h('button', { class: 'btn mt' }, 'حفظ'));
    form.onsubmit = saveForm(form);
    body = form;
  } else if (tab === 'telegram') {
    const recips = await GET('/admin/settings/telegram-recipients');
    const chatsBox = h('div');
    const form = h('form', { class: 'card' },
      h('h3', null, '1) البوت'),
      h('p', { class: 'hint' }, 'أنشئ بوتاً من @BotFather على تيليجرام وانسخ التوكن هنا.'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'telegram_enabled', checked: s.telegram_enabled === '1' }), 'تفعيل الإرسال التلقائي للتقارير'),
      field('توكن البوت', inp('telegram_token', { dir: 'ltr', placeholder: s.telegram_token_set ? '•••••• (محفوظ — اتركه فارغاً لعدم التغيير)' : '123456:ABC…', autocomplete: 'off' })),
      h('h3', { class: 'mt' }, '2) مين تصله التقارير'),
      h('p', { class: 'hint' }, 'التقارير تصل معاً لكل مدير ومالك أُدخل له رقم تيليجرام في صفحة المستخدمين، ويمكن إضافة مجموعة أيضاً.'),
      recips.length ? h('div', { class: 'list-acc' }, recips.map((r) => h('div', null, h('span', null, '✈️ ', r.name), h('span', { dir: 'ltr', class: 'hint' }, r.id))))
        : h('p', { class: 'alert' }, 'لا يوجد مستلمون بعد. أدخل رقم تيليجرام لك وللمالك من صفحة المستخدمين.'),
      h('div', { class: 'actions mt' }, h('a', { class: 'btn sm sec', href: '#/users' }, 'المستخدمون وأرقام تيليجرام'),
        h('button', { type: 'button', class: 'btn sm ghost', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const chats = await GET('/admin/settings/telegram-chats');
            chatsBox.innerHTML = '';
            chatsBox.append(h('div', { class: 'card tight mt', style: { background: '#f7f9fc' } },
              h('b', null, 'المحادثات اللي راسلت البوت مؤخراً:'),
              chats.length ? table(['الاسم', 'المعرف', 'النوع', 'رقم المحادثة'], chats.map((c) => [c.name, c.username ? `@${c.username}` : '', c.type === 'private' ? 'شخص' : 'مجموعة', h('b', { dir: 'ltr' }, c.id)]))
                : h('p', { class: 'hint' }, 'لا توجد رسائل. اطلب من كل شخص يرسل أي رسالة للبوت ثم اضغط مرة ثانية.')));
          } catch (err) { toast(err.message, 'err'); }
          e.target.disabled = false;
        } }, '🔎 جلب المحادثات (لمعرفة الأرقام)')),
      chatsBox,
      field('مجموعة إضافية (اختياري)', inp('telegram_chat_id', { dir: 'ltr', value: s.telegram_chat_id }), { hint: 'رقم مجموعة تيليجرام إن أردتم استلام التقارير فيها أيضاً (يبدأ عادة بـ -100)' }),
      h('h3', { class: 'mt' }, '3) مواعيد الجرد التلقائي'),
      h('div', { class: 'grid g3' },
        field('وقت التقرير اليومي', inp('daily_report_time', { type: 'time', value: s.daily_report_time }), { hint: 'عن اليوم المنتهي — يُنصح 00:05' }),
        field('يوم التقرير الأسبوعي', sel('weekly_report_day', DAY_NAMES.map((d, i) => [i, d]), s.weekly_report_day)),
        field('وقت التقرير الأسبوعي', inp('weekly_report_time', { type: 'time', value: s.weekly_report_time })),
        field('وقت الجرد الشهري (أول الشهر)', inp('monthly_report_time', { type: 'time', value: s.monthly_report_time }))),
      h('p', { class: 'hint' }, 'كل شخص يختار من صفحة المستخدمين شو يوصله: الجرد اليومي، الأسبوعي، الشهري، ورسالة فورية لكل عملية.'),
      h('div', { class: 'actions mt' }, h('button', { class: 'btn' }, 'حفظ'),
        h('button', { type: 'button', class: 'btn sec', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await api('POST', '/admin/settings/telegram-test');
            if (r.ok.length) toast(`وصلت رسالة الاختبار إلى: ${r.ok.join('، ')}`, 'ok');
            if (r.failed.length) toast(`فشل: ${r.failed.join(' | ')}`, 'err');
          } catch (err) { toast(err.message, 'err'); }
          e.target.disabled = false;
        } }, 'إرسال رسالة اختبار للجميع')));
    form.onsubmit = saveForm(form);
    body = form;
  } else if (tab === 'facilities') {
    body = h('div', null, h('div', { class: 'card' },
      h('p', { class: 'hint' }, 'كل منشأة لها رمز ترقيم مستقل (مثل A100، U100، D100). كل حجز أو طلب أو دفعة أو مصروف يأخذ الرقم التالي في تسلسل منشأته.'),
      table(['المنشأة', 'الرمز', 'الرقم التالي', 'الحالة', ''], s.facilities.map((f) => [f.name, noTag(f.prefix), noTag(`${f.prefix}${f.next_no}`),
        f.active ? badge('active', 'فعّالة') : badge('cancelled', 'موقوفة'),
        h('button', { class: 'btn sm sec', onclick: () => modal(`تعديل ${f.name}`, [
          field('الاسم', inp('name', { value: f.name, required: true })),
          field('رمز الترقيم', inp('prefix', { value: f.prefix, dir: 'ltr', maxlength: 3 })),
          field('الرقم التالي', inp('next_no', { type: 'number', value: f.next_no, min: 1 })),
          f.kind === 'other' ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: !!f.active }), 'فعّالة') : '',
        ], async (d, idem) => { await api('PUT', `/admin/facilities/${f.id}`, d, { idem }); closeModal(); await refreshMeta(); reload(); }) }, 'تعديل')])),
      h('button', { class: 'btn mt', onclick: () => modal('إضافة منشأة جديدة', [
        field('اسم المنشأة', inp('name', { required: true })), field('رمز الترقيم', inp('prefix', { required: true, dir: 'ltr', maxlength: 3 }), { hint: 'حرف إنجليزي، مثل B' }),
        h('p', { class: 'hint' }, 'سيتم إنشاء خزنة للمنشأة وصفحة إيداعات ومصروفات خاصة بها.'),
      ], async (d, idem) => { await api('POST', '/admin/facilities', d, { idem }); closeModal(); await refreshMeta(); reload(); }) }, '+ إضافة منشأة')));
  } else if (tab === 'categories') {
    body = h('div', null, s.facilities.map((f) => h('div', { class: 'card' }, h('h3', null, f.name),
      ['expense', 'income'].map((k) => h('div', { class: 'mt' }, h('b', null, k === 'expense' ? 'تصنيفات المصروفات: ' : 'أنواع الإيداعات: '),
        h('div', { class: 'row', style: { marginTop: '6px' } }, s.categories.filter((c) => c.facility_id === f.id && c.kind === k).map((c) => h('button', {
          class: `btn sm ${c.active ? 'sec' : 'ghost'}`, title: c.active ? 'اضغط للإيقاف' : 'اضغط للتفعيل',
          onclick: async () => { await api('PUT', `/admin/categories/${c.id}`, { active: !c.active }); await refreshMeta(); reload(); },
        }, c.active ? c.name : `${c.name} (موقوف)`)),
        h('button', { class: 'btn sm', onclick: () => modal('إضافة تصنيف', [field('الاسم', inp('name', { required: true }))], async (d, idem) => {
          await api('POST', '/admin/categories', { ...d, facility_id: f.id, kind: k }, { idem }); closeModal(); await refreshMeta(); reload();
        }) }, '+ إضافة')))))));
  } else if (tab === 'services') {
    const services = await GET('/laundry/services?all=1');
    const edit = (sv = null) => modal(sv ? 'تعديل خدمة' : 'إضافة خدمة', [
      field('اسم نوع الخدمة', inp('name', { required: true, value: sv?.name })),
      field('السعر الافتراضي (اختياري)', moneyInp('default_price', { value: sv ? major(sv.default_price) : 0 })),
      sv ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: !!sv.active }), 'فعّالة') : '',
    ], async (d, idem) => { if (sv) await api('PUT', `/laundry/services/${sv.id}`, d, { idem }); else await api('POST', '/laundry/services', d, { idem }); closeModal(); reload(); });
    body = h('div', { class: 'card' }, table(['الخدمة', 'السعر الافتراضي', 'الحالة', ''], services.map((sv) => [sv.name, money(sv.default_price),
      sv.active ? badge('active', 'فعّالة') : badge('cancelled', 'موقوفة'), h('button', { class: 'btn sm sec', onclick: () => edit(sv) }, 'تعديل')])),
    h('button', { class: 'btn mt', onclick: () => edit() }, '+ إضافة خدمة'));
  } else if (tab === 'backup') {
    const list = await GET('/admin/backups');
    body = h('div', { class: 'card' },
      h('p', { class: 'hint' }, `يتم أخذ نسخة احتياطية تلقائية يومياً، ويُحتفظ بآخر ${s.backup_keep} نسخة.`),
      h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); saveForm(e.target)(e); } },
        field('وقت النسخ اليومي', inp('backup_time', { type: 'time', value: s.backup_time })), field('عدد النسخ المحفوظة', inp('backup_keep', { type: 'number', value: s.backup_keep, min: 3 })),
        h('button', { class: 'btn sec' }, 'حفظ')),
      h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; try { await api('POST', '/admin/backups'); toast('تم إنشاء نسخة احتياطية', 'ok'); } catch (err) { toast(err.message, 'err'); } reload(); } }, 'نسخة احتياطية الآن'),
      h('div', { class: 'mt' }, table(['الملف', 'الحجم', 'الوقت', ''], list.map((b) => [h('span', { dir: 'ltr' }, b.name), `${(b.size / 1024).toFixed(0)} KB`, dt(b.mtime),
        h('a', { class: 'btn sm sec', href: `/api/admin/backups/${encodeURIComponent(b.name)}` }, 'تنزيل')]), { empty: 'لا توجد نسخ بعد' })));
  }
  return h('div', null, h('div', { class: 'page-head' }, h('h1', null, '⚙️ الإعدادات')), tabs, body);
});

boot();
