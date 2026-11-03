-- Прод-база, 04.11.2026: прогресс по группам слов «Топ-1000».
-- Выполнить ОДИН раз ДО деплоя:
--   npx.cmd wrangler d1 execute trace-db --remote --file=./migrations/2026-11-04.sql

CREATE TABLE IF NOT EXISTS word_groups (
    group_no INTEGER PRIMARY KEY,
    studied INTEGER DEFAULT 0,
    best INTEGER,
    last_score INTEGER,
    attempts INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
