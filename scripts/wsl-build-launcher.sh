#!/usr/bin/env bash
# =============================================================================
# Build SW2RPGMGL.nro (Switch 2 RPG Maker Game Launcher — native Switch 2 UI)
# for Nintendo Switch 2 (kaiHEN / libounce) in WSL2 Ubuntu.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCHER_DIR="$PROJECT_DIR/launcher"
DIST_DIR="$PROJECT_DIR/dist"
SD_READY_DIR="$DIST_DIR/sd-ready/switch/SW2RPGMGL"

export DEVKITPRO=/opt/devkitpro
export PATH="$DEVKITPRO/portlibs/switch2/bin:$DEVKITPRO/portlibs/switch/bin:$DEVKITPRO/devkitA64/bin:$DEVKITPRO/tools/bin:$PATH"

echo "=== Building SW2RPGMGL.nro (native Switch 2 C++ / libounce) ==="
make -C "$LAUNCHER_DIR" -j"$(nproc)"

ELF_OUT="$LAUNCHER_DIR/build-switch2/SW2RPGMGL.elf"
NRO_OUT="$LAUNCHER_DIR/build-switch2/SW2RPGMGL.nro"

echo "=== Verifying zero hard-TLS (mrs tpidr_el0) instructions in ELF ==="
BAD_TLS="$(aarch64-none-elf-objdump -d "$ELF_OUT" | grep -E 'mrs\s+x[0-9]+,\s*tpidr_el0' || true)"
if [ -n "$BAD_TLS" ]; then
  echo "[WARNING] Found tpidr_el0 instruction(s) in ELF:"
  echo "$BAD_TLS" | head -n 10
else
  echo "[OK] Zero tpidr_el0 instructions found!"
fi

mkdir -p "$DIST_DIR" "$SD_READY_DIR/engines" "$SD_READY_DIR/games" "$SD_READY_DIR/log"
cp -f "$NRO_OUT" "$DIST_DIR/SW2RPGMGL.nro"
cp -f "$NRO_OUT" "$SD_READY_DIR/SW2RPGMGL.nro"
printf 'Place your RPG Maker MV, MZ, VX Ace / VX / XP, and WOLF RPG Editor game folders in this directory.\n' > "$SD_READY_DIR/games/PUT_GAMES_HERE.txt"

# Stage engines if present in dist/
if [ -f "$DIST_DIR/mv-engine-switch2.nro" ]; then
  cp -f "$DIST_DIR/mv-engine-switch2.nro" "$SD_READY_DIR/engines/mv-engine-switch2.nro"
fi
if [ -f "$DIST_DIR/mz-engine-switch2.nro" ]; then
  cp -f "$DIST_DIR/mz-engine-switch2.nro" "$SD_READY_DIR/engines/mz-engine-switch2.nro"
fi
if [ -f "$PROJECT_DIR/loader/romfs/nxjs.ini" ]; then
  cp -f "$PROJECT_DIR/loader/romfs/nxjs.ini" "$SD_READY_DIR/engines/nxjs.ini"
fi
if [ -f "$DIST_DIR/mkxp-z-switch2.nro" ]; then
  cp -f "$DIST_DIR/mkxp-z-switch2.nro" "$SD_READY_DIR/engines/mkxp-z-switch2.nro"
fi
if [ -f "$DIST_DIR/wolf-engine-switch2.nro" ]; then
  cp -f "$DIST_DIR/wolf-engine-switch2.nro" "$SD_READY_DIR/engines/wolf-engine-switch2.nro"
fi

echo ""
echo "==================================================================="
echo "  SW2RPGMGL.nro BUILD COMPLETE!"
ls -lh "$DIST_DIR/SW2RPGMGL.nro"
echo "  Staged SD-ready folder: $SD_READY_DIR"
echo "==================================================================="
