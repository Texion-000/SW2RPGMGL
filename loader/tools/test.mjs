#!/usr/bin/env node
/**
 * Automated verification of the Universal Switch 2 MV Loader shims, multi-game discovery,
 * auto-font registration, audio format detection, and Demons Roots plugin compatibility.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loaderDir = resolve(__dirname, '..');
const gameWww = resolve(loaderDir, '..', '..', 'Demons Roots', 'www');

// Bundle helper modules in memory for Node test execution
const bundleRes = await build({
  stdin: {
    contents: `
      export * from './src/log.ts';
      export * from './src/assets.ts';
      export * from './src/games.ts';
      export * from './src/mv-compat.ts';
      export * from './src/mz-compat.ts';
      export * from './src/node-compat.ts';
      export * from './src/saves.ts';
      export * from './src/browser-host.ts';
      export * from './src/input.ts';
      export * from './src/png-decode.ts';
      export * from './src/perf-hud.ts';
    `,
    resolveDir: loaderDir,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  write: false,
  target: 'es2022',
});
const modUrl = `data:text/javascript;base64,${Buffer.from(bundleRes.outputFiles[0].text).toString('base64')}`;
const mod = await import(modUrl);

// Helper: in-memory mock SwitchApi
function createMockSwitch(initialFiles = {}) {
  const memFiles = new Map();
  for (const [k, v] of Object.entries(initialFiles)) {
    memFiles.set(k, typeof v === 'string' ? new TextEncoder().encode(v).buffer : v);
  }
  const sw = {
    argv: ['sdmc:/switch/switch2-MV-loader/switch2-MV-loader.nro'],
    statSync(p) {
      const clean = p.replace(/\/+$/, '');
      if (memFiles.has(clean)) return { mode: 0o100644, size: memFiles.get(clean).byteLength };
      const prefix = clean + '/';
      for (const k of memFiles.keys()) {
        if (k.startsWith(prefix)) return { mode: 0o040755, size: 0 };
      }
      return null;
    },
    mkdirSync() {},
    readFileSync(p) { return memFiles.get(p.replace(/\/+$/, '')) ?? null; },
    async readFile(p) { return memFiles.get(p.replace(/\/+$/, '')) ?? null; },
    writeFileSync(p, val) {
      memFiles.set(p.replace(/\/+$/, ''), typeof val === 'string' ? new TextEncoder().encode(val).buffer : val);
    },
    removeSync(p) { memFiles.delete(p.replace(/\/+$/, '')); },
    readDirSync(dir) {
      const clean = dir.replace(/\/+$/, '') + '/';
      const names = new Set();
      for (const k of memFiles.keys()) {
        if (k.startsWith(clean)) {
          const seg = k.slice(clean.length).split('/')[0];
          if (seg) names.add(seg);
        }
      }
      return [...names];
    },
    exit() {},
    _files: memFiles,
  };
  return sw;
}

// 1. Verify argv[0] -> loader directory resolution & direct-launch handoff args
assert.equal(
  mod.resolveLoaderDirFromArgv('sdmc:/switch/switch2-MV-loader/switch2-MV-loader.nro'),
  'sdmc:/switch/switch2-MV-loader',
);
assert.equal(
  mod.resolveLoaderDirFromArgv('sdmc:/switch/SW2RPGMGL/engines/mv-engine-switch2.nro'),
  'sdmc:/switch/SW2RPGMGL',
);
assert.equal(
  mod.resolveLoaderDirFromArgv('/switch/custom-mv/loader.nro'),
  'sdmc:/switch/custom-mv',
);
assert.equal(mod.resolveLoaderDirFromArgv(''), 'sdmc:/switch/SW2RPGMGL');
const handoff = mod.resolveLaunchArgs([
  'sdmc:/switch/SW2RPGMGL/engines/mv-engine-switch2.nro',
  'sdmc:/switch/SW2RPGMGL/engines/mv-engine-switch2.nro',
  'sdmc:/switch/SW2RPGMGL/demons-roots',
  'sdmc:/switch/SW2RPGMGL/SW2RPGMGL.nro',
]);
assert.equal(handoff.loaderDir, 'sdmc:/switch/SW2RPGMGL');
assert.equal(handoff.directGameDir, 'sdmc:/switch/SW2RPGMGL/demons-roots');
assert.equal(handoff.returnNroPath, 'sdmc:/switch/SW2RPGMGL/SW2RPGMGL.nro');
console.log('[PASS] Dynamic loader directory resolution & modular engine handoff args');

// 2. Verify multi-game discovery (standard www/, flat web export, mv-loader.json overrides, save counts)
const multiSw = createMockSwitch({
  'sdmc:/switch/switch2-MV-loader/demons-roots/www/index.html': '<html><title>DR</title></html>',
  'sdmc:/switch/switch2-MV-loader/demons-roots/www/data/System.json': JSON.stringify({
    gameTitle: 'Demons Roots v1.03',
    locale: 'ja_JP',
    hasEncryptedImages: true,
    hasEncryptedAudio: true,
  }),
  'sdmc:/switch/switch2-MV-loader/demons-roots/www/js/plugins.js': '{"name":"A","status":true},{"name":"B","status":true}',
  'sdmc:/switch/switch2-MV-loader/demons-roots/www/icon/icon.png': new Uint8Array([137, 80, 78, 71]).buffer,
  'sdmc:/switch/switch2-MV-loader/demons-roots/save/file1.rpgsave': 'abc',
  'sdmc:/switch/switch2-MV-loader/demons-roots/save/file2.rpgsave': 'def',
  'sdmc:/switch/switch2-MV-loader/demons-roots/save/global.rpgsave': 'ghi',

  'sdmc:/switch/switch2-MV-loader/another-rpg/www/index.html': '<html><title>Another RPG</title></html>',
  'sdmc:/switch/switch2-MV-loader/another-rpg/mv-loader.json': JSON.stringify({
    title: 'Another RPG (HD)',
    skipPlugins: ['MyBrokenPCPlugin'],
    audioFormat: 'm4a',
  }),

  'sdmc:/switch/switch2-MV-loader/flat-game/index.html': '<html><title>Flat Export RPG</title></html>',
  'sdmc:/switch/switch2-MV-loader/flat-game/js/rpg_core.js': '// core',

  'sdmc:/switch/switch2-MV-loader/Black Souls 2/Game.ini': '[Game]\r\nLibrary=System\\RGSS301.dll\r\nTitle=BLACK SOULS 2\r\n',
  'sdmc:/switch/switch2-MV-loader/Black Souls 2/Game.rgss3a': 'RGSSAD',
  'sdmc:/switch/switch2-MV-loader/Black Souls 2/Save01.rvdata2': 'save1',
  'sdmc:/switch/switch2-MV-loader/mkxp-z-switch2.nro': 'NRO',
});

const found = mod.discoverGames(multiSw, 'sdmc:/switch/switch2-MV-loader');
assert.equal(found.length, 4);
assert.equal(found[0].title, 'Another RPG (HD)');
assert.equal(found[0].engine, 'mv');
assert.equal(found[0].config.audioFormat, 'm4a');
assert.deepEqual(found[0].config.skipPlugins, ['MyBrokenPCPlugin']);
assert.equal(found[1].title, 'BLACK SOULS 2');
assert.equal(found[1].engine, 'vxace');
assert.equal(found[1].encrypted, true);
assert.equal(found[1].saveCount, 1);
assert.equal(found[2].title, 'Demons Roots v1.03');
assert.equal(found[2].engine, 'mv');
assert.equal(found[2].saveCount, 2); // excludes global.rpgsave
assert.equal(found[2].pluginCount, 2);
assert.equal(found[2].encrypted, true);
assert.equal(found[2].iconPath, 'sdmc:/switch/switch2-MV-loader/demons-roots/www/icon/icon.png');
assert.equal(found[3].title, 'Flat Export RPG');
assert.equal(found[3].wwwRoot, 'sdmc:/switch/switch2-MV-loader/flat-game');
assert.equal(
  mod.findMkxpzNroPath(multiSw, 'sdmc:/switch/switch2-MV-loader'),
  'sdmc:/switch/switch2-MV-loader/mkxp-z-switch2.nro',
);
mod.saveLastSelectedGameId(multiSw, 'sdmc:/switch/switch2-MV-loader', 'demons-roots');
assert.equal(mod.loadLastSelectedGameId(multiSw, 'sdmc:/switch/switch2-MV-loader'), 'demons-roots');
console.log('[PASS] Multi-game SD discovery, metadata parsing, mv-loader.json & last-selected state');

// 3. Verify auto-font CSS parsing + FontFace registration + missing FontLoad alias
const cssParsed = mod.parseGameFontCss(`
  /* comment */
  @font-face {
    font-family: GameFont;
    src: url("Amarante-Regular.ttf");
  }
  @font-face {
    font-family: 'Sub Font';
    src: url('./mplus-1m-regular.ttf');
  }
