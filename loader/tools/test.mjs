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

// Optional read-only checks against real game files: set SW2_TEST_GAMES_DIR to a folder that holds
// the PC game folders (e.g. `OMORI`, `Dragon Conquista`). Those checks are skipped when it's unset.
const REAL_GAMES_DIR = process.env.SW2_TEST_GAMES_DIR || '';
const realGamePath = (...parts) => (REAL_GAMES_DIR ? join(REAL_GAMES_DIR, ...parts) : null);

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

{
  const fs = 'precision mediump float;' + String.fromCharCode(10) + 'varying lowp vec4 vColor; uniform mediump sampler2D s;';
  assert.equal(mod.promoteShaderPrecision(fs), 'precision highp float;' + String.fromCharCode(10) + 'varying highp vec4 vColor; uniform highp sampler2D s;');
  assert.equal(mod.promoteShaderPrecision('float mediumpx = 1.0; // lowpass'), 'float mediumpx = 1.0; // lowpass', 'only whole-word qualifiers');
  console.log('  ✓ shader precision promoted to highp');
}
// Graphics.loadFont(name, url) at runtime registers the shipped file under the requested family
// (In Stars And Time: 'default1' <- fonts/VCR_OSD_MONO_1.001.ttf)
assert.equal(mod.registerFontFamilySync('default1', 'fonts/Amarante-Regular.ttf'), true);
assert.ok(registeredFonts.includes('default1'), 'requested family registered');
assert.equal(mod.registerFontFamilySync('default1', 'fonts/Amarante-Regular.ttf'), false, 'registered once');
assert.equal(mod.registerFontFamilySync('GameFont', 'fonts/ship.otf'), false, 'never replaces a family from fonts/');
assert.equal(mod.registerFontFamilySync('missing', 'fonts/nope.ttf'), false, 'missing file is ignored');
assert.equal(mod.registerFontFamilySync('spaced', './fonts/Amarante%2DRegular.ttf'), true, 'relative, URL-encoded path');
console.log('[PASS] Graphics.loadFont registers runtime font families');

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
    realGamePath('Dragon Conquista'),
    realGamePath('Stranded with You'),
  ].filter(Boolean)) {
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
  const realWoffPath = realGamePath('Dragon Conquista', 'fonts', 'mplus-1m-regular.woff');
  if (realWoffPath && existsSync(realWoffPath)) {
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
  // In Stars And Time hard-wires the renderer type and calls checkWebGL() -> needs WebGL2 mode
  assert.equal(mod.detectMvWebGLReason(null, null, null,
    "SceneManager.preferableRendererType = function() {\n        return 'webgl';\n    if (Utils.isOptionValid('canvas')) {"), 'forced WebGL');
  assert.equal(mod.detectMvWebGLReason(null, null, null,
    "SceneManager.preferableRendererType = function() {\n    if (Utils.isOptionValid('canvas')) {\n        return 'canvas';"), null);

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

  // 4a) TN_SpriteExtender / bush-depth half-body children (_upperBody/_lowerBody) still allow the fast path
  const tnEv = new MockEvent();
  const tnSp = new MockSpriteChar(tnEv);
  tnSp._upperBody = { name: 'upper' };
  tnSp._lowerBody = { name: 'lower' };
  tnSp.children.push(tnSp._upperBody, tnSp._lowerBody);
  tnSp.update(); tnSp.update();
  assert.equal(tnSp._drFastOk, true, 'half-body children only -> fast path allowed');
  const beforeTn = charUpdates;
  tnSp.update();
  assert.equal(charUpdates, beforeTn, 'unchanged half-body sprite skips the full update');
  tnEv._drStateRev++; // event turned / animated -> parent recomputes the halves
  tnSp.update();
  assert.equal(charUpdates, beforeTn + 1);
  tnSp.children.push({ name: 'namePop' }); // any other child still forces full updates
  tnSp.update();
  assert.equal(tnSp._drFastOk, false);

  // 4b) Off-screen sprites that cannot use the fast path (lights, emitters) run the full update only
  //     every 8th tick while they stay off-screen, and immediately once they come back into view
  const farEv = new MockEvent();
  let farX = 5000;
  farEv.screenX = () => farX;
  const farSp = new MockSpriteChar(farEv);
  farSp.children.push({ name: 'animeLight' });
  farSp.x = 5000;
  farSp.update(); farSp.update(); // warm up -> ready & marked off-screen
  assert.equal(farSp._drOffscreenRender, true);
  const beforeOff = charUpdates;
  for (let i = 0; i < 16; i++) farSp.update();
  assert.equal(charUpdates - beforeOff, 2, 'far off-screen sprite: 2 full updates in 16 ticks');
  farX = 240; // scrolled back into view
  const beforeBack = charUpdates;
  farSp.update();
  assert.equal(charUpdates, beforeBack + 1, 'sprite back on screen gets a full update immediately');
  farEv._balloonId = 3; // a balloon on an off-screen event always runs the full update
  farX = 5000; farSp.x = 5000; farSp._drOffscreenRender = true;
  const beforeBalloon = charUpdates;
  farSp.update();
  assert.equal(charUpdates, beforeBalloon + 1);

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

// 26. OMORI & The Coffin of Andy and Leyley compatibility (AES-256-CTR, SHA-256, Zlib, CommonJS, Riruka24.ini, inline scripts, TCOAAL saves & OMORI gamepad)
{
  const nodeCrypto = await import('node:crypto');
  const nodeZlib = await import('node:zlib');

  const gameRoot = 'sdmc:/switch/SW2RPGMGL/games/TestEncryptedGame';
  const swEnc = createMockSwitch({
    [`${gameRoot}/Riruka24.ini`]: '[Launch]\r\nArgs=--00112233445566778899aabbccddeeff\r\n',
    [`${gameRoot}/www/index.html`]: '<html></html>',
    [`${gameRoot}/www/js/plugins/Test.OMORI`]: 'enc',
    [`${gameRoot}/www/languages/en/System.HERO`]: 'hero-data',
    [`${gameRoot}/www/js/libs/custom-pkg/package.json`]: JSON.stringify({ main: './lib/entry.js' }),
    [`${gameRoot}/www/js/libs/custom-pkg/lib/entry.js`]: "const sub = require('./helper'); module.exports = { answer: sub.val + 2 };",
    [`${gameRoot}/www/js/libs/custom-pkg/lib/helper.js`]: 'exports.val = 40;',
  });

  const encTarget = {};
  mod.installNodeCompat(
    encTarget,
    swEnc,
    `${gameRoot}/www`,
    `${gameRoot}/save`,
    undefined,
    gameRoot,
    'OMORI',
  );

  // Riruka24.ini Args + pre-created OMORI/CUTSCENE.json
  assert.deepEqual(encTarget.nw.App.argv, ['--00112233445566778899aabbccddeeff']);
  const fsEnc = encTarget.require('fs');
  const pathEnc = encTarget.require('path');
  assert.equal(fsEnc.existsSync(`${encTarget.process.env.LOCALAPPDATA}/OMORI/CUTSCENE.json`), true);
  assert.equal(pathEnc.join('/a/b', 'OMORI/'), '/a/b/OMORI/');
  assert.equal(pathEnc.relative(`${gameRoot}/www`, `${gameRoot}/www/fonts/Test.ttf`), 'fonts/Test.ttf');
  // Case-insensitive directory lookup (`/Languages/en/` -> `www/languages/en/`)
  assert.deepEqual(fsEnc.readdirSync(`${gameRoot}/www/Languages/en/`), ['System.HERO']);

  // Scoped CommonJS require('./...')
  assert.equal(encTarget.require('./js/libs/custom-pkg').answer, 42);

  // MiniBuffer slice & subarray species safety (regression for Coffin LANGDATA header check)
  const B = encTarget.Buffer;
  const fullBuf = B.from('LANGDATA{"hello":"world"}', 'utf8');
  const sigBuf = B.from('LANGDATA', 'utf8');
  assert.equal(fullBuf.slice(0, 8).byteLength, 8);
  assert.equal(fullBuf.subarray(0, 8).byteLength, 8);
  assert.equal(fullBuf.slice(0, 8).equals(sigBuf), true);
  assert.equal(B.concat([B.from('AB'), B.from('CD')]).toString('utf8'), 'ABCD');

  // SHA-256 (Coffin `data/System.json` -> `be1a37535e921f91`)
  const cryptoShim = encTarget.require('crypto');
  const sysHash = cryptoShim.createHash('sha256').update('data/System.json').digest('hex').slice(0, 16);
  assert.equal(sysHash, 'be1a37535e921f91');
  assert.equal(
    cryptoShim.createHash('sha256').update('The Coffin of Andy and Leyley').digest('hex'),
    nodeCrypto.createHash('sha256').update('The Coffin of Andy and Leyley').digest('hex'),
  );

  // AES-256-CTR (streaming unaligned + multi-block, verified bit-for-bit against node:crypto)
  const key = '00112233445566778899aabbccddeeff';
  const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const plain = Buffer.alloc(109, 0).map((_, idx) => (idx * 37 + 11) & 0xff);
  const nodeCipher = nodeCrypto.createCipheriv('aes-256-ctr', key, iv);
  const encrypted = Buffer.concat([nodeCipher.update(plain), nodeCipher.final()]);
  const decStream = cryptoShim.createDecipheriv('aes-256-ctr', key, iv);
  const part1 = decStream.update(encrypted.subarray(0, 7));   // unaligned 7 bytes
  const part2 = decStream.update(encrypted.subarray(7, 60));  // crosses multiple 16B blocks
  const part3 = decStream.update(encrypted.subarray(60));     // tail
  const decCombined = B.concat([part1, part2, part3, decStream.final()]);
  assert.deepEqual([...decCombined], [...plain]);

  // Zlib inflateSync & gunzipSync
  const zlibShim = encTarget.require('zlib');
  const samplePayload = Buffer.from('Coffin & OMORI Switch 2 Zlib Test! '.repeat(60), 'utf8');
  assert.equal(zlibShim.inflateSync(nodeZlib.deflateSync(samplePayload)).toString('utf8'), samplePayload.toString('utf8'));
  assert.equal(zlibShim.gunzipSync(nodeZlib.gzipSync(samplePayload)).toString('utf8'), samplePayload.toString('utf8'));

  // AudioStreaming.js trailing `_()` bootstrap preservation + .OMORI skip + Yanfly.PreloadedMaps dedupe
  const prep = mod.createScriptPreparer();
  assert.equal(prep('js/plugins/AudioStreaming.js', '/* audio */\nfunction foo(){}_();'), 'if (typeof _ === "function") _();');
  assert.equal(prep('js/plugins/AudioStreaming.OMORI', '/* plain audio */'), null);
  assert.equal(prep('js/plugins/OggOnly.OMORI', '/* stbvorbis */'), null);
  const dedupedYanfly = prep('js/plugins/YEP_EventCopier.OMORI', 'if (Yanfly.PreloadedMaps[mapId]) return;');
  assert.ok(dedupedYanfly.includes('Yanfly.PreloadedMaps[mapId] !== undefined'));

  // Inline <script>, <style>.sheet.insertRule, document.getElementsByTagName('head').item(0), atob/btoa
  const hostScreen = { width: 1280, height: 720, addEventListener() {}, getContext: () => null };
  const dummyAssets = mod.createAssetReader(`${gameRoot}/www`, swEnc);
  mod.createBrowserHost(dummyAssets, (_p, s) => s, hostScreen, { enableWebGL: false });
  assert.equal(globalThis.atob(globalThis.btoa('TCOAAL_DRM')), 'TCOAAL_DRM');
  const headEl = globalThis.document.getElementsByTagName('head').item(0);
  assert.equal(headEl.tagName, 'HEAD');
  const styleEl = globalThis.document.createElement('style');
  headEl.appendChild(styleEl);
  assert.equal(styleEl.sheet.insertRule('@font-face { font-family: "Test"; }', 0), 0);
  globalThis.__inlineRan = 0;
  const inlineScr = globalThis.document.createElement('script');
  inlineScr.textContent = 'globalThis.__inlineRan = 77;';
  globalThis.document.body.appendChild(inlineScr);
  assert.equal(globalThis.__inlineRan, 77);
  delete globalThis.__inlineRan;

  // Subdirectory saves & negative/zero autosave slot IDs (CoffinAndyLeyley/)
  const coffinSaveSw = createMockSwitch();
  const coffinRt = {
    StorageManager: {
      localFileDirectoryPath: () => `${gameRoot}/save/CoffinAndyLeyley/`,
      localFilePath: (id) => (id > 0
        ? `${gameRoot}/save/CoffinAndyLeyley/file${id}.rpgsave`
        : `${gameRoot}/save/CoffinAndyLeyley/auto12345.rpgsave`),
    },
    LZString: {
      compressToBase64: (s) => Buffer.from(s, 'utf8').toString('base64'),
      decompressFromBase64: (s) => Buffer.from(s, 'base64').toString('utf8'),
    },
  };
  mod.installSdSaves(coffinRt, coffinSaveSw, `${gameRoot}/save`);
  coffinRt.StorageManager.save(1, '{"slot":1}');
  coffinRt.StorageManager.save(0, '{"autosave":true}');
  assert.ok(coffinSaveSw._files.has(`${gameRoot}/save/CoffinAndyLeyley/file1.rpgsave`));
  assert.ok(coffinSaveSw._files.has(`${gameRoot}/save/CoffinAndyLeyley/auto12345.rpgsave`));
  assert.equal(coffinRt.StorageManager.load(0), '{"autosave":true}');

  // OMORI custom ConfigManager.setDefaultGamepadKeyMap preservation in input.ts
  const omoriInputRt = {
    Input: { keyMapper: {}, gamepadMapper: {}, _gamepadStates: [], _currentState: {} },
    ConfigManager: {
      gamepadTips: false,
      setDefaultKeyboardKeyMap() { omoriInputRt.Input.keyMapper = { 90: 'ok', 88: 'escape', 65: 'tag' }; },
      setDefaultGamepadKeyMap() { omoriInputRt.Input.gamepadMapper = { 0: 'ok', 1: 'escape', 3: 'tag' }; },
      applyData(cfg) {
        omoriInputRt.Input.gamepadMapper = cfg.gamepadInputMap;
        if (!omoriInputRt.Input.gamepadMapper) this.setDefaultGamepadKeyMap();
      },
    },
  };
  mod.createInputBridge().installIntoRuntime(omoriInputRt, () => ({ x: 0, y: 0, w: 640, h: 480, gw: 640, gh: 480 }));
  assert.equal(omoriInputRt.Input.gamepadMapper[1], 'ok');
  assert.equal(omoriInputRt.Input.gamepadMapper[0], 'escape');
  assert.equal(omoriInputRt.Input.gamepadMapper[3], 'tag');
  assert.equal(omoriInputRt.ConfigManager.gamepadTips, true);

  // Read-only verification against real OMORI & Coffin files if present in workspace
  const realOmoriPlugin = realGamePath('OMORI', 'www', 'js', 'plugins', 'DisableMouse.OMORI');
  const realOmoriIni = realGamePath('OMORI', 'Riruka24.ini');
  if (realOmoriPlugin && existsSync(realOmoriPlugin) && existsSync(realOmoriIni)) {
    const omoriKey = /Args\s*=\s*--(\S+)/.exec(readFileSync(realOmoriIni, 'utf8'))?.[1];
    assert.ok(omoriKey, 'Riruka24.ini has no Args=--<key>');
    const raw = readFileSync(realOmoriPlugin);
    const d = cryptoShim.createDecipheriv('aes-256-ctr', omoriKey, raw.subarray(0, 16));
    const txt = B.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8');
    assert.ok(txt.includes('TouchInput._onMouseDown'));
  }
  const realCoffinDir = realGamePath('The Coffin of Andy and Leyley', 'www', 'js', 'plugins');
  if (realCoffinDir && existsSync(join(realCoffinDir, 'YEP_RegionRestrictions.js'))) {
    const chunks = {};
    for (const f of readdirSync(realCoffinDir)) {
      if (!f.endsWith('.js')) continue;
      const s = readFileSync(join(realCoffinDir, f), 'utf8');
      for (const m of s.matchAll(/function\s+(_0x[0-9a-f]+_)\(\)\s*\{\s*return\s+"([^"]*)";\s*\}/g)) {
        chunks[m[1]] = m[2];
      }
    }
    const order = ['_0x375027_', '_0x30b90a_', '_0x990d93_', '_0xb68cd3_', '_0x7144d1_', '_0x19a532_', '_0x490766_'];
    const joinedB64 = order.map((kName) => chunks[kName]).join('');
    const decompressed = zlibShim.inflateSync(B.from(joinedB64, 'base64')).toString('utf8');
    assert.ok(decompressed.includes('BUILD_FLAGS'));
  }

  console.log('[PASS] OMORI & The Coffin of Andy and Leyley compatibility (AES-256-CTR, SHA-256, Zlib, CommonJS, inline scripts & gamepad)');
}

// Incremental ShaderTilemap painting: only newly exposed rows/columns are painted while scrolling
{
  let paintAllCalls = 0;
  const painted = [];
  let containerUT = 0;
  function MockContainer() {}
  MockContainer.prototype.updateTransform = function () { containerUT++; };
  function MockZLayer() { this.position = { x: 0, y: 0 }; this.clears = 0; }
  MockZLayer.prototype.clear = function () { this.clears++; };
  function ShaderTilemap() {
    this.origin = { x: 0, y: 0 };
    this.roundPixels = true;
    this._margin = 20;
    this._tileWidth = 48;
    this._tileHeight = 48;
    this._width = 1280 + 40;
    this._height = 720 + 40;
    this._needsRepaint = true;
    this.lowerZLayer = new MockZLayer();
    this.upperZLayer = new MockZLayer();
  }
  // Same shape as stock RPG Maker MV 1.6 rpg_core.js (the patch only installs over the stock code)
  ShaderTilemap.prototype.updateTransform = function () {
    if (this.roundPixels) {
      var ox = Math.floor(this.origin.x);
      var oy = Math.floor(this.origin.y);
    } else {
      ox = this.origin.x;
      oy = this.origin.y;
    }
    var startX = Math.floor((ox - this._margin) / this._tileWidth);
    var startY = Math.floor((oy - this._margin) / this._tileHeight);
    this._updateLayerPositions(startX, startY);
    if (this._needsRepaint || this._lastStartX !== startX || this._lastStartY !== startY) {
      this._lastStartX = startX;
      this._lastStartY = startY;
      this._paintAllTiles(startX, startY);
      this._needsRepaint = false;
    }
    this._sortChildren();
  };
  ShaderTilemap.prototype._paintAllTiles = function (startX, startY) {
    paintAllCalls++;
    this.lowerZLayer.clear();
    this.upperZLayer.clear();
    var tileCols = Math.ceil(this._width / this._tileWidth) + 1;
    var tileRows = Math.ceil(this._height / this._tileHeight) + 1;
    for (var y = 0; y < tileRows; y++) {
      for (var x = 0; x < tileCols; x++) {
        this._paintTiles(startX, startY, x, y);
      }
    }
  };
  ShaderTilemap.prototype._paintTiles = function (startX, startY, x, y) {
    painted.push([startX + x, startY + y, x * this._tileWidth, y * this._tileHeight]);
  };
  ShaderTilemap.prototype._updateLayerPositions = function () {};
  ShaderTilemap.prototype._sortChildren = function () {};

  // pixi-tilemap RectTileLayer with the stock full-rebuild logic (layout: 9 numbers/rect, 4x11 floats)
  let fullRebuilds = 0;
  let vbUploads = 0;
  // Fake GPU: one ARRAY_BUFFER binding point, one byte store per vertex buffer (pixi glCore GLBuffer:
  // upload(data, offset, dontBind) writes to whatever buffer is currently bound when dontBind is set)
  const gpu = { bound: null };
  const makeGlBuffer = () => {
    const b = {
      store: new Uint8Array(0), data: null,
      bind() { gpu.bound = b; },
      upload(data, offset = 0, dontBind) {
        if (!dontBind) b.bind();
        const target = gpu.bound;
        const bytes = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
        if (target.store.length >= bytes.length + offset) target.store.set(bytes, offset);
        else { target.store = new Uint8Array(bytes); }
        b.data = data;
      },
    };
    return b;
  };
  const fakeGl = {
    ARRAY_BUFFER: 0x8892,
    bufferSubData(_t, offset, data) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      assert.ok(gpu.bound.store.length >= offset + bytes.length, 'bufferSubData within the buffer');
      gpu.bound.store.set(bytes, offset);
    },
  };
  const vbs = new Map();
  let nextVbId = 1;
  function RectTileLayer() { this.pointsBuf = []; this.modificationMarker = 0; this.vbId = nextVbId++; this.vbBuffer = null; }
  RectTileLayer.prototype.clear = function () { this.pointsBuf.length = 0; this.modificationMarker = 0; };
  RectTileLayer.prototype.renderWebGL = function (renderer, useSquare) {
    var points = this.pointsBuf;
    if (points.length === 0) return;
    var rectsCount = points.length / 9;
    var vertices = rectsCount * 4;
    if (this.modificationMarker != vertices) {
      this.modificationMarker = vertices;
      fullRebuilds++;
      var vs = 44 * vertices;
      if (!this.vbBuffer || this.vbBuffer.byteLength < vs) {
        var bk = 44;
        while (bk < vs) bk *= 2;
        this.vbBuffer = new ArrayBuffer(bk);
        this.vbArray = new Float32Array(this.vbBuffer);
        renderer.plugins.tilemap.getVb(this.vbId).vb.bind();
        renderer.plugins.tilemap.getVb(this.vbId).vb.upload(this.vbBuffer, 0, true);
      }
      var arr = this.vbArray, sz = 0;
      for (var i = 0; i < points.length; i += 9) {
        var eps = 0.5;
        var textureId = (points[i + 8] >> 2);
        var shiftU = 1024 * (points[i + 8] & 1);
        var shiftV = 1024 * ((points[i + 8] >> 1) & 1);
        var x = points[i + 2], y = points[i + 3], w = points[i + 4], h = points[i + 5];
        var u = points[i] + shiftU, v = points[i + 1] + shiftV;
        var animX = points[i + 6], animY = points[i + 7];
        var cs = [x, y, u, v, x + w, y, u + w, v, x + w, y + h, u + w, v + h, x, y + h, u, v + h];
        for (var c = 0; c < 16; c += 4) {
          arr[sz++] = cs[c]; arr[sz++] = cs[c + 1]; arr[sz++] = cs[c + 2]; arr[sz++] = cs[c + 3];
          arr[sz++] = u + eps; arr[sz++] = v + eps; arr[sz++] = u + w - eps; arr[sz++] = v + h - eps;
          arr[sz++] = animX; arr[sz++] = animY; arr[sz++] = textureId;
        }
      }
      renderer.plugins.tilemap.getVb(this.vbId).vb.bind();
      renderer.plugins.tilemap.getVb(this.vbId).vb.upload(arr, 0, true);
      vbUploads++;
    }
  };
  const tmRt = {
    Graphics: { width: 1280, height: 720, frameCount: 0 },
    PIXI: { Container: MockContainer, tilemap: { RectTileLayer } },
    ShaderTilemap,
  };
  mod.installMvCompat(tmRt, { isDirectGpu: () => true, getWebGLContext: () => null }, {});
  assert.equal(ShaderTilemap.prototype.__drIncPaint, true);

  const tm = new ShaderTilemap();
  // cols = ceil(1320/48)+1 = 29, rows = ceil(760/48)+1 = 17; startX = floor((0-20)/48) = -1
  tm.updateTransform();
  assert.equal(paintAllCalls, 1, 'first frame paints the full view');
  assert.equal(painted.length, 29 * 17);
  assert.equal(tm.lowerZLayer.position.x, -48);
  // Walk one tile right: only the new right-hand column is painted, at its position relative to the origin
  painted.length = 0;
  tm.origin.x = 48;
  tm.updateTransform();
  assert.equal(paintAllCalls, 1, 'no full repaint when crossing a tile boundary');
  assert.equal(painted.length, 17, 'one new column of 17 cells');
  assert.ok(painted.every(([mx, , dx]) => mx === 28 && dx === (28 - -1) * 48));
  assert.equal(tm.lowerZLayer.position.x, -1 * 48 - 48, 'layers stay anchored to the paint origin');
  assert.equal(tm.upperZLayer.position.x, tm.lowerZLayer.position.x);
  // Walking back left reuses already painted cells
  painted.length = 0;
  tm.origin.x = 0;
  tm.updateTransform();
  assert.equal(painted.length, 0);
  // Diagonal step paints the new row and column once each (no duplicates)
  tm.origin.x = 96;
  tm.origin.y = 48;
  painted.length = 0;
  tm.updateTransform();
  const keys = new Set(painted.map(([mx, my]) => `${mx},${my}`));
  assert.equal(keys.size, painted.length, 'no cell painted twice');
  // refresh() -> _needsRepaint forces a full repaint
  tm._needsRepaint = true;
  tm.updateTransform();
  assert.equal(paintAllCalls, 2);
  // Travelling far enough to exceed ~6 screens of painted area triggers a full repaint
  tm.origin.x += 48 * 29 * 7;
  tm.updateTransform();
  assert.equal(paintAllCalls, 3);
  assert.ok(containerUT >= 5, 'children transforms still updated every frame');

  // Append-only vertex fill: growing a layer fills only the new rects, identical to a full rebuild
  assert.equal(RectTileLayer.prototype.__drAppendFill, true);
  const fakeRenderer = {
    gl: fakeGl,
    plugins: { tilemap: { getVb: (id) => { if (!vbs.has(id)) vbs.set(id, { vb: makeGlBuffer() }); return vbs.get(id); } } },
  };
  const gpuFloats = (layer, n) => Array.from(new Float32Array(vbs.get(layer.vbId).vb.store.buffer.slice(0, n * 176)));
  const addRects = (layer, n, seed) => {
    for (let k = 0; k < n; k++) {
      const t = seed + k;
      layer.pointsBuf.push(t * 3 % 512, t * 7 % 512, t * 48, (t % 17) * 48, 48, 24, t % 3, 0, (t % 5) << 2 | (t & 3));
    }
  };
  const grown = new RectTileLayer();
  addRects(grown, 100, 1);
  grown.renderWebGL(fakeRenderer, false);
  assert.equal(fullRebuilds, 1);
  addRects(grown, 10, 101);
  // Another layer's buffer is bound when the append happens (as after drawing a different layer)
  const other = new RectTileLayer();
  addRects(other, 3, 500);
  other.renderWebGL(fakeRenderer, false);
  const otherBefore = gpuFloats(other, 3);
  grown.renderWebGL(fakeRenderer, false);
  assert.equal(fullRebuilds, 2, 'appending rects must not rebuild the whole layer');
  assert.deepEqual(gpuFloats(other, 3), otherBefore, 'append must not write into the buffer of another layer');
  const reference = new RectTileLayer();
  addRects(reference, 110, 1);
  reference.renderWebGL(fakeRenderer, false);
  assert.deepEqual(
    Array.from(grown.vbArray.subarray(0, 110 * 44)),
    Array.from(reference.vbArray.subarray(0, 110 * 44)),
    'append-filled vertices match a full rebuild',
  );
  assert.deepEqual(gpuFloats(grown, 110), gpuFloats(reference, 110), 'GPU buffer holds the appended vertices');
  // clear() resets: the next fill is a normal full rebuild
  grown.clear();
  addRects(grown, 5, 7);
  const rebuildsBefore = fullRebuilds;
  grown.renderWebGL(fakeRenderer, false);
  assert.equal(fullRebuilds, rebuildsBefore + 1);
  console.log('[PASS] Incremental ShaderTilemap painting (new rows/columns only, full repaint on refresh/far travel)');
}

// TF_LayeredMap-compatible incremental painting must show exactly what TF's full repaint shows
{
  const TW = 48;
  const tileIdAt = (mx, my) => ((mx * 73856093) ^ (my * 19349663)) >>> 0;
  function makeRectLayer() {
    return { rects: [], addRect(_t, u, _v, x, y) { this.rects.push({ id: u, x, y }); } };
  }
  function makeZLayer() {
    const rect = makeRectLayer();
    return { rect, position: { x: 0, y: 0 }, children: [{ children: [rect] }], clear() { rect.rects.length = 0; } };
  }
  function defineTf(Cls) {
    Cls.prototype._drawTile = function (layer, id, dx, dy) { layer.addRect(0, id, 0, dx, dy, TW, TW); };
    // Same index/offset scheme as TF_LayeredMap's _paintTiles (wall tiles go to billboards y, y+1, y+2)
    Cls.prototype._paintTiles = function( startX, startY, x, y ) {
      const mx = startX + x;
      const my = startY + y;
      const dx = x * this._tileWidth;
      const dy = y * this._tileHeight;
      const tileId = tileIdAt( mx, my );
      const lowerLayer = this.lowerLayer.children[ 0 ];
      if( tileId % 5 === 0 ) {
        const k = tileId % 3;
        if( k === 1 ) {
          this._drawTile( this.TF_billboards[ y + 1 ].children[ 0 ].children[ 0 ], tileId, dx, -this._tileHeight * 2 );
        } else if( k === 2 ) {
          this._drawTile( this.TF_billboards[ y + 2 ].children[ 0 ].children[ 0 ], tileId, dx, -this._tileHeight * 3 );
        } else {
          this._drawTile( this.TF_billboards[ y ].children[ 0 ].children[ 0 ], tileId, dx, -this._tileHeight );
        }
      } else {
        this._drawTile( lowerLayer, tileId, dx, dy );
      }
    };
    const stockPaintAll = function (startX, startY) {
      this.lowerZLayer.clear();
      this.upperZLayer.clear();
      var tileCols = Math.ceil(this._width / this._tileWidth) + 1;
      var tileRows = Math.ceil(this._height / this._tileHeight) + 1;
      for (var y = 0; y < tileRows; y++) {
        for (var x = 0; x < tileCols; x++) {
          this._paintTiles(startX, startY, x, y);
        }
      }
    };
    // TF wrapper: clear billboards, then the stock full paint
    Cls.prototype._paintAllTiles = function( startX, startY ) {
      for( let curItem of this.TF_billboards ) {
        curItem.clear();
      }
      stockPaintAll.apply( this, arguments );
    };
    // TF positions billboard i at world row startY + i + 1
    Cls.prototype._updateLayerPositions = function (startX, startY) {
      const ox = Math.floor(this.origin.x);
      const oy = Math.floor(this.origin.y);
      this.lowerZLayer.position.x = startX * this._tileWidth - ox;
      this.lowerZLayer.position.y = startY * this._tileHeight - oy;
      for (let i = 0; i < this.TF_billboards.length; i++) {
        this.TF_billboards[i].position.x = startX * this._tileWidth - ox;
        this.TF_billboards[i].position.y = startY * this._tileHeight - oy + (i + 1) * this._tileHeight;
      }
    };
    Cls.prototype.updateTransform = function () {
      if (this.roundPixels) {
        var ox = Math.floor(this.origin.x);
        var oy = Math.floor(this.origin.y);
      } else {
        ox = this.origin.x;
        oy = this.origin.y;
      }
      var startX = Math.floor((ox - this._margin) / this._tileWidth);
      var startY = Math.floor((oy - this._margin) / this._tileHeight);
      this._updateLayerPositions(startX, startY);
      if (this._needsRepaint || this._lastStartX !== startX || this._lastStartY !== startY) {
        this._lastStartX = startX;
        this._lastStartY = startY;
        this._paintAllTiles(startX, startY);
        this._needsRepaint = false;
      }
      this._sortChildren();
    };
    Cls.prototype._sortChildren = function () {};
  }
  function initTf(t) {
    t.origin = { x: 0, y: 0 };
    t.roundPixels = true;
    t._margin = 20;
    t._tileWidth = TW;
    t._tileHeight = TW;
    t._width = 1280 + 40;
    t._height = 720 + 40;
    t._needsRepaint = true;
    t.lowerRect = makeRectLayer();
    t.lowerLayer = { children: [t.lowerRect] };
    t.upperLayer = { children: [makeRectLayer()] };
    t.lowerZLayer = { position: { x: 0, y: 0 }, clear: () => { t.lowerRect.rects.length = 0; } };
    t.upperZLayer = { position: { x: 0, y: 0 }, clear() {} };
    t.TF_billboards = [];
    for (let i = 0; i < Math.ceil(t._height / TW) + 3; i++) t.TF_billboards.push(makeZLayer());
  }
  function ShaderTilemap() { initTf(this); }
  defineTf(ShaderTilemap);
  function RefTilemap() { initTf(this); }
  defineTf(RefTilemap);
  function MockContainer() {}
  MockContainer.prototype.updateTransform = function () {};
  mod.installMvCompat(
    { Graphics: { width: 1280, height: 720, frameCount: 0 }, PIXI: { Container: MockContainer }, ShaderTilemap },
    { isDirectGpu: () => true, getWebGLContext: () => null },
    {},
  );
  assert.equal(ShaderTilemap.prototype.__drIncPaint, true, 'TF_LayeredMap tilemaps get incremental painting');

  // Everything visible in the view window: map-layer tiles and, per billboard world row, wall tiles
  const visible = (t) => {
    const ox = Math.floor(t.origin.x);
    const oy = Math.floor(t.origin.y);
    const startX = Math.floor((ox - t._margin) / TW);
    const startY = Math.floor((oy - t._margin) / TW);
    const cols = Math.ceil(t._width / TW) + 1;
    const rows = Math.ceil(t._height / TW) + 1;
    const inView = (ax, ay) => ax >= startX * TW && ax < (startX + cols) * TW && ay >= startY * TW && ay < (startY + rows) * TW;
    const out = [];
    for (const r of t.lowerRect.rects) {
      const ax = t.lowerZLayer.position.x + r.x + ox;
      const ay = t.lowerZLayer.position.y + r.y + oy;
      if (inView(ax, ay)) out.push(`L${r.id}@${ax},${ay}`);
    }
    for (const b of t.TF_billboards) {
      const W = Math.round((b.position.y + oy) / TW);
      if (W < startY + 3 || W > startY + rows) continue; // rows TF itself paints completely
      for (const r of b.rect.rects) {
        const ax = b.position.x + r.x + ox;
        const ay = b.position.y + r.y + oy;
        if (inView(ax, ay)) out.push(`B${W}:${r.id}@${ax},${ay}`);
      }
    }
    return out.sort();
  };
  const ours = new ShaderTilemap();
  const ref = new RefTilemap();
  const path = [[0, 0], [48, 0], [96, 0], [96, 48], [96, 96], [48, 96], [0, 48], [-48, 0], [-48, -48],
    [0, 0], [24, 30], [72, 75], [120, 125], [48 * 29 * 6, 0], [48 * 29 * 6 + 48, 48]];
  for (const [x, y] of path) {
    ours.origin.x = ref.origin.x = x;
    ours.origin.y = ref.origin.y = y;
    ours.updateTransform();
    ref.updateTransform();
    const a = visible(ours);
    const b = visible(ref);
    assert.ok(a.length > 100);
    assert.ok(a.filter((e) => e[0] === 'B').length > 20, 'billboard wall tiles are part of the comparison');
    assert.deepEqual(a, b, `view at origin ${x},${y} must match TF's full repaint`);
  }
  console.log('[PASS] TF_LayeredMap-compatible incremental tilemap painting matches full repaints');
}

// WOLF RPG Editor game discovery & save counting (e.g. Purgatory)
{
  const wolfSw = createMockSwitch({
    'sdmc:/switch/SW2RPGMGL/engines/wolf-engine-switch2.nro': 'NRO',
    'sdmc:/switch/SW2RPGMGL/games/Purgatory/Data.wolf': 'DX_WOLF_210',
    'sdmc:/switch/SW2RPGMGL/games/Purgatory/Game.exe': 'MZ',
    'sdmc:/switch/SW2RPGMGL/games/Purgatory/Game.ini': '[Game]\r\nSoftModeFlag=1\r\n',
    'sdmc:/switch/SW2RPGMGL/games/Purgatory/Save/SaveData1.sav': 's1',
    'sdmc:/switch/SW2RPGMGL/games/Purgatory/Save/SaveData2.sav': 's2',
    'sdmc:/switch/SW2RPGMGL/games/Purgatory/Save/SysSaveData.sav': 'sys',
    'sdmc:/switch/SW2RPGMGL/games/UnpackedWolf/Data/BasicData/Game.dat': 'DAT',
  });
  const wolfFound = mod.discoverGames(wolfSw, 'sdmc:/switch/SW2RPGMGL');
  assert.equal(wolfFound.length, 2);
  assert.equal(wolfFound[0].title, 'Purgatory');
  assert.equal(wolfFound[0].engine, 'wolf');
  assert.equal(wolfFound[0].encrypted, true);
  assert.equal(wolfFound[0].saveCount, 2);
  assert.equal(mod.engineBadgeLabel(wolfFound[0].engine), 'WOLF');
  assert.equal(wolfFound[1].title, 'UnpackedWolf');
  assert.equal(wolfFound[1].engine, 'wolf');
  assert.equal(wolfFound[1].encrypted, false);
  assert.equal(
    mod.findWolfNroPath(wolfSw, 'sdmc:/switch/SW2RPGMGL'),
    'sdmc:/switch/SW2RPGMGL/engines/wolf-engine-switch2.nro',
  );
  console.log('[PASS] WOLF RPG Editor discovery (Data.wolf & unpacked BasicData, non-RGSS Game.ini, Save/*.sav count)');
}

// MV Performance & GPU Fast-Path Verification (Spine WebGL2 detection, TDDP_FluidTimestep / MV 1.6.0
// universal timestep cap, O(1) spatial event grid, zero-alloc Typed-Array A* pathfinding, WebAudio
// decoded SE LRU cache, Bitmap.measureTextWidth memoization, Sprite flash quantization & save slot cache)
{
  // 1. Spine WebGL2 detection (Nightmare Knight) + Live2D (Lilialette's Hustle) + PixiJS v5 (Ambrosia)
  assert.equal(
    mod.detectMvWebGLReason('var $plugins = [{"name":"PictureSpine","status":true}];', null, null),
    'Spine',
  );
  assert.equal(
    mod.detectMvWebGLReason('var $plugins = [{"name":"enc_lv2d","status":true}];', null, null),
    'Live2D',
  );
  assert.equal(
    mod.detectMvWebGLReason('var $plugins = [{"name":"PictureSpine","status":false}];', null, null),
    null,
  );

  // 2. Universal timestep stabilizer on MV <= 1.6.0 + TDDP_FluidTimestep (no _deltaTime, uses _dt / getTimeInMs)
  let mockNow = 1000;
  let updateSceneCalls = 0;
  let renderSceneCalls = 0;
  let measureCalls = 0;
  let tintExecCalls = 0;

  function MockSprite() {
    this._blendColor = [0, 0, 0, 0];
    this._colorTone = [0, 0, 0, 0];
    this._bitmap = { _image: { width: 96, height: 96 }, baseTexture: { scaleMode: 0 } };
    this._canvas = { width: 96, height: 96 };
    this._context = {
      globalCompositeOperation: 'source-over',
      globalAlpha: 1,
      fillStyle: '#000',
      drawImage() {},
      fillRect() {},
    };
    this.anchor = { x: 0, y: 0 };
    this.scale = { x: 1, y: 1 };
    this.children = [];
  }
  MockSprite.prototype.addChild = function (c) { c.parent = this; this.children.push(c); };
  MockSprite.prototype.removeChild = function (c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parent = null;
  };
  MockSprite.prototype._refresh = function () {
    this._createTinter(96, 96);
    this._executeTint(0, 0, 96, 96);
  };
  MockSprite.prototype._createTinter = function (w, h) {
    if (!this._canvas) { this._canvas = { width: w, height: h }; }
    this._canvas.width = w;
    this._canvas.height = h;
    this._tintTexture = { width: w, height: h, scaleMode: 0 };
  };
  MockSprite.prototype._executeTint = function (x, y, w, h) {
    const context = this._context;
    context.drawImage(this._bitmap._image, x, y, w, h, 0, 0, w, h);
  };
  MockSprite.prototype.setBlendColor = function (color) {
    if (!(color instanceof Array)) throw new Error('Argument must be an array');
    if (this._blendColor.some((v, idx) => v !== color[idx])) {
      this._blendColor = color.slice();
      this._refresh();
    }
  };

  function MockBitmap() {
    this.fontFace = 'GameFont';
    this.fontSize = 28;
    this.fontItalic = false;
  }
  MockBitmap.prototype.measureTextWidth = function (text) {
    measureCalls++;
    return String(text).length * 14;
  };

  function MockGameCharacterBase() {}
  MockGameCharacterBase.prototype.pos = function (x, y) { return this._x === x && this._y === y; };
  MockGameCharacterBase.prototype.posNt = function (x, y) { return this.pos(x, y) && !this.isThrough(); };
  MockGameCharacterBase.prototype.setPosition = function (x, y) { this._x = x; this._y = y; };
  MockGameCharacterBase.prototype.moveStraight = function (d) {
    if (d === 4) this._x--;
    else if (d === 6) this._x++;
    else if (d === 8) this._y--;
    else if (d === 2) this._y++;
  };

  function MockGameCharacter() {}
  MockGameCharacter.prototype = Object.create(MockGameCharacterBase.prototype);
  MockGameCharacter.prototype.searchLimit = function () { return 12; };
  // Stock MV reference A* implementation to test exact equivalence before and after installMvCompat
  const stockFindDirectionTo = function (goalX, goalY) {
    const searchLimit = this.searchLimit();
    const mapWidth = perfRt.$gameMap.width();
    const nodeList = [];
    const openList = [];
    const closedList = [];
    const start = {};
    let best = start;
    if (this.x === goalX && this.y === goalY) return 0;
    start.parent = null;
    start.x = this.x;
    start.y = this.y;
    start.g = 0;
    start.f = perfRt.$gameMap.distance(start.x, start.y, goalX, goalY);
    nodeList.push(start);
    openList.push(start.y * mapWidth + start.x);
    while (openList.length > 0) {
      let bestIndex = 0;
      for (let i = 0; i < openList.length; i++) {
        if (nodeList[i].f < nodeList[bestIndex].f) bestIndex = i;
      }
      const current = nodeList[bestIndex];
      const x1 = current.x;
      const y1 = current.y;
      const pos1 = y1 * mapWidth + x1;
      const g1 = current.g;
      nodeList.splice(bestIndex, 1);
      openList.splice(bestIndex, 1);
      closedList.push(pos1);
      if (current.x === goalX && current.y === goalY) { best = current; break; }
      if (g1 >= searchLimit) continue;
      for (let j = 0; j < 4; j++) {
        const direction = 2 + j * 2;
        const x2 = perfRt.$gameMap.roundXWithDirection(x1, direction);
        const y2 = perfRt.$gameMap.roundYWithDirection(y1, direction);
        const pos2 = y2 * mapWidth + x2;
        if (closedList.includes(pos2)) continue;
        if (!this.canPass(x1, y1, direction)) continue;
        const g2 = g1 + 1;
        const index2 = openList.indexOf(pos2);
        if (index2 < 0 || g2 < nodeList[index2].g) {
          let neighbor;
          if (index2 >= 0) neighbor = nodeList[index2];
          else { neighbor = {}; nodeList.push(neighbor); openList.push(pos2); }
          neighbor.parent = current;
          neighbor.x = x2;
          neighbor.y = y2;
          neighbor.g = g2;
          neighbor.f = g2 + perfRt.$gameMap.distance(x2, y2, goalX, goalY);
          if (!best || neighbor.f - neighbor.g < best.f - best.g) best = neighbor;
        }
      }
    }
    let node = best;
    while (node.parent && node.parent !== start) node = node.parent;
    const deltaX1 = perfRt.$gameMap.deltaX(node.x, start.x);
    const deltaY1 = perfRt.$gameMap.deltaY(node.y, start.y);
    if (deltaY1 > 0) return 2;
    if (deltaX1 < 0) return 4;
    if (deltaX1 > 0) return 6;
    if (deltaY1 < 0) return 8;
    const deltaX2 = this.deltaXFrom(goalX);
    const deltaY2 = this.deltaYFrom(goalY);
    if (Math.abs(deltaX2) > Math.abs(deltaY2)) return deltaX2 > 0 ? 4 : 6;
    if (deltaY2 !== 0) return deltaY2 > 0 ? 8 : 2;
    return 0;
  };
  MockGameCharacter.prototype.findDirectionTo = stockFindDirectionTo;

  function MockGameMap() {
    this._mapId = 1;
    this._events = [];
  }
  MockGameMap.prototype.width = function () { return 20; };
  MockGameMap.prototype.height = function () { return 15; };
  MockGameMap.prototype.events = function () { return this._events.filter((e) => !!e); };
  MockGameMap.prototype.eventsXy = function (x, y) { return this.events().filter((event) => event.pos(x, y)); };
  MockGameMap.prototype.eventsXyNt = function (x, y) { return this.events().filter((event) => event.posNt(x, y)); };
  MockGameMap.prototype.roundXWithDirection = function (x, d) { return x + (d === 6 ? 1 : d === 4 ? -1 : 0); };
  MockGameMap.prototype.roundYWithDirection = function (y, d) { return y + (d === 2 ? 1 : d === 8 ? -1 : 0); };
  MockGameMap.prototype.deltaX = function (x1, x2) { return x1 - x2; };
  MockGameMap.prototype.deltaY = function (y1, y2) { return y1 - y2; };
  MockGameMap.prototype.distance = function (x1, y1, x2, y2) { return Math.abs(x1 - x2) + Math.abs(y1 - y2); };

  let decodeCalls = 0;
  function MockWebAudio(url) {
    this._url = url;
    this._loadListeners = [];
    this._load(url);
  }
  MockWebAudio._context = {
    decodeAudioData(_arr, ok) {
      decodeCalls++;
      ok({ duration: 0.4, numberOfChannels: 2, length: 17640 });
    },
  };
  MockWebAudio.prototype._load = function (url) {
    const xhr = new globalThis.XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => { this._onXhrLoad(xhr); };
    xhr.send();
  };
  MockWebAudio.prototype._onXhrLoad = function (xhr) {
    MockWebAudio._context.decodeAudioData(xhr.response, (buf) => {
      this._buffer = buf;
      this._onLoad();
    });
  };
  MockWebAudio.prototype._onLoad = function () {
    while (this._loadListeners.length > 0) this._loadListeners.shift()();
  };

  const perfSw = createMockSwitch({
    'sdmc:/perf/www/audio/se/Step1.ogg': new Uint8Array([0x4f, 0x67, 0x67, 0x53]).buffer,
  });
  const perfAssets = mod.createAssetReader('sdmc:/perf/www', perfSw);
  const perfHost = mod.createBrowserHost(perfAssets, (p, s) => s, fakeScreen, { gameTitle: 'PerfTest' });

  const perfRt = {
    document: globalThis.document,
    Graphics: { width: 816, height: 624, frameCount: 1 },
    Utils: {},
    Decrypter: { hasEncryptedAudio: false },
    WebAudio: MockWebAudio,
    Bitmap: MockBitmap,
    Sprite: MockSprite,
    Game_CharacterBase: MockGameCharacterBase,
    Game_Character: MockGameCharacter,
    Game_Map: MockGameMap,
    SceneManager: {
      // Simulate Fear & Hunger (MV 1.6.0 + TDDP_FluidTimestep): NO _deltaTime, only _dt = 1/60 & getTimeInMs!
      _dt: 1 / 60,
      _t: 0,
      _accumulator: 0,
      _currentTime: 1000,
      getTimeInMs: () => mockNow,
      isSceneChanging: () => false,
      updateInputData() {},
      changeScene() {},
      updateScene() { updateSceneCalls++; },
      renderScene() { renderSceneCalls++; },
      requestUpdate() {},
      updateMain() { throw new Error('Legacy unguarded updateMain should have been replaced!'); },
    },
  };
  const gMap = new MockGameMap();
  perfRt.$gameMap = gMap;
  for (let i = 1; i <= 40; i++) {
    const ev = Object.create(MockGameCharacterBase.prototype);
    ev._x = i % 10;
    ev._y = Math.floor(i / 10);
    ev.isThrough = () => (i % 2 === 0);
    gMap._events[i] = ev;
  }

  mod.installMvCompat(perfRt, perfHost);

  // Verify 200ms frame spike on TDDP_FluidTimestep caps at max 2 update ticks (never 12 ticks!)
  mockNow = 1200;
  perfRt.SceneManager.updateMain();
  assert.equal(updateSceneCalls, 2, `Expected 2 capped ticks on 200ms spike, got ${updateSceneCalls}`);
  assert.equal(renderSceneCalls, 1);
  assert.ok(perfRt.SceneManager._t > 0.03, 'TDDP_FluidTimestep _t must advance');

  // Verify VSync phase-lock at 16.0ms (within 2.5ms of 16.667ms) executes 1 steady tick
  mockNow += 16;
  perfRt.SceneManager.updateMain();
  assert.equal(updateSceneCalls, 3);

  // Verify O(1) spatial grid + mid-tick move invalidation
  assert.equal(gMap.eventsXy(3, 1).length, 1);
  assert.equal(gMap.eventsXyNt(3, 1).length, 1); // i=13 -> odd -> not through
  assert.equal(gMap.eventsXyNt(2, 1).length, 0); // i=12 -> even -> through
  gMap._events[13].moveStraight(6); // moves (3,1) -> (4,1) mid-frame!
  assert.equal(gMap.eventsXy(3, 1).length, 0);
  assert.equal(gMap.eventsXy(4, 1).length, 2);

  // Verify zero-alloc Typed-Array A* matches stock MV A* around obstacles on every start/goal pair
  const walls = new Set(['5,4', '5,5', '5,6', '4,6', '6,4']);
  const chTest = Object.create(MockGameCharacter.prototype);
  chTest.canPass = (x, y, d) => {
    const nx = gMap.roundXWithDirection(x, d);
    const ny = gMap.roundYWithDirection(y, d);
    if (nx < 0 || nx >= 20 || ny < 0 || ny >= 15) return false;
    return !walls.has(`${nx},${ny}`);
  };
  chTest.deltaXFrom = function (gx) { return this.x - gx; };
  chTest.deltaYFrom = function (gy) { return this.y - gy; };
  for (const [sx, sy, gx, gy] of [[2, 5, 8, 5], [5, 3, 5, 7], [7, 7, 3, 3], [5, 5, 5, 5], [1, 1, 18, 13]]) {
    chTest.x = sx; chTest.y = sy;
    const fastDir = chTest.findDirectionTo(gx, gy);
    const refDir = stockFindDirectionTo.call(chTest, gx, gy);
    assert.equal(fastDir, refDir, `A* mismatch for (${sx},${sy})->(${gx},${gy}): fast=${fastDir} vs stock=${refDir}`);
  }

  // Verify Bitmap.measureTextWidth memoization
  const bmp = new MockBitmap();
  assert.equal(bmp.measureTextWidth('Attack'), 84);
  assert.equal(bmp.measureTextWidth('Attack'), 84);
  assert.equal(bmp.measureTextWidth('Attack'), 84);
  assert.equal(measureCalls, 1, 'Repeated measureTextWidth calls must hit JS cache');

  // Verify Sprite flash alpha quantization & _executeTint memoization
  const sp = new MockSprite();
  const origDraw = sp._context.drawImage;
  sp._context.drawImage = () => { tintExecCalls++; origDraw(); };
  for (let a = 255; a >= 0; a -= 4) {
    sp.setBlendColor([255, 255, 255, a]);
  }
  // 64 alpha updates (each _executeTint draws twice) would be 128 drawImage calls unoptimized; quantized <= 36!
  assert.ok(tintExecCalls <= 36, `Expected quantized flash tint draws <= 36, got ${tintExecCalls}`);
  assert.deepEqual(sp._blendColor, [255, 255, 255, 0]);

  // Verify WebAudio decoded SE cache (2nd load hits cache with 0 decodeAudioData calls!)
  const se1 = new MockWebAudio('audio/se/Step1.ogg');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(se1._buffer, 'First SE should decode');
  assert.equal(decodeCalls, 1);
  const se2 = new MockWebAudio('audio/se/Step1.ogg');
  assert.equal(se2._buffer, se1._buffer, 'Cached SE must be ready synchronously on 2nd play');
  assert.equal(decodeCalls, 1, 'Cached SE must not re-run decodeAudioData');

  // Verify PixiJS v4 WebGL2 Bitmap.snap passes positional (w, h) to PIXI.RenderTexture.create (Nightmare Knight fix!)
  {
    let rtArgs = null;
    let extractCalls = 0;
    let canvasUpdates = 0;
    const ctxDraws = [];
    function NkBitmap(w, h) {
      this.width = w;
      this.height = h;
      this._dirty = false;
      this._baseTexture = { width: w, height: h, update() { canvasUpdates++; } };
      this._context = {
        save() {}, restore() {},
        drawImage(src) { ctxDraws.push(src); },
        fillRect() { ctxDraws.push('fillRect'); },
      };
    }
    // PixiJS v4 MV: Bitmap#checkDirty uploads the canvas via baseTexture.update()
    NkBitmap.prototype._setDirty = function () { this._dirty = true; };
    NkBitmap.prototype.checkDirty = function () {
      if (this._dirty) {
        this._baseTexture.update();
        this._dirty = false;
      }
    };
    Object.defineProperty(NkBitmap.prototype, 'baseTexture', {
      configurable: true,
      get() { return this._baseTexture; },
    });
    NkBitmap.snap = () => { throw new Error('Should use WebGL zero-copy RenderTexture path!'); };

    let glBufDataCalls = 0;
    let glBufSubDataCalls = 0;
    let nextBufId = 1;
    const mockGlScreen = {
      width: 1280,
      height: 720,
      getContext(type) {
        if (type !== 'webgl2') return null;
        return {
          ARRAY_BUFFER: 0x8892,
          ELEMENT_ARRAY_BUFFER: 0x8893,
          FRAMEBUFFER: 0x8d40,
          DRAW_FRAMEBUFFER: 0x8ca9,
          SCISSOR_TEST: 0x0c11,
          COLOR_BUFFER_BIT: 0x4000,
          DEPTH_BUFFER_BIT: 0x0100,
          STENCIL_BUFFER_BIT: 0x0400,
          drawingBufferWidth: 1280,
          drawingBufferHeight: 720,
          createBuffer() { return { id: nextBufId++ }; },
          deleteBuffer() {},
          bindBuffer() {},
          bufferData() { glBufDataCalls++; },
          bufferSubData() { glBufSubDataCalls++; },
          bindFramebuffer() {},
          viewport() {},
          scissor() {},
          enable() {},
          disable() {},
          clearColor() {},
          clear() {},
          texImage2D() {},
          texSubImage2D() {},
          getError() { return 0; },
          TEXTURE_2D: 0x0de1,
          TEXTURE0: 0x84c0,
          activeTexture() {},
          bindTexture() {},
          useProgram() {},
        };
      },
    };
    const nkHost = mod.createBrowserHost(perfAssets, (p, s) => s, mockGlScreen, {
      gameTitle: 'NightmareKnight',
      enableWebGL: true,
    });
    const gl = nkHost.ensureWebGLContext();

    // Also include a mock Live2DCubismFramework.CubismRenderer_WebGL to test per-drawable VBO pooling!
    function MockCubismRenderer() {
      this.gl = gl;
      this._bufferData = { vertex: null, uv: null, index: null };
    }
    MockCubismRenderer.prototype.drawMesh = function (_t, _ic, _vc, idxArr, vertArr, uvArr) {
      if (!this._bufferData.vertex) this._bufferData.vertex = this.gl.createBuffer();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this._bufferData.vertex);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, vertArr, 0x88e8);
      if (!this._bufferData.uv) this._bufferData.uv = this.gl.createBuffer();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this._bufferData.uv);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, uvArr, 0x88e8);
      if (!this._bufferData.index) this._bufferData.index = this.gl.createBuffer();
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this._bufferData.index);
      this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, idxArr, 0x88e8);
    };

    // Minimal PIXI v4 WebGLRenderer for the sprite-batch slot resync (Live2D white boxes)
    const glTexWindow = { name: 'windowBack' };
    const texWindow = { _glTextures: { 0: { texture: glTexWindow } } };
    const emptyTex = [{ empty: 0 }, { empty: 1 }];
    const pixiProgram = { name: 'pixiSprite' };
    let spriteFlushes = 0;
    const nkRenderer = {
      gl,
      type: 1,
      CONTEXT_UID: 0,
      boundTextures: [texWindow, emptyTex[1]],
      emptyTextures: emptyTex,
      _activeShader: { program: pixiProgram },
      state: { activeState: [1, 0, 0, 0, 0] },
      bindShader() {},
      bindTexture() {},
      plugins: { sprite: { flush() { spriteFlushes++; } } },
    };
    let coreUpdates = 0;
    function MockCubismModel() {}
    MockCubismModel.prototype.update = function () { coreUpdates++; };

    const nkRt = {
      document: globalThis.document,
      Graphics: {
        width: 1280,
        height: 720,
        frameCount: 10,
        _createRenderer() { this._renderer = nkRenderer; },
        _renderer: {
          render() {},
          extract: { canvas() { extractCalls++; return { width: 1280, height: 720, tag: 'rt-pixels' }; } },
        },
      },
      PIXI: {
        VERSION: '4.5.4', // PixiJS v4: RenderTexture.create(width, height) requires numbers, NOT { width, height }!
        RenderTexture: {
          create(w, h) {
            rtArgs = [w, h];
            assert.equal(typeof w, 'number', 'PixiJS v4 RenderTexture.create first arg must be numeric width!');
            assert.equal(typeof h, 'number', 'PixiJS v4 RenderTexture.create second arg must be numeric height!');
            return {
              baseTexture: {
                width: w,
                height: h,
                destroyed: false,
                source: null,
                // Real PixiJS v4 BaseRenderTexture has no image source: update() reads source.naturalWidth
                update() { return this.source.naturalWidth; },
              },
              destroy() {},
            };
          },
        },
      },
      Bitmap: NkBitmap,
      SceneManager: {},
      Live2DCubismFramework: { CubismRenderer_WebGL: MockCubismRenderer, CubismModel: MockCubismModel },
    };

    mod.installMvCompat(nkRt, nkHost, { live2dUpdateRate: 'half' });

    const snapped = NkBitmap.snap({ children: [] });
    assert.deepEqual(rtArgs, [1280, 720]);
    assert.equal(snapped.baseTexture.width, 1280);
    assert.equal(snapped.baseTexture.height, 720);

    // Dirty flag on the GPU-backed snapshot must not reach RenderTexture.baseTexture.update()
    // (crashed Nightmare Knight on Continue / New Game and Lilialette's ring menu)
    snapped._setDirty();
    assert.doesNotThrow(() => snapped.checkDirty());
    assert.equal(extractCalls, 0, 'zero-copy snapshot must not read back until drawn on');
    // A plugin drawing on the snapshot converts it into a normal canvas bitmap holding the scene pixels
    snapped._context.fillRect(0, 0, 10, 10);
    assert.equal(extractCalls, 1);
    assert.equal(ctxDraws[0].tag, 'rt-pixels', 'scene pixels copied into the canvas before the game draws');
    assert.equal(ctxDraws[1], 'fillRect');
    assert.notEqual(snapped.baseTexture.source, null);
    assert.equal(typeof snapped.baseTexture.update, 'function');
    assert.doesNotThrow(() => snapped.checkDirty());
    assert.ok(canvasUpdates >= 1, 'converted snapshot uploads its canvas texture');
    // The converted bitmap now owns its pixels and is never handed out again as the snapshot target
    const snapped2 = NkBitmap.snap({ children: [] });
    assert.notEqual(snapped2, snapped);

    // Live2D 'half' rate: Cubism Core deforms each model on every other presented frame
    const l2dModel = new MockCubismModel();
    for (let f = 1; f <= 6; f++) {
      nkRt.__drRenderFrame = f;
      l2dModel.update();
    }
    assert.equal(coreUpdates, 3, 'half rate runs csmUpdateModel on frames 1, 3, 5');
    nkRt.__drRenderFrame = 6;
    l2dModel.update(); // a second call in a frame that skipped still skips (no catch-up burst)
    assert.equal(coreUpdates, 3);
    nkRt.__drRenderFrame = 7;
    l2dModel.update();
    l2dModel.update(); // repeated call within an updated frame still runs
    assert.equal(coreUpdates, 5);
    const otherModel = new MockCubismModel();
    nkRt.__drRenderFrame = 8;
    otherModel.update(); // a model's first update always runs
    assert.equal(coreUpdates, 6);

    // Sprite batch flush resyncs PIXI's cached texture slots after a foreign (Live2D) GL draw
    nkRt.Graphics._createRenderer();
    assert.equal(nkRenderer.plugins.sprite.__drSlotSync, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glTexWindow);
    gl.useProgram(pixiProgram);
    nkRenderer.plugins.sprite.flush();
    assert.equal(nkRenderer.boundTextures[0], texWindow, 'still bound -> cache kept');
    assert.equal(nkRenderer.state.activeState[4], 0, 'PIXI program still active -> blend cache kept');
    gl.bindTexture(gl.TEXTURE_2D, { name: 'live2dAtlas' }); // Live2D Cubism draws with its own texture...
    gl.useProgram({ name: 'cubismProgram' }); // ...and program
    nkRenderer.plugins.sprite.flush();
    assert.equal(nkRenderer.boundTextures[0], emptyTex[0], 'stale slot dropped so PIXI rebinds the window texture');
    assert.equal(nkRenderer.state.activeState[4], -1, 'blend func cache invalidated after foreign GL program');
    assert.equal(spriteFlushes, 2);

    // Quick Menu "Log On-Screen Objects" walks the scene graph without throwing
    const bigBounds = { x: 0, y: 400, width: 816, height: 224 };
    function Window_Message() {}
    const fakeWin = Object.assign(new Window_Message(), {
      visible: true, worldAlpha: 1, alpha: 1, renderable: true, opacity: 255, backOpacity: 192,
      contentsOpacity: 255, openness: 255, _windowskin: { _url: 'img/system/Window.png' },
      getBounds: () => bigBounds, children: [],
    });
    nkRt.SceneManager._scene = {
      constructor: { name: 'Scene_Map' }, visible: true, worldAlpha: 1, alpha: 1,
      getBounds: () => ({ x: 0, y: 0, width: 816, height: 624 }),
      children: [fakeWin, { visible: false, worldAlpha: 1, children: [] }],
    };
    assert.equal(typeof nkRt.__drDumpScene, 'function');
    assert.doesNotThrow(() => nkRt.__drDumpScene());

    // Test Live2D per-drawable VBO pool across 2 frames:
    // Frame 1: allocates vertex + uv + index once (3 bufferData calls).
    // Frame 2: 0 bufferData calls, 0 uv/index uploads, and only 1 bufferSubData call (even if drawn twice in mask + color pass!).
    const cubism = new MockCubismRenderer();
    const wasmHeap = new ArrayBuffer(1024);
    const idxView = new Uint16Array(wasmHeap, 64, 6);
    const vertView = new Float32Array(wasmHeap, 128, 8);
    const uvView = new Float32Array(wasmHeap, 256, 8);
    nkHost.beginFrame();
    cubism.drawMesh(0, 6, 4, idxView, vertView, uvView, 1, 0, false);
    assert.equal(glBufDataCalls, 3, 'Frame 1 must initialize vertex, uv, and index buffers once');
    assert.equal(glBufSubDataCalls, 0);

    nkHost.beginFrame();
    // Simulate mask pass + color pass of the same drawable in Frame 2:
    cubism.drawMesh(0, 6, 4, idxView, vertView, uvView, 1, 0, false);
    cubism.drawMesh(0, 6, 4, idxView, vertView, uvView, 1, 0, false);
    assert.equal(glBufDataCalls, 3, 'Frame 2 must make ZERO gl.bufferData re-allocations!');
    assert.equal(glBufSubDataCalls, 1, 'Frame 2 must update vertex VBO once via bufferSubData and skip static uv/index!');
  }

  // Verify YEP_X_MoreQuests malformed separator guard & Live2D string-table constant folder in createScriptPreparer
  {
    const prep = mod.createScriptPreparer();
    const questSafe = prep(
      'js/plugins/YEP_X_MoreQuests1.js',
      "DataManager.questDatabaseCreate = function() { var i = 101; var questData = JSON.parse(Yanfly.Parameters['Quest ' + i] || 'null'); return questData; };",
    );
    const qCtx = { DataManager: {}, Yanfly: { Parameters: { 'Quest 101': '---Separator---' } } };
    new Function('DataManager', 'Yanfly', questSafe)(qCtx.DataManager, qCtx.Yanfly);
    assert.equal(qCtx.DataManager.questDatabaseCreate(), null, 'Malformed separator in Quest parameter must safely return null');
  }

  // Verify OMORI YED_Tiled (`TiledTilemap extends ShaderTilemap` without `lowerZLayer`/`upperZLayer`)
  // delegates cleanly to stock `ShaderTilemap.prototype.updateTransform` while stock `ShaderTilemap` still uses incremental paint
  {
    let stockPaintCalls = 0;
    let tiledPaintCalls = 0;
    let tiledPosCalls = 0;
    function MockContainer() {}
    MockContainer.prototype.updateTransform = function () {};
    function MockShaderTilemap() {
      this.roundPixels = true;
      this.origin = { x: 0, y: 0 };
      this._margin = 20;
      this._tileWidth = 32;
      this._tileHeight = 32;
      this._width = 640;
      this._height = 480;
      this._needsRepaint = true;
      this.lowerZLayer = { position: { x: 0, y: 0 }, clear() {} };
      this.upperZLayer = { position: { x: 0, y: 0 }, clear() {} };
      this.lowerLayer = { children: [] };
      this.upperLayer = { children: [] };
    }
    MockShaderTilemap.prototype = Object.create(MockContainer.prototype);
    MockShaderTilemap.prototype.constructor = MockShaderTilemap;
    MockShaderTilemap.prototype._sortChildren = function () {};
    MockShaderTilemap.prototype._updateLayerPositions = function () {
      this.lowerZLayer.position.x = 0;
      this.upperZLayer.position.y = 0;
    };
    MockShaderTilemap.prototype._paintTiles = function (_sx, _sy, _x, _y) {};
    MockShaderTilemap.prototype._paintAllTiles = function (startX, startY) {
      this.lowerZLayer.clear();
      this.upperZLayer.clear();
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) this._paintTiles(startX, startY, x, y);
      }
      stockPaintCalls++;
    };
    MockShaderTilemap.prototype.updateTransform = function () {
      const ox = this.roundPixels ? Math.floor(this.origin.x) : this.origin.x;
      const oy = this.roundPixels ? Math.floor(this.origin.y) : this.origin.y;
      const startX = Math.floor((ox - this._margin) / this._tileWidth);
      const startY = Math.floor((oy - this._margin) / this._tileHeight);
      this._updateLayerPositions(startX, startY);
      if (this._needsRepaint || this._lastStartX !== startX || this._lastStartY !== startY) {
        this._lastStartX = startX;
        this._lastStartY = startY;
        this._paintAllTiles(startX, startY);
        this._needsRepaint = false;
      }
      this._sortChildren();
      MockContainer.prototype.updateTransform.call(this);
    };

    // Subclass matching OMORI's `YED_Tiled` `TiledTilemap`: inherits `updateTransform`, NO `lowerZLayer`/`upperZLayer`!
    function MockTiledTilemap() {
      this.roundPixels = true;
      this.origin = { x: 0, y: 0 };
      this._margin = 20;
      this._tileWidth = 32;
      this._tileHeight = 32;
      this._width = 640;
      this._height = 480;
      this._needsRepaint = true;
      this._layers = [{ position: { x: 0, y: 0 }, clear() {} }];
    }
    MockTiledTilemap.prototype = Object.create(MockShaderTilemap.prototype);
    MockTiledTilemap.prototype.constructor = MockTiledTilemap;
    MockTiledTilemap.prototype._updateLayerPositions = function () { tiledPosCalls++; };
    MockTiledTilemap.prototype._paintTiles = function (_layer, _sx, _sy) {};
    MockTiledTilemap.prototype._paintAllTiles = function (startX, startY) {
      tiledPaintCalls++;
      for (const l of this._layers) {
        l.clear();
        this._paintTiles(l, startX, startY);
      }
    };

    const tmRt = {
      document: globalThis.document,
      Graphics: { width: 640, height: 480, frameCount: 1 },
      PIXI: { Container: MockContainer },
      ShaderTilemap: MockShaderTilemap,
      SceneManager: {},
    };
    mod.installMvCompat(tmRt, perfHost);
    assert.equal(MockShaderTilemap.prototype.__drIncPaint, true, 'Incremental tilemap painter must install');

    // Stock ShaderTilemap uses incremental paint (scrolling 1 tile does NOT call _paintAllTiles again)
    const stockTm = new MockShaderTilemap();
    stockTm.updateTransform();
    assert.equal(stockPaintCalls, 1);
    stockTm.origin.x = 32;
    stockTm.updateTransform();
    assert.equal(stockPaintCalls, 1, 'Stock ShaderTilemap must scroll incrementally without full repaint');

    // OMORI TiledTilemap subclass runs without crashing on missing lowerZLayer/upperZLayer
    const omoriTiledTm = new MockTiledTilemap();
    assert.doesNotThrow(() => omoriTiledTm.updateTransform());
    assert.equal(tiledPosCalls, 1);
    assert.equal(tiledPaintCalls, 1);
    omoriTiledTm.origin.x = 32;
    assert.doesNotThrow(() => omoriTiledTm.updateTransform());
    assert.equal(tiledPosCalls, 2);
    assert.equal(tiledPaintCalls, 2);
  }

  // Verify OMORI YED_Tiled fast-paths:
  // 1) Sprite_CharacterReflect skips full Sprite_Character.update when reflections.length === 0
  // 2) YED_Tiled updateReflection avoids per-tick Array allocation & caches isHalfTile()
  // 3) O(N) nearly-sorted Tilemap._sortChildren matches stock order without .bind() allocations
  // 4) Direct-to-GPU RectTileLayer.renderCanvas draws directly to renderer.context (no CPU offscreen canvas upload)
  {
    let baseCharUpdates = 0;
    function MockGameEvent() {
      this.reflections = [];
      this._transparent = false;
      this._characterName = 'DW_NPC';
      this._characterIndex = 0;
      this._tileId = 0;
      this._opacity = 255;
      this._blendMode = 0;
      this._realX = 5;
      this._realY = 5;
    }
    function MockSpriteChar(ch) {
      this._character = ch;
      this.visible = true;
      this.children = [];
      this.scale = { x: 1, y: 1 };
    }
    MockSpriteChar.prototype.update = function () {
      baseCharUpdates++;
      this.visible = !this._character._transparent;
    };
    MockSpriteChar.prototype.updateTransform = function () {};

    function MockSpriteCharReflect(ch) {
      MockSpriteChar.call(this, ch);
      this.visible = false;
    }
    MockSpriteCharReflect.prototype = Object.create(MockSpriteChar.prototype);
    MockSpriteCharReflect.prototype.constructor = MockSpriteCharReflect;
    MockSpriteCharReflect.prototype.update = function () {
      MockSpriteChar.prototype.update.call(this);
      this.updateReflect();
    };
    MockSpriteCharReflect.prototype.updateReflect = function () {
      this.visible = this._character.reflections.length > 0;
      const r = this._character.reflections[0];
      if (!r) return;
      this.scale.y = r.reflectionCast > 0 ? -1 : 1;
      this.opacity = r.reflectionOpacity || 255;
    };

    let halfTileLookups = 0;
    function MockCharBase() {
      this._realX = 2;
      this._realY = 3;
      this.reflections = [];
    }
    MockCharBase.prototype.updateReflection = function () {
      if (!omoriRt.$gameMap.isOnReflection(this)) {
        this.reflections = [];
        return;
      }
      this.reflections = omoriRt.$gameMap.getReflections(this);
    };
    function MockYedMap() {
      this._reflection = [];
    }
    MockYedMap.prototype.isTiledMap = () => true;
    MockYedMap.prototype.tileWidth = function () { return this.isHalfTile() ? 16 : 32; };
    MockYedMap.prototype.tileHeight = function () { return this.isHalfTile() ? 16 : 32; };
    MockYedMap.prototype.isHalfTile = function () {
      halfTileLookups++;
      const pluginParams = { 'Half-tile movement': 'false' };
      return pluginParams['Half-tile movement'].toLowerCase() === 'true';
    };

    function MockTilemapSort() {
      this.children = [];
    }
    MockTilemapSort.prototype._sortChildren = function () {
      this.children.sort(this._compareChildOrder.bind(this));
    };
    MockTilemapSort.prototype._compareChildOrder = function (a, b) {
      if (a.z !== b.z) return a.z - b.z;
      else if (a.y !== b.y) return a.y - b.y;
      else return a.spriteId - b.spriteId;
    };

    let rendererBlits = 0;
    function MockRectTileLayer() {
      this.pointsBuf = [];
      this.textures = [{ baseTexture: { source: { width: 256, height: 256 }, width: 256, height: 256, hasLoaded: true } }];
      this.hasAnim = false;
    }
    MockRectTileLayer.prototype.renderCanvas = function (renderer) {
      const points = this.pointsBuf;
      renderer.context.fillStyle = '#000000';
      for (let i = 0; i < points.length; i += 9) {
        renderer.context.drawImage(this.textures[0].baseTexture.source, points[i], points[i + 1], 32, 32, points[i + 2], points[i + 3], 32, 32);
      }
    };

    const yedMap = new MockYedMap();
    const omoriRt = {
      Graphics: { width: 640, height: 480, frameCount: 1 },
      PIXI: { tilemap: { RectTileLayer: MockRectTileLayer } },
      Game_CharacterBase: MockCharBase,
      Game_Event: MockGameEvent,
      Game_Map: MockYedMap,
      Sprite_Character: MockSpriteChar,
      Tilemap: MockTilemapSort,
      $gameMap: yedMap,
      SceneManager: {},
    };
    mod.installMvCompat(omoriRt, { isDirectGpu: () => true, getWebGLContext: () => null }, {});

    // 1) Sprite_CharacterReflect: 1st sprite patches prototype once, then 0 base updates when reflections is empty!
    const ev1 = new MockGameEvent();
    const ev2 = new MockGameEvent();
    const ref1 = new MockSpriteCharReflect(ev1);
    const ref2 = new MockSpriteCharReflect(ev2);
    ref1.update(); // patches MockSpriteCharReflect.prototype.update on 1st call
    assert.equal(baseCharUpdates, 1);
    assert.equal(ref1.visible, false);
    for (let t = 0; t < 10; t++) {
      ref1.update();
      ref2.update();
    }
    assert.equal(baseCharUpdates, 1, 'Inactive Sprite_CharacterReflect sprites must skip Sprite_Character.update');
    // Stepping onto a reflection immediately wakes Sprite_CharacterReflect up
    ev2.reflections = [{ reflectionCast: 1, reflectionOpacity: 180 }];
    ref2.update();
    assert.equal(baseCharUpdates, 2, 'Active reflection must run full Sprite_CharacterReflect update');
    assert.equal(ref2.visible, true);
    assert.equal(ref2.scale.y, -1);
    assert.equal(ref2.opacity, 180);

    // 2) updateReflection reuses shared empty array & caches isHalfTile
    const cb = new MockCharBase();
    cb.updateReflection();
    const emptyRef1 = cb.reflections;
    cb.updateReflection();
    assert.equal(cb.reflections, emptyRef1, 'updateReflection must reuse shared empty array when off reflections');
    yedMap._reflection.push({ rect: { x: 60, y: 90, width: 32, height: 32 }, reflectionCast: 1, reflectionOpacity: 200 });
    cb.updateReflection();
    assert.equal(cb.reflections.length, 1);
    assert.equal(halfTileLookups, 1, 'isHalfTile must cache boolean instead of calling toLowerCase() every query');

    // 3) O(N) Tilemap._sortChildren preserves exact z -> y -> spriteId order
    const tmSort = new MockTilemapSort();
    tmSort.children = [
      { z: 3, y: 200, spriteId: 5 },
      { z: 1, y: 400, spriteId: 2 },
      { z: 3, y: 120, spriteId: 9 },
      { z: 3, y: 120, spriteId: 4 },
    ];
    tmSort._sortChildren();
    assert.deepEqual(
      tmSort.children.map((c) => c.spriteId),
      [2, 4, 9, 5],
      'Tilemap._sortChildren must sort by z, then y, then spriteId',
    );
    // Small single-character y movement uses fast insertion sort
    tmSort.children[3].y = 100;
    tmSort._sortChildren();
    assert.deepEqual(tmSort.children.map((c) => c.spriteId), [2, 5, 4, 9]);

    // 4) Direct-to-GPU RectTileLayer.renderCanvas draws directly to renderer.context without setting fillStyle
    const layer = new MockRectTileLayer();
    for (let i = 0; i < 10; i++) {
      layer.pointsBuf.push(0, 0, i * 32, 0, 32, 32, 0, 0, 0);
    }
    let fillStyleSets = 0;
    const fakeRenderer = {
      plugins: { tilemap: { tileAnim: [0, 0] } },
      context: {
        set fillStyle(_v) { fillStyleSets++; },
        drawImage() { rendererBlits++; },
      },
    };
    layer.renderCanvas(fakeRenderer);
    assert.equal(rendererBlits, 10, 'Direct-to-GPU RectTileLayer must draw tiles directly from cached Image source');
    assert.equal(fillStyleSets, 0, 'Must not set CSS fillStyle on normal textured tile layers');
  }

  // Verify Noel liply_MobileLight (`spriteset._lightMask` half-res + radial gradient cache + throttle)
  // and Node crypto AES-256-GCM (KageDesu PKD Protector 2) & AES-256-CBC round-trips
  {
    const ncTarget = {};
    mod.installNodeCompat(ncTarget, null, 'sdmc:/switch/SW2RPGMGL/games/PKDTest/www', 'sdmc:/switch/SW2RPGMGL/games/PKDTest/save');
    const cMod = ncTarget.require('crypto');
    const nodeCrypto = await import('node:crypto');

    // AES-256-GCM encrypt in real Node crypto -> decrypt in Switch 2 node-compat (PKD Protector 2 / RmmzEncripterTool)
    const gcmKey = nodeCrypto.randomBytes(32);
    const gcmIv = nodeCrypto.randomBytes(12);
    const gcmPlain = Buffer.from('var PKD_ProtectedPlugin = { ok: 42 }; // KageDesu PKD Protector 2 test!', 'utf8');
    const realGcmEnc = nodeCrypto.createCipheriv('aes-256-gcm', gcmKey, gcmIv);
    const gcmCt = Buffer.concat([realGcmEnc.update(gcmPlain), realGcmEnc.final()]);
    const gcmTag = realGcmEnc.getAuthTag();

    const shimGcmDec = cMod.createDecipheriv('aes-256-gcm', gcmKey, gcmIv);
    shimGcmDec.setAuthTag(gcmTag);
    const gcmOut = ncTarget.Buffer.concat([shimGcmDec.update(gcmCt), shimGcmDec.final()]);
    assert.equal(gcmOut.toString('utf8'), gcmPlain.toString('utf8'), 'AES-256-GCM must decrypt & verify authTag');

    // AES-256-CBC encrypt in real Node crypto -> decrypt in Switch 2 node-compat
    const cbcIv = nodeCrypto.randomBytes(16);
    const realCbcEnc = nodeCrypto.createCipheriv('aes-256-cbc', gcmKey, cbcIv);
    const cbcCt = Buffer.concat([realCbcEnc.update(gcmPlain), realCbcEnc.final()]);
    const shimCbcDec = cMod.createDecipheriv('aes-256-cbc', gcmKey, cbcIv);
    const cbcOut = ncTarget.Buffer.concat([shimCbcDec.update(cbcCt), shimCbcDec.final()]);
    assert.equal(cbcOut.toString('utf8'), gcmPlain.toString('utf8'), 'AES-256-CBC must decrypt & unpad PKCS#7');

    // Zero-copy MiniBuffer.slice view semantics (matches Node Buffer.prototype.slice)
    const zBuf = ncTarget.Buffer.from([10, 20, 30, 40]);
    const zSlice = zBuf.slice(1, 3);
    assert.equal(zSlice.length, 2);
    assert.equal(zSlice[0], 20);
    zSlice[0] = 99;
    assert.equal(zBuf[1], 99, 'MiniBuffer.slice must share underlying ArrayBuffer memory like Node Buffer.slice');
  }

  console.log('[PASS] MV Performance fast-paths (Spine WebGL2, Pixi v4 snap, OMORI TiledTilemap & RectTileLayer bake, Noel liply_MobileLight, PKD AES-GCM/CBC, Live2D VBO pool & constant folder, O(1) spatial grid, Typed-Array A*, SE cache)');
}

