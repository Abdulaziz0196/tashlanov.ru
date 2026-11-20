// Abugram relay for Deno Deploy: lets Abugram Web reach Telegram where *.web.telegram.org is blocked.
// It only forwards WebSocket connections to Telegram's own web endpoints: wss://<relay>/<host>/<path>
// goes to wss://<host>.web.telegram.org/<path>. The MTProto traffic inside stays encrypted end to end
// between the app and Telegram; the relay cannot read it. Anything else gets a plain page.
const ROUTE = /^\/((?:k|a)?ws[1-5](?:-[a-z0-9]+)*)\/(apiws(?:_test)?(?:_premium)?)$/i;

Deno.serve((request) => {
  const url = new URL(request.url);
  const match = url.pathname.match(ROUTE);
  if(!match) {
    return new Response('Abugram relay is running.', {headers: {'content-type': 'text/plain; charset=utf-8'}});
  }
  if((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket', {status: 426});
  }

  const {socket: client, response} = Deno.upgradeWebSocket(request, {protocol: 'binary'});
  const upstream = new WebSocket('wss://' + match[1].toLowerCase() + '.web.telegram.org/' + match[2] + url.search, 'binary');
  client.binaryType = 'arraybuffer';
  upstream.binaryType = 'arraybuffer';

  const pending: (ArrayBuffer | string)[] = [];
  const close = () => {
    try { client.close(); } catch {}
    try { upstream.close(); } catch {}
  };

  client.onmessage = (event) => {
    if(upstream.readyState === WebSocket.OPEN) upstream.send(event.data);
    else pending.push(event.data);
  };
  upstream.onopen = () => {
    for(const data of pending) upstream.send(data);
    pending.length = 0;
  };
  upstream.onmessage = (event) => {
    if(client.readyState === WebSocket.OPEN) client.send(event.data);
  };
  client.onclose = close;
  client.onerror = close;
  upstream.onclose = close;
  upstream.onerror = close;

  return response;
});
