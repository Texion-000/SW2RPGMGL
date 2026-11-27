/**
 * SW2RPGMGL — RPG Maker MZ Engine Entrypoint (engines/mz-engine-switch2.nro)
 *
 * Runs under nx.js compiled with ounce-devkit (libounce + OunceVK Hardware WebGL2/GLES3 + FFmpeg).
 * IMPORTANT: Never calls `screen.getContext('2d')` so `screen.getContext('webgl2')` succeeds cleanly
 * for PixiJS v5! The loading screen renders via a lightweight WebGL2 fullscreen textured quad.
 */
import { createAssetReader } from './assets';
import { createBrowserHost } from './browser-host';
import { discoverGames, inspectSingleMzGame, type GameEntry } from './games';
import { createInputBridge } from './input';
import {
  SW2RPGMGL_VERSION,
  getSwitch,
  initLog,
  log,
  logGameDiagnostics,
  logRuntimeDiagnostics,
  recentLogs,
  resolveLaunchArgs,
} from './log';
import { mountIndexHtmlCanvases } from './mv-compat';
import {
  createMzScriptPreparer,
  extractMzMainScripts,
  installEffekseerShim,
  installMzCompat,
  installMzFontCompat,
} from './mz-compat';
import { installNodeCompat } from './node-compat';
import { createWebGLSplash } from './webgl-splash';

declare const screen: any;

function returnToLauncher(returnNroPath?: string | null): void {
  const sw = getSwitch();
  try {
    if (returnNroPath && typeof sw?.Application === 'function') {
      new sw.Application(returnNroPath).launch();
      return;
    }
  } catch { /* ignore */ }
  sw?.exit();
}

