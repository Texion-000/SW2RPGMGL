#!/usr/bin/env bash
# =============================================================================
# Build wolf-engine-switch2.nro (WOLF RPG Editor / Woditor companion engine)
# for Nintendo Switch 2 (kaiHEN / libounce + OunceVK + OpenAL) in WSL2 Ubuntu.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WOLF_DIR="$PROJECT_DIR/wolf-engine"
DIST_DIR="$PROJECT_DIR/dist"
SD_READY_DIR="$DIST_DIR/sd-ready/switch/SW2RPGMGL"

BW_DIR="/var/tmp/bw"
WABT_DIR="/var/tmp/wabt-deb"
GEN_DIR="/var/tmp/wolf-sw2-gen"
BUILD_DIR="/var/tmp/wolf-sw2-build"

export DEVKITPRO=/opt/devkitpro
export PATH="$DEVKITPRO/portlibs/switch2/bin:$DEVKITPRO/portlibs/switch/bin:$DEVKITPRO/devkitA64/bin:$DEVKITPRO/tools/bin:$PATH"

# 1. Ensure BrowserWoditor 0.6.3.0 runtime assets exist
if [ ! -f "$BW_DIR/public/woditor.wasm" ]; then
  echo "=== Downloading BrowserWoditor 0.6.3.0 ==="
  mkdir -p "$BW_DIR"
  curl -fsSL "https://frostyhowl.com/files/BrowserWoditor_0_6_3_0.zip" -o /var/tmp/BrowserWoditor.zip
  echo "32b8b899a0e1e003b24b613ab86effe45a66f2ef1173aa4824a12380e55930fa  /var/tmp/BrowserWoditor.zip" | sha256sum -c -
  unzip -qo /var/tmp/BrowserWoditor.zip -d "$BW_DIR"
fi

# Ensure RomFS default fonts & Game.ini are staged
mkdir -p "$WOLF_DIR/romfs"
cp -f "$BW_DIR/public/DefaultFont.ttf" "$BW_DIR/public/DefaultSubFont.ttf" "$BW_DIR/public/Game.ini" "$WOLF_DIR/romfs/"

# 2. Ensure wasm2c (wabt) is available
WASM2C_BIN=""
if command -v wasm2c >/dev/null 2>&1; then
  WASM2C_BIN="$(command -v wasm2c)"
elif [ -x "$WABT_DIR/usr/bin/wasm2c" ]; then
  WASM2C_BIN="$WABT_DIR/usr/bin/wasm2c"
else
  echo "=== Fetching wabt (wasm2c) ==="
  mkdir -p "$WABT_DIR"
  (cd /var/tmp && apt-get download wabt && dpkg-deb -x wabt_*.deb "$WABT_DIR")
  WASM2C_BIN="$WABT_DIR/usr/bin/wasm2c"
fi

# 3. Generate (or reuse cached) 8-shard C code from woditor.wasm
mkdir -p "$GEN_DIR"
if [ ! -f "$GEN_DIR/woditor_wasm.h" ]; then
  if [ -f "/var/tmp/woditor_wasm.h" ] && [ -f "/var/tmp/woditor_wasm_7.c" ]; then
    echo "=== Staging pre-generated wasm2c sources into $GEN_DIR ==="
    cp -f /var/tmp/woditor_wasm.h /var/tmp/woditor_wasm-impl.h /var/tmp/woditor_wasm_*.c "$GEN_DIR/"
  else
    echo "=== Translating woditor.wasm -> 8 C shards via wasm2c ==="
    "$WASM2C_BIN" --enable-threads --num-outputs=8 "$BW_DIR/public/woditor.wasm" -o "$GEN_DIR/woditor_wasm.c"
  fi
fi

# 3b. Fix wabt 1.0.36 non-shared atomics (RMW returned the new value, cmpxchg returned `expected`).
#     Without this, libc++ shared_ptr refcounts are off by one -> use-after-free -> OOB trap at boot.
echo "=== Patching wasm2c atomics in woditor_wasm-impl.h ==="
python3 "$SCRIPT_DIR/patch-wasm2c-atomics.py" "$GEN_DIR/woditor_wasm-impl.h"

# 4. Compile & link Switch 2 ELF + NRO in parallel
echo "=== Building wolf-engine-switch2.nro (Cortex-A78C + libounce + OunceVK + OpenAL) ==="
make -C "$WOLF_DIR" WASM2C_DIR="$GEN_DIR" BUILD="$BUILD_DIR" -j"$(nproc)"

ELF_OUT="$BUILD_DIR/wolf-engine-switch2.elf"
NRO_OUT="$BUILD_DIR/wolf-engine-switch2.nro"

echo "=== Verifying zero hard-TLS (mrs tpidr_el0) instructions in ELF ==="
BAD_TLS="$(aarch64-none-elf-objdump -d "$ELF_OUT" | grep -E 'mrs\s+x[0-9]+,\s*tpidr_el0' || true)"
if [ -n "$BAD_TLS" ]; then
  echo "[ERROR] Found tpidr_el0 hard-TLS instruction(s) in $ELF_OUT:" >&2
  echo "$BAD_TLS" | head -n 10 >&2
  exit 1
else
  echo "[OK] Zero tpidr_el0 instructions found!"
fi

mkdir -p "$DIST_DIR" "$SD_READY_DIR/engines"
cp -f "$NRO_OUT" "$DIST_DIR/wolf-engine-switch2.nro"
cp -f "$NRO_OUT" "$SD_READY_DIR/engines/wolf-engine-switch2.nro"

echo ""
echo "==================================================================="
echo "  wolf-engine-switch2.nro BUILD COMPLETE!"
ls -lh "$DIST_DIR/wolf-engine-switch2.nro"
echo "==================================================================="
