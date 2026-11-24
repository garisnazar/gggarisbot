const PRICE = 100_000_000;         // 0.1 TON в nanoTON
const MIN_DEPOSIT = 1_000_000_000; // 1 TON
const FREE_START = 5;              // пробные запросы
const MAX_NUM = 2000;              // номера NFT берутся от 1 до MAX_NUM
const COLLECTIONS = ['PlushPepe','DurovsCap','HeartLocket','LootBag','SnoopDogg','ToyBear','SwissWatch','ScaredCat','SpicedWine','EternalRose','LolPop','HomemadeCake','JellyBunny','BDayCandle','DiamondRing','LoveCandle','SignetRing','VintageCigar','TopHat','NailBracelet','GingerCookie','CookieHeart','JesterHat','WitchHat','HexPot','BigYear','SnowGlobe','StarNotepad'];

const ton = n => +(n / 1e9).toFixed(3);
const isAdmin = (env, id) => String(id) === String(env.ADMIN_ID);

let ready = false;
async function initDb(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, free INTEGER NOT NULL DEFAULT 5, balance INTEGER NOT NULL DEFAULT 0, created_at INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS payments (hash TEXT PRIMARY KEY, user_id INTEGER, amount INTEGER, comment TEXT, created_at INTEGER)'),
  ]);
  ready = true;
}

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json()).catch(() => ({}));
const send = (env, chat_id, text, extra = {}) => tg(env, 'sendMessage', { chat_id, text, ...extra });

async function ensureUser(env, id, username = null) {
  await env.DB.prepare('INSERT OR IGNORE INTO users (id,username,free,balance,created_at) VALUES (?,?,?,0,?)')
    .bind(id, username, FREE_START, Date.now()).run();
}
async function getUser(env, from) {
  await ensureUser(env, from.id, from.username || null);
  return env.DB.prepare('SELECT * FROM users WHERE id=?').bind(from.id).first();
}

// списание: сначала бесплатные, потом баланс
async function charge(env, id, admin) {
  if (admin) return 'admin';
  let r = await env.DB.prepare('UPDATE users SET free=free-1 WHERE id=? AND free>0').bind(id).run();
  if (r.meta.changes) return 'free';
  r = await env.DB.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').bind(PRICE, id, PRICE).run();
  return r.meta.changes ? 'paid' : null;
}
async function refund(env, id, kind) {
  if (kind === 'free') await env.DB.prepare('UPDATE users SET free=free+1 WHERE id=?').bind(id).run();
  if (kind === 'paid') await env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(PRICE, id).run();
}

