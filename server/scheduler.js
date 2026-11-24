'use strict';
const { db, nowISO } = require('./db');
const { getSetting, localParts, addDays, addAlert } = require('./util');
const { createReportSet, sendReport } = require('./reports/service');
const telegram = require('./telegram');
const backup = require('./backup');

let running = false;

async function autoReport(type, from, to, params) {
  try {
    // كل منشأة ملف مستقل + الملخص الإجمالي (ما أُنشئ سابقاً لا يتكرر)
    const set = await createReportSet({ kind: 'period', params, auto: true, type, skipExisting: true });
    if (telegram.config().enabled) {
      for (const x of set) await sendReport(x.id, null, x.data).catch(() => {});
    }
  } catch (e) {
    const exists = db.prepare("SELECT id FROM reports WHERE auto=1 AND type=? AND period_from=? AND period_to=? AND part='error'").get(type, from, to);
    if (exists) return;
    db.prepare(`INSERT INTO reports (type, title, period_from, period_to, params, auto, created_at, telegram_status, telegram_error, part)
      VALUES (?,?,?,?,?,1,?, 'failed', ?, 'error')`).run(type, `تقرير ${from} — ${to}`, from, to, JSON.stringify({ kind: 'period', params }), nowISO(), String(e.message || e));
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
    // الجرد الشهري عن الشهر الماضي (أول أيام الشهر)
    const day = Number(now.date.slice(8, 10));
    if (day <= 3 && (day > 1 || now.time >= (getSetting('monthly_report_time') || '00:30'))) {
      const [y, m] = now.date.slice(0, 7).split('-').map(Number);
      const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
      const last = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
      await autoReport('monthly', `${prev}-01`, last, { preset: 'month', month: prev });
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

// إرسال رسائل العمليات الفورية لمن اختار استلامها
let flushing = false;
async function flushNotifications() {
  if (flushing) return;
  flushing = true;
  try {
    const pending = db.prepare("SELECT * FROM notifications WHERE status='pending' ORDER BY id LIMIT 20").all();
    if (!pending.length) return;
    const cfg = telegram.config();
    const recips = telegram.recipients('notify');
    if (!cfg.enabled || !cfg.token || !recips.length) {
      db.prepare("UPDATE notifications SET status='skipped' WHERE status='pending'").run();
      return;
    }
    for (const n of pending) {
      const res = await telegram.sendText(n.text, recips).catch((e) => ({ ok: [], failed: [{ name: 'الكل', error: e.message }] }));
      if (!res.failed.length) {
        db.prepare("UPDATE notifications SET status='sent', sent_at=? WHERE id=?").run(nowISO(), n.id);
      } else {
        const tries = n.attempts + 1;
        const err = res.failed.map((f) => `${f.name}: ${f.error}`).join(' | ');
        // من استلم لا نكرر له: إذا وصلت لأحد نعتبرها مرسلة ونسجل الخطأ
        const status = res.ok.length ? 'sent' : tries >= 5 ? 'failed' : 'pending';
        db.prepare('UPDATE notifications SET status=?, attempts=?, error=? WHERE id=?').run(status, tries, err, n.id);
        if (status === 'failed') addAlert('telegram_failed', `تعذر إرسال رسالة عملية عبر تيليجرام: ${err}`);
        break;
      }
    }
  } catch (e) {
    console.error('notify', e);
  } finally {
    flushing = false;
  }
}

function start() {
  setTimeout(tick, 5000);
  setInterval(flushNotifications, 4000);
  return setInterval(tick, 30000);
}

module.exports = { start, tick, flushNotifications, autoReport };
