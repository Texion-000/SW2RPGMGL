/**
 * Switch 2 SD-card & console logger with per-engine log files (`mv.log`, `mz.log`)
 * and structured game/engine/encryption diagnostic headers for easy bug reporting.
 */
import type { AssetReader } from './assets';
import type { GameEntry } from './games';

export const SW2RPGMGL_VERSION = '0.3.2';

export interface SwitchApi {
  argv?: string[];
  entrypoint?: string;
  readFile(path: string): Promise<ArrayBuffer | null>;
  readFileSync(path: string): ArrayBuffer | null;
  writeFileSync(path: string, data: string | ArrayBuffer | Uint8Array): void;
  appendFileSync?(path: string, data: string | ArrayBuffer | Uint8Array): void;
  mkdirSync(path: string): void;
  removeSync(path: string): void;
  statSync(path: string): { mode: number; size?: number } | null;
  readDirSync(path: string): string[] | null;
  exit(): void;
  memoryUsage?(): {
    used?: number;
    total?: number;
    usedHeapSize?: number;
    totalHeapSize?: number;
    heapSizeLimit?: number;
  };
  version?: Record<string, string>;
  Application?: {
    new (path: string): {
      launch(...args: string[]): never;
    };
    self?: {
      launch?(...args: string[]): never;
    };
  };
}

export const DEFAULT_LOADER_DIR = 'sdmc:/switch/SW2RPGMGL';

export interface LaunchArgs {
  loaderDir: string;
  directGameDir: string | null;
  returnNroPath: string | null;
}

function normalizeSdmcPath(raw?: string | null): string | null {
  const s = String(raw ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s) return null;
  if (s.startsWith('/')) return `sdmc:${s}`;
  if (/^sdmc:\//i.test(s)) return s;
  return null;
}

let resolvedLoaderDir: string | null = null;
let activeLogFileName = 'mv.log';
let logReady = false;
const memoryLog: string[] = [];
const MAX_MEM_LOG = 200;

export function getSwitch(): SwitchApi | null {
  return ((globalThis as any).Switch as SwitchApi | undefined) ?? null;
}

/**
 * Derive the loader's base directory from `Switch.argv[0]` (the path to this `.nro`).
 * Strips a trailing `/engines` folder when the engine lives inside `<launcher>/engines/`.
 */
export function resolveLoaderDirFromArgv(argv0?: string | null): string {
  const normalized = normalizeSdmcPath(argv0);
  if (!normalized) return DEFAULT_LOADER_DIR;

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 'sdmc:'.length) {
    return DEFAULT_LOADER_DIR;
  }
  let dir = normalized.slice(0, lastSlash);
  if (/\/engines$/i.test(dir)) {
    dir = dir.slice(0, -'/engines'.length);
  }
  return dir || DEFAULT_LOADER_DIR;
}

/**
 * Parse `Switch.argv` for direct-launch handoff from `SW2RPGMGL.nro`.
 * Supported calling conventions:
 *   1. `[engineNro, engineNro, gameDir, returnNro]` (nx.js `.nro` self-romfs bootstrap)
 *   2. `[engineNro, gameDir, returnNro]` (if invoked without duplicate self-nro arg)
 *   3. `[standaloneNro]` (standalone mode -> shows built-in Game Select fallback)
 */
export function resolveLaunchArgs(argv?: string[] | null): LaunchArgs {
  const args = Array.isArray(argv) ? argv : [];
  let directGameDir: string | null = null;
  let returnNroPath: string | null = null;

  if (args.length >= 3 && /\.nro$/i.test(String(args[1] ?? '').trim())) {
    directGameDir = normalizeSdmcPath(args[2]);
    returnNroPath = normalizeSdmcPath(args[3]);
  } else if (args.length >= 2 && !/\.nro$/i.test(String(args[1] ?? '').trim())) {
    directGameDir = normalizeSdmcPath(args[1]);
    returnNroPath = normalizeSdmcPath(args[2]);
  }

  const loaderDir = returnNroPath
    ? resolveLoaderDirFromArgv(returnNroPath)
    : resolveLoaderDirFromArgv(args[0]);

  return { loaderDir, directGameDir, returnNroPath };
}

