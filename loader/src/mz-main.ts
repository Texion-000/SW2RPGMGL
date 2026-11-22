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
import { getSwitch, initLog, log, recentLogs, resolveLaunchArgs } from './log';
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
  log(`=== Launching MZ Game: "${game.title}" ===`);
  log(`  gameDir: ${game.gameDir}`);
  log(`  wwwRoot: ${game.wwwRoot}`);
  log(`  saveDir: ${game.saveDir}`);

  const assets = createAssetReader(game.wwwRoot, sw);
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
    'SW2RPGMGL  •  RPG Maker MZ (kaiHEN / OunceVK WebGL2)',
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
  const input = createInputBridge();
  let fatalShown = false;
  installMzCompat(runtime, host, input, game, {
    returnNroPath,
    onFatalError: (title, detail) => {
      if (fatalShown) return;
      fatalShown = true;
      const errSplash = createWebGLSplash(
        host.getWebGLContext(),
        'SW2RPGMGL  •  RPG Maker MZ (kaiHEN / OunceVK WebGL2)',
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

  splash?.dispose();

  log('[mz] Launching Scene_Boot via SceneManager.run(Scene_Boot)');
  runtime.SceneManager.run(runtime.Scene_Boot);
}

async function boot(): Promise<void> {
  initLog();
  const sw = getSwitch();
  const { loaderDir, directGameDir, returnNroPath } = resolveLaunchArgs(sw?.argv);
  log(
    `Booting SW2RPGMGL — MZ Engine (WebGL2) ` +
    `(dir=${loaderDir}${directGameDir ? `, game=${directGameDir}` : ''}${returnNroPath ? `, return=${returnNroPath}` : ''})`,
  );

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
