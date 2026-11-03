// Run with: npm test   (Node 22+, uses the built-in node:sqlite as a D1 stand-in)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = (await import(pathToFileURL(path.join(ROOT, 'src/worker.js')).href)).default;

// ---------- test doubles ----------
function makeDB() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  const wrap = (sql, params = []) => ({
    bind: (...p) => wrap(sql, p),
    run: async () => {
      const r = db.prepare(sql).run(...params);
      return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
    },
    all: async () => ({ results: db.prepare(sql).all(...params).map(r => ({ ...r })) }),
    first: async () => { const r = db.prepare(sql).get(...params); return r ? { ...r } : null; }
  });
  return { prepare: (s) => wrap(s), raw: db };
}

let aiReply = null;             // what the fake Gemini returns
let geminiMode = 'ok';          // 'ok' | 'geo' | 'down'
let ratesMode = 'down';          // 'ok' | 'insane' | 'down'
const fetchLog = [];
const tgSent = [];
globalThis.fetch = async (url, opts) => {
  url = String(url);
  fetchLog.push(url);
  if (url.includes('generativelanguage') || url.includes('gateway.ai')) {
    if (geminiMode === 'down') return new Response('boom', { status: 500 });
    if (geminiMode === 'geo' && url.includes('generativelanguage')) {
      return new Response('User location is not supported for the API use.', { status: 400 });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(aiReply) }] } }] }), { status: 200 });
  }
  if (url.includes('api.telegram.org')) {
    if (opts?.body instanceof FormData) {    // sendDocument (the weekly backup)
      tgSent.push({ document: opts.body.get('document'), caption: opts.body.get('caption'), chat_id: opts.body.get('chat_id') });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    tgSent.push(opts?.body ? JSON.parse(opts.body) : null);
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }
  if (url.includes('open.er-api.com')) {
    if (ratesMode === 'ok') return new Response(JSON.stringify({ rates: { VND: 26000, RUB: 90, AED: 3.6725 } }), { status: 200 });
    if (ratesMode === 'insane') return new Response(JSON.stringify({ rates: { VND: 5, RUB: 90, AED: 3.6725 } }), { status: 200 });
  }
  return new Response('unavailable', { status: 500 });   // Groq etc.
};

const makeEnv = (extra = {}) => ({
  DB: makeDB(), GEMINI_API_KEY: 'k', TELEGRAM_BOT_TOKEN: 't', AUTH_TOKEN: 'secret', DEFAULT_CURRENCY: 'VND', ...extra
});
const call = (env, method, p, body, headers = {}, ctx = { waitUntil() {} }) =>
  worker.fetch(new Request('https://t.local' + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-token': 'secret', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, ctx);
const json = (r) => r.json();
const rows = (env, table) => env.DB.raw.prepare(`select * from ${table}`).all().map(r => ({ ...r }));
const say = async (env, text, actions) => {
  aiReply = { actions };
  return json(await call(env, 'POST', '/api/voice-hook', { text }));
};
const fin = (amount, extra = {}) => ({ type: 'finance', data: { amount, currency: 'VND', category: 'food', title: 'Еда', confidence: 0.9, ...extra } });

// ---------- amounts ----------
test('simple finance is stored as dictated', async () => {
  const env = makeEnv();
  await say(env, 'потратил 150к на еду', [fin(150000)]);
  assert.deepEqual(rows(env, 'finances').map(f => f.amount), [150000]);
});

test('amount is not hijacked by other numbers in a compound phrase', async () => {
  const env = makeEnv();
  await say(env, 'напомни завтра в 11 позвонить дизайнеру и потратил 150к на еду', [
    { type: 'task', data: { title: 'Позвонить дизайнеру' } }, fin(150000)
  ]);
  assert.deepEqual(rows(env, 'finances').map(f => f.amount), [150000]);
});

for (const [phrase, expected] of [
  ['потратил 2.5к на кофе', 2500],
  ['1.5 млн за аренду', 1500000],
  ['потратил 12.50 usd', 12.5],
  ['купил 2 билета за 500к', 500000],
  ['сто пятьдесят тысяч на еду', 150000],
  ['150 000 донгов', 150000]
]) {
  test(`amount parsing: "${phrase}"`, async () => {
    const env = makeEnv();
    await say(env, phrase, [fin(expected)]);
    assert.equal(rows(env, 'finances')[0].amount, expected);
  });
}

test('wrong LLM amount is corrected when the transcript has a single number', async () => {
  const env = makeEnv();
  await say(env, 'потратил 150к на кофе', [fin(777)]);
  assert.equal(rows(env, 'finances')[0].amount, 150000);
});

test('unverifiable LLM amount goes to review', async () => {
  const env = makeEnv();
  await say(env, 'потратил 150к и еще 20к на еду', [fin(777)]);
  const f = rows(env, 'finances')[0];
  assert.equal(f.amount, 777);
  assert.equal(f.needs_review, 1);
});

test('duplicate expense is flagged', async () => {
  const env = makeEnv();
  await say(env, 'кофе 50к', [fin(50000, { title: 'Кофе' })]);
  const r = await say(env, 'кофе 50к', [fin(50000, { title: 'Кофе' })]);
  assert.match(r.voice_reply, /дубликат/i);
  assert.deepEqual(rows(env, 'finances').map(f => f.possible_duplicate), [0, 1]);
});

// ---------- delete / update safety ----------
test('voice delete removes an existing record when asked to delete', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into finances(amount,currency,category,title) values (1000,'VND','food','Чай'),(2000,'VND','food','Кофе')");
  await say(env, 'удали расход на кофе', [{ type: 'delete', target_table: 'finances', target_id: 2 }]);
  assert.deepEqual(rows(env, 'finances').map(f => f.title), ['Чай']);
});

test('voice delete refuses a record that does not match what was said', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into finances(amount,currency,category,title) values (40000,'VND','food','Кофе')");
  env.DB.raw.exec("insert into tasks(title) values ('Позвонить дизайнеру')");
  let r = await say(env, 'удали расход на арбуз', [{ type: 'delete', target_table: 'finances', target_id: 1 }]);
  assert.equal(rows(env, 'finances').length, 1);
  assert.match(r.voice_reply, /не найдена/);
  r = await say(env, 'удали задачу купить молоко', [{ type: 'delete', target_table: 'tasks', target_id: 1 }]);
  assert.equal(rows(env, 'tasks').length, 1);
});

test('voice delete of "the last record" trusts the picked record; spoken amount also identifies it', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into finances(amount,currency,category,title) values (40000,'VND','food','Кофе'),(90000,'VND','food','Арбуз')");
  await say(env, 'удали последнюю запись', [{ type: 'delete', target_table: 'finances', target_id: 2 }]);
  await say(env, 'удали 40 тысяч', [{ type: 'delete', target_table: 'finances', target_id: 1 }]);
  assert.equal(rows(env, 'finances').length, 0);
});

test('voice correction by item name only touches the record with that name', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into finances(amount,currency,category,title) values (40000,'VND','food','Кофе'),(90000,'VND','food','Арбуз')");
  await say(env, 'исправь арбуз на 95 тысяч', [{ type: 'update', target_table: 'finances', target_id: 1, data: { amount: 95000 } }]);
  assert.deepEqual(rows(env, 'finances').map(f => f.amount), [40000, 90000], 'wrong record untouched');
  await say(env, 'исправь арбуз на 95 тысяч', [{ type: 'update', target_table: 'finances', target_id: 2, data: { amount: 95000 } }]);
  assert.deepEqual(rows(env, 'finances').map(f => f.amount), [40000, 95000]);
});

test('voice delete is ignored without delete intent and reports missing ids', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into finances(amount,currency,category,title) values (1000,'VND','food','a')");
  let r = await say(env, 'запиши что-нибудь', [{ type: 'delete', target_table: 'finances', target_id: 1 }]);
  assert.equal(rows(env, 'finances').length, 1);
  assert.match(r.screen_notification, /не найдена/);
  r = await say(env, 'удали расход', [{ type: 'delete', target_table: 'finances', target_id: 999 }]);
  assert.match(r.screen_notification, /не найдена/);
});

// ---------- tasks & reminders ----------
test('reminder marks a task reminded but not completed', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42'); insert into tasks(title,due_datetime) values ('t1', datetime('now','-1 minutes'))");
  await worker.scheduled({}, env, { waitUntil() {} });
  await new Promise(r => setTimeout(r, 200));
  const t = rows(env, 'tasks')[0];
  assert.equal(t.reminded, 1);
  assert.equal(t.is_completed, 0);
});

test('active tasks are ordered high, medium, low', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into tasks(title,priority) values ('l','low'),('h','high'),('m','medium')");
  const r = await json(await call(env, 'GET', '/api/tasks?filter=active'));
  assert.deepEqual(r.tasks.map(t => t.priority), ['high', 'medium', 'low']);
});

test('relative dates are computed in code (tomorrow 9 pm Nha Trang = 14:00 UTC)', async () => {
  const env = makeEnv();
  await say(env, 'напомни завтра в 9 вечера выпить', [{ type: 'task', data: { title: 'Выпить' } }]);
  assert.match(rows(env, 'tasks')[0].due_datetime, /14:00:00$/);
});

// ---------- finances API ----------
test('period totals are not capped at 100 rows', async () => {
  const env = makeEnv();
  const ins = env.DB.raw.prepare("insert into finances(amount,currency,category,title) values (?, 'VND','food','x')");
  for (let i = 0; i < 150; i++) ins.run(1000);
  const r = await json(await call(env, 'GET', '/api/finances?period=month'));
  assert.equal(r.total, 150000);
});

test('outside_limit: planned purchase stays in the list but not in totals or categories', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/api/finances', { amount: 50000, category: 'food', title: 'Обед' });
  await call(env, 'POST', '/api/finances', { amount: 3000000, category: 'tech', title: 'Ноутбук', outside_limit: true });
  let r = await json(await call(env, 'GET', '/api/finances?period=day'));
  assert.equal(r.total, 50000);
  assert.equal(r.outside_total, 3000000);
  assert.equal(r.categories.tech, 0);
  assert.equal(r.transactions.length, 2, 'the purchase is still listed');
  assert.deepEqual(r.transactions.map(t => t.outside_limit).sort(), [0, 1]);

  // the mark can be switched off again; a save that does not send it leaves it alone
  await call(env, 'PATCH', '/api/finances/2', { amount: 3000000, title: 'Ноутбук' });
  assert.equal(rows(env, 'finances')[1].outside_limit, 1);
  await call(env, 'PATCH', '/api/finances/2', { amount: 3000000, outside_limit: false });
  r = await json(await call(env, 'GET', '/api/finances?period=day'));
  assert.equal(r.total, 3050000);
});

// The local day of the month in Nha Trang (UTC+7), as the worker sees it
const nhaDay = () => new Date(Date.now() + 7 * 3600000).getUTCDate();
const nhaMonth = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 7);

test('recurring: fires on its day as a planned expense plus a task, once a month', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42')");
  const day = nhaDay();
  const add = await call(env, 'POST', '/api/recurring', { title: 'Интернет', amount: 250000, category: 'services', day_of_month: day, add_task: true });
  assert.equal(add.status, 200);
  await call(env, 'POST', '/api/recurring', { title: 'Завтрашний', amount: 1000, day_of_month: day === 28 ? 1 : day + 1 });
  assert.equal(rows(env, 'finances').length, 0, 'nothing is added at creation time');

  await worker.scheduled({}, env, { waitUntil() {} });
  await new Promise(r => setTimeout(r, 100));
  let fin = rows(env, 'finances');
  assert.equal(fin.length, 1);
  assert.equal(fin[0].title, 'Интернет');
  assert.equal(fin[0].amount, 250000);
  assert.equal(fin[0].outside_limit, 1, 'a planned payment stays out of the daily limit');
  const tasks = rows(env, 'tasks');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].is_date_only, 1);

  await worker.scheduled({}, env, { waitUntil() {} });                // the next minute: nothing new
  await new Promise(r => setTimeout(r, 100));
  assert.equal(rows(env, 'finances').length, 1);
  assert.equal(rows(env, 'tasks').length, 1);
  assert.equal(rows(env, 'recurring')[0].last_run_month, nhaMonth());
});

test('recurring: a day that already passed waits for next month; validation; edit and delete', async () => {
  const env = makeEnv();
  if (nhaDay() > 1) {
    await call(env, 'POST', '/api/recurring', { title: 'Аренда', amount: 5000000, day_of_month: 1 });
    assert.equal(rows(env, 'recurring')[0].last_run_month, nhaMonth(), 'this month already counts as done');
  }
  assert.equal((await call(env, 'POST', '/api/recurring', { title: '', amount: 1, day_of_month: 5 })).status, 400);
  assert.equal((await call(env, 'POST', '/api/recurring', { title: 'x', amount: 1, day_of_month: 40 })).status, 400);
  assert.equal((await call(env, 'POST', '/api/recurring', { title: 'x', day_of_month: 5 })).status, 400, 'an expense needs an amount');
  assert.equal((await call(env, 'POST', '/api/recurring', { title: 'x', day_of_month: 5, add_expense: false })).status, 400, 'something must be added');
  const ok = await call(env, 'POST', '/api/recurring', { title: 'Позвонить', day_of_month: 5, add_expense: false, add_task: true });
  assert.equal(ok.status, 200);
  const list = await json(await call(env, 'GET', '/api/recurring'));
  const id = list.items.find(i => i.title === 'Позвонить').id;
  assert.equal((await call(env, 'PATCH', '/api/recurring/' + id, { title: 'Позвонить маме', day_of_month: 7, add_expense: false, add_task: true })).status, 200);
  assert.equal(rows(env, 'recurring').find(i => i.id === id).day_of_month, 7);
  await call(env, 'DELETE', '/api/recurring/' + id);
  assert.equal(rows(env, 'recurring').some(i => i.id === id), false);
});

test('debts: a spoken debt is an expense with the debt mark, outside the day total; repayments lower it', async () => {
  const env = makeEnv();
  // even when the LLM files it as a plain expense or a note, the code recognises the phrase
  await say(env, 'Арбуз должен мне 100 тысяч', [fin(100000, { title: 'Арбуз' })]);
  await say(env, '100 000 арбуз долг', [{ type: 'note', data: { title: 'Арбуз', content: '100000 долг' } }]);
  const f = rows(env, 'finances');
  assert.deepEqual(f.map(r => [r.title, r.amount, r.is_debt, r.outside_limit]), [['Арбуз', 100000, 1, 1], ['Арбуз', 100000, 1, 1]]);

  const day = await json(await call(env, 'GET', '/api/finances?period=day'));
  assert.equal(day.total, 0, 'a debt is not today\'s spending');
  assert.equal(day.transactions.length, 2, 'but it stays in the list');

  await say(env, 'Арбуз вернул 150 тысяч', []);
  assert.deepEqual(rows(env, 'finances').map(r => r.debt_paid), [100000, 50000], 'oldest debt first');
  const list = await json(await call(env, 'GET', '/api/debts?currency=VND'));
  assert.equal(list.total, 50000);
  assert.equal(list.items.length, 2);

  await say(env, 'Незнакомец вернул 10 тысяч', []);
  assert.equal(rows(env, 'finances').reduce((s, r) => s + r.debt_paid, 0), 150000, 'an unknown person changes nothing');
});

test('debts: "я должен" is a separate list; my repayments do not touch debts owed to me', async () => {
  const env = makeEnv();
  await say(env, 'Арбуз должен мне 100 тысяч', []);
  await say(env, 'Я должен Диме 200 тысяч', []);
  await say(env, 'занял у Маши 50к', []);
  assert.deepEqual(rows(env, 'finances').map(r => [r.title.slice(0, 3), r.is_debt, r.debt_owe]), [['Арб', 1, 0], ['Дим', 1, 1], ['Маш', 1, 1]]);
  await say(env, 'я вернул Диме 80 тысяч', []);
  assert.deepEqual(rows(env, 'finances').map(r => r.debt_paid), [0, 80000, 0]);
  const owe = await json(await call(env, 'GET', '/api/debts?currency=VND&dir=owe'));
  assert.equal(owe.items.length, 2);
  assert.equal(owe.total, 170000);
  const owed = await json(await call(env, 'GET', '/api/debts?currency=VND'));
  assert.equal(owed.items.length, 1);
  assert.equal(owed.total, 100000);
  await say(env, 'Арбуз вернул 30 тысяч', []);
  assert.equal(rows(env, 'finances')[0].debt_paid, 30000);
});

