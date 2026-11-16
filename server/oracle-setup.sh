#!/bin/bash
# =============================================================================
#  getvid server on Oracle Cloud "Always Free" — one-shot setup
#  Ubuntu 24.04 (recommended) or 22.04 · Ampere A1 (ARM) or E2.1.Micro (AMD)
#
#  Use it as the instance's "Initialization script" (cloud-init) when you create
#  the VM, or run it later over SSH:
#      curl -fsSL https://monolito123.github.io/projetotele/server/oracle-setup.sh | sudo bash
#
#  It installs: getvid server (yt-dlp) as a service · Caddy (automatic HTTPS) ·
#  YouTube PO-token provider (fewer "confirm you're not a bot" blocks) ·
#  daily updates · firewall rules · swap on small VMs.
# =============================================================================

# ---- PREENCHA (opcional, recomendado) / FILL IN (optional, recommended) -----
#      Free stable HTTPS name from https://www.duckdns.org (log in with GitHub).
#      Leave empty to use <your-ip>.sslip.io instead.
MEU_DUCKDNS=""          # ex.: meugetvid        (sem .duckdns.org)
MEU_DUCKDNS_TOKEN=""    # ex.: a1b2c3d4-5678-...
# -----------------------------------------------------------------------------
DUCKDNS_DOMAIN="${DUCKDNS_DOMAIN:-$MEU_DUCKDNS}"
DUCKDNS_TOKEN="${DUCKDNS_TOKEN:-$MEU_DUCKDNS_TOKEN}"

# ---- Who may use the server from a browser (the getvid site).
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://monolito123.github.io}"
SERVER_SRC="${SERVER_SRC:-https://monolito123.github.io/projetotele/server/getvid_server.py}"
POT_IMAGE="brainicism/bgutil-ytdlp-pot-provider:2.0.2-node"
# =============================================================================

set -uo pipefail
exec > >(tee -a /var/log/getvid-setup.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
log() { echo -e "\n\033[1;35m[getvid]\033[0m $*"; }
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }

log "1/8 System packages"
apt-get update -y
apt-get install -y python3-venv python3-pip ffmpeg curl ca-certificates docker.io iptables
if ! apt-get install -y caddy; then
  # Older Ubuntu without a caddy package: use Caddy's official repository.
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

log "2/8 Swap (small VMs)"
if [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 2048 ] && ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "3/8 getvid server + yt-dlp"
id getvid >/dev/null 2>&1 || useradd --system --home /opt/getvid --shell /usr/sbin/nologin getvid
mkdir -p /opt/getvid
python3 -m venv /opt/getvid/venv
/opt/getvid/venv/bin/pip install -q -U pip
/opt/getvid/venv/bin/pip install -q -U "yt-dlp[default,curl-cffi]" bgutil-ytdlp-pot-provider \
  || /opt/getvid/venv/bin/pip install -q -U "yt-dlp[default]" bgutil-ytdlp-pot-provider
curl -fsSL "$SERVER_SRC" -o /opt/getvid/getvid_server.py
chown -R getvid:getvid /opt/getvid

log "4/8 YouTube PO-token provider (Docker)"
systemctl enable --now docker
docker rm -f bgutil-provider >/dev/null 2>&1 || true
docker run -d --name bgutil-provider --restart unless-stopped -p 127.0.0.1:4416:4416 "$POT_IMAGE" \
  || echo "PO-token provider could not start (YouTube may ask to confirm you're not a bot more often)."

