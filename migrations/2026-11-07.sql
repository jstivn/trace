-- Прод-база, этап 2 «подписки»: настройки, слова и прогресс по словам становятся «на человека».
-- Раньше ключ был один на всех (settings.key, vocabulary.word, word_groups.group_no); теперь уникальна пара (user_id, ключ).
-- Таблицы пересоздаются с переносом всех строк (SQLite не умеет менять первичный ключ на месте).
-- Нужна ПОСЛЕ migrations/2026-11-06.sql (колонка user_id). Код воркера работает и до, и после этой миграции
-- (пока пользователь один), но до подключения других людей её нужно выполнить.
-- Сделать копию базы ДО и выполнить ОДИН раз:
--   npx.cmd wrangler d1 execute trace-db --remote --file=./migrations/2026-11-07.sql
-- Потом сверить число строк: SELECT (SELECT COUNT(*) FROM settings), (SELECT COUNT(*) FROM vocabulary), (SELECT COUNT(*) FROM word_groups);

CREATE TABLE settings_new (
    user_id INTEGER NOT NULL DEFAULT 1,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
);
INSERT INTO settings_new (user_id, key, value) SELECT user_id, key, value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

CREATE TABLE vocabulary_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    word TEXT NOT NULL,
    translation TEXT NOT NULL,
    phonetic TEXT,
    example TEXT,
    lookup_count INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, word)
);
INSERT INTO vocabulary_new (id, user_id, word, translation, phonetic, example, lookup_count, created_at)
    SELECT id, user_id, word, translation, phonetic, example, lookup_count, created_at FROM vocabulary;
DROP TABLE vocabulary;
ALTER TABLE vocabulary_new RENAME TO vocabulary;
CREATE INDEX idx_vocab_word ON vocabulary(word);
CREATE INDEX idx_vocab_created_at ON vocabulary(created_at);
CREATE INDEX idx_vocab_user ON vocabulary(user_id);

CREATE TABLE word_groups_new (
    user_id INTEGER NOT NULL DEFAULT 1,
    group_no INTEGER NOT NULL,
    studied INTEGER DEFAULT 0,
    best INTEGER,
    last_score INTEGER,
    attempts INTEGER DEFAULT 0,
    perfect INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, group_no)
);
INSERT INTO word_groups_new (user_id, group_no, studied, best, last_score, attempts, perfect, updated_at)
    SELECT user_id, group_no, studied, best, last_score, attempts, perfect, updated_at FROM word_groups;
DROP TABLE word_groups;
ALTER TABLE word_groups_new RENAME TO word_groups;