test('top words: 1000 unique words in 50 groups of 20; progress keeps the best test score', async () => {
  const env = makeEnv();
  const d = await json(await call(env, 'GET', '/api/top-words'));
  assert.equal(d.words.length, 1000);
  assert.equal(d.group_count, 50);
  assert.equal(new Set(d.words.map(w => w.word.toLowerCase())).size, 1000, 'no repeated words');
  assert.ok(d.words.every((w, i) => w.id === i + 1 && w.word && w.translation && /^\[.+\]$/.test(w.phonetic)), 'every word has a translation and a pronunciation');
  assert.deepEqual(d.groups, {});

  await call(env, 'POST', '/api/top-words/progress', { group: 3, studied: true });
  await call(env, 'POST', '/api/top-words/progress', { group: 3, score: 85 });
  await call(env, 'POST', '/api/top-words/progress', { group: 3, score: 60 });
  await call(env, 'POST', '/api/top-words/progress', { group: 0, score: 40 });
  const p = (await json(await call(env, 'GET', '/api/top-words'))).groups;
  assert.deepEqual(p[3], { studied: true, best: 85, last: 60, attempts: 2, perfect: 0 });
  assert.deepEqual(p[0], { studied: false, best: 40, last: 40, attempts: 1, perfect: 0 });
  for (let i = 0; i < 3; i++) await call(env, 'POST', '/api/top-words/progress', { group: 4, score: 100 });
  await call(env, 'POST', '/api/top-words/progress', { group: 4, score: 95 });
  assert.equal((await json(await call(env, 'GET', '/api/top-words'))).groups[4].perfect, 3, 'only a 100% run counts as flawless');

  assert.equal((await call(env, 'POST', '/api/top-words/progress', { group: 51, score: 10 })).status, 400);
  assert.equal((await call(env, 'POST', '/api/top-words/progress', { group: 1, score: 150 })).status, 400);
});

test('debts: an ordinary expense with the word "отдал" stays an expense', async () => {
  const env = makeEnv();
  await say(env, 'отдал 50к за обед', [fin(50000)]);
  assert.equal(rows(env, 'finances')[0].is_debt, 0);
});

test('debts: the checkbox on an expense, partial and full return, unchecking removes it from the list', async () => {
  const env = makeEnv();
  const add = await json(await call(env, 'POST', '/api/finances', { amount: 100000, title: 'Арбуз', category: 'other', is_debt: true }));
  const id = add.id;
  assert.equal((await json(await call(env, 'GET', '/api/debts'))).items.length, 1);
  const part = await json(await call(env, 'POST', `/api/debts/${id}/pay`, { amount: 20000 }));
  assert.equal(part.left, 80000);
  assert.equal((await call(env, 'POST', `/api/debts/${id}/pay`, { amount: 0 })).status, 400);
  const all = await json(await call(env, 'POST', `/api/debts/${id}/pay`, { all: true }));
  assert.equal(all.left, 0);
  assert.equal((await json(await call(env, 'GET', '/api/debts'))).total, 0);

  await call(env, 'PATCH', '/api/finances/' + id, { amount: 100000, title: 'Арбуз', is_debt: false });
  assert.equal((await json(await call(env, 'GET', '/api/debts'))).items.length, 0);
  assert.equal((await call(env, 'POST', '/api/debts/999/pay', { all: true })).status, 404);
});

test('morning summary: lists today\'s tasks, skips done and other days, sends nothing on an empty day', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42')");
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 31 * 3600000).toISOString().slice(0, 10);
  env.DB.raw.exec(`insert into tasks(title,due_datetime,is_date_only) values ('Оплатить интернет','${today} 00:00:00',1),('Другой день','${tomorrow} 00:00:00',1)`);
  env.DB.raw.exec(`insert into tasks(title,due_datetime,is_completed) values ('Сделано','${today} 03:00:00',1)`);
  env.DB.raw.exec("insert into tasks(title,due_datetime) values ('Звонок', datetime('" + today + " 02:30:00'))");  // 09:30 Nha Trang
  tgSent.length = 0;
  const r = await json(await call(env, 'GET', '/api/cron-trigger?morning=1'));
  assert.equal(r.result.morningSent.count, 2);
  const card = tgSent.find(m => m && /На сегодня 2 задачи/.test(m.text || ''));
  assert.ok(card);
  assert.match(card.text, /Оплатить интернет/);
  assert.match(card.text, /09:30\s+Звонок/);
  assert.doesNotMatch(card.text, /Другой день|Сделано/);

  const empty = makeEnv();
  empty.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42')");
  tgSent.length = 0;
  const e = await json(await call(empty, 'GET', '/api/cron-trigger?morning=1'));
  assert.equal(e.result.morningSent, null);
  assert.equal(tgSent.some(m => m && /На сегодня/.test(m.text || '')), false);
});

test('morning summary can be switched off in settings', async () => {
  const env = makeEnv();
  assert.equal((await json(await call(env, 'GET', '/api/settings'))).morning_summary, true);
  await call(env, 'PUT', '/api/settings', { morning_summary: false });
  assert.equal((await json(await call(env, 'GET', '/api/settings'))).morning_summary, false);
});

test('no database copy is ever sent: not on Sunday, not when forced', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42'); insert into finances(amount,category,title) values (1000,'food','Чай')");
  tgSent.length = 0;
  const r = await json(await call(env, 'GET', '/api/cron-trigger?backup=1'));
  assert.equal(r.result.backupSent, undefined);
  assert.equal(tgSent.filter(m => m && m.document).length, 0);
});
test('invalid input is rejected with 400', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'POST', '/api/finances', { amount: -5 })).status, 400);
  const bad = await worker.fetch(new Request('https://t.local/api/finances', { method: 'POST', headers: { 'x-token': 'secret' }, body: '{bad' }), env, {});
  assert.equal(bad.status, 400);
});

// ---------- review queue ----------
test('merge refuses self-merge and missing targets without losing data', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into notes(title,content) values ('a','aaa'),('b','bbb')");
  assert.equal((await call(env, 'POST', '/api/review/merge', { table: 'notes', id: 1, target_id: 1 })).status, 400);
  assert.equal((await call(env, 'POST', '/api/review/merge', { table: 'notes', id: 2, target_id: 77 })).status, 404);
  assert.equal(rows(env, 'notes').length, 2);
});

// ---------- security ----------
test('API requires a token or valid Telegram initData', async () => {
  const env = makeEnv();
  const noTok = { 'x-token': '' };
  assert.equal((await call(env, 'GET', '/api/notes', undefined, noTok)).status, 401);
  assert.equal((await call(env, 'GET', '/api/notes', undefined, { 'x-token': 'nope' })).status, 401);
  assert.equal((await call(env, 'GET', '/api/notes')).status, 200);
  assert.equal((await call(env, 'POST', '/api/voice-hook', { text: 'x' }, noTok)).status, 401);
  assert.equal((await call(env, 'POST', '/api/sync-user', { chat_id: 1 }, noTok)).status, 401);
  assert.equal((await call(env, 'GET', '/api/cron-trigger?force=true', undefined, noTok)).status, 401);
  assert.equal((await call(env, 'GET', '/api/health', undefined, noTok)).status, 200);
  assert.equal((await call(env, 'GET', '/', undefined, noTok)).status, 200);
});

test('Telegram initData: owner ok, a stranger gets their own empty space, forged/expired rejected, owner id cannot be swapped', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42')");
  const initData = (uid, botToken = 't', age = 0) => {
    const p = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000) - age), query_id: 'q',
      user: JSON.stringify({ id: uid, first_name: 'x' })
    });
    const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
    return p.toString();
  };
  const as = (data) => call(env, 'GET', '/api/notes', undefined, { 'x-token': '', 'x-telegram-init-data': data });
  assert.equal((await as(initData(42))).status, 200);
  env.DB.raw.exec("insert into notes(title,content) values ('owner note','secret')");
  const stranger = await as(initData(7));
  assert.equal(stranger.status, 200);
  assert.deepEqual((await json(stranger)).notes, []);                     // not the owner's notes
  assert.equal(env.DB.raw.prepare('select status, role from users where telegram_id = 7').get().role, 'user');
  assert.equal((await as(initData(42, 'other-bot'))).status, 401);
  assert.equal((await as(initData(42, 't', 90000))).status, 401);
  const swap = await call(env, 'POST', '/api/sync-user', { chat_id: 666 }, { 'x-token': '', 'x-telegram-init-data': initData(42) });
  assert.equal(swap.status, 403);
  assert.equal(rows(env, 'settings')[0].value, '42');
});

test('Telegram webhook ignores strangers, enforces secret and drops replayed updates', async () => {
  const env = makeEnv({ TELEGRAM_WEBHOOK_SECRET: 'whs' });
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42')");
  aiReply = { actions: [{ type: 'note', data: { category: 'idea', title: 'hello world', content: 'hello world note' } }] };
  const send = (body, secret = 'whs') => {
    const pending = [];
    return worker.fetch(new Request('https://t.local/api/telegram-webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
      body: JSON.stringify(body)
    }), env, { waitUntil: p => pending.push(p) }).then(async r => { await Promise.all(pending); return r; });
  };
  assert.equal((await send({ update_id: 1, message: { chat: { id: 42 }, text: 'x' } }, '')).status, 403);
  await send({ update_id: 2, message: { chat: { id: 9999 }, text: 'spam' } });
  assert.equal(rows(env, 'notes').length, 0);
  assert.equal(rows(env, 'settings').find(s => s.key === 'telegram_chat_id').value, '42');
  await send({ update_id: 10, message: { chat: { id: 42 }, text: 'hello world note' } });
  await send({ update_id: 10, message: { chat: { id: 42 }, text: 'hello world note' } });
  assert.equal(rows(env, 'notes').length, 1);
});

test('Mini App quick capture: works with Telegram initData, rejects anonymous calls', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42')");
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 42 }) });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  p.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update('t').digest()).update(dcs).digest('hex'));
  aiReply = { actions: [fin(45000, { title: 'Кофе' })] };
  assert.equal((await call(env, 'POST', '/api/capture', { text: 'кофе 45к' }, { 'x-token': '' })).status, 401);
  const r = await call(env, 'POST', '/api/capture', { text: 'кофе 45к' }, { 'x-token': '', 'x-telegram-init-data': p.toString() });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.deepEqual(rows(env, 'finances').map(f => f.amount), [45000]);
});

test('tasks API: date-only flag is stored and a new due date re-arms the reminder', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/api/tasks', { title: 'Купить фильтры', due_datetime: '2026-11-02 00:00:00', is_date_only: true });
  assert.equal(rows(env, 'tasks')[0].is_date_only, 1);
  env.DB.raw.exec('update tasks set reminded = 2');
  await call(env, 'PATCH', '/api/tasks/1', { title: 'Купить фильтры', due_datetime: '2026-11-02 00:00:00', is_date_only: true });
  assert.equal(rows(env, 'tasks')[0].reminded, 2, 'same due date keeps the reminder state');
  await call(env, 'PATCH', '/api/tasks/1', { title: 'Купить фильтры', due_datetime: '2026-11-03 03:00:00' });
  const t = rows(env, 'tasks')[0];
  assert.equal(t.reminded, 0);
  assert.equal(t.is_date_only, 0);
});

test('translate: a Russian word with an English translation is stored English -> Russian', async () => {
  const env = makeEnv();
  await say(env, 'как будет собака по-английски', [{ type: 'translate', data: { word: 'собака', translation: 'dog', phonetic: '[дог]', example: 'The dog barks.' } }]);
  const v = rows(env, 'vocabulary');
  assert.equal(v[0].word, 'dog');
  assert.equal(v[0].translation, 'собака');
});

test('vocabulary API returns words under "words"', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/api/vocabulary', { word: 'resilient', translation: 'стойкий' });
  const r = await json(await call(env, 'GET', '/api/vocabulary'));
  assert.equal(r.words[0].word, 'resilient');
});

// ---------- LLM cascade ----------
test('LLM cascade: after a regional refusal the next request goes through the gateway first', async () => {
  geminiMode = 'geo';
  fetchLog.length = 0;
  const env = makeEnv();
  await say(env, 'запиши идею про сайт', [{ type: 'note', data: { category: 'idea', title: 'Сайт', content: 'идея про сайт' } }]);
  const firstCall = fetchLog.filter(u => u.includes('generativelanguage') || u.includes('gateway.ai'));
  assert.ok(firstCall[0].includes('generativelanguage'), 'first attempt is direct');
  fetchLog.length = 0;
  await say(env, 'запиши идею про сайт два', [{ type: 'note', data: { category: 'idea', title: 'Сайт два', content: 'идея про сайт два' } }]);
  const secondCall = fetchLog.filter(u => u.includes('generativelanguage') || u.includes('gateway.ai'));
  assert.ok(secondCall[0].includes('gateway.ai'), 'second request tries the gateway first');
  geminiMode = 'ok';
});

test('LLM cascade: when every provider fails the phrase is still saved as a note', async () => {
  geminiMode = 'down';
  const env = makeEnv();
  const r = await json(await call(env, 'POST', '/api/voice-hook', { text: 'просто мысль про лендинг' }));
  assert.equal(r.ok, true);
  assert.equal(rows(env, 'notes').length, 1);
  geminiMode = 'ok';
});

// ---------- voice corrections ----------
test('correction "не 90, а 70 тысяч арбуз" fixes the 90k record', async () => {
  const env = makeEnv();
  await say(env, '90 тысяч арбуз', [fin(90000, { title: 'Арбуз' })]);
  await say(env, 'не 90, а 70 тысяч арбуз', [{ type: 'update', target_table: 'finances', target_id: 1, data: { amount: 70000 } }]);
  assert.deepEqual(rows(env, 'finances').map(f => f.amount), [70000]);
});

test('correction never rewrites a record with another amount (seen in prod: coffee 40k became 70k)', async () => {
  const env = makeEnv();
  await say(env, 'купил кофе за 40 тысяч', [fin(40000, { title: 'Кофе' })]);
  const r = await say(env, 'не 90, а 70 тысяч арбуз', [{ type: 'update', target_table: 'finances', target_id: 1, data: { amount: 70000 } }]);
  assert.deepEqual(rows(env, 'finances').map(f => [f.amount, f.title]), [[40000, 'Кофе']]);
  assert.match(r.voice_reply, /не найдена/);
});

// ---------- bare expense dictations (seen in prod: filed as notes) ----------
test('expense: "110 тысяч обед в лето" filed by the LLM as a note is still an expense', async () => {
  const env = makeEnv();
  const r = await say(env, '110 тысяч обед в лето', [{ type: 'note', data: { category: 'fact', title: 'Обед в лето', content: '110 тысяч обед в лето' } }]);
  assert.deepEqual(rows(env, 'finances').map(f => [f.amount, f.title, f.category, f.needs_review]), [[110000, 'Обед в лето', 'food', 0]]);
  assert.equal(rows(env, 'notes').length, 0);
  assert.match(r.screen_notification, /Расход: 110\s000 VND/);
});

test('expense: two expenses survive a total LLM outage', async () => {
  geminiMode = 'down';
  const env = makeEnv();
  await json(await call(env, 'POST', '/api/voice-hook', { text: '140 000 шаурма и 50 000 пепси' }));
  assert.deepEqual(rows(env, 'finances').map(f => [f.amount, f.title]), [[140000, 'Шаурма'], [50000, 'Пепси']]);
  assert.equal(rows(env, 'notes').length, 0);
  geminiMode = 'ok';
});

for (const [phrase, expected] of [
  ['50 тысяч на кофе потратил', [[50000, 'Кофе', 'VND']]],
  ['кофе 50к', [[50000, 'Кофе', 'VND']]],
  ['10 тысяч рублей такси', [[10000, 'Такси', 'RUB']]]
]) {
  test(`expense phrase parsed: "${phrase}"`, async () => {
    geminiMode = 'down';
    const env = makeEnv();
    await json(await call(env, 'POST', '/api/voice-hook', { text: phrase }));
    assert.deepEqual(rows(env, 'finances').map(f => [f.amount, f.title, f.currency]), expected);
    geminiMode = 'ok';
  });
}

test('expense categories come from each expense, not the whole phrase', async () => {
  geminiMode = 'down';
  const env = makeEnv();
  await json(await call(env, 'POST', '/api/voice-hook', { text: '60 тысяч такси и 30 тысяч вода' }));
  assert.deepEqual(rows(env, 'finances').map(f => [f.title, f.category]), [['Такси', 'car'], ['Вода', 'food']]);
  geminiMode = 'ok';
});

test('period breakdown adds up: a confirmed "unsure" expense counts as "other"', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into finances(amount,currency,category,title) values (777,'VND','unsure','Что-то'),(1000,'VND','food','Кофе')");
  const r = await json(await call(env, 'GET', '/api/finances?period=week&currency=VND'));
  const sum = Object.values(r.categories).reduce((s, v) => s + v, 0);
  assert.equal(sum, r.total);
  assert.equal(r.categories.other, 777);
});

test('editing a record by hand takes it out of the review queue', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into finances(amount,currency,category,title,needs_review) values (777,'VND','unsure','Что-то',1)");
  await call(env, 'PATCH', '/api/finances/1', { amount: 150000, title: 'Еда', category: 'food', currency: 'VND' });
  const f = rows(env, 'finances')[0];
  assert.deepEqual([f.amount, f.category, f.needs_review], [150000, 'food', 0]);
  const review = await json(await call(env, 'GET', '/api/review'));
  assert.equal(review.count, 0);
});

