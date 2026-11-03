/**
 * TRACE — Voice-First AI Copilot & Telegram Mini App
 * Powered by Cloudflare Workers, Cloudflare D1 & Google Gemini 2.0 Flash
 * 
 * Architecture:
 * iPhone Action Button -> Cloudflare Worker -> Gemini 2.0 Flash -> D1 SQLite -> Telegram Mini App
 */

import { APP_HTML } from './html.js';
import { TOP_WORDS, TOP_GROUPS } from './top_words.js';

const BUILD_VERSION = '4.0';

// Настройки подписки по умолчанию (см. PLAN-SUBSCRIPTIONS.md). Пока нигде не используются —
// подключаются на этапах 4–5. Менять цифры здесь, не в текстах бота.
const SUBSCRIPTION_DEFAULTS = {
  PRICE_STARS: 200,          // цена подписки в Telegram Stars
  PERIOD_DAYS: 30,           // на сколько дней одна оплата
  TRIAL_DAYS: 3,             // пробный период; 0 = выключен
  TRIAL_DAILY_LIMIT: 10,     // записей в день в пробном периоде
  DAILY_RECORD_LIMIT: 30,    // записей в день при активной подписке
  REMIND_DAYS_BEFORE: [3, 1], // напоминания о конце подписки
  LOG_RETENTION_DAYS: 7,     // сколько хранить request_logs клиентов
  DEFAULT_CURRENCY: 'RUB',   // у клиентов; у владельца остаётся VND
  DEFAULT_TIMEZONE_OFFSET: 3 // Москва, UTC+3
};

// Standard CORS headers for Mini App API
// No cross-site access: the Mini App calls this worker from its own address and the Shortcut is not a browser,
// so other sites get no CORS permission. (Name kept: it is spread into every response.)
const CORS_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
// The page may load only itself, Telegram's script, and be shown inside Telegram.
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://telegram.org",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors https://web.telegram.org https://*.telegram.org https://telegram.org"
].join('; ');

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS
    }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

/**
 * Parse a JSON request body. Invalid JSON throws SyntaxError (mapped to 400 by the router);
 * a non-object body (null, number, array) is normalised to {}.
 */
async function readJson(request, { skip = [] } = {}) {
  const body = await request.json();
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  // One text field is never this long in real use; a robot filling the database with huge texts is stopped here, for every route
  // (`skip`: fields that legitimately are big, like the audio of the voice hook; the whole body is capped by its size anyway)
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length > MAX_FIELD_CHARS && !skip.includes(k)) throw new LimitError('Слишком длинный текст: сократите его.');
  }
  return obj;
}

const MAX_FIELD_CHARS = 5000;
class LimitError extends Error {}

/** How many rows one person may keep per table (manual creation; the AI route is held back by the daily limit instead). */
const ROW_CAPS = {
  '/api/finances': { cap: 20000, sql: 'SELECT COUNT(*) c FROM finances WHERE user_id = ?' },
  '/api/tasks': { cap: 5000, sql: 'SELECT COUNT(*) c FROM tasks WHERE user_id = ?' },
  '/api/notes': { cap: 5000, sql: 'SELECT COUNT(*) c FROM notes WHERE user_id = ?' },
  '/api/vocabulary': { cap: 5000, sql: 'SELECT COUNT(*) c FROM vocabulary WHERE user_id = ?' },
  '/api/recurring': { cap: 100, sql: 'SELECT COUNT(*) c FROM recurring WHERE user_id = ?' }
};

/** What a client may read about a failure: the owner sees the real reason, everybody else a neutral text (no internals leak). */
function publicError(env, err, owner = 'Internal Server Error') {
  if (env?.uid === OWNER_ID) return err?.message || owner;
  return 'Что-то пошло не так. Попробуйте ещё раз.';
}

/**
 * Authentication for everything except the Mini App shell, healthcheck and the
 * endpoints that do their own check (voice-hook, telegram-webhook).
 * Accepts either AUTH_TOKEN (Bearer / X-Token / ?token=) or Telegram Mini App initData
 * signed with the bot token and belonging to the owner chat.
 */
// Speed and size limits. The counters live in the memory of one running copy of the worker, so this is a
// brake against floods and token guessing, not an exact count (the paid daily limit is counted in the database).
const RATE = {
  perIp: { max: 240, windowMs: 60_000 },
  perUser: { max: 120, windowMs: 60_000 },
  badAuth: { max: 10, windowMs: 10 * 60_000 }
};
const MAX_ACTIONS_PER_RECORD = 10;
const MAX_JSON_BODY = 256 * 1024;
const MAX_AUDIO_BODY = 12 * 1024 * 1024;
const AUDIO_PATHS = new Set(['/api/voice-hook', '/api/capture']);
const rateBuckets = new Map();

function rateBucket(key, rule) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now >= b.reset) {
    if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (now >= v.reset) rateBuckets.delete(k);
    b = { count: 0, reset: now + rule.windowMs };
    rateBuckets.set(key, b);
  }
  return b;
}
/** Count one hit; true = over the limit. */
const rateHit = (key, rule) => ++rateBucket(key, rule).count > rule.max;
/** Look without counting; true = already over. */
const rateOver = (key, rule) => rateBucket(key, rule).count >= rule.max;
const rateLimited = () => new Response(JSON.stringify({ ok: false, error: 'Too many requests, try again in a minute' }),
  { status: 429, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60', ...CORS_HEADERS } });

function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const msg = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
}

async function getOwnerChatId(env) {
  if (env.TELEGRAM_CHAT_ID) return String(env.TELEGRAM_CHAT_ID);
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'telegram_chat_id' AND user_id = ?").bind(OWNER_ID).first();
    return row?.value ? String(row.value) : null;
  } catch (e) {
    return null;
  }
}

// ================= Users (PLAN-SUBSCRIPTIONS.md, stage 2) =================
// Every row of user data carries user_id. The env a handler gets is "scoped" to one user (env.uid), and its DB
// refuses any statement on a user table that does not mention user_id, so a forgotten filter fails loudly.
const OWNER_ID = 1;
const OWNER = { id: OWNER_ID, role: 'owner', status: 'active' };
const CREATE_PATHS = new Set(['/api/finances', '/api/tasks', '/api/notes', '/api/recurring', '/api/vocabulary']);   // POST here makes a new record
const USER_DATA_TABLES_RX = /\b(finances|tasks|notes|vocabulary|word_groups|recurring|request_logs|settings)\b/i;

/** env for one user. `rawDB` is the unrestricted database (users table, system jobs); handlers must not need it. */
function scopeEnv(env, user) {
  const raw = env.DB;
  const DB = raw && {
    raw: raw.raw,
    prepare(sql) {
      if (USER_DATA_TABLES_RX.test(sql) && !/\buser_id\b/i.test(sql)) {
        throw new Error(`SQL on user data without user_id: ${String(sql).replace(/\s+/g, ' ').slice(0, 90)}`);
      }
      return raw.prepare(sql);
    }
  };
  return { ...env, DB, rawDB: raw, uid: user.id, user, ...tzFields(420) };
}

// Currencies a person can choose as their own (first run asks; settings can change it)
const SUPPORTED_CURRENCIES = ['RUB', 'VND', 'USD', 'KZT', 'UAH', 'EUR', 'AED'];

// Time zones a person picks from on the first run (never detected from the phone or Telegram). Not the owner: the owner may set any zone.
const TIMEZONE_CHOICES = [
  ['Europe/Kaliningrad', 'Калининград'], ['Europe/Moscow', 'Москва, Санкт-Петербург'], ['Europe/Samara', 'Самара'],
  ['Asia/Yekaterinburg', 'Екатеринбург'], ['Asia/Omsk', 'Омск'], ['Asia/Novosibirsk', 'Новосибирск'], ['Asia/Krasnoyarsk', 'Красноярск'],
  ['Asia/Irkutsk', 'Иркутск'], ['Asia/Yakutsk', 'Якутск'], ['Asia/Vladivostok', 'Владивосток'], ['Asia/Magadan', 'Магадан'],
  ['Asia/Kamchatka', 'Камчатка'], ['Europe/Kyiv', 'Киев'], ['Europe/Minsk', 'Минск'], ['Asia/Almaty', 'Алматы'], ['Asia/Tashkent', 'Ташкент'],
  ['Asia/Bishkek', 'Бишкек'], ['Asia/Tbilisi', 'Тбилиси'], ['Asia/Yerevan', 'Ереван'], ['Asia/Baku', 'Баку'], ['Asia/Dubai', 'Дубай'],
  ['Europe/Istanbul', 'Стамбул'], ['Asia/Bangkok', 'Бангкок'], ['Asia/Ho_Chi_Minh', 'Нячанг, Хошимин'], ['Europe/Berlin', 'Берлин'],
  ['Europe/London', 'Лондон'], ['America/New_York', 'Нью-Йорк']
];
const TIMEZONE_IDS = TIMEZONE_CHOICES.map(t => t[0]);

/** Minutes the zone is ahead of UTC right now (Europe/Moscow = 180); 420 (Nha Trang) for an unknown zone. */
function tzOffsetMinutes(tz, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(now);
    const g = (t) => Number(parts.find(p => p.type === t).value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
    return Math.round((asUtc - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  } catch (e) {
    return 420;
  }
}

const isValidTimezone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: String(tz) }); return true; } catch (e) { return false; } };

/** Everything the handlers need to work in one person's local time. tzSql goes into SQLite date modifiers. */
function tzFields(minutes) {
  const m = Math.round(Number(minutes)) || 0;
  return {
    tzMin: m, tzMs: m * 60000, tzHours: m / 60,
    tzSql: `${m >= 0 ? '+' : '-'}${Math.abs(m)} minutes`,
    tzSqlNeg: `${m >= 0 ? '-' : '+'}${Math.abs(m)} minutes`
  };
}

/**
 * scopeEnv plus the person's own zone and currency (users row; the owner falls back to the deploy settings).
 * DEFAULT_CURRENCY and USER_TIMEZONE of the returned env are the person's, so everything that reads them follows.
 */
async function userEnv(env, user) {
  let row = null;
  if (env.DB) {
    try { row = await env.DB.prepare('SELECT timezone, currency FROM users WHERE id = ?').bind(user.id).first(); } catch (e) {}
  }
  const owner = user.id === OWNER_ID;
  const tz = row?.timezone || (owner ? env.USER_TIMEZONE || 'Asia/Ho_Chi_Minh' : 'Europe/Moscow');
  const currency = String(row?.currency || (owner ? env.DEFAULT_CURRENCY || 'VND' : SUBSCRIPTION_DEFAULTS.DEFAULT_CURRENCY)).toUpperCase();
  return Object.assign(scopeEnv(env, user), { DEFAULT_CURRENCY: currency, USER_TIMEZONE: tz }, tzFields(tzOffsetMinutes(tz)));
}

/** One setting of one user (default: the current one). Shared keys (rates, last Telegram update) live with the owner. */
async function getSetting(env, key, uid = env.uid) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ? AND user_id = ?').bind(key, uid).first();
  return row?.value ?? null;
}

async function setSetting(env, key, value, uid = env.uid) {
  const up = await env.DB.prepare('UPDATE settings SET value = ? WHERE key = ? AND user_id = ?').bind(String(value), key, uid).run();
  if (!up?.meta?.changes) {
    await env.DB.prepare('INSERT INTO settings (key, value, user_id) VALUES (?, ?, ?)').bind(key, String(value), uid).run();
  }
}

/** SQLite's datetime('now') format, for values kept in settings. */
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** The user behind a Telegram id: the owner, a known user, or a new one (created with no access yet). */
async function userForTelegram(env, tgId, name) {
  // Strict read: if the settings table cannot be read, fail (a stranger must never be taken for "the first chat = owner")
  const ownerChat = env.TELEGRAM_CHAT_ID ? String(env.TELEGRAM_CHAT_ID)
    : (await env.DB.prepare("SELECT value FROM settings WHERE key = 'telegram_chat_id' AND user_id = ?").bind(OWNER_ID).first())?.value?.toString() || null;
  if (ownerChat && String(tgId) === ownerChat) return OWNER;
  const found = await env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?').bind(Number(tgId)).first();
  if (found) return found.id === OWNER_ID ? OWNER : found;
  if (!ownerChat) return OWNER;   // nobody has written to the bot yet: the first chat is the owner
  await env.DB.prepare("INSERT OR IGNORE INTO users (telegram_id, name, role, status) VALUES (?, ?, 'user', 'new')")
    .bind(Number(tgId), String(name || '').slice(0, 80)).run();
  return await env.DB.prepare('SELECT * FROM users WHERE telegram_id = ?').bind(Number(tgId)).first();
}

/** Who may record new things (voice, text, capture). The owner always; others once a subscription or trial is on. */
function userMayRecord(user) {
  const state = subscriptionState(user);
  return state === 'owner' || state === 'trial' || state === 'active';
}

const NO_ACCESS_TEXT = 'Доступ к записи пока закрыт: нужна подписка или пробный период.';

// ================= Payments (PLAN-SUBSCRIPTIONS.md, stage 4) =================
// Money goes through a "payment provider" (today only Telegram Stars); the rest of the code talks to the interface
// { id, currency, invoice(), sendInvoice(), invoiceLink(), verify(), refund() } so another provider can be added beside it.
// `payments` and `users` are read and written through env.rawDB (they are not per-user data tables).
const DAY_MS = 86400000;
const sqlMs = (s) => {
  if (!s) return NaN;
  const t = String(s);
  return Date.parse(t.replace(' ', 'T') + (/z$/i.test(t) ? '' : 'Z'));
};
const msToSql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const ruDate = (ms, tzMs = 0) => {
  const d = new Date(ms + tzMs);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
};
const ruDays = (n) => {
  const m100 = n % 100, m10 = n % 10;
  return (m100 >= 11 && m100 <= 14) || m10 === 0 || m10 >= 5 ? 'дней' : m10 === 1 ? 'день' : 'дня';
};

function telegramCall(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json()).catch(e => ({ ok: false, description: e.message }));
}

/** owner | trial | active | expired | new — what the person's subscription is right now. */
function subscriptionState(user, now = Date.now()) {
  if (user.role === 'owner') return 'owner';
  const until = sqlMs(user.sub_until);
  const live = Number.isFinite(until) ? until > now : true;
  if ((user.status === 'trial' || user.status === 'active') && live) return user.status;
  return user.status === 'new' ? 'new' : 'expired';
}

/** Price and length of one payment. The price can be changed by the owner's setting `price_stars` (e.g. 1 for a live test). */
async function subscriptionPlan(env) {
  let price = NaN;
  try { price = parseInt(await getSetting(env, 'price_stars', OWNER_ID), 10); } catch (e) {}
  return { priceStars: price >= 1 ? price : SUBSCRIPTION_DEFAULTS.PRICE_STARS, days: SUBSCRIPTION_DEFAULTS.PERIOD_DAYS };
}

const PAYMENT_PROVIDERS = {
  stars: {
    id: 'stars',
    currency: 'XTR',
    invoice(user, plan) {
      return {
        title: 'Подписка TRACE',
        description: `Доступ к записи на ${plan.days} ${ruDays(plan.days)}: голос, траты, задачи, заметки.`,
        payload: `sub:${user.id}:${plan.days}`,
        currency: 'XTR',
        prices: [{ label: `${plan.days} ${ruDays(plan.days)}`, amount: plan.priceStars }]
      };
    },
    sendInvoice: (env, chatId, params) => telegramCall(env, 'sendInvoice', { chat_id: chatId, ...params }),
    invoiceLink: (env, params) => telegramCall(env, 'createInvoiceLink', params),
    /** A forged "successful_payment" must not give a free subscription: trust the webhook secret, else ask Telegram. */
    async verify(env, sp) {
      if (env.TELEGRAM_WEBHOOK_SECRET) return true;
      const res = await telegramCall(env, 'getStarTransactions', { offset: 0, limit: 100 });
      const list = res?.result?.transactions || [];
      return list.some(t => t.id === sp.telegram_payment_charge_id && Number(t.amount) === Number(sp.total_amount));
    },
    refund: (env, telegramUserId, chargeId) => telegramCall(env, 'refundStarPayment', { user_id: telegramUserId, telegram_payment_charge_id: chargeId })
  }
};
const activeProvider = () => PAYMENT_PROVIDERS.stars;

const subscribeMarkup = (label = 'Оформить подписку') => ({ inline_keyboard: [[{ text: label, callback_data: 'sub_buy' }]] });

/** The invoice message in the person's chat (the "pay" button is drawn by Telegram). */
async function sendSubscriptionInvoice(env, chatId) {
  const p = activeProvider();
  const res = await p.sendInvoice(env, chatId, p.invoice(env.user, await subscriptionPlan(env)));
  if (!res?.ok) {
    console.error('sendInvoice failed:', JSON.stringify(res));
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, '<i>Не получилось выставить счёт. Попробуйте чуть позже.</i>', null, 'HTML');
  }
  return res;
}

/** Checks the payload, the payer and (for pre_checkout) the price. Returns { days } or { error } with a text for the payer. */
async function validatePayment(env, user, q, { checkPrice = true } = {}) {
  const m = /^sub:(\d+):(\d+)$/.exec(String(q.invoice_payload || ''));
  if (!m) return { error: 'Неизвестный счёт. Откройте оплату заново: /subscribe' };
  if (Number(m[1]) !== user.id) return { error: 'Счёт выписан для другого аккаунта. Откройте оплату заново: /subscribe' };
  if (q.currency !== activeProvider().currency) return { error: 'Неверная валюта счёта. Откройте оплату заново: /subscribe' };
  const plan = await subscriptionPlan(env);
  const days = Number(m[2]);
  if (checkPrice && (Number(q.total_amount) !== plan.priceStars || days !== plan.days)) {
    return { error: 'Цена изменилась. Откройте оплату заново: /subscribe' };
  }
  return { days };
}

/** Adds days to the subscription: from today, or from the current end if it is still ahead. Returns the new end (ms). */
async function grantSubscription(env, user, days) {
  const row = await env.rawDB.prepare('SELECT sub_until FROM users WHERE id = ?').bind(user.id).first();
  const until = Math.max(Date.now(), sqlMs(row?.sub_until) || 0) + days * DAY_MS;
  await env.rawDB.prepare(`UPDATE users SET sub_until = ?, sub_notice = NULL${user.role === 'owner' ? '' : ", status = 'active'"} WHERE id = ?`)
    .bind(msToSql(until), user.id).run();
  return until;
}

/**
 * Telegram says money was taken. The payment row is written first (charge_id is UNIQUE, so a repeated update
 * is a no-op); `applied` flips to 1 only after the days were added, so an interrupted run can be finished by a repeat.
 */
async function handleSuccessfulPayment(env, chatId, message) {
  const sp = message.successful_payment;
  const user = env.user;
  const p = activeProvider();
  const check = await validatePayment(env, user, sp, { checkPrice: false });
  const days = check.error ? (await subscriptionPlan(env)).days : check.days;
  if (check.error) console.error('Payment with an odd payload:', check.error, sp.invoice_payload);

  const charge = String(sp.telegram_payment_charge_id || '');
  if (!charge) return;
  const verified = sp.currency === p.currency && await p.verify(env, sp);
  await env.rawDB.prepare(
    'INSERT OR IGNORE INTO payments (user_id, provider, amount, currency, charge_id, payload, period_days, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(user.id, p.id, Number(sp.total_amount) || 0, String(sp.currency || ''), charge, String(sp.invoice_payload || '').slice(0, 100), days, verified ? 'paid' : 'unverified').run();
  const pay = await env.rawDB.prepare('SELECT * FROM payments WHERE provider = ? AND charge_id = ?').bind(p.id, charge).first();
  if (!pay || pay.applied || pay.status === 'refunded' || pay.status === 'refunding') return;

  if (!verified) {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      '<i>Платёж получен, но не подтвердился автоматически.</i>\n<blockquote>Мы проверим его вручную и включим подписку. Если долго нет ответа, напишите: /paysupport</blockquote>', null, 'HTML');
    const owner = await getOwnerChatId(env);
    if (owner) await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, owner, `<i>Платёж не подтвердился</i>\n<blockquote>платёж №${pay.id}, человек №${user.id}, ${pay.amount} ${escapeHtml(pay.currency)}</blockquote>`, null, 'HTML');
    return;
  }
  if (pay.status !== 'paid') await env.rawDB.prepare("UPDATE payments SET status = 'paid' WHERE id = ?").bind(pay.id).run();
  // Take the payment in ONE statement before adding days, so two deliveries at the same moment cannot both add them
  const claim = await env.rawDB.prepare('UPDATE payments SET applied = 1 WHERE id = ? AND applied = 0').bind(pay.id).run();
  if (!claim?.meta?.changes) return;
  let until;
  try {
    until = await grantSubscription(env, user, pay.period_days);
  } catch (e) {
    await env.rawDB.prepare('UPDATE payments SET applied = 0 WHERE id = ?').bind(pay.id).run();   // let a repeat finish it
    throw e;
  }
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
    `<i>Оплата получена</i>\n<blockquote>Подписка действует до <b>${ruDate(until, env.tzMs)}</b>.</blockquote>`, null, 'HTML');
}

/** Gives the money back (owner only). The subscription loses the days that payment bought. */
async function refundPayment(env, paymentId) {
  const p = activeProvider();
  const pay = await env.rawDB.prepare('SELECT * FROM payments WHERE id = ? AND provider = ?').bind(paymentId, p.id).first();
  if (!pay) return { ok: false, error: 'Платёж не найден' };
  const claim = await env.rawDB.prepare("UPDATE payments SET status = 'refunding' WHERE id = ? AND status IN ('paid', 'unverified')").bind(pay.id).run();
  if (!claim?.meta?.changes) return { ok: false, error: pay.status === 'refunded' ? 'Этот платёж уже возвращён' : 'Платёж сейчас нельзя вернуть' };
  const user = await env.rawDB.prepare('SELECT * FROM users WHERE id = ?').bind(pay.user_id).first();
  const res = user?.telegram_id ? await p.refund(env, user.telegram_id, pay.charge_id) : { ok: false, description: 'no telegram id' };
  if (!res?.ok) {
    await env.rawDB.prepare('UPDATE payments SET status = ? WHERE id = ?').bind(pay.status, pay.id).run();
    return { ok: false, error: `Telegram не вернул платёж: ${res?.description || 'ошибка'}` };
  }
  await env.rawDB.prepare("UPDATE payments SET status = 'refunded', refunded_at = datetime('now') WHERE id = ?").bind(pay.id).run();
  await auditLog(env, `refund платёж №${pay.id} (${pay.amount} Stars, человек №${pay.user_id})`);
  if (pay.applied) {
    const until = (sqlMs(user.sub_until) || Date.now()) - pay.period_days * DAY_MS;
    const ended = user.role !== 'owner' && until <= Date.now();
    await env.rawDB.prepare(`UPDATE users SET sub_until = ?, sub_notice = NULL${ended ? ", status = 'expired'" : ''} WHERE id = ?`).bind(msToSql(until), user.id).run();
  }
  if (user.telegram_id) {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, user.telegram_id, `<i>Платёж возвращён</i>\n<blockquote>${pay.amount} Stars вернулись на ваш счёт в Telegram.</blockquote>`, null, 'HTML');
  }
  return { ok: true };
}

// ================= Owner admin (PLAN-SUBSCRIPTIONS.md, stage 7) =================
// Only counters and statuses: other people's expenses, tasks and notes are never read here.
// API use is counted by day under the owner's settings (`usage:YYYY-MM-DD:<name>`, no phrases): the counts are collected
// in memory while a request runs (noteUsage) and written by flushUsage (end of a voice request, and every cron minute).
const usageBuffer = {};
const noteUsage = (name) => { usageBuffer[name] = (usageBuffer[name] || 0) + 1; };
const USAGE_LABELS = {
  stt_groq: 'Речь: Groq', stt_cf: 'Речь: запасной Cloudflare',
  llm_gemini: 'Разбор: Gemini', llm_groq: 'Разбор: запасной Groq', llm_cf: 'Разбор: запасной Cloudflare', llm_fallback: 'Разбор без ИИ'
};

async function flushUsage(env) {
  const take = { ...usageBuffer };
  for (const k of Object.keys(take)) delete usageBuffer[k];
  if (!env.DB) return;
  const day = new Date().toISOString().slice(0, 10);
  for (const [name, n] of Object.entries(take)) {
    const key = `usage:${day}:${name}`;
    try {
      const up = await env.DB.prepare('UPDATE settings SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = ? AND user_id = ?').bind(n, key, OWNER_ID).run();
      if (!up?.meta?.changes) await env.DB.prepare('INSERT INTO settings (key, value, user_id) VALUES (?, ?, ?)').bind(key, String(n), OWNER_ID).run();
    } catch (e) {
      usageBuffer[name] = (usageBuffer[name] || 0) + n;   // keep it for the next flush
    }
  }
}

/** { name: count } for the last `days` days (today included), and the same for today alone. */
async function usageTotals(env, days) {
  const from = new Date(Date.now() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE user_id = ? AND key LIKE 'usage:%'").bind(OWNER_ID).all()).results || [];
  const period = {}, now = {};
  for (const r of rows) {
    const m = /^usage:(\d{4}-\d{2}-\d{2}):(\w+)$/.exec(r.key);
    if (!m || m[1] < from) continue;
    period[m[2]] = (period[m[2]] || 0) + (parseInt(r.value, 10) || 0);
    if (m[1] === today) now[m[2]] = (now[m[2]] || 0) + (parseInt(r.value, 10) || 0);
  }
  return { period, today: now };
}

function usageText(totals, days) {
  const names = Object.keys(USAGE_LABELS);
  const w = Math.max(...names.map(n => USAGE_LABELS[n].length));
  const lines = names.map(n => `${USAGE_LABELS[n].padEnd(w)}  ${String(totals.today[n] || 0).padStart(5)}  ${String(totals.period[n] || 0).padStart(6)}`);
  const head = `${''.padEnd(w)}  ${'сегодня'.padStart(7)}  ${('за ' + days + ' дн.').padStart(8)}`.replace(/^ +/, '');
  const fb = totals.period.llm_fallback || 0, all = names.filter(n => n.startsWith('llm_')).reduce((s, n) => s + (totals.period[n] || 0), 0);
  const warn = all && fb / all > 0.1 ? '\n<i>Разбор без ИИ встречается часто: возможно, кончается бесплатная квота.</i>' : '';
  return `<pre>${escapeHtml(head)}\n${escapeHtml(lines.join('\n'))}</pre>${warn}`;
}

/** Counters for /users and the weekly report: people by status, new people and paid Stars over the last 7 days. */
async function ownerStats(env) {
  const by = {};
  for (const r of (await env.rawDB.prepare('SELECT status, COUNT(*) c FROM users WHERE id != ? GROUP BY status').bind(OWNER_ID).all()).results || []) by[r.status] = r.c;
  const total = Object.values(by).reduce((s, n) => s + n, 0);
  const fresh = (await env.rawDB.prepare("SELECT COUNT(*) c FROM users WHERE id != ? AND created_at >= datetime('now', '-7 days')").bind(OWNER_ID).first())?.c || 0;
  const pay = await env.rawDB.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount), 0) s FROM payments WHERE status = 'paid' AND created_at >= datetime('now', '-7 days')").first();
  return { by, total, fresh, paid: pay?.c || 0, stars: pay?.s || 0 };
}

const STATUS_RU = { new: 'без подписки', trial: 'пробный', active: 'подписка', expired: 'закончилась' };

async function usersCommandText(env) {
  const s = await ownerStats(env);
  const recent = (await env.rawDB.prepare('SELECT id, name, status, sub_until FROM users WHERE id != ? ORDER BY id DESC LIMIT 10').bind(OWNER_ID).all()).results || [];
  const list = recent.map(u => `№${u.id} ${stripEmojis(u.name || 'без имени').slice(0, 24)} — ${STATUS_RU[u.status] || u.status}` +
    (u.sub_until && (u.status === 'active' || u.status === 'trial') ? `, до ${ruDate(sqlMs(u.sub_until), env.tzMs)}` : '')).join('\n');
  return '<i>Люди</i>\n<blockquote>' +
    `Всего: <b>${s.total}</b>\nПробный: ${s.by.trial || 0}, с подпиской: ${s.by.active || 0}\nЗакончилась: ${s.by.expired || 0}, без подписки: ${s.by.new || 0}\n` +
    `За 7 дней: новых ${s.fresh}, оплат ${s.paid} (${s.stars} Stars)</blockquote>` +
    (list ? `\n<i>Последние</i>\n<pre>${escapeHtml(list)}</pre>` : '') +
    '\n<i>Выдать дни: /grant номер дни. Закрыть доступ: /revoke номер. Расход ИИ: /usage.</i>';
}

/** Monday morning (owner's time): one card with the week's numbers. Nothing about anybody's own records. */
async function checkWeeklyOwnerReport(env, chatId, force = false) {
  if (env.uid !== OWNER_ID) return null;
  const local = new Date(Date.now() + env.tzMs);
  if (!force && (local.getUTCDay() !== 1 || local.getUTCHours() < 9)) return null;
  const today = localDateOf(Date.now(), env.tzMs);
  if (!force && (await getSetting(env, 'last_report_date')) === today) return null;
  const s = await ownerStats(env);
  const totals = await usageTotals(env, 7);
  const text = '<i>Неделя в TRACE</i>\n<blockquote>' +
    `Новых людей: <b>${s.fresh}</b>\nОплат: <b>${s.paid}</b> (${s.stars} Stars)\nСейчас: пробный ${s.by.trial || 0}, с подпиской ${s.by.active || 0}, закончилась ${s.by.expired || 0}</blockquote>\n` +
    '<i>Расход ИИ</i>\n' + usageText(totals, 7);
  const res = await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, null, 'HTML');
  if (res && res.ok === false) return null;
  await setSetting(env, 'last_report_date', today);
  try {   // old counters are not needed
    const cutoff = new Date(Date.now() - 40 * DAY_MS).toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM settings WHERE user_id = ? AND key LIKE 'usage:%' AND substr(key, 7, 10) < ?").bind(OWNER_ID, cutoff).run();
  } catch (e) {}
  return { date: today };
}

/** Journal of who gave or took back access (owner's settings `audit:<time>:<random>`, plain text, no records of anybody). */
async function auditLog(env, text) {
  try {
    const key = `audit:${new Date().toISOString()}:${Math.random().toString(36).slice(2, 6)}`;
    await setSetting(scopeEnv(env, OWNER), key, String(text).slice(0, 200));
    const cutoff = new Date(Date.now() - 180 * DAY_MS).toISOString();
    await env.DB.prepare("DELETE FROM settings WHERE user_id = ? AND key LIKE 'audit:%' AND substr(key, 7, 24) < ?").bind(OWNER_ID, cutoff).run();
  } catch (e) {
    console.warn('audit log skipped:', e.message);
  }
}

async function journalText(env) {
  const rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE user_id = ? AND key LIKE 'audit:%' ORDER BY key DESC LIMIT 15").bind(OWNER_ID).all()).results || [];
  if (!rows.length) return '<i>Журнал пуст: выдач и возвратов ещё не было.</i>';
  const lines = rows.map(r => `${ruDate(Date.parse(r.key.slice(6, 30)), env.tzMs)} ${r.value}`).join('\n');
  return `<i>Журнал (последние 15)</i>\n<pre>${escapeHtml(lines)}</pre>`;
}
/** /grant <number> [days] and /revoke <number>: by the person's number from /users. Owner only (checked by the caller). */
async function adminGrant(env, arg) {
  const [idStr, daysStr] = String(arg || '').trim().split(/\s+/);
  const id = parseInt(idStr, 10);
  const days = daysStr ? parseInt(daysStr, 10) : (await subscriptionPlan(env)).days;
  if (!id || !(days >= 1 && days <= 365)) return { error: 'Пример: /grant 5 30 (номер человека из /users и число дней от 1 до 365)' };
  const target = id === OWNER_ID ? null : await env.rawDB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) return { error: `Человека №${id} нет` };
  const until = await grantSubscription(env, target, days);
  await auditLog(env, `grant №${id} +${days} дн.`);
  if (target.telegram_id) {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, target.telegram_id,
      `<i>Вам включён доступ</i>\n<blockquote>Подписка действует до <b>${ruDate(until, 3 * 3600000)}</b>.</blockquote>`, null, 'HTML');
  }
  return { ok: true, text: `Человеку №${id} добавлено ${days} дн. Доступ до ${ruDate(until, env.tzMs)}.` };
}

