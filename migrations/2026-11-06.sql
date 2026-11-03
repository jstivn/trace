-- Прод-база, этап 1 «подписки»: появляются пользователи. Владельцу ничего не меняется.
-- Миграция ТОЛЬКО ДОБАВЛЯЕТ: таблицу users и колонку user_id (по умолчанию 1 = владелец) во все таблицы.
-- Старый воркер продолжает работать как раньше. Смена ключей (settings, vocabulary, word_groups «на человека»)
-- будет отдельной миграцией на этапе 2 вместе с кодом.
-- Сделать копию базы ДО (backup-before-users.sql) и выполнить ОДИН раз (повтор даст ошибку «duplicate column» — это нормально, значит уже применено):
--   npx.cmd wrangler d1 execute trace-db --remote --file=./migrations/2026-11-06.sql

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'user',      -- owner | user
    status TEXT NOT NULL DEFAULT 'new',     -- new | trial | active | expired
    language TEXT NOT NULL DEFAULT 'ru',
    currency TEXT NOT NULL DEFAULT 'RUB',
    timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
    sub_until DATETIME,                     -- конец подписки (UTC)
    trial_used INTEGER NOT NULL DEFAULT 0,
    daily_count INTEGER NOT NULL DEFAULT 0, -- записей за день daily_date
    daily_date TEXT,                        -- 'YYYY-MM-DD' в поясе пользователя
    token TEXT UNIQUE,                      -- личный токен для Shortcut
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Пользователь №1 — владелец. Чат берём из настроек (если там есть).
INSERT OR IGNORE INTO users (id, telegram_id, name, role, status, currency, timezone)
VALUES (1, (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'telegram_chat_id'),
        'owner', 'owner', 'active', 'VND', 'Asia/Ho_Chi_Minh');

ALTER TABLE finances      ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks         ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notes         ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE vocabulary    ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE word_groups   ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recurring     ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE request_logs  ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings      ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_finances_user ON finances(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, is_completed);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_vocab_user ON vocabulary(user_id);
CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring(user_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_user ON request_logs(user_id, created_at);
