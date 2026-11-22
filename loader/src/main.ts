/**
 * Universal RPG Maker MV Loader — Nintendo Switch 2 (kaiHEN) Entrypoint
 * Runs under nx.js compiled with ounce-devkit (libounce + OunceVK + libkaihen).
 */
import { createAssetReader } from './assets';
import { createBrowserHost, installFontLeakGuard } from './browser-host';
import { runGameSelect } from './game-select';
import { discoverGames, engineFullLabel, findMkxpzNroPath, inspectSingleMvGame, type GameEntry } from './games';
import { createInputBridge } from './input';
import { getLogPath, getSwitch, initLog, log, recentLogs, resolveLaunchArgs } from './log';
import {
  createScriptPreparer,
  detectAudioSupport,
  detectMvWebGLReason,
  extractIndexScripts,
  installMvCompat,
  mountIndexHtmlCanvases,
  registerGameFonts,
} from './mv-compat';
import { installNodeCompat } from './node-compat';
import { createOverlay } from './overlay';
import { installSdSaves } from './saves';
import { createWebGLSplash, type WebGLSplash } from './webgl-splash';

declare const screen: any;

function detectMvNeedsWebGL(sw: NonNullable<ReturnType<typeof getSwitch>>, game: GameEntry): string | null {
  if ((game.config as any)?.renderer === 'webgl') return 'config';
  if ((game.config as any)?.renderer === 'canvas') return null;
  try {
    const readText = (rel: string, maxBytes?: number): string | null => {
      try {
        const bytes = sw.readFileSync(`${game.wwwRoot}/${rel}`);
        if (!bytes) return null;
        const view = maxBytes && bytes.byteLength > maxBytes
          ? new Uint8Array(bytes, 0, maxBytes)
          : new Uint8Array(bytes);
        return new TextDecoder().decode(view);
      } catch {
        return null;
      }
    };
    const pjsText = readText('js/plugins.js');
    const quick = detectMvWebGLReason(pjsText, null, null);
    if (quick) return quick;
    const pixiHead = readText('js/libs/pixi.js', 512);
    const pixiReason = detectMvWebGLReason(null, null, pixiHead);
    if (pixiReason) return pixiReason;
    const rpgCoreText = readText('js/rpg_core.js');
    return detectMvWebGLReason(null, rpgCoreText, null);
  } catch {
    return null;
  }
}

function drawSplash(
  ctx: any,
  title: string,
  progress: number,
  status: string,
  detail = '',
  isError = false,
): void {
  if (!ctx) return;
  const sw = ctx.canvas?.width || 1280;
  const sh = ctx.canvas?.height || 720;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = isError ? '#1a0c12' : '#0d1018';
  ctx.fillRect(0, 0, sw, sh);

  ctx.fillStyle = isError ? '#ff5c72' : '#f1f5ff';
  ctx.font = '40px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(title.length > 36 ? title.slice(0, 35) + '…' : title, 72, 76);

  ctx.fillStyle = isError ? '#d96b7c' : '#6c8cff';
  ctx.font = '20px sans-serif';
  ctx.fillText('SW2RPGMGL  •  kaiHEN / OunceVK Skia GPU', 72, 130);

  // Progress bar
  const barX = 72;
  const barY = 204;
  const barW = sw - 144;
  const barH = 18;
  ctx.fillStyle = '#1e2638';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = isError ? '#ff4d63' : '#5c7cfa';
  ctx.fillRect(barX, barY, Math.round(barW * Math.max(0, Math.min(1, progress))), barH);

  ctx.fillStyle = '#ffffff';
  ctx.font = '24px sans-serif';
  ctx.fillText(status, 72, 242);

  if (detail) {
    ctx.fillStyle = '#a8b5d1';
    ctx.font = '18px sans-serif';
    const lines = detail.split('\n');
    for (let i = 0; i < lines.length && i < 14; i++) {
      ctx.fillText(lines[i].slice(0, 110), 72, 288 + i * 26);
    }
  }

  ctx.fillStyle = '#73809e';
  ctx.font = '16px sans-serif';
  ctx.fillText(
    isError
      ? `Press A: Return to Game Select   •   Press +: Exit to hbmenu   •   Log: ${getLogPath()}`
      : 'Press Minus (-) anytime in-game for Display, Filter, HUD, Game Select & Exit',
    72,
    sh - 54,
  );
  ctx.restore();
}