test('notes search ignores case in Russian', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into notes(category,title,content) values ('thought','Про привычки','надо побороть нежелание'),('idea','Идея лендинга','что-то')");
  const find = async (q) => (await json(await call(env, 'GET', '/api/notes?q=' + encodeURIComponent(q)))).notes.map(n => n.title);
  assert.deepEqual(await find('Привычки'), ['Про привычки']);
  assert.deepEqual(await find('идея'), ['Идея лендинга']);
  assert.deepEqual(await find('ПОБОРОТЬ'), ['Про привычки']);
});

test('vocabulary: same word in another case is one entry; editing renames, a clash is refused', async () => {
  const env = makeEnv();
  await call(env, 'POST', '/api/vocabulary', { word: 'discount', translation: 'скидка' });
  await call(env, 'POST', '/api/vocabulary', { word: 'Discount', translation: 'скидка' });
  await say(env, 'переведи слово DISCOUNT', [{ type: 'translate', data: { word: 'DISCOUNT', translation: 'скидка' } }]);
  let v = rows(env, 'vocabulary');
  assert.deepEqual(v.map(w => [w.word, w.lookup_count]), [['discount', 3]]);
  await call(env, 'POST', '/api/vocabulary', { word: 'vibe', translation: 'атмосфера' });
  let r = await call(env, 'PUT', '/api/vocabulary/1', { word: 'discounts', translation: 'скидки' });
  assert.equal(r.status, 200);
  r = await call(env, 'PUT', '/api/vocabulary/1', { word: 'Vibe', translation: 'x' });
  assert.equal(r.status, 409);
  v = rows(env, 'vocabulary');
  assert.deepEqual(v.map(w => w.word), ['discounts', 'vibe']);
});

// ---------- expense dates ----------
const localDateOfRow = (createdAt) => new Date(Date.parse(String(createdAt).replace(' ', 'T') + 'Z') + 7 * 3600000).toISOString().slice(0, 10);
const todayLocal = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(todayLocal() + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

test('expense date: "вчера потратил..." is filed under yesterday and the reply says so', async () => {
  const env = makeEnv();
  const r = await say(env, 'Вчера потратил 140 тысяч на шоурум', [fin(140000, { title: 'Шоурум', evidence: 'потратил 140 тысяч на шоурум' })]);
  assert.equal(localDateOfRow(rows(env, 'finances')[0].created_at), daysAgo(1));
  assert.match(r.screen_notification, /Шоурум\), вчера$/);
  const day = await json(await call(env, 'GET', `/api/finances?date=${daysAgo(1)}&currency=VND`));
  assert.equal(day.total, 140000);
});

for (const [phrase, ago, title] of [
  ['позавчера 50к кофе', 2, 'Кофе'],
  ['3 дня назад 200 тысяч аренда байка', 3, 'Аренда байка'],
  [`${Number(daysAgo(4).slice(8))} ${MONTHS[Number(daysAgo(4).slice(5, 7)) - 1]} 100 тысяч массаж`, 4, 'Массаж'],
  ['1.5 млн за аренду', 0, 'Аренду'],
  ['сегодня 45000 кофе', 0, 'Кофе']
]) {
  test(`expense date when the LLM is down: "${phrase}"`, async () => {
    geminiMode = 'down';
    const env = makeEnv();
    await json(await call(env, 'POST', '/api/voice-hook', { text: phrase }));
    const f = rows(env, 'finances')[0];
    assert.ok(f, 'saved');
    assert.equal(localDateOfRow(f.created_at), daysAgo(ago));
    assert.equal(f.title, title);
    geminiMode = 'ok';
  });
}

test('expense date: "в пятницу" is the last Friday, never today or ahead', async () => {
  const env = makeEnv();
  await say(env, 'в пятницу 30 тысяч такси', [fin(30000, { title: 'Такси' })]);
  const d = localDateOfRow(rows(env, 'finances')[0].created_at);
  assert.equal(new Date(d + 'T00:00:00Z').getUTCDay(), 5);
  assert.ok(d < todayLocal() && d >= daysAgo(7));
});

test('expense date: a weekday that belongs to a task in the same phrase does not move the expense', async () => {
  const env = makeEnv();
  await say(env, 'купил кофе за 40 тысяч и в пятницу позвонить мастеру', [
    fin(40000, { title: 'Кофе', evidence: 'купил кофе за 40 тысяч' }), { type: 'task', data: { title: 'Позвонить мастеру' } }
  ]);
  assert.equal(localDateOfRow(rows(env, 'finances')[0].created_at), todayLocal());
});

test('expense date: captured in the app while yesterday is open lands on yesterday; a future day is ignored', async () => {
  const env = makeEnv();
  aiReply = { actions: [fin(50000, { title: 'Кофе' })] };
  await call(env, 'POST', '/api/capture', { text: '50к кофе', date: daysAgo(1) });
  aiReply = { actions: [fin(60000, { title: 'Чай' })] };
  await call(env, 'POST', '/api/capture', { text: '60к чай', date: '2999-01-01' });
  assert.deepEqual(rows(env, 'finances').map(f => [f.title, localDateOfRow(f.created_at)]), [['Кофе', daysAgo(1)], ['Чай', todayLocal()]]);
});

test('expense date: editing moves an expense to another day and keeps the time; future dates are refused', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into finances(amount,currency,category,title,created_at) values (1000,'VND','food','Кофе','2026-10-31 05:30:00')");
  let r = await call(env, 'PATCH', '/api/finances/1', { amount: 1000, date: '2026-10-29' });
  assert.equal(r.status, 200);
  assert.equal(rows(env, 'finances')[0].created_at, '2026-10-29 05:30:00');
  r = await call(env, 'PATCH', '/api/finances/1', { amount: 1000, date: '2999-01-01' });
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/finances', { amount: 5, title: 'x', date: daysAgo(2) });
  assert.equal(localDateOfRow(rows(env, 'finances')[1].created_at), daysAgo(2));
});

// ---------- settings: daily limit, word reminders ----------
test('settings: limit can be changed (in the shown currency) and switched off', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into finances(amount,currency,category,title) values (300000,'VND','food','Еда')");
  let s = await json(await call(env, 'GET', '/api/settings?currency=VND'));
  assert.deepEqual([s.limit_enabled, s.limit_amount, s.vocab_reminders], [true, 200000, 'daily']);

  await call(env, 'PUT', '/api/settings', { limit_enabled: true, limit_amount: '500 000', currency: 'VND' });
  let day = await json(await call(env, 'GET', '/api/finances?period=day&currency=VND'));
  assert.equal(day.limit, 500000);

  await call(env, 'PUT', '/api/settings', { limit_enabled: false });
  day = await json(await call(env, 'GET', '/api/finances?period=week&currency=VND'));
  assert.deepEqual([day.limit, day.daily_limit, day.limit_enabled], [0, 0, false]);
  s = await json(await call(env, 'GET', '/api/settings?currency=VND'));
  assert.equal(s.limit_amount, 500000, 'the amount is kept for when the limit is switched back on');

  assert.equal((await call(env, 'PUT', '/api/settings', { limit_enabled: true, limit_amount: 0 })).status, 400);
  assert.equal((await call(env, 'PUT', '/api/settings', { vocab_reminders: 'hourly' })).status, 400);
});

test('daily digest leaves the limit out when it is switched off', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42'), ('daily_limit_off','1')");
  tgSent.length = 0;
  await call(env, 'GET', '/api/cron-trigger?digest=1');
  const digest = tgSent.find(m => m && /Трат не было/.test(m.text || ''));
  assert.ok(digest);
  assert.doesNotMatch(digest.text, /лимит| из /i);
});

// ---------- Telegram cards ----------
// Presses an inline button: increasing update ids (the bot drops replays) and waits for the background job
let nextUpdateId = 1000;
async function pressButton(env, data, text = 'x') {
  const pending = [];
  await worker.fetch(new Request('https://t.local/api/telegram-webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: nextUpdateId++, callback_query: { id: 'c', data, from: { id: 42 }, message: { chat: { id: 42 }, message_id: 9, text } } })
  }), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}

test('daily digest card: total of limit, aligned category column, over-limit line', async () => {
  const env = makeEnv();
  env.DB.raw.exec(`insert into settings(key,value) values ('telegram_chat_id','42'), ('daily_limit_vnd','300000');
    insert into finances(amount,currency,category,title) values (520000,'VND','food','Еда'),(120000,'VND','car','Такси'),(605000,'VND','unsure','Что-то')`);
  tgSent.length = 0;
  await call(env, 'GET', '/api/cron-trigger?digest=1');
  const d = tgSent.find(m => m && /<pre>/.test(m.text || ''));
  const lines = d.text.split('\n');
  assert.match(lines[0], /^<i>[А-Я][а-я]+, \d+ [а-я]+<\/i>$/);
  assert.equal(lines[1], '<b>1 245 000 ₫</b> из 300 000 ₫');
  assert.equal(lines.slice(2, 5).join('\n'), '<pre>Прочее     605 000\nЕда        520 000\nТранспорт  120 000</pre>');
  assert.equal(lines[5], '<b>Сверх лимита на 945 000 ₫</b> · 3 траты');
});

test('saved card after a Shortcut capture: amount line, quote, edit and delete buttons; delete works', async () => {
  // No TELEGRAM_CHAT_ID secret (as in prod): the chat saved in settings is used
  const env = makeEnv();
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42')");
  tgSent.length = 0;
  await say(env, '45000 кофе', [fin(45000, { title: 'Кофе' })]);
  const card = tgSent.find(m => m && /Кофе/.test(m.text || ''));
  assert.equal(card.text, '<b>Кофе — 45 000 ₫</b>\nЕда\n<i>«45000 кофе»</i>');
  const kb = JSON.stringify(card.reply_markup);
  assert.match(kb, /open=finance:1/);
  assert.match(kb, /del_finances_1/);

  tgSent.length = 0;
  await pressButton(env, 'del_finances_1', 'Кофе — 45 000 ₫\nЕда');
  assert.equal(rows(env, 'finances').length, 0);
  assert.ok(tgSent.some(m => m && m.text === '<s>Кофе — 45 000 ₫</s>\n<i>Удалено</i>'));
});

test('saved card: several records get one "Открыть TRACE" button; a flagged one says so', async () => {
  const env = makeEnv({ TELEGRAM_CHAT_ID: '42' });
  tgSent.length = 0;
  await say(env, 'потратил 150к и еще 20к на еду', [fin(777), { type: 'task', data: { title: 'Позвонить' } }]);
  const card = tgSent.find(m => m && /Позвонить/.test(m.text || ''));
  assert.match(card.text, /проверь в разделе «Проверить»/);
  assert.doesNotMatch(JSON.stringify(card.reply_markup), /del_/);
});

// Runs the cron at a given Nha Trang time and reports whether a word was pushed
const wordPushedAt = async (localHour, mode, lastSentLocal = null) => {
  const env = makeEnv();
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42'); insert into vocabulary(word,translation) values ('vibe','атмосфера')");
  if (mode) env.DB.raw.prepare("insert into settings(key,value) values ('vocab_reminders', ?)").run(mode);
  const at = (h) => Date.UTC(2026, 10, 2, h - 7, 5);           // 2 Nov 2026, hh:05 local
  if (lastSentLocal !== null) {
    env.DB.raw.prepare("insert into settings(key,value) values ('last_vocab_reminder', ?)").run(new Date(at(lastSentLocal)).toISOString().slice(0, 19).replace('T', ' '));
  }
  mock.timers.enable({ apis: ['Date'], now: at(localHour) });
  tgSent.length = 0;
  try {
    await call(env, 'GET', '/api/cron-trigger');
  } finally {
    mock.timers.reset();
  }
  return tgSent.some(m => m && /vibe/.test(m.text || ''));
};

test('word reminders: off sends nothing, once a day waits for 10:00 and sends once', async () => {
  assert.equal(await wordPushedAt(12, 'off'), false);
  assert.equal(await wordPushedAt(9, 'daily'), false);
  assert.equal(await wordPushedAt(10, 'daily'), true);
  assert.equal(await wordPushedAt(15, 'daily', 10), false, 'already sent today');
  assert.equal(await wordPushedAt(10, 'daily', 10 - 24), true, 'sent yesterday');
});

test('word reminders: twice a day at 10:00 and 18:00, every 3 hours when "often"', async () => {
  assert.equal(await wordPushedAt(17, 'twice', 10), false);
  assert.equal(await wordPushedAt(18, 'twice', 10), true);
  assert.equal(await wordPushedAt(12, 'often', 10), false);
  assert.equal(await wordPushedAt(13, 'often', 10), true);
  assert.equal(await wordPushedAt(23, 'often', 10), false, 'never at night');
});

test('word message: example split into English and Russian, frequency buttons save the choice', async () => {
  const env = makeEnv({ TELEGRAM_CHAT_ID: '42' });
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42'); insert into vocabulary(word,translation,phonetic,example) values ('resilient','устойчивый','[рези́лиент]','She is resilient. (Она стойкая.)')");
  tgSent.length = 0;
  await call(env, 'GET', '/api/cron-trigger?vocab=1');
  const msg = tgSent.find(m => m && /resilient/.test(m.text || ''));
  assert.equal(msg.text, '<b>resilient</b>  [рези́лиент]\nустойчивый\n\n<i>She is resilient.</i>\nОна стойкая.');
  assert.ok(JSON.stringify(msg.reply_markup).includes('vocab_freq'));

  tgSent.length = 0;
  await pressButton(env, 'vocab_freq');
  assert.ok(tgSent.some(m => m && JSON.stringify(m.reply_markup || {}).includes('vocab_mode_off')));
  await pressButton(env, 'vocab_mode_off');
  assert.equal(rows(env, 'settings').find(r => r.key === 'vocab_reminders').value, 'off');
});

for (const phrase of [
  'бюджет 10 тысяч на еду',
  'напомни в 12 позвонить',
  'Подумал я тут съесть собаку и в 12 часов покакать',
  'встреча с 3 друзьями'
]) {
  test(`not an expense: "${phrase}"`, async () => {
    const env = makeEnv();
    await say(env, phrase, [{ type: 'note', data: { category: 'thought', title: 'Мысль', content: phrase } }]);
    assert.equal(rows(env, 'finances').length, 0);
  });
}

test('STT silence hallucinations are not saved', async () => {
  const env = makeEnv({ GROQ_API_KEY: 'g' });
  for (const heard of ['Субтитры сделал DimaTorzok', 'а']) {
    const prev = globalThis.fetch;
    globalThis.fetch = async (url, opts) => String(url).includes('audio/transcriptions')
      ? new Response(JSON.stringify({ text: heard }), { status: 200 })
      : prev(url, opts);
    const r = await json(await call(env, 'POST', '/api/voice-hook', { audio: Buffer.from('fake-audio').toString('base64') }));
    globalThis.fetch = prev;
    assert.equal(r.ok, false);
  }
  assert.equal(rows(env, 'notes').length + rows(env, 'finances').length, 0);
});

test('request_logs table exists and is written', async () => {
  const env = makeEnv();
  await say(env, 'запиши идею', [{ type: 'note', data: { category: 'idea', title: 'Идея', content: 'идея' } }]);
  assert.ok(rows(env, 'request_logs').length >= 1);
});

