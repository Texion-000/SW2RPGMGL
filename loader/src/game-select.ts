/**
 * Interactive Nintendo Switch 2 Game Select screen for the Universal MV Loader.
 * Supports Joy-Con / Pro Controller (D-Pad, Left Stick, A, X, L/R, +) and Touchscreen.
 */
import type { GameEngine, GameEntry } from './games';
import {
  discoverGames,
  engineBadgeLabel,
  engineFullLabel,
  findMkxpzNroPath,
  loadLastSelectedGameId,
  saveLastSelectedGameId,
} from './games';
import { log, type SwitchApi } from './log';
import { decodePngToRgba } from './png-decode';

function engineBadgeColor(engine: GameEngine): [string, string] {
  switch (engine) {
    case 'mv': return ['#253668', '#8ba8ff'];
    case 'mz': return ['#1b4d4a', '#7ef7e6'];
    case 'vxace': return ['#4d1d3a', '#ff7aa8'];
    case 'vx': return ['#4c3214', '#ffb85c'];
    case 'xp': return ['#14453d', '#52e3c2'];
  }
}

interface IconSlot {
  img: any | null;
  width: number;
  height: number;
  url: string | null;
  loaded: boolean;
}

function pollGamepad(): Gamepad | null {
  try {
    const pads = navigator.getGamepads?.();
    if (!pads) return null;
    for (const pad of pads) {
      if (pad && pad.connected) return pad;
    }
  } catch { /* ignore */ }
  return null;
}

function truncateText(ctx: any, text: string, maxWidth: number): string {
  if (!text) return '';
  try {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, Math.max(1, lo)) + '…';
  } catch {
    return text.slice(0, 40);
  }
}

