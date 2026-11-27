/**
 * Universal RPG Maker MZ compatibility & hardware WebGL2 (OunceVK / GLES3) layer
 * for Nintendo Switch 2 (kaiHEN / nx.js).
 */
import type { AssetReader } from './assets';
import { syncCanvas2DPluginPrototypes, type BrowserHost, type DisplayMode, type ScriptFilter } from './browser-host';
import type { GameEntry } from './games';
import type { InputBridge } from './input';
import { getSwitch, log } from './log';
import { foldObfuscatedStringTable } from './mv-compat';
import { drawPerfHud, HUD_MODE_LABELS, nextHudMode, type HudMode } from './perf-hud';

export const DEFAULT_MZ_SCRIPTS: string[] = [
  'js/libs/pixi.js',
  'js/libs/pako.min.js',
  'js/libs/localforage.min.js',
  'js/libs/effekseer.min.js',
  'js/libs/vorbisdecoder.js',
  'js/rmmz_core.js',
  'js/rmmz_managers.js',
  'js/rmmz_objects.js',
  'js/rmmz_scenes.js',
  'js/rmmz_sprites.js',
  'js/rmmz_windows.js',
  'js/plugins.js',
];

/**
 * Parse `const scriptUrls = [...]` from RPG Maker MZ's `js/main.js` if customized,
 * falling back to MZ's standard 12-script boot order.
 */
export function extractMzMainScripts(mainJsSource: string): string[] {
  const m = /scriptUrls\s*=\s*\[([\s\S]*?)\]/.exec(mainJsSource);
  if (!m) return [...DEFAULT_MZ_SCRIPTS];
  const urls: string[] = [];
  const re = /["']([^"']+\.js)["']/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(m[1])) !== null) {
    const u = hit[1].trim();
    if (u && !urls.includes(u)) urls.push(u);
  }
  return urls.length >= 6 ? urls : [...DEFAULT_MZ_SCRIPTS];
}

const DEFAULT_SKIP_MZ_PLUGINS = [
  'makescreencapture',
  'makescreenmovie',
  'recscene',
  'shiro_steamworksapi',
  'greenworks',
  'steamworks',
  'nwjs_devtools',
];

const UNICODE_PROP_FALLBACKS: Record<string, string> = {
  L: 'A-Za-z\\u00C0-\\u024F\\u0370-\\u1FFF\\u3040-\\u30FF\\u3400-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF',
  Letter: 'A-Za-z\\u00C0-\\u024F\\u0370-\\u1FFF\\u3040-\\u30FF\\u3400-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF',
  N: '0-9\\uFF10-\\uFF19',
  Number: '0-9\\uFF10-\\uFF19',
  Nd: '0-9\\uFF10-\\uFF19',
  Pc: '_',
  M: '\\u0300-\\u036F',
  Cf: '\\u200B-\\u200F\\uFEFF',
  P: '\\u0021-\\u002F\\u003A-\\u0040\\u005B-\\u0060\\u007B-\\u007E\\u2000-\\u206F\\u3000-\\u303F\\uFF01-\\uFF0F',
  S: '$+<=>^|~',
  Z: ' \\u00A0\\u3000',
  C: '\\u0000-\\u001F\\u007F-\\u009F',
};

/**
 * Rewrite ES2018 `\p{...}` Unicode property escapes into BMP character ranges so
 * V8 built without full ICU (`v8_enable_i18n_support=false`) parses MZ plugins like `Fs.js`.
 */
export function rewriteUnsupportedUnicodeProps(source: string): string {
  if (!source.includes('\\p{') && !source.includes('\\P{')) return source;
  return source.replace(/\\p\{([^}]+)\}/g, (_match, rawProp: string) => {
    const key = String(rawProp).trim().replace(/^General_Category=/i, '');
    return UNICODE_PROP_FALLBACKS[key] ?? 'A-Za-z0-9_';
  });
}

/**
 * Hoist top-level `const`, `let`, and `class` declarations to `var` so separate
 * `(0, eval)(...)` plugin loads share global bindings just like browser `<script>` tags
 * (e.g. `NUUN_Base.js`'s `const NUUN_Base_Ver = 140;` read by `NUUN_BattleStyleEX_Default.js`).
 */
export function hoistTopLevelLexicals(source: string): string {
  const len = source.length;
  let out = '';
  let lastEmit = 0;
  let i = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  // Track template literal `${ ... }` brace depth stack
  const tplBraceStack: number[] = [];
  // Track top-level `class Name { ... }` closing brace so we can export to globalThis without ASI hazards
  let pendingClassExport: string | null = null;
  let expectingClassBody = false;
  // Track whether the previous significant token allows a regex literal (`/`)
  let canStartRegex = true;

  const isIdentStart = (c: number) =>
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c >= 128;
  const isIdentPart = (c: number) =>
    isIdentStart(c) || (c >= 48 && c <= 57);

  while (i < len) {
    const ch = source.charCodeAt(i);

    // Line comment
    if (ch === 47 /* / */ && i + 1 < len && source.charCodeAt(i + 1) === 47) {
      const nl = source.indexOf('\n', i + 2);
      i = nl < 0 ? len : nl;
      continue;
    }

    // Block comment
    if (ch === 47 /* / */ && i + 1 < len && source.charCodeAt(i + 1) === 42 /* * */) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? len : end + 2;
      continue;
    }

    // Regex literal
    if (ch === 47 /* / */ && canStartRegex) {
      i++;
      let inClass = false;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c === 92 /* \ */) { i += 2; continue; }
        if (c === 91 /* [ */) { inClass = true; i++; continue; }
        if (c === 93 /* ] */) { inClass = false; i++; continue; }
        if (c === 47 /* / */ && !inClass) { i++; break; }
        if (c === 10 || c === 13) break;
        i++;
      }
      while (i < len && isIdentPart(source.charCodeAt(i))) i++;
      canStartRegex = false;
      continue;
    }

    // Single or double quoted string
    if (ch === 34 /* " */ || ch === 39 /* ' */) {
      const quote = ch;
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c === 92 /* \ */) { i += 2; continue; }
        if (c === quote) { i++; break; }
        if (c === 10 || c === 13) break;
        i++;
      }
      canStartRegex = false;
      continue;
    }

    // Template literal
    if (ch === 96 /* ` */) {
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c === 92 /* \ */) { i += 2; continue; }
        if (c === 96 /* ` */) { i++; break; }
        if (c === 36 /* $ */ && i + 1 < len && source.charCodeAt(i + 1) === 123 /* { */) {
          tplBraceStack.push(braceDepth);
          braceDepth++;
          i += 2;
          canStartRegex = true;
          break;
        }
        i++;
      }
      if (i <= len && source.charCodeAt(i - 1) === 96) canStartRegex = false;
      continue;
    }

    // Braces / Parens / Brackets
    if (ch === 123 /* { */) {
      if (braceDepth === 0 && expectingClassBody) expectingClassBody = false;
      braceDepth++;
      i++;
      canStartRegex = true;
      continue;
    }
    if (ch === 125 /* } */) {
      braceDepth = Math.max(0, braceDepth - 1);
      i++;
      // Resume template literal if closing `${ ... }`
      if (tplBraceStack.length > 0 && braceDepth === tplBraceStack[tplBraceStack.length - 1]) {
        tplBraceStack.pop();
        while (i < len) {
          const c = source.charCodeAt(i);
          if (c === 92 /* \ */) { i += 2; continue; }
          if (c === 96 /* ` */) { i++; break; }
          if (c === 36 /* $ */ && i + 1 < len && source.charCodeAt(i + 1) === 123 /* { */) {
            tplBraceStack.push(braceDepth);
            braceDepth++;
            i += 2;
            canStartRegex = true;
            break;
          }
          i++;
        }
        if (source.charCodeAt(i - 1) === 96) canStartRegex = false;
      } else {
        if (braceDepth === 0 && pendingClassExport && !expectingClassBody) {
          const cls = pendingClassExport;
          pendingClassExport = null;
          out += source.slice(lastEmit, i) + `;globalThis[${JSON.stringify(cls)}]=${cls};`;
          lastEmit = i;
        }
        canStartRegex = true;
      }
      continue;
    }
    if (ch === 40 /* ( */) { parenDepth++; i++; canStartRegex = true; continue; }
    if (ch === 41 /* ) */) { parenDepth = Math.max(0, parenDepth - 1); i++; canStartRegex = false; continue; }
    if (ch === 91 /* [ */) { bracketDepth++; i++; canStartRegex = true; continue; }
    if (ch === 93 /* ] */) { bracketDepth = Math.max(0, bracketDepth - 1); i++; canStartRegex = false; continue; }

    // Whitespace
    if (ch <= 32) { i++; continue; }

    // Identifiers / keywords
    if (isIdentStart(ch)) {
      const start = i;
      i++;
      while (i < len && isIdentPart(source.charCodeAt(i))) i++;
      const word = source.slice(start, i);

      // Check previous non-whitespace char to avoid rewriting property access like `obj.const`
      let prevIdx = start - 1;
      while (prevIdx >= 0 && source.charCodeAt(prevIdx) <= 32) prevIdx--;
      const prevChar = prevIdx >= 0 ? source.charCodeAt(prevIdx) : 0;
      const isProp = prevChar === 46 /* . */;

      if (!isProp && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        if (word === 'const' || word === 'let') {
          // Ensure followed by whitespace, `{`, or `[` (actual declaration, not `let = 1`)
          let j = i;
          while (j < len && source.charCodeAt(j) <= 32) j++;
          const nextCh = j < len ? source.charCodeAt(j) : 0;
          if (
            j > i &&
            (isIdentStart(nextCh) || nextCh === 123 /* { */ || nextCh === 91 /* [ */)
          ) {
            out += source.slice(lastEmit, start) + 'var';
            lastEmit = i;
            canStartRegex = true;
            continue;
          }
        } else if (
          word === 'class' &&
          prevChar !== 61 /* = */ &&
          prevChar !== 40 /* ( */ &&
          prevChar !== 44 /* , */ &&
          prevChar !== 58 /* : */ &&
          prevChar !== 63 /* ? */
        ) {
          // Top-level named `class Foo ... { ... }` -> keep declaration intact & export to globalThis after `}`
          let j = i;
          while (j < len && source.charCodeAt(j) <= 32) j++;
          if (j > i && j < len && isIdentStart(source.charCodeAt(j))) {
            const nameStart = j;
            j++;
            while (j < len && isIdentPart(source.charCodeAt(j))) j++;
            const className = source.slice(nameStart, j);
            if (className !== 'extends') {
              pendingClassExport = className;
              expectingClassBody = true;
              canStartRegex = false;
              continue;
            }
          }
        }
      }

      canStartRegex =
        word === 'return' || word === 'case' || word === 'throw' || word === 'in' ||
        word === 'of' || word === 'typeof' || word === 'void' || word === 'delete' ||
        word === 'new' || word === 'else' || word === 'do' || word === 'yield' || word === 'await';
      continue;
    }

    // Punctuation / numbers
    if (ch >= 48 && ch <= 57) {
      i++;
      while (i < len && (isIdentPart(source.charCodeAt(i)) || source.charCodeAt(i) === 46)) i++;
      canStartRegex = false;
      continue;
    }

    // Operators & punctuation (`+`, `-`, `*`, `=`, `,`, `;`, `:`, `?`, `!`, `&`, `|`, `^`, `~`, `<`, `>`, `%`)
    canStartRegex = !(ch === 46 /* . */);
    i++;
  }

  if (lastEmit === 0) return source;
  return out + source.slice(lastEmit);
}

export function createMzScriptPreparer(extraSkipPlugins?: string[]): ScriptFilter {
  const skipSet = new Set<string>(DEFAULT_SKIP_MZ_PLUGINS);
  if (Array.isArray(extraSkipPlugins)) {
    for (const s of extraSkipPlugins) {
      const clean = String(s ?? '').trim().toLowerCase().replace(/\.js$/i, '');
      if (clean) skipSet.add(clean);
    }
  }
  return (path: string, source: string): string | null => {
    const lower = path.replace(/\\/g, '/').toLowerCase();
    // Skip effekseer.min.js & vorbisdecoder.js because we shim Effekseer (wasm=off)
    // and use nx.js's native C++ FFmpeg WebAudio decoder for .ogg/.ogg_.
    if (lower.endsWith('/effekseer.min.js') || lower.endsWith('/vorbisdecoder.js')) {
      return '';
    }
    if (lower.includes('/plugins/')) {
      const base = (lower.split('/').pop() || '').replace(/\.js$/i, '');
      if (skipSet.has(base)) {
        return null;
      }
      let out = rewriteUnsupportedUnicodeProps(source);
      out = foldObfuscatedStringTable(out, path);
      out = hoistTopLevelLexicals(out);
      return out;
    }
    if (lower.endsWith('/js/plugins.js') || lower === 'js/plugins.js') {
      return hoistTopLevelLexicals(source);
    }
    return source;
  };
}

/**
 * Install safe Effekseer shim (for `wasm = off`) before `rmmz_core.js` runs.
 * Battle and map animations still play all sound effects and flashes cleanly.
 */
export function installEffekseerShim(runtime: Record<string, any>): void {
  runtime.effekseer = {
    initRuntime(_wasmUrl: string, onLoad?: () => void, _onError?: () => void) {
      log('[mz-effekseer] WebAssembly disabled (jit=off) -> using lightweight no-op Effekseer shim');
      if (typeof onLoad === 'function') setTimeout(onLoad, 0);
    },
    createContext() {
      return null;
    },
    setLogEnabled() {},
  };
}

/**
 * Convert WOFF 1.0 (`wOFF` + zlib-compressed SFNT tables) to a raw TrueType/OpenType
 * SFNT `ArrayBuffer` that FreeType / Skia (`nx.js` `FontFace`) can render cleanly.
 * Passes valid raw TTF/OTF/TTC files through unchanged; returns `null` for unsupported
 * formats (such as `.woff2` Brotli) so we never register a broken tofu-box font face.
 */
