-- Прод-база, 02.11.2026: долги = трата с галочкой «Это долг».
-- Старая отдельная таблица debts (была пустой, проверено) больше не нужна.
-- Выполнить ОДИН раз ДО деплоя:
--   npx.cmd wrangler d1 execute trace-db --remote --file=./migrations/2026-11-02.sql

ALTER TABLE finances ADD COLUMN is_debt INTEGER DEFAULT 0;
ALTER TABLE finances ADD COLUMN debt_paid REAL DEFAULT 0;
DROP TABLE IF EXISTS debts;