export function getLoaderDir(sw?: Pick<SwitchApi, 'argv'> | null): string {
  if (sw && Array.isArray(sw.argv) && sw.argv.length > 0) {
    return resolveLaunchArgs(sw.argv).loaderDir;
  }
  if (resolvedLoaderDir) return resolvedLoaderDir;
  const activeSw = getSwitch();
  resolvedLoaderDir = resolveLaunchArgs(activeSw?.argv).loaderDir;
  return resolvedLoaderDir;
}

export function getLogFileName(): string {
  return activeLogFileName;
}

export function getLogPath(sw?: Pick<SwitchApi, 'argv'> | null, logFileName?: string): string {
  return `${getLoaderDir(sw)}/log/${logFileName || activeLogFileName}`;
}

export function ensureDir(fs: Pick<SwitchApi, 'statSync' | 'mkdirSync'>, dir: string): void {
  const clean = dir.replace(/\/+$/, '');
  const parts = clean.split('/');
  let acc = parts[0]; // e.g. 'sdmc:'
  for (let i = 1; i < parts.length; i++) {
    acc += '/' + parts[i];
    try {
      if (!fs.statSync(acc)) fs.mkdirSync(acc);
    } catch {
      try { fs.mkdirSync(acc); } catch { /* ignore */ }
    }
  }
}

function formatRuntimeSummary(sw: SwitchApi): string {
  const parts: string[] = [];
  const scr = (globalThis as any).screen;
  if (scr?.width && scr?.height) {
    parts.push(`screen=${scr.width}x${scr.height}`);
  }
  const ver = sw.version;
  if (ver && typeof ver === 'object') {
    for (const k of ['nxjs', 'v8', 'cairo', 'hos', 'switch']) {
      if (ver[k]) parts.push(`${k}=${ver[k]}`);
    }
  }
  try {
    const m = sw.memoryUsage?.();
    if (m) {
      const mib = (v?: number) => (typeof v === 'number' && v > 0 ? `${(v / (1024 * 1024)).toFixed(1)}MiB` : null);
      const used = mib(m.usedHeapSize ?? m.used);
      const limit = mib(m.heapSizeLimit ?? m.totalHeapSize ?? m.total);
      if (used || limit) {
        parts.push(`heap=${used || '?'}/${limit || '?'}`);
      }
    }
  } catch { /* ignore */ }
  return parts.join(' | ') || 'Switch 2 (kaiHEN / OunceVK)';
}

export function initLog(logFileName = 'mv.log', engineLabel = 'RPG Maker MV Engine'): void {
  activeLogFileName = logFileName;
  memoryLog.length = 0;
  const sw = getSwitch();
  if (!sw) return;
  const { loaderDir, directGameDir, returnNroPath } = resolveLaunchArgs(sw.argv);
  resolvedLoaderDir = loaderDir;
  const logDir = `${resolvedLoaderDir}/log`;
  const logPath = `${logDir}/${activeLogFileName}`;
  let isoNow = '';
  try { isoNow = new Date().toISOString(); } catch { /* ignore */ }
  const divider = '='.repeat(72);
  const headerLines = [
    divider,
    `SW2RPGMGL v${SW2RPGMGL_VERSION} — ${engineLabel} (${activeLogFileName})`,
    divider,
    ...(isoNow ? [`Time:       ${isoNow}`] : []),
    `Loader Dir: ${resolvedLoaderDir}`,
    `Log File:   ${logPath}`,
    `Engine NRO: ${sw.argv?.[0] || '(unknown)'}`,
    `Game Arg:   ${directGameDir || '(standalone game select)'}`,
    `Return NRO: ${returnNroPath || '(none)'}`,
    `Runtime:    ${formatRuntimeSummary(sw)}`,
    `argv:       ${JSON.stringify(sw.argv ?? [])}`,
    '-'.repeat(72),
  ];
  try {
    ensureDir(sw, logDir);
    sw.writeFileSync(logPath, headerLines.join('\n') + '\n');
    logReady = true;
  } catch {
    logReady = false;
  }
}

