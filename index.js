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

// вставка «один человек — одна запись» (каналы и /earn): не вставляет, если NFT/человек уже есть или уже выдавались
const INSERT_NEW = `INSERT OR IGNORE INTO items (slug,owner,name,verified,added_at)
  SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM claimed WHERE k=? OR k=?)
  AND NOT EXISTS (SELECT 1 FROM items WHERE lower(slug)=lower(?) OR lower(owner)=lower(?))`;
const insertNew = (env, slug, owner, name, verified, ts) =>
  env.DB.prepare(INSERT_NEW).bind(slug, owner, name, verified, ts, 'n:' + slug.toLowerCase(), 'o:' + owner.toLowerCase(), slug, owner);

// вставка всех NFT одного человека (админская загрузка): человек может иметь много записей
const INSERT_GRAB = `INSERT OR IGNORE INTO items (slug,owner,name,verified,added_at)
  SELECT ?,?,?,1,? WHERE NOT EXISTS (SELECT 1 FROM claimed WHERE k=? OR k=?)
  AND NOT EXISTS (SELECT 1 FROM items WHERE lower(slug)=lower(?))`;

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
  return send(env, m.chat.id, `${ok ? '✅ Принято: ' + ok : '❌ Ничего не принято'}\n${lines.join('\n')}${ta