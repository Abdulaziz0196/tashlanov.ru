// Abugram relay: lets Abugram reach Telegram where *.web.telegram.org is blocked, and serves Abugram's own ads.
//
// Telegram (only Telegram's own web endpoints are forwarded):
//   https://<relay>/<host>/apiw1 -> https://<host>.web.telegram.org/apiw1 (plain HTTPS requests)
//   wss://<relay>/<host>/apiws   -> wss://<host>.web.telegram.org/apiws  (WebSocket)
// The MTProto traffic inside stays encrypted end to end between the app and Telegram; the relay cannot read it.
//
// Ads (need a D1 database bound as DB; without it there are simply no ads):
//   GET  /ads              the active ads, for the apps
//   POST /ads/seen         body {"ids":[1,2]}: counts a view of each
//   GET  /go/<id>          counts a click and redirects to the ad's link
//   GET  /access?uid=<id>  what this Telegram account may use: {"ghost": bool, "admin": bool}
//   POST /hello            body {"uid": <id>, "platform": "web"|"android"}: counts the account as active today; only a
//                          SHA-256 of the ID is kept, never the ID
//   GET  /stats            user counts for advertisers: total, today, 7 and 30 days, by platform, the last 30 days
//   /admin/ads             list (GET), save (POST {id?, title, text, image, url, active}), delete (DELETE ?id=)
//   /admin/stats           the same as /stats (for the admin page)
//   /admin/access          the allowed accounts: list (GET), save (POST {uid, name, ghost, admin}), delete (DELETE ?uid=)
//                          both only with "Authorization: Bearer <ADMIN_PASSWORD>" (a secret set in Cloudflare)
const HTTP_ROUTE = /^\/((?:pluto|venus|aurora|vesta|flora)(?:-[a-z0-9]+)*)\/(apiw(?:_test)?1)$/i;
const WS_ROUTE = /^\/((?:k|a)?ws[1-5](?:-[a-z0-9]+)*)\/(apiws(?:_test)?(?:_premium)?)$/i;
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type'
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json; charset=utf-8', ...CORS, ...extra}});
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
    schemaReady = true;
  }
  return env.DB;
}

function isAdmin(request, env) {
  const auth = request.headers.get('authorization') || '';
  return !!env.ADMIN_PASSWORD && auth === 'Bearer ' + env.ADMIN_PASSWORD;
}

function clean(value, max) {
  return String(value ?? '').slice(0, max);
}