// ---------- поиск NFT (открытая страница t.me/nft/<Коллекция>-<номер>) ----------
function parseOwner(html, slug) {
  const m = html.match(/<th[^>]*>\s*Owner\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
  if (!m) return null;
  const u = m[1].match(/href="(?:https?:\/\/t\.me\/|\/|tg:\/\/resolve\?domain=)@?([A-Za-z][A-Za-z0-9_]{3,31})"/i);
  if (!u) return null; // у владельца нет юзернейма
  return { link: `https://t.me/nft/${slug}`, owner: u[1] };
}
async function fetchNft(slug) {
  try {
    const r = await fetch(`https://t.me/nft/${slug}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    return parseOwner(await r.text(), slug);
  } catch { return null; }
}
async function findNft() {
  for (let round = 0; round < 3; round++) {
    const batch = Array.from({ length: 4 }, () => {
      const c = COLLECTIONS[Math.floor(Math.random() * COLLECTIONS.length)];
      return fetchNft(`${c}-${1 + Math.floor(Math.random() * MAX_NUM)}`);
    });
    const found = (await Promise.all(batch)).find(Boolean);
    if (found) return found;
  }
  return null;
}

// ---------- тексты ----------
const mainKb = { inline_keyboard: [
  [{ text: '👤 Взять человека', callback_data: 'get' }],
  [{ text: '💰 Баланс / Пополнить', callback_data: 'bal' }],
] };
const mainText = (u, admin) =>
  `👋 Бот-парсер NFT-подарков\n\n🎁 Бесплатных запросов: ${admin ? '∞' : u.free}\n💰 Баланс: ${ton(u.balance)} TON\n\nКаждый следующий запрос — 0.1 TON.`;
const depositText = (env, u) =>
  `💰 Баланс: ${ton(u.balance)} TON\n\nПополнение (от 1 TON). Отправь TON на адрес:\n<code>${env.WALLET}</code>\n\n⚠️ В комментарии обязательно укажи свой ID:\n<code>${u.id}</code>\n\nЗачислится автоматически за 1–2 минуты.`;

// ---------- обработчики ----------
async function onMessage(m, env) {
  if (m.chat.type !== 'private') return;
  const admin = isAdmin(env, m.from.id);
  const [cmd, a, b] = (m.text || '').trim().split(/\s+/);
  const user = await getUser(env, m.from);

  if (admin && cmd === '/addzapros') {
    const n = parseInt(a), id = parseInt(b);
    if (!n || !id) return send(env, m.chat.id, 'Формат: /addzapros 10 123456789');
    await ensureUser(env, id);
    await env.DB.prepare('UPDATE users SET free=free+? WHERE id=?').bind(n, id).run();
    await send(env, m.chat.id, `✅ Добавлено запросов: ${n} → ${id}`);
    return send(env, id, `🎁 Тебе добавили запросов: ${n}`);
  }
  if (admin && cmd === '/addbalance') { // ручное зачисление: /addbalance 1.5 123456789
    const t = parseFloat(a), id = parseInt(b);
    if (!t || !id) return send(env, m.chat.id, 'Формат: /addbalance 1.5 123456789');
    await ensureUser(env, id);
    await env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(Math.round(t * 1e9), id).run();
    await send(env, m.chat.id, `✅ Зачислено ${t} TON → ${id}`);
    return send(env, id, `✅ Баланс пополнен на ${t} TON`);
  }
  if (admin && cmd === '/nft') { // отладка парсера: /nft PlushPepe-1
    const slug = a || 'PlushPepe-1';
    const r = await fetch(`https://t.me/nft/${slug}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const html = await r.text();
    const res = parseOwner(html, slug);
    const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '—';
    const plain = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const g = html.search(/tgme_gift/i);
    const raw = g >= 0 ? html.slice(g, g + 900) : html.slice(0, 600);
    return send(env, m.chat.id,
      `HTTP ${r.status}, ${html.length} симв.\nОтвет: ${res ? '@' + res.owner : 'не найден'}\nTitle: ${title}\n\nТЕКСТ: ${plain.slice(0, 700)}\n\nHTML: ${raw}`.slice(0, 3900));
  }
  if (cmd === '/start') return send(env, m.chat.id, mainText(user, admin), { reply_markup: mainKb });
}

async function onCallback(q, env) {
  const chat = q.message.chat.id;
  const admin = isAdmin(env, q.from.id);
  await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  const user = await getUser(env, q.from);

  if (q.data === 'bal') {
    return send(env, chat, depositText(env, user), { parse_mode: 'HTML', reply_markup: mainKb });
  }
  if (q.data !== 'get') return;

  const kind = await charge(env, q.from.id, admin);
  if (!kind) {
    return send(env, chat, '❌ Бесплатные запросы закончились, а на балансе меньше 0.1 TON.\n\n' + depositText(env, user), { parse_mode: 'HTML' });
  }
  const wait = await send(env, chat, '🔎 Ищу...');
  const mid = wait.result?.message_id;
  const nft = await findNft();

  if (!nft) {
    await refund(env, q.from.id, kind);
    return tg(env, 'editMessageText', { chat_id: chat, message_id: mid,
      text: '😕 Никого не нашёл. Запрос не списан — попробуй ещё раз.',
      reply_markup: { inline_keyboard: [[{ text: '🔁 Ещё раз', callback_data: 'get' }]] } });
  }
  const u2 = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(q.from.id).first();
  await tg(env, 'editMessageText', { chat_id: chat, message_id: mid,
    text: `🎁 NFT: ${nft.link}\n👤 Владелец: @${nft.owner}\n\nОсталось: ${admin ? '∞' : u2.free} беспл. | ${ton(u2.balance)} TON`,
    reply_markup: { inline_keyboard: [
      [{ text: '💼 Сделать оффер', url: env.OFFER_URL }],
      [{ text: '👤 Взять ещё', callback_data: 'get' }],
    ] } });
}

// ---------- автопополнение (cron каждую минуту) ----------
async function checkPayments(env) {
  const r = await fetch(`https://toncenter.com/api/v3/transactions?account=${env.WALLET}&limit=30&sort=desc`,
    { headers: env.TONCENTER_KEY ? { 'X-API-Key': env.TONCENTER_KEY } : {} });
  if (!r.ok) return;
  const { transactions = [] } = await r.json();

  for (const tx of transactions.reverse()) {
    const im = tx.in_msg;
    if (!im || !im.source || tx.description?.aborted) continue;
    if (tx.now < Date.now() / 1000 - 86400) continue;
    const amount = Number(im.value || 0);
    if (!amount) continue;
    const comment = String(im.message_content?.decoded?.comment || '').trim();
    const uid = /^\d{5,15}$/.test(comment) ? Number(comment) : null;

    const ins = await env.DB.prepare('INSERT OR IGNORE INTO payments (hash,user_id,amount,comment,created_at) VALUES (?,?,?,?,?)')
      .bind(tx.hash, uid, amount, comment, Date.now()).run();
    if (!ins.meta.changes) continue; // уже обработан

    if (uid && amount >= MIN_DEPOSIT) {
      await ensureUser(env, uid);
      await env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(amount, uid).run();
      const u = await env.DB.prepare('SELECT balance FROM users WHERE id=?').bind(uid).first();
      await send(env, uid, `✅ Баланс пополнен на ${ton(amount)} TON. Сейчас: ${ton(u.balance)} TON`);
    } else if (amount >= PRICE) {
      await send(env, env.ADMIN_ID, `⚠️ Не зачислено: ${ton(amount)} TON от ${im.source}\nКомментарий: "${comment}"\nЗачислить вручную: /addbalance ${ton(amount)} <ID>`);
    }
  }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method !== 'POST') return new Response('gggarisbot ok');
    if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET)
      return new Response('forbidden', { status: 403 });
    const upd = await req.json();
    ctx.waitUntil((async () => {
      await initDb(env.DB);
      if (upd.message) await onMessage(upd.message, env);
      else if (upd.callback_query) await onCallback(upd.callback_query, env);
    })().catch(e => console.error(e)));
    return new Response('ok');
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { await initDb(env.DB); await checkPayments(env); })().catch(e => console.error(e)));
  },
};
