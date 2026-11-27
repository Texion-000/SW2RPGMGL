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
      const m: any = sw?.memoryUsage?.();
      const used = m?.usedHeapSize ?? m?.used;
      if (used) memMiB = Math.round(used / (1024 * 1024));
    } catch { /* ignore */ }
    const runtime = globalThis as any;
    const st = runtime.__drPerfStats;
    const vp = host.getViewport();
    const isGl = Boolean(host.getWebGLContext());
    const sceneName = st?.sceneName || runtime.SceneManager?._scene?.constructor?.name || 'none';
    return {
      engine: 'MV',
      backend: isGl ? 'WebGL2' : (host.isDirectGpu() ? '2D GPU' : '2D'),
      // __drPerfStats is only refreshed while the Pro HUD is active; Basic must use the live counter or it
      // shows the last Pro value frozen after switching Pro -> Basic.
      fps: hudMode === 'pro' ? (st?.fps ?? fpsDisplay) : fpsDisplay,
      frameMs: hudMode === 'pro' && st?.frameMs ? st.frameMs : (fpsDisplay > 0 ? 1000 / fpsDisplay : 16.7),
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

  // The HUD only occupies the top-left corner, so it is rasterized into a small cached canvas that is
  // redrawn only when its content changes (Pro: every 250ms, Basic: when the FPS number changes).
  // Previously the 2D path re-rasterized all HUD text every frame and the WebGL path re-uploaded a
  // full game-resolution (e.g. 1024x768) canvas 4x/sec, which cost 10-30 FPS while the HUD was visible.
  const HUD_MAX_W = 640;
  const HUD_MAX_H = 176;
  let hudCanvas: any = null;
  let hudCtx: any = null;
  let hudKey = '';

  function hudContentKey(): string {
    if (hudMode === 'pro') {
      const now = performance.now();
      if (now - lastProHudDrawMs >= 250) {
        lastProHudDrawMs = now;
        proHudTick++;
      }
      return `pro|${proHudTick}|${host.getDisplayMode()}`;
    }
    return `basic|${fpsDisplay}|${host.getDisplayMode()}`;
  }

  /** Returns the cached HUD canvas, redrawing it only when its content key changed. */
  function renderHudCached(maxW: number): { canvas: any; changed: boolean } | null {
    if (hudMode === 'off' || typeof OffscreenCanvas === 'undefined') return null;
    const w = Math.max(64, Math.min(HUD_MAX_W, maxW | 0));
    if (!hudCanvas || hudCanvas.width !== w) {
      hudCanvas = new OffscreenCanvas(w, HUD_MAX_H);
      hudCtx = hudCanvas.getContext('2d');
      hudKey = '';
    }
    if (!hudCtx) return null;
    const key = hudContentKey();
    if (key === hudKey) return { canvas: hudCanvas, changed: false };
    hudKey = key;
    hudCtx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
    drawHud(hudCtx);
    return { canvas: hudCanvas, changed: true };
  }

  function setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    input.setOverlayOpen(open);
    if (open) {
      prevUp = true;
      prevDown = true;
      prevA = true;
      prevB = true;
    } else {
      host.markLetterboxDirty();
    }
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
        label: 'Log On-Screen Objects (debug)',
        run: () => {
          const dump = (globalThis as any).__drDumpScene;
          if (typeof dump === 'function') {
            try { dump(); } catch (err) { log(`[overlay] scene dump failed: ${String(err)}`); }
          } else {
            log('[overlay] scene dump not available for this engine');
          }
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

  let hudGlTex: any = null;
  let hudGlContainer: any = null;
  let hudGlSource: any = null;

  function ensureGlHudLayer(source: any): boolean {
    const PIXI = (globalThis as any).PIXI;
    if (!PIXI || !source) return false;
    if (hudGlSource !== source || !hudGlTex || !hudGlContainer) {
      const isPixiV5Plus = /^([5-9]|\d{2,})\./.test(String(PIXI.VERSION ?? ''));
      hudGlTex = !isPixiV5Plus && typeof PIXI.Texture?.fromCanvas === 'function'
        ? PIXI.Texture.fromCanvas(source)
        : PIXI.Texture.from(source);
      const spr = new PIXI.Sprite(hudGlTex);
      hudGlContainer = new PIXI.Container();
      hudGlContainer.addChild(spr);
      hudGlSource = source;
    }
    return true;
  }

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
        if (open) {
          drawMenu(ctx);
        } else if (hudMode !== 'off') {
          const cached = renderHudCached(ctx.canvas?.width || 1280);
          if (cached) {
            ctx.save();
            if (typeof ctx.setTransform === 'function') ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.drawImage(cached.canvas, 0, 0);
            ctx.restore();
          } else {
            drawHud(ctx);
          }
        }
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

      if (!open) {
        // HUD only: small cached texture, re-uploaded only when its content changes
        lastGlKey = '';
        const cached = renderHudCached(gw);
        if (!cached || !ensureGlHudLayer(cached.canvas)) return;
        if (cached.changed) hudGlTex.baseTexture?.update?.();
        try {
          renderer.render(hudGlContainer, undefined, false);
        } catch { /* ignore */ }
        return;
      }

      if (!ensureGlOverlay(gw, gh)) return;
      const key = `menu|${selected}|${host.getDisplayMode()}|${host.getFilterMode()}|${hudMode}`;
      if (key !== lastGlKey) {
        lastGlKey = key;
        glCtx2d.clearRect(0, 0, gw, gh);
        drawMenu(glCtx2d);
        glTex.baseTexture?.update?.();
      }
      try {
        renderer.render(glContainer, undefined, false);
      } catch { /* ignore */ }
    },
  };
}
