const PRICE = 100_000_000;         // 0.1 TON в nanoTON
const MIN_DEPOSIT = 1_000_000_000; // 1 TON
const FREE_START = 5;              // пробные запросы
const FRESH_MS = 14 * 86400000;    // записи старше 14 дней удаляются
const COOLDOWN_MS = 10_000;        // пауза между "Взять человека"
const DAILY_LIMIT = 25;            // людей в сутки на пользователя
const REWARD = 250_000_000;        // награда за принятую пару: 0.25 TON
const EARN_DAILY = 30;             // принятых пар в сутки на человека
const OFFER_URL = 'https://t.me/garisofferopenbot'; // куда ведёт кнопка "Сделать оффер"
const DEFAULT_CHANNELS = ['prodazhai', 'prodazhaq', 'prodazhah', 'mospodbor', 'chatik_podarkov1', 'NFT_chatkk', 'podarkov_chatNFT', 'nft_chat_prodazha', 'prodazha_nft_chat', 'chattik_nft', 'podarkov_chatkk'];

const ton = n => +(n / 1e9).toFixed(3);
const isAdmin = (env, id) => String(id) === String(env.ADMIN_ID);
const dayKey = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // сутки по Москве

let ready = false;
async function initDb(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, free INTEGER NOT NULL DEFAULT 5, balance INTEGER NOT NULL DEFAULT 0, created_at INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS payments (hash TEXT PRIMARY KEY, user_id INTEGER, amount INTEGER, comment TEXT, created_at INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS items (slug TEXT PRIMARY KEY, owner TEXT, name TEXT, verified INTEGER, added_at INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS claimed (k TEXT PRIMARY KEY)'),
    db.prepare('CREATE TABLE IF NOT EXISTS channels (name TEXT PRIMARY KEY)'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY)'),
    db.prepare('CREATE TABLE IF NOT EXISTS usage2 (user_id INTEGER PRIMARY KEY, day TEXT, cnt INTEGER NOT NULL DEFAULT 0, last_ts INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS earn2 (user_id INTEGER PRIMARY KEY, day TEXT, cnt INTEGER NOT NULL DEFAULT 0)'),
  ]);
  const s = await db.prepare("INSERT OR IGNORE INTO meta (k) VALUES ('seed2')").run();
  if (s.meta.changes) await db.batch(DEFAULT_CHANNELS.map(n => db.prepare('INSERT OR IGNORE INTO channels (name) VALUES (?)').bind(n)));
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

// задержка 10 сек + лимит 25/сутки; возвращает текст отказа или null
async function gate(env, id, admin) {
  if (admin) return null;
  const now = Date.now(), day = dayKey();
  await env.DB.prepare('INSERT OR IGNORE INTO usage2 (user_id,day,cnt,last_ts) VALUES (?,?,0,0)').bind(id, day).run();
  await env.DB.prepare('UPDATE usage2 SET day=?, cnt=0 WHERE user_id=? AND day<>?').bind(day, id, day).run();
  const u = await env.DB.prepare('SELECT cnt,last_ts FROM usage2 WHERE user_id=?').bind(id).first();
  if (u.cnt >= DAILY_LIMIT) return `📅 Дневной лимит: ${DAILY_LIMIT} человек. Новый день начнётся в 00:00 по Москве.`;
  const r = await env.DB.prepare('UPDATE usage2 SET last_ts=? WHERE user_id=? AND last_ts<=?').bind(now, id, now - COOLDOWN_MS).run();
  if (!r.meta.changes) return `⏳ Подожди ещё ${Math.max(1, Math.ceil((u.last_ts + COOLDOWN_MS - now) / 1000))} сек.`;
  return null;
}

// сколько принятых пар человек ещё может сдать сегодня
async function earnLeft(env, id) {
  const day = dayKey();
  await env.DB.prepare('INSERT OR IGNORE INTO earn2 (user_id,day,cnt) VALUES (?,?,0)').bind(id, day).run();
  await env.DB.prepare('UPDATE earn2 SET day=?, cnt=0 WHERE user_id=? AND day<>?').bind(day, id, day).run();
  const r = await env.DB.prepare('SELECT cnt FROM earn2 WHERE user_id=?').bind(id).first();
  return EARN_DAILY - r.cnt;
}

// ---------- вспомогательное ----------
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

// имя владельца со страницы t.me/nft/<slug>; null — страница не получена (заглушка или NFT нет)
async function pageOwner(slug) {
  const pages = await Promise.all([H_PLAIN, H_PLAIN, H_FULL].map(h =>
    fetch(`https://t.me/nft/${slug}`, { headers: h }).then(r => r.text()).catch(() => '')));
  for (const html of pages) {
    const m = html.match(OWNER_RE);
    if (m) return decode(m[1].replace(/<[^>]+>/g, '')).trim();
  }
  return null;
}

// имя из профиля t.me/<username>; null — такого пользователя нет
async function profileName(username) {
  try {
    const r = await fetch(`https://t.me/${username}`, { headers: H_FULL });
    const html = await r.text();
    const m = html.match(/<meta property="og:title" content="([^"]*)"/i);
    const t = m ? decode(m[1]).trim() : '';
    if (!t || /^Telegram: (Contact|Launch|Join|View)/i.test(t)) return null;
    return t;
  } catch { return null; }
}

