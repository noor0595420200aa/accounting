'use strict';
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');
const { getSetting, localParts } = require('./util');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function list() {
  return fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort().reverse()
    .map((f) => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime }));
}

async function backupNow(tag = 'manual') {
  const p = localParts();
  const name = `backup-${p.date}_${p.time.replace(':', '')}-${tag}.db`;
  await db.backup(path.join(BACKUP_DIR, name));
  const keep = Math.max(Number(getSetting('backup_keep')) || 30, 3);
  const all = list();
  for (const f of all.slice(keep)) fs.unlinkSync(path.join(BACKUP_DIR, f.name));
  return name;
}

function hasBackupFor(date) {
  return list().some((f) => f.name.startsWith(`backup-${date}_`) && f.name.includes('-auto'));
}

function filePath(name) {
  if (!/^backup-[\w-]+\.db$/.test(name)) return null;
  const p = path.join(BACKUP_DIR, name);
  return fs.existsSync(p) ? p : null;
}

module.exports = { backupNow, list, hasBackupFor, filePath, BACKUP_DIR };