// 18. Verify Haven / VisuStella MZ hoisted _0x string-table folding + MZ runtime fast-paths + DomNode.style.font
{
  // A) Hoisted VisuStella MZ `_0x` string-table folding (with outer alias before rotation IIFE,
  //    `instanceof` trailing-space guard, split-string bracket concat, and quoted hex args)
  const visuLikePlugin = [
    'var VisuMZ = VisuMZ || {};',
    'const _0x2057f9=_0x1960;(function(_0x3ac999,_0x534bc0){const _0x3e95a5=_0x1960,_0x4aab50=_0x3ac999();while(!![]){try{const _0x17ae4b=parseInt(_0x3e95a5(0x100))/0x1+parseInt(_0x3e95a5(0x101))/0x2;if(_0x17ae4b===_0x534bc0)break;else _0x4aab50.push(_0x4aab50.shift());}catch(_0xe1){_0x4aab50.push(_0x4aab50.shift());}}}(_0x3fef,0x3));',
    'VisuMZ.check = function(sm, Scene_Map) { const _0xa1 = _0x2057f9; return sm[_0xa1(0x102)]instanceof Scene_Map && sm[_0xa1(0x103) + _0xa1(\'0x104\')] === 42; };',
    'function _0x3fef(){const _0xa2b3=["zoom","Scale","1a","4b","_scene"];_0x3fef=function(){return _0xa2b3;};return _0x3fef();}',
    'function _0x1960(_0x10,_0x20){const _0xd1=_0x3fef();return _0x1960=function(_0xe2,_0xf3){_0xe2=_0xe2-0x100;let _0xc4=_0xd1[_0xe2];return _0xc4;},_0x1960(_0x10,_0x20);}',
  ].join('\n');

  const foldedVisu = mod.foldObfuscatedStringTable(visuLikePlugin, 'js/plugins/VisuMZ_Test.js');
  assert.ok(foldedVisu.includes('sm._scene instanceof Scene_Map'), 'Must fold hoisted _0x table & preserve space before instanceof');
  assert.ok(foldedVisu.includes('sm.zoomScale === 42'), 'Must fold split-string bracket access & quoted hex arg into dot property');
  assert.ok(!foldedVisu.includes('while(!![])'), 'Must pre-bake rotated array and elide startup rotation IIFE');
  const visuCtx = {};
  new Function('VisuMZ', foldedVisu + '\nreturn VisuMZ;')(visuCtx);
  function DummySceneMap() {}
  assert.equal(visuCtx.check({ _scene: new DummySceneMap(), zoomScale: 42 }, DummySceneMap), true);

  // A2) Comma-grouped rotation IIFE (`(function(a,b){...}(_0xTable, expr), mainBody)`) used by NEO_CTB / NEO_ConquestCardGame
  const commaGroupedPlugin = [
    'var NEO = {};',
    'function _0x2912(_0xa,_0xb){_0xa=_0xa-0x100;const _0xt=_0x53e6();return _0xt[_0xa];}',
    'function _0x53e6(){const _0xc=["hello","1a","4b"];_0x53e6=function(){return _0xc;};return _0x53e6();}',
    '(function(_0xd,_0xe){const _0xf=_0x2912,_0x11=_0xd();while(!![]){try{const _0x12=parseInt(_0xf(0x100))/0x1+parseInt(_0xf(0x101))/0x2;if(_0x12===_0xe)break;else _0x11.push(_0x11.shift());}catch(_0x13){_0x11.push(_0x11.shift());}}}(_0x53e6,0x1+0x2),NEO[_0x2912(0x102)]=99);',
  ].join('\n');
  const foldedComma = mod.foldObfuscatedStringTable(commaGroupedPlugin, 'js/plugins/NEO_CTB.js');
  assert.ok(foldedComma.includes('NEO.hello=99'), 'Must fold comma-grouped rotation IIFE without eating trailing plugin body');
  const neoCtx = {};
  new Function('NEO', foldedComma.replace('var NEO = {};', '') + '\nreturn NEO;')(neoCtx);
  assert.equal(neoCtx.hello, 99);

  // B) DomNode.style.font shorthand parser (`OpenTypePixelFont.js` compatibility)
  const prevScreen = globalThis.screen;
  globalThis.screen = { width: 1280, height: 720, addEventListener() {}, removeEventListener() {}, getContext() { return { canvas: { width: 1280, height: 720 } }; } };
  try {
    const host = mod.createBrowserHost(
      { async read() { return null; }, async exists() { return false; } },
      (_p, s) => s,
      globalThis.screen,
      { gameTitle: 'FontStyleTest', enableWebGL: false },
    );
    void host;
    const pEl = globalThis.document.createElement('p');
    pEl.style.font = 'italic bold 26px "rmmz-mainfont", sans-serif';
    assert.equal(pEl.style.fontStyle, 'italic');
    assert.equal(pEl.style.fontWeight, 'bold');
    assert.equal(pEl.style.fontSize, '26px');
    assert.equal(pEl.style.fontFamily.replace(/['"]/g, '').split(',')[0].trim(), 'rmmz-mainfont');
  } finally {
    globalThis.screen = prevScreen;
  }

  // C) MZ Tilemap.Layer flat Float32Array VBO + Tilemap 30-frame skip + _sortChildren + WindowLayer zero-alloc render
  let uploadedVertexLen = 0;
  let glDraws = 0;
  let gfxCreated = 0;
  let stencilClears = 0;

  function MockMzLayer() {
    this._elements = [];
    this._indexArray = new Float32Array(0);
    this._vertexArray = new Float32Array(0);
    this._indexBuffer = { update() {} };
    this._vertexBuffer = { update(arr) { uploadedVertexLen = arr.length; } };
    this._vao = {};
    this._images = [];
    this._state = {};
    this._needsTexturesUpdate = false;
    this._needsVertexUpdate = false;
    this.worldTransform = {};
  }
  MockMzLayer.VERTEX_STRIDE = 36;
  MockMzLayer.prototype.clear = function () { this._elements.length = 0; this._needsVertexUpdate = true; };
  MockMzLayer.prototype.size = function () { return this._elements.length; };
  MockMzLayer.prototype.addRect = function (sn, sx, sy, dx, dy, w, h) { this._elements.push([sn, sx, sy, dx, dy, w, h]); };
  MockMzLayer.prototype._updateIndexBuffer = function () {};
  MockMzLayer.prototype._updateVertexBuffer = function () {
    const req = this._elements.length * 36;
    if (this._vertexArray.length < req) this._vertexArray = new Float32Array(req * 2);
    this._vertexBuffer.update(this._vertexArray);
  };
  MockMzLayer.prototype.render = function (renderer) {
    const tilemapRenderer = renderer.plugins.rpgtilemap;
    if (this._needsVertexUpdate) { this._updateVertexBuffer(); this._needsVertexUpdate = false; }
    void tilemapRenderer;
    glDraws++;
  };

  let addAllSpotsCalls = 0;
  let spotTileInnerCalls = 0;
  function MockMzTilemap() {
    this.origin = { x: 0, y: 0 };
    this._margin = 20;
    this._tileWidth = 48;
    this._tileHeight = 48;
    this._lastStartX = -1;
    this._lastStartY = -1;
    this._lastAnimationFrame = 0;
    this.animationFrame = 0;
    this._needsRepaint = true;
    this.children = [];
  }
  MockMzTilemap.Layer = MockMzLayer;
  MockMzTilemap.prototype.refresh = function () { this._needsRepaint = true; };
  MockMzTilemap.prototype._addAutotile = function (_layer, _tileId, _dx, _dy) {};
  MockMzTilemap.prototype._addSpotTile = function (_tileId, _dx, _dy) { spotTileInnerCalls++; };
  MockMzTilemap.prototype._addAllSpots = function (sx, sy) {
    addAllSpotsCalls++;
    for (const tid of this._testTiles || [0, 0, 1536, 2144]) {
      if (tid >= 2048) this._addAutotile(null, tid, 0, 0);
      this._addSpotTile(tid, 0, 0);
    }
    void sx; void sy;
  };
  MockMzTilemap.prototype.updateTransform = function () {
    const ox = Math.ceil(this.origin.x);
    const oy = Math.ceil(this.origin.y);
    const sx = Math.floor((ox - this._margin) / this._tileWidth);
    const sy = Math.floor((oy - this._margin) / this._tileHeight);
    if (this._needsRepaint || this._lastAnimationFrame !== this.animationFrame || this._lastStartX !== sx || this._lastStartY !== sy) {
      this._lastAnimationFrame = this.animationFrame;
      this._lastStartX = sx;
      this._lastStartY = sy;
      this._addAllSpots(sx, sy);
      this._needsRepaint = false;
    }
    this._sortChildren();
  };
  MockMzTilemap.prototype._sortChildren = function () {
    this.children.sort(this._compareChildOrder.bind(this));
  };
  MockMzTilemap.prototype._compareChildOrder = function (a, b) {
    if (a.z !== b.z) return a.z - b.z;
    if (a.y !== b.y) return a.y - b.y;
    return a.spriteId - b.spriteId;
  };

  function MockWindowLayer() {
    this.visible = true;
    this.children = [];
    this.transform = {};
  }
  MockWindowLayer.prototype.render = function () { gfxCreated += 999; };

  const mzRt = {
    Utils: {},
    Graphics: { width: 960, height: 540 },
    SceneManager: {},
    WebAudio: { prototype: {} },
    StorageManager: {},
    Bitmap: { prototype: {} },
    PIXI: {
      settings: {},
      utils: { createIndicesForQuads: (n) => new Uint16Array(n * 6) },
      Graphics: function () {
        gfxCreated++;
        this.clear = () => {};
        this.render = () => {};
      },
    },
    Tilemap: MockMzTilemap,
    WindowLayer: MockWindowLayer,
  };
  mod.installMzCompat(
    mzRt,
    { getDisplayMode: () => 'fit', setDisplayMode() {}, getViewport: () => ({ x: 0, y: 0, w: 960, h: 540, gw: 960, gh: 540 }), getWebGLContext: () => null },
    { isMinusJustPressed: () => false, setOverlayOpen() {}, pollGamepadRaw: () => null },
    { title: 'Haven', gameDir: '/g', wwwRoot: '/g', saveDir: '/g/save', engine: 'mz', config: {} },
  );

  // 1) Flat Layer: zero _elements array allocations, exact 2*36=72 float upload, empty layer skips draw
  const mzLayer = new MockMzLayer();
  const mockMzRenderer = {
    gl: { TRIANGLES: 4, STENCIL_TEST: 1, STENCIL_BUFFER_BIT: 2, EQUAL: 3, KEEP: 4, ALWAYS: 5, REPLACE: 6, ZERO: 0, ONE: 1, ONE_MINUS_SRC_ALPHA: 7, enable() {}, disable() {}, stencilFunc() {}, stencilOp() {}, blendFunc() {}, clear() { stencilClears++; }, clearStencil() {} },
    plugins: { rpgtilemap: { getShader: () => ({ uniforms: { uProjectionMatrix: { append() {} } } }), bindTextures() {}, updateTextures() {} } },
    batch: { setObjectRenderer() {}, flush() {} },
    projection: { projectionMatrix: { copyTo() {} } },
    shader: { bind() {} },
    geometry: { bind() {}, updateBuffers() {}, draw() { glDraws++; } },
    state: { set() {} },
    framebuffer: { forceStencil() {} },
  };
  mzLayer.clear();
  mzLayer.render(mockMzRenderer);
  assert.equal(glDraws, 0, 'Empty Tilemap.Layer must skip shader/VAO/draw calls');
  mzLayer.addRect(0, 48, 96, 0, 0, 24, 24);
  mzLayer.addRect(4, 0, 0, 24, 0, 24, 24);
  assert.equal(mzLayer._elements.length, 0, 'Must store rects in flat Float32Array without allocating JS arrays');
  assert.equal(mzLayer.size(), 2);
  mzLayer.render(mockMzRenderer);
  assert.equal(glDraws, 1);
  assert.equal(uploadedVertexLen, 72, 'Must upload exact active subarray (2 * 36 = 72 floats) instead of 2x over-allocated tail');

  // 2) Tilemap 30-frame skip on static maps vs rebuild on animated water maps + zero-tile guard
  const tm = new MockMzTilemap();
  tm.children = [{ z: 3, y: 100, spriteId: 2 }, { z: 1, y: 200, spriteId: 1 }];
  tm.updateTransform(); // initial build (animationFrame=0, only static A5=1536 + static A1=2144 + two 0s)
  assert.equal(addAllSpotsCalls, 1);
  assert.equal(spotTileInnerCalls, 2, 'tileId <= 0 slots must short-circuit before plugin _addSpotTile wrappers');
  assert.deepEqual(tm.children.map((c) => c.spriteId), [1, 2], 'MZ Tilemap._sortChildren must sort z/y/spriteId');

  tm.animationFrame = 1; // 30 frames later, camera stationary, no animated water -> SKIP rebuild!
  tm.updateTransform();
  assert.equal(addAllSpotsCalls, 1, 'Stationary map with no animated A1 water tiles must skip 30-frame _addAllSpots');

  // Now put an animated water tile (2048) on map and refresh: 30-frame tick MUST rebuild!
  tm._testTiles = [2048];
  tm.refresh();
  tm.updateTransform();
  assert.equal(addAllSpotsCalls, 2);
  tm.animationFrame = 2;
  tm.updateTransform();
  assert.equal(addAllSpotsCalls, 3, 'Map with visible animated A1 water tile must still animate every 30 frames');

  // 3) WindowLayer: 0 open windows & 1 open window allocate ZERO PIXI.Graphics and ZERO stencil clears;
  //    2+ open windows reuse a single pooled PIXI.Graphics across frames!
  const wl = new MockWindowLayer();
  let winRenders = 0;
  const closedWin = { _isWindow: true, visible: true, openness: 0, render() { winRenders++; }, drawShape() {} };
  const openWin1 = { _isWindow: true, visible: true, openness: 255, render() { winRenders++; }, drawShape() {} };
  const openWin2 = { _isWindow: true, visible: true, openness: 255, render() { winRenders++; }, drawShape() {} };
  wl.children = [closedWin];
  wl.render(mockMzRenderer);
  assert.equal(gfxCreated, 0);
  assert.equal(stencilClears, 0);
  assert.equal(winRenders, 0);

  wl.children = [closedWin, openWin1];
  wl.render(mockMzRenderer);
  assert.equal(gfxCreated, 0, 'Single open window must render directly without stencil Graphics allocation');
  assert.equal(stencilClears, 0);
  assert.equal(winRenders, 1);

  wl.children = [openWin1, openWin2];
  wl.render(mockMzRenderer);
  wl.render(mockMzRenderer);
  assert.equal(gfxCreated, 1, 'Overlapping windows must reuse a single pooled PIXI.Graphics across frames');
  assert.equal(stencilClears, 2);
  assert.equal(winRenders, 5);

  console.log('[PASS] VisuStella MZ hoisted _0x folder, DomNode.style.font, & MZ Tilemap/WindowLayer/Sprite fast-paths');
}

// ============================================================================
// 19. MZ Battle, Filter, Texture-Coalescing & OpenTypePixelFont Fast-Paths
// ============================================================================
{
  let btUpdates = 0;
  let drawTextInner = 0;
  let newFnCompiles = 0;
  let multiTargetRefreshes = 0;
  let gridBitmapClears = 0;
  let dynCreateContents = 0;
  let posClears = 0;
  let rawPathTextCalls = 0;
  let hueRtCreates = 0;

  function MockRenderer() {}
  MockRenderer.prototype.render = function () {};

  function MockBaseTexture(w = 64, h = 64) {
    this.width = w;
    this.height = h;
    this.resource = { source: { width: w, height: h } };
  }
  MockBaseTexture.prototype.update = function () {
    btUpdates++;
  };

  function MockBitmap(w = 64, h = 64, url = '') {
    this.width = w;
    this.height = h;
    this._url = url;
    this.baseTexture = new MockBaseTexture(w, h);
  }
  MockBitmap.prototype.isReady = function () { return true; };
  MockBitmap.prototype.clear = function () { gridBitmapClears++; };
  MockBitmap.prototype.drawText = function () { drawTextInner++; };
  MockBitmap.prototype.destroy = function () {};

  function MockColorFilter() {
    this.initialize();
  }
  MockColorFilter.prototype.initialize = function () {
    this.enabled = true;
    this.uniforms = {
      hue: 0,
      colorTone: [0, 0, 0, 0],
      blendColor: [0, 0, 0, 0],
      brightness: 255,
    };
  };
  MockColorFilter.prototype.setHue = function (h) { this.uniforms.hue = Number(h); };
  MockColorFilter.prototype.setBrightness = function (b) { this.uniforms.brightness = Number(b); };
  MockColorFilter.prototype.setColorTone = function (t) { this.uniforms.colorTone = t.slice(); };
  MockColorFilter.prototype.setBlendColor = function (c) { this.uniforms.blendColor = c.slice(); };

  function MockSprite(bmp = null) {
    this.children = [];
    this.visible = true;
    this._bitmap = bmp;
    this._hue = 0;
    this._colorTone = [0, 0, 0, 0];
    this._blendColor = [0, 0, 0, 0];
    this._colorFilter = null;
    this.texture = { baseTexture: bmp ? bmp.baseTexture : null };
  }
  MockSprite.prototype.update = function () {
    for (const child of this.children) {
      if (child.update) {
        child.update();
      }
    }
  };
  MockSprite.prototype._updateColorFilter = function () {
    if (!this._colorFilter) this._colorFilter = new MockColorFilter();
    this._colorFilter.setHue(this._hue);
    this._colorFilter.setBlendColor(this._blendColor);
    this._colorFilter.setColorTone(this._colorTone);
  };
  MockSprite.prototype.setHue = function (h) {
    this._hue = Number(h);
    this._updateColorFilter();
  };
  MockSprite.prototype.setColorTone = function (tone) {
    this._colorTone = tone.slice();
    this._updateColorFilter();
  };
  MockSprite.prototype.setBlendColor = function (color) {
    this._blendColor = color.slice();
    this._updateColorFilter();
  };
  MockSprite.prototype._refresh = function () {
    if (this._bitmap && this.texture) this.texture.baseTexture = this._bitmap.baseTexture;
  };
  MockSprite.prototype._onBitmapLoad = function () {
    this._refresh();
  };

  function MockWindow() {
    this._isWindow = true;
    this.visible = true;
    this.active = false;
    this._openness = 255;
    this.openness = 255;
    this.x = 0;
    this.y = 0;
    this._width = 200;
    this._height = 100;
    this._padding = 12;
    this.origin = { x: 0, y: 0 };
    this._clientArea = {
      filters: [{ alpha: 1, enabled: true }],
      filterArea: { x: 0, y: 0, width: 0, height: 0 },
      worldTransform: { tx: 12, ty: 12, apply: () => ({ x: 12, y: 12 }) },
    };
    this._contentsSprite = { _bitmap: { width: 176, height: 76 } };
    this.children = [];
  }
  Object.defineProperty(MockWindow.prototype, 'innerWidth', { get() { return this._width - this._padding * 2; } });
  Object.defineProperty(MockWindow.prototype, 'innerHeight', { get() { return this._height - this._padding * 2; } });
  MockWindow.prototype.update = function () {
    if (this.active) {
      this._animationCount++;
    }
    for (const child of this.children) {
      if (child.update) {
        child.update();
      }
    }
  };
  MockWindow.prototype._updateFilterArea = function () {
    const pos = this._clientArea.worldTransform.apply(new Point(0, 0));
    const filterArea = this._clientArea.filterArea;
    filterArea.x = pos.x + this.origin.x;
    filterArea.y = pos.y + this.origin.y;
    filterArea.width = this.innerWidth;
    filterArea.height = this.innerHeight;
  };
  MockWindow.prototype.updateTransform = function () {
    this._updateFilterArea();
  };
  MockWindow.prototype.render = function () {};

  function MockWindowLayer2() {
    this.visible = true;
    this.children = [];
    this.transform = {};
  }
  MockWindowLayer2.prototype.isMaskingEnabled = () => true;
  MockWindowLayer2.prototype.render = function () {};

  function MockSpriteGauge() {
    this._statusType = 'tp';
    this._gaugeImgData = { VisibilityCondition: '$gameSystem._showTp' };
    this.visible = false;
  }
  MockSpriteGauge.isGaugeVisible = () => true;
  MockSpriteGauge.prototype.updateVisibility = function () {
    const condition = this._gaugeImgData.VisibilityCondition;
    const evalFunc = new Function('$gameSystem', `return ${condition};`);
    this.visible = evalFunc(battleRt.$gameSystem);
  };

  function MockBattleMultiTarget() {
    this.visible = false;
    this._buttonKey = undefined;
    this._buttonText = undefined;
  }
  MockBattleMultiTarget.SHOW_BUTTON = false;
  MockBattleMultiTarget.prototype.refresh = function () { multiTargetRefreshes++; };
  MockBattleMultiTarget.prototype.updateKeyboardKeys = function () {
    if (this._buttonText !== '') this.refresh();
  };

  function MockGridPassives() {
    this.bitmap = new MockBitmap(32, 32);
    this._pictureSprite = { bitmap: null, visible: false };
    this._currentPictureName = '';
    this._iconIndex = 0;
  }
  MockGridPassives.prototype.stateIDs = function () { return [5]; };
  MockGridPassives.prototype.setupAnimatedPicture = function () {};
  MockGridPassives.prototype.onPictureLoad = function () {};
  MockGridPassives.prototype.drawIconBitmap = function () {};
  MockGridPassives.prototype.updatePictureSprite = function () {
    const stateIds = this.stateIDs();
    if (battleRt.$neo.StateNotetags[stateIds[0]]) {
      this._pictureSprite.visible = true;
      this.bitmap.clear();
    }
  };

  function MockDynamicBattleText() {
    this.x = 0;
    this.y = 42;
    this.height = 60;
    this.contents = { clear() {} };
    this._evalResult = ['Alert A'];
  }
  MockDynamicBattleText.prototype.fittingHeight = (n) => n * 36 + 24;
  MockDynamicBattleText.prototype.evaluateConditions = function () { return this._evalResult; };
  MockDynamicBattleText.prototype.createContents = function () { dynCreateContents++; this.contents = { clear() {} }; };
  MockDynamicBattleText.prototype.drawAllText = function () {};
  MockDynamicBattleText.prototype.refresh = function () {
    this.contents.clear();
    this._displayTexts = this.evaluateConditions();
    this.createContents();
    this.drawAllText();
  };

  function MockPositionedBattleText() {
    this.contents = { clear() { posClears++; } };
    this._entries = [];
  }
  MockPositionedBattleText.prototype.evaluateConditions = function () { return this._entries; };
  MockPositionedBattleText.prototype.drawAllPositionedText = function () {};
  MockPositionedBattleText.prototype.refresh = function () {
    this.contents.clear();
    this._activeEntries = this.evaluateConditions();
    this.drawAllPositionedText();
  };

  function MockSceneBattle() {}
  MockSceneBattle.prototype.createAllWindows = function () {
    this._dynamicBattleTextWindow = new MockDynamicBattleText();
    this._positionedBattleTextWindow = new MockPositionedBattleText();
  };

  function MockCtx2D() {
    this.lineWidth = 4;
    this.moves = [];
    this.lines = [];
  }
  MockCtx2D.prototype.beginPath = function () {};
  MockCtx2D.prototype.closePath = function () {};
  MockCtx2D.prototype.moveTo = function (x, y) { this.moves.push([x, y]); };
  MockCtx2D.prototype.lineTo = function (x, y) { this.lines.push([x, y]); };
  MockCtx2D.prototype.fill = function () {};
  MockCtx2D.prototype.stroke = function () {};
  MockCtx2D.prototype._groupTextForDrawing = function (t, f) {
    return [{ text: t, font: { shouldSquishText: false }, width: t.length * 8, scale: 1 }];
  };
  MockCtx2D.prototype._pathText = function (g, f, x, y) {
    rawPathTextCalls++;
    return {
      commands: [
        { type: 'M', x: 2 + x, y: 4 + y },
        { type: 'L', x: 10 + x, y: 4 + y },
        { type: 'Z' },
        { type: 'M', x: -12345, y: -12345 },
        { type: 'L', x: -12345, y: -12345 },
      ],
    };
  };
  MockCtx2D.prototype._fillText = function (g, f, x, y, w) {
    const p = this._pathText(g, f, x, y, w);
    for (const c of p.commands) {
      if (c.type === 'M') this.moveTo(c.x, c.y);
      else if (c.type === 'L') this.lineTo(c.x, c.y);
    }
  };
  MockCtx2D.prototype._strokeText = function (g, f, x, y, w) {
    this._fillText(g, f, x, y, w);
  };

  const rendererInst = new MockRenderer();
  let wlStencilClears = 0;
  const mockWlRenderer = {
    gl: { STENCIL_TEST: 1, STENCIL_BUFFER_BIT: 2, EQUAL: 3, KEEP: 4, ALWAYS: 5, REPLACE: 6, ZERO: 0, ONE: 1, ONE_MINUS_SRC_ALPHA: 7, enable() {}, disable() {}, stencilFunc() {}, stencilOp() {}, blendFunc() {}, clear() { wlStencilClears++; }, clearStencil() {} },
    batch: { flush() {} },
    framebuffer: { forceStencil() {} },
  };

  const battleRt = {
    Utils: {},
    Graphics: { width: 960, height: 540, frameCount: 10, _app: { renderer: rendererInst } },
    SceneManager: { _scene: { _windowLayer: null } },
    WebAudio: { prototype: {} },
    StorageManager: {},
    $gameSystem: { _showTp: true },
    $gameScreen: { picture: () => null },
    $neo: { StateNotetags: { 5: 'GridPic' } },
    ImageManager: { loadPicture: () => ({ addLoadListener(cb) { cb(); } }) },
    Function: function (...args) {
      newFnCompiles++;
      return new globalThis.Function(...args);
    },
    Bitmap: MockBitmap,
    ColorFilter: MockColorFilter,
    Sprite: MockSprite,
    Window: MockWindow,
    WindowLayer: MockWindowLayer2,
    Sprite_Gauge: MockSpriteGauge,
    Window_BattleMultiTarget: MockBattleMultiTarget,
    Sprite_BattleGridPassives: MockGridPassives,
    Scene_Battle: MockSceneBattle,
    CanvasRenderingContext2D: MockCtx2D,
    PIXI: {
      settings: {},
      Renderer: MockRenderer,
      BaseTexture: MockBaseTexture,
      Sprite: function (tex) { this.texture = tex; this.filters = null; },
      Texture: Object.assign(function (bt) { this.baseTexture = bt; }, { EMPTY: {} }),
      RenderTexture: {
        create: ({ width, height }) => {
          hueRtCreates++;
          return { baseTexture: new MockBaseTexture(width, height), destroy() {} };
        },
      },
      Graphics: function () { this.clear = () => {}; this.render = () => {}; },
    },
  };

  mod.installMzCompat(
    battleRt,
    { getDisplayMode: () => 'fit', setDisplayMode() {}, getViewport: () => ({ x: 0, y: 0, w: 960, h: 540, gw: 960, gh: 540 }), getWebGLContext: () => null },
    { isMinusJustPressed: () => false, setOverlayOpen() {}, pollGamepadRaw: () => null },
    { title: 'Haven', gameDir: '/g', wwwRoot: '/g', saveDir: '/g/save', engine: 'mz', config: {} },
  );

  // 1) BaseTexture.update coalesces within same render epoch, resets on Renderer.render, & drawText("") skips
  const bt = new MockBaseTexture(128, 32);
  bt.update();
  bt.update();
  bt.update();
  assert.equal(btUpdates, 1, 'Multiple BaseTexture.update() calls in the same frame must coalesce to 1');
  rendererInst.render();
  bt.update();
  assert.equal(btUpdates, 2, 'BaseTexture.update() must fire again after Renderer.render() advances epoch');

  const bmp = new MockBitmap(64, 32);
  bmp.drawText('');
  bmp.drawText(null);
  assert.equal(drawTextInner, 0, 'Empty/null Bitmap.drawText must short-circuit');
  bmp.drawText(0);
  bmp.drawText('HP');
  assert.equal(drawTextInner, 2, 'Numeric 0 and non-empty strings must still draw');

  // 2) ColorFilter auto-disables at identity & static URL-backed battlerHue pre-bakes into shared RenderTexture!
  const cf = new MockColorFilter();
  assert.equal(cf.enabled, false, 'Identity ColorFilter must start with enabled=false');
  cf.setColorTone([30, 0, 0, 0]);
  assert.equal(cf.enabled, true, 'Non-zero colorTone must enable ColorFilter');
  cf.setColorTone([0, 0, 0, 0]);
  assert.equal(cf.enabled, false, 'Returning colorTone to [0,0,0,0] must disable ColorFilter again');

  const enemyBmp = new MockBitmap(128, 128, 'img/enemies/Slime.png');
  const enemySpr1 = new MockSprite(enemyBmp);
  const enemySpr2 = new MockSprite(enemyBmp);
  enemySpr1.setHue(169);
  enemySpr2.setHue(169);
  assert.equal(hueRtCreates, 1, 'Multiple enemies sharing (Bitmap, hue) must bake only 1 shared RenderTexture');
  assert.equal(enemySpr1.texture.baseTexture, enemySpr2.texture.baseTexture);
  assert.notEqual(enemySpr1.texture.baseTexture, enemyBmp.baseTexture);
  assert.equal(enemySpr1._colorFilter.enabled, false, 'Pre-baked hue sprite must disable per-frame ColorFilter FBO pass');
  enemySpr1.setBlendColor([255, 255, 255, 160]);
  assert.equal(enemySpr1._colorFilter.enabled, true, 'Hit-flash blendColor on pre-baked hue sprite must still enable ColorFilter');

  // 3) Window AlphaFilter disables when unscrolled & contents fit, enables when scrolled; non-overlapping & offscreen WindowLayer
  const winA = new MockWindow();
  winA.updateTransform();
  assert.equal(winA._clientArea.filters[0].enabled, false, 'Unscrolled open window with fitting contents must bypass AlphaFilter FBO');
  winA.origin.y = 36;
  winA.updateTransform();
  assert.equal(winA._clientArea.filters[0].enabled, true, 'Scrolled window must enable AlphaFilter clipping');

  const wl2 = new MockWindowLayer2();
  battleRt.SceneManager._scene._windowLayer = wl2;
  let renderedWins = [];
  const wLeft = { _isWindow: true, visible: true, openness: 255, x: 0, y: 376, _width: 532, _height: 156, render() { renderedWins.push('left'); }, drawShape() {} };
  const wRight = { _isWindow: true, visible: true, openness: 255, x: 532, y: 376, _width: 420, _height: 156, render() { renderedWins.push('right'); }, drawShape() {} };
  const wOffscreen = { _isWindow: true, visible: true, openness: 255, x: 1904, y: 0, _width: 952, _height: 384, render() { renderedWins.push('off'); }, drawShape() {} };
  wl2.children = [wLeft, wRight, wOffscreen];
  wl2.render(mockWlRenderer);
  assert.deepEqual(renderedWins, ['left', 'right'], 'Off-screen Window_BattleLog at x=1904 must be culled');
  assert.equal(wlStencilClears, 0, 'Non-overlapping open battle windows must skip stencil passes');

  // 4) NUUN_GaugeImage VisibilityCondition compiles Function once, Window_BattleMultiTarget skips refresh, GridPassives skips clear
  const g1 = new MockSpriteGauge();
  const g2 = new MockSpriteGauge();
  for (let i = 0; i < 10; i++) { g1.updateVisibility(); g2.updateVisibility(); }
  assert.equal(newFnCompiles, 1, 'NUUN_GaugeImage VisibilityCondition must compile once across all gauges & frames');
  assert.equal(g1.visible, true);

  const bmt = new MockBattleMultiTarget();
  bmt.updateKeyboardKeys();
  bmt.updateKeyboardKeys();
  assert.equal(multiTargetRefreshes, 0, 'Hidden/SHOW_BUTTON=false Window_BattleMultiTarget must not refresh every frame');

  const gp = new MockGridPassives();
  gp.updatePictureSprite();
  gp.updatePictureSprite();
  gp.updatePictureSprite();
  assert.equal(gridBitmapClears, 1, 'Sprite_BattleGridPassives must clear its bitmap only once when state picture is unchanged');

  // 5) NEO_BattleTextAlerts closure-private windows skip redundant createContents/clear
  const sb = new MockSceneBattle();
  sb.createAllWindows();
  sb._dynamicBattleTextWindow.refresh();
  sb._dynamicBattleTextWindow.refresh();
  sb._dynamicBattleTextWindow.refresh();
  assert.equal(dynCreateContents, 0, 'Unchanged Window_DynamicBattleText height/text must not recreate Bitmap contents');
  sb._positionedBattleTextWindow.refresh();
  sb._positionedBattleTextWindow.refresh();
  assert.equal(posClears, 1, 'Window_PositionedBattleText must clear 960x540 bitmap only when active entries change');

  // 6) OpenTypePixelFont glyph path cache strips -12345 dummy cmds & translates integer shifts without re-tessellating
  const ctx = new MockCtx2D();
  const glyphGroup = { text: 'Attack', font: { shouldSquishText: false }, scale: 1 };
  const fontMeta = { size: 16, fontStyle: 'normal' };
  ctx._fillText(glyphGroup, fontMeta, 10, 20, 100);
  ctx._fillText(glyphGroup, fontMeta, 50, 80, 100);
  ctx._strokeText(glyphGroup, fontMeta, 50, 80, 100);
  assert.equal(rawPathTextCalls, 1, 'OpenTypePixelFont must cache snapped glyph paths across integer (x, y) shifts & passes');
  assert.deepEqual(ctx.moves, [[12, 24], [52, 84], [52, 84]], 'Cached glyph path must translate coordinates & strip -12345 dummy cmds');

  console.log('[PASS] MZ Battle, ColorFilter/Hue/AlphaFilter, Texture-Coalescing & OpenTypePixelFont fast-paths');
}

// ============================================================================
// 20. MZ `globalThis.main` AoE Shim & VisuMZ / NEO_InputConfig Quick-Menu Resume
// ============================================================================
{
  let fatalCalls = 0;
  let tickCalls = 0;
  const mzAoeRt = {
    Utils: {},
    Graphics: {
      width: 960,
      height: 540,
      _canRender: () => true,
      _app: { render() {}, renderer: { render() {} } },
      _onTick() { tickCalls++; },
      stopGameLoop() {},
    },
    SceneManager: {
      stop() {},
      catchException() {},
    },
    WebAudio: { prototype: {} },
    StorageManager: {},
    Bitmap: { prototype: {} },
    PIXI: { settings: {} },
  };
  mod.installMzCompat(
    mzAoeRt,
    { getDisplayMode: () => 'fit', setDisplayMode() {}, getViewport: () => ({ x: 0, y: 0, w: 960, h: 540, gw: 960, gh: 540 }), getWebGLContext: () => null },
    { isMinusJustPressed: () => false, setOverlayOpen() {}, pollGamepadRaw: () => null },
    { title: 'Haven', gameDir: '/g', wwwRoot: '/g', saveDir: '/g/save', engine: 'mz', config: {} },
    { onFatalError: () => { fatalCalls++; } },
  );

  // 1) VisuMZ_2_BattleGridSystem `if (member === main) continue;` must not throw ReferenceError
  assert.ok('main' in mzAoeRt && mzAoeRt.main && typeof mzAoeRt.main === 'object', 'installMzCompat must define runtime.main');
  const getAoeFn = new Function(
    'runtime',
    'with (runtime) { return function(targets, unit) { const out = []; for (const m of unit) { if (m === main) continue; if (targets.includes(m)) continue; out.push(m); } return out; }; }',
  )(mzAoeRt);
  const e1 = { id: 1 }, e2 = { id: 2 }, e3 = { id: 3 };
  assert.deepEqual(getAoeFn([e1], [e1, e2, e3]), [e2, e3], 'AoE target scan referencing `main` must succeed cleanly');

  // 2) Fatal exception latching: stops ticking & invokes onFatalError only once
  mzAoeRt.Graphics._onTick(1);
  assert.equal(tickCalls, 1);
  mzAoeRt.SceneManager.catchException(new Error('Boom'));
  mzAoeRt.SceneManager.catchException(new Error('Boom 2'));
  mzAoeRt.Graphics._onTick(1);
  assert.equal(fatalCalls, 1, 'SceneManager.catchException must latch and invoke onFatalError once');
  assert.equal(tickCalls, 1, 'Graphics._onTick must halt after fatal exception so error splash stays visible');

  // 3) VisuMZ_0_CoreEngine `_gamepadWait = 24` + NEO_InputConfig `gamepadMapper[8] = 'tab'` Quick-Menu resume test!
  const makeBtns = (pressedSet = []) =>
    Array.from({ length: 16 }, (_, i) => ({ pressed: pressedSet.includes(i), value: pressedSet.includes(i) ? 1 : 0 }));
  let activePads = [
    { index: 0, connected: true, buttons: makeBtns([]), axes: [0, 0] },
    { index: 1, connected: true, buttons: makeBtns([]), axes: [0, 0] },
  ];
  const prevNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => activePads },
    configurable: true,
    writable: true,
  });

  try {
    const visuInput = {
      keyRepeatWait: 24,
      gamepadMapper: { ...mod.DEFAULT_MV_GAMEPAD_MAP },
      keyMapper: {},
      _currentState: {},
      _previousState: {},
      _gamepadStates: [],
      _latestButton: null,
      _pressedTime: 0,
      _dir4: 0,
      _dir8: 0,
      _gamepadWait: 0,
      clear() {
        this._currentState = {};
        this._previousState = {};
        this._gamepadStates = [];
        this._latestButton = null;
        this._pressedTime = 0;
        // Exact VisuMZ_0_CoreEngine behavior that previously deadlocked gamepad input!
        this._gamepadWait = this.keyRepeatWait;
      },
      update() {
        this._pollGamepads();
        if (this._gamepadWait) this._gamepadWait--;
        for (const name in this._currentState) {
          if (this._currentState[name] && !this._previousState[name]) {
            this._latestButton = name;
            this._pressedTime = 0;
          }
          this._previousState[name] = this._currentState[name];
        }
      },
      _pollGamepads() {
        if (this._gamepadWait) return;
        for (const gp of globalThis.navigator.getGamepads()) {
          if (gp && gp.connected) this._updateGamepadState(gp);
        }
      },
      _updateGamepadState(gamepad) {
        const lastState = this._gamepadStates[gamepad.index] || [];
        const newState = [];
        for (let i = 0; i < gamepad.buttons.length; i++) {
          newState[i] = gamepad.buttons[i].pressed;
        }
        for (let j = 0; j < newState.length; j++) {
          if (newState[j] !== lastState[j]) {
            const buttonName = this.gamepadMapper[j];
            if (buttonName) this._currentState[buttonName] = newState[j];
          }
        }
        this._gamepadStates[gamepad.index] = newState;
      },
      isTriggered(name) {
        return this._latestButton === name && this._pressedTime === 0;
      },
    };

    const bridge = mod.createInputBridge();
    bridge.installIntoRuntime(
      { Input: visuInput, TouchInput: { clear() {} } },
      () => ({ x: 0, y: 0, w: 960, h: 540, gw: 960, gh: 540 }),
    );

    // Simulate NEO_InputConfig overwriting Input.gamepadMapper on Scene_Boot.start (`6: '', 7: '', 8: 'tab'`)
    visuInput.gamepadMapper = {
      0: 'escape', 1: 'ok', 2: 'shift', 3: 'menu', 4: 'pagedown', 5: 'pageup',
      6: '', 7: '', 8: 'tab', 9: 'menu', 12: 'up', 13: 'down', 14: 'left', 15: 'right',
    };

    // Multi-controller check: pad[0] idle, pad[1] pressing Minus (8) -> pollGamepadRaw must detect pad[1]!
    activePads[1].buttons = makeBtns([8]);
    assert.equal(bridge.pollGamepadRaw().index, 1, 'pollGamepadRaw must pick active controller when multiple pads are connected');
    assert.equal(bridge.isMinusJustPressed(), true);

    // Even if _updateGamepadState runs with Minus pressed, 'tab' must NOT fire on button 8 and must move to ZL (6)
    visuInput.update();
    assert.equal(visuInput._currentState.tab || false, false, 'Minus (button 8) must never trigger in-game tab');
    assert.equal(visuInput.gamepadMapper[6], 'tab', 'NEO_InputConfig 8:tab must migrate to Switch ZL (button 6)');
    assert.equal(visuInput.gamepadMapper[8], undefined, 'Button 8 must stay reserved for Quick Menu');

    // Open Quick Menu, then close it with B (button 0) held for 2 frames, then release and press A (button 1 = ok)!
    bridge.setOverlayOpen(true);
    activePads[1].buttons = makeBtns([0]); // holding B to close menu
    visuInput.update();
    assert.equal(visuInput._gamepadWait, 0, 'VisuMZ _gamepadWait must stay 0 while overlay is open');

    bridge.setOverlayOpen(false);
    // B still held for 2 frames -> must not leak 'escape' into game
    visuInput.update();
    visuInput.update();
    assert.equal(visuInput._currentState.escape || false, false, 'Held B from closing menu must not leak into game');

    // Release B, let 2 settle frames run
    activePads[1].buttons = makeBtns([]);
    visuInput.update();
    visuInput.update();
    visuInput.update();
    assert.equal(visuInput._gamepadWait, 0, 'VisuMZ _gamepadWait must remain 0 after overlay close');

    // Immediately press A (button 1 = 'ok') -> MUST register on the very first frame without 300-frame lockup!
    activePads[1].buttons = makeBtns([1]);
    visuInput.update();
    assert.equal(visuInput._currentState.ok, true, 'Buttons must respond immediately after closing Quick Menu');
    assert.equal(visuInput.isTriggered('ok'), true);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true, writable: true });
  }

  console.log('[PASS] MZ globalThis.main AoE shim, fatal exception latch & VisuMZ/NEO Quick-Menu input resume');
}

