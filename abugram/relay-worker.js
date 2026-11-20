// Abugram relay: lets Abugram Web reach Telegram where *.web.telegram.org is blocked.
// It only forwards WebSocket connections to Telegram's own web endpoints: wss://<relay>/<host>/<path>
// goes to wss://<host>.web.telegram.org/<path>. The MTProto traffic inside stays encrypted end to end
// between the app and Telegram; the relay cannot read it. Anything else gets a plain page.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/((?:k|a)?ws[1-5](?:-[a-z0-9]+)*)\/(apiws(?:_test)?(?:_premium)?)$/i);
    if(!match) {
      return new Response('Abugram relay is running.', {headers: {'content-type': 'text/plain; charset=utf-8'}});
    }
    if((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket', {status: 426});
    }
    const target = 'https://' + match[1].toLowerCase() + '.web.telegram.org/' + match[2] + url.search;
    return fetch(new Request(target, request));
  }
};