export function log(msg: string): void {
  const line = `[${Math.round(performance.now())}ms] ${msg}`;
  memoryLog.push(line);
  if (memoryLog.length > MAX_MEM_LOG) memoryLog.shift();
  try { console.log(line); } catch { /* ignore */ }
  if (!logReady) return;
  const sw = getSwitch();
  if (!sw) return;
  const logPath = getLogPath(sw);
  try {
    if (typeof sw.appendFileSync === 'function') {
      sw.appendFileSync(logPath, line + '\n');
    } else {
      const prev = sw.readFileSync(logPath);
      const prevText = prev ? new TextDecoder().decode(prev) : '';
      sw.writeFileSync(logPath, prevText + line + '\n');
    }
  } catch {
    /* ignore SD write glitches during logging */
  }
}

export function recentLogs(): string[] {
  return memoryLog.slice();
}

// ============================================================================
// Structured Game, Engine & Encryption Diagnostics
// ============================================================================

export interface GameDiagnosticsOptions {
  rendererMode: string;
  displayMode?: string;
  filterMode?: string;
}

export interface GameDiagnosticsSummary {
  version: string;
  title: string;
  systemTitle: string | null;
  packageInfo: string | null;
  engine: string;
  folderName: string;
  layout: string;
  gameDir: string;
  wwwRoot: string;
  saveDir: string;
  locale: string;
  versionId: number | string | null;
  configuredResolution: string | null;
  rendererMode: string;
  displayMode: string;
  filterMode: string;
  encryptionSummary: string;
  imageFormats: string[];
  audioFormats: string[];
  saveSummary: string;
  jpMapCount: number;
  configOverrides: string;
  totalPlugins: number;
  enabledPlugins: string[];
  lines: string[];
}

function readUtf8Safe(sw: Pick<SwitchApi, 'readFileSync'>, path: string): string | null {
  try {
    const buf = sw.readFileSync(path);
    if (!buf) return null;
    const text = new TextDecoder().decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

function fileExistsSafe(sw: Pick<SwitchApi, 'statSync'>, path: string): boolean {
  try {
    return sw.statSync(path) !== null;
  } catch {
    return false;
  }
}

function parsePluginList(pluginsJs: string | null): { total: number; enabled: string[] } {
  if (!pluginsJs) return { total: 0, enabled: [] };
  const eqIdx = pluginsJs.indexOf('[');
  const lastIdx = pluginsJs.lastIndexOf(']');
  if (eqIdx >= 0 && lastIdx > eqIdx) {
    try {
      const arr = JSON.parse(pluginsJs.slice(eqIdx, lastIdx + 1));
      if (Array.isArray(arr)) {
        const enabled: string[] = [];
        let total = 0;
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          total++;
          if (item.status && typeof item.name === 'string' && item.name.trim()) {
            enabled.push(item.name.trim());
          }
        }
        return { total, enabled };
      }
    } catch {
      /* fallback to regex scan below */
    }
  }
  const enabled: string[] = [];
  let total = 0;
  const objRe = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"status"\s*:\s*(true|false)/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(pluginsJs)) !== null) {
    total++;
    if (m[2] === 'true') enabled.push(m[1]);
  }
  return { total, enabled };
}

