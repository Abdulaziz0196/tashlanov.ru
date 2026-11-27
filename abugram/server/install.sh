#!/usr/bin/env bash
# Xabarchi relay server: one command on a fresh Ubuntu/Debian VPS (run as root).
#
#   curl -fsSL https://abdulaziz0196.github.io/tashlanov.ru/abugram/server/install.sh | sudo bash
#
# It installs Node.js, the relay (relay-server.js from this site) as a service, and Caddy for HTTPS with an automatic
# certificate. Without a domain it uses <ip-with-dashes>.sslip.io, which points to your server's address.
# Own domain: DOMAIN=relay.example.com ... | sudo -E bash   (its A record must point to this server first)
# Read the script before you run it: it is plain text. Remove everything with: bash install.sh uninstall
set -euo pipefail

SITE="https://abdulaziz0196.github.io/tashlanov.ru/abugram/server"
APP=/opt/xabarchi-relay
say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root bilan ishga tushiring (sudo bash)."

if [ "${1:-}" = "uninstall" ]; then
  systemctl disable --now xabarchi-relay caddy-xabarchi 2>/dev/null || true
  rm -f /etc/systemd/system/xabarchi-relay.service /etc/systemd/system/caddy-xabarchi.service
  rm -rf "$APP" /etc/caddy-xabarchi /usr/local/bin/caddy-xabarchi
  systemctl daemon-reload
  say "O'chirildi."
  exit 0
fi

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) NODE_ARCH=x64; CADDY_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; CADDY_ARCH=arm64 ;;
  *) die "Bu protsessor ($ARCH) qo'llab-quvvatlanmaydi." ;;
esac
command -v curl >/dev/null || { apt-get update -y >/dev/null && apt-get install -y curl >/dev/null; }

say "Server manzili aniqlanmoqda"
IP="${PUBLIC_IP:-$(curl -fsS -4 --max-time 10 https://api.ipify.org || curl -fsS -4 --max-time 10 https://ifconfig.me || true)}"
[ -n "$IP" ] || die "Tashqi IP topilmadi. PUBLIC_IP=1.2.3.4 deb qo'lda bering."
DOMAIN="${DOMAIN:-$(echo "$IP" | tr . -).sslip.io}"
echo "IP: $IP   Manzil: $DOMAIN"

say "Node.js"
need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 18 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  NODE_VER=v20.18.1
  tmp=$(mktemp -d)
  curl -fsSL --max-time 300 "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$NODE_ARCH.tar.xz" -o "$tmp/node.tar.xz" \
    || die "Node.js yuklab bo'lmadi (nodejs.org ochilmayapti?). 'apt install nodejs' bilan 18+ versiyani o'rnating va qayta ishga tushiring."
  tar -xJf "$tmp/node.tar.xz" -C /usr/local --strip-components=1
  rm -rf "$tmp"
fi
node -v

say "Relay dasturi"
mkdir -p "$APP"
curl -fsSL --max-time 60 "$SITE/relay-server.js" -o "$APP/relay-server.js" || die "relay-server.js yuklanmadi."
id xabarchi >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin xabarchi
cat > /etc/systemd/system/xabarchi-relay.service <<UNIT
[Unit]
Description=Xabarchi relay
After=network-online.target
Wants=network-online.target

[Service]
User=xabarchi
Environment=PORT=8787 HOST=127.0.0.1
ExecStart=$(command -v node) $APP/relay-server.js
Restart=always
RestartSec=2
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

say "Caddy (HTTPS)"
if [ ! -x /usr/local/bin/caddy-xabarchi ]; then
  curl -fsSL --max-time 300 "https://caddyserver.com/api/download?os=linux&arch=$CADDY_ARCH" -o /usr/local/bin/caddy-xabarchi \
    || die "Caddy yuklab bo'lmadi."
  chmod +x /usr/local/bin/caddy-xabarchi
fi
mkdir -p /etc/caddy-xabarchi
cat > /etc/caddy-xabarchi/Caddyfile <<CADDY
$DOMAIN {
	encode off
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
CADDY
cat > /etc/systemd/system/caddy-xabarchi.service <<UNIT
[Unit]
Description=Xabarchi HTTPS front (Caddy)
After=network-online.target
Wants=network-online.target

[Service]
Environment=XDG_DATA_HOME=/var/lib/caddy-xabarchi XDG_CONFIG_HOME=/etc/caddy-xabarchi
ExecStart=/usr/local/bin/caddy-xabarchi run --config /etc/caddy-xabarchi/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=2
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  say "Brandmauer: 80 va 443 ochilmoqda"
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

say "Ishga tushirilmoqda"
systemctl daemon-reload
systemctl enable --now xabarchi-relay caddy-xabarchi
sleep 3
systemctl is-active xabarchi-relay >/dev/null || die "Relay ishga tushmadi: journalctl -u xabarchi-relay"

say "Tekshiruv (sertifikat olinishi 1–2 daqiqa olishi mumkin)"
ok=0
for i in $(seq 1 24); do
  if curl -fsS --max-time 8 "https://$DOMAIN/health" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
  sleep 5
done
if [ "$ok" -eq 1 ]; then
  printf '\n\033[32m✔ Tayyor!\033[0m\n\nShu manzilni menga yuboring (admin panelga qo'"'"'shiladi):\n\n    https://%s\n\n' "$DOMAIN"
else
  printf '\n\033[33m! Relay ishlayapti, lekin HTTPS hali tayyor emas.\033[0m 1–2 daqiqadan keyin brauzerda oching: https://%s/health\nBo'"'"'lmasa: 80 va 443 portlar hosting panelida ochiqmi? Log: journalctl -u caddy-xabarchi\n' "$DOMAIN"
fi
