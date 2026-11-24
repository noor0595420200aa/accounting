/* نظام إدارة الصالة والمغسلة والملعب — الواجهة */
'use strict';

const S = { me: null, meta: null, L: null };

// ---------------- أدوات عامة ----------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

function fmt(m) {
  const v = Math.round(m || 0) / 100;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
const major = (m) => (m ? Math.round(m) / 100 : 0);
function money(m, cls = '') {
  return h('span', { class: `num ${cls}` }, fmt(m), S.me && S.me.currency ? ` ${S.me.currency}` : '');
}
function dt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}
const noTag = (no) => (no ? h('span', { class: 'no' }, no) : '');
const badge = (cls, text) => h('span', { class: `badge b-${cls}` }, text);
const bStatus = (s) => badge(s, S.L.bookingStatus[s] || s);
const oStatus = (s) => badge(s, S.L.orderStatus[s] || s);
const isAdmin = () => S.me && S.me.user.role === 'admin';
const today = () => S.me.today;
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function txnLabel(t) {
  if (t.pay_type) return S.L.payType[t.pay_type];
  return S.L.kind[t.kind] || t.kind;
}

function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}` }, msg);
  $('#toast').append(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3000);
}

async function api(method, url, body, opts = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  const res = await fetch('/api' + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (res.status === 401 && url !== '/login') { S.me = null; renderLogin(); throw new Error('يجب تسجيل الدخول'); }
  if (!res.ok) throw new Error((data && data.error) || `خطأ ${res.status}`);
  return data;
}
const GET = (u) => api('GET', u);
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v !== undefined && v !== null) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---------------- النماذج ----------------
function field(label, input, { req = false, hint = '' } = {}) {
  const tag = input instanceof Element && input.classList.contains('radios') ? 'div' : 'label';
  return h(tag, { class: 'f' }, h('span', null, label, req ? h('span', { class: 'req' }, ' *') : ''), input, hint ? h('div', { class: 'hint' }, hint) : '');
}
const inp = (name, attrs = {}) => h('input', { name, ...attrs });
const moneyInp = (name, attrs = {}) => h('input', { name, type: 'number', step: '0.01', min: '0', inputmode: 'decimal', ...attrs });
const dateInp = (name, value) => h('input', { name, type: 'date', value: value || today() });
const area = (name, value = '') => { const t = h('textarea', { name }); t.value = value || ''; return t; };
function sel(name, options, value) {
  const s = h('select', { name });
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    const op = h('option', { value: v }, l);
    if (String(v) === String(value)) op.selected = true;
    s.append(op);
  }
  return s;
}
function accountSel(facilityId, name = 'account_id', value) {
  const f = S.meta.facilities.find((x) => x.id === Number(facilityId));
  const accs = f ? f.accounts : [];
  // الافتراضي: الكاش، ويضغط الموظف على بال باي أو جوال باي إذا وصل المبلغ عليهم
  const def = accs.find((a) => a.type === 'safe') || accs[0];
  if (accs.length && accs.length <= 6) {
    const cur = String(value || (def ? def.id : ''));
    return h('div', { class: 'radios' }, accs.map((a) => h('label', { class: 'pick' },
      h('input', { type: 'radio', name, value: a.id, checked: String(a.id) === cur }), h('span', null, a.name))));
  }
  return sel(name, [['', '— اختر الحساب —'], ...accs.map((a) => [a.id, a.name])], value || (def ? def.id : ''));
}
// زر "أخرى" لإضافة تفاصيل حرة
function extraBox(value = '') {
  const box = h('div', { class: value ? '' : 'hide' }, field('تفاصيل أخرى', area('extra', value)));
  const btn = h('button', { type: 'button', class: 'btn sec sm', onclick: () => { box.classList.toggle('hide'); } }, '+ أخرى');
  return h('div', { style: { marginBottom: '10px' } }, value ? '' : btn, box);
}
function formData(form) {
  const o = {};
  for (const el of form.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else o[el.name] = el.value;
  }
  return o;
}

// ---------------- النوافذ المنبثقة ----------------
function closeModal() { $('#modal-root').innerHTML = ''; }
/**
 * modal(title, body, onSubmit) — onSubmit(data, idem) يُرجع Promise. الزر يُعطّل أثناء الإرسال لمنع التكرار
 */
function modal(title, body, onSubmit, { submitText = 'حفظ', submitClass = '', wide = false } = {}) {
  const idem = uuid();
  const form = h('form', { class: 'body' }, body);
  const btn = h('button', { type: 'submit', class: `btn ${submitClass}` }, submitText);
  const wrap = h('div', { class: 'modal-bg', onmousedown: (e) => { if (e.target === wrap) closeModal(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}` },
      h('header', null, h('h3', null, title), h('button', { type: 'button', class: 'x', onclick: closeModal }, '×')),
      form,
      onSubmit ? h('footer', null, btn, h('button', { type: 'button', class: 'btn ghost', onclick: closeModal }, 'إلغاء')) : ''));
  if (onSubmit) {
    btn.onclick = (e) => { e.preventDefault(); form.requestSubmit(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        await onSubmit(formData(form), idem, form);
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    };
  }
  $('#modal-root').innerHTML = '';
  $('#modal-root').append(wrap);
  const first = form.querySelector('input:not([type=hidden]),select,textarea');
  if (first && window.innerWidth > 700) first.focus();
  return form;
}
function confirmBox(text) {
  return new Promise((resolve) => {
    modal('تأكيد', h('p', null, text), async () => { closeModal(); resolve(true); }, { submitText: 'نعم، متابعة' });
  });
}