let fatalActive = false;
let activeReturnNro: string | null = null;

function showFatalError(ctx: any, heading: string, title: string, detail: string): void {
  if (fatalActive) return;
  fatalActive = true;
  log(`FATAL: ${title} :: ${detail}`);
  const tail = recentLogs().slice(-6).join('\n');
  const full = `${detail}\n\nRecent log:\n${tail}`;
  let prevA = true;
  const render = () => {
    try {
      const pads = navigator.getGamepads?.();
      if (pads) {
        for (const pad of pads) {
          if (pad && pad.connected) {
            const a = Boolean(pad.buttons?.[1]?.pressed);
            if (a && !prevA) {
              const sw = getSwitch();
              try {
                if (activeReturnNro && typeof sw?.Application === 'function') {
                  new sw.Application(activeReturnNro).launch();
                  return;
                }
                if (typeof sw?.Application?.self?.launch === 'function') {
                  sw.Application.self.launch();
                  return;
                }
              } catch { /* fall through to exit */ }
              sw?.exit();
              return;
            }
            prevA = a;
            break;
          }
        }
      }
    } catch { /* ignore */ }
    drawSplash(ctx, heading, 1, title, full, true);
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);
}

async function launchGame(
  ctx: any,
  sw: NonNullable<ReturnType<typeof getSwitch>>,
  game: GameEntry,
  setAllowPlusExit: (allow: boolean) => void,
  returnNroPath?: string | null,
  webglReason: string | null = null,
): Promise<void> {
  const enableWebGL = Boolean(webglReason);
  const title = game.title;
  log(`=== Launching Game: "${title}"${enableWebGL ? ` [WebGL2/${webglReason} mode]` : ''} ===`);
  log(`  gameDir: ${game.gameDir}`);
  log(`  wwwRoot: ${game.wwwRoot}`);
  log(`  saveDir: ${game.saveDir}`);

  const assets = createAssetReader(game.wwwRoot, sw);
  const scriptPreparer = createScriptPreparer(game.config.skipPlugins);
  const host = createBrowserHost(assets, scriptPreparer, screen, {
    gameTitle: title,
    displayMode: game.config.displayMode ?? 'fit',
    filterMode: game.config.filterMode ?? 'auto',
    enableWebGL,
  });

  // Wire window.close() / SceneManager.exit() / nw.App.quit() so title-screen "Quit Game"
  // cleanly returns to SW2RPGMGL Game Select (or hbmenu) instead of freezing.
  let exitingGame = false;
  const exitGameCleanly = () => {
    if (exitingGame) return;
    exitingGame = true;
    log(`[exit] Game requested exit -> returning to ${returnNroPath || 'launcher/hbmenu'}`);
    setAllowPlusExit(true);
    try {
      if (returnNroPath && typeof sw.Application === 'function') {
        new sw.Application(returnNroPath).launch();
        return;
      }
      if (typeof sw.Application?.self?.launch === 'function') {
        sw.Application.self.launch();
        return;
      }
    } catch { /* fall through to exit */ }
    sw.exit();
  };
  (globalThis as any).close = exitGameCleanly;

  let glSplash: WebGLSplash | null = null;
  if (enableWebGL) {
    const gl = host.ensureWebGLContext();
    glSplash = createWebGLSplash(
      gl,
      `SW2RPGMGL  •  RPG Maker MV (WebGL2 / ${webglReason})`,
      '#6c8cff',
    );
  }

  const updateSplash = async (progress: number, status: string, detail = '', isError = false) => {
    if (glSplash) {
      await glSplash.draw(title, progress, status, detail, isError);
    } else {
      drawSplash(ctx, title, progress, status, detail, isError);
    }
  };

  const showFatal = (errTitle: string, errDetail: string) => {
    setAllowPlusExit(true);
    if (enableWebGL) {
      const errGl = host.getWebGLContext();
      const errSplash = glSplash || createWebGLSplash(
        errGl,
        'SW2RPGMGL  •  RPG Maker MV (WebGL2 / Live2D)',
        '#6c8cff',
      );
      const tail = recentLogs().slice(-6).join('\n');
      void errSplash?.draw(title, 1.0, `Error: ${errTitle}`, `${errDetail}\n\nRecent log:\n${tail}`, true);
      let prevA = true;
      const waitReturn = () => {
        const pads = navigator.getGamepads?.();
        if (pads) {
          for (const pad of pads) {
            if (pad && pad.connected) {
              const a = Boolean(pad.buttons?.[1]?.pressed);
              const plus = Boolean(pad.buttons?.[9]?.pressed);
              if (plus) { sw.exit(); return; }
              if (a && !prevA) {
                try {
                  if (activeReturnNro && typeof sw.Application === 'function') {
                    new sw.Application(activeReturnNro).launch();
                    return;
                  }
                } catch { /* ignore */ }
                sw.exit();
                return;
              }
              prevA = a;
              break;
            }
          }
        }
        requestAnimationFrame(waitReturn);
      };
      setTimeout(() => requestAnimationFrame(waitReturn), 500);
    } else {
      showFatalError(ctx, title, errTitle, errDetail);
    }
  };

  await updateSplash(0.08, 'Reading www/index.html…', game.wwwRoot);
  const indexBytes = await assets.read('index.html');
  if (!indexBytes) {
    showFatal('Missing www/index.html', `Expected ${game.wwwRoot}/index.html`);
    return;
  }
  const indexHtml = new TextDecoder().decode(indexBytes);
  const scripts = extractIndexScripts(indexHtml);
  const extraCanvases = mountIndexHtmlCanvases((globalThis as any).document, indexHtml);
  if (extraCanvases.length > 0) {
    log(`Pre-mounted custom index.html canvas(es): ${extraCanvases.join(', ')}`);
  }
  log(`Parsed ${scripts.length} core scripts from index.html`);

  await updateSplash(0.16, 'Discovering & registering fonts…');
  await registerGameFonts(assets);

  await updateSplash(0.22, 'Detecting audio format & initializing Switch 2 host…');
  const audioSupport = detectAudioSupport(assets, game.config.audioFormat ?? 'auto');
  installNodeCompat(
    globalThis as any,
    sw,
    game.wwwRoot,
    game.saveDir,
    log,
    game.gameDir,
    title,
  );

  // Load core scripts in exact DOM order (pixi, rpg_core..rpg_windows, plugins.js, main.js)
  for (let i = 0; i < scripts.length; i++) {
    const scriptPath = scripts[i];
    const pct = 0.25 + (0.58 * (i + 1)) / Math.max(1, scripts.length);
    await updateSplash(pct, `Loading engine scripts (${i + 1}/${scripts.length})…`, scriptPath);
    await host.loadScript(scriptPath);
  }

  // Wait for PluginManager.setup($plugins) to finish loading all enabled plugins
  const pluginMsg = game.pluginCount > 0
    ? `Loading plugins (${game.pluginCount} enabled)…`
    : 'Loading plugins…';
  await updateSplash(0.88, pluginMsg, 'Please wait on first boot');
  await host.settled();

  await updateSplash(0.94, 'Installing Switch 2 saves, controls & GPU acceleration…');
  const runtime = globalThis as any;
  const input = createInputBridge();
  installMvCompat(runtime, host, {
    audioSupport,
    onFatalError: (errTitle, errDetail) => {
      showFatal(errTitle, errDetail);
    },
  });
  installSdSaves(runtime, sw, game.saveDir);
  input.installIntoRuntime(runtime, () => host.getViewport());
  runtime.close = exitGameCleanly;
  if (runtime.SceneManager) {
    runtime.SceneManager.exit = exitGameCleanly;
  }

  const overlay = createOverlay(host, input, game, returnNroPath);

  // Hook overlay rendering onto every frame after Graphics.render finishes
  let lastOverlayFrame = 0;
  const origEndFrame = host.endFrame.bind(host);
  host.endFrame = (activeVideo?: any | null) => {
    origEndFrame(activeVideo);
    lastOverlayFrame = performance.now();
    overlay.tickAndDraw();
  };
  const origPresent = host.present.bind(host);
  host.present = (activeVideo?: any | null) => {
    origPresent(activeVideo);
    lastOverlayFrame = performance.now();
    overlay.tickAndDraw();
  };

  // Start RPG Maker MV Scene_Boot!
  await updateSplash(0.99, `Starting ${title}…`, game.gameDir);
  glSplash?.dispose();
  glSplash = null;

  log('Launching Scene_Boot via window.onload / SceneManager.run');
  if (typeof runtime.onload === 'function') {
    runtime.onload();
  } else if (runtime.SceneManager && runtime.Scene_Boot) {
    runtime.SceneManager.run(runtime.Scene_Boot);
  } else {
    showFatal('Failed to initialize RPG Maker MV', 'SceneManager or Scene_Boot is undefined.');
    return;
  }

  // Keep overlay responsive even during loading transitions when Graphics.render may pause (2D mode only;
  // in WebGL2 mode, overlay renders directly at the end of Graphics.render without racing the swapchain).
  if (!enableWebGL) {
    const overlayPump = () => {
      if (overlay.isOpen() && performance.now() - lastOverlayFrame > 50) {
        host.present(runtime.Graphics?._video);
      }
      requestAnimationFrame(overlayPump);
    };
    requestAnimationFrame(overlayPump);
  }
}

