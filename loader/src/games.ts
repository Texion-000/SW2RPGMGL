/**
 * Universal RPG Maker game discovery & metadata scanner (MV + VX Ace / VX / XP).
 *
 * Expected SD card layout:
 *   sdmc:/switch/switch2-MV-loader/
 *     ├── switch2-MV-loader.nro       (Game Select UI + RPG Maker MV engine)
 *     ├── mkxp-z-switch2.nro          (Companion RGSS1/2/3 engine for XP/VX/VX Ace)
 *     ├── nxjs.ini
 *     ├── rtp-vxace/                  (optional: shared VX Ace RTP)
 *     ├── <mv-game>/
 *     │   ├── save/                   (optional: PC *.rpgsave files)
 *     │   ├── mv-loader.json          (optional: per-game overrides)
 *     │   └── www/                    (RPG Maker MV www/ folder with index.html)
 *     └── <vxace-game>/               (e.g. Black Souls 2)
 *         ├── Game.ini
 *         ├── Game.rgss3a (or Data/ + Graphics/ + Audio/)
 *         └── Save*.rvdata2
 */
import type { DisplayMode, FilterMode } from './browser-host';
import { ensureDir, log, type SwitchApi } from './log';

export type GameEngine = 'mv' | 'mz' | 'vxace' | 'vx' | 'xp';

export interface GameConfig {
  title?: string;
  skipPlugins?: string[];
  audioFormat?: 'auto' | 'ogg' | 'm4a';
  displayMode?: DisplayMode;
  filterMode?: FilterMode;
  /** MV: reuse map data + Spriteset_Map across pause-menu round-trips (default true). */
  fastMenu?: boolean;
}

export interface GameEntry {
  id: string;
  folderName: string;
  engine: GameEngine;
  title: string;
  gameDir: string;
  wwwRoot: string;
  saveDir: string;
  iconPath: string | null;
  pluginCount: number;
  saveCount: number;
  locale: string;
  encrypted: boolean;
  config: GameConfig;
}

