// Abugram relay: lets Abugram reach Telegram where *.web.telegram.org is blocked, and serves Abugram's own ads.
//
// Telegram (only Telegram's own web endpoints are forwarded):
//   https://<relay>/<host>/apiw1 -> https://<host>.web.telegram.org/apiw1 (plain HTTPS requests)
//   wss://<relay>/<host>/apiws   -> wss://<host>.web.telegram.org/apiws  (WebSocket)
// The MTProto traffic inside stays encrypted end to end between the app and Telegram; the relay cannot read it.
//
// Ads (need a D1 database bound as DB; without it there are simply no ads):
//   GET  /ads              the active ads, for the apps
//   Campaigns: kind 'hours' | 'days' (amount = how many, from now) or 'views' (amount = how many views); a campaign stops by time or by views
//   POST /ads/seen         body {"ids":[1,2]}: counts a view of each
//   GET  /go/<id>          counts a click and redirects to the ad's link
//   GET  /access?uid=<id>  what this Telegram account may use: {"ghost": bool, "admin": bool}
//   POST /hello            body {"uid": <id>, "platform": "web"|"android", "version": "..."}: counts the account as active today
//                          on that platform (one account on both counts on both); only a SHA-256 of the ID is kept
//   GET  /stats            user counts for advertisers: total, today, 7 and 30 days, by platform, the last 30 days
//   /admin/ads             list (GET), save (POST {id?, title, text, image, url, active}), delete (DELETE ?id=)
//   /admin/stats           /stats plus the app versions in use (admin only)
//   GET  /config           {paid, minBuild, ...}: what the apps check at start (an update is required / a paid period is required); both off while free
//   /config `off`: the features the admin switched off (apps skip them): ads, splash, updater, sendTime, ghost, keepDeleted
//   Payments (subscription; see the pay page): GET /pay/quote?uid=, POST /pay/create {uid} (PayHamyon, so'm),
//   GET /pay/status?id=&uid=, POST /pay/callback?k=, POST /pay/rub {uid, bank, rub, at, contact} (rubles, confirmed by hand);
//   /admin/pay (GET payments + settings, POST settings), /admin/pay/approve, /admin/pay/reject, /admin/pay/test
//   /admin/config          read (GET) and save (POST) /config; `relays` = the relay servers of the apps, one https address per line
//   /admin/access          the allowed accounts: list (GET), save (POST {uid, name, ghost, admin}), delete (DELETE ?uid=)
//                          all /admin/* only with "Authorization: Bearer <ADMIN_PASSWORD>" (a secret set in Cloudflare);
//                          5 wrong passwords lock the address out for 15 minutes; /admin/* and /access answer only the Abugram site's origin
const HTTP_ROUTE = /^\/((?:pluto|venus|aurora|vesta|flora)(?:-[a-z0-9]+)*)\/(apiw(?:_test)?1)$/i;
const WS_ROUTE = /^\/((?:k|a)?ws[1-5](?:-[a-z0-9]+)*)\/(apiws(?:_test)?(?:_premium)?)$/i;
const SITE_ORIGIN = 'https://abdulaziz0196.github.io';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type'
};
// what the browser may read from the admin and account endpoints: only the Abugram site (the apps are not browsers)
const STRICT_CORS = {...CORS, 'access-control-allow-origin': SITE_ORIGIN, 'vary': 'origin'};
const SAFE = {'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'};

function json(data, status = 200, extra = {}, cors = CORS) {
  return new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json; charset=utf-8', ...cors, ...SAFE, ...extra}});
}

// best-effort rate limit per address, kept in this isolate's memory (costs no database writes)
const hits = new Map();
function limited(request, name, max, windowMs) {
  const ip = request.headers.get('cf-connecting-ip') || 'x';
  const key = name + '|' + ip;
  const now = Date.now();
  let h = hits.get(key);
  if(!h || now > h.until) { h = {n: 0, until: now + windowMs}; hits.set(key, h); }
  h.n++;
  if(hits.size > 5000) for(const [k, v] of hits) if(now > v.until) hits.delete(k);
  return h.n > max;
}

async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

