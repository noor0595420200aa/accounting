'use strict';
const { db, nowISO } = require('./db');
const { getSetting, localParts, addDays, addAlert } = require('./util');
const { createReport, sendReport } = require('./reports/service');
const telegram = require('./telegram');
const backup = require('./backup');

let running = false;

async function autoReport(type, from, to, params) {
  const exists = db.prepare('SELECT id FROM reports WHERE auto=1 AND type=? AND period_from=? AND period_to=?').get(type, from, to);
  if (exists) return;
  try {
    const { id, data } = await createReport({ kind: 'period', params, auto: true, type });
    if (telegram.config().enabled) await sendReport(id, null, data).catch(() => {});
  } catch (e) {
    // نسجل محاولة فاشلة حتى لا نكرر بشكل لا نهائي، وننبه المدير
    db.prepare(`INSERT OR IGNORE INTO reports (type, title, period_from, period_to, params, auto, created_at, telegram_status, telegram_error)
      VALUES (?,?,?,?,?,1,?, 'failed', ?)`).run(type, `تقرير ${from} — ${to}`, from, to, JSON.stringify({ kind: 'period', params }), nowISO(), String(e.message || e));
    addAlert('report_failed', `تعذر إنشاء التقرير التلقائي (${from} — ${to}): ${e.message || e}`);
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const now = localParts();
    const yesterday = addDays(now.date, -1);
    // التقرير اليومي عن اليوم المنتهي (00:00 — 23:59) مع ملخص تراكمي للشهر والسنة
    if (now.time >= (getSetting('daily_report_time') || '00:05')) {
      await autoReport('daily', yesterday, yesterday, { preset: 'day', date: yesterday });
    }
    // التقرير الأسبوعي عن آخر 7 أيام
    if (String(now.weekday) === String(getSetting('weekly_report_day') ?? '6') && now.time >= (getSetting('weekly_report_time') || '00:15')) {
      await autoReport('weekly', addDays(yesterday, -6), yesterday, { preset: 'last7', date: yesterday });
    }
    // إعادة محاولة إرسال التقارير التلقائية الفاشلة (حتى 3 مرات، كل 15 دقيقة)
    if (telegram.config().enabled) {
      const cutoff = new Date(Date.now() - 15 * 60000).toISOString();
      const failed = db.prepare(`SELECT id FROM reports WHERE auto=1 AND telegram_status IN ('failed','none') AND file_name IS NOT NULL
        AND attempts < 3 AND (last_attempt_at IS NULL OR last_attempt_at < ?) AND created_at > ?`)
        .all(cutoff, new Date(Date.now() - 2 * 86400000).toISOString());
      for (const r of failed) await sendReport(r.id).catch(() => {});
    }
    // نسخ احتياطي يومي
    if (now.time >= (getSetting('backup_time') || '03:00') && !backup.hasBackupFor(now.date)) {
      await backup.backupNow('auto').catch((e) => addAlert('backup_failed', `فشل النسخ الاحتياطي: ${e.message}`));
    }
  } catch (e) {
    console.error('scheduler', e);
  } finally {
    running = false;
  }
}

function start() {
  setTimeout(tick, 5000);
  return setInterval(tick, 30000);
}

module.exports = { start, tick };
