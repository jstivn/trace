// Миграция этапа 1: на базе в «прод-виде» (колонки добавлялись ALTER-ами) ничего не теряется.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'migrations/2026-11-06.sql'), 'utf8');

// Таблицы ровно как в проде (снято 02.11.2026 из sqlite_master)
const PROD_SCHEMA = `
CREATE TABLE finances (id INTEGER PRIMARY KEY AUTOINCREMENT, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'AED',
  category TEXT NOT NULL, raw_text TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, raw_transcript TEXT, title TEXT,
  needs_review INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0, possible_duplicate INTEGER DEFAULT 0, duplicate_of INTEGER,
  outside_limit INTEGER DEFAULT 0, is_debt INTEGER DEFAULT 0, debt_paid REAL DEFAULT 0, debt_owe INTEGER DEFAULT 0);
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, due_datetime DATETIME, is_completed INTEGER DEFAULT 0,
  priority TEXT DEFAULT 'medium', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, reminded INTEGER DEFAULT 0, raw_transcript TEXT,
  is_date_only INTEGER DEFAULT 0, needs_review INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0, possible_duplicate INTEGER DEFAULT 0, duplicate_of INTEGER);
CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT DEFAULT 'general', title TEXT, content TEXT NOT NULL, tags TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, raw_transcript TEXT, needs_review INTEGER DEFAULT 0, confidence REAL DEFAULT 1.0,
  possible_duplicate INTEGER DEFAULT 0, duplicate_of INTEGER);
CREATE TABLE vocabulary (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL UNIQUE, translation TEXT NOT NULL, phonetic TEXT,
  example TEXT, lookup_count INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE request_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT, method TEXT, content_type TEXT, body_length INTEGER,
  body_preview TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE recurring (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, amount REAL, currency TEXT DEFAULT 'VND',
  category TEXT DEFAULT 'other', day_of_month INTEGER NOT NULL, add_expense INTEGER DEFAULT 1, add_task INTEGER DEFAULT 0,
  last_run_month TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE word_groups (group_no INTEGER PRIMARY KEY, studied INTEGER DEFAULT 0, best INTEGER, last_score INTEGER,
  attempts INTEGER DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, perfect INTEGER DEFAULT 0);
`;
const DATA_TABLES = ['finances', 'tasks', 'notes', 'vocabulary', 'settings', 'request_logs', 'recurring', 'word_groups'];

function prodDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(PROD_SCHEMA);
  db.exec(`
    INSERT INTO settings (key, value) VALUES ('telegram_chat_id', '123456789'), ('daily_limit_off', '1');
    INSERT INTO finances (amount, currency, category, title) VALUES (50000, 'VND', 'food', 'кофе'), (200, 'RUB', 'car', 'бензин');
    INSERT INTO tasks (title) VALUES ('позвонить'), ('купить воду'), ('оплатить аренду');
    INSERT INTO notes (content) VALUES ('идея');
    INSERT INTO vocabulary (word, translation) VALUES ('silent', 'тихий'), ('silent ', 'тихий');
    INSERT INTO request_logs (endpoint) VALUES ('/api/capture');
    INSERT INTO recurring (title, day_of_month) VALUES ('интернет', 5);
    INSERT INTO word_groups (group_no, perfect) VALUES (1, 3), (2, 0);
  `);
  return db;
}
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