async function boot(): Promise<void> {
  initLog();
  const sw = getSwitch();
  const { loaderDir, directGameDir, returnNroPath } = resolveLaunchArgs(sw?.argv);
  activeReturnNro = returnNroPath;
  log(
    `Booting SW2RPGMGL — MV Engine (screen=${screen?.width}x${screen?.height}, dir=${loaderDir}` +
    `${directGameDir ? `, directGame=${directGameDir}` : ''}${returnNroPath ? `, returnNro=${returnNroPath}` : ''})`,
  );

  // Allow Plus (+) to exit cleanly while in Game Select or Fatal Error mode;
  // prevent accidental Plus (+) quits once a game is running (use Minus -> Exit instead).
  let allowPlusExit = true;
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('beforeunload', (ev: Event) => {
      if (!allowPlusExit) {
        ev.preventDefault();
      }
    });
    globalThis.addEventListener('unhandledrejection', (ev: any) => {
      try { ev?.preventDefault?.(); } catch { /* ignore */ }
      const reason = ev?.reason;
      log(`[unhandledrejection] ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
    });
    globalThis.addEventListener('error', (ev: any) => {
      try { ev?.preventDefault?.(); } catch { /* ignore */ }
      const err = ev?.error;
      log(`[error] ${err instanceof Error ? err.stack || err.message : String(ev?.message ?? ev)}`);
    });
  }

  if (!sw) {
    const screenCtx = screen?.getContext?.('2d');
    installFontLeakGuard(screenCtx);
    showFatalError(screenCtx, 'SW2RPGMGL', 'Switch runtime API unavailable', 'Expected nx.js Switch global.');
    return;
  }

  // Direct-launch mode (invoked by SW2RPGMGL.nro with gameDir + returnNro).
  // Inspect before acquiring screen.getContext('2d') so Live2D MV games can use Hardware WebGL2!
  if (directGameDir) {
    const directGame = inspectSingleMvGame(sw, directGameDir);
    if (!directGame) {
      const screenCtx = screen?.getContext?.('2d');
      installFontLeakGuard(screenCtx);
      allowPlusExit = true;
      showFatalError(
        screenCtx,
        'SW2RPGMGL',
        'RPG Maker MV game not found',
        `Expected www/index.html (or flat index.html + js/rpg_core.js) inside:\n  ${directGameDir}`,
      );
      return;
    }
    const webglReason = detectMvNeedsWebGL(sw, directGame);
    const screenCtx = webglReason ? null : screen?.getContext?.('2d');
    if (screenCtx) installFontLeakGuard(screenCtx);
    allowPlusExit = false;
    await launchGame(screenCtx, sw, directGame, (allow) => {
      allowPlusExit = allow;
    }, returnNroPath, webglReason);
    return;
  }

  const screenCtx = screen?.getContext?.('2d');
  installFontLeakGuard(screenCtx);
  drawSplash(screenCtx, 'SW2RPGMGL', 0.15, 'Scanning SD card for RPG Maker games…', loaderDir);
  const games = discoverGames(sw, loaderDir);

  // Standalone fallback Game Select screen
  const selectedGame = await runGameSelect(screenCtx, sw, loaderDir, games);

  // If this is an RPG Maker VX Ace / VX / XP game, hand off cleanly to mkxp-z-switch2.nro!
  if (selectedGame.engine !== 'mv') {
    const mkxpNro = findMkxpzNroPath(sw, loaderDir);
    if (!mkxpNro) {
      allowPlusExit = true;
      showFatalError(
        screenCtx,
        selectedGame.title,
        'Missing mkxp-z-switch2.nro companion runtime',
        `${selectedGame.title} uses ${engineFullLabel(selectedGame.engine)}.\n\n` +
        `Copy mkxp-z-switch2.nro into:\n  ${loaderDir}/engines/mkxp-z-switch2.nro`,
      );
      return;
    }
    const selfNro = returnNroPath || sw.argv?.[0] || `${loaderDir}/SW2RPGMGL.nro`;
    const normalizedSelf = selfNro.startsWith('/') ? `sdmc:${selfNro}` : selfNro;
    drawSplash(
      screenCtx,
      selectedGame.title,
      0.85,
      `Launching via mkxp-z (${engineFullLabel(selectedGame.engine)})…`,
      `${mkxpNro}\nGame: ${selectedGame.gameDir}`,
    );
    log(`[handoff] launching ${mkxpNro} with game="${selectedGame.gameDir}" return="${normalizedSelf}"`);
    try {
      const AppCtor = sw.Application;
      if (typeof AppCtor === 'function') {
        const app = new AppCtor(mkxpNro);
        app.launch(selectedGame.gameDir, normalizedSelf);
        return;
      }
      throw new Error('Switch.Application constructor unavailable');
    } catch (err) {
      allowPlusExit = true;
      showFatalError(
        screenCtx,
        selectedGame.title,
        'Failed to chain-load mkxp-z-switch2.nro',
        err instanceof Error ? err.stack || err.message : String(err),
      );
      return;
    }
  }

  // MV Game selected -> lock Plus (+) against accidental exit and boot natively in nx.js
  allowPlusExit = false;
  await launchGame(screenCtx, sw, selectedGame, (allow) => {
    allowPlusExit = allow;
  }, returnNroPath);
}

boot().catch((err) => {
  const ctx = screen?.getContext?.('2d');
  showFatalError(
    ctx,
    'SW2RPGMGL',
    'Unhandled boot error',
    err instanceof Error ? err.stack || err.message : String(err),
  );
});
