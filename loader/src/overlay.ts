/**
 * Switch 2 in-game Quick Overlay Menu (Minus button) + optional FPS/Memory HUD.
 */
import type { BrowserHost, DisplayMode, FilterMode } from './browser-host';
import type { GameEntry } from './games';
import type { InputBridge } from './input';
import { getSwitch, log } from './log';
import { drawPerfHud, HUD_MODE_LABELS, nextHudMode, type HudMode, type PerfHudSnapshot } from './perf-hud';

export interface OverlayController {
  isOpen(): boolean;
  tickAndDraw(): void;
}

const DISPLAY_MODES: DisplayMode[] = ['fit', 'pixel', 'stretch'];
const FILTER_MODES: FilterMode[] = ['auto', 'nearest', 'bilinear', 'trilinear', 'bicubic'];
const FILTER_LABELS: Record<FilterMode, string> = {
  auto: 'AUTO (Smart)',
  nearest: 'NEAREST (Sharp)',
  bilinear: 'BILINEAR (Linear)',
  trilinear: 'TRILINEAR (Mipmap)',
  bicubic: 'BICUBIC (Mitchell)',
};

function relaunchLoader(returnNroPath?: string | null): void {
  const sw = getSwitch();
  try {
    if (returnNroPath && typeof sw?.Application === 'function') {
      log(`[overlay] returning to launcher NRO -> ${returnNroPath}`);
      const app = new sw.Application(returnNroPath);
      app.launch();
      return;
    }
    const selfApp = sw?.Application?.self;
    if (selfApp && typeof selfApp.launch === 'function') {
      log('[overlay] relaunching SW2RPGMGL -> Game Select');
      selfApp.launch();
      return;
    }
  } catch (err) {
    log(`[overlay] launcher handoff failed (${String(err)}), falling back to exit()`);
  }
  sw?.exit();
}

