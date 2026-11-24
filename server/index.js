'use strict';
const path = require('path');
const express = require('express');
const { db, nowISO } = require('./db');
const { HttpError } = require('./util');
const auth = require('./auth');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// منع تكرار تسجيل نفس العملية: الواجهة ترسل مفتاحاً فريداً مع كل نموذج
function idempotency(req, res, next) {
  const key = req.get('Idempotency-Key');
  if (req.method !== 'POST' || !key || !req.user) return next();
  const k = `${req.user.id}:${key}`.slice(0, 200);
  const prev = db.prepare('SELECT response FROM idem_keys WHERE key=?').get(k);
  if (prev) return res.json({ ...JSON.parse(prev.response), duplicate: true });
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400) {
      db.prepare('INSERT OR IGNORE INTO idem_keys (key, user_id, response, created_at) VALUES (?,?,?,?)')
        .run(k, req.user.id, JSON.stringify(body ?? {}), nowISO());
    }
    return json(body);
  };
  next();
}

const api = express.Router();
api.post('/login', auth.login);
api.post('/logout', auth.logout);
api.get('/health', (req, res) => res.json({ ok: true }));
api.use(auth.requireAuth);
api.use((req, res, next) => {
  // الموظف الذي يجب أن يغير كلمة المرور لا يستطيع غير ذلك
  if (req.user.must_change_password && !['/me', '/me/password', '/meta'].includes(req.path)) {
    return next(new HttpError(403, 'يجب تغيير كلمة المرور أولاً'));
  }
  next();
});
api.use(idempotency);
api.use('/', require('./routes/core').router);
api.use('/hall', require('./routes/hall').router);
api.use('/field', require('./routes/field').router);
api.use('/laundry', require('./routes/laundry').router);
api.use('/', require('./routes/finance').router);
api.use('/reports', require('./routes/reports').router);
api.use('/admin', auth.requireAdmin, require('./routes/admin').router);
api.use((req, res, next) => next(new HttpError(404, 'غير موجود')));

app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
app.use('/fonts', express.static(path.join(path.dirname(require.resolve('@fontsource/cairo/package.json')), 'files'), { maxAge: '30d' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let msg = err.message || 'خطأ غير متوقع';
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' && /hall_bookings/.test(msg)) { status = 400; msg = 'هذه الفترة محجوزة مسبقاً'; }
  else if (String(err.code || '').startsWith('SQLITE_CONSTRAINT')) { status = 400; msg = 'بيانات غير صالحة أو مكررة'; }
  else if (err.type === 'entity.parse.failed') { status = 400; msg = 'بيانات غير صالحة'; }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.status ? 'خطأ في الخادم' : msg });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  if (process.env.DISABLE_SCHEDULER !== '1') require('./scheduler').start();
  const shutdown = async () => {
    await require('./reports/pdf').closeBrowser();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