// ---------- dates ----------
const localDay = (offsetDays) => {
  const d = new Date(Date.now() + 7 * 3600000);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const nextDow = (dow) => {
  const today = new Date(Date.now() + 7 * 3600000).getUTCDay();
  return ((dow - today + 7) % 7) || 7;
};
const dueOf = async (phrase, title = 'Задача') => {
  const env = makeEnv();
  await say(env, phrase, [{ type: 'task', data: { title } }]);
  return rows(env, 'tasks')[0];
};

test('dates: "через 2 дня" and "через неделю" are date-only', async () => {
  let t = await dueOf('напомни через 2 дня позвонить');
  assert.equal(t.due_datetime, `${localDay(2)} 00:00:00`);
  assert.equal(t.is_date_only, 1);
  t = await dueOf('сделать отчёт через неделю');
  assert.equal(t.due_datetime, `${localDay(7)} 00:00:00`);
});

test('dates: weekday names resolve to the next such day, with the spoken time', async () => {
  const t = await dueOf('напомни в пятницу в 10 утра сходить в банк');
  const day = localDay(nextDow(5));
  assert.equal(t.due_datetime, `${day} 03:00:00`);          // 10:00 Nha Trang = 03:00 UTC
  assert.equal(t.is_date_only, 0);
});

test('dates: "в среднем" is not mistaken for Wednesday', async () => {
  const env = makeEnv();
  await say(env, 'проверить что в среднем расходы растут', [{ type: 'task', data: { title: 'Проверить расходы' } }]);
  assert.equal(rows(env, 'tasks')[0].due_datetime, null);
});

test('dates: every task in one phrase gets its own date', async () => {
  const env = makeEnv();
  await say(env, 'напомни завтра в 11 позвонить Ахмеду, а в пятницу заказать детали', [
    { type: 'task', data: { title: 'Позвонить Ахмеду' } },
    { type: 'task', data: { title: 'Заказать детали' } }
  ]);
  const [a, b] = rows(env, 'tasks');
  assert.equal(a.due_datetime, `${localDay(1)} 04:00:00`);   // 11:00 Nha Trang
  assert.equal(b.due_datetime, `${localDay(nextDow(5))} 00:00:00`);
});

// ---------- reminders ----------
const taskAfterTicks = async (env, due, reminded, ticks = 1) => {
  env.DB.raw.exec(`insert into settings(key,value) values ('telegram_chat_id','42'); insert into tasks(title,due_datetime,reminded) values ('t1', datetime('now','${due}'), ${reminded})`);
  tgSent.length = 0;
  for (let i = 0; i < ticks; i++) await worker.scheduled({}, env, { waitUntil() {} });
  await new Promise(r => setTimeout(r, 150));
  return { task: rows(env, 'tasks')[0], pings: tgSent.filter(m => m?.text?.includes('Напоминание')).length };
};

test('reminder: first ping at the due time, includes snooze button, counter increments', async () => {
  const env = makeEnv();
  const { task, pings } = await taskAfterTicks(env, '-1 minutes', 0);
  assert.equal(pings, 1);
  assert.equal(task.reminded, 1);
  const msg = tgSent.find(m => m?.text?.includes('Напоминание'));
  assert.match(msg.text, /^<i>Напоминание<\/i>\n<blockquote><b>t1<\/b>\nсегодня в \d{1,2}:\d\d<\/blockquote>$/);
  const kb = JSON.stringify(msg.reply_markup);
  assert.match(kb, /snooze_1/);
  assert.match(kb, /done_1/);
});

test('reminder: repeats 30 minutes after the first ping, stops after 3 pings', async () => {
  let r = await taskAfterTicks(makeEnv(), '-31 minutes', 1);
  assert.equal(r.pings, 1);                 // second ping is due
  assert.equal(r.task.reminded, 2);
  r = await taskAfterTicks(makeEnv(), '-10 minutes', 1);
  assert.equal(r.pings, 0);                 // too early for the repeat
  r = await taskAfterTicks(makeEnv(), '-61 minutes', 2);
  assert.equal(r.pings, 1);
  assert.equal(r.task.reminded, 3);
  r = await taskAfterTicks(makeEnv(), '-200 minutes', 3);
  assert.equal(r.pings, 0);                 // already pinged 3 times
});

test('reminder: an old, never-completed task does not trigger a burst of repeats', async () => {
  const r = await taskAfterTicks(makeEnv(), '-5 hours', 1);
  assert.equal(r.pings, 0);
});

test('reminder: snooze button moves the task 10 minutes ahead and resets the counter', async () => {
  const env = makeEnv();
  env.DB.raw.exec("insert into settings(key,value) values ('telegram_chat_id','42'); insert into tasks(title,due_datetime,reminded) values ('t1', datetime('now','-1 minutes'), 1)");
  const pending = [];
  await worker.fetch(new Request('https://t.local/api/telegram-webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: 5, callback_query: { id: 'c', data: 'snooze_1', message: { chat: { id: 42 }, message_id: 9, text: 'Напоминание' } } })
  }), env, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  const t = rows(env, 'tasks')[0];
  assert.equal(t.reminded, 0);
  const mins = (new Date(t.due_datetime.replace(' ', 'T') + 'Z') - Date.now()) / 60000;
  assert.ok(mins > 8 && mins <= 10.5, `due in ${mins.toFixed(1)} min`);
});

// ---------- exchange rates ----------
const usdTotal = async (env) => (await json(await call(env, 'GET', '/api/finances?period=month&currency=USD'))).total;
const withTx = (env) => env.DB.raw.exec("insert into finances(amount,currency,category,title) values (26000,'VND','food','x')");

test('rates: live rates are fetched, used and cached in the database', async () => {
  ratesMode = 'ok';
  const env = makeEnv(); withTx(env);
  assert.ok(Math.abs(await usdTotal(env) - 1) < 1e-9);          // 26000 VND at 26000/USD
  const cache = JSON.parse(env.DB.raw.prepare("select value from settings where key='rates_cache'").get().value);
  assert.equal(cache.rates.VND, 26000);
  ratesMode = 'down';
});

test('rates: an implausible answer from the rates service is ignored', async () => {
  ratesMode = 'insane';
  const env = makeEnv(); withTx(env);
  assert.ok(Math.abs(await usdTotal(env) - 26000 / 25400) < 1e-9);   // built-in fallback rate
  ratesMode = 'down';
});

test('rates: when the service is down the stale cache is kept and retries are throttled', async () => {
  ratesMode = 'down';
  const env = makeEnv(); withTx(env);
  const stale = { ts: Date.now() - 3 * 24 * 3600 * 1000, rates: { USD: 1, VND: 27000, RUB: 90, AED: 3.6725 } };
  env.DB.raw.prepare("insert into settings(key,value) values ('rates_cache', ?)").run(JSON.stringify(stale));
  fetchLog.length = 0;
  assert.ok(Math.abs(await usdTotal(env) - 26000 / 27000) < 1e-9);
  await usdTotal(env);
  assert.equal(fetchLog.filter(u => u.includes('open.er-api.com')).length, 1);   // second call within 10 min: no refetch
});

// ---------- isolation between users (subscriptions, stage 2): the most important tests of the project ----------
const B_TOKEN = 'b-personal-token-0123456789abcdef';
// A = the owner (user 1, the old AUTH_TOKEN, chat 42). B = a paying user with a personal token and chat 77.
function twoUsers() {
  const env = makeEnv();
  const raw = env.DB.raw;
  raw.exec("insert into settings(key,value) values ('telegram_chat_id','42')");
  raw.prepare("insert into users (id, telegram_id, name, role, status, token) values (2, 77, 'B', 'user', 'active', ?)").run('h:' + createHash('sha256').update(B_TOKEN).digest('hex'));
  raw.exec(`
    insert into finances(amount,currency,category,title,raw_text,user_id) values (111000,'VND','food','A-SECRET-кофе','A-SECRET',1), (222,'VND','car','B-такси','B-такси',2);
    insert into tasks(title,due_datetime,user_id) values ('A-SECRET-task','2030-01-01 00:00:00',1), ('B-task','2030-01-01 00:00:00',2);
    insert into notes(title,content,user_id) values ('A-SECRET-note','A-SECRET-content',1), ('B-note','b content',2);
    insert into vocabulary(word,translation,user_id) values ('asecret','A-SECRET-перевод',1), ('bword','b-перевод',2);
    insert into recurring(title,amount,day_of_month,user_id) values ('A-SECRET-rent',500,5,1), ('B-rent',50,5,2);
    insert into word_groups(group_no,perfect,user_id) values (1,3,1);
    insert into settings(key,value,user_id) values ('daily_limit_vnd','777777',1);
  `);
  return env;
}
const asB = (env, method, p, body) => call(env, method, p, body, { 'x-token': B_TOKEN });
const one = (env, sql, ...p) => env.DB.raw.prepare(sql).get(...p);
const allOf = (env, sql, ...p) => env.DB.raw.prepare(sql).all(...p).map(r => ({ ...r }));

test('isolation: every read route shows B only B\'s data, nothing of A', async () => {
  const env = twoUsers();
  for (const p of ['/api/finances?period=month', '/api/finances?period=month&date=2030-01-01', '/api/tasks?filter=all', '/api/notes', '/api/notes?q=secret',
    '/api/vocabulary', '/api/recurring', '/api/debts', '/api/debts?dir=owe', '/api/review', '/api/top-words', '/api/settings']) {
    const res = await asB(env, 'GET', p);
    assert.equal(res.status, 200, p);
    assert.doesNotMatch(await res.text(), /A-SECRET|asecret|777777|111000/, p);
  }
  // and B really sees own rows
  const mine = await json(await asB(env, 'GET', '/api/finances?period=month'));
  assert.deepEqual(mine.transactions.map(t => t.title), ['B-такси']);
  assert.deepEqual((await json(await asB(env, 'GET', '/api/top-words'))).groups, {});
  // A still sees A's
  const a = await json(await call(env, 'GET', '/api/finances?period=month'));
  assert.deepEqual(a.transactions.map(t => t.title), ['A-SECRET-кофе']);
});

test('isolation: B cannot change or delete A\'s records through any /api route', async () => {
  const env = twoUsers();
  const snapshot = () => JSON.stringify(['finances', 'tasks', 'notes', 'vocabulary', 'recurring', 'word_groups', 'settings']
    .map(t => allOf(env, `select * from ${t} where user_id = 1`)));
  const before = snapshot();
  const aid = (t) => one(env, `select id from ${t} where user_id = 1 order by id limit 1`).id;
  const f = aid('finances'), t = aid('tasks'), n = aid('notes'), v = aid('vocabulary'), r = aid('recurring');
  await asB(env, 'PUT', `/api/finances/${f}`, { amount: 1, title: 'hacked' });
  await asB(env, 'DELETE', `/api/finances/${f}`);
  await asB(env, 'PUT', `/api/tasks/${t}`, { title: 'hacked', priority: 'low' });
  await asB(env, 'PATCH', `/api/tasks/${t}/toggle`);
  await asB(env, 'DELETE', `/api/tasks/${t}`);
  await asB(env, 'PUT', `/api/notes/${n}`, { title: 'hacked', content: 'hacked' });
  await asB(env, 'DELETE', `/api/notes/${n}`);
  await asB(env, 'PUT', `/api/vocabulary/${v}`, { word: 'hacked', translation: 'hacked' });
  await asB(env, 'DELETE', `/api/vocabulary/${v}`);
  await asB(env, 'PUT', `/api/recurring/${r}`, { title: 'hacked', amount: 1, day_of_month: 9, add_expense: true });
  await asB(env, 'DELETE', `/api/recurring/${r}`);
  env.DB.raw.exec("update finances set is_debt = 1 where user_id = 1");
  const debtsBefore = JSON.stringify(allOf(env, 'select * from finances where user_id = 1'));
  const pay = await asB(env, 'POST', `/api/debts/${f}/pay`, { all: true });
  assert.equal(pay.status, 404);
  assert.equal(JSON.stringify(allOf(env, 'select * from finances where user_id = 1')), debtsBefore);
  for (const [table, id] of [['finances', f], ['tasks', t], ['notes', n]]) {
    await asB(env, 'POST', '/api/review/confirm', { table, id, updates: { title: 'hacked' } });
    await asB(env, 'POST', '/api/review/reject', { table, id });
  }
  // merge: both ids are A's, or one is A's and one is B's
  const bNote = one(env, 'select id from notes where user_id = 2').id;
  await asB(env, 'POST', '/api/review/merge', { table: 'notes', id: bNote, target_id: n });
  await asB(env, 'POST', '/api/review/merge', { table: 'notes', id: n, target_id: bNote });
  env.DB.raw.exec("update finances set is_debt = 0 where user_id = 1");
  assert.equal(snapshot(), before);
  assert.equal(one(env, 'select count(*) c from notes where user_id = 2').c, 1);   // B's own note was not merged away either
});

test('isolation: a user id sent by the client (body, query, header) is ignored', async () => {
  const env = twoUsers();
  await call(env, 'POST', '/api/notes?user_id=2', { title: 'x', content: 'from A', user_id: 2 }, { 'x-user-id': '2' });
  await asB(env, 'POST', '/api/notes?user_id=1', { title: 'y', content: 'from B', user_id: 1 }, { 'x-user-id': '1' });
  await asB(env, 'POST', '/api/tasks', { title: 'B-new-task', user_id: 1 });
  await asB(env, 'POST', '/api/finances', { amount: 5, user_id: 1 });
  assert.equal(one(env, "select user_id u from notes where content = 'from A'").u, 1);
  assert.equal(one(env, "select user_id u from notes where content = 'from B'").u, 2);
  assert.equal(one(env, "select user_id u from tasks where title = 'B-new-task'").u, 2);
  assert.equal(one(env, 'select user_id u from finances where amount = 5').u, 2);
  const seenByB = await asB(env, 'GET', '/api/notes?user_id=1');
  assert.doesNotMatch(await seenByB.text(), /A-SECRET/);
  // an unknown or too short token is nobody
  assert.equal((await call(env, 'GET', '/api/notes', undefined, { 'x-token': 'short' })).status, 401);
  assert.equal((await call(env, 'GET', '/api/notes', undefined, { 'x-token': B_TOKEN + 'x' })).status, 401);
});

test('isolation: settings are per user, and B cannot run owner-only routes', async () => {
  const env = twoUsers();
  await asB(env, 'PUT', '/api/settings', { limit_enabled: true, limit_amount: 5000, currency: 'VND', vocab_reminders: 'off' });
  assert.equal(one(env, "select value v from settings where key = 'daily_limit_vnd' and user_id = 1").v, '777777');
  assert.equal(one(env, "select value v from settings where key = 'daily_limit_vnd' and user_id = 2").v, '5000');
  assert.equal((await asB(env, 'GET', '/api/cron-trigger?force=true')).status, 403);
  assert.equal((await asB(env, 'POST', '/api/sync-user', { chat_id: 77 })).status, 403);
  assert.equal(one(env, "select value v from settings where key = 'telegram_chat_id'").v, '42');
});

test('isolation: bot buttons of B cannot touch A\'s records or settings', async () => {
  const env = twoUsers();
  const before = JSON.stringify(['finances', 'tasks', 'notes', 'vocabulary'].map(t => allOf(env, `select * from ${t} where user_id = 1`)));
  const aTask = one(env, 'select id from tasks where user_id = 1').id;
  const press = async (data) => {
    const pending = [];
    await worker.fetch(new Request('https://t.local/api/telegram-webhook', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: nextUpdateId++, callback_query: { id: 'c', data, from: { id: 77 }, message: { chat: { id: 77 }, message_id: 9, text: 'x' } } })
    }), env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  };
  const ids = (t) => one(env, `select id from ${t} where user_id = 1`).id;
  await press(`done_${aTask}`);
  await press(`snooze_${aTask}`);
  await press(`del_finances_${ids('finances')}`);
  await press(`del_tasks_${aTask}`);
  await press(`del_notes_${ids('notes')}`);
  await press(`del_vocabulary_${ids('vocabulary')}`);
  await press('vocab_mode_off');
  assert.equal(JSON.stringify(['finances', 'tasks', 'notes', 'vocabulary'].map(t => allOf(env, `select * from ${t} where user_id = 1`))), before);
  assert.equal(one(env, "select count(*) c from settings where key = 'vocab_reminders' and user_id = 1").c, 0);
  assert.equal(one(env, "select value v from settings where key = 'vocab_reminders' and user_id = 2").v, 'off');
  // B's own record is deletable by B's button
  const bFin = one(env, 'select id from finances where user_id = 2').id;
  await press(`del_finances_${bFin}`);
  assert.equal(one(env, 'select count(*) c from finances where user_id = 2').c, 0);
});

test('isolation: B\'s voice correction or deletion never reaches A\'s record, even with the right id and words', async () => {
  const env = twoUsers();
  const aFin = one(env, 'select id from finances where user_id = 1').id;
  const aTask = one(env, 'select id from tasks where user_id = 1').id;
  const before = JSON.stringify([allOf(env, 'select * from finances where user_id = 1'), allOf(env, 'select * from tasks where user_id = 1')]);
  aiReply = { actions: [{ type: 'delete', target_table: 'finances', target_id: aFin }] };
  const del = await asB(env, 'POST', '/api/voice-hook', { text: 'удали A-SECRET кофе 111000' });
  assert.equal((await json(del)).screen_notification.includes('не найдена'), true);
  aiReply = { actions: [{ type: 'update', target_table: 'finances', target_id: aFin, data: { amount: 1, title: 'A-SECRET-кофе' } }] };
  await asB(env, 'POST', '/api/voice-hook', { text: 'не 111000 а 1 кофе' });
  aiReply = { actions: [{ type: 'update', target_table: 'tasks', target_id: aTask, data: { title: 'hacked' } }] };
  await asB(env, 'POST', '/api/voice-hook', { text: 'измени задачу A-SECRET-task' });
  aiReply = { actions: [{ type: 'delete', target_table: 'tasks', target_id: aTask }] };
  await asB(env, 'POST', '/api/voice-hook', { text: 'удали задачу A-SECRET-task' });
  assert.equal(JSON.stringify([allOf(env, 'select * from finances where user_id = 1'), allOf(env, 'select * from tasks where user_id = 1')]), before);
});

test('isolation: what B dictates is saved for B, and the LLM context never contains A\'s records', async () => {
  const env = twoUsers();
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (/generativelanguage|gateway\.ai/.test(String(url))) sent.push(String(opts?.body || '')); return realFetch(url, opts); };
  try {
    aiReply = { actions: [fin(30000, { title: 'Вода' })] };
    await asB(env, 'POST', '/api/voice-hook', { text: 'вода 30к' });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(one(env, "select user_id u from finances where amount = 30000").u, 2);
  assert.equal(one(env, "select count(*) c from finances where user_id = 1").c, 1);
  assert.ok(sent.length > 0);
  assert.doesNotMatch(sent.join('\n'), /A-SECRET/);
  assert.equal(one(env, "select count(*) c from request_logs where user_id = 2").c >= 3, true);
  assert.equal(one(env, "select count(*) c from request_logs where user_id = 1").c, 0);
  // privacy: a client's phrase text never lands in the logs
  const previews = allOf(env, 'select body_preview p from request_logs where user_id = 2').map(r => r.p).join('\n');
  assert.doesNotMatch(previews, /вода/);
});

