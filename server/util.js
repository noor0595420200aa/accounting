'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR, nowISO } = require('./db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

// ---------- الإعدادات ----------
function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function tz() {
  return getSetting('timezone') || 'Asia/Hebron';
}

// ---------- التواريخ (حسب المنطقة الزمنية في الإعدادات) ----------
function localParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: wd };
}
const today = () => localParts().date;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function reqDate(v, label, def) {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  if (!isDate(v)) throw bad(`${label}: تاريخ غير صحيح`);
  return v;
}

// ---------- المبالغ: تخزن كأعداد صحيحة (× 100) لتجنب أخطاء الكسور ----------
function toMinor(v, label, { allowZero = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (allowZero) return 0;
    throw bad(`${label}: المبلغ مطلوب`);
  }
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n)) throw bad(`${label}: مبلغ غير صحيح`);
  const m = Math.round(n * 100);
  if (m < 0 || (!allowZero && m === 0)) throw bad(`${label}: يجب أن يكون المبلغ أكبر من صفر`);
  if (m > 1e13) throw bad(`${label}: المبلغ كبير جداً`);
  return m;
}
const toMajor = (m) => Math.round(m) / 100;
function fmt(m) {
  const v = toMajor(m || 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function str(v, label, { required = false, max = 2000 } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (required && !s) throw bad(`${label} مطلوب`);
  if (s.length > max) throw bad(`${label}: النص طويل جداً`);
  return s || null;
}

// ---------- الترقيم: كل منشأة لها تسلسل مستقل برمزها ----------
function nextNo(facilityId) {
  const r = db.prepare('UPDATE facilities SET next_no = next_no + 1 WHERE id = ? RETURNING prefix, next_no - 1 AS n')
    .get(facilityId);
  if (!r) throw bad('منشأة غير موجودة');
  return `${r.prefix}${r.n}`;
}

// ---------- سجل الرقابة ----------
function audit(user, action, entity, entityId, { facilityId = null, refNo = null, summary = null, details = null } = {}) {
  db.prepare(`INSERT INTO audit (user_id, facility_id, action, entity, entity_id, ref_no, summary, details, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(user ? user.id : null, facilityId, action, entity, entityId, refNo, summary,
      details ? JSON.stringify(details) : null, nowISO());
}

function addAlert(type, message, refId = null) {
  db.prepare('INSERT INTO alerts (type, message, ref_id, created_at) VALUES (?,?,?,?)').run(type, message, refId, nowISO());
}

// عند تسجيل/إلغاء عملية بتاريخ يوم سبق إرسال تقريره: نعلّم التقرير كـ"قديم" وننبه المدير
function markStale(dates) {
  const list = [...new Set(dates.filter(Boolean))];
  for (const d of list) {
    const reps = db.prepare(`SELECT id, title FROM reports WHERE auto = 1 AND stale = 0
      AND period_from <= ? AND period_to >= ? AND created_at IS NOT NULL`).all(d, d);
    for (const r of reps) {
      db.prepare('UPDATE reports SET stale = 1 WHERE id = ?').run(r.id);
      addAlert('stale_report', `تم تسجيل أو إلغاء عملية بتاريخ ${d} بعد إنشاء التقرير "${r.title}". يُنصح بإعادة توليده وإرساله.`, r.id);
    }
  }
}

// ---------- تشفير توكن تيليجرام ----------
function secretKey() {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const p = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(p)) fs.writeFileSync(p, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex');
}
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  if (!blob) return '';
  try {
    const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

const LABELS = {
  period: { evening: 'مسائية', morning: 'صباحية' },
  bookingStatus: { confirmed: 'حجز مؤكد', paid: 'مكتمل الدفع', cancelled: 'ملغي' },
  orderStatus: { paid: 'مدفوع', unpaid: 'غير مدفوع', partial: 'دفع جزئي', cancelled: 'ملغي' },
  payType: {
    deposit: 'عربون', completion: 'دفعة تكملة', extra: 'دفعة إضافية', full: 'دفع كامل',
    advance: 'دفع مقدم', on_pickup: 'دفع عند الاستلام', debt: 'سداد دين',
  },
  kind: {
    payment: 'دفعة', income: 'إيداع', expense: 'مصروف', refund: 'مرتجع',
    funding: 'تمويل وارد', funding_out: 'تمويل صادر', funding_repay: 'سداد تمويل', funding_repay_in: 'استرداد تمويل',
  },
  accountType: {
    safe: 'كاش (خزنة)', employee: 'كاش مع موظف', palpay: 'بال باي', jawwalpay: 'جوال باي', bank: 'حساب بنكي', reserve: 'حساب احتياطي', other: 'أخرى',
  },
  method: { cash: 'كاش', palpay: 'بال باي', jawwalpay: 'جوال باي', bank: 'بنك', reserve: 'احتياطي', other: 'أخرى' },
  cancelAction: { refund_all: 'إرجاع كامل المبلغ', keep: 'الاحتفاظ بالمبلغ', partial: 'خصم وإرجاع الباقي', none: 'لا توجد مبالغ' },
};

// طريقة وصول المال حسب نوع الحساب: الخزنة وحساب الموظف كلاهما كاش
const METHOD_OF = { safe: 'cash', employee: 'cash', palpay: 'palpay', jawwalpay: 'jawwalpay', bank: 'bank', reserve: 'reserve', other: 'other' };
const methodOf = (type) => METHOD_OF[type] || 'other';
const METHOD_ORDER = ['cash', 'palpay', 'jawwalpay', 'bank', 'reserve', 'other'];

module.exports = {
  methodOf, METHOD_ORDER,
  HttpError, bad, getSetting, setSetting, tz, localParts, today, isDate, addDays, daysBetween, reqDate,
  TIME_RE, toMinor, toMajor, fmt, str, nextNo, audit, addAlert, markStale, encrypt, decrypt, LABELS, nowISO,
};