async function launchMzGame(
  sw: NonNullable<ReturnType<typeof getSwitch>>,
  game: GameEntry,
  returnNroPath: string | null,
): Promise<void> {
  const assets = createAssetReader(game.wwwRoot, sw);
  logGameDiagnostics(sw, game, assets, {
    rendererMode: 'Hardware WebGL2 (OunceVK ES3)',
    displayMode: game.config.displayMode ?? 'fit',
    filterMode: game.config.filterMode ?? 'auto',
  });

  const scriptPreparer = createMzScriptPreparer(game.config.skipPlugins);
  const host = createBrowserHost(assets, scriptPreparer, screen, {
    gameTitle: game.title,
    displayMode: game.config.displayMode ?? 'fit',
    filterMode: game.config.filterMode ?? 'auto',
    enableWebGL: true,
  });

  let exitingGame = false;
  const exitGameCleanly = () => {
    if (exitingGame) return;
    exitingGame = true;
    log(`[mz-exit] Game requested exit -> returning to ${returnNroPath || 'hbmenu'}`);
    returnToLauncher(returnNroPath);
  };
  (globalThis as any).close = exitGameCleanly;

  // Bring up WebGL2 immediately so we can show the loading screen from 0% -> 100%
  const gl = host.ensureWebGLContext();
  const splash = createWebGLSplash(
    gl,
    `SW2RPGMGL v${SW2RPGMGL_VERSION}  •  RPG Maker MZ (kaiHEN / OunceVK WebGL2)`,
    '#3dd6a5',
  );
  await splash?.draw(game.title, 0.06, 'Initializing Switch 2 MZ runtime (WebGL2)...', game.gameDir);

  const runtime = globalThis as any;
  installNodeCompat(
    runtime,
    sw,
    game.wwwRoot,
    game.saveDir,
    log,
    game.gameDir,
    game.title,
  );
  installEffekseerShim(runtime);

  const indexBytes = await assets.read('index.html');
  if (indexBytes) {
    const extraCanvases = mountIndexHtmlCanvases(
      runtime.document,
      new TextDecoder().decode(indexBytes),
    );
    if (extraCanvases.length > 0) {
      log(`[mz] Pre-mounted custom index.html canvas(es): ${extraCanvases.join(', ')}`);
    }
  }

  let mainJsSource = '';
  const mainBytes = await assets.read('js/main.js');
  if (mainBytes) {
    mainJsSource = new TextDecoder().decode(mainBytes);
  }
  const scripts = extractMzMainScripts(mainJsSource);
  log(`[mz] Loading ${scripts.length} core scripts (${scripts.join(', ')})`);

  for (let i = 0; i < scripts.length; i++) {
    const pct = 0.1 + 0.35 * ((i + 1) / Math.max(1, scripts.length));
    await splash?.draw(game.title, pct, `Loading MZ core scripts (${i + 1}/${scripts.length})...`, scripts[i]);
    await host.loadScript(scripts[i]);
  }

  if (runtime.PluginManager && Array.isArray(runtime.$plugins)) {
    const enabledCount = runtime.$plugins.filter((p: any) => p?.status).length;
    log(`[mz] Setting up plugins (${runtime.$plugins.length} entries, ${enabledCount} enabled)`);
    await splash?.draw(
      game.title,
      0.55,
      `Loading ${enabledCount} RPG Maker MZ plugins...`,
      'Scanning & preparing game plugins from SD card',
    );
    runtime.PluginManager.setup(runtime.$plugins);
    await host.settled();
  }

  await splash?.draw(game.title, 0.82, 'Preparing game fonts & WOFF1 decoder...', 'Loading fonts/ from SD card');
  await installMzFontCompat(runtime, assets);

  await splash?.draw(game.title, 0.94, 'Starting RPG Maker MZ (WebGL2)...', 'Launching Scene_Boot');
  logRuntimeDiagnostics(runtime, { skippedScripts: host.getSkippedScripts?.() });
  const input = createInputBridge();
  let fatalShown = false;
  installMzCompat(runtime, host, input, game, {
    returnNroPath,
    onFatalError: (title, detail) => {
      if (fatalShown) return;
      fatalShown = true;
      const errSplash = createWebGLSplash(
        host.getWebGLContext(),
        `SW2RPGMGL v${SW2RPGMGL_VERSION}  •  RPG Maker MZ (kaiHEN / OunceVK WebGL2)`,
        '#3dd6a5',
      );
      const tail = recentLogs().slice(-6).join('\n');
      void errSplash?.draw(game.title, 1.0, `Error: ${title}`, `${detail}\n\nRecent log:\n${tail}`, true);
      let prevA = true;
      const waitReturn = () => {
        const pad = input.pollGamepadRaw();
        const a = Boolean(pad?.buttons?.[1]?.pressed);
        const plus = Boolean(pad?.buttons?.[9]?.pressed);
        if (plus) {
          sw.exit();
          return;
        }
        if (a && !prevA) {
          returnToLauncher(returnNroPath);
          return;
        }
        prevA = a;
        requestAnimationFrame(waitReturn);
      };
      setTimeout(() => requestAnimationFrame(waitReturn), 500);
    },
  });
  input.installIntoRuntime(runtime, () => host.getViewport());
  runtime.close = exitGameCleanly;
  if (runtime.SceneManager) {
    runtime.SceneManager.exit = exitGameCleanly;
  }

  if (!runtime.SceneManager || !runtime.Scene_Boot) {
    log('[mz] FATAL: SceneManager or Scene_Boot is undefined after loading scripts');
    await splash?.draw(game.title, 1.0, 'Fatal Boot Error', 'SceneManager or Scene_Boot failed to load.', true);
    setTimeout(() => returnToLauncher(returnNroPath), 2500);
    return;
  }

  await preloadMzDatabase(runtime, async (loaded, total) => {
    await splash?.draw(
      game.title,
      0.94 + 0.05 * (loaded / Math.max(1, total)),
      `Loading game database (${loaded}/${total})...`,
      'Reading data/*.json from SD card',
    );
  });

  splash?.dispose();

  log('[mz] Launching Scene_Boot via SceneManager.run(Scene_Boot)');
  const bootT0 = performance.now();
  const SceneBootProto = runtime.Scene_Boot?.prototype;
  if (SceneBootProto && typeof SceneBootProto.start === 'function') {
    const origBootStart = SceneBootProto.start;
    let logged = false;
    SceneBootProto.start = function (this: any) {
      if (!logged) {
        logged = true;
        log(`[mz-boot] Scene_Boot ready after ${(performance.now() - bootT0).toFixed(0)}ms`);
      }
      return origBootStart.apply(this, arguments as any);
    };
  }
  runtime.SceneManager.run(runtime.Scene_Boot);
}

