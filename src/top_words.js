// Топ-1000 частых английских слов, поделённых на 50 групп по 20 (как билеты ПДД).
// Источник слов и их порядка: NGSL 1.2 (New General Service List), Browne, Culligan & Phillips, https://www.newgeneralservicelist.com,
// первые 1000 по рейтингу частоты (файл NGSL_12_stats.csv, лицензия CC BY-SA 4.0). Переводы и произношение дописаны вручную.
// id слова = его место в списке (1..1000), группа = ceil(id / 20).
import P1 from './top_words_1.js';
import P2 from './top_words_2.js';
import P3 from './top_words_3.js';
import P4 from './top_words_4.js';

export const GROUP_SIZE = 20;

export const TOP_WORDS = [P1, P2, P3, P4]
  .join('\n')
  .split('\n')
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('//'))
  .map((line, i) => {
    const [word, translation, phonetic] = line.split('|');
    return { id: i + 1, word, translation, phonetic };
  });

export const TOP_GROUPS = Math.ceil(TOP_WORDS.length / GROUP_SIZE);