function wrapListLines(prefix: string, contIndent: string, items: string[], maxWidth = 96): string[] {
  if (items.length === 0) return [`${prefix}(none)`];
  const out: string[] = [];
  let cur = prefix;
  for (let i = 0; i < items.length; i++) {
    const token = i < items.length - 1 ? `${items[i]}, ` : items[i];
    if (cur.length > prefix.length && cur.length + token.length > maxWidth) {
      out.push(cur.replace(/,\s*$/, ''));
      cur = contIndent + token;
    } else {
      cur += token;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function collectGameDiagnostics(
  sw: Pick<SwitchApi, 'readFileSync' | 'statSync' | 'readDirSync'>,
  game: GameEntry,
  assets: Pick<AssetReader, 'readDirSync' | 'exists'> & Partial<Pick<AssetReader, 'jpMapCount'>>,
  options: GameDiagnosticsOptions,
): GameDiagnosticsSummary {
  const cleanGameDir = game.gameDir.replace(/\/+$/, '');
  const cleanWww = game.wwwRoot.replace(/\/+$/, '');
  const cleanSave = game.saveDir.replace(/\/+$/, '');
  const layout = cleanWww.toLowerCase() !== cleanGameDir.toLowerCase() ? 'nested (www/)' : 'flat root';

  // 1. Inspect System.json
  let systemTitle: string | null = null;
  let locale = game.locale || '';
  let versionId: number | string | null = null;
  let hasEncImg = false;
  let hasEncAud = false;
  let encKeyInfo = 'none';
  let sysResolution: string | null = null;

  const sysText = readUtf8Safe(sw, `${cleanWww}/data/System.json`);
  if (sysText) {
    try {
      const sys = JSON.parse(sysText);
      if (typeof sys.gameTitle === 'string' && sys.gameTitle.trim()) {
        systemTitle = sys.gameTitle.trim();
      }
      if (typeof sys.locale === 'string' && sys.locale.trim()) {
        locale = sys.locale.trim();
      }
      if (sys.versionId !== undefined && sys.versionId !== null) {
        versionId = sys.versionId;
      }
      hasEncImg = Boolean(sys.hasEncryptedImages);
      hasEncAud = Boolean(sys.hasEncryptedAudio);
      if (typeof sys.encryptionKey === 'string' && sys.encryptionKey.trim()) {
        encKeyInfo = `present (${sys.encryptionKey.trim().length} chars)`;
      }
      if (sys.advanced && typeof sys.advanced === 'object') {
        const swW = sys.advanced.screenWidth;
        const swH = sys.advanced.screenHeight;
        const uiW = sys.advanced.uiAreaWidth;
        const uiH = sys.advanced.uiAreaHeight;
        if (swW && swH) {
          sysResolution = uiW && uiH && (uiW !== swW || uiH !== swH)
            ? `${swW}x${swH} (UI ${uiW}x${uiH})`
            : `${swW}x${swH}`;
        }
      }
    } catch { /* ignore malformed or encrypted System.json */ }
  }

  // 2. Inspect package.json (NW.js manifest)
  let packageInfo: string | null = null;
  let pkgResolution: string | null = null;
  for (const pkgPath of [`${cleanWww}/package.json`, `${cleanGameDir}/package.json`]) {
    const pkgText = readUtf8Safe(sw, pkgPath);
    if (!pkgText) continue;
    try {
      const pkg = JSON.parse(pkgText);
      const pName = typeof pkg.name === 'string' ? pkg.name.trim() : '';
      const pVer = typeof pkg.version === 'string' ? pkg.version.trim() : '';
      if (pName || pVer) {
        packageInfo = [pName, pVer ? `v${pVer.replace(/^v/i, '')}` : ''].filter(Boolean).join(' ');
      }
      const ww = pkg.window?.width;
      const wh = pkg.window?.height;
      if (ww && wh) pkgResolution = `${ww}x${wh}`;
      break;
    } catch { /* ignore */ }
  }
  const configuredResolution = sysResolution || pkgResolution;

  // 3. Scan asset extensions & custom encryption containers
  const imgExts = new Set<string>();
  for (const sub of ['img/system', 'img/titles1', 'img/pictures', 'img/characters']) {
    for (const f of assets.readDirSync(sub)) {
      const dot = f.lastIndexOf('.');
      if (dot > 0) imgExts.add(f.slice(dot).toLowerCase());
      if (imgExts.size >= 5) break;
    }
    if (imgExts.size > 0) break;
  }

  const audExts = new Set<string>();
  for (const sub of ['audio/bgm', 'audio/se', 'audio/me', 'audio/bgs']) {
    for (const f of assets.readDirSync(sub)) {
      const dot = f.lastIndexOf('.');
      if (dot > 0) audExts.add(f.slice(dot).toLowerCase());
    }
  }

  const dataFiles = assets.readDirSync('data');
  const pluginDirFiles = assets.readDirSync('js/plugins');
  const pluginsJs = readUtf8Safe(sw, `${cleanWww}/js/plugins.js`);
  const parsedPlugins = parsePluginList(pluginsJs);

  const hasOmoriPlugins = pluginDirFiles.some((f) => /\.omori$/i.test(f));
  const hasOmoriData = dataFiles.some((f) => /\.(?:kel|pluto|aubrey|hero)$/i.test(f));
  const hasRirukaIni =
    fileExistsSafe(sw, `${cleanGameDir}/Riruka24.ini`) ||
    fileExistsSafe(sw, `${cleanWww}/Riruka24.ini`);

  const hasKageDesuPkd =
    pluginDirFiles.some((f) => /\.(?:pkd|bin)$/i.test(f)) ||
    dataFiles.some((f) => /\.pkd$/i.test(f)) ||
    Boolean(pluginsJs && /(?:PKD_Protector|RmmzEncripter|KageDesu.*Protector)/i.test(pluginsJs));

  const hasHashedDataOnly =
    !sysText &&
    dataFiles.length > 0 &&
    dataFiles.every((f) => /^[0-9a-f]{16,}(?:\.[a-z0-9_]+)?$/i.test(f));

  // Build concise, accurate encryption summary
  const encSchemes: string[] = [];
  if (hasOmoriPlugins || hasOmoriData) {
    encSchemes.push(
      `OMORI AES-256-CTR (.OMORI/.KEL/.PLUTO, Riruka24.ini=${hasRirukaIni ? 'present' : 'MISSING!'})`,
    );
  }
  if (hasKageDesuPkd) {
    encSchemes.push('KageDesu / PKD Protector');
  }
  if (hasHashedDataOnly) {
    encSchemes.push('Custom Hashed Container (e.g. TCOAAL)');
  }
  if (
    hasEncImg ||
    hasEncAud ||
    imgExts.has('.rpgmvp') ||
    imgExts.has('.png_') ||
    audExts.has('.rpgmvo') ||
    audExts.has('.ogg_') ||
    audExts.has('.rpgmvm') ||
    audExts.has('.m4a_')
  ) {
    const stdTag = game.engine === 'mz' ? 'Standard MZ (.png_/.ogg_)' : 'Standard MV (.rpgmvp/.rpgmvo)';
    encSchemes.push(`${stdTag} [img=${hasEncImg}, audio=${hasEncAud}, key=${encKeyInfo}]`);
  }
  if (!sysText && dataFiles.length === 0) {
    encSchemes.push('WARNING: data/ missing or empty (unpacked single-file EXE?)');
  }
  const encryptionSummary = encSchemes.length > 0
    ? encSchemes.join(' + ')
    : `Unencrypted (img=${hasEncImg}, audio=${hasEncAud}, key=${encKeyInfo})`;

  // 4. Save directory inspection
  let hasGlobalSave = false;
  let hasConfigSave = false;
  try {
    for (const s of sw.readDirSync(`${cleanSave}/`) ?? []) {
      const low = s.toLowerCase();
      if (low === 'global.rpgsave' || low === 'global.rmmzsave') hasGlobalSave = true;
      if (low === 'config.rpgsave' || low === 'config.rmmzsave') hasConfigSave = true;
    }
  } catch { /* ignore */ }
  const saveExtras = [hasGlobalSave ? 'global' : '', hasConfigSave ? 'config' : ''].filter(Boolean);
  const saveSummary = `${game.saveCount} slot save(s)` + (saveExtras.length ? ` (+ ${saveExtras.join(', ')})` : '');

  // 5. Overrides & FTP mapping
  const cfgKeys = Object.keys(game.config || {});
  const configOverrides = cfgKeys.length > 0 ? JSON.stringify(game.config) : 'defaults';
  const jpMapCount = assets.jpMapCount ?? 0;

  const imageFormats = [...imgExts].sort();
  const audioFormats = [...audExts].sort();
  const displayMode = options.displayMode || game.config.displayMode || 'fit';
  const filterMode = options.filterMode || game.config.filterMode || 'auto';
  const engineName = game.engine === 'mz' ? 'RPG Maker MZ' : 'RPG Maker MV';

  const titleExtra: string[] = [];
  if (systemTitle && systemTitle !== game.title) titleExtra.push(`System.json="${systemTitle}"`);
  if (packageInfo) titleExtra.push(`pkg=${packageInfo}`);
  if (versionId !== null) titleExtra.push(`versionId=${versionId}`);

  const lines: string[] = [
    `[diag] ================ GAME DIAGNOSTIC SUMMARY ================`,
    `[diag] Game Title:   ${game.title}${titleExtra.length ? ` (${titleExtra.join(', ')})` : ''}`,
    `[diag] Folder:       ${game.folderName}  [layout: ${layout}]`,
    `[diag] Engine:       ${engineName}  |  SW2RPGMGL v${SW2RPGMGL_VERSION}`,
    `[diag] Renderer:     ${options.rendererMode}  |  display=${displayMode}  |  filter=${filterMode}` +
      `${configuredResolution ? `  |  res=${configuredResolution}` : ''}` +
      `${locale ? `  |  locale=${locale}` : ''}`,
    `[diag] Encryption:   ${encryptionSummary}`,
    `[diag] Asset Types:  images=[${imageFormats.join(', ') || 'none'}]  audio=[${audioFormats.join(', ') || 'none'}]` +
      `${jpMapCount > 0 ? `  ftpMap=${jpMapCount} files` : ''}`,
    `[diag] Paths:        game=${cleanGameDir}  |  www=${cleanWww}  |  save=${cleanSave}`,
    `[diag] Saves/Config: ${saveSummary}  |  mv-loader.json=${configOverrides}`,
    `[diag] Plugins:      ${parsedPlugins.enabled.length} enabled / ${parsedPlugins.total} total`,
    ...wrapListLines('[diag]   Enabled:    ', '[diag]               ', parsedPlugins.enabled, 108),
    `[diag] =========================================================`,
  ];

  return {
    version: SW2RPGMGL_VERSION,
    title: game.title,
    systemTitle,
    packageInfo,
    engine: engineName,
    folderName: game.folderName,
    layout,
    gameDir: cleanGameDir,
    wwwRoot: cleanWww,
    saveDir: cleanSave,
    locale,
    versionId,
    configuredResolution,
    rendererMode: options.rendererMode,
    displayMode,
    filterMode,
    encryptionSummary,
    imageFormats,
    audioFormats,
    saveSummary,
    jpMapCount,
    configOverrides,
    totalPlugins: parsedPlugins.total,
    enabledPlugins: parsedPlugins.enabled,
    lines,
  };
}

export function logGameDiagnostics(
  sw: Pick<SwitchApi, 'readFileSync' | 'statSync' | 'readDirSync'>,
  game: GameEntry,
  assets: Pick<AssetReader, 'readDirSync' | 'exists'> & Partial<Pick<AssetReader, 'jpMapCount'>>,
  options: GameDiagnosticsOptions,
): GameDiagnosticsSummary {
  const summary = collectGameDiagnostics(sw, game, assets, options);
  for (const line of summary.lines) {
    log(line);
  }
  return summary;
}

export function logRuntimeDiagnostics(
  runtime: Record<string, any>,
  options?: { skippedScripts?: string[] },
): void {
  try {
    const Utils = runtime?.Utils;
    const PIXI = runtime?.PIXI;
    const Graphics = runtime?.Graphics;
    const coreName = Utils?.RPGMAKER_NAME || '?';
    const coreVer = Utils?.RPGMAKER_VERSION || '?';
    const pixiVer = PIXI?.VERSION || '?';
    const gw = Graphics?.width || Graphics?.boxWidth || '?';
    const gh = Graphics?.height || Graphics?.boxHeight || '?';

    const frameworks: string[] = [];
    if (runtime?.VisuMZ) frameworks.push('VisuMZ');
    if (runtime?.Imported && typeof runtime.Imported === 'object') {
      const impKeys = Object.keys(runtime.Imported);
      if (impKeys.some((k) => /^YEP_|Yanfly/i.test(k)) || runtime?.Yanfly) frameworks.push('Yanfly');
      if (impKeys.some((k) => /^MOG_/i.test(k)) || runtime?.Moghunter) frameworks.push('MogHunter');
      if (impKeys.some((k) => /Tiled/i.test(k))) frameworks.push('Tiled');
    } else if (runtime?.Yanfly) {
      frameworks.push('Yanfly');
    }
    if (runtime?.LIVE2DCUBISMFRAMEWORK || runtime?.Live2D || PIXI?.live2d) {
      frameworks.push('Live2D');
    }

    log(
      `[diag-runtime] Core=${coreName} ${coreVer} | PIXI=v${pixiVer} | Resolution=${gw}x${gh}` +
      `${frameworks.length ? ` | Detected=[${frameworks.join(', ')}]` : ''}`,
    );
    const skipped = options?.skippedScripts?.filter(Boolean) ?? [];
    if (skipped.length > 0) {
      log(`[diag-runtime] Skipped PC-only/configured plugins (${skipped.length}): ${skipped.join(', ')}`);
    }
  } catch { /* ignore */ }
}