async function adminRevoke(env, arg) {
  const id = parseInt(String(arg || '').trim(), 10);
  if (!id) return { error: 'Пример: /revoke 5 (номер человека из /users)' };
  const target = id === OWNER_ID ? null : await env.rawDB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) return { error: `Человека №${id} нет` };
  await env.rawDB.prepare("UPDATE users SET status = 'expired', sub_until = datetime('now'), sub_notice = NULL WHERE id = ?").bind(id).run();
  await auditLog(env, `revoke №${id}`);
  if (target.telegram_id) {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, target.telegram_id,
      `<i>Доступ закрыт</i>\n<blockquote>Свои записи можно смотреть, править и удалять, новые добавлять нельзя.</blockquote>${supportLine(env)}`, null, 'HTML');
  }
  return { ok: true, text: `Доступ человека №${id} закрыт.` };
}

/** Text of /status and the matching button. */
async function subscriptionCard(env) {
  const user = env.user;
  const state = subscriptionState(user);
  const plan = await subscriptionPlan(env);
  const until = sqlMs(user.sub_until);
  const left = Number.isFinite(until) ? Math.max(0, Math.ceil((until - Date.now()) / DAY_MS)) : null;
  const when = Number.isFinite(until) ? ruDate(until, env.tzMs) : '';
  const price = `${plan.priceStars} Stars на ${plan.days} ${ruDays(plan.days)}`;
  if (state === 'owner') return { text: '<i>Подписка</i>\n<blockquote>Вы владелец: доступ без ограничений.</blockquote>', markup: null };
  if (state === 'trial' || state === 'active') {
    const name = state === 'trial' ? 'Пробный период' : 'Подписка';
    const limit = dailyLimitFor(state, await subscriptionLimits(env));
    return {
      text: `<i>${name}</i>\n<blockquote>Действует до <b>${when}</b>${left !== null ? ` (осталось ${left} ${ruDays(left)})` : ''}.\nЗаписей сегодня: ${usedToday(user, env)} из ${limit}.</blockquote>`,
      markup: subscribeMarkup(`Продлить: ${price}`)
    };
  }
  if (state === 'expired') {
    return { text: `<i>Подписка закончилась</i>\n<blockquote>${when ? `Была до ${when}. ` : ''}Старые записи можно смотреть, новые не сохраняются. Продлить?</blockquote>`, markup: subscribeMarkup(`Продлить: ${price}`) };
  }
  const offer = await accessOffer(env);
  return { text: `<i>Подписки нет</i>\n<blockquote>${escapeHtml(offer.line)}\nСтоимость: ${price}.</blockquote>`, markup: { inline_keyboard: offer.rows } };
}

const supportLine = (env) => env.SUPPORT_CONTACT ? `\n\nПоддержка: ${escapeHtml(env.SUPPORT_CONTACT)}` : '';

/** Reminder 3 and 1 days before the end (a trial: only the last one). Once per end date and stage; daytime only. */
async function checkSubscriptionReminder(env, chatId) {
  const user = env.user;
  if (!user || user.role === 'owner') return null;
  const state = subscriptionState(user);
  if (state !== 'trial' && state !== 'active') return null;
  const until = sqlMs(user.sub_until);
  if (!Number.isFinite(until)) return null;
  const stages = [...SUBSCRIPTION_DEFAULTS.REMIND_DAYS_BEFORE].sort((a, b) => a - b);
  const stage = stages.find(n => until - Date.now() <= n * DAY_MS);
  if (!stage || (state === 'trial' && stage !== stages[0])) return null;
  const key = `${user.sub_until}|${stage}`;
  if (user.sub_notice === key) return null;
  const hour = new Date(Date.now() + env.tzMs).getUTCHours();
  if (hour < 9 || hour >= 22) return null;
  const left = Math.max(1, Math.ceil((until - Date.now()) / DAY_MS));
  const plan = await subscriptionPlan(env);
  const name = state === 'trial' ? 'Пробный период заканчивается' : 'Подписка заканчивается';
  const res = await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId,
    `<i>${name}</i>\n<blockquote>Осталось ${left} ${ruDays(left)}, до <b>${ruDate(until, env.tzMs)}</b>.</blockquote>`,
    subscribeMarkup(`Продлить: ${plan.priceStars} Stars на ${plan.days} ${ruDays(plan.days)}`), 'HTML');
  if (!res?.ok) return null;
  await env.rawDB.prepare('UPDATE users SET sub_notice = ? WHERE id = ?').bind(key, user.id).run();
  user.sub_notice = key;
  return key;
}

/** GET /api/subscription: what the Mini App shows in Settings. */
async function getSubscriptionInfo(env) {
  const user = env.rawDB ? await env.rawDB.prepare('SELECT * FROM users WHERE id = ?').bind(env.uid).first() : env.user;
  const fresh = { ...env.user, ...user };
  const plan = await subscriptionPlan(env);
  const limits = await subscriptionLimits(env);
  const until = sqlMs(fresh.sub_until);
  const state = subscriptionState(fresh);
  return jsonResponse({
    ok: true,
    state,
    sub_until: Number.isFinite(until) ? new Date(until).toISOString() : null,
    price_stars: plan.priceStars,
    period_days: plan.days,
    daily_limit: dailyLimitFor(state, limits),
    used_today: usedToday(fresh, env),
    can_start_trial: state === 'new' && !fresh.trial_used && limits.trialDays > 0,
    trial_days: limits.trialDays,
    support: env.SUPPORT_CONTACT || null
  });
}

/** POST /api/subscription/invoice: a payment link for Telegram.WebApp.openInvoice(). */
async function createSubscriptionLink(env) {
  const p = activeProvider();
  const res = await p.invoiceLink(env, p.invoice(env.user, await subscriptionPlan(env)));
  if (!res?.ok || !res.result) return errorResponse('Не получилось выставить счёт', 502);
  return jsonResponse({ ok: true, link: res.result });
}

// ================= Access and limits (PLAN-SUBSCRIPTIONS.md, stage 5) =================
// States: owner (no limits) | trial (3 days, 5 records a day) | active (30 a day) | expired (view only) | new (view only, can start the trial).
// A "record" that is counted against the daily limit = anything that goes through the AI pipeline: voice hook, /api/capture,
// a voice or text message to the bot. Without access NOTHING NEW can be created (not by the AI, not by hand), but one's own records
// can still be looked at, edited and deleted (REST, buttons of the bot). Hand-made creation with access is not counted.
// A record that failed (nothing recognised, the AI or the server broke) gives its place back, up to twice the limit a day.

/** Trial length and daily limits: the owner's settings `trial_days`, `trial_daily_limit`, `daily_record_limit`, else the defaults. */
async function subscriptionLimits(env) {
  const out = { trialDays: SUBSCRIPTION_DEFAULTS.TRIAL_DAYS, trialDaily: SUBSCRIPTION_DEFAULTS.TRIAL_DAILY_LIMIT, daily: SUBSCRIPTION_DEFAULTS.DAILY_RECORD_LIMIT };
  try {
    const rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE user_id = ? AND key IN ('trial_days', 'trial_daily_limit', 'daily_record_limit')")
      .bind(OWNER_ID).all()).results || [];
    for (const r of rows) {
      const n = parseInt(r.value, 10);
      if (!(n >= 0)) continue;
      if (r.key === 'trial_days') out.trialDays = n;                     // 0 switches the trial off
      else if (n >= 1) out[r.key === 'trial_daily_limit' ? 'trialDaily' : 'daily'] = n;
    }
  } catch (e) {}
  return out;
}

const localDay = (env) => new Date(Date.now() + env.tzMs).toISOString().slice(0, 10);
const usedToday = (user, env) => (user.daily_date === localDay(env) ? Number(user.daily_count) || 0 : 0);
const dailyLimitFor = (state, limits) => (state === 'trial' ? limits.trialDaily : state === 'active' ? limits.daily : null);

const buyButton = (plan, label) => [{ text: `${label}: ${plan.priceStars} Stars на ${plan.days} ${ruDays(plan.days)}`, callback_data: 'sub_buy' }];

/** What to tell (and offer) a person who cannot record: the trial if they still have it, else the payment. */
async function accessOffer(env) {
  const state = subscriptionState(env.user);
  if (state === 'owner' || state === 'trial' || state === 'active') return { line: '', rows: [] };
  const plan = await subscriptionPlan(env);
  if (state === 'new' && !env.user.trial_used) {
    const limits = await subscriptionLimits(env);
    if (limits.trialDays > 0) {
      return {
        line: `Доступ к записи пока закрыт: нужна подписка. Можно сначала попробовать: пробный период ${limits.trialDays} ${ruDays(limits.trialDays)}, до ${limits.trialDaily} записей в день.`,
        rows: [[{ text: `Начать пробный период: ${limits.trialDays} ${ruDays(limits.trialDays)}`, callback_data: 'trial_start' }], buyButton(plan, 'Оформить подписку')]
      };
    }
  }
  return state === 'expired'
    ? { line: 'Подписка закончилась. Продлить?', rows: [buyButton(plan, 'Продлить')] }
    : { line: NO_ACCESS_TEXT, rows: [buyButton(plan, 'Оформить подписку')] };
}

/**
 * May this person record right now? With count (the default) a granted record is also counted against the day's limit
 * in ONE statement, so two records at the same moment cannot both take the last place.
 * Returns { ok: true } or { ok: false, reason, status, text, markup }.
 */
async function recordingGate(env, { count = true } = {}) {
  const user = env.user;
  const state = subscriptionState(user);
  if (state === 'owner') return { ok: true };
  if (state !== 'trial' && state !== 'active') {
    const offer = await accessOffer(env);
    return { ok: false, reason: state, status: 403, text: offer.line, markup: offer.rows.length ? { inline_keyboard: offer.rows } : null };
  }
  if (!count) return { ok: true };
  const limits = await subscriptionLimits(env);
  const limit = dailyLimitFor(state, limits);
  const day = localDay(env);
  const took = await env.rawDB.prepare(
    'UPDATE users SET daily_count = CASE WHEN daily_date = ? THEN daily_count + 1 ELSE 1 END, ' +
    'daily_fails = CASE WHEN daily_date = ? THEN daily_fails ELSE 0 END, daily_date = ? ' +
    'WHERE id = ? AND (daily_date IS NULL OR daily_date <> ? OR daily_count < ?)'
  ).bind(day, day, day, user.id, day, limit).run();
  if (took?.meta?.changes) return { ok: true };
  const plan = await subscriptionPlan(env);
  const text = state === 'trial'
    ? `Дневной лимит пробного периода исчерпан (${limit} из ${limit}). Завтра счётчик обнулится, а с подпиской можно ${limits.daily} записей в день.`
    : `Дневной лимит записей исчерпан (${limit} из ${limit}). Завтра счётчик обнулится.`;
  return { ok: false, reason: 'limit', status: 429, text, markup: state === 'trial' ? { inline_keyboard: [buyButton(plan, 'Оформить подписку')] } : null };
}

/**
 * A record that did not work out (not recognised, the AI or the server failed, nothing was saved) gives its place back,
 * so the person just says it again. At most twice the day's limit of such returns, so failures cannot be used to get around the limit.
 */
async function releaseRecordingSlot(env) {
  try {
    const state = env.user ? subscriptionState(env.user) : 'owner';
    if (state !== 'trial' && state !== 'active') return;
    const limit = dailyLimitFor(state, await subscriptionLimits(env));
    await env.rawDB.prepare(
      'UPDATE users SET daily_count = daily_count - 1, daily_fails = daily_fails + 1 WHERE id = ? AND daily_date = ? AND daily_count > 0 AND daily_fails < ?'
    ).bind(env.user.id, localDay(env), limit * 2).run();
  } catch (e) {
    console.error('releaseRecordingSlot failed:', e);
  }
}

/** Starts the free trial once per person. Returns { ok, until } or { ok: false, error }. */
async function startTrial(env) {
  const user = env.user;
  const limits = await subscriptionLimits(env);
  if (subscriptionState(user) !== 'new' || user.trial_used || limits.trialDays <= 0) {
    return { ok: false, error: limits.trialDays <= 0 ? 'Пробный период сейчас не предлагается' : 'Пробный период уже был' };
  }
  const until = Date.now() + limits.trialDays * DAY_MS;
  const res = await env.rawDB.prepare(
    "UPDATE users SET status = 'trial', trial_used = 1, sub_until = ?, sub_notice = NULL WHERE id = ? AND status = 'new' AND trial_used = 0 AND role <> 'owner'"
  ).bind(msToSql(until), user.id).run();
  if (!res?.meta?.changes) return { ok: false, error: 'Пробный период уже был' };
  user.status = 'trial'; user.trial_used = 1; user.sub_until = msToSql(until);
  return { ok: true, until, days: limits.trialDays, daily: limits.trialDaily };
}

const trialStartedText = (r, env) =>
  `<i>Пробный период начался</i>\n<blockquote>До <b>${ruDate(r.until, env.tzMs)}</b>, до ${r.daily} записей в день. Просто скажите или напишите: «кофе 50к».</blockquote>`;

/**
 * Subscriptions that ran out: mark them expired and say so once, in the person's daytime
 * (until then they are already view-only; the status is derived from the date).
 */
async function notifyEndedSubscriptions(env) {
  const ended = (await env.DB.prepare(
    "SELECT * FROM users WHERE role <> 'owner' AND status IN ('trial', 'active') AND sub_until IS NOT NULL AND sub_until <= datetime('now') ORDER BY sub_until LIMIT 50"
  ).all()).results || [];
  const notified = [];
  for (const person of ended) {
    try {
      const uenv = await userEnv(env, person);
      const hour = new Date(Date.now() + uenv.tzMs).getUTCHours();
      if (person.telegram_id && (hour < 9 || hour >= 22)) continue;
      const claim = await env.DB.prepare("UPDATE users SET status = 'expired', sub_notice = NULL WHERE id = ? AND status IN ('trial', 'active')").bind(person.id).run();
      if (!claim?.meta?.changes || !person.telegram_id) continue;
      const plan = await subscriptionPlan(uenv);
      const name = person.status === 'trial' ? 'Пробный период закончился' : 'Подписка закончилась';
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, person.telegram_id,
        `<i>${name}</i>\n<blockquote>Старые записи остаются, их можно смотреть. Чтобы записывать дальше, оформите подписку.</blockquote>`,
        { inline_keyboard: [buyButton(plan, 'Продлить')] }, 'HTML');
      notified.push(person.id);
    } catch (e) {
      console.error(`Ended-subscription notice failed for user ${person.id}:`, e);
    }
  }
  return notified;
}

async function verifyTelegramInitData(initData, env) {
  const user = await parseTelegramInitData(initData, env);
  return user?.id ? String(user.id) : null;
}

/** Checks the signature of Mini App initData; returns { id, name } of the Telegram user or null. */
async function parseTelegramInitData(initData, env) {
  if (!initData || !env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const secret = await hmacSha256(new TextEncoder().encode('WebAppData'), env.TELEGRAM_BOT_TOKEN);
    const sig = await hmacSha256(secret, dataCheckString);
    const hex = [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
    if (!safeEqual(hex, hash)) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
    const user = JSON.parse(params.get('user') || 'null');
    return user?.id ? { id: String(user.id), name: user.first_name || user.username || '' } : null;
  } catch (e) {
    return null;
  }
}

/**
 * Who is calling: { user, kind } or null. The old AUTH_TOKEN is the owner (the iPhone Shortcut keeps working),
 * a personal token (users.token) is that user, Telegram initData is the Telegram user it names.
 * The user id never comes from the request body or the URL.
 */
async function resolveUser(request, env) {
  const url = new URL(request.url);
  const authHeader = request.headers.get('Authorization') || '';
  const fromHeaders = [
    authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '',
    request.headers.get('X-Token') || ''
  ].filter(Boolean);
  // The owner's own link may carry ?token= (browser); a personal token never travels in an address (addresses end up in logs)
  const candidates = [...fromHeaders, url.searchParams.get('token') || ''].filter(Boolean);
  if (env.AUTH_TOKEN && candidates.some(c => safeEqual(c, env.AUTH_TOKEN))) return { user: OWNER, kind: 'token' };

  if (env.DB) {
    for (const c of fromHeaders) {
      if (c.length < 20 || c.startsWith(TOKEN_HASH_PREFIX)) continue;   // personal tokens are long random strings; a stored hash is never a token
      // Tokens are kept only as a hash (checked in prod 02.11.2026: no open-text tokens were left, so that path is gone)
      const row = await env.DB.prepare('SELECT * FROM users WHERE token = ?').bind(TOKEN_HASH_PREFIX + await sha256Hex(c)).first();
      if (row) return { user: row.id === OWNER_ID ? OWNER : row, kind: 'token' };
    }
  }

  const tg = await parseTelegramInitData(request.headers.get('X-Telegram-Init-Data'), env);
  if (tg && env.DB) {
    const user = await userForTelegram(env, tg.id, tg.name);
    if (user) return { user, kind: 'telegram' };
  }
  return null;
}

// ================= Personal token for the iPhone Shortcut (PLAN-SUBSCRIPTIONS.md, stage 6b) =================
// The token is shown once and kept only as a hash in users.token ("h:" + sha256). Reissuing replaces it (the old one stops working).
const TOKEN_HASH_PREFIX = 'h:';

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function issueToken(env) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await env.rawDB.prepare('UPDATE users SET token = ? WHERE id = ?').bind(TOKEN_HASH_PREFIX + await sha256Hex(token), env.uid).run();
  return token;
}

async function hasToken(env) {
  return !!(await env.rawDB.prepare('SELECT token FROM users WHERE id = ?').bind(env.uid).first())?.token;
}

/** The steps for building the button on the iPhone, as plain lines (the bot and the Mini App show the same list). */
function shortcutSteps(env, origin) {
  const hook = `${origin}/api/voice-hook`;
  const ready = env.SHORTCUT_URL ? [`Откройте готовую команду и нажмите «Добавить команду»: ${env.SHORTCUT_URL}`, 'Когда она спросит токен, вставьте его. Если кнопка «Добавить» не нажимается, выберите «Пропустить настройку», откройте добавленную команду и вставьте токен в действие «Текст».'] : [];
  return {
    ready,
    // Where to put the finished command so that one press starts the recording
    placement: [
      'Кнопка действия (iPhone 15 Pro и новее): Настройки → Кнопка действия → листайте до «Быстрая команда» → «Выбрать быструю команду» → выберите добавленную команду.',
      'Экран «Домой» (любой iPhone): в приложении «Команды» откройте команду, нажмите (i) → «Добавить на экран «Домой»» → «Добавить».',
      'Касание задней панели (iPhone 8 и новее): Настройки → Универсальный доступ → Касание → Касание задней панели → «Двойное касание» → выберите команду.'
    ],
    manual: [
      'Откройте на iPhone приложение «Команды» и нажмите «+».',
      'Добавьте действие «Текст» и впишите в него ваш токен.',
      'Добавьте действие «Записать аудио».',
      'Добавьте действие «Получить содержимое URL». Адрес: ' + hook + '. Метод: POST. Тело запроса: «Файл», выберите «Записанное аудио».',
      'В этом же действии откройте «Заголовки» и добавьте один: ключ X-Token, значение — результат действия «Текст».',
      'Назовите команду, например «TRACE», и вынесите её на главный экран или на кнопку действия. Ответ придёт карточкой в Telegram.'
    ]
  };
}

/** GET /api/shortcut: is a token issued, and the steps. POST /api/token: issue (or reissue) it, shown once. */
async function getShortcutInfo(env, url) {
  return jsonResponse({ ok: true, has_token: await hasToken(env), hook_url: `${url.origin}/api/voice-hook`, ...shortcutSteps(env, url.origin) });
}

// ================= Terms and deleting one's data (stage 8) =================
// The wording was agreed with the owner on 02.11.2026 (PLAN-SUBSCRIPTIONS.md). Refund: 7 days and at most REFUND_MAX_RECORDS records.
const REFUND_DAYS = 7;
const REFUND_MAX_RECORDS = 10;

/** The terms as [title, text] pairs: the bot shows them as a card, the Mini App renders the same list from GET /api/terms. */
async function termsSections(env) {
  const plan = await subscriptionPlan(env);
  const limits = await subscriptionLimits(env);
  const support = env.SUPPORT_CONTACT ? ` Поддержка: ${env.SUPPORT_CONTACT}.` : '';
  return [
    ['Что это', `TRACE записывает ваши траты, задачи и заметки по голосу или тексту. Доступ платный: ${plan.priceStars} Stars на ${plan.days} ${ruDays(plan.days)}. ` +
      `Сначала есть пробный период ${limits.trialDays} ${ruDays(limits.trialDays)}, до ${limits.trialDaily} записей в день. С подпиской можно до ${limits.daily} записей в день.`],
    ['Какие данные хранятся', 'Ваши траты, задачи, заметки, слова, настройки (валюта, город) и ваш номер в Telegram. Всё лежит в базе Cloudflare. Голосовое аудио не сохраняется.'],
    ['Куда уходит фраза', 'Чтобы понять речь и разложить её на траты и задачи, фраза во время обработки передаётся сервисам Groq, Google Gemini и Cloudflare AI. В журналах TRACE текст ваших фраз не хранится.'],
    ['Кто видит данные', 'Владелец сервиса технически имеет доступ к базе, но не читает чужие записи. Для работы ему доступны только счётчики: сколько людей, у кого какая подписка, сколько запросов.'],
    ['Копии', 'Cloudflare хранит историю базы 7 дней, чтобы восстановиться после сбоя. После удаления данные могут ещё до 7 дней лежать в служебных копиях.'],
    ['Удаление', 'Команда /delete_me в боте или кнопка «Удалить все мои данные» в Настройках стирает ваши записи безвозвратно. Остаются только платежи (нужны для возвратов) и дата конца подписки.'],
    ['Возврат денег', `В течение ${REFUND_DAYS} дней после оплаты, если вы сделали не больше ${REFUND_MAX_RECORDS} записей. Если пользовались больше, деньги не возвращаются. ` +
      `Исключение: сервис не работал по нашей вине. Напишите в поддержку (/paysupport).${support} После возврата доступ заканчивается.`],
    ['Без подписки', 'Свои записи можно смотреть, править и удалять. Создавать новые нельзя.'],
    ['Без гарантий', 'Сервис работает в бета-режиме. ИИ может ошибиться в сумме или дате, проверяйте записи. Мы не отвечаем за потерю данных и можем менять цену и лимиты, предупредив заранее.']
  ];
}

function termsCardHtml(sections) {
  return '<b>Условия и данные TRACE</b>\n\n' + sections.map(([title, text]) => `<i>${escapeHtml(title)}</i>\n${escapeHtml(text)}`).join('\n\n') +
    '\n\nУдалить все свои данные: /delete_me';
}

/**
 * Erases everything a person has recorded. Kept on purpose: the user row (so the subscription and the used trial survive and
 * "delete + start again" is no way to get a second trial or a fresh daily limit) and the payments (needed for refunds); the personal token is cleared.
 * The owner cannot do this to himself.
 */
async function deleteMyData(env) {
  if (env.uid === OWNER_ID) return { ok: false, error: 'Данные владельца так не удаляются.' };
  for (const table of ['finances', 'tasks', 'notes', 'vocabulary', 'word_groups', 'recurring', 'request_logs', 'settings']) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(env.uid).run();
  }
  await env.rawDB.prepare('UPDATE users SET token = NULL, name = NULL WHERE id = ?').bind(env.uid).run();
  await auditLog(env, `delete_me: человек №${env.uid} удалил свои данные`);
  return { ok: true };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // Handle CORS Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // 1. FRONTEND: Telegram Mini App
      if ((url.pathname === '/' || url.pathname === '/app') && (method === 'GET' || method === 'HEAD')) {
        return new Response(method === 'HEAD' ? null : APP_HTML, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': PAGE_CSP,
            ...CORS_HEADERS,
            'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'ETag': `"v${BUILD_VERSION}"`
          }
        });
      }

      // 2. HEALTHCHECK & TEST TRIGGER
      if (url.pathname === '/api/health') {
        return jsonResponse({
          ok: true,
          app: env.APP_NAME || 'TRACE Copilot',
          model: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
          time: new Date().toISOString()
        });
      }

      // Size and speed limits (before any work is done). Telegram's own webhook is exempt from the speed limit.
      const ip = request.headers.get('CF-Connecting-IP') || '';   // Cloudflare always sets it; without it (tests) no speed limit
      if (url.pathname.startsWith('/api/') && method !== 'GET' && method !== 'HEAD') {
        const sizeLimit = AUDIO_PATHS.has(url.pathname) ? MAX_AUDIO_BODY : MAX_JSON_BODY;
        if (Number(request.headers.get('content-length') || 0) > sizeLimit) return errorResponse('Request too large', 413);
      }
      if (ip && url.pathname.startsWith('/api/') && url.pathname !== '/api/telegram-webhook' && url.pathname !== '/api/health') {
        // Wrong tokens: a guessing robot is stopped after a few tries from one address
        if (rateOver(`bad:${ip}`, RATE.badAuth)) return rateLimited();
        if (rateHit(`ip:${ip}`, RATE.perIp)) return rateLimited();
      }

      // Everything below except the voice hook and Telegram webhook (own checks) requires auth
      // From here on `env` belongs to ONE user (env.uid); every query below is filtered by it.
      let authKind = null;
      // /api/set-webhook is opened by the webhook secret itself (X-Setup-Key) or by the owner's usual login
      const setupKeyOk = url.pathname === '/api/set-webhook' && !!env.TELEGRAM_WEBHOOK_SECRET &&
        safeEqual(request.headers.get('X-Setup-Key'), env.TELEGRAM_WEBHOOK_SECRET);
      if (setupKeyOk) {
        env = await userEnv(env, OWNER);
      } else if (url.pathname.startsWith('/api/') && url.pathname !== '/api/voice-hook' && url.pathname !== '/api/telegram-webhook') {
        const who = await resolveUser(request, env);
        if (!who) { if (ip) rateHit(`bad:${ip}`, RATE.badAuth); return errorResponse('Unauthorized', 401); }
        authKind = who.kind;
        env = await userEnv(env, who.user);
        if (ip && env.uid !== OWNER_ID && rateHit(`u:${env.uid}`, RATE.perUser)) return rateLimited();

        // Without access (new, trial/subscription over) nothing NEW can be created, by hand or through the AI:
        // looking, editing and deleting one's own records stay open. /api/capture checks (and counts) the access itself.
        if (method === 'POST' && CREATE_PATHS.has(url.pathname)) {
          const gate = await recordingGate(env, { count: false });
          if (!gate.ok) return jsonResponse({ ok: false, error: gate.text, code: 'subscription_required', reason: gate.reason }, gate.status);
          // A ceiling on how much one person can store by hand (the owner has none)
          const rows = ROW_CAPS[url.pathname];
          if (rows && env.uid !== OWNER_ID && (await env.DB.prepare(rows.sql).bind(env.uid).first())?.c >= rows.cap) {
            return errorResponse('Достигнут предел записей. Удалите ненужные или напишите в поддержку.', 409);
          }
        }
      }

      if (url.pathname === '/api/cron-trigger') {
        if (env.uid !== OWNER_ID) return errorResponse('Forbidden', 403);
        const forceVocab = url.searchParams.get('vocab') === '1' || url.searchParams.get('force') === 'true';
        const forceDigest = url.searchParams.get('digest') === '1' || url.searchParams.get('force') === 'true';
        const forceMorning = url.searchParams.get('morning') === '1';
        const result = await checkAndSendReminders(env, { forceVocab, forceDigest, forceMorning });
        return jsonResponse({ ok: true, result });
      }

      // Re-register the bot's webhook with the secret ("password" Telegram attaches to every message) and only the
      // update kinds the bot uses. The bot token never leaves the worker. Owner only.
      if (url.pathname === '/api/set-webhook' && method === 'POST') {
        if (env.uid !== OWNER_ID) return errorResponse('Forbidden', 403);
        if (!env.TELEGRAM_WEBHOOK_SECRET) return errorResponse('TELEGRAM_WEBHOOK_SECRET is not set', 400);
        const res = await telegramCall(env, 'setWebhook', {
          url: `${url.origin}/api/telegram-webhook`,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
          drop_pending_updates: false
        });
        return jsonResponse({ ok: !!res?.ok, description: res?.description || null });
      }

      if (url.pathname === '/api/sync-user' && method === 'POST') {
        const body = await readJson(request);
        if (env.uid !== OWNER_ID) return errorResponse('Forbidden', 403);
        if (body.chat_id && env.DB) {
          const owner = await getOwnerChatId(env);
          if (owner && authKind !== 'token' && String(body.chat_id) !== owner) {
            return errorResponse('Forbidden', 403);
          }
          await setSetting(env, 'telegram_chat_id', body.chat_id);
          await env.rawDB.prepare('UPDATE users SET telegram_id = ? WHERE id = ?').bind(Number(body.chat_id), OWNER_ID).run();
          await checkAndSendReminders(env);
        }
        return jsonResponse({ ok: true, synced: body.chat_id });
      }

      // 3. CORE: Apple Shortcuts Voice Hook
      if (url.pathname === '/api/voice-hook' && method === 'POST') {
        return await handleVoiceHook(request, env);
      }

      // 3b. Quick capture from the Mini App (same pipeline, app auth already checked above)
      if (url.pathname === '/api/capture' && method === 'POST') {
        return await handleVoiceHook(request, env, { trusted: true });
      }

      // 4. TELEGRAM BOT: Webhook handler
      if (url.pathname === '/api/telegram-webhook' && method === 'POST') {
        return await handleTelegramWebhook(request, env, url, ctx);
      }

      // 5. REST API: Finances
      if (url.pathname === '/api/finances') {
        if (method === 'GET') return await getFinances(request, env, url);
        if (method === 'POST') return await addFinance(request, env);
      }
      if (url.pathname.startsWith('/api/finances/')) {
        const id = url.pathname.split('/')[3];
        if (method === 'DELETE') return await deleteFinance(env, id);
        if (method === 'PUT' || method === 'PATCH') return await updateFinance(request, env, id);
      }

      if (url.pathname === '/api/settings') {
        if (method === 'GET') return await getSettings(env, url);
        if (method === 'PUT' || method === 'PATCH') return await saveSettings(request, env, url);
      }

      if (url.pathname === '/api/shortcut' && method === 'GET') return await getShortcutInfo(env, url);
      if (url.pathname === '/api/token' && method === 'POST') {
        // Only from inside Telegram: a stolen token must not be able to issue itself a replacement and lock the person out
        if (authKind !== 'telegram') return errorResponse('Forbidden', 403);
        return jsonResponse({ ok: true, token: await issueToken(env) });
      }
      if (url.pathname === '/api/terms' && method === 'GET') return jsonResponse({ ok: true, sections: await termsSections(env) });
      if (url.pathname === '/api/account/delete' && method === 'POST') {
        // Only from inside Telegram and only with an explicit confirmation: a stolen token must not be able to wipe the account
        if (authKind !== 'telegram') return errorResponse('Forbidden', 403);
        const body = await readJson(request);
        if (body.confirm !== true) return errorResponse('Нужно подтверждение', 400);
        const res = await deleteMyData(env);
        return res.ok ? jsonResponse({ ok: true }) : errorResponse(res.error, 409);
      }
      if (url.pathname === '/api/subscription' && method === 'GET') return await getSubscriptionInfo(env);
      if (url.pathname === '/api/subscription/invoice' && method === 'POST') return await createSubscriptionLink(env);
      if (url.pathname === '/api/subscription/trial' && method === 'POST') {
        const res = await startTrial(env);
        return res.ok ? jsonResponse({ ok: true, sub_until: new Date(res.until).toISOString(), days: res.days, daily_limit: res.daily }) : errorResponse(res.error, 409);
      }

      // 6. REST API: Tasks
      if (url.pathname === '/api/tasks') {
        if (method === 'GET') return await getTasks(request, env, url);
        if (method === 'POST') return await addTask(request, env);
      }
      if (url.pathname.startsWith('/api/tasks/')) {
        const id = url.pathname.split('/')[3];
        if (url.pathname.endsWith('/toggle') && (method === 'PATCH' || method === 'POST')) {
          return await toggleTask(env, id);
        }
        if (method === 'DELETE') return await deleteTask(env, id);
        if (method === 'PUT' || method === 'PATCH') return await updateTask(request, env, id);
      }

      // 6b. REST API: Recurring payments
      if (url.pathname === '/api/recurring') {
        if (method === 'GET') return await getRecurring(env);
        if (method === 'POST') return await addRecurring(request, env);
      }
      if (url.pathname.startsWith('/api/recurring/')) {
        const id = url.pathname.split('/')[3];
        if (method === 'DELETE') return await deleteRecurring(env, id);
        if (method === 'PUT' || method === 'PATCH') return await updateRecurring(request, env, id);
      }

      // 6c. REST API: Debts
      if (url.pathname === '/api/debts' && method === 'GET') return await getDebts(env, url);
      if (url.pathname.startsWith('/api/debts/') && url.pathname.endsWith('/pay') && (method === 'POST' || method === 'PATCH')) {
        return await payDebt(request, env, url.pathname.split('/')[3]);
      }

      // 7. REST API: Notes & Memory
      if (url.pathname === '/api/notes') {
        if (method === 'GET') return await getNotes(request, env, url);
        if (method === 'POST') return await addNote(request, env);
      }
      if (url.pathname.startsWith('/api/notes/')) {
        const id = url.pathname.split('/')[3];
        if (method === 'DELETE') return await deleteNote(env, id);
        if (method === 'PUT' || method === 'PATCH') return await updateNote(request, env, id);
      }

      // 8. REST API: Vocabulary
      if (url.pathname === '/api/vocabulary') {
        if (method === 'GET') return await getVocabulary(request, env);
        if (method === 'POST') return await addVocabulary(request, env);
      }
      if (url.pathname.startsWith('/api/vocabulary/')) {
        const id = url.pathname.split('/')[3];
        if (method === 'DELETE') return await deleteVocabulary(env, id);
        if (method === 'PUT' || method === 'PATCH') return await updateVocabulary(request, env, id);
      }

      // 8b. REST API: Top-1000 words (groups of 20, tests); the list lives in code, only progress is in D1
      if (url.pathname === '/api/top-words' && method === 'GET') return await getTopWords(env);
      if (url.pathname === '/api/top-words/progress' && method === 'POST') return await saveTopWordsProgress(request, env);

      // 9. REST API: Review Queue
      if (url.pathname === '/api/review') {
        if (method === 'GET') return await getReviewItems(env);
      }
      if (url.pathname === '/api/review/confirm' && method === 'POST') {
        return await confirmReviewItem(request, env);
      }
      if (url.pathname === '/api/review/merge' && method === 'POST') {
        return await mergeReviewItem(request, env);
      }
      if (url.pathname === '/api/review/reject' && method === 'POST') {
        return await rejectReviewItem(request, env);
      }

      return errorResponse('Endpoint not found', 404);
    } catch (err) {
      if (err instanceof SyntaxError) return errorResponse('Invalid JSON body', 400);
      if (err instanceof LimitError) return errorResponse(err.message, 413);
      console.error('Unhandled worker error:', err);
      return errorResponse(publicError(env, err), 500);
    }
  },

  // Cloudflare Cron Trigger (Runs every minute to trigger scheduled reminders)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCronForAllUsers(env));
    ctx.waitUntil(cleanupRequestLogs(env));
  }
};

