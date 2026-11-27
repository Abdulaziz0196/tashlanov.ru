// Xabarchi relay server: forwards the app's Telegram requests (plain HTTPS POSTs of already encrypted MTProto packets)
// to Telegram's own web endpoints. It is the same job as the Cloudflare relay, run on your own server.
// Nothing is stored or logged but counters; the packets are encrypted end to end between the app and Telegram, so the
// server cannot read messages. Zero dependencies: Node.js 18 or newer.
//
//   POST /<host>/apiw1   host: pluto | venus | aurora | vesta | flora (optionally with -1, -2 ... suffixes)
//   GET  /health         {"ok":true,"v":...,"uptime":...,"requests":...}
//
// Environment: PORT (default 8787), HOST (default 127.0.0.1: put a TLS front such as Caddy in front of it)
'use strict';
const http = require('http');
const https = require('https');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = 'xabarchi-relay-server-1';
const ROUTE = /^\/((?:pluto|venus|aurora|vesta|flora)(?:-[a-z0-9]+)*)\/(apiw(?:_test)?1)$/i;
const MAX_BODY = 20 * 1024 * 1024;
const UPSTREAM_TIMEOUT = 40000;

// Long-lived connections to Telegram: no new TLS handshake for every packet.
const agent = new https.Agent({keepAlive: true, maxSockets: 512, maxFreeSockets: 64, timeout: 60000});

const stats = {started: Date.now(), requests: 0, ok: 0, failed: 0, bytesIn: 0, bytesOut: 0};

// A small per-address limit so one client cannot starve the rest (requests per second).
const hits = new Map();
function limited(ip) {
  const now = Math.floor(Date.now() / 1000);
  const h = hits.get(ip);
  if (!h || h.t !== now) {
    if (hits.size > 20000) hits.clear();
    hits.set(ip, {t: now, n: 1});
    return false;
  }
  return ++h.n > 80;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({'content-type': 'application/json', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store'}, headers));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    return send(res, 200, {ok: true, v: VERSION, uptime: Math.round((Date.now() - stats.started) / 1000), requests: stats.requests, failed: stats.failed}, {'access-control-allow-origin': 'https://abdulaziz0196.github.io'});
  }
  const m = url.pathname.match(ROUTE);
  if (!m || req.method !== 'POST') return send(res, 404, {error: 'not found'});

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return send(res, 429, {error: 'slow down'}, {'retry-after': '1'});

  stats.requests++;
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      aborted = true;
      send(res, 413, {error: 'too large'});
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('error', () => { aborted = true; });
  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    stats.bytesIn += body.length;
    const up = https.request({
      host: m[1].toLowerCase() + '.web.telegram.org',
      path: '/' + m[2],
      method: 'POST',
      agent,
      headers: {'content-type': 'application/octet-stream', 'content-length': body.length},
      timeout: UPSTREAM_TIMEOUT
    }, (ur) => {
      const out = [];
      ur.on('data', (c) => out.push(c));
      ur.on('end', () => {
        const data = Buffer.concat(out);
        stats.bytesOut += data.length;
        if (ur.statusCode === 200) stats.ok++; else if (ur.statusCode !== 404) stats.failed++;
        // Telegram's status (200, or 404 for an unknown key) is passed on as it is.
        res.writeHead(ur.statusCode, {'content-type': 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-store'});
        res.end(data);
      });
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', () => {
      stats.failed++;
      if (!res.headersSent) send(res, 502, {error: 'upstream'});
    });
    up.end(body);
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.listen(PORT, HOST, () => console.log(VERSION + ' listening on ' + HOST + ':' + PORT));
process.on('uncaughtException', (e) => console.error('uncaught', e && e.message));
