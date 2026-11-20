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
//   /admin/ads             list (GET), save (POST {id?, title, text, image, url, active}), delete (DELETE ?id=)
//                          only with "Authorization: Bearer <ADMIN_PASSWORD>" (a secret set in Cloudflare)
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
    if(url.pathname === '/ads' || url.pathname.startsWith('/ads/') || url.pathname.startsWith('/go/') || url.pathname.startsWith('/admin/')) {
      try {
        const response = await handleAds(request, env, url);
        if(response) return response;
      } catch(e) {
        return json({error: String(e && e.message || e)}, 500);
      }
    }
    return new Response('Abugram relay is running (v3).', {headers: {'content-type': 'text/plain; charset=utf-8'}});
  }
};