/**
 * Helpers for Audio Processing
 */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function parseCleanJson(text) {
  if (!text || typeof text !== 'string') return null;
  let clean = text.trim();
  // Strip markdown code fences anywhere in the string
  clean = clean.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  try {
    const direct = JSON.parse(clean);
    return Array.isArray(direct) ? (direct[0] || null) : direct;
  } catch (e) {}

  // Extract JSON object { ... } or array [ ... ]
  const firstBrace = clean.indexOf('{');
  const firstBracket = clean.indexOf('[');
  let startIdx = -1;
  let endChar = '}';
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endChar = '}';
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endChar = ']';
  }

  if (startIdx !== -1) {
    const lastIdx = clean.lastIndexOf(endChar);
    if (lastIdx > startIdx) {
      let candidate = clean.slice(startIdx, lastIdx + 1).trim();
      try {
        const p = JSON.parse(candidate);
        return Array.isArray(p) ? (p[0] || null) : p;
      } catch (e1) {
        // Fix trailing commas before } or ]
        candidate = candidate.replace(/,\s*([\}\]])/g, '$1');
        try {
          const p = JSON.parse(candidate);
          return Array.isArray(p) ? (p[0] || null) : p;
        } catch (e2) {}
      }
    }
  }

  // Truncation repair: If the JSON ended abruptly inside actions array
  if (clean.includes('"actions"') && clean.indexOf('{') !== -1) {
    try {
      const sub = clean.slice(clean.indexOf('{'));
      const lastObjEnd = sub.lastIndexOf('}');
      if (lastObjEnd !== -1) {
        let repaired = sub.slice(0, lastObjEnd + 1);
        if (!repaired.endsWith(']}')) {
          repaired = repaired + ']}';
        }
        const p = JSON.parse(repaired);
        if (p && Array.isArray(p.actions) && p.actions.length > 0) {
          return p;
        }
      }
    } catch (e3) {}
  }

  return null;
}

function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function detectAudioMime(base64Str, defaultMime = 'audio/m4a') {
  if (!base64Str) return defaultMime;
  try {
    const rawHead = atob(base64Str.slice(0, 48));
    if (rawHead.startsWith('RIFF')) return 'audio/wav';
    if (rawHead.startsWith('OggS')) return 'audio/ogg';
    if (rawHead.startsWith('fLaC')) return 'audio/flac';
    if (rawHead.startsWith('ID3')) return 'audio/mp3';
    if (rawHead.length >= 2 && rawHead.charCodeAt(0) === 0xFF && (rawHead.charCodeAt(1) & 0xE0) === 0xE0) return 'audio/mp3';
    if (rawHead.length >= 8 && rawHead.slice(4, 8) === 'ftyp') return 'audio/m4a';
  } catch (e) {}
  return defaultMime;
}

const CATEGORY_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Speech-to-Text with multi-provider cascade:
 * 1. Groq (whisper-large-v3) - ultra-fast inference (<300ms) with vocabulary context
 * 2. Cloudflare Workers AI (@cf/openai/whisper-large-v3-turbo) with initial_prompt
 * 3. Cloudflare Workers AI base (@cf/openai/whisper) fallback
 */
async function transcribeSpeech(audioBytes, audioMime, vocabList, env) {
  // STT_LANGUAGE: 'ru' (default), another ISO code, or 'auto' to let Whisper detect it (mixed RU/EN speech)
  const sttLangEnv = (env.STT_LANGUAGE || 'ru').toLowerCase();
  const sttLanguage = sttLangEnv === 'auto' ? '' : sttLangEnv;
  const vocabPrompt = Array.isArray(vocabList) && vocabList.length > 0
    ? vocabList.slice(0, 50).join(', ')
    : 'Нячанг, Камрань, CXR, Sparc, Meta Ad Library';

  // 1. Try Groq Whisper Large V3 if GROQ_API_KEY is configured
  if (env.GROQ_API_KEY) {
    const ext = audioMime?.includes('ogg') ? 'ogg' : audioMime?.includes('wav') ? 'wav' : audioMime?.includes('webm') ? 'webm' : 'm4a';
    const mime = audioMime || 'audio/m4a';

    // 1a. Groq Whisper Large V3 (high accuracy, 8s timeout)
    try {
      const blob = new Blob([audioBytes], { type: mime });
      const formData = new FormData();
      formData.append('file', blob, `audio.${ext}`);
      formData.append('model', env.GROQ_WHISPER_MODEL || 'whisper-large-v3');
      if (vocabPrompt) {
        formData.append('prompt', vocabPrompt);
      }
      if (sttLanguage) formData.append('language', sttLanguage);
      formData.append('temperature', '0');

      const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY}`
        },
        body: formData,
        signal: AbortSignal.timeout(8000)
      });

      if (groqRes.ok) {
        const data = await groqRes.json();
        if (data?.text && data.text.trim()) {
          console.log('Groq Whisper Large v3 recognized:', data.text.trim());
          noteUsage('stt_groq');
          return data.text.trim();
        }
      } else {
        const errText = await groqRes.text().catch(() => '');
        console.warn(`Groq STT error (${groqRes.status}):`, errText);
      }
    } catch (gErr) {
      console.warn('Groq whisper-large-v3 timeout / error:', gErr.message);
    }

    // 1b. Groq Whisper Large V3 Turbo fallback (ultra fast ~400ms, 5s timeout)
    try {
      const blob = new Blob([audioBytes], { type: mime });
      const formData = new FormData();
      formData.append('file', blob, `audio.${ext}`);
      formData.append('model', 'whisper-large-v3-turbo');
      if (vocabPrompt) {
        formData.append('prompt', vocabPrompt);
      }
      if (sttLanguage) formData.append('language', sttLanguage);
      formData.append('temperature', '0');

      const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GROQ_API_KEY}`
        },
        body: formData,
        signal: AbortSignal.timeout(5000)
      });

      if (groqRes.ok) {
        const data = await groqRes.json();
        if (data?.text && data.text.trim()) {
          console.log('Groq Whisper Large v3 Turbo recognized:', data.text.trim());
          noteUsage('stt_groq');
          return data.text.trim();
        }
      }
    } catch (gTurboErr) {
      console.warn('Groq whisper-large-v3-turbo timeout / error:', gTurboErr.message);
    }
  }

  // 2. Cloudflare Workers AI Whisper Large V3 Turbo
  if (env.AI) {
    try {
      const whisperRes = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
        audio: [...audioBytes],
        initial_prompt: vocabPrompt
      });
      if (whisperRes?.text && whisperRes.text.trim()) {
        console.log('Workers AI Whisper Turbo recognized:', whisperRes.text.trim());
        noteUsage('stt_cf');
        return whisperRes.text.trim();
      }
    } catch (turboErr) {
      console.warn('Workers AI Whisper Turbo error, falling back to base whisper:', turboErr.message);
      try {
        const fallbackRes = await env.AI.run('@cf/openai/whisper', {
          audio: [...audioBytes]
        });
        if (fallbackRes?.text && fallbackRes.text.trim()) {
          console.log('Workers AI Base Whisper recognized:', fallbackRes.text.trim());
          noteUsage('stt_cf');
          return fallbackRes.text.trim();
        }
      } catch (baseErr) {
        console.error('Workers AI Base Whisper error:', baseErr.message);
      }
    }
  }

  return '';
}

/**
 * Whisper fills silence or noise with phrases from its training subtitles ("Субтитры сделал DimaTorzok",
 * "Продолжение следует...") or a lone interjection. Such a transcript is no speech at all.
 */
function isSttHallucination(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-zа-яё0-9]+/giu, ' ').trim();
  if (t.replace(/\s/g, '').length < 3) return true;
  return /(?:субтитр|dimatorzok|редактор субтитров|корректор|продолжение следует|спасибо за просмотр|подписывайтесь на канал|amara org)/iu.test(t);
}

/**
 * Grounding validator: check if LLM extracted entity evidence exists in user transcript
 */
function validateEvidence(evidence, rawTranscript) {
  if (!evidence || typeof evidence !== 'string') return true;
  const cleanEv = evidence.toLowerCase().replace(/[^a-zа-я0-9]/gi, '');
  if (!cleanEv || cleanEv.length < 3) return true;
  const cleanRaw = (rawTranscript || '').toLowerCase().replace(/[^a-zа-я0-9]/gi, '');
  return cleanRaw.includes(cleanEv);
}


// ================= Expense dates ("вчера потратил ...") =================
const NHA_TRANG_OFFSET_MS = 7 * 3600000;
// Pure date helpers take the person's offset as the last argument; the default is Nha Trang (the owner)
const localDateOf = (ms, offMs = NHA_TRANG_OFFSET_MS) => new Date(ms + offMs).toISOString().slice(0, 10);
const shiftDate = (dateStr, days) => new Date(Date.parse(`${dateStr}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const MONTHS_GEN = { 'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6, 'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12 };
const WEEKDAYS_ACC = { 'понедельник': 1, 'вторник': 2, 'среду': 3, 'среда': 3, 'четверг': 4, 'пятницу': 5, 'пятница': 5, 'субботу': 6, 'суббота': 6, 'воскресенье': 0 };
const DATE_WORDS_RX = /(?:^|\s)(?:(?:в|во)\s+(?:прошл(?:ый|ую|ое)\s+)?(?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|позавчера|вчера|сегодня|\d+\s+(?:дн(?:я|ей)|день)\s+назад|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря))(?=[\s,.!?]|$)/giu;

/**
 * The past local day an expense phrase points at ("вчера", "позавчера", "3 дня назад", "в пятницу",
 * "30 октября"), or null for today / no date. Never a future day: an expense already happened.
 */
function parseExpenseDate(text, now = new Date(), offMs = NHA_TRANG_OFFSET_MS) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const today = localDateOf(now.getTime(), offMs);
  let d = null;
  let m;
  if (/\sпозавчера[\s,.!?]/u.test(t)) d = shiftDate(today, -2);
  else if (/\sвчера[\s,.!?]/u.test(t)) d = shiftDate(today, -1);
  else if ((m = t.match(/\s(\d+)\s+(?:дн(?:я|ей)|день)\s+назад/u))) d = shiftDate(today, -parseInt(m[1], 10));
  else if ((m = t.match(/\sв(?:о)?\s+(?:прошл(?:ый|ую|ое)\s+)?(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)[\s,.!?]/u))) {
    const back = ((new Date(`${today}T00:00:00Z`).getUTCDay() - WEEKDAYS_ACC[m[1]] + 7) % 7) || 7;   // last such day, not today
    d = shiftDate(today, -back);
  } else if ((m = t.match(/\s(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)[\s,.!?]/u))) {
    d = pastCalendarDate(today, MONTHS_GEN[m[2]], parseInt(m[1], 10));
  }
  // No "30.10" form on purpose: it is indistinguishable from an amount like "1.5 млн"
  if (!d || d >= today || d < shiftDate(today, -366)) return null;
  return d;
}

/** "30 октября" said on 2 Nov is this year; said on 2 Oct it is last year's. */
function pastCalendarDate(today, month, day) {
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  let year = parseInt(today.slice(0, 4), 10);
  const fmt = (y) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (fmt(year) > today) year -= 1;
  const s = fmt(year);
  return new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s ? s : null;   // rejects 31.11
}

/**
 * created_at (UTC, SQLite format) for an expense on a past local day: that day at the current local time,
 * so the day's list keeps a natural order. null means "now" (today or no valid date).
 */
function expenseCreatedAt(localDate, now = new Date(), offMs = NHA_TRANG_OFFSET_MS) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDate || ''))) return null;
  const today = localDateOf(now.getTime(), offMs);
  if (localDate >= today) return null;
  const timeOfDayMs = (((now.getTime() + offMs) % 86400000) + 86400000) % 86400000;
  const ms = Date.parse(`${localDate}T00:00:00Z`) + timeOfDayMs - offMs;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** "вчера", "позавчера", "в пятницу, 30 октября"-style label for a past local day (for replies) */
function pastDayLabel(localDate, now = new Date(), offMs = NHA_TRANG_OFFSET_MS) {
  const today = localDateOf(now.getTime(), offMs);
  if (localDate === shiftDate(today, -1)) return 'вчера';
  if (localDate === shiftDate(today, -2)) return 'позавчера';
  return new Date(`${localDate}T00:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' });
}

/**
 * Deterministic Russian words-to-number parser
 */
function parseDigitAmount(numStr, mult) {
  let s = numStr.replace(/\s/g, '');
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(s)) {
    s = s.replace(/[.,]/g, '');       // 1.500.000 / 1,500 -> thousands separators
  } else {
    s = s.replace(',', '.');          // 2,5 -> decimal
  }
  let val = parseFloat(s);
  if (!Number.isFinite(val)) return null;
  const m = (mult || '').toLowerCase();
  if (/^(?:к|k|тыс)/.test(m)) {
    if (val < 1000) val *= 1000;
  } else if (/^(?:млн|лям|милли)/.test(m)) {
    val *= 1000000;
  }
  return Math.round(val * 100) / 100;
}

/**
 * All amounts that can be read from a transcript: digits ("150к", "2.5к", "1.5 млн", "150 000")
 * plus Russian number words ("сто пятьдесят тысяч"). Used to cross-check the LLM amount.
 */
function extractAmountCandidates(text) {
  if (!text) return [];
  const t = String(text).toLowerCase();
  const out = [];
  const rx = /(\d+(?:\s\d{3})*(?:[.,]\d+)?)\s*(к|k|тыс(?:яч[аи]?)?|млн|лям[а-я]*)?(?![а-яa-z0-9])/giu;
  let m;
  while ((m = rx.exec(t)) !== null) {
    const v = parseDigitAmount(m[1], m[2]);
    if (v !== null && v > 0) out.push(v);
  }
  const words = parseWordsToNumber(t);
  if (words !== null) out.push(words);
  return out;
}

function parseWordsToNumber(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  // Word-to-number mapping
  const numWords = {
    'один': 1, 'одна': 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5,
    'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10,
    'одиннадцать': 11, 'двенадцать': 12, 'тринадцать': 13, 'четырнадцать': 14,
    'пятнадцать': 15, 'шестнадцать': 16, 'семнадцать': 17, 'восемнадцать': 18,
    'девятнадцать': 19, 'двадцать': 20, 'тридцать': 30, 'сорок': 40,
    'пятьдесят': 50, 'шестьдесят': 60, 'семьдесят': 70, 'восемьдесят': 80,
    'девяносто': 90, 'сто': 100, 'двести': 200, 'триста': 300, 'четыреста': 400,
    'пятьсот': 500, 'шестьсот': 600, 'семьсот': 700, 'восемьсот': 800, 'девятьсот': 900
  };

  const tokens = t.split(/[\s,.:;!?]+/).filter(Boolean);
  let total = 0;
  let currentGroup = 0;
  let matched = false;

  for (const token of tokens) {
    if (numWords[token] !== undefined) {
      currentGroup += numWords[token];
      matched = true;
    } else if (token === 'тысяча' || token === 'тысячи' || token === 'тысяч' || token === 'к' || token === 'k') {
      if (currentGroup === 0) currentGroup = 1;
      total += currentGroup * 1000;
      currentGroup = 0;
      matched = true;
    } else if (token.startsWith('миллион') || token.startsWith('лям')) {
      if (currentGroup === 0) currentGroup = 1;
      total += currentGroup * 1000000;
      currentGroup = 0;
      matched = true;
    }
  }
  total += currentGroup;
  return matched && total > 0 ? total : null;
}

/**
 * Deterministic relative date parser (local timezone UTC+7)
 */
function parseRelativeDate(text, now = new Date(), offsetHours = 7) {
  if (!text) return null;
  const t = text.toLowerCase();

  // 1. "через X минут(ы)"
  const mMin = t.match(/через\s+(\d+)\s+минут/i);
  if (mMin) {
    const mins = parseInt(mMin[1], 10);
    const target = new Date(now.getTime() + mins * 60000);
    return {
      isoDateTime: target.toISOString().slice(0, 19).replace('T', ' '),
      isDateOnly: 0
    };
  }
  if (/через\s+(?:полчаса|пол\s+часа)/i.test(t)) {
    const target = new Date(now.getTime() + 30 * 60000);
    return {
      isoDateTime: target.toISOString().slice(0, 19).replace('T', ' '),
      isDateOnly: 0
    };
  }
  if (/через\s+час(?:ок)?(?:\s|$|[!?,.:;])/i.test(t)) {
    const target = new Date(now.getTime() + 60 * 60000);
    return {
      isoDateTime: target.toISOString().slice(0, 19).replace('T', ' '),
      isDateOnly: 0
    };
  }
  const mHour = t.match(/через\s+(\d+)\s+час/i);
  if (mHour) {
    const hrs = parseInt(mHour[1], 10);
    const target = new Date(now.getTime() + hrs * 3600000);
    return {
      isoDateTime: target.toISOString().slice(0, 19).replace('T', ' '),
      isDateOnly: 0
    };
  }

  // Calculate local user date and time
  const localTimeMs = now.getTime() + offsetHours * 3600000;
  const localNow = new Date(localTimeMs);

  function extractTime(str) {
    const m = str.match(/(?:в|к)\s+(\d{1,2})(?::(\d{2}))?\s*(утра|дня|вечера|ночи)?/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const period = m[3] ? m[3].toLowerCase() : '';
    if (period === 'вечера' || period === 'дня') {
      if (h < 12) h += 12;
    } else if (period === 'ночи' && h === 12) {
      h = 0;
    }
    return { h, min };
  }

  const timeSpec = extractTime(t);

  // Tomorrow
  if (/(?:^|\s)завтра(?:\s|$|[!?,.:;])/i.test(t)) {
    const d = new Date(localNow);
    d.setUTCDate(d.getUTCDate() + 1);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dt = String(d.getUTCDate()).padStart(2, '0');
    if (timeSpec) {
      const targetUtc = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), timeSpec.h - offsetHours, timeSpec.min, 0));
      return {
        isoDateTime: targetUtc.toISOString().slice(0, 19).replace('T', ' '),
        isoDate: `${y}-${m}-${dt}`,
        isDateOnly: 0
      };
    }
    return { isoDate: `${y}-${m}-${dt}`, isDateOnly: 1 };
  }

  // Day after tomorrow
  if (/(?:^|\s)послезавтра(?:\s|$|[!?,.:;])/i.test(t)) {
    const d = new Date(localNow);
    d.setUTCDate(d.getUTCDate() + 2);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dt = String(d.getUTCDate()).padStart(2, '0');
    if (timeSpec) {
      const targetUtc = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), timeSpec.h - offsetHours, timeSpec.min, 0));
      return {
        isoDateTime: targetUtc.toISOString().slice(0, 19).replace('T', ' '),
        isoDate: `${y}-${m}-${dt}`,
        isDateOnly: 0
      };
    }
    return { isoDate: `${y}-${m}-${dt}`, isDateOnly: 1 };
  }

  // Build a result for "local date = today + offset days", with the spoken time if there is one
  const resultForOffset = (days) => {
    const d = new Date(localNow);
    d.setUTCDate(d.getUTCDate() + days);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dt = String(d.getUTCDate()).padStart(2, '0');
    if (timeSpec) {
      const targetUtc = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), timeSpec.h - offsetHours, timeSpec.min, 0));
      return { isoDateTime: targetUtc.toISOString().slice(0, 19).replace('T', ' '), isoDate: `${y}-${m}-${dt}`, isDateOnly: 0 };
    }
    return { isoDate: `${y}-${m}-${dt}`, isDateOnly: 1 };
  };

  // "через 2 дня", "через два дня", "через неделю", "через 2 недели"
  const smallNums = { один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, десять: 10 };
  const mDays = t.match(/через\s+(\d+|один|одну|два|две|три|четыре|пять|шесть|семь|десять)\s+(?:дня|дней|день)(?![а-я])/i);
  if (mDays) {
    const n = /^\d+$/.test(mDays[1]) ? parseInt(mDays[1], 10) : smallNums[mDays[1]];
    return resultForOffset(n);
  }
  if (/через\s+неделю(?![а-я])/i.test(t)) return resultForOffset(7);
  const mWeeks = t.match(/через\s+(\d+|два|две|три|четыре)\s+недел/i);
  if (mWeeks) {
    const n = /^\d+$/.test(mWeeks[1]) ? parseInt(mWeeks[1], 10) : smallNums[mWeeks[1]];
    return resultForOffset(n * 7);
  }

  // Weekdays: next occurrence strictly after today ("в пятницу", "во вторник", "в понедельник")
  const weekdays = [
    ['воскресень[ея]', 0], ['понедельник[а-я]*', 1], ['вторник[а-я]*', 2], ['сред[ауе]', 3],
    ['четверг[а-я]*', 4], ['пятниц[ауе]', 5], ['суббот[ауе]', 6]
  ];
  for (const [pattern, dow] of weekdays) {
    if (new RegExp('(?:^|\\s)(?:в|во|на|к)\\s+' + pattern + '(?![а-я])', 'i').test(t)) {
      let diff = (dow - localNow.getUTCDay() + 7) % 7;
      if (diff === 0) diff = 7;
      return resultForOffset(diff);
    }
  }

  // "на следующей неделе": next Monday, date only
  if (/(?:на|в)\s+следующ(?:ей|ую)\s+недел/i.test(t)) {
    let diff = (1 - localNow.getUTCDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return { ...resultForOffset(diff), isoDateTime: undefined, isDateOnly: 1 };
  }

  // If time mentioned with "сегодня" or action verbs
  if (timeSpec && /(?:сегодня|напомни|позвони|встреча|набрать)/i.test(t)) {
    const y = localNow.getUTCFullYear();
    const m = String(localNow.getUTCMonth() + 1).padStart(2, '0');
    const dt = String(localNow.getUTCDate()).padStart(2, '0');
    let targetUtc = new Date(Date.UTC(y, localNow.getUTCMonth(), localNow.getUTCDate(), timeSpec.h - offsetHours, timeSpec.min, 0));
    if (targetUtc.getTime() < now.getTime() - 600000 && !/сегодня/i.test(t)) {
      targetUtc = new Date(targetUtc.getTime() + 86400000);
    }
    return {
      isoDateTime: targetUtc.toISOString().slice(0, 19).replace('T', ' '),
      isoDate: `${y}-${m}-${dt}`,
      isDateOnly: 0
    };
  }

  // End of specific month
  const months = {
    'январ': 1, 'феврал': 2, 'март': 3, 'апрел': 4, 'ма[йея]': 5, 'июн': 6,
    'июл': 7, 'август': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12
  };

  for (const [mPattern, mNum] of Object.entries(months)) {
    const rxEnd = new RegExp('(?:в\\s+конце?|на\\s+конец)\\s+' + mPattern + '[а-я]*', 'i');
    if (rxEnd.test(t)) {
      const year = localNow.getUTCFullYear();
      const lastDay = new Date(Date.UTC(year, mNum, 0)).getUTCDate();
      const monthStr = String(mNum).padStart(2, '0');
      const dayStr = String(lastDay).padStart(2, '0');
      return { isoDate: `${year}-${monthStr}-${dayStr}`, isDateOnly: 1 };
    }
  }

  // End of current month
  if (/(?:в\s+конце?|на\s+конец)\s+месяца/i.test(t)) {
    const year = localNow.getUTCFullYear();
    const curMonth = localNow.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(year, curMonth, 0)).getUTCDate();
    const monthStr = String(curMonth).padStart(2, '0');
    const dayStr = String(lastDay).padStart(2, '0');
    return { isoDate: `${year}-${monthStr}-${dayStr}`, isDateOnly: 1 };
  }

  // Weekend (nearest Saturday)
  if (/(?:на\s+выходных|в\s+выходные|на\s+выходные)/i.test(t)) {
    const d = new Date(localNow);
    const dayOfWeek = d.getUTCDay();
    const daysUntilSat = dayOfWeek === 6 ? 0 : (6 - dayOfWeek);
    d.setUTCDate(d.getUTCDate() + daysUntilSat);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dt = String(d.getUTCDate()).padStart(2, '0');
    return { isoDate: `${y}-${m}-${dt}`, isDateOnly: 1 };
  }

  return null;
}

/**
 * The part of the transcript that talks about one particular task, so that
 * "завтра в 11 позвонить Ахмеду, а в пятницу заказать детали" gives each task its own date.
 */
