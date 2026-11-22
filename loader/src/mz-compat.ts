/**
 * Universal RPG Maker MZ compatibility & hardware WebGL2 (OunceVK / GLES3) layer
 * for Nintendo Switch 2 (kaiHEN / nx.js).
 */
import type { AssetReader } from './assets';
import type { BrowserHost, DisplayMode, ScriptFilter } from './browser-host';
import type { GameEntry } from './games';
import type { InputBridge } from './input';
import { getSwitch, log } from './log';
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
      i += 2;
      while (i < len && source.charCodeAt(i) !== 10 && source.charCodeAt(i) !== 13) i++;
      continue;
    }

    // Block comment
    if (ch === 47 /* / */ && i + 1 < len && source.charCodeAt(i + 1) === 42 /* * */) {
      i += 2;
      while (i + 1 < len && !(source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47)) i++;
      i = Math.min(len, i + 2);
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

  const decodeFont = (raw: ArrayBuffer | null, label: string): ArrayBuffer | null => {
    if (!raw || raw.byteLength < 64) return null;
    const sig = new DataView(raw).getUint32(0, false);
    try {
      const sfnt = decodeWoffToSfnt(raw, pakoInflate);
      if (sfnt && sig === 0x774f4646) {
        log(`[mz-fonts] decoded WOFF1 -> TTF/OTF (${label}: ${raw.byteLength} -> ${sfnt.byteLength} bytes)`);
      }
      return sfnt;
    } catch (err) {
      log(`[mz-fonts] WOFF decode failed for '${label}': ${String(err)}`);
      return null;
    }
  };

  const loadedBytesByFile = new Map<string, ArrayBuffer>();
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
        log(`[mz-fonts] pre-registered '${baseFamily}' <- fonts/${file}`);
      }
    } catch (err) {
      log(`[mz-fonts] skipped '${file}': ${String(err)}`);
    }
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
      log(`[mz-fonts] loaded family '${family}' <- ${fileName || fallbackFontName}`);
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

  // 0. Forward console.error / console.warn (first 40 messages) to debug.log so PIXI v5
  //    shader / WebGL / plugin diagnostics are always visible on Switch 2.
  if (runtime.console && !runtime.console.__drMzLogHooked) {
    runtime.console.__drMzLogHooked = true;
    let consoleLogCount = 0;
    for (const level of ['error', 'warn'] as const) {
      const origFn = typeof runtime.console[level] === 'function'
        ? runtime.console[level].bind(runtime.console)
        : null;
      runtime.console[level] = (...args: any[]) => {
        if (consoleLogCount < 40) {
          consoleLogCount++;
          const txt = args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');
          log(`[console.${level}] ${txt.slice(0, 600)}`);
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
  if (StorageManager) {
    const cleanSaveDir = game.saveDir.replace(/\/+$/, '') + '/';
    StorageManager.isLocalMode = () => true;
    StorageManager.fileDirectoryPath = () => cleanSaveDir;
    log(`[mz-saves] SD-card saves mounted at ${cleanSaveDir}`);
  }

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
        log(`[mz-overlay] hudMode -> ${hudMode}`);
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
      overlayCanvas = new OffscreenCanvas(gw, gh);
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

    if (input.isMinusJustPressed()) {
      setOverlayOpen(!overlayOpen);
      selected = 0;
    }

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
    try { memMiB = Math.round((sw?.memoryUsage?.()?.used || 0) / (1024 * 1024)); } catch { /* ignore */ }
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
    const origOnTick = Graphics._onTick;
    Graphics._onTick = function (deltaTime: number) {
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

      const gl = host.getWebGLContext();
      gl?.__drClearScreen?.();

      if (overlayOpen) {
        if (this._canRender?.() && this._app?.renderer) {
          this._app.render();
          drawOverlayAndHud(this._app.renderer);
        }
        return;
      }

      const tick0 = performance.now();
      origOnTick.call(this, deltaTime);
      const tickDt = performance.now() - tick0;

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
      if (elapsed >= 5000) {
        const fps = (perfFrames * 1000) / Math.max(1, elapsed);
        const sceneName = SceneManager?._scene?.constructor?.name || 'none';
        if (perfLogCount < 24) {
          perfLogCount++;
          const st = gl?.__drGetStats?.();
          const extra = st
            ? ` draws=${st.draws} tex=${st.texUploads} rbFix=${st.rbFixes} glErr=0x${(st.err >>> 0).toString(16)}`
            : '';
          log(`[mz-perf] fps=${fps.toFixed(1)} scene=${sceneName} size=${Graphics.width}x${Graphics.height} webgl2=true${extra}`);
        }
        if (fps < 52 && sceneName === 'Scene_Map' && typeof runtime.gc === 'function' && now - lastAutoGcMs >= 15000) {
          try {
            const t0 = performance.now();
            runtime.gc();
            lastAutoGcMs = performance.now();
            log(`[mz-gc] auto gc (low-fps:${fps.toFixed(1)}) took ${(lastAutoGcMs - t0).toFixed(1)}ms`);
          } catch { /* ignore */ }
        }
        perfFrames = 0;
        perfLastLog = now;
      }
    };
  }

  // 6. Log SceneManager exceptions cleanly, auto-GC on scene transitions & allow A-button return to launcher
  if (SceneManager && !SceneManager.__drMzErrHooked) {
    SceneManager.__drMzErrHooked = true;
    const origChangeScene = SceneManager.changeScene;
    if (typeof origChangeScene === 'function') {
      SceneManager.changeScene = function () {
        const prevScene = this._scene;
        const res = origChangeScene.call(this);
        if (prevScene && this._scene !== prevScene && typeof runtime.gc === 'function') {
          const now = performance.now();
          if (now - lastAutoGcMs >= 8000) {
            try {
              const t0 = performance.now();
              runtime.gc();
              lastAutoGcMs = performance.now();
              log(`[mz-gc] auto gc (scene:${prevScene.constructor?.name || '?'}->${this._scene?.constructor?.name || '?'}) took ${(lastAutoGcMs - t0).toFixed(1)}ms`);
            } catch { /* ignore */ }
          }
        }
        return res;
      };
    }
    const origCatch = SceneManager.catchException;
    SceneManager.catchException = function (e: unknown) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack || ''}` : String(e);
      log(`[mz-SceneManager] EXCEPTION: ${msg}`);
      options.onFatalError?.(e instanceof Error ? e.name : 'Runtime Error', msg);
      if (typeof origCatch === 'function') {
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

  log('[mz-compat] Universal Switch 2 RPG Maker MZ WebGL2 compatibility layer installed');
}
