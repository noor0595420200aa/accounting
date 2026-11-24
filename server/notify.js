'use strict';
/**
 * رسائل تيليجرام فورية لكل عملية بقالب موحد.
 * تُكتب الرسالة داخل نفس معاملة قاعدة البيانات (إذا فشلت العملية لا تُرسل رسالة)،
 * ثم يرسلها المجدول خلال ثوانٍ لكل من اختار استلام رسائل العمليات.
 */
const { db, nowISO } = require('./db');
const { fmt, getSetting, LABELS } = require('./util');

const LINE = '━━━━━━━━━━━━━━';
const cur = () => (getSetting('currency') ? ` ${getSetting('currency')}` : '');
const m = (x) => `${fmt(x)}${cur()}`;

function accLabel(id) {
  const a = id && db.prepare('SELECT label FROM accounts WHERE id=?').get(Number(id));
  return a ? a.label : '—';
}

function facilityBalance(fid) {
  const L = require('./ledger');
  return db.prepare('SELECT id FROM accounts WHERE facility_id=?').all(fid).reduce((s, a) => s + L.accountBalance(a.id), 0);
}

function localNow() {
  try {
    return new Date().toLocaleString('en-GB', { timeZone: getSetting('timezone') || 'UTC', hour12: false, dateStyle: 'short', timeStyle: 'short' }).replace(',', '');
  } catch {
    return nowISO();
  }
}

/**
 * القالب:
 *   <أيقونة> <العنوان>  <رقم العملية>
 *   ━━━━━━━━
 *   سطور التفاصيل
 *   ━━━━━━━━
 *   🏢 المنشأة · الرصيد الآن
 *   ✍️ سجّلها: الموظف · 🕒 الوقت
 */
function queue(user, { icon, title, no, lines, facilityId }) {
  try {
    const f = facilityId ? db.prepare('SELECT name FROM facilities WHERE id=?').get(facilityId) : null;
    const body = lines.filter((l) => l !== null && l !== undefined && l !== false && l !== '').join('\n');
    const text = [
      `${icon} ${title}${no ? `  #${no}` : ''}`,
      LINE,
      body,
      LINE,
      f ? `🏢 ${f.name} · 💼 الرصيد الآن: ${m(facilityBalance(facilityId))}` : null,
      `✍️ سجّلها: ${user ? user.display_name : 'النظام'} · 🕒 ${localNow()}`,
    ].filter(Boolean).join('\n');
    db.prepare('INSERT INTO notifications (text, facility_id, created_at) VALUES (?,?,?)').run(text, facilityId || null, nowISO());
  } catch (e) {
    console.error('notify.queue', e);
  }
}

const P = LABELS.period;
const FIELD_NAMES = {
  customer_name: 'الاسم', phone: 'الهاتف', reg_date: 'تاريخ التسجيل', event_date: 'تاريخ الفرح', period: 'الفترة', total: 'السعر',
  play_date: 'تاريخ اللعب', start_time: 'البداية', end_time: 'النهاية', hour_price: 'سعر الساعة', notes: 'الملاحظات', price: 'السعر', order_date: 'التاريخ',
};
function changesLines(changes) {
  return Object.entries(changes || {})
    .filter(([k]) => FIELD_NAMES[k])
    .map(([k, v]) => {
      const f = (x) => (['total', 'hour_price', 'price'].includes(k) ? m(x) : k === 'period' ? P[x] : (x ?? '—'));
      return `✏️ ${FIELD_NAMES[k]}: ${f(v.from)} ← ${f(v.to)}`;
    });
}

module.exports = { queue, accLabel, m, changesLines, P, LINE };