// пары «ссылка на NFT + @юзернейм» из текста (каждая пара с новой строки)
function parsePairs(text, max) {
  const slugRe = /t\.me\/nft\/([A-Za-z0-9_]+-\d+)/i;
  const userOf = s => {
    const x = s.replace(/t\.me\/nft\/\S+/gi, ' ').match(/(?:@|t\.me\/)([A-Za-z][A-Za-z0-9_]{4,31})/);
    return x ? x[1] : null;
  };
  const pairs = [];
  for (const l of text.split(/\n+/)) {
    const s = l.match(slugRe), u = userOf(l);
    if (s && u) pairs.push([s[1], u]);
  }
  if (!pairs.length) {
    const s = text.match(slugRe), u = userOf(text);
    if (s && u) pairs.push([s[1], u]);
  }
  const seen = new Set();
  return pairs.filter(([s]) => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())).slice(0, max);
}

// вставка в базу, если NFT и человека ещё не было и они не были выданы раньше
const INSERT_NEW = `INSERT OR IGNORE INTO items (slug,owner,name,verified,added_at)
  SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM claimed WHERE k=? OR k=?)
  AND NOT EXISTS (SELECT 1 FROM items WHERE lower(slug)=lower(?) OR lower(owner)=lower(?))`;
const insertNew = (env, slug, owner, name, verified, ts) =>
  env.DB.prepare(INSERT_NEW).bind(slug, owner, name, verified, ts, 'n:' + slug.toLowerCase(), 'o:' + owner.toLowerCase(), slug, owner);

