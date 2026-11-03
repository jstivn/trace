-- Прод-база, 05.11.2026: сколько раз группа слов пройдена без ошибок (3 раза открывают следующую группу).
-- Выполнить ОДИН раз ДО деплоя:
--   npx.cmd wrangler d1 execute trace-db --remote --file=./migrations/2026-11-05.sql

ALTER TABLE word_groups ADD COLUMN perfect INTEGER DEFAULT 0;