// ---------------- الجداول ----------------
function table(headers, rows, { onRow, foot, empty = 'لا توجد بيانات', rowClass } = {}) {
  if (!rows.length) return h('div', { class: 'tbl-wrap' }, h('div', { class: 'empty' }, empty));
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, headers.map((x) => h('th', null, x)))),
    h('tbody', null, rows.map((r, i) => h('tr', {
      class: [onRow ? 'click' : '', rowClass ? rowClass(i) : ''].join(' '),
      onclick: onRow ? () => onRow(i) : null,
    }, r.map((c) => h('td', null, typeof c === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c) ? h('span', { class: 'nw' }, c) : c))))),
    foot ? h('tfoot', null, h('tr', null, foot.map((c) => h('td', null, c)))) : ''));
}
const kpi = (label, value, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value));

// ---------------- التنقل ----------------
const routes = [];
const route = (re, fn) => routes.push([re, fn]);
const go = (hash) => { location.hash = hash; };

function menuItems() {
  const m = [['#/', '🏠', 'الرئيسية']];
  const facs = S.meta.facilities;
  const has = (k) => facs.some((f) => f.kind === k);
  if (has('hall')) m.push(['#/hall', '💍', 'الصالة']);
  if (has('laundry')) m.push(['#/laundry', '🚗', 'المغسلة']);
  if (has('field')) m.push(['#/field', '⚽', 'الملعب']);
  for (const f of facs.filter((x) => x.kind === 'other')) m.push([`#/finance/${f.id}`, '🏢', f.name]);
  m.push(['#/treasury', '💰', 'الخزن والحسابات']);
  m.push([has('laundry') ? '#/debts' : '#/fundings', '📒', 'الديون']);
  m.push(['#/reports', '📊', 'التقارير']);
  if (isAdmin()) {
    m.push(['#/users', '👥', 'المستخدمون']);
    m.push(['#/audit', '🕑', 'سجل النشاطات']);
    m.push(['#/settings', '⚙️', 'الإعدادات']);
  }
  return m;
}

function layout(content) {
  const cur = location.hash || '#/';
  const side = h('nav', { class: 'side' }, h('div', { class: 'brand' }, 'إدارة الأنشطة'),
    menuItems().map(([href, ico, label]) => h('a', {
      href, class: (href === '#/' ? cur === '#/' || cur === '' : cur.startsWith(href)) ? 'on' : '',
      onclick: () => side.classList.remove('open'),
    }, h('span', { class: 'ico' }, ico), label)),
    h('a', { href: '#/password' }, h('span', { class: 'ico' }, '🔑'), 'تغيير كلمة المرور'),
    h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await api('POST', '/logout'); location.hash = '#/'; location.reload(); } },
      h('span', { class: 'ico' }, '🚪'), 'تسجيل الخروج'));
  const searchInp = h('input', { placeholder: 'رقم العملية مثل A105', 'aria-label': 'بحث برقم العملية' });
  const search = h('form', { class: 'search', onsubmit: async (e) => { e.preventDefault(); await lookup(searchInp.value); } },
    searchInp, h('button', { class: 'btn sm sec' }, 'بحث'));
  const top = h('div', { class: 'topbar' },
    h('button', { class: 'btn sm ghost menu-btn', onclick: () => side.classList.toggle('open') }, '☰'),
    search,
    h('div', { class: 'who' }, '👤 ', h('span', { class: 'nm' }, S.me.user.display_name)));
  return h('div', { class: 'shell' }, side, h('div', { class: 'main' }, top, h('div', { class: 'content' }, content)));
}

