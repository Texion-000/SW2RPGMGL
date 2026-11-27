<p align="center">
  <img src="loader/icon.jpg" alt="SW2RPGMGL Icon" width="144" />
</p>

<h1 align="center">SW2RPGMGL</h1>
<p align="center">
  <strong>Switch 2 RPG Maker Game Launcher &bull; v0.3.2</strong><br />
  Native Nintendo Switch 2 launcher &amp; runtime suite for <strong>RPG Maker MV</strong>, <strong>MZ</strong>, <strong>VX Ace / VX / XP</strong>, and <strong>WOLF RPG Editor</strong> on <strong>kaiHEN</strong> (<code>libounce</code> + <code>OunceVK</code>).
</p>

> **Work in Progress:** This project is under active development. Compatibility varies by game and plugin set — some games may experience graphical/audio glitches, lower performance, or crashes.

> **New to this?** Follow the short step-by-step guide: **[Setting up SW2RPGMGL on your Switch 2](docs/SETUP-SWITCH2.md)**.

---

## Overview

**SW2RPGMGL** is a modular homebrew suite split into a lightweight instant-boot native launcher and drop-in engine runtimes:

| Component | File | Description |
|---|---|---|
| **Native Launcher** | `SW2RPGMGL.nro` | C++20 `libounce` 1280×720 game selector with system font (Latin + Japanese), game icons, controller & touch support. |
| **RPG Maker MV Engine** | `engines/mv-engine-switch2.nro` | Switch 2 `nx.js` runtime supporting both Skia GPU Canvas2D and hardware WebGL2 (`OunceVK`), Spine/Live2D, custom encryption, and `-` Quick Menu. |
| **RPG Maker MZ Engine** | `engines/mz-engine-switch2.nro` | Switch 2 `nx.js` runtime using hardware WebGL2 (`OunceVK` ES3), WOFF/TTF & `OpenTypePixelFont` rendering, VisuStella MZ optimizations, and `-` Quick Menu. |
| **RPG Maker VX Ace / VX / XP** | `engines/mkxp-z-switch2.nro` | Experimental Switch 2 port of [GQster/mkxp-zSwitchPort](https://github.com/GQster/mkxp-zSwitchPort) (`mkxp-z`) with shared RTP support and `-` Quick Menu. |
| **WOLF RPG Editor** | `engines/wolf-engine-switch2.nro` | Experimental: the BrowserWoditor runtime (`woditor.wasm`) compiled ahead-of-time to native ARM64 via `wasm2c`, with OunceVK GLES3, OpenAL, and `-` Quick Menu. `.wolf` archives are mounted directly in memory — nothing is extracted to the SD card. |

> **Notes:**
> - `mkxp-z-switch2.nro` is an **experimental Switch 2 port** based on the Switch 1 version by **GQster** ([GQster/mkxp-zSwitchPort](https://github.com/GQster/mkxp-zSwitchPort)) and upstream [mkxp-z](https://github.com/mkxp-z/mkxp-z).
> - `wolf-engine-switch2.nro` is **experimental**. Tested so far with *Purgatory*, *Purgatory 2*, and *Mad Father*.
> - Original PC game folders are **never modified in place**. PC saves (`.rpgsave`, `.rmmzsave`, `Save*.rvdata2`, WOLF `Save/*.sav`) can be copied back and forth freely.
> - **No game keys are bundled:** games with external decryption keys (such as *OMORI*'s `Riruka24.ini`) read the key directly from your own game files on the SD card at runtime.

---

## Quick Start (SD Card Setup)

1. Copy `dist/sd-ready/switch/SW2RPGMGL/` to `sdmc:/switch/SW2RPGMGL/` on your Switch 2 SD card.
2. Drop your PC game folders (MV, MZ, VX Ace / VX / XP, or WOLF RPG Editor) inside `sdmc:/switch/SW2RPGMGL/games/`.
3. *(Optional, for VX Ace games)* Copy the RPG Maker VX Ace RTP (`Audio/`, `Fonts/`, `Graphics/`) into `sdmc:/switch/SW2RPGMGL/RPGVXAce/`.
4. Open **SW2RPGMGL** from **hbmenu** and pick a game.

### SD Card Folder Structure

```text
sdmc:/
└── switch/
    └── SW2RPGMGL/
        ├── SW2RPGMGL.nro                 # Native launcher (only tile shown in hbmenu)
        ├── engines/
        │   ├── mv-engine-switch2.nro     # RPG Maker MV runtime
        │   ├── mz-engine-switch2.nro     # RPG Maker MZ hardware WebGL2 runtime
        │   ├── mkxp-z-switch2.nro        # RPG Maker VX Ace / VX / XP runtime (experimental)
        │   ├── wolf-engine-switch2.nro   # WOLF RPG Editor runtime (experimental)
        │   └── nxjs.ini                  # nx.js runtime configuration
        ├── log/                          # Per-engine diagnostic logs (auto-created)
        │   ├── launcher.log
        │   ├── mv.log
        │   ├── mz.log
        │   ├── mkxpz.log
        │   ├── mkxpz_boot.log
        │   └── wolf.log
        ├── RPGVXAce/                     # Optional: shared RPG Maker VX Ace RTP
        │   ├── Audio/
        │   ├── Fonts/
        │   └── Graphics/
        └── games/
            ├── <mv-game>/                # RPG Maker MV (www/ or flat web export)
            │   ├── save/                 # PC-compatible *.rpgsave files
            │   ├── mv-loader.json        # Optional per-game overrides
            │   └── www/
            ├── <mz-game>/                # RPG Maker MZ
            │   ├── index.html
            │   ├── js/
            │   ├── mv-loader.json        # Optional per-game overrides
            │   └── save/                 # PC-compatible *.rmmzsave files
            ├── <vxace-game>/             # RPG Maker VX Ace / VX / XP
            │   ├── Game.ini
            │   ├── Game.rgss3a           # Or unpacked Data/, Graphics/, Audio/
            │   └── Save*.rvdata2         # PC-compatible VX Ace saves
            └── <wolf-game>/              # WOLF RPG Editor
                ├── Game.exe              # Not used, harmless to keep
                ├── Data.wolf             # Or Data/*.wolf, or an unpacked Data/ folder
                └── Save/                 # PC-compatible SaveData*.sav (auto-created)
```

---

## Supported Engines & Encryption

| Engine | Auto-Detected Layout | Saves |Supported Encryption & Features |
|---|---|---|---|
| **RPG Maker MV** | `www/index.html` or flat `index.html` + `js/rpg_core.js` | `<game>/save/*.rpgsave` | Standard MV (`.rpgmvp`/`.rpgmvo`/`.rpgmvm`), *OMORI* AES-256-CTR (`.OMORI`/`.AUBREY`/`.KEL`/`.HERO`/`.PLUTO` via user's `Riruka24.ini`), KageDesu / PKD Protector (AES-GCM/CBC), `.ogg` & `.m4a` audio, Canvas2D & hardware WebGL2 (PixiJS v4/v5, Spine, Live2D Cubism 4). |
| **RPG Maker MZ** | `index.html` + `js/rmmz_core.js` | `<game>/save/*.rmmzsave` | Standard MZ (`.png_`/`.ogg_`/`.m4a_`), KageDesu / PKD Protector (AES-GCM/CBC), hardware WebGL2 (`OunceVK` ES3), WOFF 1.0 → TTF decoding, `OpenTypePixelFont.js` pixel fonts, VisuStella MZ compatibility, lightweight Effekseer shim. |
| **RPG Maker VX Ace / VX / XP** | `Game.ini` / `.rgss3a` / `.rgss2a` / `.rgssad` | `<game>/Save*.rvdata2` | Experimental Switch 2 port of `mkxp-z`. Reads encrypted `.rgss3a` / `.rgss2a` / `.rgssad` archives directly; auto-detects shared RTP in `SW2RPGMGL/RPGVXAce/` or `games/RPGVXAce/`. |
| **WOLF RPG Editor** | `Data.wolf`, `Data/*.wolf` / `.dxa`, or `Data/BasicData/Game.dat` | `<game>/Save/` | Experimental. Mounts DXArchive v1–v8, WOLF 2.x keys, WolfCrypt, and ChaCha20 archives in memory (so Japanese filenames inside archives never touch the SD card) and loads custom `.ttf`/`.otf` fonts automatically. Newer WOLF 3.x archives may not open yet. |

---

## Controls

### Game Select Screen (`SW2RPGMGL.nro`)
| Input | Action |
|---|---|
| **D-Pad / Left Stick** | Navigate game list |
| **Touch Drag / Scrollbar Drag** | Smooth scroll through games |
| **L / R** | Page Up / Down (6 rows) |
| **A / Tap Selected Card** | Launch game |
| **X** | Rescan SD card for games |
| **+ (Plus)** | Exit to hbmenu |

### In-Game — RPG Maker MV & MZ
| Input | Action |
|---|---|
| **D-Pad / Left Stick** | Move / Navigate |
| **A / 1-Finger Tap** | Confirm (`ok` / Enter / Walk on map) |
| **B / 2-Finger Tap** | Cancel / Back / Menu (`cancel` / Esc) |
| **X** | Menu (`menu`) |
| **Y** | Dash / Shift (`shift`) |
| **L / R** | Page Up / Page Down (`pageup` / `pagedown`) |
| **ZL / ZR** | Plugin hotkeys (`tab` / `control`) |
| **L3 / R3** | Extra plugin hotkeys |
| **- (Minus)** | Open **SW2RPGMGL Quick Menu** (Display Mode, Texture Filter, Off / Basic / Pro Performance HUD, Log On-Screen Objects, Skip Video, Manual GC, Return to Game Select, Exit to hbmenu) |
| **Touchscreen** | Tap & drag mapped to the active game resolution |

### In-Game — RPG Maker VX Ace / VX / XP
| Input | Action |
|---|---|
| **D-Pad / Left Stick** | Move / Navigate |
| **A** | Confirm (`C`) |
| **B** | Cancel / Menu (`B`) |
| **X** | Menu / Action (`X`) |
| **Y** | Dash / Shift (`A`) |
| **L / R** | Page Up / Page Down (`L` / `R`) |
| **- (Minus)** | Open **SW2RPGMGL Quick Menu** (Resume, Performance HUD `SW2RPGMGL (VX) \| XX FPS`, Soft Reset, Return to Game Select, Exit to hbmenu) |

### In-Game — WOLF RPG Editor
Buttons are mapped to the standard PC WOLF keyboard controls:

| Input | Keyboard Key | Usual Action |
|---|---|---|
| **D-Pad / Left Stick** | Arrow keys | Move / Navigate |
| **A** | `Z` | Confirm |
| **B** | `X` | Cancel / Menu |
| **X** | `C` | Game-specific |
| **Y** | `Shift` | Sub key / Dash (game-specific) |
| **L / R** | `A` / `S` | Game-specific |
| **ZL** | `Ctrl` | Game-specific (often message skip) |
| **ZR** | `Enter` | Confirm (alternate) |
| **+ (Plus)** | `Esc` | Cancel / Menu (alternate) |
| **Touchscreen** | Mouse | Tap / click for games with mouse support |
| **- (Minus)** | — | Open **SW2RPGMGL Quick Menu** (Resume, Display Mode, Scaling Filter, Performance HUD, Soft Reset (`F12`), Return to Game Select, Exit to hbmenu) |

---

## Key Features

- **Universal MV & MZ Compatibility Layer (`loader/src/`):**
  - Automatic font discovery (`gamefont.css`, `.ttf`, `.otf`, `.woff` → SFNT TTF decoding via `pako`, `FontLoad` plugin aliasing, non-Latin glyph fallback, and `OpenTypePixelFont.js` `OffscreenCanvas` pixel-font support).
  - Full NW.js & browser shims: non-truncating UTF-8 `TextEncoder` / multi-encoding `TextDecoder` (`utf-8`, `utf-16le`, `utf-16be`, `latin1`), isolated per-game `fs` / `path` / `nw.App` / `nw.Window` / `localStorage`, `MediaRecorder`, `StereoPannerNode`, custom `index.html` `<canvas>` pre-mounting, and native Switch 2 Software Keyboard (`swkbd`) text input.
  - V8-no-i18n Unicode property regex rewriting (`\p{...}`), top-level lexical hoisting for indirect script evaluation, WebGLSL `highp` promotion (eliminating 16-bit atlas seam lines), and GLES3 FBO viewport/scissor state shadowing.
- **Switch 2 (`--jitless` V8 + `OunceVK`) Performance Fast-Paths:**
  - **Tilemaps:** incremental/baked `ShaderTilemap` & `YED_Tiled` (*OMORI*) layers, flat `Float32Array` MZ `Tilemap.Layer` VBO uploads, animated-tile idle skip, and `TF_LayeredMap` row reuse.
  - **Plugins & Battle:** VisuStella MZ hoisted `_0x` string-table constant folding, `liply_MobileLight` (*Noel*) & half-res GPU `Lightmask` fast-paths, Live2D Cubism 4 per-drawable VBO pooling, `ColorFilter`/`Hue`/`AlphaFilter` caching, `WindowLayer` stencil-skip/pooling, `OpenTypePixelFont` packed glyph-path cache, and `BaseTexture.update()` frame coalescing.
  - **Map & Menus:** selective dependency-indexed `Game_Map.refresh()`, compiled `Game_Interpreter` script cache, `O(1)` spatial character grid, typed-array A* pathfinding, fast pause-menu round-trip (`fastMenu`), and WebGL splash database preloading.
- **Optional Per-Game Config (`<game>/mv-loader.json`):**
  Every game works out of the box, or you can place an optional `mv-loader.json` in the game's root folder to override defaults:
  ```json
  {
    "title": "Custom Display Name",
    "skipPlugins": ["SomeBrokenPCPlugin.js"],
    "audioFormat": "auto",
    "displayMode": "fit",
    "filterMode": "auto",
    "fastMenu": true,
    "live2dUpdateRate": "auto"
  }
  ```
  - `fastMenu` (MV, default `true`): keeps `$dataMap` and `Spriteset_Map` alive across pause menus so closing the menu is instant. Set to `false` if a plugin expects `Scene_Map` to rebuild from scratch.
  - `live2dUpdateRate` (MV Live2D games, default `"auto"`): `"auto"` halves Live2D CPU mesh deformation to 30 Hz only when measured as heavy while keeping the game itself at 60 FPS; `"half"` forces 30 Hz mesh updates; `"full"` updates meshes every frame.
- **FTP-Safe ASCII Helper (`make-ftp-safe.bat` / `scripts/make-ftp-safe.py`):**
  Some Switch FTP servers (`ftpd`) reject Japanese/non-ASCII filenames. Copying via an SD card reader avoids this completely, or if you use FTP *(requires **Python 3** on `PATH`)*:
  1. Upload your game folder to `sdmc:/switch/SW2RPGMGL/games/<Game>/` via FTP (skipping any non-ASCII files that fail).
  2. On PC, drag and drop your original game folder onto `make-ftp-safe.bat` (or run `python scripts/make-ftp-safe.py "C:\path\to\Game"`), creating `<Game>_ftp_patch` with ASCII-safe filenames + `_jp_map.txt`.
  3. Upload the contents of `<Game>_ftp_patch` into `sdmc:/switch/SW2RPGMGL/games/<Game>/` (overwriting if prompted). `mv-engine-switch2.nro`, `mz-engine-switch2.nro`, and `mkxp-z-switch2.nro` resolve `_jp_map.txt` automatically.

---

## Building From Source

### Prerequisites
- **Windows:** Node.js (v18+) and Python 3 (for bundling/packing MV & MZ engines).
- **WSL2 (Ubuntu):** `ounce-devkit` / devkitPro (`aarch64-none-elf-g++`, `libounce`, `elf2nro`, `meson`, `ninja`) for compiling the native C++ launcher, `mkxp-z`, and `wolf-engine`.

### 1. Build MV & MZ Engines (Windows, ~5s)
Typechecks, runs all 22 automated verification suites, repacks `mv-engine-switch2.nro` and `mz-engine-switch2.nro`, and stages them into `dist/sd-ready/switch/SW2RPGMGL/engines/`:

```powershell
node loader/node_modules/typescript/bin/tsc -p loader/tsconfig.json --noEmit
node loader/tools/test.mjs
node loader/tools/build.mjs
```

### 2. Build Native Launcher (WSL2, ~2s)
Compiles `launcher/src/main.cpp` with `-mtp=soft`, verifies zero hard-TLS (`tpidr_el0`) instructions, embeds `loader/icon.jpg`, and stages `SW2RPGMGL.nro`:

```bash
bash scripts/wsl-build-launcher.sh
```

### 3. Build `mkxp-z` VX Ace / VX / XP Engine (WSL2)
Applies Switch 2 patches (`scripts/patch-mkxpz-switch2.py`) onto [GQster/mkxp-zSwitchPort](https://github.com/GQster/mkxp-zSwitchPort), compiles Ruby 3.1 + `mkxp-z` with OunceVK, checks soft-TLS safety, and stages `engines/mkxp-z-switch2.nro`:

```bash
bash scripts/wsl-build-mkxpz.sh
```

### 4. Build WOLF RPG Editor Engine (WSL2)
Downloads BrowserWoditor 0.6.3.0 (checksum-verified), translates `woditor.wasm` into 8 C shards with `wasm2c` (wabt), applies `scripts/patch-wasm2c-atomics.py`, compiles everything for Cortex-A78C with OunceVK + OpenAL, checks soft-TLS safety, and stages `engines/wolf-engine-switch2.nro`:

```bash
bash scripts/wsl-build-wolf.sh
```

> `scripts/patch-wasm2c-atomics.py` fixes a wabt 1.0.36 `wasm2c` bug where atomic read-modify-write helpers on non-shared memories returned the *new* value and `cmpxchg` always reported success, which corrupts libc++ `shared_ptr` reference counts.

### 5. Rebuild Base `nx.js` C++ Runtime (Optional, WSL2)
```bash
bash scripts/wsl-rebuild-fast.sh
```

---

## Troubleshooting & Shareable Logs

Each component writes its own dedicated log file inside `sdmc:/switch/SW2RPGMGL/log/`. Engine logs start with a structured **Game Diagnostic Summary** (game title, version, folder layout, renderer, resolution, encryption mode with **masked** key status so keys are never leaked, enabled/skipped plugins, save count, performance metrics, and stack traces), making them safe and ready to share when reporting bugs:

| Log File | Source |
|---|---|
| `log/launcher.log` | Native `SW2RPGMGL.nro` game scanner & NRO handoff |
| `log/mv.log` | RPG Maker MV engine diagnostics, encryption/plugin summary, perf & errors |
| `log/mz.log` | RPG Maker MZ engine diagnostics, encryption/plugin summary, WebGL2 & errors |
| `log/mkxpz.log` & `log/mkxpz_boot.log` | RPG Maker VX Ace / VX / XP (`mkxp-z` game/archive/RTP summary & Ruby backtraces) |
| `log/wolf.log` | WOLF RPG Editor engine (archive mounting, file access & errors) |
| `sdmc:/switch/nxjs-debug.log` | Low-level `nx.js` C++ / V8 / Skia / OunceVK output |

- **What is `sdmc:/hello-v8-mman.log` in the SD root?**
  A harmless debug log hardcoded in the prebuilt upstream `switch-v8` (`horizon_mman`) memory allocator inside `nxjs-switch2.nro`. It is overwritten on each MV/MZ launch and safe to ignore or delete.
- **Slow FPS in Live2D MV games?**
  Live2D CPU mesh deformation is heavy under V8 `jit = off`; `live2dUpdateRate` defaults to `"auto"` (30 Hz mesh updates while keeping 60 FPS gameplay), or disabling Live2D in the game's own options restores full frame rate.
- **OMORI shows a black screen or fails to load?**
  Make sure you copied the entire OMORI install folder, including `Riruka24.ini` next to `www/`. The engine reads your copy's decryption key from `Riruka24.ini` at runtime.
- **WOLF game closes right away?**
  Check `log/wolf.log`. A message saying the game data is "too old" or "could not be read" usually means the game uses a newer WOLF 3.x archive encryption not yet supported; unpacking the game on PC into `Data/BasicData/Game.dat` often works around it.

---

## Credits

- [nx.js](https://github.com/TooTallNate/nx.js) — JavaScript runtime (Switch 2 `libounce` + `OunceVK` port)
- [mkxp-z](https://github.com/mkxp-z/mkxp-z) — RGSS / Ruby 3.1 engine
- [mkxp-zSwitchPort](https://github.com/GQster/mkxp-zSwitchPort) by **GQster** — Switch 1 `mkxp-z` port that `mkxp-z-switch2.nro` is experimentally ported from
- **BrowserWoditor** — WOLF RPG Editor browser runtime by **SmokingWOLF** / SilverSecond (WOLF RPG Editor); downloaded at build time, not stored in this repository
- [wabt](https://github.com/WebAssembly/wabt) — `wasm2c` WebAssembly-to-C translator used for the WOLF engine
- [kaiHEN](https://github.com/ouncebrew/kaihen) — Switch 2 homebrew environment ([ouncebrew](https://github.com/ouncebrew))
- [ounce-devkit](https://github.com/ouncebrew/ounce-devkit) — Switch 2 toolchain & `libounce` ([pkg.ouncebrew.org](https://pkg.ouncebrew.org))
- [OunceVK](https://github.com/ouncebrew/ouncevk) — Switch 2 Vulkan / EGL / OpenGL ES driver layer (NVK + Zink)

---

## License

This project is licensed under the **GNU General Public License v3.0** — see the [LICENSE](LICENSE) file for details.

Bundled/upstream runtimes retain their respective licenses (`mkxp-z`: GPL-2.0-or-later / GPL-3.0; `nx.js`: MIT; `wabt`: Apache-2.0; BrowserWoditor: its own distribution terms).
