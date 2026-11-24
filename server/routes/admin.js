'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, nowISO } = require('../db');
const { bad, HttpError, str, audit, getSetting, setSetting, encrypt, TIME_RE, toMinor, toMajor } = require('../util');
const telegram = require('../telegram');
const backup = require('../backup');

const r = express.Router();

// ---------- المستخدمون ----------
r.get('/users', (req, res) => {
  res.json(db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.facility_id, u.telegram_chat_id, u.active, u.created_at, f.name AS facility_name,
      (SELECT MAX(created_at) FROM audit a WHERE a.user_id=u.id) AS last_activity
    FROM users u LEFT JOIN facilities f ON f.id=u.facility_id ORDER BY u.id`).all());
});

function validateUser(B, isNew) {
  const d = {
    username: str(B.username, 'اسم المستخدم', { required: true, max: 50 }),
    display_name: str(B.display_name, 'اسم الموظف', { required: true, max: 100 }),
    role: ['admin', 'viewer'].includes(B.role) ? B.role : 'staff',
    facility_id: B.facility_id ? Number(B.facility_id) : null,
    telegram_chat_id: str(B.telegram_chat_id, 'رقم تيليجرام', { max: 40 }),
    active: B.active === undefined ? 1 : (B.active ? 1 : 0),
  };
  if (!/^[\w.\-]+$/.test(d.username)) throw bad('اسم المستخدم: أحرف إنجليزية وأرقام فقط');
  if (d.role === 'staff' && !d.facility_id) throw bad('حدد القسم الذي يدخل إليه الموظف');
  if (d.role !== 'staff') d.facility_id = null;
  if (d.telegram_chat_id && !/^-?\d+$/.test(d.telegram_chat_id)) throw bad('رقم تيليجرام يجب أن يكون أرقاماً فقط');
  if (d.facility_id && !db.prepare('SELECT id FROM facilities WHERE id=?').get(d.facility_id)) throw bad('القسم غير موجود');
  if (isNew || B.password) {
    if (String(B.password || '').length < 6) throw bad('كلمة المرور 6 أحرف على الأقل');
  }
  return d;
}

r.post('/users', (req, res) => {
  const d = validateUser(req.body || {}, true);
  if (db.prepare('SELECT id FROM users WHERE username=?').get(d.username)) throw bad('اسم المستخدم مستخدم مسبقاً');
  const info = db.prepare(`INSERT INTO users (username, display_name, password_hash, role, facility_id, telegram_chat_id, active, must_change_password, created_at)
    VALUES (?,?,?,?,?,?,?,1,?)`).run(d.username, d.display_name, bcrypt.hashSync(req.body.password, 10), d.role, d.facility_id, d.telegram_chat_id, d.active, nowISO());
  audit(req.user, 'create', 'user', info.lastInsertRowid, { summary: `إضافة مستخدم: ${d.display_name} (${d.username})` });
  res.json({ id: info.lastInsertRowid });
});

r.put('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  if (!u) throw new HttpError(404, 'المستخدم غير موجود');
  const d = validateUser({ ...u, ...req.body }, false);
  if (u.id === req.user.id && (d.role !== 'admin' || !d.active)) throw bad('لا يمكنك تعطيل حسابك أو إزالة صلاحية المدير عنه');
  if (db.prepare('SELECT id FROM users WHERE username=? AND id<>?').get(d.username, u.id)) throw bad('اسم المستخدم مستخدم مسبقاً');
  db.prepare('UPDATE users SET username=?, display_name=?, role=?, facility_id=?, telegram_chat_id=?, active=? WHERE id=?')
    .run(d.username, d.display_name, d.role, d.facility_id, d.telegram_chat_id, d.active, u.id);
  if (req.body.password) {
    db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').run(bcrypt.hashSync(req.body.password, 10), u.id);
  }
  if (!d.active || req.body.password) db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  const before = { ...u };
  delete before.password_hash;
  audit(req.user, 'update', 'user', u.id, {
    summary: `تعديل مستخدم: ${d.display_name}${!d.active ? ' (تعطيل)' : ''}${req.body.password ? ' (تغيير كلمة المرور)' : ''}`,
    details: { before, after: d },
  });
  res.json({ ok: true });
});

// ---------- سجل النشاطات ----------
r.get('/audit', (req, res) => {
  const q = req.query;
  const where = ['1=1'];
  const args = [];
  if (q.user_id) { where.push('a.user_id=?'); args.push(Number(q.user_id)); }
  if (q.facility_id) { where.push('a.facility_id=?'); args.push(Number(q.facility_id)); }
  if (q.action) { where.push('a.action=?'); args.push(q.action); }
  if (q.from) { where.push('a.created_at>=?'); args.push(`${q.from}T00:00:00`); }
  if (q.to) { where.push('a.created_at<=?'); args.push(`${q.to}T23:59:59.999Z`); }
  if (q.q) { where.push('(a.summary LIKE ? OR a.ref_no LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
  res.json(db.prepare(`SELECT a.*, u.display_name AS user_name, f.name AS facility_name FROM audit a
    LEFT JOIN users u ON u.id=a.user_id LEFT JOIN facilities f ON f.id=a.facility_id
    WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 1000`).all(...args));
});

// ---------- الإعدادات ----------
const PUBLIC_KEYS = ['timezone', 'currency', 'daily_report_time', 'weekly_report_day', 'weekly_report_time', 'backup_time', 'backup_keep',
  'staff_can_cancel', 'field_open', 'field_close', 'field_hour_price', 'telegram_enabled', 'telegram_chat_id'];

r.get('/settings', (req, res) => {
  const out = {};
  for (const k of PUBLIC_KEYS) out[k] = getSetting(k);
  out.field_hour_price = String(toMajor(Number(out.field_hour_price || 0)));
  out.telegram_token_set = !!getSetting('telegram_token_enc');
  out.facilities = db.prepare('SELECT * FROM facilities ORDER BY sort').all();
  out.categories = db.prepare('SELECT * FROM categories ORDER BY facility_id, kind, id').all();
  res.json(out);
});

r.put('/settings', (req, res) => {
  const B = req.body || {};
  const changed = [];
  const set = (k, v) => { if (getSetting(k) !== String(v)) { setSetting(k, v); changed.push(k); } };
  if (B.timezone !== undefined) {
    try { new Intl.DateTimeFormat('en', { timeZone: B.timezone }); } catch { throw bad('المنطقة الزمنية غير صحيحة'); }
    set('timezone', B.timezone);
  }
  if (B.currency !== undefined) set('currency', str(B.currency, 'العملة', { max: 10 }) || '');
  for (const k of ['daily_report_time', 'weekly_report_time', 'backup_time', 'field_open', 'field_close']) {
    if (B[k] !== undefined) { if (!TIME_RE.test(B[k])) throw bad(`وقت غير صحيح: ${k}`); set(k, B[k]); }
  }
  if (B.weekly_report_day !== undefined) {
    if (!/^[0-6]$/.test(String(B.weekly_report_day))) throw bad('يوم غير صحيح');
    set('weekly_report_day', B.weekly_report_day);
  }
  if (B.backup_keep !== undefined) set('backup_keep', Math.max(3, Number(B.backup_keep) || 30));
  if (B.staff_can_cancel !== undefined) set('staff_can_cancel', B.staff_can_cancel ? '1' : '0');
  if (B.field_hour_price !== undefined) set('field_hour_price', toMinor(B.field_hour_price, 'سعر الساعة', { allowZero: true }));
  if (B.telegram_enabled !== undefined) set('telegram_enabled', B.telegram_enabled ? '1' : '0');
  if (B.telegram_chat_id !== undefined) set('telegram_chat_id', str(B.telegram_chat_id, 'رقم المحادثة', { max: 50 }) || '');
  if (B.telegram_token) { setSetting('telegram_token_enc', encrypt(String(B.telegram_token).trim())); changed.push('telegram_token'); }
  if (changed.length) audit(req.user, 'update', 'settings', null, { summary: `تعديل الإعدادات: ${changed.join(', ')}` });
  res.json({ ok: true });
});

r.post('/settings/telegram-test', async (req, res) => {
  let out;
  try {
    out = await telegram.sendText('✅ تم ربط نظام إدارة الصالة والمغسلة والملعب. ستصلك التقارير هنا.');
  } catch (e) {
    throw bad(`فشل الاختبار: ${e.message}`);
  }
  res.json({ ok: out.ok.map((x) => x.name), failed: out.failed.map((x) => `${x.name}: ${x.error}`) });
});

r.get('/settings/telegram-recipients', (req, res) => res.json(telegram.recipients()));

// المحادثات التي راسلت البوت — لمعرفة رقم المدير والمالك
r.get('/settings/telegram-chats', async (req, res) => {
  try {
    res.json(await telegram.recentChats());
  } catch (e) {
    throw bad(e.message);
  }
});

// ---------- المنشآت ورموز الترقيم ----------
r.post('/facilities', (req, res) => {
  const name = str(req.body.name, 'اسم المنشأة', { required: true, max: 100 });
  const prefix = String(req.body.prefix || '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(prefix)) throw bad('رمز الترقيم: حرف إلى ثلاثة أحرف إنجليزية');
  if (db.prepare('SELECT id FROM facilities WHERE prefix=?').get(prefix)) throw bad('الرمز مستخدم لمنشأة أخرى');
  const id = db.transaction(() => {
    const fid = db.prepare("INSERT INTO facilities (kind, name, prefix, sort) VALUES ('other', ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM facilities))")
      .run(name, prefix).lastInsertRowid;
    db.prepare(`INSERT INTO accounts (facility_id, name, type, opening_balance, opening_date, created_by, created_at)
      VALUES (?, ?, 'safe', 0, date('now'), ?, ?)`).run(fid, `خزنة ${name}`, req.user.id, nowISO());
    const ins = db.prepare('INSERT INTO categories (facility_id, kind, name) VALUES (?,?,?)');
    for (const n of ['رواتب', 'صيانة', 'أخرى']) ins.run(fid, 'expense', n);
    for (const n of ['إيراد', 'أخرى']) ins.run(fid, 'income', n);
    return fid;
  })();
  audit(req.user, 'create', 'facility', id, { summary: `إضافة منشأة: ${name} (${prefix})` });
  res.json({ id });
});

r.put('/facilities/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM facilities WHERE id=?').get(Number(req.params.id));
  if (!f) throw new HttpError(404, 'غير موجودة');
  const name = str(req.body.name ?? f.name, 'اسم المنشأة', { required: true, max: 100 });
  const prefix = String(req.body.prefix ?? f.prefix).trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(prefix)) throw bad('رمز الترقيم: حرف إلى ثلاثة أحرف إنجليزية');
  if (db.prepare('SELECT id FROM facilities WHERE prefix=? AND id<>?').get(prefix, f.id)) throw bad('الرمز مستخدم لمنشأة أخرى');
  let nextNo = f.next_no;
  if (req.body.next_no !== undefined && Number(req.body.next_no) !== f.next_no) {
    nextNo = Number(req.body.next_no);
    if (!Number.isInteger(nextNo) || nextNo < 1) throw bad('رقم البداية غير صحيح');
  }
  // نتأكد أن تغيير الرمز أو الرقم لا يكرر أرقاماً مستخدمة
  if (prefix !== f.prefix || nextNo !== f.next_no) {
    for (const tbl of ['txns', 'hall_bookings', 'field_bookings', 'orders', 'fundings']) {
      const used = db.prepare(`SELECT MAX(CAST(SUBSTR(no, ?) AS INTEGER)) m FROM ${tbl} WHERE no GLOB ?`).get(prefix.length + 1, `${prefix}[0-9]*`).m;
      if (used && used >= nextNo) throw bad(`الرقم ${prefix}${nextNo} أو ما بعده مستخدم. اختر رقم بداية أكبر من ${used}`);
    }
  }
  const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : f.active;
  db.prepare('UPDATE facilities SET name=?, prefix=?, next_no=?, active=? WHERE id=?').run(name, prefix, nextNo, active, f.id);
  audit(req.user, 'update', 'facility', f.id, { summary: `تعديل منشأة: ${name} (${prefix}${nextNo})`, details: { before: f } });
  res.json({ ok: true });
});

// ---------- التصنيفات ----------
r.post('/categories', (req, res) => {
  const fid = Number(req.body.facility_id);
  const kind = req.body.kind === 'income' ? 'income' : 'expense';
  const name = str(req.body.name, 'اسم التصنيف', { required: true, max: 100 });
  try {
    db.prepare('INSERT INTO categories (facility_id, kind, name) VALUES (?,?,?)').run(fid, kind, name);
  } catch {
    throw bad('التصنيف موجود مسبقاً');
  }
  audit(req.user, 'create', 'category', null, { facilityId: fid, summary: `إضافة تصنيف ${kind === 'income' ? 'إيداع' : 'مصروف'}: ${name}` });
  res.json({ ok: true });
});

r.put('/categories/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM categories WHERE id=?').get(Number(req.params.id));
  if (!c) throw new HttpError(404, 'غير موجود');
  db.prepare('UPDATE categories SET active=? WHERE id=?').run(req.body.active ? 1 : 0, c.id);
  audit(req.user, 'update', 'category', c.id, { facilityId: c.facility_id, summary: `${req.body.active ? 'تفعيل' : 'إيقاف'} تصنيف: ${c.name}` });
  res.json({ ok: true });
});

// ---------- النسخ الاحتياطي ----------
r.get('/backups', (req, res) => res.json(backup.list()));
r.post('/backups', async (req, res) => {
  const name = await backup.backupNow('manual');
  audit(req.user, 'create', 'backup', null, { summary: `نسخة احتياطية يدوية: ${name}` });
  res.json({ name });
});
r.get('/backups/:name', (req, res) => {
  const p = backup.filePath(req.params.name);
  if (!p) throw new HttpError(404, 'غير موجودة');
  audit(req.user, 'download', 'backup', null, { summary: `تنزيل نسخة احتياطية: ${req.params.name}` });
  res.download(p);
});

module.exports = { router: r };
