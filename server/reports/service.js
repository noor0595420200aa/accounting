'use strict';
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR, nowISO } = require('../db');
const { addAlert, audit, HttpError, fmt } = require('../util');
const { buildPeriodReport, buildStatement } = require('./data');
const { renderReport } = require('./html');
const { htmlToPdf } = require('./pdf');
const telegram = require('../telegram');

const REPORTS_DIR = path.join(DATA_DIR, 'reports');
fs.mkdirSync(REPORTS_DIR, { recursive: true });

function build(kind, params) {
  return kind === 'statement' ? buildStatement(params) : buildPeriodReport(params);
}

const filePath = (id) => path.join(REPORTS_DIR, `report-${id}.pdf`);

async function renderPdf(kind, params) {
  const data = build(kind, params);
  const pdf = await htmlToPdf(renderReport(data));
  return { data, pdf };
}

/** إنشاء تقرير PDF وحفظه في السجل */
async function createReport({ kind, params, user = null, auto = false, type = null }) {
  const { data, pdf } = await renderPdf(kind, params);
  const rtype = type || (kind === 'statement' ? 'statement' : 'period');
  const existing = auto ? db.prepare('SELECT id FROM reports WHERE auto=1 AND type=? AND period_from=? AND period_to=?').get(rtype, data.from, data.to) : null;
  let id;
  if (existing) {
    id = existing.id;
    db.prepare('UPDATE reports SET title=?, params=?, created_at=?, stale=0 WHERE id=?').run(data.title, JSON.stringify({ kind, params }), nowISO(), id);
  } else {
    id = db.prepare(`INSERT INTO reports (type, title, period_from, period_to, params, auto, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(rtype, data.title, data.from, data.to, JSON.stringify({ kind, params }), auto ? 1 : 0,
      user ? user.id : null, nowISO()).lastInsertRowid;
  }
  const name = `report-${id}.pdf`;
  fs.writeFileSync(filePath(id), pdf);
  db.prepare('UPDATE reports SET file_name=? WHERE id=?').run(name, id);
  if (user) audit(user, 'create', 'report', id, { summary: `إنشاء تقرير: ${data.title}` });
  return { id, data };
}

function caption(r, data) {
  let c = `📊 ${r.title}`;
  if (data && data.summary) {
    const S = data.summary;
    c += `\nالداخل: ${fmt(S.tin)} | الخارج: ${fmt(S.tout)} | الصافي: ${fmt(S.net)}`;
    c += `\nإجمالي الأرصدة: ${fmt(S.balances)} | ديون الزبائن: ${fmt(S.receivables)}`;
  } else if (data && data.totals) {
    c += `\nالافتتاحي: ${fmt(data.opening)} | الداخل: ${fmt(data.totals.tin)} | الخارج: ${fmt(data.totals.tout)} | المتبقي: ${fmt(data.closing)}`;
  }
  if (r.stale) c += '\n⚠️ نسخة معدّلة بعد تسجيل عمليات متأخرة';
  return c;
}

/** إرسال تقرير محفوظ عبر تيليجرام، مع تسجيل الخطأ وتنبيه المدير عند الفشل */
async function sendReport(id, user = null, data = null) {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(id);
  if (!r) throw new HttpError(404, 'التقرير غير موجود');
  if (!fs.existsSync(filePath(id))) throw new HttpError(404, 'ملف التقرير غير موجود، أعد توليده');
  db.prepare('UPDATE reports SET attempts=attempts+1, last_attempt_at=? WHERE id=?').run(nowISO(), id);
  try {
    if (!data) {
      try { const p = JSON.parse(r.params); data = build(p.kind, p.params); } catch { data = null; }
    }
    await telegram.sendDocument(fs.readFileSync(filePath(id)), `${r.title.replace(/[\\/:*?"<>|]/g, '-')}.pdf`, caption(r, data));
    db.prepare("UPDATE reports SET telegram_status='sent', telegram_error=NULL, sent_at=? WHERE id=?").run(nowISO(), id);
    if (user) audit(user, 'send', 'report', id, { summary: `إرسال تقرير عبر تيليجرام: ${r.title}` });
    db.prepare("UPDATE alerts SET resolved=1 WHERE type='telegram_failed' AND ref_id=?").run(id);
    return { ok: true };
  } catch (e) {
    db.prepare("UPDATE reports SET telegram_status='failed', telegram_error=? WHERE id=?").run(String(e.message || e), id);
    addAlert('telegram_failed', `فشل إرسال التقرير "${r.title}" عبر تيليجرام: ${e.message || e}`, id);
    throw new HttpError(502, `تعذر الإرسال: ${e.message || e}`);
  }
}

async function regenerate(id, user) {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(id);
  if (!r) throw new HttpError(404, 'التقرير غير موجود');
  const p = JSON.parse(r.params);
  const { data, pdf } = await renderPdf(p.kind, p.params);
  fs.writeFileSync(filePath(id), pdf);
  db.prepare("UPDATE reports SET title=?, created_at=?, stale=0, file_name=? WHERE id=?").run(data.title, nowISO(), `report-${id}.pdf`, id);
  db.prepare("UPDATE alerts SET resolved=1 WHERE type='stale_report' AND ref_id=?").run(id);
  if (user) audit(user, 'update', 'report', id, { summary: `إعادة توليد تقرير: ${data.title}` });
  return { id, data };
}

module.exports = { createReport, sendReport, regenerate, filePath, build, REPORTS_DIR };
