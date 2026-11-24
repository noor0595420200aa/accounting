'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, nowISO } = require('./db');
const { HttpError, audit, getSetting } = require('./util');

const SESSION_DAYS = 30;
const COOKIE = 'sid';

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function loadUser(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?`).get(token);
  if (!row || row.expires_at < nowISO() || !row.active) return null;
  delete row.password_hash;
  row.token = token;
  return row;
}

function requireAuth(req, res, next) {
  const u = loadUser(req);
  if (!u) return next(new HttpError(401, 'يجب تسجيل الدخول'));
  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return next(new HttpError(403, 'هذه العملية للمدير فقط'));
  next();
}

const isAdmin = (u) => u && u.role === 'admin';
const isViewer = (u) => u && u.role === 'viewer';
// المدير والمشاهد (المالك) يرون كل المنشآت؛ المشاهد بدون أي تعديل
const seesAll = (u) => isAdmin(u) || isViewer(u);

// يتحقق أن المستخدم يملك صلاحية على المنشأة
function assertFacility(user, facilityId) {
  if (seesAll(user)) return;
  if (Number(user.facility_id) !== Number(facilityId)) throw new HttpError(403, 'لا تملك صلاحية على هذا القسم');
}

function assertCanCancel(user, facilityId) {
  if (isViewer(user)) throw new HttpError(403, 'حساب المشاهدة للاطلاع فقط');
  assertFacility(user, facilityId);
  if (isAdmin(user)) return;
  if (getSetting('staff_can_cancel') !== '1') throw new HttpError(403, 'الإلغاء متاح للمدير فقط');
}

// حماية بسيطة من محاولات الدخول المتكررة
const attempts = new Map();
function login(req, res) {
  const ip = req.ip || 'x';
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) throw new HttpError(429, 'محاولات كثيرة، حاول بعد دقائق');
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!u || !u.active || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    a.n += 1;
    if (a.n >= 8) { a.until = Date.now() + 5 * 60000; a.n = 0; }
    attempts.set(ip, a);
    throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(token, u.id, nowISO(), exp);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowISO());
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  audit(u, 'login', 'user', u.id, { summary: 'تسجيل دخول' });
  res.json({ ok: true });
}

function logout(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

module.exports = { requireAuth, requireAdmin, isAdmin, isViewer, seesAll, assertFacility, assertCanCancel, login, logout, loadUser };
