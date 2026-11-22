/**
 * Shared Basic & Pro Performance HUD renderer for SW2RPGMGL (RPG Maker MV & MZ).
 *
 * Modes:
 *  - 'off'   : hidden
 *  - 'basic' : compact 1-line FPS / Memory / Display pill
 *  - 'pro'   : detailed telemetry card (FPS, frame/update/render ms, ticks/f, scene,
 *              resolution/viewport, map entity & breakdown timings, WebGL2 draw/tex stats,
 *              memory usage, and a live 48-frame sparkline graph with 60Hz target line)
 */

export type HudMode = 'off' | 'basic' | 'pro';

export const HUD_MODES: readonly HudMode[] = ['off', 'basic', 'pro'] as const;

export const HUD_MODE_LABELS: Record<HudMode, string> = {
  off: 'OFF',
  basic: 'BASIC',
  pro: 'PRO',
};

export function nextHudMode(current: HudMode): HudMode {
  const idx = HUD_MODES.indexOf(current);
  return HUD_MODES[(idx + 1) % HUD_MODES.length];
}

export interface PerfHudMapStats {
  ev: number;
  ch: number;
  pic: number;
  gmMs?: number;
  evMs?: number;
  ssMs?: number;
  winMs?: number;
  fastPct?: number;
}

export interface PerfHudGlStats {
  drawsPerFrame: number;
  texUploads: number;
  err: number;
}

export interface PerfHudSnapshot {
  engine: 'MV' | 'MZ';
  backend: string;
  fps: number;
  frameMs: number;
  updateMs?: number;
  renderMs?: number;
  ticksPerFrame?: number;
  sceneName: string;
  displayMode: string;
  filterMode?: string;
  gameW: number;
  gameH: number;
  vpW: number;
  vpH: number;
  memMiB: number;
  map?: PerfHudMapStats | null;
  gl?: PerfHudGlStats | null;
  frameHistory?: ArrayLike<number>;
  frameHistoryHead?: number;
}

function fpsColor(fps: number): string {
  if (fps >= 55) return '#5ef29d';
  if (fps >= 40) return '#ffd166';
  return '#ff6b6b';
}

function barColor(ms: number): string {
  if (ms <= 18.5) return '#5ef29d';
  if (ms <= 28.0) return '#ffd166';
  return '#ff6b6b';
}