test('access: a new Telegram user can look around but not record until they have a trial or subscription', async () => {
  const env = twoUsers();
  const talk = async (chatId, text) => {
    const pending = [];
    tgSent.length = 0;
    await worker.fetch(new Request('https://t.local/api/telegram-webhook', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: nextUpdateId++, message: { chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: 'Нов' }, text } })
    }), env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return tgSent.map(m => m?.text).join('\n');
  };
  aiReply = { actions: [fin(1000)] };
  const start = await talk(900, '/start');
  assert.match(start, /подписка/);
  const row = one(env, 'select * from users where telegram_id = 900');
  assert.equal(row.role, 'user');
  assert.equal(row.status, 'new');
  assert.match(await talk(900, 'кофе 1000'), /пока закрыт/);
  assert.equal(one(env, 'select count(*) c from finances where user_id = ?', row.id).c, 0);
  // the same person via the voice hook with a personal token
  env.DB.raw.prepare('update users set token = ? where id = ?').run('h:' + createHash('sha256').update('new-user-token-0123456789abcdef').digest('hex'), row.id);
  const denied = await call(env, 'POST', '/api/voice-hook', { text: 'кофе 1000' }, { 'x-token': 'new-user-token-0123456789abcdef' });
  assert.equal(denied.status, 403);
  // subscription on, then it works; an expired subscription closes it again
  env.DB.raw.prepare("update users set status = 'active', sub_until = datetime('now', '+5 days') where id = ?").run(row.id);
  assert.equal((await call(env, 'POST', '/api/voice-hook', { text: 'кофе 1000' }, { 'x-token': 'new-user-token-0123456789abcdef' })).status, 200);
  assert.equal(one(env, 'select count(*) c from finances where user_id = ?', row.id).c, 1);
  env.DB.raw.prepare("update users set sub_until = datetime('now', '-1 days') where id = ?").run(row.id);
  assert.equal((await call(env, 'POST', '/api/voice-hook', { text: 'кофе 2000' }, { 'x-token': 'new-user-token-0123456789abcdef' })).status, 403);
  // group chats are ignored
  const groupBefore = one(env, 'select count(*) c from users').c;
  await worker.fetch(new Request('https://t.local/api/telegram-webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update_id: nextUpdateId++, message: { chat: { id: -100123, type: 'group' }, from: { id: 5 }, text: '/start' } })
  }), env, { waitUntil() {} });
  assert.equal(one(env, 'select count(*) c from users').c, groupBefore);
});

test('guard: every SQL statement on user data in worker.js mentions user_id', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/worker.js'), 'utf8');
  const tables = /\b(finances|tasks|notes|vocabulary|word_groups|recurring|request_logs|settings)\b/i;
  const bad = [];
  for (const m of src.matchAll(/\.prepare\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    const sql = m[2];
    if (tables.test(sql) && !/\buser_id\b/i.test(sql)) bad.push(sql.replace(/\s+/g, ' ').slice(0, 100));
  }
  // The only system-wide statement: the hourly cleanup of old request logs, which runs with the unrestricted env
  assert.deepEqual(bad.filter(s => !s.startsWith("DELETE FROM request_logs WHERE created_at < datetime('now', '-7 days')")), []);
});

// ---------- stage 3: the cron serves every person in their own chat, time zone and currency ----------
function cronPeople() {
  const env = twoUsers();          // A = owner (chat 42, Nha Trang, VND), B = user 2 (chat 77, active)
  env.DB.raw.exec("update users set timezone = 'Europe/Moscow', currency = 'RUB' where id = 2");
  env.DB.raw.exec("delete from tasks; delete from finances; delete from vocabulary; delete from recurring; delete from notes");
  return env;
}
const atUtc = (iso) => mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
const tickCron = async (env) => { tgSent.length = 0; await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) }); await Promise.all(pending.splice(0)); return tgSent.filter(Boolean); };
const pending = [];
const to = (sent, chat) => sent.filter(m => String(m.chat_id) === String(chat));

test('cron: two people due at the same minute each get only their own reminder, in their own chat', async () => {
  const env = cronPeople();
  atUtc('2026-11-02T05:03:00Z');
  try {
    env.DB.raw.exec(`insert into tasks(title,due_datetime,user_id) values ('задача-А','2026-11-02 05:00:00',1), ('задача-Б','2026-11-02 05:00:00',2)`);
    const sent = await tickCron(env);
    assert.match(to(sent, 42).map(m => m.text).join('\n'), /задача-А/);
    assert.doesNotMatch(to(sent, 42).map(m => m.text).join('\n'), /задача-Б/);
    assert.match(to(sent, 77).map(m => m.text).join('\n'), /задача-Б/);
    assert.doesNotMatch(to(sent, 77).map(m => m.text).join('\n'), /задача-А/);
    assert.equal(one(env, 'select reminded r from tasks where user_id = 1').r, 1);
    assert.equal(one(env, 'select reminded r from tasks where user_id = 2').r, 1);
    // the next minute: nothing is sent twice
    mock.timers.reset(); atUtc('2026-11-02T05:04:00Z');
    assert.equal((await tickCron(env)).length, 0);
  } finally { mock.timers.reset(); }
});

test('cron: morning summary comes at 8:00 of each person\'s own morning', async () => {
  const env = cronPeople();
  env.DB.raw.exec(`insert into tasks(title,due_datetime,is_date_only,user_id) values ('дело-А','2026-11-02 00:00:00',1,1), ('дело-Б','2026-11-02 00:00:00',1,2)`);
  env.DB.raw.exec('update tasks set reminded = 3');   // SQLite keeps the real clock: only the summary is under test here
  try {
    atUtc('2026-11-02T01:00:00Z');                       // 08:00 Nha Trang, 04:00 Moscow
    let sent = await tickCron(env);
    assert.match(to(sent, 42).map(m => m.text).join(), /дело-А/);
    assert.equal(to(sent, 77).length, 0);
    mock.timers.reset(); atUtc('2026-11-02T05:00:00Z');  // 12:00 Nha Trang (window over), 08:00 Moscow
    sent = await tickCron(env);
    assert.equal(to(sent, 42).filter(m => !/Неделя в TRACE/.test(m.text)).length, 0);   // (Monday 12:00: the weekly report may come)
    assert.match(to(sent, 77).map(m => m.text).join(), /дело-Б/);
    assert.doesNotMatch(to(sent, 77).map(m => m.text).join(), /дело-А/);
  } finally { mock.timers.reset(); }
});

test('cron: the evening digest is in the person\'s currency and day, with a limit of their own', async () => {
  const env = cronPeople();
  env.DB.raw.exec(`insert into finances(amount,currency,category,title,created_at,user_id) values (700,'RUB','food','Кофе','2026-11-02 10:00:00',2), (50000,'VND','food','Фо','2026-11-02 03:00:00',1)`);
  try {
    atUtc('2026-11-02T21:00:00Z');                       // 00:00 Moscow (Nov 3): B's day Nov 2 is over; 04:00 in Nha Trang: nothing yet
    const sent = await tickCron(env);
    const b = to(sent, 77).map(m => m.text).join('\n');
    assert.match(b, /700 ₽/);
    assert.match(b, /из 2 000 ₽/);                       // the default limit of a rouble user, not 200 000 dong
    assert.doesNotMatch(b, /₫/);
    assert.equal(to(sent, 42).length, 0);
  } finally { mock.timers.reset(); }
});

test('cron: on Sunday morning nobody gets a database file (the weekly copy was removed)', async () => {
  const env = cronPeople();
  env.DB.raw.exec(`insert into notes(title,content,user_id) values ('заметка-А','a',1), ('заметка-Б','b',2)`);
  try {
    atUtc('2026-11-08T01:00:00Z');                       // Sunday 08:00 Nha Trang, 04:00 Moscow
    const sent = await tickCron(env);
    assert.equal(sent.filter(m => m.document).length, 0);
  } finally { mock.timers.reset(); }
});
test('cron: a person without access (expired or never paid) gets no pushes, and the owner is always served', async () => {
  const env = cronPeople();
  env.DB.raw.exec(`insert into tasks(title,due_datetime,user_id) values ('задача-А','2026-11-02 05:00:00',1), ('задача-Б','2026-11-02 05:00:00',2)`);
  env.DB.raw.exec("update users set sub_until = datetime('now', '-1 days') where id = 2");
  try {
    atUtc('2026-11-02T05:03:00Z');
    env.DB.raw.exec("update users set sub_until = '2026-11-01 00:00:00' where id = 2");
    const sent = await tickCron(env);
    assert.equal(to(sent, 77).length, 0);
    assert.match(to(sent, 42).map(m => m.text).join(), /задача-А/);
  } finally { mock.timers.reset(); }
});

test('settings: a person picks their own currency and time zone; bad values are refused', async () => {
  const env = twoUsers();
  const bad1 = await asB(env, 'PUT', '/api/settings', { default_currency: 'XXX' });
  const bad2 = await asB(env, 'PUT', '/api/settings', { timezone: 'Mars/Base' });
  assert.equal(bad1.status, 400);
  assert.equal(bad2.status, 400);
  const ok = await json(await asB(env, 'PUT', '/api/settings', { default_currency: 'kzt', timezone: 'Asia/Almaty' }));
  assert.equal(ok.default_currency, 'KZT');
  assert.equal(ok.timezone, 'Asia/Almaty');
  assert.equal(one(env, 'select currency c, timezone t from users where id = 2').c, 'KZT');
  const a = await json(await call(env, 'GET', '/api/settings'));          // the owner is untouched
  assert.equal(a.default_currency, 'VND');
  assert.equal(a.timezone, 'Asia/Ho_Chi_Minh');
});

test('currency: what B dictates is saved in B\'s own currency, small amounts included; the owner stays on dong', async () => {
  const env = twoUsers();
  env.DB.raw.exec("update users set currency = 'RUB' where id = 2");
  aiReply = { actions: [{ type: 'note', data: { title: 'x', content: 'x' } }] };
  await asB(env, 'POST', '/api/voice-hook', { text: 'кофе 300' });
  await asB(env, 'POST', '/api/voice-hook', { text: 'такси 1500 тенге' });
  await call(env, 'POST', '/api/voice-hook', { text: 'кофе 45000' });
  assert.deepEqual(allOf(env, "select amount, currency from finances where user_id = 2 and title in ('Кофе','Такси') order by id").map(r => `${r.amount} ${r.currency}`), ['300 RUB', '1500 KZT']);
  assert.equal(one(env, "select currency c from finances where user_id = 1 and amount = 45000").c, 'VND');
});

test('cron: a date-only task pings at 07:00 of the person\'s own morning, not at the same UTC moment for everybody', async () => {
  const env = cronPeople();
  const hourAgo = new Date(Date.now() - 3600000).toISOString().slice(0, 19).replace('T', ' ');
  env.DB.raw.prepare("insert into tasks(title,due_datetime,is_date_only,user_id) values ('дата-А', ?, 1, 1), ('дата-Б', ?, 1, 2)").run(hourAgo, hourAgo);
  const sent = await tickCron(env);
  assert.match(to(sent, 42).map(m => m.text).join(), /дата-А/);            // Nha Trang: the stored moment is already past
  assert.equal(to(sent, 77).length, 0);                                    // Moscow: 07:00 local is 4 hours after the stored moment
});

// ---------- stage 4: payments with Telegram Stars ----------
const tgCalls = [];
/** Records every Telegram method called (with its body); `replies` overrides the answer of a method. Returns the restore function. */
function spyTelegram(replies = {}) {
  const real = globalThis.fetch;
  tgCalls.length = 0;
  globalThis.fetch = async (url, opts) => {
    const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(String(url));
    if (m) {
      tgCalls.push({ method: m[1], body: opts?.body && !(opts.body instanceof FormData) ? JSON.parse(opts.body) : null });
      if (replies[m[1]]) return new Response(JSON.stringify(replies[m[1]]), { status: 200 });
    }
    return real(url, opts);
  };
  return () => { globalThis.fetch = real; };
}
const callsOf = (method) => tgCalls.filter(c => c.method === method).map(c => c.body);
const SECRET = { 'x-telegram-bot-api-secret-token': 's' };
async function hook(env, update, headers = SECRET) {
  const pending = [];
  const res = await worker.fetch(new Request('https://t.local/api/telegram-webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ update_id: nextUpdateId++, ...update })
  }), env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  return res;
}
// B = user 2, Telegram 77, no subscription yet
function buyer() {
  const env = twoUsers();
  env.TELEGRAM_WEBHOOK_SECRET = 's';
  env.DB.raw.exec("update users set status = 'new', sub_until = null where id = 2");
  return env;
}
const said = (chat, text) => ({ message: { chat: { id: chat, type: 'private' }, from: { id: chat, first_name: 'B' }, text } });
const paid = (uid, extra = {}) => ({ message: { chat: { id: 77, type: 'private' }, from: { id: 77 },
  successful_payment: { currency: 'XTR', total_amount: 200, invoice_payload: `sub:${uid}:30`, telegram_payment_charge_id: 'ch-1', provider_payment_charge_id: '', ...extra } } });
const preCheckout = (uid, extra = {}) => ({ pre_checkout_query: { id: 'q1', from: { id: 77, first_name: 'B' }, currency: 'XTR', total_amount: 200, invoice_payload: `sub:${uid}:30`, ...extra } });
const untilOf = (env, id = 2) => Date.parse(one(env, 'select sub_until s from users where id = ?', id).s.replace(' ', 'T') + 'Z');
const DAY = 86400000;

test('payment: /subscribe sends a 200-Star invoice for this very person; the price comes from the owner\'s setting', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    await hook(env, said(77, '/subscribe'));
    const inv = callsOf('sendInvoice')[0];
    assert.equal(inv.chat_id, 77);
    assert.equal(inv.currency, 'XTR');
    assert.deepEqual(inv.prices, [{ label: '30 дней', amount: 200 }]);
    assert.equal(inv.payload, 'sub:2:30');
    assert.equal(inv.provider_token, undefined);
    // a live test with 1 Star: the owner changes the setting, no deploy needed
    env.DB.raw.exec("insert into settings(key,value,user_id) values ('price_stars','1',1)");
    await hook(env, said(77, '/subscribe'));
    assert.equal(callsOf('sendInvoice')[1].prices[0].amount, 1);
    // the button under /status and reminders does the same
    tgCalls.length = 0;
    await hook(env, { callback_query: { id: 'c', data: 'sub_buy', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 5, text: 'x' } } });
    assert.equal(callsOf('sendInvoice').length, 1);
  } finally { restore(); }
});

test('payment: pre-checkout accepts the right invoice and refuses a wrong payer, price, currency or payload', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    const answerTo = async (update) => { tgCalls.length = 0; await hook(env, update); return callsOf('answerPreCheckoutQuery')[0]; };
    assert.deepEqual(await answerTo(preCheckout(2)), { pre_checkout_query_id: 'q1', ok: true });
    for (const bad of [preCheckout(1), preCheckout(2, { total_amount: 100 }), preCheckout(2, { currency: 'USD' }), preCheckout(2, { invoice_payload: 'hello' }), preCheckout(2, { invoice_payload: 'sub:2:9999' })]) {
      const a = await answerTo(bad);
      assert.equal(a.ok, false);
      assert.ok(a.error_message.length > 5);
    }
  } finally { restore(); }
});

test('payment: a paid invoice switches the subscription on for 30 days; the same payment twice counts once', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    const t0 = Date.now();
    await hook(env, paid(2));
    const u = one(env, 'select status, sub_until from users where id = 2');
    assert.equal(u.status, 'active');
    assert.ok(Math.abs(untilOf(env) - (t0 + 30 * DAY)) < 60000);
    assert.deepEqual(allOf(env, 'select user_id, amount, currency, charge_id, status, applied, period_days from payments'),
      [{ user_id: 2, amount: 200, currency: 'XTR', charge_id: 'ch-1', status: 'paid', applied: 1, period_days: 30 }]);
    assert.match(callsOf('sendMessage').map(m => m.text).join('\n'), /Оплата получена[\s\S]*Подписка действует до/);
    // Telegram repeats the update: nothing is added
    const before = untilOf(env);
    tgCalls.length = 0;
    await hook(env, paid(2));
    assert.equal(untilOf(env), before);
    assert.equal(one(env, 'select count(*) c from payments').c, 1);
    assert.equal(callsOf('sendMessage').length, 0);
    // and the person can record now
    assert.equal((await call(env, 'POST', '/api/voice-hook', { text: 'кофе 1000' }, { 'x-token': B_TOKEN })).status, 200);
  } finally { restore(); }
});