export function createOverlay(
  host: BrowserHost,
  input: InputBridge,
  game: GameEntry,
  returnNroPath?: string | null,
): OverlayController {
  let open = false;
  let hudMode: HudMode = 'off';
  let selected = 0;

  let prevUp = false;
  let prevDown = false;
  let prevA = false;
  let prevB = false;

  // Rolling FPS counter (for Basic HUD & fallback)
  let fpsFrames = 0;
  let fpsLast = performance.now();
  let fpsDisplay = 60;
  let proHudTick = 0;
  let lastProHudDrawMs = 0;

  function updateFpsCounter() {
    fpsFrames++;
    const now = performance.now();
    if (now - fpsLast >= 500) {
      fpsDisplay = Math.round((fpsFrames * 1000) / (now - fpsLast));
      fpsFrames = 0;
      fpsLast = now;
    }
  }

  function buildHudSnapshot(): PerfHudSnapshot {
    const sw = getSwitch();
    let memMiB = 0;
    try {
      const m = sw?.memoryUsage?.();
      if (m?.used) memMiB = Math.round(m.used / (1024 * 1024));
    } catch { /* ignore */ }
    const runtime = globalThis as any;
    const st = runtime.__drPerfStats;
    const vp = host.getViewport();
    const isGl = Boolean(host.getWebGLContext());
    const sceneName = st?.sceneName || runtime.SceneManager?._scene?.constructor?.name || 'none';
    return {
      engine: 'MV',
      backend: isGl ? 'WebGL2' : (host.isDirectGpu() ? '2D GPU' : '2D'),
      fps: st?.fps ?? fpsDisplay,
      frameMs: st?.frameMs ?? (fpsDisplay > 0 ? 1000 / fpsDisplay : 16.7),
      updateMs: st?.updateMs,
      renderMs: st?.renderMs,
      ticksPerFrame: st?.ticksPerFrame,
      sceneName,
      displayMode: host.getDisplayMode(),
      filterMode: isGl ? undefined : host.getFilterMode(),
      gameW: vp.gw,
      gameH: vp.gh,
      vpW: vp.w,
      vpH: vp.h,
      memMiB,
      map: st?.map ?? null,
      gl: st?.gl ?? null,
      frameHistory: st?.frameHistory,
      frameHistoryHead: st?.frameHistoryHead,
    };
  }

  function drawHud(ctx: any) {
    if (hudMode === 'off') return;
    drawPerfHud(ctx, hudMode, buildHudSnapshot());
  }

  function setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    input.setOverlayOpen(open);
    if (!open) host.markLetterboxDirty();
  }

  function items() {
    return [
      { label: 'Resume Game', run: () => { setOpen(false); } },
      {
        label: `Display Mode: ${host.getDisplayMode().toUpperCase()}`,
        run: () => {
          const idx = (DISPLAY_MODES.indexOf(host.getDisplayMode()) + 1) % DISPLAY_MODES.length;
          host.setDisplayMode(DISPLAY_MODES[idx]);
          log(`[overlay] displayMode -> ${DISPLAY_MODES[idx]}`);
        },
      },
      {
        label: `Texture Filter: ${FILTER_LABELS[host.getFilterMode()]}`,
        run: () => {
          const idx = (FILTER_MODES.indexOf(host.getFilterMode()) + 1) % FILTER_MODES.length;
          host.setFilterMode(FILTER_MODES[idx]);
          log(`[overlay] filterMode -> ${FILTER_MODES[idx]}`);
        },
      },
      {
        label: `Performance HUD: ${HUD_MODE_LABELS[hudMode]}`,
        run: () => {
          hudMode = nextHudMode(hudMode);
          (globalThis as any).__drHudMode = hudMode;
          lastGlKey = '';
          host.markLetterboxDirty();
          log(`[overlay] hudMode -> ${hudMode}`);
        },
      },
      {
        label: 'Skip Current Video Cutscene',
        run: () => {
          host.forceStopVideos();
          setOpen(false);
          log('[overlay] skipped active video(s)');
        },
      },
      {
        label: 'Run Garbage Collector (gc)',
        run: () => {
          try { (globalThis as any).gc?.(); log('[overlay] manual gc() triggered'); } catch { /* ignore */ }
        },
      },
      {
        label: 'Return to Game Select',
        run: () => {
          relaunchLoader(returnNroPath);
        },
      },
      {
        label: 'Exit to hbmenu (kaiHEN)',
        run: () => {
          log('[overlay] clean exit requested');
          getSwitch()?.exit();
        },
      },
    ];
  }

  function drawMenu(ctx: any) {
    const sw = ctx.canvas?.width || 1280;
    const sh = ctx.canvas?.height || 720;
    const list = items();

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(0, 0, sw, sh);

    const boxW = 580;
    const rowH = 42;
    const boxH = 112 + list.length * rowH + 62;
    const bx = Math.floor((sw - boxW) / 2);
    const by = Math.floor((sh - boxH) / 2);

    ctx.fillStyle = '#141926';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = '#5c7cfa';
    ctx.lineWidth = 3;
    ctx.strokeRect(bx, by, boxW, boxH);

    ctx.fillStyle = '#ffffff';
    ctx.font = '23px sans-serif';
    ctx.textBaseline = 'top';
    const headerTitle = `${game.title} — Switch 2`;
    ctx.fillText(headerTitle.length > 42 ? headerTitle.slice(0, 41) + '…' : headerTitle, bx + 28, by + 20);

    ctx.fillStyle = '#9aa8c7';
    ctx.font = '13px sans-serif';
    ctx.fillText('A: Confirm  •  B / Minus: Resume  •  X: Menu  •  Y: Dash  •  ZL/ZR: Plugin Hotkeys', bx + 28, by + 56);

    for (let i = 0; i < list.length; i++) {
      const y = by + 98 + i * rowH;
      if (i === selected) {
        ctx.fillStyle = 'rgba(92, 124, 250, 0.32)';
        ctx.fillRect(bx + 20, y - 5, boxW - 40, 35);
      }
      ctx.fillStyle = i === selected ? '#ffffff' : '#c7d1e8';
      ctx.font = i === selected ? '19px sans-serif' : '18px sans-serif';
      ctx.fillText(`${i === selected ? '> ' : '  '}${list[i].label}`, bx + 32, y + 3);
    }

    ctx.fillStyle = '#7f8ca8';
    ctx.font = '13px sans-serif';
    const saveFooter = `Saves: ${game.saveDir}/`;
    ctx.fillText(saveFooter.length > 74 ? saveFooter.slice(0, 73) + '…' : saveFooter, bx + 28, by + boxH - 32);
    ctx.restore();
  }

  let glCanvas: any = null;
  let glCtx2d: any = null;
  let glTex: any = null;
  let glSprite: any = null;
  let glContainer: any = null;
  let lastGlKey = '';

  function ensureGlOverlay(gw: number, gh: number): boolean {
    const PIXI = (globalThis as any).PIXI;
    if (!PIXI) return false;
    if (!glCanvas || glCanvas.width !== gw || glCanvas.height !== gh) {
      glCanvas = new OffscreenCanvas(gw, gh);
      glCtx2d = glCanvas.getContext('2d');
      const isPixiV5Plus = /^([5-9]|\d{2,})\./.test(String(PIXI.VERSION ?? ''));
      glTex = !isPixiV5Plus && typeof PIXI.Texture?.fromCanvas === 'function'
        ? PIXI.Texture.fromCanvas(glCanvas)
        : PIXI.Texture.from(glCanvas);
      glSprite = new PIXI.Sprite(glTex);
      glContainer = new PIXI.Container();
      glContainer.addChild(glSprite);
      lastGlKey = '';
    }
    return Boolean(glCtx2d && glTex && glSprite && glContainer);
  }

  return {
    isOpen: () => open,
    tickAndDraw() {
      const ctx = host.getScreenContext();
      const gl = !ctx ? host.getWebGLContext() : null;
      if (!ctx && !gl) return;

      updateFpsCounter();

      if (input.isMinusJustPressed()) {
        setOpen(!open);
        selected = 0;
      }

      if (open) {
        const pad = input.pollGamepadRaw();
        const up = Boolean(pad?.buttons?.[12]?.pressed || (pad?.axes?.[1] ?? 0) < -0.5);
        const down = Boolean(pad?.buttons?.[13]?.pressed || (pad?.axes?.[1] ?? 0) > 0.5);
        const a = Boolean(pad?.buttons?.[1]?.pressed);
        const b = Boolean(pad?.buttons?.[0]?.pressed);

        const list = items();
        if (up && !prevUp) selected = (selected + list.length - 1) % list.length;
        if (down && !prevDown) selected = (selected + 1) % list.length;
        if (b && !prevB) { setOpen(false); }
        else if (a && !prevA) list[selected]?.run();

        prevUp = up; prevDown = down; prevA = a; prevB = b;
      } else {
        prevUp = prevDown = prevA = prevB = false;
      }

      if (ctx) {
        if (open) drawMenu(ctx);
        else drawHud(ctx);
        return;
      }

      // WebGL2 mode (Live2D / PixiJS v5 MV games): cache overlay texture & only re-upload when menu/HUD state changes
      if (!open && hudMode === 'off') {
        lastGlKey = '';
        return;
      }
      const Graphics = (globalThis as any).Graphics;
      const renderer = Graphics?._renderer;
      if (!renderer) return;
      const gw = Graphics?.width || 816;
      const gh = Graphics?.height || 624;
      if (!ensureGlOverlay(gw, gh)) return;

      if (!open && hudMode === 'pro') {
        const now = performance.now();
        if (now - lastProHudDrawMs >= 250) {
          lastProHudDrawMs = now;
          proHudTick++;
        }
      }
      const key = open
        ? `menu|${selected}|${host.getDisplayMode()}|${host.getFilterMode()}|${hudMode}`
        : hudMode === 'pro'
          ? `pro|${proHudTick}|${host.getDisplayMode()}`
          : `basic|${fpsDisplay}|${host.getDisplayMode()}`;
      if (key !== lastGlKey) {
        lastGlKey = key;
        glCtx2d.clearRect(0, 0, gw, gh);
        if (open) drawMenu(glCtx2d);
        else drawHud(glCtx2d);
        glTex.baseTexture?.update?.();
      }
      try {
        renderer.render(glContainer, undefined, false);
      } catch { /* ignore */ }
    },
  };
}
