'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- المنشآت. كل منشأة لها رمز ترقيم مستقل (A100, U100, D100 ...)
CREATE TABLE IF NOT EXISTS facilities (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                 -- hall | laundry | field | general | other
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  next_no INTEGER NOT NULL DEFAULT 100,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  facility_id INTEGER REFERENCES facilities(id),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- الحسابات وأماكن حفظ واستلام الأموال
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,                  -- safe | bank | employee | reserve | other
  phone TEXT,
  notes TEXT,
  opening_balance INTEGER NOT NULL DEFAULT 0,
  opening_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (facility_id, kind, name)
);

-- حجوزات الصالة
CREATE TABLE IF NOT EXISTS hall_bookings (
  id INTEGER PRIMARY KEY,
  no TEXT NOT NULL UNIQUE,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  customer_name TEXT NOT NULL,
  phone TEXT,
  reg_date TEXT NOT NULL,
  event_date TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('evening','morning')),
  total INTEGER NOT NULL CHECK (total > 0),
  notes TEXT,
  extra TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed','paid','cancelled')),
  cancel_reason TEXT,
  cancel_action TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS hall_no_conflict
  ON hall_bookings(facility_id, event_date, period) WHERE status <> 'cancelled';

-- حجوزات الملعب
CREATE TABLE IF NOT EXISTS field_bookings (
  id INTEGER PRIMARY KEY,
  no TEXT NOT NULL UNIQUE,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  customer_name TEXT NOT NULL,
  phone TEXT,
  reg_date TEXT NOT NULL,
  play_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  start_at TEXT NOT NULL,            -- YYYY-MM-DDTHH:MM (محلي)
  end_at TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  hour_price INTEGER NOT NULL CHECK (hour_price >= 0),
  total INTEGER NOT NULL CHECK (total > 0),
  notes TEXT,
  extra TEXT,
  status TEXT NOT NULL CHECK (status IN ('confirmed','paid','cancelled')),
  cancel_reason TEXT,
  cancel_action TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS field_time ON field_bookings(start_at, end_at);

-- المغسلة
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  name TEXT NOT NULL,
  default_price INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  name TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',       -- وصف مميز عند تشابه الأسماء
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (facility_id, name, tag)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  no TEXT NOT NULL UNIQUE,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  service_name TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  order_date TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price > 0),
  notes TEXT,
  extra TEXT,
  status TEXT NOT NULL CHECK (status IN ('paid','unpaid','partial','cancelled')),
  cancel_reason TEXT,
  cancel_action TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- التمويل / الديون الخارجية لصالح منشأة
