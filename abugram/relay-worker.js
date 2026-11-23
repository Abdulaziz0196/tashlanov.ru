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
    const row = d && Number.isSafeInteger(uid) && uid > 0 ? await d.prepare('SELECT ghost, admin FROM access WHERE uid = ?').bind(uid).first() : null;
    return J({ghost: !!(row && row.ghost), admin: !!(row && row.admin)}, 200, {'cache-control': 'no-store'});
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
      await d.prepare('INSERT INTO access (uid, name, ghost, admin) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET name = excluded.name, ghost = excluded.ghost, admin = excluded.admin')
        .bind(uid, clean(b.name, 80), b.ghost ? 1 : 0, b.admin ? 1 : 0).run();
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
    if(url.pathname === '/ads' || url.pathname.startsWith('/ads/') || url.pathname.startsWith('/go/') || url.pathname.startsWith('/admin/') || url.pathname === '/access' || url.pathname === '/hello' || url.pathname === '/stats') {
      try {
        const response = await handleAds(request, env, url);
        if(response) return response;
      } catch(e) {
        console.log('relay error', e && e.message || e);
        return json({error: 'server xatosi'}, 500);
      }
    }
    return new Response('Abugram relay is running (v8).', {headers: {'content-type': 'text/plain; charset=utf-8'}});
  }
};
