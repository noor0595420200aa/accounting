/* اختبار شامل للنظام عبر الـ API: node test/smoke.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-test-'));
process.env.DATA_DIR = tmp;
process.env.DISABLE_SCHEDULER = '1';

// خادم تيليجرام وهمي لاختبار الإرسال
const tgReceived = [];
const tg = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    const m = body.match(/name="chat_id"\r\n\r\n(-?\d+)/);
    const chat = m ? m[1] : null;
    tgReceived.push({ url: req.url, size: body.length, chat });
    res.setHeader('Content-Type', 'application/json');
    if (chat === '999') return res.end(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }));
    if (req.url.endsWith('/getUpdates')) return res.end(JSON.stringify({ ok: true, result: [{ message: { chat: { id: 222, first_name: 'المالك', type: 'private' } } }] }));
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});

let base;
const jar = {};
async function call(who, method, url, body, headers = {}) {
  const res = await fetch(base + '/api' + url, {
    method, headers: { 'Content-Type': 'application/json', Cookie: jar[who] || '', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) jar[who] = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data };
}
async function ok(who, method, url, body, headers) {
  const r = await call(who, method, url, body, headers);
  if (r.status !== 200) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function fail(who, method, url, body, re) {
  const r = await call(who, method, url, body);
  assert.notStrictEqual(r.status, 200, `${url} expected failure`);
  if (re) assert.match(r.data.error, re);
  return r.data;
}

(async () => {
  await new Promise((r) => tg.listen(0, r));
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${tg.address().port}`;
  const app = require('../server/index');
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}`;
  const { today, addDays } = require('../server/util');
  const T = today();
  const step = (m) => console.log('✔', m);

  // ---- الدخول وتغيير كلمة المرور الإجبارية ----
  await ok('admin', 'POST', '/login', { username: 'admin', password: 'admin123' });
  await fail('admin', 'GET', '/dashboard', null, /تغيير كلمة المرور/);
  await ok('admin', 'POST', '/me/password', { current: 'admin123', password: 'secret123' });
  step('login + forced password change');

  const meta = await ok('admin', 'GET', '/meta');
  const F = Object.fromEntries(meta.facilities.map((f) => [f.kind, f]));
  const acc = (k) => F[k].accounts[0].id;
  const accT = (k, type) => F[k].accounts.find((a) => a.type === type).id;
  assert.deepStrictEqual(F.hall.accounts.map((a) => a.name), ['كاش', 'بال باي', 'جوال باي']);

  // ---- المستخدمون والصلاحيات ----
  await ok('admin', 'POST', '/admin/users', { username: 'hall1', display_name: 'موظف الصالة', password: 'pass123', role: 'staff', facility_id: F.hall.id });
  await ok('admin', 'POST', '/admin/users', { username: 'wash1', display_name: 'موظف المغسلة', password: 'pass123', role: 'staff', facility_id: F.laundry.id });
  await ok('hall', 'POST', '/login', { username: 'hall1', password: 'pass123' });
  await ok('hall', 'POST', '/me/password', { current: 'pass123', password: 'pass1234' });
  await ok('wash', 'POST', '/login', { username: 'wash1', password: 'pass123' });
  await ok('wash', 'POST', '/me/password', { current: 'pass123', password: 'pass1234' });
  await fail('hall', 'GET', '/laundry/orders', null, /صلاحية/);
  await fail('hall', 'GET', '/admin/users', null, /للمدير/);
  // حساب المشاهدة للمالك: يرى كل شيء ولا يعدل شيئاً
  await ok('admin', 'POST', '/admin/users', { username: 'owner', display_name: 'المالك', password: 'pass123', role: 'viewer', telegram_chat_id: '222' });
  await ok('owner', 'POST', '/login', { username: 'owner', password: 'pass123' });
  await ok('owner', 'POST', '/me/password', { current: 'pass123', password: 'pass1234' });
  const ometa = await ok('owner', 'GET', '/meta');
  assert.strictEqual(ometa.facilities.length, meta.facilities.length);
  await fail('owner', 'POST', '/txns/expense', { facility_id: F.hall.id, account_id: acc('hall'), amount: 1, category: 'رواتب', party: 'x' }, /للاطلاع/);
  await fail('owner', 'POST', '/hall/bookings', { customer_name: 'x', event_date: T, total: 1, deposit: 1, account_id: acc('hall') }, /للاطلاع/);
  await fail('owner', 'GET', '/admin/users', null, /للمدير/);
  await ok('admin', 'PUT', '/admin/users/1', { telegram_chat_id: '111' });
  step('users + facility permissions + owner viewer account (read-only)');

  // ---- الصالة: العربون إلزامي، الفترة المسائية تلقائية، منع التعارض ----
  const ev = addDays(T, 30);
  await fail('hall', 'POST', '/hall/bookings', { customer_name: 'أحمد', event_date: ev, total: 5000, account_id: acc('hall') }, /العربون/);
  const hb = await ok('hall', 'POST', '/hall/bookings', { customer_name: 'أحمد', phone: '0599', event_date: ev, total: 5000, deposit: 1000, account_id: acc('hall') });
  assert.match(hb.no, /^A\d+$/);
  let b = await ok('hall', 'GET', `/hall/bookings/${hb.id}`);
  assert.strictEqual(b.period, 'evening');
  assert.strictEqual(b.status, 'confirmed');
  assert.strictEqual(b.remaining, 400000);
  assert.strictEqual(b.payments[0].pay_type, 'deposit');
  await fail('hall', 'POST', '/hall/bookings', { customer_name: 'خالد', event_date: ev, total: 3000, deposit: 500, account_id: acc('hall') }, /محجوزة/);
  const hb2 = await ok('hall', 'POST', '/hall/bookings', { customer_name: 'خالد', event_date: ev, period: 'morning', total: 3000, deposit: 500, account_id: acc('hall') });
  step(`hall booking ${hb.no}, conflict blocked, morning slot ${hb2.no} allowed`);

  // دفعات + منع الدفع الزائد + منع التكرار
  await fail('hall', 'POST', `/hall/bookings/${hb.id}/payments`, { amount: 4500, account_id: acc('hall') }, /أكبر من المتبقي/);
  const idem = 'k-' + Date.now();
  const p1 = await ok('hall', 'POST', `/hall/bookings/${hb.id}/payments`, { amount: 1500, account_id: acc('hall') }, { 'Idempotency-Key': idem });
  const p1dup = await ok('hall', 'POST', `/hall/bookings/${hb.id}/payments`, { amount: 1500, account_id: acc('hall') }, { 'Idempotency-Key': idem });
  assert.strictEqual(p1dup.duplicate, true);
  assert.strictEqual(p1dup.no, p1.no);
  await ok('hall', 'POST', `/hall/bookings/${hb.id}/payments`, { amount: 1000, account_id: accT('hall', 'palpay') });
  await ok('hall', 'POST', `/hall/bookings/${hb.id}/payments`, { amount: 1500, account_id: accT('hall', 'jawwalpay') });
  b = await ok('hall', 'GET', `/hall/bookings/${hb.id}`);
  assert.strictEqual(b.status, 'paid');
  assert.strictEqual(b.payments.length, 4);
  assert.deepStrictEqual(b.payments.map((p) => p.pay_type), ['deposit', 'extra', 'extra', 'completion']);
  step('hall payments, duplicate submission ignored, status -> paid');

  // إلغاء مع خصم وإرجاع الباقي (الموظف لا يستطيع الإلغاء افتراضياً)
  await fail('hall', 'POST', `/hall/bookings/${hb2.id}/cancel`, { cancel_reason: 'x', cancel_action: 'keep' }, /للمدير/);
  await fail('admin', 'POST', `/hall/bookings/${hb2.id}/cancel`, { cancel_reason: 'ظروف' }, /ماذا نفعل/);
  const c = await ok('admin', 'POST', `/hall/bookings/${hb2.id}/cancel`, { cancel_reason: 'ظروف', cancel_action: 'partial', kept_amount: 200, refund_account_id: acc('hall') });
  assert.strictEqual(c.refund, 30000);
  await ok('hall', 'POST', '/hall/bookings', { customer_name: 'سامي', event_date: ev, period: 'morning', total: 2000, deposit: 300, account_id: acc('hall') });
  step('cancel with deduction (kept 200, refunded 300), date freed and rebooked');

  // ---- الملعب: حجز يتجاوز منتصف الليل + التعارض ----
  const pd = addDays(T, 2);
  const fb = await ok('admin', 'POST', '/field/bookings', { customer_name: 'فريق النجوم', play_date: pd, start_time: '23:00', end_time: '01:00', hour_price: 100, deposit: 50, account_id: acc('field') });
  assert.match(fb.no, /^D\d+$/);
  const fbd = await ok('admin', 'GET', `/field/bookings/${fb.id}`);
  assert.strictEqual(fbd.minutes, 120);
  assert.strictEqual(fbd.total, 20000);
  await fail('admin', 'POST', '/field/bookings', { customer_name: 'آخر', play_date: addDays(pd, 1), start_time: '00:30', end_time: '01:30', hour_price: 100, deposit: 50, account_id: acc('field') }, /يتعارض/);
  await ok('admin', 'POST', '/field/bookings', { customer_name: 'آخر', play_date: addDays(pd, 1), start_time: '01:00', end_time: '02:00', hour_price: 100, deposit: 100, account_id: acc('field') });
  const sch = await ok('admin', 'GET', `/field/schedule?from=${pd}&days=7`);
  assert.ok(sch.bookings.length >= 2);
  step(`field booking across midnight ${fb.no} (2h=200), overlap blocked`);

  // ---- المغسلة: مثال 100 → دفع 50 → دفع 30 → المتبقي 20 ----
  const svc = (await ok('wash', 'GET', '/laundry/services'))[0];
  const o = await ok('wash', 'POST', '/laundry/orders', { service_id: svc.id, customer_name: 'محمد', customer_tag: 'السوق', price: 100, paid_now: 50, account_id: acc('laundry') });
  assert.match(o.no, /^U\d+$/);
  let od = await ok('wash', 'GET', `/laundry/orders/${o.id}`);
  assert.strictEqual(od.status, 'partial');
  assert.strictEqual(od.remaining, 5000);
  await ok('wash', 'POST', `/laundry/orders/${o.id}/payments`, { amount: 30, account_id: acc('laundry'), pay_type: 'debt' });
  od = await ok('wash', 'GET', `/laundry/orders/${o.id}`);
  assert.strictEqual(od.remaining, 2000);
  await fail('wash', 'POST', '/laundry/orders', { service_id: svc.id, customer_name: 'محمد', customer_tag: 'السوق', price: 10 }, /بنفس الاسم/);
  const o2 = await ok('wash', 'POST', '/laundry/orders', { service_id: svc.id, customer_id: o.customer_id, price: 40 });
  od = await ok('wash', 'GET', `/laundry/orders/${o2.id}`);
  assert.strictEqual(od.status, 'unpaid');
  let debts = await ok('wash', 'GET', '/laundry/debts');
  assert.strictEqual(debts.total, 6000);
  await ok('wash', 'POST', `/laundry/customers/${o.customer_id}/pay`, { amount: 60, account_id: acc('laundry') });
  debts = await ok('wash', 'GET', '/laundry/debts');
  assert.strictEqual(debts.total, 0);
  od = await ok('wash', 'GET', `/laundry/orders/${o.id}`);
  assert.strictEqual(od.status, 'paid');
  step('laundry 100 -> paid 50 -> paid 30 -> remaining 20; debts cleared -> paid');

  // ---- المصروفات والرصيد ----
  await fail('wash', 'POST', '/txns/expense', { facility_id: F.laundry.id, account_id: acc('laundry'), amount: 999, category: 'مواد تنظيف', party: 'محل' }, /لا يكفي/);
  const ex = await ok('wash', 'POST', '/txns/expense', { facility_id: F.laundry.id, account_id: acc('laundry'), amount: 20, category: 'مواد تنظيف', party: 'محل المواد' });
  await fail('wash', 'POST', '/txns/expense', { facility_id: F.hall.id, account_id: acc('hall'), amount: 1, category: 'رواتب', party: 'x' }, /صلاحية/);
  let tr = await ok('admin', 'GET', `/treasury/${F.laundry.id}`);
  assert.strictEqual(tr.current, 14000 - 2000); // 50 + 30 + 60 دخلت، 20 مصروف
  await ok('admin', 'POST', `/txns/${ex.id}/cancel`, { reason: 'خطأ إدخال' });
  tr = await ok('admin', 'GET', `/treasury/${F.laundry.id}`);
  assert.strictEqual(tr.current, 14000);
  step('expense deducted from account, cancel restores balance (kept in log)');

  // ---- حساب موظف + تمويل من الحساب الاحتياطي ----
  await ok('admin', 'POST', '/accounts', { facility_id: F.hall.id, name: 'أسامة', type: 'employee', phone: '0599000000', opening_balance: 0 });
  // حساب دفع يضيفه المدير: بنك فلسطين — فلان
  const bank = await ok('admin', 'POST', '/accounts', { facility_id: F.hall.id, name: 'بنك فلسطين', holder: 'فلان', type: 'bank', opening_balance: 0 });
  await ok('hall', 'POST', '/txns/income', { facility_id: F.hall.id, account_id: bank.id, amount: 700, category: 'أخرى', party: 'تحويل' });
  await ok('hall', 'POST', '/txns/expense', { facility_id: F.hall.id, account_id: bank.id, amount: 200, category: 'صيانة', party: 'فني' });
  const inv = await ok('owner', 'GET', `/accounts-summary?from=${T}&to=${T}`);
  const bk = inv.rows.find((a) => a.id === bank.id);
  assert.strictEqual(bk.label, 'بنك فلسطين — فلان');
  assert.deepStrictEqual([bk.tin, bk.tout, bk.closing], [70000, 20000, 50000]);
  assert.ok((await ok('hall', 'GET', '/meta')).facilities[0].accounts.some((a) => a.name === 'بنك فلسطين — فلان'));
  const general = meta.facilities.find((f) => f.kind === 'general');
  await ok('admin', 'PUT', `/accounts/${general.accounts[0].id}`, { opening_balance: 10000 });
  // موظف الصالة يسجل ديناً على قسمه فقط ويسدده، والإلغاء للمدير
  const sd = await ok('hall', 'POST', '/fundings', { facility_id: F.hall.id, received: 'yes', account_id: acc('hall'), party: 'أبو سمير', amount: 50, reason: 'سلفة لشراء ورد' });
  await fail('hall', 'POST', '/fundings', { facility_id: F.field.id, party: 'x', amount: 5, reason: 'x' }, /صلاحية/);
  await ok('hall', 'POST', `/fundings/${sd.id}/repay`, { amount: 50, account_id: acc('hall'), reason: 'رجعناله السلفة' });
  await fail('hall', 'POST', `/fundings/${sd.id}/cancel`, { reason: 'x' }, /للمدير/);
  assert.strictEqual((await ok('hall', 'GET', '/fundings')).length, 1);
  // دين على الملعب: استلمنا المبلغ كاش، وسداده يحتاج سبباً
  const fu = await ok('admin', 'POST', '/fundings', { facility_id: F.field.id, received: 'yes', account_id: acc('field'), party: 'أبو علي', amount: 1000, reason: 'صيانة الإنارة' });
  await fail('admin', 'POST', '/fundings', { facility_id: F.field.id, party: 'x', amount: 5 }, /سبب الدين/);
  await fail('admin', 'POST', `/fundings/${fu.id}/repay`, { amount: 100, account_id: acc('field') }, /سبب/);
  const r1 = await ok('admin', 'POST', `/fundings/${fu.id}/repay`, { amount: 100, account_id: acc('field'), reason: 'دفعة أولى' });
  assert.strictEqual(r1.settled, false);
  let fl = (await ok('admin', 'GET', '/fundings')).find((x) => x.id === fu.id);
  assert.strictEqual(fl.debt_status, 'partial');
  const r2 = await ok('admin', 'POST', `/fundings/${fu.id}/repay`, { amount: 900, account_id: acc('field'), reason: 'تسديد كامل', allow_negative: true });
  assert.strictEqual(r2.settled, true);
  fl = (await ok('admin', 'GET', '/fundings')).find((x) => x.id === fu.id);
  assert.strictEqual(fl.debt_status, 'settled');
  assert.deepStrictEqual(fl.txns.filter((t) => t.kind === 'funding_repay').map((t) => t.notes), ['دفعة أولى', 'تسديد كامل']);
  // دين على الصالة بدون استلام مصاري (شراء بالدين): لا يدخل الصندوق
  const hallBefore = (await ok('admin', 'GET', `/treasury/${F.hall.id}`)).current;
  const ext = await ok('admin', 'POST', '/fundings', { facility_id: F.hall.id, received: 'no', party: 'محل الكراسي', amount: 500, reason: 'شراء كراسي بالدين' });
  assert.strictEqual((await ok('admin', 'GET', `/treasury/${F.hall.id}`)).current, hallBefore);
  assert.strictEqual((await ok('admin', 'GET', '/dashboard')).owed_total, 50000);
  step('payment accounts inventory (bank — holder: in 700 / out 200 / left 500)');
  step('employee account; debts owed by facility with reasons, repayments with reasons, status -> settled');

  // ---- التقارير ----
  const rep = require('../server/reports/data').buildPeriodReport({ preset: 'day', date: T });
  const S = rep.summary;
  assert.strictEqual(S.receivables, 0);
  assert.strictEqual(S.funding_external, 50000);
  assert.strictEqual(S.funding_internal, 0);
  assert.strictEqual(S.net_assets, S.balances + S.receivables - S.funding_external);
  const hallSec = rep.sections.find((s) => s.facility.kind === 'hall');
  assert.strictEqual(hallSec.new_bookings_count, 2);
  assert.ok(hallSec.totals.refunds === 30000);
  const pm = Object.fromEntries(hallSec.by_method.map((m) => [m.label, m]));
  assert.strictEqual(pm['بال باي'].tin, 100000);
  assert.strictEqual(pm['جوال باي'].tin, 150000);
  assert.strictEqual(hallSec.by_method.reduce((x, m) => x + m.closing, 0), hallSec.closing);
  const payRow = hallSec.ins.find((t) => t.ref_no === hb.no);
  assert.strictEqual(payRow.booking_date, T);
  assert.ok(payRow.event.startsWith(ev));
  const st = require('../server/reports/data').buildStatement({});
  assert.strictEqual(st.closing, st.opening + st.totals.tin - st.totals.tout);
  step(`period report + statement balance identity (net assets ${S.net_assets / 100})`);

  const html = await call('admin', 'GET', `/reports/view?preset=last7`);
  assert.strictEqual(html.status, 200);
  const xls = await call('admin', 'GET', `/reports/excel?kind=statement&preset=all`);
  assert.strictEqual(xls.status, 200);
  assert.ok(xls.data.byteLength > 2000);
  step('HTML view + Excel export');

  const { findChrome } = require('../server/reports/pdf');
  if (findChrome()) {
    await ok('admin', 'PUT', '/admin/settings', { telegram_enabled: true, telegram_token: '123:TEST', telegram_chat_id: '' });
    const chats = await ok('admin', 'GET', '/admin/settings/telegram-chats');
    assert.strictEqual(chats[0].id, '222');
    const test = await ok('admin', 'POST', '/admin/settings/telegram-test');
    assert.deepStrictEqual(test.ok, ['المدير', 'المالك']);
    // كشف لكل منشأة لحاله
    const g = await ok('admin', 'POST', '/reports/generate', { kind: 'statement', preset: 'all', send: true });
    assert.ok(g.items.length >= 3, 'separate statement per facility');
    assert.ok(g.items.every((i) => i.sent && i.sent.ok), JSON.stringify(g.items));
    assert.deepStrictEqual(g.items[0].sent.sent_to, ['المدير', 'المالك'], 'report reaches manager and owner together');
    const docs = tgReceived.filter((x) => x.url.endsWith('/sendDocument'));
    assert.strictEqual(docs.filter((x) => x.chat === '111').length, docs.filter((x) => x.chat === '222').length);
    // فشل مستلم واحد لا يمنع الباقين، وإعادة المحاولة لا تكرر لمن استلم
    await ok('admin', 'PUT', '/admin/settings', { telegram_chat_id: '999' });
    const gf = await ok('admin', 'POST', '/reports/generate', { kind: 'statement', preset: 'all', facility_id: F.hall.id, send: true });
    assert.strictEqual(gf.items[0].sent.ok, false);
    await ok('admin', 'PUT', '/admin/settings', { telegram_chat_id: '' });
    const before = tgReceived.length;
    const again = await require('../server/reports/service').sendReport(gf.items[0].id);
    assert.strictEqual(again.already, true);
    assert.strictEqual(tgReceived.length, before);
    // الإرسال اليدوي لشخص محدد فقط
    const n0 = tgReceived.length;
    const only = await ok('admin', 'POST', '/reports/generate', { kind: 'period', preset: 'month', facility_id: F.hall.id, send: true, recipients: ['222'] });
    assert.deepStrictEqual(only.items[0].sent.sent_to, ['المالك']);
    assert.ok(tgReceived.slice(n0).every((x) => x.chat === '222'));
    // الاشتراكات: المالك يستلم الأسبوعي فقط
    const owner = (await ok('admin', 'GET', '/admin/users')).find((u) => u.username === 'owner');
    await ok('admin', 'PUT', `/admin/users/${owner.id}`, { tg_daily: false, tg_weekly: true, tg_monthly: false, tg_notify: false });
    const sched0 = require('../server/scheduler');
    const pm = addDays(`${T.slice(0, 7)}-01`, -1).slice(0, 7);
    const n1 = tgReceived.length;
    await sched0.autoReport('monthly', `${pm}-01`, addDays(`${T.slice(0, 7)}-01`, -1), { preset: 'month', month: pm });
    const monthlyDocs = tgReceived.slice(n1).filter((x) => x.url.endsWith('/sendDocument'));
    assert.ok(monthlyDocs.length >= 4 && monthlyDocs.every((x) => x.chat === '111'), 'monthly only to subscribers');
    // رسائل العمليات الفورية: للمدير فقط (المالك غير مشترك)
    const n2 = tgReceived.length;
    const { db } = require('../server/db');
    db.prepare("UPDATE notifications SET status='skipped' WHERE status='pending'").run();
    await ok('hall', 'POST', '/txns/expense', { facility_id: F.hall.id, account_id: bank.id, amount: 10, category: 'صيانة', party: 'كهربائي' });
    await sched0.flushNotifications();
    const msgs = tgReceived.slice(n2).filter((x) => x.url.endsWith('/sendMessage'));
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].chat, '111');
    const note = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 1').get();
    assert.strictEqual(note.status, 'sent');
    assert.match(note.text, /مصروف/);
    assert.match(note.text, /بنك فلسطين — فلان/);
    assert.match(note.text, /سجّلها: موظف الصالة/);
    console.log('  sample message:\n' + note.text.split('\n').map((l) => '    ' + l).join('\n'));
    // المالك يستطيع إنشاء ملف PDF لكن لا يستطيع الإرسال
    const og = await ok('owner', 'POST', '/reports/generate', { kind: 'period', preset: 'day', facility_id: F.hall.id });
    assert.strictEqual(og.items.length, 1);
    await fail('owner', 'POST', '/reports/generate', { kind: 'period', preset: 'day', send: true }, /للاطلاع|للمدير/);
    const gp = await ok('admin', 'POST', '/reports/generate', { kind: 'period', preset: 'day' });
    assert.ok(gp.items.some((i) => i.title.startsWith('الملخص الإجمالي')));
    assert.ok(gp.items.some((i) => i.title.startsWith('صالة الأفراح')));
    for (const it of gp.items) {
      const f = await call('admin', 'GET', `/reports/${it.id}/pdf`);
      fs.writeFileSync(path.join(tmp, `${it.title.split(' — ')[0]}.pdf`), Buffer.from(f.data));
    }
    const pdf = await call('admin', 'GET', `/reports/${g.items[0].id}/pdf`);
    assert.strictEqual(Buffer.from(pdf.data).slice(0, 4).toString(), '%PDF');
    fs.writeFileSync(path.join(tmp, 'statement.pdf'), Buffer.from(pdf.data));
    // التقرير اليومي التلقائي + علامة "قديم" عند تسجيل عملية متأخرة
    const sched = require('../server/scheduler');
    await sched.tick();
    const reps = await ok('admin', 'GET', '/reports');
    const dailies = reps.filter((r) => r.auto && r.type === 'daily');
    assert.ok(dailies.length >= 4, 'daily: one file per facility + summary');
    assert.ok(dailies.every((r) => r.telegram_status === 'sent'), 'daily auto reports sent');
    await sched.tick();
    assert.strictEqual((await ok('admin', 'GET', '/reports')).filter((r) => r.auto && r.type === 'daily').length, dailies.length, 'no duplicates');
    const daily = dailies.find((r) => r.title.startsWith('صالة الأفراح'));
    const y = addDays(T, -1);
    await ok('admin', 'POST', '/txns/income', { facility_id: F.hall.id, account_id: acc('hall'), amount: 5, category: 'أخرى', party: 'متأخر', op_date: y });
    const after = (await ok('admin', 'GET', '/reports')).find((r) => r.id === daily.id);
    assert.strictEqual(after.stale, 1);
    await ok('admin', 'POST', `/reports/${daily.id}/regenerate`, { send: true });
    step(`PDF generated (${pdf.data.byteLength} bytes), sent to Telegram, daily auto report + stale detection`);
    console.log('  sample PDF:', path.join(tmp, 'statement.pdf'));
  } else {
    console.log('⚠ Chrome not found — PDF/Telegram tests skipped');
  }

  // ---- سجل الرقابة والبحث بالرقم ----
  const audit = await ok('admin', 'GET', '/admin/audit');
  assert.ok(audit.some((a) => a.action === 'cancel'));
  const lk = await ok('admin', 'GET', `/lookup?q=${hb.no.toLowerCase()}`);
  assert.deepStrictEqual(lk, { type: 'hall', id: hb.id });
  await fail('hall', 'GET', `/lookup?q=${o.no}`, null, /قسم آخر/);
  const dash = await ok('admin', 'GET', '/dashboard');
  assert.strictEqual(dash.new_counts.hall, 2);
  step('audit log, lookup by number, dashboard');

  await require('../server/reports/pdf').closeBrowser();
  srv.close();
  tg.close();
  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch(async (e) => {
  console.error('✘', e);
  try { await require('../server/reports/pdf').closeBrowser(); } catch { /* ignore */ }
  process.exit(1);
});