// 21. Verify per-engine log separation (mv.log vs mz.log), rich diagnostic reports & version sync
{
  const pkgJson = JSON.parse(readFileSync(join(loaderDir, 'package.json'), 'utf8'));
  const launcherMk = readFileSync(join(loaderDir, '..', 'launcher', 'Makefile'), 'utf8');
  const wolfMk = readFileSync(join(loaderDir, '..', 'wolf-engine', 'Makefile'), 'utf8');
  const mkxpzPreload = readFileSync(join(loaderDir, '..', 'scripts', 'mkxpz', 'preload-compat-v2.rb'), 'utf8');

  assert.equal(mod.SW2RPGMGL_VERSION, '0.3.2', 'SW2RPGMGL_VERSION must be bumped to 0.3.2');
  assert.equal(pkgJson.version, mod.SW2RPGMGL_VERSION, 'package.json version must match SW2RPGMGL_VERSION');
  assert.equal(pkgJson.nacp.version, mod.SW2RPGMGL_VERSION, 'package.json nacp.version must match SW2RPGMGL_VERSION');
  assert.match(launcherMk, new RegExp(`^APP_VERSION\\s*:=\\s*${mod.SW2RPGMGL_VERSION}\\b`, 'm'));
  assert.match(wolfMk, new RegExp(`^APP_VERSION\\s*:=\\s*${mod.SW2RPGMGL_VERSION}\\b`, 'm'));
  assert.match(mkxpzPreload, new RegExp(`VERSION\\s*=\\s*"${mod.SW2RPGMGL_VERSION}"`));
  assert.match(mkxpzPreload, /SW2RPGMGL v#\{VERSION\} — MKXP-Z Engine \(mkxpz\.log\)/);

  const prevSwitch = globalThis.Switch;
  try {
    const logSw = createMockSwitch({
      // 1) Standard encrypted MV game
      'sdmc:/switch/SW2RPGMGL/games/SampleMV/www/index.html': '<title>Sample MV</title>',
      'sdmc:/switch/SW2RPGMGL/games/SampleMV/www/package.json': JSON.stringify({
        name: 'sample-mv',
        version: '1.2.0',
        window: { width: 1280, height: 720 },
      }),
      'sdmc:/switch/SW2RPGMGL/games/SampleMV/www/data/System.json': JSON.stringify({
        gameTitle: 'Sample MV Chronicle',
        locale: 'ja_JP',
        versionId: 987654,
        hasEncryptedImages: true,
        hasEncryptedAudio: true,
        encryptionKey: '0123456789abcdef0123456789abcdef',
      }),
      'sdmc:/switch/SW2RPGMGL/games/SampleMV/www/img/system/Window.rpgmvp': 'enc',
      'sdmc:/switch/SW2RPGMGL/games/SampleMV/www/audio/bgm/Theme1.rpgmvo': 'enc',
      'sdmc:/switch/SW2RPGMGL/games/SampleMV/www/_jp_map.txt': 'img/pictures/立ち絵.rpgmvp\timg/pictures/_jp_001.rpgmvp\n',
      'sdmc:/switch/SW2RPGMGL/games/SampleMV/www/js/plugins.js':
        'var $plugins = [\n' +
        '{"name":"YEP_CoreEngine","status":true,"description":"","parameters":{}},\n' +
        '{"name":"MOG_TitleParticles","status":true,"description":"","parameters":{}},\n' +
        '{"name":"UnusedPlugin","status":false,"description":"","parameters":{}}\n' +
        '];',
      'sdmc:/switch/SW2RPGMGL/games/SampleMV/save/file1.rpgsave': 's1',
      'sdmc:/switch/SW2RPGMGL/games/SampleMV/save/global.rpgsave': 'g1',

      // 2) Custom OMORI-encrypted game
      'sdmc:/switch/SW2RPGMGL/games/SampleOmori/Riruka24.ini': 'Args=--secretlaunchkey\n',
      'sdmc:/switch/SW2RPGMGL/games/SampleOmori/www/index.html': '<title>OMORI</title>',
      'sdmc:/switch/SW2RPGMGL/games/SampleOmori/www/data/System.KEL': 'enc',
      'sdmc:/switch/SW2RPGMGL/games/SampleOmori/www/js/plugins/OmoriBase.OMORI': 'enc',
      'sdmc:/switch/SW2RPGMGL/games/SampleOmori/www/js/plugins.js':
        'var $plugins = [{"name":"OmoriBase","status":true,"parameters":{}}];',

      // 3) Encrypted MZ game with KageDesu PKD Protector & custom overrides
      'sdmc:/switch/SW2RPGMGL/games/SampleMZ/index.html': '<title>Sample MZ</title>',
      'sdmc:/switch/SW2RPGMGL/games/SampleMZ/js/rmmz_core.js': '// mz',
      'sdmc:/switch/SW2RPGMGL/games/SampleMZ/mv-loader.json': JSON.stringify({ displayMode: 'stretch' }),
      'sdmc:/switch/SW2RPGMGL/games/SampleMZ/data/System.json': JSON.stringify({
        gameTitle: 'Sample MZ Quest',
        locale: 'en_US',
        hasEncryptedImages: true,
        hasEncryptedAudio: false,
        encryptionKey: 'fedcba9876543210fedcba9876543210',
        advanced: { screenWidth: 1280, screenHeight: 720, uiAreaWidth: 1152, uiAreaHeight: 648 },
      }),
      'sdmc:/switch/SW2RPGMGL/games/SampleMZ/img/system/Window.png_': 'enc',
      'sdmc:/switch/SW2RPGMGL/games/SampleMZ/audio/bgm/Field1.ogg': 'raw',
      'sdmc:/switch/SW2RPGMGL/games/SampleMZ/js/plugins/Assets.pkd': 'pkd',
      'sdmc:/switch/SW2RPGMGL/games/SampleMZ/js/plugins.js':
        'var $plugins = [{"name":"VisuMZ_0_CoreEngine","status":true,"parameters":{}},{"name":"PKD_Protector","status":true,"parameters":{}}];',
    });

    // Verify MV writes exclusively to log/mv.log
    logSw.argv = [
      'sdmc:/switch/SW2RPGMGL/engines/mv-engine-switch2.nro',
      'sdmc:/switch/SW2RPGMGL/engines/mv-engine-switch2.nro',
      'sdmc:/switch/SW2RPGMGL/games/SampleMV',
      'sdmc:/switch/SW2RPGMGL/SW2RPGMGL.nro',
    ];
    globalThis.Switch = logSw;
    mod.initLog('mv.log', 'RPG Maker MV Engine');
    assert.equal(mod.getLogPath(), 'sdmc:/switch/SW2RPGMGL/log/mv.log');

    const mvGame = mod.inspectSingleMvGame(logSw, 'sdmc:/switch/SW2RPGMGL/games/SampleMV');
    const mvAssets = mod.createAssetReader(mvGame.wwwRoot, logSw);
    const mvDiag = mod.logGameDiagnostics(logSw, mvGame, mvAssets, {
      rendererMode: 'Canvas2D (Skia GPU)',
    });
    assert.equal(mvDiag.title, 'Sample MV Chronicle');
    assert.equal(mvDiag.jpMapCount, 1);
    assert.deepEqual(mvDiag.enabledPlugins, ['YEP_CoreEngine', 'MOG_TitleParticles']);
    assert.equal(mvDiag.totalPlugins, 3);
    assert.match(mvDiag.encryptionSummary, /Standard MV \(\.rpgmvp\/\.rpgmvo\)/);
    assert.match(mvDiag.encryptionSummary, /key=present \(32 chars\)/);
    // Secret encryption key itself must NEVER appear in the shareable log!
    const mvLogText = new TextDecoder().decode(logSw.readFileSync('sdmc:/switch/SW2RPGMGL/log/mv.log'));
    assert.ok(!mvLogText.includes('0123456789abcdef0123456789abcdef'), 'Raw encryptionKey must never leak into mv.log');
    assert.ok(mvLogText.includes('SW2RPGMGL v0.3.2 — RPG Maker MV Engine (mv.log)'));
    assert.ok(mvLogText.includes('YEP_CoreEngine, MOG_TitleParticles'));

    // Verify OMORI custom encryption detection
    const omoriGame = mod.inspectSingleMvGame(logSw, 'sdmc:/switch/SW2RPGMGL/games/SampleOmori');
    const omoriAssets = mod.createAssetReader(omoriGame.wwwRoot, logSw);
    const omoriDiag = mod.collectGameDiagnostics(logSw, omoriGame, omoriAssets, {
      rendererMode: 'Canvas2D (Skia GPU)',
    });
    assert.match(omoriDiag.encryptionSummary, /OMORI AES-256-CTR.*Riruka24\.ini=present/);

    // Verify MZ writes exclusively to log/mz.log without touching log/mv.log!
    logSw.argv = [
      'sdmc:/switch/SW2RPGMGL/engines/mz-engine-switch2.nro',
      'sdmc:/switch/SW2RPGMGL/engines/mz-engine-switch2.nro',
      'sdmc:/switch/SW2RPGMGL/games/SampleMZ',
      'sdmc:/switch/SW2RPGMGL/SW2RPGMGL.nro',
    ];
    mod.initLog('mz.log', 'RPG Maker MZ Engine (WebGL2)');
    assert.equal(mod.getLogPath(), 'sdmc:/switch/SW2RPGMGL/log/mz.log');

    const mzGame = mod.inspectSingleMzGame(logSw, 'sdmc:/switch/SW2RPGMGL/games/SampleMZ');
    const mzAssets = mod.createAssetReader(mzGame.wwwRoot, logSw);
    const mzDiag = mod.logGameDiagnostics(logSw, mzGame, mzAssets, {
      rendererMode: 'Hardware WebGL2 (OunceVK ES3)',
    });
    assert.equal(mzDiag.configuredResolution, '1280x720 (UI 1152x648)');
    assert.match(mzDiag.encryptionSummary, /KageDesu \/ PKD Protector/);
    assert.match(mzDiag.encryptionSummary, /Standard MZ \(\.png_\/\.ogg_\)/);

    const mzLogText = new TextDecoder().decode(logSw.readFileSync('sdmc:/switch/SW2RPGMGL/log/mz.log'));
    const mvLogAfterMz = new TextDecoder().decode(logSw.readFileSync('sdmc:/switch/SW2RPGMGL/log/mv.log'));
    assert.ok(mzLogText.includes('SW2RPGMGL v0.3.2 — RPG Maker MZ Engine (WebGL2) (mz.log)'));
    assert.ok(mzLogText.includes('Sample MZ Quest'));
    assert.ok(!mzLogText.includes('fedcba9876543210fedcba9876543210'), 'Raw encryptionKey must never leak into mz.log');
    assert.ok(mvLogAfterMz.includes('Sample MV Chronicle'), 'Launching MZ must preserve mv.log intact');
    assert.ok(!mvLogAfterMz.includes('Sample MZ Quest'), 'MZ logs must not bleed into mv.log');
  } finally {
    globalThis.Switch = prevSwitch;
  }

  console.log('[PASS] Per-engine logs (mv.log / mz.log / mkxpz.log), shareable encryption/plugin diagnostics & v0.3.2 sync');
}

// 22. Verify MZ .rmmzsave non-truncating UTF-8 save/load & OpenTypePixelFont OffscreenCanvas prototype sync
{
  const prevTextEncoder = globalThis.TextEncoder;
  const prevC2D = globalThis.CanvasRenderingContext2D;
  const prevOffC2D = globalThis.OffscreenCanvasRenderingContext2D;
  const prevOffCanvas = globalThis.OffscreenCanvas;
  const prevNativeDollar = globalThis.$;

  try {
    // 1) Simulate upstream nx.js's buggy 1.5x TextEncoder that truncates >50% high-byte deflate strings!
    class BuggyNxTextEncoder {
      encode(input = '') {
        const len = input.length;
        const tlen = Math.max(32, len + (len >>> 1) + 7);
        const target = new Uint8Array((tlen >>> 3) << 3);
        let at = 0;
        for (let pos = 0; pos < len; pos++) {
          const v = input.charCodeAt(pos);
          if (v < 0x80) target[at++] = v;
          else if (v < 0x800) {
            target[at++] = ((v >>> 6) & 0x1f) | 0xc0;
            target[at++] = (v & 0x3f) | 0x80;
          } else {
            target[at++] = ((v >>> 12) & 0x0f) | 0xe0;
            target[at++] = ((v >>> 6) & 0x3f) | 0x80;
            target[at++] = (v & 0x3f) | 0x80;
          }
        }
        return target.slice(0, at);
      }
    }
    const nxPrivateEncoder = new BuggyNxTextEncoder();
    globalThis.TextEncoder = BuggyNxTextEncoder;

    // Build a binary string with ~85% bytes >= 0x80 (guaranteed to overflow 1.5x buffer before fix!)
    let highByteZip = '';
    for (let i = 0; i < 4096; i++) {
      highByteZip += String.fromCharCode((i % 7 === 0) ? (i & 0x7f) : (0x80 | (i & 0x7f)));
    }
    // Sanity-check that unpatched BuggyNxTextEncoder really did corrupt it:
    assert.ok(nxPrivateEncoder.encode(highByteZip).byteLength < 7000, 'Unpatched 1.5x encoder truncates high-byte string');

    // Installing browser-host / node-compat must patch BuggyNxTextEncoder.prototype.encode IN PLACE
    // (fixing nxPrivateEncoder too!) and write/read full binary strings via fs.writeFileSync / readFileSync!
    const saveSw = createMockSwitch({});
    saveSw.writeFileSync = (p, val) => {
      const bytes = typeof val === 'string' ? nxPrivateEncoder.encode(val) : new Uint8Array(val);
      saveSw._files.set(p.replace(/\/+$/, ''), bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    };
    const saveRt = { TextEncoder: BuggyNxTextEncoder };
    mod.installNodeCompat(saveRt, saveSw, 'sdmc:/switch/SW2RPGMGL/games/Haven', 'sdmc:/switch/SW2RPGMGL/games/Haven/save');

    // Even nxPrivateEncoder (already instantiated before installNodeCompat) is now fixed via prototype!
    const fixedBytes = nxPrivateEncoder.encode(highByteZip);
    assert.equal(mod.decodeUtf8Safe(fixedBytes), highByteZip, 'Patched TextEncoder.prototype.encode must preserve 100% of bytes');

    const fsShim = saveRt.require('fs');
    fsShim.writeFileSync('sdmc:/switch/SW2RPGMGL/games/Haven/save/file1.rmmzsave', highByteZip);
    const loadedZip = fsShim.readFileSync('sdmc:/switch/SW2RPGMGL/games/Haven/save/file1.rmmzsave', { encoding: 'utf8' });
    assert.equal(loadedZip.length, highByteZip.length, '.rmmzsave length must match 100% after round-trip');
    assert.equal(loadedZip, highByteZip, '.rmmzsave content must round-trip bit-for-bit');

    // 2) Simulate separate CanvasRenderingContext2D vs OffscreenCanvasRenderingContext2D + $.canvasContext2dMeasureTextWidth
    //    (matching real Switch 2 nx.js) + OpenTypePixelFont.js!
    const pathDraws = [];
    class MockScreenCtx2D {
      constructor() { this._nativeFont = ''; this.font = '10px sans-serif'; }
      get font() { return this._nativeFont; }
      set font(v) {
        // Mirror nx.js: `if (!v || this.font === v) return;` + early return on unregistered families
        if (!v || this.font === v) return;
        if (/rmmz-tinyfont|Tiny Pixel/i.test(v)) return;
        this._nativeFont = v;
      }
      save() {}
      restore() {}
      beginPath() {}
      closePath() {}
      moveTo() {}
      lineTo() {}
      fill() { pathDraws.push('screen-fill'); }
      stroke() {}
      measureText(t) { return { width: String(t).length * 20 }; }
      fillText() { pathDraws.push('screen-native-fillText'); }
      strokeText() {}
    }
    class MockOffscreenCtx2D {
      constructor() { this._nativeFont = ''; this.font = '10px sans-serif'; }
      get font() { return this._nativeFont; }
      set font(v) {
        // Mirror nx.js: `if (!v || this.font === v) return;` + early return on unregistered families
        if (!v || this.font === v) return;
        if (/rmmz-tinyfont|Tiny Pixel/i.test(v)) return;
        this._nativeFont = v;
      }
      save() {}
      restore() {}
      beginPath() {}
      closePath() {}
      moveTo() {}
      lineTo() {}
      fill() { pathDraws.push(`offscreen-glyph-fill:${this.font}`); }
      stroke() { pathDraws.push(`offscreen-glyph-stroke:${this.font}`); }
      measureText(t) { return { width: String(t).length * 20 }; }
      fillText() { pathDraws.push('BROKEN-native-fillText'); }
      strokeText() { pathDraws.push('BROKEN-native-strokeText'); }
    }
    globalThis.CanvasRenderingContext2D = MockScreenCtx2D;
    globalThis.OffscreenCanvasRenderingContext2D = MockOffscreenCtx2D;
    globalThis.OffscreenCanvas = class {
      constructor(w = 1, h = 1) { this.width = w; this.height = h; this._c = null; }
      getContext(k) { return k === '2d' ? (this._c ||= new MockOffscreenCtx2D()) : null; }
    };
    // Simulate Switch 2 native HarfBuzz width hook (returns huge 20px/char width if OpenTypePixelFont is bypassed!)
    globalThis.$ = { canvasContext2dMeasureTextWidth: (_ctx, str) => str.length * 20 };

    // Simulate OpenTypePixelFont.js installing its hooks ONLY onto CanvasRenderingContext2D.prototype
    const fakeOpenFont = {
      familyName: 'rmmz-tinyfont',
      shouldSquishText: false,
      snap: true,
    };
    MockScreenCtx2D.prototype._groupTextForDrawing = function (t, f) {
      const g = [{ text: String(t), font: fakeOpenFont, width: String(t).length * 5, scale: 1 }];
      g.width = String(t).length * 5;
      g.advanceWidth = g.width;
      g.parsedSize = f.size;
      return g;
    };
    MockScreenCtx2D.prototype._pathText = function (g, f, x, y) {
      return {
        commands: [
          { type: 'M', x, y },
          { type: 'L', x: x + f.size, y },
          { type: 'Z' },
        ],
      };
    };
    MockScreenCtx2D.prototype._fillText = function (g, f, x, y, w) {
      const p = this._pathText(g, f, x, y, w);
      if (p.commands.length) { this.beginPath(); this.fill(); }
    };
    MockScreenCtx2D.prototype._strokeText = function (g, f, x, y, w) {
      const p = this._pathText(g, f, x, y, w);
      if (p.commands.length) { this.beginPath(); this.stroke(); }
    };
    MockScreenCtx2D.prototype.measureText = function (t, w) {
      const m = /(\d+)px\s+(.+)/.exec(this.font);
      const f = { fontSize: (m?.[1] || '16') + 'px', size: Number(m?.[1] || 16), fontFamily: (m?.[2] || '').toLowerCase(), fontStyle: 'normal', isOpenFont: true };
      return this._groupTextForDrawing(t, f, w);
    };
    MockScreenCtx2D.prototype.fillText = function (t, x, y, w) {
      const groups = this.measureText(t, w);
      const m = /(\d+)px\s+(.+)/.exec(this.font);
      const f = { fontSize: (m?.[1] || '16') + 'px', size: Number(m?.[1] || 16), fontFamily: (m?.[2] || '').toLowerCase(), fontStyle: 'normal', isOpenFont: true };
      for (const g of groups) this._fillText(g, f, x, y, g.width);
    };
    MockScreenCtx2D.prototype.strokeText = function (t, x, y, w) {
      const groups = this.measureText(t, w);
      const m = /(\d+)px\s+(.+)/.exec(this.font);
      const f = { fontSize: (m?.[1] || '16') + 'px', size: Number(m?.[1] || 16), fontFamily: (m?.[2] || '').toLowerCase(), fontStyle: 'normal', isOpenFont: true };
      for (const g of groups) this._strokeText(g, f, x, y, g.width);
    };

    const dummyAssets = mod.createAssetReader('sdmc:/g', createMockSwitch({}));
    const host = mod.createBrowserHost(dummyAssets, (_p, s) => s, { width: 1280, height: 720, getContext: () => null }, { enableWebGL: true });
    // Even if a canvas was created BEFORE installMzCompat, wrapper must pick up OpenTypePixelFont once synced!
    const preCanvas = globalThis.document.createElement('canvas');
    const preCtx = preCanvas.getContext('2d');

    mod.installMzCompat(
      globalThis,
      host,
      mod.createInputBridge(),
      { id: 'h', folderName: 'Haven', engine: 'mz', title: 'Haven', gameDir: '/g', wwwRoot: '/g', saveDir: '/g/save', iconPath: null, pluginCount: 1, saveCount: 0, locale: '', encrypted: false, config: {} },
      {},
    );

    // Verify splash/native Skia fonts (e.g. MZ WebGL splash OffscreenCanvas & MV screen ctx) are NOT
    // short-circuited by nx.js's `if (this.font === v) return;` check after installFontLeakGuard!
    const splashCanvas = new globalThis.OffscreenCanvas(1280, 720);
    const splashCtx = splashCanvas.getContext('2d');
    assert.equal(splashCtx._nativeFont, '10px sans-serif', 'Newly constructed OffscreenCanvas must initialize native 10px sans-serif font');
    splashCtx.font = '40px sans-serif';
    assert.equal(splashCtx._nativeFont, '40px sans-serif', 'Native Skia font must update to 40px sans-serif for MZ/MV splash screen');
    splashCtx.font = 'bold 24px sans-serif';
    assert.equal(splashCtx._nativeFont, '24px sans-serif', 'Bold weight stripped for Skia leak guard while updating pixel size to 24px');
    assert.equal(splashCtx.font, 'bold 24px sans-serif', 'Logical CSS font retains bold weight');

    preCtx.font = '8px rmmz-tinyfont';
    assert.equal(preCtx.font, '8px rmmz-tinyfont', 'Logical CSS font must be preserved even when Skia FontFaceSet lacks virtual family');
    const measured = preCtx.measureText('Latest Save');
    assert.equal(measured.width, 55, 'wrapper.measureText must use OpenTypePixelFont width (5px/ch) instead of native HarfBuzz (20px/ch)');
    preCtx.lineWidth = 4;
    preCtx.strokeText('Latest Save', 10, 20, 200);
    preCtx.fillText('Latest Save', 10, 20, 200);
    assert.ok(!pathDraws.includes('BROKEN-native-fillText'), 'OffscreenCanvas Bitmap must never fall back to oversized native fillText');
    assert.ok(pathDraws.includes('offscreen-glyph-fill:8px rmmz-tinyfont'), 'OffscreenCanvas Bitmap must render crisp OpenTypePixelFont glyph paths');
  } finally {
    globalThis.TextEncoder = prevTextEncoder;
    globalThis.CanvasRenderingContext2D = prevC2D;
    globalThis.OffscreenCanvasRenderingContext2D = prevOffC2D;
    globalThis.OffscreenCanvas = prevOffCanvas;
    globalThis.$ = prevNativeDollar;
  }

  console.log('[PASS] Non-truncating MZ .rmmzsave TextEncoder & OpenTypePixelFont OffscreenCanvas prototype sync');
}

console.log('\nALL UNIVERSAL SW2RPGMGL TESTS PASSED!');