export function drawPerfHud(ctx: any, mode: HudMode, snap: PerfHudSnapshot): void {
  if (!ctx || mode === 'off') return;

  ctx.save();
  if (typeof ctx.setTransform === 'function') {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  if (mode === 'basic') {
    const memStr = snap.memMiB > 0 ? ` | ${snap.memMiB} MiB` : '';
    const label = `SW2RPGMGL (${snap.engine}) | ${Math.round(snap.fps)} FPS${memStr} | ${snap.displayMode.toUpperCase()}`;
    const boxW = Math.min((ctx.canvas?.width || 1280) - 20, Math.max(360, label.length * 10 + 28));
    ctx.fillStyle = 'rgba(10, 14, 24, 0.72)';
    ctx.fillRect(10, 10, boxW, 28);
    ctx.strokeStyle = snap.engine === 'MZ' ? 'rgba(61, 214, 165, 0.55)' : 'rgba(108, 140, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(10.5, 10.5, boxW - 1, 27);
    ctx.fillStyle = snap.engine === 'MZ' ? '#7ef7e6' : '#f0f4ff';
    ctx.font = '16px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 18, 24);
    ctx.restore();
    return;
  }

  // PRO mode: rich translucent telemetry panel + 48-frame live frame-time sparkline
  const accent = snap.engine === 'MZ' ? '#3dd6a5' : '#6c8cff';
  const lines: Array<{ text: string; color: string }> = [];

  const updStr = typeof snap.updateMs === 'number' ? `Upd ${snap.updateMs.toFixed(1)}ms` : '';
  const renStr = typeof snap.renderMs === 'number' ? `Ren ${snap.renderMs.toFixed(1)}ms` : '';
  const tpfStr = typeof snap.ticksPerFrame === 'number' ? `  •  ${snap.ticksPerFrame.toFixed(2)} t/f` : '';
  if (updStr || renStr) {
    lines.push({
      text: `${updStr}${updStr && renStr ? '  ' : ''}${renStr}${tpfStr}`,
      color: '#dce6ff',
    });
  }

  const filtStr = snap.filterMode ? `/${snap.filterMode.toUpperCase()}` : '';
  lines.push({
    text: `${snap.sceneName}  •  ${snap.gameW}×${snap.gameH} → ${snap.vpW}×${snap.vpH} (${snap.displayMode.toUpperCase()}${filtStr})`,
    color: '#b7c6e6',
  });

  if (snap.map) {
    const m = snap.map;
    const timing =
      typeof m.gmMs === 'number' && typeof m.ssMs === 'number' && typeof m.winMs === 'number'
        ? `  GM:${m.gmMs.toFixed(1)}(ev:${(m.evMs ?? 0).toFixed(1)}) SS:${m.ssMs.toFixed(1)} Win:${m.winMs.toFixed(1)}`
        : '';
    lines.push({
      text: `Map ev:${m.ev} ch:${m.ch} pic:${m.pic}${timing}`,
      color: '#a8d8ff',
    });
  }

  if (snap.gl) {
    const errHex = `0x${(snap.gl.err >>> 0).toString(16)}`;
    lines.push({
      text: `GL: ${Math.round(snap.gl.drawsPerFrame)} draws/f  •  tex:${snap.gl.texUploads}  •  err:${errHex}`,
      color: snap.gl.err ? '#ff8b8b' : '#9eead2',
    });
  }

  const hasGraph = Boolean(snap.frameHistory && snap.frameHistory.length > 0);
  const padX = 12;
  const headerH = 26;
  const lineH = 17;
  const graphH = hasGraph ? 32 : 0;
  const boxW = Math.min((ctx.canvas?.width || 1280) - 20, 412);
  const boxH = 10 + headerH + lines.length * lineH + (hasGraph ? graphH + 8 : 4);
  const x0 = 10;
  const y0 = 10;

  // Panel background & accent border
  ctx.fillStyle = 'rgba(10, 14, 24, 0.82)';
  ctx.fillRect(x0, y0, boxW, boxH);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0 + 0.75, y0 + 0.75, boxW - 1.5, boxH - 1.5);
  ctx.fillStyle = accent;
  ctx.fillRect(x0, y0, 4, boxH);

  // Header row: big color-coded FPS + frame ms + engine/backend + RAM
  ctx.textBaseline = 'middle';
  const hdrY = y0 + 18;
  ctx.fillStyle = fpsColor(snap.fps);
  ctx.font = '18px sans-serif';
  const fpsStr = `${snap.fps.toFixed(1)} FPS`;
  ctx.fillText(fpsStr, x0 + padX, hdrY);

  ctx.fillStyle = '#e6eeff';
  ctx.font = '13px sans-serif';
  const memPart = snap.memMiB > 0 ? `  •  ${snap.memMiB} MiB` : '';
  ctx.fillText(
    `(${snap.frameMs.toFixed(1)}ms)  •  ${snap.engine} ${snap.backend}${memPart}`,
    x0 + padX + 86,
    hdrY,
  );

  // Subtle divider
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillRect(x0 + padX, y0 + headerH + 4, boxW - padX * 2, 1);

  // Detail rows
  ctx.font = '12px sans-serif';
  let curY = y0 + headerH + 14;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillStyle = lines[i].color;
    const txt = lines[i].text;
    ctx.fillText(txt.length > 62 ? txt.slice(0, 61) + '…' : txt, x0 + padX, curY);
    curY += lineH;
  }

  // Live 48-frame frame-time sparkline
  if (hasGraph && snap.frameHistory) {
    const hist = snap.frameHistory;
    const len = hist.length;
    const head = snap.frameHistoryHead ?? 0;
    const gx = x0 + padX;
    const gy = curY - 4;
    const gw = boxW - padX * 2;
    const gh = graphH;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(gx, gy, gw, gh);

    // 16.67ms (60 FPS) reference line (scale: 0..40ms -> gh..0)
    const maxMs = 40;
    const ref60Y = Math.round(gy + gh - (16.67 / maxMs) * gh) + 0.5;
    ctx.fillStyle = 'rgba(94, 242, 157, 0.35)';
    ctx.fillRect(gx, ref60Y, gw, 1);

    const barW = Math.max(2, Math.floor((gw - 4) / len));
    const gap = Math.max(1, Math.floor((gw - barW * len) / Math.max(1, len)));
    const step = (gw - 2) / len;
    for (let i = 0; i < len; i++) {
      const idx = (head + i) % len;
      const ms = hist[idx] || 0;
      if (ms <= 0) continue;
      const h = Math.max(1, Math.min(gh - 2, Math.round((ms / maxMs) * (gh - 2))));
      ctx.fillStyle = barColor(ms);
      ctx.fillRect(gx + 1 + Math.round(i * step), gy + gh - 1 - h, Math.max(1, Math.round(step) - (gap > 0 ? 1 : 0)), h);
    }

    ctx.fillStyle = 'rgba(200, 215, 245, 0.72)';
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('16.7ms', gx + gw - 36, gy + 2);
  }

  ctx.restore();
}