function drawRoundedRect(
  ctx: any,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

function pickMonogramColors(seed: string): [string, string] {
  const palettes: Array<[string, string]> = [
    ['#3c2458', '#9b6bff'],
    ['#1e3a5f', '#4ea8ff'],
    ['#4f1f34', '#e85d87'],
    ['#1d443c', '#3dd6a5'],
    ['#4a3519', '#f0a642'],
    ['#2a2d54', '#748ffc'],
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return palettes[Math.abs(h) % palettes.length];
}

export function runGameSelect(
  ctx: any,
  sw: SwitchApi,
  loaderDir: string,
  initialGames: GameEntry[],
): Promise<GameEntry> {
  return new Promise<GameEntry>((resolve) => {
    let games = initialGames.slice();
    let selected = 0;
    let scrollTop = 0;
    let statusBanner = '';
    let statusBannerUntil = 0;
    let finished = false;
    let rafId = 0;

    // Restore last launched game cursor if present
    const lastId = loadLastSelectedGameId(sw, loaderDir);
    if (lastId) {
      const idx = games.findIndex((g) => g.id === lastId);
      if (idx >= 0) selected = idx;
    }

    const icons = new Map<string, IconSlot>();

    function revokeAllIcons(): void {
      for (const slot of icons.values()) {
        if (slot.url) {
          try { URL.revokeObjectURL(slot.url); } catch { /* ignore */ }
        }
      }
      icons.clear();
    }

    function drawIconIntoBox(
      targetCtx: any,
      slot: IconSlot,
      x: number,
      y: number,
      boxSize: number,
      radius: number,
    ): void {
      targetCtx.save();
      drawRoundedRect(targetCtx, x, y, boxSize, boxSize, radius);
      targetCtx.clip();
      targetCtx.fillStyle = '#0d1018';
      targetCtx.fillRect(x, y, boxSize, boxSize);
      const iw = slot.width || slot.img?.width || boxSize;
      const ih = slot.height || slot.img?.height || boxSize;
      const fitScale = Math.min(boxSize / Math.max(1, iw), boxSize / Math.max(1, ih));
      const dw = Math.max(1, Math.round(iw * fitScale));
      const dh = Math.max(1, Math.round(ih * fitScale));
      const dx = x + Math.floor((boxSize - dw) / 2);
      const dy = y + Math.floor((boxSize - dh) / 2);
      targetCtx.imageSmoothingEnabled = iw > 48 || ih > 48;
      targetCtx.drawImage(slot.img, dx, dy, dw, dh);
      targetCtx.restore();
    }

    function loadIconsForGames(list: GameEntry[]): void {
      revokeAllIcons();
      const ImgCtor = (globalThis as any).Image;
      const OffCanvasCtor = (globalThis as any).OffscreenCanvas;
      const ImageDataCtor = (globalThis as any).ImageData;

      for (const g of list) {
        if (!g.iconPath) continue;
        const slot: IconSlot = { img: null, width: 0, height: 0, url: null, loaded: false };
        icons.set(g.id, slot);
        void sw.readFile(g.iconPath).then(async (buf) => {
          if (finished || !buf) return;
          const u8 = new Uint8Array(buf);
          const isPng =
            u8.byteLength >= 33 &&
            u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47;

          // 1. Decode PNGs via our spec-compliant RGBA32 decoder (supports palette+tRNS,
          //    grayscale, 16-bit, RGB, RGBA, Adam7) so nx.js libpng quirks never corrupt icons!
          if (isPng && OffCanvasCtor && ImageDataCtor) {
            try {
              const decoded = await decodePngToRgba(u8);
              if (finished) return;
              const oc = new OffCanvasCtor(decoded.width, decoded.height);
              const octx = oc.getContext('2d');
              if (octx) {
                const imgData = new ImageDataCtor(decoded.rgba, decoded.width, decoded.height);
                octx.putImageData(imgData, 0, 0);
                slot.img = oc;
                slot.width = decoded.width;
                slot.height = decoded.height;
                slot.loaded = true;
                log(`[select] icon '${g.folderName}': ${decoded.width}x${decoded.height} ct=${decoded.colorType} bd=${decoded.bitDepth}`);
                return;
              }
            } catch (err) {
              log(`[select] png-decode failed for '${g.folderName}': ${String(err)}`);
            }
          }

          // 2. Fallback to native Image (for JPEG / WebP icons)
          if (ImgCtor && typeof URL?.createObjectURL === 'function') {
            try {
              const blob = new Blob([buf]);
              const url = URL.createObjectURL(blob);
              slot.url = url;
              const img = new ImgCtor();
              img.onload = () => {
                if (finished) return;
                slot.img = img;
                slot.width = img.width || 0;
                slot.height = img.height || 0;
                slot.loaded = true;
              };
              img.onerror = () => {
                slot.loaded = false;
              };
              img.src = url;
            } catch {
              /* ignore icon decode failures */
            }
          }
        }).catch(() => {});
      }
    }

    loadIconsForGames(games);

    // Input edge + smooth hold-repeat tracking
    let prevUp = false;
    let prevDown = false;
    let prevL = false;
    let prevR = false;
    let prevA = true; // Ignore any A still held from hbmenu launch!
    let prevX = false;
    let prevPlus = false;
    let holdDir = 0;
    let holdNextMs = 0;

    // Layout cache for touchscreen hit-testing
    let cardRects: Array<{ index: number; x: number; y: number; w: number; h: number }> = [];
    let playBtnRect: { x: number; y: number; w: number; h: number } | null = null;
    let rescanBtnRect: { x: number; y: number; w: number; h: number } | null = null;

    function launchSelected(): void {
      if (finished || games.length === 0) return;
      const chosen = games[selected];
      if (!chosen) return;
      finished = true;
      cleanup();
      saveLastSelectedGameId(sw, loaderDir, chosen.id);
      log(`[select] launching '${chosen.title}' (${chosen.wwwRoot})`);
      resolve(chosen);
    }

    function rescan(): void {
      const prevId = games[selected]?.id ?? null;
      games = discoverGames(sw, loaderDir);
      selected = prevId ? Math.max(0, games.findIndex((g) => g.id === prevId)) : 0;
      if (selected >= games.length) selected = Math.max(0, games.length - 1);
      scrollTop = 0;
      loadIconsForGames(games);
      statusBanner = `Rescanned SD card — found ${games.length} RPG Maker MV game${games.length === 1 ? '' : 's'}`;
      statusBannerUntil = performance.now() + 2600;
    }

    const onTouchStart = (ev: any) => {
      if (finished) return;
      const t = ev.changedTouches?.[0] ?? ev.touches?.[0];
      if (!t) return;
      const tx = t.clientX;
      const ty = t.clientY;

      if (playBtnRect && tx >= playBtnRect.x && tx <= playBtnRect.x + playBtnRect.w && ty >= playBtnRect.y && ty <= playBtnRect.y + playBtnRect.h) {
        launchSelected();
        return;
      }
      if (rescanBtnRect && tx >= rescanBtnRect.x && tx <= rescanBtnRect.x + rescanBtnRect.w && ty >= rescanBtnRect.y && ty <= rescanBtnRect.y + rescanBtnRect.h) {
        rescan();
        return;
      }
      for (const r of cardRects) {
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          if (selected === r.index) {
            launchSelected();
          } else {
            selected = r.index;
          }
          return;
        }
      }
    };

    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('touchstart', onTouchStart);
    }

    function cleanup(): void {
      if (rafId) {
        try { cancelAnimationFrame(rafId); } catch { /* ignore */ }
        rafId = 0;
      }
      if (typeof globalThis.removeEventListener === 'function') {
        globalThis.removeEventListener('touchstart', onTouchStart);
      }
      revokeAllIcons();
    }

    function moveSelection(delta: number, visibleRows: number): void {
      if (games.length === 0) return;
      selected = (selected + delta + games.length) % games.length;
      if (selected < scrollTop) scrollTop = selected;
      if (selected >= scrollTop + visibleRows) scrollTop = selected - visibleRows + 1;
    }

    function renderFrame(): void {
      if (finished) return;
      const swPx = ctx.canvas?.width || 1280;
      const shPx = ctx.canvas?.height || 720;
      const scale = shPx / 720;
      const px = (n: number) => Math.round(n * scale);

      const headerH = px(92);
      const footerH = px(56);
      const padX = px(44);
      const contentY = headerH + px(16);
      const contentH = shPx - headerH - footerH - px(32);

      const rowH = px(80);
      const rowGap = px(10);
      const visibleRows = Math.max(1, Math.floor((contentH + rowGap) / (rowH + rowGap)));

      // Poll controller input
      const pad = pollGamepad();
      const up = Boolean(pad?.buttons?.[12]?.pressed || (pad?.axes?.[1] ?? 0) < -0.5);
      const down = Boolean(pad?.buttons?.[13]?.pressed || (pad?.axes?.[1] ?? 0) > 0.5);
      const lBtn = Boolean(pad?.buttons?.[4]?.pressed);
      const rBtn = Boolean(pad?.buttons?.[5]?.pressed);
      const aBtn = Boolean(pad?.buttons?.[1]?.pressed);
      const xBtn = Boolean(pad?.buttons?.[3]?.pressed);
      const plusBtn = Boolean(pad?.buttons?.[9]?.pressed);

      const now = performance.now();
      const dir = up ? -1 : down ? 1 : 0;
      if (dir !== 0) {
        if (dir !== holdDir || (!prevUp && !prevDown)) {
          moveSelection(dir, visibleRows);
          holdDir = dir;
          holdNextMs = now + 320;
        } else if (now >= holdNextMs) {
          moveSelection(dir, visibleRows);
          holdNextMs = now + 95;
        }
      } else {
        holdDir = 0;
      }

      if (lBtn && !prevL && games.length > 0) {
        selected = Math.max(0, selected - visibleRows);
        if (selected < scrollTop) scrollTop = selected;
      }
      if (rBtn && !prevR && games.length > 0) {
        selected = Math.min(games.length - 1, selected + visibleRows);
        if (selected >= scrollTop + visibleRows) scrollTop = Math.max(0, selected - visibleRows + 1);
      }
      if (xBtn && !prevX) {
        rescan();
      }
      if (plusBtn && !prevPlus) {
        finished = true;
        cleanup();
        log('[select] user pressed Plus (+) -> exiting to hbmenu');
        sw.exit();
        return;
      }
      if (aBtn && !prevA && games.length > 0) {
        launchSelected();
        return;
      }

      prevUp = up;
      prevDown = down;
      prevL = lBtn;
      prevR = rBtn;
      prevA = aBtn;
      prevX = xBtn;
      prevPlus = plusBtn;

      // Clamp scrollTop
      const maxScroll = Math.max(0, games.length - visibleRows);
      if (scrollTop > maxScroll) scrollTop = maxScroll;
      if (selected < scrollTop) scrollTop = selected;
      if (selected >= scrollTop + visibleRows) scrollTop = Math.max(0, selected - visibleRows + 1);

      // Draw background
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#0d1018';
      ctx.fillRect(0, 0, swPx, shPx);

      // Subtle header bar
      ctx.fillStyle = '#141926';
      ctx.fillRect(0, 0, swPx, headerH);
      ctx.fillStyle = '#5c7cfa';
      ctx.fillRect(0, headerH - px(2), swPx, px(2));

      // Header title & metadata
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#f1f5ff';
      ctx.font = `${px(30)}px sans-serif`;
      ctx.fillText('SW2RPGMGL', padX, px(18));

      ctx.fillStyle = '#8b98b8';
      ctx.font = `${px(15)}px sans-serif`;
      ctx.fillText('Universal RPG Maker MV & VX Ace Launcher  •  kaiHEN / OunceVK GPU', padX, px(56));

      ctx.textAlign = 'right';
      ctx.fillStyle = '#9db4ff';
      ctx.font = `${px(17)}px sans-serif`;
      ctx.fillText(
        `${games.length} Game${games.length === 1 ? '' : 's'} Found`,
        swPx - padX,
        px(24),
      );
      ctx.fillStyle = '#6f7d9d';
      ctx.font = `${px(13)}px sans-serif`;
      ctx.fillText(truncateText(ctx, loaderDir, px(460)), swPx - padX, px(54));
      ctx.textAlign = 'left';

      cardRects = [];
      playBtnRect = null;
      rescanBtnRect = null;

      if (games.length === 0) {
        // Empty-state setup guide
        const boxW = Math.min(swPx - padX * 2, px(860));
        const boxH = Math.min(contentH, px(430));
        const bx = Math.floor((swPx - boxW) / 2);
        const by = contentY + Math.floor((contentH - boxH) / 2);

        drawRoundedRect(ctx, bx, by, boxW, boxH, px(14));
        ctx.fillStyle = '#151b2b';
        ctx.fill();
        ctx.strokeStyle = '#2d3958';
        ctx.lineWidth = px(2);
        ctx.stroke();

        ctx.fillStyle = '#ffd166';
        ctx.font = `${px(26)}px sans-serif`;
        ctx.fillText('No RPG Maker Games Found', bx + px(32), by + px(28));

        ctx.fillStyle = '#c5d0ea';
        ctx.font = `${px(17)}px sans-serif`;
        ctx.fillText('Copy any PC RPG Maker MV ("www/") or VX Ace ("Game.ini") game into a subfolder here:', bx + px(32), by + px(70));

        const codeY = by + px(110);
        const codeH = px(214);
        drawRoundedRect(ctx, bx + px(32), codeY, boxW - px(64), codeH, px(8));
        ctx.fillStyle = '#0c1019';
        ctx.fill();

        const treeLines = [
          `${loaderDir}/`,
          '  ├── switch2-MV-loader.nro',
          '  ├── nxjs.ini',
          '  └── demons-roots/              (any game folder name)',
          '      ├── save/                  (optional: drop PC *.rpgsave here)',
          '      └── www/                   (contains index.html, data/, img/, js/)',
        ];
        ctx.fillStyle = '#9ec5ff';
        ctx.font = `${px(16)}px monospace`;
        for (let i = 0; i < treeLines.length; i++) {
          ctx.fillText(treeLines[i], bx + px(50), codeY + px(22) + i * px(29));
        }

        // Rescan button
        const btnW = px(200);
        const btnH = px(44);
        const btnX = bx + px(32);
        const btnY = by + boxH - btnH - px(24);
        rescanBtnRect = { x: btnX, y: btnY, w: btnW, h: btnH };
        drawRoundedRect(ctx, btnX, btnY, btnW, btnH, px(8));
        ctx.fillStyle = '#334678';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `${px(17)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('X  Rescan SD Card', btnX + btnW / 2, btnY + btnH / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
      } else {
        // Two-column layout: scrollable game list (left ~62%) + selected details panel (right ~36%)
        const gap = px(24);
        const totalW = swPx - padX * 2;
        const listW = Math.floor(totalW * 0.62);
        const detailW = totalW - listW - gap;
        const detailX = padX + listW + gap;

        const endIdx = Math.min(games.length, scrollTop + visibleRows);
        for (let i = scrollTop; i < endIdx; i++) {
          const g = games[i];
          const rowIdx = i - scrollTop;
          const cy = contentY + rowIdx * (rowH + rowGap);
          const isSel = i === selected;

          cardRects.push({ index: i, x: padX, y: cy, w: listW, h: rowH });

          drawRoundedRect(ctx, padX, cy, listW, rowH, px(12));
          ctx.fillStyle = isSel ? '#1f2942' : '#141926';
          ctx.fill();
          ctx.strokeStyle = isSel ? '#6c8cff' : '#232c43';
          ctx.lineWidth = isSel ? px(3) : px(1);
          ctx.stroke();

          // Left accent bar for selected item
          if (isSel) {
            drawRoundedRect(ctx, padX + px(4), cy + px(12), px(5), rowH - px(24), px(3));
            ctx.fillStyle = '#6c8cff';
            ctx.fill();
          }

          // Game icon box
          const iconSize = px(56);
          const ix = padX + px(18);
          const iy = cy + Math.floor((rowH - iconSize) / 2);
          const slot = icons.get(g.id);
          if (slot?.loaded && slot.img) {
            drawIconIntoBox(ctx, slot, ix, iy, iconSize, px(8));
          } else {
            const [bg, fg] = pickMonogramColors(g.folderName);
            drawRoundedRect(ctx, ix, iy, iconSize, iconSize, px(8));
            ctx.fillStyle = bg;
            ctx.fill();
            ctx.fillStyle = fg;
            ctx.font = `${px(24)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const initials = (g.title.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || 'MV').toUpperCase();
            ctx.fillText(initials, ix + iconSize / 2, iy + iconSize / 2);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
          }

          // Title, engine badge & metadata line
          const textX = ix + iconSize + px(16);
          const badgeText = engineBadgeLabel(g.engine);
          const badgeW = px(badgeText.length > 3 ? 72 : 46);
          const badgeH = px(24);
          const badgeX = padX + listW - badgeW - px(16);
          const badgeY = cy + px(14);
          const [badgeBg, badgeFg] = engineBadgeColor(g.engine);
          drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, px(6));
          ctx.fillStyle = badgeBg;
          ctx.fill();
          ctx.fillStyle = badgeFg;
          ctx.font = `${px(12)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';

          const textMaxW = badgeX - textX - px(12);
          ctx.fillStyle = isSel ? '#ffffff' : '#dce4f7';
          ctx.font = `${px(21)}px sans-serif`;
          ctx.fillText(truncateText(ctx, g.title, textMaxW), textX, cy + px(13));

          const metaParts: string[] = [
            `${g.folderName}/`,
            g.saveCount > 0 ? `${g.saveCount} save${g.saveCount === 1 ? '' : 's'}` : 'no saves yet',
            g.engine === 'mv'
              ? `${g.pluginCount} plugin${g.pluginCount === 1 ? '' : 's'}`
              : 'mkxp-z runtime',
          ];
          ctx.fillStyle = isSel ? '#9eb4e8' : '#73809e';
          ctx.font = `${px(14)}px sans-serif`;
          ctx.fillText(truncateText(ctx, metaParts.join('   •   '), listW - (textX - padX) - px(20)), textX, cy + px(46));
        }

        // Scrollbar indicator if list overflows
        if (games.length > visibleRows) {
          const trackX = padX + listW + px(6);
          const trackW = px(5);
          const trackH = contentH;
          ctx.fillStyle = '#1d2436';
          ctx.fillRect(trackX, contentY, trackW, trackH);
          const thumbH = Math.max(px(32), Math.round((visibleRows / games.length) * trackH));
          const thumbY = contentY + Math.round((scrollTop / Math.max(1, games.length - visibleRows)) * (trackH - thumbH));
          ctx.fillStyle = '#5c7cfa';
          ctx.fillRect(trackX, thumbY, trackW, thumbH);
        }

        // Right-hand details panel for the selected game
        const selGame = games[selected];
        if (selGame) {
          drawRoundedRect(ctx, detailX, contentY, detailW, contentH, px(14));
          ctx.fillStyle = '#141926';
          ctx.fill();
          ctx.strokeStyle = '#252f49';
          ctx.lineWidth = px(2);
          ctx.stroke();

          // Large icon preview
          const bigIcon = px(112);
          const bix = detailX + Math.floor((detailW - bigIcon) / 2);
          const biy = contentY + px(26);
          const slot = icons.get(selGame.id);
          if (slot?.loaded && slot.img) {
            drawIconIntoBox(ctx, slot, bix, biy, bigIcon, px(14));
          } else {
            const [bg, fg] = pickMonogramColors(selGame.folderName);
            drawRoundedRect(ctx, bix, biy, bigIcon, bigIcon, px(14));
            ctx.fillStyle = bg;
            ctx.fill();
            ctx.fillStyle = fg;
            ctx.font = `${px(44)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const initials = (selGame.title.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || 'MV').toUpperCase();
            ctx.fillText(initials, bix + bigIcon / 2, biy + bigIcon / 2);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
          }

          const dPad = px(24);
          const dMaxW = detailW - dPad * 2;
          ctx.textAlign = 'center';
          ctx.fillStyle = '#ffffff';
          ctx.font = `${px(22)}px sans-serif`;
          ctx.fillText(truncateText(ctx, selGame.title, dMaxW), detailX + detailW / 2, biy + bigIcon + px(18));

          ctx.fillStyle = '#8294be';
          ctx.font = `${px(14)}px sans-serif`;
          ctx.fillText(
            truncateText(ctx, `Folder: ${selGame.folderName}/`, dMaxW),
            detailX + detailW / 2,
            biy + bigIcon + px(50),
          );
          ctx.textAlign = 'left';

          // Detail rows
          const infoStartY = biy + bigIcon + px(86);
          const mkxpAvailable = selGame.engine === 'mv' ? true : findMkxpzNroPath(sw, loaderDir) !== null;
          const infoRows: Array<[string, string]> = selGame.engine === 'mv'
            ? [
                ['Engine', engineFullLabel(selGame.engine)],
                ['Saves', `${selGame.saveCount} slot file${selGame.saveCount === 1 ? '' : 's'}`],
                ['Plugins', `${selGame.pluginCount} enabled`],
                ['Assets', selGame.encrypted ? 'Encrypted (.rpgmvp/.rpgmvo)' : 'Unencrypted'],
                ['Save Path', `${selGame.folderName}/save/`],
              ]
            : [
                ['Engine', engineFullLabel(selGame.engine)],
                ['Saves', `${selGame.saveCount} save file${selGame.saveCount === 1 ? '' : 's'}`],
                ['Runtime', mkxpAvailable ? 'mkxp-z-switch2.nro ready' : 'Missing mkxp-z-switch2.nro!'],
                ['Archive', selGame.encrypted ? 'Encrypted (.rgss3a/.rgss)' : 'Unpacked Data/'],
                ['Save Path', `${selGame.folderName}/`],
              ];
          for (let r = 0; r < infoRows.length; r++) {
            const ry = infoStartY + r * px(30);
            ctx.fillStyle = '#6f7e9e';
            ctx.font = `${px(14)}px sans-serif`;
            ctx.fillText(infoRows[r][0], detailX + dPad, ry);

            ctx.textAlign = 'right';
            ctx.fillStyle = '#d3ddf5';
            ctx.fillText(truncateText(ctx, infoRows[r][1], dMaxW * 0.65), detailX + detailW - dPad, ry);
            ctx.textAlign = 'left';
          }

          // Launch button
          const btnH = px(50);
          const btnX = detailX + dPad;
          const btnY = contentY + contentH - btnH - px(24);
          const btnW = detailW - dPad * 2;
          playBtnRect = { x: btnX, y: btnY, w: btnW, h: btnH };

          drawRoundedRect(ctx, btnX, btnY, btnW, btnH, px(10));
          ctx.fillStyle = '#4c6ef5';
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.font = `${px(20)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('A   Launch Game', btnX + btnW / 2, btnY + btnH / 2);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
        }
      }

      // Optional transient status toast
      if (statusBanner && now < statusBannerUntil) {
        const toastW = Math.min(swPx - px(80), px(520));
        const toastH = px(34);
        const tx = Math.floor((swPx - toastW) / 2);
        const ty = shPx - footerH - toastH - px(10);
        drawRoundedRect(ctx, tx, ty, toastW, toastH, px(8));
        ctx.fillStyle = 'rgba(30, 44, 78, 0.94)';
        ctx.fill();
        ctx.strokeStyle = '#5c7cfa';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#e5edff';
        ctx.font = `${px(14)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(statusBanner, tx + toastW / 2, ty + toastH / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
      }

      // Footer bar with controls legend
      const footerY = shPx - footerH;
      ctx.fillStyle = '#121622';
      ctx.fillRect(0, footerY, swPx, footerH);
      ctx.fillStyle = '#232b40';
      ctx.fillRect(0, footerY, swPx, px(1));

      ctx.fillStyle = '#9aa8c7';
      ctx.font = `${px(15)}px sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(
        games.length > 0
          ? 'D-Pad / Stick: Browse   •   A / Tap: Launch   •   X: Rescan   •   +: Exit to hbmenu'
          : 'X: Rescan SD Card   •   +: Exit to hbmenu',
        padX,
        footerY + footerH / 2,
      );

      ctx.textAlign = 'right';
      ctx.fillStyle = '#6f7e9e';
      ctx.fillText('In-game Quick Menu: Minus (-)', swPx - padX, footerY + footerH / 2);
      ctx.textAlign = 'left';
      ctx.restore();

      rafId = requestAnimationFrame(renderFrame);
    }

    rafId = requestAnimationFrame(renderFrame);
  });
}