`);
assert.deepEqual(cssParsed, [
  { family: 'GameFont', file: 'fonts/Amarante-Regular.ttf' },
  { family: 'Sub Font', file: 'fonts/mplus-1m-regular.ttf' },
]);

const fontSw = createMockSwitch({
  'sdmc:/g/www/fonts/gamefont.css': '@font-face { font-family: GameFont; src: url("Amarante-Regular.ttf"); }',
  'sdmc:/g/www/fonts/Amarante-Regular.ttf': new Uint8Array([1, 2, 3, 4]).buffer,
  'sdmc:/g/www/fonts/ship.otf': new Uint8Array([5, 6, 7, 8]).buffer,
  'sdmc:/g/www/js/plugins.js': 'var $plugins = [{"name":"FontLoad","status":true,"parameters":{"fontName":"FOT-SkipStd-D"}}];',
});
const registeredFonts = [];
globalThis.FontFace = class {
  constructor(family, bytes) {
    this.family = family;
    this.bytes = bytes;
  }
};
globalThis.fonts = {
  add(face) { registeredFonts.push(face.family); },
};
const fontAssets = mod.createAssetReader('sdmc:/g/www', fontSw);
await mod.registerGameFonts(fontAssets);
assert.ok(registeredFonts.includes('GameFont'));
assert.ok(registeredFonts.includes('Amarante-Regular'));
assert.ok(registeredFonts.includes('ship'));
assert.ok(registeredFonts.includes('FOT-SkipStd-D'));
console.log(`[PASS] Automatic font discovery & FontLoad aliasing (${registeredFonts.join(', ')})`);

// 4. Verify audio format auto-detection (OGG vs M4A-only)
const oggSw = createMockSwitch({ 'sdmc:/g/www/audio/bgm/Theme1.rpgmvo': 'ogg' });
assert.deepEqual(mod.detectAudioSupport(mod.createAssetReader('sdmc:/g/www', oggSw)), { canOgg: true, canM4a: false });
const m4aSw = createMockSwitch({ 'sdmc:/g/www/audio/bgm/Theme1.m4a': 'm4a' });
assert.deepEqual(mod.detectAudioSupport(mod.createAssetReader('sdmc:/g/www', m4aSw)), { canOgg: false, canM4a: true });
console.log('[PASS] Audio format auto-detection (.ogg/.rpgmvo vs .m4a-only)');

// 5. Verify real Demons Roots game folder (if present) + all 136 plugins + per-game extra skip
if (existsSync(join(gameWww, 'index.html'))) {
  const indexHtml = readFileSync(join(gameWww, 'index.html'), 'utf8');
  const scripts = mod.extractIndexScripts(indexHtml);
  assert.equal(scripts.length, 14, `Expected 14 scripts in index.html, got ${scripts.length}`);
  assert.equal(scripts[0], 'js/libs/pixi.js');
  assert.equal(scripts[scripts.length - 1], 'js/main.js');
  console.log(`[PASS] Real Demons Roots index.html script plan (${scripts.length} scripts)`);

  const pluginsSrc = readFileSync(join(gameWww, 'js', 'plugins.js'), 'utf8');
  const enabled = [...pluginsSrc.matchAll(/"name":"([^"]+)","status":true/g)].map((m) => m[1]);
  assert.equal(enabled.length, 136);
  const preparer = mod.createScriptPreparer();
  let skipped = 0;
  let syntaxChecked = 0;
  for (const name of enabled) {
    const rel = `js/plugins/${name}.js`;
    const full = join(gameWww, rel);
    assert.ok(existsSync(full), `Missing enabled plugin file: ${full}`);
    const src = readFileSync(full, 'utf8');
    const prepared = preparer(rel, src);
    if (prepared === null) {
      skipped++;
    } else {
      new Function(prepared);
      syntaxChecked++;
    }
  }
  assert.equal(skipped, 5, `Expected 5 skipped PC-only plugins, got ${skipped}`);
  assert.equal(syntaxChecked, 131, `Expected 131 valid gameplay plugins, got ${syntaxChecked}`);
  console.log('[PASS] All 136 Demons Roots plugins verified (131 syntax-valid, 5 PC-only skipped)');

  // Also test real Demons Roots/www/fonts/ directory discovery
  const realFonts = readdirSync(join(gameWww, 'fonts')).filter((f) => /\.(?:ttf|otf)$/i.test(f));
  assert.ok(realFonts.length >= 9, `Expected >= 9 fonts in Demons Roots/www/fonts, got ${realFonts.length}`);
  console.log(`[PASS] Real Demons Roots fonts detected (${realFonts.length} font files)`);
}

// 6. Verify per-game skipPlugins override & default PC screen-recorder skips
const customPreparer = mod.createScriptPreparer(['CustomBrokenPlugin']);
assert.equal(customPreparer('js/plugins/CustomBrokenPlugin.js', 'console.log(1);'), null);
assert.equal(customPreparer('js/plugins/MakeScreenMovie.js', 'class ScreenRecorder {}'), null);
assert.equal(customPreparer('js/plugins/RecScene.js', 'class ScreenRecorder {}'), null);
assert.notEqual(customPreparer('js/plugins/NormalPlugin.js', "'use strict';\nvar x = 1;"), null);
console.log('[PASS] Per-game skipPlugins & default PC screen-recorder plugin skips');

// 6b. Verify browser-host MediaRecorder / captureStream / localStorage shims + spaced game paths
const spacedSw = createMockSwitch({
  'sdmc:/switch/switch2-MV-loader/Detective Girl of the Steam City/www/index.html': '<html></html>',
});
const spacedAssets = mod.createAssetReader(
  'sdmc:/switch/switch2-MV-loader/Detective Girl of the Steam City/www',
  spacedSw,
);
assert.equal(spacedAssets.exists('index.html'), true);
const fakeScreen = {
  width: 1280,
  height: 720,
  getContext: () => ({
    save() {}, restore() {}, setTransform() {}, scale() {}, translate() {}, rotate() {}, transform() {},
    beginPath() {}, rect() {}, clip() {}, fillRect() {}, clearRect() {}, drawImage() {},
    canvas: { width: 1280, height: 720 },
  }),
};
mod.createBrowserHost(spacedAssets, customPreparer, fakeScreen, { gameTitle: 'Detective Girl' });
assert.equal(globalThis.MediaRecorder.isTypeSupported('video/webm;codecs=vp9'), true);
const testCanvas = globalThis.document.createElement('canvas');
assert.deepEqual(testCanvas.captureStream().getTracks(), []);
globalThis.localStorage.setItem('k', 'v');
assert.equal(globalThis.localStorage.getItem('k'), 'v');
console.log('[PASS] Spaced folder paths + MediaRecorder / captureStream / localStorage shims');

// 7. Verify asset path normalization & traversal blocking
assert.equal(mod.normalizeAssetRelPath('./img/pictures/test%20name.png?v=1'), 'img/pictures/test name.png');
assert.equal(mod.normalizeAssetRelPath('../secret.txt'), null);
assert.equal(mod.normalizeAssetRelPath('sdmc:/escape'), null);
console.log('[PASS] Asset path normalization & traversal guard');

// 8. Verify per-game isolated node-compat & atomic saves
const saveSw = createMockSwitch();
const fakeGlobal = {};
const gDir = 'sdmc:/switch/switch2-MV-loader/demons-roots';
mod.installNodeCompat(fakeGlobal, saveSw, `${gDir}/www`, `${gDir}/save`, undefined, gDir, 'Demons Roots v1.03');
assert.equal(fakeGlobal.process.mainModule.filename, `${gDir}/www/index.html`);
assert.equal(fakeGlobal.nw.Window.get().title, 'Demons Roots v1.03');
const fsShim = fakeGlobal.require('fs');
fsShim.writeFileSync('save/test.txt', 'hello-universal');
assert.equal(fsShim.readFileSync('save/test.txt', 'utf8'), 'hello-universal');
assert.ok(saveSw._files.has(`${gDir}/save/test.txt`));

// Verify Greenworks / Steamworks, Discord, os & events shims (e.g. Fear & Hunger)
const gw = fakeGlobal.require('./js/libs/greenworks');
assert.equal(gw.initAPI(), true);
assert.equal(gw.isCloudEnabled(), false);
let achFired = false;
gw.activateAchievement('TEST_ACH', () => { achFired = true; });
assert.equal(achFired, true);
assert.equal(typeof gw.someUnknownFutureSteamCall, 'function');
assert.equal(gw.someUnknownFutureSteamCall(), false);
assert.equal(fakeGlobal.require('os').arch(), 'arm64');
const { EventEmitter } = fakeGlobal.require('events');
const ee = new EventEmitter();
let evHit = false;
ee.once('ping', () => { evHit = true; });
ee.emit('ping');
assert.equal(evHit, true);

const fakeRuntime = {
  StorageManager: {},
  LZString: {
    compressToBase64: (s) => Buffer.from(s, 'utf8').toString('base64'),
    decompressFromBase64: (s) => Buffer.from(s, 'base64').toString('utf8'),
  },
};
mod.installSdSaves(fakeRuntime, saveSw, `${gDir}/save`);
fakeRuntime.StorageManager.save(1, '{"actor":"Deathpolca"}');
assert.equal(fakeRuntime.StorageManager.exists(1), true);
assert.equal(fakeRuntime.StorageManager.load(1), '{"actor":"Deathpolca"}');
fakeRuntime.StorageManager.saveCommonSave('{"switches":[1,2,3]}');
assert.equal(fakeRuntime.StorageManager.existsCommonSave(), true);
assert.equal(fakeRuntime.StorageManager.loadCommonSave(), '{"switches":[1,2,3]}');
assert.ok(saveSw._files.has(`${gDir}/save/common.rpgsave`));
console.log('[PASS] Per-game isolated node-compat & atomic SD saves');

// 9. Verify viewport calculation for both 816x624 and 1280x720 MV games
const vp816 = mod.computeViewport(816, 624, 1920, 1080, 'fit');
assert.equal(vp816.h, 1080);
assert.equal(vp816.w, 1412);
assert.equal(vp816.x, 254);
const vp1280 = mod.computeViewport(1280, 720, 1920, 1080, 'fit');
assert.equal(vp1280.w, 1920);
assert.equal(vp1280.h, 1080);
assert.equal(vp1280.x, 0);
console.log('[PASS] Viewport letterboxing (816x624 & 1280x720 -> 1080p)');

// 10. Verify pure-JS PNG decoder on real Demons Roots icon.png + synthetic palette+tRNS & grayscale PNGs
import { deflateSync } from 'node:zlib';
function makePng(width, height, bitDepth, colorType, rawScanlines, extraChunks = []) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const chunk = (type, data) => {
    const buf = Buffer.alloc(12 + data.length);
    buf.writeUInt32BE(data.length, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < 8 + data.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    buf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
    return buf;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    ...extraChunks.map(([t, d]) => chunk(t, d)),
    chunk('IDAT', deflateSync(rawScanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
if (existsSync(join(gameWww, 'icon', 'icon.png'))) {
  const realIcon = await mod.decodePngToRgba(readFileSync(join(gameWww, 'icon', 'icon.png')));
  assert.equal(realIcon.width, 32);
  assert.equal(realIcon.height, 32);
  assert.equal(realIcon.rgba.length, 32 * 32 * 4);
}
// Indexed palette (colorType=3) + tRNS transparency (2x1: pixel 0 transparent red, pixel 1 opaque blue)
const palPng = makePng(2, 1, 8, 3, Buffer.from([0, 0, 1]), [
  ['PLTE', Buffer.from([255, 0, 0, 0, 128, 255])],
  ['tRNS', Buffer.from([0, 255])],
]);
const decPal = await mod.decodePngToRgba(palPng);
assert.deepEqual([...decPal.rgba], [255, 0, 0, 0, 0, 128, 255, 255]);
// Grayscale (colorType=0, 2x1: black & white)
const grayPng = makePng(2, 1, 8, 0, Buffer.from([0, 0, 255]));
const decGray = await mod.decodePngToRgba(grayPng);
assert.deepEqual([...decGray.rgba], [0, 0, 0, 255, 255, 255, 255, 255]);
console.log('[PASS] Universal PNG decoder (RGBA8, Indexed Palette + tRNS, Grayscale)');

// 11. Verify no-op setValue guard & selective Game_Map.refresh() dependency indexing
let ev1Refreshes = 0;
let ev2Refreshes = 0;
function FakeGameEvent(id, varId) {
  this._eventId = id;
  this._pageIndex = 0;
  this._varId = varId;
}
FakeGameEvent.prototype.event = function () {
  return {
    pages: this._varId
      ? [{ conditions: { switch1Valid: false, switch2Valid: false, variableValid: true, variableId: this._varId, variableValue: 5 } }]
      : [{ conditions: { switch1Valid: false, switch2Valid: false, variableValid: false } }],
  };
};
FakeGameEvent.prototype.meetsConditions = function (page) {
  const c = page.conditions;
  if (c.switch1Valid && !c.switch1Id) return false;
  if (c.variableValid && c.variableId < 0) return false;
  return true;
};
FakeGameEvent.prototype.refresh = function () {
  if (this._eventId === 1) ev1Refreshes++;
  if (this._eventId === 2) ev2Refreshes++;
};
function FakeGameVariables() { this._data = []; }
FakeGameVariables.prototype.setValue = function (id, v) { this._data[id] = Math.floor(v); this.onChange(); };
FakeGameVariables.prototype.onChange = function () { selRuntime.$gameMap.requestRefresh(); };
function FakeGameMap() {
  this._mapId = 1;
  this._needsRefresh = false;
  this._events = [new FakeGameEvent(1, 10), new FakeGameEvent(2, 0)];
  this._commonEvents = [];
}
FakeGameMap.prototype.events = function () { return this._events; };
FakeGameMap.prototype.requestRefresh = function () { this._needsRefresh = true; };
FakeGameMap.prototype.refreshTileEvents = function () {};
FakeGameMap.prototype.refresh = function () {
  for (const e of this._events) e.refresh();
  this._needsRefresh = false;
};
const selRuntime = {
  $dataSystem: { switches: ['', 's1'], variables: ['', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11'] },
  Game_Event: FakeGameEvent,
  Game_Variables: FakeGameVariables,
  Game_Map: FakeGameMap,
};
selRuntime.$gameMap = new FakeGameMap();
selRuntime.$gameVariables = new FakeGameVariables();
mod.installMvCompat(selRuntime, { isDirectGpu: () => true, beginFrame() {}, endFrame() {} });
// Initial refresh builds dependency index (full refresh)
selRuntime.$gameMap.refresh();
assert.equal(ev1Refreshes, 1);
assert.equal(ev2Refreshes, 1);
// Writing variable 11 (used by neither event) -> refreshes 0 events!
selRuntime.$gameVariables.setValue(11, 42);
assert.equal(selRuntime.$gameMap._needsRefresh, true);
selRuntime.$gameMap.refresh();
assert.equal(ev1Refreshes, 1);
assert.equal(ev2Refreshes, 1);
// Writing unchanged variable 11 -> does not even request refresh!
selRuntime.$gameVariables.setValue(11, 42);
assert.equal(selRuntime.$gameMap._needsRefresh, false);
// Writing variable 10 (used by event 1 only) -> refreshes ONLY event 1!
selRuntime.$gameVariables.setValue(10, 7);
selRuntime.$gameMap.refresh();
assert.equal(ev1Refreshes, 2);
assert.equal(ev2Refreshes, 1);
console.log('[PASS] No-op setValue guard & selective Game_Map.refresh() dependency indexing');

// 12. Verify half-res Lightmask downscale + dynamic _addSprite -> Sprite._refresh never overflows baseTexture
function FakeLightmask() {
  this._maskBitmap = {
    _canvas: { width: 866, height: 630 },
    _context: { setTransform() {} },
    _baseTexture: { realWidth: 866, realHeight: 630, width: 866, height: 630, update() {} },
  };
  this._sprites = [];
  this.children = [];
}
FakeLightmask.prototype._updateMask = function () {
  // Simulate Lightmask._addSprite creating a new Sprite bound to _maskBitmap mid-_updateMask
  const sp = new FakeSprite();
  sp._bitmap = this._maskBitmap;
  sp._frame = { x: 0, y: 0, width: sp._bitmap.width, height: sp._bitmap.height };
  sp._refresh();
  this._sprites.push(sp);
};
function FakeSprite() {
  this._bitmap = null;
  this._frame = { x: 0, y: 0, width: 0, height: 0 };
  this.scale = { x: 1, y: 1 };
  this.texture = { frame: { width: 0, height: 0 } };
}
FakeSprite.prototype._refresh = function () {
  const bw = this._bitmap.width;
  const bh = this._bitmap.height;
  const bt = this._bitmap._baseTexture;
  if (this._frame.width > bt.width || this._frame.height > bt.height || bw > bt.width || bh > bt.height) {
    throw new Error(`Texture Error: ${this._frame.width}x${this._frame.height} > ${bt.width}x${bt.height}`);
  }
  this.texture.frame.width = this._frame.width;
  this.texture.frame.height = this._frame.height;
};
const lmRuntime = {
  Lightmask: FakeLightmask,
  Sprite: FakeSprite,
  Graphics: { frameCount: 0 },
  $gameMap: { _displayX: 0, _displayY: 0 },
  $gamePlayer: { _realX: 0, _realY: 0 },
};
mod.installMvCompat(lmRuntime, { isDirectGpu: () => true, beginFrame() {}, endFrame() {} });
const lmInst = new FakeLightmask();
lmInst._updateMask();
assert.equal(lmInst._maskBitmap.width, 866);
assert.equal(lmInst._maskBitmap._canvas.width, 433);
assert.equal(lmInst._sprites[0].texture.frame.width, 433);
assert.equal(lmInst._sprites[0].scale.x, 2);
console.log('[PASS] Half-res Lightmask GPU upscale + dynamic Sprite._refresh bounds safety');

// 13. Verify Game_Interpreter compiled script cache (command111 / command122 / command355) & Weather cap
function FakeInterpreter() {
  this._index = 0;
  this._indent = 0;
  this._branch = {};
  this._params = [];
  this._list = [];
  this._vars = {};
  this._skipped = false;
}
FakeInterpreter.prototype.currentCommand = function () { return this._list[this._index]; };
FakeInterpreter.prototype.nextEventCode = function () { return this._list[this._index + 1]?.code ?? 0; };
FakeInterpreter.prototype.skipBranch = function () { this._skipped = true; };
FakeInterpreter.prototype.operateVariable = function (id, _op, val) { this._vars[id] = val; };
FakeInterpreter.prototype.command111 = function () { throw new Error('should use compiled cache'); };
FakeInterpreter.prototype.command122 = function () { throw new Error('should use compiled cache'); };
FakeInterpreter.prototype.command355 = function () { throw new Error('should use compiled cache'); };

function FakeWeather() {
  this.power = 9;
  this._sprites = [];
  this.origin = { x: 0, y: 0 };
}
FakeWeather.prototype._addSprite = function () { this._sprites.push({ ax: 10, ay: 20, x: 0, y: 0 }); };
FakeWeather.prototype._removeSprite = function () { this._sprites.pop(); };
FakeWeather.prototype._updateSprite = function () {};
FakeWeather.prototype._updateAllSprites = function () {};

const interpRuntime = { Game_Interpreter: FakeInterpreter, Weather: FakeWeather };
mod.installMvCompat(interpRuntime, { isDirectGpu: () => true, beginFrame() {}, endFrame() {} });
const ip = new FakeInterpreter();
ip._params = [12, '1 + 1 === 2;'];
assert.equal(ip.command111(), true);
assert.equal(ip._branch[0], true);
assert.equal(ip._skipped, false);
ip._params = [12, 'false'];
ip.command111();
assert.equal(ip._skipped, true);
ip._params = [5, 5, 0, 4, '6 * 7;'];
ip.command122();
assert.equal(ip._vars[5], 42);
ip._list = [{ code: 355, parameters: ['this._ran = 99;'] }];
ip._index = 0;
ip.command355();
assert.equal(ip._ran, 99);
const w = new FakeWeather();
w._updateAllSprites();
assert.equal(w._sprites.length, 40);
console.log('[PASS] Game_Interpreter compiled script cache & Weather sprite cap');

// 14. Verify gamepad bridges for Forbidden Orders (isKeycodeTriggered/isSpecialCode) & Claire's Quest (hideUI/escape)
{
  function Scene_Map() {}
  function Scene_Custom() {}
  const fakeInput = {
    gamepadMapper: { 0: 'ok', 1: 'cancel', 2: 'hideUI', 3: 'menu' },
    keyMapper: {},
    _gamepadStates: [],
    _currentState: {},
    _latestButton: null,
    _pressedTime: 0,
    _latestKeyCode: null,
    _inputSpecialKeyCode: undefined,
    clear() { this._currentState = {}; this._latestButton = null; this._latestKeyCode = null; },
    isTriggered(name) { return this._latestButton === name && this._pressedTime === 0; },
    isPressed(name) { return Boolean(this._currentState[name]); },
    isKeycodeTriggered(kc) { return this._latestKeyCode === kc && this._pressedTime === 0; },
    isSpecialCode(k) { return k === 'enter' && this._inputSpecialKeyCode === 13; },
    isArrowPressed() { return [37, 38, 39, 40].includes(this._inputSpecialKeyCode); },
    _updateGamepadState(pad) {
      const prev = this._gamepadStates[pad.index] || [];
      const next = pad.buttons.map((b) => Boolean(b.pressed));
      this._gamepadStates[pad.index] = next;
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== Boolean(prev[i])) {
          const sym = this.gamepadMapper[i];
          if (sym) {
            this._currentState[sym] = next[i];
            if (next[i]) { this._latestButton = sym; this._pressedTime = 0; }
          }
        }
      }
    },
  };
  const fakeRuntime = { Input: fakeInput, Scene_Map, SceneManager: { _scene: new Scene_Custom() } };
  const bridge = mod.createInputBridge();
  bridge.installIntoRuntime(fakeRuntime, () => ({ x: 0, y: 0, w: 816, h: 624, gw: 816, gh: 624 }));

  const makePad = (pressedIndices) => ({
    index: 0,
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressedIndices.includes(i) })),
  });

  // Press A (button 1 -> ok): must trigger Input.isKeycodeTriggered(13) and Input.isSpecialCode('enter')
  fakeInput._updateGamepadState(makePad([1]));
  assert.equal(fakeInput.isKeycodeTriggered(13), true);
  assert.equal(fakeInput.isSpecialCode('enter'), true);
  assert.equal(fakeInput._latestKeyCode, 13);

  // Press Y (button 2 -> shift): must NOT trigger hideUI (remapped to ZL button 6)
  fakeInput._updateGamepadState(makePad([2]));
  assert.equal(Boolean(fakeInput._currentState.shift), true);
  assert.equal(Boolean(fakeInput._currentState.hideUI), false);

  // Press ZL (button 6 -> tab + hideUI): must trigger hideUI and keycode 72
  fakeInput._updateGamepadState(makePad([6]));
  assert.equal(Boolean(fakeInput._currentState.hideUI), true);
  assert.equal(fakeInput.isKeycodeTriggered(72), true);

  // Press B (button 0 -> cancel): satisfies 'escape' in custom scenes, but NOT on Scene_Map
  fakeInput._updateGamepadState(makePad([0]));
  assert.equal(fakeInput.isTriggered('escape'), true);
  fakeRuntime.SceneManager._scene = new Scene_Map();
  assert.equal(fakeInput.isTriggered('escape'), false);

  console.log('[PASS] Gamepad keycode/escape/hideUI bridges (Forbidden Orders & Claire\'s Quest)');
}

// 15. Verify RPG Maker MZ discovery, script plan, Effekseer shim & fs.renameSync
{
  const mzSw = createMockSwitch({
    'sdmc:/switch/SW2RPGMGL/games/Dragon Conquista/index.html': '<title>Dragon</title>',
    'sdmc:/switch/SW2RPGMGL/games/Dragon Conquista/js/rmmz_core.js': '// mz core',
    'sdmc:/switch/SW2RPGMGL/games/Dragon Conquista/data/System.json': JSON.stringify({
      gameTitle: 'Dragon Conquista',
      hasEncryptedImages: true,
      hasEncryptedAudio: true,
    }),
    'sdmc:/switch/SW2RPGMGL/games/Dragon Conquista/js/plugins.js': 'var $plugins = [{name:"A",status:true},{name:"B",status:false}];',
    'sdmc:/switch/SW2RPGMGL/games/Dragon Conquista/save/file1.rmmzsave': 'zipdata',
  });
  const found = mod.discoverGames(mzSw, 'sdmc:/switch/SW2RPGMGL');
  assert.equal(found.length, 1);
  assert.equal(found[0].engine, 'mz');
  assert.equal(found[0].title, 'Dragon Conquista');
  assert.equal(found[0].pluginCount, 1);
  assert.equal(found[0].saveCount, 1);
  assert.equal(found[0].encrypted, true);

  const single = mod.inspectSingleMzGame(mzSw, 'sdmc:/switch/SW2RPGMGL/games/Dragon Conquista');
  assert.equal(single?.engine, 'mz');

  const scripts = mod.extractMzMainScripts('const scriptUrls = ["js/libs/pixi.js","js/libs/pako.min.js","js/rmmz_core.js","js/rmmz_managers.js","js/rmmz_objects.js","js/plugins.js"];');
  assert.equal(scripts.length, 6);

  const prep = mod.createMzScriptPreparer();
  assert.equal(prep('js/libs/effekseer.min.js', 'code'), '');
  assert.equal(prep('js/plugins/Shiro_SteamworksAPI.js', 'code'), null);
  assert.equal(prep('js/plugins/PluginCommonBase.js', 'code'), 'code');

  // Verify top-level const/let/class hoisting across separate eval() calls (NUUN_Base pattern)
  const hoisted = prep(
    'js/plugins/NUUN_Base.js',
    `const NUUN_Base_Ver = 140;
