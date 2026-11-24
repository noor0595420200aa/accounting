'use strict';
const { db } = require('./db');
const { getSetting, decrypt } = require('./util');

const API = () => process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

/**
 * المستلمون: كل مستخدم فعّال (مدير أو مشاهد/مالك) أُدخل له رقم تيليجرام،
 * بالإضافة لمجموعة اختيارية من الإعدادات. التقارير تصل للجميع معاً.
 */
function recipients() {
  const list = db.prepare(`SELECT display_name, role, telegram_chat_id FROM users
    WHERE active=1 AND role IN ('admin','viewer') AND telegram_chat_id IS NOT NULL AND TRIM(telegram_chat_id)<>'' ORDER BY id`).all()
    .map((u) => ({ id: u.telegram_chat_id.trim(), name: u.display_name }));
  const group = (getSetting('telegram_chat_id') || '').trim();
  if (group) list.push({ id: group, name: 'المجموعة' });
  const seen = new Set();
  return list.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

function config() {
  return {
    enabled: getSetting('telegram_enabled') === '1',
    token: decrypt(getSetting('telegram_token_enc') || ''),
    recipients: recipients(),
  };
}

async function call(token, method, form) {
  const res = await fetch(`${API()}/bot${token}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !data || !data.ok) throw new Error((data && data.description) || `HTTP ${res.status}`);
  return data.result;
}

// يرسل لكل مستلم لحاله؛ فشل واحد لا يمنع الباقين
async function toAll(target, build, method) {
  const c = config();
  if (!c.token) throw new Error('لم يتم إدخال توكن بوت تيليجرام في الإعدادات');
  const list = target || c.recipients;
  if (!list.length) throw new Error('لا يوجد مستلمون: أدخل رقم تيليجرام للمدير والمالك من صفحة المستخدمين');
  const ok = [];
  const failed = [];
  for (const r of list) {
    try {
      await call(c.token, method, build(r));
      ok.push(r);
    } catch (e) {
      failed.push({ ...r, error: String(e.message || e) });
    }
  }
  return { ok, failed };
}

function sendDocument(buffer, fileName, caption, target = null) {
  return toAll(target, (r) => {
    const form = new FormData();
    form.append('chat_id', r.id);
    if (caption) form.append('caption', caption.slice(0, 1000));
    form.append('document', new Blob([buffer], { type: 'application/pdf' }), fileName);
    return form;
  }, 'sendDocument');
}

function sendText(text, target = null) {
  return toAll(target, (r) => {
    const form = new FormData();
    form.append('chat_id', r.id);
    form.append('text', text.slice(0, 4000));
    return form;
  }, 'sendMessage');
}

// المحادثات التي راسلت البوت مؤخراً — لمعرفة رقم كل شخص بسهولة
async function recentChats() {
  const c = config();
  if (!c.token) throw new Error('أدخل توكن البوت أولاً');
  const updates = await call(c.token, 'getUpdates', new FormData());
  const m = new Map();
  for (const u of updates || []) {
    const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member;
    const chat = msg && msg.chat;
    if (!chat) continue;
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '';
    m.set(String(chat.id), { id: String(chat.id), name, username: chat.username || '', type: chat.type });
  }
  return [...m.values()];
}

module.exports = { sendDocument, sendText, config, recipients, recentChats };