test('payment: paying while still subscribed adds 30 days to the current end, not to today', async () => {
  const env = buyer();
  env.DB.raw.exec("update users set status = 'active', sub_until = datetime('now', '+10 days') where id = 2");
  const restore = spyTelegram();
  try {
    const before = untilOf(env);
    await hook(env, paid(2, { telegram_payment_charge_id: 'ch-2' }));
    assert.equal(untilOf(env) - before, 30 * DAY);
    // an ended subscription starts again from today
    env.DB.raw.exec("update users set status = 'expired', sub_until = datetime('now', '-20 days') where id = 2");
    const t0 = Date.now();
    await hook(env, paid(2, { telegram_payment_charge_id: 'ch-3' }));
    assert.ok(Math.abs(untilOf(env) - (t0 + 30 * DAY)) < 60000);
    assert.equal(one(env, 'select status from users where id = 2').status, 'active');
  } finally { restore(); }
});

test('payment: a payment of one person never extends another person\'s subscription', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    const ownerBefore = JSON.stringify(allOf(env, 'select * from users where id = 1'));
    await hook(env, paid(1));     // B pays an invoice made out for the owner: B is still the one who paid
    assert.equal(JSON.stringify(allOf(env, 'select * from users where id = 1')), ownerBefore);
    assert.equal(one(env, 'select user_id u from payments').u, 2);
  } finally { restore(); }
});

test('payment: a forged "successful_payment" gives nothing unless Telegram confirms it', async () => {
  const env = buyer();
  delete env.TELEGRAM_WEBHOOK_SECRET;          // no secret: the bot has to ask Telegram itself
  let restore = spyTelegram({ getStarTransactions: { ok: true, result: { transactions: [] } } });
  try {
    await hook(env, paid(2, { telegram_payment_charge_id: 'fake' }), {});
    assert.equal(one(env, 'select status from users where id = 2').status, 'new');
    assert.deepEqual(allOf(env, 'select status, applied from payments'), [{ status: 'unverified', applied: 0 }]);
    assert.ok(callsOf('sendMessage').some(m => String(m.chat_id) === '42' && /не подтвердился/.test(m.text)));   // the owner is told
  } finally { restore(); }
  // the same charge, now confirmed by Telegram: finished by the repeat
  restore = spyTelegram({ getStarTransactions: { ok: true, result: { transactions: [{ id: 'fake', amount: 200 }] } } });
  try {
    await hook(env, paid(2, { telegram_payment_charge_id: 'fake' }), {});
    assert.equal(one(env, 'select status from users where id = 2').status, 'active');
    assert.deepEqual(allOf(env, 'select status, applied from payments'), [{ status: 'paid', applied: 1 }]);
    // a real transaction of another size is not a match
    await hook(env, paid(2, { telegram_payment_charge_id: 'other', total_amount: 999 }), {});
    assert.equal(one(env, "select status from payments where charge_id = 'other'").status, 'unverified');
  } finally { restore(); }
});

test('payment: owner refunds a payment; the days go away, a second refund and a stranger are refused', async () => {
  const env = buyer();
  let restore = spyTelegram({ refundStarPayment: { ok: true, result: true } });
  try {
    await hook(env, paid(2));
    const id = one(env, 'select id from payments').id;
    // a stranger cannot refund
    tgCalls.length = 0;
    await hook(env, said(77, `/refund ${id}`));
    assert.equal(callsOf('refundStarPayment').length, 0);
    assert.equal(one(env, 'select status from payments').status, 'paid');
    // the owner can
    tgCalls.length = 0;
    await hook(env, said(42, `/refund ${id}`));
    assert.deepEqual(callsOf('refundStarPayment'), [{ user_id: 77, telegram_payment_charge_id: 'ch-1' }]);
    assert.equal(one(env, 'select status from payments').status, 'refunded');
    assert.equal(one(env, 'select status from users where id = 2').status, 'expired');
    assert.ok(untilOf(env) <= Date.now());
    assert.ok(callsOf('sendMessage').some(m => m.chat_id === 77 && /Платёж возвращён/.test(m.text)));
    // twice: Telegram is not asked again
    tgCalls.length = 0;
    await hook(env, said(42, `/refund ${id}`));
    assert.equal(callsOf('refundStarPayment').length, 0);
    assert.match(callsOf('sendMessage')[0].text, /уже возвращён/);
    assert.equal((await call(env, 'POST', '/api/voice-hook', { text: 'кофе 1000' }, { 'x-token': B_TOKEN })).status, 403);
  } finally { restore(); }
  // Telegram refuses: the payment stays as it was
  const env2 = buyer();
  restore = spyTelegram({ refundStarPayment: { ok: false, description: 'CHARGE_ALREADY_REFUNDED' } });
  try {
    await hook(env2, paid(2));
    await hook(env2, said(42, '/refund 1'));
    assert.equal(one(env2, 'select status from payments').status, 'paid');
    assert.equal(one(env2, 'select status from users where id = 2').status, 'active');
  } finally { restore(); }
});

test('payment: refunding one of two payments takes back only its 30 days', async () => {
  const env = buyer();
  const restore = spyTelegram({ refundStarPayment: { ok: true, result: true } });
  try {
    await hook(env, paid(2, { telegram_payment_charge_id: 'a' }));
    await hook(env, paid(2, { telegram_payment_charge_id: 'b' }));
    const both = untilOf(env);
    await hook(env, said(42, '/refund 1'));
    assert.equal(both - untilOf(env), 30 * DAY);
    assert.equal(one(env, 'select status from users where id = 2').status, 'active');
  } finally { restore(); }
});

test('payment: /status, /help and /paysupport answer in plain words, with the support contact when it is set', async () => {
  const env = buyer();
  env.SUPPORT_CONTACT = '@trace_help';
  const restore = spyTelegram();
  try {
    // (the owner's every message also fires pending reminders first, so the answer is the last message)
    const ask = async (chat, text) => { tgCalls.length = 0; await hook(env, said(chat, text)); return callsOf('sendMessage').at(-1); };
    let m = await ask(77, '/status');
    assert.match(m.text, /Подписки нет/);
    assert.deepEqual(m.reply_markup.inline_keyboard.flat().map(b => b.callback_data), ['trial_start', 'sub_buy']);   // a new person: the trial first, or pay at once
    await hook(env, paid(2));
    m = await ask(77, '/status');
    assert.match(m.text, /Подписка[\s\S]*Действует до <b>\d\d\.\d\d\.\d{4}<\/b> \(осталось 30 дней\)/);
    env.DB.raw.exec("update users set status = 'expired', sub_until = datetime('now', '-1 days') where id = 2");
    m = await ask(77, '/status');
    assert.match(m.text, /Подписка закончилась[\s\S]*Продлить\?/);
    assert.match((await ask(42, '/status')).text, /владелец/i);
    assert.match((await ask(77, '/help')).text, /\/subscribe[\s\S]*@trace_help/);
    assert.match((await ask(77, '/paysupport')).text, /Stars[\s\S]*@trace_help/);
    assert.match((await ask(77, '/status@my_trace_voice_bot')).text, /Подписка закончилась/);
    for (const t of ['/status', '/help', '/paysupport']) assert.doesNotMatch((await ask(77, t)).text, /\p{Extended_Pictographic}/u);
    // commands never turn into notes or expenses
    assert.equal(one(env, 'select count(*) c from notes where user_id = 2').c, 1);
  } finally { restore(); }
});

test('token: /token issues a personal token once, stored as a hash; /token new replaces it; the hash itself is not a key', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    const ask = async (text) => { tgCalls.length = 0; await hook(env, said(77, text)); return callsOf('sendMessage').at(-1); };
    // without a token the guide says how to get one; B has a legacy plain token, so start from a person without one
    env.DB.raw.exec("update users set token = null where id = 2");
    assert.match((await ask('/shortcut')).text, /Токена ещё нет/);
    const m = await ask('/token');
    const tok = /<code>([A-Za-z0-9_-]{43})<\/code>/.exec(m.text)?.[1];
    assert.ok(tok, 'the token is in the message');
    assert.match(m.text, /X-Token/);
    assert.match(m.text, /\/api\/voice-hook/);
    const stored = one(env, 'select token t from users where id = 2').t;
    assert.ok(stored.startsWith('h:') && !stored.includes(tok), 'only a hash is kept');
    // it opens the door as this person (and only this person)
    assert.equal((await call(env, 'GET', '/api/notes', undefined, { 'x-token': tok })).status, 200);
    assert.equal((await json(await call(env, 'GET', '/api/notes', undefined, { 'x-token': tok }))).notes.some(n => /A-SECRET/.test(n.title)), false);
    // the stored hash cannot be used as a token
    assert.equal((await call(env, 'GET', '/api/notes', undefined, { 'x-token': stored })).status, 401);
    // asking again does not show it again
    const again = await ask('/token');
    assert.doesNotMatch(again.text, /<code>/);
    assert.match(again.text, /\/token new/);
    // a new one replaces the old
    const fresh = /<code>([A-Za-z0-9_-]{43})<\/code>/.exec((await ask('/token new')).text)?.[1];
    assert.ok(fresh && fresh !== tok);
    assert.equal((await call(env, 'GET', '/api/notes', undefined, { 'x-token': tok })).status, 401);
    assert.equal((await call(env, 'GET', '/api/notes', undefined, { 'x-token': fresh })).status, 200);
    // the voice hook takes it too
    env.DB.raw.exec("update users set status = 'active', sub_until = datetime('now', '+10 days') where id = 2");
    aiReply = { actions: [fin(1000)] };
    assert.equal((await call(env, 'POST', '/api/voice-hook', { text: 'кофе 1000' }, { 'x-token': fresh })).status, 200);
    assert.equal(one(env, 'select count(*) c from finances where user_id = 2 and amount = 1000').c, 1);
  } finally { restore(); }
});

test('admin: /users, /grant, /revoke, /usage are for the owner only and show no one\'s records', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    const ask = async (chat, text) => { tgCalls.length = 0; await hook(env, said(chat, text)); return callsOf('sendMessage'); };
    // a stranger gets nothing
    for (const c of ['/users', '/usage', '/grant 2 30', '/revoke 2']) assert.match((await ask(77, c)).at(-1).text, /недоступна/);
    assert.equal(one(env, 'select status s from users where id = 2').s, 'new');
    // the owner sees counters and numbers, not records
    const list = (await ask(42, '/users')).at(-1).text;
    assert.match(list, /Всего: <b>1<\/b>/);
    assert.match(list, /№2 B — без подписки/);
    assert.doesNotMatch(list, /A-SECRET|B-такси|B-task/);
    // grant: days are added, the person is told, a wrong number is refused
    const granted = await ask(42, '/grant 2 10');
    assert.match(granted.at(-1).text, /№2 добавлено 10 дн/);
    assert.equal(one(env, 'select status s from users where id = 2').s, 'active');
    assert.ok(Math.abs(untilOf(env) - (Date.now() + 10 * DAY)) < 60000);
    assert.ok(granted.some(m => String(m.chat_id) === '77' && /Вам включён доступ/.test(m.text)));
    assert.match((await ask(42, '/grant 99 10')).at(-1).text, /нет/);
    assert.match((await ask(42, '/grant 2 9999')).at(-1).text, /Пример/);
    assert.match((await ask(42, '/grant 1 10')).at(-1).text, /нет/);                 // the owner is not a target
    // revoke closes the door at once
    const revoked = await ask(42, '/revoke 2');
    assert.match(revoked.at(-1).text, /закрыт/);
    assert.equal(one(env, 'select status s from users where id = 2').s, 'expired');
    assert.equal((await record(env)).status, 403);
    assert.ok(revoked.some(m => String(m.chat_id) === '77' && /Доступ закрыт/.test(m.text)));
    // the owner's help lists the commands, a person's does not
    assert.match((await ask(42, '/help')).at(-1).text, /\/grant/);
    assert.doesNotMatch((await ask(77, '/help')).at(-1).text, /\/grant/);
    for (const t of ['/users', '/usage']) assert.doesNotMatch((await ask(42, t)).at(-1).text, /\p{Extended_Pictographic}/u);
  } finally { restore(); }
});

test('admin: API use is counted by day (no phrases) and shown in /usage and the Monday report', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    env.DB.raw.exec("update users set status = 'active', sub_until = datetime('now', '+10 days') where id = 2");
    aiReply = { actions: [fin(1000)] };
    await asB(env, 'POST', '/api/voice-hook', { text: 'кофе 1000' });
    await hook(env, said(42, '/usage'));      // flushes the counters first
    const day = new Date().toISOString().slice(0, 10);
    const keys = allOf(env, "select key, value from settings where user_id = 1 and key like 'usage:%'");
    assert.ok(keys.length > 0, 'something was counted');
    assert.ok(keys.every(k => k.key.startsWith(`usage:${day}:`) && /^\d+$/.test(k.value)));
    assert.match(callsOf('sendMessage').at(-1).text, /Расход ИИ[\s\S]*Разбор/);
    assert.doesNotMatch(JSON.stringify(keys), /кофе/);
    // the Monday report: once a week, after 9:00 owner's time
    mock.timers.reset(); atUtc('2026-11-09T03:00:00Z');       // Monday 10:00 in Nha Trang
    try {
      tgCalls.length = 0;
      await tickCron(env);
      assert.equal(callsOf('sendMessage').filter(m => /Неделя в TRACE/.test(m.text)).length, 1);
      tgCalls.length = 0;
      await tickCron(env);
      assert.equal(callsOf('sendMessage').filter(m => /Неделя в TRACE/.test(m.text)).length, 0);
    } finally { mock.timers.reset(); }
  } finally { restore(); }
});

test('token: the Mini App route needs Telegram, a token cannot issue its own replacement', async () => {
  const env = buyer();
  assert.equal((await asB(env, 'POST', '/api/token')).status, 403);
  assert.equal((await asB(env, 'GET', '/api/shortcut')).status, 200);
  const info = await json(await asB(env, 'GET', '/api/shortcut'));
  assert.equal(info.placement.length, 3);
  assert.match(info.placement.join('\n'), /Кнопка действия[\s\S]*Экран «Домой»[\s\S]*задней панели/);
  const restore = spyTelegram();
  try {
    await hook(env, said(77, '/shortcut'));
    assert.match(callsOf('sendMessage').at(-1).text, /Как вынести на кнопку[\s\S]*Кнопка действия/);
  } finally { restore(); }
  assert.equal((await call(env, 'POST', '/api/token', undefined, { 'x-token': 'nope' })).status, 401);
});

test('terms: /terms shows the agreed wording (refund 7 days / 10 records, AI services named) and the API gives the same sections', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    await hook(env, said(77, '/terms'));
    const text = callsOf('sendMessage').at(-1).text;
    assert.match(text, /Условия и данные TRACE/);
    assert.match(text, /не больше 10 записей/);
    assert.match(text, /7 дней после оплаты/);
    assert.match(text, /Groq, Google Gemini и Cloudflare AI/);
    assert.match(text, /\/delete_me/);
    const api = await json(await asB(env, 'GET', '/api/terms'));
    assert.ok(api.sections.length >= 8 && api.sections.some(s => s[0] === 'Возврат денег'));
  } finally { restore(); }
});

test('delete_me: asks first, then erases only this person\'s records; the subscription, the used trial and the payments stay', async () => {
  const env = buyer();
  env.DB.raw.exec("update users set trial_used = 1, daily_count = 4 where id = 2");
  env.DB.raw.exec("insert into payments(user_id, amount, charge_id) values (2, 200, 'ch-del')");
  env.DB.raw.exec("insert into request_logs(endpoint, user_id) values ('/api/voice-hook', 2)");
  env.DB.raw.exec("insert into settings(key,value,user_id) values ('setup_done','1',2)");
  const restore = spyTelegram();
  const countB = () => one(env, "select (select count(*) from finances where user_id=2) + (select count(*) from tasks where user_id=2) + (select count(*) from notes where user_id=2) + (select count(*) from vocabulary where user_id=2) + (select count(*) from recurring where user_id=2) + (select count(*) from request_logs where user_id=2) + (select count(*) from settings where user_id=2 and key='setup_done') c").c;
  try {
    const before = JSON.stringify([allOf(env, 'select * from finances where user_id = 1'), allOf(env, 'select * from tasks where user_id = 1'), allOf(env, 'select * from notes where user_id = 1')]);
    await hook(env, said(77, '/delete_me'));
    const ask = callsOf('sendMessage').at(-1);
    assert.deepEqual(ask.reply_markup.inline_keyboard[0].map(b => b.callback_data), ['delme_yes', 'delme_no']);
    assert.ok(countB() > 0, 'nothing is erased by the question alone');
    // "no" changes nothing
    await hook(env, { callback_query: { id: 'c1', data: 'delme_no', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 5, text: 'x' } } });
    assert.ok(countB() > 0);
    // "yes" erases
    await hook(env, { callback_query: { id: 'c2', data: 'delme_yes', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 5, text: 'x' } } });
    assert.equal(countB(), 0);
    assert.equal(JSON.stringify([allOf(env, 'select * from finances where user_id = 1'), allOf(env, 'select * from tasks where user_id = 1'), allOf(env, 'select * from notes where user_id = 1')]), before);
    const u = one(env, 'select * from users where id = 2');
    assert.equal(u.status, 'new');
    assert.equal(u.trial_used, 1);
    assert.equal(u.daily_count, 4);
    assert.equal(u.token, null);
    assert.equal(one(env, "select count(*) c from payments where user_id = 2").c, 1);
    assert.equal((await asB(env, 'GET', '/api/finances')).status, 401);       // the old token is dead
    assert.match(allOf(env, "select value v from settings where user_id = 1 and key like 'audit:%'").map(r => r.v).join(), /№2/);
  } finally { restore(); }
});