log "5/8 Services"
cat > /etc/systemd/system/getvid.service <<EOF
[Unit]
Description=getvid server (yt-dlp backend)
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=getvid
WorkingDirectory=/opt/getvid
Environment=HOST=127.0.0.1
Environment=PORT=9100
Environment=TRUST_PROXY=1
Environment=ALLOWED_ORIGINS=$ALLOWED_ORIGINS
Environment=RATE_LIMIT=30/300
Environment=MAX_STREAMS=6
ExecStart=/opt/getvid/venv/bin/python /opt/getvid/getvid_server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# Daily: newest yt-dlp + PO-token plugin + server script, refresh DuckDNS IP, restart.
cat > /opt/getvid/update.sh <<EOF
#!/bin/bash
/opt/getvid/venv/bin/pip install -q -U "yt-dlp[default,curl-cffi]" bgutil-ytdlp-pot-provider || /opt/getvid/venv/bin/pip install -q -U yt-dlp bgutil-ytdlp-pot-provider
curl -fsSL "$SERVER_SRC" -o /opt/getvid/getvid_server.py.new && python3 -m py_compile /opt/getvid/getvid_server.py.new && mv /opt/getvid/getvid_server.py.new /opt/getvid/getvid_server.py
chown -R getvid:getvid /opt/getvid
docker pull -q "$POT_IMAGE" >/dev/null 2>&1 || true
[ -n "$DUCKDNS_DOMAIN" ] && curl -fsS "https://www.duckdns.org/update?domains=$DUCKDNS_DOMAIN&token=$DUCKDNS_TOKEN&ip=" >/dev/null
systemctl restart getvid
EOF
chmod 700 /opt/getvid/update.sh
cat > /etc/systemd/system/getvid-update.service <<'EOF'
[Unit]
Description=Update getvid server and yt-dlp
[Service]
Type=oneshot
ExecStart=/opt/getvid/update.sh
EOF
cat > /etc/systemd/system/getvid-update.timer <<'EOF'
[Unit]
Description=Daily getvid/yt-dlp update
[Timer]
OnCalendar=*-*-* 06:17:00
RandomizedDelaySec=30m
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now getvid getvid-update.timer

log "6/8 HTTPS name"
PUBLIC_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
if [ -n "$DUCKDNS_DOMAIN" ] && [ -n "$DUCKDNS_TOKEN" ]; then
  curl -fsS "https://www.duckdns.org/update?domains=$DUCKDNS_DOMAIN&token=$DUCKDNS_TOKEN&ip=$PUBLIC_IP" && echo
  HOSTNAME_PUBLIC="$DUCKDNS_DOMAIN.duckdns.org"
else
  HOSTNAME_PUBLIC="${PUBLIC_IP//./-}.sslip.io"
fi
echo "Public IP: $PUBLIC_IP  →  https://$HOSTNAME_PUBLIC/"

cat > /etc/caddy/Caddyfile <<EOF
$HOSTNAME_PUBLIC {
	request_body {
		max_size 64KB
	}
	reverse_proxy 127.0.0.1:9100 {
		flush_interval -1
	}
}
EOF
systemctl enable caddy
systemctl restart caddy

log "7/8 Firewall (ports 80 and 443)"
# Oracle's Ubuntu images block everything but SSH with iptables: open 80/443 before the REJECT rule.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    n="$(iptables -L INPUT --line-numbers | awk '/REJECT/{print $1; exit}')"
    if [ -n "$n" ]; then iptables -I INPUT "$n" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    else iptables -A INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT; fi
  fi
done
command -v netfilter-persistent >/dev/null && netfilter-persistent save || true

log "8/8 Check"
echo "https://$HOSTNAME_PUBLIC/" > /root/getvid-url.txt
cat > /etc/motd <<EOF

  getvid server:  https://$HOSTNAME_PUBLIC/
  logs: journalctl -u getvid -f   ·   setup log: /var/log/getvid-setup.log

EOF
ok=""
for _ in $(seq 1 24); do
  if curl -fsS -m 10 "https://$HOSTNAME_PUBLIC/" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
echo
echo "============================================================"
if [ -n "$ok" ]; then
  echo "  READY:  https://$HOSTNAME_PUBLIC/"
  echo "  Paste it in getvid → ⚙ Settings → cobalt servers (or send it to be built into the site)."
else
  echo "  Server installed:  https://$HOSTNAME_PUBLIC/"
  echo "  HTTPS isn't answering yet. Usually: open ports 80 and 443 in the VCN Security List"
  echo "  (Networking → Virtual cloud networks → your VCN → Security Lists → Add Ingress Rules)."
  echo "  Caddy keeps retrying the certificate by itself; check:  journalctl -u caddy -f"
fi
echo "============================================================"
