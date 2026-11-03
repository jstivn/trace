-- Прод-база, 03.11.2026: долги в обе стороны («Кто мне должен» / «Кому я должен»).
-- Выполнить ОДИН раз ДО деплоя:
--   npx.cmd wrangler d1 execute trace-db --remote --file=./migrations/2026-11-03.sql

ALTER TABLE finances ADD COLUMN debt_owe INTEGER DEFAULT 0;