async function handleAds(request, env, url) {
  const path = url.pathname;
  if(request.method === 'OPTIONS') return new Response(null, {status: 204, headers: CORS});

  if(path === '/ads' && request.method === 'GET') {
    const d = await db(env);
    if(!d) return json({ads: []});
    const {results} = await d.prepare('SELECT id, title, text, image, url FROM ads WHERE active = 1 ORDER BY id DESC LIMIT 5').all();
    return json({ads: results}, 200, {'cache-control': 'public, max-age=60'});
  }

  if(path === '/ads/seen' && request.method === 'POST') {
    const d = await db(env);
    if(!d) return json({ok: true});
    let ids = [];
    try { ids = ((await request.json()).ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5); } catch(e) {}
    if(ids.length) await d.batch(ids.map((id) => d.prepare('UPDATE ads SET views = views + 1 WHERE id = ?').bind(id)));
    return json({ok: true});
  }

  const go = path.match(/^\/go\/(\d+)$/);
  if(go) {
    const d = await db(env);
    const row = d && await d.prepare('SELECT url FROM ads WHERE id = ?').bind(Number(go[1])).first();
    if(!row || !/^https?:\/\//i.test(row.url)) return new Response('Not found', {status: 404, headers: CORS});
    await d.prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ?').bind(Number(go[1])).run();
    return Response.redirect(row.url, 302);
  }

  if(path === '/access' && request.method === 'GET') {
    const d = await db(env);
    const uid = Number(url.searchParams.get('uid'));
    const row = d && Number.isSafeInteger(uid) && uid > 0 ? await d.prepare('SELECT ghost, admin FROM access WHERE uid = ?').bind(uid).first() : null;
    return json({ghost: !!(row && row.ghost), admin: !!(row && row.admin)}, 200, {'cache-control': 'no-store'});
  }

  if(path === '/hello' && request.method === 'POST') {
    const d = await db(env);
    if(!d) return json({ok: true});
    let b = {};
    try { b = await request.json(); } catch(e) {}
    const uid = Number(b.uid);
    if(!Number.isSafeInteger(uid) || uid <= 0) return json({ok: false}, 400);
    const platform = b.platform === 'android' ? 'android' : 'web';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abugram-user:' + uid));
    const h = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    await d.batch([
      d.prepare('INSERT INTO users (h, platform, first, last) VALUES (?, ?, ?, ?) ON CONFLICT(h) DO UPDATE SET last = excluded.last, platform = excluded.platform').bind(h, platform, now, now),
      d.prepare('INSERT OR IGNORE INTO daily (day, h, platform) VALUES (?, ?, ?)').bind(day, h, platform)
    ]);
    return json({ok: true});
  }

  if(path === '/stats' || path === '/admin/stats') {
    const d = await db(env);
    if(!d) return json({total: 0, today: 0, d7: 0, d30: 0, platforms: {}, days: []});
    const now = Date.now();
    const count = async(sql, ...args) => (await d.prepare(sql).bind(...args).first()).n;
    const since = (days) => new Date(now - days * 864e5).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    const [total, todayN, d7, d30] = await Promise.all([
      count('SELECT COUNT(*) AS n FROM users'),
      count('SELECT COUNT(*) AS n FROM daily WHERE day = ?', today),
      count('SELECT COUNT(DISTINCT h) AS n FROM daily WHERE day > ?', since(7)),
      count('SELECT COUNT(DISTINCT h) AS n FROM daily WHERE day > ?', since(30))
    ]);
    const {results: platformRows} = await d.prepare('SELECT platform, COUNT(*) AS n FROM users GROUP BY platform').all();
    const {results: days} = await d.prepare('SELECT day, COUNT(*) AS n FROM daily WHERE day > ? GROUP BY day ORDER BY day').bind(since(30)).all();
    const platforms = {};
    for(const row of platformRows) platforms[row.platform] = row.n;
    return json({total, today: todayN, d7, d30, platforms, days, updated: now}, 200, {'cache-control': 'public, max-age=300'});
  }

  if(path === '/admin/access') {
    if(!isAdmin(request, env)) return json({error: 'unauthorized'}, 401);
    const d = await db(env);
    if(!d) return json({error: 'no database bound as DB'}, 500);
    if(request.method === 'GET') {
      const {results} = await d.prepare('SELECT * FROM access ORDER BY name').all();
      return json({users: results});
    }
    if(request.method === 'POST') {
      const b = await request.json();
      const uid = Number(b.uid);
      if(!Number.isSafeInteger(uid) || uid <= 0) return json({error: 'Telegram ID raqam bo\'lishi kerak'}, 400);
      await d.prepare('INSERT INTO access (uid, name, ghost, admin) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET name = excluded.name, ghost = excluded.ghost, admin = excluded.admin')
        .bind(uid, clean(b.name, 80), b.ghost ? 1 : 0, b.admin ? 1 : 0).run();
      return json({ok: true});
    }
    if(request.method === 'DELETE') {
      await d.prepare('DELETE FROM access WHERE uid = ?').bind(Number(url.searchParams.get('uid'))).run();
      return json({ok: true});
    }
  }

  if(path === '/admin/ads') {
    if(!isAdmin(request, env)) return json({error: 'unauthorized'}, 401);
    const d = await db(env);
    if(!d) return json({error: 'no database bound as DB'}, 500);
    if(request.method === 'GET') {
      const {results} = await d.prepare('SELECT * FROM ads ORDER BY id DESC').all();
      return json({ads: results});
    }
    if(request.method === 'POST') {
      const b = await request.json();
      const fields = [clean(b.title, 120), clean(b.text, 600), clean(b.image, 500), clean(b.url, 500), b.active ? 1 : 0];
      if(fields[3] && !/^https?:\/\//i.test(fields[3])) return json({error: 'url must start with https://'}, 400);
      if(b.id) {
        await d.prepare('UPDATE ads SET title = ?, text = ?, image = ?, url = ?, active = ? WHERE id = ?').bind(...fields, Number(b.id)).run();
        return json({ok: true, id: Number(b.id)});
      }
      const r = await d.prepare('INSERT INTO ads (title, text, image, url, active, created) VALUES (?, ?, ?, ?, ?, ?)').bind(...fields, Date.now()).run();
      return json({ok: true, id: r.meta.last_row_id});
    }
    if(request.method === 'DELETE') {
      await d.prepare('DELETE FROM ads WHERE id = ?').bind(Number(url.searchParams.get('id'))).run();
      return json({ok: true});
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
        return json({error: String(e && e.message || e)}, 500);
      }
    }
    return new Response('Abugram relay is running (v5).', {headers: {'content-type': 'text/plain; charset=utf-8'}});
  }
};