test('delete_me: the owner\'s data cannot be erased, and the API route needs Telegram and a confirmation', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    await hook(env, said(42, '/delete_me'));
    assert.doesNotMatch(JSON.stringify(callsOf('sendMessage').at(-1)), /delme_yes/);
    await hook(env, { callback_query: { id: 'c3', data: 'delme_yes', from: { id: 42 }, message: { chat: { id: 42 }, message_id: 5, text: 'x' } } });
    assert.ok(one(env, 'select count(*) c from finances where user_id = 1').c > 0);
    assert.ok(one(env, 'select count(*) c from tasks where user_id = 1').c > 0);
    // a stolen token cannot wipe an account through the API
    assert.equal((await asB(env, 'POST', '/api/account/delete', { confirm: true })).status, 403);
    assert.equal((await call(env, 'POST', '/api/account/delete', { confirm: true })).status, 403);
    assert.ok(one(env, 'select count(*) c from finances where user_id = 2').c > 0);
  } finally { restore(); }
});

test('limits: a huge text field is refused (413) on every route, the audio of the voice hook is not affected, a full table stops manual creation', async () => {
  const env = buyer();
  env.DB.raw.exec("update users set status = 'active', sub_until = datetime('now', '+10 days') where id = 2");
  const huge = 'я'.repeat(5001);
  assert.equal((await asB(env, 'POST', '/api/notes', { title: 't', content: huge })).status, 413);
  assert.equal((await asB(env, 'POST', '/api/tasks', { title: huge })).status, 413);
  assert.equal((await asB(env, 'PUT', '/api/finances/2', { title: huge })).status, 413);
  assert.equal(one(env, "select count(*) c from notes where user_id = 2 and content like 'яяяя%'").c, 0);
  assert.equal((await asB(env, 'POST', '/api/notes', { title: 't', content: 'я'.repeat(5000) })).status, 200);
  // the voice hook takes audio as a long string: no 413 from the text limit (it fails later, on speech recognition, but not as "too long")
  aiReply = { actions: [fin(1000)] };
  const audio = await asB(env, 'POST', '/api/voice-hook', { audio_base64: 'QUJD'.repeat(5000) });
  assert.notEqual(audio.status, 413);
  // a person's table is full: no more by hand; the owner has no ceiling
  const rows = Array.from({ length: 100 }, (_, i) => `('r${i}', 1, 5, 2)`).join(',');
  env.DB.raw.exec(`insert into recurring(title, amount, day_of_month, user_id) values ${rows}`);
  const full = await asB(env, 'POST', '/api/recurring', { title: 'ещё', amount: 10, day_of_month: 3 });
  assert.equal(full.status, 409);
  assert.match((await json(full)).error, /предел записей/);
  assert.equal((await call(env, 'POST', '/api/recurring', { title: 'ещё', amount: 10, day_of_month: 3 })).status, 200);
});

test('errors: a client gets a neutral text when the server breaks, the owner still sees the reason', async () => {
  const env = buyer();
  env.DB.raw.exec("update users set status = 'active', sub_until = datetime('now', '+10 days') where id = 2");
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (/INSERT INTO finances/.test(sql)) throw new Error('SQLITE_BOOM secret detail'); return realPrepare(sql); };
  const errSpy = console.error; console.error = () => {};
  try {
    const b = await asB(env, 'POST', '/api/finances', { amount: 5 });
    assert.equal(b.status, 500);
    assert.doesNotMatch(JSON.stringify(await json(b)), /BOOM|SQLITE/);
    const a = await call(env, 'POST', '/api/finances', { amount: 5 });
    assert.equal(a.status, 500);
    assert.match((await json(a)).error, /BOOM/);
  } finally { console.error = errSpy; env.DB.prepare = realPrepare; }
});

test('first run: a new person picks the currency and the zone from the list, the owner is never asked', async () => {
  const env = buyer();
  const first = await json(await asB(env, 'GET', '/api/settings'));
  assert.equal(first.setup_done, false);
  assert.ok(first.timezones.some(t => t.id === 'Europe/Moscow' && t.offset_min === 180));
  assert.equal(first.tz_offset_min, 180);
  assert.equal((await json(await call(env, 'GET', '/api/settings'))).setup_done, true);   // the owner
  // only zones from the list (and only real ones)
  assert.equal((await asB(env, 'PUT', '/api/settings', { timezone: 'Pacific/Kiritimati' })).status, 400);
  assert.equal((await asB(env, 'PUT', '/api/settings', { timezone: 'Not/AZone' })).status, 400);
  assert.equal((await asB(env, 'PUT', '/api/settings', { default_currency: 'XXX' })).status, 400);
  const done = await json(await asB(env, 'PUT', '/api/settings', { default_currency: 'KZT', timezone: 'Asia/Almaty', setup_done: true }));
  assert.deepEqual([done.setup_done, done.default_currency, done.timezone, done.tz_offset_min], [true, 'KZT', 'Asia/Almaty', 300]);
  assert.equal(one(env, 'select currency c from users where id = 2').c, 'KZT');
  assert.equal((await json(await call(env, 'GET', '/api/settings'))).default_currency, env.DEFAULT_CURRENCY);   // the owner's own did not change
});

test('payment: Mini App can read the subscription and get a payment link', async () => {
  const env = buyer();
  const restore = spyTelegram({ createInvoiceLink: { ok: true, result: 'https://t.me/$abc' } });
  try {
    const info = await json(await asB(env, 'GET', '/api/subscription'));
    assert.deepEqual([info.state, info.sub_until, info.price_stars, info.period_days], ['new', null, 200, 30]);
    assert.equal(info.support, env.SUPPORT_CONTACT || null);
    const link = await json(await asB(env, 'POST', '/api/subscription/invoice'));
    assert.equal(link.link, 'https://t.me/$abc');
    assert.equal(callsOf('createInvoiceLink')[0].payload, 'sub:2:30');
    assert.equal((await call(env, 'GET', '/api/subscription', undefined, { 'x-token': 'nope' })).status, 401);
    await hook(env, paid(2));
    const after = await json(await asB(env, 'GET', '/api/subscription'));
    assert.equal(after.state, 'active');
    assert.ok(Math.abs(Date.parse(after.sub_until) - (Date.now() + 30 * DAY)) < 60000);
  } finally { restore(); }
});

test('payment: reminders come 3 and 1 days before the end, once each, in the person\'s daytime; the owner gets none', async () => {
  const env = cronPeople();
  const restore = spyTelegram();
  const day = new Date(Date.now() + DAY); day.setUTCHours(7, 0, 0, 0);          // 10:00 in Moscow, a minute divisible by 5
  const t0 = day.getTime();
  const end = t0 + 2 * DAY;                                                       // 2 days left: the "3 days" reminder is due
  env.DB.raw.prepare("update users set status = 'active', sub_until = ? where id = 2").run(msToSqlTest(end));
  try {
    atUtc(new Date(t0).toISOString());
    const text = async () => to(await tickCron(env), 77).map(m => m.text).filter(Boolean).join('\n');
    const first = await text();
    assert.match(first, /Подписка заканчивается[\s\S]*Осталось 2 дня/);
    assert.equal((await text()), '');                                              // not again
    mock.timers.reset(); atUtc(new Date(t0 + 5 * 60000).toISOString());
    assert.equal(await text(), '');
    mock.timers.reset(); atUtc(new Date(end - 20 * 3600000).toISOString());       // 20 hours left -> the last reminder (06:00 UTC, 09:00 Moscow)
    assert.match(await text(), /Осталось 1 день/);
    assert.equal(await text(), '');
    // night in Moscow: postponed until the morning
    env.DB.raw.prepare("update users set sub_until = ?, sub_notice = null where id = 2").run(msToSqlTest(t0 + 20 * 3600000));
    mock.timers.reset(); atUtc(new Date(t0 + 15 * 3600000).toISOString());       // 22:00 Moscow
    assert.equal(await text(), '');
    // a renewal re-arms the reminders
    assert.equal(one(env, 'select sub_notice n from users where id = 2').n, null);
  } finally { mock.timers.reset(); restore(); }
  // the owner never gets them
  env.DB.raw.exec("update users set sub_until = datetime('now', '+1 hours') where id = 1");
  assert.ok(!to(await tickCron(env), 42).some(m => /заканчивается/.test(m.text || '')));   // (chat 42 = the owner; the other person may get theirs at the real clock's hour)
});
const msToSqlTest = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// ---------- stage 5: access by subscription state and daily limits ----------
const record = (env, text = 'кофе 1000') => { aiReply = { actions: [fin(1000)] }; return asB(env, 'POST', '/api/voice-hook', { text }); };
const moscowDay = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const press = async (env, data, chat = 77) => { tgCalls.length = 0; await hook(env, { callback_query: { id: 'c', data, from: { id: chat }, message: { chat: { id: chat }, message_id: 9, text: 'x' } } }); };

test('trial: a new person starts it once with a button or from the app; an ended or switched-off trial cannot be restarted', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    assert.equal((await record(env)).status, 403);
    const start = await hook(env, said(77, '/start'));
    assert.equal(start.status, 200);
    const welcome = callsOf('sendMessage').at(-1);
    assert.match(welcome.text, /пробный период 3 дня, до 10 записей в день/);
    assert.deepEqual(welcome.reply_markup.inline_keyboard.flat().map(b => b.callback_data).filter(Boolean), ['trial_start', 'sub_buy']);
    const t0 = Date.now();
    await press(env, 'trial_start');
    const u = one(env, 'select status, trial_used, sub_until from users where id = 2');
    assert.deepEqual([u.status, u.trial_used], ['trial', 1]);
    assert.ok(Math.abs(untilOf(env) - (t0 + 3 * DAY)) < 60000);
    assert.match(callsOf('sendMessage').map(m => m.text).join('\n'), /Пробный период начался[\s\S]*до 10 записей в день/);
    assert.equal((await record(env)).status, 200);
    // pressed again (or from the app): refused, the end date does not move
    const until = untilOf(env);
    await press(env, 'trial_start');
    assert.equal(callsOf('answerCallbackQuery')[0].text, 'Пробный период уже был');
    assert.equal((await asB(env, 'POST', '/api/subscription/trial')).status, 409);
    assert.equal(untilOf(env), until);
    // after it ran out there is no second trial; paying is the way
    env.DB.raw.exec("update users set status = 'expired', sub_until = datetime('now', '-1 hours') where id = 2");
    assert.equal((await asB(env, 'POST', '/api/subscription/trial')).status, 409);
    assert.deepEqual((await json(await asB(env, 'GET', '/api/subscription'))).can_start_trial, false);
    // the owner can switch the trial off for new people
    const env2 = buyer();
    env2.DB.raw.exec("insert into settings(key,value,user_id) values ('trial_days','0',1)");
    await hook(env2, said(77, '/start'));
    assert.deepEqual(callsOf('sendMessage').at(-1).reply_markup.inline_keyboard.flat().map(b => b.callback_data).filter(Boolean), ['sub_buy']);
    assert.equal((await asB(env2, 'POST', '/api/subscription/trial')).status, 409);
    assert.equal(one(env2, 'select status from users where id = 2').status, 'new');
    // the app starts the trial the same way
    const env3 = buyer();
    const api = await json(await asB(env3, 'POST', '/api/subscription/trial'));
    assert.deepEqual([api.ok, api.days, api.daily_limit], [true, 3, 10]);
    assert.equal(one(env3, 'select status from users where id = 2').status, 'trial');
  } finally { restore(); }
});

test('limits: a trial allows 5 records a day, a subscription 30; the 6th gets a clear answer; a new day starts from zero', async () => {
  const env = buyer();
  env.DB.raw.exec("update users set status = 'trial', trial_used = 1, sub_until = datetime('now', '+2 days') where id = 2; insert into settings(key,value,user_id) values ('trial_daily_limit','5',1)");
  for (let i = 0; i < 5; i++) assert.equal((await record(env)).status, 200, `record ${i + 1}`);
  const sixth = await record(env);
  assert.equal(sixth.status, 429);
  const body = await json(sixth);
  assert.equal(body.reason, 'limit');
  assert.match(body.voice_reply, /лимит пробного периода исчерпан \(5 из 5\)[\s\S]*30 записей/);
  assert.equal(one(env, 'select count(*) c from finances where user_id = 2').c, 6);   // B's own old expense + 5 new
  const u = one(env, 'select daily_count c, daily_date d from users where id = 2');
  assert.deepEqual([u.c, u.d], [5, moscowDay()]);
  // the plain-text answer for the Shortcut
  const text = await call(env, 'POST', '/api/voice-hook?format=text', { text: 'кофе 1000' }, { 'x-token': B_TOKEN });
  assert.equal(text.status, 429);
  assert.match(await text.text(), /лимит/);
  // the next day (in the person's own zone) the counter starts again
  env.DB.raw.exec("update users set daily_date = '2000-01-01' where id = 2");
  assert.equal((await record(env)).status, 200);
  assert.equal(one(env, 'select daily_count c from users where id = 2').c, 1);
  // a subscription: 30 a day (here the owner lowered it to 3), and the app shows how many are used
  env.DB.raw.exec("update users set status = 'active', daily_count = 0 where id = 2; insert into settings(key,value,user_id) values ('daily_record_limit','3',1)");
  for (let i = 0; i < 3; i++) assert.equal((await record(env)).status, 200);
  assert.equal((await record(env)).status, 429);
  const info = await json(await asB(env, 'GET', '/api/subscription'));
  assert.deepEqual([info.daily_limit, info.used_today], [3, 3]);
  // the default really is 30
  env.DB.raw.exec("delete from settings where key = 'daily_record_limit'; update users set daily_count = 29 where id = 2");
  assert.equal((await record(env)).status, 200);
  assert.equal((await record(env)).status, 429);
});

test('limits: the last place cannot be taken twice by simultaneous records; the owner has no limit', async () => {
  const env = buyer();
  env.DB.raw.exec("update users set status = 'trial', trial_used = 1, sub_until = datetime('now', '+2 days') where id = 2; insert into settings(key,value,user_id) values ('trial_daily_limit','5',1)");
  const results = await Promise.all(Array.from({ length: 9 }, () => record(env)));
  assert.equal(results.filter(r => r.status === 200).length, 5);
  assert.equal(results.filter(r => r.status === 429).length, 4);
  for (let i = 0; i < 35; i++) assert.equal((await call(env, 'POST', '/api/voice-hook', { text: 'кофе 1000' })).status, 200);
  assert.equal(one(env, 'select daily_count c from users where id = 1').c, 0);
});

test('limits: the bot counts text and voice like the Shortcut, and says so when the day is used up', async () => {
  const env = buyer();
  const restore = spyTelegram();
  env.DB.raw.exec("update users set status = 'trial', trial_used = 1, sub_until = datetime('now', '+2 days') where id = 2; insert into settings(key,value,user_id) values ('trial_daily_limit','5',1)");
  try {
    aiReply = { actions: [fin(1000)] };
    for (let i = 0; i < 4; i++) assert.equal((await record(env)).status, 200);
    await hook(env, said(77, 'кофе 1000'));                       // the 5th, through the bot
    assert.equal(one(env, 'select count(*) c from finances where user_id = 2').c, 6);   // B's own old expense + 5 new
    tgCalls.length = 0;
    await hook(env, said(77, 'кофе 2000'));
    const reply = callsOf('sendMessage').at(-1);
    assert.match(reply.text, /лимит пробного периода исчерпан/);
    assert.equal(reply.reply_markup.inline_keyboard[0][0].callback_data, 'sub_buy');
    assert.equal(one(env, 'select count(*) c from finances where user_id = 2').c, 6);   // B's own old expense + 5 new
    // commands are not records
    await hook(env, said(77, '/status'));
    assert.match(callsOf('sendMessage').at(-1).text, /Записей сегодня: 5 из 5/);
  } finally { restore(); }
});

