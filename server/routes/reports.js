'use strict';
const express = require('express');
const fs = require('fs');
const { db } = require('../db');
const { HttpError } = require('../util');
const { isAdmin } = require('../auth');
const { build, createReport, sendReport, regenerate, filePath } = require('../reports/service');
const { renderReport } = require('../reports/html');
const { reportToExcel } = require('../reports/excel');

const r = express.Router();

// الموظف يرى تقارير قسمه فقط، وكشف الحساب الشامل للمدير
function params(req, src) {
  const q = { ...src };
  const kind = q.kind === 'statement' ? 'statement' : 'period';
  delete q.kind;
  for (const k of Object.keys(q)) if (q[k] === '' || q[k] == null) delete q[k];
  if (!isAdmin(req.user)) {
    if (kind === 'statement' && (q.account_id || q.user_id)) throw new HttpError(403, 'للمدير فقط');
    q.facility_id = String(req.user.facility_id);
  }
  return { kind, params: q };
}

r.get('/view', (req, res) => {
  const { kind, params: p } = params(req, req.query);
  res.type('html').send(renderReport(build(kind, p)));
});

r.get('/excel', async (req, res) => {
  const { kind, params: p } = params(req, req.query);
  const data = build(kind, p);
  const buf = await reportToExcel(data);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="report-${data.from}-${data.to}.xlsx"; filename*=UTF-8''${encodeURIComponent(data.title)}.xlsx`);
  res.send(buf);
});

r.post('/generate', async (req, res) => {
  const { kind, params: p } = params(req, req.body || {});
  const { id } = await createReport({ kind, params: p, user: req.user });
  let sent = null;
  if (req.body.send) {
    if (!isAdmin(req.user)) throw new HttpError(403, 'الإرسال للمدير فقط');
    sent = await sendReport(id, req.user).catch((e) => ({ ok: false, error: e.message }));
  }
  res.json({ id, sent });
});

r.get('/', (req, res) => {
  const rows = isAdmin(req.user)
    ? db.prepare(`SELECT r.*, u.display_name AS user_name FROM reports r LEFT JOIN users u ON u.id=r.created_by ORDER BY r.id DESC LIMIT 200`).all()
    : db.prepare(`SELECT r.*, u.display_name AS user_name FROM reports r LEFT JOIN users u ON u.id=r.created_by WHERE r.created_by=? ORDER BY r.id DESC LIMIT 100`).all(req.user.id);
  res.json(rows);
});

function own(req, id) {
  const rep = db.prepare('SELECT * FROM reports WHERE id=?').get(id);
  if (!rep) throw new HttpError(404, 'التقرير غير موجود');
  if (!isAdmin(req.user) && rep.created_by !== req.user.id) throw new HttpError(403, 'لا تملك صلاحية');
  return rep;
}

r.get('/:id/pdf', (req, res) => {
  const rep = own(req, Number(req.params.id));
  const p = filePath(rep.id);
  if (!fs.existsSync(p)) throw new HttpError(404, 'ملف التقرير غير موجود، أعد توليده');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename="report-${rep.id}.pdf"; filename*=UTF-8''${encodeURIComponent(rep.title)}.pdf`);
  fs.createReadStream(p).pipe(res);
});

r.post('/:id/send', async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'للمدير فقط');
  res.json(await sendReport(Number(req.params.id), req.user));
});

r.post('/:id/regenerate', async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'للمدير فقط');
  const { id } = await regenerate(Number(req.params.id), req.user);
  let sent = null;
  if (req.body && req.body.send) sent = await sendReport(id, req.user).catch((e) => ({ ok: false, error: e.message }));
  res.json({ id, sent });
});

module.exports = { router: r };