const IGNORED_DIRS = new Set([
  '.',
  '..',
  'engines',
  'games',
  'log',
  'save',
  'screenshots',
  'userdata',
  'rpgvxace',
  'rtp-vxace',
  'rtp-vx',
  'rtp-xp',
  'rtp',
  '__macosx',
]);

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readTextSyncSafe(
  sw: Pick<SwitchApi, 'readFileSync'>,
  path: string,
): string | null {
  try {
    const buf = sw.readFileSync(path);
    if (!buf) return null;
    return stripBom(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

function fileExistsSync(
  sw: Pick<SwitchApi, 'statSync'>,
  path: string,
): boolean {
  try {
    return sw.statSync(path) !== null;
  } catch {
    return false;
  }
}

function parseIndexTitle(html: string | null): string | null {
  if (!html) return null;
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const title = m?.[1]?.trim();
  return title || null;
}

function countEnabledPlugins(pluginsSrc: string | null): number {
  if (!pluginsSrc) return 0;
  let count = 0;
  const re = /(?:^|[{,\s])"?status"?\s*:\s*true\b/g;
  while (re.exec(pluginsSrc) !== null) count++;
  return count;
}

function findGameIconPath(
  sw: Pick<SwitchApi, 'statSync' | 'readDirSync'>,
  wwwRoot: string,
): string | null {
  const direct = `${wwwRoot}/icon/icon.png`;
  if (fileExistsSync(sw, direct)) return direct;
  try {
    const entries = sw.readDirSync(`${wwwRoot}/icon/`) ?? [];
    for (const name of entries) {
      if (name.toLowerCase() === 'icon.png') return `${wwwRoot}/icon/${name}`;
    }
    for (const name of entries) {
      if (/\.(?:png|jpe?g|webp)$/i.test(name)) return `${wwwRoot}/icon/${name}`;
    }
  } catch { /* ignore */ }
  return null;
}

function findRgssIconPath(
  sw: Pick<SwitchApi, 'statSync' | 'readDirSync'>,
  gameDir: string,
): string | null {
  for (const cand of ['icon.png', 'cover.png', 'icon.jpg', 'cover.jpg']) {
    const p = `${gameDir}/${cand}`;
    if (fileExistsSync(sw, p)) return p;
  }
  try {
    const entries = sw.readDirSync(`${gameDir}/`) ?? [];
    for (const name of entries) {
      if (/^(?:icon|cover)\.(?:png|jpe?g|webp)$/i.test(name)) {
        return `${gameDir}/${name}`;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function countSaveFiles(
  sw: Pick<SwitchApi, 'readDirSync'>,
  saveDir: string,
): number {
  try {
    const entries = sw.readDirSync(`${saveDir.replace(/\/+$/, '')}/`);
    if (!entries) return 0;
    let count = 0;
    for (const name of entries) {
      const lower = name.toLowerCase();
      if (
        (lower.endsWith('.rpgsave') && lower !== 'config.rpgsave' && lower !== 'global.rpgsave') ||
        (lower.endsWith('.rmmzsave') && lower !== 'config.rmmzsave' && lower !== 'global.rmmzsave')
      ) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function countRgssSaveFiles(
  sw: Pick<SwitchApi, 'readDirSync'>,
  gameDir: string,
): number {
  let count = 0;
  for (const dir of [gameDir, `${gameDir}/Save`, `${gameDir}/save`]) {
    try {
      const entries = sw.readDirSync(`${dir.replace(/\/+$/, '')}/`) ?? [];
      for (const name of entries) {
        if (/\.(?:rvdata2|rvdata|rxdata)$/i.test(name) && /^save/i.test(name)) {
          count++;
        }
      }
    } catch { /* ignore */ }
  }
  return count;
}

function parseGameConfig(
  sw: Pick<SwitchApi, 'readFileSync'>,
  gameDir: string,
): GameConfig {
  const raw = readTextSyncSafe(sw, `${gameDir}/mv-loader.json`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const cfg: GameConfig = {};
    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      cfg.title = parsed.title.trim();
    }
    if (Array.isArray(parsed.skipPlugins)) {
      cfg.skipPlugins = parsed.skipPlugins.filter((s: unknown): s is string => typeof s === 'string' && s.length > 0);
    }
    if (parsed.audioFormat === 'auto' || parsed.audioFormat === 'ogg' || parsed.audioFormat === 'm4a') {
      cfg.audioFormat = parsed.audioFormat;
    }
    if (parsed.displayMode === 'fit' || parsed.displayMode === 'pixel' || parsed.displayMode === 'stretch') {
      cfg.displayMode = parsed.displayMode;
    }
    if (
      parsed.filterMode === 'auto' ||
      parsed.filterMode === 'nearest' ||
      parsed.filterMode === 'bilinear' ||
      parsed.filterMode === 'trilinear' ||
      parsed.filterMode === 'bicubic'
    ) {
      cfg.filterMode = parsed.filterMode;
    }
    if (typeof parsed.fastMenu === 'boolean') {
      cfg.fastMenu = parsed.fastMenu;
    }
    return cfg;
  } catch (err) {
    log(`[games] failed to parse ${gameDir}/mv-loader.json: ${String(err)}`);
    return {};
  }
}

function inspectMvGame(
  sw: Pick<SwitchApi, 'statSync' | 'readFileSync' | 'readDirSync'>,
  id: string,
  folderName: string,
  gameDir: string,
  wwwRoot: string,
  saveDir: string,
): GameEntry {
  const config = parseGameConfig(sw, gameDir);

  let systemTitle: string | null = null;
  let locale = '';
  let encrypted = false;

  const sysText = readTextSyncSafe(sw, `${wwwRoot}/data/System.json`);
  if (sysText) {
    try {
      const sys = JSON.parse(sysText);
      if (typeof sys.gameTitle === 'string' && sys.gameTitle.trim()) {
        systemTitle = sys.gameTitle.trim();
      }
      if (typeof sys.locale === 'string') {
        locale = sys.locale.trim();
      }
      encrypted = Boolean(sys.hasEncryptedImages || sys.hasEncryptedAudio);
    } catch {
      /* malformed or custom System.json */
    }
  }

  const indexHtml = readTextSyncSafe(sw, `${wwwRoot}/index.html`);
  const htmlTitle = parseIndexTitle(indexHtml);
  const title = config.title || systemTitle || htmlTitle || folderName;

  const pluginsSrc = readTextSyncSafe(sw, `${wwwRoot}/js/plugins.js`);
  const pluginCount = countEnabledPlugins(pluginsSrc);
  const saveCount = countSaveFiles(sw, saveDir);
  const iconPath = findGameIconPath(sw, wwwRoot);

  return {
    id,
    folderName,
    engine: 'mv',
    title,
    gameDir,
    wwwRoot,
    saveDir,
    iconPath,
    pluginCount,
    saveCount,
    locale,
    encrypted,
    config,
  };
}

function isValidRgssIni(text: string | null): boolean {
  if (!text) return false;
  // WOLF RPG Editor (e.g. False Myth) also uses Game.ini with SoftModeFlag/Old_DirectX_Use
  // and Data/*.wolf archives; require actual RPG Maker RGSS INI markers.
  return /(?:^\s*\[Game\]\s*$|^\s*Scripts\s*=|^\s*Library\s*=\s*.*RGSS|^\s*RTP\d*\s*=)/im.test(text);
}

function findRgssDescriptor(
  sw: Pick<SwitchApi, 'statSync' | 'readDirSync' | 'readFileSync' | 'writeFileSync'>,
  gameDir: string,
): { iniPath: string | null; hasRgssAssets: boolean } {
  let standardIni: string | null = null;
  if (fileExistsSync(sw, `${gameDir}/Game.ini`)) standardIni = `${gameDir}/Game.ini`;
  else if (fileExistsSync(sw, `${gameDir}/game.ini`)) standardIni = `${gameDir}/game.ini`;

  let customIni: string | null = null;
  let hasArchiveOrData = false;
  try {
    const entries = sw.readDirSync(`${gameDir}/`) ?? [];
    for (const name of entries) {
      const low = name.toLowerCase();
      if (!standardIni && low === 'game.ini') {
        standardIni = `${gameDir}/${name}`;
      } else if (low.endsWith('.ini') && low !== 'nxjs.ini' && low !== 'desktop.ini') {
        customIni = `${gameDir}/${name}`;
      }
      if (/\.(?:rgss3a|rgss2a|rgssad)$/i.test(low)) {
        hasArchiveOrData = true;
      }
    }
  } catch { /* ignore */ }

  if (
    !hasArchiveOrData &&
    (fileExistsSync(sw, `${gameDir}/Data/Scripts.rvdata2`) ||
      fileExistsSync(sw, `${gameDir}/Data/Scripts.rvdata`) ||
      fileExistsSync(sw, `${gameDir}/Data/Scripts.rxdata`) ||
      fileExistsSync(sw, `${gameDir}/Data/System.rvdata2`) ||
      fileExistsSync(sw, `${gameDir}/Data/System.rvdata`) ||
      fileExistsSync(sw, `${gameDir}/Data/System.rxdata`))
  ) {
    hasArchiveOrData = true;
  }

  if (standardIni) {
    if (hasArchiveOrData || isValidRgssIni(readTextSyncSafe(sw, standardIni))) {
      return { iniPath: standardIni, hasRgssAssets: true };
    }
    return { iniPath: null, hasRgssAssets: false };
  }

  // If the developer renamed Game.exe/Game.ini to CustomName.ini, mirror it to Game.ini
  // so mkxp-z reads its [Game] Title / Scripts / RTP configuration seamlessly.
  if (customIni && (hasArchiveOrData || isValidRgssIni(readTextSyncSafe(sw, customIni)))) {
    try {
      const bytes = sw.readFileSync(customIni);
      if (bytes) {
        sw.writeFileSync(`${gameDir}/Game.ini`, bytes);
        log(`[games] mirrored custom INI ${customIni} -> ${gameDir}/Game.ini`);
        return { iniPath: `${gameDir}/Game.ini`, hasRgssAssets: true };
      }
    } catch { /* ignore */ }
    return { iniPath: customIni, hasRgssAssets: true };
  }

  return { iniPath: null, hasRgssAssets: hasArchiveOrData };
}

function inspectRgssGame(
  sw: Pick<SwitchApi, 'statSync' | 'readFileSync' | 'readDirSync'>,
  id: string,
  folderName: string,
  gameDir: string,
  iniPath: string | null,
): GameEntry {
  const config = parseGameConfig(sw, gameDir);
  const iniText = iniPath ? (readTextSyncSafe(sw, iniPath) || '') : '';

  let iniTitle: string | null = null;
  let library = '';
  for (const rawLine of iniText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^title\s*=/i.test(line)) {
      const val = line.replace(/^title\s*=/i, '').trim();
      // Ignore garbled replacement characters from non-UTF-8 Shift-JIS Game.ini
      if (val && !val.includes('\ufffd')) iniTitle = val;
    } else if (/^library\s*=/i.test(line)) {
      library = line.replace(/^library\s*=/i, '').trim().toLowerCase();
    }
  }

  let engine: GameEngine = 'vxace';
  let encrypted = false;
  if (
    library.includes('rgss3') ||
    fileExistsSync(sw, `${gameDir}/Game.rgss3a`) ||
    fileExistsSync(sw, `${gameDir}/Data/Scripts.rvdata2`)
  ) {
    engine = 'vxace';
    encrypted = fileExistsSync(sw, `${gameDir}/Game.rgss3a`);
  } else if (
    library.includes('rgss2') ||
    fileExistsSync(sw, `${gameDir}/Game.rgss2a`) ||
    fileExistsSync(sw, `${gameDir}/Data/Scripts.rvdata`)
  ) {
    engine = 'vx';
    encrypted = fileExistsSync(sw, `${gameDir}/Game.rgss2a`);
  } else if (
    library.includes('rgss1') ||
    fileExistsSync(sw, `${gameDir}/Game.rgssad`) ||
    fileExistsSync(sw, `${gameDir}/Data/Scripts.rxdata`)
  ) {
    engine = 'xp';
    encrypted = fileExistsSync(sw, `${gameDir}/Game.rgssad`);
  }

  const title = config.title || iniTitle || folderName;
  const saveCount = countRgssSaveFiles(sw, gameDir);
  const iconPath = findRgssIconPath(sw, gameDir);

  return {
    id,
    folderName,
    engine,
    title,
    gameDir,
    wwwRoot: gameDir,
    saveDir: gameDir,
    iconPath,
    pluginCount: 0,
    saveCount,
    locale: '',
    encrypted,
    config,
  };
}

/**
 * Locate companion `mkxp-z-switch2.nro` (or `mkxp-z.nro`) for RGSS1/2/3 games.
 */
export function findMkxpzNroPath(
  sw: Pick<SwitchApi, 'statSync'>,
  loaderDir: string,
): string | null {
  const cleanRoot = loaderDir.replace(/\/+$/, '');
  const candidates = [
    `${cleanRoot}/engines/mkxp-z-switch2.nro`,
    `${cleanRoot}/mkxp-z-switch2.nro`,
    `${cleanRoot}/mkxp-z.nro`,
    'sdmc:/switch/mkxp-z/mkxp-z-switch2.nro',
    'sdmc:/switch/mkxp-z/mkxp-z.nro',
    'sdmc:/switch/mkxp-z.nro',
  ];
  for (const c of candidates) {
    if (fileExistsSync(sw, c)) return c;
  }
  return null;
}

export function engineBadgeLabel(engine: GameEngine): string {
  switch (engine) {
    case 'mv': return 'MV';
    case 'mz': return 'MZ';
    case 'vxace': return 'VX ACE';
    case 'vx': return 'VX';
    case 'xp': return 'XP';
  }
}

export function engineFullLabel(engine: GameEngine): string {
  switch (engine) {
    case 'mv': return 'RPG Maker MV (nx.js)';
    case 'mz': return 'RPG Maker MZ (nx.js WebGL2)';
    case 'vxace': return 'RPG Maker VX Ace (mkxp-z)';
    case 'vx': return 'RPG Maker VX (mkxp-z)';
    case 'xp': return 'RPG Maker XP (mkxp-z)';
  }
}

function tryInspectFolder(
  sw: Pick<SwitchApi, 'statSync' | 'readFileSync' | 'readDirSync' | 'writeFileSync'>,
  id: string,
  folderName: string,
  gameDir: string,
): GameEntry | null {
  const nestedWww = `${gameDir}/www`;

  // 0. RPG Maker MZ layout: <gameDir>/js/rmmz_core.js or <gameDir>/www/js/rmmz_core.js
  if (fileExistsSync(sw, `${gameDir}/js/rmmz_core.js`)) {
    const mz = inspectMvGame(sw, id, folderName, gameDir, gameDir, `${gameDir}/save`);
    mz.engine = 'mz';
    return mz;
  }
  if (fileExistsSync(sw, `${nestedWww}/js/rmmz_core.js`)) {
    const mz = inspectMvGame(sw, id, folderName, gameDir, nestedWww, `${gameDir}/save`);
    mz.engine = 'mz';
    return mz;
  }

  // 1. Standard RPG Maker MV layout: <gameDir>/www/index.html
  if (fileExistsSync(sw, `${nestedWww}/index.html`)) {
    return inspectMvGame(sw, id, folderName, gameDir, nestedWww, `${gameDir}/save`);
  }

  // 2. Flat MV web export layout: <gameDir>/index.html + js/rpg_core.js
  if (
    fileExistsSync(sw, `${gameDir}/index.html`) &&
    fileExistsSync(sw, `${gameDir}/js/rpg_core.js`)
  ) {
    return inspectMvGame(sw, id, folderName, gameDir, gameDir, `${gameDir}/save`);
  }

  // 3. RPG Maker VX Ace / VX / XP layout: Game.ini, <CustomName>.ini, *.rgss3a/2a/ad, or Data/Scripts.rvdata2
  const rgss = findRgssDescriptor(sw, gameDir);
  if (rgss.iniPath || rgss.hasRgssAssets) {
    return inspectRgssGame(sw, id, folderName, gameDir, rgss.iniPath);
  }

  return null;
}

export function inspectSingleMzGame(
  sw: Pick<SwitchApi, 'statSync' | 'readFileSync' | 'readDirSync'>,
  gameDir: string,
): GameEntry | null {
  const cleanDir = gameDir.replace(/\/+$/, '');
  const folderName = cleanDir.split('/').pop() || 'game';
  let wwwRoot: string | null = null;
  if (fileExistsSync(sw, `${cleanDir}/js/rmmz_core.js`)) {
    wwwRoot = cleanDir;
  } else if (fileExistsSync(sw, `${cleanDir}/www/js/rmmz_core.js`)) {
    wwwRoot = `${cleanDir}/www`;
  }
  if (!wwwRoot) return null;
  const entry = inspectMvGame(sw, folderName, folderName, cleanDir, wwwRoot, `${cleanDir}/save`);
  entry.engine = 'mz';
  return entry;
}

export function inspectSingleMvGame(
  sw: Pick<SwitchApi, 'statSync' | 'readFileSync' | 'readDirSync'>,
  gameDir: string,
): GameEntry | null {
  const cleanDir = gameDir.replace(/\/+$/, '');
  const folderName = cleanDir.split('/').pop() || 'game';
  const nestedWww = `${cleanDir}/www`;
  if (fileExistsSync(sw, `${nestedWww}/index.html`)) {
    return inspectMvGame(sw, folderName, folderName, cleanDir, nestedWww, `${cleanDir}/save`);
  }
  if (
    fileExistsSync(sw, `${cleanDir}/index.html`) &&
    fileExistsSync(sw, `${cleanDir}/js/rpg_core.js`)
  ) {
    return inspectMvGame(sw, folderName, folderName, cleanDir, cleanDir, `${cleanDir}/save`);
  }
  return null;
}

/**
 * Scan `<loaderDir>` for RPG Maker MV and RPG Maker XP/VX/VX Ace games
 * (including 1-level nested unzip folders).
 */
export function discoverGames(
  sw: Pick<SwitchApi, 'statSync' | 'readFileSync' | 'readDirSync'> & Partial<Pick<SwitchApi, 'writeFileSync'>>,
  loaderDir: string,
): GameEntry[] {
  const cleanRoot = loaderDir.replace(/\/+$/, '');
  const games: GameEntry[] = [];
  const fullSw = {
    ...sw,
    writeFileSync: sw.writeFileSync ?? (() => {}),
  };

  const scanRoot = (rootDir: string, idPrefix: string) => {
    let entries: string[] = [];
    try {
      entries = sw.readDirSync(`${rootDir}/`) ?? [];
    } catch {
      return;
    }

    for (const name of entries) {
      if (!name || name.startsWith('.') || IGNORED_DIRS.has(name.toLowerCase())) {
        continue;
      }
      // Skip files at top level (e.g. *.nro, nxjs.ini, debug.log, loader-state.json)
      if (/\.(?:nro|ini|log|json|txt|md)$/i.test(name)) {
        continue;
      }
      const gameDir = `${rootDir}/${name}`;
      const fullId = idPrefix ? `${idPrefix}/${name}` : name;
      const direct = tryInspectFolder(fullSw, fullId, name, gameDir);
      if (direct) {
        log(`[games] + '${direct.title}' [${direct.engine}] (${direct.gameDir})`);
        games.push(direct);
        continue;
      }

      // Check 1 level deeper in case the user unzipped a folder containing an inner game folder
      let foundNested = false;
      try {
        const subEntries = sw.readDirSync(`${gameDir}/`) ?? [];
        for (const sub of subEntries) {
          if (!sub || sub.startsWith('.') || IGNORED_DIRS.has(sub.toLowerCase())) continue;
          const subDir = `${gameDir}/${sub}`;
          const nested = tryInspectFolder(fullSw, `${fullId}/${sub}`, name, subDir);
          if (nested) {
            log(`[games] + '${nested.title}' [${nested.engine}] (nested: ${nested.gameDir})`);
            games.push(nested);
            foundNested = true;
          }
        }
        if (!foundNested) {
          log(`[games] skipped '${name}' (contents: ${subEntries.slice(0, 8).join(', ') || 'empty'})`);
        }
      } catch {
        /* not a directory */
      }
    }
  };

  // Primary location: <loaderDir>/games/
  scanRoot(`${cleanRoot}/games`, 'games');
  // Backwards-compatible fallback: games directly inside <loaderDir>/
  scanRoot(cleanRoot, '');

  // 4. Fallback single-game drop-in mode: <loaderDir>/www/index.html directly beside the .nro
  if (games.length === 0 && fileExistsSync(sw, `${cleanRoot}/www/index.html`)) {
    const folderLabel = cleanRoot.split('/').pop() || 'game';
    games.push(
      inspectMvGame(sw, '.', folderLabel, cleanRoot, `${cleanRoot}/www`, `${cleanRoot}/save`),
    );
  }

  games.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  log(`[games] discovered ${games.length} game(s) in ${cleanRoot}`);
  return games;
}

export function loadLastSelectedGameId(
  sw: Pick<SwitchApi, 'readFileSync'>,
  loaderDir: string,
): string | null {
  const text = readTextSyncSafe(sw, `${loaderDir.replace(/\/+$/, '')}/loader-state.json`);
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return typeof data?.lastGameId === 'string' ? data.lastGameId : null;
  } catch {
    return null;
  }
}

export function saveLastSelectedGameId(
  sw: Pick<SwitchApi, 'statSync' | 'mkdirSync' | 'writeFileSync'>,
  loaderDir: string,
  gameId: string,
): void {
  try {
    const cleanRoot = loaderDir.replace(/\/+$/, '');
    ensureDir(sw, cleanRoot);
    sw.writeFileSync(`${cleanRoot}/loader-state.json`, JSON.stringify({ lastGameId: gameId }, null, 2));
  } catch {
    /* best-effort persistence */
  }
}
