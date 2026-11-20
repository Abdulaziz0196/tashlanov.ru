// Abugram relay: lets Abugram Web reach Telegram where *.web.telegram.org is blocked.
// It only forwards to Telegram's own web endpoints:
//   https://<relay>/<host>/apiw1 -> https://<host>.web.telegram.org/apiw1 (plain HTTPS requests)
//   wss://<relay>/<host>/apiws   -> wss://<host>.web.telegram.org/apiws  (WebSocket)
// The MTProto traffic inside stays encrypted end to end between the app and Telegram; the relay cannot
// read it. Anything else gets a plain page.
const HTTP_ROUTE = /^\/((?:pluto|venus|aurora|vesta|flora)(?:-[a-z0-9]+)*)\/(apiw(?:_test)?1)$/i;
const WS_ROUTE = /^\/((?:k|a)?ws[1-5](?:-[a-z0-9]+)*)\/(apiws(?:_test)?(?:_premium)?)$/i;

export default {
  async fetch(request) {
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
    return new Response('Abugram relay is running (v2).', {headers: {'content-type': 'text/plain; charset=utf-8'}});
  }
};
