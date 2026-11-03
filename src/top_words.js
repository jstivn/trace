// Топ-1000 частых английских слов, поделённых на 50 групп по 20 (как билеты ПДД).
// Источник слов и их порядка: NGSL 1.2 (New General Service List), Browne, Culligan & Phillips, https://www.newgeneralservicelist.com,
// первые 1000 по рейтингу частоты (файл NGSL_12_stats.csv, лицензия CC BY-SA 4.0). Переводы и произношение дописаны вручную.
// id слова = его место в списке (1..1000), группа = ceil(id / 20).
import P1 from './top_words_1.js';
import P2 from './top_words_2.js';
import P3 from './top_words_3.js';
import P4 from './top_words_4.js';

import S1 from './top_sentences_1.js';
import S2 from './top_sentences_2.js';
import S3 from './top_sentences_3.js';
import S4 from './top_sentences_4.js';

export const GROUP_SIZE = 20;

const dataLines = parts => parts.join('\n').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'));

// Мини-предложения лежат в тех же четырёх частях и в том же порядке. Строка: слово|предложение с {словом}|перевод|[свой перевод слова].
// Если строка не совпала со словом, слово остаётся без предложения (экран тогда работает по-старому).
const SENTENCES = dataLines([S1, S2, S3, S4]).map(line => {
  const [word, sentence, sentenceRu, translation] = line.split('|');
  return { word, sentence, sentenceRu, translation };
});

export const TOP_WORDS = dataLines([P1, P2, P3, P4])
  .map((line, i) => {
    const [word, translation, phonetic] = line.split('|');
    const s = SENTENCES[i];
    const item = { id: i + 1, word, translation, phonetic };
    if (s && s.word === word && s.sentence && s.sentenceRu) {
      item.sentence = s.sentence;
      item.sentence_ru = s.sentenceRu;
      if (s.translation) item.translation = s.translation;
    }
    return item;
  });

export const TOP_GROUPS = Math.ceil(TOP_WORDS.length / GROUP_SIZE);
