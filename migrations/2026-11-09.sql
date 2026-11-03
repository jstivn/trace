-- Прод-база, этап 5б «подписки»: неудачная запись возвращает место в дневном лимите (счётчик возвратов, чтобы это нельзя было
-- использовать для обхода лимита). Только добавляет колонку; старый воркер работает как раньше.
-- Выполнять ПОСЛЕ 2026-11-08.sql, ОДИН раз (повтор даст «duplicate column» — значит уже применено):
--   npx.cmd wrangler d1 execute trace-db --remote --file=./migrations/2026-11-09.sql

ALTER TABLE users ADD COLUMN daily_fails INTEGER NOT NULL DEFAULT 0;
