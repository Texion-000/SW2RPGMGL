#!/usr/bin/env bash
set -euo pipefail
export DEVKITPRO=/opt/devkitpro
export PATH="/usr/local/bin:$DEVKITPRO/pacman/bin:$DEVKITPRO/tools/bin:$DEVKITPRO/devkitA64/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NXJS_WORK="/var/tmp/dr-sw2-build/nx.js"

cp -f "$PROJECT_DIR/upstream/nx.js/source/main.cc" "$NXJS_WORK/source/main.cc"
cp -f "$PROJECT_DIR/upstream/nx.js/source/skia_gpu.cc" "$NXJS_WORK/source/skia_gpu.cc"
cp -f "$PROJECT_DIR/upstream/nx.js/source/webgl.cc" "$NXJS_WORK/source/webgl.cc"
cp -f "$PROJECT_DIR/upstream/nx.js/source/image.cc" "$NXJS_WORK/source/image.cc"

cd "$NXJS_WORK"
make -f Makefile.switch2 -j"$(nproc)" V=1
cp -f "$NXJS_WORK/nxjs-switch2.nro" "$PROJECT_DIR/upstream/nx.js/nxjs-switch2.nro"
echo "[ok] Incremental Switch 2 runtime rebuild complete!"