// ---------- сдача пар: direct (админ) — сразу в базу; иначе проверка, дубли и награда ----------
async function handleSubmit(m, env, direct, text) {
  const pairs = parsePairs(text, direct ? 30 : 5);
  if (!pairs.length) return send(env, m.chat.id, '❌ Не нашёл пару «ссылка на NFT + @юзернейм». Пример:\nhttps://t.me/nft/PlushPepe-1 @username');
  let left = direct ? 999 : await earnLeft(env, m.from.id);
  if (left <= 0) return send(env, m.chat.id, `📅 Лимит на сегодня исчерпан (${EARN_DAILY} принятых пар). Продолжишь после 00:00 по Москве.`);

  const lines = [];
  let ok = 0;
  for (const [slug, owner] of pairs) {
    if (direct) {
      await env.DB.prepare('INSERT OR REPLACE INTO items (slug,owner,name,verified,added_at) VALUES (?,?,?,1,?)').bind(slug, owner, '', Date.now()).run();
      lines.push(`✅ ${slug} → @${owner}`); ok++; continue;
    }
    if (left <= 0) { lines.push(`⏸ ${slug}: дневной лимит`); continue; }
    if (/bot$/i.test(owner)) { lines.push(`❌ ${slug}: @${owner} — это бот`); continue; }
    const dupN = await env.DB.prepare('SELECT 1 AS x FROM items WHERE lower(slug)=lower(?) UNION ALL SELECT 1 FROM claimed WHERE k=?').bind(slug, 'n:' + slug.toLowerCase()).first();
    if (dupN) { lines.push(`❌ ${slug}: этот NFT уже был добавлен ранее — не засчитано`); continue; }
    const dupO = await env.DB.prepare('SELECT 1 AS x FROM items WHERE lower(owner)=lower(?) UNION ALL SELECT 1 FROM claimed WHERE k=?').bind(owner, 'o:' + owner.toLowerCase()).first();
    if (dupO) { lines.push(`❌ ${slug}: @${owner} уже был в базе — не засчитано`); continue; }
    const page = await pageOwner(slug);
    if (page === null) { lines.push(`❌ ${slug}: страница NFT не загрузилась (проверь ссылку или повтори через минуту)`); continue; }
    const prof = await profileName(owner);
    if (!prof) { lines.push(`❌ ${slug}: @${owner} не найден`); continue; }
    if (!sameName(page, prof, '')) { lines.push(`❌ ${slug}: владелец на странице NFT «${page}», а у @${owner} имя «${prof}» — не совпало`); continue; }
    const ins = await insertNew(env, slug, owner, prof, 1, Date.now()).run();
    if (!ins.meta.changes) { lines.push(`❌ ${slug}: этот NFT или человек уже был добавлен ранее — не засчитано`); continue; }
    await env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(REWARD, m.from.id).run();
    await env.DB.prepare('UPDATE earn2 SET cnt=cnt+1 WHERE user_id=?').bind(m.from.id).run();
    left--; ok++;
    lines.push(`✅ ${slug} → @${owner} (+${ton(REWARD)} TON)`);
  }
  let tail = '';
  if (!direct) {
    const u = await env.DB.prepare('SELECT balance FROM users WHERE id=?').bind(m.from.id).first();
    tail = `\n\n💰 Баланс: ${ton(u.balance)} TON`;
  }
  return send(env, m.chat.id, `${ok ? '✅ Принято: ' + ok : '❌ Ничего не принято'}\n${lines.join('\n')}${tail}`.slice(0, 3900));
}

// ---------- сканирование публичных каналов (t.me/s/<канал>) ----------
const SKIP_NAMES = new Set(['nft', 'mrkt', 'portals', 'tonnel', 'share', 'addlist', 'joinchat', 'boost', 'proxy', 'socks', 'login', 'telegram', 'durov', 'username', 'iv']);

async function scanChannel(env, name) {
  const r = await fetch(`https://t.me/s/${name}`, { headers: H_FULL });
  if (!r.ok) return { name, posts: 0, withNft: 0, added: 0, err: `HTTP ${r.status}` };
  const html = await r.text();
  const chunks = html.split('tgme_widget_message_wrap').slice(1);
  const stmts = [];
  let withNft = 0;
  for (const ch of chunks) {
    const t = Date.parse((ch.match(/datetime="([^"]+)"/) || [])[1] || '');
    if (!t || t < Date.now() - FRESH_MS) continue;
    const slugs = [...new Set([...ch.matchAll(/t\.me\/nft\/([A-Za-z0-9_]+-\d+)/gi)].map(x => x[1]))].slice(0, 5);
    if (!slugs.length) continue;
    withNft++;
    const text = decode(ch.replace(/<[^>]+>/g, ' ')).replace(/(через|via)\s+@\w+/gi, ' ');
    const cands = [...text.matchAll(/@([A-Za-z][A-Za-z0-9_]{4,31})/g)].map(x => x[1]);
    for (const x of ch.matchAll(/href="https?:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})"/g)) cands.push(x[1]);
    const owner = cands.find(u => u.toLowerCase() !== name.toLowerCase() && !/bot$/i.test(u) && !SKIP_NAMES.has(u.toLowerCase()));
    if (!owner) continue;
    for (const slug of slugs) stmts.push(insertNew(env, slug, owner, '', 0, t));
  }
  let added = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch(stmts.slice(i, i + 50));
    added += res.reduce((s, x) => s + (x.meta.changes || 0), 0);
  }
  return { name, posts: chunks.length, withNft, added };
}