CREATE TABLE IF NOT EXISTS fundings (
  id INTEGER PRIMARY KEY,
  no TEXT NOT NULL UNIQUE,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  source_account_id INTEGER REFERENCES accounts(id),
  party TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  op_date TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- دفتر الحركات المالية: مصدر الحقيقة الوحيد لكل الأرصدة
CREATE TABLE IF NOT EXISTS txns (
  id INTEGER PRIMARY KEY,
  no TEXT NOT NULL UNIQUE,
  facility_id INTEGER NOT NULL REFERENCES facilities(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  kind TEXT NOT NULL,      -- payment | income | expense | refund | funding | funding_out | funding_repay | funding_repay_in
  category TEXT,
  pay_type TEXT,           -- deposit | completion | extra | full | advance | on_pickup | debt
  ref_type TEXT,           -- hall | field | order | funding
  ref_id INTEGER,
  ref_no TEXT,
  party TEXT,
  notes TEXT,
  extra TEXT,
  op_date TEXT NOT NULL,
  created_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancel_reason TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS txns_date ON txns(op_date);
CREATE INDEX IF NOT EXISTS txns_acc ON txns(account_id);
CREATE INDEX IF NOT EXISTS txns_ref ON txns(ref_type, ref_id);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  facility_id INTEGER REFERENCES facilities(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  ref_no TEXT,
  summary TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_time ON audit(created_at);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,          -- daily | weekly | period | statement
  title TEXT NOT NULL,
  period_from TEXT,
  period_to TEXT,
  params TEXT,
  file_name TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  telegram_status TEXT NOT NULL DEFAULT 'none',   -- none | sent | failed
  telegram_error TEXT,
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  part TEXT NOT NULL DEFAULT ''          -- f<id> لكشف منشأة، summary للملخص الإجمالي
);

-- منع تكرار تسجيل نفس العملية (ضغط الزر مرتين)
CREATE TABLE IF NOT EXISTS idem_keys (
  key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  ref_id INTEGER,
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
`;

db.exec(SCHEMA);

function nowISO() {
  return new Date().toISOString();
}

function seed() {
  const has = db.prepare('SELECT COUNT(*) c FROM facilities').get().c;
  if (has) return;
  const now = nowISO();
  const today = now.slice(0, 10);
  const tx = db.transaction(() => {
    const insF = db.prepare('INSERT INTO facilities (id, kind, name, prefix, sort) VALUES (?,?,?,?,?)');
    insF.run(1, 'hall', 'صالة الأفراح', 'A', 1);
    insF.run(2, 'laundry', 'المغسلة والخدمات', 'U', 2);
    insF.run(3, 'field', 'ملعب كرة القدم', 'D', 3);
    insF.run(4, 'general', 'الحسابات العامة', 'R', 9);

    const insA = db.prepare(`INSERT INTO accounts (facility_id, name, type, opening_balance, opening_date, created_at)
      VALUES (?,?,?,0,?,?)`);
    // لكل منشأة: كاش + بال باي + جوال باي
    for (const f of [1, 2, 3]) {
      insA.run(f, 'كاش', 'safe', today, now);
      insA.run(f, 'بال باي', 'palpay', today, now);
      insA.run(f, 'جوال باي', 'jawwalpay', today, now);
    }
    insA.run(4, 'الحساب الاحتياطي', 'reserve', today, now);

    const insC = db.prepare('INSERT INTO categories (facility_id, kind, name) VALUES (?,?,?)');
    for (const n of ['رواتب', 'صيانة', 'كهرباء', 'مشتريات', 'أخرى']) insC.run(1, 'expense', n);
    for (const n of ['مشتريات', 'مواد تنظيف', 'رواتب', 'صيانة', 'أخرى']) insC.run(2, 'expense', n);
    for (const n of ['رواتب', 'صيانة', 'سولار', 'أخرى']) insC.run(3, 'expense', n);
    for (const n of ['مصروفات عامة', 'أخرى']) insC.run(4, 'expense', n);
    for (const f of [1, 2, 3, 4]) for (const n of ['إيراد إضافي', 'أخرى']) insC.run(f, 'income', n);

    const insS = db.prepare('INSERT INTO services (facility_id, name, default_price) VALUES (2,?,0)');
    for (const n of ['غسيل سيارة', 'وجبة', 'خدمات أخرى']) insS.run(n);

    const pwd = process.env.ADMIN_PASSWORD || 'admin123';
    db.prepare(`INSERT INTO users (username, display_name, password_hash, role, must_change_password, created_at)
      VALUES ('admin', 'المدير', ?, 'admin', 1, ?)`).run(bcrypt.hashSync(pwd, 10), now);

    const insSet = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    const defaults = {
      timezone: process.env.TZ_APP || 'Asia/Hebron',
      currency: '₪',
      daily_report_time: '00:05',
      weekly_report_day: '6',      // 0 = الأحد ... 6 = السبت
      weekly_report_time: '00:15',
      backup_time: '03:00',
      backup_keep: '30',
      staff_can_cancel: '0',
      field_open: '08:00',
      field_close: '02:00',
      field_hour_price: '0',
      telegram_enabled: '0',
      telegram_chat_id: '',
      telegram_token_enc: '',
    };
    for (const [k, v] of Object.entries(defaults)) insSet.run(k, v);
  });
  tx();
}
seed();

// ترقيات لقواعد البيانات الموجودة
function migrate() {
  const cols = db.prepare('PRAGMA table_info(reports)').all().map((c) => c.name);
  if (!cols.includes('part')) db.exec("ALTER TABLE reports ADD COLUMN part TEXT NOT NULL DEFAULT ''");
  db.exec('DROP INDEX IF EXISTS reports_auto');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reports_auto_part ON reports(type, period_from, period_to, part) WHERE auto = 1');
  // إضافة بال باي وجوال باي للمنشآت التي لا تملكها
  const now = nowISO();
  for (const f of db.prepare("SELECT id FROM facilities WHERE kind IN ('hall','laundry','field')").all()) {
    for (const [type, name] of [['palpay', 'بال باي'], ['jawwalpay', 'جوال باي']]) {
      if (!db.prepare('SELECT id FROM accounts WHERE facility_id=? AND type=?').get(f.id, type)) {
        db.prepare(`INSERT INTO accounts (facility_id, name, type, opening_balance, opening_date, created_at) VALUES (?,?,?,0,?,?)`)
          .run(f.id, name, type, now.slice(0, 10), now);
      }
    }
  }
  db.prepare("UPDATE accounts SET name='كاش' WHERE type='safe' AND name IN ('خزنة الصالة','خزنة المغسلة','خزنة الملعب')").run();
}
migrate();

module.exports = { db, DATA_DIR, DB_PATH, nowISO };
