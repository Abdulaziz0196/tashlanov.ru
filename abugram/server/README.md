# Xabarchi relay server

Rossiyadagi (yoki istalgan) VPS'da ishlaydigan relay. Ilova Telegram'ga shu server orqali ulanadi. Cloudflare'dan farqi:
server ichki tarmoqda bo'lsa, operatorlar uni to'xtatmaydi; Telegram'ga doimiy ulanishlar ochiq turadi.

**O'rnatish** (Ubuntu/Debian, root):

    curl -fsSL https://abdulaziz0196.github.io/tashlanov.ru/abugram/server/install.sh | sudo bash

Skript oxirida `https://…sslip.io` manzilini chiqaradi. Uni admin panelning "Relay serverlari" bo'limiga qo'shing.

- Tekshiruv: `https://MANZIL/health`
- Loglar: `journalctl -u xabarchi-relay -f`
- Yangilash: o'rnatish buyrug'ini qayta bajaring.
- O'chirish: `curl -fsSL .../install.sh | sudo bash -s uninstall`
- Shifrlangan paketlar server orqali o'tadi, u xabarlarni o'qiy olmaydi. Hech narsa saqlanmaydi.