async function scanSome(env, all = false) {
  const { results } = await env.DB.prepare('SELECT name FROM channels ORDER BY name').all();
  const names = results.map(r => r.name);
  if (!names.length) return [];
  const step = Math.floor(Date.now() / 60000) * 2;
  const pick = all ? names : [0, 1].map(i => names[(step + i) % names.length]);
  const out = [];
  for (const n of [...new Set(pick)]) {
    try { out.push(await scanChannel(env, n)); }
    catch (e) { out.push({ name: n, posts: 0, withNft: 0, added: 0, err: String(e) }); }
  }
  return out;
}
const fmtScan = o => `@${o.name}: ${o.err ? 'ошибка ' + o.err : o.posts ? `постов ${o.posts}, с NFT ${o.withNft}, новых людей ${o.added}` : 'посты не видны (это чат, а не канал)'}`;

// ---------- сбор из чатов, где есть бот ----------
async function collect(m, env, u, rep) {
  const log = t => rep && rep.push(t);
  if (!u || u.is_bot) return 0;
  if (!u.username) { log(`У автора «${u.first_name}» нет публичного @юзернейма.`); return 0; }
  const urls = [...(m.entities || []), ...(m.caption_entities || [])].map(e => e.url || '').join(' ');
  const blob = `${m.text || ''} ${m.caption || ''} ${urls}`;
  const slugs = [...new Set([...blob.matchAll(/t\.me\/nft\/([A-Za-z0-9_]+-\d+)/gi)].map(x => x[1]))].slice(0, 5);
  if (!slugs.length) { log('В сообщении нет ссылки t.me/nft/…'); return 0; }
  const name = `${u.first_name || ''} ${u.last_name || ''}`.trim();
  const res = await env.DB.batch(slugs.map(slug => insertNew(env, slug, u.username, name, 0, Date.now())));
  const added = res.reduce((s, x) => s + (x.meta.changes || 0), 0);
  log(`@${u.username}: ссылок ${slugs.length}, новых ${added}`);
  return added;
}

// выдать случайного человека ОДНОМУ покупателю: запись удаляется из базы и помечается выданной навсегда
async function pickNft(env) {
  for (let i = 0; i < 3; i++) {
    const res = await env.DB.prepare(
      'DELETE FROM items WHERE slug = (SELECT slug FROM items WHERE added_at > ? ORDER BY RANDOM() LIMIT 1) RETURNING *')
      .bind(Date.now() - FRESH_MS).all();
    const row = res.results && res.results[0];
    if (!row) continue;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM items WHERE lower(owner)=lower(?)').bind(row.owner),
      env.DB.prepare('INSERT OR IGNORE INTO claimed (k) VALUES (?)').bind('n:' + row.slug.toLowerCase()),
      env.DB.prepare('INSERT OR IGNORE INTO claimed (k) VALUES (?)').bind('o:' + row.owner.toLowerCase()),
    ]);
    return row;
  }
  return null;
}

// ---------- тексты ----------
const mainKb = { inline_keyboard: [
  [{ text: '👤 Взять человека', callback_data: 'get' }],
  [{ text: '💸 Заработать TON', callback_data: 'earn' }],
  [{ text: '💰 Баланс / Пополнить', callback_data: 'bal' }],
] };
const mainText = (u, admin) =>
  `👋 Бот-парсер NFT-подарков\n\n🎁 Бесплатных запросов: ${admin ? '∞' : u.free}\n💰 Баланс: ${ton(u.balance)} TON\n\nКаждый следующий запрос — 0.1 TON.\nПауза между запросами 10 сек, не больше ${DAILY_LIMIT} человек в сутки.`;
const depositText = (env, u) =>
  `💰 Баланс: ${ton(u.balance)} TON\n\nПополнение (от 1 TON). Отправь TON на адрес:\n<code>${env.WALLET}</code>\n\n⚠️ В комментарии обязательно укажи свой ID:\n<code>${u.id}</code>\n\nЗачислится автоматически за 1–2 минуты.`;
