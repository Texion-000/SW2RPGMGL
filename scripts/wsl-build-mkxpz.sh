#!/usr/bin/env bash
# =============================================================================
# Build mkxp-z-switch2.nro (RPG Maker XP / VX / VX Ace companion engine)
# for Nintendo Switch 2 (kaiHEN / libounce + OunceVK) in WSL2 Ubuntu.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="/var/tmp/mkxp-z-sw2"

export DEVKITPRO=/opt/devkitpro
export PATH="/usr/local/bin:$DEVKITPRO/portlibs/switch2/bin:$DEVKITPRO/portlibs/switch/bin:$DEVKITPRO/tools/bin:$DEVKITPRO/devkitA64/bin:$PATH"

if [ ! -d "$WORK_DIR/.git" ]; then
  echo "=== Cloning GQster/mkxp-zSwitchPort (switch-port-upstream) ==="
  rm -rf "$WORK_DIR"
  git clone --depth 1 -b switch-port-upstream https://github.com/GQster/mkxp-zSwitchPort.git "$WORK_DIR"
fi

echo "=== Applying Switch 2 (libounce + OunceVK) & Unified Loader patches ==="
python3 "$SCRIPT_DIR/patch-mkxpz-switch2.py" "$WORK_DIR"

cd "$WORK_DIR"
if [ ! -f "build-switch2/build.ninja" ]; then
  echo "=== Configuring Meson for Switch 2 (Cortex-A78C + libounce + OunceVK) ==="
  meson setup --cross-file switch/switch2.ini --buildtype release build-switch2
fi

# Ensure Switch 2 OunceVK (Zink + NVK) libraries in portlibs/switch2/lib are linked
# instead of Switch 1 Mesa nouveau archives from sdl2.pc's -L/opt/devkitpro/portlibs/switch/lib
sed -i -E 's#/opt/devkitpro/portlibs/switch/lib/(lib(EGL|GLESv2|glapi|drm_nouveau)\.a)#/opt/devkitpro/portlibs/switch2/lib/\1#g' build-switch2/build.ninja

echo "=== Building mkxp-z-switch2.nro (this compiles Ruby 3.1 + subprojects on first build) ==="
ninja -C build-switch2 -j"$(nproc)"

# If ninja regenerated build.ninja during the build, re-apply the OunceVK library path fix and relink
if grep -q "/opt/devkitpro/portlibs/switch/lib/libEGL\.a" build-switch2/build.ninja; then
  echo "=== Re-applying OunceVK (Zink + NVK) libEGL path after Meson regeneration ==="
  sed -i -E 's#/opt/devkitpro/portlibs/switch/lib/(lib(EGL|GLESv2|glapi|drm_nouveau)\.a)#/opt/devkitpro/portlibs/switch2/lib/\1#g' build-switch2/build.ninja
  rm -f build-switch2/mkxp-z.cortex-a78c build-switch2/switch/nro/mkxp-z.nro
  ninja -C build-switch2 -j"$(nproc)"
fi

echo "=== Checking ELF for soft-TLS miscompiles ==="
ELF_PATH="$(ls build-switch2/mkxp-z.* 2>/dev/null | grep -v '\.p$' | head -n 1 || true)"
if [ -n "$ELF_PATH" ] && [ -f "$ELF_PATH" ]; then
  aarch64-none-elf-objdump -d "$ELF_PATH" > build-switch2/disassembly.txt
  python3 switch/find_bad_tls.py build-switch2/disassembly.txt
fi

NRO_OUT="$WORK_DIR/build-switch2/switch/nro/mkxp-z.nro"
if [ ! -f "$NRO_OUT" ]; then
  echo "[error] Expected NRO not found at $NRO_OUT" >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/dist/sd-ready/switch/SW2RPGMGL/engines"
cp -f "$NRO_OUT" "$PROJECT_DIR/dist/mkxp-z-switch2.nro"
cp -f "$NRO_OUT" "$PROJECT_DIR/dist/sd-ready/switch/SW2RPGMGL/engines/mkxp-z-switch2.nro"

echo ""
echo "==================================================================="
echo "  mkxp-z-switch2.nro BUILD COMPLETE!"
echo "  Output: $PROJECT_DIR/dist/mkxp-z-switch2.nro"
echo "==================================================================="
