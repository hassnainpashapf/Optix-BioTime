#!/bin/sh
# Installs Optix as a systemd service (Proxmox container, VM or any Linux x64). Run as root from the unpacked folder:
#   ./install.sh [--http 8080] [--https 8443]     (--https turns HTTPS on with an automatic certificate)
set -e
HTTP=8080; HTTPS=""
while [ $# -gt 0 ]; do case "$1" in --http) HTTP="$2"; shift 2;; --https) HTTPS="$2"; shift 2;; *) echo "unknown option $1"; exit 1;; esac; done
[ "$(id -u)" = 0 ] || { echo "Run as root"; exit 1; }
DIR=/opt/optix; DATA=/var/lib/optix
mkdir -p "$DIR" "$DATA"
systemctl stop optix 2>/dev/null || true
rm -rf "$DIR/app"; cp -R app "$DIR/app"; cp -f node "$DIR/node"; chmod +x "$DIR/node"
if [ ! -f "$DATA/server.json" ]; then
  if [ -n "$HTTPS" ]; then H='{"enabled":true,"port":'$HTTPS',"source":"auto","host":""}'; else H='{"enabled":false,"port":8443,"source":"auto","host":""}'; fi
  echo '{"http":{"enabled":true,"port":'$HTTP'},"https":'$H',"redirect":false}' > "$DATA/server.json"
fi
cat > /etc/systemd/system/optix.service <<EOF
[Unit]
Description=Optix attendance server
After=network.target

[Service]
WorkingDirectory=$DIR/app
Environment=OPTIX_DATA=$DATA
ExecStart=$DIR/node $DIR/app/launcher.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload; systemctl enable --now optix
sleep 2; systemctl is-active optix
echo "Optix is running. Open http://$(hostname -I 2>/dev/null | awk '{print $1}'):$HTTP  (first login admin / admin123 - change it)."
echo "Ports and HTTPS can be changed later in the web app: System > Configuration > Server Setting."
echo "Data (database, backups, certificates) is in $DATA"
