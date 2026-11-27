# Setting up SW2RPGMGL on your Switch 2

This guide gets you from zero to playing your PC RPG Maker or WOLF RPG Editor games on a Switch 2, in about 10 minutes.

---

## What you need

- A **Switch 2 that can run homebrew** using [kaiHEN](https://github.com/ouncebrew/kaihen), with **hbmenu** working. (Setting that up is outside this guide; follow the kaiHEN instructions first.)
- The Switch 2's **SD card** and a way to connect it to your PC (card reader), or an FTP app on the Switch.
- The **SW2RPGMGL files**: download the latest version from the [Releases page](https://github.com/Texion-000/SW2RPGMGL/releases) and unzip it.
- The **PC versions** of the games you want to play.

---

## Step 1 — Copy SW2RPGMGL to the SD card

1. Put the SD card in your PC.
2. From the download, copy the **`switch`** folder to the **top level** of the SD card. If a `switch` folder already exists, let your PC merge them.

You should now have this on the SD card:

```text
switch/
└── SW2RPGMGL/
    ├── SW2RPGMGL.nro
    ├── engines/
    └── games/        ← your games go here
```

## Step 2 — Add your games

Copy each game's **whole folder** (the folder that contains its `Game.exe`) into `switch/SW2RPGMGL/games/`. Use one folder per game:

```text
switch/SW2RPGMGL/games/
├── Purgatory/
├── Mad Father/
└── My MV Game/
```

The launcher works out which engine each game needs by itself. It looks for these files:

| Game made with | It's detected by |
|---|---|
| RPG Maker **MV** | `www/index.html` (or `index.html` + `js/rpg_core.js`) |
| RPG Maker **MZ** | `index.html` + `js/rmmz_core.js` |
| RPG Maker **VX Ace / VX / XP** | `Game.ini` + `Game.rgss3a` / `.rgss2a` / `.rgssad` |
| **WOLF RPG Editor** | `Data.wolf` (or a `Data/` folder) |

> **VX Ace games only:** if a game complains about missing graphics or sounds, it needs the free RPG Maker VX Ace **RTP**. Copy the RTP's `Audio`, `Fonts` and `Graphics` folders into `switch/SW2RPGMGL/RPGVXAce/`.

## Step 3 — Play

1. Put the SD card back into the Switch 2.
2. Start **hbmenu** through kaiHEN.
3. Open **SW2RPGMGL**.
4. Pick a game with the D-Pad or touchscreen and press **A**.

The first launch of a big game can take a little while; a loading screen with a progress bar shows what's happening.

---

## Controls you need to know

| Button | What it does |
|---|---|
| **A** | Confirm |
| **B** | Cancel / open the game's menu |
| **D-Pad / Left Stick** | Move |
| **− (Minus)** | **Quick Menu**: change display mode and filter, show FPS, soft reset, go back to the game list, or exit |
| **+ (Plus)** | On the game list: exit to hbmenu |
| **X** | On the game list: rescan the SD card for new games |

The full button list for each engine is in the [README](../README.md#controls).

---

## Saves

Your saves are stored inside each game's folder, in the same format as on PC, so you can move them back and forth:

| Engine | Save location |
|---|---|
| MV / MZ | `<game>/save/` |
| VX Ace / VX / XP | `<game>/` (`Save*.rvdata2`) |
| WOLF RPG Editor | `<game>/Save/` |

---

## Something's not working?

- **A game doesn't show up:** make sure you copied the game's whole folder (not just the `.exe`) straight into `games/`, not inside an extra folder. Press **X** on the game list to rescan.
- **Files with Japanese names fail to copy over FTP:** copy them with a card reader instead, or use the `make-ftp-safe.bat` helper described in the [README](../README.md#key-features).
- **A game crashes or closes:** look in `switch/SW2RPGMGL/log/` on the SD card. `launcher.log` is the game list, `mv.log` is RPG Maker MV, `mz.log` is RPG Maker MZ, `mkxpz.log` is VX Ace/VX/XP, and `wolf.log` is WOLF RPG Editor. Include the matching log file when reporting a problem.

Compatibility is still a work in progress, so some games may have glitches, run slowly, or not start at all.
