#!/bin/sh
# Self-signed certificate so phones can use the employee portal (GPS needs https).
# Usage: scripts/make-cert.sh [server-ip]      then start with:  TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start
# Phones show a warning the first time; choose "continue" / install the certificate. For a warning-free setup use a real certificate (see README).
set -e
IP=${1:-$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')}
[ -n "$IP" ] || { echo "Give the server's IP address: scripts/make-cert.sh 192.168.1.20"; exit 1; }
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 825 -subj "/CN=$IP" -addext "subjectAltName=IP:$IP,DNS:localhost"
echo "Created certs/cert.pem and certs/key.pem for $IP"
echo "Start the server with:  TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem npm start"
echo "Employees open:  https://$IP:8443/portal"
