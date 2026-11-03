-- Прод-база, 01.11.2026: повторяющиеся платежи.
-- Колонка finances.outside_limit в проде уже добавлена (проверено 01.11.2026).
-- Выполнить ОДИН раз ДО деплоя:
--   npx.cmd wrangler d1 execute trace-db --remote --file=./migrations/2026-11-01.sql

CREATE TABLE IF NOT EXISTS recurring (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    amount REAL,
    currency TEXT DEFAULT 'VND',
    category TEXT DEFAULT 'other',
    day_of_month INTEGER NOT NULL,
    add_expense INTEGER DEFAULT 1,
    add_task INTEGER DEFAULT 0,
    last_run_month TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
