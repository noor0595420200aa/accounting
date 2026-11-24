'use strict';
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR, nowISO } = require('../db');
const { addAlert, audit, HttpError, fmt } = require('../util');
const { buildPeriodReport, buildStatement, resolvePeriod, reportFacilities } = require('./data');
const { renderReport, docTitle } = require('./html');
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

/** إنشاء ملف PDF واحد (كشف منشأة أو الملخص) وحفظه في السجل */
async function createReport({ kind, params, user = null, auto = false, type = null, part = '' }) {
  const { data, pdf } = await renderPdf(kind, params);
  const rtype = type || (kind === 'statement' ? 'statement' : 'period');
  const title = docTitle(data, data.sections && data.sections[0]);
  const existing = auto ? db.prepare('SELECT id FROM reports WHERE auto=1 AND type=? AND period_from=? AND period_to=? AND part=?').get(rtype, data.from, data.to, part) : null;
  let id;
  if (existing) {
    id = existing.id;
    db.prepare('UPDATE reports SET title=?, params=?, created_at=?, stale=0 WHERE id=?').run(title, JSON.stringify({ kind, params }), nowISO(), id);
  } else {
    id = db.prepare(`INSERT INTO reports (type, title, period_from, period_to, params, auto, created_by, created_at, part)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(rtype, title, data.from, data.to, JSON.stringify({ kind, params }), auto ? 1 : 0,
      user ? user.id : null, nowISO(), part).lastInsertRowid;
  }
  fs.writeFileSync(filePath(id), pdf);
  db.prepare('UPDATE reports SET file_name=? WHERE id=?').run(`report-${id}.pdf`, id);
  if (user) audit(user, 'create', 'report', id, { summary: `إنشاء تقرير: ${title}` });
  return { id, data, title };
}

/** كل منشأة كشف مستقل تماماً، والملخص الإجمالي ملف منفصل */
function splitParts(kind, params) {
  if (params.facility_id) return [{ part: `f${params.facility_id}`, params }];
  if (params.account_id) return [{ part: `a${params.account_id}`, params }];
  const { from, to } = resolvePeriod(params.preset ? params : { ...params, preset: 'all' });
  const list = reportFacilities(from, to).map((f) => ({ part: `f${f.id}`, params: { ...params, facility_id: String(f.id) } }));
  if (kind === 'period') list.push({ part: 'summary', params: { ...params, part: 'summary' } });
  return list;
}

async function createReportSet({ kind, params, user = null, auto = false, type = null, skipExisting = false }) {
  const out = [];
  for (const p of splitParts(kind, params)) {
    if (skipExisting) {
      const { from, to } = resolvePeriod(p.params.preset ? p.params : { ...p.params, preset: 'all' });
      const ex = db.prepare('SELECT id FROM reports WHERE auto=1 AND type=? AND period_from=? AND period_to=? AND part=? AND file_name IS NOT NULL')
        .get(type, from, to, p.part);
      if (ex) continue;
    }
    out.push(await createReport({ kind, params: p.params, user, auto, type, part: p.part }));
  }
  return out;
}

function caption(r, data) {
  let c = `📊 ${r.title}`;
  if (data) {
    let tin; let tout; let left; let lines = [];
    const accLines = (accounts) => accounts.filter((a) => a.tin || a.tout || a.closing)
      .map((a) => `• ${a.label || a.name}: دخل ${fmt(a.tin || 0)} | خرج ${fmt(a.tout || 0)} | ضايل ${fmt(a.closing)}`);
    if (data.type === 'statement') {
      ({ tin, tout } = data.totals); left = data.closing; lines = accLines(data.accounts);
    } else if (data.part === 'summary') {
      const S = data.summary;
      tin = S.tin; tout = S.tout; left = S.balances;
      lines = data.sections.map((x) => `• ${x.facility.name}: دخل ${fmt(x.totals.tin)} | خرج ${fmt(x.totals.tout)} | ضايل ${fmt(x.closing)}`);
    } else if (data.sections && data.sections[0]) {
      const x = data.sections[0];
      tin = x.totals.tin; tout = x.totals.tout; left = x.closing; lines = accLines(x.accounts);
    }
    if (tin !== undefined) {
      c += `\n━━━━━━━━━━━━\n🟢 دخل: ${fmt(tin)}\n🔴 خرج: ${fmt(tout)}\n💼 ضايل: ${fmt(left)}`;
      if (lines.length) c += `\n━━━━━━━━━━━━\n${lines.join('\n')}`;
    }
  }
  if (r.stale) c += '\n⚠️ نسخة معدّلة بعد تسجيل عمليات متأخرة';
  return c.slice(0, 1000);
}

/**
 * إرسال تقرير محفوظ عبر تيليجرام لكل المستلمين (المدير + المالك + المجموعة).
 * force=false: يرسل فقط لمن لم يستلمه بعد (إعادة المحاولة التلقائية). force=true: للجميع.
 */
const KIND_OF = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };

async function sendReport(id, user = null, data = null, { force = false, to = null } = {}) {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(id);
  if (!r) throw new HttpError(404, 'التقرير غير موجود');
  if (!fs.existsSync(filePath(id))) throw new HttpError(404, 'ملف التقرير غير موجود، أعد توليده');
  // to: أرقام محددة يختارها المدير؛ وإلا حسب اشتراك كل شخص بنوع التقرير
  let all = telegram.recipients(KIND_OF[r.type] || 'manual');
  if (to) {
    const everyone = telegram.recipients('manual');
    all = everyone.filter((x) => to.map(String).includes(String(x.id)));
    if (!all.length) throw new HttpError(400, 'اختر مستلماً واحداً على الأقل');
  }
  if (!all.length) {
    db.prepare("UPDATE reports SET telegram_status='none' WHERE id=?").run(id);
    return { ok: true, sent_to: [], none: true };
  }
  const already = force ? [] : JSON.parse(r.sent_to || '[]');
  const target = all.filter((x) => !already.includes(x.id));
  if (all.length && !target.length) return { ok: true, sent_to: [], already: true };
  db.prepare('UPDATE reports SET attempts=attempts+1, last_attempt_at=? WHERE id=?').run(nowISO(), id);
  let res;
  try {
    if (!data) {
      try { const p = JSON.parse(r.params); data = build(p.kind, p.params); } catch { data = null; }
    }
    res = await telegram.sendDocument(fs.readFileSync(filePath(id)), `${r.title.replace(/[\\/:*?"<>|]/g, '-')}.pdf`, caption(r, data), target);
  } catch (e) {
    res = { ok: [], failed: [{ name: 'الكل', error: String(e.message || e) }] };
  }
  const sentTo = [...new Set([...already, ...res.ok.map((x) => x.id)])];
  if (res.failed.length) {
    const err = res.failed.map((f) => `${f.name}: ${f.error}`).join(' | ');
    db.prepare("UPDATE reports SET telegram_status='failed', telegram_error=?, sent_to=? WHERE id=?").run(err, JSON.stringify(sentTo), id);
    addAlert('telegram_failed', `فشل إرسال "${r.title}" — ${err}${res.ok.length ? ` (وصل إلى: ${res.ok.map((x) => x.name).join('، ')})` : ''}`, id);
    throw new HttpError(502, `تعذر الإرسال إلى ${err}`);
  }
  db.prepare("UPDATE reports SET telegram_status='sent', telegram_error=NULL, sent_at=?, sent_to=? WHERE id=?").run(nowISO(), JSON.stringify(sentTo), id);
  if (user) audit(user, 'send', 'report', id, { summary: `إرسال "${r.title}" عبر تيليجرام إلى: ${res.ok.map((x) => x.name).join('، ')}` });
  db.prepare("UPDATE alerts SET resolved=1 WHERE type='telegram_failed' AND ref_id=?").run(id);
  return { ok: true, sent_to: res.ok.map((x) => x.name) };
}

async function regenerate(id, user) {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(id);
  if (!r) throw new HttpError(404, 'التقرير غير موجود');
  const p = JSON.parse(r.params);
  const { data, pdf } = await renderPdf(p.kind, p.params);
  fs.writeFileSync(filePath(id), pdf);
  db.prepare("UPDATE reports SET title=?, created_at=?, stale=0, file_name=? WHERE id=?").run(docTitle(data, data.sections && data.sections[0]), nowISO(), `report-${id}.pdf`, id);
  db.prepare("UPDATE alerts SET resolved=1 WHERE type='stale_report' AND ref_id=?").run(id);
  if (user) audit(user, 'update', 'report', id, { summary: `إعادة توليد تقرير: ${data.title}` });
  return { id, data };
}

module.exports = { createReport, createReportSet, sendReport, regenerate, filePath, build, REPORTS_DIR };