function taskDateContext(data, rawTranscript, taskCount) {
  if (data?.evidence && validateEvidence(data.evidence, rawTranscript) && String(data.evidence).length >= 6) {
    return String(data.evidence);
  }
  if (taskCount <= 1) return rawTranscript;

  const clauses = String(rawTranscript || '')
    .split(/[,;.!?]+|\s(?:а еще|а также|а потом|и еще|также|кстати)\s|\sа\s/i)
    .map(s => s.trim())
    .filter(Boolean);
  let best = '';
  let bestScore = 0;
  for (const c of clauses) {
    const score = fuzzyTextSimilarity(data?.title || '', c);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 0.2 ? best : '';
}

function cleanFinanceTitle(text, amount) {
  let t = text || '';
  if (amount) {
    t = t.replace(new RegExp(String(amount), 'g'), ' ');
  }
  t = t.replace(/(?:^|\s)\d+(?:[\s.,]\d+)?\s*(?:к|k|тыс(?:яч[аи]?)?|донгов|vnd|руб(?:лей)?|долларов|usd|aed|дирхам)?(?:\s|$|[!?,.:;])/gi, ' ');
  t = t.replace(/(?:^|\s)(?:блядь|нахуй|похуй|хуй|сука|ебать|пиздец|заебал[аои]?|нах)(?:\s|$|[!?,.:;])/gi, ' ');
  t = t.replace(/(?:^|\s)(?:потратил|оплатил|купил|отдал|чек|списали|расход|слушай|короче|кстати|запиши|пожалуйста|мне|такое)(?:\s|$|[!?,.:;])/gi, ' ');
  t = t.replace(/[!?,.:;]+/g, ' ').trim();
  const words = t.split(/\s+/).filter(w => w.length > 0);
  let res = words.slice(0, 5).join(' ');
  if (res) {
    res = res.charAt(0).toUpperCase() + res.slice(1);
    res = res.replace(/^(Шоу-?рум)[ауе]/i, '$1');
  }
  return res || 'Расход';
}

/**
 * Deterministic reading of a bare expense dictation: every part is "<amount> <what>" or "<what> <amount>",
 * joined by "и" / "," / "плюс" ("140 000 шаурма и 50 000 пепси", "110 тысяч обед в лето", "кофе 50к").
 * Returns finance actions, or null when the phrase is anything else (a task, a budget, a correction, a time).
 */
function parseExpensePhrase(text, defaultCurrency = 'VND') {
  // "вчера 50к кофе": the date words leave the item (the day itself is read when saving; "30 октября" is not an amount)
  const t = String(text || '').toLowerCase().replace(DATE_WORDS_RX, ' ').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 160) return null;
  if (/(?:напомн|надо|нужно|бюджет|лимит|план|выдел|исправ|поменя|перезапис|удали|отмени|верни|должен|долг|час|минут|завтра|послезавтра|сегодня в|утра|вечера|через)/iu.test(t)) return null;

  const amountRx = /(\d+(?:\s\d{3})*(?:[.,]\d+)?)\s*(к|k|тыс(?:яч[аи]?)?|млн|лям[а-я]*)?(?![а-яa-z0-9])/giu;
  const currencyRx = /(?:^|\s)(донг(?:ов|а)?|vnd|руб(?:лей|ля|ль)?|usd|доллар(?:ов|а)?|бакс(?:ов|а)?|aed|дирхам(?:ов|а)?|тенге|kzt|гривн(?:ы|а|у|ах)?|грн|uah|евро|eur)(?=\s|$)/iu;
  // A small bare number is a count ("с 3 друзьями") where money comes in thousands, an amount where it does not
  const minBareAmount = ['VND', 'KZT'].includes(String(defaultCurrency).toUpperCase()) ? 1000 : 10;
  const segments = t.split(/\s+(?:и|плюс|а также|ещё|еще)\s+|\s*[,;]\s*/u).map(s => s.trim()).filter(Boolean);
  if (segments.length === 0 || segments.length > 5) return null;

  const actions = [];
  for (const seg of segments) {
    const amounts = [...seg.matchAll(amountRx)];
    if (amounts.length !== 1) return null;
    const amount = parseDigitAmount(amounts[0][1], amounts[0][2]);
    if (!(amount > 0)) return null;

    let currency = defaultCurrency;
    const cur = seg.match(currencyRx);
    if (cur) {
      const c = cur[1];
      currency = /^руб/.test(c) ? 'RUB' : /^(?:usd|доллар|бакс)/.test(c) ? 'USD' : /^(?:aed|дирхам)/.test(c) ? 'AED'
        : /^(?:тенге|kzt)/.test(c) ? 'KZT' : /^(?:гривн|грн|uah)/.test(c) ? 'UAH' : /^(?:евро|eur)/.test(c) ? 'EUR' : 'VND';
    } else if (!amounts[0][2] && amount < minBareAmount) {
      return null;                     // "с 3 друзьями": a small bare number is a count, not dongs
    }

    const item = seg
      .replace(amounts[0][0], ' ')
      .replace(currencyRx, ' ')
      .replace(/(?:^|\s)(?:потратил[аи]?|оплатил[аи]?|заплатил[аи]?|купил[аи]?|отдал[аи]?|ушло|списали|расход|я)(?=\s|$)/giu, ' ')
      .replace(/^\s*(?:на|за)\s+/u, ' ')
      .replace(/\s+(?:на|за)\s*$/u, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const words = item.split(' ').filter(Boolean);
    if (!/[а-яёa-z]/iu.test(item) || words.length > 5) return null;

    actions.push({
      type: 'finance',
      data: { amount, currency, category: guessFinanceCategory(item) || 'other', title: item.charAt(0).toUpperCase() + item.slice(1), confidence: 0.8 },
      evidence: seg
    });
  }
  return actions;
}

/** Category from everyday words (Nha Trang life), or null when nothing obvious matches. */
function guessFinanceCategory(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  const has = (rx) => new RegExp(`[\\s(«"](?:${rx})(?=[\\s)»",.!?:;])`, 'iu').test(t);
  if (has('шаурм[аыеу]|шаверм[аыеу]|бургер[а-я]*|пицц[а-я]*|пепси|pepsi|кол[аыу]|кофе|чай|обед[а-я]*|ужин[а-я]*|завтрак[а-я]*|еда|еду|доширак|ролл[а-я]*|суши|ресторан[а-я]*|кафе|багет|сэндвич|вод[аыуичк][а-я]*|пиво|пива|сайгон|продукт[а-я]*|фрукт[а-я]*|арбуз[а-я]*|манго|хлеб[а-я]*|молок[оа]|яйц[а-я]*|мяс[оа]|рыб[аыу]|магазин[а-я]*|супермаркет[а-я]*|сок[а-я]*|снек[а-я]*|фо|бань ?ми|морожен[а-я]*')) return 'food';
  if (has('такси|grab|граб|бензин[а-я]*|заправк[а-я]*|байк[а-я]*|мотобайк[а-я]*|парковк[а-я]*|мойк[а-я]*|автобус[а-я]*|билет[а-я]*|самол[её]т[а-я]*|ремонт байка')) return 'car';
  if (has('клауд|claude|chatgpt|gpt|подписк[а-я]* на|домен[а-я]*|хостинг[а-я]*|сервер[а-я]*|vpn|впн|айфон[а-я]*|ноутбук[а-я]*|телефон[а-я]*|симк[а-я]*|интернет[а-я]*')) return 'tech';
  if (has('аренд[а-я]*|квартир[а-я]*|массаж[а-я]*|стрижк[а-я]*|барбер[а-я]*|прачечн[а-я]*|стирк[а-я]*|уборк[а-я]*|подписк[а-я]*|виз[аыу]|визаран[а-я]*')) return 'services';
  return null;
}

const VOICE_EDIT_STOPWORDS = new Set((
  'удали удалить удалите убери убрать сотри стереть отмени отменить исправь исправить поменяй поменять измени изменить ' +
  'перезапиши перезаписываю замени заменить поставь сделай перенеси переименуй вместо ошибся ошибка неправильно ' +
  'последний последняя последнюю последнее последние предыдущий предыдущую прошлый прошлую этот эту это там тут ' +
  'расход расходы трату траты покупку задачу задача заметку заметка запись записи записал записывал напоминание ' +
  'тысяч тысячи тысяча рублей рубля донгов донга долларов доллара баксов сумму сумма минут минуты назад только сейчас ' +
  'сегодня завтра послезавтра вчера утра утром вечера вечером часов часа дня понедельник вторник среду четверг пятницу субботу воскресенье ' +
  'пожалуйста слушай короче нет было надо'
).split(' '));

/**
 * Voice "исправь / удали" acts on a record the LLM picked from recent context. When the phrase names something
 * (an item or an amount) that the picked record does not have, the LLM grabbed the wrong one: refuse.
 * A phrase that names nothing ("удали последнюю запись") trusts the LLM's choice.
 */
async function voiceTargetMatches(table, id, rawTranscript, env) {
  const cols = { finances: 'amount, title, raw_text', tasks: 'title', notes: 'title, content' }[table];
  if (!cols) return false;
  const row = await env.DB.prepare(`SELECT ${cols} FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, env.uid).first();
  if (!row) return false;

  const text = String(rawTranscript || '').toLowerCase();
  const words = text.split(/[^a-zа-яё]+/iu).filter(w => w.length >= 3 && !VOICE_EDIT_STOPWORDS.has(w));
  const amounts = table === 'finances' ? extractAmountCandidates(text) : [];
  if (words.length === 0 && amounts.length === 0) return true;

  if (table === 'finances' && amounts.some(a => [a, a * 1000].some(v => Math.abs(Number(row.amount) - v) < 0.01))) return true;
  const rowWords = [row.title, row.raw_text, row.content].join(' ').toLowerCase().split(/[^a-zа-яё]+/iu).filter(w => w.length >= 3);
  return words.some(w => rowWords.some(r => r.slice(0, 4) === w.slice(0, 4) || wordSimilarity(w, r) >= 0.7));
}

/**
 * Safety net for expense dictations the LLM filed as a note (or never saw because every provider failed):
 * a phrase made only of "<amount> <what>" parts is an expense, whatever the router said.
 */
function enforceExpenseShape(classification, text, defaultCurrency) {
  const debt = parseDebtPhrase(text, defaultCurrency);   // "Арбуз должен мне 100к" is a debt, never an expense
  if (debt) return debt;
  const actions = Array.isArray(classification?.actions) && classification.actions.length > 0
    ? classification.actions
    : (classification?.type ? [classification] : []);
  if (actions.some(a => a.type !== 'note')) return classification;
  const expenses = parseExpensePhrase(text, defaultCurrency);
  if (!expenses) return classification;
  return { raw_text: classification?.raw_text, type: 'finance', actions: expenses, haptic: 'success' };
}

/**
 * Vocabulary post-correction: touch ONLY glossary words, leave rest unchanged
 */
function postCorrectTranscript(text, vocabList = []) {
  if (!text) return text;
  let res = text;

  // 1. Камрань (CXR)
  res = res.replace(/(?:из\s+|в\s+|до\s+)?(?:камран[иеья]|комран[иеья]|камрань|комрань)(?:\s*\(cxr\))?/gi, (match) => {
    const prefix = match.match(/^(?:из|в|до)\s+/i);
    return (prefix ? prefix[0] : '') + 'Камрань (CXR)';
  });

  // 2. Sparc
  res = res.replace(/(?:^|\s)(?:спарк|sparc)(?:\s|$|[!?,.:;])/gi, (m) => m.replace(/спарк|sparc/i, 'Sparc'));

  // 3. Meta Ad Library
  res = res.replace(/(?:^|\s)(?:мета\s*(?:эд|ад)\s*лайбрари|meta\s*ad\s*library)(?:\s|$|[!?,.:;])/gi, (m) => m.replace(/мета\s*(?:эд|ад)\s*лайбрари|meta\s*ad\s*library/i, 'Meta Ad Library'));

  return res;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const v0 = new Array(b.length + 1).fill(0).map((_, i) => i);
  const v1 = new Array(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}

function wordSimilarity(w1, w2) {
  if (w1 === w2) return 1;
  const maxLen = Math.max(w1.length, w2.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(w1, w2);
  return (maxLen - dist) / maxLen;
}

/**
 * Fuzzy text similarity matching words with Levenshtein tolerance
 * Handles inflections and phonetic misspellings (e.g. Камрань vs Кампани)
 */
function fuzzyTextSimilarity(str1, str2) {
  const norm = s => (s || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2);

  const t1 = norm(str1);
  const t2 = norm(str2);
  if (!t1.length || !t2.length) return 0;

  const matched2 = new Set();
  let matches = 0;

  for (const w1 of t1) {
    let bestScore = 0;
    let bestIdx = -1;
    for (let j = 0; j < t2.length; j++) {
      if (matched2.has(j)) continue;
      const w2 = t2[j];
      const score = wordSimilarity(w1, w2);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }
    if (bestScore >= 0.70) {
      matches++;
      if (bestIdx !== -1) matched2.add(bestIdx);
    }
  }

  return (2 * matches) / (t1.length + t2.length);
}

/**
 * Smart merge without duplicating identical sentences or appending repetitive text
 */
function smartMergeText(existingText, newText) {
  const t1 = (existingText || '').trim();
  const t2 = (newText || '').trim();
  if (!t1) return t2;
  if (!t2) return t1;

  if (t1.toLowerCase().includes(t2.toLowerCase())) return t1;
  if (t2.toLowerCase().includes(t1.toLowerCase())) return t2;

  const overallSim = fuzzyTextSimilarity(t1, t2);
  if (overallSim >= 0.75) {
    return t1.length >= t2.length ? t1 : t2;
  }

  const sentences1 = t1.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const sentences2 = t2.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);

  const additions = [];
  for (const s2 of sentences2) {
    const isDup = sentences1.some(s1 => fuzzyTextSimilarity(s1, s2) >= 0.7);
    if (!isDup) {
      additions.push(s2.trim());
    }
  }

  if (additions.length === 0) {
    return t1.length >= t2.length ? t1 : t2;
  }

  return `${t1}\n${additions.join(' ')}`;
}

/**
 * VOICE HOOK: Core Router & AI Dispatcher for Apple Shortcuts
 */
async function handleVoiceHook(request, env, opts = {}) {
  const reqUrl = new URL(request.url);
  const isText = reqUrl.searchParams.get('format') === 'text';
  // Once this request has taken a place in the day's limit, a failure gives it back (only once)
  let slotTaken = false;
  const giveBack = async () => { if (slotTaken) { slotTaken = false; await releaseRecordingSlot(env); } };

  try {
    // Who is speaking (skipped for /api/capture: the router already scoped env to the caller)
    if (!opts.trusted) {
      const who = await resolveUser(request, env);
      if (!who) {
        const ip = request.headers.get('CF-Connecting-IP');
        if (ip) rateHit(`bad:${ip}`, RATE.badAuth);
        return errorResponse('Unauthorized: Invalid or missing token', 401);
      }
      env = await userEnv(env, who.user);
    }
    const gate = await recordingGate(env);
    if (!gate.ok) {
      if (isText) return new Response(gate.text, { status: gate.status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS } });
      return jsonResponse({ ok: false, reason: gate.reason, voice_reply: gate.text, screen_notification: gate.text, haptic: 'warning' }, gate.status);
    }
    slotTaken = true;

    // Parse input (supports JSON text, JSON audio base64, or raw audio body)
    let rawText = '';
    let audioBase64 = '';
    let audioMime = '';
    let coords = null;
    let dayOpenInApp = null;   // the Mini App sends the past day it is showing; expenses land on that day

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await readJson(request, { skip: ['audio', 'audio_base64', 'voice'] });
      rawText = body.text || body.message || body.input || '';
      audioBase64 = body.audio || body.audio_base64 || body.voice || '';
      audioMime = body.mime_type || body.mimeType || '';
      coords = body.coords || null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) dayOpenInApp = body.date;
    } else if (contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
      const arrayBuffer = await request.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_AUDIO_BODY) {
        await giveBack();
        return errorResponse('Request too large', 413);
      }
      audioBase64 = arrayBufferToBase64(arrayBuffer);
      audioMime = contentType.split(';')[0].trim();
    } else {
      rawText = await request.text();
    }

    rawText = (rawText || '').trim();
    audioBase64 = (audioBase64 || '').replace(/[\r\n\s]+/g, '').trim();
    if (audioBase64.startsWith('data:')) {
      audioBase64 = audioBase64.replace(/^data:[^;]+;base64,/, '');
    }

    try {
      if (env.DB) {
        await env.DB.prepare(
          'INSERT INTO request_logs (endpoint, method, content_type, body_length, body_preview, user_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(
          '/api/voice-hook',
          request.method,
          contentType,
          rawText ? rawText.length : audioBase64.length,
          rawText ? `text: ${logSnippet(env, rawText)}` : `audio len=${audioBase64.length} mime=${audioMime}`,
          env.uid
        ).run();
      }
    } catch (logErr) {
      console.error('Request logging error:', logErr);
    }

    if (!rawText && !audioBase64) {
      await giveBack();
      if (isText) {
        return new Response('Ошибка: пустой ввод (голос не получен)', {
          status: 400,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...CORS_HEADERS
          }
        });
      }
      return jsonResponse({
        ok: false,
        voice_reply: 'Голос не получен. Попробуйте еще раз.',
        screen_notification: 'Ошибка: пустой ввод',
        haptic: 'warning'
      }, 400);
    }

    if (audioBase64 && !audioMime) {
      audioMime = detectAudioMime(audioBase64, 'audio/m4a');
    }

    // Fetch vocabulary glossary first for STT prompt context and post-correction
    let vocabList = ['Камрань (CXR)', 'Sparc', 'Meta Ad Library'];
    try {
      if (env.DB) {
        const vRes = await env.DB.prepare('SELECT word FROM vocabulary WHERE user_id = ?').bind(env.uid).all();
        if (vRes?.results) vocabList = vRes.results.map(r => r.word);
      }
    } catch (e) {}

    // 1. Run Speech-to-Text via multi-provider STT cascade (Groq Whisper -> CF Whisper Large Turbo)
    let whisperText = '';
    if (audioBase64) {
      try {
        const audioBytes = base64ToUint8Array(audioBase64);
        whisperText = await transcribeSpeech(audioBytes, audioMime, vocabList, env);
      } catch (wErr) {
        console.error('STT transcribe error:', wErr);
      }
    }
    const sttRejected = Boolean(whisperText) && isSttHallucination(whisperText);

    try {
      if (env.DB) {
        await env.DB.prepare(
          'INSERT INTO request_logs (endpoint, method, content_type, body_length, body_preview, user_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(
          '/api/voice-hook/stt',
          request.method,
          audioMime || 'unknown',
          (whisperText || '').length,
          `stt: "${logSnippet(env, whisperText)}"`,
          env.uid
        ).run();
      }
    } catch (logErr) {}

    if (sttRejected) whisperText = '';
    let effectiveText = rawText || whisperText || '';

    if (!effectiveText) {
      await giveBack();
      if (isText) {
        return new Response('Речь не распознана. Попробуйте записать еще раз.', {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            ...CORS_HEADERS
          }
        });
      }
      return jsonResponse({
        ok: false,
        voice_reply: 'Речь не распознана. Попробуйте еще раз.',
        screen_notification: 'Речь не распознана',
        haptic: 'warning'
      });
    }

    // Pristine untouched raw transcript before ANY glossary replacement or AI manipulation
    const pristineRawTranscript = effectiveText || whisperText || '';

    // Post-correct transcript for glossary terms (used only for AI routing / title normalization)
    const correctedEffectiveText = postCorrectTranscript(effectiveText, vocabList);

    // Process text or audio through AI Router:
    const audioForAI = whisperText ? '' : audioBase64;
    const classification = enforceExpenseShape(await classifyWithGemini({
      text: correctedEffectiveText,
      audioBase64: audioForAI,
      mimeType: audioMime,
      vocabList
    }, env), effectiveText, env.DEFAULT_CURRENCY || 'VND');

    if (!rawText && (whisperText || classification.raw_text)) {
      rawText = whisperText || classification.raw_text;
    } else if (!rawText) {
      rawText = 'Голосовое сообщение';
    }

    // Preserve the pristine transcript strictly (before any glossary additions)
    const rawTranscript = pristineRawTranscript || classification.raw_text || rawText || '';

    // Save to Cloudflare D1 with duplicate and review checks
    const persistResult = await persistToD1(classification, rawTranscript, coords, env, { date: dayOpenInApp });

    // Optional: Send background notification to Telegram
    if (env.TELEGRAM_BOT_TOKEN) {
      // Awaited: a Worker may drop a promise still pending after the response is returned
      await sendSavedCard(persistResult, rawTranscript, classification, env).catch(e => console.error('Telegram push failed:', e));
    }

    // Strip emojis helper
    const cleanVoice = stripEmojis(classification.voice_reply);
    const cleanScreen = stripEmojis(classification.screen_notification);

    const actions = Array.isArray(classification.actions) && classification.actions.length > 0
      ? classification.actions
      : (classification.type ? [classification] : []);

    let voiceReply = cleanVoice;
    let screenNotification = cleanScreen;

    if (persistResult?.notFound) {
      await giveBack();                       // nothing was changed: the place goes back
      voiceReply = 'Запись не найдена.';
      screenNotification = 'Запись не найдена или не удалена';
    } else if (persistResult?.hasDuplicate) {
      voiceReply = 'Обнаружен возможный дубликат. Проверьте в приложении.';
      screenNotification = 'Возможный дубликат. Отправлено в Разобрать';
    } else if (persistResult?.hasNeedsReview) {
      voiceReply = 'Запись отправлена в очередь на проверку.';
      screenNotification = 'Отправлено в Разобрать';
    } else if (actions.length > 0) {
      const parts = actions.map(act => {
        if (act.type === 'finance') {
          const amt = Number(act.data?.amount || 0).toLocaleString('ru-RU');
          const curr = act.data?.currency || env.DEFAULT_CURRENCY || 'VND';
          const title = act.data?.title ? ` (${act.data.title})` : '';
          const day = act.data?.date ? `, ${pastDayLabel(act.data.date, new Date(), env.tzMs)}` : '';
          return `Расход: ${amt} ${curr}${title}${day}`;
        } else if (act.type === 'task') {
          return `Задача: ${act.data?.title || 'Создана'}`;
        } else if (act.type === 'translate') {
          return `Перевод: ${act.data?.word || ''} — ${act.data?.translation || ''}`;
        } else if (act.type === 'update') {
          return `Исправлено: [${act.target_table || 'запись'} #${act.target_id || ''}]`;
        } else if (act.type === 'delete') {
          return `Удалено: [${act.target_table || 'запись'} #${act.target_id || ''}]`;
        } else {
          return `Заметка: ${act.data?.title || 'Сохранена'}`;
        }
      });
      screenNotification = stripEmojis(parts.join(' | '));
    }

    if (!voiceReply) {
      if (actions.length > 1) {
        voiceReply = `Записано действий: ${actions.length}`;
      } else if (actions[0]?.type === 'finance') {
        voiceReply = `Расход: ${actions[0].data?.amount || ''} ${actions[0].data?.currency || ''}`;
      } else if (actions[0]?.type === 'task') {
        voiceReply = `Задача создана: ${actions[0].data?.title || ''}`;
      } else if (actions[0]?.type === 'translate') {
        voiceReply = `${actions[0].data?.word || ''} — ${actions[0].data?.translation || ''}`;
      } else if (actions[0]?.type === 'update') {
        voiceReply = 'Запись обновлена';
      } else if (actions[0]?.type === 'delete') {
        voiceReply = 'Запись удалена';
      } else {
        voiceReply = 'Заметка сохранена';
      }
      voiceReply = stripEmojis(voiceReply);
    }

    if (!screenNotification) {
      screenNotification = voiceReply || 'Запись сохранена';
    }

    try {
      if (env.DB) {
        await env.DB.prepare(
          'INSERT INTO request_logs (endpoint, method, content_type, body_length, body_preview, user_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(
          '/api/voice-hook/out',
          request.method,
          isText ? 'text/plain' : 'application/json',
          (screenNotification || '').length,
          `out: "${logSnippet(env, screenNotification)}"`,
          env.uid
        ).run();
      }
    } catch (logErr) {}

    if (isText) {
      return new Response(screenNotification, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ...CORS_HEADERS
        }
      });
    }

    // Return formatted response for Apple Shortcuts
    return jsonResponse({
      ok: true,
      type: actions[0]?.type || 'note',
      actions: actions,
      voice_reply: voiceReply,
      screen_notification: screenNotification,
      haptic: classification.haptic || 'success',
      data: actions[0]?.data || {}
    });
  } catch (err) {
    console.error('handleVoiceHook error:', err);
    await giveBack();
    if (isText) {
      return new Response(`Ошибка: ${publicError(env, err)}`, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ...CORS_HEADERS
        }
      });
    }
    if (err instanceof LimitError) return errorResponse(err.message, 413);
    return errorResponse(publicError(env, err), 500);
  } finally {
    try { await flushUsage(env); } catch (e) { console.error('Usage flush failed:', e); }
  }
}

/**
 * Fetch recent records from D1 to give Gemini conversational awareness
 * for corrections, re-recordings, and deletions ("перезаписываю", "поменяй", "не 150, а 200").
 */
async function getRecentContext(env) {
  if (!env.DB) return '';
  try {
    const [financesRes, tasksRes, notesRes] = await Promise.all([
      env.DB.prepare('SELECT id, amount, currency, category, raw_text, created_at FROM finances WHERE user_id = ? ORDER BY id DESC LIMIT 5').bind(env.uid).all(),
      env.DB.prepare('SELECT id, title, due_datetime, priority, is_completed, created_at FROM tasks WHERE user_id = ? ORDER BY id DESC LIMIT 5').bind(env.uid).all(),
      env.DB.prepare("SELECT id, category, title, content, created_at FROM notes WHERE user_id = ? AND category != 'debug' ORDER BY id DESC LIMIT 5").bind(env.uid).all()
    ]);

    const finances = financesRes?.results || [];
    const tasks = tasksRes?.results || [];
    const notes = notesRes?.results || [];

    if (finances.length === 0 && tasks.length === 0 && notes.length === 0) {
      return '';
    }

    let lines = ['НЕДАВНИЕ ЗАПИСИ ПОЛЬЗОВАТЕЛЯ В БАЗЕ (используй для команд "перезапиши", "исправь", "поменяй", "не X, а Y", "удали", "отмени"):'];

    if (finances.length > 0) {
      lines.push('--- Последние траты (finances):');
      finances.forEach(f => {
        lines.push(`  • [finances id=${f.id}] Сумма: ${f.amount} ${f.currency}, категория: ${f.category}, текст: "${f.raw_text || ''}", дата: ${f.created_at}`);
      });
    }

    if (tasks.length > 0) {
      lines.push('--- Последние задачи (tasks):');
      tasks.forEach(t => {
        lines.push(`  • [tasks id=${t.id}] "${t.title}", дедлайн: ${t.due_datetime || 'нет'}, статус: ${t.is_completed ? 'выполнена' : 'активна'}, приоритет: ${t.priority || 'medium'}`);
      });
    }

    if (notes.length > 0) {
      lines.push('--- Последние заметки (notes):');
      notes.forEach(n => {
        const preview = (n.content || '').slice(0, 90).replace(/\n/g, ' ');
        lines.push(`  • [notes id=${n.id}] [${n.category}] "${n.title}": ${preview}`);
      });
    }

    return lines.join('\n');
  } catch (err) {
    console.warn('Failed to load recent context for AI:', err);
    return '';
  }
}

/**
 * Gemini 2.0 Flash Classifier (Multimodal Audio & Text)
 */
// Per-isolate memory: until this time, skip the direct Google endpoint (region refusal seen recently)
let directGeminiBlockedUntil = 0;