let __mzTestLet = 42;
class __MzTestClass { static ok() { const inner = 1; for (let i = 0; i < 2; i++) {} return inner; } }
(() => { const privateConst = 'const inside'; const re = /const x/g; return privateConst + re; })();`,
  );
  assert.ok(hoisted.includes('var NUUN_Base_Ver = 140;'));
  assert.ok(hoisted.includes('var __mzTestLet = 42;'));
  assert.ok(hoisted.includes(';globalThis["__MzTestClass"]=__MzTestClass;'));
  assert.ok(hoisted.includes('const inner = 1;'));
  assert.ok(hoisted.includes('for (let i = 0;'));
  assert.ok(hoisted.includes("const privateConst = 'const inside';"));
  (0, eval)(hoisted);
  assert.equal(globalThis.NUUN_Base_Ver, 140);
  assert.equal(globalThis.__mzTestLet, 42);
  assert.equal(globalThis.__MzTestClass.ok(), 1);
  delete globalThis.NUUN_Base_Ver;
  delete globalThis.__mzTestLet;
  delete globalThis.__MzTestClass;

  // Verify Unicode property escape rewrite (Fs.js RE_UNKNOWN in V8 without i18n)
  const rewrittenRe = prep(
    'js/plugins/Fs.js',
    String.raw`const RE_UNKNOWN = /^(?:[a-z0-9$_]+|[\p{L}\p{N}\p{Pc}\p{M}\p{Cf}]+|[\p{P}\p{S}]+|[^ \t\r\n]+)/iu;`,
  );
  assert.ok(!rewrittenRe.includes('\\p{'));
  new Function(rewrittenRe);

  // Verify all enabled real MZ game plugins (read-only) parse cleanly after createMzScriptPreparer
  for (const realMz of [
    'C:/Users/Laptop/Desktop/VN/# new/new_261121/Dragon Conquista',
    'C:/Users/Laptop/Desktop/VN/# new/new_261121/Stranded with You',
  ]) {
    const pjsPath = join(realMz, 'js', 'plugins.js');
    if (existsSync(pjsPath)) {
      const pjsSrc = readFileSync(pjsPath, 'utf8');
      const entries = new Function(`${pjsSrc}; return $plugins;`)();
      let checked = 0;
      for (const entry of entries) {
        if (!entry?.status || !entry?.name) continue;
        const fp = join(realMz, 'js', 'plugins', `${entry.name}.js`);
        if (!existsSync(fp)) continue;
        const src = readFileSync(fp, 'utf8');
        const out = prep(`js/plugins/${entry.name}.js`, src);
        if (out === null) continue;
        new Function(out);
        checked++;
      }
      assert.ok(checked > 0);
    }
  }

  // Verify WOFF 1.0 -> SFNT TTF/OTF conversion on real MZ mplus-1m-regular.woff
  const realWoffPath = 'C:/Users/Laptop/Desktop/VN/# new/new_261121/Dragon Conquista/fonts/mplus-1m-regular.woff';
  if (existsSync(realWoffPath)) {
    const woffBuf = readFileSync(realWoffPath);
    const woffAb = woffBuf.buffer.slice(woffBuf.byteOffset, woffBuf.byteOffset + woffBuf.byteLength);
    const sfnt = mod.decodeWoffToSfnt(woffAb, (u8) => new Uint8Array(inflateSync(u8)));
    assert.ok(sfnt && sfnt.byteLength >= 1731228);
    const dv = new DataView(sfnt);
    assert.equal(dv.getUint32(0, false), 0x00010000);
    assert.equal(dv.getUint16(4, false), 20);
  }

  const mzRt = {};
  mod.installEffekseerShim(mzRt);
  assert.equal(mzRt.effekseer.createContext(), null);

  // Verify fs.renameSync for MZ StorageManager atomic saves
  const nodeTarget = {};
  mod.installNodeCompat(
    nodeTarget,
    mzSw,
    'sdmc:/switch/SW2RPGMGL/games/Dragon Conquista',
    'sdmc:/switch/SW2RPGMGL/games/Dragon Conquista/save',
    undefined,
    'sdmc:/switch/SW2RPGMGL/games/Dragon Conquista',
  );
  const fsMod = nodeTarget.require('fs');
  fsMod.writeFileSync('save/file2.rmmzsave', 'hello-mz');
  fsMod.renameSync('save/file2.rmmzsave', 'save/file2.rmmzsave_');
  assert.equal(fsMod.existsSync('save/file2.rmmzsave'), false);
  assert.equal(fsMod.readFileSync('save/file2.rmmzsave_', 'utf8'), 'hello-mz');
  // Verify multi-encoding TextDecoder (utf-16le, utf-16be, latin1, uppercase UTF-8) & screen touch events
  {
    const tdHostScreen = {
      width: 1280,
      height: 720,
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      getContext() { return null; },
    };
    const prevScreen = globalThis.screen;
    globalThis.screen = tdHostScreen;
    try {
      const dummyAssets = mod.createAssetReader('sdmc:/switch/SW2RPGMGL/games/test', mzSw);
      mod.createBrowserHost(dummyAssets, (_p, s) => s, tdHostScreen, { enableWebGL: true });
      const u16le = new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43, 0x00]); // "ABC"
      assert.equal(new TextDecoder('utf-16le').decode(u16le), 'ABC');
      const u16be = new Uint8Array([0x00, 0x41, 0x00, 0x42]); // "AB"
      assert.equal(new TextDecoder('utf-16be').decode(u16be), 'AB');
      assert.equal(new TextDecoder('latin1').decode(new Uint8Array([0x48, 0x69, 0xe9])), 'Hi\u00e9');
      assert.equal(new TextDecoder('UTF-8').decode(new Uint8Array([0x4f, 0x4b])), 'OK');

      // Verify Switch 2 touchscreen events attach to `screen` and drive TouchInput (1-finger + 2-finger cancel)
      const events = [];
      const mockTouchInput = {
        _screenPressed: false,
        _pressedTime: 99,
        clear() {},
        _onTrigger(x, y) { events.push(['trigger', x, y]); },
        _onCancel(x, y) { events.push(['cancel', x, y]); },
        _onMove(x, y) { events.push(['move', x, y]); },
        _onRelease(x, y) { events.push(['release', x, y]); },
      };
      const inp = mod.createInputBridge();
      inp.installIntoRuntime({ TouchInput: mockTouchInput }, () => ({ x: 169, y: 0, w: 942, h: 720, gw: 816, gh: 624 }));
      assert.ok(tdHostScreen.listeners.touchstart?.length === 1);
      tdHostScreen.listeners.touchstart[0]({ touches: [{ clientX: 640, clientY: 360 }], changedTouches: [{ clientX: 640, clientY: 360 }] });
      assert.equal(mockTouchInput._screenPressed, true);
      assert.equal(mockTouchInput._pressedTime, 0);
      assert.equal(events[0][0], 'trigger');
      assert.ok(Math.abs(events[0][1] - 408) <= 2 && Math.abs(events[0][2] - 312) <= 2);
      tdHostScreen.listeners.touchstart[0]({ touches: [{ clientX: 640, clientY: 360 }, { clientX: 700, clientY: 360 }], changedTouches: [{ clientX: 700, clientY: 360 }] });
      assert.equal(events[1][0], 'cancel');
      tdHostScreen.listeners.touchend[0]({ touches: [], changedTouches: [{ clientX: 640, clientY: 360 }] });
      assert.equal(mockTouchInput._screenPressed, false);
      assert.equal(events[2][0], 'release');
    } finally {
      globalThis.screen = prevScreen;
    }
  }
  console.log('[PASS] RPG Maker MZ discovery, Effekseer shim, plugin filter, TextDecoder, touch & atomic saves');
}

// 13. Verify Ambrosia (PixiJS v5 MV WebGL2 auto-detect), Mirage Rebellion (balloon/anim playing guard,
//     Window width/height no-op guard, child-sprite guard), & Nightmare Knight (FontLoad URL pairing,
//     FloatVariables preservation)
{
  // PixiJS v5 MV WebGL2 auto-detection
  assert.equal(mod.detectMvWebGLReason('{"name":"enc_lv2d","status":true}', null, null), 'Live2D');
  assert.equal(mod.detectMvWebGLReason(null, 'this._renderer = new PIXI.Renderer(options);', null), 'PixiJS v5');
  assert.equal(mod.detectMvWebGLReason(null, null, '/*!\n * pixi.js - v5.3.8\n */'), 'PixiJS v5');
  assert.equal(mod.detectMvWebGLReason('{"name":"YEP_CoreEngine","status":true}', 'new PIXI.CanvasRenderer()', 'pixi.js - v4.5.4'), null);

  // FontLoad paired URL extraction
  const flEntries = mod.extractFontLoadEntries(
    'var $plugins = [{"name":"FontLoad","status":true,"parameters":{"フォント名1":"Phenomena","フォントURL1":"fonts/Phenomena-Regular.otf","ロード完了まで待機":"true"}}];',
  );
  assert.deepEqual(flEntries, [{ family: 'Phenomena', file: 'fonts/Phenomena-Regular.otf' }]);

  // MV runtime compat: Window no-op size guard + FloatVariables preservation + Sprite_Character balloonPlaying/children guard
  class MockEvent {
    constructor() {
      this._drStateRev = 1;
      this._realX = 5; this._realY = 5; this._PosZ = 0;
      this._characterName = ''; this._characterIndex = 0; this._tileId = 0;
      this._opacity = 255; this._transparent = false; this._blendMode = 0;
      this._animationId = 0; this._balloonId = 0;
      this._animationPlaying = false; this._balloonPlaying = false;
    }
    screenX() { return 240; }
    screenY() { return 240; }
  }
  let charUpdates = 0;
  class MockSpriteChar {
    constructor(ch) {
      this._character = ch;
      this._tilesetId = 1;
      this._characterName = ''; this._characterIndex = 0; this._tileId = 0;
      this.opacity = 255; this.visible = true; this.blendMode = 0;
      this.x = 240; this.y = 240; this.scale = { x: 1, y: 1 };
      this._frame = { width: 48, height: 48 };
      this._balloonSprite = null;
      this._animationSprites = [];
      this.children = [];
    }
    update() {
      charUpdates++;
      if (!this._balloonSprite && this._character._balloonPlaying) {
        this._character._balloonPlaying = false;
      }
    }
  }
  let winRefreshes = 0;
  function MockWindow() { this._width = 0; this._height = 0; }
  MockWindow.prototype._refreshAllParts = function () { winRefreshes++; };
  Object.defineProperty(MockWindow.prototype, 'width', {
    configurable: true,
    get() { return this._width; },
    set(v) { this._width = v; this._refreshAllParts(); },
  });
  Object.defineProperty(MockWindow.prototype, 'height', {
    configurable: true,
    get() { return this._height; },
    set(v) { this._height = v; this._refreshAllParts(); },
  });
  function MockFloatVars() { this._data = []; }
  MockFloatVars.prototype.setValue = function (id, val) { this._data[id] = val; };
  function MockMap() {
    this._mapId = 1; this._tilesetId = 1; this._displayX = 0; this._displayY = 0;
    this._events = []; this._needsRefresh = false;
  }
  MockMap.prototype.tileWidth = () => 48;
  MockMap.prototype.tileHeight = () => 48;
  MockMap.prototype.isLoopHorizontal = () => false;
  MockMap.prototype.isLoopVertical = () => false;
  MockMap.prototype.refresh = function () {};
  MockMap.prototype.requestRefresh = function () { this._needsRefresh = true; };
  MockMap.prototype.events = function () { return this._events; };
  MockEvent.prototype.meetsConditions = function () { return true; };

  const mockRt = {
    Graphics: { width: 1280, height: 720, frameCount: 0 },
    Window: MockWindow,
    Game_Variables: MockFloatVars,
    Game_Map: MockMap,
    Game_Event: MockEvent,
    Sprite_Character: MockSpriteChar,
    $dataSystem: { variables: ['', 'v1', 'v2'], switches: ['', 's1'] },
    $gameMap: new MockMap(),
  };
  mod.installMvCompat(mockRt, { isDirectGpu: () => true, getWebGLContext: () => null }, {});

  // 1) Window width/height no-op guard
  const w = new MockWindow();
  w.width = 0; w.height = 0; // first init write
  const afterFirst = winRefreshes;
  w.width = 0; w.height = 0; w.width = 0; w.height = 0; // no-op writes skipped!
  assert.equal(winRefreshes, afterFirst);
  w.width = 200; // real change refreshes!
  assert.equal(winRefreshes, afterFirst + 1);

  // 2) FloatVariables preservation (0.5 must NOT be floored to 0 and dropped!)
  const fv = new MockFloatVars();
  fv.setValue(1, 0.5);
  assert.equal(fv._data[1], 0.5);

  // 3) Sprite_Character balloonPlaying must NOT enter fast path before endBalloon clears _balloonPlaying!
  const ev = new MockEvent();
  const sp = new MockSpriteChar(ev);
  sp.update(); sp.update(); // warm up rc >= 2 -> _drFastOk = true
  assert.equal(sp._drFastOk, true);
  // Simulate frame right after Sprite_Character.endBalloon() nulled _balloonSprite while _balloonPlaying is still true:
  ev._balloonPlaying = true;
  const beforeCalls = charUpdates;
  sp.update();
  assert.equal(charUpdates, beforeCalls + 1, 'Sprite_Character must run full update while _balloonPlaying is true');
  assert.equal(ev._balloonPlaying, false, 'endBalloon must clear _balloonPlaying on next tick');

  // 4) Sprite_Character with child sprites (TMNamePop / TMAnimeLight) must NOT enter fast path!
  sp.children.push({ name: 'namePop' });
  const beforeChildCalls = charUpdates;
  sp.update();
  assert.equal(charUpdates, beforeChildCalls + 1);
  assert.equal(sp._drFastOk, false);

  // 5) Braille Pattern Blank (U+2800) normalization, patternHeight null-bitmap guard, & Window_EventMiniLabel empty culling
  let drawnText = '';
  function MockBitmap() { this.fontFace = 'GameFont'; }
  MockBitmap.prototype.drawText = function (t) { drawnText = t; };
  MockBitmap.prototype.measureTextWidth = function (t) { return String(t).length * 8; };
  function MockMiniLabel() { this.initialize(); }
  MockMiniLabel.prototype.initialize = function () { this.visible = true; this._text = ''; };
  MockMiniLabel.prototype.update = function () {};
  function MockSpriteCharPat() { this._tileId = 0; this.bitmap = undefined; }
  MockSpriteCharPat.prototype.patternHeight = function () { return this.bitmap.height / 8; };
  MockSpriteCharPat.prototype.patternWidth = function () { return this.bitmap.width / 12; };
  const mockRt2 = {
    Bitmap: MockBitmap,
    Window_EventMiniLabel: MockMiniLabel,
    Sprite_Character: MockSpriteCharPat,
  };
  mod.installMvCompat(mockRt2, { isDirectGpu: () => true, getWebGLContext: () => ({}) }, {});
  const mb = new MockBitmap();
  mb.drawText('Leo:\u2800"Be\u2800careful."');
  assert.equal(drawnText, 'Leo: "Be careful."');
  const ml = new MockMiniLabel();
  assert.equal(ml.visible, false);
  ml.visible = true; ml._text = ''; ml.update();
  assert.equal(ml.visible, false);
  const scPat = new MockSpriteCharPat();
  assert.equal(scPat.patternHeight(), 0);
  assert.equal(scPat.patternWidth(), 0);
  scPat.bitmap = { width: 576, height: 384 };
  assert.equal(scPat.patternHeight(), 48);
  assert.equal(scPat.patternWidth(), 48);

  console.log('[PASS] PixiJS v5 MV WebGL2 detect, FontLoad URLs, Window size guard, FloatVariables, balloon/child-sprite, U+2800, patternHeight & MiniLabel culling');
}

// 21. Verify GraphicalDesignMode runtime enablement, WebGL2 maxSkip=0 & VSync phase-lock,
//     closed/idle FTKR message & sub-window skip, HalfMove/KMS/MKR zero-alloc fast paths, and nw exit routing
{
  assert.equal(mod.DEFAULT_SKIPPED_PLUGINS.has('GraphicalDesignMode.js'), false, 'GraphicalDesignMode.js must run to load ContainerProperties.json');

  let msgCalls = 0;
  let choiceCalls = 0;
  let goldCalls = 0;
  let sensorCalls = 0;
  let sceneUpdates = 0;
  let fakeClock = 1000;

  function MockWinMsg(id) {
    this._windowId = id;
    this._openness = 0;
    this._opening = false;
    this._closing = false;
    this.pause = false;
    this._textState = null;
    this._gameMessage = { _texts: [], isBusy() { return this._texts.length > 0; } };
  }
  MockWinMsg.prototype.update = function () { msgCalls++; };
  function MockChoice() {
    this._openness = 0;
    this._opening = false;
    this._closing = false;
    this.active = false;
  }
  MockChoice.prototype.update = function () { choiceCalls++; };
  function MockGold() {
    this._openness = 0;
    this._opening = false;
    this._closing = false;
    this.active = true; // Window_Base default!
  }
  MockGold.prototype.update = function () { goldCalls++; };
  function MockCharBase() {}
  MockCharBase.prototype.pos = function (x, y) { return this._x === x && this._y === y; };
  function MockEv(x, y, through, activeMsg) {
    this._x = x; this._y = y; this._through = through;
    this._sensorStatus = 0;
    this._activeMsg = activeMsg;
    this._shown = false;
  }
  MockEv.prototype.isThrough = function () { return this._through; };
  MockEv.prototype.hasMapActiveMessage = function () { return this._activeMsg; };
  MockEv.prototype.isMapActiveMessageShown = function () { return this._shown; };
  MockEv.prototype.setMapActiveMessageShown = function (v) { this._shown = v; };
  MockEv.prototype.getMapActiveMessageRange = function () { return 3; };
  MockEv.prototype.sensorUpdate = function () { sensorCalls++; };
  function MockMap(evs) { this._events = evs; }
  MockMap.tileUnit = 0.5;
  MockMap.prototype.events = function () { return this._events.filter(Boolean); };
  MockMap.prototype.eventsXy = function (x, y) { return this.events().filter((event) => event.pos(x, y)); };
  MockMap.prototype.eventsXyNt = function (x, y) { return this.events().filter((event) => event.posNt(x, y)); };
  MockMap.prototype.eventsXyUnitNt = function (x, y) { return this.events().filter((event) => event.posExpansionNt(x, y)); };
  function MockPlayer() { this._x = 5; this._y = 5; }
  MockPlayer.prototype.canMove = function () { return true; };
  MockPlayer.prototype.calcDistanceForMapActiveMessage = function (ev) {
    return Math.hypot(ev._x - this._x, ev._y - this._y);
  };
  MockPlayer.prototype.findAvailableMapActiveMessageEvents = function () {
    return runtime21.$gameMap.events().filter((e) => e.hasMapActiveMessage() && !e.isMapActiveMessageShown());
  };

  const evNear = new MockEv(5.5, 5, false, true);
  const evFar = new MockEv(20, 20, false, true);
  const evThrough = new MockEv(5, 5, true, false);
  const mapObj = new MockMap([null, evNear, evFar, evThrough]);

  const runtime21 = {
    Utils: { isDesignMode: () => true },
    Graphics: {
      _maxSkip: 3,
      _skipCount: 0,
      width: 1280,
      height: 720,
      render() { this._skipCount = Math.min(2, this._maxSkip); },
    },
    SceneManager: {
      _deltaTime: 1 / 60,
      _currentTime: fakeClock,
      _accumulator: 0,
      _scene: { constructor: { name: 'Scene_Map' } },
      _getTimeInMsWithoutMobileSafari: () => fakeClock,
      isSceneChanging: () => false,
      updateInputData() {},
      changeScene() {},
      updateScene() { sceneUpdates++; },
      renderScene() {},
      requestUpdate() {},
      updateMain() {},
    },
    Window_Message: MockWinMsg,
    Window_ChoiceList: MockChoice,
    Window_Gold: MockGold,
    Game_CharacterBase: MockCharBase,
    Game_Event: MockEv,
    Game_Map: MockMap,
    Game_Player: MockPlayer,
    $gameMap: mapObj,
  };
  mod.installMvCompat(runtime21, { isDirectGpu: () => true, getWebGLContext: () => ({}), beginFrame() {}, endFrame() {} }, {});

  // 1) GraphicalDesignMode forced to read-only runtime mode + WebGL2 maxSkip=0 & skipCount=0 even after reset
  assert.equal(runtime21.Utils.isDesignMode(), false);
  assert.equal(runtime21.Graphics._maxSkip, 0);
  runtime21.Graphics._maxSkip = 3; // simulate Graphics.initialize() overwriting _maxSkip after installMvCompat
  runtime21.Graphics._skipCount = 2;
  runtime21.Graphics.render({});
  assert.equal(runtime21.Graphics._maxSkip, 0, 'WebGL2 Graphics.render must re-enforce _maxSkip=0');
  assert.equal(runtime21.Graphics._skipCount, 0, 'WebGL2 Graphics.render must never leave _skipCount > 0');

  // 2) VSync phase-lock: 10 consecutive 16.5ms frames must each run exactly 1 tick (zero 0-tick stutters!)
  for (let i = 0; i < 10; i++) {
    fakeClock += 16.5;
    runtime21.SceneManager.updateMain();
  }
  assert.equal(sceneUpdates, 10, 'VSync phase-lock must produce 1:1 ticks at 16.5ms frame cadence');

  // 3) Closed extra Window_MessageEx skips update, primary & busy extra run normally
  const primaryMsg = new MockWinMsg(0);
  const exMsg = new MockWinMsg(3);
  primaryMsg.update();
  assert.equal(msgCalls, 1);
  exMsg.update();
  assert.equal(msgCalls, 1, 'Closed/idle Window_MessageEx (_windowId > 0) must skip update');
  exMsg._gameMessage._texts.push('Hello');
  exMsg.update();
  assert.equal(msgCalls, 2, 'Busy Window_MessageEx must resume update immediately');

  // 4) Closed inactive Window_ChoiceList & Window_Gold (even with active=true!) skip update, opening runs normally
  const chWin = new MockChoice();
  chWin.update();
  assert.equal(choiceCalls, 0);
  chWin._opening = true;
  chWin.update();
  assert.equal(choiceCalls, 1);
  const goldWin = new MockGold();
  goldWin.update();
  assert.equal(goldCalls, 0, 'Closed Window_Gold must skip update even with Window_Base default active=true');
  goldWin._opening = true;
  goldWin.update();
  assert.equal(goldCalls, 1);

  // 5) HalfMove eventsXyUnitNt, KMS findAvailableMapActiveMessageEvents, MKR sensorUpdate
  assert.deepEqual(mapObj.eventsXyUnitNt(5, 5), [evNear]);
  const pl = new MockPlayer();
  assert.deepEqual(pl.findAvailableMapActiveMessageEvents(), [evNear]);
  evNear._shown = true;
  evFar._shown = true;
  assert.deepEqual(pl.findAvailableMapActiveMessageEvents(), []);
  assert.equal(evFar._shown, false, 'Out-of-range shown active message flag must be cleared');
  evNear.sensorUpdate();
  assert.equal(sensorCalls, 0);
  evNear._sensorStatus = 1;
  evNear.sensorUpdate();
  assert.equal(sensorCalls, 1);

  // 6) nw.Window.get().close() & nw.App.quit() delegate to target.close()
  let closeCalls = 0;
  const nwTarget = { close: () => { closeCalls++; } };
  mod.installNodeCompat(nwTarget, createMockSwitch({}), 'sdmc:/g/www', 'sdmc:/g/save');
  nwTarget.nw.Window.get().close();
  nwTarget.nw.App.quit();
  assert.equal(closeCalls, 2);

  // 7) YEP_CoreEngine-style command355 (>360 chars with try/catch) fast-path + EventReSpawn / MKR view-range caches
  let rawCmd355Calls = 0;
  let prefabFullCalls = 0;
  let viewRangeFullCalls = 0;
  function YepInterp() { this._index = 0; this._list = []; }
  YepInterp.prototype.currentCommand = function () { return this._list[this._index]; };
  YepInterp.prototype.nextEventCode = function () { return this._list[this._index + 1]?.code ?? 0; };
  YepInterp.prototype.command355 = function () {
    // Pad > 360 chars like YEP_CoreEngine's try/catch wrapper
    var script = this.currentCommand().parameters[0] + '\n';
    while (this.nextEventCode() === 655) {
      this._index++;
      script += this.currentCommand().parameters[0] + '\n';
    }
    try {
      rawCmd355Calls++;
      eval(script);
    } catch (e) {
      if (typeof Yanfly !== 'undefined') Yanfly.Util.displayError(e, script, 'SCRIPT CALL ERROR');
    }
    return true;
  };
  assert.ok(String(YepInterp.prototype.command355).length > 360, 'Test fixture must exceed old 360-char limit');
  function MockSSMap() {}
  MockSSMap.prototype.updatePrefabEvent = function () { prefabFullCalls++; };
  MockSSMap.prototype.updateViewRange = function () { viewRangeFullCalls++; };
  function MockMap2() {
    this._mapId = 63;
    this._events = [null, { isPrefab: () => false, _sensorType: null, update() {} }];
    this._commonEvents = [];
  }
  MockMap2.prototype.events = function () { throw new Error('zero-alloc updateEvents must not call this.events()'); };
  MockMap2.prototype.updateEvents = function () {
    this.events().forEach((e) => e.update());
    this._commonEvents.forEach((c) => c.update());
  };
  MockMap2.prototype.spawnEvent = function () {
    this._events.push({ isPrefab: () => true, _sensorType: null, update() {} });
  };
  const rt21b = {
    Game_Interpreter: YepInterp,
    Spriteset_Map: MockSSMap,
    Game_Map: MockMap2,
    Graphics: { frameCount: 1 },
    $gameVariables: { _data: [] },
    $gameSwitches: { _data: [] },
    $gameMap: new MockMap2(),
  };
  mod.installMvCompat(rt21b, { isDirectGpu: () => true }, {});
  const yi = new YepInterp();
  yi._list = [
    { code: 355, parameters: ['$gameVariables._data[708] = 10'] },
    { code: 355, parameters: ['$gameVariables._data[708] += 5;'] },
    { code: 355, parameters: ['$gameVariables._data[708] -= 3'] },
    { code: 355, parameters: ['$gameSwitches._data[104] = true;'] },
  ];
  for (let i = 0; i < yi._list.length; i++) {
    yi._index = i;
    assert.equal(yi.command355(), true);
  }
  assert.equal(rt21b.$gameVariables._data[708], 12);
  assert.equal(rt21b.$gameSwitches._data[104], true);
  assert.equal(rawCmd355Calls, 0, 'YEP_CoreEngine command355 must bypass raw eval()');
  rt21b.$gameMap.updateEvents(); // must not throw (does not call this.events())
  const ss2 = new MockSSMap();
  ss2.updatePrefabEvent();
  ss2.updatePrefabEvent();
  assert.equal(prefabFullCalls, 0, 'updatePrefabEvent must skip when map has 0 prefabs');
  rt21b.$gameMap.spawnEvent();
  ss2.updatePrefabEvent();
  assert.equal(prefabFullCalls, 1, 'updatePrefabEvent must run once a prefab event is spawned');
  ss2.updateViewRange();
  ss2.updateViewRange();
  assert.equal(viewRangeFullCalls, 0, 'updateViewRange must skip when map has 0 sensor events');

  console.log('[PASS] GraphicalDesignMode runtime mode, WebGL2 VSync phase-lock, closed message/sub-window skip, HalfMove/KMS/MKR/EventReSpawn/YEP-cmd355 fast-paths & clean exit routing');
}

// 22. Verify Basic/Pro Performance HUD (MV & MZ), command355 var-to-var fast-path,
//     YEP_EventMiniLabel lazy setup skip, and FTKR deferred _refreshAllParts on closed extra windows
{
  // 1) HUD mode cycle + Basic & Pro canvas rendering
  assert.equal(mod.nextHudMode('off'), 'basic');
  assert.equal(mod.nextHudMode('basic'), 'pro');
  assert.equal(mod.nextHudMode('pro'), 'off');
  const drawnTexts = [];
  const fakeCtx = {
    canvas: { width: 1280, height: 720 },
    save() {}, restore() {}, setTransform() {}, fillRect() {}, strokeRect() {},
    fillText(t) { drawnTexts.push(String(t)); },
  };
  const snap = {
    engine: 'MV', backend: 'WebGL2', fps: 59.8, frameMs: 16.7, updateMs: 4.1, renderMs: 3.2,
    ticksPerFrame: 1.0, sceneName: 'Scene_Map', displayMode: 'fit', filterMode: 'auto',
    gameW: 1024, gameH: 768, vpW: 960, vpH: 720, memMiB: 256,
    map: { ev: 107, ch: 75, pic: 100, gmMs: 1.5, evMs: 1.2, ssMs: 1.7, winMs: 0.1 },
    gl: { drawsPerFrame: 14, texUploads: 135, err: 0 },
    frameHistory: [16.6, 16.7, 22.1, 34.0], frameHistoryHead: 0,
  };
  mod.drawPerfHud(fakeCtx, 'basic', snap);
  assert.ok(drawnTexts.some((t) => t.includes('SW2RPGMGL (MV)') && t.includes('60 FPS')));
  drawnTexts.length = 0;
  mod.drawPerfHud(fakeCtx, 'pro', snap);
  assert.ok(drawnTexts.some((t) => t.includes('59.8 FPS')));
  assert.ok(drawnTexts.some((t) => t.includes('Upd 4.1ms') && t.includes('Ren 3.2ms')));
  assert.ok(drawnTexts.some((t) => t.includes('Map ev:107')));
  assert.ok(drawnTexts.some((t) => t.includes('GL: 14 draws/f')));

  // 2) command355 var-to-var copy/sub, YEP_EventMiniLabel lazy setup, FTKR deferred _refreshAllParts
  let mlCreated = 0;
  let partsRefreshed = 0;
  function MockInterp22() { this._index = 0; this._list = []; }
  MockInterp22.prototype.currentCommand = function () { return this._list[this._index]; };
  MockInterp22.prototype.nextEventCode = function () { return 0; };
  MockInterp22.prototype.command355 = function () { throw new Error('must use var-to-var fast-path'); };
  function MockMiniWin() {}
  MockMiniWin.prototype.initialize = function () { this.visible = true; this._text = ''; };
  MockMiniWin.prototype.update = function () {};
  function MockSpChar22(ch) { this._character = ch; }
  MockSpChar22.prototype.setupMiniLabel = function () { mlCreated++; this._miniLabel = new MockMiniWin(); };
  function MockWin22(id) { this._windowId = id; this._openness = 0; this._opening = false; }
  MockWin22.prototype._refreshAllParts = function () { partsRefreshed++; };
  Object.defineProperty(MockWin22.prototype, 'openness', {
    configurable: true,
    get() { return this._openness; },
    set(v) { this._openness = v; },
  });
  function MockWinMsgEx22(id) { MockWin22.call(this, id); }
  MockWinMsgEx22.prototype = Object.create(MockWin22.prototype);
  MockWinMsgEx22.prototype.createSubWindows = function () { this._goldWindow = new MockWin22(0); };

  const rt22 = {
    Game_Interpreter: MockInterp22,
    Window_EventMiniLabel: MockMiniWin,
    Sprite_Character: MockSpChar22,
    Window: MockWin22,
    Window_MessageEx: MockWinMsgEx22,
    $gameVariables: { _data: { 1301: 42, 1402: 7, 600: 20 } },
    $gameSwitches: { _data: {} },
  };
  mod.installMvCompat(rt22, { isDirectGpu: () => true }, {});

  const ip22 = new MockInterp22();
  ip22._list = [
    { code: 355, parameters: ['$gameVariables._data[1311] = $gameVariables._data[1301]'] },
    { code: 355, parameters: ['$gameVariables._data[600] -= $gameVariables._data[1402]'] },
  ];
  ip22._index = 0; ip22.command355();
  ip22._index = 1; ip22.command355();
  assert.equal(rt22.$gameVariables._data[1311], 42);
  assert.equal(rt22.$gameVariables._data[600], 13);

  const plainEv = { _eventId: 1, event: () => ({ pages: [{ list: [{ code: 108, parameters: ['just a comment'] }] }] }) };
  const taggedEv = { _eventId: 2, event: () => ({ pages: [{ list: [{ code: 108, parameters: ['<Mini Label: Shop>'] }] }] }) };
  new MockSpChar22(plainEv).setupMiniLabel();
  assert.equal(mlCreated, 0, 'Event without Mini Label tag must not allocate Window_EventMiniLabel');
  new MockSpChar22(taggedEv).setupMiniLabel();
  assert.equal(mlCreated, 1, 'Event with Mini Label tag must allocate Window_EventMiniLabel');

  const exWin = new MockWinMsgEx22(3);
  exWin.createSubWindows();
  assert.equal(exWin._goldWindow._windowId, 3);
  exWin._refreshAllParts();
  assert.equal(partsRefreshed, 0, 'Closed _windowId>0 window must defer _refreshAllParts');
  exWin.openness = 32;
  assert.equal(partsRefreshed, 1, 'Opening deferred _windowId>0 window must flush _refreshAllParts');

  console.log('[PASS] Basic/Pro Performance HUD (MV & MZ), cmd355 var-to-var fast-path, lazy MiniLabel & FTKR deferred parts refresh');
}

// 23. Verify path.posix/isAbsolute, nw.process, os.userInfo(), and index.html custom <canvas id="..."> pre-mounting
{
  const rt23 = {};
  mod.installNodeCompat(rt23, null, 'sdmc:/switch/SW2RPGMGL/games/Test/www', 'sdmc:/switch/SW2RPGMGL/games/Test/save');
  const pMod = rt23.require('path');
  assert.equal(pMod.posix, pMod);
  assert.equal(pMod.win32, pMod);
  assert.equal(pMod.posix.dirname('/index.html'), '/');
  assert.equal(pMod.posix.isAbsolute('/img/system/Window.png'), true);
  assert.equal(pMod.posix.isAbsolute('img/system/Window.png'), false);
  assert.equal(rt23.nw.process.platform, 'switch2');
  const uinfo = rt23.require('os').userInfo();
  assert.equal(typeof uinfo.username, 'string');
  assert.ok(uinfo.username.length > 0);

  const html = `<!DOCTYPE html><body><canvas id="refresher" style="width:100%;height:100%;"></canvas><canvas id="GameCanvas" width="816" height="624"></canvas><canvas id="hud" width="320" height="240"></canvas></body>`;
  const parsed = mod.extractIndexCanvases(html);
  assert.deepEqual(parsed, [
    { id: 'refresher', width: 1, height: 1 },
    { id: 'hud', width: 320, height: 240 },
  ]);
  const mountedNodes = [];
  const fakeDoc = {
    body: { appendChild(n) { mountedNodes.push(n); } },
    getElementById(id) { return mountedNodes.find((n) => n.id === id) || null; },
    createElement(tag) { return { tagName: tag.toUpperCase(), id: '', width: 0, height: 0 }; },
  };
  const ids = mod.mountIndexHtmlCanvases(fakeDoc, html);
  assert.deepEqual(ids, ['refresher', 'hud']);
  assert.ok(fakeDoc.getElementById('refresher'));
  assert.equal(fakeDoc.getElementById('hud').width, 320);

  console.log('[PASS] path.posix/isAbsolute, nw.process, os.userInfo(), and index.html custom <canvas> pre-mounting');
}

// 24. Fast pause-menu round-trip: $dataMap + Spriteset_Map reused, stale scene-level extras deduped
{
  function Container() { this.children = []; this.parent = null; }
  Container.prototype.addChild = function (c) { if (c.parent) c.parent.removeChild(c); this.children.push(c); c.parent = this; return c; };
  Container.prototype.removeChild = function (c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parent = null; } return c; };
  let builds = 0;
  let loads = 0;
  class Spriteset_Map extends Container {
    constructor() { super(); builds++; this._tilemap = this.addChild(new Container()); }
  }
  function Scene_Base() { Container.call(this); }
  Scene_Base.prototype = Object.create(Container.prototype);
  function Scene_MenuBase() { Scene_Base.call(this); }
  Scene_MenuBase.prototype = Object.create(Scene_Base.prototype);
  function Scene_Menu() { Scene_MenuBase.call(this); }
  Scene_Menu.prototype = Object.create(Scene_MenuBase.prototype);
  function Scene_Title() { Scene_Base.call(this); }
  Scene_Title.prototype = Object.create(Scene_Base.prototype);
  function Scene_Map() { Scene_Base.call(this); }
  Scene_Map.prototype = Object.create(Scene_Base.prototype);
  const rt = {
    Graphics: { width: 816, height: 624, frameCount: 0 },
    Scene_MenuBase, Scene_Map, Scene_Menu, Scene_Title,
    $gameMap: { mapId: () => 3, tilesetId: () => 1 },
    $gamePlayer: { isTransferring: () => false },
    $dataMap: null,
    SceneManager: { _nextScene: null, onSceneCreate() {} },
  };
  rt.DataManager = { loadMapData(id) { loads++; rt.$dataMap = { id, data: [] }; } };
  Scene_Map.prototype.create = function () { rt.DataManager.loadMapData(rt.$gameMap.mapId()); };
  Scene_Map.prototype.createSpriteset = function () {
    this._spriteset = new Spriteset_Map();
    this.addChild(this._spriteset);
  };
  // Scene-level plugin code that attaches a HUD to the spriteset on every build
  Scene_Map.prototype.start = function () {
    this.createSpriteset();
    this._hud = this._spriteset.addChild(new Container());
  };
  Scene_Map.prototype.terminate = function () { this.removeChild(this._spriteset); };
  mod.installMvCompat(rt, { isDirectGpu: () => true, getWebGLContext: () => null }, {});

  const s1 = new rt.Scene_Map();
  s1.create(); s1.start();
  assert.equal(builds, 1);
  assert.equal(loads, 1);
  const firstData = rt.$dataMap;
  const firstSs = s1._spriteset;
  rt.SceneManager._nextScene = new Scene_Menu();
  s1.terminate();
  rt.SceneManager._nextScene = null;

  const s2 = new rt.Scene_Map();
  s2.create(); s2.start();
  assert.equal(loads, 1, 'map JSON must not be reloaded after a menu round-trip');
  assert.equal(rt.$dataMap, firstData);
  assert.equal(builds, 1, 'Spriteset_Map must be reused after a menu round-trip');
  assert.equal(s2._spriteset, firstSs);
  assert.equal(firstSs.parent, s2);
  const huds = firstSs.children.filter((c) => c !== firstSs._tilemap);
  assert.equal(huds.length, 1, 'stale scene-level HUD duplicate must be removed');
  assert.equal(huds[0], s2._hud);

  // A transfer (or new game / title) must rebuild everything
  rt.SceneManager._nextScene = new Scene_Menu();
  s2.terminate();
  rt.SceneManager._nextScene = null;
  rt.$gamePlayer.isTransferring = () => true;
  const s3 = new rt.Scene_Map();
  s3.create(); s3.start();
  assert.equal(loads, 2);
  assert.equal(builds, 2);
  rt.$gamePlayer.isTransferring = () => false;

  // Leaving to a non-menu scene does not cache
  rt.SceneManager._nextScene = new Scene_Title();
  s3.terminate();
  const s4 = new rt.Scene_Map();
  s4.create(); s4.start();
  assert.equal(loads, 3);
  assert.equal(builds, 3);

  // "fastMenu": false opt-out keeps stock behaviour
  const rtOff = { ...rt, Scene_Map: function Scene_Map() {}, DataManager: { loadMapData() {} } };
  rtOff.Scene_Map.prototype = { create() {}, terminate() {}, start() {} };
  mod.installMvCompat(rtOff, { isDirectGpu: () => true, getWebGLContext: () => null }, { fastMenu: false });
  assert.equal(rtOff.Scene_Map.prototype.__drFastMenu, undefined);

  // Plugin-overridden createSpriteset (stores its own layer on the scene): reuse via Spriteset_Map hook
  let builds2 = 0;
  function SS2() { Container.call(this); builds2++; this._tilemap = this.addChild(new Container()); }
  SS2.prototype = Object.create(Container.prototype);
  SS2.prototype.constructor = SS2;
  SS2.prototype.update = function () {};
  function SM2() { Scene_Base.call(this); }
  SM2.prototype = Object.create(Scene_Base.prototype);
  const rt2 = {
    Graphics: { width: 816, height: 624, frameCount: 0 },
    Scene_MenuBase, Scene_Menu, Scene_Title, Scene_Map: SM2, Spriteset_Map: SS2,
    $gameMap: { mapId: () => 5, tilesetId: () => 2 },
    $gamePlayer: { isTransferring: () => false },
    $dataMap: null,
    SceneManager: { _nextScene: null, onSceneCreate() {} },
  };
  let loads2 = 0;
  rt2.DataManager = { loadMapData(id) { loads2++; rt2.$dataMap = { id }; } };
  SM2.prototype.create = function () { rt2.DataManager.loadMapData(rt2.$gameMap.mapId()); };
  // plugin override: builds via the global constructor, then stores an overlay on the scene
  SM2.prototype.createSpriteset = function () {
    this._spriteset = new rt2.Spriteset_Map();
    this.addChild(this._spriteset);
    this._pluginLayer = this._spriteset.addChild(new Container());
  };
  SM2.prototype.start = function () { this.createSpriteset(); };
  SM2.prototype.terminate = function () { this.removeChild(this._spriteset); };
  mod.installMvCompat(rt2, { isDirectGpu: () => true, getWebGLContext: () => null }, {});
  assert.notEqual(rt2.Spriteset_Map, SS2, 'Spriteset_Map constructor is hooked');
  const plain = new rt2.Spriteset_Map();
  assert.ok(plain instanceof SS2 && plain instanceof rt2.Spriteset_Map);
  const b0 = builds2;
  const m1 = new SM2();
  m1.create(); m1.start();
  const ss1 = m1._spriteset;
  rt2.SceneManager._nextScene = new Scene_Menu();
  m1.terminate();
  rt2.SceneManager._nextScene = null;
  const m2 = new SM2();
  m2.create(); m2.start();
  assert.equal(loads2, 1);
  assert.equal(builds2, b0 + 1, 'overridden createSpriteset still reuses the cached spriteset');
  assert.equal(m2._spriteset, ss1);
  assert.ok(m2._pluginLayer, 'plugin override still ran and set its scene field');
  const layers = ss1.children.filter((c) => c !== ss1._tilemap);
  assert.deepEqual(layers, [m2._pluginLayer], 'stale plugin layer from the first build was removed');

  console.log('[PASS] Fast pause-menu round-trip ($dataMap + Spriteset_Map reuse, stale extras dedupe, transfer/title rebuild, opt-out, overridden createSpriteset)');
}

// 25. Lazy window chrome + menu spriteset picture container reuse
{
  let realRefreshes = 0;
  function Window() { this._openness = 255; this._refreshAllParts(); this._refreshAllParts(); this._refreshBack(); }
  Window.prototype._refreshAllParts = function () { realRefreshes++; };
  Window.prototype._refreshBack = function () { realRefreshes++; };
  Window.prototype._refreshFrame = function () { realRefreshes++; };
  Window.prototype._refreshCursor = function () {};
  Window.prototype.updateTransform = function () {};
  let picBuilds = 0;
  function Container() { this.children = []; this.parent = null; }
  Container.prototype.addChild = function (c) { if (c.parent) c.parent.removeChild(c); this.children.push(c); c.parent = this; return c; };
  Container.prototype.removeChild = function (c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parent = null; } return c; };
  function Spriteset_Base() { Container.call(this); this.createPictures(); }
  Spriteset_Base.prototype = Object.create(Container.prototype);
  Spriteset_Base.prototype.createPictures = function () {
    this._pictureContainer = new Container();
    for (let i = 0; i < 100; i++) { picBuilds++; this._pictureContainer.addChild(new Container()); }
    this.addChild(this._pictureContainer);
  };
  function Spriteset_Menu() { Spriteset_Base.call(this); }
  Spriteset_Menu.prototype = Object.create(Spriteset_Base.prototype);
  Spriteset_Menu.prototype.constructor = Spriteset_Menu;
  function Spriteset_Map() { Spriteset_Base.call(this); }
  Spriteset_Map.prototype = Object.create(Spriteset_Base.prototype);
  Spriteset_Map.prototype.constructor = Spriteset_Map;
  const rt = {
    Graphics: { width: 816, height: 624, frameCount: 0 },
    Window, Spriteset_Base, Spriteset_Map,
    $gameScreen: { maxPictures: () => 100 },
    SceneManager: { _scene: null },
  };
  mod.installMvCompat(rt, { isDirectGpu: () => true, getWebGLContext: () => null }, {});

  const w = new rt.Window();
  assert.equal(realRefreshes, 0, 'chrome refreshes are deferred during construction');
  w._openness = 0;
  w.updateTransform();
  assert.equal(realRefreshes, 0, 'closed window stays deferred');
  w._openness = 32;
  w.updateTransform();
  assert.equal(realRefreshes, 1, 'one real refresh when first drawn open');
  w._refreshBack();
  assert.equal(realRefreshes, 2, 'live windows refresh normally');

  const scene1 = new Container();
  rt.SceneManager._scene = scene1;
  const m1 = scene1.addChild(new Spriteset_Menu());
  assert.equal(picBuilds, 100);
  const scene2 = new Container();
  rt.SceneManager._scene = scene2;
  const m2 = scene2.addChild(new Spriteset_Menu());
  assert.equal(picBuilds, 100, 'menu spriteset reuses the previous picture container');
  assert.equal(m2._pictureContainer, m1._pictureContainer);
  assert.equal(m2._pictureContainer.parent, m2);
  new Spriteset_Map();
  assert.equal(picBuilds, 200, 'map spritesets always build their own pictures');

  // Plugin override of createPictures that adds its own picture layer (Nightmare Knight crash:
  // updatePosition touched that layer, which a reuse used to leave undefined)
  function SB2() { Container.call(this); this.createPictures(); this.updatePosition(); }
  SB2.prototype = Object.create(Container.prototype);
  SB2.prototype.createPictures = function () {
    this._pictureContainer = this.addChild(new Container());
    for (let i = 0; i < 100; i++) { picBuilds++; this._pictureContainer.addChild(new Container()); }
  };
  const stockCreate = SB2.prototype.createPictures;
  SB2.prototype.createPictures = function () {            // the plugin override
    stockCreate.call(this);
    this._upperPictures = this.addChild(new Container());
    this._upperPictures.addChild(new Container());
  };
  SB2.prototype.updatePosition = function () { this._upperPictures.x = 1; };
  function SMenu2() { SB2.call(this); }
  SMenu2.prototype = Object.create(SB2.prototype);
  SMenu2.prototype.constructor = SMenu2;
  const rt3 = {
    Graphics: { width: 816, height: 624, frameCount: 0 },
    Spriteset_Base: SB2,
    $gameScreen: { maxPictures: () => 100 },
    SceneManager: { _scene: null },
  };
  mod.installMvCompat(rt3, { isDirectGpu: () => true, getWebGLContext: () => null }, {});
  const before = picBuilds;
  rt3.SceneManager._scene = new Container();
  const a = rt3.SceneManager._scene.addChild(new SMenu2());
  rt3.SceneManager._scene = new Container();
  const b = rt3.SceneManager._scene.addChild(new SMenu2());   // used to throw in updatePosition
  assert.equal(picBuilds, before + 100, 'second menu spriteset reused the pictures');
  assert.equal(b._pictureContainer, a._pictureContainer);
  assert.equal(b._upperPictures, a._upperPictures, 'plugin-created picture layer restored too');
  assert.equal(b._upperPictures.parent, b);
  assert.equal(b._upperPictures.x, 1);

  console.log('[PASS] Lazy window chrome + menu spriteset picture container reuse');
}

console.log('\nALL UNIVERSAL SW2RPGMGL TESTS PASSED!');
