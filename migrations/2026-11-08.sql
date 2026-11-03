-- Прод-база, этап 4 «подписки»: оплата Telegram Stars. Только добавляет (старый воркер продолжает работать).
-- Выполнять ПОСЛЕ 2026-11-06.sql и 2026-11-07.sql, ОДИН раз (повтор даст «duplicate column» — значит уже применено):
--   npx.cmd wrangler d1 execute trace-db --remote --file=./migrations/2026-11-08.sql

ALTER TABLE users ADD COLUMN sub_notice TEXT;   -- какое напоминание о конце подписки уже отправлено

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