async function classifyWithGemini(input, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in Worker secrets');
  }

  const userText = typeof input === 'string' ? input : (input?.text || '');
  const audioBase64 = typeof input === 'object' ? (input?.audioBase64 || '') : '';
  const mimeType = typeof input === 'object' ? (input?.mimeType || 'audio/mp4') : 'audio/mp4';
  const recentContext = typeof input === 'object' && input?.recentContext !== undefined
    ? input.recentContext
    : await getRecentContext(env);

  const now = new Date();
  const userTimezone = env.USER_TIMEZONE || 'Asia/Ho_Chi_Minh';
  const localNowStr = new Intl.DateTimeFormat('ru-RU', {
    timeZone: userTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now);
  const nowIso = now.toISOString();
  const defaultCurrency = env.DEFAULT_CURRENCY || 'VND';

  const systemPrompt = `Ты — ядро персонального ассистента TRACE. Твоя задача — классифицировать входящее голосовое сообщение (аудиозапись или текст) в строгий JSON.
Пользователь может сказать ОДНО действие (расход, задача, перевод, заметка) ИЛИ СРАЗУ НЕСКОЛЬКО действий в одном сообщении (поток сознания, напр. напоминание + идея + расход).

СТРОГИЕ ПРАВИЛА:
1. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО использовать любые emoji / смайлики в любых полях. Только чистый текст без смайлов.
2. ВРЕМЯ И ГЕОГРАФИЯ:
   - Пользователь живет в Нячанге (Nha Trang, Вьетнам, часовой пояс UTC+7, ${userTimezone}).
   - Главный местный аэропорт Нячанга — Камрань (Cam Ranh, код IATA: CXR).
   - Текущее местное время пользователя: ${localNowStr} (UTC+7).
   - Текущее UTC время: ${nowIso}.
   - Все относительные упоминания времени ("через 15 минут", "в 14:00", "завтра в 10 утра", "вечером", "в выходные", "конец ноября") вычисляй СТРОГО от местного времени пользователя (${localNowStr}, UTC+7)!
   - Поле due_datetime для задач возвращай в формате ISO 8601 UTC (например, '2026-10-26T13:00:00Z') либо с оффсетом '+07:00'.
3. Валюта по умолчанию: ${defaultCurrency}. Примеры сумм: "145 тысяч еда" -> 145000 VND. "10 тысяч рублей" -> 10000 RUB.
4. РАСПОЗНАВАНИЕ РЕЧИ И ТРАНСКРИПЦИЯ (ОЧЕНЬ ВАЖНО):
   - Если предоставлена аудиозапись, ОБЯЗАТЕЛЬНО запиши в корень JSON поле "raw_text", содержащее точную расшифровку того, что сказал пользователь.
   - Понимай естественную разговорную русскую речь со сленгом, местной вьетнамской спецификой и английскими терминами:
     "Нечанг" -> Нячанг, "комране" -> Камрань (CXR), "наконец на ебре" -> "конец ноября", "вайб" -> "vibe", "детейлинг" -> "detailing", "PPF", "tow truck", "resilient", "pink", "silent".
   - Игнорируй звуки-паразиты (эээ, ммм, вздохи, паузы).
   - Если пользователь сам исправил себя во время речи ("потратил сто... нет, двести рублей"), фиксируй итоговый исправленный факт.
5. РАЗДЕЛЕНИЕ СОСТАВНЫХ СООБЩЕНИЙ И ВВОДНЫЕ СЛОВА (КРИТИЧЕСКИ ВАЖНО):
   - Игнорируй любые разговорные обращения и вводные слова: "Посмотри", "Слушай", "Короче", "Так", "Запиши мне", "Кстати", "А еще", "Пожалуйста", "Как-то так", "мне такое задачу", "блядь".
   - Если фраза содержит несколько самостоятельных действий (связанных союзами "и", "а потом", "а еще", "также", "напомни", "запиши", "переведи", "потратил", "бюджет"), ОБЯЗАТЕЛЬНО разделяй каждое действие в отдельный элемент массива "actions"!
   - Пример составного запроса:
     Вход: "Посмотри, запиши идею, сделать новый крутой вайб для лендинга и напомни завтра 11 позвонить дизайнеру, а еще приведи слово Silent."
     Результат:
     "actions": [
       { "type": "note", "data": { "category": "idea", "title": "Новый вайб для лендинга", "content": "Сделать новый крутой вайб для посадочной страницы (лендинга), создавая современную эстетику и атмосферу...", "tags": "дизайн, лендинг, идея" } },
       { "type": "task", "data": { "title": "Позвонить дизайнеру", "due_datetime": "2026-10-27T04:00:00Z", "priority": "medium" } },
       { "type": "translate", "data": { "word": "Silent", "phonetic": "[са́йлент]", "translation": "Тихий", "example": "Stay silent during the speech. (Соблюдайте тишину во время речи.)" } }
     ]
   - НИКОГДА не объединяй составной запрос в одну общую заметку-мысль, если в нем явно присутствуют слова "напомни/позвонить" (task) или "переведи/слово" (translate) или "потратил" (finance)!

6. РАЗЛИЧИЕ РАСХОДА (FINANCE) И БЮДЖЕТА/ПЛАНА (NOTE) — СТРОГО:
   - В 'finance' попадают ТОЛЬКО ФАКТИЧЕСКИ СОВЕРШЕННЫЕ РАСХОДЫ И ТРАТЫ в прошлом или настоящем: "потратил", "купил", "оплатил", "списали", "чек", "отдал", "145 тысяч еда в магазине".
   - Короткая фраза "<сумма> <на что>" БЕЗ глагола — это ВСЕГДА 'finance' (так пользователь диктует траты): "110 тысяч обед в Лето" (Лето — название кафе) -> finance 110000 "Обед в Лето"; "140 000 шаурма и 50 000 пепси" -> ДВА finance-действия.
   - ВЫДЕЛЕННЫЙ БЮДЖЕТ, ЛИМИТЫ, ПЛАНЫ БУДУЩИХ ТРАТ ("у нас есть бюджет на две недели 10 тысяч рублей на еду", "планирую потратить", "выделил 500$", "лимит по карте") — ЭТО КАТЕГОРИЧЕСКИ НЕ 'finance'! Это 'note' (category: 'fact', tags: 'бюджет, финансы')! НИКОГДА не записывай бюджет или лимит в таблицу finances как трату!

7. СТРОГИЙ ЗАПРЕТ НА ВЫДУМЫВАНИЕ СУЩНОСТЕЙ (GROUNDING):
   - Категорически запрещено выдумывать страны, города или сущности, которых пользователь НЕ называл!
   - Если направление или часть фразы неразборчива (напр. "билеты из Камрани всю и обратно"), ЗАПРЕЩЕНО выдумывать Румынию! Напиши четко: "Найти билеты из Камрани (CXR) туда и обратно на конец ноября" либо сохрани фразу пользователя.

8. КОРРЕКТИРОВКА, ПЕРЕЗАПИСЬ И УДАЛЕНИЕ РАНЕЕ СОЗДАННЫХ ЗАПИСЕЙ (ОЧЕНЬ ВАЖНО):
   - Если пользователь просит исправить, перезаписать, скорректировать, изменить или удалить предыдущую запись (например: "Перезаписываю, я там записывал 150 000 на еду 5 минут назад, поменяй на 200 000", "Не 150к, а 200к на еду", "Исправь последнюю задачу на...", "Удали расход на кофе", "Я ошибся, запиши вместо 100 рублей 200"):
     1. Внимательно посмотри на блок "НЕДАВНИЕ ЗАПИСИ ПОЛЬЗОВАТЕЛЯ В БАЗЕ" ниже.
     2. Найди соответствующую запись по сумме, категории, тексту или времени.
     3. Для изменения создай действие с type: 'update':
        {
          "type": "update",
          "target_table": "finances" | "tasks" | "notes",
          "target_id": 15,
          "data": {
            "amount": 200000,
            "currency": "VND",
            "category": "food",
            "raw_text": "200 тысяч еда (исправлено)"
          }
        }
     4. Для удаления создай действие с type: 'delete':
        {
          "type": "delete",
          "target_table": "finances" | "tasks" | "notes",
          "target_id": 15
        }
     5. В voice_reply дай четкое подтверждение для Siri: "Расход изменен на 200 тысяч донгов" / "Задача обновлена" / "Запись удалена".
     6. В screen_notification: "Исправлен расход: 200 000 VND (еда)".

${recentContext ? `\n` + recentContext + `\n` : ''}

СЛОВАРЬ (собственные имена, локации, бренды — используй точные написания):
${(input?.vocabList || ['Камрань (CXR)', 'Sparc', 'Meta Ad Library']).join(', ')}

ПРАВИЛО НЕВЫДУМЫВАНИЯ:
Что пользователь не назвал, то строго null! КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО придумывать даты, время и суммы!
Если названа только дата без времени («на конец ноября», «завтра», «на выходных») — due_datetime возвращай строго в формате 'YYYY-MM-DD' без указания времени (date-only)!

9. ПРАВИЛО ДОКАЗАТЕЛЬСТВА (GROUNDING EVIDENCE):
Для каждого действия в объекте "actions" ОБЯЗАТЕЛЬНО возвращай поле "evidence" — точную дословную цитату из исходной фразы пользователя, на основании которой создано это действие (например, "полтора миллиона на аренду", "завтра в 10 набрать Ахмеду").
ВНИМАНИЕ: Если ты сомневаешься в сумме или категории, или если фраза звучит неразборчиво, ставь "needs_review": true.

Категории действий:
- 'finance': ТОЛЬКО фактически совершенные траты или покупки (потратил, оплатил).
  amount: число (распознавай 'к'/'k'/'тысяч' как x1000, 'лям'/'миллион' как x1000000).
  currency: 'VND' | 'USD' | 'RUB' | 'AED' | 'KZT' | 'UAH' | 'EUR' (по умолчанию '${defaultCurrency}').
  category: 'car' | 'food' | 'tech' | 'services' | 'other' | 'unsure'.
  ВНИМАНИЕ: Если уверенность в категории ниже 0.7 или сомневаешься, ставь строго category: 'unsure'!
  title: короткое название траты 2–5 слов, СТРОГО БЕЗ сумм, БЕЗ мата и БЕЗ междометий (например: 'Шоу-рум', 'Пепси арбуз').
  confidence: число уверенности от 0.0 до 1.0.
  needs_review: true если сомневаешься в категории или сумме, иначе false.
- 'task': любое дело, действие, поручение, намерение или напоминание (с дедлайном или без).
  ПРАВИЛО: Если во фразе есть "надо", "нужно", "сделать", "купить", "найти", "съездить", "позвонить", "сфоткать", "отправить", "забрать", "записаться" — это ВСЕГДА 'task', а НЕ 'note'!
  title: четкая, емкая формулировка задачи в инфинитиве (например: 'Найти билеты из Камрани (CXR) туда и обратно на конец ноября', 'Съездить в выходные за теплыми вещами', БЕЗ смайлов и БЕЗ разговорного мусора вроде 'мне такое задачу', 'Привет, запиши').
  due_datetime: если названа дата без времени — строго 'YYYY-MM-DD'. Если названо конкретное время — ISO 8601 UTC. Если дата не названа — строго null!
  priority: 'low' | 'medium' | 'high' (по умолчанию 'medium').
  confidence: число уверенности от 0.0 до 1.0.
- 'translate': перевод слова или фразы на русский или английский.
  word: переводимое слово/фраза на английском, ВСЕГДА латиницей (например: 'good', 'vibe', 'resilient', 'pink'). Распознавание речи часто пишет английское слово русскими буквами («гасинг», «вайб», «резилиент») — восстанови английское написание ('gassing', 'vibe', 'resilient'). Если пользователь спросил, как сказать по-английски русское слово, word — английский перевод, translation — русское слово.
  phonetic: ОБЯЗАТЕЛЬНО практическая транскрипция РУССКИМИ БУКВАМИ в квадратных скобках с ударением для русскоговорящего человека (например: '[гуд]', '[ва́йб]', '[рези́лиент]', '[пинк]').
  translation: емкий русский перевод (БЕЗ смайлов).
  example: ОБЯЗАТЕЛЬНО живой пример употребления на английском с переводом на русский в скобках (например: 'She is wearing a pink dress. (Она одета в розовое платье.)', БЕЗ смайлов).
- 'debt': кто-то должен пользователю деньги. НЕ 'finance' и НЕ 'note'!
  "Арбуз должен мне 100 тысяч", "дал в долг Диме 50к", "100 000 арбуз долг" -> repay: false.
  "Арбуз вернул 30 тысяч", "Дима отдал долг 50к" -> repay: true (человек вернул часть или весь долг).
  owe: false, если должны пользователю. owe: true, если пользователь должен кому-то: "я должен Арбузу 100 тысяч", "занял у Димы 50к" -> repay: false; "я вернул Арбузу 30 тысяч" -> repay: true.
  person: имя или кличка человека в ИМЕНИТЕЛЬНОМ падеже, с большой буквы ('Арбуз', а не 'Арбузу'). amount: число. currency: 'VND' | 'USD' | 'RUB' | 'AED' | 'KZT' | 'UAH' | 'EUR' (по умолчанию '${defaultCurrency}').
- 'note': мысли, идеи, факты, конспекты, полезная информация, инсайты, БЮДЖЕТЫ И ЛИМИТЫ (то, что нужно запомнить, а НЕ сделать).
  category: 'idea' | 'fact' | 'credentials' | 'thought'.
  title: емкий заголовок темы (2-5 слов, БЕЗ смайлов, например: 'Идея по Sparc').
  content: ТОЧНЫЕ СЛОВА ПОЛЬЗОВАТЕЛЯ. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО приукрашивать текст, придумывать канцеляризмы («профессиональные услуги», «оптимизация бизнес-процессов»), писать от третьего лица («Создана тестовая заметка...», «Пользователь предлагает...»), добавлять «Запиши идею:». Сохраняй суть ровно так, как сформулировал пользователь, убрав только междометия и вводные слова («слушай», «короче», «запиши»). Без ведущих пробелов и отступов!
  tags: ключевые теги через запятую (максимум 2 тега).
- 'update': корректировка или перезапись ранее созданной записи из базы.
  target_table: 'finances' | 'tasks' | 'notes'.
  target_id: числовой ID записи.
  data: обновленные поля (amount, category, currency, raw_text для финансов; title, due_datetime, priority для задач; title, content, tags для заметок).
- 'delete': удаление ошибочной записи.
  target_table: 'finances' | 'tasks' | 'notes'.
  target_id: числовой ID записи.

Строгая структура JSON:
{
  "raw_text": "Точная расшифровка сказанного (если передано аудио)",
  "actions": [
    {
      "type": "finance" | "task" | "translate" | "note" | "debt" | "update" | "delete",
      "target_table": "finances" | "tasks" | "notes" (для update и delete),
      "target_id": 123 (для update и delete),
      "data": { ...соответствующие поля... }
    }
  ],
  "haptic": "success" | "warning",
  "voice_reply": "Краткая фраза для озвучки Siri до 8 слов (строго БЕЗ смайлов)",
  "screen_notification": "Информативный статус (напр. 'Исправлен расход: 200 000 VND', разделитель ' | ' если несколько действий, строго БЕЗ смайлов)"
}
ВАЖНО: Выведи СТРОГО чистый JSON-объект без пояснений и без markdown. Ответ ОБЯЗАН начинаться с { и заканчиваться }.`;

  const userParts = [];
  if (audioBase64) {
    userParts.push({
      inlineData: {
        mimeType: mimeType,
        data: audioBase64
      }
    });
    if (userText) {
      userParts.push({ text: `Дополнительный контекст: ${userText}` });
    } else {
      userParts.push({ text: 'Внимательно прослушай аудиосообщение, расшифруй слова в raw_text и классифицируй действия согласно системной инструкции.' });
    }
  } else {
    userParts.push({ text: userText });
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts: userParts
      }
    ],
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const candidateModels = [
    env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    'gemini-3.5-flash'
  ];

  let rawJson = null;
  let errors = [];

  // Total time budget for the whole LLM cascade: iOS Shortcuts gives up after a while,
  // so stop trying further providers once the budget is spent (heuristic fallback then runs).
  const deadline = Date.now() + (parseInt(env.AI_BUDGET_MS, 10) || 20000);
  const timeLeft = () => deadline - Date.now();
  const MIN_ATTEMPT_MS = 1500;

  const accountId = env.CLOUDFLARE_ACCOUNT_ID || '44582e0bb3748a9b6f2b7401fc798ee0';
  const gatewayId = env.AI_GATEWAY_ID || 'trace-gateway';

  for (const model of candidateModels) {
    // Direct Google first; if Google recently refused our region, go through the Cloudflare AI Gateway first
    const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/google-ai-studio/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const urlCandidates = Date.now() < directGeminiBlockedUntil
      ? [gatewayUrl, directUrl]
      : [directUrl, gatewayUrl];

    for (const apiUrl of urlCandidates) {
      if (timeLeft() < MIN_ATTEMPT_MS) break;
      try {
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(Math.min(8000, timeLeft()))
        });

        if (response.ok) {
          const result = await response.json();
          const parts = result.candidates?.[0]?.content?.parts || [];
          const validParts = parts.filter(p => !p.thought && typeof p.text === 'string');
          const text = (validParts.length > 0 ? validParts : parts)
            .map(p => p.text || '')
            .join('')
            .trim();

          if (text) {
            rawJson = text;
            const parsed = parseCleanJson(text);
            if (parsed && (Array.isArray(parsed.actions) ? parsed.actions.length > 0 : (parsed.type || parsed.category))) {
              noteUsage('llm_gemini');
              return parsed;
            }
          }
        } else {
          const errText = await response.text();
          errors.push(`${model} [${apiUrl.includes('gateway') ? 'Gateway' : 'Direct'}] (${response.status}): ${errText}`);
          // Remember a regional refusal so the next requests skip the doomed direct call for a while
          if (!apiUrl.includes('gateway') && /location|region|not supported/i.test(errText)) {
            directGeminiBlockedUntil = Date.now() + 30 * 60 * 1000;
          }
        }
      } catch (e) {
        errors.push(`${model} (fetch error): ${e.message}`);
      }
    }
  }

  // Groq LLM fallback if GEMINI fails and GROQ_API_KEY is configured
  if (env.GROQ_API_KEY && (!rawJson || errors.length > 0)) {
    const fallbackText = userText || 'Голосовое сообщение';
    const groqCandidateModels = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

    for (const gModel of groqCandidateModels) {
      if (timeLeft() < MIN_ATTEMPT_MS) break;
      try {
        const groqLlmRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: gModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: fallbackText }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.0
          }),
          signal: AbortSignal.timeout(Math.min(6000, timeLeft()))
        });

        if (groqLlmRes.ok) {
          const gData = await groqLlmRes.json();
          const text = gData.choices?.[0]?.message?.content;
          if (text) {
            const parsed = parseCleanJson(text);
            if (parsed && (Array.isArray(parsed.actions) ? parsed.actions.length > 0 : (parsed.type || parsed.category))) {
              console.log(`Groq ${gModel} parsed successfully`);
              noteUsage('llm_groq');
              return parsed;
            }
          }
        } else {
          const errText = await groqLlmRes.text().catch(() => '');
          errors.push(`Groq ${gModel} (${groqLlmRes.status}): ${errText.slice(0, 100)}`);
        }
      } catch (gErr) {
        errors.push(`Groq ${gModel} error: ${gErr.message}`);
      }
    }
  }

  // If Gemini failed (e.g. regional location restriction), fallback to native Cloudflare Workers AI
  if (env.AI) {
    const fallbackText = userText || 'Голосовое сообщение';
    const aiCandidates = [
      '@cf/meta/llama-3.3-70b-instruct',
      '@cf/meta/llama-3.1-8b-instruct',
      '@cf/meta/llama-3.2-3b-instruct'
    ];
    for (const aiModel of aiCandidates) {
      if (timeLeft() < MIN_ATTEMPT_MS) break;
      try {
        const aiRes = await env.AI.run(aiModel, {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${fallbackText}\n\nВыведи ТОЛЬКО валидный JSON без вступительного текста:` }
          ],
          max_tokens: 1500,
          temperature: 0.1
        });
        const text = typeof aiRes.response === 'string'
          ? aiRes.response
          : (typeof aiRes === 'string' ? aiRes : JSON.stringify(aiRes));

        if (text) {
          rawJson = text;
          const parsed = parseCleanJson(text);
          if (parsed && (Array.isArray(parsed.actions) ? parsed.actions.length > 0 : (parsed.type || parsed.category))) {
            noteUsage('llm_cf');
            return parsed;
          }
        }
      } catch (aiErr) {
        errors.push(`Workers AI ${aiModel}: ${aiErr.message}`);
      }
    }
  }

  // If rawJson was captured, try one more time with robust parser
  if (rawJson) {
    const parsed = parseCleanJson(rawJson);
    if (parsed) return parsed;
  }

  console.warn('AI Routing Fallback triggered. Errors:', errors);
  noteUsage('llm_fallback');

  // Heuristic multi-action extraction fallback
  const fallbackActions = [];

  // 1. Task heuristic
  const taskMatch = userText.match(/(?:напомни|позвонить|сделать|купить|забрать|отправить)\s+([^,.]+)/i);
  if (taskMatch) {
    fallbackActions.push({
      type: 'task',
      data: {
        title: stripEmojis(taskMatch[0]).slice(0, 50),
        due_datetime: null,
        priority: 'medium'
      }
    });
  }

  // 2. Translate heuristic
  const transMatch = userText.match(/(?:как переводит(?:ся)?|что значит|перевод слова|приведи слово|переведи слово|слово)\s+([a-zA-Z\s]+)/i);
  if (transMatch) {
    const word = transMatch[1].trim();
    fallbackActions.push({
      type: 'translate',
      data: {
        word,
        translation: 'Перевод',
        phonetic: '',
        example: ''
      }
    });
  }

  // 3. Idea / Note heuristic
  const ideaMatch = userText.match(/(?:иде(?:я|ю)|запиши идею|мысль|конспект)\s*[:,]?\s*([^,.]+)/i);
  if (ideaMatch) {
    const ideaContent = stripEmojis(ideaMatch[1] || userText);
    fallbackActions.push({
      type: 'note',
      data: {
        category: 'idea',
        title: ideaContent.slice(0, 30),
        content: ideaContent,
        tags: 'идея'
      }
    });
  }

  if (fallbackActions.length > 0) {
    return {
      type: fallbackActions[0].type,
      actions: fallbackActions,
      voice_reply: `Записано действий: ${fallbackActions.length}`,
      screen_notification: fallbackActions.map(a => `${a.type}: ${a.data?.title || a.data?.word}`).join(' | '),
      haptic: 'success'
    };
  }

  // Default note fallback if completely unstructured
  const cleanNote = stripEmojis(userText) || 'Голосовая заметка';
  return {
    type: 'note',
    actions: [{
      type: 'note',
      data: {
        category: 'thought',
        title: cleanNote.slice(0, 25),
        content: cleanNote,
        tags: 'голос'
      }
    }],
    data: {
      category: 'thought',
      title: cleanNote.slice(0, 25),
      content: cleanNote,
      tags: 'голос'
    },
    voice_reply: 'Заметка сохранена',
    screen_notification: `Заметка: ${cleanNote.slice(0, 30)}`,
    haptic: 'success'
  };
}

/**
 * Persist classification to Cloudflare D1
 */
// opts.date: local YYYY-MM-DD of the day open in the app when the capture was sent (expenses land there)
async function persistToD1(classification, rawTranscript, coords, env, opts = {}) {
  if (!env.DB) {
    console.warn('D1 database binding "DB" is not bound. Skipping DB insert.');
    return { hasDuplicate: false, hasNeedsReview: false };
  }

  const actions = Array.isArray(classification.actions) && classification.actions.length > 0
    ? classification.actions
    : (classification.type ? [classification] : []);

  let hasDuplicate = false;
  let hasNeedsReview = false;
  let notFound = false;
  const created = [];   // what got saved, for the Telegram card ({ table, id, ...fields })

  for (const action of actions.slice(0, MAX_ACTIONS_PER_RECORD)) {   // one record = one place in the day's limit, so not hundreds of rows
    const type = action.type;
    const data = action.data || action;
    if (!type || !data) continue;

    try {
      switch (type) {
        case 'finance': {
          const rawAmount = data.amount;
          const parsedAmount = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount || '0').replace(/[^0-9.]/g, ''));
          const llmAmount = Number.isFinite(parsedAmount) ? parsedAmount : 0;

          // Cross-check the LLM amount against numbers actually present in the transcript.
          // Keep the LLM value when the transcript confirms it; otherwise fall back to the only
          // number in the transcript, or keep the LLM value and send the record to review.
          // Day numbers ("30 октября", "3 дня назад") are not amounts
          const candidates = extractAmountCandidates(String(rawTranscript || '').replace(DATE_WORDS_RX, ' '));
          let amount = llmAmount;
          let amountUnverified = false;
          if (candidates.length > 0 && !candidates.some(c => Math.abs(c - llmAmount) < 0.01)) {
            if (candidates.length === 1) {
              amount = candidates[0];
            } else {
              amountUnverified = true;
            }
          }
          data.amount = amount;
          
          const currency = stripEmojis(data.currency) || env.DEFAULT_CURRENCY || 'VND';
          let category = stripEmojis(data.category) || 'other';
          let confidence = typeof data.confidence === 'number' ? data.confidence : 1.0;
          const categoryThreshold = parseFloat(env.CATEGORY_CONFIDENCE_THRESHOLD || '0.7');

          // Keyword categories when the LLM is unsure. Look at this expense's own title first: in
          // "60 тысяч такси и 30 тысяч вода" the taxi must not become food because of the water.
          if (category === 'unsure' || category === 'other' || !category) {
            const guess = guessFinanceCategory(data.title || rawTranscript);
            if (guess) {
              category = guess;
              confidence = Math.max(confidence, 0.95);
            }
          }

          let needsReview = 0;
          if (category === 'unsure' || confidence < categoryThreshold || data.needs_review || amountUnverified || !(amount > 0)) {
            needsReview = 1;
            hasNeedsReview = true;
          }

          // Clean title: 2-5 words, no amounts, no swear words
          const title = cleanFinanceTitle(data.title || rawTranscript, amount);
          data.title = title;
          data.category = category;

          // Duplicate check: same amount and similar title in the last 10 minutes
          let possibleDuplicate = 0;
          let duplicateOf = null;
          try {
            const recent = await env.DB.prepare(
              `SELECT id, amount, title, raw_text FROM finances WHERE user_id = ? AND datetime(created_at, '${env.tzSql}') >= datetime('now', '${env.tzSql}', '-10 minutes') AND (needs_review IS NULL OR needs_review = 0) ORDER BY id DESC LIMIT 10`
            ).bind(env.uid).all();
            if (recent?.results) {
              for (const r of recent.results) {
                if (Math.abs(Number(r.amount) - amount) < 0.01) {
                  const rTitle = (r.title || cleanFinanceTitle(r.raw_text, r.amount)).toLowerCase();
                  const cTitle = title.toLowerCase();
                  const sim = fuzzyTextSimilarity(rTitle, cTitle);
                  if (rTitle === cTitle || rTitle.includes(cTitle) || cTitle.includes(rTitle) || sim >= 0.40) {
                    possibleDuplicate = 1;
                    duplicateOf = r.id;
                    needsReview = 1;
                    hasDuplicate = true;
                    break;
                  }
                }
              }
            }
          } catch (e) {}

          if (possibleDuplicate) {
            needsReview = 1;
            hasNeedsReview = true;
          }

          if (data.evidence && !validateEvidence(data.evidence, rawTranscript)) {
            needsReview = 1;
            hasNeedsReview = true;
          }

          // Which day: said in this expense's own words, then anywhere in the phrase, then the day open in the app.
          // The LLM's own date is ignored: dates are computed in code.
          // ("кофе 40к и в пятницу позвонить": that Friday belongs to the task, so the whole phrase counts only when it is all expenses)
          const onlyExpenses = actions.every(a => a.type === 'finance');
          const spentOn = parseExpenseDate(data.evidence, new Date(), env.tzMs) || (onlyExpenses ? parseExpenseDate(rawTranscript, new Date(), env.tzMs) : null) || opts.date || null;
          const createdAt = expenseCreatedAt(spentOn, new Date(), env.tzMs);
          data.date = createdAt ? spentOn : null;

          const finIns = await env.DB.prepare(
            `INSERT INTO finances (amount, currency, category, title, raw_text, raw_transcript, needs_review, confidence, possible_duplicate, duplicate_of, created_at, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)`
          ).bind(amount, currency, category, title, rawTranscript || '', rawTranscript || '', needsReview, confidence, possibleDuplicate, duplicateOf, createdAt, env.uid).run();
          created.push({ table: 'finances', id: finIns?.meta?.last_row_id, title, amount, currency, category, date: data.date, review: !!needsReview });
          break;
        }

        case 'task': {
          let title = stripEmojis(data.title || rawTranscript) || 'Новая задача';
          title = postCorrectTranscript(title);
          
          // Deterministic date & time parse (code calculates exact moment)
          const taskCount = actions.filter(a => a.type === 'task').length;
          const codeDate = parseRelativeDate(taskDateContext(data, rawTranscript, taskCount), new Date(), env.tzHours);
          let due = null;
          let isDateOnly = 0;
          let needsReview = 0;

          if (codeDate) {
            if (codeDate.isoDateTime) {
              due = codeDate.isoDateTime;
              isDateOnly = codeDate.isDateOnly || 0;
            } else if (codeDate.isoDate) {
              due = `${codeDate.isoDate} 00:00:00`;
              isDateOnly = 1;
            }
          } else if (data.due_datetime) {
            try {
              const parsed = new Date(data.due_datetime);
              if (!isNaN(parsed.getTime())) {
                due = parsed.toISOString().slice(0, 19).replace('T', ' ');
                if (due.endsWith('00:00:00') || data.is_date_only) {
                  isDateOnly = 1;
                }
              }
            } catch (e) {}
            // If date was not parsed by code and LLM supplied it, flag for review
            needsReview = 1;
            hasNeedsReview = true;
          }

          if (data.evidence && !validateEvidence(data.evidence, rawTranscript)) {
            needsReview = 1;
            hasNeedsReview = true;
          }

          const priority = stripEmojis(data.priority) || 'medium';
          const confidence = typeof data.confidence === 'number' ? data.confidence : 1.0;

          // Duplicate check for tasks: fuzzy matching in last 48 hours (covers "Камрань" vs "Кампани")
          let possibleDuplicate = 0;
          let duplicateOf = null;
          try {
            const recent = await env.DB.prepare(
              `SELECT id, title, due_datetime FROM tasks WHERE user_id = ? AND datetime(created_at, '${env.tzSql}') >= datetime('now', '${env.tzSql}', '-48 hours') AND (needs_review IS NULL OR needs_review = 0) ORDER BY id DESC LIMIT 20`
            ).bind(env.uid).all();
            if (recent?.results) {
              for (const r of recent.results) {
                const sim = fuzzyTextSimilarity(title, r.title);
                if (sim >= 0.55) {
                  possibleDuplicate = 1;
                  duplicateOf = r.id;
                  needsReview = 1;
                  hasDuplicate = true;
                  break;
                }
              }
            }
          } catch (e) {}

          const taskIns = await env.DB.prepare(
            `INSERT INTO tasks (title, due_datetime, is_date_only, priority, raw_transcript, needs_review, confidence, possible_duplicate, duplicate_of, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(title, due, isDateOnly, priority, rawTranscript || '', needsReview, confidence, possibleDuplicate, duplicateOf, env.uid).run();
          created.push({ table: 'tasks', id: taskIns?.meta?.last_row_id, title, due, isDateOnly, review: !!needsReview });
          break;
        }

        case 'translate': {
          let word = stripEmojis(data.word || data.english || rawTranscript || 'Word').trim() || 'Word';
          let translation = stripEmojis(data.translation || data.russian || rawTranscript || 'Перевод').trim() || 'Перевод';
          // The dictionary is English -> Russian: a Russian word with an English translation is stored the other way round
          const hasCyr = (s) => /[а-яё]/i.test(s);
          const hasLat = (s) => /[a-z]/i.test(s);
          if (hasCyr(word) && !hasLat(word) && hasLat(translation) && !hasCyr(translation)) {
            [word, translation] = [translation, word];
          }
          const phonetic = stripEmojis(data.phonetic || '');
          const example = stripEmojis(data.example || '');
          const wordId = await upsertWord(env, word, translation, phonetic, example);
          created.push({ table: 'vocabulary', id: wordId, word, translation, phonetic });
          break;
        }

        case 'debt': {
          let person = stripEmojis(data.person || '').trim();
          const owe = !!data.owe;   // true = the user owes that person
          const parsedAmount = typeof data.amount === 'number' ? data.amount : parseFloat(String(data.amount || '0').replace(/[^0-9.]/g, ''));
          const candidates = extractAmountCandidates(String(rawTranscript || ''));
          let amount = Number.isFinite(parsedAmount) ? parsedAmount : 0;
          // Same rule as expenses: the amount must be one the user actually said
          if (candidates.length > 0 && !candidates.some(c => Math.abs(c - amount) < 0.01) && candidates.length === 1) amount = candidates[0];
          const currency = SUPPORTED_CURRENCIES.includes(String(data.currency).toUpperCase()) ? String(data.currency).toUpperCase() : (env.DEFAULT_CURRENCY || 'VND');
          if (!person || !(amount > 0)) { notFound = true; break; }

          if (data.repay) {
            const r = await repayDebts(env, person, amount, currency, owe);
            if (!r.found) { notFound = true; break; }
            created.push({ table: 'debts', repay: true, owe, person, amount: r.applied, currency, left: r.left });
            break;
          }

          // A debt is an expense with the debt mark; the same person keeps one spelling ("Арбузу" -> "Арбуз")
          const known = await env.DB.prepare('SELECT title FROM finances WHERE user_id = ? AND is_debt = 1 AND COALESCE(debt_owe, 0) = ? ORDER BY id DESC LIMIT 50').bind(env.uid, owe ? 1 : 0).all();
          const same = (known.results || []).find(d => d.title && d.title.toLowerCase().slice(0, 4) === person.toLowerCase().slice(0, 4));
          if (same) person = same.title;

          const ins = await env.DB.prepare(
            `INSERT INTO finances (amount, currency, category, title, raw_text, raw_transcript, outside_limit, is_debt, debt_owe, created_at, user_id)
             VALUES (?, ?, 'other', ?, ?, ?, 1, 1, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)`
          ).bind(amount, currency, person, rawTranscript || '', rawTranscript || '', owe ? 1 : 0, expenseCreatedAt(opts.date || null, new Date(), env.tzMs), env.uid).run();
          created.push({ table: 'finances', id: ins?.meta?.last_row_id, title: person, amount, currency, category: 'other', debt: true, owe });
          break;
        }

        case 'note': {
          let category = stripEmojis(data.category) || 'general';
          let title = stripEmojis(data.title || 'Новая заметка') || 'Заметка';
          let content = stripEmojis(data.content || data.text || rawTranscript || 'Заметка') || 'Заметка';
          const categoryThreshold = parseFloat(env.CATEGORY_CONFIDENCE_THRESHOLD || '0.7');

          // Memory stores user's direct words: clean leading intros and third-person patterns
          content = content
            .replace(/^(?:запиши(?: мне)? (?:идею|мысль|заметку|факт|напоминание)?[:\s]*|идея[:\s]*|мысль[:\s]*|заметка[:\s]*|факт[:\s]*)/iu, '')
            .replace(/^создана тестовая заметка(?:\s+для\s+проверки\s+системы\s+TRACE)?\.?\s*/iu, '')
            .trim();

          title = title
            .replace(/^(?:запиши(?: мне)? (?:идею|мысль|заметку|факт|напоминание)?[:\s]*|идея[:\s]*|мысль[:\s]*|заметка[:\s]*|факт[:\s]*)/iu, '')
            .trim();

          title = postCorrectTranscript(title);
          content = postCorrectTranscript(content);
          const tags = stripEmojis(data.tags || '');
          const confidence = typeof data.confidence === 'number' ? data.confidence : 1.0;

          let needsReview = 0;
          if (category === 'unsure' || confidence < categoryThreshold || data.needs_review) {
            needsReview = 1;
            hasNeedsReview = true;
          }

          // Duplicate check: fuzzy similarity in the last 48 hours
          let possibleDuplicate = 0;
          let duplicateOf = null;
          try {
            const recent = await env.DB.prepare(
              `SELECT id, title, content FROM notes WHERE user_id = ? AND datetime(created_at, '${env.tzSql}') >= datetime('now', '${env.tzSql}', '-48 hours') AND (needs_review IS NULL OR needs_review = 0) ORDER BY id DESC LIMIT 20`
            ).bind(env.uid).all();
            if (recent?.results) {
              for (const r of recent.results) {
                const sim = Math.max(
                  fuzzyTextSimilarity(`${title} ${content}`, `${r.title || ''} ${r.content || ''}`),
                  fuzzyTextSimilarity(content, r.content || ''),
                  fuzzyTextSimilarity(title, r.title || '')
                );
                if (sim >= 0.55) {
                  possibleDuplicate = 1;
                  duplicateOf = r.id;
                  needsReview = 1;
                  hasDuplicate = true;
                  break;
                }
              }
            }
          } catch (e) {}

          if (possibleDuplicate) {
            needsReview = 1;
            hasNeedsReview = true;
          }

          const noteIns = await env.DB.prepare(
            `INSERT INTO notes (category, title, content, tags, raw_transcript, needs_review, confidence, possible_duplicate, duplicate_of, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(category, title, content, tags, rawTranscript || '', needsReview, confidence, possibleDuplicate, duplicateOf, env.uid).run();
          created.push({ table: 'notes', id: noteIns?.meta?.last_row_id, title, content, review: !!needsReview });
          break;
        }

        case 'update': {
          const table = action.target_table;
          const id = parseInt(action.target_id, 10);
          if (!id || isNaN(id)) {
            notFound = true;
            break;
          }

          if (table === 'finances') {
            // "не 90, а 70 тысяч арбуз": the old amount names the record. If the LLM picked a record with
            // another amount (the one meant was never saved), refuse instead of rewriting an unrelated expense.
            const oldMention = (rawTranscript || '').toLowerCase()
              .match(/(?:^|\s)не\s+(\d+(?:\s\d{3})*(?:[.,]\d+)?)\s*(к|k|тыс(?:яч[аи]?)?|млн|лям[а-я]*)?(?![а-яa-z0-9])/u);
            if (oldMention) {
              const target = await env.DB.prepare('SELECT amount FROM finances WHERE id = ? AND user_id = ?').bind(id, env.uid).first();
              const said = parseDigitAmount(oldMention[1], oldMention[2]);
              const fits = target && [said, said * 1000, said * 1000000].some(v => Math.abs(Number(target.amount) - v) < 0.01);
              if (!fits) {
                notFound = true;
                break;
              }
            }
            if (!(await voiceTargetMatches('finances', id, rawTranscript, env))) {
              notFound = true;
              break;
            }

            const rawAmount = data.amount;
            const parsedAmount = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount || '').replace(/[^0-9.]/g, ''));
            const amount = Number.isFinite(parsedAmount) ? parsedAmount : null;
            const currency = data.currency ? stripEmojis(data.currency) : null;
            const category = data.category ? stripEmojis(data.category) : null;
            const raw = data.raw_text ? stripEmojis(data.raw_text) : (rawTranscript ? stripEmojis(rawTranscript) : null);
            const title = data.title ? cleanFinanceTitle(data.title, amount) : null;

            const upd = await env.DB.prepare(
              `UPDATE finances SET 
                amount = COALESCE(?, amount), 
                currency = COALESCE(?, currency), 
                category = COALESCE(?, category), 
                title = COALESCE(?, title),
                raw_text = COALESCE(?, raw_text)
               WHERE id = ? AND user_id = ?`
            ).bind(amount, currency, category, title, raw, id, env.uid).run();
            if (!upd?.meta?.changes) notFound = true;
          } else if (table === 'tasks') {
            const title = data.title ? stripEmojis(data.title) : null;
            let due = null;
            if (data.due_datetime) {
              try {
                const parsed = new Date(data.due_datetime);
                if (!isNaN(parsed.getTime())) {
                  due = parsed.toISOString().slice(0, 19).replace('T', ' ');
                }
              } catch (e) {}
            }
            const priority = data.priority ? stripEmojis(data.priority) : null;
            const upd = await env.DB.prepare(
              `UPDATE tasks SET 
                title = COALESCE(?, title), 
                due_datetime = COALESCE(?, due_datetime), 
                priority = COALESCE(?, priority)
               WHERE id = ? AND user_id = ?`
            ).bind(title, due, priority, id, env.uid).run();
            if (!upd?.meta?.changes) notFound = true;
          } else if (table === 'notes') {
            const category = data.category ? stripEmojis(data.category) : null;
            const title = data.title ? stripEmojis(data.title) : null;
            const content = data.content ? stripEmojis(data.content) : null;
            const tags = data.tags ? stripEmojis(data.tags) : null;
            const upd = await env.DB.prepare(
              `UPDATE notes SET 
                category = COALESCE(?, category), 
                title = COALESCE(?, title), 
                content = COALESCE(?, content), 
                tags = COALESCE(?, tags)
               WHERE id = ? AND user_id = ?`
            ).bind(category, title, content, tags, id, env.uid).run();
            if (!upd?.meta?.changes) notFound = true;
          } else {
            notFound = true;
          }
          break;
        }

        case 'delete': {
          const table = action.target_table;
          const id = parseInt(action.target_id, 10);
          if (!id || isNaN(id)) break;
          if (['finances', 'tasks', 'notes'].includes(table)) {
            // Deleting is irreversible: only act when the user actually asked to remove something
            if (!/(?:удал|убер|убрат|сотр|отмен|delete|remove)/i.test(rawTranscript || '')) {
              notFound = true;
              break;
            }
            if (!(await voiceTargetMatches(table, id, rawTranscript, env))) {
              notFound = true;
              break;
            }
            const res = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, env.uid).run();
            if (!res?.meta?.changes) notFound = true;
          } else {
            notFound = true;
          }
          break;
        }
      }
    } catch (err) {
      console.error(`Error saving ${type} to D1:`, err);
    }
  }

  return { hasDuplicate, hasNeedsReview, notFound, created };
}

/** Text of a phrase for request_logs: only the owner's phrases are kept (for debugging); clients' text is never stored. */
function logSnippet(env, text) {
  const s = String(text || '');
  if (env.user?.role === 'owner') return s.slice(0, 90);
  return `[скрыто, ${s.length} симв.]`;
}

/** Drop request_logs older than LOG_RETENTION_DAYS (runs once an hour from the cron). */
async function cleanupRequestLogs(env) {
  if (!env.DB || new Date().getUTCMinutes() !== 0) return;
  try {
    // keep '-7 days' in sync with SUBSCRIPTION_DEFAULTS.LOG_RETENTION_DAYS (the SQL guard test reads this as plain text)
    await env.DB.prepare("DELETE FROM request_logs WHERE created_at < datetime('now', '-7 days')").run();
  } catch (e) {
    console.warn('request_logs cleanup skipped:', e.message);
  }
}

async function handleTelegramWebhook(request, env, url, ctx) {
  if (env.TELEGRAM_WEBHOOK_SECRET &&
      !safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET)) {
    return errorResponse('Forbidden', 403);
  }

  const update = await readJson(request);

  // Whose chat is it: the owner's, a known user's, or a new person's (created with no access yet).
  // Only private chats talk to the bot. Update ids are numbered per bot, so the replay check is shared
  // (kept with the owner), and runs before anything else happens.
  // A pre-checkout query (the last step before paying) has no chat: it carries only the payer.
  const preCheckout = update.pre_checkout_query;
  const chat = update.callback_query?.message?.chat ?? update.message?.chat;
  if (!env.DB) return jsonResponse({ ok: true });
  if (!preCheckout && (!chat || chat.id === undefined || (chat.type && chat.type !== 'private'))) {
    return jsonResponse({ ok: true });
  }

  const shared = scopeEnv(env, OWNER);
  // Payment steps skip the "newer than the last one" check: Telegram may deliver updates side by side, and a payment
  // with a smaller number must not be dropped. Both steps are safe to repeat (the charge id is unique, see handleSuccessfulPayment).
  const isPaymentStep = !!preCheckout || !!update.message?.successful_payment;
  if (Number.isInteger(update.update_id) && !isPaymentStep) {
    try {
      const last = await getSetting(shared, 'last_tg_update_id');
      if (last && update.update_id <= parseInt(last, 10)) {
        return jsonResponse({ ok: true });
      }
      await setSetting(shared, 'last_tg_update_id', update.update_id);
    } catch (e) {
      console.warn('update_id dedupe skipped:', e.message);
    }
  }

  if (preCheckout) {
    // Telegram waits ~10 seconds for the answer, so this is done right here, not in the background
    const payer = preCheckout.from || {};
    const buyer = payer.id !== undefined ? await userForTelegram(env, payer.id, payer.first_name || payer.username) : null;
    const check = buyer ? await validatePayment(await userEnv(env, buyer), buyer, preCheckout) : { error: 'Не удалось определить аккаунт' };
    await telegramCall(env, 'answerPreCheckoutQuery', check.error
      ? { pre_checkout_query_id: preCheckout.id, ok: false, error_message: check.error }
      : { pre_checkout_query_id: preCheckout.id, ok: true });
    return jsonResponse({ ok: true });
  }

  const from = update.callback_query?.from ?? update.message?.from;
  const user = await userForTelegram(env, chat.id, from?.first_name || from?.username || chat.first_name);
  if (!user) return jsonResponse({ ok: true });
  env = await userEnv(env, user);

  // Answer Telegram immediately; STT + LLM can take longer than its webhook timeout
  const job = processTelegramUpdate(update, env, url).catch(e => console.error('Telegram update failed:', e));
  if (ctx?.waitUntil) {
    ctx.waitUntil(job);
  } else {
    await job;
  }
  return jsonResponse({ ok: true });
}

async function processTelegramUpdate(update, env, url) {

  // 1. Handle Callback Query (e.g. inline button [Выполнено] or [Другое слово])
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || '';
    const token = env.TELEGRAM_BOT_TOKEN;

    const editCard = (text) => cb.message?.chat?.id && cb.message?.message_id
      ? fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: cb.message.chat.id, message_id: cb.message.message_id, text, parse_mode: 'HTML' })
        })
      : null;
    const answer = (text) => fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cb.id, text })
    });

    // (the buttons that edit or delete one's own records work without a subscription, too)
    if (data === 'sub_buy') {
      await answer('');
      if (cb.message?.chat?.id) await sendSubscriptionInvoice(env, cb.message.chat.id);
    } else if (data === 'delme_no') {
      await answer('Отменено');
      await editCard('<i>Удаление отменено.</i>');
    } else if (data === 'delme_yes') {
      const res = await deleteMyData(env);
      await answer(res.ok ? 'Готово' : 'Не удалось');
      await editCard(res.ok ? '<i>Все ваши данные удалены.</i>' : `<i>${escapeHtml(res.error)}</i>`);
    } else if (data === 'trial_start') {
      const res = await startTrial(env);
      await answer(res.ok ? 'Пробный период начался' : res.error);
      if (res.ok && cb.message?.chat?.id) await sendTelegramMessage(token, cb.message.chat.id, trialStartedText(res, env), null, 'HTML');
    } else if (data.startsWith('done_')) {
      const taskId = parseInt(data.split('_')[1], 10);
      const task = env.DB && taskId ? await env.DB.prepare('SELECT title FROM tasks WHERE id = ? AND user_id = ?').bind(taskId, env.uid).first() : null;
      if (task) await env.DB.prepare('UPDATE tasks SET is_completed = 1 WHERE id = ? AND user_id = ?').bind(taskId, env.uid).run();
      await answer(task ? 'Готово' : 'Задача уже удалена');
      await editCard(task
        ? `<i>Выполнено</i>\n<blockquote><s>${escapeHtml(stripEmojis(task.title))}</s></blockquote>`
        : '<i>Задача уже удалена</i>');
    } else if (data.startsWith('snooze_')) {
      // Postpone: the task is due again in 10 minutes and its ping counter restarts
      const taskId = parseInt(data.split('_')[1], 10);
      const task = env.DB && taskId ? await env.DB.prepare('SELECT title FROM tasks WHERE id = ? AND user_id = ? AND is_completed = 0').bind(taskId, env.uid).first() : null;
      if (task) {
        await env.DB.prepare(
          "UPDATE tasks SET due_datetime = datetime('now', '+10 minutes'), reminded = 0, is_date_only = 0 WHERE id = ? AND user_id = ?"
        ).bind(taskId, env.uid).run();
      }
      await answer(task ? 'Напомню через 10 минут' : 'Задача уже закрыта');
      if (task) {
        const at = tgDueLabel(new Date(Date.now() + 10 * 60000).toISOString(), 0, new Date(), env.tzMs);
        await editCard(`<i>Отложено</i>\n<blockquote><b>${escapeHtml(stripEmojis(task.title))}</b>\nнапомню ${escapeHtml(at)}</blockquote>`);
      }
    } else if (/^del_(finances|tasks|notes|vocabulary)_\d+$/.test(data) && env.DB) {
      // "Удалить" under a saved-record card
      const [, table, idStr] = data.match(/^del_(\w+)_(\d+)$/);
      const res = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(parseInt(idStr, 10), env.uid).run();
      const gone = !!res?.meta?.changes;
      await answer(gone ? 'Удалено' : 'Запись уже удалена');
      const first = String(cb.message?.text || '').split('\n')[0];
      await editCard(`<s>${escapeHtml(first)}</s>\n<i>Удалено</i>`);
    } else if (data === 'vocab_next' && env.DB) {
      const wordRow = await env.DB.prepare('SELECT * FROM vocabulary WHERE user_id = ? ORDER BY RANDOM() LIMIT 1').bind(env.uid).first();
      if (wordRow && cb.message?.chat?.id && cb.message?.message_id) {
        const { text: msg, markup } = wordMessage(wordRow, env);
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            text: msg,
            reply_markup: markup,
            parse_mode: 'HTML'
          })
        });
      }

      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id, text: 'Слово обновлено' })
      });
    } else if ((data === 'vocab_freq' || data.startsWith('vocab_mode_')) && env.DB) {
      // "Как часто присылать": swap the word's buttons for the frequency choice; a choice saves it and brings them back
      let current = await getVocabReminderMode(env);
      let answer = '';
      const picked = data.startsWith('vocab_mode_') ? data.slice('vocab_mode_'.length) : null;
      if (picked && Object.prototype.hasOwnProperty.call(VOCAB_REMINDER_MODES, picked)) {
        await setSetting(env, 'vocab_reminders', picked);
        current = picked;
        answer = picked === 'off' ? 'Слова больше не присылаю. Включить можно в настройках TRACE.' : `Буду присылать слова ${VOCAB_MODE_LABELS[picked].toLowerCase()}.`;
      }
      const markup = picked ? wordKeyboard(env) : {
        inline_keyboard: [
          ...Object.keys(VOCAB_MODE_LABELS).map(m => [{ text: (m === current ? '● ' : '') + VOCAB_MODE_LABELS[m], callback_data: `vocab_mode_${m}` }]),
          [{ text: 'Назад к слову', callback_data: 'vocab_mode_keep' }]
        ]
      };
      if (cb.message?.chat?.id && cb.message?.message_id) {
        await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: markup })
        });
      }
      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id, text: answer })
      });
    }
    return jsonResponse({ ok: true });
  }

  const message = update.message;
  if (!message) return jsonResponse({ ok: true });

  const chatId = message.chat?.id;
  const text = (message.text || '').trim();
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!token || !chatId) return jsonResponse({ ok: true });

  // Money arrived (Telegram Stars): switch the subscription on
  if (message.successful_payment) {
    await handleSuccessfulPayment(env, chatId, message);
    return jsonResponse({ ok: true });
  }

  // The owner's chat_id is kept in D1 so the Cron reminder always knows who to push (other users: users.telegram_id)
  if (env.DB && env.uid === OWNER_ID) {
    try {
      await setSetting(env, 'telegram_chat_id', chatId);
      await env.rawDB.prepare('UPDATE users SET telegram_id = ? WHERE id = ?').bind(Number(chatId), OWNER_ID).run();
      // Check and fire any pending reminders right away!
      await checkAndSendReminders(env);
    } catch (e) {
      console.error('Error saving telegram_chat_id:', e);
    }
  }

  const appUrl = `${url.origin}/app?v=${BUILD_VERSION}`;

  // Commands /start or /app
  if (text.startsWith('/start') || text.startsWith('/app')) {
    const offer = await accessOffer(env);
    const welcomeText = `<b>TRACE Copilot</b> подключен к вашему аккаунту.\n\n` +
      `Голосовой ассистент, учет финансов, задачи, банк памяти и английский словарь.\n\n` +
      `<i>Напоминания по задачам будут приходить сюда по расписанию.</i>\n\n` +
      (offer.line ? `<i>${escapeHtml(offer.line)} Уже сделанные записи можно смотреть в приложении.</i>\n\n` : '') +
      `Нажмите кнопку ниже, чтобы открыть приложение:`;

    await sendTelegramMessage(token, chatId, welcomeText, {
      inline_keyboard: [
        ...offer.rows,
        [{ text: 'Открыть TRACE Mini App', web_app: { url: appUrl } }]
      ]
    }, 'HTML');
    return jsonResponse({ ok: true });
  }

  // Subscription commands (work for everybody, also without access)
  const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
  const commandName = command ? command[1].toLowerCase() : '';
  if (commandName === 'subscribe') {
    await sendSubscriptionInvoice(env, chatId);
    return jsonResponse({ ok: true });
  }
  if (commandName === 'status') {
    const card = await subscriptionCard(env);
    await sendTelegramMessage(token, chatId, card.text, card.markup, 'HTML');
    return jsonResponse({ ok: true });
  }
  if (commandName === 'token' || commandName === 'shortcut') {
    const reissue = /^new\b/i.test(String(command[2] || '').trim());
    const had = await hasToken(env);
    const steps = shortcutSteps(env, url.origin);
    const list = (steps.ready.length ? steps.ready : steps.manual).map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join('\n') +
      '\n\n<i>Как вынести на кнопку</i>\n' + steps.placement.map((s, i) => `${i + 1}. ${escapeHtml(s)}`).join('\n');
    if (commandName === 'shortcut' || (had && !reissue)) {
      await sendTelegramMessage(token, chatId,
        '<i>Кнопка на iPhone</i>\n<blockquote>' + (had ? 'Токен уже выдан, он показывается один раз.' : 'Токена ещё нет: /token выдаст его.') +
        ' Потеряли токен или кажется, что он утёк: /token new выдаст новый, старый перестанет работать.</blockquote>\n' + list, null, 'HTML');
      return jsonResponse({ ok: true });
    }
    const personal = await issueToken(env);
    await sendTelegramMessage(token, chatId,
      '<i>' + (had ? 'Новый токен (старый больше не работает)' : 'Ваш личный токен для кнопки на iPhone') + '</i>\n<blockquote><code>' + personal + '</code></blockquote>\n' +
      '<i>Нажмите на токен, чтобы скопировать. Он показывается один раз, никому его не показывайте. После настройки удалите это сообщение.</i>\n\n' + list, null, 'HTML');
    return jsonResponse({ ok: true });
  }
  if (commandName === 'paysupport') {
    await sendTelegramMessage(token, chatId,
      '<i>Вопросы по оплате</i>\n<blockquote>Оплата идёт через Telegram Stars. Если Stars списались, а подписка не включилась, или нужен возврат, напишите в поддержку: укажите дату и сумму платежа. Условия возврата: /terms</blockquote>' + supportLine(env), null, 'HTML');
    return jsonResponse({ ok: true });
  }
  if (commandName === 'terms' || commandName === 'privacy') {
    await sendTelegramMessage(token, chatId, termsCardHtml(await termsSections(env)), null, 'HTML');
    return jsonResponse({ ok: true });
  }
  if (commandName === 'delete_me') {
    if (env.uid === OWNER_ID) {
      await sendTelegramMessage(token, chatId, '<i>Данные владельца так не удаляются.</i>', null, 'HTML');
    } else {
      await sendTelegramMessage(token, chatId,
        '<i>Удалить все мои данные?</i>\n<blockquote>Будут стёрты все ваши траты, задачи, заметки, слова и настройки. Вернуть их будет нельзя. Подписка и оплаты останутся.</blockquote>',
        { inline_keyboard: [[{ text: 'Да, удалить всё', callback_data: 'delme_yes' }, { text: 'Отмена', callback_data: 'delme_no' }]] }, 'HTML');
    }
    return jsonResponse({ ok: true });
  }
  if (commandName === 'help') {
    await sendTelegramMessage(token, chatId,
      '<i>Как пользоваться</i>\n<blockquote>Скажите голосом или напишите: «кофе 50к», «завтра в 9 позвонить маме», «заметка: ...». TRACE разложит фразу на траты, задачи и заметки.</blockquote>\n' +
      '<pre>/subscribe   оформить или продлить\n/status      до какого числа оплачено\n/token       кнопка на iPhone (Shortcut)\n/paysupport  вопросы по оплате\n/terms       условия и данные\n/delete_me   удалить все мои данные\n/help        эта подсказка</pre>' + supportLine(env) +
      (env.uid === OWNER_ID ? '\n\n<i>Для владельца</i>\n<pre>/users       люди и счётчики\n/usage       расход ИИ\n/grant N дни выдать доступ\n/revoke N    закрыть доступ\n/refund N    вернуть платёж\n/journal     кто и когда выдал или вернул</pre>' : ''), null, 'HTML');
    return jsonResponse({ ok: true });
  }
  if (['users', 'usage', 'grant', 'revoke', 'journal'].includes(commandName)) {
    if (env.uid !== OWNER_ID) {
      await sendTelegramMessage(token, chatId, '<i>Эта команда недоступна.</i>', null, 'HTML');
      return jsonResponse({ ok: true });
    }
    if (commandName === 'users') {
      await sendTelegramMessage(token, chatId, await usersCommandText(env), null, 'HTML');
    } else if (commandName === 'journal') {
      await sendTelegramMessage(token, chatId, await journalText(env), null, 'HTML');
    } else if (commandName === 'usage') {
      await flushUsage(env);
      await sendTelegramMessage(token, chatId, '<i>Расход ИИ</i>\n' + usageText(await usageTotals(env, 7), 7), null, 'HTML');
    } else {
      const res = await (commandName === 'grant' ? adminGrant : adminRevoke)(env, command[2]);
      await sendTelegramMessage(token, chatId, `<i>${escapeHtml(res.error || res.text)}</i>`, null, 'HTML');
    }
    return jsonResponse({ ok: true });
  }
  if (commandName === 'refund') {
    if (env.uid !== OWNER_ID) {
      await sendTelegramMessage(token, chatId, '<i>Эта команда недоступна.</i>', null, 'HTML');
      return jsonResponse({ ok: true });
    }
    const id = parseInt(command[2], 10);
    const res = id ? await refundPayment(env, id) : { ok: false, error: 'Укажите номер платежа: /refund 12' };
    await sendTelegramMessage(token, chatId, res.ok ? `<i>Платёж №${id} возвращён.</i>` : `<i>${escapeHtml(res.error)}</i>`, null, 'HTML');
    return jsonResponse({ ok: true });
  }

  // Command: /word or /vocab (Instant vocabulary word test/push)
  if (text.startsWith('/word') || text.startsWith('/vocab')) {
    const wordRow = await env.DB.prepare('SELECT * FROM vocabulary WHERE user_id = ? ORDER BY RANDOM() LIMIT 1').bind(env.uid).first();
    if (!wordRow) {
      await sendTelegramMessage(token, chatId, 'В словаре пока нет сохраненных слов. Добавьте слово голосом или через Mini App.', null, 'HTML');
    } else {
      await sendWordPush(env, chatId, wordRow);
    }
    return jsonResponse({ ok: true });
  }

  // Command: /digest or /stats or /finances (Instant daily expense recap)
  if (text.startsWith('/digest') || text.startsWith('/stats') || text.startsWith('/finances')) {
    await checkDailyExpenseDigest(env, chatId, true);
    return jsonResponse({ ok: true });
  }

  // Recording new things needs access (owner, trial or subscription); everything above is read-only
  // (and counts toward the day's limit: this is the part that spends the API quota)
  if (message.voice || message.audio || text) {
    const gate = await recordingGate(env);
    if (!gate.ok) {
      await sendTelegramMessage(token, chatId, escapeHtml(gate.text), gate.markup, 'HTML');
      return jsonResponse({ ok: true });
    }
  }

  // Handle Voice / Audio messages directly in Telegram bot
  if (message.voice || message.audio) {
    try {
      // Send chat action: record_audio or typing
      fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'record_voice' })
      }).catch(() => {});

      const voiceObj = message.voice || message.audio;
      const fileId = voiceObj.file_id;

      // 1. Get Telegram file path
      const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
      const fileInfo = await fileRes.json();
      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        throw new Error('Не удалось получить файл голосового сообщения из Telegram');
      }

      // 2. Download audio binary
      const downloadUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`;
      const audioRes = await fetch(downloadUrl);
      if (!audioRes.ok) throw new Error('Не удалось загрузить аудио из Telegram');

      const arrayBuffer = await audioRes.arrayBuffer();
      const audioBytes = new Uint8Array(arrayBuffer);
      const audioBase64 = arrayBufferToBase64(arrayBuffer);
      const audioMime = message.voice ? 'audio/ogg' : (voiceObj.mime_type || 'audio/mp4');

      // 3. Transcribe speech using multi-provider cascade (Groq -> CF Whisper Large Turbo)
      let whisperText = '';
      try {
        let vocabList = ['Камрань (CXR)', 'Sparc', 'Meta Ad Library'];
        if (env.DB) {
          const vRes = await env.DB.prepare('SELECT word FROM vocabulary WHERE user_id = ?').bind(env.uid).all();
          if (vRes?.results) vocabList = vRes.results.map(r => r.word);
        }
        whisperText = await transcribeSpeech(audioBytes, audioMime, vocabList, env);
      } catch (wErr) {
        console.error('Telegram STT transcribe error:', wErr);
      }

      // Silence that Whisper filled with subtitle credits: nothing was said
      if (whisperText && isSttHallucination(whisperText) && !message.caption) {
        await releaseRecordingSlot(env);
        await sendTelegramMessage(token, chatId, 'Не расслышал. Запиши ещё раз, пожалуйста.', null, 'HTML');
        return jsonResponse({ ok: true });
      }
      const effectiveText = message.caption ? `${message.caption} ${whisperText}`.trim() : (whisperText || '');
      const audioForAI = whisperText ? '' : audioBase64;   // STT failed entirely: let Gemini listen

      // 4. Classification (same safety net as the Shortcut: "<сумма> <на что>" is always an expense)
      const classification = enforceExpenseShape(await classifyWithGemini({
        text: effectiveText,
        audioBase64: audioForAI,
        mimeType: audioMime
      }, env), effectiveText, env.DEFAULT_CURRENCY || 'VND');

      const recognizedText = effectiveText || classification.raw_text || '';
      const persisted = await persistToD1(classification, recognizedText, null, env);
      if (persisted?.notFound) await releaseRecordingSlot(env);
      const { text: replyMsg, markup } = savedCard(persisted, recognizedText, classification, env);
      await sendTelegramMessage(token, chatId, replyMsg, markup, 'HTML');
      return jsonResponse({ ok: true });
    } catch (err) {
      await releaseRecordingSlot(env);
      await sendTelegramMessage(token, chatId, `Ошибка обработки голоса: ${escapeHtml(publicError(env, err))}`, null, 'HTML');
      return jsonResponse({ ok: true });
    }
  }

  // If text message is received directly in bot, process it via TRACE AI router!
  if (!text) return jsonResponse({ ok: true });

  try {
    const classification = enforceExpenseShape(await classifyWithGemini(text, env), text, env.DEFAULT_CURRENCY || 'VND');
    const persisted = await persistToD1(classification, text, null, env);
    if (persisted?.notFound) await releaseRecordingSlot(env);
    // The user just typed the phrase: no need to quote it back
    const { text: replyMsg, markup } = savedCard(persisted, '', classification, env);
    await sendTelegramMessage(token, chatId, replyMsg, markup, 'HTML');
  } catch (err) {
    await releaseRecordingSlot(env);
    await sendTelegramMessage(token, chatId, `Ошибка обработки: ${escapeHtml(publicError(env, err))}`, null, 'HTML');
  }

  return jsonResponse({ ok: true });
}

/**
 * Main scheduled handler: Tasks, Spaced Vocab Reminders, Daily Expense Digest
 */
async function checkAndSendReminders(env, options = {}) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'DB or bot token missing' };

  try {
    // 1. Get user's chat_id from settings or env
    const chatId = await getUserChatId(env);
    if (!chatId) return { ok: false, error: 'telegram_chat_id not set yet. Send any message or /start to @my_trace_voice_bot.' };

    // Fast pass (every minute): only the due-task reminders
    if (options.tasksOnly) {
      return { ok: true, chatId, tasksSent: await checkDueTasks(env, chatId) };
    }

    // Recurring items first: a task they add today is in the morning summary and gets its reminder
    let recurringFired = [];
    try {
      recurringFired = await runRecurring(env);
    } catch (e) {
      console.error('Recurring run failed:', e);
    }
    const tasksSent = await checkDueTasks(env, chatId);
    const vocabSent = await checkVocabReminder(env, chatId, options.forceVocab || false);
    const digestSent = await checkDailyExpenseDigest(env, chatId, options.forceDigest || false);
    const morningSent = await checkMorningSummary(env, chatId, options.forceMorning || false);
    let reportSent = null;
    try {
      reportSent = await checkWeeklyOwnerReport(env, chatId);
    } catch (e) {
      console.error('Weekly owner report failed:', e);
    }
    let subscriptionNotice = null;
    try {
      subscriptionNotice = await checkSubscriptionReminder(env, chatId);
    } catch (e) {
      console.error('Subscription reminder failed:', e);
    }

    return {
      subscriptionNotice,
      ok: true,
      chatId,
      recurringFired,
      tasksSent,
      vocabSent,
      digestSent,
      morningSent,
      reportSent
    };
  } catch (err) {
    console.error('Error in checkAndSendReminders:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * The minute cron for everybody. D1 allows a limited number of queries per run, so the work is split:
 *  - the owner gets the full pass every minute (as before);
 *  - everyone else gets the due-task pass only when ONE shared query says they have a reminder due,
 *    and the slow pass (digest, morning summary, words, recurring) every 5th minute.
 * Only people who may record (trial or subscription not over) are served; each one in their own chat and time.
 * One person's failure never stops the others.
 */
async function runCronForAllUsers(env, now = new Date()) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return { ok: false, error: 'DB or bot token missing' };
  const results = {};
  try { await flushUsage(env); } catch (e) { console.error('Cron: usage flush failed:', e); }
  let people = [];
  try {
    people = (await env.DB.prepare(
      "SELECT * FROM users WHERE id = ? OR (telegram_id IS NOT NULL AND status IN ('trial', 'active') AND (sub_until IS NULL OR sub_until > datetime('now')))"
    ).bind(OWNER_ID).all()).results || [];
  } catch (e) {
    console.error('Cron: cannot list users:', e);
    people = [OWNER];
  }
  if (!people.some(p => p.id === OWNER_ID)) people.unshift(OWNER);

  let dueIds = new Set();
  try {
    const due = await env.DB.prepare(
      `SELECT DISTINCT user_id FROM tasks
       WHERE is_completed = 0 AND due_datetime IS NOT NULL AND COALESCE(reminded, 0) < 3
         AND (
           (is_date_only = 1 AND datetime(due_datetime) BETWEEN datetime('now', '-2 days') AND datetime('now', '+1 day'))   -- a wide net: the exact moment depends on the zone
           OR (datetime(due_datetime, (COALESCE(reminded, 0) * 30) || ' minutes') <= datetime('now', '+2 minutes')
               AND (COALESCE(reminded, 0) = 0 OR datetime(due_datetime) > datetime('now', '-3 hours')))
         )`
    ).all();
    dueIds = new Set((due.results || []).map(r => r.user_id));
  } catch (e) {
    console.error('Cron: due-task scan failed:', e);
  }

  const slowPass = now.getUTCMinutes() % 5 === 0;
  if (slowPass) {
    try {
      const ended = await notifyEndedSubscriptions(env);
      if (ended.length) results.ended = ended;
    } catch (e) {
      console.error('Cron: ended-subscription pass failed:', e);
    }
  }
  for (const person of people) {
    const owner = person.id === OWNER_ID;
    if (!owner && !slowPass && !dueIds.has(person.id)) continue;
    try {
      const uenv = await userEnv(env, owner ? OWNER : person);
      results[person.id] = await checkAndSendReminders(uenv, { tasksOnly: !owner && !slowPass });
    } catch (e) {
      console.error(`Cron failed for user ${person.id}:`, e);
      results[person.id] = { ok: false, error: e.message };
    }
  }
  return results;
}

/** Telegram chat of the user env is scoped to: the owner's saved chat, or users.telegram_id of anyone else. */
async function getUserChatId(env) {
  if (env.uid === OWNER_ID) return await getOwnerChatId(env);
  return env.user?.telegram_id ? String(env.user.telegram_id) : null;
}

/** Public base URL of this Worker (used for Mini App buttons); override with APP_URL. */
function appBaseUrl(env) {
  return String(env.APP_URL || 'https://tpl-trace-copilot.jstivn.workers.dev').replace(/\/+$/, '');
}

/**
 * 1. Check and send due task notifications
 */
async function checkDueTasks(env, chatId) {
  // `reminded` counts pings already sent. Ping k (k = 1, 2) repeats 30*k minutes after the due time
  // until the task is done, so a missed reminder is not lost; at most 3 pings in total.
  // A repeat is only sent within 3 hours of the due time (no burst for old, never-completed tasks).
  // A date-only task ("on the 5th") is stored as that date at 00:00 and pings at 07:00 of the person's own morning:
  // for Nha Trang (UTC+7) that is 00:00 as stored, for every other zone the moment is shifted by the difference.
  const shift = 420 - env.tzMin;
  const dueAt = `CASE WHEN is_date_only = 1 THEN datetime(due_datetime, '${shift >= 0 ? '+' : '-'}${Math.abs(shift)} minutes') ELSE due_datetime END`;
  const dueTasks = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE user_id = ? AND is_completed = 0
       AND due_datetime IS NOT NULL
       AND COALESCE(reminded, 0) < 3
       AND datetime(${dueAt}, (COALESCE(reminded, 0) * 30) || ' minutes') <= datetime('now', '+2 minutes')
       AND (COALESCE(reminded, 0) = 0 OR datetime(${dueAt}) > datetime('now', '-3 hours'))
     LIMIT 5`
  ).bind(env.uid).all();
  // NB: a reminder never completes the task; that stays the user's action

  const sent = [];
  for (const task of (dueTasks.results || [])) {
    const cleanTitle = stripEmojis(task.title);
    const repeat = Number(task.reminded || 0);
    const when = tgDueLabel(task.due_datetime, task.is_date_only, new Date(), env.tzMs);
    const msg = `<i>Напоминание${repeat > 0 ? `, повтор ${repeat}` : ''}</i>\n` +
      `<blockquote><b>${escapeHtml(cleanTitle)}</b>${when ? '\n' + escapeHtml(when) : ''}</blockquote>`;
    const markup = {
      inline_keyboard: [
        [
          { text: 'Выполнено', callback_data: `done_${task.id}` },
          { text: 'Через 10 минут', callback_data: `snooze_${task.id}` }
        ],
        [
          { text: 'Открыть TRACE', web_app: { url: appOpenUrl(env, 'task', task.id) } }
        ]
      ]
    };

    const sendRes = await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg, markup, 'HTML');

    if (sendRes?.ok) {
      await env.DB.prepare('UPDATE tasks SET reminded = COALESCE(reminded, 0) + 1 WHERE id = ? AND user_id = ?').bind(task.id, env.uid).run();
      sent.push(cleanTitle);
    } else {
      console.error('Failed to send reminder for task', task.id, sendRes);
    }
  }
  return sent;
}

/**
 * 2. Vocabulary Push Reminder (Spaced Repetition)
 * Sends a word periodically during daytime (09:00 - 22:00 Nha Trang time, UTC+7)
 */
async function checkVocabReminder(env, chatId, force = false) {
  const now = new Date();
  const localHour = new Date(now.getTime() + env.tzMs).getUTCHours();

  // Daytime for this person: 09:00 to 22:00
  if (!force && (localHour < 9 || localHour >= 22)) {
    return null;
  }

  const mode = VOCAB_REMINDER_MODES[await getVocabReminderMode(env)];
  if (!force && !mode) return null;   // switched off by the user

  const lastValue = await getSetting(env, 'last_vocab_reminder');
  let lastDate = null;
  if (lastValue) {
    const d = new Date(lastValue.replace(' ', 'T') + (lastValue.endsWith('Z') ? '' : 'Z'));
    if (!isNaN(d.getTime())) lastDate = d;
  }

  if (!force && lastDate) {
    if (mode === 'interval') {
      // Every 3 hours
      if ((now.getTime() - lastDate.getTime()) / 60000 < 180) return null;
    } else {
      // Fixed slots (10:00, 18:00 local): send once the latest passed slot of today has not been served yet
      const slot = mode.filter(h => h <= localHour).pop();
      if (slot === undefined) return null;
      const localNow = new Date(now.getTime() + env.tzMs);
      const localMidnightUtc = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - env.tzMs;
      if (lastDate.getTime() >= localMidnightUtc + slot * 3600000) return null;
    }
  } else if (!force && mode !== 'interval' && mode.every(h => h > localHour)) {
    return null;                       // never sent yet: still wait for the first slot of the day
  }

  const wordRow = await env.DB.prepare('SELECT * FROM vocabulary WHERE user_id = ? ORDER BY RANDOM() LIMIT 1').bind(env.uid).first();
  if (!wordRow) return null;

  return await sendWordPush(env, chatId, wordRow);
}

const VOCAB_MODE_LABELS = { off: 'Не присылать', daily: 'Раз в день', twice: 'Два раза в день', often: 'Каждые 3 часа' };

function wordKeyboard(env) {
  return {
    inline_keyboard: [
      [
        { text: 'Другое слово', callback_data: 'vocab_next' },
        { text: 'Открыть словарь', web_app: { url: `${appBaseUrl(env)}/app?v=${BUILD_VERSION}` } }
      ],
      [{ text: 'Как часто присылать', callback_data: 'vocab_freq' }]
    ]
  };
}

/**
 * Word card for Telegram:
 *   resilient  [рези́лиент]
 *   устойчивый
 *
 *   She is resilient.
 *   Она стойкая.
 */
function wordMessage(wordRow, env) {
  const word = stripEmojis(wordRow.word);
  const translation = stripEmojis(wordRow.translation);
  const phonetic = stripEmojis(wordRow.phonetic || '');
  const example = stripEmojis(wordRow.example || '');

  let text = `<b>${escapeHtml(word)}</b>` + (phonetic ? `  ${escapeHtml(phonetic)}` : '') + `\n${escapeHtml(translation)}`;
  if (example) {
    // Examples are stored as "English sentence. (Русский перевод.)"
    const m = example.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    text += m
      ? `\n\n<i>${escapeHtml(m[1])}</i>\n${escapeHtml(m[2])}`
      : `\n\n<i>${escapeHtml(example)}</i>`;
  }
  return { text, markup: wordKeyboard(env) };
}

async function sendWordPush(env, chatId, wordRow) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const word = stripEmojis(wordRow.word);
  const translation = stripEmojis(wordRow.translation);
  const phonetic = stripEmojis(wordRow.phonetic || '');
  const { text: msg, markup } = wordMessage(wordRow, env);

  const res = await sendTelegramMessage(token, chatId, msg, markup, 'HTML');
  if (res?.ok) {
    await setSetting(env, 'last_vocab_reminder', sqlNow());
    return { word, translation, phonetic };
  }
  return null;
}

/**
 * 3. Daily Expense Digest
 * Automatically fires at 12:00 AM (00:00 midnight Nha Trang time, UTC+7)
 * to summarize the completed calendar day of expenses.
 */
async function checkDailyExpenseDigest(env, chatId, force = false) {
  const now = new Date();
  const localHour = new Date(now.getTime() + env.tzMs).getUTCHours();

  // Automatically fires at midnight (00:00) in the person's own time
  if (!force && localHour !== 0) {
    return null;
  }

  // If midnight: summarize the day that just concluded. If forced mid-day: summarize today so far.
  const isMidnight = localHour === 0;
  const targetDateObj = isMidnight
    ? new Date(now.getTime() + env.tzMs - 24 * 60 * 60 * 1000)
    : new Date(now.getTime() + env.tzMs);
  const targetDateStr = targetDateObj.toISOString().slice(0, 10);

  const lastDigest = await getSetting(env, 'last_daily_digest_date');
  if (!force && lastDigest === targetDateStr) {
    return null; // Already sent for this day
  }

  const txQuery = await env.DB.prepare(
    `SELECT * FROM finances
     WHERE user_id = ? AND date(created_at, '${env.tzSql}') = ?
       AND (needs_review IS NULL OR needs_review = 0)
       AND (possible_duplicate IS NULL OR possible_duplicate = 0)
     ORDER BY created_at ASC`
  ).bind(env.uid, targetDateStr).all();

  await refreshRates(env);
  const transactions = txQuery.results || [];
  const targetCurrency = (env.DEFAULT_CURRENCY || 'VND').toUpperCase();

  let total = 0;
  let outsideTotal = 0;
  const categories = { food: 0, car: 0, tech: 0, services: 0, other: 0 };
  for (const tx of transactions) {
    const amt = convertCurrency(Number(tx.amount || 0), tx.currency || 'VND', targetCurrency);
    if (tx.outside_limit || tx.is_debt) { outsideTotal += amt; continue; } // planned purchase or a debt: not in the limit
    total += amt;
    const cat = Object.prototype.hasOwnProperty.call(categories, tx.category) ? tx.category : 'other';
    categories[cat] += amt;
  }

  const { enabled: limitOn, amountVnd: dailyLimitVnd } = await getDailyLimit(env);
  const limitConverted = limitOn ? convertCurrency(dailyLimitVnd, 'VND', targetCurrency) : 0;

  // Пятница, 30 октября
  // 1 245 000 ₫ из 300 000 ₫
  //   Еда        520 000      (monospace block)
  //   Транспорт  120 000
  // Сверх лимита на 945 000 ₫ · 7 трат
  let msg = `<i>${escapeHtml(tgDayLabel(targetDateStr))}</i>\n`;
  if (transactions.length === 0) {
    msg += 'Трат не было.';
  } else {
    msg += `<b>${escapeHtml(tgMoney(total, targetCurrency))}</b>` + (limitOn ? ` из ${escapeHtml(tgMoney(limitConverted, targetCurrency))}` : '') + '\n';
    const rows = Object.entries(categories).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [TG_CATEGORY_LABELS[k], tgMoney(v, targetCurrency).replace(/\s*[₫₽]$/, '')]);
    const labelW = Math.max(...rows.map(r => r[0].length));
    const amountW = Math.max(...rows.map(r => r[1].length));
    msg += `<pre>${rows.map(([l, a]) => escapeHtml(l.padEnd(labelW + 2) + a.padStart(amountW))).join('\n')}</pre>\n`;
    const count = `${transactions.length} ${plural(transactions.length, 'трата', 'траты', 'трат')}`;
    if (limitOn) {
      msg += total > limitConverted
        ? `<b>Сверх лимита на ${escapeHtml(tgMoney(total - limitConverted, targetCurrency))}</b> · ${count}`
        : `Осталось ${escapeHtml(tgMoney(limitConverted - total, targetCurrency))} · ${count}`;
    } else {
      msg += count;
    }
    if (outsideTotal > 0) msg += `\n<i>Вне лимита: ${escapeHtml(tgMoney(outsideTotal, targetCurrency))}</i>`;
  }

  const markup = {
    inline_keyboard: [
      [
        { text: 'Открыть траты', web_app: { url: appOpenUrl(env) } }
      ]
    ]
  };

  const res = await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg, markup, 'HTML');
  if (res?.ok) {
    await setSetting(env, 'last_daily_digest_date', targetDateStr);
    return { date: targetDateStr, total, count: transactions.length };
  }
  return null;
}

/**
 * 4. Recurring payments: on its day of the month an item adds an expense (outside the daily limit,
 * it is planned) and/or a task. Runs from the minute cron, once per item per month; a day that does
 * not exist in a short month (31st in November) falls on the last day of that month.
 */
async function runRecurring(env, now = new Date()) {
  const today = localDateOf(now.getTime(), env.tzMs);
  const month = today.slice(0, 7);
  const dayNow = Number(today.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();

  const res = await env.DB.prepare("SELECT * FROM recurring WHERE user_id = ? AND COALESCE(last_run_month, '') != ?").bind(env.uid, month).all();
  const fired = [];
  for (const r of (res.results || [])) {
    if (Math.min(Number(r.day_of_month), daysInMonth) > dayNow) continue;
    // Claim the month first, so two overlapping cron runs cannot add it twice
    const claim = await env.DB.prepare("UPDATE recurring SET last_run_month = ? WHERE id = ? AND user_id = ? AND COALESCE(last_run_month, '') != ?")
      .bind(month, r.id, env.uid, month).run();
    if (!claim.meta?.changes) continue;

    if (r.add_expense && Number(r.amount) > 0) {
      await env.DB.prepare(
        'INSERT INTO finances (amount, currency, category, title, raw_text, outside_limit, user_id) VALUES (?, ?, ?, ?, ?, 1, ?)'
      ).bind(r.amount, r.currency || 'VND', r.category || 'other', r.title, r.title, env.uid).run();
    }
    if (r.add_task) {
      await env.DB.prepare('INSERT INTO tasks (title, due_datetime, is_date_only, user_id) VALUES (?, ?, 1, ?)')
        .bind(r.title, `${today} 00:00:00`, env.uid).run();
    }
    fired.push(r.title);
  }
  return fired;
}

/** First month a new/changed item may fire in: this month if its day has not passed, else next month. */
function recurringStartMonth(day, now = new Date(), offMs = NHA_TRANG_OFFSET_MS) {
  const today = localDateOf(now.getTime(), offMs);
  const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  return Math.min(day, daysInMonth) >= Number(today.slice(8, 10)) ? null : today.slice(0, 7);
}

/**
 * 5. Morning summary: the tasks planned for today, once a day from 08:00 Nha Trang time.
 * Nothing is sent on a day without tasks.
 */
async function checkMorningSummary(env, chatId, force = false) {
  const now = new Date();
  const localHour = new Date(now.getTime() + env.tzMs).getUTCHours();
  if (!force && (localHour < 8 || localHour >= 12)) return null;
  if (!force && !(await getMorningEnabled(env))) return null;

  const today = localDateOf(now.getTime(), env.tzMs);
  if (!force && (await getSetting(env, 'last_morning_date')) === today) return null;
  await setSetting(env, 'last_morning_date', today);

  const res = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE user_id = ? AND is_completed = 0 AND due_datetime IS NOT NULL
       AND (needs_review IS NULL OR needs_review = 0) AND (possible_duplicate IS NULL OR possible_duplicate = 0)
       AND CASE WHEN is_date_only = 1 THEN date(due_datetime) ELSE date(due_datetime, '${env.tzSql}') END = ?
     ORDER BY is_date_only DESC, due_datetime ASC`
  ).bind(env.uid, today).all();
  const tasks = res.results || [];
  if (!tasks.length) return null;

  const rows = tasks.map(t => {
    let time = 'весь день';
    if (!t.is_date_only) {
      const ms = new Date(String(t.due_datetime).replace(' ', 'T') + 'Z').getTime() + env.tzMs;
      time = new Date(ms).toISOString().slice(11, 16);
    }
    return `${time.padEnd(9)}${stripEmojis(t.title)}`;
  });
  const msg = `<i>${escapeHtml(tgDayLabel(today))}</i>\n` +
    `<blockquote><b>На сегодня ${tasks.length} ${plural(tasks.length, 'задача', 'задачи', 'задач')}</b></blockquote>\n` +
    `<pre>${rows.map(escapeHtml).join('\n')}</pre>`;
  const markup = { inline_keyboard: [[{ text: 'Открыть задачи', web_app: { url: appOpenUrl(env) } }]] };
  const sent = await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg, markup, 'HTML');
  return sent?.ok ? { date: today, count: tasks.length } : null;
}

async function getMorningEnabled(env) {
  try {
    return (await getSetting(env, 'morning_off')) !== '1';
  } catch (e) {
    return true;
  }
}

// ================= Telegram cards (style "B": quote block for the main fact, aligned columns) =================
const TG_CATEGORY_LABELS = { food: 'Еда', car: 'Транспорт', tech: 'IT и софт', services: 'Аренда и сервисы', other: 'Прочее' };

/** 1 245 000 ₫ / 10 000 ₽ / $12.50 / 40 AED */
function tgMoney(num, curr) {
  const n = Number(num || 0);
  const group = (v) => Math.round(v).toLocaleString('ru-RU').replace(/\s/g, ' ');
  if (curr === 'VND') return `${group(n)} ₫`;
  if (curr === 'RUB') return `${group(n)} ₽`;
  if (curr === 'KZT') return `${group(n)} ₸`;
  if (curr === 'UAH') return `${group(n)} ₴`;
  if (curr === 'EUR') return `${(Math.round(n * 100) / 100).toLocaleString('de-DE')} €`;
  if (curr === 'USD') return `$${(Math.round(n * 100) / 100).toLocaleString('en-US')}`;
  return `${(Math.round(n * 100) / 100).toLocaleString('ru-RU')} ${curr}`;
}

/** plural(5, 'трата', 'траты', 'трат') -> 'трат' */
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** "Пятница, 30 октября" for a local YYYY-MM-DD */
function tgDayLabel(dateStr) {
  const s = new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "сегодня в 11:00", "завтра", "5 ноября в 9:30" for a stored task due (UTC datetime or local date-only) */
function tgDueLabel(due, isDateOnly, now = new Date(), offMs = NHA_TRANG_OFFSET_MS) {
  if (!due) return '';
  const localDate = (ms) => new Date(ms + offMs).toISOString().slice(0, 10);
  const today = localDate(now.getTime());
  let dayStr, time = '';
  if (isDateOnly) {
    dayStr = String(due).slice(0, 10);
  } else {
    const ms = new Date(String(due).replace(' ', 'T') + (String(due).endsWith('Z') ? '' : 'Z')).getTime();
    if (isNaN(ms)) return '';
    dayStr = localDate(ms);
    time = new Date(ms + offMs).toISOString().slice(11, 16).replace(/^0/, '');
  }
  const diff = Math.round((Date.parse(dayStr) - Date.parse(today)) / 86400000);
  const day = diff === 0 ? 'сегодня' : diff === 1 ? 'завтра' : diff === -1 ? 'вчера'
    : new Date(`${dayStr}T00:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' });
  return time ? `${day} в ${time}` : day;
}

function appOpenUrl(env, kind, id) {
  return `${appBaseUrl(env)}/app?v=${BUILD_VERSION}` + (kind && id ? `&open=${kind}:${id}` : '');
}

/**
 * "Записал" card sent after a voice/text capture:
 *   Кофе — 45 000 ₫
 *   Еда · «45000 кофе»          [Исправить] [Удалить]
 * A single saved record gets edit/delete buttons; several records get one "Открыть TRACE".
 */
function savedCard(persisted, rawTranscript, classification, env) {
  const created = persisted?.created || [];
  const lines = [];
  for (const c of created) {
    if (c.table === 'finances') {
      lines.push(`<b>${escapeHtml(c.title)} — ${escapeHtml(tgMoney(c.amount, c.currency))}</b>\n${c.debt ? (c.owe ? 'Долг, вы должны' : 'Долг, должен вам') : escapeHtml(TG_CATEGORY_LABELS[c.category] || 'Прочее')}` +
        (c.date ? ` · ${escapeHtml(pastDayLabel(c.date, new Date(), env.tzMs))}` : ''));
    } else if (c.table === 'tasks') {
      const when = tgDueLabel(c.due, c.isDateOnly, new Date(), env.tzMs);
      lines.push(`<b>${escapeHtml(c.title)}</b>\nЗадача${when ? ', ' + escapeHtml(when) : ''}`);
    } else if (c.table === 'notes') {
      lines.push(`<b>${escapeHtml(c.title)}</b>\nЗаметка`);
    } else if (c.table === 'vocabulary') {
      lines.push(`<b>${escapeHtml(c.word)}</b>${c.phonetic ? '  ' + escapeHtml(c.phonetic) : ''}\n${escapeHtml(c.translation)}`);
    } else if (c.table === 'debts') {   // a repayment (the debt itself is a finances record)
      lines.push(`<b>${escapeHtml(c.person)} — ${c.owe ? 'вы вернули' : 'вернул'} ${escapeHtml(tgMoney(c.amount, c.currency))}</b>\n` +
        (c.left > 0 ? `Осталось ${escapeHtml(tgMoney(c.left, c.currency))}` : 'Долг закрыт'));
    }
  }

  let text;
  if (persisted?.notFound) {
    text = 'Не нашёл запись, которую нужно изменить. Ничего не поменял.';
  } else if (lines.length) {
    text = lines.join('\n\n');
  } else {
    // Corrections and deletions only: the router's own summary
    text = escapeHtml(stripEmojis(classification?.screen_notification) || 'Готово');
  }
  if (rawTranscript) text += `\n<i>«${escapeHtml(rawTranscript)}»</i>`;
  if (created.some(c => c.review)) {
    text += `\n\n${persisted?.hasDuplicate ? 'Похоже на повтор' : 'Не уверен, что понял верно'} — проверь в разделе «Проверить».`;
  }

  const kindOf = { finances: 'finance', tasks: 'task', notes: 'note', vocabulary: 'word' };
  const one = created.length === 1 ? created[0] : null;
  const markup = one && one.id
    ? { inline_keyboard: [[
        { text: 'Исправить', web_app: { url: appOpenUrl(env, kindOf[one.table], one.id) } },
        { text: 'Удалить', callback_data: `del_${one.table}_${one.id}` }
      ]] }
    : { inline_keyboard: [[{ text: 'Открыть TRACE', web_app: { url: appOpenUrl(env) } }]] };
  return { text, markup };
}

/** Card for captures that came from iOS Shortcuts or the Mini App (the bot itself replies inline). */
async function sendSavedCard(persisted, rawTranscript, classification, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = await getUserChatId(env);   // owner: the secret or the chat saved on first contact; others: their Telegram id
  if (!token || !chatId) return;
  const { text, markup } = savedCard(persisted, rawTranscript, classification, env);
  await sendTelegramMessage(token, chatId, text, markup, 'HTML');
}

function stripEmojis(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegramMessage(token, chatId, text, replyMarkup = null, parseMode = 'HTML') {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: parseMode
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Telegram sendMessage error:', JSON.stringify(data));
      // Fallback: retry without parseMode if Telegram rejected entity formatting
      if (parseMode) {
        delete payload.parse_mode;
        const retryRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return await retryRes.json();
      }
    }
    return data;
  } catch (err) {
    console.error('sendTelegramMessage network error:', err);
    return { ok: false, error: err.message };
  }
}

// ==========================================
// REST API HANDLERS (for Telegram Mini App)
// ==========================================

// Exchange rates: units of currency per 1 USD. Fallback values are used until live rates are loaded
// (or if the rates service is unreachable).
const DEFAULT_PER_USD = { USD: 1, VND: 25400, RUB: 96, AED: 3.6725, KZT: 520, UAH: 41, EUR: 0.92 };
let livePerUsd = null;

// Plausibility window for a rate fetched from the network; anything outside it is ignored.
// The first three must be present and sane for a refresh to count; the others are taken when they are sane.
const RATE_SANITY = { VND: [10000, 60000], RUB: [20, 500], AED: [3, 4.5] };
const RATE_SANITY_OPTIONAL = { KZT: [300, 900], UAH: [20, 80], EUR: [0.6, 1.3] };

function perUsd(code) {
  return (livePerUsd && livePerUsd[code]) || DEFAULT_PER_USD[code] || DEFAULT_PER_USD.VND;
}

/**
 * Loads exchange rates into `livePerUsd`: cached in D1 (settings.rates_cache) for 24 hours,
 * refreshed from a free no-key API when stale. Failures retry after 10 minutes and never throw.
 */
async function refreshRates(env) {
  if (!env.DB) return;
  try {
    // Rates are shared by everyone: the cache lives with the owner
    const cached = await getSetting(env, 'rates_cache', OWNER_ID);
    let cache = null;
    try { cache = cached ? JSON.parse(cached) : null; } catch (e) {}
    const now = Date.now();
    livePerUsd = cache?.rates || null;

    const fresh = cache?.rates && now - (cache.ts || 0) < 24 * 3600 * 1000;
    if (fresh || now < (cache?.nextTry || 0)) return;

    let rates = null;
    try {
      const res = await fetch(env.RATES_API_URL || 'https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(4000) });
      const data = res.ok ? await res.json() : null;
      const r = data?.rates;
      if (r && Object.entries(RATE_SANITY).every(([c, [lo, hi]]) => Number(r[c]) >= lo && Number(r[c]) <= hi)) {
        rates = { USD: 1, VND: Number(r.VND), RUB: Number(r.RUB), AED: Number(r.AED) };
        for (const [c, [lo, hi]] of Object.entries(RATE_SANITY_OPTIONAL)) {
          if (Number(r[c]) >= lo && Number(r[c]) <= hi) rates[c] = Number(r[c]);
        }
      }
    } catch (e) {
      console.warn('Rates fetch failed:', e.message);
    }

    const next = rates
      ? { ts: now, rates }
      : { ts: cache?.ts || 0, rates: cache?.rates || null, nextTry: now + 10 * 60 * 1000 };
    await setSetting(env, 'rates_cache', JSON.stringify(next), OWNER_ID);
    livePerUsd = next.rates;
  } catch (e) {
    console.warn('refreshRates skipped:', e.message);
  }
}

function convertCurrency(amount, fromCurr, toCurr) {
  const from = (fromCurr || 'VND').toUpperCase();
  const to = (toCurr || 'VND').toUpperCase();
  if (from === to) return amount;
  return (amount / perUsd(from)) * perUsd(to);
}

// Helper to ensure database SQLite UTC timestamps are serialized as full ISO 8601 UTC strings
function toUtcIso(dateStr) {
  if (!dateStr) return dateStr;
  let s = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return s.replace(' ', 'T') + 'Z';
  }
  if (!s.endsWith('Z') && !s.includes('+') && !s.includes('-') && s.includes('T')) {
    return s + 'Z';
  }
  return s;
}

// --- FINANCES API ---
async function getFinances(request, env, url) {
  if (!env.DB) return jsonResponse({ ok: true, total: 0, transactions: [], categories: {} });
  await refreshRates(env);

  const period = url.searchParams.get('period') || 'day';
  const specificDate = url.searchParams.get('date') || '';  // YYYY-MM-DD
  const targetCurrency = (url.searchParams.get('currency') || env.DEFAULT_CURRENCY || 'VND').toUpperCase();

  // Filter aligned to user local timezone (Nha Trang, Vietnam / UTC+7)
  const tz = env.tzSql;
  let dateFilter = `datetime(created_at, '${tz}') >= datetime(date('now', '${tz}'))`;
  let dateParams = [];

  if (specificDate && /^\d{4}-\d{2}-\d{2}$/.test(specificDate)) {
    // Specific date mode: show finances for one calendar day
    dateFilter = `date(created_at, '${tz}') = ?`;
    dateParams = [specificDate];
  } else if (period === 'week') {
    dateFilter = `datetime(created_at, '${tz}') >= datetime(date('now', '${tz}', '-7 days'))`;
  } else if (period === 'month') {
    dateFilter = `datetime(created_at, '${tz}') >= datetime(date('now', '${tz}', '-30 days'))`;
  }

  // Get ALL transactions in the period (regardless of recorded currency)
  const sql = `SELECT * FROM finances WHERE user_id = ? AND ${dateFilter} AND (needs_review IS NULL OR needs_review = 0) AND (possible_duplicate IS NULL OR possible_duplicate = 0) ORDER BY created_at DESC LIMIT 2000`;
  const txQuery = await env.DB.prepare(sql).bind(env.uid, ...dateParams).all();

  const allRows = txQuery.results || [];
  let totalConverted = 0;
  let outsideConverted = 0;
  const categories = { car: 0, food: 0, tech: 0, services: 0, other: 0 };

  const transactions = allRows.map(row => {
    const origAmount = Number(row.amount || 0);
    const origCurrency = (row.currency || 'VND').toUpperCase();
    const converted = convertCurrency(origAmount, origCurrency, targetCurrency);
    const outside = !!row.outside_limit || !!row.is_debt; // planned purchase or a debt: listed, but not in totals or the limit
    if (outside) outsideConverted += converted;
    else totalConverted += converted;

    // 'unsure' (a confirmed review item) and any stray value count as "Прочее", so the breakdown adds up to the total
    const cat = Object.prototype.hasOwnProperty.call(categories, row.category) ? row.category : 'other';
    if (!outside) categories[cat] += converted;

    return {
      ...row,
      outside_limit: outside ? 1 : 0,
      title: row.title || cleanFinanceTitle(row.raw_text, origAmount) || 'Расход',
      raw_transcript: row.raw_transcript || null,
      created_at: toUtcIso(row.created_at),
      original_amount: origAmount,
      original_currency: origCurrency,
      amount: converted, // Converted into selected target currency
      currency: targetCurrency
    };
  });

  // Limit from settings; 0 everywhere when the user switched it off
  const { enabled: limitOn, amountVnd: dailyLimitVnd } = await getDailyLimit(env);

  let multiplier = 1;
  if (period === 'week') multiplier = 7;
  else if (period === 'month') multiplier = 30;

  const periodLimit = limitOn ? convertCurrency(dailyLimitVnd * multiplier, 'VND', targetCurrency) : 0;
  const dailyLimitConverted = limitOn ? convertCurrency(dailyLimitVnd, 'VND', targetCurrency) : 0;

  return jsonResponse({
    ok: true,
    total: totalConverted,
    outside_total: outsideConverted,
    currency: targetCurrency,
    period,
    limit: periodLimit,
    daily_limit: dailyLimitConverted,
    daily_limit_vnd: dailyLimitVnd,
    // The saved amount even while switched off, so the settings sheet can offer it again
    limit_enabled: limitOn,
    limit_amount: convertCurrency(dailyLimitVnd, 'VND', targetCurrency),
    categories,
    transactions,
    rates: {
      USD_VND: perUsd('VND'),
      USD_RUB: perUsd('RUB'),
      USD_AED: perUsd('AED')
    }
  });
}

const DEFAULT_DAILY_LIMIT_VND = 200000;
// What a new person's daily limit starts at, in their own currency (kept in VND inside, like the owner's)
const DEFAULT_DAILY_LIMIT = { VND: 200000, RUB: 2000, USD: 30, KZT: 10000, UAH: 800, EUR: 25, AED: 100 };

/** Daily spending limit: the saved amount (VND) and whether the user wants it tracked at all. */
async function getDailyLimit(env) {
  const own = DEFAULT_DAILY_LIMIT[String(env.DEFAULT_CURRENCY || 'VND').toUpperCase()];
  let amountVnd = own ? Math.round(convertCurrency(own, String(env.DEFAULT_CURRENCY || 'VND').toUpperCase(), 'VND')) : DEFAULT_DAILY_LIMIT_VND;
  let enabled = true;
  try {
    const res = await env.DB.prepare("SELECT key, value FROM settings WHERE user_id = ? AND key IN ('daily_limit_vnd', 'daily_limit_off')").bind(env.uid).all();
    for (const r of res?.results || []) {
      if (r.key === 'daily_limit_vnd' && parseFloat(r.value) > 0) amountVnd = parseFloat(r.value);
      if (r.key === 'daily_limit_off') enabled = r.value !== '1';
    }
  } catch (e) {
    console.error('Error reading daily limit:', e);
  }
  return { enabled, amountVnd };
}

// How often a word is pushed to Telegram: local Nha Trang hours of the fixed slots, or every 3 hours
const VOCAB_REMINDER_MODES = { off: null, daily: [10], twice: [10, 18], often: 'interval' };
const DEFAULT_VOCAB_REMINDERS = 'daily';

async function getVocabReminderMode(env) {
  try {
    const value = await getSetting(env, 'vocab_reminders');
    if (value !== null && Object.prototype.hasOwnProperty.call(VOCAB_REMINDER_MODES, value)) return value;
  } catch (e) {}
  return DEFAULT_VOCAB_REMINDERS;
}

/** GET /api/settings?currency=: what the settings sheet shows, the limit in the currency the user sees. */
async function getSettings(env, url) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  await refreshRates(env);
  const currency = (url.searchParams.get('currency') || env.DEFAULT_CURRENCY || 'VND').toUpperCase();
  const limit = await getDailyLimit(env);
  return jsonResponse({
    ok: true,
    currency,
    limit_enabled: limit.enabled,
    limit_amount: convertCurrency(limit.amountVnd, 'VND', currency),
    vocab_reminders: await getVocabReminderMode(env),
    morning_summary: await getMorningEnabled(env),
    default_currency: env.DEFAULT_CURRENCY,     // the person's own currency (first run asks for it)
    timezone: env.USER_TIMEZONE,
    tz_offset_min: env.tzMin,                   // the app counts days with this, not a fixed +7
    supported_currencies: SUPPORTED_CURRENCIES,
    timezones: TIMEZONE_CHOICES.map(([id, label]) => ({ id, label, offset_min: tzOffsetMinutes(id) })),
    setup_done: env.uid === OWNER_ID || (await getSetting(env, 'setup_done')) === '1'   // false = show the first-run questions
  });
}

/**
 * PUT /api/settings { limit_enabled, limit_amount, currency, vocab_reminders, morning_summary, default_currency, timezone }:
 * every field optional. `currency` is the one the limit amount is given in; `default_currency` is the person's own.
 */
async function saveSettings(request, env, url) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  await refreshRates(env);
  const body = await readJson(request);
  const upsert = (key, value) => setSetting(env, key, value);

  if (body.limit_enabled !== undefined) {
    const enabled = body.limit_enabled !== false;
    if (enabled) {
      const amount = parseFloat(String(body.limit_amount ?? '').replace(/\s/g, '').replace(',', '.'));
      const amountVnd = Math.round(convertCurrency(amount, String(body.currency || 'VND').toUpperCase(), 'VND'));
      if (!(amount > 0) || !(amountVnd > 0)) return errorResponse('Valid positive amount required', 400);
      await upsert('daily_limit_vnd', amountVnd);
    }
    await upsert('daily_limit_off', enabled ? '0' : '1');
  }
  if (body.vocab_reminders !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(VOCAB_REMINDER_MODES, body.vocab_reminders)) {
      return errorResponse('Unknown vocab_reminders value', 400);
    }
    await upsert('vocab_reminders', body.vocab_reminders);
  }
  if (body.morning_summary !== undefined) {
    await upsert('morning_off', body.morning_summary === false ? '1' : '0');
  }
  // The person's own currency and time zone live in their users row (always their own id)
  if (body.default_currency !== undefined) {
    const code = String(body.default_currency).toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(code)) return errorResponse('Unknown currency', 400);
    await env.rawDB.prepare('UPDATE users SET currency = ? WHERE id = ?').bind(code, env.uid).run();
    env.DEFAULT_CURRENCY = code;
  }
  if (body.timezone !== undefined) {
    if (!isValidTimezone(body.timezone) || (env.uid !== OWNER_ID && !TIMEZONE_IDS.includes(String(body.timezone)))) return errorResponse('Unknown time zone', 400);
    // The day limit is counted by the person's own midnight, so moving the zone after the first run would reset it
    // at will. A client picks the zone once (first run, before any record); later only the owner can change it.
    if (env.uid !== OWNER_ID && String(body.timezone) !== env.USER_TIMEZONE) {
      const started = (await getSetting(env, 'setup_done')) === '1' ||
        !!(await env.rawDB.prepare('SELECT daily_date FROM users WHERE id = ?').bind(env.uid).first())?.daily_date;
      if (started) return jsonResponse({ ok: false, code: 'tz_locked', error: 'Часовой пояс после первого запуска не меняется. Напишите в поддержку.' }, 403);
    }
    await env.rawDB.prepare('UPDATE users SET timezone = ? WHERE id = ?').bind(String(body.timezone), env.uid).run();
    env.USER_TIMEZONE = String(body.timezone);
    Object.assign(env, tzFields(tzOffsetMinutes(env.USER_TIMEZONE)));
  }
  if (body.setup_done === true) await upsert('setup_done', '1');
  return getSettings(env, url);
}

async function addFinance(request, env) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const amount = parseFloat(body.amount);
  const currency = body.currency || env.DEFAULT_CURRENCY || 'VND';
  const category = body.category || 'other';
  const title = body.title || '';
  const rawText = body.raw_text || '';

  if (!amount || isNaN(amount) || amount <= 0) return errorResponse('Valid positive amount required', 400);

  // date: optional past local day (YYYY-MM-DD) to file the expense under
  const res = await env.DB.prepare(
    'INSERT INTO finances (amount, currency, category, title, raw_text, outside_limit, is_debt, debt_owe, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)'
  ).bind(amount, currency, category, title, rawText, body.outside_limit ? 1 : 0, body.is_debt ? 1 : 0, body.is_debt && body.debt_owe ? 1 : 0, expenseCreatedAt(body.date, new Date(), env.tzMs), env.uid).run();

  return jsonResponse({ ok: true, id: res.meta?.last_row_id });
}

async function deleteFinance(env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  await env.DB.prepare('DELETE FROM finances WHERE id = ? AND user_id = ?').bind(id, env.uid).run();
  return jsonResponse({ ok: true });
}

async function updateFinance(request, env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const rawAmount = body.amount;
  const parsedAmount = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount || '').replace(/[^0-9.]/g, ''));
  const amount = Number.isFinite(parsedAmount) ? parsedAmount : null;
  const currency = body.currency ? stripEmojis(body.currency) : null;
  const category = body.category ? stripEmojis(body.category) : null;
  const title = body.title !== undefined ? stripEmojis(body.title || '') : null;
  const rawText = body.raw_text ? stripEmojis(body.raw_text) : null;
  // outside_limit: not sent = leave as is; true/false = set the "not in the daily limit" mark
  const outsideLimit = body.outside_limit === undefined || body.outside_limit === null ? null : (body.outside_limit ? 1 : 0);
  // is_debt: same rule; a debt is listed with the expenses but is not counted in the day's total
  const isDebt = body.is_debt === undefined || body.is_debt === null ? null : (body.is_debt ? 1 : 0);
  // debt_owe: 1 = I owe them, 0 = they owe me; the debt mark switched off resets it
  const debtOwe = isDebt === 0 ? 0 : (body.debt_owe === undefined || body.debt_owe === null ? null : (body.debt_owe ? 1 : 0));

  if (amount === null || amount <= 0) return errorResponse('Valid positive amount required', 400);

  // date: local YYYY-MM-DD the expense moves to; the local time of day stays as recorded
  let date = null;
  if (body.date !== undefined && body.date !== null && body.date !== '') {
    date = String(body.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(`${date}T00:00:00Z`))) return errorResponse('Date must be YYYY-MM-DD', 400);
    if (date > localDateOf(Date.now(), env.tzMs)) return errorResponse('Расход не может быть в будущем', 400);
  }

  // A record the user edited by hand is checked: it leaves the review queue
  await env.DB.prepare(
    `UPDATE finances SET
      needs_review = 0, possible_duplicate = 0,
      amount = ?,
      currency = COALESCE(?, currency),
      category = COALESCE(?, category),
      title = COALESCE(?, title),
      raw_text = COALESCE(?, raw_text),
      outside_limit = COALESCE(?, outside_limit),
      is_debt = COALESCE(?, is_debt),
      debt_owe = COALESCE(?, debt_owe),
      created_at = CASE WHEN ? IS NULL THEN created_at
                        ELSE datetime(? || ' ' || time(created_at, '${env.tzSql}'), '${env.tzSqlNeg}') END
     WHERE id = ? AND user_id = ?`
  ).bind(amount, currency, category, title, rawText, outsideLimit, isDebt, debtOwe, date, date, id, env.uid).run();

  return jsonResponse({ ok: true, id });
}

// --- TASKS API ---
async function getTasks(request, env, url) {
  if (!env.DB) return jsonResponse({ ok: true, tasks: [] });

  const filter = url.searchParams.get('filter') || 'active';
  let query = 'SELECT * FROM tasks WHERE user_id = ? ORDER BY is_completed ASC, created_at DESC';

  if (filter === 'active') {
    query = 'SELECT * FROM tasks WHERE user_id = ? AND is_completed = 0 AND (needs_review IS NULL OR needs_review = 0) AND (possible_duplicate IS NULL OR possible_duplicate = 0) ORDER BY CASE priority WHEN \'high\' THEN 0 WHEN \'medium\' THEN 1 ELSE 2 END, created_at DESC';
  } else if (filter === 'completed') {
    query = 'SELECT * FROM tasks WHERE user_id = ? AND is_completed = 1 AND (needs_review IS NULL OR needs_review = 0) AND (possible_duplicate IS NULL OR possible_duplicate = 0) ORDER BY created_at DESC';
  }

  const results = await env.DB.prepare(query).bind(env.uid).all();
  const tasks = (results.results || []).map(t => ({
    ...t,
    created_at: toUtcIso(t.created_at),
    due_datetime: toUtcIso(t.due_datetime)
  }));
  return jsonResponse({ ok: true, tasks });
}

async function addTask(request, env) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const title = (body.title || '').trim();
  const due = body.due_datetime || null;
  const priority = body.priority || 'medium';
  const isDateOnly = due && body.is_date_only ? 1 : 0;

  if (!title) return errorResponse('Title required', 400);

  const res = await env.DB.prepare(
    'INSERT INTO tasks (title, due_datetime, is_date_only, priority, user_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(title, due, isDateOnly, priority, env.uid).run();

  return jsonResponse({ ok: true, id: res.meta?.last_row_id });
}

async function toggleTask(env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  await env.DB.prepare(
    'UPDATE tasks SET is_completed = CASE WHEN is_completed = 1 THEN 0 ELSE 1 END WHERE id = ? AND user_id = ?'
  ).bind(id, env.uid).run();
  return jsonResponse({ ok: true });
}

async function deleteTask(env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  await env.DB.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').bind(id, env.uid).run();
  return jsonResponse({ ok: true });
}

async function updateTask(request, env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const title = (body.title || '').trim();
  const priority = body.priority || 'medium';
  let due = body.due_datetime || null;

  if (!title) return errorResponse('Title required', 400);
  if (due && typeof due === 'string' && due.trim() === '') due = null;
  const isDateOnly = due && body.is_date_only ? 1 : 0;

  // A changed due date re-arms the reminder
  await env.DB.prepare(
    `UPDATE tasks SET title = ?, priority = ?, is_date_only = ?, needs_review = 0, possible_duplicate = 0,
       reminded = CASE WHEN due_datetime IS ? THEN reminded ELSE 0 END,
       due_datetime = ? WHERE id = ? AND user_id = ?`
  ).bind(title, priority, isDateOnly, due, due, id, env.uid).run();

  return jsonResponse({ ok: true });
}

// --- RECURRING API ---
async function getRecurring(env) {
  if (!env.DB) return jsonResponse({ ok: true, items: [] });
  const res = await env.DB.prepare('SELECT * FROM recurring WHERE user_id = ? ORDER BY day_of_month ASC, id ASC').bind(env.uid).all();
  return jsonResponse({ ok: true, items: res.results || [] });
}

/** Checks the body of POST/PATCH /api/recurring; returns { error } or the clean fields. */
function readRecurringBody(body, env) {
  const title = stripEmojis(String(body.title || '')).trim();
  const day = Math.round(Number(body.day_of_month));
  const addExpense = body.add_expense === false ? 0 : 1;
  const addTask = body.add_task ? 1 : 0;
  const amount = parseFloat(String(body.amount ?? '').replace(/\s/g, '').replace(',', '.'));
  const currency = String(body.currency || env.DEFAULT_CURRENCY || 'VND').toUpperCase();
  const category = Object.prototype.hasOwnProperty.call(TG_CATEGORY_LABELS, body.category) ? body.category : 'other';

  if (!title) return { error: 'Title required' };
  if (!(day >= 1 && day <= 31)) return { error: 'Day of month must be 1-31' };
  if (!addExpense && !addTask) return { error: 'Choose an expense, a task or both' };
  if (!SUPPORTED_CURRENCIES.includes(currency)) return { error: 'Unknown currency' };
  if (addExpense && !(amount > 0)) return { error: 'Valid positive amount required' };
  return { title, day, addExpense, addTask, amount: addExpense ? amount : null, currency, category };
}

async function addRecurring(request, env) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const f = readRecurringBody(await readJson(request), env);
  if (f.error) return errorResponse(f.error, 400);
  const res = await env.DB.prepare(
    'INSERT INTO recurring (title, amount, currency, category, day_of_month, add_expense, add_task, last_run_month, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(f.title, f.amount, f.currency, f.category, f.day, f.addExpense, f.addTask, recurringStartMonth(f.day, new Date(), env.tzMs), env.uid).run();
  return jsonResponse({ ok: true, id: res.meta?.last_row_id });
}

async function updateRecurring(request, env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const f = readRecurringBody(await readJson(request), env);
  if (f.error) return errorResponse(f.error, 400);
  // A moved day starts over: it fires this month only if the new day has not passed yet
  await env.DB.prepare(
    `UPDATE recurring SET title = ?, amount = ?, currency = ?, category = ?, add_expense = ?, add_task = ?,
       last_run_month = CASE WHEN day_of_month = ? THEN last_run_month ELSE ? END,
       day_of_month = ?
     WHERE id = ? AND user_id = ?`
  ).bind(f.title, f.amount, f.currency, f.category, f.addExpense, f.addTask, f.day, recurringStartMonth(f.day, new Date(), env.tzMs), f.day, id, env.uid).run();
  return jsonResponse({ ok: true });
}

async function deleteRecurring(env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  await env.DB.prepare('DELETE FROM recurring WHERE id = ? AND user_id = ?').bind(id, env.uid).run();
  return jsonResponse({ ok: true });
}

// --- DEBTS API ---
// A debt is an expense with the "это долг" mark (finances.is_debt): the title is who owes, the amount is what was lent.
// It stays in the day's list but, like a planned purchase, is not counted in the day's total or the limit.

/** GET /api/debts?currency=: marked expenses, with what is still owed and the open total in one currency. */
async function getDebts(env, url) {
  if (!env.DB) return jsonResponse({ ok: true, items: [], total: 0, currency: 'VND' });
  await refreshRates(env);
  const currency = (url.searchParams.get('currency') || env.DEFAULT_CURRENCY || 'VND').toUpperCase();
  const owe = url.searchParams.get('dir') === 'owe';   // dir=owe: what I owe; otherwise what is owed to me
  const res = await env.DB.prepare(
    'SELECT * FROM finances WHERE user_id = ? AND is_debt = 1 AND COALESCE(debt_owe, 0) = ? AND (needs_review IS NULL OR needs_review = 0) ORDER BY created_at DESC LIMIT 500'
  ).bind(env.uid, owe ? 1 : 0).all();
  let total = 0;
  const items = (res.results || []).map(row => {
    const cur = (row.currency || 'VND').toUpperCase();
    const left = Math.max(0, Math.round((Number(row.amount) - Number(row.debt_paid || 0)) * 100) / 100);
    total += convertCurrency(left, cur, currency);
    return {
      ...row,
      title: row.title || cleanFinanceTitle(row.raw_text, Number(row.amount)) || 'Долг',
      created_at: toUtcIso(row.created_at),
      outside_limit: 1,
      original_amount: Number(row.amount),
      original_currency: cur,
      debt_left: left
    };
  });
  return jsonResponse({ ok: true, items, total, currency });
}

/** POST /api/debts/:id/pay  { amount } = a partial return, { all: true } = the whole rest. */
async function payDebt(request, env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const debt = await env.DB.prepare('SELECT * FROM finances WHERE id = ? AND user_id = ? AND is_debt = 1').bind(id, env.uid).first();
  if (!debt) return errorResponse('Not found', 404);
  const left = Number(debt.amount) - Number(debt.debt_paid || 0);
  const part = body.all ? left : parseFloat(String(body.amount ?? '').replace(/\s/g, '').replace(',', '.'));
  if (!(part > 0)) return errorResponse('Valid positive amount required', 400);
  const paid = Math.min(Number(debt.amount), Number(debt.debt_paid || 0) + part);
  await env.DB.prepare('UPDATE finances SET debt_paid = ? WHERE id = ? AND user_id = ?').bind(paid, id, env.uid).run();
  return jsonResponse({ ok: true, left: Math.max(0, Math.round((Number(debt.amount) - paid) * 100) / 100) });
}

/**
 * Voice "Арбуз вернул 30 тысяч": the money goes to that person's open debts, oldest first.
 * Returns { found, applied, left } (left = what the person still owes in that currency).
 */
async function repayDebts(env, person, amount, currency, owe = false) {
  const want = String(person || '').toLowerCase().trim();
  const res = await env.DB.prepare('SELECT * FROM finances WHERE user_id = ? AND is_debt = 1 AND currency = ? AND COALESCE(debt_owe, 0) = ? ORDER BY id ASC').bind(env.uid, currency, owe ? 1 : 0).all();
  const mine = (res.results || []).filter(d => {
    if (Number(d.amount) - Number(d.debt_paid || 0) <= 0.005) return false;
    const name = String(d.title || '').toLowerCase();
    return want.length >= 2 && name.length >= 2 && (name === want || name.slice(0, 4) === want.slice(0, 4) || wordSimilarity(name, want) >= 0.7);
  });
  if (!mine.length) return { found: false, applied: 0, left: 0 };
  let rest = amount;
  let applied = 0;
  for (const d of mine) {
    if (rest <= 0) break;
    const take = Math.min(rest, Number(d.amount) - Number(d.debt_paid || 0));
    await env.DB.prepare('UPDATE finances SET debt_paid = ? WHERE id = ? AND user_id = ?').bind(Number(d.debt_paid || 0) + take, d.id, env.uid).run();
    rest -= take;
    applied += take;
  }
  const left = mine.reduce((s, d) => s + Number(d.amount) - Number(d.debt_paid || 0), 0) - applied;
  return { found: true, applied, left: Math.max(0, Math.round(left * 100) / 100) };
}

/**
 * Deterministic reading of a debt dictation, so it never lands in the expenses as a plain spend:
 *   "Арбуз должен мне 100 тысяч", "100 000 арбуз долг", "дал в долг Арбузу 50к"  -> they owe me
 *   "Арбуз вернул 30 тысяч"                                                    -> a repayment
 * Returns a classification, or null when the phrase is not about a debt.
 */
function parseDebtPhrase(text, defaultCurrency = 'VND') {
  const t = String(text || '').toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 160) return null;
  if (/напомн|надо|нужно|потратил|купил|оплатил|заплатил|перевед|исправ|удали|поменя/u.test(t)) return null;   // a compound phrase goes to the LLM
  const amountRx = /(\d+(?:\s\d{3})*(?:[.,]\d+)?)\s*(к|k|тыс(?:яч[аи]?)?|млн|лям[а-я]*|миллион[а-я]*)?(?![а-яa-z0-9])/iu;
  const am = t.match(amountRx);
  if (!am) return null;
  const amount = parseDigitAmount(am[1], am[2]);
  if (!(amount > 0)) return null;

  let currency = defaultCurrency;
  if (/(?:^|\s)руб/.test(t)) currency = 'RUB';
  else if (/(?:^|\s)(?:usd|доллар|бакс|\$)/.test(t)) currency = 'USD';
  else if (/(?:^|\s)(?:aed|дирхам)/.test(t)) currency = 'AED';
  else if (/(?:^|\s)(?:тенге|kzt)/.test(t)) currency = 'KZT';
  else if (/(?:^|\s)(?:гривн|грн|uah)/.test(t)) currency = 'UAH';
  else if (/(?:^|\s)(?:евро|eur)/.test(t)) currency = 'EUR';

  const rest = t.replace(am[0], ' ').replace(/(?:^|\s)(?:донг[а-я]*|vnd|руб[а-я]*|usd|доллар[а-я]*|бакс[а-я]*|aed|дирхам[а-я]*|тенге|kzt|гривн[а-я]*|грн|uah|евро|eur)(?=\s|$)/giu, ' ');
  const stop = new Set(['мне', 'я', 'должен', 'должна', 'должны', 'долг', 'долга', 'долгу', 'в', 'у', 'дал', 'дала', 'одолжил', 'одолжила', 'занял', 'заняла', 'взял', 'взяла',
    'вернул', 'вернула', 'отдал', 'отдала', 'тебе', 'ему', 'ей', 'нам', 'ещё', 'еще', 'записать', 'запиши', 'за', 'на', 'и', 'теперь', 'тоже', 'короче', 'слушай']);
  const nameWords = rest.split(/[^a-zа-яё0-9-]+/iu).filter(w => w.length >= 2 && !stop.has(w) && !/^\d+$/.test(w));
  if (nameWords.length < 1 || nameWords.length > 2) return null;
  const person = nameWords.join(' ').replace(/(^|\s)\S/g, c => c.toUpperCase());

  // The user owes: "я должен Арбузу 100к", "занял у Арбуза 100к", "взял в долг у Арбуза", "я вернул Арбузу 30к"
  const theyOweMe = /(?:^|\s)мне(?=\s|$)/u.test(t) && /(?:^|\s)должн/u.test(t);
  const owe = !theyOweMe && (
    /(?:^|\s)я\s+(?:должен|должна|занял[а-я]*|взял[а-я]*|вернул[а-я]*|отдал[а-я]*)(?=\s|$)/u.test(t) ||
    /^(?:должен|должна)\s/u.test(t) ||
    /(?:^|\s)(?:занял[а-я]*|взял[а-я]*)\s+(?:в\s+долг\s+)?у(?=\s)/u.test(t) ||
    /(?:^|\s)взял[а-я]*\s+в\s+долг(?=\s|$)/u.test(t));
  const mk = (repay) => ({
    raw_text: text, type: 'debt', haptic: 'success',
    actions: [{ type: 'debt', data: { person, amount, currency, repay, owe }, evidence: t }]
  });
  // "отдал" alone is an ordinary expense ("отдал 50к за обед"): it counts only together with the word "долг" (or "я отдал")
  if (/(?:^|\s)(?:вернул[аи]?|верн[уё]т)(?=\s|$)/u.test(t) || (/(?:^|\s)отдал[аи]?(?=\s|$)/u.test(t) && (/долг/u.test(t) || owe))) {
    return mk(true);
  }
  if (owe && /(?:^|\s)(?:должен|должна|занял[а-я]*|взял[а-я]*)(?=\s|$)/u.test(t)) return mk(false);
  if (/(?:^|\s)(?:должен|должна|должны|долг|дал[а-я]*\s+в\s+долг|одолжил[а-я]*|занял[а-я]*)(?=\s|$)/u.test(t)) return mk(false);
  return null;
}

// --- NOTES API ---
async function getNotes(request, env, url) {
  if (!env.DB) return jsonResponse({ ok: true, notes: [] });

  const q = (url.searchParams.get('q') || '').trim();
  const category = (url.searchParams.get('category') || '').trim();

  let sql = "SELECT * FROM notes WHERE user_id = ? AND category != 'debug' AND (needs_review IS NULL OR needs_review = 0) AND (possible_duplicate IS NULL OR possible_duplicate = 0)";
  const params = [env.uid];

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  // SQLite LIKE ignores case only for Latin letters, so the search runs here ("Привычки" finds "про привычки")
  sql += q ? ' ORDER BY created_at DESC' : ' ORDER BY created_at DESC LIMIT 200';

  const results = await env.DB.prepare(sql).bind(...params).all();
  const needle = q.toLowerCase();
  const found = needle
    ? (results.results || []).filter(n => [n.title, n.content, n.tags].some(f => String(f || '').toLowerCase().includes(needle))).slice(0, 200)
    : (results.results || []);
  const notes = found.map(n => ({
    ...n,
    created_at: toUtcIso(n.created_at)
  }));

  return jsonResponse({ ok: true, notes });
}

async function addNote(request, env) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const category = body.category || 'general';
  const title = body.title || 'Новая заметка';
  const content = (body.content || '').trim();
  const tags = body.tags || '';

  if (!content) return errorResponse('Content required', 400);

  const res = await env.DB.prepare(
    'INSERT INTO notes (category, title, content, tags, user_id) VALUES (?, ?, ?, ?, ?)'
  ).bind(category, title, content, tags, env.uid).run();

  return jsonResponse({ ok: true, id: res.meta?.last_row_id });
}

async function deleteNote(env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  await env.DB.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').bind(id, env.uid).run();
  return jsonResponse({ ok: true });
}

async function updateNote(request, env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  try {
    const body = await readJson(request);
    const title = stripEmojis(body.title || 'Заметка');
    const content = stripEmojis(body.content || '');
    const category = stripEmojis(body.category || 'general');
    const tags = stripEmojis(body.tags || '');

    if (!content) {
      return errorResponse('Содержание заметки не может быть пустым', 400);
    }

    await env.DB.prepare(
      'UPDATE notes SET title = ?, content = ?, category = ?, tags = ?, needs_review = 0, possible_duplicate = 0 WHERE id = ? AND user_id = ?'
    ).bind(title, content, category, tags, id, env.uid).run();

    return jsonResponse({ ok: true, message: 'Заметка обновлена' });
  } catch (err) {
    if (err instanceof LimitError) throw err;
    return errorResponse(publicError(env, err, 'Ошибка обновления заметки'), 500);
  }
}

// --- VOCABULARY API ---
async function getVocabulary(request, env) {
  if (!env.DB) return jsonResponse({ ok: true, words: [] });
  const results = await env.DB.prepare(
    'SELECT * FROM vocabulary WHERE user_id = ? ORDER BY lookup_count DESC, created_at DESC LIMIT 1000'
  ).bind(env.uid).all();
  const words = (results.results || []).map(w => ({
    ...w,
    created_at: toUtcIso(w.created_at)
  }));
  return jsonResponse({ ok: true, words });
}

// --- TOP-1000 WORDS API ---
// group_no 1..50 = a group of 20 words, group_no 0 = the general test over all words.

/** GET /api/top-words: the whole list plus progress per group ({ studied, best, last, attempts }). */
async function getTopWords(env) {
  const groups = {};
  if (env.DB) {
    const res = await env.DB.prepare('SELECT group_no, studied, best, last_score, attempts, perfect FROM word_groups WHERE user_id = ?').bind(env.uid).all();
    for (const r of res.results || []) {
      groups[r.group_no] = { studied: !!r.studied, best: r.best, last: r.last_score, attempts: r.attempts || 0, perfect: r.perfect || 0 };
    }
  }
  return jsonResponse({ ok: true, words: TOP_WORDS, groups, group_size: 20, group_count: TOP_GROUPS });
}

/** POST /api/top-words/progress { group, studied?: true, score?: 0..100 }: a group was read through or a test finished. */
async function saveTopWordsProgress(request, env) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const group = Number(body.group);
  if (!Number.isInteger(group) || group < 0 || group > TOP_GROUPS) return errorResponse('Unknown group', 400);
  const hasScore = body.score !== undefined && body.score !== null;
  const score = hasScore ? Math.round(Number(body.score)) : null;
  if (hasScore && !(score >= 0 && score <= 100)) return errorResponse('Score must be 0..100', 400);
  // No ON CONFLICT: works the same before and after the per-user keys migration
  const haveGroup = await env.DB.prepare('SELECT group_no FROM word_groups WHERE group_no = ? AND user_id = ?').bind(group, env.uid).first();
  if (!haveGroup) await env.DB.prepare('INSERT INTO word_groups (group_no, user_id) VALUES (?, ?)').bind(group, env.uid).run();
  await env.DB.prepare(
    `UPDATE word_groups SET
       studied = CASE WHEN ? THEN 1 ELSE studied END,
       best = CASE WHEN ? IS NULL THEN best ELSE MAX(COALESCE(best, 0), ?) END,
       last_score = COALESCE(?, last_score),
       attempts = attempts + CASE WHEN ? IS NULL THEN 0 ELSE 1 END,
       perfect = perfect + CASE WHEN ? = 100 THEN 1 ELSE 0 END,
       updated_at = CURRENT_TIMESTAMP
     WHERE group_no = ? AND user_id = ?`
  ).bind(body.studied ? 1 : 0, score, score, score, score, score, group, env.uid).run();
  return jsonResponse({ ok: true });
}

async function addVocabulary(request, env) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const word = (body.word || '').trim();
  const translation = (body.translation || '').trim();
  const phonetic = (body.phonetic || '').trim();
  const example = body.example || '';

  if (!word || !translation) return errorResponse('Word and translation required', 400);

  const id = await upsertWord(env, word, translation, phonetic, example);
  return jsonResponse({ ok: true, id });
}

/** One row per word whatever its case: "Discount" bumps the existing "discount" instead of adding a twin. */
async function upsertWord(env, word, translation, phonetic, example) {
  const existing = await env.DB.prepare('SELECT id FROM vocabulary WHERE user_id = ? AND lower(word) = lower(?) ORDER BY id LIMIT 1').bind(env.uid, word).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE vocabulary SET lookup_count = lookup_count + 1, translation = ?,
         phonetic = COALESCE(NULLIF(?, ''), phonetic), example = COALESCE(NULLIF(?, ''), example)
       WHERE id = ? AND user_id = ?`
    ).bind(translation, phonetic, example, existing.id, env.uid).run();
    return existing.id;
  }
  const res = await env.DB.prepare(
    'INSERT INTO vocabulary (word, translation, phonetic, example, lookup_count, user_id) VALUES (?, ?, ?, ?, 1, ?)'
  ).bind(word, translation, phonetic, example, env.uid).run();
  return res.meta?.last_row_id;
}

async function updateVocabulary(request, env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const word = (body.word || '').trim();
  const translation = (body.translation || '').trim();
  if (!word || !translation) return errorResponse('Word and translation required', 400);

  const twin = await env.DB.prepare('SELECT id FROM vocabulary WHERE user_id = ? AND lower(word) = lower(?) AND id != ?').bind(env.uid, word, id).first();
  if (twin) return errorResponse('Такое слово уже есть в словаре', 409);

  const res = await env.DB.prepare(
    'UPDATE vocabulary SET word = ?, translation = ?, phonetic = ?, example = ? WHERE id = ? AND user_id = ?'
  ).bind(word, translation, (body.phonetic || '').trim(), body.example || '', id, env.uid).run();
  if (!res?.meta?.changes) return errorResponse('Word not found', 404);
  return jsonResponse({ ok: true, id });
}

async function deleteVocabulary(env, id) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  await env.DB.prepare('DELETE FROM vocabulary WHERE id = ? AND user_id = ?').bind(id, env.uid).run();
  return jsonResponse({ ok: true });
}


// ==========================================
// REST API: REVIEW QUEUE & DUPLICATE MERGE
// ==========================================

async function getReviewItems(env) {
  if (!env.DB) return jsonResponse({ ok: true, count: 0, items: [] });

  const finances = await env.DB.prepare(`
    SELECT 'finances' as entity_type, id, amount, currency, category, title, raw_text, raw_transcript, needs_review, confidence, possible_duplicate, duplicate_of, created_at
    FROM finances
    WHERE user_id = ? AND (needs_review = 1 OR possible_duplicate = 1)
    ORDER BY created_at DESC
  `).bind(env.uid).all();

  const tasks = await env.DB.prepare(`
    SELECT 'tasks' as entity_type, id, title, due_datetime, is_date_only, priority, raw_transcript, needs_review, confidence, possible_duplicate, duplicate_of, created_at
    FROM tasks
    WHERE user_id = ? AND (needs_review = 1 OR possible_duplicate = 1)
    ORDER BY created_at DESC
  `).bind(env.uid).all();

  const notes = await env.DB.prepare(`
    SELECT 'notes' as entity_type, id, category, title, content, tags, raw_transcript, needs_review, confidence, possible_duplicate, duplicate_of, created_at
    FROM notes
    WHERE user_id = ? AND (needs_review = 1 OR possible_duplicate = 1)
    ORDER BY created_at DESC
  `).bind(env.uid).all();

  const items = [
    ...(finances.results || []),
    ...(tasks.results || []),
    ...(notes.results || [])
  ];

  for (const item of items) {
    if (item.possible_duplicate && item.duplicate_of) {
      try {
        const orig = await env.DB.prepare(`SELECT * FROM ${item.entity_type} WHERE id = ? AND user_id = ?`).bind(item.duplicate_of, env.uid).first();
        if (orig) item.original_record = orig;
      } catch (e) {}
    }
  }

  items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return jsonResponse({
    ok: true,
    count: items.length,
    items
  });
}

async function confirmReviewItem(request, env) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const table = body.table;
  const id = parseInt(body.id, 10);
  if (!['finances', 'tasks', 'notes'].includes(table) || !id) {
    return errorResponse('Valid table and id required', 400);
  }

  const updates = body.updates || {};

  if (table === 'finances') {
    const title = updates.title !== undefined ? stripEmojis(updates.title) : null;
    const category = updates.category !== undefined ? stripEmojis(updates.category) : null;
    const amount = updates.amount !== undefined ? parseFloat(updates.amount) : null;
    await env.DB.prepare(`
      UPDATE finances SET
        needs_review = 0,
        possible_duplicate = 0,
        title = COALESCE(?, title),
        category = COALESCE(?, category),
        amount = COALESCE(?, amount)
      WHERE id = ? AND user_id = ?
    `).bind(title, category, amount, id, env.uid).run();
  } else if (table === 'tasks') {
    const title = updates.title !== undefined ? stripEmojis(updates.title) : null;
    const due = updates.due_datetime !== undefined ? updates.due_datetime : null;
    const priority = updates.priority !== undefined ? stripEmojis(updates.priority) : null;
    await env.DB.prepare(`
      UPDATE tasks SET
        needs_review = 0,
        possible_duplicate = 0,
        title = COALESCE(?, title),
        due_datetime = COALESCE(?, due_datetime),
        priority = COALESCE(?, priority)
      WHERE id = ? AND user_id = ?
    `).bind(title, due, priority, id, env.uid).run();
  } else if (table === 'notes') {
    const title = updates.title !== undefined ? stripEmojis(updates.title) : null;
    const content = updates.content !== undefined ? stripEmojis(updates.content) : null;
    const category = updates.category !== undefined ? stripEmojis(updates.category) : null;
    await env.DB.prepare(`
      UPDATE notes SET
        needs_review = 0,
        possible_duplicate = 0,
        title = COALESCE(?, title),
        content = COALESCE(?, content),
        category = COALESCE(?, category)
      WHERE id = ? AND user_id = ?
    `).bind(title, content, category, id, env.uid).run();
  }

  return jsonResponse({ ok: true, id });
}