async function lookup(q) {
  q = String(q || '').trim();
  if (!q) return;
  try {
    const r = await GET(`/lookup${qs({ q })}`);
    const map = { hall: `#/hall/b/${r.id}`, field: `#/field/b/${r.id}`, order: `#/laundry/o/${r.id}`, funding: '#/fundings', txn: `#/txn/${r.id}` };
    go(map[r.type]);
  } catch (e) { toast(e.message, 'err'); }
}

async function render() {
  closeModal();
  const hash = location.hash || '#/';
  const path = hash.slice(1).split('?')[0] || '/';
  const app = $('#app');
  if (!S.me) return;
  if (S.me.user.must_change_password && path !== '/password') return go('#/password');
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      const holder = h('div', null, h('div', { class: 'loading' }, 'جارِ التحميل…'));
      app.innerHTML = '';
      app.append(layout(holder));
      try {
        const node = await fn(...m.slice(1));
        holder.innerHTML = '';
        holder.append(node);
      } catch (e) {
        holder.innerHTML = '';
        holder.append(h('div', { class: 'card' }, h('p', { class: 'c-out' }, e.message)));
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  go('#/');
}
const reload = () => render();
window.addEventListener('hashchange', render);

function hashQuery() {
  const i = location.hash.indexOf('?');
  return Object.fromEntries(new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : ''));
}

// ---------------- الدخول ----------------
function renderLogin() {
  const app = $('#app');
  const form = h('form', null,
    field('اسم المستخدم', inp('username', { autocomplete: 'username', required: true, dir: 'ltr' })),
    field('كلمة المرور', inp('password', { type: 'password', autocomplete: 'current-password', required: true, dir: 'ltr' })),
    h('button', { class: 'btn lg', style: { width: '100%' } }, 'دخول'));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const b = form.querySelector('button');
    b.disabled = true;
    try {
      await api('POST', '/login', formData(form));
      await boot();
    } catch (err) { toast(err.message, 'err'); } finally { b.disabled = false; }
  };
  app.innerHTML = '';
  app.append(h('div', { class: 'login' }, h('div', { class: 'card' },
    h('h1', null, 'إدارة الأنشطة'), h('p', { class: 'hint', style: { textAlign: 'center' } }, 'الصالة · المغسلة · الملعب'), form)));
}

async function boot() {
  try {
    S.me = await GET('/me');
  } catch {
    return renderLogin();
  }
  S.L = S.me.labels;
  S.meta = await GET('/meta');
  render();
}
async function refreshMeta() { S.meta = await GET('/meta'); }

route(/^\/password$/, async () => {
  const form = h('form', { class: 'card', style: { maxWidth: '440px' } },
    S.me.user.must_change_password ? h('p', { class: 'alert' }, 'يجب تغيير كلمة المرور قبل استخدام النظام') : '',
    field('كلمة المرور الحالية', inp('current', { type: 'password', required: true, dir: 'ltr' })),
    field('كلمة المرور الجديدة', inp('password', { type: 'password', required: true, minlength: 6, dir: 'ltr' })),
    field('تأكيد كلمة المرور', inp('password2', { type: 'password', required: true, dir: 'ltr' })),
    h('button', { class: 'btn' }, 'حفظ'));
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(form);
    if (d.password !== d.password2) return toast('كلمتا المرور غير متطابقتين', 'err');
    try {
      await api('POST', '/me/password', d);
      toast('تم تغيير كلمة المرور', 'ok');
      S.me = await GET('/me');
      go('#/');
    } catch (err) { toast(err.message, 'err'); }
  };
  return h('div', null, h('div', { class: 'page-head' }, h('h1', null, 'تغيير كلمة المرور')), form);
});