test('view only: without access nothing new can be made (AI, app, bot) but own records can be read, edited and deleted', async () => {
  const env = twoUsers();
  const restore = spyTelegram();
  env.TELEGRAM_WEBHOOK_SECRET = 's';
  env.DB.raw.exec("update users set status = 'expired', sub_until = datetime('now', '-1 days'), trial_used = 1 where id = 2");
  try {
    const snap = () => JSON.stringify(['finances', 'tasks', 'notes', 'vocabulary', 'recurring'].map(t => allOf(env, `select * from ${t} where user_id = 2`)));
    const before = snap();
    const f = one(env, 'select id from finances where user_id = 2').id, t = one(env, 'select id from tasks where user_id = 2').id;
    const n = one(env, 'select id from notes where user_id = 2').id, v = one(env, 'select id from vocabulary where user_id = 2').id;
    const r = one(env, 'select id from recurring where user_id = 2').id;
    // reading works
    for (const p of ['/api/finances?period=month', '/api/tasks?filter=all', '/api/notes', '/api/vocabulary', '/api/recurring', '/api/review', '/api/top-words', '/api/settings', '/api/subscription']) {
      assert.equal((await asB(env, 'GET', p)).status, 200, p);
    }
    // every NEW record is refused with the same answer, whichever way it is made
    const attempts = [
      ['POST', '/api/finances', { amount: 5 }], ['POST', '/api/tasks', { title: 'x' }], ['POST', '/api/notes', { title: 'x', content: 'x' }],
      ['POST', '/api/vocabulary', { word: 'cat', translation: 'кот' }], ['POST', '/api/recurring', { title: 'a', amount: 1, day_of_month: 3 }],
      ['POST', '/api/capture', { text: 'кофе 1000' }], ['POST', '/api/voice-hook', { text: 'кофе 1000' }]
    ];
    for (const [method, p, body] of attempts) {
      const res = await asB(env, method, p, body);
      assert.equal(res.status, 403, `${method} ${p}`);
      const answer = await json(res);
      assert.match(answer.error || answer.voice_reply, /Подписка закончилась\. Продлить\?/, `${method} ${p}`);
    }
    assert.equal(snap(), before);
    // settings and study progress stay open
    assert.equal((await asB(env, 'PUT', '/api/settings', { default_currency: 'KZT' })).status, 200);
    assert.equal((await asB(env, 'POST', '/api/top-words/progress', { group: 1, score: 10, total: 20 })).status < 400, true);
    // looking, editing and deleting one's own records stay open: by hand and with the bot's buttons
    assert.equal((await asB(env, 'PUT', `/api/notes/${n}`, { title: 'z', content: 'правка' })).status, 200);
    assert.equal(one(env, 'select title t from notes where id = ?', n).t, 'z');
    assert.equal((await asB(env, 'PATCH', `/api/tasks/${t}/toggle`)).status, 200);
    await press(env, `snooze_${t}`);
    assert.doesNotMatch(String(callsOf('answerCallbackQuery')[0].text), /закончилась/);
    await press(env, `del_notes_${n}`);
    assert.equal(one(env, 'select count(*) c from notes where id = ?', n).c, 0);
    assert.equal((await asB(env, 'DELETE', `/api/finances/${f}`)).status < 300, true);
    assert.equal(one(env, 'select count(*) c from finances where id = ?', f).c, 0);
    // the bot: a new record is refused, with a way to pay
    tgCalls.length = 0;
    await hook(env, said(77, 'кофе 1000'));
    const reply = callsOf('sendMessage').at(-1);
    assert.match(reply.text, /Подписка закончилась\. Продлить\?/);
    assert.deepEqual(reply.reply_markup.inline_keyboard.flat().map(b => b.callback_data), ['sub_buy']);
    await press(env, 'vocab_next');                                 // study buttons are not changes of records
    assert.equal(callsOf('editMessageText').length, 1);
    assert.equal(one(env, 'select daily_count c from users where id = 2').c, 0);      // refused attempts use no place
  } finally { restore(); }
});

test('limits: the default trial limit is 10 a day', async () => {
  const env = buyer();
  env.DB.raw.exec("update users set status = 'trial', trial_used = 1, sub_until = datetime('now', '+2 days') where id = 2");
  for (let i = 0; i < 10; i++) assert.equal((await record(env)).status, 200, `record ${i + 1}`);
  assert.equal((await record(env)).status, 429);
});

test('limits: a record that failed gives its place back (nothing recognised, nothing found to change), but only up to twice the limit', async () => {
  const env = buyer();
  const restore = spyTelegram();
  env.DB.raw.exec("update users set status = 'trial', trial_used = 1, sub_until = datetime('now', '+2 days') where id = 2; insert into settings(key,value,user_id) values ('trial_daily_limit','5',1)");
  const used = () => one(env, 'select daily_count c, daily_fails f from users where id = 2');
  try {
    assert.equal((await record(env)).status, 200);
    assert.deepEqual({ ...used() }, { c: 1, f: 0 });
    // nothing was said
    assert.equal((await asB(env, 'POST', '/api/voice-hook', { text: '' })).status, 400);
    assert.deepEqual({ ...used() }, { c: 1, f: 1 });
    // "delete that" with nothing to delete: nothing changed
    aiReply = { actions: [{ type: 'delete', target_table: 'finances', target_id: 99999 }] };
    const gone = await json(await asB(env, 'POST', '/api/voice-hook', { text: 'удали трату' }));
    assert.match(gone.voice_reply, /не найдена/);
    assert.deepEqual({ ...used() }, { c: 1, f: 2 });
    // through the bot as well
    await hook(env, said(77, 'удали трату'));
    assert.deepEqual({ ...used() }, { c: 1, f: 3 });
    // a saved record is a used place
    assert.equal((await record(env)).status, 200);
    assert.deepEqual({ ...used() }, { c: 2, f: 3 });
    // failing over and over cannot be used to dodge the limit: after 10 returns the places stay used
    for (let i = 0; i < 12; i++) await asB(env, 'POST', '/api/voice-hook', { text: '' });
    assert.deepEqual({ ...used() }, { c: 5, f: 10 });      // 7 returned, then the remaining failures used the last 3 places up
    assert.equal((await record(env)).status, 429);
    // a new day clears both
    env.DB.raw.exec("update users set daily_date = '2000-01-01' where id = 2");
    assert.equal((await record(env)).status, 200);
    assert.deepEqual({ ...used() }, { c: 1, f: 0 });
  } finally { restore(); }
});

test('support: the contact shown in /help is the owner\'s nick from the worker settings', () => {
  const cfg = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  assert.match(cfg, /"SUPPORT_CONTACT":\s*"@jstivn"/);
});

test('view only: a live trial or subscription may change records by hand without using up the day', async () => {
  const env = twoUsers();                          // B: active
  const res = await asB(env, 'POST', '/api/notes', { title: 'своя', content: 'заметка' });
  assert.equal(res.status < 300, true);
  assert.equal(one(env, 'select daily_count c from users where id = 2').c, 0);
});

test('end of access: the person is told once, in their daytime, and the status turns to expired; a trial cannot restart', async () => {
  const env = cronPeople();
  const restore = spyTelegram();
  env.DB.raw.exec("update users set status = 'trial', trial_used = 1, sub_until = '2000-01-01 00:00:00' where id = 2");
  const toB = async () => to(await tickCron(env), 77).map(m => m.text).filter(Boolean).join('\n');
  try {
    atUtc('2026-11-02T22:00:00Z');                                  // 01:00 in Moscow: no message at night
    assert.equal(await toB(), '');
    assert.equal(one(env, 'select status from users where id = 2').status, 'trial');
    mock.timers.reset(); atUtc('2026-11-03T07:00:00Z');             // 10:00 in Moscow
    assert.match(await toB(), /Пробный период закончился[\s\S]*оформите подписку/);
    assert.equal(one(env, 'select status from users where id = 2').status, 'expired');
    assert.equal(await toB(), '');                                  // only once
    mock.timers.reset(); atUtc('2026-11-03T07:05:00Z');
    assert.equal(await toB(), '');
    assert.equal((await record(env)).status, 403);
    assert.equal((await asB(env, 'POST', '/api/subscription/trial')).status, 409);
    // a paid subscription that ran out says so in its own words
    env.DB.raw.exec("update users set status = 'active', sub_until = '2000-01-01 00:00:00' where id = 2");
    mock.timers.reset(); atUtc('2026-11-04T07:00:00Z');
    assert.match(await toB(), /Подписка закончилась/);
    // the owner is never switched off
    env.DB.raw.exec("update users set sub_until = '2000-01-01 00:00:00' where id = 1");
    mock.timers.reset(); atUtc('2026-11-05T07:00:00Z');
    await tickCron(env);
    assert.equal(one(env, 'select status from users where id = 1').status, 'active');
  } finally { mock.timers.reset(); restore(); }
});

test('payment: a trial gets only the last reminder (not one on its first day)', async () => {
  const env = cronPeople();
  const restore = spyTelegram();
  const day = new Date(Date.now() + DAY); day.setUTCHours(7, 0, 0, 0);
  const t0 = day.getTime();
  env.DB.raw.prepare("update users set status = 'trial', sub_until = ? where id = 2").run(msToSqlTest(t0 + 3 * DAY - 60000));
  try {
    atUtc(new Date(t0).toISOString());
    const text = async () => to(await tickCron(env), 77).map(m => m.text).filter(Boolean).join('\n');
    assert.equal(await text(), '');
    mock.timers.reset(); atUtc(new Date(t0 + 2.25 * DAY).toISOString());         // 18 hours left, still daytime (16:00 Moscow)
    assert.match(await text(), /Пробный период заканчивается/);
  } finally { mock.timers.reset(); restore(); }
});

// ---------- stage 9: money protection ----------
test('security: a client cannot move the time zone after the first run (the day limit would reset); the owner can', async () => {
  const env = buyer();
  assert.equal((await asB(env, 'PUT', '/api/settings', { timezone: 'Asia/Almaty', setup_done: true })).status, 200);
  const moved = await asB(env, 'PUT', '/api/settings', { timezone: 'Europe/Moscow' });
  assert.equal(moved.status, 403);
  assert.equal((await json(moved)).code, 'tz_locked');
  assert.equal(one(env, 'select timezone t from users where id = 2').t, 'Asia/Almaty');
  assert.equal((await asB(env, 'PUT', '/api/settings', { timezone: 'Asia/Almaty', default_currency: 'KZT' })).status, 200);   // same value: fine
  assert.equal((await call(env, 'PUT', '/api/settings', { timezone: 'Asia/Bangkok' })).status, 200);                      // owner
  // setup never finished but a record already counted: also locked
  const env2 = buyer();
  env2.DB.raw.exec("update users set daily_date = '2026-11-02', daily_count = 1 where id = 2");
  assert.equal((await asB(env2, 'PUT', '/api/settings', { timezone: 'Asia/Almaty' })).status, 403);
});

test('security: oversized requests are refused, a guessing robot and a flood get 429', async () => {
  const env = makeEnv();
  const big = await call(env, 'POST', '/api/notes', { title: 'x' }, { 'content-length': String(300 * 1024) });
  assert.equal(big.status, 413);
  const bigAudio = await worker.fetch(new Request('https://t.local/api/voice-hook', { method: 'POST',
    headers: { 'content-type': 'audio/m4a', 'x-token': 'secret', 'content-length': String(13 * 1024 * 1024) }, body: 'x' }), env, { waitUntil() {} });
  assert.equal(bigAudio.status, 413);
  const from = (ip, token) => call(env, 'GET', '/api/health-check-none', undefined, { 'x-token': token, 'cf-connecting-ip': ip });
  for (let i = 0; i < 10; i++) assert.equal((await from('9.9.9.9', 'wrong')).status, 401);
  assert.equal((await from('9.9.9.9', 'wrong')).status, 429);
  assert.equal((await from('9.9.9.9', 'secret')).status, 429);           // still blocked for that address
  assert.notEqual((await from('8.8.8.8', 'secret')).status, 429);        // others are not
  for (let i = 0; i < 241; i++) await call(env, 'GET', '/api/notes', undefined, { 'cf-connecting-ip': '7.7.7.7' });
  assert.equal((await call(env, 'GET', '/api/notes', undefined, { 'cf-connecting-ip': '7.7.7.7' })).status, 429);
});

test('security: /api/set-webhook (owner only) registers the secret and only the update kinds the bot uses', async () => {
  const env = buyer();
  env.TELEGRAM_BOT_TOKEN = 'bot';
  const restore = spyTelegram({ setWebhook: { ok: true, result: true } });
  try {
    assert.equal((await asB(env, 'POST', '/api/set-webhook')).status, 403);
    assert.equal(callsOf('setWebhook').length, 0);
    const res = await json(await call(env, 'POST', '/api/set-webhook'));
    assert.equal(res.ok, true);
    const sent = callsOf('setWebhook')[0];
    assert.equal(sent.secret_token, 's');
    assert.deepEqual(sent.allowed_updates, ['message', 'callback_query', 'pre_checkout_query']);
    assert.equal(sent.url, 'https://t.local/api/telegram-webhook');
    delete env.TELEGRAM_WEBHOOK_SECRET;
    assert.equal((await call(env, 'POST', '/api/set-webhook')).status, 400);
  } finally { restore(); }
});

test('security: the Telegram webhook with a wrong or missing secret is refused', async () => {
  const env = buyer();
  assert.equal((await hook(env, said(77, 'hi'), { 'x-telegram-bot-api-secret-token': 'bad' })).status, 403);
  assert.equal((await hook(env, said(77, 'hi'), {})).status, 403);
});

test('security: /api/set-webhook also opens with the webhook secret as X-Setup-Key, and only with the right one', async () => {
  const env = buyer();
  env.TELEGRAM_BOT_TOKEN = 'bot';
  const restore = spyTelegram({ setWebhook: { ok: true, result: true } });
  try {
    assert.equal((await worker.fetch(new Request('https://t.local/api/set-webhook', { method: 'POST', headers: { 'x-setup-key': 'wrong' } }), env, { waitUntil() {} })).status, 401);
    assert.equal((await worker.fetch(new Request('https://t.local/api/set-webhook', { method: 'POST' }), env, { waitUntil() {} })).status, 401);
    const ok = await worker.fetch(new Request('https://t.local/api/set-webhook', { method: 'POST', headers: { 'x-setup-key': 's' } }), env, { waitUntil() {} });
    assert.equal((await json(ok)).ok, true);
    assert.equal(callsOf('setWebhook').length, 1);
  } finally { restore(); }
});

test('security: no cross-site (CORS) permission; the page carries a content policy', async () => {
  const env = makeEnv();
  const page = await worker.fetch(new Request('https://t.local/app'), env, { waitUntil() {} });
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const api = await call(env, 'GET', '/api/notes');
  assert.equal(api.headers.get('access-control-allow-origin'), null);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
});

test('journal: grant, revoke and refund are written down (no records of anybody) and /journal shows them to the owner only', async () => {
  const env = buyer();
  env.TELEGRAM_BOT_TOKEN = 'bot';
  const restore = spyTelegram({ refundStarPayment: { ok: true, result: true } });
  try {
    await hook(env, said(42, '/journal'));
    assert.match(callsOf('sendMessage').at(-1).text, /Журнал пуст/);
    await hook(env, said(42, '/grant 2 7'));
    await hook(env, said(42, '/revoke 2'));
    env.DB.raw.exec("insert into payments (user_id, provider, charge_id, amount, currency, period_days, status, applied) values (2, 'stars', 'c9', 200, 'XTR', 30, 'paid', 0)");
    const pid = one(env, "select id from payments where charge_id = 'c9'").id;
    await hook(env, said(42, `/refund ${pid}`));
    await hook(env, said(42, '/journal'));
    const text = callsOf('sendMessage').at(-1).text;
    assert.match(text, /grant №2 \+7 дн\./);
    assert.match(text, /revoke №2/);
    assert.match(text, new RegExp(`refund платёж №${pid} \\(200 Stars, человек №2\\)`));
    await hook(env, said(77, '/journal'));
    assert.match(callsOf('sendMessage').at(-1).text, /недоступна/);
  } finally { restore(); }
});

test('security: a personal token works only from a header and only as a hash; an open-text value in the table is no key', async () => {
  const env = twoUsers();
  assert.equal((await asB(env, 'GET', '/api/notes')).status, 200);
  assert.equal((await call(env, 'GET', `/api/notes?token=${B_TOKEN}`, undefined, { 'x-token': '' })).status, 401);   // not in the address
  env.DB.raw.prepare("update users set token = ? where id = 2").run(B_TOKEN);                                      // an old open-text row
  assert.equal((await asB(env, 'GET', '/api/notes')).status, 401);
});

test('security: a payment with a smaller update number is not dropped, and is still counted once', async () => {
  const env = buyer();
  const restore = spyTelegram();
  try {
    await hook(env, said(77, '/start'), SECRET);                                        // raises the "last seen" number
    const high = nextUpdateId + 50;
    await hook(env, said(77, 'привет'), SECRET);
    await hook(env, { update_id: high, ...said(77, '/status') });
    const res = await hook(env, { update_id: high - 10, ...paid(2) });                  // arrives later, smaller number
    assert.equal(res.status, 200);
    assert.equal(one(env, "select status, applied from payments where charge_id = 'ch-1'").applied, 1);
    const until = untilOf(env);
    await hook(env, { update_id: high - 9, ...paid(2) });                               // the same payment again
    assert.equal(untilOf(env), until);
  } finally { restore(); }
});

test('security: one record makes at most 10 actions', async () => {
  const env = makeEnv();
  const many = Array.from({ length: 30 }, (_, i) => ({ type: 'note', data: { title: `n${i}`, content: `c${i}`, confidence: 0.9 } }));
  await say(env, 'очень длинная диктовка', many);
  assert.ok(rows(env, 'notes').length <= 10);
});
