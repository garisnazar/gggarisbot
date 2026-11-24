const PRICE = 100_000_000;         // 0.1 TON в nanoTON
const MIN_DEPOSIT = 1_000_000_000; // 1 TON
const FREE_START = 5;              // пробные запросы

const ton = n => +(n / 1e9).toFixed(3);
const isAdmin = (env, id) => String(id) === String(env.ADMIN_ID);

let ready = false;
async function initDb(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, free INTEGER NOT NULL DEFAULT 5, balance INTEGER NOT NULL DEFAULT 0, created_at INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS payments (hash TEXT PRIMARY KEY, user_id INTEGER, amount INTEGER, comment TEXT, created_at INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS nfts (slug TEXT PRIMARY KEY, owner TEXT, name TEXT, added_at INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS seen (user_id INTEGER, slug TEXT, PRIMARY KEY (user_id, slug))'),
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

// ---------- страница NFT: имя владельца ----------
const H_PLAIN = { 'user-agent': 'Mozilla/5.0' };
const H_FULL = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};
const OWNER_RE = />\s*Owner\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i;

const decode = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const norm = s => decode(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function sameName(page, first, last) {
  const a = norm(page), b = norm(`${first || ''}${last || ''}`);
  if (!a || !b) return false;
  return a === b || (a.length > 3 && b.includes(a)) || (b.length > 3 && a.includes(b));
}

// имя владельца со страницы t.me/nft/<slug>; null — страница не получена (Telegram иногда отдаёт заглушку)
async function pageOwner(slug) {
  const pages = await Promise.all([H_PLAIN, H_PLAIN, H_FULL].map(h =>
    fetch(`https://t.me/nft/${slug}`, { headers: h }).then(r => r.text()).catch(() => '')));
  for (const html of pages) {
    const m = html.match(OWNER_RE);
    if (m) return decode(m[1].replace(/<[^>]+>/g, '')).trim();
  }
  return null;
}
async function verify(slug, u) {
  const page = await pageOwner(slug);
  if (page === null) return null;
  return sameName(page, u.first_name, u.last_name);
}

// ---------- сбор NFT из чатов ----------
async function collect(m, env, u) {
  if (!u || u.is_bot || !u.username) return 0;
  const urls = [...(m.entities || []), ...(m.caption_entities || [])].map(e => e.url || '').join(' ');
  const blob = `${m.text || ''} ${m.caption || ''} ${urls}`;
  const slugs = [...new Set([...blob.matchAll(/t\.me\/nft\/([A-Za-z0-9_]+-\d+)/gi)].map(x => x[1]))].slice(0, 5);
  let added = 0;
  for (const slug of slugs) {
    const ex = await env.DB.prepare('SELECT owner FROM nfts WHERE slug=?').bind(slug).first();
    if (ex && ex.owner === u.username) continue;
    if ((await verify(slug, u)) !== true) continue; // имя владельца на странице не совпало
    const name = `${u.first_name || ''} ${u.last_name || ''}`.trim();
    await env.DB.prepare('INSERT OR REPLACE INTO nfts (slug,owner,name,added_at) VALUES (?,?,?,?)')
      .bind(slug, u.username, name, Date.now()).run();
    added++;
  }
  return added;
}

// случайный владелец, которого этот пользователь ещё не получал
async function pickNft(env, userId) {
  for (let i = 0; i < 4; i++) {
    const row = await env.DB.prepare(
      'SELECT * FROM nfts WHERE slug NOT IN (SELECT slug FROM seen WHERE user_id=?) ORDER BY RANDOM() LIMIT 1').bind(userId).first();
    if (!row) return null;
    const page = await pageOwner(row.slug);
    if (page !== null && !sameName(page, row.name, '')) { // NFT сменил владельца
      await env.DB.prepare('DELETE FROM nfts WHERE slug=?').bind(row.slug).run();
      continue;
    }
    await env.DB.prepare('INSERT OR IGNORE INTO seen (user_id,slug) VALUES (?,?)').bind(userId, row.slug).run();
    return row;
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
  if (m.chat.type !== 'private') { await collect(m, env, m.from); return; } // чаты: собираем ссылки

  const admin = isAdmin(env, m.from.id);
  const [cmd, a, b] = (m.text || '').trim().split(/\s+/);
  const user = await getUser(env, m.from);

  if (admin && m.forward_origin?.type === 'user') { // пересланное сообщение из чата продаж
    const n = await collect(m, env, m.forward_origin.sender_user);
    return send(env, m.chat.id, n ? `✅ Добавлено в базу: ${n}` : 'Не добавлено: нет ссылки на NFT, нет юзернейма у автора или имя владельца на странице не совпало.');
  }
  if (admin && cmd === '/stats') {
    const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM nfts').first();
    const u = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
    return send(env, m.chat.id, `📊 NFT в базе: ${c.c}\n👥 Пользователей: ${u.c}`);
  }
  if (admin && cmd === '/nft') { // проверка страницы: /nft PlushPepe-1
    const n = await pageOwner(a || 'PlushPepe-1');
    return send(env, m.chat.id, `Владелец на странице: ${n ?? 'не получено (заглушка Telegram или NFT нет)'}`);
  }
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
  const nft = await pickNft(env, q.from.id);

  if (!nft) {
    await refund(env, q.from.id, kind);
    return tg(env, 'editMessageText', { chat_id: chat, message_id: mid,
      text: '😕 Новых владельцев пока нет, база пополняется. Запрос не списан — попробуй позже.',
      reply_markup: { inline_keyboard: [[{ text: '🔁 Ещё раз', callback_data: 'get' }]] } });
  }
  const u2 = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(q.from.id).first();
  await tg(env, 'editMessageText', { chat_id: chat, message_id: mid,
    text: `🎁 NFT: https://t.me/nft/${nft.slug}\n👤 Владелец: @${nft.owner}\n\nОсталось: ${admin ? '∞' : u2.free} беспл. | ${ton(u2.balance)} TON`,
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