let schemaReady = false;
async function db(env) {
  if(!env.DB) return null;
  if(!schemaReady) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0
    )`).run();
    for(const col of ['kind TEXT NOT NULL DEFAULT \'\'', 'ends INTEGER', 'views_limit INTEGER']) {
      try { await env.DB.prepare('ALTER TABLE ads ADD COLUMN ' + col).run(); } catch(e) {}
    }
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ad_views (
      ad_id INTEGER NOT NULL, h TEXT NOT NULL, PRIMARY KEY (ad_id, h)
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS access (
      uid INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      ghost INTEGER NOT NULL DEFAULT 0,
      admin INTEGER NOT NULL DEFAULT 0
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      h TEXT PRIMARY KEY, platform TEXT NOT NULL DEFAULT '', first INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL DEFAULT 0
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS daily (
      day TEXT NOT NULL, h TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '', PRIMARY KEY (day, h)
    )`).run();
    // per platform: one account on the phone and on the web counts on both, and once in the total
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_platforms (
      h TEXT NOT NULL, platform TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', first INTEGER NOT NULL DEFAULT 0, last INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (h, platform)
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS daily_p (
      day TEXT NOT NULL, h TEXT NOT NULL, platform TEXT NOT NULL, visits INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (day, h, platform)
    )`).run();
    await env.DB.prepare('INSERT OR IGNORE INTO user_platforms (h, platform, version, first, last) SELECT h, platform, \'\', first, last FROM users').run();
    await env.DB.prepare('INSERT OR IGNORE INTO daily_p (day, h, platform, visits) SELECT day, h, platform, 1 FROM daily').run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fails (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, until INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT \'\')').run();
    try { await env.DB.prepare('ALTER TABLE access ADD COLUMN pro_until INTEGER NOT NULL DEFAULT 0').run(); } catch(e) {}
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS paycfg (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '')`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL,
      uzs INTEGER NOT NULL DEFAULT 0, pay_amount INTEGER NOT NULL DEFAULT 0, token TEXT NOT NULL DEFAULT '', card TEXT NOT NULL DEFAULT '',
      rub REAL NOT NULL DEFAULT 0, expected_rub REAL NOT NULL DEFAULT 0, days INTEGER NOT NULL DEFAULT 0, discount INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL DEFAULT 0, paid_at INTEGER NOT NULL DEFAULT 0
    )`).run();
    schemaReady = true;
  }
  return env.DB;
}

// the password check: compares hashes (no early exit), and 5 wrong tries lock the address out for 15 minutes
async function adminGate(request, env, d) {
  if(!env.ADMIN_PASSWORD) return json({error: 'unauthorized'}, 401, {}, STRICT_CORS);
  const key = await sha256hex('abugram-ip:' + (request.headers.get('cf-connecting-ip') || 'x'));
  const now = Date.now();
  const row = d ? await d.prepare('SELECT n, until FROM fails WHERE k = ?').bind(key).first() : null;
  if(row && row.until > now) return json({error: 'Juda ko\'p xato urinish. 15 daqiqadan keyin qayta urining.'}, 429, {'retry-after': String(Math.ceil((row.until - now) / 1000))}, STRICT_CORS);
  const given = await sha256hex('pw:' + (request.headers.get('authorization') || '').replace(/^Bearer /, ''));
  const wanted = await sha256hex('pw:' + env.ADMIN_PASSWORD);
  let diff = 0;
  for(let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ wanted.charCodeAt(i);
  if(diff === 0) {
    if(row && row.n) await d.prepare('DELETE FROM fails WHERE k = ?').bind(key).run();
    return null;
  }
  if(d) {
    const n = (row ? row.n : 0) + 1;
    const lock = n >= 5 ? now + 15 * 60e3 : 0;
    await d.prepare('INSERT INTO fails (k, n, until) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET n = ?, until = ?').bind(key, lock ? 0 : n, lock, lock ? 0 : n, lock).run();
  }
  return json({error: 'unauthorized'}, 401, {}, STRICT_CORS);
}

function clean(value, max) {
  return String(value ?? '').slice(0, max);
}

const CONFIG_DEFAULT = {paid: false, minBuild: 0, updateTitle: 'Yangilash kerak', updateMessage: 'Xabarchi\'ning yangi versiyasi chiqdi. Saytdan yangilang.', payTitle: 'Obuna kerak', payMessage: 'Davom etish uchun Xabarchi obunasini yoqing.', url: 'https://abdulaziz0196.github.io/tashlanov.ru/abugram/', relays: '', off: ''};
// the relay servers as a list: https addresses only, at most 8
function relayList(text) {
  return String(text || '').split(/\s+/).map((x) => x.trim().replace(/\/+$/, '')).filter((x) => /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(x)).slice(0, 8);
}
// the switched-off features: names of letters and digits only
function offList(text) {
  return String(text || '').split(/[\s,]+/).filter((x) => /^[A-Za-z0-9_]{1,24}$/.test(x)).slice(0, 30);
}
// A minimum build above the newest published one would lock everybody out (nobody can have it), so it is ignored; the
// newest build is read from the app's latest GitHub release (kept 10 minutes). If that cannot be read, a number above 1000 is ignored.
let latestBuild = {v: 0, until: 0};
async function getLatestBuild() {
  if(Date.now() < latestBuild.until) return latestBuild.v;
  try {
    const r = await fetch('https://api.github.com/repos/Abdulaziz0196/abugram-android/releases/latest', {headers: {'user-agent': 'xabarchi-relay', 'accept': 'application/vnd.github+json'}});
    const j = await r.json();
    const n = parseInt(String(j.tag_name || '').split('-').pop(), 10);
    latestBuild = n > 0 ? {v: n, until: Date.now() + 600e3} : {v: latestBuild.v, until: Date.now() + 60e3};
  } catch(e) {
    latestBuild = {v: latestBuild.v, until: Date.now() + 60e3};
  }
  return latestBuild.v;
}
async function effectiveMinBuild(cfg) {
  const raw = Number(cfg.minBuild) || 0;
  if(raw <= 0) return 0;
  const latest = await getLatestBuild();
  if(latest > 0) return raw > latest ? 0 : raw; // above the newest build nobody can satisfy it: ignored
  return raw > 1000 ? 0 : raw;
}
let configCache = null;
async function getConfig(env) {
  if(configCache && Date.now() < configCache.until) return configCache.value;
  const d = await db(env);
  let value = {...CONFIG_DEFAULT};
  if(d) {
    const {results} = await d.prepare('SELECT k, v FROM config').all();
    for(const r of results) {
      if(!(r.k in CONFIG_DEFAULT)) continue;
      value[r.k] = typeof CONFIG_DEFAULT[r.k] === 'boolean' ? r.v === '1' : typeof CONFIG_DEFAULT[r.k] === 'number' ? Number(r.v) || 0 : r.v;
    }
  }
  configCache = {value, until: Date.now() + 60e3};
  return value;
}

// ---------------------------------------------------------------- payments
const PAY_KEYS = ['priceUzs', 'days', 'discountPct', 'discountHours', 'rubMargin', 'rubOverride', 'rubCard', 'rubNote', 'phUrl', 'phShopId', 'phKeyEnc', 'phOn', 'cbKey'];
const PAY_DEFAULT = {priceUzs: '30000', days: '30', discountPct: '75', discountHours: '24', rubMargin: '4', rubOverride: '0', rubCard: '', rubNote: '', phUrl: '', phShopId: '', phKeyEnc: '', phOn: '0', cbKey: ''};
const PAID_WORDS = ['paid', 'success', 'completed', 'confirmed'];

async function payCfg(d) {
  const {results} = await d.prepare('SELECT k, v FROM paycfg').all();
  const c = {...PAY_DEFAULT};
  for(const r of results) if(r.k in PAY_DEFAULT) c[r.k] = r.v;
  if(!c.cbKey) {
    c.cbKey = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
    await d.prepare('INSERT OR IGNORE INTO paycfg (k, v) VALUES (?, ?)').bind('cbKey', c.cbKey).run();
  }
  return c;
}

// the PayHamyon shop key is kept encrypted with a key derived from the admin password
async function cryptoKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abugram-pay-key:' + (env.ADMIN_PASSWORD || '')));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encryptText(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await cryptoKey(env), new TextEncoder().encode(text)));
  const all = new Uint8Array(iv.length + ct.length); all.set(iv); all.set(ct, iv.length);
  return btoa(String.fromCharCode(...all));
}
async function decryptText(env, b64) {
  try {
    const all = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: all.slice(0, 12)}, await cryptoKey(env), all.slice(12)));
  } catch(e) { return ''; }
}

// the shop address must be https (http only when the relay runs in test mode)
function phBase(env, cfg) {
  const u = String(cfg.phUrl || '').replace(/\/+$/, '');
  if(/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u)) return u;
  if(env.PAY_TEST && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(u)) return u;
  return '';
}
async function phCall(env, cfg, path, data) {
  const base = phBase(env, cfg);
  const key = await decryptText(env, cfg.phKeyEnc);
  if(!base || !cfg.phShopId || !key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({shop_id: cfg.phShopId, shop_key: key, ...data}), signal: ctrl.signal});
    return await r.json();
  } catch(e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// rubles for 10 000 so'm: the Central Bank of Russia's rate (kept an hour), or the admin's own number
let rubRate = {v: 0, until: 0};
async function rubPer10000(cfg) {
  const manual = Number(cfg.rubOverride) || 0;
  if(manual > 0) return manual;
  if(Date.now() < rubRate.until && rubRate.v > 0) return rubRate.v;
  try {
    const r = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', {headers: {'user-agent': 'xabarchi-relay'}});
    const j = await r.json();
    const u = j.Valute && j.Valute.UZS;
    if(u && u.Value > 0) rubRate = {v: u.Value / u.Nominal * 10000, until: Date.now() + 3600e3};
    else rubRate.until = Date.now() + 120e3;
  } catch(e) {
    rubRate.until = Date.now() + 120e3;
  }
  return rubRate.v;
}

// what this account pays now: the price, with the first-payment discount while its window is open
async function payQuote(env, d, uid) {
  const cfg = await payCfg(d);
  const now = Date.now();
  const price = Math.max(0, Math.floor(Number(cfg.priceUzs) || 0));
  const days = Math.max(1, Math.floor(Number(cfg.days) || 30));
  const h = await sha256hex('abugram-user:' + uid);
  const u = await d.prepare('SELECT MIN(first) AS first FROM user_platforms WHERE h = ?').bind(h).first();
  const first = u && u.first ? u.first : now;
  const hadPaid = await d.prepare("SELECT COUNT(*) AS n FROM payments WHERE uid = ? AND status = 'paid'").bind(uid).first();
  const pct = Math.min(95, Math.max(0, Number(cfg.discountPct) || 0));
  const endsAt = first + (Number(cfg.discountHours) || 0) * 3600e3;
  const discounted = pct > 0 && now < endsAt && !(hadPaid && hadPaid.n > 0);
  const finalUzs = discounted ? Math.max(1000, Math.round(price * (100 - pct) / 100 / 100) * 100) : price;
  const per10k = await rubPer10000(cfg);
  const margin = Number(cfg.rubMargin) || 0;
  const rubFor = (uzs) => per10k > 0 ? Math.ceil(uzs / 10000 * per10k * (1 + margin / 100)) : 0;
  const acc = await d.prepare('SELECT pro_until FROM access WHERE uid = ?').bind(uid).first();
  return {
    priceUzs: price, finalUzs, rubFinal: rubFor(finalUzs), rubFull: rubFor(price), days,
    discount: discounted ? {pct, endsAt} : null,
    proUntil: acc ? acc.pro_until || 0 : 0,
    methods: {payhamyon: cfg.phOn === '1' && !!phBase(env, cfg) && !!cfg.phShopId && !!cfg.phKeyEnc, rub: !!cfg.rubCard},
    rubCard: cfg.rubCard, rubNote: cfg.rubNote
  };
}

async function grantDays(d, uid, days) {
  const row = await d.prepare('SELECT pro_until FROM access WHERE uid = ?').bind(uid).first();
  const base = Math.max(Date.now(), row ? row.pro_until || 0 : 0);
  const until = base + days * 864e5;
  await d.prepare("INSERT INTO access (uid, name, ghost, admin, pro_until) VALUES (?, '', 0, 0, ?) ON CONFLICT(uid) DO UPDATE SET pro_until = excluded.pro_until").bind(uid, until).run();
  return until;
}

// asks PayHamyon again whether this payment was made (the callback is only a hint) and, once, credits the days
async function settlePayment(env, d, pay) {
  if(pay.status !== 'pending' || pay.method !== 'payhamyon') return pay.status;
  if(Date.now() > pay.expires + 120e3) {
    await d.prepare("UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(pay.id).run();
    return 'expired';
  }
  const cfg = await payCfg(d);
  const c = await phCall(env, cfg, '/api/payment/check', {token: pay.token});
  if(!c) return 'pending';
  const st = String(c.status || '').toLowerCase();
  const amount = Number(c.pay_amount ?? c.amount ?? 0);
  if(PAID_WORDS.includes(st) && amount === pay.pay_amount) {
    const r = await d.prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), pay.id).run();
    if(r.meta && r.meta.changes === 1) await grantDays(d, pay.uid, pay.days);
    return 'paid';
  }
  if(['canceled', 'expired', 'timeout', 'failed', 'rejected'].includes(st)) {
    await d.prepare("UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(pay.id).run();
    return 'expired';
  }
  return 'pending';
}

async function handlePay(request, env, url, path, d, J) {
  const uidOf = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : 0; };

  if(path === '/pay/quote' && request.method === 'GET') {
    const uid = uidOf(url.searchParams.get('uid'));
    if(!uid) return J({error: 'uid'}, 400);
    return J(await payQuote(env, d, uid), 200, {'cache-control': 'no-store'});
  }

  if(path === '/pay/create' && request.method === 'POST') {
    if(limited(request, 'paycreate', 12, 3600e3)) return J({error: 'Juda ko\'p urinish. Keyinroq qayta urining.'}, 429);
    let b = {}; try { b = await request.json(); } catch(e) {}
    const uid = uidOf(b.uid);
    if(!uid) return J({error: 'uid'}, 400);
    const q = await payQuote(env, d, uid);
    if(!q.methods.payhamyon) return J({error: 'Karta orqali to\'lov hozircha yoqilmagan'}, 400);
    // a payment still waiting for this account is shown again, not created twice
    const open = await d.prepare("SELECT * FROM payments WHERE uid = ? AND method = 'payhamyon' AND status = 'pending' AND expires > ? ORDER BY id DESC LIMIT 1").bind(uid, Date.now()).first();
    if(open) return J({id: open.id, card: open.card, payAmount: open.pay_amount, expires: open.expires, uzs: open.uzs, days: open.days});
    const cfg = await payCfg(d);
    const cb = new URL(request.url).origin + '/pay/callback?k=' + cfg.cbKey;
    const r = await phCall(env, cfg, '/api/payment/create', {amount: q.finalUzs, callback_url: cb});
    if(!r || !r.success || !r.token) return J({error: (r && r.error) || 'To\'lov tizimi javob bermadi. Keyinroq urining.'}, 502);
    const expires = Date.now() + (Number(r.timeout_minutes) || 15) * 60e3;
    const ins = await d.prepare("INSERT INTO payments (uid, method, status, uzs, pay_amount, token, card, days, discount, created, expires) VALUES (?, 'payhamyon', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(uid, q.finalUzs, Math.round(Number(r.pay_amount)), String(r.token), String(r.card || ''), q.days, q.discount ? q.discount.pct : 0, Date.now(), expires).run();
    return J({id: ins.meta.last_row_id, card: String(r.card || ''), payAmount: Math.round(Number(r.pay_amount)), expires, uzs: q.finalUzs, days: q.days});
  }

  if(path === '/pay/status' && request.method === 'GET') {
    const id = Number(url.searchParams.get('id')), uid = uidOf(url.searchParams.get('uid'));
    const pay = id && uid ? await d.prepare('SELECT * FROM payments WHERE id = ? AND uid = ?').bind(id, uid).first() : null;
    if(!pay) return J({error: 'not found'}, 404);
    const status = pay.method === 'payhamyon' ? await settlePayment(env, d, pay) : pay.status;
    const acc = await d.prepare('SELECT pro_until FROM access WHERE uid = ?').bind(uid).first();
    return J({status, proUntil: acc ? acc.pro_until || 0 : 0}, 200, {'cache-control': 'no-store'});
  }

  if(path === '/pay/callback' && request.method === 'POST') {
    const cfg = await payCfg(d);
    if(url.searchParams.get('k') !== cfg.cbKey) return J({error: 'forbidden'}, 403);
    let b = {}; try { b = await request.json(); } catch(e) {}
    const pay = b.token ? await d.prepare('SELECT * FROM payments WHERE token = ?').bind(String(b.token)).first() : null;
    if(pay) await settlePayment(env, d, pay); // never trusted as it is: asked again from PayHamyon
    return J({ok: true});
  }

  if(path === '/pay/rub' && request.method === 'POST') {
    if(limited(request, 'payrub', 8, 3600e3)) return J({error: 'Juda ko\'p urinish.'}, 429);
    let b = {}; try { b = await request.json(); } catch(e) {}
    const uid = uidOf(b.uid), rub = Number(b.rub);
    if(!uid || !(rub > 0 && rub < 10000000)) return J({error: 'Summani to\'g\'ri yozing'}, 400);
    const q = await payQuote(env, d, uid);
    if(!q.methods.rub) return J({error: 'Rubl bilan to\'lov hozircha yoqilmagan'}, 400);
    const note = ['Bank: ' + clean(b.bank, 40), 'Vaqt: ' + clean(b.at, 40), 'Aloqa: ' + clean(b.contact, 80)].join(' · ');
    const ins = await d.prepare("INSERT INTO payments (uid, method, status, uzs, rub, expected_rub, days, discount, note, created) VALUES (?, 'rub', 'review', ?, ?, ?, ?, ?, ?, ?)")
      .bind(uid, q.finalUzs, rub, q.rubFinal, q.days, q.discount ? q.discount.pct : 0, note, Date.now()).run();
    return J({id: ins.meta.last_row_id, status: 'review'});
  }

  return null;
}

async function handlePayAdmin(request, env, url, path, d, J) {
  const denied = await adminGate(request, env, d);
  if(denied) return denied;

  if(path === '/admin/pay' && request.method === 'GET') {
    const cfg = await payCfg(d);
    const {results} = await d.prepare('SELECT * FROM payments ORDER BY id DESC LIMIT 100').all();
    const safe = {...cfg}; delete safe.phKeyEnc; delete safe.cbKey;
    safe.phKeySaved = !!cfg.phKeyEnc;
    return J({config: safe, payments: results, rate: await rubPer10000(cfg)}, 200, {'cache-control': 'no-store'});
  }

  if(path === '/admin/pay' && request.method === 'POST') {
    const b = await request.json();
    const stmts = [];
    const put = (k, v) => stmts.push(d.prepare('INSERT INTO paycfg (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)));
    for(const k of ['priceUzs', 'days', 'discountPct', 'discountHours', 'rubMargin', 'rubOverride']) {
      if(k in b) put(k, Math.max(0, Number(b[k]) || 0));
    }
    if('rubCard' in b) put('rubCard', clean(b.rubCard, 60));
    if('rubNote' in b) put('rubNote', clean(b.rubNote, 300));
    if('phOn' in b) put('phOn', b.phOn ? '1' : '0');
    if('phShopId' in b) put('phShopId', clean(b.phShopId, 80));
    if('phUrl' in b) {
      const u = String(b.phUrl || '').trim().replace(/\/+$/, '');
      if(u && !phBase(env, {phUrl: u})) return J({error: 'Manzil https:// bilan boshlanishi kerak'}, 400);
      put('phUrl', u);
    }
    // a key that is sent is saved (encrypted); an empty one keeps the saved key
    if(typeof b.phKey === 'string' && b.phKey.trim()) put('phKeyEnc', await encryptText(env, b.phKey.trim()));
    if(stmts.length) await d.batch(stmts);
    return J({ok: true});
  }

  if(path === '/admin/pay/test' && request.method === 'POST') {
    const cfg = await payCfg(d);
    const r = await phCall(env, cfg, '/api/shop/info', {});
    if(!r) return J({ok: false, error: 'Javob yo\'q: manzil, Shop ID yoki KEY ni tekshiring'});
    return J({ok: !!r.success, name: r.name, min: r.min_amount, max: r.max_amount, error: r.error});
  }

  if(path === '/admin/pay/approve' && request.method === 'POST') {
    const b = await request.json();
    const pay = await d.prepare("SELECT * FROM payments WHERE id = ? AND status = 'review'").bind(Number(b.id)).first();
    if(!pay) return J({error: 'To\'lov topilmadi yoki allaqachon ko\'rib chiqilgan'}, 404);
    const days = Math.max(1, Math.min(3650, Math.floor(Number(b.days) || pay.days)));
    const r = await d.prepare("UPDATE payments SET status = 'paid', paid_at = ?, days = ? WHERE id = ? AND status = 'review'").bind(Date.now(), days, pay.id).run();
    if(r.meta && r.meta.changes === 1) await grantDays(d, pay.uid, days);
    return J({ok: true});
  }

  if(path === '/admin/pay/reject' && request.method === 'POST') {
    const b = await request.json();
    await d.prepare("UPDATE payments SET status = 'rejected' WHERE id = ? AND status = 'review'").bind(Number(b.id)).run();
    return J({ok: true});
  }
  return null;
}

async function handleAds(request, env, url) {
  const path = url.pathname;
  const strict = path.startsWith('/admin/') || path === '/access';
  const J = (data, status = 200, extra = {}) => json(data, status, extra, strict ? STRICT_CORS : CORS);
  if(request.method === 'OPTIONS') return new Response(null, {status: 204, headers: strict ? STRICT_CORS : CORS});

  if(path === '/ads' && request.method === 'GET') {
    const d = await db(env);
    if(!d) return J({ads: []});
    const now = Date.now();
    const {results} = await d.prepare('SELECT id, title, text, image, url FROM ads WHERE active = 1 AND (ends IS NULL OR ends > ?) AND (views_limit IS NULL OR views < views_limit) ORDER BY id DESC LIMIT 5').bind(now).all();
    return J({ads: results}, 200, {'cache-control': 'public, max-age=60'});
  }

  if(path === '/ads/seen' && request.method === 'POST') {
    if(limited(request, 'seen', 150, 3600e3)) return J({ok: true});
    const d = await db(env);
    if(!d) return J({ok: true});
    let b = {};
    try { b = await request.json(); } catch(e) {}
    const ids = (b.ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5);
    const uid = Number(b.uid);
    const stmts = [];
    let h = null;
    if(Number.isSafeInteger(uid) && uid > 0) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abugram-user:' + uid));
      h = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    for(const id of ids) {
      // every view counts; one account counts once in the unique views
      stmts.push(d.prepare('UPDATE ads SET views = views + 1 WHERE id = ?').bind(id));
      if(h) stmts.push(d.prepare('INSERT OR IGNORE INTO ad_views (ad_id, h) VALUES (?, ?)').bind(id, h));
    }
    if(stmts.length) await d.batch(stmts);
    return J({ok: true});
  }

  const go = path.match(/^\/go\/(\d+)$/);
  if(go) {
    const d = await db(env);
    const row = d && await d.prepare('SELECT url FROM ads WHERE id = ?').bind(Number(go[1])).first();
    if(!row || !/^https:\/\//i.test(row.url)) return new Response('Not found', {status: 404, headers: CORS});
    await d.prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ?').bind(Number(go[1])).run();
    return Response.redirect(row.url, 302);
  }

  if(path === '/access' && request.method === 'GET') {
    const d = await db(env);
    const uid = Number(url.searchParams.get('uid'));
    const row = d && Number.isSafeInteger(uid) && uid > 0 ? await d.prepare('SELECT ghost, admin, pro_until FROM access WHERE uid = ?').bind(uid).first() : null;
    return J({ghost: !!(row && row.ghost), admin: !!(row && row.admin), pro: !!(row && (row.admin || row.pro_until > Date.now())), proUntil: row ? row.pro_until || 0 : 0}, 200, {'cache-control': 'no-store'});
  }

  if(path === '/hello' && request.method === 'POST') {
    if(limited(request, 'hello', 40, 3600e3)) return J({ok: true});
    const d = await db(env);
    if(!d) return J({ok: true});
    if(Number(request.headers.get('content-length') || 0) > 1024) return J({ok: false}, 413);
    let b = {};
    try { b = await request.json(); } catch(e) {}
    const uid = Number(b.uid);
    if(!Number.isSafeInteger(uid) || uid <= 0) return J({ok: false}, 400);
    const platform = b.platform === 'android' ? 'android' : 'web';
    const version = clean(b.version, 24).replace(/[^\w .()+-]/g, '');
    const h = await sha256hex('abugram-user:' + uid);
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    await d.batch([
      d.prepare('INSERT INTO users (h, platform, first, last) VALUES (?, ?, ?, ?) ON CONFLICT(h) DO UPDATE SET last = excluded.last').bind(h, platform, now, now),
      d.prepare('INSERT INTO user_platforms (h, platform, version, first, last) VALUES (?, ?, ?, ?, ?) ON CONFLICT(h, platform) DO UPDATE SET last = excluded.last, version = CASE WHEN excluded.version = \'\' THEN user_platforms.version ELSE excluded.version END').bind(h, platform, version, now, now),
      // every app start counts as a visit of the day; one account counts once a day in the people
      d.prepare('INSERT INTO daily_p (day, h, platform, visits) VALUES (?, ?, ?, 1) ON CONFLICT(day, h, platform) DO UPDATE SET visits = visits + 1').bind(day, h, platform)
    ]);
    return J({ok: true});
  }

  if(path === '/stats' || path === '/admin/stats') {
    const d = await db(env);
    const empty = {total: 0, today: 0, d7: 0, d30: 0, platforms: {}, both: 0, byPlatform: {}, visitsToday: {}, days: []};
    const admin = path === '/admin/stats';
    if(admin && d) {
      const denied = await adminGate(request, env, d);
      if(denied) return denied;
    }
    if(!d) return J(empty);
    const now = Date.now();
    const count = async(sql, ...args) => (await d.prepare(sql).bind(...args).first()).n;
    const since = (days) => new Date(now - days * 864e5).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    const [total, todayN, d7, d30, both] = await Promise.all([
      count('SELECT COUNT(DISTINCT h) AS n FROM user_platforms'),
      count('SELECT COUNT(DISTINCT h) AS n FROM daily_p WHERE day = ?', today),
      count('SELECT COUNT(DISTINCT h) AS n FROM daily_p WHERE day > ?', since(7)),
      count('SELECT COUNT(DISTINCT h) AS n FROM daily_p WHERE day > ?', since(30)),
      count('SELECT COUNT(*) AS n FROM (SELECT h FROM user_platforms GROUP BY h HAVING COUNT(*) > 1)')
    ]);
    const {results: platformRows} = await d.prepare('SELECT platform, COUNT(*) AS n FROM user_platforms GROUP BY platform').all();
    const {results: days} = await d.prepare("SELECT day, COUNT(DISTINCT h) AS n, COUNT(DISTINCT CASE WHEN platform = 'web' THEN h END) AS web, COUNT(DISTINCT CASE WHEN platform = 'android' THEN h END) AS android FROM daily_p WHERE day > ? GROUP BY day ORDER BY day").bind(since(30)).all();
    const platforms = {};
    for(const row of platformRows) platforms[row.platform] = row.n;
    // for each platform: people active today / in 7 / in 30 days, and the visits (app starts) today
    const byPlatform = {};
    const visitsToday = {};
    for(const platform of ['web', 'android']) {
      byPlatform[platform] = {
        total: platforms[platform] || 0,
        today: await count('SELECT COUNT(*) AS n FROM daily_p WHERE day = ? AND platform = ?', today, platform),
        d7: await count('SELECT COUNT(DISTINCT h) AS n FROM daily_p WHERE day > ? AND platform = ?', since(7), platform),
        d30: await count('SELECT COUNT(DISTINCT h) AS n FROM daily_p WHERE day > ? AND platform = ?', since(30), platform)
      };
      visitsToday[platform] = await count('SELECT COALESCE(SUM(visits), 0) AS n FROM daily_p WHERE day = ? AND platform = ?', today, platform);
    }
    const out = {total, today: todayN, d7, d30, platforms, both, byPlatform, visitsToday, days, updated: now};
    if(admin) {
      // which app versions the people use (the version each one last reported)
      const {results: vr} = await d.prepare("SELECT platform, version, COUNT(*) AS n FROM user_platforms GROUP BY platform, version ORDER BY n DESC").all();
      out.versions = vr.map((r) => ({platform: r.platform, version: r.version || '?', n: r.n}));
    }
    return J(out, 200, admin ? {'cache-control': 'no-store'} : {'cache-control': 'public, max-age=120'});
  }

  if(path.startsWith('/pay/')) {
    const d = await db(env);
    if(!d) return J({error: 'no database bound as DB'}, 500);
    const r = await handlePay(request, env, url, path, d, J);
    if(r) return r;
  }
  if(path.startsWith('/admin/pay')) {
    const d = await db(env);
    if(!d) return J({error: 'no database bound as DB'}, 500);
    const r = await handlePayAdmin(request, env, url, path, d, J);
    if(r) return r;
  }

  if(path === '/config' && request.method === 'GET') {
    const cfg = await getConfig(env);
    return J({...cfg, minBuild: await effectiveMinBuild(cfg), relays: relayList(cfg.relays), off: offList(cfg.off)}, 200, {'cache-control': 'public, max-age=60'});
  }

  if(path === '/admin/config') {
    const d = await db(env);
    if(!d) return J({error: 'no database bound as DB'}, 500);
    const denied = await adminGate(request, env, d);
    if(denied) return denied;
    if(request.method === 'GET') return J(await getConfig(env), 200, {'cache-control': 'no-store'});
    if(request.method === 'POST') {
      const b = await request.json();
      const stmts = [];
      for(const k of Object.keys(CONFIG_DEFAULT)) {
        if(!(k in b)) continue;
        const v = k === 'relays' ? relayList(b[k]).join('\n') : k === 'off' ? offList(b[k]).join(',') : typeof CONFIG_DEFAULT[k] === 'boolean' ? (b[k] ? '1' : '0') : typeof CONFIG_DEFAULT[k] === 'number' ? String(Math.max(0, Math.floor(Number(b[k]) || 0))) : clean(b[k], 400);
        if(k === 'url' && v && !/^https:\/\//i.test(v)) return J({error: 'Havola https:// bilan boshlanishi kerak'}, 400);
        stmts.push(d.prepare('INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v));
      }
      if(stmts.length) await d.batch(stmts);
      configCache = null;
      return J({ok: true});
    }
  }

  if(path === '/admin/access') {
    const d = await db(env);
    if(!d) return J({error: 'no database bound as DB'}, 500, {}, STRICT_CORS);
    const denied = await adminGate(request, env, d);
    if(denied) return denied;
    if(request.method === 'GET') {
      const {results} = await d.prepare('SELECT * FROM access ORDER BY name').all();
      return J({users: results});
    }
    if(request.method === 'POST') {
      const b = await request.json();
      const uid = Number(b.uid);
      if(!Number.isSafeInteger(uid) || uid <= 0) return J({error: 'Telegram ID raqam bo\'lishi kerak'}, 400);
      // proDays: pays for that many days from now (0 clears it); left out keeps the current period
      const old = await d.prepare('SELECT pro_until FROM access WHERE uid = ?').bind(uid).first();
      let proUntil = old ? old.pro_until || 0 : 0;
      if('proDays' in b) {
        const days = Math.max(0, Math.min(3650, Math.floor(Number(b.proDays) || 0)));
        proUntil = days ? Date.now() + days * 864e5 : 0;
      }
      await d.prepare('INSERT INTO access (uid, name, ghost, admin, pro_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET name = excluded.name, ghost = excluded.ghost, admin = excluded.admin, pro_until = excluded.pro_until')
        .bind(uid, clean(b.name, 80), b.ghost ? 1 : 0, b.admin ? 1 : 0, proUntil).run();
      return J({ok: true});
    }
    if(request.method === 'DELETE') {
      await d.prepare('DELETE FROM access WHERE uid = ?').bind(Number(url.searchParams.get('uid'))).run();
      return J({ok: true});
    }
  }

  if(path === '/admin/ads') {
    const d = await db(env);
    if(!d) return J({error: 'no database bound as DB'}, 500, {}, STRICT_CORS);
    const denied = await adminGate(request, env, d);
    if(denied) return denied;
    if(request.method === 'GET') {
      const {results} = await d.prepare('SELECT ads.*, (SELECT COUNT(*) FROM ad_views v WHERE v.ad_id = ads.id) AS unique_views FROM ads ORDER BY id DESC').all();
      return J({ads: results});
    }
    if(request.method === 'POST') {
      const b = await request.json();
      const fields = [clean(b.title, 120), clean(b.text, 600), clean(b.image, 500), clean(b.url, 500), b.active ? 1 : 0];
      if(!fields[0].trim()) return J({error: 'Sarlavha kerak'}, 400);
      if(fields[3] && !/^https:\/\//i.test(fields[3])) return J({error: 'Havola https:// bilan boshlanishi kerak'}, 400);
      if(fields[2] && !/^https:\/\//i.test(fields[2])) return J({error: 'Rasm havolasi https:// bilan boshlanishi kerak'}, 400);
      // the campaign: by hours or days from now, or until a number of views
      const amount = Math.floor(Number(b.amount) || 0);
      const kind = ['hours', 'days', 'views'].includes(b.kind) ? b.kind : 'days';
      const now = Date.now();
      let ends = null, limit = null;
      if(kind === 'hours' && amount > 0) ends = (b.id ? Number(b.starts || now) : now) + amount * 3600e3;
      if(kind === 'days' && amount > 0) ends = (b.id ? Number(b.starts || now) : now) + amount * 864e5;
      if(kind === 'views' && amount > 0) limit = amount;
      if(b.id) {
        await d.prepare('UPDATE ads SET title = ?, text = ?, image = ?, url = ?, active = ?, kind = ?, ends = ?, views_limit = ? WHERE id = ?').bind(...fields, kind, ends, limit, Number(b.id)).run();
        return J({ok: true, id: Number(b.id)});
      }
      const r = await d.prepare('INSERT INTO ads (title, text, image, url, active, created, kind, ends, views_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(...fields, now, kind, ends, limit).run();
      return J({ok: true, id: r.meta.last_row_id});
    }
    if(request.method === 'DELETE') {
      await d.prepare('DELETE FROM ads WHERE id = ?').bind(Number(url.searchParams.get('id'))).run();
      return J({ok: true});
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const http = url.pathname.match(HTTP_ROUTE);
    // an old app can be asked to update: the Android app names its build in a header (a browser sends an Origin and is not asked)
    if((http || url.pathname.match(WS_ROUTE)) && !request.headers.get('origin') && env.DB) {
      const cfg = await getConfig(env);
      const build = Number(request.headers.get('x-abugram-build') || 0);
      const minBuild = await effectiveMinBuild(cfg);
      if(minBuild > 0 && build < minBuild) {
        return new Response(JSON.stringify({error: 'update', minBuild}), {status: 426, headers: {'content-type': 'application/json', ...SAFE}});
      }
    }
    if(http) {
      const target = 'https://' + http[1].toLowerCase() + '.web.telegram.org/' + http[2] + url.search;
      const response = await fetch(new Request(target, request));
      const headers = new Headers(response.headers);
      headers.set('access-control-allow-origin', '*');
      return new Response(response.body, {status: response.status, headers});
    }
    const ws = url.pathname.match(WS_ROUTE);
    if(ws) {
      if((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket', {status: 426});
      }
      const target = 'https://' + ws[1].toLowerCase() + '.web.telegram.org/' + ws[2] + url.search;
      return fetch(new Request(target, request));
    }
    if(url.pathname === '/ads' || url.pathname.startsWith('/ads/') || url.pathname.startsWith('/go/') || url.pathname.startsWith('/admin/') || url.pathname === '/access' || url.pathname === '/hello' || url.pathname === '/stats' || url.pathname === '/config' || url.pathname.startsWith('/pay/')) {
      try {
        const response = await handleAds(request, env, url);
        if(response) return response;
      } catch(e) {
        console.log('relay error', e && e.message || e);
        return json({error: 'server xatosi'}, 500);
      }
    }
    return new Response('Abugram relay is running (v13).', {headers: {'content-type': 'text/plain; charset=utf-8'}});
  }
};