const earnText = `💸 Заработай TON на баланс\n\nНашёл NFT-подарок и его владельца? Пришли мне сообщением ссылку на NFT и @юзернейм владельца.\n\nПример:\nhttps://t.me/nft/PlushPepe-1 @username\n\nМожно несколько пар — каждую с новой строки (до 5 за раз).\n\n💰 За каждую принятую пару: +${ton(REWARD)} TON на баланс (до ${EARN_DAILY} в сутки).\n\nПара принимается, если NFT существует, @юзернейм настоящий, имя владельца на странице NFT совпадает с именем в профиле @юзернейма. Один и тот же NFT и один и тот же человек засчитываются только один раз: если уже есть в базе или уже выдавался, награды не будет.`;

// ---------- обработчики ----------
async function onMessage(m, env) {
  if (m.chat.type !== 'private') { if (!m.forward_origin) await collect(m, env, m.from); return; } // чаты: собираем ссылки

  const admin = isAdmin(env, m.from.id);
  const parts = (m.text || '').trim().split(/\s+/);
  const [cmd, a, b] = parts;
  const user = await getUser(env, m.from);

  if (cmd === '/earn') { // сдача пары как обычный пользователь (проверка, дубли, награда) — работает и у админа
    return handleSubmit(m, env, false, (m.text || '').replace(/^\/earn\S*\s*/i, ''));
  }
  if (admin && m.forward_origin) { // пересланное сообщение из чата продаж
    const o = m.forward_origin;
    if (o.type === 'hidden_user') return send(env, m.chat.id, '❌ Автор скрыл пересылку — юзернейм взять негде.');
    if (o.type !== 'user') return send(env, m.chat.id, '❌ Переслано из канала, автор неизвестен. Для каналов используй /addchannel имя.');
    const rep = [];
    const n = await collect(m, env, o.sender_user, rep);
    return send(env, m.chat.id, `${n ? '✅ Добавлено: ' + n : '❌ Не добавлено'}\n${rep.join('\n')}`.slice(0, 3900));
  }
  if (admin && cmd === '/delnft') { // удалить запись из базы: /delnft PlushPepe-1
    const r = await env.DB.prepare('DELETE FROM items WHERE lower(slug)=lower(?)').bind(a || '').run();
    return send(env, m.chat.id, r.meta.changes ? '✅ Удалено из базы.' : 'Такого NFT в базе нет.');
  }
  if (admin && cmd === '/unclaim') { // снять "уже выдавался" для повторного теста: /unclaim PlushPepe-1  или  /unclaim @username
    const x = (a || '').replace(/^@/, '');
    if (!x) return send(env, m.chat.id, 'Формат: /unclaim PlushPepe-1 или /unclaim @username');
    const key = /-\d+$/.test(x) ? 'n:' + x.toLowerCase() : 'o:' + x.toLowerCase();
    const r = await env.DB.prepare('DELETE FROM claimed WHERE k=?').bind(key).run();
    return send(env, m.chat.id, r.meta.changes ? '✅ Блокировка снята.' : 'Такой записи среди выданных нет.');
  }
  if (admin && cmd === '/addchannel') { // /addchannel prodazhai  (можно несколько через пробел или ссылки)
    const names = parts.slice(1).map(x => x.replace(/^.*t\.me\/(s\/)?/i, '').replace(/^@/, '').split(/[/?]/)[0]).filter(Boolean);
    if (!names.length) return send(env, m.chat.id, 'Формат: /addchannel prodazhai (имя или ссылка, можно несколько)');
    const lines = [];
    for (const name of names.slice(0, 10)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name)) { lines.push(`❌ ${name}: неверное имя`); continue; }
      await env.DB.prepare('INSERT OR IGNORE INTO channels (name) VALUES (?)').bind(name).run();
      const o = await scanChannel(env, name).catch(e => ({ name, err: String(e) }));
      lines.push(fmtScan(o));
    }
    return send(env, m.chat.id, '✅ Добавлено в список\n' + lines.join('\n'));
  }
  if (admin && cmd === '/delchannel') {
    await env.DB.prepare('DELETE FROM channels WHERE name=?').bind((a || '').replace(/^@/, '')).run();
    return send(env, m.chat.id, '✅ Удалено (если был в списке).');
  }
  if (admin && cmd === '/channels') {
    const { results } = await env.DB.prepare('SELECT name FROM channels ORDER BY name').all();
    return send(env, m.chat.id, `📡 Источники (${results.length}):\n` + results.map(r => '@' + r.name).join('\n'));
  }
  if (admin && cmd === '/scan') { // сканировать все каналы прямо сейчас
    const out = await scanSome(env, true);
    return send(env, m.chat.id, (out.length ? out.map(fmtScan).join('\n') : 'Список пуст: /addchannel имя').slice(0, 3900));
  }
  if (admin && cmd === '/stats') {
    const all = await env.DB.prepare('SELECT COUNT(*) AS c FROM items').first();
    const own = await env.DB.prepare('SELECT COUNT(DISTINCT owner) AS c FROM items').first();
    const gone = await env.DB.prepare("SELECT COUNT(*) AS c FROM claimed WHERE k LIKE 'o:%'").first();
    const u = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
    const ch = await env.DB.prepare('SELECT COUNT(*) AS c FROM channels').first();
    return send(env, m.chat.id, `📊 В базе: ${all.c} NFT, людей: ${own.c}\n📤 Уже выдано людей: ${gone.c}\n📡 Источников: ${ch.c}\n👥 Пользователей: ${u.c}`);
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
  if (m.text && !m.text.startsWith('/') && /t\.me\/nft\//i.test(m.text)) return handleSubmit(m, env, admin, m.text);
}

async function onCallback(q, env) {
  const chat = q.message.chat.id;
  const admin = isAdmin(env, q.from.id);

  if (q.data === 'get') {
    const block = await gate(env, q.from.id, admin);
    if (block) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: block, show_alert: true });
  }
  await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  const user = await getUser(env, q.from);

  if (q.data === 'earn') return send(env, chat, earnText, { reply_markup: mainKb });
  if (q.data === 'bal') {
    return send(env, chat, depositText(env, user), { parse_mode: 'HTML', reply_markup: mainKb });
  }
  if (q.data !== 'get') return;

  const kind = await charge(env, q.from.id, admin);
  if (!kind) {
    await env.DB.prepare('UPDATE usage2 SET last_ts=0 WHERE user_id=?').bind(q.from.id).run();
    return send(env, chat, '❌ Бесплатные запросы закончились, а на балансе меньше 0.1 TON.\n\nМожно пополнить баланс или заработать TON, добавляя NFT и владельцев.\n\n' + depositText(env, user), { parse_mode: 'HTML', reply_markup: mainKb });
  }
  const wait = await send(env, chat, '🔎 Ищу...');
  const mid = wait.result?.message_id;
  const nft = await pickNft(env);

  if (!nft) {
    await refund(env, q.from.id, kind);
    await env.DB.prepare('UPDATE usage2 SET last_ts=0 WHERE user_id=?').bind(q.from.id).run();
    return tg(env, 'editMessageText', { chat_id: chat, message_id: mid,
      text: '😕 Новых людей пока нет, база пополняется. Запрос не списан — попробуй позже.',
      reply_markup: { inline_keyboard: [[{ text: '🔁 Ещё раз', callback_data: 'get' }]] } });
  }
  let today = '';
  if (!admin) {
    await env.DB.prepare('UPDATE usage2 SET cnt=cnt+1 WHERE user_id=?').bind(q.from.id).run();
    const us = await env.DB.prepare('SELECT cnt FROM usage2 WHERE user_id=?').bind(q.from.id).first();
    today = ` | сегодня ${us.cnt}/${DAILY_LIMIT}`;
  }
  const u2 = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(q.from.id).first();
  await tg(env, 'editMessageText', { chat_id: chat, message_id: mid,
    text: `🎁 NFT: https://t.me/nft/${nft.slug}\n👤 ${nft.verified ? 'Владелец' : 'Продавец'}: @${nft.owner}\n\nОсталось: ${admin ? '∞' : u2.free} беспл. | ${ton(u2.balance)} TON${today}`,
    reply_markup: { inline_keyboard: [
      [{ text: '💼 Сделать оффер', url: OFFER_URL }],
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
    ctx.waitUntil((async () => {
      await initDb(env.DB);
      await checkPayments(env).catch(e => console.error(e));
      await scanSome(env).catch(e => console.error(e));
      await env.DB.prepare('DELETE FROM items WHERE added_at < ?').bind(Date.now() - FRESH_MS).run().catch(e => console.error(e));
    })());
  },
};