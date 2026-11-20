# Abugram Web — source

Abugram Web is a build of [Telegram Web K](https://github.com/morethanwords/tweb) (GPL-3.0),
upstream commit `2e4bbb52b6aec5e95ee32e5c2882c1f05de32200`, with the changes in
[`abugram-web.patch`](abugram-web.patch) (Abugram name and icons, own API id, optional WebSocket relay, Settings → Abugram: ghost mode, keeping deleted messages, hiding sponsored messages and the stories panel).

Rebuild: clone tweb at that commit, `git apply abugram-web.patch`, `pnpm install`,
`VITE_API_ID=… VITE_API_HASH=… pnpm exec vite build`, then copy `public/` and `dist/` here.