export function decodeWoffToSfnt(
  raw: ArrayBuffer,
  inflate?: (data: Uint8Array) => Uint8Array,
): ArrayBuffer | null {
  if (!raw || raw.byteLength < 12) return null;
  const view = new DataView(raw);
  const sig = view.getUint32(0, false);

  // Already a valid raw SFNT / TrueType / OpenType / TTC font
  if (
    sig === 0x00010000 || // TrueType
    sig === 0x4f54544f || // 'OTTO' (CFF OpenType)
    sig === 0x74727565 || // 'true' (Apple TrueType)
    sig === 0x74746366    // 'ttcf' (TrueType Collection)
  ) {
    return raw;
  }

  // WOFF 1.0 ('wOFF' = 0x774F4646)
  if (sig !== 0x774f4646 || raw.byteLength < 44) return null;

  const flavor = view.getUint32(4, false);
  const numTables = view.getUint16(12, false);
  const totalSfntSize = view.getUint32(16, false);
  if (numTables === 0 || 44 + numTables * 20 > raw.byteLength) return null;

  interface WoffEntry {
    tag: number;
    offset: number;
    compLength: number;
    origLength: number;
    origChecksum: number;
  }
  const entries: WoffEntry[] = [];
  for (let i = 0; i < numTables; i++) {
    const off = 44 + i * 20;
    entries.push({
      tag: view.getUint32(off, false),
      offset: view.getUint32(off + 4, false),
      compLength: view.getUint32(off + 8, false),
      origLength: view.getUint32(off + 12, false),
      origChecksum: view.getUint32(off + 16, false),
    });
  }

  // Compute SFNT offset table fields
  let entrySelector = 0;
  let searchRange = 16;
  while (searchRange * 2 <= numTables * 16) {
    searchRange *= 2;
    entrySelector++;
  }
  const rangeShift = numTables * 16 - searchRange;

  // Compute exact output buffer size (12-byte header + 16*numTables directory + 4-byte aligned tables)
  const dirEnd = 12 + numTables * 16;
  let calcSize = dirEnd;
  for (const e of entries) {
    calcSize += (e.origLength + 3) & ~3;
  }
  const outSize = Math.max(totalSfntSize, calcSize);
  const outBuf = new ArrayBuffer(outSize);
  const outBytes = new Uint8Array(outBuf);
  const outView = new DataView(outBuf);

  outView.setUint32(0, flavor, false);
  outView.setUint16(4, numTables, false);
  outView.setUint16(6, searchRange, false);
  outView.setUint16(8, entrySelector, false);
  outView.setUint16(10, rangeShift, false);

  const srcBytes = new Uint8Array(raw);
  let writeOff = dirEnd;
  for (let i = 0; i < numTables; i++) {
    const e = entries[i];
    if (e.offset + e.compLength > srcBytes.byteLength) return null;
    const compSlice = srcBytes.subarray(e.offset, e.offset + e.compLength);
    let tableData: Uint8Array;
    if (e.compLength < e.origLength) {
      if (typeof inflate !== 'function') return null;
      tableData = inflate(compSlice);
      if (!tableData || tableData.byteLength < e.origLength) return null;
    } else {
      tableData = compSlice;
    }

    const dirOff = 12 + i * 16;
    outView.setUint32(dirOff, e.tag, false);
    outView.setUint32(dirOff + 4, e.origChecksum, false);
    outView.setUint32(dirOff + 8, writeOff, false);
    outView.setUint32(dirOff + 12, e.origLength, false);

    outBytes.set(tableData.subarray(0, e.origLength), writeOff);
    writeOff += (e.origLength + 3) & ~3;
  }

  return outBuf;
}

/**
 * Discover and pre-register usable TTF/OTF/WOFF1 fonts in `fonts/`, converting WOFF 1.0
 * (`mplus-1m-regular.woff` etc.) to raw SFNT TTF/OTF via `pako.inflate` so Skia/FreeType
 * renders crisp glyphs instead of tofu boxes, and falling back cleanly for `.woff2`.
 */