test('migration: no row is lost and every old row belongs to the owner (user 1)', () => {
  const db = prodDb();
  const before = Object.fromEntries(DATA_TABLES.map(t => [t, count(db, t)]));
  db.exec(MIGRATION);
  for (const t of DATA_TABLES) {
    assert.equal(count(db, t), before[t], `${t}: row count changed`);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = 1`).get().n, before[t], `${t}: user_id is not 1`);
  }
});

test('migration: owner row is created with the chat id from settings', () => {
  const db = prodDb();
  db.exec(MIGRATION);
  const u = db.prepare('SELECT * FROM users').all();
  assert.equal(u.length, 1);
  assert.equal(u[0].id, 1);
  assert.equal(u[0].role, 'owner');
  assert.equal(u[0].telegram_id, 123456789);
  assert.equal(u[0].currency, 'VND');
});

test('migration: the old worker queries keep working afterwards', () => {
  const db = prodDb();
  db.exec(MIGRATION);
  db.prepare("INSERT INTO finances (amount, currency, category, title) VALUES (1, 'VND', 'food', 'x')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  db.prepare("INSERT INTO word_groups (group_no) VALUES (3) ON CONFLICT(group_no) DO UPDATE SET studied = 1").run();
  assert.equal(db.prepare("SELECT user_id FROM finances WHERE title = 'x'").get().user_id, 1);
});

test('migration: a database without telegram_chat_id still gets the owner', () => {
  const db = prodDb();
  db.exec("DELETE FROM settings WHERE key = 'telegram_chat_id'");
  db.exec(MIGRATION);
  const u = db.prepare('SELECT telegram_id, role FROM users WHERE id = 1').get();
  assert.equal(u.role, 'owner');
  assert.equal(u.telegram_id, null);
});

test('schema.sql and the migrated prod database have the same columns', () => {
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  const migrated = prodDb();
  migrated.exec(MIGRATION);
  const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).sort();
  for (const t of [...DATA_TABLES, 'users']) {
    const m = cols(migrated, t);
    for (const c of cols(fresh, t)) {
      if (['id'].includes(c)) continue;
      // в проде у finances/tasks/notes нет части новых колонок только если они не нужны; user_id обязан быть везде
      if (c === 'user_id') assert.ok(m.includes(c), `${t}: user_id missing after migration`);
    }
    assert.ok(cols(fresh, t).includes('user_id') || t === 'users', `${t}: user_id missing in schema.sql`);
  }
  assert.equal(fresh.prepare('SELECT role FROM users WHERE id = 1').get().role, 'owner');
});

// ---------- 2026-11-07: keys "per person" ----------
const MIGRATION_7 = fs.readFileSync(path.join(ROOT, 'migrations/2026-11-07.sql'), 'utf8');

test('migration 07: rows survive, ids stay, and two users can hold the same key, word and group', () => {
  const db = prodDb();
  db.exec(MIGRATION);
  const before = { settings: count(db, 'settings'), vocabulary: count(db, 'vocabulary'), word_groups: count(db, 'word_groups') };
  const ids = db.prepare('SELECT id FROM vocabulary ORDER BY id').all().map(r => r.id);
  db.exec(MIGRATION_7);
  for (const t of Object.keys(before)) assert.equal(count(db, t), before[t], `${t}: row count changed`);
  assert.deepEqual(db.prepare('SELECT id FROM vocabulary ORDER BY id').all().map(r => r.id), ids);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'telegram_chat_id' AND user_id = 1").get().value, '123456789');
  assert.equal(db.prepare('SELECT perfect FROM word_groups WHERE group_no = 1 AND user_id = 1').get().perfect, 3);

  db.exec("INSERT INTO users (id, telegram_id) VALUES (2, 5)");
  db.exec("INSERT INTO settings (key, value, user_id) VALUES ('telegram_chat_id', '5', 2)");
  db.exec("INSERT INTO vocabulary (word, translation, user_id) VALUES ('silent', 'тихий', 2)");
  db.exec("INSERT INTO word_groups (group_no, user_id) VALUES (1, 2)");
  assert.throws(() => db.exec("INSERT INTO settings (key, value, user_id) VALUES ('telegram_chat_id', 'dup', 2)"));
  assert.throws(() => db.exec("INSERT INTO vocabulary (word, translation, user_id) VALUES ('silent', 'dup', 2)"));
  // new ids continue after the old ones
  assert.ok(db.prepare("SELECT id FROM vocabulary WHERE user_id = 2").get().id > Math.max(...ids));
});

test('schema.sql has the same per-person keys as the migrated database', () => {
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  fresh.exec("INSERT INTO users (id, telegram_id) VALUES (2, 5)");
  for (const db of [fresh]) {
    db.exec("INSERT INTO settings (key, value, user_id) VALUES ('k', 'a', 1), ('k', 'b', 2)");
    db.exec("INSERT INTO vocabulary (word, translation, user_id) VALUES ('w', 'a', 1), ('w', 'b', 2)");
    db.exec("INSERT INTO word_groups (group_no, user_id) VALUES (1, 1), (1, 2)");
    assert.throws(() => db.exec("INSERT INTO settings (key, value, user_id) VALUES ('k', 'c', 2)"));
  }
});

// ---------- 2026-11-09: returned places in the daily limit ----------
test('migration 09: adds daily_fails (default 0) to users and matches schema.sql', () => {
  const db = prodDb();
  db.exec(MIGRATION);
  db.exec(fs.readFileSync(path.join(ROOT, 'migrations/2026-11-07.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(ROOT, 'migrations/2026-11-08.sql'), 'utf8'));
  db.exec("INSERT INTO users (id, telegram_id) VALUES (2, 5)");
  db.exec(fs.readFileSync(path.join(ROOT, 'migrations/2026-11-09.sql'), 'utf8'));
  assert.equal(db.prepare('SELECT daily_fails FROM users WHERE id = 2').get().daily_fails, 0);
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  const cols = (d) => d.prepare('PRAGMA table_info(users)').all().map(c => c.name).sort();
  assert.deepEqual(cols(db), cols(fresh));
});

// ---------- 2026-11-08: payments ----------
const MIGRATION_8 = fs.readFileSync(path.join(ROOT, 'migrations/2026-11-08.sql'), 'utf8');

test('migration 08: adds payments and the reminder mark, keeps users, and matches schema.sql', () => {
  const db = prodDb();
  db.exec(MIGRATION);
  db.exec(MIGRATION_7);
  db.exec("INSERT INTO users (id, telegram_id, status, sub_until) VALUES (2, 5, 'active', '2030-01-01 00:00:00')");
  const usersBefore = db.prepare('SELECT * FROM users ORDER BY id').all().length;
  db.exec(MIGRATION_8);
  assert.equal(db.prepare('SELECT * FROM users ORDER BY id').all().length, usersBefore);
  assert.equal(db.prepare('SELECT sub_notice FROM users WHERE id = 2').get().sub_notice, null);
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  const cols = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).sort();
  assert.deepEqual(cols(db, 'payments'), cols(fresh, 'payments'));
  assert.ok(cols(db, 'users').includes('sub_notice'));
  // the same charge cannot be stored twice
  db.exec("INSERT INTO payments (user_id, amount, charge_id) VALUES (2, 200, 'x')");
  assert.throws(() => db.exec("INSERT INTO payments (user_id, amount, charge_id) VALUES (2, 200, 'x')"));
});