/**
 * Load data/*.json while the WebGL loading screen is still up, instead of inside Scene_Boot, which
 * otherwise shows several seconds of black screen on large MZ databases. Scene_Boot's own
 * DataManager.loadDatabase() call is skipped once the preload succeeded. On any load error we fall
 * back to the stock path so Scene_Boot reports and retries the error as usual.
 */
async function preloadMzDatabase(
  runtime: any,
  onProgress: (loaded: number, total: number) => Promise<void>,
): Promise<void> {
  const DM = runtime.DataManager;
  const files: Array<{ name: string; src: string }> | undefined = DM?._databaseFiles;
  if (!DM || typeof DM.loadDatabase !== 'function' || !Array.isArray(files) || files.length === 0) return;
  if (DM.isBattleTest?.() || DM.isEventTest?.()) return;
  const t0 = performance.now();
  const countLoaded = () => {
    let n = 0;
    for (const f of files) if (runtime[f.name]) n++;
    return n;
  };
  try {
    DM.loadDatabase();
  } catch (err) {
    log(`[mz-boot] database preload failed to start: ${String(err)}`);
    return;
  }
  const deadline = t0 + 90000;
  let loaded = countLoaded();
  let lastDraw = 0;
  while (loaded < files.length) {
    if (Array.isArray(DM._errors) && DM._errors.length > 0) {
      log(`[mz-boot] database preload hit a load error (${DM._errors[0]?.src ?? '?'}); Scene_Boot will retry`);
      return;
    }
    if (performance.now() > deadline) {
      log(`[mz-boot] database preload timed out (${loaded}/${files.length}); Scene_Boot will continue it`);
      return;
    }
    const now = performance.now();
    if (now - lastDraw >= 100) {
      lastDraw = now;
      await onProgress(loaded, files.length);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    loaded = countLoaded();
  }
  log(`[mz-boot] database preloaded in ${(performance.now() - t0).toFixed(0)}ms (${files.length} files)`);
  const origLoadDatabase = DM.loadDatabase;
  let skipNext = true;
  DM.loadDatabase = function (this: any) {
    if (skipNext) {
      skipNext = false;
      if (!this.isBattleTest?.() && !this.isEventTest?.()) return;
    }
    return origLoadDatabase.apply(this, arguments as any);
  };
}

async function boot(): Promise<void> {
  initLog('mz.log', 'RPG Maker MZ Engine (WebGL2)');
  const sw = getSwitch();
  const { loaderDir, directGameDir, returnNroPath } = resolveLaunchArgs(sw?.argv);

  let allowPlusExit = false;
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('beforeunload', (ev: Event) => {
      if (!allowPlusExit) ev.preventDefault();
    });
    globalThis.addEventListener('unhandledrejection', (ev: any) => {
      try { ev?.preventDefault?.(); } catch { /* ignore */ }
      const reason = ev?.reason;
      log(`[mz-unhandledrejection] ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
    });
    globalThis.addEventListener('error', (ev: any) => {
      try { ev?.preventDefault?.(); } catch { /* ignore */ }
      const err = ev?.error;
      log(`[mz-error] ${err instanceof Error ? err.stack || err.message : String(ev?.message ?? ev)}`);
    });
  }

  if (!sw) {
    log('[mz] FATAL: Switch runtime API unavailable');
    return;
  }

  let game: GameEntry | null = null;
  if (directGameDir) {
    game = inspectSingleMzGame(sw, directGameDir);
    if (!game) {
      log(`[mz] FATAL: Not a valid RPG Maker MZ game folder: ${directGameDir}`);
      allowPlusExit = true;
      returnToLauncher(returnNroPath);
      return;
    }
  } else {
    const all = discoverGames(sw, loaderDir);
    game = all.find((g) => g.engine === 'mz') ?? null;
    if (!game) {
      log(`[mz] No RPG Maker MZ games found in ${loaderDir}; exiting to hbmenu`);
      allowPlusExit = true;
      sw.exit();
      return;
    }
  }

  await launchMzGame(sw, game, returnNroPath);
}

boot().catch((err) => {
  log(`[mz] Unhandled boot error: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  getSwitch()?.exit();
});
