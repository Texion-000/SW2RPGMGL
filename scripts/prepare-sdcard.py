#!/usr/bin/env python3
"""
Stage a ready-to-copy Nintendo Switch 2 SD card folder for Switch 2 MV Loader
without modifying original PC game installations.

Output layout:
  sd-card/
    switch/
      switch2-MV-loader/
        switch2-MV-loader.nro      (universal loader NRO)
        nxjs.ini                   (runtime config)
        demons-roots/              (and any extra games passed via --game)
          save/                    (existing PC saves copied if present)
          www/                     (original game's www/ assets)

Usage:
  python scripts/prepare-sdcard.py [destination_dir]
  python scripts/prepare-sdcard.py E:\\ --game "C:\\Games\\MyMVGame"
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_GAME_DIR = PROJECT_DIR.parent / "Demons Roots"
DIST_LAUNCHER_NRO = PROJECT_DIR / "dist" / "SW2RPGMGL.nro"
DIST_MV_NRO = PROJECT_DIR / "dist" / "mv-engine-switch2.nro"
DIST_MZ_NRO = PROJECT_DIR / "dist" / "mz-engine-switch2.nro"
DIST_MKXPZ_NRO = PROJECT_DIR / "dist" / "mkxp-z-switch2.nro"
NXJS_INI = PROJECT_DIR / "loader" / "romfs" / "nxjs.ini"


def slugify(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", name.strip()).strip("-").lower()
    return slug or "mv-game"


def stage_game(src_dir: Path, loader_root: Path, folder_name: str | None = None) -> bool:
    www_src = src_dir / "www" if (src_dir / "www" / "index.html").is_file() else src_dir
    if not (www_src / "index.html").is_file():
        print(f"[warn] Skipping {src_dir}: no index.html found in {src_dir} or {src_dir / 'www'}", file=sys.stderr)
        return False

    name = folder_name or slugify(src_dir.name if www_src != src_dir else src_dir.name)
    game_dst = loader_root / name
    www_dst = game_dst / "www"
    save_dst = game_dst / "save"

    game_dst.mkdir(parents=True, exist_ok=True)
    save_dst.mkdir(parents=True, exist_ok=True)

    # Copy existing PC saves if any exist in www/save
    orig_save = www_src / "save"
    if orig_save.is_dir():
        copied_saves = 0
        for f in orig_save.glob("*.rpgsave"):
            shutil.copy2(f, save_dst / f.name)
            copied_saves += 1
        if copied_saves:
            print(f"[ok] Imported {copied_saves} PC save file(s) -> {save_dst}")

    print(f"[copy] Copying {www_src} -> {www_dst} ...")
    shutil.copytree(www_src, www_dst, dirs_exist_ok=True)
    print(f"[ok] Staged game '{name}' -> {game_dst}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage Switch 2 MV Loader SD card layout")
    parser.add_argument("destination", nargs="?", default=str(PROJECT_DIR / "sd-card"), help="Destination SD root directory")
    parser.add_argument("--game", action="append", default=[], help="Path to an RPG Maker MV game folder (repeatable)")
    parser.add_argument("--no-default-game", action="store_true", help="Do not auto-include ../Demons Roots")
    args = parser.parse_args()

    dest_root = Path(args.destination).resolve()
    loader_root = dest_root / "switch" / "SW2RPGMGL"
    engines_root = loader_root / "engines"
    games_root = loader_root / "games"
    engines_root.mkdir(parents=True, exist_ok=True)
    games_root.mkdir(parents=True, exist_ok=True)

    # 1. Copy compiled native launcher & engine NROs
    if DIST_LAUNCHER_NRO.is_file():
        shutil.copy2(DIST_LAUNCHER_NRO, loader_root / "SW2RPGMGL.nro")
        print(f"[ok] Copied {DIST_LAUNCHER_NRO.name} -> {loader_root}")
    else:
        print(f"[note] {DIST_LAUNCHER_NRO} not built yet — run `bash scripts/wsl-build-launcher.sh` first.")

    if DIST_MV_NRO.is_file():
        shutil.copy2(DIST_MV_NRO, engines_root / "mv-engine-switch2.nro")
        print(f"[ok] Copied {DIST_MV_NRO.name} -> {engines_root}")
    else:
        print(f"[note] {DIST_MV_NRO} not built yet — run `node loader/tools/build.mjs` first.")

    if DIST_MZ_NRO.is_file():
        shutil.copy2(DIST_MZ_NRO, engines_root / "mz-engine-switch2.nro")
        print(f"[ok] Copied {DIST_MZ_NRO.name} -> {engines_root}")
    else:
        print(f"[note] {DIST_MZ_NRO} not built yet — run `node loader/tools/build.mjs` first.")

    if DIST_MKXPZ_NRO.is_file():
        shutil.copy2(DIST_MKXPZ_NRO, engines_root / "mkxp-z-switch2.nro")
        print(f"[ok] Copied {DIST_MKXPZ_NRO.name} -> {engines_root}")

    # 2. Copy editable nxjs.ini into engines/
    if NXJS_INI.is_file():
        shutil.copy2(NXJS_INI, engines_root / "nxjs.ini")
        print(f"[ok] Copied nxjs.ini -> {engines_root / 'nxjs.ini'}")

    # 3. Stage default game (Demons Roots) if present unless disabled
    if not args.no_default_game and (DEFAULT_GAME_DIR / "www" / "index.html").is_file():
        stage_game(DEFAULT_GAME_DIR, games_root, "demons-roots")

    # 4. Stage any additional --game folders
    for raw_game in args.game:
        stage_game(Path(raw_game).resolve(), games_root)

    print(f"\n[done] SD card folder ready at: {dest_root}")
    print("       Copy the `switch/` folder inside it to the root of your Switch 2 microSD Express card.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
