#!/usr/bin/env node
/**
 * Build script for Switch 2 MV Loader (kaiHEN) & NRO packager.
 *
 * Usage:
 *   node tools/build.mjs --js-only                    # Bundle romfs/main.js + generate icon.jpg
 *   node tools/build.mjs [--base <nxjs-switch2.nro>]  # Bundle + pack dist/switch2-MV-loader.nro
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loaderDir = resolve(__dirname, '..');
const projectDir = resolve(loaderDir, '..');
const distDir = join(projectDir, 'dist');

const args = process.argv.slice(2);
const jsOnly = args.includes('--js-only');
const baseArgIdx = args.indexOf('--base');
const baseNroPath = baseArgIdx >= 0 && args[baseArgIdx + 1]
  ? resolve(args[baseArgIdx + 1])
  : join(projectDir, 'upstream', 'nx.js', 'nxjs-switch2.nro');

mkdirSync(join(loaderDir, 'romfs'), { recursive: true });
mkdirSync(distDir, { recursive: true });

// 1. Bundle TypeScript engines -> loader/romfs/main.js (MV) & loader/romfs/mz-main.js (MZ)
console.log('[build] Bundling loader/src/main.ts -> loader/romfs/main.js');
await build({
  entryPoints: [join(loaderDir, 'src', 'main.ts')],
  outfile: join(loaderDir, 'romfs', 'main.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: false,
  sourcemap: false,
});

console.log('[build] Bundling loader/src/mz-main.ts -> loader/romfs/mz-main.js');
await build({
  entryPoints: [join(loaderDir, 'src', 'mz-main.ts')],
  outfile: join(loaderDir, 'romfs', 'mz-main.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: false,
  sourcemap: false,
});

// 2. Build crisp 256x256 baseline JPEG hbmenu icon for Switch 2 URPGM Launcher
function buildCustomIconJpeg(srcPath) {
  const decoded = jpeg.decode(readFileSync(srcPath), { useTArray: true, formatAsRGBA: true });
  const srcW = decoded.width;
  const srcH = decoded.height;
  const src = decoded.data;
  const dstW = 256;
  const dstH = 256;
  const dst = Buffer.alloc(dstW * dstH * 4);

  // High-quality area-box downsampling for crisp 256x256 hbmenu tile
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = dy * scaleY;
    const sy1 = Math.min(srcH, (dy + 1) * scaleY);
    const iy0 = Math.floor(sy0);
    const iy1 = Math.min(srcH - 1, Math.floor(sy1));
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = dx * scaleX;
      const sx1 = Math.min(srcW, (dx + 1) * scaleX);
      const ix0 = Math.floor(sx0);
      const ix1 = Math.min(srcW - 1, Math.floor(sx1));
      let r = 0, g = 0, b = 0, wSum = 0;
      for (let sy = iy0; sy <= iy1; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = ix0; sx <= ix1; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const idx = (sy * srcW + sx) * 4;
          r += src[idx] * w;
          g += src[idx + 1] * w;
          b += src[idx + 2] * w;
          wSum += w;
        }
      }
      const outIdx = (dy * dstW + dx) * 4;
      const inv = wSum > 0 ? 1 / wSum : 1;
      dst[outIdx] = Math.min(255, Math.max(0, Math.round(r * inv)));
      dst[outIdx + 1] = Math.min(255, Math.max(0, Math.round(g * inv)));
      dst[outIdx + 2] = Math.min(255, Math.max(0, Math.round(b * inv)));
      dst[outIdx + 3] = 255;
    }
  }
  return jpeg.encode({ data: dst, width: dstW, height: dstH }, 92).data;
}

function generateLoaderIconJpeg() {
  const customSourcePath = join(loaderDir, 'icon-source.jpg');
  if (existsSync(customSourcePath)) {
    return buildCustomIconJpeg(customSourcePath);
  }
  const W = 256;
  const H = 256;
  const rgba = Buffer.alloc(W * H * 4);

  const setPx = (x, y, r, g, b, a = 1) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    if (a >= 1) {
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    } else {
      rgba[i] = Math.round(r * a + rgba[i] * (1 - a));
      rgba[i + 1] = Math.round(g * a + rgba[i + 1] * (1 - a));
      rgba[i + 2] = Math.round(b * a + rgba[i + 2] * (1 - a));
      rgba[i + 3] = 255;
    }
  };

  const fillRect = (x0, y0, w, h, r, g, b, a = 1) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) setPx(x, y, r, g, b, a);
    }
  };

  // Smooth dark indigo gradient background with subtle diagonal sheen
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (x * 0.35 + y * 0.65) / 256;
      const r = Math.round(14 + 18 * t);
      const g = Math.round(18 + 24 * t);
      const b = Math.round(32 + 44 * t);
      setPx(x, y, r, g, b);
    }
  }

  // Joy-Con inspired dual accent stripes (cyan left, coral-red right)
  fillRect(0, 0, 14, H, 0, 195, 227);
  fillRect(W - 14, 0, 14, H, 255, 69, 84);

  // Subtle framed card center
  fillRect(26, 26, W - 52, H - 52, 20, 26, 44, 0.72);
  fillRect(26, 26, W - 52, 3, 92, 124, 250, 0.9);
  fillRect(26, H - 29, W - 52, 3, 92, 124, 250, 0.9);

  // Crisp 5x7 pixel bitmap font for "MV" (big) and "SWITCH 2" (sub-label)
  const GLYPHS = {
    M: [
      '10001',
      '11011',
      '10101',
      '10001',
      '10001',
      '10001',
      '10001',
    ],
    V: [
      '10001',
      '10001',
      '10001',
      '10001',
      '10001',
      '01010',
      '00100',
    ],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
    I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
    L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  };

  const drawText = (text, centerY, scale, r, g, b) => {
    const glyphW = 5 * scale;
    const gap = 1 * scale;
    const totalW = text.length * glyphW + Math.max(0, text.length - 1) * gap;
    let xCursor = Math.floor((W - totalW) / 2);
    const yStart = Math.floor(centerY - (7 * scale) / 2);
    for (const ch of text) {
      const pattern = GLYPHS[ch] || GLYPHS[' '];
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (pattern[row][col] === '1') {
            fillRect(xCursor + col * scale, yStart + row * scale, scale, scale, r, g, b);
          }
        }
      }
      xCursor += glyphW + gap;
    }
  };

  // Large "MV" emblem with soft drop shadow
  drawText('MV', 102, 13, 10, 14, 28);
  drawText('MV', 98, 13, 241, 245, 255);

  // Accent divider
  fillRect(56, 154, W - 112, 4, 92, 124, 250);

  // Subtitles
  drawText('SWITCH 2', 180, 3, 157, 180, 255);
  drawText('LOADER', 206, 3, 184, 198, 232);

  return jpeg.encode({ data: rgba, width: W, height: H }, 92).data;
}

const iconOutPath = join(loaderDir, 'icon.jpg');
const iconJpg = generateLoaderIconJpeg();
writeFileSync(iconOutPath, iconJpg);
console.log(`[build] Generated 256x256 hbmenu icon -> ${iconOutPath} (${iconJpg.length} bytes)`);

if (jsOnly) {
  console.log('[build] --js-only complete.');
  process.exit(0);
}

// 3. Pack compiled Switch 2 nxjs-switch2.nro + romfs/ + icon.jpg + NACP -> dist/switch2-MV-loader.nro
if (!existsSync(baseNroPath)) {
  console.error(`[build] Base Switch 2 runtime NRO not found at: ${baseNroPath}`);
  console.error('        Run scripts/wsl-setup-and-build.sh inside WSL Ubuntu first to compile nxjs-switch2.nro.');
  process.exit(1);
}

const { NACP } = await import('@tootallnate/nacp');
const NRO = await import('@tootallnate/nro');
const RomFS = await import('@tootallnate/romfs');

console.log(`[build] Packing Switch 2 NRO using base runtime: ${baseNroPath}`);
const baseBuf = readFileSync(baseNroPath);
const decoded = await NRO.decode(new Blob([baseBuf]));

// Pack helper for Switch 2 nx.js engine NROs (MV + MZ)
const meta = JSON.parse(readFileSync(join(loaderDir, 'package.json'), 'utf8')).nacp;
async function packNxjsEngineNro(engineTitle, titleIdHex, mainJsPath, outFileName) {
  const nacp = new NACP(await decoded.nacp.arrayBuffer());
  nacp.title = engineTitle;
  nacp.author = meta.author;
  nacp.version = meta.version;
  nacp.id = BigInt('0x' + titleIdHex);
  // Avoid profile-selection popup on launch; saves go directly to per-game save/ folders on SD card
  const nacpBytes = new Uint8Array(nacp.buffer);
  nacpBytes[0x3025] = 0; // startupUserAccount = None

  const romfs = decoded.romfs ? await RomFS.decode(decoded.romfs) : Object.create(null);
  romfs['main.js'] = new Blob([readFileSync(mainJsPath)]);
  romfs['nxjs.ini'] = new Blob([readFileSync(join(loaderDir, 'romfs', 'nxjs.ini'))]);

  const outBlob = await NRO.encode({
    ...decoded,
    icon: new Blob([iconJpg]),
    nacp: new Blob([new Uint8Array(nacp.buffer)]),
    romfs: await RomFS.encode(romfs),
  });

  const outPath = join(distDir, outFileName);
  const outBuf = Buffer.from(await outBlob.arrayBuffer());
  writeFileSync(outPath, outBuf);
  console.log(`[build] SUCCESS! Wrote ${outPath} (${(outBuf.length / (1024 * 1024)).toFixed(2)} MiB)`);
  return outPath;
}

const mvOutPath = await packNxjsEngineNro(
  'SW2RPGMGL MV Engine',
  meta.id,
  join(loaderDir, 'romfs', 'main.js'),
  'mv-engine-switch2.nro',
);
const mzOutPath = await packNxjsEngineNro(
  'SW2RPGMGL MZ Engine',
  '016d7a656e676900',
  join(loaderDir, 'romfs', 'mz-main.js'),
  'mz-engine-switch2.nro',
);

// Stage into the modular SD-card folder:
//   dist/sd-ready/switch/SW2RPGMGL/
//     ├── SW2RPGMGL.nro  (built by scripts/wsl-build-launcher.sh)
//     ├── engines/
//     │   ├── mv-engine-switch2.nro
//     │   ├── mz-engine-switch2.nro
//     │   ├── mkxp-z-switch2.nro
//     │   └── nxjs.ini
//     └── games/
const sdReadyAppDir = join(distDir, 'sd-ready', 'switch', 'SW2RPGMGL');
const sdReadyEnginesDir = join(sdReadyAppDir, 'engines');
const sdReadyGamesDir = join(sdReadyAppDir, 'games');
const sdReadyLogDir = join(sdReadyAppDir, 'log');
mkdirSync(sdReadyEnginesDir, { recursive: true });
mkdirSync(sdReadyGamesDir, { recursive: true });
mkdirSync(sdReadyLogDir, { recursive: true });
writeFileSync(
  join(sdReadyGamesDir, 'PUT_GAMES_HERE.txt'),
  'Place your RPG Maker MV, MZ, VX Ace / VX / XP, and WOLF RPG Editor game folders in this directory.\n',
);
copyFileSync(mvOutPath, join(sdReadyEnginesDir, 'mv-engine-switch2.nro'));
copyFileSync(mzOutPath, join(sdReadyEnginesDir, 'mz-engine-switch2.nro'));
copyFileSync(join(loaderDir, 'romfs', 'nxjs.ini'), join(sdReadyEnginesDir, 'nxjs.ini'));

// Keep NACP version (and mkxp-z RomFS preload scripts) synchronized across companion NROs in dist/
async function stampCompanionNro(nroPath, updateRomfsFn = null) {
  if (!existsSync(nroPath)) return false;
  const raw = readFileSync(nroPath);
  const dec = await NRO.decode(new Blob([raw]));
  const nacp = new NACP(await dec.nacp.arrayBuffer());
  let changed = false;
  if (nacp.version !== meta.version) {
    nacp.version = meta.version;
    changed = true;
  }
  let romfsBlob = dec.romfs;
  if (updateRomfsFn && dec.romfs) {
    const rfs = await RomFS.decode(dec.romfs);
    if (await updateRomfsFn(rfs)) {
      romfsBlob = await RomFS.encode(rfs);
      changed = true;
    }
  }
  if (changed) {
    const repacked = await NRO.encode({
      ...dec,
      nacp: new Blob([new Uint8Array(nacp.buffer)]),
      romfs: romfsBlob,
    });
    writeFileSync(nroPath, Buffer.from(await repacked.arrayBuffer()));
    console.log(`[build] Stamped ${nroPath} -> v${meta.version}`);
  }
  return true;
}

const mkxpzDist = join(distDir, 'mkxp-z-switch2.nro');
if (
  await stampCompanionNro(mkxpzDist, async (rfs) => {
    if (!rfs?.preload) return false;
    let touched = false;
    const compatPath = join(loaderDir, '..', 'scripts', 'mkxpz', 'preload-compat-v2.rb');
    if (existsSync(compatPath) && rfs.preload['win32api_stub.rb']) {
      const compatSrc = readFileSync(compatPath, 'utf8').replace(/\r\n/g, '\n');
      let stubText = (await rfs.preload['win32api_stub.rb'].text()).replace(/\r\n/g, '\n');
      const marker = '\n# [switch2-preload-compat-v2]';
      const idx = stubText.indexOf(marker);
      const baseStub = idx >= 0 ? stubText.slice(0, idx) : stubText;
      const nextStub = baseStub + (compatSrc.startsWith('\n') ? compatSrc : '\n' + compatSrc);
      if (nextStub !== stubText) {
        rfs.preload['win32api_stub.rb'] = new Blob([nextStub]);
        touched = true;
      }
    }
    const loadScreenPath = join(loaderDir, '..', 'scripts', 'mkxpz', 'loading-screen.rb');
    if (existsSync(loadScreenPath) && rfs.preload['loading_screen.rb']) {
      const lsSrc = readFileSync(loadScreenPath, 'utf8').replace(/\r\n/g, '\n');
      const curLs = (await rfs.preload['loading_screen.rb'].text()).replace(/\r\n/g, '\n');
      if (lsSrc !== curLs) {
        rfs.preload['loading_screen.rb'] = new Blob([lsSrc]);
        touched = true;
      }
    }
    const hooksPath = join(loaderDir, '..', 'scripts', 'mkxpz', 'win32-hooks.rb');
    if (existsSync(hooksPath) && rfs.preload['win32_wrap.rb']) {
      const hooksSrc = readFileSync(hooksPath, 'utf8').replace(/\r\n/g, '\n');
      const curWrap = (await rfs.preload['win32_wrap.rb'].text()).replace(/\r\n/g, '\n');
      const hMarker = '\n# [switch2-win32-hooks-v1]';
      const hIdx = curWrap.indexOf(hMarker);
      const baseWrap = hIdx >= 0 ? curWrap.slice(0, hIdx) : curWrap.replace(/\n+$/, '');
      const nextWrap = baseWrap + '\n' + hooksSrc.replace(/^\n+/, '');
      if (nextWrap !== curWrap) {
        rfs.preload['win32_wrap.rb'] = new Blob([nextWrap]);
        touched = true;
      }
    }
    return touched;
  })
) {
  copyFileSync(mkxpzDist, join(sdReadyEnginesDir, 'mkxp-z-switch2.nro'));
}
const wolfDist = join(distDir, 'wolf-engine-switch2.nro');
if (await stampCompanionNro(wolfDist)) {
  copyFileSync(wolfDist, join(sdReadyEnginesDir, 'wolf-engine-switch2.nro'));
}
const launcherDist = join(distDir, 'SW2RPGMGL.nro');
if (await stampCompanionNro(launcherDist)) {
  copyFileSync(launcherDist, join(sdReadyAppDir, 'SW2RPGMGL.nro'));
}
console.log(`[build] Staged SD-ready SW2RPGMGL layout -> ${sdReadyAppDir}`);
