import test from 'node:test';
import assert from 'node:assert/strict';
import { TOP_WORDS } from '../src/top_words.js';

test('top words: 1000 words, ids in order', () => {
  assert.equal(TOP_WORDS.length, 1000);
  TOP_WORDS.forEach((w, i) => assert.equal(w.id, i + 1));
});

test('top words: every word has a sentence, its translation, and the word inside {braces} exactly once', () => {
  const bad = [];
  for (const w of TOP_WORDS) {
    const marks = w.sentence ? w.sentence.match(/\{[^{}]+\}/g) : null;
    const ok = marks && marks.length === 1
      && marks[0].slice(1, -1).toLowerCase() === w.word.toLowerCase()
      && !/[{}|]/.test(w.sentence.replace(/\{[^{}]+\}/, ''))
      && /[а-яё]/i.test(w.sentence_ru || '')
      && !/[{}|]/.test(w.sentence_ru);
    if (!ok) bad.push(w.id + ':' + w.word);
  }
  assert.deepEqual(bad, []);
});

test('top words: sentences are short and not repeated', () => {
  const seen = new Map();
  const long = [];
  for (const w of TOP_WORDS) {
    if (w.sentence.split(/\s+/).length > 12) long.push(w.word);
    seen.set(w.sentence, (seen.get(w.sentence) || 0) + 1);
  }
  assert.deepEqual(long, []);
  assert.deepEqual([...seen].filter(([, n]) => n > 1).map(([s]) => s), []);
});

test('top words: the word itself is never left untranslated', () => {
  assert.deepEqual(TOP_WORDS.filter(w => !w.translation || !w.translation.trim()).map(w => w.word), []);
});
