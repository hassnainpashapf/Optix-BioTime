#!/bin/sh
# Builds the Windows installer (Optix-Setup-<version>.exe) on macOS/Linux. Needs: node, npm, curl, unzip, makensis (brew install makensis).
# The installer bundles node.exe, asks for the HTTP/HTTPS ports, opens the firewall for node.exe and runs the server as a scheduled task at boot.
set -e
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
NODEVER=${NODE_WIN_VERSION:-$(node -p "process.version")}
OUT=${OUT:-dist}; STAGE=build/win/stage
rm -rf build/win; mkdir -p "$STAGE/app" "$OUT"
# app files: server code + public + production dependencies only (no tests, no local data)
for f in *.js; do case "$f" in e2e*|test.js|seed-demo.js|sim-device.js) continue;; esac; cp "$f" "$STAGE/app/"; done
cp -R public "$STAGE/app/public"; cp package.json package-lock.json "$STAGE/app/"
( cd "$STAGE/app" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 )
# node.exe (cached)
CACHE=${CACHE:-$HOME/.cache/optix-build}; mkdir -p "$CACHE"; ZIP="$CACHE/node-$NODEVER-win-x64.zip"
[ -f "$ZIP" ] || curl -fL -o "$ZIP" "https://nodejs.org/dist/$NODEVER/node-$NODEVER-win-x64.zip"
unzip -o -j "$ZIP" "node-$NODEVER-win-x64/node.exe" -d "$STAGE" >/dev/null
cp scripts/windows/install-task.ps1 scripts/windows/remove-task.ps1 scripts/windows/service-console.ps1 scripts/windows/check-db.cjs "$STAGE/"
cp assets/okt.ico "$STAGE/okt.ico"
cp scripts/windows/installer.nsi build/win/installer.nsi
( cd build/win && makensis -V2 -DVERSION="$VER" -DOUTFILE="$PWD/../../$OUT/ZKT-Setup-$VER.exe" installer.nsi )
ls -la "$OUT/ZKT-Setup-$VER.exe"
