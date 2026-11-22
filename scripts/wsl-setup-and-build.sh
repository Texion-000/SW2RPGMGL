#!/usr/bin/env bash
# =============================================================================
# Demons Roots — Nintendo Switch 2 (kaiHEN) Full Local Build Script (WSL Ubuntu)
#
# Installs:
#   1. Ubuntu host build tools + Node.js 22 + pnpm
#   2. Complete /opt/devkitpro + dkp-pacman + devkitA64 + nx.js portlibs
#      (switch-v8, switch-skia, switch-libuv, switch-ffmpeg, switch-ada)
#      directly from ghcr.io/tootallnate/pacman-packages (no Docker!)
#   3. ounce-devkit (libounce, ouncevk, libkaihen) from https://pkg.ouncebrew.org
# Then compiles on fast Linux ext4:
#   - upstream/nx.js/nxjs-switch2.nro  (native Switch 2 V8+Skia+OunceVK+kaiHEN JIT)
#   - dist/demons-roots-switch2.nro    (self-contained Demons Roots Switch 2 NRO!)
# =============================================================================
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NXJS_SRC="$PROJECT_DIR/upstream/nx.js"
OUNCE_DIR="$PROJECT_DIR/upstream/ounce-devkit"
LOADER_DIR="$PROJECT_DIR/loader"
WORK_ROOT="/var/tmp/dr-sw2-build"
NXJS_WORK="$WORK_ROOT/nx.js"

echo "=== [1/6] Installing Ubuntu host prerequisites ==="
$SUDO apt-get update
$SUDO apt-get install -y --no-install-recommends \
  ca-certificates curl git jq make pkg-config python3 zstd xz-utils \
  build-essential gnupg dirmngr rsync libarchive13t64 || \
$SUDO apt-get install -y --no-install-recommends \
  ca-certificates curl git jq make pkg-config python3 zstd xz-utils \
  build-essential gnupg dirmngr rsync

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 20 ]; then
  echo "=== Installing Node.js 22.x ==="
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

if ! command -v pnpm >/dev/null 2>&1; then
  $SUDO npm install -g pnpm@10
fi

echo "=== [2/6] Pulling devkitPro + devkitA64 + nx.js portlibs (V8, Skia, libuv, FFmpeg) from ghcr.io ==="
PORTLIB_CACHE="/var/cache/demons-roots-nxjs-portlibs"
$SUDO mkdir -p "$PORTLIB_CACHE"
$SUDO python3 "$SCRIPT_DIR/fetch-nxjs-portlibs.py" "$PORTLIB_CACHE"

export DEVKITPRO=/opt/devkitpro
export DEVKITARM=/opt/devkitpro/devkitARM
export DEVKITPPC=/opt/devkitpro/devkitPPC
export PATH="/usr/local/bin:$DEVKITPRO/pacman/bin:$DEVKITPRO/tools/bin:$DEVKITPRO/devkitA64/bin:$PATH"

echo "=== [3/6] Installing ounce-devkit (libounce, ouncevk, libkaihen) from pkg.ouncebrew.org ==="
if [ ! -f "$DEVKITPRO/libounce/switch2_rules" ] || [ ! -f "$DEVKITPRO/portlibs/switch2/lib/libouncevk-gl.a" ]; then
  tr -d '\r' < "$OUNCE_DIR/install.sh" | sh
else
  echo "[ok] ounce-devkit already installed (libounce + ouncevk + libkaihen)"
fi

echo "=== [4/6] Syncing nx.js to Linux ext4 & bundling runtime.js ==="
python3 "$PROJECT_DIR/nxjs-switch2/patch-nxjs-switch2.py"
mkdir -p "$WORK_ROOT"
rsync -a --delete --exclude node_modules --exclude build --exclude build-switch2 --exclude .git "$NXJS_SRC/" "$NXJS_WORK/"
cp -f "$PROJECT_DIR/nxjs-switch2/Makefile.switch2" "$NXJS_WORK/Makefile.switch2"
sed -i 's|$(CURDIR)/../../nxjs-switch2/Makefile.switch2|$(CURDIR)/Makefile.switch2|g' "$NXJS_WORK/Makefile.switch2"

cd "$NXJS_WORK"
pnpm install --frozen-lockfile
pnpm build --filter @nx.js/runtime
pnpm bundle

echo "=== [5/6] Compiling nxjs-switch2.nro with ounce-devkit (libounce + OunceVK + libkaihen) ==="
mkdir -p "$NXJS_WORK/build-switch2"
python3 "$PROJECT_DIR/nxjs-switch2/patch-v8-nopac.py" \
  "$DEVKITPRO/portlibs/switch/lib/libv8_monolith.a" \
  "$NXJS_WORK/build-switch2/v8_snapshot_nopac.o"
make -f Makefile.switch2 -j"$(nproc)" V=1
cp -f "$NXJS_WORK/nxjs-switch2.nro" "$NXJS_SRC/nxjs-switch2.nro"
echo "[ok] Copied compiled Switch 2 runtime -> $NXJS_SRC/nxjs-switch2.nro"

echo "=== [6/6] Bundling & packing Demons Roots Switch 2 NRO ==="
LOADER_WORK="$WORK_ROOT/loader"
rsync -a --delete --exclude node_modules "$LOADER_DIR/" "$LOADER_WORK/"
cd "$LOADER_WORK"
npm install
node tools/build.mjs --base "$NXJS_SRC/nxjs-switch2.nro"
mkdir -p "$PROJECT_DIR/dist"
cp -f "$WORK_ROOT/dist/demons-roots-switch2.nro" "$PROJECT_DIR/dist/demons-roots-switch2.nro"

echo ""
echo "==================================================================="
echo "  BUILD COMPLETE!"
echo "  Output NRO: $PROJECT_DIR/dist/demons-roots-switch2.nro"
echo "==================================================================="
