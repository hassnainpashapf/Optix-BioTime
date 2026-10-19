#!/bin/sh
# Builds dist/optix-<version>-linux-x64.tar.gz: Node runtime + app + install.sh. Copy it to the container and run ./install.sh.
set -e
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version"); NODEVER=${NODE_LINUX_VERSION:-$(node -p "process.version")}
OUT=${OUT:-dist}; ST=build/linux/optix-$VER; rm -rf build/linux; mkdir -p "$ST/app" "$OUT"
for f in *.js; do case "$f" in e2e*|test.js|seed-demo.js|sim-device.js) continue;; esac; cp "$f" "$ST/app/"; done
cp -R public "$ST/app/public"; cp package.json package-lock.json "$ST/app/"
( cd "$ST/app" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 )
CACHE=${CACHE:-$HOME/.cache/optix-build}; mkdir -p "$CACHE"; TX="$CACHE/node-$NODEVER-linux-x64.tar.xz"
[ -f "$TX" ] || curl -fL -o "$TX" "https://nodejs.org/dist/$NODEVER/node-$NODEVER-linux-x64.tar.xz"
tar -xJf "$TX" -C build/linux "node-$NODEVER-linux-x64/bin/node" && cp "build/linux/node-$NODEVER-linux-x64/bin/node" "$ST/node"
cp scripts/linux/install.sh "$ST/install.sh"; chmod +x "$ST/install.sh" "$ST/node"
( cd build/linux && tar -czf "../../$OUT/optix-$VER-linux-x64.tar.gz" "optix-$VER" )
ls -la "$OUT/optix-$VER-linux-x64.tar.gz"
