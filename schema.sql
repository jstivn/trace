-- TRACE: Cloudflare D1 Database Schema
-- Architecture: Voice-First AI Copilot & Second Brain
-- Database: Cloudflare D1 Serverless SQLite

-- 1. Финансы и расходы
CREATE TABLE IF NOT EXISTS finances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1, -- чей это ряд (1 = владелец)
    amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'VND', -- VND, USD, RUB, AED
    category TEXT NOT NULL, -- car, food, tech, services, other, unsure
    title TEXT,
    raw_text TEXT,
    raw_transcript TEXT,
    needs_review INTEGER DEFAULT 0,
    confidence REAL DEFAULT 1.0,
    possible_duplicate INTEGER DEFAULT 0,
    duplicate_of INTEGER,
    outside_limit INTEGER DEFAULT 0, -- 1 = planned big purchase, not counted in the daily limit
    is_debt INTEGER DEFAULT 0, -- 1 = lent money: title is who owes, amount is what they owe; not counted in the day
    debt_paid REAL DEFAULT 0, -- how much of the debt has been returned (same currency as amount)
    debt_owe INTEGER DEFAULT 0, -- 1 = the debt is mine (I owe title), 0 = title owes me
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Задачи и напоминания
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1, -- чей это ряд (1 = владелец)
    title TEXT NOT NULL,
    due_datetime DATETIME,
    is_date_only INTEGER DEFAULT 0,
    is_completed INTEGER DEFAULT 0,
    priority TEXT DEFAULT 'medium', -- low, medium, high
    raw_transcript TEXT,
    needs_review INTEGER DEFAULT 0,
    confidence REAL DEFAULT 1.0,
    possible_duplicate INTEGER DEFAULT 0,
    duplicate_of INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reminded INTEGER DEFAULT 0
);

-- 3. Заметки и банк памяти
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1, -- чей это ряд (1 = владелец)
    category TEXT DEFAULT 'general', -- idea, credentials, fact, thought
    title TEXT,
    content TEXT NOT NULL,
    tags TEXT,
    raw_transcript TEXT,
    needs_review INTEGER DEFAULT 0,
    confidence REAL DEFAULT 1.0,
    possible_duplicate INTEGER DEFAULT 0,
    duplicate_of INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Английский словарь и карточки
CREATE TABLE IF NOT EXISTS vocabulary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1, -- чей это ряд (1 = владелец)
    word TEXT NOT NULL,
    translation TEXT NOT NULL,
    phonetic TEXT,
    example TEXT,
    lookup_count INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, word)
);

-- 4b. Топ-1000 слов: прогресс по группам (сами слова лежат в коде, src/top_words_*.js). group_no 0 = общий тест
CREATE TABLE IF NOT EXISTS word_groups (
    user_id INTEGER NOT NULL DEFAULT 1, -- чей это ряд (1 = владелец)
    group_no INTEGER NOT NULL,
    studied INTEGER DEFAULT 0,   -- 1 = карточки группы просмотрены до конца
    best INTEGER,                -- лучший результат теста, %
    last_score INTEGER,          -- последний результат теста, %
    attempts INTEGER DEFAULT 0,  -- сколько раз проходили тест
    perfect INTEGER DEFAULT 0,   -- сколько раз тест пройден без единой ошибки (3 раза открывают следующую группу)
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, group_no)
);

-- 5. Системные настройки (у каждого человека свои; общие ключи — курсы, номер апдейта Telegram — хранятся у владельца)
CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER NOT NULL DEFAULT 1,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
);

-- 5a. Пользователи (этап 1–2 подписок)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'user',      -- owner | user
    status TEXT NOT NULL DEFAULT 'new',     -- new | trial | active | expired
    language TEXT NOT NULL DEFAULT 'ru',
    currency TEXT NOT NULL DEFAULT 'RUB',
    timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
    sub_until DATETIME,
    trial_used INTEGER NOT NULL DEFAULT 0,
    daily_count INTEGER NOT NULL DEFAULT 0,
    daily_date TEXT,
    token TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sub_notice TEXT,                        -- какое напоминание о конце подписки уже отправлено ('конец|за сколько дней')
    daily_fails INTEGER NOT NULL DEFAULT 0  -- сколько неудачных записей сегодня вернули место в лимите (потолок = 2 лимита)
);
INSERT OR IGNORE INTO users (id, name, role, status, currency, timezone)
VALUES (1, 'owner', 'owner', 'active', 'VND', 'Asia/Ho_Chi_Minh');

-- Оплаты подписки (этап 4). charge_id уникален: повторный апдейт Telegram не зачислится дважды.
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'stars',
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'XTR',
    charge_id TEXT NOT NULL,
    payload TEXT,
    period_days INTEGER NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'paid',    -- paid | unverified | refunding | refunded
    applied INTEGER NOT NULL DEFAULT 0,     -- 1 = дни уже добавлены к подписке
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    refunded_at DATETIME,
    UNIQUE (provider, charge_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at);

-- 5b. Повторяющиеся платежи и задачи (раз в месяц, в указанное число)
CREATE TABLE IF NOT EXISTS recurring (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1, -- чей это ряд (1 = владелец)
    title TEXT NOT NULL,
    amount REAL,
    currency TEXT DEFAULT 'VND',
    category TEXT DEFAULT 'other',
    day_of_month INTEGER NOT NULL, -- 1-31, in a short month the last day
    add_expense INTEGER DEFAULT 1,
    add_task INTEGER DEFAULT 0,
    last_run_month TEXT, -- 'YYYY-MM' of the last time it fired
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


-- Индексы для сверхбыстрых выборок (<5ms)
CREATE INDEX IF NOT EXISTS idx_finances_created_at ON finances(created_at);
CREATE INDEX IF NOT EXISTS idx_finances_currency ON finances(currency);
CREATE INDEX IF NOT EXISTS idx_finances_review ON finances(needs_review, possible_duplicate);
CREATE INDEX IF NOT EXISTS idx_tasks_is_completed ON tasks(is_completed);
CREATE INDEX IF NOT EXISTS idx_tasks_review ON tasks(needs_review, possible_duplicate);
CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at);
CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);
CREATE INDEX IF NOT EXISTS idx_notes_review ON notes(needs_review, possible_duplicate);
CREATE INDEX IF NOT EXISTS idx_vocab_word ON vocabulary(word);
CREATE INDEX IF NOT EXISTS idx_vocab_created_at ON vocabulary(created_at);

-- 6. Request logs (debug of incoming voice-hook / STT requests, cleaned up by cron after 14 days)
CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1, -- чей это ряд (1 = владелец)
    endpoint TEXT,
    method TEXT,
    content_type TEXT,
    body_length INTEGER,
    body_preview TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Индексы по пользователю
CREATE INDEX IF NOT EXISTS idx_finances_user ON finances(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, is_completed);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_vocab_user ON vocabulary(user_id);
CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring(user_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_user ON request_logs(user_id, created_at);