async function mergeReviewItem(request, env) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const table = body.table;
  const id = parseInt(body.id, 10);
  const targetId = parseInt(body.target_id, 10);
  if (!['finances', 'tasks', 'notes'].includes(table) || !id || !targetId) {
    return errorResponse('Valid table, id, and target_id required', 400);
  }
  if (id === targetId) return errorResponse('Cannot merge a record into itself', 400);

  const source = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, env.uid).first();
  const target = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ? AND user_id = ?`).bind(targetId, env.uid).first();
  if (!source || !target) return errorResponse('Source or target record not found', 404);

  if (table === 'notes') {
    const sourceNote = await env.DB.prepare('SELECT title, content FROM notes WHERE id = ? AND user_id = ?').bind(id, env.uid).first();
    const targetNote = await env.DB.prepare('SELECT title, content FROM notes WHERE id = ? AND user_id = ?').bind(targetId, env.uid).first();
    if (sourceNote && targetNote) {
      const mergedContent = smartMergeText(targetNote.content, sourceNote.content);
      await env.DB.prepare('UPDATE notes SET content = ? WHERE id = ? AND user_id = ?').bind(mergedContent, targetId, env.uid).run();
    }
  } else if (table === 'tasks') {
    const sourceTask = await env.DB.prepare('SELECT title, due_datetime FROM tasks WHERE id = ? AND user_id = ?').bind(id, env.uid).first();
    const targetTask = await env.DB.prepare('SELECT title, due_datetime FROM tasks WHERE id = ? AND user_id = ?').bind(targetId, env.uid).first();
    if (sourceTask && targetTask) {
      const mergedTitle = smartMergeText(targetTask.title, sourceTask.title);
      const mergedDue = targetTask.due_datetime || sourceTask.due_datetime;
      await env.DB.prepare('UPDATE tasks SET title = ?, due_datetime = ? WHERE id = ? AND user_id = ?').bind(mergedTitle, mergedDue, targetId, env.uid).run();
    }
  }
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, env.uid).run();
  return jsonResponse({ ok: true, merged_into: targetId });
}

async function rejectReviewItem(request, env) {
  if (!env.DB) return errorResponse('D1 DB not bound', 500);
  const body = await readJson(request);
  const table = body.table;
  const id = parseInt(body.id, 10);
  if (!['finances', 'tasks', 'notes'].includes(table) || !id) {
    return errorResponse('Valid table and id required', 400);
  }
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, env.uid).run();
  return jsonResponse({ ok: true, deleted: id });
}
