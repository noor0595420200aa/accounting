'use strict';
const { getSetting, decrypt } = require('./util');

const API = () => process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

function config() {
  return {
    enabled: getSetting('telegram_enabled') === '1',
    token: decrypt(getSetting('telegram_token_enc') || ''),
    chatId: getSetting('telegram_chat_id') || '',
  };
}

async function call(token, method, form) {
  const res = await fetch(`${API()}/bot${token}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !data || !data.ok) {
    throw new Error(`Telegram: ${(data && data.description) || `HTTP ${res.status}`}`);
  }
  return data.result;
}

async function sendDocument(buffer, fileName, caption) {
  const c = config();
  if (!c.token || !c.chatId) throw new Error('لم يتم إعداد بوت تيليجرام (التوكن ورقم المحادثة) من الإعدادات');
  const form = new FormData();
  form.append('chat_id', c.chatId);
  if (caption) form.append('caption', caption.slice(0, 1000));
  form.append('document', new Blob([buffer], { type: 'application/pdf' }), fileName);
  return call(c.token, 'sendDocument', form);
}

async function sendText(text) {
  const c = config();
  if (!c.token || !c.chatId) throw new Error('لم يتم إعداد بوت تيليجرام');
  const form = new FormData();
  form.append('chat_id', c.chatId);
  form.append('text', text.slice(0, 4000));
  return call(c.token, 'sendMessage', form);
}

module.exports = { sendDocument, sendText, config };