export async function installMzFontCompat(
  runtime: Record<string, any>,
  assets: AssetReader,
): Promise<void> {
  const NativeFontFace = runtime.FontFace;
  const fontSet = runtime.fonts || runtime.document?.fonts;
  const pakoInflate: ((data: Uint8Array) => Uint8Array) | undefined =
    typeof runtime.pako?.inflate === 'function'
      ? (data: Uint8Array) => runtime.pako.inflate(data)
      : undefined;

  let decodedWoffCount = 0;
  const decodeFont = (raw: ArrayBuffer | null, label: string): ArrayBuffer | null => {
    if (!raw || raw.byteLength < 64) return null;
    const sig = new DataView(raw).getUint32(0, false);
    try {
      const sfnt = decodeWoffToSfnt(raw, pakoInflate);
      if (sfnt && sig === 0x774f4646) {
        decodedWoffCount++;
      }
      return sfnt;
    } catch (err) {
      log(`[mz-fonts] WOFF decode failed for '${label}': ${String(err)}`);
      return null;
    }
  };

  const loadedBytesByFile = new Map<string, ArrayBuffer>();
  const registeredFamilies = new Set<string>();
  let fallbackFontBytes: ArrayBuffer | null = null;
  let fallbackFontName = '';

  const fontFiles = assets.readDirSync('fonts');
  // Prefer .ttf/.otf first, then .woff (decompressed via pako -> TTF/OTF)
  const ordered = [
    ...fontFiles.filter((f) => /\.(?:ttf|otf)$/i.test(f)),
    ...fontFiles.filter((f) => /\.woff$/i.test(f)),
  ];

  for (const file of ordered) {
    const raw = await assets.read(`fonts/${file}`);
    const ab = decodeFont(raw, file);
    if (!ab) continue;
    loadedBytesByFile.set(file.toLowerCase(), ab);
    if (!fallbackFontBytes) {
      fallbackFontBytes = ab;
      fallbackFontName = file;
    }
    const baseFamily = file.replace(/\.[^.]+$/, '');
    try {
      if (NativeFontFace && fontSet) {
        const face = new NativeFontFace(baseFamily, ab);
        await Promise.resolve(face.load?.()).catch(() => {});
        fontSet.add?.(face);
        registeredFamilies.add(baseFamily);
      }
    } catch (err) {
      log(`[mz-fonts] skipped '${file}': ${String(err)}`);
    }
  }
  if (loadedBytesByFile.size > 0) {
    log(
      `[mz-fonts] registered ${loadedBytesByFile.size} font file(s)` +
      `${decodedWoffCount > 0 ? ` (${decodedWoffCount} WOFF1->SFNT)` : ''}` +
      `${fallbackFontName ? `, default=${fallbackFontName}` : ''}`,
    );
  }

  const registerFamilyFromUrl = async (family: string, url: string): Promise<boolean> => {
    const cleanUrl = String(url ?? '').replace(/^url\(["']?|["']?\)$/gi, '').trim();
    const fileName = (cleanUrl.split('/').pop() || '').toLowerCase();
    let ab = loadedBytesByFile.get(fileName) || null;
    if (!ab && cleanUrl && !/\.woff2$/i.test(cleanUrl)) {
      const raw = await assets.read(cleanUrl);
      const decoded = decodeFont(raw, fileName || cleanUrl);
      if (decoded) {
        ab = decoded;
        loadedBytesByFile.set(fileName, ab);
      }
    }
    if (!ab && fallbackFontBytes) {
      log(`[mz-fonts] '${family}' (${fileName || cleanUrl}) unsupported/missing -> falling back to '${fallbackFontName}'`);
      ab = fallbackFontBytes;
    }
    if (!ab || !NativeFontFace || !fontSet) return false;
    try {
      const face = new NativeFontFace(family, ab);
      await Promise.resolve(face.load?.()).catch(() => {});
      fontSet.add?.(face);
      registeredFamilies.add(family);
      return true;
    } catch (err) {
      if (fallbackFontBytes && ab !== fallbackFontBytes) {
        try {
          const fb = new NativeFontFace(family, fallbackFontBytes);
          await Promise.resolve(fb.load?.()).catch(() => {});
          fontSet.add?.(fb);
          log(`[mz-fonts] fallback loaded family '${family}' <- ${fallbackFontName}`);
          return true;
        } catch { /* ignore */ }
      }
      log(`[mz-fonts] failed family '${family}': ${String(err)}`);
      return false;
    }
  };

  // Wrap global FontFace for plugins that call `new FontFace(family, "url(fonts/...)")`
  if (NativeFontFace && !NativeFontFace.__drMzWrapped) {
    const WrappedFontFace = function (this: any, family: string, source: any, descriptors?: any) {
      if (typeof source === 'string') {
        const stubFace: any = {
          family,
          status: 'loading',
          loaded: Promise.resolve(),
          load() {
            return registerFamilyFromUrl(family, source).then(() => {
              stubFace.status = 'loaded';
              return stubFace;
            });
          },
        };
        stubFace.loaded = stubFace.load();
        return stubFace;
      }
      return new NativeFontFace(family, source, descriptors);
    } as any;
    WrappedFontFace.__drMzWrapped = true;
    WrappedFontFace.prototype = NativeFontFace.prototype;
    runtime.FontFace = WrappedFontFace;
  }

  // Override FontManager.startLoading directly when present
  const FontManager = runtime.FontManager;
  if (FontManager && !FontManager.__drMzPatched) {
    FontManager.__drMzPatched = true;
    FontManager.startLoading = function (family: string, url: string) {
      this._urls[family] = url;
      this._states[family] = 'loading';
      void registerFamilyFromUrl(family, url).then(() => {
        this._states[family] = 'loaded';
      });
    };
  }
}

export interface MzCompatOptions {
  returnNroPath?: string | null;
  onFatalError?: (title: string, detail: string) => void;
}

const DISPLAY_MODES: DisplayMode[] = ['fit', 'pixel', 'stretch'];

/**
 * Universal RPG Maker MZ runtime fast-paths for Switch 2 (`--jitless` V8 + OunceVK WebGL2):
 *  1. Flat `Float32Array` `Tilemap.Layer` rect storage + exact subarray VBO upload + empty-layer skip
 *  2. Skip 30-frame `_addAllSpots` full tilemap rebuilds when no animated A1 tiles are on screen,
 *     short-circuit `tileId <= 0` in `_addSpotTile`, and eliminate per-tile `Object.keys()` in `VisuMZ` `isTileExtended`
 *  3. Zero-allocation `O(N)` sorted check + insertion sort for `Tilemap.prototype._sortChildren`
 *  4. Zero-allocation `WindowLayer.prototype.render` (skip `new PIXI.Graphics()` leak & stencil clear when 0–1 windows open, pool `PIXI.Graphics` when 2+ open)
 *  5. Fast-skip closed `Window` transforms, idle `Sprite_Clickable` gamepad frames, inactive `CGMZ` light sprites, and empty/transparent `Sprite_Character`s
 */
function installMzRuntimeFastPaths(runtime: Record<string, any>): void {
  if (runtime.__drMzFastPathsInstalled) return;
  runtime.__drMzFastPathsInstalled = true;

  const {
    PIXI,
    Bitmap,
    ColorFilter,
    Sprite,
    TilingSprite,
    Tilemap,
    Window,
    Window_Base,
    Window_Selectable,
    WindowLayer,
    Sprite_Clickable,
    Sprite_Character,
    Sprite_Picture,
    Sprite_Gauge,
    Sprite_StateIcon,
    Spriteset_Battle,
    Scene_MenuBase,
    Game_Map,
  } = runtime;

  // 0. Coalesce redundant PIXI.BaseTexture.prototype.update() calls within the same render frame
  //    (e.g. Bitmap.clear + blt + multiple drawText calls on the same window/gauge in one tick)
  //    and skip empty-string Bitmap.prototype.drawText("") calls that dirty baseTexture for nothing.
  let renderEpoch = 1;
  let insideRender = false;
  const RendererProto = PIXI?.Renderer?.prototype;
  const BaseTexProto = PIXI?.BaseTexture?.prototype;
  if (
    RendererProto &&
    BaseTexProto &&
    typeof RendererProto.render === 'function' &&
    typeof BaseTexProto.update === 'function' &&
    !BaseTexProto.__drCoalescedUpdate
  ) {
    BaseTexProto.__drCoalescedUpdate = true;
    const origRendererRender = RendererProto.render;
    RendererProto.render = function () {
      renderEpoch = (renderEpoch + 1) | 0;
      const prevInside = insideRender;
      insideRender = true;
      try {
        return origRendererRender.apply(this, arguments);
      } finally {
        insideRender = prevInside;
      }
    };
    const origBtUpdate = BaseTexProto.update;
    BaseTexProto.update = function () {
      const src = this.resource?.source;
      if (
        this._drDirtyEpoch === renderEpoch &&
        (!src || (this.width === src.width && this.height === src.height))
      ) {
        return;
      }
      this._drDirtyEpoch = renderEpoch;
      return origBtUpdate.apply(this, arguments);
    };
  }

  const BmpProto = Bitmap?.prototype;
  if (BmpProto && !BmpProto.__drFastDrawText) {
    BmpProto.__drFastDrawText = true;
    if (typeof BmpProto.drawText === 'function') {
      const origDrawText = BmpProto.drawText;
      BmpProto.drawText = function (text: any) {
        if (text === undefined || text === null || text === '') return;
        return origDrawText.apply(this, arguments);
      };
    }
    if (typeof BmpProto.destroy === 'function') {
      const origBmpDestroy = BmpProto.destroy;
      BmpProto.destroy = function () {
        if (this._drHueRts) {
          for (const k of Object.keys(this._drHueRts)) {
            try { this._drHueRts[k]?.destroy?.(true); } catch { /* ignore */ }
          }
          this._drHueRts = null;
        }
        return origBmpDestroy.apply(this, arguments);
      };
    }
  }

  // 0b. ColorFilter identity auto-bypass + zero-alloc uniform updates:
  //     Stock MZ attaches enabled ColorFilters to Scene, Spriteset, _baseSprite, and every Battler/Sprite,
  //     forcing 10+ full-screen/per-sprite offscreen FBO passes & HSL shader runs per frame even at identity!
  const CfProto = ColorFilter?.prototype;
  if (CfProto && !CfProto.__drFastColorFilter) {
    CfProto.__drFastColorFilter = true;
    const syncColorFilterEnabled = (f: any) => {
      const u = f?.uniforms;
      if (!u) return;
      const ct = u.colorTone;
      const bc = u.blendColor;
      f.enabled = Boolean(
        u.hue !== 0 ||
          (u.brightness !== undefined && u.brightness !== 255) ||
          (ct && (ct[0] !== 0 || ct[1] !== 0 || ct[2] !== 0 || ct[3] !== 0)) ||
          (bc && bc[3] !== 0),
      );
    };
    const origCfInit = CfProto.initialize;
    if (typeof origCfInit === 'function') {
      CfProto.initialize = function () {
        const r = origCfInit.apply(this, arguments);
        syncColorFilterEnabled(this);
        return r;
      };
    }
    if (typeof CfProto.setHue === 'function') {
      CfProto.setHue = function (hue: number) {
        this.uniforms.hue = Number(hue);
        syncColorFilterEnabled(this);
      };
    }
    if (typeof CfProto.setBrightness === 'function') {
      CfProto.setBrightness = function (brightness: number) {
        this.uniforms.brightness = Number(brightness);
        syncColorFilterEnabled(this);
      };
    }
    if (typeof CfProto.setColorTone === 'function') {
      CfProto.setColorTone = function (tone: number[]) {
        if (!Array.isArray(tone)) throw new Error('Argument must be an array');
        let dst = this.uniforms.colorTone;
        if (!Array.isArray(dst) || dst.length !== 4) {
          dst = [0, 0, 0, 0];
          this.uniforms.colorTone = dst;
        }
        dst[0] = tone[0] || 0;
        dst[1] = tone[1] || 0;
        dst[2] = tone[2] || 0;
        dst[3] = tone[3] || 0;
        syncColorFilterEnabled(this);
      };
    }
    if (typeof CfProto.setBlendColor === 'function') {
      CfProto.setBlendColor = function (color: number[]) {
        if (!Array.isArray(color)) throw new Error('Argument must be an array');
        let dst = this.uniforms.blendColor;
        if (!Array.isArray(dst) || dst.length !== 4) {
          dst = [0, 0, 0, 0];
          this.uniforms.blendColor = dst;
        }
        dst[0] = color[0] || 0;
        dst[1] = color[1] || 0;
        dst[2] = color[2] || 0;
        dst[3] = color[3] || 0;
        syncColorFilterEnabled(this);
      };
    }
  }

  // 0c. Sprite.prototype: zero-alloc setColorTone/setBlendColor + indexed update loop skipping empty leaf Sprites
  const SprProto = Sprite?.prototype;
  if (SprProto && !SprProto.__drFastSprite) {
    SprProto.__drFastSprite = true;
    if (
      typeof SprProto.setColorTone === 'function' &&
      String(SprProto.setColorTone).includes('_updateColorFilter')
    ) {
      SprProto.setColorTone = function (tone: number[]) {
        if (!Array.isArray(tone)) throw new Error('Argument must be an array');
        const ct = this._colorTone;
        const r0 = tone[0] || 0;
        const r1 = tone[1] || 0;
        const r2 = tone[2] || 0;
        const r3 = tone[3] || 0;
        if (ct && ct[0] === r0 && ct[1] === r1 && ct[2] === r2 && ct[3] === r3) return;
        if (Array.isArray(ct) && ct.length === 4) {
          ct[0] = r0; ct[1] = r1; ct[2] = r2; ct[3] = r3;
        } else {
          this._colorTone = [r0, r1, r2, r3];
        }
        this._updateColorFilter();
      };
    }
    if (
      typeof SprProto.setBlendColor === 'function' &&
      String(SprProto.setBlendColor).includes('_updateColorFilter')
    ) {
      SprProto.setBlendColor = function (color: number[]) {
        if (!Array.isArray(color)) throw new Error('Argument must be an array');
        const bc = this._blendColor;
        const r0 = color[0] || 0;
        const r1 = color[1] || 0;
        const r2 = color[2] || 0;
        const r3 = color[3] || 0;
        if (bc && bc[0] === r0 && bc[1] === r1 && bc[2] === r2 && bc[3] === r3) return;
        if (Array.isArray(bc) && bc.length === 4) {
          bc[0] = r0; bc[1] = r1; bc[2] = r2; bc[3] = r3;
        } else {
          this._blendColor = [r0, r1, r2, r3];
        }
        this._updateColorFilter();
      };
    }
    const sprUpdSrc = String(SprProto.update ?? '').replace(/\s+/g, '');
    if (sprUpdSrc === 'function(){for(constchildofthis.children){if(child.update){child.update();}}}') {
      const fastSpriteUpdate = function (this: any) {
        const kids = this.children;
        const n = kids ? kids.length : 0;
        for (let i = 0; i < n; i++) {
          const c = kids[i];
          if (c && c.update) {
            if (c.update === fastSpriteUpdate && (!c.children || c.children.length === 0)) continue;
            c.update();
          }
        }
      };
      SprProto.update = fastSpriteUpdate;
    }

    // Pre-bake static image `battlerHue` / `Sprite.setHue` once per (Bitmap, hue) into a shared RenderTexture
    // so hue-shifted enemies batch into 1 draw call instead of running 6+ offscreen FBO HSL passes every frame!
    let sharedHueSpr: any = null;
    let sharedHueFilter: any = null;
    const getOrBakeHueRt = (bmp: any, rawHue: number): any => {
      if (!bmp || !bmp._url || !bmp.isReady?.() || !bmp.baseTexture) return null;
      const w = bmp.width | 0;
      const h = bmp.height | 0;
      if (w <= 0 || h <= 0 || w > 2048 || h > 2048) return null;
      const hKey = Math.round((((rawHue % 360) + 360) % 360) * 100) / 100;
      if (hKey === 0) return null;
      if (bmp._drHueRts && bmp._drHueRts[hKey]) return bmp._drHueRts[hKey];
      if (insideRender) return null;
      const renderer = runtime.Graphics?._app?.renderer;
      if (!renderer || !PIXI?.RenderTexture?.create || !PIXI?.Sprite || !PIXI?.Texture || !ColorFilter) return null;
      try {
        const rt = PIXI.RenderTexture.create({ width: w, height: h });
        if (!sharedHueSpr) {
          sharedHueSpr = new PIXI.Sprite(PIXI.Texture.EMPTY);
          sharedHueFilter = new ColorFilter();
          sharedHueSpr.filters = [sharedHueFilter];
        }
        sharedHueSpr.texture = new PIXI.Texture(bmp.baseTexture);
        sharedHueFilter.setHue(hKey);
        sharedHueFilter.enabled = true;
        renderer.render(sharedHueSpr, rt, true);
        sharedHueSpr.texture = PIXI.Texture.EMPTY;
        if (!bmp._drHueRts) bmp._drHueRts = Object.create(null);
        bmp._drHueRts[hKey] = rt;
        return rt;
      } catch {
        return null;
      }
    };

    const origSprRefresh = SprProto._refresh;
    const origSprUpdCf = SprProto._updateColorFilter;
    const origSprOnBmpLoad = SprProto._onBitmapLoad;
    if (
      typeof origSprRefresh === 'function' &&
      typeof origSprUpdCf === 'function' &&
      typeof origSprOnBmpLoad === 'function'
    ) {
      SprProto._refresh = function () {
        const r = origSprRefresh.apply(this, arguments);
        if (this._hue && this._bitmap && this.texture) {
          const rt = getOrBakeHueRt(this._bitmap, this._hue);
          if (rt?.baseTexture) {
            this.texture.baseTexture = rt.baseTexture;
            if (this._colorFilter) this._colorFilter.setHue(0);
          }
        }
        return r;
      };
      SprProto._updateColorFilter = function () {
        const r = origSprUpdCf.apply(this, arguments);
        if (this._hue && this._bitmap && this.texture) {
          const rt = getOrBakeHueRt(this._bitmap, this._hue);
          if (rt?.baseTexture) {
            if (this.texture.baseTexture !== rt.baseTexture) {
              this.texture.baseTexture = rt.baseTexture;
            }
            if (this._colorFilter) this._colorFilter.setHue(0);
          }
        } else if (!this._hue && this._bitmap?.baseTexture && this.texture && this.texture.baseTexture !== this._bitmap.baseTexture) {
          this.texture.baseTexture = this._bitmap.baseTexture;
        }
        return r;
      };
      SprProto._onBitmapLoad = function () {
        const r = origSprOnBmpLoad.apply(this, arguments);
        if (this._hue && this._colorFilter) {
          this._updateColorFilter();
        }
        return r;
      };
    }
  }

  const TsProto = TilingSprite?.prototype;
  if (TsProto && !TsProto.__drFastTiling) {
    const tsUpdSrc = String(TsProto.update ?? '').replace(/\s+/g, '');
    if (tsUpdSrc === 'function(){for(constchildofthis.children){if(child.update){child.update();}}}') {
      TsProto.__drFastTiling = true;
      TsProto.update = function () {
        const kids = this.children;
        const n = kids ? kids.length : 0;
        for (let i = 0; i < n; i++) {
          const c = kids[i];
          if (c && c.update) c.update();
        }
      };
    }
  }

  // 0d. Bake static BlurFilter background once in Spriteset_Battle & Scene_MenuBase during update()
  //     (completely outside Renderer.render, eliminating 2 full-screen Gaussian blur FBO passes every frame!)
  const hookStaticBlurBackground = (HolderProto: any) => {
    if (
      !HolderProto ||
      typeof HolderProto.createBackground !== 'function' ||
      typeof HolderProto.update !== 'function' ||
      HolderProto.__drFastBlurBg
    ) {
      return;
    }
    HolderProto.__drFastBlurBg = true;
    const origCreateBg = HolderProto.createBackground;
    HolderProto.createBackground = function () {
      const res = origCreateBg.apply(this, arguments);
      const bg = this._backgroundSprite;
      const bf = this._backgroundFilter;
      if (bg && bf && Array.isArray(bg.filters) && bg.filters.length === 1 && bg.filters[0] === bf) {
        const bmp = bg.bitmap;
        if (!bmp || !bmp.isReady?.() || bmp.width <= 0) {
          bf.enabled = false;
        }
      }
      return res;
    };
    const origHolderUpdate = HolderProto.update;
    HolderProto.update = function () {
      const res = origHolderUpdate.apply(this, arguments);
      const bg = this._backgroundSprite;
      const bf = this._backgroundFilter;
      if (bg && bf && !bg._drBlurBaked && Array.isArray(bg.filters) && bg.filters.length === 1 && bg.filters[0] === bf) {
        const b = bg.bitmap;
        if (!b || !b.isReady?.() || b.width <= 0 || b.height <= 0) {
          bf.enabled = false;
        } else {
          const renderer = runtime.Graphics?._app?.renderer;
          if (renderer && PIXI?.RenderTexture?.create) {
            try {
              const gw = runtime.Graphics.width || b.width;
              const gh = runtime.Graphics.height || b.height;
              const rt = PIXI.RenderTexture.create({ width: gw, height: gh });
              const savedAlpha = bg.alpha;
              bg.alpha = 1;
              bf.enabled = true;
              renderer.render(bg, rt, true);
              bg.alpha = savedAlpha;
              bg.filters = null;
              bg._bitmap = null;
              bg.texture = rt;
              bg._drBlurBaked = true;
              bg._drBakedRt = rt;
              const origDestroy = bg.destroy;
              if (typeof origDestroy === 'function' && !bg.__drDestroyBakedHooked) {
                bg.__drDestroyBakedHooked = true;
                bg.destroy = function () {
                  if (this._drBakedRt) {
                    try { this._drBakedRt.destroy(true); } catch { /* ignore */ }
                    this._drBakedRt = null;
                  }
                  return origDestroy.apply(this, arguments);
                };
              }
            } catch {
              bf.enabled = true;
              bg._drBlurBaked = true;
            }
          } else {
            bf.enabled = true;
          }
        }
      }
      return res;
    };
  };
  hookStaticBlurBackground(Spriteset_Battle?.prototype);
  hookStaticBlurBackground(Scene_MenuBase?.prototype);

  // 1. Tilemap.Layer flat Float32Array rect storage + partial VBO upload + empty-layer skip
  const LayerProto = Tilemap?.Layer?.prototype;
  if (LayerProto && !LayerProto.__drFastLayer && PIXI?.utils?.createIndicesForQuads) {
    const addSrc = String(LayerProto.addRect ?? '');
    const vboSrc = String(LayerProto._updateVertexBuffer ?? '');
    if (addSrc.includes('_elements') && vboSrc.includes('_elements') && vboSrc.includes('_vertexArray')) {
      LayerProto.__drFastLayer = true;

      LayerProto.clear = function () {
        this._drCount = 0;
        if (Array.isArray(this._elements)) this._elements.length = 0;
        this._needsVertexUpdate = true;
      };

      LayerProto.size = function () {
        return (this._drCount | 0) || (Array.isArray(this._elements) ? this._elements.length : 0);
      };

      LayerProto.addRect = function (
        setNumber: number,
        sx: number,
        sy: number,
        dx: number,
        dy: number,
        w: number,
        h: number,
      ) {
        let rects: Float32Array | undefined = this._drRects;
        const count = this._drCount | 0;
        const need = (count + 1) * 7;
        if (!rects) {
          rects = new Float32Array(256 * 7);
          this._drRects = rects;
        } else if (need > rects.length) {
          const grown = new Float32Array(Math.max(need, rects.length * 2));
          grown.set(rects);
          rects = grown;
          this._drRects = grown;
        }
        const base = count * 7;
        rects[base] = setNumber;
        rects[base + 1] = sx;
        rects[base + 2] = sy;
        rects[base + 3] = dx;
        rects[base + 4] = dy;
        rects[base + 5] = w;
        rects[base + 6] = h;
        this._drCount = count + 1;
        this._needsVertexUpdate = true;
      };

      LayerProto._updateIndexBuffer = function () {
        const numElements = this._drCount | 0;
        if (numElements <= 0) return;
        if (!this._indexArray || this._indexArray.length < numElements * 6 * 2) {
          this._indexArray = PIXI.utils.createIndicesForQuads(Math.max(256, numElements * 2));
          this._indexBuffer.update(this._indexArray);
        }
      };

      LayerProto._updateVertexBuffer = function () {
        const numElements = this._drCount | 0;
        if (numElements <= 0) return;
        const stride = Tilemap.Layer.VERTEX_STRIDE || 36;
        const required = numElements * stride;
        if (!this._vertexArray || this._vertexArray.length < required) {
          this._vertexArray = new Float32Array(Math.max(256 * 36, required * 2));
        }
        const vertexArray: Float32Array = this._vertexArray;
        const rects: Float32Array = this._drRects;
        let index = 0;
        for (let i = 0; i < numElements; i++) {
          const base = i * 7;
          const setNumber = rects[base] | 0;
          const tid = setNumber >> 2;
          const sxOffset = 1024 * (setNumber & 1);
          const syOffset = 1024 * ((setNumber >> 1) & 1);
          const sx = rects[base + 1] + sxOffset;
          const sy = rects[base + 2] + syOffset;
          const dx = rects[base + 3];
          const dy = rects[base + 4];
          const w = rects[base + 5];
          const h = rects[base + 6];
          const frameLeft = sx + 0.5;
          const frameTop = sy + 0.5;
          const frameRight = sx + w - 0.5;
          const frameBottom = sy + h - 0.5;
          const sxw = sx + w;
          const syh = sy + h;
          const dxw = dx + w;
          const dyh = dy + h;

          vertexArray[index] = tid;
          vertexArray[index + 1] = frameLeft;
          vertexArray[index + 2] = frameTop;
          vertexArray[index + 3] = frameRight;
          vertexArray[index + 4] = frameBottom;
          vertexArray[index + 5] = sx;
          vertexArray[index + 6] = sy;
          vertexArray[index + 7] = dx;
          vertexArray[index + 8] = dy;

          vertexArray[index + 9] = tid;
          vertexArray[index + 10] = frameLeft;
          vertexArray[index + 11] = frameTop;
          vertexArray[index + 12] = frameRight;
          vertexArray[index + 13] = frameBottom;
          vertexArray[index + 14] = sxw;
          vertexArray[index + 15] = sy;
          vertexArray[index + 16] = dxw;
          vertexArray[index + 17] = dy;

          vertexArray[index + 18] = tid;
          vertexArray[index + 19] = frameLeft;
          vertexArray[index + 20] = frameTop;
          vertexArray[index + 21] = frameRight;
          vertexArray[index + 22] = frameBottom;
          vertexArray[index + 23] = sxw;
          vertexArray[index + 24] = syh;
          vertexArray[index + 25] = dxw;
          vertexArray[index + 26] = dyh;

          vertexArray[index + 27] = tid;
          vertexArray[index + 28] = frameLeft;
          vertexArray[index + 29] = frameTop;
          vertexArray[index + 30] = frameRight;
          vertexArray[index + 31] = frameBottom;
          vertexArray[index + 32] = sx;
          vertexArray[index + 33] = syh;
          vertexArray[index + 34] = dx;
          vertexArray[index + 35] = dyh;
          index += 36;
        }
        this._vertexBuffer.update(vertexArray.subarray(0, index));
      };

      const renSrc = String(LayerProto.render ?? '');
      if (renSrc.includes('rpgtilemap') && renSrc.includes('_updateVertexBuffer')) {
        LayerProto.render = function (renderer: any) {
          const numElements = this._drCount | 0;
          if (numElements <= 0) {
            if (this._needsTexturesUpdate && renderer?.plugins?.rpgtilemap) {
              renderer.plugins.rpgtilemap.updateTextures(renderer, this._images);
              this._needsTexturesUpdate = false;
            }
            this._needsVertexUpdate = false;
            return;
          }
          const gl = renderer.gl;
          const tilemapRenderer = renderer.plugins.rpgtilemap;
          const shader = tilemapRenderer.getShader();
          const matrix = shader.uniforms.uProjectionMatrix;

          renderer.batch.setObjectRenderer(tilemapRenderer);
          renderer.projection.projectionMatrix.copyTo(matrix);
          matrix.append(this.worldTransform);
          renderer.shader.bind(shader);

          if (this._needsTexturesUpdate) {
            tilemapRenderer.updateTextures(renderer, this._images);
            this._needsTexturesUpdate = false;
          }
          tilemapRenderer.bindTextures(renderer);
          renderer.geometry.bind(this._vao, shader);
          this._updateIndexBuffer();
          if (this._needsVertexUpdate) {
            this._updateVertexBuffer();
            this._needsVertexUpdate = false;
          }
          renderer.geometry.updateBuffers();

          renderer.state.set(this._state);
          renderer.geometry.draw(gl.TRIANGLES, numElements * 6, 0);
        };
      }
    }
  }

  // 2. Tilemap animation rebuild skip + zero-tile _addSpotTile guard + O(N) _sortChildren
  const TmProto = Tilemap?.prototype;
  if (TmProto && !TmProto.__drMzFastTilemap) {
    TmProto.__drMzFastTilemap = true;

    const origRefresh = TmProto.refresh;
    if (typeof origRefresh === 'function') {
      TmProto.refresh = function () {
        this._drSpotsBuilt = false;
        return origRefresh.apply(this, arguments);
      };
    }

    const origAddAutotile = TmProto._addAutotile;
    if (typeof origAddAutotile === 'function') {
      TmProto._addAutotile = function (layer: any, tileId: number, dx: number, dy: number) {
        // Tile A1 animated water / waterfall tiles: [2048, 2816) except static kinds 2 & 3 [2144, 2240)
        if (tileId >= 2048 && tileId < 2816 && (tileId < 2144 || tileId >= 2240)) {
          this._drHasAnimTiles = true;
        }
        return origAddAutotile.call(this, layer, tileId, dx, dy);
      };
    }

    const origAddAllSpots = TmProto._addAllSpots;
    if (typeof origAddAllSpots === 'function') {
      TmProto._addAllSpots = function (startX: number, startY: number) {
        this._drHasAnimTiles = false;
        const r = origAddAllSpots.call(this, startX, startY);
        this._drSpotsBuilt = true;
        return r;
      };
    }

    const origAddSpotTile = TmProto._addSpotTile;
    if (typeof origAddSpotTile === 'function') {
      TmProto._addSpotTile = function (tileId: number, dx: number, dy: number) {
        if (tileId <= 0) return;
        return origAddSpotTile.call(this, tileId, dx, dy);
      };
    }

    const origTmUpdateTransform = TmProto.updateTransform;
    if (typeof origTmUpdateTransform === 'function') {
      TmProto.updateTransform = function () {
        if (
          this._drSpotsBuilt &&
          !this._needsRepaint &&
          this._drHasAnimTiles === false &&
          this._lastAnimationFrame !== this.animationFrame
        ) {
          const tw = this._tileWidth || 48;
          const th = this._tileHeight || 48;
          const ox = Math.ceil(this.origin.x);
          const oy = Math.ceil(this.origin.y);
          const startX = Math.floor((ox - this._margin) / tw);
          const startY = Math.floor((oy - this._margin) / th);
          if (this._lastStartX === startX && this._lastStartY === startY) {
            this._lastAnimationFrame = this.animationFrame;
          }
        }
        return origTmUpdateTransform.apply(this, arguments);
      };
    }

    const origSortChildren = TmProto._sortChildren;
    const cmpSrc = String(TmProto._compareChildOrder ?? '');
    if (
      typeof origSortChildren === 'function' &&
      cmpSrc.includes('a.z') &&
      cmpSrc.includes('a.y') &&
      cmpSrc.includes('spriteId')
    ) {
      const fastCompare = (a: any, b: any): number => {
        const dz = (a.z || 0) - (b.z || 0);
        if (dz !== 0) return dz;
        const dy = (a.y || 0) - (b.y || 0);
        if (dy !== 0) return dy;
        return (a.spriteId || 0) - (b.spriteId || 0);
      };
      TmProto._sortChildren = function () {
        const children = this.children;
        const len = children ? children.length : 0;
        if (len <= 1) return;
        let prev = children[0];
        let prevZ = prev.z || 0;
        let prevY = prev.y || 0;
        let prevId = prev.spriteId || 0;
        let sorted = true;
        for (let i = 1; i < len; i++) {
          const cur = children[i];
          const cz = cur.z || 0;
          const cy = cur.y || 0;
          const cid = cur.spriteId || 0;
          if (cz < prevZ || (cz === prevZ && (cy < prevY || (cy === prevY && cid < prevId)))) {
            sorted = false;
            break;
          }
          prevZ = cz;
          prevY = cy;
          prevId = cid;
        }
        if (sorted) return;

        // Nearly-sorted insertion pass (typical when 1-3 characters move vertically)
        let shifts = 0;
        const maxShifts = len * 4;
        for (let i = 1; i < len; i++) {
          const item = children[i];
          const iz = item.z || 0;
          const iy = item.y || 0;
          const iid = item.spriteId || 0;
          let j = i - 1;
          while (j >= 0) {
            const c = children[j];
            const cz = c.z || 0;
            if (cz < iz) break;
            if (cz === iz) {
              const cy = c.y || 0;
              if (cy < iy || (cy === iy && (c.spriteId || 0) <= iid)) break;
            }
            j--;
          }
          if (j < i - 1) {
            shifts += i - 1 - j;
            if (shifts > maxShifts) {
              children.sort(fastCompare);
              return;
            }
            for (let k = i; k > j + 1; k--) {
              children[k] = children[k - 1];
            }
            children[j + 1] = item;
          }
        }
      };
    }
  }

  // 2b. VisuMZ_0_CoreEngine Game_Map.prototype.isTileExtended zero-alloc fast-path
  const GmProto = Game_Map?.prototype;
  if (GmProto && typeof GmProto.isTileExtended === 'function' && typeof GmProto.setupTileExtendTerrainTags === 'function') {
    const origSetupExtend = GmProto.setupTileExtendTerrainTags;
    GmProto.setupTileExtendTerrainTags = function () {
      const r = origSetupExtend.apply(this, arguments);
      const tags = this._tileExtendTerrainTags;
      let hasAny = false;
      if (tags && typeof tags === 'object') {
        for (const k in tags) {
          if (Object.prototype.hasOwnProperty.call(tags, k) && tags[k] > 0) {
            hasAny = true;
            break;
          }
        }
      }
      this._drHasTileExtend = hasAny;
      return r;
    };
    GmProto.isTileExtended = function (tileId: number) {
      if (tileId <= 0 || tileId >= 0x400) return false;
      if (this._tileExtendTerrainTags === undefined) {
        this.setupTileExtendTerrainTags();
      }
      if (!this._drHasTileExtend) return false;
      const flags = this.tilesetFlags();
      return ((this._tileExtendTerrainTags[flags[tileId] >> 12] || 0) > 0);
    };
  }

  // 3. WindowLayer.prototype.update & render:
  //    - Indexed update loop (no ArrayIterator per frame in --jitless V8)
  //    - Cull 0-size / off-screen windows (e.g. VisuMZ_1_BattleCore's off-screen Window_BattleLog at x=1904)
  //    - Skip stencil passes & pooled PIXI.Graphics when <=1 window open OR open windows do not overlap!
  const WlProto = WindowLayer?.prototype;
  if (WlProto && !WlProto.__drFastRender) {
    WlProto.__drFastRender = true;
    const wlUpdSrc = String(WlProto.update ?? '').replace(/\s+/g, '');
    if (wlUpdSrc === 'function(){for(constchildofthis.children){if(child.update){child.update();}}}') {
      WlProto.update = function () {
        const kids = this.children;
        const n = kids ? kids.length : 0;
        for (let i = 0; i < n; i++) {
          const c = kids[i];
          if (c && c.update) c.update();
        }
      };
    }

    if (typeof WlProto.render === 'function' && PIXI?.Graphics) {
      WlProto.render = function (renderer: any) {
        if (!this.visible) return;
        const kids: any[] = this.children;
        const n = kids ? kids.length : 0;
        if (n === 0) return;

        const gw = runtime.Graphics?.width || 0;
        const gh = runtime.Graphics?.height || 0;
        const openWins: any[] = this._drOpenWins || (this._drOpenWins = []);
        openWins.length = 0;
        let hasNonWindow = false;

        for (let i = 0; i < n; i++) {
          const c = kids[i];
          if (!c || !c.visible) continue;
          if (c._isWindow) {
            if (c.openness > 0) {
              const cw = c._width ?? c.width;
              const ch = c._height ?? c.height;
              if (cw !== undefined && ch !== undefined) {
                if (cw <= 0 || ch <= 0) continue;
                const cx = c.x || 0;
                const cy = c.y || 0;
                if (gw > 0 && gh > 0 && (cx >= gw || cy >= gh || cx + cw <= 0 || cy + ch <= 0)) {
                  continue;
                }
              }
              openWins.push(c);
            }
          } else {
            if (gw > 0 && gh > 0 && (c.x || 0) >= gw * 2) continue;
            hasNonWindow = true;
          }
        }

        const openCount = openWins.length;
        if (openCount === 0) {
          if (!hasNonWindow) return;
          for (let i = 0; i < n; i++) {
            const c = kids[i];
            if (c && !c._isWindow && c.visible) c.render(renderer);
          }
          renderer.batch.flush();
          return;
        }

        let needStencil = openCount > 1 && (typeof this.isMaskingEnabled === 'function' ? Boolean(this.isMaskingEnabled()) : true);
        if (needStencil) {
          let anyOverlap = false;
          outer: for (let i = 0; i < openCount; i++) {
            const a = openWins[i];
            const aw = a._width ?? a.width;
            const ah = a._height ?? a.height;
            if (aw === undefined || ah === undefined) {
              anyOverlap = true;
              break;
            }
            const ax0 = a.x || 0;
            const ay0 = a.y || 0;
            const ax1 = ax0 + aw;
            const ay1 = ay0 + ah;
            for (let j = i + 1; j < openCount; j++) {
              const b = openWins[j];
              const bw = b._width ?? b.width;
              const bh = b._height ?? b.height;
              if (bw === undefined || bh === undefined) {
                anyOverlap = true;
                break outer;
              }
              const bx0 = b.x || 0;
              const by0 = b.y || 0;
              if (ax0 < bx0 + bw && ax1 > bx0 && ay0 < by0 + bh && ay1 > by0) {
                anyOverlap = true;
                break outer;
              }
            }
          }
          if (!anyOverlap) needStencil = false;
        }

        if (!needStencil) {
          for (let i = 0; i < openCount; i++) {
            openWins[i].render(renderer);
          }
          openWins.length = 0;
          if (hasNonWindow) {
            for (let i = 0; i < n; i++) {
              const c = kids[i];
              if (c && !c._isWindow && c.visible) c.render(renderer);
            }
          }
          renderer.batch.flush();
          return;
        }

        // 2+ overlapping open windows with stencil masking enabled -> reuse persistent PIXI.Graphics!
        let graphics = this._drStencilGfx;
        if (!graphics || graphics._destroyed) {
          graphics = new PIXI.Graphics();
          this._drStencilGfx = graphics;
        }
        const gl = renderer.gl;
        renderer.framebuffer.forceStencil();
        graphics.transform = this.transform;
        renderer.batch.flush();
        gl.enable(gl.STENCIL_TEST);

        for (let i = openCount - 1; i >= 0; i--) {
          const win = openWins[i];
          gl.stencilFunc(gl.EQUAL, 0, ~0);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
          win.render(renderer);
          renderer.batch.flush();
          graphics.clear();
          win.drawShape(graphics);
          gl.stencilFunc(gl.ALWAYS, 1, ~0);
          gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);
          gl.blendFunc(gl.ZERO, gl.ONE);
          graphics.render(renderer);
          renderer.batch.flush();
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }
        openWins.length = 0;
        graphics.clear();

        gl.disable(gl.STENCIL_TEST);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.clearStencil(0);
        renderer.batch.flush();

        if (hasNonWindow) {
          for (let i = 0; i < n; i++) {
            const c = kids[i];
            if (c && !c._isWindow && c.visible) c.render(renderer);
          }
          renderer.batch.flush();
        }
      };
    }
  }

  // 4. Window / Window_Base / Window_Selectable fast-paths:
  //    - Skip child sprite updates (e.g. hidden Window_BattleActor's 26 Sprite_Gauges) when window is hidden/closed
  //    - Disable _clientArea AlphaFilter offscreen FBO pass when unscrolled, fully open, alpha=1, and contents fit
  //    - Zero-alloc _updateFilterArea (avoid per-window `new Point(0, 0)` every frame)
  //    - Skip off-screen / closed Window transforms & inactive hidden Window_Base / Window_Selectable plugin polling
  const WinProto = Window?.prototype;
  if (WinProto && !WinProto.__drFastWinTransform) {
    WinProto.__drFastWinTransform = true;

    const winUpdSrc = String(WinProto.update ?? '').replace(/\s+/g, '');
    if (
      winUpdSrc ===
      'function(){if(this.active){this._animationCount++;}for(constchildofthis.children){if(child.update){child.update();}}}'
    ) {
      WinProto.update = function () {
        if (this.active) {
          this._animationCount++;
        }
        if (
          this._drWinChildInit &&
          !this.active &&
          (!this.visible || (this._openness <= 0 && !this._opening && !this._closing))
        ) {
          return;
        }
        this._drWinChildInit = true;
        const kids = this.children;
        const n = kids ? kids.length : 0;
        for (let i = 0; i < n; i++) {
          const c = kids[i];
          if (c && c.update) c.update();
        }
      };
    }

    const filterAreaSrc = String(WinProto._updateFilterArea ?? '');
    if (
      filterAreaSrc.includes('new Point(0, 0)') &&
      filterAreaSrc.includes('filterArea.x') &&
      filterAreaSrc.includes('innerWidth')
    ) {
      WinProto._updateFilterArea = function () {
        const ca = this._clientArea;
        if (!ca) return;
        const filters = ca.filters;
        if (filters && filters.length === 1 && !filters[0].enabled) return;
        const filterArea = ca.filterArea;
        if (!filterArea) return;
        const wt = ca.worldTransform;
        filterArea.x = wt.tx + this.origin.x;
        filterArea.y = wt.ty + this.origin.y;
        filterArea.width = this.innerWidth;
        filterArea.height = this.innerHeight;
      };
    }

    const origWinUpdateTransform = WinProto.updateTransform;
    if (typeof origWinUpdateTransform === 'function') {
      WinProto.updateTransform = function () {
        if (!this.visible) return;
        if (this._openness <= 0 && (!this.children || this.children.length <= 5)) {
          if (!this._drClosedSynced) {
            origWinUpdateTransform.call(this);
            this._drClosedSynced = true;
          }
          return;
        }
        const gw = runtime.Graphics?.width || 0;
        const gh = runtime.Graphics?.height || 0;
        const curScene = runtime.SceneManager?._scene;
        if (
          gw > 0 &&
          gh > 0 &&
          this.parent &&
          (this.parent === curScene?._windowLayer || this.parent === curScene) &&
          (this._width <= 0 ||
            this._height <= 0 ||
            this.x >= gw ||
            this.y >= gh ||
            this.x + this._width <= 0 ||
            this.y + this._height <= 0)
        ) {
          if (!this._drOffscreenSynced) {
            origWinUpdateTransform.call(this);
            this._drOffscreenSynced = true;
          }
          return;
        }
        this._drClosedSynced = false;
        this._drOffscreenSynced = false;

        const ca = this._clientArea;
        const filters = ca?.filters;
        if (filters && filters.length === 1) {
          const af = filters[0];
          if (af && typeof af.alpha === 'number') {
            const bmp = this._contentsSprite?._bitmap;
            const iw = Math.max(0, this._width - this._padding * 2);
            const ih = Math.max(0, this._height - this._padding * 2);
            af.enabled = Boolean(
              af.alpha < 1 ||
                this.origin.x !== 0 ||
                this.origin.y !== 0 ||
                (this._openness > 0 && this._openness < 255) ||
                (bmp && (bmp.width > iw || bmp.height > ih)),
            );
          }
        }
        return origWinUpdateTransform.call(this);
      };
    }

    if (typeof WinProto.render === 'function' && !WinProto.__drFastWinRender) {
      WinProto.__drFastWinRender = true;
      const origWinRender = WinProto.render;
      WinProto.render = function (renderer: any) {
        if (!this.visible || this._openness <= 0 || this._drOffscreenSynced) return;
        return origWinRender.call(this, renderer);
      };
    }
  }

  const WinBaseProto = Window_Base?.prototype;
  if (WinBaseProto && !WinBaseProto.__drFastTone) {
    WinBaseProto.__drFastTone = true;
    const origUpdateTone = WinBaseProto.updateTone;
    if (typeof origUpdateTone === 'function') {
      WinBaseProto.updateTone = function () {
        if (this._openness <= 0 && !this._opening && !this._closing) return;
        return origUpdateTone.call(this);
      };
    }
    const origWbUpdate = WinBaseProto.update;
    if (typeof origWbUpdate === 'function') {
      WinBaseProto.update = function () {
        if (
          this._drWbInit &&
          !this.active &&
          (!this.visible || (this._openness <= 0 && !this._opening && !this._closing)) &&
          !(this._moveDuration > 0) &&
          !(this._easingDuration > 0)
        ) {
          return;
        }
        this._drWbInit = true;
        return origWbUpdate.apply(this, arguments);
      };
    }
  }

  const WinSelProto = Window_Selectable?.prototype;
  if (WinSelProto && typeof WinSelProto.update === 'function' && !WinSelProto.__drFastSelUpdate) {
    WinSelProto.__drFastSelUpdate = true;
    const origWsUpdate = WinSelProto.update;
    WinSelProto.update = function () {
      if (
        this._drWsInit &&
        !this.active &&
        (!this.visible || (this._openness <= 0 && !this._opening && !this._closing)) &&
        !(this._moveDuration > 0) &&
        !(this._easingDuration > 0)
      ) {
        if (WinBaseProto?.update) return WinBaseProto.update.call(this);
        return;
      }
      this._drWsInit = true;
      return origWsUpdate.apply(this, arguments);
    };
  }

  // 5. Sprite_Clickable: skip Point/Rectangle/matrix inverse allocations on idle gamepad frames
  const ClickProto = Sprite_Clickable?.prototype;
  if (ClickProto && typeof ClickProto.processTouch === 'function' && !ClickProto.__drFastClick) {
    ClickProto.__drFastClick = true;
    const origProcessTouch = ClickProto.processTouch;
    ClickProto.processTouch = function () {
      const TI = runtime.TouchInput;
      if (
        !this._pressed &&
        !this._hovered &&
        TI &&
        !TI._hovered &&
        !TI._triggered &&
        !TI._screenPressed
      ) {
        return;
      }
      return origProcessTouch.call(this);
    };
  }

  // 6. CGMZ_Sprite_SimpleLightEffect: skip idle per-event light sprites with no light attached
  const CgmzLight = runtime.CGMZ_Sprite_SimpleLightEffect;
  if (CgmzLight?.prototype && !CgmzLight.prototype.__drFastLight) {
    CgmzLight.prototype.__drFastLight = true;
    const origLightUpdate = CgmzLight.prototype.update;
    if (typeof origLightUpdate === 'function') {
      CgmzLight.prototype.update = function () {
        if (!this._light && (!this._event || !this._event._CGMZ_light)) {
          if (this.visible) this.visible = false;
          return;
        }
        return origLightUpdate.call(this);
      };
    }
    const origLightUpdTr = CgmzLight.prototype.updateTransform;
    if (typeof origLightUpdTr === 'function') {
      CgmzLight.prototype.updateTransform = function () {
        if (!this.visible && (!this.children || this.children.length === 0)) return;
        return origLightUpdTr.call(this);
      };
    }
  }

  // 7. Empty / transparent Sprite_Character (unused vehicles, followers, invisible trigger events)
  const ScProto = Sprite_Character?.prototype;
  if (ScProto && !ScProto.__drMzFastChar) {
    ScProto.__drMzFastChar = true;
    const origCharUpdate = ScProto.update;
    if (typeof origCharUpdate === 'function') {
      ScProto.update = function () {
        const ch = this._character;
        if (
          ch &&
          !this.visible &&
          (!this.children || this.children.length === 0) &&
          (ch._transparent || (ch._tileId === 0 && !ch._characterName)) &&
          this._tileId === ch._tileId &&
          this._characterName === ch._characterName &&
          this._tilesetId === runtime.$gameMap?._tilesetId &&
          !ch._balloonPlaying &&
          !ch._animationPlaying &&
          (runtime.$gameTemp?._animationQueue?.length || 0) === 0 &&
          (runtime.$gameTemp?._balloonQueue?.length || 0) === 0
        ) {
          return;
        }
        return origCharUpdate.call(this);
      };
    }
    const origCharUpdTr = ScProto.updateTransform;
    if (typeof origCharUpdTr === 'function') {
      ScProto.updateTransform = function () {
        if (!this.visible && (!this.children || this.children.length === 0)) return;
        return origCharUpdTr.call(this);
      };
    }
  }

  // 8. Unused Sprite_Picture slots (100 picture sprites exist in both Scene_Map and Scene_Battle)
  const SpPicProto = Sprite_Picture?.prototype;
  if (SpPicProto && !SpPicProto.__drFastPicture) {
    SpPicProto.__drFastPicture = true;
    const origPicUpdate = SpPicProto.update;
    if (typeof origPicUpdate === 'function') {
      SpPicProto.update = function () {
        if (!this.visible && !this._pictureName && !runtime.$gameScreen?.picture?.(this._pictureId)) {
          return;
        }
        return origPicUpdate.call(this);
      };
    }
    const origPicUpdTr = SpPicProto.updateTransform;
    if (typeof origPicUpdTr === 'function') {
      SpPicProto.updateTransform = function () {
        if (!this.visible && !this._pictureName) return;
        return origPicUpdTr.call(this);
      };
    }
  }

  // 9. Sprite_Gauge / NUUN_GaugeImage: cache compiled VisibilityCondition functions instead of calling
  //    `new Function('$gameSystem', ...)` 1,140x/sec, and avoid per-frame [0,0,0,0] array allocations.
  const SgProto = Sprite_Gauge?.prototype;
  if (SgProto && !SgProto.__drFastGauge) {
    SgProto.__drFastGauge = true;
    const visSrc = String(SgProto.updateVisibility ?? '');
    if (visSrc.includes('VisibilityCondition') && visSrc.includes('Function')) {
      const condFnCache = new Map<string, ((gs: any) => any) | null>();
      SgProto.updateVisibility = function () {
        if (!this._gaugeImgData) {
          this.visible = Sprite_Gauge.isGaugeVisible(this._statusType);
          return;
        }
        const condition = this._gaugeImgData.VisibilityCondition;
        let isVisible = Sprite_Gauge.isGaugeVisible(this._statusType);
        const gs = runtime.$gameSystem;
        if (condition && gs && isVisible) {
          let fn = condFnCache.get(condition);
          if (fn === undefined) {
            try {
              const F = runtime.Function || Function;
              fn = new F('$gameSystem', `return ${condition};`) as (gs: any) => any;
            } catch {
              fn = null;
            }
            condFnCache.set(condition, fn);
          }
          if (fn) {
            try {
              isVisible = Boolean(fn(gs));
            } catch { /* ignore */ }
          }
        }
        this.visible = isVisible;
      };
    }
  }

  // 10. VisuMZ_1_BattleCore Window_BattleMultiTarget: fix per-frame refresh() storm when SHOW_BUTTON is false
  const Wbmt = runtime.Window_BattleMultiTarget;
  if (Wbmt?.prototype && !Wbmt.prototype.__drFastMultiTarget) {
    Wbmt.prototype.__drFastMultiTarget = true;
    const origUpdKeys = Wbmt.prototype.updateKeyboardKeys;
    if (typeof origUpdKeys === 'function') {
      Wbmt.prototype.updateKeyboardKeys = function () {
        if (!this.visible || !Wbmt.SHOW_BUTTON) return;
        return origUpdKeys.call(this);
      };
    }
  }

  // 11. VisuMZ_1_BattleCore Sprite_EnemyName: cache enemy <SHOW/HIDE HP GAUGE> regex result & skip hidden child gauges
  const SenProto = runtime.Sprite_EnemyName?.prototype;
  if (SenProto && !SenProto.__drFastEnemyName) {
    SenProto.__drFastEnemyName = true;
    const origUpdAttached = SenProto.updateAttachedSprites;
    if (typeof origUpdAttached === 'function') {
      SenProto.updateAttachedSprites = function () {
        if (this._drAttachedInit && this.opacity <= 0 && !this.visibilityState?.()) {
          if (this._hpGaugeSprite && this._hpGaugeSprite.visible) this._hpGaugeSprite.visible = false;
          return;
        }
        this._drAttachedInit = true;
        return origUpdAttached.call(this);
      };
    }
    const origEnemyUpdate = SenProto.update;
    if (typeof origEnemyUpdate === 'function' && SprProto?.update) {
      SenProto.update = function () {
        if (this._drAttachedInit && this.opacity <= 0 && this._battler === this._linkedSprite?._battler && !this.visibilityState?.()) {
          this.updatePosition?.();
          return;
        }
        return origEnemyUpdate.call(this);
      };
    }
  }

  // 12. VisuMZ_2_BattleGridSystem + NEO_Ext_GridBattle Sprite_BattleGridNode & Sprite_BattleGridPassives:
  //     cache battler() & stateIDs() per frame & eliminate 12x/frame unconditional Bitmap.clear() texture uploads!
  const SbgnProto = runtime.Sprite_BattleGridNode?.prototype;
  if (SbgnProto && typeof SbgnProto.battler === 'function' && !SbgnProto.__drFastGridNode) {
    SbgnProto.__drFastGridNode = true;
    const origNodeBattler = SbgnProto.battler;
    SbgnProto.battler = function () {
      const fc = runtime.Graphics?.frameCount ?? -1;
      if (fc >= 0 && this._drNodeBatFrame === fc) {
        return this._drNodeBatVal;
      }
      const val = origNodeBattler.call(this);
      this._drNodeBatFrame = fc;
      this._drNodeBatVal = val;
      return val;
    };
  }

  const SbgpProto = runtime.Sprite_BattleGridPassives?.prototype;
  if (SbgpProto && !SbgpProto.__drFastGridPassives) {
    SbgpProto.__drFastGridPassives = true;
    const origStateIDs = SbgpProto.stateIDs;
    if (typeof origStateIDs === 'function') {
      SbgpProto.stateIDs = function () {
        const fc = runtime.Graphics?.frameCount ?? -1;
        if (fc >= 0 && this._drStateIdsFrame === fc) {
          return this._drStateIdsVal;
        }
        const val = origStateIDs.call(this);
        this._drStateIdsFrame = fc;
        this._drStateIdsVal = val;
        return val;
      };
    }
    const picSprSrc = String(SbgpProto.updatePictureSprite ?? '');
    if (
      typeof SbgpProto.updatePictureSprite === 'function' &&
      picSprSrc.includes('StateNotetags') &&
      picSprSrc.includes('this.bitmap.clear()')
    ) {
      SbgpProto.updatePictureSprite = function () {
        const stateIds = this.stateIDs();
        let foundPicture = false;
        let pictureName = '';
        const noteMap = runtime.$neo?.StateNotetags;
        if (noteMap && stateIds && stateIds.length > 0) {
          for (let i = 0; i < stateIds.length; i++) {
            const sid = stateIds[i];
            if (noteMap[sid]) {
              pictureName = noteMap[sid];
              foundPicture = true;
              if (!this._pictureSprite.bitmap || this._currentPictureName !== pictureName) {
                this.setupAnimatedPicture(pictureName);
                this._pictureSprite.bitmap = runtime.ImageManager.loadPicture(pictureName);
                this._pictureSprite.bitmap.addLoadListener(this.onPictureLoad.bind(this));
              }
              break;
            }
          }
        }
        this._pictureSprite.visible = foundPicture;
        const iconKey = foundPicture ? -1 : (this._iconIndex | 0);
        if (this._drLastGridIconKey === iconKey) return;
        this._drLastGridIconKey = iconKey;
        if (!foundPicture) {
          if (iconKey > 0) {
            this.bitmap.clear();
            this.drawIconBitmap(iconKey);
          } else {
            this.bitmap.clear();
          }
        } else {
          this.bitmap.clear();
        }
      };
    }
  }

  // 13. VisuMZ_3_WeaknessDisplay (196 sprites in Scene_Battle): skip unchanged icon setFrame & hidden containers
  const SwiProto = runtime.Sprite_WeaknessIcon?.prototype;
  if (SwiProto && typeof SwiProto.update === 'function' && !SwiProto.__drFastWeakIcon) {
    const swiSrc = String(SwiProto.update);
    if (swiSrc.includes('updateIconFrame') && swiSrc.includes('_backgroundIndex') && swiSrc.includes('_protectIcon')) {
      SwiProto.__drFastWeakIcon = true;
      const origSwiUpdate = SwiProto.update;
      SwiProto.update = function () {
        const sw = this._iconSheet?.width || 0;
        if (
          sw > 0 &&
          this._drBgIdx === this._backgroundIndex &&
          this._drIcIdx === this._iconIndex &&
          this._drPrIdx === this._protectIcon &&
          this._drSheetW === sw
        ) {
          return;
        }
        const r = origSwiUpdate.call(this);
        if (sw > 0) {
          this._drBgIdx = this._backgroundIndex;
          this._drIcIdx = this._iconIndex;
          this._drPrIdx = this._protectIcon;
          this._drSheetW = sw;
        }
        return r;
      };
    }
  }

  const SwcProto = runtime.Sprite_WeaknessContainer?.prototype;
  if (SwcProto && typeof SwcProto.update === 'function' && !SwcProto.__drFastWeakCont) {
    SwcProto.__drFastWeakCont = true;
    const origSwcUpdate = SwcProto.update;
    SwcProto.update = function () {
      if (
        this._drSwcInit &&
        this.opacity <= 0 &&
        this._battler === this._linkedSprite?._battler &&
        !this.visibilityState?.()
      ) {
        return;
      }
      this._drSwcInit = true;
      return origSwcUpdate.call(this);
    };
  }

  // 14. VisuMZ_1_SkillsStatesCore Sprite_StateIcon.prototype.updateTurnDisplaySprite:
  //     memoize displayed state/buff turn & data so empty/unchanged icons don't clear+drawText every 40 frames
  const SsiProto = Sprite_StateIcon?.prototype;
  if (SsiProto && typeof SsiProto.updateTurnDisplaySprite === 'function' && !SsiProto.__drFastTurnDisp) {
    const utdSrc = String(SsiProto.updateTurnDisplaySprite);
    if (utdSrc.includes('this.contents.clear()') && utdSrc.includes('_animationIndex')) {
      SsiProto.__drFastTurnDisp = true;
      const origUpdateTurnDisplay = SsiProto.updateTurnDisplaySprite;
      SsiProto.updateTurnDisplaySprite = function () {
        const b = this._battler;
        if (!b) {
          if (this._drTurnDispKey === 'none') return;
          this._drTurnDispKey = 'none';
          return origUpdateTurnDisplay.call(this);
        }
        const states = typeof b.states === 'function' ? b.states() : [];
        const animIdx = this._animationIndex | 0;
        let visIdx = 0;
        let targetState: any = null;
        for (let i = 0; i < states.length; i++) {
          const st = states[i];
          if (st && st.iconIndex > 0) {
            if (visIdx === animIdx) {
              targetState = st;
              break;
            }
            visIdx++;
          }
        }
        let key = 'empty';
        if (targetState) {
          const turns = b._stateTurns?.[targetState.id] ?? '';
          const data = typeof b.getStateDisplay === 'function' ? b.getStateDisplay(targetState.id) : '';
          key = `s:${targetState.id}:${turns}:${data}`;
        } else if (typeof b.buff === 'function') {
          let buffIdx = animIdx - visIdx;
          for (let paramId = 0; paramId < 8; paramId++) {
            const bv = b.buff(paramId);
            if (bv !== 0) {
              if (buffIdx === 0) {
                key = `b:${paramId}:${bv}:${b._buffTurns?.[paramId] ?? ''}`;
                break;
              }
              buffIdx--;
            }
          }
        }
        if (this._drTurnDispKey === key) return;
        this._drTurnDispKey = key;
        return origUpdateTurnDisplay.call(this);
      };
    }
  }

  // 15. NEO_BattleTextAlerts (closure-private Window_DynamicBattleText & Window_PositionedBattleText):
  //     skip 5-frame createContents() churn & 10-frame full-screen 960x540 Bitmap.clear() when alerts unchanged!
  const SbProto = runtime.Scene_Battle?.prototype;
  if (SbProto && typeof SbProto.createAllWindows === 'function' && !SbProto.__drFastBattleAlerts) {
    SbProto.__drFastBattleAlerts = true;
    const origCreateAllWindows = SbProto.createAllWindows;
    SbProto.createAllWindows = function () {
      const res = origCreateAllWindows.apply(this, arguments);
      const dynWin = this._dynamicBattleTextWindow;
      const dynProto = dynWin ? Object.getPrototypeOf(dynWin) : null;
      if (
        dynProto &&
        !dynProto.__drFastDynRefresh &&
        typeof dynProto.refresh === 'function' &&
        typeof dynProto.evaluateConditions === 'function' &&
        typeof dynProto.drawAllText === 'function'
      ) {
        dynProto.__drFastDynRefresh = true;
        dynProto.refresh = function () {
          const texts = this.evaluateConditions();
          const key = Array.isArray(texts) ? texts.join('\x01') : '';
          if (this._drDynKey === key && this.contents) {
            this._displayTexts = texts;
            return;
          }
          this._drDynKey = key;
          this._displayTexts = texts;
          const savedX = this.x;
          const savedY = this.y;
          const numLines = Math.max(texts.length, 1);
          const newHeight = this.fittingHeight(numLines);
          if (this.height !== newHeight || !this.contents) {
            this.height = newHeight;
            this.createContents();
          } else {
            this.contents.clear();
          }
          this.x = savedX;
          this.y = savedY;
          this.drawAllText();
        };
      }
      const posWin = this._positionedBattleTextWindow;
      const posProto = posWin ? Object.getPrototypeOf(posWin) : null;
      if (
        posProto &&
        !posProto.__drFastPosRefresh &&
        typeof posProto.refresh === 'function' &&
        typeof posProto.evaluateConditions === 'function' &&
        typeof posProto.drawAllPositionedText === 'function'
      ) {
        posProto.__drFastPosRefresh = true;
        posProto.refresh = function () {
          const entries = this.evaluateConditions();
          let key = '';
          if (Array.isArray(entries)) {
            for (let i = 0; i < entries.length; i++) {
              const e = entries[i];
              key += `${i ? '\x01' : ''}${e?.text ?? ''}@${e?.x ?? 0},${e?.y ?? 0}`;
            }
          }
          if (this._drPosKey === key && this.contents) {
            this._activeEntries = entries;
            return;
          }
          this._drPosKey = key;
          this._activeEntries = entries;
          this.contents.clear();
          this.drawAllPositionedText();
        };
      }
      return res;
    };
  }

  installMzOpenTypePixelFontCompat(runtime);
}

/**
 * Mirror `OpenTypePixelFont.js` hooks from `CanvasRenderingContext2D.prototype` onto
 * `OffscreenCanvasRenderingContext2D.prototype` (used by all OffscreenCanvas-backed MZ Bitmaps!)
 * and install shift-invariant snapped glyph command buffer + `_groupTextForDrawing` caches
 * across both prototypes. Runs idempotently per prototype (`__drFastOpenType`) rather than behind
 * `runtime.__drMzFastPathsInstalled` so late-loaded plugins and multi-suite tests always sync.
 */
function installMzOpenTypePixelFontCompat(runtime: Record<string, any>): void {
  const ctx2dProtos = syncCanvas2DPluginPrototypes(runtime);
  const Ctx2DProto = runtime.CanvasRenderingContext2D?.prototype;
  if (
    Ctx2DProto &&
    typeof Ctx2DProto._pathText === 'function' &&
    typeof Ctx2DProto._fillText === 'function' &&
    typeof Ctx2DProto._strokeText === 'function' &&
    !Ctx2DProto.__drFastOpenType
  ) {
    const origGroup = Ctx2DProto._groupTextForDrawing;
    let fastGroupFn: any = null;
    if (typeof origGroup === 'function') {
      const groupCache = new Map<string, any>();
      fastGroupFn = function (this: any, t: string, f: any, w: any) {
        if (this.options || runtime.openFontLoading || typeof t !== 'string' || t.length > 96 || !f || !f.isOpenFont) {
          return origGroup.call(this, t, f, w);
        }
        const key = `${f.fontSize || ''}|${f.fontFamily || ''}|${w === undefined ? '' : w}|${t}`;
        let hit = groupCache.get(key);
        if (hit !== undefined) return hit;
        hit = origGroup.call(this, t, f, w);
        if (groupCache.size >= 1024) groupCache.clear();
        groupCache.set(key, hit);
        return hit;
      };
    }

    const origPathText = Ctx2DProto._pathText;
    const origFillText = Ctx2DProto._fillText;
    const origStrokeText = Ctx2DProto._strokeText;
    const pathBufCache = new Map<string, Float32Array | null>();
    let nextFontId = 1;

    const getPackedGlyphPath = (ctx: any, g: any, f: any, rx: number, ry: number, w: number): Float32Array | null => {
      const ofnt = g.font;
      if (!ofnt) return null;
      let fid = ofnt._drFontId;
      if (!fid) {
        fid = nextFontId++;
        ofnt._drFontId = fid;
      }
      const sc = g.scale < 1 && ofnt.shouldSquishText ? Math.round(g.scale * 1000) / 1000 : 1;
      const it = String(f.fontStyle || '').includes('italic') ? 1 : 0;
      const key = `${fid}|${f.size}|${it}|${sc}|${rx}|${ry}|${g.text}`;
      let packed = pathBufCache.get(key);
      if (packed !== undefined) return packed;

      const raw = origPathText.call(ctx, g, f, rx, ry, w);
      if (!raw || (raw._layers && raw._layers.length) || raw._image || !Array.isArray(raw.commands)) {
        pathBufCache.set(key, null);
        return null;
      }
      const cmds = raw.commands;
      const nums: number[] = [];
      for (let i = 0; i < cmds.length; i++) {
        const c = cmds[i];
        if (!c) continue;
        // Strip OpenTypePixelFont's 68 dummy (-12345, -12345) Chromium workaround commands
        if (c.x === -12345 && c.y === -12345) continue;
        const tp = c.type;
        if (tp === 'M') {
          nums.push(0, c.x, c.y);
        } else if (tp === 'L') {
          nums.push(1, c.x, c.y);
        } else if (tp === 'Q') {
          nums.push(2, c.x1, c.y1, c.x, c.y);
        } else if (tp === 'C') {
          nums.push(3, c.x1, c.y1, c.x2, c.y2, c.x, c.y);
        } else if (tp === 'Z') {
          nums.push(4);
        }
      }
      packed = new Float32Array(nums);
      if (pathBufCache.size >= 1536) pathBufCache.clear();
      pathBufCache.set(key, packed);
      return packed;
    };

    const fastFillText = function (this: any, g: any, f: any, x: number, y: number, w: number) {
      if (
        !this.options &&
        g?.font &&
        typeof g.text === 'string' &&
        g.text.length > 0 &&
        g.text.length <= 64 &&
        Number.isFinite(x) &&
        Number.isFinite(y)
      ) {
        const kx = Math.floor(x);
        const ky = Math.floor(y);
        const rx = Math.round((x - kx) * 4) / 4;
        const ry = Math.round((y - ky) * 4) / 4;
        const buf = getPackedGlyphPath(this, g, f, rx, ry, w);
        if (buf) {
          if (buf.length === 0) return;
          this.beginPath();
          for (let i = 0, len = buf.length; i < len; ) {
            const op = buf[i++];
            if (op === 0) {
              this.closePath();
              this.moveTo(buf[i++] + kx, buf[i++] + ky);
            } else if (op === 1) {
              this.lineTo(buf[i++] + kx, buf[i++] + ky);
            } else if (op === 2) {
              this.quadraticCurveTo(buf[i++] + kx, buf[i++] + ky, buf[i++] + kx, buf[i++] + ky);
            } else if (op === 3) {
              this.bezierCurveTo(
                buf[i++] + kx,
                buf[i++] + ky,
                buf[i++] + kx,
                buf[i++] + ky,
                buf[i++] + kx,
                buf[i++] + ky,
              );
            } else if (op === 4) {
              this.closePath();
            }
          }
          this.closePath();
          this.fill();
          return;
        }
      }
      return origFillText.call(this, g, f, x, y, w);
    };

    const fastStrokeText = function (this: any, g: any, f: any, x: number, y: number, w: number) {
      if (
        !this.options &&
        g?.font &&
        typeof g.text === 'string' &&
        g.text.length > 0 &&
        g.text.length <= 64 &&
        Number.isFinite(x) &&
        Number.isFinite(y)
      ) {
        const sw = Math.round((this.lineWidth || 0) / 2) * 2;
        if (sw <= 0) return;
        const kx = Math.floor(x);
        const ky = Math.floor(y);
        const rx = Math.round((x - kx) * 4) / 4;
        const ry = Math.round((y - ky) * 4) / 4;
        const buf = getPackedGlyphPath(this, g, f, rx, ry, w);
        if (buf) {
          if (buf.length === 0) return;
          this.beginPath();
          for (let i = 0, len = buf.length; i < len; ) {
            const op = buf[i++];
            if (op === 0) {
              this.closePath();
              this.moveTo(buf[i++] + kx, buf[i++] + ky);
            } else if (op === 1) {
              this.lineTo(buf[i++] + kx, buf[i++] + ky);
            } else if (op === 2) {
              this.quadraticCurveTo(buf[i++] + kx, buf[i++] + ky, buf[i++] + kx, buf[i++] + ky);
            } else if (op === 3) {
              this.bezierCurveTo(
                buf[i++] + kx,
                buf[i++] + ky,
                buf[i++] + kx,
                buf[i++] + ky,
                buf[i++] + kx,
                buf[i++] + ky,
              );
            } else if (op === 4) {
              this.closePath();
            }
          }
          this.closePath();
          this.lineWidth = sw;
          this.stroke();
          return;
        }
      }
      return origStrokeText.call(this, g, f, x, y, w);
    };

    for (const proto of ctx2dProtos) {
      if (!proto || proto.__drFastOpenType) continue;
      proto.__drFastOpenType = true;
      if (fastGroupFn) proto._groupTextForDrawing = fastGroupFn;
      proto._fillText = fastFillText;
      proto._strokeText = fastStrokeText;
    }
  }
}

/**
 * Install RPG Maker MZ runtime compatibility hooks + WebGL2 Quick Overlay Menu (Minus '-').
 */
export function installMzCompat(
  runtime: Record<string, any>,
  host: BrowserHost,
  input: InputBridge,
  game: GameEntry,
  options: MzCompatOptions = {},
): void {
  const { Utils, Graphics, SceneManager, WebAudio, PIXI, StorageManager, Bitmap } = runtime;

  // 0a. Provide `globalThis.main` (created by stock MZ's `js/main.js`: `const main = new Main()`)
  //     so plugins that reference `main` in global scope (e.g. VisuMZ_2_BattleGridSystem.js's
  //     `Game_Action.prototype.getAreaOfEffectTargets`: `if (member === main) continue;`) never throw
  //     `ReferenceError: main is not defined` during AoE / special skills!
  if (!('main' in runtime) || runtime.main === undefined) {
    runtime.main = { xhrSucceeded: true, loadCount: 0, error: null };
  }

  // 0. Forward console.error / console.warn (up to 40 distinct messages) to mz.log so PIXI v5
  //    shader / WebGL / plugin diagnostics are captured without per-frame duplicate spam.
  if (runtime.console && !runtime.console.__drMzLogHooked) {
    runtime.console.__drMzLogHooked = true;
    const seenConsoleMsgs = new Set<string>();
    for (const level of ['error', 'warn'] as const) {
      const origFn = typeof runtime.console[level] === 'function'
        ? runtime.console[level].bind(runtime.console)
        : null;
      runtime.console[level] = (...args: any[]) => {
        if (seenConsoleMsgs.size < 40) {
          const txt = args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ').slice(0, 600);
          const key = `${level}:${txt}`;
          if (txt && !seenConsoleMsgs.has(key)) {
            seenConsoleMsgs.add(key);
            log(`[console.${level}] ${txt}`);
          }
        }
        origFn?.(...args);
      };
    }
  }

  // 0b. Fast bounds guard on Bitmap.getPixel / Bitmap.getAlphaPixel to avoid out-of-bounds
  //     getImageData calls (e.g. picture hover plugins querying negative coordinates).
  if (Bitmap?.prototype && !Bitmap.prototype.__drMzPixelGuarded) {
    Bitmap.prototype.__drMzPixelGuarded = true;
    const origGetPixel = Bitmap.prototype.getPixel;
    if (typeof origGetPixel === 'function') {
      Bitmap.prototype.getPixel = function (x: number, y: number) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) {
          return '#000000';
        }
        return origGetPixel.call(this, x, y);
      };
    }
    const origGetAlphaPixel = Bitmap.prototype.getAlphaPixel;
    if (typeof origGetAlphaPixel === 'function') {
      Bitmap.prototype.getAlphaPixel = function (x: number, y: number) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) {
          return 0;
        }
        return origGetAlphaPixel.call(this, x, y);
      };
    }
  }

  // 1. Report NW.js / local mode + native FFmpeg OGG decoding (skip slow JS VorbisDecoder!)
  //    + browser feature checks so SceneManager.checkBrowser() never rejects Switch 2.
  if (Utils) {
    Utils.isNwjs = () => true;
    Utils.isLocal = () => true;
    Utils.canUseWebGL = () => true;
    Utils.canUseWebAudioAPI = () => true;
    Utils.canUseCssFontLoading = () => true;
    Utils.canUseIndexedDB = () => true;
    Utils.canPlayOgg = () => true;
    Utils.canPlayWebm = () => true;
  }

  if (WebAudio?.prototype) {
    WebAudio.prototype._shouldUseDecoder = () => false;
  }

  // 2. Disable PIXI v5 async createImageBitmap path (nx.js Images are already decoded)
  if (PIXI?.settings) {
    PIXI.settings.CREATE_IMAGE_BITMAP = false;
    PIXI.settings.FAIL_IF_MAJOR_PERFORMANCE_CAVEAT = false;
    if (PIXI.utils) {
      PIXI.utils.isWebGLSupported = () => true;
    }
  }

  // 3. Ensure MZ StorageManager writes .rmmzsave files into `<gameDir>/save/`
  //    and log any DataManager.saveGame / DataManager.loadGame rejection into mz.log for debugging.
  if (StorageManager) {
    const cleanSaveDir = game.saveDir.replace(/\/+$/, '') + '/';
    StorageManager.isLocalMode = () => true;
    StorageManager.fileDirectoryPath = () => cleanSaveDir;
    log(`[mz-saves] SD-card saves mounted at ${cleanSaveDir}`);
  }
  const DM = runtime.DataManager;
  if (DM && !DM.__drMzSaveDiagHooked) {
    DM.__drMzSaveDiagHooked = true;
    for (const fnName of ['loadGame', 'saveGame'] as const) {
      const origFn = DM[fnName];
      if (typeof origFn === 'function') {
        DM[fnName] = function (savefileId: any) {
          const p = origFn.apply(this, arguments as any);
          if (p && typeof p.catch === 'function') {
            return p.catch((err: unknown) => {
              const msg = err instanceof Error ? err.stack || err.message : String(err);
              log(`[mz-saves] DataManager.${fnName}(${String(savefileId)}) failed: ${msg}`);
              throw err;
            });
          }
          return p;
        };
      }
    }
  }

  // 3b. Install universal RPG Maker MZ runtime performance fast-paths & OpenTypePixelFont OffscreenCanvas sync
  installMzRuntimeFastPaths(runtime);
  installMzOpenTypePixelFontCompat(runtime);

  // 4. WebGL2 Minus (-) Quick Menu + Basic/Pro Performance HUD rendered through PIXI v5 over FBO 0!
  let overlayOpen = false;
  let hudMode: HudMode = 'off';
  let selected = 0;
  let prevUp = false;
  let prevDown = false;
  let prevA = false;
  let prevB = false;

  let fpsFrames = 0;
  let fpsLast = performance.now();
  let fpsDisplay = 60;
  let perfFrames = 0;
  let perfLastLog = performance.now();
  // Per-10s perf breakdown: game update vs scene render time, and hitches (ticks over 40 ms)
  let perfUpdMs = 0;
  let perfRenMs = 0;
  let perfHitches = 0;
  let perfHitchMax = 0;
  let perfTexMs = 0;
  let hitchDetailsLogged = 0;
  // V8 heap sampling around each tick (only while hitch details are still being logged):
  // a big usedHeapSize drop inside a stalled frame means the stall was a garbage collection.
  const heapUsedMiB = (): number => {
    try {
      const m: any = (getSwitch() as any)?.memoryUsage?.();
      const v = m?.usedHeapSize ?? m?.used;
      return typeof v === 'number' ? v / (1024 * 1024) : -1;
    } catch { return -1; }
  };
  let hitchDetailsThisWindow = 0;
  let perfLogCount = 0;

  // Live PRO HUD rolling metrics & 48-frame sparkline ring buffer for MZ
  let mzHudFrames = 0;
  let mzHudLastMs = performance.now();
  let mzHudPrevFrameMs = performance.now();
  let mzHudTickSum = 0;
  let mzHudFps = 60;
  let mzHudFrameMs = 16.7;
  let mzHudTickMs = 0;
  let mzHudDrawsPerFrame = 0;
  let mzHudPrevGlDraws = 0;
  let mzHudRenderTick = 0;
  const MZ_HIST_LEN = 48;
  const mzFrameHist = new Float32Array(MZ_HIST_LEN);
  let mzFrameHistHead = 0;

  let overlayCanvas: any = null;
  let overlayCtx: any = null;
  let overlaySprite: any = null;
  let overlayContainer: any = null;
  let overlayTex: any = null;
  let lastOverlayRenderKey = '';

  const returnToLauncher = () => {
    const sw = getSwitch();
    try {
      if (options.returnNroPath && typeof sw?.Application === 'function') {
        log(`[mz-overlay] returning to launcher NRO -> ${options.returnNroPath}`);
        new sw.Application(options.returnNroPath).launch();
        return;
      }
      if (typeof sw?.Application?.self?.launch === 'function') {
        sw.Application.self.launch();
        return;
      }
    } catch (err) {
      log(`[mz-overlay] handoff failed (${String(err)}), exiting`);
    }
    sw?.exit();
  };

  const setOverlayOpen = (next: boolean) => {
    if (overlayOpen === next) return;
    overlayOpen = next;
    input.setOverlayOpen(next);
    lastOverlayRenderKey = '';
    if (next) {
      // Prime edge flags so holding A/B/D-pad while pressing Minus (-) never immediately closes or fires Resume
      prevUp = true;
      prevDown = true;
      prevA = true;
      prevB = true;
    }
  };

  // Quick Menu "Log On-Screen Objects": visible display objects that cover a noticeable part of the
  // screen OR are long and thin (streaks/lines), with class, bounds, scale, rotation, alpha, blend mode,
  // texture frame and image, so rendering glitches can be traced to the object that draws them.
  const dumpMzScene = () => {
    const scene = runtime.SceneManager?._scene;
    if (!scene) {
      log('[mz-dump] no active scene');
      return;
    }
    const lines: string[] = [];
    const MAX_LINES = 160;
    let thinCount = 0;
    const imgName = (o: any): string => {
      const bmp = o.bitmap;
      const url = String(bmp?._url || bmp?.url || bmp?._image?.src || o.texture?.baseTexture?.resource?.url || '');
      if (url) return ` img=${url.split('/').pop()}`;
      if (bmp) return ` img=canvas${bmp.width}x${bmp.height}`;
      return '';
    };
    const walk = (obj: any, depth: number) => {
      if (!obj || lines.length >= MAX_LINES || !obj.visible || obj.worldAlpha <= 0) return;
      let b: any = null;
      try { b = obj.getBounds?.(); } catch { /* ignore */ }
      const w = b ? Math.max(0, b.width) : 0;
      const h = b ? Math.max(0, b.height) : 0;
      const big = w * h >= 8000;
      const thin = (h >= 100 && w > 0 && w <= 12) || (w >= 100 && h > 0 && h <= 12);
      if ((big || thin) && obj.renderable !== false) {
        if (thin) thinCount++;
        let extra = '';
        if (obj.scale && (obj.scale.x !== 1 || obj.scale.y !== 1)) {
          extra += ` scale=${Number(obj.scale.x).toFixed(2)},${Number(obj.scale.y).toFixed(2)}`;
        }
        if (obj.rotation) extra += ` rot=${Number(obj.rotation).toFixed(2)}`;
        const fr = obj.texture?.frame || obj._frame;
        if (fr && fr.width !== undefined) extra += ` frame=${fr.x},${fr.y},${fr.width}x${fr.height}`;
        extra += imgName(obj);
        if (obj.filters?.length) extra += ` filters=${obj.filters.map((f: any) => f?.constructor?.name).join('+')}`;
        if (obj.blendMode) extra += ` blend=${obj.blendMode}`;
        if (obj.tint !== undefined && obj.tint !== 0xffffff) extra += ` tint=${Number(obj.tint).toString(16)}`;
        lines.push(
          `${' '.repeat(Math.min(depth, 12))}${thin ? '[thin] ' : ''}${obj.constructor?.name || 'Object'} ` +
          `[${Math.round(b.x)},${Math.round(b.y)} ${Math.round(w)}x${Math.round(h)}] a=${Number(obj.alpha).toFixed(2)} ` +
          `wa=${Number(obj.worldAlpha).toFixed(2)}${extra}`,
        );
      }
      const kids = obj.children;
      if (Array.isArray(kids)) for (const k of kids) walk(k, depth + 1);
    };
    walk(scene, 0);
    log(`[mz-dump] scene=${scene.constructor?.name} (${lines.length} objects, ${thinCount} thin)\n${lines.join('\n')}`);
  };

  const menuItems = () => [
    { label: 'Resume Game', run: () => setOverlayOpen(false) },
    {
      label: `Display Mode: ${host.getDisplayMode().toUpperCase()}`,
      run: () => {
        const idx = (DISPLAY_MODES.indexOf(host.getDisplayMode()) + 1) % DISPLAY_MODES.length;
        host.setDisplayMode(DISPLAY_MODES[idx]);
        lastOverlayRenderKey = '';
        log(`[mz-overlay] displayMode -> ${DISPLAY_MODES[idx]}`);
      },
    },
      {
      label: `Performance HUD: ${HUD_MODE_LABELS[hudMode]}`,
      run: () => {
        hudMode = nextHudMode(hudMode);
        lastOverlayRenderKey = '';
      },
    },
    {
      label: 'Log On-Screen Objects (debug)',
      run: () => {
        try { dumpMzScene(); } catch (err) { log(`[mz-dump] failed: ${String(err)}`); }
      },
    },
    {
      label: 'Run Garbage Collector (gc)',
      run: () => {
        try { runtime.gc?.(); log('[mz-overlay] manual gc() triggered'); } catch { /* ignore */ }
      },
    },
    { label: 'Return to Game Select', run: returnToLauncher },
    {
      label: 'Exit to hbmenu (kaiHEN)',
      run: () => {
        log('[mz-overlay] clean exit requested');
        getSwitch()?.exit();
      },
    },
  ];

  const ensureOverlayResources = (gw: number, gh: number) => {
    if (!PIXI) return false;
    if (!overlayCanvas || overlayCanvas.width !== gw || overlayCanvas.height !== gh) {
      const OC = runtime.OffscreenCanvas ?? (typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas : null);
      if (OC) {
        overlayCanvas = new OC(gw, gh);
      } else if (runtime.document?.createElement) {
        overlayCanvas = runtime.document.createElement('canvas');
        overlayCanvas.width = gw;
        overlayCanvas.height = gh;
      } else {
        return false;
      }
      overlayCtx = overlayCanvas.getContext('2d');
      overlayTex = PIXI.Texture.from(overlayCanvas);
      overlaySprite = new PIXI.Sprite(overlayTex);
      overlayContainer = new PIXI.Container();
      overlayContainer.addChild(overlaySprite);
      lastOverlayRenderKey = '';
    }
    return Boolean(overlayCtx && overlaySprite && overlayContainer && overlayTex);
  };

  const drawOverlayAndHud = (renderer: any) => {
    const gw = Graphics?.width || 816;
    const gh = Graphics?.height || 624;

    fpsFrames++;
    const now = performance.now();
    if (now - fpsLast >= 500) {
      fpsDisplay = Math.round((fpsFrames * 1000) / (now - fpsLast));
      fpsFrames = 0;
      fpsLast = now;
    }

    if (overlayOpen) {
      const pad = input.pollGamepadRaw();
      const up = Boolean(pad?.buttons?.[12]?.pressed || (pad?.axes?.[1] ?? 0) < -0.5);
      const down = Boolean(pad?.buttons?.[13]?.pressed || (pad?.axes?.[1] ?? 0) > 0.5);
      const a = Boolean(pad?.buttons?.[1]?.pressed);
      const b = Boolean(pad?.buttons?.[0]?.pressed);
      const list = menuItems();
      if (up && !prevUp) selected = (selected + list.length - 1) % list.length;
      if (down && !prevDown) selected = (selected + 1) % list.length;
      if (b && !prevB) setOverlayOpen(false);
      else if (a && !prevA) list[selected]?.run();
      prevUp = up; prevDown = down; prevA = a; prevB = b;
    } else {
      prevUp = prevDown = prevA = prevB = false;
    }

    if (!overlayOpen && hudMode === 'off') return;
    if (!ensureOverlayResources(gw, gh)) return;

    const sw = getSwitch();
    let memMiB = 0;
    try {
      const m: any = sw?.memoryUsage?.();
      memMiB = Math.round((m?.usedHeapSize ?? m?.used ?? 0) / (1024 * 1024));
    } catch { /* ignore */ }
    const renderKey = overlayOpen
      ? `menu|${selected}|${host.getDisplayMode()}|${hudMode}`
      : hudMode === 'pro'
        ? `pro|${mzHudRenderTick}|${host.getDisplayMode()}`
        : `basic|${fpsDisplay}|${memMiB}|${host.getDisplayMode()}`;

    if (renderKey !== lastOverlayRenderKey) {
      lastOverlayRenderKey = renderKey;
      const ctx = overlayCtx;
      ctx.clearRect(0, 0, gw, gh);
      if (overlayOpen) {
        const list = menuItems();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
        ctx.fillRect(0, 0, gw, gh);
        const boxW = Math.min(gw - 40, 560);
        const rowH = 38;
        const boxH = 104 + list.length * rowH + 46;
        const bx = Math.floor((gw - boxW) / 2);
        const by = Math.floor((gh - boxH) / 2);
        ctx.fillStyle = '#141926';
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.strokeStyle = '#3dd6a5';
        ctx.lineWidth = 3;
        ctx.strokeRect(bx, by, boxW, boxH);

        ctx.fillStyle = '#ffffff';
        ctx.font = '21px sans-serif';
        ctx.textBaseline = 'top';
        const titleStr = `${game.title} — Switch 2 (MZ)`;
        ctx.fillText(titleStr.length > 42 ? titleStr.slice(0, 41) + '…' : titleStr, bx + 24, by + 18);

        ctx.fillStyle = '#9aa8c7';
        ctx.font = '12px sans-serif';
        ctx.fillText('A: Confirm  •  B / Minus: Resume  •  X: Menu  •  Y: Dash', bx + 24, by + 50);

        for (let i = 0; i < list.length; i++) {
          const y = by + 88 + i * rowH;
          if (i === selected) {
            ctx.fillStyle = 'rgba(61, 214, 165, 0.25)';
            ctx.fillRect(bx + 18, y - 4, boxW - 36, 32);
          }
          ctx.fillStyle = i === selected ? '#ffffff' : '#c7d1e8';
          ctx.font = '17px sans-serif';
          ctx.fillText(`${i === selected ? '> ' : '  '}${list[i].label}`, bx + 28, y + 3);
        }

        ctx.fillStyle = '#7f8ca8';
        ctx.font = '12px sans-serif';
        const footer = `Saves: ${game.saveDir}/`;
        ctx.fillText(footer.length > 72 ? footer.slice(0, 71) + '…' : footer, bx + 24, by + boxH - 26);
      } else if (hudMode !== 'off') {
        const vp = host.getViewport();
        const scene = runtime.SceneManager?._scene;
        const sceneName = scene?.constructor?.name || 'none';
        const glSt = host.getWebGLContext?.()?.__drGetStats?.() ?? null;
        drawPerfHud(ctx, hudMode, {
          engine: 'MZ',
          backend: 'WebGL2',
          fps: hudMode === 'pro' ? mzHudFps : fpsDisplay,
          frameMs: hudMode === 'pro' ? mzHudFrameMs : (fpsDisplay > 0 ? 1000 / fpsDisplay : 16.7),
          updateMs: hudMode === 'pro' ? mzHudTickMs : undefined,
          sceneName,
          displayMode: host.getDisplayMode(),
          gameW: vp.gw,
          gameH: vp.gh,
          vpW: vp.w,
          vpH: vp.h,
          memMiB,
          map: sceneName === 'Scene_Map'
            ? {
                ev: runtime.$gameMap?._events?.length ?? 0,
                ch: scene?._spriteset?._characterSprites?.length ?? 0,
                pic: scene?._spriteset?._pictureContainer?.children?.length ?? 0,
              }
            : null,
          gl: glSt
            ? {
                drawsPerFrame: mzHudDrawsPerFrame,
                texUploads: glSt.texUploads,
                err: glSt.err,
              }
            : null,
          frameHistory: mzFrameHist,
          frameHistoryHead: mzFrameHistHead,
        });
      }
      overlayTex.baseTexture?.update?.();
    }

    try {
      renderer.render(overlayContainer, undefined, false);
    } catch (err) {
      log(`[mz-overlay] render failed: ${String(err)}`);
    }
  };

  let lastAutoGcMs = 0;
  let fatalLatched = false;

  // 5. Log any PIXI.Application init error instead of letting MZ swallow it silently,
  //    and hook Graphics._onTick for letterbox clear, Minus (-) overlay, and perf telemetry.
  if (Graphics && !Graphics.__drMzHooked) {
    Graphics.__drMzHooked = true;
    const origCreatePixi = Graphics._createPixiApp;
    if (typeof origCreatePixi === 'function') {
      Graphics._createPixiApp = function () {
        try {
          this._setupPixi();
          this._app = new PIXI.Application({
            view: this._canvas,
            autoStart: false,
          });
          this._app.ticker.remove(this._app.render, this._app);
          this._app.ticker.add(this._onTick, this);
          log(`[mz-Graphics] PIXI.Application created (renderer=${this._app.renderer?.constructor?.name ?? 'unknown'}, type=${this._app.renderer?.type ?? '?'})`);
        } catch (e: any) {
          log(`[mz-Graphics] _createPixiApp FAILED: ${e instanceof Error ? e.stack || e.message : String(e)}`);
          this._app = null;
        }
      };
    }
    const origResize = Graphics.resize;
    if (typeof origResize === 'function') {
      Graphics.resize = function (width: number, height: number) {
        origResize.call(this, width, height);
        if (width > 0 && height > 0 && this._app?.renderer?.resize) {
          try {
            this._app.renderer.resize(width, height);
          } catch { /* ignore */ }
        }
      };
    }
    if (SceneManager && !SceneManager.__drMzPerfSplit) {
      SceneManager.__drMzPerfSplit = true;
      const timeIt = (name: string, add: (ms: number) => void) => {
        const orig = SceneManager[name];
        if (typeof orig !== 'function') return;
        SceneManager[name] = function () {
          const t0 = performance.now();
          try {
            return orig.apply(this, arguments);
          } finally {
            add(performance.now() - t0);
          }
        };
      };
      timeIt('updateScene', (ms) => { perfUpdMs += ms; });
    }
    const origOnTick = Graphics._onTick;
    Graphics._onTick = function (deltaTime: number) {
      if (fatalLatched) return;
      if (
        this._width > 0 &&
        this._height > 0 &&
        this._app?.renderer?.resize &&
        (this._app.renderer.width !== this._width || this._app.renderer.height !== this._height)
      ) {
        try {
          this._app.renderer.resize(this._width, this._height);
        } catch { /* ignore */ }
      }

      // Poll Minus (-) BEFORE SceneManager.updateInputData() so opening/closing the Quick Menu
      // never leaks physical button 8 into game input on the toggle frame.
      if (input.isMinusJustPressed()) {
        setOverlayOpen(!overlayOpen);
        selected = 0;
      }

      const gl = host.getWebGLContext();
      gl?.__drClearScreen?.();

      if (overlayOpen) {
        if (this._canRender?.() && this._app?.renderer) {
          this._app.render();
          drawOverlayAndHud(this._app.renderer);
        }
        return;
      }

      const tc0 = gl?.__drTexCounters?.();
      if (tc0) gl.__drResetTexMax?.();
      const upd0 = perfUpdMs;
      const heap0 = hitchDetailsLogged < 60 ? heapUsedMiB() : -1;
      const tick0 = performance.now();
      origOnTick.call(this, deltaTime);
      const tickDt = performance.now() - tick0;
      // MZ renders inside Graphics._onTick (this._app.render()), not via SceneManager.renderScene:
      // everything in the tick that isn't scene update counts as render.
      const updDt = perfUpdMs - upd0;
      perfRenMs += Math.max(0, tickDt - updDt);
      const tc1 = gl?.__drTexCounters?.();
      const texDt = tc0 && tc1 ? tc1[1] - tc0[1] : 0;
      perfTexMs += texDt;
      if (tickDt > 40) {
        perfHitches++;
        if (tickDt > perfHitchMax) perfHitchMax = tickDt;
        // Explain the first few stalls of each 10 s window: game update vs drawing vs texture uploads
        if (hitchDetailsLogged < 60 && hitchDetailsThisWindow < 4) {
          hitchDetailsLogged++;
          hitchDetailsThisWindow++;
          const texInfo = tc0 && tc1
            ? ` texUploads=${tc1[0] - tc0[0]} (${texDt.toFixed(1)}ms, largest ${tc1[2].toFixed(1)}ms ${Math.round(Math.sqrt(tc1[3]))}^2px)`
            : '';
          const heap1 = heap0 >= 0 ? heapUsedMiB() : -1;
          const heapInfo = heap0 >= 0 && heap1 >= 0
            ? ` heap=${heap0.toFixed(1)}->${heap1.toFixed(1)}MiB${heap1 < heap0 - 1 ? ' (GC)' : ''}`
            : '';
          log(
            `[mz-hitch] ${tickDt.toFixed(0)}ms: update=${updDt.toFixed(1)}ms render=${Math.max(0, tickDt - updDt).toFixed(1)}ms` +
            `${texInfo}${heapInfo} scene=${SceneManager?._scene?.constructor?.name || 'none'}`,
          );
        }
      }

      if (hudMode === 'pro') {
        const nowTick = performance.now();
        const fDelta = Math.max(0, Math.min(250, nowTick - mzHudPrevFrameMs));
        mzHudPrevFrameMs = nowTick;
        mzFrameHist[mzFrameHistHead] = fDelta;
        mzFrameHistHead = (mzFrameHistHead + 1) % MZ_HIST_LEN;
        mzHudFrames++;
        mzHudTickSum += tickDt;
        const hudElapsed = nowTick - mzHudLastMs;
        if (hudElapsed >= 250 && mzHudFrames > 0) {
          mzHudFps = (mzHudFrames * 1000) / hudElapsed;
          mzHudFrameMs = hudElapsed / mzHudFrames;
          mzHudTickMs = mzHudTickSum / mzHudFrames;
          const glSt = gl?.__drGetStats?.();
          if (glSt) {
            mzHudDrawsPerFrame = Math.max(0, glSt.draws - mzHudPrevGlDraws) / mzHudFrames;
            mzHudPrevGlDraws = glSt.draws;
          }
          mzHudFrames = 0;
          mzHudTickSum = 0;
          mzHudLastMs = nowTick;
          mzHudRenderTick++;
        }
      } else {
        mzHudPrevFrameMs = performance.now();
        mzHudFrames = 0;
        mzHudTickSum = 0;
        mzHudLastMs = mzHudPrevFrameMs;
      }

      if (this._app?.renderer) {
        drawOverlayAndHud(this._app.renderer);
      }

      perfFrames++;
      const now = performance.now();
      const elapsed = now - perfLastLog;
      if (elapsed >= 10000) {
        const fps = (perfFrames * 1000) / Math.max(1, elapsed);
        const sceneName = SceneManager?._scene?.constructor?.name || 'none';
        if (perfLogCount < 24 && (perfLogCount < 2 || fps < 55 || runtime.__drHudMode === 'pro')) {
          perfLogCount++;
          const st = gl?.__drGetStats?.();
          const extra = st
            ? ` draws=${st.draws} tex=${st.texUploads} rbFix=${st.rbFixes} glErr=0x${(st.err >>> 0).toString(16)}`
            : '';
          const split = perfFrames > 0
            ? ` update=${(perfUpdMs / perfFrames).toFixed(1)}ms render=${(perfRenMs / perfFrames).toFixed(1)}ms` +
              ` texUpload=${(perfTexMs / perfFrames).toFixed(1)}ms` +
              ` hitch=${perfHitches}(max ${Math.round(perfHitchMax)}ms)`
            : '';
          log(`[mz-perf] fps=${fps.toFixed(1)}${split} scene=${sceneName} size=${Graphics.width}x${Graphics.height} webgl2=true${extra}`);
        }
        perfFrames = 0;
        perfLastLog = now;
        perfUpdMs = 0;
        perfRenMs = 0;
        perfHitches = 0;
        perfHitchMax = 0;
        perfTexMs = 0;
        hitchDetailsThisWindow = 0;
      }
    };
  }

  // 6. Log SceneManager exceptions cleanly, auto-GC on non-menu scene transitions & allow A-button return to launcher
  if (SceneManager && !SceneManager.__drMzErrHooked) {
    SceneManager.__drMzErrHooked = true;
    const origChangeScene = SceneManager.changeScene;
    if (typeof origChangeScene === 'function') {
      SceneManager.changeScene = function () {
        const prevScene = this._scene;
        const res = origChangeScene.call(this);
        if (prevScene && this._scene !== prevScene && typeof runtime.gc === 'function') {
          const MenuBase = runtime.Scene_MenuBase;
          const isMenu = typeof MenuBase === 'function' && (prevScene instanceof MenuBase || this._scene instanceof MenuBase);
          const now = performance.now();
          if (!isMenu && now - lastAutoGcMs >= 30000) {
            try {
              const t0 = performance.now();
              runtime.gc();
              lastAutoGcMs = performance.now();
              const dt = lastAutoGcMs - t0;
              if (dt >= 25) {
                log(`[mz-gc] scene gc (${prevScene.constructor?.name || '?'}->${this._scene?.constructor?.name || '?'}) took ${dt.toFixed(1)}ms`);
              }
            } catch { /* ignore */ }
          }
        }
        return res;
      };
    }
    const origCatch = SceneManager.catchException;
    SceneManager.catchException = function (e: unknown) {
      if (fatalLatched) return;
      fatalLatched = true;
      const msg = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack || ''}` : String(e);
      log(`[mz-SceneManager] EXCEPTION: ${msg}`);
      try { Graphics?.stopGameLoop?.(); } catch { /* ignore */ }
      try { this.stop?.(); } catch { /* ignore */ }
      options.onFatalError?.(e instanceof Error ? e.name : 'Runtime Error', msg);
      if (typeof origCatch === 'function' && !options.onFatalError) {
        try { origCatch.call(this, e); } catch { /* ignore */ }
      }
    };
    const origCatchLoad = SceneManager.catchLoadError;
    if (typeof origCatchLoad === 'function') {
      SceneManager.catchLoadError = function (e: any) {
        log(`[mz-SceneManager] LOAD ERROR: ${Array.isArray(e) ? e.join(' | ') : String(e)}`);
        return origCatchLoad.call(this, e);
      };
    }
  }

  try {
    const m: any = (getSwitch() as any)?.memoryUsage?.();
    if (m) {
      const mib = (v: any) => (typeof v === 'number' ? (v / (1024 * 1024)).toFixed(1) : '?');
      log(`[mz-heap] used=${mib(m.usedHeapSize)}MiB total=${mib(m.totalHeapSize)}MiB limit=${mib(m.heapSizeLimit)}MiB`);
    }
  } catch { /* ignore */ }
  log('[mz-compat] Universal Switch 2 RPG Maker MZ WebGL2 compatibility layer installed');
}
