/**
 * Universal RPG Maker MV compatibility & GPU acceleration layer for nx.js on Switch 2.
 *
 * Handles:
 *  - Automatic font discovery (`fonts/gamefont.css` + `www/fonts/*` + missing FontLoad aliases)
 *  - Automatic audio format detection (`.ogg`/`.rpgmvo` vs `.m4a`/`.rpgmvm`) via native FFmpeg
 *  - Bypassing PC/editor-only plugins (plus optional per-game `mv-loader.json` `skipPlugins`)
 *  - Stripping top-level 'use strict' for indirect eval global compatibility
 *  - Routing `111_InputForm.js` to Switch 2's native Software Keyboard (`prompt()`)
 *  - Fixing PIXI.js v4 Canvas2D `SATURATION` blend mode string
 *  - Dynamic resolution support (816x624, 1280x720, 1920x1080, etc.)
 *  - Direct GPU screen rendering & MV performance fast-paths (`WindowLayer`, `ScreenSprite`,
 *    `Tilemap` toroidal cache, fast zero-alloc `rotateHue`, `Sprite_Character` revision caching)
 */
import type { AssetReader } from './assets';
import { syncCanvas2DPluginPrototypes, type BrowserHost, type ScriptFilter } from './browser-host';
import { log } from './log';

/** Default plugins that are PC/editor-only or replaced by native Switch 2 C++ subsystems. */
export const DEFAULT_SKIPPED_PLUGINS = new Set([
  'AudioStreaming.js',      // Replaced by native C++ FFmpeg WebAudio decode in nx.js
  'OggOnly.js',             // Replaced by native C++ FFmpeg WebAudio decode in nx.js (skips slow JS stbvorbis)
  'DevToolsManage.js',      // PC NW.js DevTools / F12 menu bar
  'TRP_ParticleEditor.js',  // Editor-only particle disk writer (TRP_Particle stays enabled!)
  '111_InputForm.js',       // Replaced by Switch 2 native swkbd (prompt()) hook below
  'MakeScreenMovie.js',     // PC Chrome/NW.js MediaRecorder screen video recorder
  'RecScene.js',            // PC Chrome/NW.js MediaRecorder screen video recorder
]);

export interface AudioSupport {
  canOgg: boolean;
  canM4a: boolean;
}

export interface MvCompatOptions {
  audioSupport?: AudioSupport;
  /** Reuse $dataMap + Spriteset_Map when returning from pause-menu scenes (default true). */
  fastMenu?: boolean;
  /** Live2D Cubism Core mesh update rate: 'auto' (halve only when measured slow), 'half', 'full'. */
  live2dUpdateRate?: 'auto' | 'half' | 'full';
  onFatalError?: (title: string, detail: string) => void;
}

/** Remove only a top-level 'use strict' directive (preserving function-body directives). */
export function stripTopLevelUseStrict(source: string): string {
  const lines = source.split('\n');
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end >= 0) { inBlock = false; line = line.slice(end + 2); }
      else continue;
    }
    let rest = line;
    for (;;) {
      const s = rest.indexOf('/*');
      if (s < 0) break;
      const e = rest.indexOf('*/', s + 2);
      if (e < 0) { inBlock = true; rest = rest.slice(0, s); break; }
      rest = rest.slice(0, s) + rest.slice(e + 2);
    }
    const c = rest.indexOf('//');
    if (c >= 0) rest = rest.slice(0, c);
    const trimmed = rest.trim();
    if (!trimmed) continue;
    if (/^(['"])use strict\1;?$/.test(trimmed)) {
      lines.splice(i, 1);
      return lines.join('\n');
    }
    return source;
  }
  return source;
}

/**
 * Rewrite top-level (depth 0) `const` / `let` / `class` declarations to `var` so
 * indirect `(0, eval)` places them on `globalThis` (matching browser `<script>` tag
 * shared Global Lexical Environment semantics across multiple plugin files).
 */
export function exposeTopLevelLexicals(source: string): string {
  if (!/(?:^|[;\r\n{}])\s*(?:const|let|class)\s+[A-Za-z_${[]/.test(source)) {
    return source;
  }
  const n = source.length;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  const templateBraceDepths: number[] = [];
  let canStartRegex = true;
  let canStartStmt = true;
  const edits: Array<{ start: number; end: number; replacement: string }> = [];

  const isIdentStart = (ch: number) =>
    (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 36 || ch >= 0x80;
  const isIdentPart = (ch: number) =>
    isIdentStart(ch) || (ch >= 48 && ch <= 57);

  function scanTemplateLiteral(startIdx: number): number {
    let j = startIdx;
    while (j < n) {
      const ch = source.charCodeAt(j);
      if (ch === 92 /* \\ */) {
        j += 2;
        continue;
      }
      if (ch === 96 /* ` */) {
        return j + 1;
      }
      if (ch === 36 /* $ */ && j + 1 < n && source.charCodeAt(j + 1) === 123 /* { */) {
        templateBraceDepths.push(braceDepth);
        braceDepth++;
        return j + 2;
      }
      j++;
    }
    return j;
  }

  let i = 0;
  while (i < n) {
    const c = source.charCodeAt(i);

    // Whitespace & newlines
    if (c === 32 || c === 9 || c === 13 || c === 10) {
      if (c === 10 && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        canStartStmt = true;
      }
      i++;
      continue;
    }

    // Line comment (SIMD indexOf jump)
    if (c === 47 /* / */ && i + 1 < n && source.charCodeAt(i + 1) === 47 /* / */) {
      const nl = source.indexOf('\n', i + 2);
      i = nl < 0 ? n : nl;
      continue;
    }

    // Block comment (SIMD indexOf jump — skips 480 KB JSDoc headers in <0.1ms)
    if (c === 47 /* / */ && i + 1 < n && source.charCodeAt(i + 1) === 42 /* * */) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }

    // String literals
    if (c === 39 /* ' */ || c === 34 /* " */) {
      const quote = c;
      i++;
      while (i < n) {
        const sc = source.charCodeAt(i);
        if (sc === 92 /* \\ */) {
          i += 2;
          continue;
        }
        i++;
        if (sc === quote || sc === 10) break;
      }
      canStartRegex = false;
      canStartStmt = false;
      continue;
    }

    // Template literal
    if (c === 96 /* ` */) {
      i = scanTemplateLiteral(i + 1);
      canStartRegex = false;
      canStartStmt = false;
      continue;
    }

    // Regex literal
    if (c === 47 /* / */ && canStartRegex) {
      i++;
      let inClass = false;
      while (i < n) {
        const rc = source.charCodeAt(i);
        if (rc === 92 /* \\ */) {
          i += 2;
          continue;
        }
        if (rc === 91 /* [ */) inClass = true;
        else if (rc === 93 /* ] */) inClass = false;
        else if (rc === 47 /* / */ && !inClass) {
          i++;
          while (i < n && isIdentPart(source.charCodeAt(i))) i++;
          break;
        } else if (rc === 10) {
          break;
        }
        i++;
      }
      canStartRegex = false;
      canStartStmt = false;
      continue;
    }

    // Braces / parens / brackets
    if (c === 123 /* { */) {
      braceDepth++;
      canStartRegex = true;
      canStartStmt = true;
      i++;
      continue;
    }
    if (c === 125 /* } */) {
      if (braceDepth > 0) braceDepth--;
      if (
        templateBraceDepths.length > 0 &&
        templateBraceDepths[templateBraceDepths.length - 1] === braceDepth
      ) {
        templateBraceDepths.pop();
        i = scanTemplateLiteral(i + 1);
        canStartRegex = false;
        canStartStmt = false;
        continue;
      }
      canStartRegex = false;
      canStartStmt = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;
      i++;
      continue;
    }
    if (c === 40 /* ( */) {
      parenDepth++;
      canStartRegex = true;
      canStartStmt = false;
      i++;
      continue;
    }
    if (c === 41 /* ) */) {
      if (parenDepth > 0) parenDepth--;
      canStartRegex = false;
      canStartStmt = false;
      i++;
      continue;
    }
    if (c === 91 /* [ */) {
      bracketDepth++;
      canStartRegex = true;
      canStartStmt = false;
      i++;
      continue;
    }
    if (c === 93 /* ] */) {
      if (bracketDepth > 0) bracketDepth--;
      canStartRegex = false;
      canStartStmt = false;
      i++;
      continue;
    }
    if (c === 59 /* ; */) {
      canStartRegex = true;
      canStartStmt = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;
      i++;
      continue;
    }

    // Identifiers & keywords
    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (i < n && isIdentPart(source.charCodeAt(i))) i++;
      const word = source.slice(start, i);

      if (canStartStmt && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        if (word === 'const' || word === 'let') {
          let k = i;
          while (k < n && (source.charCodeAt(k) === 32 || source.charCodeAt(k) === 9)) k++;
          if (k > i && k < n && (isIdentStart(source.charCodeAt(k)) || source.charCodeAt(k) === 123 || source.charCodeAt(k) === 91)) {
            edits.push({ start, end: i, replacement: 'var' });
          }
        } else if (word === 'class') {
          let k = i;
          while (k < n && (source.charCodeAt(k) === 32 || source.charCodeAt(k) === 9)) k++;
          if (k > i && k < n && isIdentStart(source.charCodeAt(k))) {
            const nameStart = k;
            k++;
            while (k < n && isIdentPart(source.charCodeAt(k))) k++;
            const className = source.slice(nameStart, k);
            edits.push({ start, end: k, replacement: `var ${className} = class ${className}` });
          }
        }
      }

      canStartRegex =
        word === 'return' ||
        word === 'case' ||
        word === 'throw' ||
        word === 'typeof' ||
        word === 'void' ||
        word === 'delete' ||
        word === 'in' ||
        word === 'of' ||
        word === 'instanceof' ||
        word === 'new' ||
        word === 'yield' ||
        word === 'await';
      canStartStmt = false;
      continue;
    }

    // Numbers
    if (c >= 48 && c <= 57) {
      i++;
      while (i < n && (isIdentPart(source.charCodeAt(i)) || source.charCodeAt(i) === 46)) i++;
      canStartRegex = false;
      canStartStmt = false;
      continue;
    }

    // Operators / punctuation
    canStartRegex = true;
    canStartStmt = false;
    i++;
  }

  if (edits.length === 0) return source;
  let out = '';
  let last = 0;
  for (const e of edits) {
    out += source.slice(last, e.start) + e.replacement;
    last = e.end;
  }
  out += source.slice(last);
  return out;
}

/**
 * Constant-fold `javascript-obfuscator` string-table indirections (`_0xabc(0x1f0)` -> `"apply"`,
 * `_0xabc('0x1f0')` -> `"apply"`, and `obj[_0xabc(0x1f0)]` -> `obj.apply`) in memory at script load time.
 *
 * Supports both top-of-file preludes (Live2D Cubism 4 `enc_lv2d.js`, older MV plugins) and hoisted
 * mid/end-of-file `function _0xTable()` + `function _0xDec()` layouts (VisuStella MZ & modern obfuscator).
 * Also flattens self-overwriting decoder wrappers (`return _0xDec = function...`) and pre-bakes rotated
 * string arrays so neither startup rotation IIFEs nor any dynamic fallback calls allocate closures on
 * `--jitless` V8!
 */
export function foldObfuscatedStringTable(code: string, pathLabel = ''): string {
  if (!code.includes('_0x')) return code;
  const t0 = performance.now();

  // 1. Locate string table anywhere in script:
  //    - Modern hoisted function table: `function _0xTable(){ const a = [...]; _0xTable = function(){ return a; }; return _0xTable(); }`
  //    - Array literal table: `var/const/let _0xTable = [...];`
  let tableName = '';
  let tableCode = '';
  let tableStart = -1;
  let tableEnd = -1;
  let isFnTable = false;

  const fnTableRe =
    /function (_0x[0-9a-f]+)\(\)\{(?:const|var|let) (_0x[0-9a-f]+)=\[[\s\S]*?\];\1=function\(\)\{return \2;\};return \1\(\);\}/;
  const fm = fnTableRe.exec(code);
  if (fm) {
    tableName = fm[1];
    tableCode = fm[0];
    tableStart = fm.index;
    tableEnd = fm.index + fm[0].length;
    isFnTable = true;
  } else {
    const arrTableRe =
      /(?:const|var|let) (_0x[0-9a-f]+)=\[(?:'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|\s|,){8,}\];/;
    const am = arrTableRe.exec(code);
    if (am) {
      tableName = am[1];
      tableCode = am[0];
      tableStart = am.index;
      tableEnd = am.index + am[0].length;
    }
  }
  if (!tableName) return code;

  // 2. Locate decoder function referencing `tableName`
  const escTable = tableName.replace(/\$/g, '\\$');
  const selfOverwriteRe = new RegExp(
    `function (_0x[0-9a-f]+)\\((_0x[0-9a-f]+),(_0x[0-9a-f]+)\\)\\{(?:const|var|let) (_0x[0-9a-f]+)=${escTable}\\(\\);return \\1=function\\((_0x[0-9a-f]+),(_0x[0-9a-f]+)\\)\\{([^}]{1,260})\\},\\1\\(\\2,\\3\\);\\}`,
  );
  const directFnRe = new RegExp(
    `function (_0x[0-9a-f]+)\\(_0x[0-9a-f]+,_0x[0-9a-f]+\\)\\{[^}]{1,260}\\b${escTable}\\(\\)[^}]{1,160}\\}`,
  );
  const varFnRe = new RegExp(
    `(?:const|var|let) (_0x[0-9a-f]+)=function\\(_0x[0-9a-f]+,_0x[0-9a-f]+\\)\\{[^}]{1,260}\\b${escTable}\\[[^}]{1,160}\\};`,
  );

  let decName = '';
  let decCode = '';
  let fastDecCode = '';
  let decStart = -1;
  let decEnd = -1;

  const sm = selfOverwriteRe.exec(code);
  if (sm) {
    decName = sm[1];
    decCode = sm[0];
    // Flatten self-overwriting wrapper so outer aliases (`const _0xAlias = _0xDec`) NEVER allocate closures!
    fastDecCode = `function ${sm[1]}(${sm[5]},${sm[6]}){var ${sm[4]}=${tableName}();${sm[7]}}`;
    decStart = sm.index;
    decEnd = sm.index + sm[0].length;
  } else {
    const dm = directFnRe.exec(code) || varFnRe.exec(code);
    if (dm) {
      decName = dm[1];
      decCode = dm[0];
      fastDecCode = decCode;
      decStart = dm.index;
      decEnd = dm.index + dm[0].length;
    }
  }
  if (!decName) return code;

  // 3. Locate optional rotation IIFE:
  //    - Standalone: `(function(a,b){...}(tableName, expr))` or `(function(a,b){...})(tableName, expr)`
  //    - Comma-grouped (`(function(a,b){...}(tableName, expr), mainIife())`): match without outer `(` so `(void 0, mainIife())` stays balanced!
  const standaloneIifeRe = new RegExp(
    `\\(function\\(_0x[0-9a-f]+,_0x[0-9a-f]+\\)\\{[\\s\\S]{40,4000}?\\}\\s*(?:\\(\\s*${escTable}\\s*,[0-9a-fx+\\-*()\\s]{1,160}\\)\\)|\\)\\s*\\(\\s*${escTable}\\s*,[0-9a-fx+\\-*()\\s]{1,160}\\))`,
  );
  const commaIifeRe = new RegExp(
    `function\\(_0x[0-9a-f]+,_0x[0-9a-f]+\\)\\{[\\s\\S]{40,4000}?\\}\\s*\\(\\s*${escTable}\\s*,[0-9a-fx+\\-*()\\s]{1,160}\\)(?=\\s*,)`,
  );
  let iifeCode = '';
  let iifeEvalCode = '';
  let iifeStart = -1;
  let iifeEnd = -1;
  const sim = standaloneIifeRe.exec(code);
  if (sim) {
    iifeCode = sim[0];
    iifeEvalCode = sim[0];
    iifeStart = sim.index;
    iifeEnd = sim.index + sim[0].length;
  } else {
    const cim = commaIifeRe.exec(code);
    if (cim) {
      iifeCode = cim[0];
      iifeEvalCode = `(${cim[0]})`;
      iifeStart = cim.index;
      iifeEnd = cim.index + cim[0].length;
    }
  }
  // Safety invariant: if `tableName` is passed as first argument to an unrecognized rotation call, never fold unrotated!
  if (!iifeCode && new RegExp(`\\(\\s*${escTable}\\s*,`).test(code)) {
    return code;
  }

  const evalBundle = `${tableCode}\n${fastDecCode}\n${iifeEvalCode ? iifeEvalCode + ';' : ''}`;
  if (/\b(?:eval|Function|require|fetch|XMLHttpRequest|document|window|process)\b/.test(evalBundle)) {
    return code;
  }

  let decFn: ((idx: number) => any) | null = null;
  let rotatedArr: string[] | null = null;
  try {
    const res = new Function(
      `${evalBundle}\nreturn { dec: ${decName}, tbl: ${isFnTable ? tableName + '()' : tableName} };`,
    )() as { dec: (idx: number) => any; tbl: unknown };
    decFn = res?.dec ?? null;
    if (Array.isArray(res?.tbl) && res.tbl.every((x) => typeof x === 'string')) {
      rotatedArr = res.tbl as string[];
    }
  } catch {
    return code;
  }
  if (typeof decFn !== 'function') return code;

  // 4. Propagate direct decoder aliases (`_0xAlias = _0xDec`) across all scopes
  const aliases = new Set<string>([decName]);
  const pairs: Array<[string, string]> = [];
  const aliasRe = /\b(_0x[0-9a-f]+)\s*=\s*(_0x[0-9a-f]+)\b/g;
  let am: RegExpExecArray | null;
  while ((am = aliasRe.exec(code)) !== null) {
    pairs.push([am[1], am[2]]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < pairs.length; i++) {
      const [lhs, rhs] = pairs[i];
      if (aliases.has(rhs) && !aliases.has(lhs)) {
        aliases.add(lhs);
        changed = true;
      }
    }
  }

  // Pre-bake rotated array + flattened decoder + elide rotation IIFE so script eval skips O(N) rotation
  let working = code;
  const protectedSpans: Array<{ start: number; end: number }> = [];
  if (rotatedArr) {
    const edits: Array<{ start: number; end: number; rep: string }> = [
      {
        start: tableStart,
        end: tableEnd,
        rep: isFnTable
          ? `function ${tableName}(){var a=${JSON.stringify(rotatedArr)};${tableName}=function(){return a;};return a;}`
          : `var ${tableName}=${JSON.stringify(rotatedArr)};`,
      },
    ];
    if (fastDecCode !== decCode) {
      edits.push({ start: decStart, end: decEnd, rep: fastDecCode });
    } else {
      edits.push({ start: decStart, end: decEnd, rep: decCode });
    }
    if (iifeStart >= 0) {
      edits.push({ start: iifeStart, end: iifeEnd, rep: 'void 0' });
    }
    edits.sort((a, b) => a.start - b.start);
    let overlapping = false;
    for (let i = 1; i < edits.length; i++) {
      if (edits[i].start < edits[i - 1].end) {
        overlapping = true;
        break;
      }
    }
    if (!overlapping) {
      let built = '';
      let cur = 0;
      for (const ed of edits) {
        built += working.slice(cur, ed.start);
        const ns = built.length;
        built += ed.rep;
        protectedSpans.push({ start: ns, end: built.length });
        cur = ed.end;
      }
      built += working.slice(cur);
      working = built;
    }
  }
  if (protectedSpans.length === 0) {
    protectedSpans.push({ start: tableStart, end: tableEnd });
    protectedSpans.push({ start: decStart, end: decEnd });
    if (iifeStart >= 0) protectedSpans.push({ start: iifeStart, end: iifeEnd });
  }

  const inProtectedSpan = (off: number): boolean => {
    for (let i = 0; i < protectedSpans.length; i++) {
      const sp = protectedSpans[i];
      if (off >= sp.start && off < sp.end) return true;
    }
    return false;
  };

  const NON_OBJ_KW = new Set([
    'return', 'case', 'throw', 'typeof', 'void', 'delete',
    'in', 'of', 'instanceof', 'new', 'yield', 'await', 'else', 'do',
  ]);
  const STMT_PAREN_KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
  const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const isIdentChar = (c: number) =>
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

  const canEmitDotAt = (str: string, offset: number): boolean => {
    if (offset <= 0) return false;
    const pc = str.charCodeAt(offset - 1);
    if (pc === 93 /* ] */) return true;
    if (pc === 41 /* ) */) {
      let depth = 1;
      let k = offset - 2;
      while (k >= 0 && depth > 0) {
        const kc = str.charCodeAt(k);
        if (kc === 41) depth++;
        else if (kc === 40) depth--;
        k--;
      }
      if (depth === 0) {
        while (k >= 0 && (str.charCodeAt(k) === 32 || str.charCodeAt(k) === 9)) k--;
        const we = k + 1;
        while (k >= 0 && isIdentChar(str.charCodeAt(k))) k--;
        const kw = str.slice(k + 1, we);
        if (kw.length > 0 && !STMT_PAREN_KW.has(kw)) return true;
      }
    } else if (isIdentChar(pc)) {
      let ws = offset - 1;
      while (ws > 0 && isIdentChar(str.charCodeAt(ws - 1))) ws--;
      const prevWord = str.slice(ws, offset);
      const fc = prevWord.charCodeAt(0);
      if (!(fc >= 48 && fc <= 57) && !NON_OBJ_KW.has(prevWord)) return true;
    }
    return false;
  };

  const callRe =
    /(['"`])(?:\\[\s\S]|(?!\1)[\s\S])*?\1|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(\[\s*)?(\b_0x[0-9a-f]+)\((0x[0-9a-f]+|\d+|'(?:0x[0-9a-f]+|\d+)'|"(?:0x[0-9a-f]+|\d+)")\)(\s*\])?/g;
  let replaced = 0;
  let dotProps = 0;
  let rewritten = working.replace(
    callRe,
    (full, quote, openBr, fnId, argStr, closeBr, offset, str) => {
      if (quote || !fnId || !aliases.has(fnId) || inProtectedSpan(offset)) return full;
      const rawArg =
        argStr.charCodeAt(0) === 39 || argStr.charCodeAt(0) === 34
          ? argStr.slice(1, -1)
          : argStr;
      let val: any;
      try {
        val = decFn!(Number(rawArg));
      } catch {
        return full;
      }
      if (typeof val !== 'string') return full;
      replaced++;
      const jsonLit = JSON.stringify(val);
      if (openBr && closeBr && val !== '__proto__' && IDENT_RE.test(val) && canEmitDotAt(str, offset)) {
        const afterIdx = offset + full.length;
        const trail = afterIdx < str.length && isIdentChar(str.charCodeAt(afterIdx)) ? ' ' : '';
        dotProps++;
        return '.' + val + trail;
      }
      return (openBr || '') + jsonLit + (closeBr || '');
    },
  );
  if (replaced === 0) return code;

  // Fold split-string bracket accesses `obj["foo" + "bar"]` -> `obj.foobar` (from `splitStrings: true`)
  if (rewritten.includes('"+') || rewritten.includes('" +')) {
    const concatBracketRe =
      /(`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/)|\[\s*("(?:\\[\s\S]|[^"\\])*"(?:\s*\+\s*"(?:\\[\s\S]|[^"\\])*")+)\s*\]/g;
    rewritten = rewritten.replace(concatBracketRe, (full, skip, chain, offset, str) => {
      if (skip || !chain) return full;
      let joined = '';
      const partRe = /"(?:\\[\s\S]|[^"\\])*"/g;
      let pm: RegExpExecArray | null;
      while ((pm = partRe.exec(chain)) !== null) {
        try {
          joined += JSON.parse(pm[0]);
        } catch {
          return full;
        }
      }
      if (joined !== '__proto__' && IDENT_RE.test(joined) && canEmitDotAt(str, offset)) {
        const afterIdx = offset + full.length;
        const trail = afterIdx < str.length && isIdentChar(str.charCodeAt(afterIdx)) ? ' ' : '';
        dotProps++;
        return '.' + joined + trail;
      }
      return '[' + JSON.stringify(joined) + ']';
    });
  }

  // Strip per-frame leaked `this.gl.createTexture(), this.gl.createFramebuffer(),` in Cubism4 setupClippingContext
  rewritten = rewritten.replace(
    /this(?:\.gl|\['gl'\]|\["gl"\])(?:\.createTexture|\["createTexture"\])\(\)\s*,\s*this(?:\.gl|\['gl'\]|\["gl"\])(?:\.createFramebuffer|\["createFramebuffer"\])\(\)\s*,/g,
    '',
  );
  try {
    // Verify syntax safety before committing the folded script
    new Function(rewritten);
  } catch {
    return code;
  }
  if (pathLabel) {
    const dt = performance.now() - t0;
    if (replaced >= 2000 || dt >= 25) {
      log(
        `[script] folded ${replaced} string-table calls (${dotProps} dot-props) in ${pathLabel} ` +
        `(${dt.toFixed(0)}ms)`,
      );
    }
  }
  return rewritten;
}

/** Create a script filter combining default skipped plugins with optional per-game overrides. */
export function createScriptPreparer(extraSkipPlugins?: string[]): ScriptFilter {
  const skipped = new Set<string>();
  for (const name of DEFAULT_SKIPPED_PLUGINS) {
    skipped.add(name.toLowerCase());
  }
  if (Array.isArray(extraSkipPlugins)) {
    for (const raw of extraSkipPlugins) {
      const clean = String(raw ?? '').trim();
      if (!clean) continue;
      const withExt = clean.toLowerCase().endsWith('.js') ? clean : `${clean}.js`;
      skipped.add(withExt.toLowerCase());
    }
  }
  return (path: string, source: string): string | null => {
    const rawBase = (path.split('/').pop() || path).toLowerCase();
    const base = rawBase.replace(/\.omori$/i, '.js');
    if (skipped.has(base)) {
      // The Coffin of Andy and Leyley appends its `_();` runtime decrypter bootstrap to the end
      // of `AudioStreaming.js`. Keep `stbvorbis` AudioStreaming skipped while still invoking `_()`!
      if (base === 'audiostreaming.js' && /\b_\(\)\s*;?\s*$/.test(source)) {
        log(`[script] skipped PC-only AudioStreaming body while preserving trailing _() bootstrap: ${path}`);
        return 'if (typeof _ === "function") _();';
      }
      return null;
    }
    let stripped = stripTopLevelUseStrict(source);
    if (path.toLowerCase().includes('js/libs/')) return stripped;
    // Constant-fold javascript-obfuscator string tables (e.g. enc_lv2d.js Live2D Cubism 4 -> >10x faster in jitless V8)
    stripped = foldObfuscatedStringTable(stripped, path);
    // Deduplicate & lazily load Yanfly.PreloadedMaps[mapId] in YEP_EventCopier / Morpher / Spawner
    // (stock Yanfly sets `Yanfly.PreloadedMaps[mapId] = null` before async XHR/fs.readFile, queuing
    // 250+ duplicate multi-MB map reads, and in OMORI eagerly decrypting 18 Map*.KEL files on boot).
    if (stripped.includes('Yanfly.PreloadedMaps[mapId]')) {
      stripped = stripped.replace(
        /if\s*\(\s*Yanfly\.PreloadedMaps\[mapId\]\s*\)\s*return\s*;/g,
        'if (Object.prototype.hasOwnProperty.call(Yanfly.PreloadedMaps, mapId) || Yanfly.PreloadedMaps[mapId] !== undefined) return;',
      );
      if (stripped.includes('.KEL') && stripped.includes('Encryption.decrypt')) {
        stripped = stripped.replace(
          /Yanfly\.PreloadedMaps\[mapId\]\s*=\s*null\s*;\s*fs\.readFile\(\s*base\s*\+\s*"\/data\/"\s*\+\s*filename\s*,\s*\(err,\s*data\)\s*=>\s*\{\s*data\s*=\s*Encryption\.decrypt\(data\)\s*;\s*Yanfly\.PreloadedMaps\[mapId\]\s*=\s*JSON\.parse\(data\.toString\(\)\)\s*;?\s*\}\s*\)\s*;?/g,
          'Object.defineProperty(Yanfly.PreloadedMaps, mapId, { configurable: true, enumerable: true, get: function() { var p = null; try { var raw = fs.readFileSync(base + "/data/" + filename); p = JSON.parse(Encryption.decrypt(raw).toString()); } catch (_) {} Object.defineProperty(Yanfly.PreloadedMaps, mapId, { value: p, writable: true, configurable: true, enumerable: true }); return p; } });',
        );
      }
    }
    // Guard YEP_X_MoreQuests against non-JSON separator strings in `Quest N` plugin parameters (e.g. Nightmare Knight)
    if (stripped.includes('DataManager.questDatabaseCreate') && stripped.includes("JSON.parse(Yanfly.Parameters['Quest ' + i]")) {
      stripped = stripped.replace(
        /JSON\.parse\(\s*Yanfly\.Parameters\['Quest '\s*\+\s*i\]\s*\|\|\s*'null'\s*\)/g,
        "(function(s){try{return JSON.parse(s||'null');}catch(_){return null;}})(Yanfly.Parameters['Quest ' + i])",
      );
    }
    return exposeTopLevelLexicals(stripped);
  };
}

/** Extract <script src="..."> list in exact DOM order from www/index.html. */
export function extractIndexScripts(indexHtml: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexHtml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Extract custom `<canvas id="...">` elements declared in `index.html` (e.g. Look Outside's
 * `<canvas id="refresher">`) so plugins calling `document.getElementById(id).getContext('2d')`
 * never receive `null`.
 */
export function extractIndexCanvases(indexHtml: string): Array<{ id: string; width: number; height: number }> {
  const out: Array<{ id: string; width: number; height: number }> = [];
  const seen = new Set<string>();
  const tagRe = /<canvas\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(indexHtml)) !== null) {
    const attrs = m[1] || '';
    const idMatch = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i.exec(attrs);
    const id = (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3] ?? '').trim();
    if (!id || seen.has(id) || id.toLowerCase() === 'gamecanvas') continue;
    seen.add(id);
    const wMatch = /\bwidth\s*=\s*["']?(\d+)/i.exec(attrs);
    const hMatch = /\bheight\s*=\s*["']?(\d+)/i.exec(attrs);
    out.push({
      id,
      width: wMatch ? Math.max(1, parseInt(wMatch[1], 10) || 1) : 1,
      height: hMatch ? Math.max(1, parseInt(hMatch[1], 10) || 1) : 1,
    });
  }
  return out;
}

/** Pre-mount custom `<canvas id="...">` elements from `index.html` into `document.body`. */
export function mountIndexHtmlCanvases(doc: any, indexHtml: string): string[] {
  if (!doc || !doc.body || typeof doc.createElement !== 'function') return [];
  const mounted: string[] = [];
  for (const spec of extractIndexCanvases(indexHtml)) {
    if (typeof doc.getElementById === 'function' && doc.getElementById(spec.id)) continue;
    const el = doc.createElement('canvas');
    el.id = spec.id;
    el.width = spec.width;
    el.height = spec.height;
    doc.body.appendChild(el);
    mounted.push(spec.id);
  }
  return mounted;
}

/**
 * Parse `@font-face` declarations from a CSS file (e.g. `www/fonts/gamefont.css`).
 */
export function parseGameFontCss(css: string): Array<{ family: string; file: string }> {
  const out: Array<{ family: string; file: string }> = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blockRe = /@font-face\s*\{([^}]*)\}/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(stripped)) !== null) {
    const body = block[1];
    const famMatch = /font-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;,\n]+))/i.exec(body);
    const urlMatch = /url\s*\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+))\s*\)/i.exec(body);
    const family = (famMatch?.[1] ?? famMatch?.[2] ?? famMatch?.[3] ?? '').trim();
    let url = (urlMatch?.[1] ?? urlMatch?.[2] ?? urlMatch?.[3] ?? '').trim();
    if (!family || !url) continue;
    url = url.replace(/^\.\//, '').replace(/^\/+/, '');
    const file = url.startsWith('fonts/') ? url : `fonts/${url}`;
    out.push({ family, file });
  }
  return out;
}

export interface FontLoadEntry {
  family: string;
  file?: string;
}

/**
 * Detect whether an RPG Maker MV game requires Hardware WebGL2 mode
 * (Live2D Cubism plugins, Spine 2D skeletal mesh plugins, or PixiJS v5+ MV core upgrades).
 */
export function detectMvWebGLReason(
  pluginsJsText: string | null,
  rpgCoreJsText: string | null,
  pixiJsHeadText: string | null,
  rpgManagersJsText: string | null = null,
): string | null {
  if (pluginsJsText && /"name"\s*:\s*"[^"]*(?:live2d|lv2d|cubism)[^"]*"[^}]*"status"\s*:\s*true/i.test(pluginsJsText)) {
    return 'Live2D';
  }
  if (pluginsJsText && /"name"\s*:\s*"[^"]*(?:pixi-spine|PictureSpine|Spine)[^"]*"[^}]*"status"\s*:\s*true/i.test(pluginsJsText)) {
    return 'Spine';
  }
  if (rpgCoreJsText && /\bnew\s+PIXI\.Renderer\s*\(/.test(rpgCoreJsText)) {
    return 'PixiJS v5';
  }
  if (pixiJsHeadText && /pixi\.js\s*-\s*v(?:[5-9]|\d{2,})\./i.test(pixiJsHeadText)) {
    return 'PixiJS v5';
  }
  // Games that hard-wire SceneManager.preferableRendererType to 'webgl' (e.g. In Stars And Time) call
  // checkWebGL() and need real WebGL; the canvas renderer would throw "Your browser does not support WebGL".
  const forcedWebGL = /preferableRendererType\s*=\s*function\s*\(\s*\)\s*\{\s*return\s*['"]webgl['"]/;
  if ((rpgManagersJsText && forcedWebGL.test(rpgManagersJsText)) || (pluginsJsText && forcedWebGL.test(pluginsJsText))) {
    return 'forced WebGL';
  }
  return null;
}

/**
 * Extract extra font family entries (with optional explicit file URLs) requested by
 * `FontLoad.js` in `www/js/plugins.js`, so shipped fonts bind to their exact file and
 * missing commercial/system fonts can be cleanly aliased.
 */
export function extractFontLoadEntries(pluginsSrc: string): FontLoadEntry[] {
  const entries: FontLoadEntry[] = [];
  const seen = new Set<string>();
  const addEntry = (family: string, file?: string) => {
    const cleanFam = family.trim();
    if (!cleanFam || seen.has(cleanFam)) return;
    seen.add(cleanFam);
    let cleanFile: string | undefined;
    if (file) {
      let u = file.trim().replace(/^\.\//, '').replace(/^\/+/, '');
      if (u) cleanFile = u.startsWith('fonts/') ? u : `fonts/${u}`;
    }
    entries.push({ family: cleanFam, file: cleanFile });
  };

  const entryRe = /"name"\s*:\s*"FontLoad"[^}]*"status"\s*:\s*true[^}]*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/;
  const match = entryRe.exec(pluginsSrc);
  if (!match) return entries;
  try {
    const params = JSON.parse(match[1]) as Record<string, any>;
    // Pair numbered FontLoad params first: e.g. フォント名1 + フォントURL1, fontName1 + fontUrl1
    const urlBySuffix = new Map<string, string>();
    for (const [k, val] of Object.entries(params)) {
      if (typeof val !== 'string' || !val.trim()) continue;
      const mUrl = /(?:URL|Url|url|File|file|パス)(\d*)$/.exec(k);
      if (mUrl) urlBySuffix.set(mUrl[1] || '', val.trim());
    }
    for (const [k, val] of Object.entries(params)) {
      if (typeof val !== 'string') continue;
      const trimmed = val.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('[')) {
        try {
          const arr = JSON.parse(trimmed);
          for (const item of arr) {
            if (typeof item === 'string' && item.trim()) {
              if (item.trim().startsWith('{')) {
                const obj = JSON.parse(item);
                const name = obj.name || obj.family || obj.fontName;
                const url = obj.url || obj.file || obj.fontUrl || obj.src;
                if (typeof name === 'string' && name.trim()) {
                  addEntry(name, typeof url === 'string' ? url : undefined);
                }
              } else {
                addEntry(item);
              }
            }
          }
        } catch { /* ignore malformed JSON param */ }
      } else if (
        !trimmed.includes('/') &&
        !trimmed.includes('.') &&
        !/^(?:true|false|\d+)$/i.test(trimmed) &&
        trimmed.length <= 64
      ) {
        const mName = /(\d+)$/.exec(k);
        const pairedUrl = mName ? urlBySuffix.get(mName[1]) : urlBySuffix.get('');
        addEntry(trimmed, pairedUrl);
      }
    }
  } catch { /* ignore */ }
  return entries;
}

/**
 * Extract extra font family names requested by `FontLoad.js` in `www/js/plugins.js`
 * (if present), so missing system/commercial fonts can be cleanly aliased.
 */
export function extractFontLoadFamilies(pluginsSrc: string): string[] {
  return extractFontLoadEntries(pluginsSrc).map((e) => e.family);
}

const FONT_FILE_RE = /\.(?:ttf|otf|woff2?|ttc)$/i;

// Track Latin-only (<250 KB) registered font families and the game's best full Unicode/CJK fallback
// family so Bitmap.drawText can avoid tofu boxes on nx.js (which has no CSS per-glyph fallback chain).
const smallLatinFontFamilies = new Set<string>();
let fullUnicodeFallbackFamily: string | null = null;
// Kept from registerGameFonts so Graphics.loadFont(name, url) can register extra family names at runtime
let fontAssetReader: AssetReader | null = null;
const registeredFontFamilies = new Set<string>();

/**
 * Runtime `Graphics.loadFont(name, url)`: register the game's font file under the family name the game
 * asks for (e.g. In Stars And Time loads 'default1' <- fonts/VCR_OSD_MONO_1.001.ttf and draws all text
 * with fontFace 'default1'). Without it the family is unknown and text falls back to a system font.
 */
export function registerFontFamilySync(family: string, url: string): boolean {
  const fam = String(family || '').trim();
  if (!fam || registeredFontFamilies.has(fam) || !fontAssetReader) return false;
  const FontFaceCtor = (globalThis as any).FontFace;
  const fontSet = (globalThis as any).fonts;
  if (!FontFaceCtor || !fontSet?.add) return false;
  let rel = String(url || '').trim();
  try { rel = decodeURIComponent(rel); } catch { /* keep as is */ }
  rel = rel.replace(/^\.\//, '').replace(/^\/+/, '');
  try {
    const bytes = fontAssetReader.readSync(rel);
    if (!bytes) {
      log(`[fonts] loadFont '${fam}': file not found (${rel})`);
      return false;
    }
    fontSet.add(new FontFaceCtor(fam, bytes));
    registeredFontFamilies.add(fam);
    if (bytes.byteLength < 250_000) smallLatinFontFamilies.add(fam.toLowerCase());
    log(`[fonts] loadFont registered '${fam}' <- ${rel}`);
    return true;
  } catch (err) {
    log(`[fonts] loadFont '${fam}' (${rel}) failed: ${String(err)}`);
    return false;
  }
}

/**
 * Automatically discover and register all fonts shipped in the game's `www/fonts/`
 * directory + `www/fonts/gamefont.css` via nx.js's FontFace API.
 */
export async function registerGameFonts(assets: AssetReader): Promise<void> {
  smallLatinFontFamilies.clear();
  fullUnicodeFallbackFamily = null;
  fontAssetReader = assets;
  registeredFontFamilies.clear();

  const FontFaceCtor = (globalThis as any).FontFace;
  const fontSet = (globalThis as any).fonts;
  if (!FontFaceCtor || !fontSet?.add) {
    log('[fonts] FontFace API unavailable; using default font');
    return;
  }

  const entries: Array<{ family: string; file: string }> = [];
  const registeredFamilies = new Set<string>();
  const byteCache = new Map<string, ArrayBuffer>();

  // 1. Parse www/fonts/gamefont.css
  const cssBytes = await assets.read('fonts/gamefont.css');
  if (cssBytes) {
    const cssText = new TextDecoder().decode(cssBytes);
    for (const parsed of parseGameFontCss(cssText)) {
      entries.push(parsed);
    }
  }

  // 2. Scan every font file in www/fonts/
  const fontFiles = assets.readDirSync('fonts').filter((f) => FONT_FILE_RE.test(f));
  for (const filename of fontFiles) {
    const stem = filename.replace(FONT_FILE_RE, '');
    if (stem) {
      entries.push({ family: stem, file: `fonts/${filename}` });
    }
  }

  async function registerOne(family: string, file: string): Promise<boolean> {
    if (!family || registeredFamilies.has(family)) return false;
    try {
      let bytes = byteCache.get(file);
      if (!bytes) {
        const read = await assets.read(file);
        if (!read) return false;
        bytes = read;
        byteCache.set(file, bytes);
      }
      const face = new FontFaceCtor(family, bytes);
      // In nx.js, FontFace loads synchronously in the constructor (face.load() is unimplemented).
      fontSet.add(face);
      registeredFamilies.add(family);
      registeredFontFamilies.add(family);
      if (bytes.byteLength < 250_000) {
        smallLatinFontFamilies.add(family.toLowerCase());
      } else if (!fullUnicodeFallbackFamily && family !== 'GameFont') {
        fullUnicodeFallbackFamily = family;
      }
      if (family === 'GameFont') gameFontSource = file;
      return true;
    } catch (err) {
      log(`[fonts] failed '${family}' (${file}): ${String(err)}`);
      return false;
    }
  }

  let gameFontSource: string | null = null;
  let firstLoadedFile: string | null = null;
  let preferredCjkFile: string | null = null;
  let preferredCjkFamily: string | null = null;

  for (const entry of entries) {
    const ok = await registerOne(entry.family, entry.file);
    if (ok) {
      if (!firstLoadedFile) firstLoadedFile = entry.file;
      if (
        !preferredCjkFile &&
        /(?:ship|mplus|noto|jp|cjk|gothic|mincho|meiryo|yu|hiragino|vl-)/i.test(entry.file)
      ) {
        preferredCjkFile = entry.file;
        preferredCjkFamily = entry.family;
      }
    }
  }
  if (preferredCjkFamily) {
    fullUnicodeFallbackFamily = preferredCjkFamily;
  }

  // 3. Ensure GameFont is always registered if any font file exists
  if (!registeredFamilies.has('GameFont') && firstLoadedFile) {
    await registerOne('GameFont', firstLoadedFile);
  }

  // 4. Register FontLoad.js families: use paired URL / matching shipped file first,
  //    falling back to CJK/default font only for unshipped commercial fonts (e.g. FOT-SkipStd-D).
  const fallbackFile = preferredCjkFile || firstLoadedFile;
  if (fallbackFile) {
    const pluginsBytes = await assets.read('js/plugins.js');
    if (pluginsBytes) {
      const pluginsText = new TextDecoder().decode(pluginsBytes);
      for (const fl of extractFontLoadEntries(pluginsText)) {
        if (registeredFamilies.has(fl.family)) continue;
        let bound = false;
        if (fl.file) {
          bound = await registerOne(fl.family, fl.file);
        }
        if (!bound) {
          const lowFam = fl.family.toLowerCase();
          const stemMatch = fontFiles.find((f) => {
            const stem = f.replace(FONT_FILE_RE, '').toLowerCase();
            return stem === lowFam || stem.startsWith(lowFam + '-') || stem.startsWith(lowFam + '_');
          });
          if (stemMatch) {
            bound = await registerOne(fl.family, `fonts/${stemMatch}`);
          }
        }
        if (!bound) {
          await registerOne(fl.family, fallbackFile);
        }
      }
    }
  }
  if (registeredFamilies.size > 0) {
    log(
      `[fonts] registered ${registeredFamilies.size} family(s)` +
      `${gameFontSource ? ` (GameFont <- ${gameFontSource})` : ''}`,
    );
  }
}

/**
 * Inspect `www/audio/` to determine whether the game ships `.ogg`/`.rpgmvo` and/or `.m4a`/`.rpgmvm`.
 */
export function detectAudioSupport(
  assets: AssetReader,
  preferred: 'auto' | 'ogg' | 'm4a' = 'auto',
): AudioSupport {
  if (preferred === 'ogg') return { canOgg: true, canM4a: false };
  if (preferred === 'm4a') return { canOgg: false, canM4a: true };

  let hasOgg = false;
  let hasM4a = false;
  for (const sub of ['audio/bgm', 'audio/se', 'audio/me', 'audio/bgs']) {
    const files = assets.readDirSync(sub);
    for (const f of files) {
      const low = f.toLowerCase();
      if (low.endsWith('.ogg') || low.endsWith('.rpgmvo')) hasOgg = true;
      else if (low.endsWith('.m4a') || low.endsWith('.rpgmvm')) hasM4a = true;
      if (hasOgg && hasM4a) break;
    }
    if (hasOgg && hasM4a) break;
  }

  // If only m4a exists, report canPlayOgg=false so RPG Maker MV picks .m4a/.rpgmvm automatically.
  if (!hasOgg && hasM4a) {
    log('[audio] detected M4A-only audio assets -> selecting .m4a/.rpgmvm');
    return { canOgg: false, canM4a: true };
  }
  log(`[audio] detected audio assets (ogg=${hasOgg}, m4a=${hasM4a}) -> preferring .ogg/.rpgmvo`);
  return { canOgg: true, canM4a: hasM4a };
}

/**
 * Apply post-script runtime patches once RPG Maker MV core + plugins are evaluated
 * (before `SceneManager.run(Scene_Boot)`).
 */
export function installMvCompat(
  runtime: Record<string, any>,
  host: BrowserHost,
  options?: MvCompatOptions,
): void {
  const { Graphics, WebAudio, Utils, SceneManager, Game_Interpreter, PIXI } = runtime;
  const isWebGLMode = Boolean(host?.getWebGLContext?.());
  syncCanvas2DPluginPrototypes(runtime);

  // 0. Forward console.error / console.warn (up to 40 distinct messages) to mv.log
  //    so plugin & PIXI/Live2D diagnostics are captured without per-frame duplicate spam.
  if (runtime.console && !runtime.console.__drMvLogHooked) {
    runtime.console.__drMvLogHooked = true;
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

  // 1. Report NW.js mode cleanly so plugins expecting local mode work through node-compat
  if (Utils) {
    Utils.isNwjs = () => true;
    Utils.isMobileDevice = () => false;
    Utils.isOptionValid = (name: string) => (isWebGLMode ? name === 'webgl' : name === 'canvas');
  }

  // 1b. In WebGL2 mode (Live2D or PixiJS v5+ MV upgrades like Ambrosia), configure PIXI v5
  //     flags so `new PIXI.Renderer(options)` succeeds cleanly on OunceVK WebGL2.
  if (isWebGLMode && PIXI?.settings) {
    PIXI.settings.CREATE_IMAGE_BITMAP = false;
    PIXI.settings.FAIL_IF_MAJOR_PERFORMANCE_CAVEAT = false;
    if (PIXI.utils && typeof PIXI.utils.isWebGLSupported === 'function') {
      PIXI.utils.isWebGLSupported = () => true;
    }
  }

  // 2. FontLoad.js & Graphics.isFontLoaded: immediately mark registered fonts loaded
  //    Also keep GraphicalDesignMode.js strictly in read-only runtime layout mode (never editor/write mode).
  if (runtime.Utils && typeof runtime.Utils.isDesignMode === 'function') {
    runtime.Utils.isDesignMode = () => false;
  }
  if (Graphics) {
    Graphics.isFontLoaded = () => true;
    Graphics.loadFont = (name: string, url: string) => {
      registerFontFamilySync(name, url);
    };
    Graphics._createErrorPrinter = () => {};
    Graphics._updateErrorPrinter = () => {};
    Graphics.printError = (name: string, message: string) => {
      const title = String(name || 'RPG Maker MV Error');
      const detail = String(message || 'Unknown error');
      log(`[Graphics.printError] ${title}: ${detail}`);
      options?.onFatalError?.(title, detail);
    };

    // WebGL-state compatibility shim on PIXI.CanvasRenderer for plugins (e.g. Khas Ultra/Advanced Lighting,
    // SubtractiveBlend, MPP_BlendMode) that hook Graphics._createRenderer and touch renderer.state.blendModes
    // or renderer.gl constants assuming PIXI.WebGLRenderer.
    const WEBGL_CONST_STUB: Record<string, any> = {
      ZERO: 0,
      ONE: 1,
      SRC_COLOR: 0x0300,
      ONE_MINUS_SRC_COLOR: 0x0301,
      SRC_ALPHA: 0x0302,
      ONE_MINUS_SRC_ALPHA: 0x0303,
      DST_ALPHA: 0x0304,
      ONE_MINUS_DST_ALPHA: 0x0305,
      DST_COLOR: 0x0306,
      ONE_MINUS_DST_COLOR: 0x0307,
      SRC_ALPHA_SATURATE: 0x0308,
      FUNC_ADD: 0x8006,
      FUNC_SUBTRACT: 0x800a,
      FUNC_REVERSE_SUBTRACT: 0x800b,
      CONSTANT_COLOR: 0x8001,
      ONE_MINUS_CONSTANT_COLOR: 0x8002,
      CONSTANT_ALPHA: 0x8003,
      ONE_MINUS_CONSTANT_ALPHA: 0x8004,
      BLEND: 0x0be2,
      blendEquation() {},
      blendEquationSeparate() {},
      blendFunc() {},
      blendFuncSeparate() {},
      getParameter() { return 0; },
      getExtension() { return null; },
    };

    const canvasRendererProto = PIXI?.CanvasRenderer?.prototype;
    if (canvasRendererProto) {
      if (!('state' in canvasRendererProto)) {
        Object.defineProperty(canvasRendererProto, 'state', {
          configurable: true,
          get() {
            if (!this.__sw2StubWebGLState) {
              const modes: any[] = [];
              for (let i = 0; i < 64; i++) modes[i] = [1, 0x0303];
              this.__sw2StubWebGLState = {
                blendModes: modes,
                activeState: new Uint8Array(10),
                defaultState: new Uint8Array(10),
                setState() {},
                setBlend() {},
                setBlendMode() {},
                setDepthTest() {},
                setCullFace() {},
                setFrontFace() {},
                resetToDefault() {},
                resetAttributes() {},
              };
            }
            return this.__sw2StubWebGLState;
          },
          set(v: any) {
            this.__sw2StubWebGLState = v;
          },
        });
      }

      if (typeof canvasRendererProto.setBlendMode === 'function' && !canvasRendererProto.__sw2BlendGuard) {
        const origSetBlendMode = canvasRendererProto.setBlendMode;
        canvasRendererProto.__sw2BlendGuard = true;
        canvasRendererProto.setBlendMode = function (blendMode: number) {
          if (this.blendModes && this.blendModes[blendMode] === undefined) {
            // Custom WebGL blend mode IDs (e.g. Khas Ultra/Advanced Lighting: KHAS_LIGHT=31 additive, KHAS_LIGHTING=32 multiply)
            const bm = PIXI?.BLEND_MODES;
            if (blendMode === bm?.KHAS_LIGHT || blendMode === 31) {
              this.blendModes[blendMode] = 'lighter';
            } else if (blendMode === bm?.KHAS_LIGHTING || blendMode === 32) {
              this.blendModes[blendMode] = 'multiply';
            } else {
              this.blendModes[blendMode] = blendMode >= 17 ? 'multiply' : 'source-over';
            }
          }
          return origSetBlendMode.call(this, blendMode);
        };
      }

      // Fix PIXI v4 CanvasRenderer.prototype.render when rendering to a RenderTexture:
      // 1. Stock PIXI v4 has an unimplemented `// else { // TODO }` for clearing RenderTextures,
      //    leaving offscreen lightmaps uncleared across frames.
      // 2. Stock PIXI v4 saves `var tempContext = this.context` AFTER overwriting `this.context = context`,
      //    failing to restore `this.context` back to `this.rootContext`.
      if (typeof canvasRendererProto.render === 'function' && !canvasRendererProto.__sw2RenderTexFix) {
        const origCanvasRender = canvasRendererProto.render;
        canvasRendererProto.__sw2RenderTexFix = true;
        canvasRendererProto.render = function (
          displayObject: any,
          renderTexture?: any,
          clear?: boolean,
          transform?: any,
          skipUpdateTransform?: boolean,
        ) {
          const rootCtx = this.rootContext || this.context;
          if (renderTexture && clear !== false) {
            const rt = renderTexture.baseTexture?._canvasRenderTarget;
            const ctx = rt?.context;
            const cvs = rt?.canvas;
            if (ctx && cvs) {
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.globalCompositeOperation = 'source-over';
              ctx.globalAlpha = 1;
              ctx.clearRect(0, 0, cvs.width, cvs.height);
            }
          }
          try {
            return origCanvasRender.call(this, displayObject, renderTexture, clear, transform, skipUpdateTransform);
          } finally {
            if (renderTexture && rootCtx) {
              this.context = rootCtx;
            }
          }
        };
      }
    }

    // KhasUltraLighting / KhasAdvancedLighting Canvas2D compatibility & performance fast-path:
    // In WebGL, Khas_Lighting uses a fragment shader (`light + ambientLight`) with `KHAS_LIGHTING` (multiply)
    // and per-light shadow RenderTextures. In CanvasRenderer, sprite filters do not run, so we:
    // 1. Force `castShadows = false` on Sprite_Light so lights draw their radial texture directly
    //    without black shadow-mask polygons or per-light offscreen RenderTextures.
    // 2. Set `_layerSprite.blendMode = PIXI.BLEND_MODES.MULTIPLY`.
    // 3. Hide `_layerSprite` completely (0ms) when ambient light is 100% white and no point lights exist;
    //    otherwise fill `_lightMap` with the ambient RGB color and render additive point lights on top.
    const SpriteLightProto = runtime.Sprite_Light?.prototype;
    if (SpriteLightProto && !SpriteLightProto.__sw2CanvasLight) {
      SpriteLightProto.__sw2CanvasLight = true;
      if (typeof SpriteLightProto.setRendering === 'function') {
        const origSetRendering = SpriteLightProto.setRendering;
        SpriteLightProto.setRendering = function (_which: boolean) {
          return origSetRendering.call(this, false);
        };
      }
      if (typeof SpriteLightProto.render === 'function') {
        SpriteLightProto.render = function () {};
      }
      if (typeof SpriteLightProto.refreshScreenPosition === 'function') {
        SpriteLightProto.refreshScreenPosition = function () {
          if (this._syncWithDirection) {
            const d = this._character?._direction || 2;
            if (d !== this._last_direction) {
              const bmp = this.getCachedBitmap?.(this._id, d);
              if (this._light) {
                this._light.bitmap = bmp;
              } else if (bmp?.baseTexture && PIXI?.Texture) {
                this.texture = new PIXI.Texture(bmp.baseTexture);
              }
              this._last_direction = d;
              this._last_crx = null;
              this._last_cry = null;
            }
            this._screenX = this._character.lightScreenX() + (this._ox?.[d] ?? 0);
            this._screenY = this._character.lightScreenY() + (this._oy?.[d] ?? 0);
          } else {
            this._screenX = this._character.lightScreenX() + (this._ox || 0);
            this._screenY = this._character.lightScreenY() + (this._oy || 0);
          }
        };
      }
    }
    const KhasLightingProto = runtime.Khas_Lighting?.prototype;
    if (KhasLightingProto && typeof KhasLightingProto.update === 'function' && !KhasLightingProto.__sw2CanvasLighting) {
      KhasLightingProto.__sw2CanvasLighting = true;
      KhasLightingProto.update = function () {
        const layerSprite = this._layerSprite;
        // Support both KhasUltraLighting v4.2 (this._lightingState) and v1.0 (this._AutoStatus / this._ambientLight)
        if (this._lightingState) {
          if (this._enabled !== this._lightingState.enabled) {
            this._enabled = this._lightingState.enabled;
            if (layerSprite) layerSprite.visible = Boolean(this._enabled);
          }
          if (!this._enabled) {
            if (layerSprite) layerSprite.visible = false;
            return;
          }
          this._lightingState.update?.();
        } else if ('_AutoStatus' in this) {
          if (!this._AutoStatus) {
            if (layerSprite) layerSprite.visible = false;
            return;
          }
          if (this._timeTransfer > 0 && this._ambientLight && this._targetAmbientLight) {
            const t = this._timeTransfer;
            this._ambientLight.red = (this._ambientLight.red * (t - 1) + this._targetAmbientLight.red) / t;
            this._ambientLight.green = (this._ambientLight.green * (t - 1) + this._targetAmbientLight.green) / t;
            this._ambientLight.blue = (this._ambientLight.blue * (t - 1) + this._targetAmbientLight.blue) / t;
            this._ambientLight.intensity =
              (this._ambientLight.intensity * (t - 1) + this._targetAmbientLight.intensity) / t;
            this._timeTransfer--;
          }
        }
        if (!layerSprite) return;
        layerSprite.blendMode = PIXI?.BLEND_MODES?.MULTIPLY ?? 2;

        if (Array.isArray(this._lights)) {
          for (let i = 0; i < this._lights.length; i++) {
            const l = this._lights[i];
            l.update?.();
            if (typeof l.deleted === 'function' && l.deleted()) {
              this.deleteLight?.(l);
              i--;
            }
          }
        }

        const amb = this._lightingState?.ambientLight ?? this._ambientLight;
        const intensity = amb?.intensity ?? 1;
        const ambR = Math.max(0, Math.min(255, Math.round((amb?.red ?? 1) * intensity * 255)));
        const ambG = Math.max(0, Math.min(255, Math.round((amb?.green ?? 1) * intensity * 255)));
        const ambB = Math.max(0, Math.min(255, Math.round((amb?.blue ?? 1) * intensity * 255)));
        const numLights = Array.isArray(this._lights) ? this._lights.length : 0;

        if (numLights === 0 && ambR >= 253 && ambG >= 253 && ambB >= 253) {
          layerSprite.visible = false;
          return;
        }
        layerSprite.visible = true;

        const fc = Graphics?.frameCount || 0;
        const ambKey = (ambR << 16) | (ambG << 8) | ambB;
        if (numLights === 0 && this._sw2LastAmbKey === ambKey && this._sw2LastNumLights === 0) {
          return;
        }
        if (numLights > 0 && this._sw2LastNumLights > 0 && (fc & 1) === 1) {
          return;
        }
        this._sw2LastAmbKey = ambKey;
        this._sw2LastNumLights = numLights;

        const rt = this._lightMap?.baseTexture?._canvasRenderTarget;
        const ctx = rt?.context;
        const cvs = rt?.canvas;
        if (ctx && cvs) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
          ctx.fillStyle = `rgb(${ambR},${ambG},${ambB})`;
          ctx.fillRect(0, 0, cvs.width, cvs.height);
          if (numLights > 0 && Graphics?._renderer) {
            Graphics._renderer.render(this._layer, this._lightMap, false);
          }
        }
      };
    }

    // Guard PIXI.Sprite._renderCanvas, PIXI.TilingSprite._renderCanvas, and PIXI.CanvasSpriteRenderer.render
    // against null `_texture` or null `_texture._frame` (e.g. Khas Ultra/Advanced Lighting's unallocated WebGL lightmap sprite).
    const pixiSpriteProto = PIXI?.Sprite?.prototype;
    if (pixiSpriteProto && typeof pixiSpriteProto._renderCanvas === 'function' && !pixiSpriteProto.__sw2NullTexGuard) {
      const origSpriteRenderCanvas = pixiSpriteProto._renderCanvas;
      pixiSpriteProto.__sw2NullTexGuard = true;
      pixiSpriteProto._renderCanvas = function (renderer: any) {
        if (!this._texture || !this._texture._frame || !this._texture.orig || !this._texture.baseTexture) {
          return;
        }
        return origSpriteRenderCanvas.call(this, renderer);
      };
    }

    const canvasSpriteRendererProto =
      PIXI?.CanvasSpriteRenderer?.prototype ?? PIXI?.CanvasRenderer?.__plugins?.sprite?.prototype;
    if (
      canvasSpriteRendererProto &&
      typeof canvasSpriteRendererProto.render === 'function' &&
      !canvasSpriteRendererProto.__sw2NullTexGuard
    ) {
      const origCSRRender = canvasSpriteRendererProto.render;
      canvasSpriteRendererProto.__sw2NullTexGuard = true;
      canvasSpriteRendererProto.render = function (sprite: any) {
        if (!sprite || !sprite._texture || !sprite._texture._frame || !sprite._texture.orig || !sprite._texture.baseTexture) {
          return;
        }
        return origCSRRender.call(this, sprite);
      };
    }

    const pixiTilingProto = PIXI?.extras?.TilingSprite?.prototype ?? PIXI?.TilingSprite?.prototype;
    if (pixiTilingProto && typeof pixiTilingProto._renderCanvas === 'function' && !pixiTilingProto.__sw2NullTexGuard) {
      const origTilingRenderCanvas = pixiTilingProto._renderCanvas;
      pixiTilingProto.__sw2NullTexGuard = true;
      pixiTilingProto._renderCanvas = function (renderer: any) {
        if (!this._texture || !this._texture._frame || !this._texture.baseTexture) {
          return;
        }
        return origTilingRenderCanvas.call(this, renderer);
      };
    }

    // Ensure PIXI v4 CanvasRenderer uses valid Canvas2D blend mode 'saturation'
    // and recovers cleanly if a WebGL-only plugin throws inside Graphics._createRenderer
    const origCreateRenderer = Graphics._createRenderer;
    if (typeof origCreateRenderer === 'function') {
      Graphics._createRenderer = function () {
        let addedGlStub = false;
        if (canvasRendererProto && !('gl' in canvasRendererProto)) {
          Object.defineProperty(canvasRendererProto, 'gl', {
            configurable: true,
            value: WEBGL_CONST_STUB,
          });
          addedGlStub = true;
        }
        let res: any;
        try {
          res = origCreateRenderer.apply(this, arguments);
        } catch (err) {
          log(`[compat] recovered from plugin error in Graphics._createRenderer: ${String(err)}`);
          if (!this._renderer && PIXI?.CanvasRenderer) {
            this._renderer = new PIXI.CanvasRenderer(this._width || 816, this._height || 624, {
              view: this._canvas,
            });
          }
        } finally {
          if (addedGlStub && canvasRendererProto) {
            delete canvasRendererProto.gl;
          }
        }
        const r = this._renderer;
        if (isWebGLMode) {
          // Disable mipmap auto-generation on PixiJS v5 MV upgrades (saves OunceVK texture upload cost)
          if (PIXI?.settings && PIXI?.MIPMAP_MODES && 'MIPMAP_TEXTURES' in PIXI.settings) {
            PIXI.settings.MIPMAP_TEXTURES = PIXI.MIPMAP_MODES.OFF;
          }
          // Stock RPG Maker MV sets textureGC.maxIdle = 1 (unloading textures after 1s!),
          // causing massive re-uploads & hitches on Switch 2. Keep textures resident for 10 min.
          if (r?.textureGC) {
            r.textureGC.maxIdle = 600;
            r.textureGC.checkCountMax = 1200;
          }
          // Live2D Cubism draws with its own programs/textures between PIXI draws. PIXI v4 caches
          // `_activeShader` / `boundTextures`, so after a Live2D draw it may skip re-binding and draw
          // with Live2D's program/textures (white sprites & textboxes). Validate the cache against the
          // real GL bindings (tracked in browser-host) and invalidate on mismatch.
          const rgl = r?.gl;
          if (rgl?.__drBoundProgram && typeof r.bindShader === 'function' && !r.__drResync) {
            r.__drResync = true;
            const origBindShader = r.bindShader.bind(r);
            r.bindShader = function (shader: any, autoProject?: boolean) {
              if (this._activeShader && rgl.__drBoundProgram() !== this._activeShader.program) {
                this._activeShader = null;
              }
              return origBindShader(shader, autoProject);
            };
            if (typeof r.bindTexture === 'function') {
              const origBindTexture = r.bindTexture.bind(r);
              r.bindTexture = function (texture: any, location?: number, forceLocation?: boolean) {
                const bt = this.boundTextures;
                if (bt) {
                  for (let slot = 0; slot < 2; slot++) {
                    const cached = bt[slot];
                    const gt = cached?._glTextures?.[this.CONTEXT_UID]?.texture;
                    if (gt && rgl.__drBoundTex2D(slot) !== gt) {
                      bt[slot] = this.emptyTextures?.[slot] ?? null;
                    }
                  }
                }
                return origBindTexture(texture, location, forceLocation);
              };
            }
            // PIXI v4's sprite batcher never calls bindTexture for a texture it believes is already in
            // `renderer.boundTextures` (it reuses the slot via `_virtalBoundId`). After Live2D Cubism has
            // bound its own textures to units 0/1, windows and sprites cached in those slots sampled the
            // Live2D texture instead (white message boxes / white rectangles over sprites in Lilialette's
            // Hustle). Before every batch flush, drop any cached slot whose texture is no longer the one
            // actually bound in GL, and forget the cached blend mode, so PIXI rebinds what it needs.
            const spriteRenderer = r.plugins?.sprite;
            if (spriteRenderer && typeof spriteRenderer.flush === 'function' && !spriteRenderer.__drSlotSync) {
              spriteRenderer.__drSlotSync = true;
              const origFlush = spriteRenderer.flush;
              const uid = r.CONTEXT_UID;
              spriteRenderer.flush = function (this: any) {
                const bt = r.boundTextures;
                const empty = r.emptyTextures;
                if (bt && empty) {
                  for (let slot = 0; slot < bt.length; slot++) {
                    const cached = bt[slot];
                    if (!cached || cached === empty[slot]) continue;
                    const gt = cached._glTextures?.[uid]?.texture;
                    if (!gt || rgl.__drBoundTex2D(slot) !== gt) {
                      bt[slot] = empty[slot];
                    }
                  }
                }
                const st = r.state;
                if (st && rgl.__drBoundProgram() !== r._activeShader?.program) {
                  // Another GL user ran since PIXI last drew: its blend func may be active.
                  // PIXI v4 caches it in activeState[4] (BLEND_FUNC); v5-style ports in `blendMode`.
                  if (st.activeState && st.activeState.length > 4) st.activeState[4] = -1;
                  if ('blendMode' in st) st.blendMode = -1;
                }
                return origFlush.apply(this, arguments);
              };
            }
          }
          log(`[compat] MV renderer created: ${r?.constructor?.name ?? 'null'} (type=${r?.type ?? '?'}, gl=${Boolean(r?.gl)})`);
        }
        const sat = PIXI?.BLEND_MODES?.SATURATION;
        if (r?.type === PIXI?.RENDERER_TYPE?.CANVAS && sat !== undefined && r.blendModes?.[sat] === 'saturate') {
          r.blendModes[sat] = 'saturation';
        }
        const spritePlugin = r?.plugins?.sprite;
        if (spritePlugin && typeof spritePlugin.render === 'function' && !spritePlugin.__sw2NullTexGuard) {
          const origPluginRender = spritePlugin.render;
          spritePlugin.__sw2NullTexGuard = true;
          spritePlugin.render = function (sprite: any) {
            if (!sprite || !sprite._texture || !sprite._texture._frame || !sprite._texture.orig || !sprite._texture.baseTexture) {
              return;
            }
            return origPluginRender.call(this, sprite);
          };
        }
        return res;
      };
    }

    // Make Graphics.playVideo safe and skippable via our native FFmpeg VideoNode
    Graphics.canPlayVideoType = (mime: string) => {
      const m = String(mime ?? '').toLowerCase();
      return m.includes('webm') || m.includes('mp4');
    };
  }

  // 3. WebAudio: select format supported by this game's audio/ folder (native FFmpeg decodes both)
  //    AND install an in-memory decoded AudioBuffer LRU cache + in-flight request coalescer!
  //    Stock RPG Maker MV re-reads `.ogg`/`.rpgmvo` from SD via XHR and runs FFmpeg `decodeAudioData`
  //    from scratch on EVERY `AudioManager.playSe()` call (footsteps in Fear & Hunger, cursor moves,
  //    and 5-20 simultaneous SEs during battle animations!). Caching decoded buffers <= 15s (up to
  //    96 MB PCM) makes repeat SE/ME/voice playback 0.0 ms instant with zero SD I/O or decode stalls.
  if (WebAudio) {
    const support = options?.audioSupport ?? { canOgg: true, canM4a: false };
    WebAudio.canPlayOgg = () => support.canOgg;
    WebAudio.canPlayM4a = () => support.canM4a;

    const WebAudioProto = WebAudio.prototype;
    if (
      WebAudioProto &&
      typeof WebAudioProto._load === 'function' &&
      typeof WebAudioProto._onXhrLoad === 'function' &&
      !WebAudioProto.__drAudioCache
    ) {
      const loadSrc = String(WebAudioProto._load);
      const onXhrSrc = String(WebAudioProto._onXhrLoad);
      if (loadSrc.includes('XMLHttpRequest') && onXhrSrc.includes('decodeAudioData')) {
        WebAudioProto.__drAudioCache = true;
        type CachedAudioEntry = {
          buffer: any;
          totalTime: number;
          sampleRate: number;
          loopStart: number;
          loopLength: number;
          bytes: number;
        };
        const MAX_AUDIO_CACHE_BYTES = 96 * 1024 * 1024;
        const MAX_CACHE_DURATION_SEC = 15;
        const audioCache = new Map<string, CachedAudioEntry>();
        const inflightAudio = new Map<string, Array<(entry: CachedAudioEntry | null) => void>>();
        let audioCacheBytes = 0;

        const putAudioCache = (key: string, entry: CachedAudioEntry) => {
          if (entry.totalTime <= 0 || entry.totalTime > MAX_CACHE_DURATION_SEC || entry.bytes > 16 * 1024 * 1024) {
            return;
          }
          if (audioCache.has(key)) {
            const old = audioCache.get(key)!;
            audioCacheBytes -= old.bytes;
            audioCache.delete(key);
          }
          while (audioCacheBytes + entry.bytes > MAX_AUDIO_CACHE_BYTES && audioCache.size > 0) {
            const oldestKey = audioCache.keys().next().value;
            if (oldestKey === undefined) break;
            const oldest = audioCache.get(oldestKey)!;
            audioCacheBytes -= oldest.bytes;
            audioCache.delete(oldestKey);
          }
          audioCache.set(key, entry);
          audioCacheBytes += entry.bytes;
        };

        const applyAudioEntry = (inst: any, entry: CachedAudioEntry, syncReady: boolean) => {
          inst._buffer = entry.buffer;
          inst._totalTime = entry.totalTime;
          inst._sampleRate = entry.sampleRate;
          inst._loopStart = entry.loopStart;
          inst._loopLength = entry.loopLength;
          if (syncReady) {
            Promise.resolve().then(() => {
              if (inst._buffer && inst._loadListeners?.length > 0) {
                inst._onLoad?.();
              }
            });
          } else {
            inst._onLoad?.();
          }
        };

        const origLoad = WebAudioProto._load;
        WebAudioProto._load = function (url: string) {
          if (!WebAudio._context || !url) return origLoad.call(this, url);
          const Dec = runtime.Decrypter;
          const realUrl = Dec?.hasEncryptedAudio && typeof Dec.extToEncryptExt === 'function'
            ? Dec.extToEncryptExt(url)
            : url;
          const cached = audioCache.get(realUrl);
          if (cached) {
            // Refresh LRU order
            audioCache.delete(realUrl);
            audioCache.set(realUrl, cached);
            applyAudioEntry(this, cached, true);
            return;
          }
          const waiters = inflightAudio.get(realUrl);
          if (waiters) {
            waiters.push((entry) => {
              if (entry) applyAudioEntry(this, entry, false);
              else {
                this._hasError = true;
                this._loader?.();
              }
            });
            return;
          }
          const queue: Array<(entry: CachedAudioEntry | null) => void> = [];
          inflightAudio.set(realUrl, queue);

          const XHR = (globalThis as any).XMLHttpRequest;
          const xhr = new XHR();
          xhr.open('GET', realUrl);
          xhr.responseType = 'arraybuffer';
          xhr.onload = () => {
            if (xhr.status < 400 && xhr.response) {
              let array = xhr.response;
              try {
                if (Dec?.hasEncryptedAudio && typeof Dec.decryptArrayBuffer === 'function') {
                  array = Dec.decryptArrayBuffer(array);
                }
                this._readLoopComments?.(new Uint8Array(array));
              } catch { /* ignore header parse errors */ }
              const rawSampleRate = this._sampleRate || 0;
              const rawLoopStart = this._loopStart || 0;
              const rawLoopLen = this._loopLength || 0;
              WebAudio._context.decodeAudioData(
                array,
                (buffer: any) => {
                  const totalTime = Number(buffer?.duration) || 0;
                  let loopStart = 0;
                  let loopLength = totalTime;
                  if (rawLoopLen > 0 && rawSampleRate > 0) {
                    loopStart = rawLoopStart / rawSampleRate;
                    loopLength = rawLoopLen / rawSampleRate;
                  }
                  const ch = Number(buffer?.numberOfChannels) || 2;
                  const len = Number(buffer?.length) || Math.ceil(totalTime * 44100);
                  const entry: CachedAudioEntry = {
                    buffer,
                    totalTime,
                    sampleRate: rawSampleRate,
                    loopStart,
                    loopLength,
                    bytes: ch * len * 4,
                  };
                  putAudioCache(realUrl, entry);
                  inflightAudio.delete(realUrl);
                  applyAudioEntry(this, entry, false);
                  for (let i = 0; i < queue.length; i++) queue[i](entry);
                },
                () => {
                  inflightAudio.delete(realUrl);
                  this._hasError = true;
                  for (let i = 0; i < queue.length; i++) queue[i](null);
                },
              );
            } else {
              inflightAudio.delete(realUrl);
              this._hasError = true;
              for (let i = 0; i < queue.length; i++) queue[i](null);
            }
          };
          xhr.onerror = () => {
            inflightAudio.delete(realUrl);
            if (typeof this._loader === 'function') this._loader();
            else this._hasError = true;
            for (let i = 0; i < queue.length; i++) queue[i](null);
          };
          xhr.send();
        };
        log('[audio] WebAudio decoded SE/ME buffer LRU cache (96 MB) & request coalescing enabled');
      }
    }
  }

  // 4. Hook `111_InputForm` plugin command to Switch 2's native Software Keyboard (swkbd)
  if (Game_Interpreter?.prototype?.pluginCommand) {
    const origCmd = Game_Interpreter.prototype.pluginCommand;
    Game_Interpreter.prototype.pluginCommand = function (command: string, args: string[]) {
      if (command === 'InputForm') {
        try {
          const joined = (args || []).join(' ');
          const vMatch = /v=(\d+)/.exec(joined);
          const phMatch = /placeholder=([^;]+)/.exec(joined);
          const varId = vMatch ? Number(vMatch[1]) : 0;
          const initial = phMatch
            ? (phMatch[1] === '$' ? String(runtime.$gameVariables?.value(varId) ?? '') : phMatch[1])
            : '';
          const promptFn = (globalThis as any).prompt;
          const entered = typeof promptFn === 'function' ? promptFn('Enter text', initial) : initial;
          if (varId > 0 && runtime.$gameVariables) {
            runtime.$gameVariables.setValue(varId, entered ?? initial);
          }
          log(`[inputform] swkbd -> var[${varId}] = "${entered ?? initial}"`);
          return;
        } catch (err) {
          log(`[inputform] error: ${String(err)}`);
          return;
        }
      }
      return origCmd.call(this, command, args);
    };
  }

  // 5. Log uncaught RPG Maker SceneManager errors cleanly to SD log & display on-screen error
  if (SceneManager?.catchException) {
    const origCatch = SceneManager.catchException;
    SceneManager.catchException = function (e: unknown) {
      let header = 'RPG Maker MV Exception';
      let msg: string;
      if (e instanceof Error) {
        header = `${e.name || 'Error'}: ${e.message || ''}`;
        const stack = e.stack || '';
        msg = stack.includes(e.message) && stack.startsWith(e.name) ? stack : `${header}\n${stack}`;
      } else {
        msg = String(e);
      }
      log(`[SceneManager] EXCEPTION: ${msg}`);
      try {
        origCatch.call(this, e);
      } catch { /* ignore */ }
      options?.onFatalError?.(header, msg);
    };
  }

  // 6. Direct GPU screen framing + universal MV performance optimizations for Switch 2
  let perfFrames = 0;
  let perfUpdateSum = 0;
  let perfRenderSum = 0;
  let perfLastLog = performance.now();
  let perfLogCount = 0;
  let hudLastRenderMs = 0;

  if (Graphics) {
    // In WebGL2 mode, never skip frames: skipping a render skips eglSwapBuffers (VSync), causing
    // rAF to fire immediately and breaking 60Hz frame pacing (judder while scrolling).
    Graphics._maxSkip = isWebGLMode ? 0 : 1;
  }

  // 6a. Graphics.render: frame direct GPU screen clipping/viewport around PIXI render
  if (Graphics?.render) {
    const origRender = Graphics.render;
    Graphics.render = function (stage: any) {
      // Graphics.initialize() resets _maxSkip=3 after installMvCompat(). In WebGL2 mode, skipping a
      // render skips eglSwapBuffers (VSync), firing a 1ms ghost frame with 0 update ticks (fps~68,
      // ticks/f~0.86 -> scrolling judder in Ambrosia). Enforce _maxSkip=0 & _skipCount=0 on WebGL2!
      if (isWebGLMode) {
        this._maxSkip = 0;
        this._skipCount = 0;
      }
      const willRender = this._skipCount <= 0;
      const t0 = performance.now();
      if (willRender) {
        // One count per presented frame (Graphics.frameCount counts logic ticks, ~2 per frame at 30 fps)
        runtime.__drRenderFrame = (runtime.__drRenderFrame | 0) + 1;
        host.beginFrame();
      }
      let out: any;
      try {
        out = origRender.call(this, stage);
      } finally {
        if (isWebGLMode) {
          this._skipCount = 0;
        }
        if (willRender) {
          const rdt = performance.now() - t0;
          perfRenderSum += rdt;
          hudLastRenderMs += rdt;
        }
        // WebGL2 mode: on skipped frames nothing was drawn into this swapchain buffer, so drawing the
        // Minus-menu/HUD overlay (and swapping) would present a stale/partial buffer -> flicker.
        if (willRender || !isWebGLMode) {
          host.endFrame(Graphics._video);
        }
      }
      return out;
    };
  }

  // 6b. WindowLayer.renderCanvas fast-path:
  //   0 visible windows -> skip CPU _tempCanvas completely
  //   1 visible window  -> no overlapping punch-out needed; draw directly to GPU screen!
  //   2+ visible windows -> keep _tempCanvas with preserveSize=true (no realloc/clear)
  const WindowLayerProto = runtime.WindowLayer?.prototype;
  if (WindowLayerProto?.renderCanvas && !WindowLayerProto.__drFastLayer) {
    WindowLayerProto.__drFastLayer = true;
    const origWindowLayerRender = WindowLayerProto.renderCanvas;
    WindowLayerProto.renderCanvas = function (renderer: any) {
      if (!this.visible || !this.renderable) return;
      let visibleCount = 0;
      let singleWin: any = null;
      const children = this.children;
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (c._isWindow && c.visible && c.openness > 0) {
          visibleCount++;
          singleWin = c;
        }
      }
      if (visibleCount === 0) {
        for (let j = 0; j < children.length; j++) {
          if (!children[j]._isWindow) children[j].renderCanvas(renderer);
        }
        return;
      }
      if (visibleCount === 1 && singleWin && renderer?.context) {
        const ctx = renderer.context;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        ctx.rect(this.x, this.y, this.width, this.height);
        ctx.closePath();
        ctx.clip();
        singleWin.renderCanvas(renderer);
        ctx.restore();
        for (let j = 0; j < children.length; j++) {
          if (!children[j]._isWindow) children[j].renderCanvas(renderer);
        }
        return;
      }
      const tc = this._tempCanvas;
      if (tc) tc.preserveSize = true;
      try {
        return origWindowLayerRender.call(this, renderer);
      } finally {
        if (tc) tc.preserveSize = false;
      }
    };
  }

  // 6c. ScreenSprite: hide 100x-screen (-5W,-5H,10W,10H) PIXI.Graphics rect when alpha === 0
  const ScreenSpriteProto = runtime.ScreenSprite?.prototype;
  if (ScreenSpriteProto && !ScreenSpriteProto.__drAlphaSkip) {
    ScreenSpriteProto.__drAlphaSkip = true;
    const origSSInit = ScreenSpriteProto.initialize;
    if (typeof origSSInit === 'function') {
      ScreenSpriteProto.initialize = function () {
        origSSInit.apply(this, arguments);
        if (this._graphics) this._graphics.visible = this.alpha > 0;
      };
    }
    try {
      Object.defineProperty(ScreenSpriteProto, 'opacity', {
        configurable: true,
        get() { return this.alpha * 255; },
        set(value: number) {
          const a = Math.max(0, Math.min(255, Number(value) || 0)) / 255;
          this.alpha = a;
          if (this._graphics) this._graphics.visible = a > 0;
        },
      });
    } catch { /* keep original if non-configurable */ }
  }

  // 6d. Fast Bitmap.snap / SceneManager.snapForBackground (avoids re-rendering 170+ sprites on CPU
  //     or full-res 3MB WebGL2 gl.readPixels stalls when opening Scene_Menu) + skip 18-pass CPU blur
  //     + fast zero-alloc rotateHue.
  const BitmapClass = runtime.Bitmap;
  if (BitmapClass && typeof BitmapClass.snap === 'function' && !BitmapClass.__drFastSnap) {
    BitmapClass.__drFastSnap = true;
    const origSnap = BitmapClass.snap;
    // One persistent snapshot target per mode, re-rendered on every menu open: only the latest menu
    // background is ever displayed, and allocating a fresh full-screen canvas / RenderTexture +
    // framebuffer per snapshot was the bulk of the 70-230ms menu-open snapshot cost.
    let snapCache: { mode: '2d' | 'rt'; w: number; h: number; bitmap: any; rt?: any } | null = null;
    let lastSnapFrame = -1;
    let lastSnapStage: any = null;
    let lastSnapBitmap: any = null;
    let snapLogCount = 0;
    const snapLog = (msg: string, isWarn = false) => {
      if (isWarn && snapLogCount < 4) {
        snapLogCount++;
        log(`[snap] ${msg}`);
      }
    };
    // A zero-copy snapshot Bitmap samples a GPU RenderTexture, so its own 2D canvas is blank and its
    // texture has no image source. Games and plugins may still draw on it (menu-background darkening,
    // custom blur, thumbnails): the first touch of its 2D context reads the RenderTexture back into the
    // canvas once and restores the Bitmap's own canvas texture, turning it into an ordinary snapshot.
    // Until then a dirty flag must not reach RenderTexture.baseTexture.update(), which reads
    // `source.naturalWidth` from a null source ("Cannot read properties of null (reading 'naturalWidth')").
    const makeRtBitmapCanvasSafe = (bitmap: any, rt: any, canvasBase: any) => {
      const rtBase = rt.baseTexture;
      const ctx = bitmap._context;
      if (!ctx || !canvasBase) return;
      let materialized = false;
      const materialize = () => {
        if (materialized) return;
        materialized = true;
        let pixels: any = null;
        try {
          if (!rtBase?.destroyed) pixels = Graphics._renderer?.extract?.canvas?.(rt);
        } catch (err) {
          snapLog(`zero-copy readback failed: ${String(err)}`);
        }
        delete bitmap._context;
        bitmap._context = ctx;
        try { delete bitmap.baseTexture; } catch { /* ignore */ }
        try { delete bitmap._baseTexture; } catch { /* ignore */ }
        try { bitmap._baseTexture = canvasBase; } catch { /* getter-only: own prop already removed */ }
        delete bitmap.checkDirty;
        if (pixels) {
          ctx.save?.();
          ctx.globalCompositeOperation = 'copy';
          ctx.globalAlpha = 1;
          ctx.drawImage(pixels, 0, 0, bitmap.width || pixels.width, bitmap.height || pixels.height);
          ctx.restore?.();
        }
        bitmap._setDirty?.();
        // This Bitmap now owns its pixels: never hand it out again as the reusable snapshot target.
        const cached = snapCache;
        if (cached && cached.bitmap === bitmap) {
          try { cached.rt?.destroy?.(true); } catch { /* ignore */ }
          snapCache = null;
        }
        if (lastSnapBitmap === bitmap) lastSnapBitmap = null;
        snapLog('zero-copy snapshot drawn on by the game -> converted to canvas bitmap');
      };
      Object.defineProperty(bitmap, '_context', {
        configurable: true,
        enumerable: true,
        get() { materialize(); return ctx; },
        set(v) { materialize(); delete bitmap._context; bitmap._context = v; },
      });
      const protoCheckDirty = Object.getPrototypeOf(bitmap)?.checkDirty;
      bitmap.checkDirty = function (this: any, ...args: any[]) {
        if (!materialized && this.baseTexture === rtBase) {
          this._dirty = false;
          return undefined;
        }
        return protoCheckDirty?.apply(this, args);
      };
    };
    BitmapClass.snap = function (stage: any) {
      const fc = typeof Graphics?.frameCount === 'number' ? Graphics.frameCount : -2;
      if (fc >= 0 && fc === lastSnapFrame && stage && stage === lastSnapStage && lastSnapBitmap && !lastSnapBitmap._destroyed) {
        return lastSnapBitmap;
      }
      const remember = (bmp: any) => {
        if (fc >= 0 && stage && bmp) {
          lastSnapFrame = fc;
          lastSnapStage = stage;
          lastSnapBitmap = bmp;
        }
        return bmp;
      };
      const gw = Graphics?.width || 816;
      const gh = Graphics?.height || 624;
      // 2D directGPU mode: copy the already-rendered screen surface directly in 1 GPU blit (<1ms)
      // instead of creating a 1280x720 PIXI.RenderTexture and re-rendering the whole map on CPU!
      if (!isWebGLMode && stage === SceneManager?._scene && host.isDirectGpu()) {
        const sctx = host.getScreenContext?.();
        const surf = sctx?.canvas;
        const vp = host.getViewport?.();
        if (surf && vp && vp.w > 0 && vp.h > 0) {
          try {
            const t0 = performance.now();
            let c = snapCache;
            const reused = Boolean(
              c && c.mode === '2d' && c.w === gw && c.h === gh && c.bitmap?._context && !c.bitmap._destroyed,
            );
            if (!reused) {
              const bmp = new BitmapClass(gw, gh);
              c = snapCache = bmp?._context ? { mode: '2d', w: gw, h: gh, bitmap: bmp } : null;
            }
            const t1 = performance.now();
            const ctx = c?.bitmap?._context;
            if (c && ctx) {
              ctx.save?.();
              ctx.globalCompositeOperation = 'copy';
              ctx.globalAlpha = 1;
              ctx.drawImage(surf, vp.x, vp.y, vp.w, vp.h, 0, 0, gw, gh);
              ctx.restore?.();
              c.bitmap._setDirty?.();
              snapLog(`2d screen copy: alloc=${(t1 - t0).toFixed(1)}ms copy=${(performance.now() - t1).toFixed(1)}ms reused=${reused}`);
              return remember(c.bitmap);
            }
          } catch (err) {
            snapLog(`2d screen copy failed: ${String(err)}`);
          }
        }
      }
      // WebGL2 mode: render into a half-resolution RenderTexture so gl.readPixels reads 4x fewer bytes
      // (cuts menu-open GPU pipeline stall dramatically while looking clean behind menus).
      if (isWebGLMode && stage && Graphics?._renderer && PIXI?.RenderTexture?.create) {
        // PixiJS v4 (`PIXI.RenderTexture.create(w, h)`) takes positional numbers, whereas PixiJS v5
        // accepts `{ width, height }`. Passing an object in PixiJS v4 sets `baseTexture.width = [object Object]`!
        const createPixiRt = (w: number, h: number) =>
          (!PIXI.BatchRenderer || String(PIXI.VERSION || '').startsWith('4.'))
            ? PIXI.RenderTexture.create(w, h)
            : PIXI.RenderTexture.create({ width: w, height: h });
        // Zero-readback path: render the scene into a GPU RenderTexture and let the background Bitmap
        // sample it directly (no gl.readPixels pipeline stall, no canvas copy, no re-upload).
        try {
          const t0 = performance.now();
          let c = snapCache;
          const reused = Boolean(
            c && c.mode === 'rt' && c.w === gw && c.h === gh && c.rt && !c.rt.baseTexture?.destroyed &&
            c.bitmap && c.bitmap.baseTexture === c.rt.baseTexture,
          );
          if (!reused) {
            const rt = createPixiRt(gw, gh);
            const bitmap = new BitmapClass(gw, gh);
            const base = rt.baseTexture;
            const prevBase = bitmap._baseTexture;
            // Some PixiJS v5 MV ports expose Bitmap#_baseTexture as a getter-only accessor, so plain
            // assignment throws in strict mode: shadow both accessors with own properties instead.
            try { bitmap._baseTexture = base; } catch { /* getter-only */ }
            if (bitmap._baseTexture !== base) {
              try {
                Object.defineProperty(bitmap, '_baseTexture', { value: base, writable: true, configurable: true });
              } catch { /* ignore */ }
            }
            if (bitmap.baseTexture !== base) {
              try {
                Object.defineProperty(bitmap, 'baseTexture', { get: () => base, configurable: true });
              } catch { /* ignore */ }
            }
            if (bitmap.baseTexture === base) {
              try { if (snapCache?.rt) snapCache.rt.destroy?.(true); } catch { /* ignore */ }
              makeRtBitmapCanvasSafe(bitmap, rt, prevBase);
              c = snapCache = { mode: 'rt', w: gw, h: gh, bitmap, rt };
            } else {
              try { bitmap._baseTexture = prevBase; } catch { /* ignore */ }
              rt.destroy?.(true);
              c = null;
              snapLog('webgl zero-copy unavailable (Bitmap.baseTexture not overridable) -> readback path');
            }
          }
          if (c && c.rt) {
            const t1 = performance.now();
            Graphics._renderer.render(stage, c.rt, true);
            snapLog(
              `webgl zero-copy: alloc=${(t1 - t0).toFixed(1)}ms render=${(performance.now() - t1).toFixed(1)}ms reused=${reused}`,
            );
            return remember(c.bitmap);
          }
        } catch (err) {
          snapLog(`webgl zero-copy failed: ${String(err)}`);
        }
        try {
          const hw = Math.max(1, gw >> 1);
          const hh = Math.max(1, gh >> 1);
          const rt = createPixiRt(hw, hh);
          const prevSx = stage.scale?.x ?? 1;
          const prevSy = stage.scale?.y ?? 1;
          if (stage.scale) stage.scale.set(prevSx * (hw / gw), prevSy * (hh / gh));
          try {
            Graphics._renderer.render(stage, rt);
          } finally {
            if (stage.scale) stage.scale.set(prevSx, prevSy);
            stage.worldTransform?.identity?.();
          }
          const extracted = Graphics._renderer.extract?.canvas?.(rt);
          rt.destroy?.(true);
          if (extracted) {
            const bitmap = new BitmapClass(gw, gh);
            bitmap._context?.drawImage?.(extracted, 0, 0, extracted.width || hw, extracted.height || hh, 0, 0, gw, gh);
            bitmap._setDirty?.();
            return remember(bitmap);
          }
        } catch { /* fall through to origSnap */ }
      }
      return remember(origSnap.call(this, stage));
    };
  }
  // 6d00. Menu spritesets (e.g. MenuCommonEvent.js's Spriteset_Menu, created on every menu open) build
  //       100 Sprite_Picture objects each time (~120-300ms). Sprite_Picture reads $gameScreen live, so the
  //       container from the previous (now discarded) menu spriteset of the same class can be re-attached.
  const SpritesetBaseP = runtime.Spriteset_Base?.prototype;
  if (SpritesetBaseP && typeof SpritesetBaseP.createPictures === 'function' && !SpritesetBaseP.__drPicReuse) {
    SpritesetBaseP.__drPicReuse = true;
    const origCreatePictures = SpritesetBaseP.createPictures;
    // Everything the (possibly plugin-extended) createPictures sets up is recorded on the first build:
    // the own properties it assigned (e.g. extra picture layers added by a plugin override, which
    // updatePosition/update then touch) and the children it attached. A reuse restores all of them.
    type PicSnap = { props: Array<[string, any]>; kids: any[]; owner: any; max: number; counts: number[] };
    const pictureCache = new Map<any, PicSnap>();
    const isDisplayObj = (v: any) => Boolean(v && typeof v === 'object' && Array.isArray(v.children));
    SpritesetBaseP.createPictures = function () {
      const SM = runtime.Spriteset_Map;
      const SB = runtime.Spriteset_Battle;
      if ((SM && this instanceof SM) || (SB && this instanceof SB)) return origCreatePictures.apply(this, arguments);
      const ctor = this.constructor;
      const max = Number(runtime.$gameScreen?.maxPictures?.() ?? -1);
      const snap = pictureCache.get(ctor);
      const owner = snap?.owner;
      const ownerLive = Boolean(owner && owner !== this && owner.parent && owner.parent === SceneManager?._scene);
      const intact = Boolean(
        snap && snap.max === max && !ownerLive &&
        snap.kids.every((k: any, i: number) => !k._destroyed && Array.isArray(k.children) && k.children.length === snap.counts[i]),
      );
      if (snap && intact) {
        for (const [key, value] of snap.props) this[key] = value;
        for (const k of snap.kids) {
          try { k.parent?.removeChild?.(k); } catch { /* ignore */ }
          this.addChild(k);
        }
        snap.owner = this;
        return;
      }
      const beforeKeys = new Set(Object.keys(this));
      const beforeKids = new Set(Array.isArray(this.children) ? this.children : []);
      const res = origCreatePictures.apply(this, arguments);
      try {
        const props: Array<[string, any]> = [];
        for (const key of Object.keys(this)) {
          if (!beforeKeys.has(key)) props.push([key, this[key]]);
        }
        const kids = (Array.isArray(this.children) ? this.children : []).filter((c: any) => !beforeKids.has(c));
        // Only cache when every new child is a display object we can move, and the picture
        // container is among them (otherwise the override does something we don't understand).
        if (kids.length > 0 && kids.every(isDisplayObj) && kids.includes(this._pictureContainer)) {
          pictureCache.set(ctor, { props, kids, owner: this, max, counts: kids.map((k: any) => k.children.length) });
        } else {
          pictureCache.delete(ctor);
        }
      } catch {
        pictureCache.delete(ctor);
      }
      return res;
    };
  }

  // 6d0b. Fast JsonEx (saves / loads / makeDeepCopy). Stock MV writes '@'/'@c' metadata onto the LIVE game
  //       objects while saving and `delete`s it afterwards, and on load it calls Object.setPrototypeOf on
  //       every parsed object. In jitless V8 both leave objects in slow dictionary / prototype-mutated
  //       mode: property access on loaded Game_Event objects measured ~6x slower, which is why the first
  //       map after loading a save ran ~2x slower until the next map change rebuilt the events.
  //       This encoder builds the identical JSON from a parallel structure, and the decoder creates
  //       fresh objects with the right prototype.
  installFastJsonEx();

  // 6d0. Larger MV ImageCache: the stock 10-megapixel budget is exceeded by a single big map's tilesets +
  //      characters + faces, so opening the menu evicted map images and closing it re-read and re-decoded
  //      them from SD. 40 MP (~160 MB RGBA) fits comfortably in the Switch 2 application memory budget.
  const ImageCacheClass = runtime.ImageCache;
  if (ImageCacheClass && typeof ImageCacheClass.limit === 'number' && ImageCacheClass.limit < 40 * 1000 * 1000) {
    ImageCacheClass.limit = 40 * 1000 * 1000;
  }
  // Aetherflow_PreloadEverything (used by OMORI):
  // 1. Raise ImageCacheSize from 10 MB (2.5 MP) so 4096x4096 atlases & map tilesets don't constantly evict.
  // 2. Skip pre-decoding unused full-length BGM/BGS tracks into uncompressed Float32 PCM during Scene_Boot
  //    and Scene_Map.onMapLoaded (saves ~25s on OMORI boot, ~800ms per map load, and ~350 MB RAM).
  const aether = runtime.Aetherflow;
  if (aether?.Preload && !aether.__drFastPreload) {
    aether.__drFastPreload = true;
    if (aether.Param && typeof aether.Param.ImageCacheSize === 'number' && aether.Param.ImageCacheSize < 160 * 1000 * 1000) {
      aether.Param.ImageCacheSize = 160 * 1000 * 1000;
    }
    if (ImageCacheClass && typeof ImageCacheClass.maxSize === 'number' && ImageCacheClass.maxSize < 160 * 1000 * 1000) {
      ImageCacheClass.maxSize = 160 * 1000 * 1000;
    }
    const AM = runtime.AudioManager;
    if (AM && typeof AM.reserveAudio === 'function' && !AM.__drSkipBgmPreload) {
      AM.__drSkipBgmPreload = true;
      const origReserveAudio = AM.reserveAudio;
      AM.reserveAudio = function (folder: string, filename: string, reservationId?: any) {
        const f = String(folder || '').toLowerCase();
        if (f.startsWith('bgm') || f.startsWith('bgs') || f.startsWith('me')) {
          return null;
        }
        return origReserveAudio.call(this, folder, filename, reservationId);
      };
    }
  }
  if (SceneManager?.snapForBackground) {
    SceneManager.snapForBackground = function () {
      this._backgroundBitmap = this.snap();
    };
  }
  if (BitmapClass?.prototype?.blur) {
    BitmapClass.prototype.blur = function () {};
  }
  // 6d1. Normalize Braille Pattern Blank (U+2800, used by TMLogWindow addLog plugins as a
  //      non-splitting space) -> ASCII space AND per-draw CJK/Unicode glyph fallback when GameFont /
  //      active font is a small Latin-only font (e.g. Phenomena-Regular.otf in Nightmare Knight)
  //      while the game ships a full CJK/Unicode font (e.g. mplus-1m-regular.ttf).
  if (BitmapClass?.prototype && !BitmapClass.prototype.__drGlyphFallback) {
    BitmapClass.prototype.__drGlyphFallback = true;
    const cjkFam = fullUnicodeFallbackFamily;
    const hasSmallLatin = Boolean(cjkFam && smallLatinFontFamilies.size > 0);
    const NON_LATIN_RE = /[^\u0000-\u024F]/;
    const normalizeDrawText = (text: any): any => {
      if (typeof text === 'string' && text.includes('\u2800')) {
        return text.replace(/\u2800/g, ' ');
      }
      return text;
    };
    const needsFallback = (bmp: any, text: any): boolean => {
      if (!hasSmallLatin || text == null) return false;
      const s = String(text);
      if (!s || !NON_LATIN_RE.test(s)) return false;
      const primary = String(bmp.fontFace || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
      return smallLatinFontFamilies.has(primary);
    };
    if (typeof BitmapClass.prototype.drawText === 'function') {
      const origDrawText = BitmapClass.prototype.drawText;
      BitmapClass.prototype.drawText = function (text: any, ...rest: any[]) {
        const clean = normalizeDrawText(text);
        if (needsFallback(this, clean)) {
          const prev = this.fontFace;
          this.fontFace = cjkFam;
          try {
            return origDrawText.call(this, clean, ...rest);
          } finally {
            this.fontFace = prev;
          }
        }
        return origDrawText.call(this, clean, ...rest);
      };
    }
    if (typeof BitmapClass.prototype.measureTextWidth === 'function') {
      const origMeasure = BitmapClass.prototype.measureTextWidth;
      const textWidthCache = new Map<string, number>();
      const MAX_TEXT_WIDTH_CACHE = 8192;
      BitmapClass.prototype.measureTextWidth = function (text: any) {
        const clean = normalizeDrawText(text);
        const s = clean == null ? '' : String(clean);
        if (!s) return 0;
        const useFallback = needsFallback(this, clean);
        const effFace = useFallback ? cjkFam : this.fontFace;
        if (s.length <= 64) {
          const cacheKey = `${effFace}|${this.fontSize}|${this.fontItalic ? 1 : 0}|${this.fontBold ? 1 : 0}|${s}`;
          const hit = textWidthCache.get(cacheKey);
          if (hit !== undefined) return hit;
          let measured: number;
          if (useFallback) {
            const prev = this.fontFace;
            this.fontFace = cjkFam;
            try {
              measured = origMeasure.call(this, clean);
            } finally {
              this.fontFace = prev;
            }
          } else {
            measured = origMeasure.call(this, clean);
          }
          if (typeof measured === 'number' && !Number.isNaN(measured)) {
            if (textWidthCache.size >= MAX_TEXT_WIDTH_CACHE) textWidthCache.clear();
            textWidthCache.set(cacheKey, measured);
          }
          return measured;
        }
        if (useFallback) {
          const prev = this.fontFace;
          this.fontFace = cjkFam;
          try {
            return origMeasure.call(this, clean);
          } finally {
            this.fontFace = prev;
          }
        }
        return origMeasure.call(this, clean);
      };
    }
    if (hasSmallLatin) {
      log(`[fonts] enabled non-Latin glyph fallback -> '${cjkFam}' for small Latin fonts (${[...smallLatinFontFamilies].join(', ')})`);
    }
  }
  // Fast exact zero-allocation Bitmap.prototype.rotateHue:
  // Stock RPG Maker MV allocates millions of [h,s,l] & [r,g,b] JS arrays per animation sheet.
  // Skipping alpha===0 & gray pixels with inline scalar HSL rotation is 50-100x faster with 0 heap allocs.
  if (BitmapClass?.prototype?.rotateHue && !BitmapClass.prototype.__drFastHue) {
    BitmapClass.prototype.__drFastHue = true;
    BitmapClass.prototype.rotateHue = function (offset: number) {
      if (!offset || this.width <= 0 || this.height <= 0) return;
      const off = ((offset % 360) + 360) % 360;
      if (off === 0) return;
      const offset6 = off / 60;
      const context = this._context;
      const imageData = context.getImageData(0, 0, this.width, this.height);
      const pixels: Uint8ClampedArray = imageData.data;
      const u32 = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >>> 2);
      const len = u32.length;
      for (let p = 0; p < len; p++) {
        if (u32[p] === 0) continue;
        const i = p << 2;
        if (pixels[i + 3] === 0) continue;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const cmax = r >= g ? (r >= b ? r : b) : (g >= b ? g : b);
        const cmin = r <= g ? (r <= b ? r : b) : (g <= b ? g : b);
        const delta = cmax - cmin;
        if (delta === 0) continue;
        let h6: number;
        if (r === cmax) {
          h6 = (g - b) / delta;
          if (h6 < 0) h6 += 6;
        } else if (g === cmax) {
          h6 = (b - r) / delta + 2;
        } else {
          h6 = (r - g) / delta + 4;
        }
        h6 += offset6;
        if (h6 >= 6) h6 -= 6;
        const sector = h6 | 0;
        const frac = h6 - sector;
        const xm = cmin + ((sector & 1) ? delta * (1 - frac) : delta * frac);
        switch (sector) {
          case 0: pixels[i] = cmax; pixels[i + 1] = xm; pixels[i + 2] = cmin; break;
          case 1: pixels[i] = xm; pixels[i + 1] = cmax; pixels[i + 2] = cmin; break;
          case 2: pixels[i] = cmin; pixels[i + 1] = cmax; pixels[i + 2] = xm; break;
          case 3: pixels[i] = cmin; pixels[i + 1] = xm; pixels[i + 2] = cmax; break;
          case 4: pixels[i] = xm; pixels[i + 1] = cmin; pixels[i + 2] = cmax; break;
          default: pixels[i] = cmax; pixels[i + 1] = cmin; pixels[i + 2] = xm; break;
        }
      }
      context.putImageData(imageData, 0, 0);
      this._setDirty();
    };
  }

  // 6d2. Snappier battle initiate transition & async battleback/enemy preloading
  const SceneMapBattleProto = runtime.Scene_Map?.prototype;
  const SceneBattleProto = runtime.Scene_Battle?.prototype;
  if (SceneMapBattleProto && !SceneMapBattleProto.__drFastBattleInit) {
    SceneMapBattleProto.__drFastBattleInit = true;
    if (typeof SceneMapBattleProto.encounterEffectSpeed === 'function') {
      const origEncSpeed = SceneMapBattleProto.encounterEffectSpeed;
      SceneMapBattleProto.encounterEffectSpeed = function () {
        const s = origEncSpeed.call(this);
        return s > 18 ? 18 : s;
      };
    }
    if (typeof SceneMapBattleProto.launchBattle === 'function') {
      const origLaunchBattle = SceneMapBattleProto.launchBattle;
      SceneMapBattleProto.launchBattle = function () {
        try {
          const IM = runtime.ImageManager;
          const gm = runtime.$gameMap;
          const ds = runtime.$dataSystem;
          const gt = runtime.$gameTroop;
          if (IM) {
            const bb1 = gm?.battleback1Name?.() || ds?.battleback1Name;
            const bb2 = gm?.battleback2Name?.() || ds?.battleback2Name;
            if (bb1) IM.loadBattleback1?.(bb1);
            if (bb2) IM.loadBattleback2?.(bb2);
            const members = gt?.members?.();
            if (Array.isArray(members)) {
              for (let i = 0; i < members.length; i++) {
                const name = members[i]?.battlerName?.();
                const hue = members[i]?.battlerHue?.() || 0;
                if (name) {
                  if (ds?.optSideView) IM.loadSvEnemy?.(name, hue);
                  else IM.loadEnemy?.(name, hue);
                }
              }
            }
          }
        } catch { /* ignore preload errors */ }

        const origSnap = SceneManager?.snap;
        if (typeof origSnap === 'function' && BitmapClass) {
          let cachedSnap: any = null;
          SceneManager.snap = function () {
            if (!cachedSnap) {
              cachedSnap = origSnap.call(this);
              return cachedSnap;
            }
            const copy = new BitmapClass(cachedSnap.width, cachedSnap.height);
            copy.blt(cachedSnap, 0, 0, cachedSnap.width, cachedSnap.height, 0, 0);
            return copy;
          };
          try {
            return origLaunchBattle.call(this);
          } finally {
            SceneManager.snap = origSnap;
          }
        }
        return origLaunchBattle.call(this);
      };
    }
  }
  if (SceneBattleProto && !SceneBattleProto.__drFastBattleFade) {
    SceneBattleProto.__drFastBattleFade = true;
    SceneBattleProto.fadeSpeed = function () {
      return 15;
    };
  }

  // 6e. Fast CanvasRenderer culling for invisible, empty-frame (0x0), or off-screen sprites
  //     using dynamic Graphics.width / Graphics.height bounds, plus zero-realloc _createTinter,
  //     flash-alpha quantization, memoized _executeTint, and Sprite_Animation cell pooling/prewarm.
  const SpriteProto = runtime.Sprite?.prototype;
  if (SpriteProto && typeof SpriteProto._createTinter === 'function' && !SpriteProto.__drNoReallocTinter) {
    const ctSrc = String(SpriteProto._createTinter);
    if (ctSrc.includes('_canvas') && ctSrc.includes('_tintTexture') && ctSrc.length < 520) {
      SpriteProto.__drNoReallocTinter = true;
      SpriteProto._createTinter = function (w: number, h: number) {
        if (!this._canvas) {
          this._canvas = runtime.document.createElement('canvas');
          this._context = this._canvas.getContext('2d');
        }
        if (this._canvas.width !== w || this._canvas.height !== h) {
          this._canvas.width = w;
          this._canvas.height = h;
          this._drTintKey = '';
        }
        if (!this._tintTexture && PIXI?.BaseTexture) {
          this._tintTexture = new PIXI.BaseTexture(this._canvas);
        }
        if (this._tintTexture) {
          this._tintTexture.width = w;
          this._tintTexture.height = h;
          if (this._bitmap?.baseTexture) {
            this._tintTexture.scaleMode = this._bitmap.baseTexture.scaleMode;
          }
        }
      };
    }
  }
  if (SpriteProto && typeof SpriteProto.setBlendColor === 'function' && !SpriteProto.__drQuantBlend) {
    const sbSrc = String(SpriteProto.setBlendColor);
    if (sbSrc.includes('_blendColor') && sbSrc.includes('_refresh') && sbSrc.length < 320) {
      SpriteProto.__drQuantBlend = true;
      SpriteProto.setBlendColor = function (color: number[]) {
        if (!Array.isArray(color)) throw new Error('Argument must be an array');
        const r = color[0] | 0;
        const g = color[1] | 0;
        const b = color[2] | 0;
        const rawA = Number(color[3]) || 0;
        // Quantize decaying hit-flash alpha into 16-unit steps (preserving exact 0 and 255)
        // so 30-60 frame animation/damage flashes don't re-rasterize & re-upload battler canvases every frame!
        const qA = rawA <= 2 ? 0 : rawA >= 250 ? 255 : ((rawA + 8) & ~15);
        const cur = this._blendColor;
        if (cur && cur[0] === r && cur[1] === g && cur[2] === b && cur[3] === qA) return;
        this._blendColor = [r, g, b, qA];
        this._refresh();
      };
    }
  }
  if (SpriteProto && typeof SpriteProto._executeTint === 'function' && !SpriteProto.__drFastTint) {
    SpriteProto.__drFastTint = true;
    const origExecuteTint = SpriteProto._executeTint;
    SpriteProto._executeTint = function (x: number, y: number, w: number, h: number) {
      const context = this._context;
      const bmp = this._bitmap;
      const src = bmp?._image || bmp?._canvas;
      if (!context || !src || w <= 0 || h <= 0) return;
      const tone = this._colorTone;
      const color = this._blendColor;
      if (Array.isArray(tone) && Array.isArray(color)) {
        const bmpRev = bmp?._canvas?.revision ?? (bmp?._dirty ? 1 : 0);
        const tintKey = `${x},${y},${w},${h}|${tone[0]},${tone[1]},${tone[2]},${tone[3]}|${color[0]},${color[1]},${color[2]},${color[3]}|${bmpRev}`;
        if (this._drTintSrc === src && this._drTintKey === tintKey) return;
        this._drTintSrc = src;
        this._drTintKey = tintKey;
      }
      return origExecuteTint.call(this, x, y, w, h);
    };
  }
  if (SpriteProto?._renderCanvas && !SpriteProto.__drSpriteSkip) {
    SpriteProto.__drSpriteSkip = true;
    const origSpriteRender = SpriteProto._renderCanvas;
    SpriteProto._renderCanvas = function (renderer: any) {
      if (this._drOffscreenRender || !this.visible || !this.renderable || this.worldAlpha <= 0) return;
      const frame = this._texture?._frame;
      if (!frame || frame.width <= 0 || frame.height <= 0) return;
      if (this._character && !this._character._customResource) {
        const wt = this.worldTransform;
        if (wt && wt.b === 0 && wt.c === 0) {
          const sw = Math.abs(frame.width * wt.a);
          const sh = Math.abs(frame.height * wt.d);
          const ax = this.anchor?._x ?? this.anchor?.x ?? 0.5;
          const ay = this.anchor?._y ?? this.anchor?.y ?? 1;
          const left = wt.tx - sw * ax;
          const top = wt.ty - sh * ay;
          const gw = Graphics?.width || 816;
          const gh = Graphics?.height || 624;
          if (left + sw < -128 || left > gw + 128 || top + sh < -128 || top > gh + 128) {
            return;
          }
        }
      }
      return origSpriteRender.call(this, renderer);
    };
  }

  // 6e1b. Sprite_Animation cell-sprite pooling + eager animation sheet preloading on requestAnimation /
  //       startAnimation so battle & map animations start without cold PNG decode stalls or 16-Sprite GC churn.
  const SpriteAnimProto = runtime.Sprite_Animation?.prototype;
  const SpriteCtor = runtime.Sprite;
  if (SpriteAnimProto && typeof SpriteCtor === 'function' && !SpriteAnimProto.__drAnimPool) {
    SpriteAnimProto.__drAnimPool = true;
    const cellPool: any[] = [];
    const MAX_CELL_POOL = 96;
    if (
      typeof SpriteAnimProto.createCellSprites === 'function' &&
      String(SpriteAnimProto.createCellSprites).includes('_cellSprites') &&
      String(SpriteAnimProto.createCellSprites).length < 360
    ) {
      SpriteAnimProto.createCellSprites = function () {
        this._cellSprites = [];
        for (let i = 0; i < 16; i++) {
          let sp = cellPool.pop();
          if (!sp || sp._destroyed) {
            sp = new SpriteCtor();
          } else {
            sp.bitmap = null;
            sp.rotation = 0;
            sp.scale.x = 1;
            sp.scale.y = 1;
            sp.opacity = 255;
            sp.blendMode = 0;
          }
          sp.anchor.x = 0.5;
          sp.anchor.y = 0.5;
          sp.visible = false;
          this._cellSprites.push(sp);
          this.addChild(sp);
        }
      };
    }
    if (typeof SpriteAnimProto.remove === 'function') {
      const origAnimRemove = SpriteAnimProto.remove;
      SpriteAnimProto.remove = function () {
        const cells = this._cellSprites;
        const res = origAnimRemove.apply(this, arguments);
        if (Array.isArray(cells)) {
          for (let i = 0; i < cells.length; i++) {
            const sp = cells[i];
            if (sp && !sp._destroyed && cellPool.length < MAX_CELL_POOL) {
              try { sp.parent?.removeChild?.(sp); } catch { /* ignore */ }
              sp.bitmap = null;
              sp.visible = false;
              cellPool.push(sp);
            }
          }
        }
        return res;
      };
    }
    const prewarmAnimId = (animId: number) => {
      const anim = runtime.$dataAnimations?.[animId];
      const IM = runtime.ImageManager;
      if (!anim || !IM || typeof IM.loadAnimation !== 'function') return;
      if (anim.animation1Name) IM.loadAnimation(anim.animation1Name, anim.animation1Hue || 0);
      if (anim.animation2Name) IM.loadAnimation(anim.animation2Name, anim.animation2Hue || 0);
    };
    const GameTempP = runtime.Game_Temp?.prototype;
    if (GameTempP && typeof GameTempP.requestAnimation === 'function' && !GameTempP.__drAnimPrewarm) {
      GameTempP.__drAnimPrewarm = true;
      const origReqAnim = GameTempP.requestAnimation;
      GameTempP.requestAnimation = function (_targets: any, animationId: number) {
        try { prewarmAnimId(animationId); } catch { /* ignore */ }
        return origReqAnim.apply(this, arguments);
      };
    }
    const GameBattlerP = runtime.Game_Battler?.prototype;
    if (GameBattlerP && typeof GameBattlerP.startAnimation === 'function' && !GameBattlerP.__drAnimPrewarm) {
      GameBattlerP.__drAnimPrewarm = true;
      const origStartAnim = GameBattlerP.startAnimation;
      GameBattlerP.startAnimation = function (animationId: number) {
        try { prewarmAnimId(animationId); } catch { /* ignore */ }
        return origStartAnim.apply(this, arguments);
      };
    }
  }

  // 6e2. Tilemap fast-paths (_sortChildren, resolution-independent toroidal _paintTiles cache,
  //      and MPP_MapLight darkness skip):
  const TilemapProto = runtime.Tilemap?.prototype;
  if (TilemapProto && !TilemapProto.__drFastSort) {
    TilemapProto.__drFastSort = true;
    if (TilemapProto._sortChildren) {
      const compareTilemapChild = (a: any, b: any) => {
        const az = a.z || 0;
        const bz = b.z || 0;
        if (az !== bz) return az - bz;
        const ay = a.y || 0;
        const by = b.y || 0;
        if (ay !== by) return ay - by;
        return (a.spriteId || 0) - (b.spriteId || 0);
      };
      TilemapProto._sortChildren = function () {
        const ch = this.children;
        const len = ch.length;
        if (len <= 1) return;
        let prev = ch[0];
        let pz = prev.z || 0;
        let py = prev.y || 0;
        let ps = prev.spriteId || 0;
        for (let i = 1; i < len; i++) {
          const cur = ch[i];
          const cz = cur.z || 0;
          const cy = cur.y || 0;
          const cs = cur.spriteId || 0;
          if (pz > cz || (pz === cz && (py > cy || (py === cy && ps > cs)))) {
            ch.sort(compareTilemapChild);
            return;
          }
          pz = cz;
          py = cy;
          ps = cs;
        }
      };
    }

    // MPP_MapLight._paintAllDarkness: skip when darknessOpacity === 0
    if (typeof TilemapProto._paintAllDarkness === 'function') {
      const origPaintDarkness = TilemapProto._paintAllDarkness;
      TilemapProto._paintAllDarkness = function (startX: number, startY: number) {
        const op = runtime.$gameMap?.darknessOpacity ?? this._darknessLayer?.opacity ?? 0;
        if (op <= 0) return;
        return origPaintDarkness.call(this, startX, startY);
      };
    }

    // Tag Tilemap's lower/upper canvases and tileset bitmaps with __drSharpTile so Smart AUTO
    // texture filtering uses NEAREST for map tiles (zero dark/bright seam lines in FIT/STRETCH)
    // while keeping smooth BILINEAR filtering for menus, text, portraits, and battles.
    if (typeof TilemapProto._createLayers === 'function') {
      const origCreateLayers = TilemapProto._createLayers;
      TilemapProto._createLayers = function () {
        const res = origCreateLayers.apply(this, arguments);
        if (this._lowerBitmap?._canvas) this._lowerBitmap._canvas.__drSharpTile = true;
        if (this._upperBitmap?._canvas) this._upperBitmap._canvas.__drSharpTile = true;
        return res;
      };
    }
    const ImageManager = runtime.ImageManager;
    if (ImageManager && typeof ImageManager.loadTileset === 'function' && !ImageManager.__drSharpTileset) {
      ImageManager.__drSharpTileset = true;
      const origLoadTileset = ImageManager.loadTileset;
      ImageManager.loadTileset = function (filename: string, hue?: number) {
        const bmp = origLoadTileset.call(this, filename, hue);
        if (bmp && !bmp.__drSharpBound) {
          bmp.__drSharpBound = true;
          const mark = () => {
            if (bmp._image) bmp._image.__drSharpTile = true;
            if (bmp.__canvas) bmp.__canvas.__drSharpTile = true;
          };
          mark();
          if (typeof bmp.addLoadListener === 'function') bmp.addLoadListener(mark);
        }
        return bmp;
      };
    }

    // Resolution-independent toroidal slot cache for Tilemap._paintTiles
    if (typeof TilemapProto.refresh === 'function' && typeof TilemapProto._paintTiles === 'function') {
      const origRefresh = TilemapProto.refresh;
      TilemapProto.refresh = function () {
        this._drSlotGen = (this._drSlotGen || 0) + 1;
        return origRefresh.call(this);
      };
      const origPaintTiles = TilemapProto._paintTiles;
      TilemapProto._paintTiles = function (startX: number, startY: number, x: number, y: number) {
        const tw = this._tileWidth;
        const th = this._tileHeight;
        const lw = this._layerWidth;
        const lh = this._layerHeight;
        if (tw > 0 && th > 0 && lw > 0 && lh > 0 && this._lastTiles?.length > 0) {
          const cols = Math.max(1, (lw / tw) | 0);
          const rows = Math.max(1, (lh / th) | 0);
          const totalSlots = cols * rows;
          const mx = startX + x;
          const my = startY + y;
          const dx = ((mx * tw) % lw + lw) % lw;
          const dy = ((my * th) % lh + lh) % lh;
          const lx = (dx / tw) | 0;
          const ly = (dy / th) | 0;
          if (lx >= 0 && lx < cols && ly >= 0 && ly < rows) {
            const slot = ly * cols + lx;
            const gen = this._drSlotGen || 1;
            if (
              !this._drSlotMx ||
              this._drSlotMxGen !== gen ||
              this._drSlotMx.length !== totalSlots
            ) {
              this._drSlotMx = new Int32Array(totalSlots).fill(0x7fffffff);
              this._drSlotMy = new Int32Array(totalSlots).fill(0x7fffffff);
              this._drSlotMxGen = gen;
            }
            if (this._drSlotMx[slot] === mx && this._drSlotMy[slot] === my) {
              if (!this._frameUpdated) return;
              const tileId0 = this._readMapData(mx, my, 0);
              if (!runtime.Tilemap?.isTileA1?.(tileId0)) return;
            }
            origPaintTiles.call(this, startX, startY, x, y);
            this._drSlotMx[slot] = mx;
            this._drSlotMy[slot] = my;
            return;
          }
        }
        return origPaintTiles.call(this, startX, startY, x, y);
      };
    }
  }

  // 6f. PictureCallCommon + empty Sprite_Picture slot + DTextPicture memoization
  const GamePictureProto = runtime.Game_Picture?.prototype;
  if (GamePictureProto && typeof GamePictureProto.show === 'function' && !GamePictureProto.__drDTextMemo) {
    GamePictureProto.__drDTextMemo = true;
    const origGamePicShow = GamePictureProto.show;
    GamePictureProto.show = function () {
      const res = origGamePicShow.apply(this, arguments);
      // DTextPicture.js sets `this._name = Date.now().toString()` on every showPicture call,
      // forcing Sprite_Picture to allocate a brand-new Canvas2D Bitmap and re-layout text every frame
      // even when HUD strings (e.g. Ruins Seeker's 11 per-frame SetPicStr calls) have not changed!
      // Replacing the timestamp with a deterministic content key eliminates 660 canvas allocations/sec.
      const d = this.dTextInfo;
      if (d && typeof d === 'object') {
        this._name = `__dtext:${d.value ?? ''}|${d.size ?? 0}|${d.align ?? 0}|${d.color ?? ''}|${d.font ?? ''}|${d.windowFrame ? 1 : 0}|${d.lineHeight ?? 0}`;
      }
      return res;
    };
  }
  const SpritePictureProto = runtime.Sprite_Picture?.prototype;
  if (SpritePictureProto?.update && !SpritePictureProto.__drPicTouchFast) {
    SpritePictureProto.__drPicTouchFast = true;
    const origPicUpdate = SpritePictureProto.update;
    SpritePictureProto.update = function () {
      if (!this.picture?.() && !this.bitmap && !this._pictureName && !this._frameWindow) {
        if (this.visible) this.visible = false;
        return;
      }
      return origPicUpdate.call(this);
    };
    if (typeof SpritePictureProto.updateTouch === 'function') {
      const origUpdateTouch = SpritePictureProto.updateTouch;
      SpritePictureProto.updateTouch = function () {
        const gs = runtime.$gameScreen;
        const id = this._pictureId;
        if (gs && id != null && typeof gs.getPictureCid === 'function') {
          const cid = gs.getPictureCid(id);
          const sid = gs.getPictureSid?.(id);
          const pid = gs.getPicturePid?.(id);
          if (!cid && !sid && !pid) return;
        }
        return origUpdateTouch.call(this);
      };
    }
  }
  // PictureSpine.js attaches a Sprite_Spine child to all 100 Sprite_Picture slots; fast-skip idle slots.
  const SpriteSpineProto = runtime.Sprite_Spine?.prototype;
  if (SpriteSpineProto?.update && !SpriteSpineProto.__drIdleSpineSkip) {
    SpriteSpineProto.__drIdleSpineSkip = true;
    const origSpineUpdate = SpriteSpineProto.update;
    SpriteSpineProto.update = function () {
      if (!this._spine && !this._skeleton && !this._data) {
        const pic = runtime.$gameScreen?.picture?.(this._pictureId);
        if (!pic || !pic._spine) return;
      }
      return origSpineUpdate.call(this);
    };
  }
  // Live2D Cubism 4 (`enc_lv2d.js` / `live2dCubism4RuntimeForMV.js`):
  // Stock `CubismRenderer_WebGL` shares ONE `_bufferData` trio across all 50-160 drawables, calling
  // `gl.bufferData(..., DYNAMIC_DRAW)` 3 times per mesh (~165 `VkBuffer` re-allocations/frame in Zink!).
  // Pooling a dedicated `{ vertex, uv, index }` VBO trio per drawable lets `uv` and `index` upload ONCE
  // for the lifetime of the model and updates `vertex` via a single in-place `gl.bufferSubData` per frame.
  const cubismRendererProto = runtime.Live2DCubismFramework?.CubismRenderer_WebGL?.prototype;
  if (cubismRendererProto && typeof cubismRendererProto.drawMesh === 'function' && !cubismRendererProto.__drVboPool) {
    cubismRendererProto.__drVboPool = true;
    const origDrawMesh = cubismRendererProto.drawMesh;
    cubismRendererProto.drawMesh = function (
      texNo: number,
      idxCount: number,
      vertCount: number,
      idxArr: any,
      vertArr: any,
      uvArr: any,
      opacity: number,
      blendMode: number,
      invMask: boolean,
    ) {
      if (uvArr && idxArr && vertArr && typeof uvArr.byteOffset === 'number' && uvArr.byteLength > 0) {
        let pool: Map<number, any> = this.__drMeshVbos;
        if (!pool) {
          pool = new Map<number, any>();
          this.__drMeshVbos = pool;
        }
        const key = uvArr.byteOffset;
        let bd = pool.get(key);
        if (!bd) {
          bd = { vertex: null, uv: null, index: null };
          pool.set(key, bd);
        }
        this._bufferData = bd;
        const res = origDrawMesh.call(this, texNo, idxCount, vertCount, idxArr, vertArr, uvArr, opacity, blendMode, invMask);
        if (bd.uv && !bd.uv.__drImmutableBuf) bd.uv.__drImmutableBuf = true;
        if (bd.index && !bd.index.__drImmutableBuf) bd.index.__drImmutableBuf = true;
        if (bd.vertex && bd.vertex.__drSubDataSize === undefined) {
          bd.vertex.__drSubDataSize = vertArr.byteLength;
        }
        return res;
      }
      return origDrawMesh.apply(this, arguments);
    };
    if (typeof cubismRendererProto.release === 'function') {
      const origCubismRelease = cubismRendererProto.release;
      cubismRendererProto.release = function () {
        const pool: Map<number, any> | undefined = this.__drMeshVbos;
        if (pool && this.gl) {
          pool.forEach((bd) => {
            try {
              if (bd.vertex) this.gl.deleteBuffer?.(bd.vertex);
              if (bd.uv) this.gl.deleteBuffer?.(bd.uv);
              if (bd.index) this.gl.deleteBuffer?.(bd.index);
            } catch { /* ignore */ }
          });
          pool.clear();
        }
        return origCubismRelease.apply(this, arguments);
      };
    }
    if (runtime.LAppPal && typeof runtime.LAppPal.printMessage === 'function') {
      runtime.LAppPal.printMessage = function () {};
    }
    log('[compat] Live2D Cubism 4 per-drawable VBO pool & static UV/index upload skip enabled');
  }
  // Live2D cost breakdown for the [perf] line: time spent in the Cubism Core mesh update, the WebGL
  // renderer, physics and motion each frame. Only wraps methods that exist; costs ~4 timer reads/model/frame.
  const l2dFw = runtime.Live2DCubismFramework;
  if (l2dFw && !l2dFw.__drL2dProf) {
    l2dFw.__drL2dProf = true;
    const stats = { upd: 0, draw: 0, phys: 0, motion: 0, calls: 0 };
    const timeMethod = (proto: any, name: string, key: 'upd' | 'draw' | 'phys' | 'motion') => {
      const orig = proto?.[name];
      if (typeof orig !== 'function' || orig.__drL2dTimed) return false;
      const timed = function (this: any) {
        const t0 = performance.now();
        try {
          return orig.apply(this, arguments);
        } finally {
          stats[key] += performance.now() - t0;
          if (key === 'upd') stats.calls++;
        }
      };
      (timed as any).__drL2dTimed = true;
      proto[name] = timed;
      return true;
    };
    // Cubism Core's per-frame mesh deformation (csmUpdateModel) runs interpreted here (~20 ms per model
    // per frame on Switch 2). In 'half' mode each model deforms on every other presented frame; motion,
    // physics and parameters still advance every frame and the renderer keeps drawing the last mesh, so
    // only the Live2D character animates at half rate. 'auto' switches to half rate once the measured
    // core cost exceeds L2D_AUTO_MS per model and back when it drops well below it.
    const rateMode = options?.live2dUpdateRate ?? 'auto';
    const L2D_AUTO_MS = 6;
    let halfRate = rateMode === 'half';
    let autoSamples = 0;
    let autoSum = 0;
    const modelProto = l2dFw.CubismModel?.prototype;
    if (rateMode !== 'full' && modelProto && typeof modelProto.update === 'function' && !modelProto.__drL2dRate) {
      modelProto.__drL2dRate = true;
      const origModelUpdate = modelProto.update;
      modelProto.update = function (this: any) {
        const frame = runtime.__drRenderFrame | 0;
        // Skip only when this model already deformed on the immediately preceding presented frame;
        // the very first update and repeated calls within one frame always run.
        if (halfRate && this.__drL2dUpdated && frame - (this.__drL2dFrame | 0) === 1) {
          return undefined;
        }
        const t0 = performance.now();
        const res = origModelUpdate.apply(this, arguments);
        const dt = performance.now() - t0;
        this.__drL2dUpdated = true;
        this.__drL2dFrame = frame;
        if (rateMode === 'auto') {
          autoSum += dt;
          if (++autoSamples >= 30) {
            const avg = autoSum / autoSamples;
            const next = halfRate ? avg > L2D_AUTO_MS / 2 : avg > L2D_AUTO_MS;
            if (next !== halfRate) {
              halfRate = next;
              log(`[compat] Live2D core update -> ${halfRate ? 'half' : 'full'} rate (avg ${avg.toFixed(1)}ms/model)`);
            }
            autoSamples = 0;
            autoSum = 0;
          }
        }
        return res;
      };
    }
    const hooked = [
      timeMethod(l2dFw.CubismModel?.prototype, 'update', 'upd') && 'update',
      (timeMethod(l2dFw.CubismRenderer_WebGL?.prototype, 'doDrawModel', 'draw') ||
        timeMethod(l2dFw.CubismRenderer?.prototype, 'drawModel', 'draw')) && 'draw',
      timeMethod(l2dFw.CubismPhysics?.prototype, 'evaluate', 'phys') && 'physics',
      (timeMethod(l2dFw.CubismMotionManager?.prototype, 'updateMotion', 'motion') ||
        timeMethod(l2dFw.CubismMotionQueueManager?.prototype, 'doUpdateMotion', 'motion')) && 'motion',
    ].filter(Boolean);
    if (hooked.length) {
      runtime.__drTakeL2dStats = () => {
        const out = { ...stats };
        stats.upd = 0; stats.draw = 0; stats.phys = 0; stats.motion = 0; stats.calls = 0;
        return out;
      };
      log(`[compat] Live2D profiler armed (${hooked.join(', ')})`);
    }
  }
  // In Canvas2D mode, PIXI CanvasRenderer ignores WebGL `.filters` completely, yet FilterController.js
  // still instantiates PIXI.Filter objects + Displacement sprites and runs filter handlers every frame.
  if (!isWebGLMode) {
    for (const scName of ['Scene_Map', 'Scene_Battle'] as const) {
      const scP = runtime[scName]?.prototype;
      if (scP && typeof scP.updateTKMfilters === 'function' && !scP.__drSkipCanvasFilters) {
        scP.__drSkipCanvasFilters = true;
        scP.updateTKMfilters = function () {};
      }
    }
  }

  // 6f2. Window_Base dimmer gradient memoization (universal + BB_WindowSelector3 compatible)
  const WindowBaseProto = runtime.Window_Base?.prototype;
  if (WindowBaseProto?.refreshDimmerBitmap && !WindowBaseProto.__drDimmerMemo) {
    WindowBaseProto.__drDimmerMemo = true;
    const origRefreshDimmer = WindowBaseProto.refreshDimmerBitmap;
    WindowBaseProto.refreshDimmerBitmap = function () {
      if (!this._dimmerSprite) return;
      const c1 = typeof this.dimColor1 === 'function' ? this.dimColor1() : '';
      const c2 = typeof this.dimColor2 === 'function' ? this.dimColor2() : '';
      const v99 = runtime.$gameVariables ? runtime.$gameVariables.value(99) : 0;
      const key = `${this.width}|${this.height}|${this.padding}|${c1}|${c2}|${v99}`;
      if (this._drDimmerKey === key && this._dimmerSprite.bitmap?.width === this.width) {
        return;
      }
      this._drDimmerKey = key;
      return origRefreshDimmer.call(this);
    };
  }

  // 6f2b. No-op guard on Window.prototype.width/height setters + LL_VariableWindowMV memoization
  //       + YEP_EventMiniLabel empty-window hiding + PixiJS v5 transparent Window FBO skip.
  //       1. LL_VariableWindowMV assigns `this.width = 0; this.height = 0;` every frame on 4 windows (~12.5ms/tick).
  //       2. YEP_EventMiniLabel creates a Window_EventMiniLabel for EVERY character on the map (e.g. 93 in Ambrosia)
  //          with `visible=true, opacity=0, contentsOpacity=0, _text=''`. In PixiJS v5 MV, every Window attaches an
  //          AlphaFilter FBO pass -> 93 invisible FBO swaps & 250+ wasted draw calls/frame (15 FPS -> 60 FPS!).
  const WindowProto = runtime.Window?.prototype;
  if (WindowProto && !WindowProto.__drNoopSizeGuard) {
    WindowProto.__drNoopSizeGuard = true;
    for (const [prop, priv] of [['width', '_width'], ['height', '_height']] as const) {
      const desc = Object.getOwnPropertyDescriptor(WindowProto, prop);
      if (desc && desc.configurable && typeof desc.set === 'function' && typeof desc.get === 'function') {
        const origGet = desc.get;
        const origSet = desc.set;
        Object.defineProperty(WindowProto, prop, {
          configurable: true,
          get: origGet,
          set(value: number) {
            if (this[priv] === value && this[`__drInit_${prop}`]) return;
            this[`__drInit_${prop}`] = true;
            origSet.call(this, value);
          },
        });
      }
    }
    // Skip PixiJS v5 AlphaFilter FBO render passes on completely transparent MV windows (opacity=0 & contentsOpacity=0)
    if (isWebGLMode && typeof WindowProto.render === 'function' && !WindowProto.__drEmptyWinSkip) {
      WindowProto.__drEmptyWinSkip = true;
      const origWinRender = WindowProto.render;
      WindowProto.render = function (renderer: any) {
        if (
          this._isWindow &&
          (this._openness <= 0 ||
            (this.opacity <= 0 &&
              this.contentsOpacity <= 0 &&
              (!this._windowPauseSignSprite || !this._windowPauseSignSprite.visible) &&
              (!this._upArrowSprite || !this._upArrowSprite.visible) &&
              (!this._downArrowSprite || !this._downArrowSprite.visible) &&
              (!this._dimmerSprite || !this._dimmerSprite.visible)))
        ) {
          return;
        }
        return origWinRender.call(this, renderer);
      };
    }
  }
  const EventMiniLabelProto = runtime.Window_EventMiniLabel?.prototype;
  if (EventMiniLabelProto && !EventMiniLabelProto.__drEmptyHide) {
    EventMiniLabelProto.__drEmptyHide = true;
    if (typeof EventMiniLabelProto.initialize === 'function') {
      const origInit = EventMiniLabelProto.initialize;
      EventMiniLabelProto.initialize = function () {
        const res = origInit.apply(this, arguments);
        this.visible = false;
        return res;
      };
    }
    if (typeof EventMiniLabelProto.update === 'function') {
      const origUpd = EventMiniLabelProto.update;
      EventMiniLabelProto.update = function () {
        // Fast-skip invisible empty mini-labels when character page hasn't changed
        // (avoids running Window_Base.update on 90+ empty label windows every frame).
        const ch = this._character;
        if (!this._text && !this.visible && ch && (!ch._eventId || this._pageIndex === ch._pageIndex)) {
          return;
        }
        const res = origUpd.apply(this, arguments);
        if (!this._text && this.visible) {
          this.visible = false;
        }
        return res;
      };
    }
    // Skip allocating Window_EventMiniLabel + Bitmap + 9-slice Windowskin on characters/events
    // that have NO <MINI LABEL> / <MINI WINDOW> comment tag on any page (saves ~600ms on
    // menu-close & room transfers in games like Ambrosia with 75-100 events per map!).
    const SpCharEmlProto = runtime.Sprite_Character?.prototype;
    if (SpCharEmlProto && typeof SpCharEmlProto.setupMiniLabel === 'function' && !SpCharEmlProto.__drLazyMiniLabel) {
      SpCharEmlProto.__drLazyMiniLabel = true;
      const origSetupML = SpCharEmlProto.setupMiniLabel;
      const MINI_TAG_RE = /<(?:ALWAYS SHOW )?MINI (?:WINDOW|LABEL)/i;
      const eventMayHaveMiniLabel = (ch: any): boolean => {
        if (!ch || !ch._eventId) return false;
        const evData = typeof ch.event === 'function' ? ch.event() : null;
        if (!evData || !Array.isArray(evData.pages)) return true;
        if (typeof evData.__drHasMiniLabel === 'boolean') return evData.__drHasMiniLabel;
        let found = false;
        for (let p = 0; p < evData.pages.length && !found; p++) {
          const list = evData.pages[p]?.list;
          if (!Array.isArray(list)) continue;
          for (let i = 0; i < list.length; i++) {
            const cmd = list[i];
            if (cmd && (cmd.code === 108 || cmd.code === 408) && MINI_TAG_RE.test(String(cmd.parameters?.[0] ?? ''))) {
              found = true;
              break;
            }
          }
        }
        evData.__drHasMiniLabel = found;
        return found;
      };
      SpCharEmlProto.setupMiniLabel = function () {
        if (this._miniLabel || this._drNoMiniLabel) return;
        if (!eventMayHaveMiniLabel(this._character)) {
          this._drNoMiniLabel = true;
          return;
        }
        return origSetupML.call(this);
      };
    }
    log('[compat] YEP_EventMiniLabel lazy allocation & empty-window visibility culling enabled');
  }
  const ExVarWinProto = runtime.Window_ExVariableWindow?.prototype;
  if (ExVarWinProto?.refresh && !ExVarWinProto.__drVarWinMemo) {
    ExVarWinProto.__drVarWinMemo = true;
    const origExVarRefresh = ExVarWinProto.refresh;
    ExVarWinProto.refresh = function () {
      const varId = typeof this.getVariableId === 'function' ? this.getVariableId() : null;
      const val = varId ? runtime.$gameVariables?.value?.(varId) : null;
      const key = varId
        ? `${varId}|${val}|${this.getX?.()}|${this.getY?.()}|${this.windowWidth?.()}`
        : 'hidden';
      if (this._drVarWinKey === key) return;
      this._drVarWinKey = key;
      return origExVarRefresh.call(this);
    };
  }

  // 6f2c. Closed/idle message & sub-window fast-skip (slashes ~3-4ms/tick on games using
  //       FTKR_ExMessageWindow2 which instantiates 25 extra Window_MessageEx + 100 sub-windows
  //       that all remain closed on Scene_Map while running 6+ plugin update chains every tick).
  const WinMsgProto = runtime.Window_Message?.prototype;
  if (WinMsgProto?.update && !WinMsgProto.__drIdleExSkip) {
    WinMsgProto.__drIdleExSkip = true;
    const origMsgUpdate = WinMsgProto.update;
    WinMsgProto.update = function () {
      if (
        this._windowId > 0 &&
        this._openness === 0 &&
        !this._opening &&
        !this._closing &&
        !this.pause &&
        !this._textState &&
        !this._dimmerSprite?.visible
      ) {
        const msg = this._gameMessage;
        if (
          msg &&
          !msg._finishDisp &&
          !msg._terminate &&
          (typeof msg.isBusy === 'function' ? !msg.isBusy() : !msg._texts?.length) &&
          !this.isAnySubWindowActive?.()
        ) {
          return;
        }
      }
      return origMsgUpdate.call(this);
    };
  }
  for (const [winClassName, ignoreActive] of [
    ['Window_ChoiceList', false],
    ['Window_NumberInput', false],
    ['Window_EventItem', false],
    ['Window_NameBox', true],
    ['Window_Gold', true],
  ] as const) {
    const proto = runtime[winClassName]?.prototype;
    if (proto?.update && !proto.__drClosedSubSkip) {
      proto.__drClosedSubSkip = true;
      const origSubUpdate = proto.update;
      proto.update = function () {
        // Window_Base initializes `active = true` (unlike Window_Selectable), so display-only
        // sub-windows like Window_Gold / Window_NameBox still have `active === true` when closed!
        if (
          this._openness === 0 &&
          !this._opening &&
          !this._closing &&
          (ignoreActive || !this.active) &&
          !this._dimmerSprite?.visible
        ) {
          return;
        }
        return origSubUpdate.call(this);
      };
    }
  }

  // 6f2d. Defer _refreshAllParts() on closed FTKR_ExMessageWindow2 extra windows (_windowId > 0)
  //       so closing Scene_Menu doesn't synchronously build 150 unused Windowskin 9-slice canvases
  //       (~300ms saved on every menu close in Nightmare Knight!). Refreshes automatically on open.
  const WinMsgExProto = runtime.Window_MessageEx?.prototype;
  if (WinMsgExProto && WindowProto && typeof WindowProto._refreshAllParts === 'function' && !WindowProto.__drDeferExParts) {
    WindowProto.__drDeferExParts = true;
    const origRefreshParts = WindowProto._refreshAllParts;
    WindowProto._refreshAllParts = function () {
      if (this._windowId > 0 && this._openness === 0 && !this._opening) {
        this._drPartsDirty = true;
        return;
      }
      this._drPartsDirty = false;
      return origRefreshParts.call(this);
    };
    const openDesc = Object.getOwnPropertyDescriptor(WindowProto, 'openness');
    if (openDesc && openDesc.configurable && typeof openDesc.set === 'function' && typeof openDesc.get === 'function') {
      const origOpenGet = openDesc.get;
      const origOpenSet = openDesc.set;
      Object.defineProperty(WindowProto, 'openness', {
        configurable: true,
        get: origOpenGet,
        set(value: number) {
          origOpenSet.call(this, value);
          if (this._drPartsDirty && this._openness > 0) {
            this._drPartsDirty = false;
            origRefreshParts.call(this);
          }
        },
      });
    }
    if (typeof WinMsgExProto.createSubWindows === 'function' && !WinMsgExProto.__drTagGoldId) {
      WinMsgExProto.__drTagGoldId = true;
      const origCreateSub = WinMsgExProto.createSubWindows;
      WinMsgExProto.createSubWindows = function () {
        const res = origCreateSub.call(this);
        if (this._goldWindow && this._windowId > 0) {
          this._goldWindow._windowId = this._windowId;
        }
        return res;
      };
    }
  }

  // 6f2e. Defer window chrome (back / frame / cursor 9-slice bitmaps) for ALL windows until the window is
  //       first drawn while open. Windows are constructed fully open (openness 255), so every
  //       move()/padding/windowskin-load during construction rebuilt 3 canvases with ~20 blits even for
  //       windows that are closed right after and may never open (e.g. 26 FTKR extra message windows +
  //       their gold/choice/number/item sub-windows: ~2s on every Nightmare Knight map load).
  if (
    WindowProto && typeof WindowProto._refreshAllParts === 'function' &&
    typeof WindowProto.updateTransform === 'function' && !WindowProto.__drLazyChrome
  ) {
    WindowProto.__drLazyChrome = true;
    const innerAll = WindowProto._refreshAllParts;
    const gate = (name: string) => {
      const inner = WindowProto[name];
      if (typeof inner !== 'function') return;
      WindowProto[name] = function () {
        if (!this.__drChromeLive) {
          this.__drChromeDeferred = true;
          return;
        }
        return inner.apply(this, arguments);
      };
    };
    gate('_refreshAllParts');
    gate('_refreshBack');
    gate('_refreshFrame');
    gate('_refreshCursor');
    const goLive = (win: any) => {
      win.__drChromeLive = true;
      if (win.__drChromeDeferred) {
        win.__drChromeDeferred = false;
        innerAll.call(win);
      }
    };
    const origWinUT = WindowProto.updateTransform;
    WindowProto.updateTransform = function () {
      if (!this.__drChromeLive) {
        const op = typeof this._openness === 'number' ? this._openness : this.openness;
        if (op > 0) goLive(this);
      }
      return origWinUT.apply(this, arguments);
    };
    // Anything that inspects the chrome sprites directly forces the real refresh first.
    WindowProto.__drEnsureChrome = function () {
      if (!this.__drChromeLive) goLive(this);
    };
  }

  // 6f3c. Quick Menu "Log On-Screen Objects": every visible display object covering at least ~1% of the
  //       screen, with class, bounds, alpha, blend mode, image source and (for canvas bitmaps) the
  //       pixel at the bitmap centre, so rendering glitches can be traced to the object that causes them.
  runtime.__drDumpScene = () => {
    const scene = SceneManager?._scene;
    if (!scene) {
      log('[dump] no active scene');
      return;
    }
    const lines: string[] = [];
    const MIN_AREA = 8000;
    const MAX_LINES = 150;
    const describeBitmap = (bmp: any): string => {
      if (!bmp) return '';
      const url = String(bmp._url || bmp.url || bmp._image?.src || '');
      const name = url ? url.split('/').pop() : `canvas${bmp.width}x${bmp.height}`;
      let px = '';
      try {
        const ctx = bmp._context;
        if (!url && ctx && bmp.width > 0 && bmp.height > 0) {
          const d = ctx.getImageData(bmp.width >> 1, bmp.height >> 1, 1, 1).data;
          px = ` mid=${d[0]},${d[1]},${d[2]},${d[3]}`;
        }
      } catch { /* ignore */ }
      const premul = bmp.baseTexture?.premultipliedAlpha;
      return ` img=${name}${px}${premul === false ? ' premul=false' : ''}`;
    };
    const walk = (obj: any, depth: number) => {
      if (!obj || lines.length >= MAX_LINES || !obj.visible || obj.worldAlpha <= 0) return;
      let b: any = null;
      try { b = obj.getBounds?.(); } catch { /* ignore */ }
      const area = b ? Math.max(0, b.width) * Math.max(0, b.height) : 0;
      if (area >= MIN_AREA && obj.renderable !== false) {
        const cls = obj.constructor?.name || 'Object';
        let extra = '';
        if (typeof obj.backOpacity === 'number') {
          const skin = obj._windowskin || obj.windowskin;
          const skinName = String(skin?._url || '').split('/').pop();
          extra += ` win[skin=${skinName} op=${obj.opacity} back=${obj.backOpacity} contents=${obj.contentsOpacity} open=${obj.openness}]`;
        }
        if (obj.bitmap) extra += describeBitmap(obj.bitmap);
        if (obj.filters?.length) extra += ` filters=${obj.filters.map((f: any) => f?.constructor?.name).join('+')}`;
        if (obj.blendMode) extra += ` blend=${obj.blendMode}`;
        if (obj.tint !== undefined && obj.tint !== 0xffffff) extra += ` tint=${Number(obj.tint).toString(16)}`;
        lines.push(
          `${' '.repeat(Math.min(depth, 12))}${cls} [${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}] ` +
          `a=${Number(obj.alpha).toFixed(2)} wa=${Number(obj.worldAlpha).toFixed(2)}${extra}`,
        );
      }
      const kids = obj.children;
      if (Array.isArray(kids)) for (const k of kids) walk(k, depth + 1);
    };
    walk(scene, 0);
    log(`[dump] scene=${scene.constructor?.name} (${lines.length} large visible objects)\n${lines.join('\n')}`);
  };

  // 6f4. No-op setValue guard + dependency-indexed selective Game_Map.refresh()
  //      Eliminates massive per-frame 150+ event refresh storms when parallel events write
  //      timer / coordinate variables every frame (e.g. Fear & Hunger, lighting/HUD scripts).
  const GameSwitchesProto = runtime.Game_Switches?.prototype;
  const GameVariablesProto = runtime.Game_Variables?.prototype;
  const GameSelfSwitchesProto = runtime.Game_SelfSwitches?.prototype;
  const GameMapRefreshProto = runtime.Game_Map?.prototype;
  const GameEventProto = runtime.Game_Event?.prototype;

  if (
    GameMapRefreshProto?.refresh &&
    GameMapRefreshProto?.requestRefresh &&
    GameEventProto?.meetsConditions &&
    !GameMapRefreshProto.__drSelectiveRefresh
  ) {
    GameMapRefreshProto.__drSelectiveRefresh = true;
    const dirtyVars = new Set<number>();
    const dirtySwitches = new Set<number>();
    const dirtySelfEvents = new Set<number>();
    let dirtyAll = true;
    let inTrackedSetValue = false;

    // Detect if meetsConditions is stock RPG Maker MV (only checks switch1/switch2/variable/selfSwitch/item/actor)
    const meetsSrc = String(GameEventProto.meetsConditions);
    const isStockMeetsConditions =
      meetsSrc.includes('switch1Valid') &&
      meetsSrc.includes('variableValid') &&
      meetsSrc.length < 1100;

    const origRequestRefresh = GameMapRefreshProto.requestRefresh;
    GameMapRefreshProto.requestRefresh = function () {
      if (!inTrackedSetValue) dirtyAll = true;
      return origRequestRefresh.call(this);
    };

    if (GameSwitchesProto?.setValue && !GameSwitchesProto.__drNoopGuard) {
      GameSwitchesProto.__drNoopGuard = true;
      const origSwSet = GameSwitchesProto.setValue;
      GameSwitchesProto.setValue = function (switchId: number, value: any) {
        const ds = runtime.$dataSystem;
        if (ds?.switches && switchId > 0 && switchId < ds.switches.length) {
          const next = Boolean(value);
          if (Boolean(this._data[switchId]) === next) return;
          dirtySwitches.add(switchId);
          inTrackedSetValue = true;
          try {
            return origSwSet.call(this, switchId, value);
          } finally {
            inTrackedSetValue = false;
          }
        }
        return origSwSet.call(this, switchId, value);
      };
    }

    if (GameVariablesProto?.setValue && !GameVariablesProto.__drNoopGuard) {
      GameVariablesProto.__drNoopGuard = true;
      const origVarSet = GameVariablesProto.setValue;
      // Only floor numbers when setValue is stock MV (preserves fractional floats for FloatVariables.js / FilterController.js)
      const varSetSrc = String(origVarSet);
      const isStockIntVarSet = varSetSrc.includes('Math.floor') && varSetSrc.length < 260;
      GameVariablesProto.setValue = function (variableId: number, value: any) {
        const ds = runtime.$dataSystem;
        if (ds?.variables && variableId > 0 && variableId < ds.variables.length) {
          const norm = isStockIntVarSet && typeof value === 'number' ? Math.floor(value) : value;
          const prev = this._data[variableId];
          if (prev === norm || (prev === undefined && norm === 0)) return;
          dirtyVars.add(variableId);
          inTrackedSetValue = true;
          try {
            return origVarSet.call(this, variableId, value);
          } finally {
            inTrackedSetValue = false;
          }
        }
        return origVarSet.call(this, variableId, value);
      };
    }

    if (GameSelfSwitchesProto?.setValue && !GameSelfSwitchesProto.__drNoopGuard) {
      GameSelfSwitchesProto.__drNoopGuard = true;
      const origSelfSet = GameSelfSwitchesProto.setValue;
      GameSelfSwitchesProto.setValue = function (key: any, value: any) {
        const next = Boolean(value);
        if (Boolean(this._data[key]) === next) return;
        if (Array.isArray(key) && key.length >= 2) {
          dirtySelfEvents.add(Number(key[1]));
        } else {
          dirtyAll = true;
        }
        inTrackedSetValue = true;
        try {
          return origSelfSet.call(this, key, value);
        } finally {
          inTrackedSetValue = false;
        }
      };
    }

    // Build per-map dependency index (switchId -> events[], variableId -> events[])
    const buildMapDeps = (gm: any) => {
      const bySwitch = new Map<number, any[]>();
      const byVar = new Map<number, any[]>();
      const byEventId = new Map<number, any>();
      const events = gm.events?.() ?? [];
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev) continue;
        byEventId.set(ev._eventId, ev);
        const dataEv = ev.event?.();
        const pages = dataEv?.pages;
        if (!Array.isArray(pages)) continue;
        const swSeen = new Set<number>();
        const varSeen = new Set<number>();
        for (let p = 0; p < pages.length; p++) {
          const c = pages[p]?.conditions;
          if (!c) continue;
          if (c.switch1Valid && c.switch1Id > 0) swSeen.add(c.switch1Id);
          if (c.switch2Valid && c.switch2Id > 0) swSeen.add(c.switch2Id);
          if (c.variableValid && c.variableId > 0) varSeen.add(c.variableId);
        }
        for (const swId of swSeen) {
          let list = bySwitch.get(swId);
          if (!list) { list = []; bySwitch.set(swId, list); }
          list.push(ev);
        }
        for (const vId of varSeen) {
          let list = byVar.get(vId);
          if (!list) { list = []; byVar.set(vId, list); }
          list.push(ev);
        }
      }
      gm._drDepMapId = gm._mapId;
      gm._drDepCount = events.length;
      gm._drDepBySwitch = bySwitch;
      gm._drDepByVar = byVar;
      gm._drDepByEventId = byEventId;
    };

    if (typeof GameMapRefreshProto.setupEvents === 'function') {
      const origSetupEvents = GameMapRefreshProto.setupEvents;
      GameMapRefreshProto.setupEvents = function () {
        dirtyAll = true;
        const res = origSetupEvents.apply(this, arguments);
        this._drDepMapId = -1;
        return res;
      };
    }

    const origRefresh = GameMapRefreshProto.refresh;
    GameMapRefreshProto.refresh = function () {
      if (!isStockMeetsConditions || dirtyAll || this._drDepMapId !== this._mapId || this._drDepCount !== (this.events?.()?.length ?? 0)) {
        dirtyAll = false;
        dirtyVars.clear();
        dirtySwitches.clear();
        dirtySelfEvents.clear();
        if (isStockMeetsConditions) buildMapDeps(this);
        return origRefresh.call(this);
      }

      // Selective refresh: only re-evaluate events that actually depend on changed vars/switches!
      const toRefresh = new Set<any>();
      const bySwitch: Map<number, any[]> = this._drDepBySwitch;
      const byVar: Map<number, any[]> = this._drDepByVar;
      const byEventId: Map<number, any> = this._drDepByEventId;

      for (const swId of dirtySwitches) {
        const list = bySwitch?.get(swId);
        if (list) for (let i = 0; i < list.length; i++) toRefresh.add(list[i]);
      }
      for (const vId of dirtyVars) {
        const list = byVar?.get(vId);
        if (list) for (let i = 0; i < list.length; i++) toRefresh.add(list[i]);
      }
      for (const evId of dirtySelfEvents) {
        const ev = byEventId?.get(evId);
        if (ev) toRefresh.add(ev);
      }

      let anyPageChanged = false;
      for (const ev of toRefresh) {
        const before = ev._pageIndex;
        ev.refresh();
        if (ev._pageIndex !== before) anyPageChanged = true;
      }

      if (dirtySwitches.size > 0 && Array.isArray(this._commonEvents)) {
        for (let i = 0; i < this._commonEvents.length; i++) {
          const ce = this._commonEvents[i];
          const swId = ce?.event?.()?.switchId;
          if (!swId || dirtySwitches.has(swId)) {
            ce.refresh();
          }
        }
      }

      if (anyPageChanged) {
        this.refreshTileEvents();
        if (typeof this.createNavGrid === 'function') {
          this.createNavGrid();
        }
      }
      this._needsRefresh = false;
      dirtyVars.clear();
      dirtySwitches.clear();
      dirtySelfEvents.clear();
    };
  }

  // 6f4b. Lightmask (TerraxLighting / Community_Lighting) half-resolution + redraw throttle:
  //       Many lighting plugins declare `function Lightmask()` inside an IIFE (not on window),
  //       attaching the instance as `spriteset._lightmask` (or child of Spriteset_Map).
  //       1. Render `_maskBitmap` at 0.5x resolution (4x fewer CPU radial-gradient pixels & 4x
  //          smaller texture upload) and let the GPU upscale it smoothly with bilinear filtering.
  //       2. Throttle CPU lightmask redraws to 30Hz while moving and 15Hz while stationary.
  let lightmaskMs = 0;
  let lightmaskHookedName = '';
  const downscaleLightmaskBitmap = (lm: any): boolean => {
    const bmp = lm?._maskBitmap;
    const canvas = bmp?._canvas;
    const ctx = bmp?._context;
    if (!bmp || !canvas || !ctx) return false;
    if (bmp.__drHalfRes) return true;
    const origW = canvas.width | 0;
    const origH = canvas.height | 0;
    if (origW < 400 || origH < 300) return false;

    const halfW = Math.ceil(origW / 2);
    const halfH = Math.ceil(origH / 2);
    const sx = halfW / origW;
    const sy = halfH / origH;
    const invSx = origW / halfW;
    const invSy = origH / halfH;

    canvas.width = halfW;
    canvas.height = halfH;
    canvas.__drSharpTile = false;
    try {
      if (bmp._baseTexture) {
        bmp._baseTexture.realWidth = halfW;
        bmp._baseTexture.realHeight = halfH;
        bmp._baseTexture.width = halfW;
        bmp._baseTexture.height = halfH;
        bmp._baseTexture.update?.();
      }
    } catch { /* ignore */ }

    // Keep logical width/height at full game size so TerraxLighting math stays 100% unchanged,
    // except while Sprite._refresh reads physical baseTexture bounds (usePhysical=true).
    const hrInfo = { sx, sy, invSx, invSy, halfW, halfH, origW, origH, usePhysical: false };
    try {
      Object.defineProperty(bmp, 'width', {
        configurable: true,
        get: () => (hrInfo.usePhysical ? halfW : origW),
      });
      Object.defineProperty(bmp, 'height', {
        configurable: true,
        get: () => (hrInfo.usePhysical ? halfH : origH),
      });
    } catch { /* ignore */ }

    bmp.__drHalfRes = hrInfo;
    log(`[compat] Lightmask half-res GPU upscale enabled (${origW}x${origH} -> ${halfW}x${halfH}, 4x fewer pixels)`);
    return true;
  };

  // Ensure any Sprite bound to a half-res Lightmask bitmap (including sprites created dynamically
  // via Lightmask._addSprite mid-_updateMask!) always uses physical (halfW x halfH) texture frame
  // and applies the 2x GPU upscale cleanly without throwing PIXI Texture frame bounds errors.
  if (SpriteProto?._refresh && !SpriteProto.__drHalfResRefresh) {
    SpriteProto.__drHalfResRefresh = true;
    const origSpriteRefresh = SpriteProto._refresh;
    SpriteProto._refresh = function () {
      const hr = this._bitmap?.__drHalfRes;
      if (hr) {
        if (this._frame) {
          if (this._frame.width > hr.halfW) this._frame.width = hr.halfW;
          if (this._frame.height > hr.halfH) this._frame.height = hr.halfH;
        }
        hr.usePhysical = true;
        try {
          const res = origSpriteRefresh.call(this);
          if (this.scale) {
            this.scale.x = hr.invSx;
            this.scale.y = hr.invSy;
          }
          return res;
        } finally {
          hr.usePhysical = false;
        }
      }
      return origSpriteRefresh.call(this);
    };
  }

  const syncLightmaskSpriteScale = (lm: any) => {
    const info = lm?._maskBitmap?.__drHalfRes;
    if (!info) return;
    const applyScale = (sp: any) => {
      if (!sp || !sp.scale) return;
      if (sp.bitmap === lm._maskBitmap) {
        if (typeof sp.setFrame === 'function') {
          if (sp._frame?.width !== info.halfW || sp._frame?.height !== info.halfH) {
            sp.setFrame(0, 0, info.halfW, info.halfH);
          }
        } else if (sp.texture?.frame) {
          sp.texture.frame.width = info.halfW;
          sp.texture.frame.height = info.halfH;
        }
        sp.scale.x = info.invSx;
        sp.scale.y = info.invSy;
      }
    };
    if (Array.isArray(lm._sprites)) {
      for (let i = 0; i < lm._sprites.length; i++) applyScale(lm._sprites[i]);
    }
    if (Array.isArray(lm.children)) {
      for (let i = 0; i < lm.children.length; i++) applyScale(lm.children[i]);
    }
  };

  const patchLightmaskObject = (lm: any, sourceTag: string) => {
    if (!lm || lm.__drFastMask) return;
    const proto = Object.getPrototypeOf(lm);
    const target = proto && typeof proto._updateMask === 'function' ? proto : lm;
    if (typeof target._updateMask !== 'function' || target.__drFastMask) return;
    target.__drFastMask = true;
    lm.__drFastMask = true;
    lightmaskHookedName = sourceTag;
    const origUpdateMask = target._updateMask;
    target._updateMask = function () {
      downscaleLightmaskBitmap(this);
      syncLightmaskSpriteScale(this);
      const gm = runtime.$gameMap;
      const gp = runtime.$gamePlayer;
      const dx = gm?._displayX ?? 0;
      const dy = gm?._displayY ?? 0;
      const px = gp?._realX ?? 0;
      const py = gp?._realY ?? 0;
      const moved = dx !== this._drLmDX || dy !== this._drLmDY || px !== this._drLmPX || py !== this._drLmPY;
      const fc = Graphics?.frameCount || 0;
      const interval = moved ? 2 : 4;
      if (this._drLmReady && (fc % interval) !== 0) {
        return;
      }
      this._drLmDX = dx;
      this._drLmDY = dy;
      this._drLmPX = px;
      this._drLmPY = py;
      this._drLmReady = true;

      const info = this._maskBitmap?.__drHalfRes;
      const ctx = this._maskBitmap?._context;
      if (info && ctx) {
        ctx.setTransform(info.sx, 0, 0, info.sy, 0, 0);
      }
      const t0 = performance.now();
      const res = origUpdateMask.apply(this, arguments);
      lightmaskMs += performance.now() - t0;
      if (info && ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      syncLightmaskSpriteScale(this);
      return res;
    };
    log(`[compat] Lightmask fast-path attached via ${sourceTag}`);
  };
  if (runtime.Lightmask?.prototype) {
    patchLightmaskObject(runtime.Lightmask.prototype, 'window.Lightmask');
  }

  // Support `liply_MobileLight.js` (e.g. Noel The Mortal Fate): attaches `spriteset._lightMask = new Sprite(maskBitmap)`
  // with `blendMode = BLEND_MULTIPLY (2)` and redraws CPU `createRadialGradient` on a full-screen 1120x630 canvas
  // inside `Scene_Map.prototype.update` whenever `Graphics._skipCount === 0` (~24ms/tick -> ~48ms/frame at 2 ticks/f!).
  // Downscales `maskBitmap` to 0.5x resolution (2x GPU bilinear upscale) and caches each `(r0, r1, c0, c1)` radial
  // gradient on a tiny offscreen canvas so per-frame lights use fast SIMD `drawImage` blits (<0.3ms/frame).
  const radialSpriteCache = new Map<string, any>();
  const patchLiplyLightMaskSprite = (sp: any) => {
    const bmp = sp?.bitmap;
    const canvas = bmp?._canvas || bmp?.canvas;
    const ctx = bmp?._context;
    if (!sp || !bmp || !canvas || !ctx || sp.blendMode !== 2) return;
    if (!sp.__drLiplyFast) {
      sp.__drLiplyFast = true;
      lightmaskHookedName = 'spriteset._lightMask';
    }
    if (!bmp.__drHalfRes) {
      downscaleLightmaskBitmap({ _maskBitmap: bmp });
    }
    const info = bmp.__drHalfRes;
    if (info) {
      if (typeof sp.setFrame === 'function') {
        if (sp._frame?.width !== info.halfW || sp._frame?.height !== info.halfH) {
          sp.setFrame(0, 0, info.halfW, info.halfH);
        }
      }
      if (sp.scale) {
        sp.scale.x = info.invSx;
        sp.scale.y = info.invSy;
      }
    }
    if (!canvas.__drLiplyCtxHooked && typeof canvas.getContext === 'function') {
      canvas.__drLiplyCtxHooked = true;
      const origGetCtx = canvas.getContext;
      canvas.getContext = function (type: string, ...args: any[]) {
        const c = origGetCtx.call(this, type, ...args);
        if (type === '2d' && c && bmp.__drHalfRes) {
          const hr = bmp.__drHalfRes;
          // Set 0.5x base transform BEFORE liply_MobileLight calls `context.save()` in `initCanvas()`
          c.setTransform?.(hr.sx, 0, 0, hr.sy, 0, 0);
        }
        return c;
      };
    }
    if (!ctx.__drLiplyGradCache && typeof ctx.createRadialGradient === 'function' && typeof ctx.fillRect === 'function' && typeof ctx.drawImage === 'function') {
      let proto = Object.getPrototypeOf(ctx);
      let fillDesc: PropertyDescriptor | undefined;
      while (proto && !fillDesc) {
        fillDesc = Object.getOwnPropertyDescriptor(proto, 'fillStyle');
        proto = Object.getPrototypeOf(proto);
      }
      if (fillDesc && typeof fillDesc.set === 'function' && typeof fillDesc.get === 'function') {
        ctx.__drLiplyGradCache = true;
        const origFillSet = fillDesc.set;
        const origFillGet = fillDesc.get;
        const origCreateRG = ctx.createRadialGradient;
        const origFillRect = ctx.fillRect;
        const origDrawImage = ctx.drawImage;
        let pendingRad: any = null;
        try {
          Object.defineProperty(ctx, 'fillStyle', {
            configurable: true,
            get() { return pendingRad || origFillGet.call(this); },
            set(v: any) {
              if (v && v.__drRad) {
                pendingRad = v;
              } else {
                pendingRad = null;
                origFillSet.call(this, v);
              }
            },
          });
          ctx.createRadialGradient = function (x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) {
            if (x0 === x1 && y0 === y1 && r1 > 0 && r1 <= 1024 && r0 >= 0 && r0 <= r1) {
              return {
                __drRad: true,
                x0,
                y0,
                r0,
                r1,
                c0: '#ffffff',
                c1: 'black',
                addColorStop(off: number, col: string) {
                  if (off <= 0) this.c0 = String(col);
                  else this.c1 = String(col);
                },
              };
            }
            return origCreateRG.call(this, x0, y0, r0, x1, y1, r1);
          };
          ctx.fillRect = function (rx: number, ry: number, rw: number, rh: number) {
            const rad = pendingRad;
            const doc = runtime.document;
            if (
              rad &&
              doc?.createElement &&
              Math.abs(rw - rad.r1 * 2) <= 2 &&
              Math.abs(rh - rad.r1 * 2) <= 2
            ) {
              const hr = bmp.__drHalfRes;
              const sx = hr ? hr.sx : 0.5;
              const sy = hr ? hr.sy : 0.5;
              const qr0 = Math.round(rad.r0);
              const qr1 = Math.round(rad.r1);
              const key = `${qr0}|${qr1}|${rad.c0}|${rad.c1}|${sx.toFixed(3)}`;
              let spriteCanvas = radialSpriteCache.get(key);
              if (!spriteCanvas) {
                const pw = Math.max(2, Math.ceil(qr1 * sx) * 2);
                const ph = Math.max(2, Math.ceil(qr1 * sy) * 2);
                const sc = doc.createElement('canvas');
                sc.width = pw;
                sc.height = ph;
                const sctx = sc.getContext?.('2d');
                if (sctx && typeof sctx.createRadialGradient === 'function') {
                  sctx.scale?.(pw / (qr1 * 2), ph / (qr1 * 2));
                  const g = sctx.createRadialGradient(qr1, qr1, qr0, qr1, qr1, qr1);
                  g.addColorStop(0, rad.c0);
                  g.addColorStop(1, rad.c1);
                  sctx.fillStyle = g;
                  sctx.fillRect(0, 0, qr1 * 2, qr1 * 2);
                  if (radialSpriteCache.size >= 48) {
                    const oldest = radialSpriteCache.keys().next().value;
                    if (oldest !== undefined) radialSpriteCache.delete(oldest);
                  }
                  radialSpriteCache.set(key, sc);
                  spriteCanvas = sc;
                }
              }
              if (spriteCanvas) {
                origDrawImage.call(this, spriteCanvas, 0, 0, spriteCanvas.width, spriteCanvas.height, rx, ry, rw, rh);
                return;
              }
            }
            if (rad) {
              const realG = origCreateRG.call(this, rad.x0, rad.y0, rad.r0, rad.x0, rad.y0, rad.r1);
              realG.addColorStop(0, rad.c0);
              realG.addColorStop(1, rad.c1);
              origFillSet.call(this, realG);
            }
            return origFillRect.call(this, rx, ry, rw, rh);
          };
        } catch { /* fallback cleanly to unhooked ctx */ }
      }
    }
  };

  // 6f4b2. Zero-allocation direct-loop Game_Map.events / eventsXy / eventsXyNt / tileEventsXy / updateEvents
  //        Stock RPG Maker MV uses .filter(fn) & .forEach(fn) on 300+ events dozens of times per frame,
  //        which is especially expensive under V8 Ignition (jit=off). Only replaces stock MV implementations.
  if (GameMapRefreshProto && !GameMapRefreshProto.__drFastLoops) {
    GameMapRefreshProto.__drFastLoops = true;
    if (typeof GameMapRefreshProto.events === 'function' && String(GameMapRefreshProto.events).length < 180) {
      GameMapRefreshProto.events = function () {
        const src = this._events;
        const out: any[] = [];
        if (src) {
          for (let i = 0, len = src.length; i < len; i++) {
            const ev = src[i];
            if (ev) out.push(ev);
          }
        }
        return out;
      };
    }
    if (typeof GameMapRefreshProto.eventsXy === 'function' && String(GameMapRefreshProto.eventsXy).length < 220) {
      GameMapRefreshProto.eventsXy = function (x: number, y: number) {
        const src = this._events;
        const out: any[] = [];
        if (src) {
          for (let i = 0, len = src.length; i < len; i++) {
            const ev = src[i];
            if (ev && ev.pos(x, y)) out.push(ev);
          }
        }
        return out;
      };
    }
    if (typeof GameMapRefreshProto.eventsXyNt === 'function' && String(GameMapRefreshProto.eventsXyNt).length < 220) {
      GameMapRefreshProto.eventsXyNt = function (x: number, y: number) {
        const src = this._events;
        const out: any[] = [];
        if (src) {
          for (let i = 0, len = src.length; i < len; i++) {
            const ev = src[i];
            if (ev && ev.posNt(x, y)) out.push(ev);
          }
        }
        return out;
      };
    }
    if (typeof GameMapRefreshProto.tileEventsXy === 'function' && String(GameMapRefreshProto.tileEventsXy).length < 220) {
      GameMapRefreshProto.tileEventsXy = function (x: number, y: number) {
        const src = this.tileEvents;
        const out: any[] = [];
        if (src) {
          for (let i = 0, len = src.length; i < len; i++) {
            const ev = src[i];
            if (ev && ev.posNt(x, y)) out.push(ev);
          }
        }
        return out;
      };
    }
    if (typeof GameMapRefreshProto.updateEvents === 'function' && String(GameMapRefreshProto.updateEvents).length < 280) {
      GameMapRefreshProto.updateEvents = function () {
        const evs = this._events;
        if (evs) {
          for (let i = 0, len = evs.length; i < len; i++) {
            const ev = evs[i];
            if (ev) ev.update();
          }
        }
        const ces = this._commonEvents;
        if (ces) {
          for (let i = 0, len = ces.length; i < len; i++) {
            const ce = ces[i];
            if (ce) ce.update();
          }
        }
      };
    }
  }

  // 6f4b3. Compiled script cache for Game_Interpreter (command111 / command122 / command355)
  //        and allocation-free command dispatch table.
  //        Under V8 Ignition (jit=off), calling eval() inside Parallel Common Events 60x/sec
  //        re-lexes & re-parses bytecode every frame (e.g. Fear & Hunger ce=5-7ms/tick).
  //        Compiling each unique script string once into a cached Function is 20-50x faster.
  const InterpProto = runtime.Game_Interpreter?.prototype;
  if (InterpProto && !InterpProto.__drFastInterp) {
    InterpProto.__drFastInterp = true;
    const exprCache = new Map<string, ((this: any) => any) | null>();
    const stmtCache = new Map<string, ((this: any) => any) | null>();
    const MAX_SCRIPT_CACHE = 4096;

    const getCompiledExpr = (code: string): ((this: any) => any) | null => {
      if (exprCache.has(code)) return exprCache.get(code)!;
      if (exprCache.size >= MAX_SCRIPT_CACHE) exprCache.clear();
      try {
        const cleaned = code.trim().replace(/;+\s*$/, '');
        const fn = new Function(`return (${cleaned});`) as (this: any) => any;
        exprCache.set(code, fn);
        return fn;
      } catch {
        exprCache.set(code, null);
        return null;
      }
    };

    const getCompiledStmt = (code: string): ((this: any) => any) | null => {
      if (stmtCache.has(code)) return stmtCache.get(code)!;
      if (stmtCache.size >= MAX_SCRIPT_CACHE) stmtCache.clear();
      try {
        const fn = new Function(code) as (this: any) => any;
        stmtCache.set(code, fn);
        return fn;
      } catch {
        stmtCache.set(code, null);
        return null;
      }
    };

    // Cache 'command' + code strings so executeCommand avoids per-command string allocation
    const cmdNameTable: Record<number, string> = Object.create(null);
    if (typeof InterpProto.executeCommand === 'function' && String(InterpProto.executeCommand).length < 480) {
      InterpProto.executeCommand = function () {
        const command = this.currentCommand();
        if (command) {
          this._params = command.parameters;
          this._indent = command.indent;
          const code = command.code;
          let methodName = cmdNameTable[code];
          if (!methodName) {
            methodName = 'command' + code;
            cmdNameTable[code] = methodName;
          }
          const fn = this[methodName];
          if (typeof fn === 'function') {
            if (!fn.call(this)) {
              return false;
            }
          }
          this._index++;
        } else {
          this.terminate();
        }
        return true;
      };
    }

    // command111 case 12: Conditional Branch -> Script
    if (typeof InterpProto.command111 === 'function') {
      const origCmd111 = InterpProto.command111;
      InterpProto.command111 = function () {
        if (this._params && this._params[0] === 12) {
          const code = String(this._params[1] ?? '');
          const fn = getCompiledExpr(code);
          if (fn) {
            const result = Boolean(fn.call(this));
            this._branch[this._indent] = result;
            if (result === false) this.skipBranch();
            return true;
          }
        }
        return origCmd111.call(this);
      };
    }

    // command122 operand 4: Control Variables -> Script
    if (typeof InterpProto.command122 === 'function') {
      const origCmd122 = InterpProto.command122;
      InterpProto.command122 = function () {
        if (this._params && this._params[3] === 4 && typeof this.operateVariable === 'function') {
          const code = String(this._params[4] ?? '');
          const fn = getCompiledExpr(code);
          if (fn) {
            let value = 0;
            try {
              value = fn.call(this);
            } catch {
              return origCmd122.call(this);
            }
            const startId = this._params[0];
            const endId = this._params[1];
            const opType = this._params[2];
            for (let i = startId; i <= endId; i++) {
              this.operateVariable(i, opType, value);
            }
            return true;
          }
        }
        return origCmd122.call(this);
      };
    }

    // command355: Event Script command (supports both stock MV and YEP_CoreEngine's try/catch wrapper)
    const cmd355Src = typeof InterpProto.command355 === 'function' ? String(InterpProto.command355) : '';
    if (
      typeof InterpProto.command355 === 'function' &&
      cmd355Src.length < 650 &&
      (cmd355Src.includes('eval(script)') || cmd355Src.length < 360)
    ) {
      const origCmd355 = InterpProto.command355;
      // Zero-compile fast-path for simple single-line direct variable/switch assignments
      // (eliminates 300+ eval() / cold Function() compiles on Ambrosia's textbox-end CommonEvents).
      const VAR_CONST_RE = /^\$gameVariables\._data\[(\d+)\]\s*(=|\+=|-=)\s*(-?\d+(?:\.\d+)?)\s*;?$/;
      const VAR_VAR_RE = /^\$gameVariables\._data\[(\d+)\]\s*(=|\+=|-=)\s*\$gameVariables\._data\[(\d+)\]\s*;?$/;
      const SW_ASSIGN_RE = /^\$gameSwitches\._data\[(\d+)\]\s*=\s*(true|false)\s*;?$/;
      InterpProto.command355 = function () {
        let script = this.currentCommand().parameters[0] + '\n';
        let multiLine = false;
        while (this.nextEventCode() === 655) {
          this._index++;
          script += this.currentCommand().parameters[0] + '\n';
          multiLine = true;
        }
        if (!multiLine) {
          const trimmed = script.trim();
          const vm = VAR_CONST_RE.exec(trimmed);
          if (vm && runtime.$gameVariables?._data) {
            const idx = Number(vm[1]);
            const val = Number(vm[3]);
            const data = runtime.$gameVariables._data;
            if (vm[2] === '=') data[idx] = val;
            else if (vm[2] === '+=') data[idx] = (data[idx] || 0) + val;
            else data[idx] = (data[idx] || 0) - val;
            return true;
          }
          const vvm = VAR_VAR_RE.exec(trimmed);
          if (vvm && runtime.$gameVariables?._data) {
            const dst = Number(vvm[1]);
            const src = Number(vvm[3]);
            const data = runtime.$gameVariables._data;
            const rhs = data[src];
            if (vvm[2] === '=') data[dst] = rhs;
            else if (vvm[2] === '+=') data[dst] = (data[dst] || 0) + (rhs || 0);
            else data[dst] = (data[dst] || 0) - (rhs || 0);
            return true;
          }
          const sm = SW_ASSIGN_RE.exec(trimmed);
          if (sm && runtime.$gameSwitches?._data) {
            runtime.$gameSwitches._data[Number(sm[1])] = sm[2] === 'true';
            return true;
          }
        }
        const fn = getCompiledStmt(script);
        if (fn) {
          try {
            fn.call(this);
          } catch (e) {
            if (typeof runtime.Yanfly?.Util?.displayError === 'function') {
              runtime.Yanfly.Util.displayError(e, script, 'SCRIPT CALL ERROR');
            } else {
              throw e;
            }
          }
          return true;
        }
        // Fallback: evaluate directly if compilation failed
        try {
          (0, eval)(script);
        } catch (e) {
          if (typeof runtime.Yanfly?.Util?.displayError === 'function') {
            runtime.Yanfly.Util.displayError(e, script, 'SCRIPT CALL ERROR');
          } else {
            return origCmd355.call(this);
          }
        }
        return true;
      };
    }

    // Smoothly time-slice massive post-dialogue CommonEvents (e.g. Ambrosia CE#6's 1,600 commands)
    // across the 8-frame Window_Message closing animation so the textbox bend-out stays 60 FPS!
    if (typeof InterpProto.update === 'function' && typeof InterpProto.checkFreeze === 'function' && !InterpProto.__drSmoothCloseYield) {
      InterpProto.__drSmoothCloseYield = true;
      let interpTickStart = 0;
      let interpActiveDepth = 0;
      const origInterpUpdate = InterpProto.update;
      InterpProto.update = function () {
        if (interpActiveDepth === 0) interpTickStart = performance.now();
        interpActiveDepth++;
        try {
          return origInterpUpdate.call(this);
        } finally {
          interpActiveDepth--;
        }
      };
      const origCheckFreeze = InterpProto.checkFreeze;
      InterpProto.checkFreeze = function () {
        if (origCheckFreeze.call(this)) return true;
        if (
          this._freezeChecker > 0 &&
          (this._freezeChecker & 63) === 0 &&
          runtime.SceneManager?._scene?._messageWindow?.isClosing?.() &&
          performance.now() - interpTickStart >= 6
        ) {
          return true;
        }
        return false;
      };
    }
  }

  // 6f4b4. Rain / Storm / Snow Weather & TRP_Particle optimization (Demons Roots & universal MV):
  //        1. Cap stock MV Weather sprites at 40 (down from 90) and use a direct for-loop.
  //        2. Cap dense TRP_Particle emitters at 60 particles and step at 30Hz (dt*2 every 2nd frame)
  //           to preserve motion speed & lifetime at half CPU + Canvas2D draw cost.
  const WeatherProto = runtime.Weather?.prototype;
  if (WeatherProto?._updateAllSprites && !WeatherProto.__drFastWeather) {
    WeatherProto.__drFastWeather = true;
    WeatherProto._updateAllSprites = function () {
      const maxSprites = Math.min(40, Math.floor(this.power * 6));
      while (this._sprites.length < maxSprites) {
        this._addSprite();
      }
      while (this._sprites.length > maxSprites) {
        this._removeSprite();
      }
      const sprites = this._sprites;
      const ox = this.origin.x;
      const oy = this.origin.y;
      for (let i = 0, len = sprites.length; i < len; i++) {
        const sp = sprites[i];
        this._updateSprite(sp);
        sp.x = sp.ax - ox;
        sp.y = sp.ay - oy;
      }
    };
  }

  const ParticleEmitterProto = runtime.ParticleEmitter?.prototype;
  if (ParticleEmitterProto?.updateEmitter && !ParticleEmitterProto.__drFastParticles) {
    ParticleEmitterProto.__drFastParticles = true;
    const origUpdateEmitter = ParticleEmitterProto.updateEmitter;
    ParticleEmitterProto.updateEmitter = function () {
      const emitter = this._emitter;
      if (emitter && !this._destroyed) {
        if (emitter.maxParticles > 60) {
          emitter.maxParticles = 60;
        }
        // Step particle physics at 30Hz with 2x dt (exact same speed/lifetime, 2x faster JS)
        const fc = Graphics?.frameCount || 0;
        if (this._drPartReady && (fc & 1) === 1) {
          if (this._followScroll || this._updatePos) {
            this.updatePosition?.();
          }
          return;
        }
        this._drPartReady = true;
        const origDt = this.updateDeltaTime;
        if (typeof origDt === 'function') {
          this.updateDeltaTime = function () { return origDt.call(this) * 2; };
          try {
            return origUpdateEmitter.call(this);
          } finally {
            this.updateDeltaTime = origDt;
          }
        }
      }
      return origUpdateEmitter.call(this);
    };
  }

  // 6f4b2. O(1) spatial coordinate index for Game_Map.eventsXy / eventsXyNt + zero-allocation
  //        Typed-Array A* pathfinding (`Game_Character.prototype.findDirectionTo`).
  //        Speeds up collision checks, HalfMove, MKR_PlayerSensor, and YEP_EventChasePlayer
  //        chasing enemies (Fear & Hunger, Ambrosia, Nightmare Knight) by 20x-50x in jitless V8!
  const GameCharBaseProto = runtime.Game_CharacterBase?.prototype;
  const isStockCharPos = Boolean(
    GameCharBaseProto?.pos &&
    String(GameCharBaseProto.pos).includes('this._x === x') &&
    String(GameCharBaseProto.pos).includes('this._y === y') &&
    String(GameCharBaseProto.pos).length < 120,
  );
  if (GameCharBaseProto && !GameCharBaseProto.__drSpatialHooks) {
    GameCharBaseProto.__drSpatialHooks = true;
    for (const posMut of ['setPosition', 'copyPosition', 'locate', 'moveStraight', 'moveDiagonally', 'jump'] as const) {
      const origMut = GameCharBaseProto[posMut];
      if (typeof origMut === 'function') {
        GameCharBaseProto[posMut] = function () {
          if (runtime.$gameMap) runtime.$gameMap._drSpatialDirty = true;
          return origMut.apply(this, arguments);
        };
      }
    }
  }
  const ensureSpatialIndex = (gm: any): Map<number, any[]> | null => {
    const evs = gm?._events;
    if (!evs) return null;
    const fc = Graphics?.frameCount || 0;
    if (
      !gm._drSpatialDirty &&
      gm._drSpatialMap &&
      gm._drSpatialFrame === fc &&
      gm._drSpatialMapId === gm._mapId &&
      gm._drSpatialLen === evs.length
    ) {
      return gm._drSpatialMap;
    }
    let map: Map<number, any[]> = gm._drSpatialMap;
    if (!map) {
      map = new Map<number, any[]>();
      gm._drSpatialMap = map;
    } else {
      map.clear();
    }
    for (let i = 0, len = evs.length; i < len; i++) {
      const ev = evs[i];
      if (!ev) continue;
      const ex = ev._x;
      const ey = ev._y;
      if ((ex | 0) !== ex || (ey | 0) !== ey) {
        // Fractional tile coordinates (e.g. HalfMove): abort integer grid index for this map
        gm._drSpatialNonInt = true;
        return null;
      }
      const key = ((ex & 0xffff) << 16) | (ey & 0xffff);
      let bucket = map.get(key);
      if (!bucket) {
        bucket = [ev];
        map.set(key, bucket);
      } else {
        bucket.push(ev);
      }
    }
    gm._drSpatialDirty = false;
    gm._drSpatialNonInt = false;
    gm._drSpatialFrame = fc;
    gm._drSpatialMapId = gm._mapId;
    gm._drSpatialLen = evs.length;
    return map;
  };
  if (GameMapRefreshProto && !GameMapRefreshProto.__drFastEventLookup) {
    GameMapRefreshProto.__drFastEventLookup = true;
    if (
      isStockCharPos &&
      typeof GameMapRefreshProto.eventsXy === 'function' &&
      (String(GameMapRefreshProto.eventsXy).includes('event.pos(') || String(GameMapRefreshProto.eventsXy).includes('ev.pos(')) &&
      String(GameMapRefreshProto.eventsXy).length < 260
    ) {
      GameMapRefreshProto.eventsXy = function (x: number, y: number) {
        const evs = this._events;
        const out: any[] = [];
        if (!evs) return out;
        if (!this._drSpatialNonInt && (x | 0) === x && (y | 0) === y && evs.length >= 16) {
          const grid = ensureSpatialIndex(this);
          if (grid) {
            const bucket = grid.get(((x & 0xffff) << 16) | (y & 0xffff));
            if (!bucket) return out;
            for (let i = 0; i < bucket.length; i++) {
              const ev = bucket[i];
              if (ev._x === x && ev._y === y) out.push(ev);
            }
            return out;
          }
        }
        for (let i = 0; i < evs.length; i++) {
          const ev = evs[i];
          if (ev && ev._x === x && ev._y === y) out.push(ev);
        }
        return out;
      };
    }
    if (
      isStockCharPos &&
      typeof GameMapRefreshProto.eventsXyNt === 'function' &&
      (String(GameMapRefreshProto.eventsXyNt).includes('event.posNt(') || String(GameMapRefreshProto.eventsXyNt).includes('ev.posNt(')) &&
      String(GameMapRefreshProto.eventsXyNt).length < 260
    ) {
      GameMapRefreshProto.eventsXyNt = function (x: number, y: number) {
        const evs = this._events;
        const out: any[] = [];
        if (!evs) return out;
        if (!this._drSpatialNonInt && (x | 0) === x && (y | 0) === y && evs.length >= 16) {
          const grid = ensureSpatialIndex(this);
          if (grid) {
            const bucket = grid.get(((x & 0xffff) << 16) | (y & 0xffff));
            if (!bucket) return out;
            for (let i = 0; i < bucket.length; i++) {
              const ev = bucket[i];
              if (ev._x === x && ev._y === y && !ev.isThrough()) out.push(ev);
            }
            return out;
          }
        }
        for (let i = 0; i < evs.length; i++) {
          const ev = evs[i];
          if (ev && ev._x === x && ev._y === y && !ev.isThrough()) out.push(ev);
        }
        return out;
      };
    }
    if (
      typeof GameMapRefreshProto.eventsXyUnitNt === 'function' &&
      String(GameMapRefreshProto.eventsXyUnitNt).includes('posExpansionNt') &&
      String(GameMapRefreshProto.eventsXyUnitNt).length < 180
    ) {
      GameMapRefreshProto.eventsXyUnitNt = function (x: number, y: number) {
        const evs = this._events;
        const out: any[] = [];
        if (!evs) return out;
        const unit = runtime.Game_Map?.tileUnit ?? 0.5;
        const minX = x - unit;
        const maxX = x + unit;
        const minY = y - unit;
        const maxY = y + unit;
        for (let i = 0; i < evs.length; i++) {
          const ev = evs[i];
          if (!ev) continue;
          if (ev._triggerExpansion) {
            if (ev.posExpansionNt(x, y)) out.push(ev);
          } else if (
            ev._x >= minX &&
            ev._x <= maxX &&
            ev._y >= minY &&
            ev._y <= maxY &&
            !ev.isThrough()
          ) {
            out.push(ev);
          }
        }
        return out;
      };
    }
  }

  // Zero-allocation Typed-Array A* `Game_Character.prototype.findDirectionTo` (exact match with stock MV).
  const GameCharProto = runtime.Game_Character?.prototype;
  if (GameCharProto && typeof GameCharProto.findDirectionTo === 'function' && !GameCharProto.__drFastAStar) {
    const astarSrc = String(GameCharProto.findDirectionTo);
    if (
      astarSrc.includes('searchLimit') &&
      astarSrc.includes('closedList') &&
      astarSrc.includes('roundXWithDirection') &&
      astarSrc.length < 2600
    ) {
      GameCharProto.__drFastAStar = true;
      const origFindDir = GameCharProto.findDirectionTo;
      const MAX_ASTAR_NODES = 1024;
      const aNodeX = new Int32Array(MAX_ASTAR_NODES);
      const aNodeY = new Int32Array(MAX_ASTAR_NODES);
      const aNodeG = new Int32Array(MAX_ASTAR_NODES);
      const aNodeF = new Float64Array(MAX_ASTAR_NODES);
      const aNodeParent = new Int32Array(MAX_ASTAR_NODES);
      const aNodePos = new Int32Array(MAX_ASTAR_NODES);
      const aOpenIdx = new Int32Array(MAX_ASTAR_NODES);
      let aClosedStamp = new Int32Array(4096);
      let aOpenNodeAtPos = new Int32Array(4096);
      let aStampGen = 1;

      GameCharProto.findDirectionTo = function (goalX: number, goalY: number) {
        const gm = runtime.$gameMap;
        if (!gm || (this.x | 0) !== this.x || (this.y | 0) !== this.y || (goalX | 0) !== goalX || (goalY | 0) !== goalY) {
          return origFindDir.call(this, goalX, goalY);
        }
        const searchLimit = this.searchLimit();
        const mapWidth = gm.width();
        const mapHeight = gm.height();
        if (this.x === goalX && this.y === goalY) return 0;
        const mapCells = mapWidth * mapHeight;
        if (mapCells <= 0 || mapCells > 262144) {
          return origFindDir.call(this, goalX, goalY);
        }
        if (aClosedStamp.length < mapCells) {
          aClosedStamp = new Int32Array(mapCells);
          aOpenNodeAtPos = new Int32Array(mapCells);
          aStampGen = 1;
        } else {
          aStampGen++;
          if (aStampGen >= 0xfffff) {
            aClosedStamp.fill(0);
            aOpenNodeAtPos.fill(0);
            aStampGen = 1;
          }
        }
        const gen = aStampGen;
        const startX = this.x;
        const startY = this.y;
        const startPos = startY * mapWidth + startX;
        aNodeX[0] = startX;
        aNodeY[0] = startY;
        aNodeG[0] = 0;
        aNodeF[0] = gm.distance(startX, startY, goalX, goalY);
        aNodeParent[0] = -1;
        aNodePos[0] = startPos;
        aOpenIdx[0] = 0;
        aOpenNodeAtPos[startPos] = 1 | (gen << 12);
        let nodeCount = 1;
        let openLen = 1;
        let bestIdx = 0;

        while (openLen > 0) {
          let minSlot = 0;
          let minF = aNodeF[aOpenIdx[0]];
          for (let i = 1; i < openLen; i++) {
            const f = aNodeF[aOpenIdx[i]];
            if (f < minF) {
              minF = f;
              minSlot = i;
            }
          }
          const curIdx = aOpenIdx[minSlot];
          openLen--;
          for (let i = minSlot; i < openLen; i++) aOpenIdx[i] = aOpenIdx[i + 1];

          const curPos = aNodePos[curIdx];
          aOpenNodeAtPos[curPos] = 0;
          aClosedStamp[curPos] = gen;

          const x1 = aNodeX[curIdx];
          const y1 = aNodeY[curIdx];
          const g1 = aNodeG[curIdx];

          if (x1 === goalX && y1 === goalY) {
            bestIdx = curIdx;
            break;
          }
          if (g1 >= searchLimit) continue;

          for (let j = 0; j < 4; j++) {
            const direction = 2 + j * 2;
            const x2 = gm.roundXWithDirection(x1, direction);
            const y2 = gm.roundYWithDirection(y1, direction);
            if (x2 < 0 || x2 >= mapWidth || y2 < 0 || y2 >= mapHeight) continue;
            const pos2 = y2 * mapWidth + x2;
            if (aClosedStamp[pos2] === gen) continue;
            if (!this.canPass(x1, y1, direction)) continue;

            const g2 = g1 + 1;
            const encodedOpen = aOpenNodeAtPos[pos2];
            const existingIdx = (encodedOpen !== 0 && (encodedOpen >>> 12) === (gen & 0xfffff))
              ? ((encodedOpen & 0xfff) - 1)
              : -1;

            if (existingIdx < 0 || g2 < aNodeG[existingIdx]) {
              let nIdx = existingIdx;
              if (nIdx < 0) {
                if (nodeCount >= MAX_ASTAR_NODES) return origFindDir.call(this, goalX, goalY);
                nIdx = nodeCount++;
                aOpenIdx[openLen++] = nIdx;
                aOpenNodeAtPos[pos2] = ((nIdx + 1) & 0xfff) | ((gen & 0xfffff) << 12);
              }
              aNodeParent[nIdx] = curIdx;
              aNodeX[nIdx] = x2;
              aNodeY[nIdx] = y2;
              aNodePos[nIdx] = pos2;
              aNodeG[nIdx] = g2;
              const h2 = gm.distance(x2, y2, goalX, goalY);
              aNodeF[nIdx] = g2 + h2;
              if (h2 < aNodeF[bestIdx] - aNodeG[bestIdx]) {
                bestIdx = nIdx;
              }
            }
          }
        }

        let walk = bestIdx;
        while (aNodeParent[walk] >= 0 && aNodeParent[walk] !== 0) {
          walk = aNodeParent[walk];
        }
        const deltaX1 = gm.deltaX(aNodeX[walk], startX);
        const deltaY1 = gm.deltaY(aNodeY[walk], startY);
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
      log('[compat] zero-allocation Typed-Array A* findDirectionTo & O(1) spatial event grid enabled');
    }
  }
  const GamePlayerProto = runtime.Game_Player?.prototype;
  if (
    GamePlayerProto &&
    typeof GamePlayerProto.findAvailableMapActiveMessageEvents === 'function' &&
    !GamePlayerProto.__drFastActiveMsgScan
  ) {
    const kmsSrc = String(GamePlayerProto.findAvailableMapActiveMessageEvents);
    if (kmsSrc.includes('hasMapActiveMessage') && kmsSrc.includes('isMapActiveMessageShown')) {
      GamePlayerProto.__drFastActiveMsgScan = true;
      GamePlayerProto.findAvailableMapActiveMessageEvents = function () {
        if (!this.canMove()) return [];
        const evs = runtime.$gameMap?._events;
        const out: any[] = [];
        if (!evs) return out;
        for (let i = 0; i < evs.length; i++) {
          const ev = evs[i];
          if (!ev) continue;
          const shown = ev.isMapActiveMessageShown?.();
          if (shown) {
            if (this.calcDistanceForMapActiveMessage(ev) > ev.getMapActiveMessageRange()) {
              ev.setMapActiveMessageShown(false);
            }
          } else if (ev.hasMapActiveMessage?.()) {
            if (this.calcDistanceForMapActiveMessage(ev) <= ev.getMapActiveMessageRange()) {
              out.push(ev);
            }
          }
        }
        return out;
      };
    }
  }

  // 6f4c. Zero-alloc Game_Map.updateEvents + EventReSpawn / MKR_PlayerSensor Spriteset_Map caches
  //       + MKR_PlayerSensor fast-exit & bounding-box pre-check
  if (
    GameMapRefreshProto &&
    typeof GameMapRefreshProto.updateEvents === 'function' &&
    !GameMapRefreshProto.__drZeroAllocUpdEv
  ) {
    const ueSrc = String(GameMapRefreshProto.updateEvents);
    if (
      ueSrc.length < 420 &&
      ueSrc.includes('this.events()') &&
      ueSrc.includes('_commonEvents')
    ) {
      GameMapRefreshProto.__drZeroAllocUpdEv = true;
      GameMapRefreshProto.updateEvents = function () {
        const evs = this._events;
        if (evs) {
          for (let i = 0, len = evs.length; i < len; i++) {
            const ev = evs[i];
            if (ev) ev.update();
          }
        }
        const ces = this._commonEvents;
        if (ces) {
          for (let i = 0, len = ces.length; i < len; i++) {
            const ce = ces[i];
            if (ce) ce.update();
          }
        }
      };
    }
  }
  const SpritesetMapOptProto = runtime.Spriteset_Map?.prototype;
  if (SpritesetMapOptProto) {
    // EventReSpawn.js: avoid allocating two 171-element arrays + scanning 168 sprites every frame
    // when no prefab events exist on the current map.
    if (typeof GameMapRefreshProto?.spawnEvent === 'function' && !GameMapRefreshProto.__drPrefabTrack) {
      GameMapRefreshProto.__drPrefabTrack = true;
      const origSpawnEv = GameMapRefreshProto.spawnEvent;
      GameMapRefreshProto.spawnEvent = function () {
        this._drPrefabDirty = true;
        return origSpawnEv.apply(this, arguments);
      };
    }
    if (typeof SpritesetMapOptProto.updatePrefabEvent === 'function' && !SpritesetMapOptProto.__drPrefabFast) {
      SpritesetMapOptProto.__drPrefabFast = true;
      const origUpdPrefab = SpritesetMapOptProto.updatePrefabEvent;
      SpritesetMapOptProto.updatePrefabEvent = function () {
        const gm = runtime.$gameMap;
        const evs = gm?._events;
        if (gm && evs) {
          if (
            !gm._drPrefabDirty &&
            this._drPrefabMapId === gm._mapId &&
            this._drPrefabEvLen === evs.length &&
            !this._drHasPrefabs
          ) {
            return;
          }
          let hasPrefab = false;
          for (let i = 0, len = evs.length; i < len; i++) {
            const ev = evs[i];
            if (ev && ev.isPrefab?.()) {
              hasPrefab = true;
              break;
            }
          }
          gm._drPrefabDirty = false;
          this._drPrefabMapId = gm._mapId;
          this._drPrefabEvLen = evs.length;
          this._drHasPrefabs = hasPrefab;
          if (!hasPrefab) return;
        }
        return origUpdPrefab.call(this);
      };
    }
    // MKR_PlayerSensor.js: avoid allocating two 171-element arrays + scanning all events every frame
    // when no uncreated sensor view-range sprites exist on the current map.
    if (typeof SpritesetMapOptProto.updateViewRange === 'function' && !SpritesetMapOptProto.__drViewRangeFast) {
      SpritesetMapOptProto.__drViewRangeFast = true;
      const origUpdVR = SpritesetMapOptProto.updateViewRange;
      SpritesetMapOptProto.updateViewRange = function () {
        const gm = runtime.$gameMap;
        const evs = gm?._events;
        if (gm && evs) {
          if (
            this._drVrMapId === gm._mapId &&
            this._drVrEvLen === evs.length &&
            ((Graphics?.frameCount || 0) & 31) !== 0
          ) {
            return;
          }
          let needCreate = false;
          for (let i = 0, len = evs.length; i < len; i++) {
            const ev = evs[i];
            if (ev && ev._sensorType && !ev.isCreateRange?.()) {
              needCreate = true;
              break;
            }
          }
          this._drVrMapId = gm._mapId;
          this._drVrEvLen = evs.length;
          if (!needCreate) return;
        }
        return origUpdVR.call(this);
      };
    }
  }
  if (GameEventProto && typeof GameEventProto.sensorUpdate === 'function' && !GameEventProto.__drSensorUpdFast) {
    GameEventProto.__drSensorUpdFast = true;
    const origSensorUpdate = GameEventProto.sensorUpdate;
    GameEventProto.sensorUpdate = function () {
      if (this._sensorStatus != 1) return;
      return origSensorUpdate.call(this);
    };
  }
  if (GameEventProto && typeof GameEventProto.isFoundPlayer === 'function' && !GameEventProto.__drSensorFast) {
    GameEventProto.__drSensorFast = true;
    const origIsFoundPlayer = GameEventProto.isFoundPlayer;
    GameEventProto.isFoundPlayer = function () {
      const player = runtime.$gamePlayer;
      if (player && typeof this.getSensorRange === 'function') {
        const range = (Number(this.getSensorRange()) || 12) + 2;
        if (
          Math.abs(player._realX - this._realX) > range ||
          Math.abs(player._realY - this._realY) > range
        ) {
          return false;
        }
      }
      return origIsFoundPlayer.call(this);
    };
  }

  // 6f4d. Safe stationary & off-screen Game_Event.update throttle + _drStateRev tracking
  //       (Note: `refresh` is intentionally omitted from mutators because setupPage already fires on page change!)
  if (GameEventProto?.update && !GameEventProto.__drEventSkip) {
    GameEventProto.__drEventSkip = true;
    for (const mut of ['setupPage', 'locate', 'setImage', 'setTileImage', 'setDirection', 'setPattern', 'setOpacity', 'setTransparent'] as const) {
      const fn = GameEventProto[mut] || runtime.Game_CharacterBase?.prototype?.[mut];
      if (typeof fn === 'function' && !GameEventProto[`__drMut_${mut}`]) {
        GameEventProto[`__drMut_${mut}`] = true;
        GameEventProto[mut] = function () {
          this._drStateRev = (this._drStateRev || 0) + 1;
          return fn.apply(this, arguments);
        };
      }
    }
    const origEventUpdate = GameEventProto.update;
    GameEventProto.update = function () {
      const warmup = this._drWarmup || 0;
      if (
        warmup >= 3 &&
        this._drLastPage === this._pageIndex &&
        !this._interpreter &&
        this._trigger !== 3 &&
        this._trigger !== 4 &&
        !this._needsAlwaysRefresh &&
        !this._moveRouteForcing &&
        !this.isMoving() &&
        !this.isJumping() &&
        !this.isStarting()
      ) {
        const gm = runtime.$gameMap;
        const touchActive = Boolean(runtime.TouchInput?.isTriggered?.() || runtime.TouchInput?.isReleased?.());
        const eventCount = gm?._events?.length ?? 0;
        const isFixedIdle =
          eventCount > 60 &&
          this._moveType === 0 &&
          !this._stepAnime &&
          !this._sensorType &&
          !this.mapLight &&
          !this._chaseRange &&
          !this._fleeRange &&
          !this._isHidingContainer &&
          !this._hasQuest &&
          !this._isEnemy &&
          !(this._waitCount > 0);
        let isOffscreen = false;
        if (!isFixedIdle && gm && !gm.isLoopHorizontal() && !gm.isLoopVertical()) {
          const halfX = (gm.screenTileX?.() || 17) * 0.5;
          const halfY = (gm.screenTileY?.() || 13) * 0.5;
          const dx = Math.abs(this._realX - (gm._displayX + halfX));
          const dy = Math.abs(this._realY - (gm._displayY + halfY));
          isOffscreen = dx > halfX + 3 || dy > halfY + 3;
        }
        // Blank/disabled event pages (_pageIndex < 0) have no graphic, movement, or trigger;
        // stationary idle events on large maps (>60 events) tick at 1/8 (or 1/16 on >100-event maps),
        // off-screen moving events at 1/16.
        const fc = (Graphics?.frameCount || 0) + (this._eventId || 0);
        if (!touchActive) {
          if (this._pageIndex < 0 && (fc & 31) !== 0) return;
          if (isFixedIdle && (fc & (eventCount > 100 ? 15 : 7)) !== 0) return;
          if (isOffscreen && (fc & 15) !== 0) return;
        }
      }
      this._drWarmup = warmup + 1;
      this._drLastPage = this._pageIndex;
      const px = this._realX;
      const py = this._realY;
      const dir = this._direction;
      const pat = this._pattern;
      const res = origEventUpdate.call(this);
      if (
        this._realX !== px ||
        this._realY !== py ||
        this._direction !== dir ||
        this._pattern !== pat ||
        this.isMoving() ||
        this.isJumping()
      ) {
        this._drStateRev = (this._drStateRev || 0) + 1;
      }
      return res;
    };
  }

  // 6f5. KNH_CharacterShadow zero-call shadow update + null-bitmap guard on patternWidth/patternHeight
  //      (prevents KMS_MapActiveMessage crash on map transitions before Sprite_Character.updateBitmap runs)
  const SpriteCharProto = runtime.Sprite_Character?.prototype;
  if (SpriteCharProto && !SpriteCharProto.__drPatternNullGuard) {
    SpriteCharProto.__drPatternNullGuard = true;
    if (typeof SpriteCharProto.patternHeight === 'function') {
      const origPatH = SpriteCharProto.patternHeight;
      SpriteCharProto.patternHeight = function () {
        if (!(this._tileId > 0) && !this.bitmap) return 0;
        return origPatH.call(this);
      };
    }
    if (typeof SpriteCharProto.patternWidth === 'function') {
      const origPatW = SpriteCharProto.patternWidth;
      SpriteCharProto.patternWidth = function () {
        if (!(this._tileId > 0) && !this.bitmap) return 0;
        return origPatW.call(this);
      };
    }
  }
  if (SpriteCharProto && typeof SpriteCharProto.updateShadow === 'function' && !SpriteCharProto.__drShadowFast) {
    SpriteCharProto.__drShadowFast = true;
    const origUpdateShadow = SpriteCharProto.updateShadow;
    SpriteCharProto.updateShadow = function () {
      origUpdateShadow.call(this);
      const sh = this._shadowSprite;
      if (sh && !sh.__drFast) {
        sh.__drFast = true;
        const owner = this;
        sh.update = function () {
          const ch = this._character;
          if (!ch) return;
          this.x = owner.x + (ch._shadowAddX || 0);
          this.y = owner.y - 2 + (ch._shadowAddY || 0);
          this.z = owner.z - 1;
          this._drOffscreenRender = owner._drOffscreenRender;
          const sc = (ch._shadowScale || 100) / 100;
          if (this.scale.x !== sc) this.scale.x = this.scale.y = sc;
          this.opacity = (ch._transparent || ch._opacity === 0) ? 0 : ch._opacity;
        };
      }
    };
  }

  // 6g. Visibility-safe 1-integer-check Sprite_Character.update + off-screen updateTransform skip
  let charFastTicks = 0;
  let charTotalTicks = 0;
  let charOffSkips = 0;
  const charSlowWhy = new Map<string, number>();
  const GameEventCtor = runtime.Game_Event;
  if (SpriteCharProto?.update && GameEventCtor && !SpriteCharProto.__drSafeThrottle) {
    SpriteCharProto.__drSafeThrottle = true;
    if (typeof SpriteCharProto.updateTransform === 'function') {
      const origCharUpdateTransform = SpriteCharProto.updateTransform;
      SpriteCharProto.updateTransform = function () {
        if (this._drOffscreenRender) return;
        return origCharUpdateTransform.call(this);
      };
    }
    // Child sprites that are only this sprite's own half-body pair (MV bush depth, or TN_SpriteExtender
    // which splits EVERY character into _upperBody/_lowerBody) carry no state of their own: their frame,
    // bitmap and tint are recomputed in the parent's full update, which the fast path already forces
    // whenever the event moves, turns, animates or changes graphic. Any other child (name pops, lights,
    // attached effects) still requires the full update every tick.
    const hasOnlyHalfBodyChildren = (sp: any): boolean => {
      const kids = sp.children;
      if (!kids || kids.length === 0) return true;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (k !== sp._upperBody && k !== sp._lowerBody) return false;
      }
      return true;
    };
    const origCharUpdate = SpriteCharProto.update;
    SpriteCharProto.update = function () {
      // YED_Tiled (OMORI) creates a second `Sprite_CharacterReflect` instance for EVERY event,
      // follower, vehicle, and player on the map (`ch=128` for 54 events!). Stock `Sprite_CharacterReflect.update`
      // calls `Sprite_Character.prototype.update` FIRST (setting `this.visible = true`) and THEN calls
      // `this.updateReflect()` (setting `this.visible = false` when `reflections.length === 0`), which
      // previously defeated `_drLastVisible` and forced all 64 reflection sprites through the full slow
      // update every single tick! Patch the subclass prototype once so inactive reflection sprites cost ~0ms.
      if (typeof this.updateReflect === 'function') {
        const subProto = Object.getPrototypeOf(this);
        if (subProto && subProto !== SpriteCharProto && !subProto.__drReflectFast && typeof subProto.update === 'function') {
          subProto.__drReflectFast = true;
          const origSubUpdate = subProto.update;
          subProto.update = function () {
            const rch = this._character;
            if (!rch || !rch.reflections || rch.reflections.length === 0) {
              if (this.visible) this.visible = false;
              this._drOffscreenRender = true;
              return;
            }
            this._drOffscreenRender = false;
            return origSubUpdate.call(this);
          };
        }
        return origCharUpdate.call(this);
      }
      const ch = this._character;
      const gm = runtime.$gameMap;
      if (ch && gm && ch instanceof GameEventCtor) {
        charTotalTicks++;
        const gw = Graphics?.width || 816;
        const gh = Graphics?.height || 624;
        const tw = gm.tileWidth?.() || 48;
        const th = gm.tileHeight?.() || 48;
        // Fast path: 1 integer revision check + direct property check when event did not mutate this tick!
        // (Also checks _realX/_realY/_PosZ/_characterName/_opacity/_angle/_additionalX/Y/_scaleX/Y in case an
        // action-RPG plugin like Ruins Seeker's NupuAG / NupuPCStates / CharacterGraphicExtend mutates fields directly.)
        if (
          this._drFastOk &&
          this._drStateRev === ch._drStateRev &&
          this._tilesetId === gm._tilesetId &&
          this._drLastRealX === ch._realX &&
          this._drLastRealY === ch._realY &&
          this._drLastPosZ === (ch._PosZ || 0) &&
          this._characterName === ch._characterName &&
          this._characterIndex === ch._characterIndex &&
          this._tileId === ch._tileId &&
          !ch._customResource &&
          this.opacity === ch._opacity &&
          this.visible === this._drLastVisible &&
          ch._transparent === this._drLastTransparent &&
          this.blendMode === ch._blendMode &&
          this._drLastAngle === (ch._angle || 0) &&
          this._drLastAddX === (ch._additionalX || 0) &&
          this._drLastAddY === (ch._additionalY || 0) &&
          this._drLastScaleX === (ch._scaleX ?? 100) &&
          this._drLastScaleY === (ch._scaleY ?? 100) &&
          !ch._animationId &&
          !ch._balloonId &&
          !ch._animationPlaying &&
          !ch._balloonPlaying &&
          hasOnlyHalfBodyChildren(this)
        ) {
          const dispX = gm._displayX;
          const dispY = gm._displayY;
          if (dispX !== this._drLastDX || dispY !== this._drLastDY) {
            if (this._drCanInlineScroll) {
              this.x = Math.round(this._drBaseX - (dispX - this._drLastDX) * tw);
              this.y = Math.round(this._drBaseY - (dispY - this._drLastDY) * th);
            } else {
              this.x = ch.screenX();
              this.y = ch.screenY();
            }
            this._drOffscreenRender =
              this.x < -this._drMarginX ||
              this.x > gw + this._drMarginX ||
              this.y < -this._drMarginY ||
              this.y > gh + this._drMarginY;
          }
          charFastTicks++;
          return;
        }

        // Off-screen slow-path throttle: sprites that cannot take the fast path (template-event lights,
        // step-animated emitters, plugin child sprites) still ran the full MV update every tick even
        // while far outside the view — on Lilialette's 60x50 town map ~200 of 261 sprites. While a
        // ready sprite stays off-screen with no animation/balloon, only track its position and run the
        // full update every 8th tick; it gets a full update as soon as it is back near the screen.
        if (
          this._drOffscreenRender &&
          (this._drReadyCount || 0) >= 2 &&
          !ch._customResource &&
          !ch._animationId &&
          !ch._balloonId &&
          !ch._animationPlaying &&
          !ch._balloonPlaying &&
          !this._balloonSprite &&
          !(this._animationSprites && this._animationSprites.length > 0)
        ) {
          const sx = ch.screenX();
          const sy = ch.screenY();
          const extra = this.children && this.children.length > 0 ? 256 : 0; // lights / attached sprites
          const mx = (this._drMarginX || 128) + extra;
          const my = (this._drMarginY || 128) + extra;
          const stillOff = sx < -mx || sx > gw + mx || sy < -my || sy > gh + my;
          this._drOffTick = ((this._drOffTick || 0) + 1) & 7;
          if (stillOff && this._drOffTick !== 0) {
            this.x = sx;
            this.y = sy;
            charOffSkips++;
            return;
          }
        }

        // Telemetry: first fast-path condition that failed (shown on the [perf-map] line as slow[...])
        {
          let why = 'other';
          if (!this._drFastOk) {
            if ((this._drReadyCount || 0) < 2) why = 'notReady';
            else if (!hasOnlyHalfBodyChildren(this)) why = 'children';
            else if (ch._animationId || ch._balloonId || ch._animationPlaying || ch._balloonPlaying) why = 'anim';
            else if (ch._animeLight) why = 'animeLight';
            else why = 'motionData';
          } else if (this._drStateRev !== ch._drStateRev) why = 'moved';
          else if (this._tilesetId !== gm._tilesetId) why = 'tileset';
          else if (this._drLastRealX !== ch._realX || this._drLastRealY !== ch._realY) why = 'pos';
          else if (this._characterName !== ch._characterName || this._characterIndex !== ch._characterIndex || this._tileId !== ch._tileId) why = 'graphic';
          else if (this.opacity !== ch._opacity) why = 'opacity';
          else if (this.visible !== this._drLastVisible || ch._transparent !== this._drLastTransparent) why = 'visible';
          else if (this.blendMode !== ch._blendMode) why = 'blend';
          else if (this._drLastAngle !== (ch._angle || 0) || this._drLastScaleX !== (ch._scaleX ?? 100) || this._drLastScaleY !== (ch._scaleY ?? 100)) why = 'xform';
          charSlowWhy.set(why, (charSlowWhy.get(why) || 0) + 1);
        }

        const out = origCharUpdate.call(this);
        const bmp = this.bitmap;
        const hasGraphic = Boolean(ch._characterName || ch._tileId > 0 || ch._customResource);
        const bmpReady = !hasGraphic || Boolean(bmp && bmp.isReady?.() && this._frame?.width > 0);
        const rc = bmpReady ? (this._drReadyCount || 0) + 1 : 0;
        this._drReadyCount = rc;
        this._drStateRev = ch._drStateRev;
        this._drLastRealX = ch._realX;
        this._drLastRealY = ch._realY;
        this._drLastPosZ = ch._PosZ || 0;
        this._drLastVisible = this.visible;
        this._drLastTransparent = ch._transparent;
        this._drLastDX = gm._displayX;
        this._drLastDY = gm._displayY;
        this._drBaseX = this.x;
        this._drBaseY = this.y;
        this._drLastAngle = ch._angle || 0;
        this._drLastAddX = ch._additionalX || 0;
        this._drLastAddY = ch._additionalY || 0;
        this._drLastScaleX = ch._scaleX ?? 100;
        this._drLastScaleY = ch._scaleY ?? 100;
        const fw = (this._frame?.width || tw) * Math.abs(this.scale?.x || 1);
        const fh = (this._frame?.height || th) * Math.abs(this.scale?.y || 1);
        this._drMarginX = Math.max(128, fw + tw);
        this._drMarginY = Math.max(128, fh + th);
        const animOrBalloonActive = Boolean(
          ch._animationId ||
          ch._balloonId ||
          ch._animationPlaying ||
          ch._balloonPlaying ||
          this._balloonSprite ||
          (this._animationSprites && this._animationSprites.length > 0),
        );
        this._drOffscreenRender =
          !ch._customResource &&
          !animOrBalloonActive &&
          rc >= 2 &&
          (this.x < -this._drMarginX ||
            this.x > gw + this._drMarginX ||
            this.y < -this._drMarginY ||
            this.y > gh + this._drMarginY);
        this._drCanInlineScroll =
          !gm.isLoopHorizontal() && !gm.isLoopVertical() && !(ch._absoluteX > 0) && !(ch._absoluteY > 0);
        const hasMotion = Boolean(
          ch._customResource ||
          ch._collapseData?.[0] ||
          ch._swingData?.[0] ||
          ch._floatData?.[0] ||
          ch._breathData?.[0] ||
          ch._shakeData?.[0] ||
          ch._ghostData?.[0] ||
          ch._animeLight,
        );
        this._drFastOk =
          rc >= 2 &&
          !hasMotion &&
          !animOrBalloonActive &&
          hasOnlyHalfBodyChildren(this);
        return out;
      }
      // Fast-skip transparent unused non-event characters (3 `Game_Vehicle`s + up to 10 unused
      // `Extra_Followers` slots in OMORI = ~13 invisible sprites ticking every frame on every map).
      if (ch && ch !== runtime.$gamePlayer) {
        if (
          this._drNonEvHidden &&
          !this.visible &&
          ch._transparent === true &&
          (typeof ch.isTransparent !== 'function' || ch.isTransparent()) &&
          !ch._customResource &&
          !ch._animationId &&
          !ch._balloonId &&
          !ch._animationPlaying &&
          !ch._balloonPlaying &&
          !this._balloonSprite &&
          !(this._animationSprites && this._animationSprites.length > 0) &&
          hasOnlyHalfBodyChildren(this)
        ) {
          return;
        }
        this._drOffscreenRender = false;
        const out = origCharUpdate.call(this);
        const canHideSkip =
          !this.visible &&
          ch._transparent === true &&
          (typeof ch.isTransparent !== 'function' || ch.isTransparent()) &&
          !ch._customResource &&
          !ch._animationId &&
          !ch._balloonId &&
          !ch._animationPlaying &&
          !ch._balloonPlaying &&
          !this._balloonSprite &&
          !(this._animationSprites && this._animationSprites.length > 0) &&
          hasOnlyHalfBodyChildren(this);
        this._drNonEvHidden = canHideSkip;
        this._drOffscreenRender = canHideSkip;
        return out;
      }
      return origCharUpdate.call(this);
    };
  }

  // 6g1b. YED_Tiled (OMORI) per-tick `updateReflection` & `isHalfTile` fast-paths:
  //       Stock `Game_CharacterBase.prototype.updateReflection` calls `tileWidth()` + `tileHeight()`
  //       (each running `YED_TiledParameters["Half-tile movement"].toLowerCase()`) AND allocates a
  //       fresh `this.reflections = []` array on EVERY character on EVERY tick (~3,500 allocations/sec).
  const YedCharProto = runtime.Game_CharacterBase?.prototype;
  if (
    YedCharProto &&
    typeof YedCharProto.updateReflection === 'function' &&
    !YedCharProto.__drReflectUpdFast &&
    String(YedCharProto.updateReflection).includes('isOnReflection')
  ) {
    YedCharProto.__drReflectUpdFast = true;
    const EMPTY_REFLECTIONS: any[] = [];
    YedCharProto.updateReflection = function () {
      const gm = runtime.$gameMap;
      const refls = gm?._reflection;
      if (!refls || refls.length === 0 || (typeof gm.isTiledMap === 'function' && !gm.isTiledMap())) {
        if (!this.reflections || this.reflections.length !== 0) {
          this.reflections = EMPTY_REFLECTIONS;
        }
        return;
      }
      const mapX = this._realX * gm.tileWidth();
      const mapY = this._realY * gm.tileHeight();
      let hit: any[] | null = null;
      for (let i = 0, len = refls.length; i < len; i++) {
        const r = refls[i];
        const rect = r?.rect;
        if (rect && mapX >= rect.x && mapX <= rect.x + rect.width && mapY >= rect.y && mapY <= rect.y + rect.height) {
          if (!hit) hit = [r];
          else hit.push(r);
        }
      }
      this.reflections = hit || EMPTY_REFLECTIONS;
    };
  }
  const YedMapProto = runtime.Game_Map?.prototype;
  if (
    YedMapProto &&
    typeof YedMapProto.isHalfTile === 'function' &&
    !YedMapProto.__drHalfTileFast &&
    String(YedMapProto.isHalfTile).includes('Half-tile movement')
  ) {
    YedMapProto.__drHalfTileFast = true;
    const origIsHalfTile = YedMapProto.isHalfTile;
    let cachedHalfTile: boolean | undefined;
    YedMapProto.isHalfTile = function () {
      if (cachedHalfTile === undefined) {
        cachedHalfTile = Boolean(origIsHalfTile.call(this));
      }
      return cachedHalfTile;
    };
  }

  // 6g2. Incremental ShaderTilemap painting. Stock MV clears and repaints the whole visible window
  //      (~29x17 cells at 1280x720, ~7.6 ms on Switch 2) every time the camera crosses a tile boundary,
  //      i.e. every 8-16 frames while walking -> a hitch on almost every step (Nightmare Knight big maps).
  //      Keep a fixed paint origin and only paint the newly exposed row/column; tiles already painted
  //      stay valid (positions are relative to the paint origin and each cell is self-contained). A full
  //      repaint still happens on refresh (_needsRepaint), resize, or once the painted area exceeds
  //      ~6 screens. Only installed when updateTransform/_paintAllTiles are the stock implementations.
  let tmIncCells = 0;
  const ShaderTmProto = runtime.ShaderTilemap?.prototype;
  if (
    ShaderTmProto && !ShaderTmProto.__drIncPaint &&
    typeof ShaderTmProto._paintTiles === 'function' &&
    typeof ShaderTmProto._paintAllTiles === 'function' &&
    typeof ShaderTmProto.updateTransform === 'function'
  ) {
    const utSrc = String(ShaderTmProto.updateTransform);
    const paSrc = String(ShaderTmProto._paintAllTiles);
    const utStock =
      utSrc.includes('_paintAllTiles(startX, startY)') && utSrc.includes('_lastStartX') &&
      !utSrc.includes('animationFrame') && !utSrc.includes('_frameUpdated');
    const paStock = paSrc.includes('lowerZLayer.clear()') && paSrc.includes('_paintTiles(startX, startY, x, y)');
    // TF_LayeredMap (wall "billboards"): wraps _paintAllTiles to clear its per-screen-row billboard
    // ZLayers and replaces _paintTiles, which writes wall tiles into TF_billboards[y], [y+1], [y+2]
    // (y = screen row). Supported below by giving each billboard a fixed world row instead.
    const ptSrc = String(ShaderTmProto._paintTiles);
    const tfMode =
      utStock && !paStock && paSrc.includes('TF_billboards') && paSrc.includes('.clear()') &&
      ptSrc.includes('this.TF_billboards[ y ]') && ptSrc.includes('this.TF_billboards[ y + 1 ]') &&
      ptSrc.includes('this.TF_billboards[ y + 2 ]');
    const stock = utStock && (paStock || tfMode);
    const ContainerUT = PIXI?.Container?.prototype?.updateTransform;
    // pixi-tilemap (MV) rebuilds the vertex data of EVERY rect in a layer whenever its rect count
    // changes, so appending a column would still cost a full-layer rebuild. When a layer only grew
    // since the last fill (no clear) and its GPU buffer has room, fill just the new rects, upload, and
    // mark the layer current so the stock code skips its full rebuild. Layout-checked: 9 numbers per
    // rect in pointsBuf, 4 vertices x 11 floats per rect.
    const RectLayerProto = PIXI?.tilemap?.RectTileLayer?.prototype;
    const rlSrc = RectLayerProto ? String(RectLayerProto.renderWebGL) : '';
    const rectLayoutOk =
      rlSrc.includes('this.modificationMarker != vertices') && rlSrc.includes('points.length / 9') &&
      rlSrc.includes('arr[sz++] = u + w - eps') && typeof RectLayerProto?.clear === 'function';
    if (stock && rectLayoutOk && !RectLayerProto.__drAppendFill) {
      RectLayerProto.__drAppendFill = true;
      const origRlClear = RectLayerProto.clear;
      RectLayerProto.clear = function (this: any) {
        this.__drFilled = 0;
        return origRlClear.apply(this, arguments);
      };
      const origRlRender = RectLayerProto.renderWebGL;
      RectLayerProto.renderWebGL = function (this: any, renderer: any, useSquare?: boolean) {
        const points = this.pointsBuf;
        const filled = this.__drFilled | 0;
        const count = points ? points.length / 9 : 0;
        if (!useSquare && filled > 0 && count > filled && this.vbArray && this.vbId !== undefined &&
            this.modificationMarker === filled * 4 && this.vbBuffer && this.vbBuffer.byteLength >= count * 176) {
          const tile = renderer?.plugins?.tilemap;
          const vb = tile?.getVb?.(this.vbId);
          const gl = renderer?.gl;
          // The GPU buffer must already hold the whole vbBuffer (stock uploads it on (re)allocation)
          if (vb?.vb && gl && typeof vb.vb.bind === 'function' && vb.vb.data && vb.vb.data.byteLength >= count * 176) {
            const arr = this.vbArray;
            let sz = filled * 44;
            for (let i = filled * 9; i < points.length; i += 9) {
              const eps = 0.5;
              const textureId = points[i + 8] >> 2;
              const shiftU = 1024 * (points[i + 8] & 1);
              const shiftV = 1024 * ((points[i + 8] >> 1) & 1);
              const x = points[i + 2], y = points[i + 3];
              const w = points[i + 4], h = points[i + 5];
              const u = points[i] + shiftU, v = points[i + 1] + shiftV;
              const animX = points[i + 6], animY = points[i + 7];
              const corners = [x, y, u, v, x + w, y, u + w, v, x + w, y + h, u + w, v + h, x, y + h, u, v + h];
              for (let c = 0; c < 16; c += 4) {
                arr[sz++] = corners[c];
                arr[sz++] = corners[c + 1];
                arr[sz++] = corners[c + 2];
                arr[sz++] = corners[c + 3];
                arr[sz++] = u + eps;
                arr[sz++] = v + eps;
                arr[sz++] = u + w - eps;
                arr[sz++] = v + h - eps;
                arr[sz++] = animX;
                arr[sz++] = animY;
                arr[sz++] = textureId;
              }
            }
            // Bind THIS layer's buffer first (upload(..., dontBind) writes to whatever is bound), then
            // upload only the new rects.
            vb.vb.bind();
            gl.bufferSubData(gl.ARRAY_BUFFER, filled * 176, arr.subarray(filled * 44, count * 44));
            this.modificationMarker = count * 4; // stock code sees the layer as current
          }
        }
        const res = origRlRender.apply(this, arguments);
        if (!useSquare && points && this.modificationMarker === (points.length / 9) * 4) {
          this.__drFilled = points.length / 9;
        }
        return res;
      };
    }
    // Keep every layer below pixi-tilemap's 16-bit index limit (16384 quads per draw)
    const MAX_LAYER_RECTS = 12000;
    const layerRects = (tm: any): number => {
      let maxRects = 0;
      for (const z of [tm.lowerLayer, tm.upperLayer]) {
        const kids = z?.children;
        if (!kids) continue;
        for (let i = 0; i < kids.length; i++) {
          const n = (kids[i]?.pointsBuf?.length || 0) / 9;
          if (n > maxRects) maxRects = n;
        }
      }
      return maxRects;
    };
    if (stock && typeof ContainerUT === 'function') {
      ShaderTmProto.__drIncPaint = true;
      const MAX_AREA_SCREENS = 4;
      // --- TF_LayeredMap support -------------------------------------------------------------------
      // Sinks swallow tile writes, so one _paintTiles call can be limited to the map layers (billboard
      // writes dropped) or to a single billboard (map-layer writes and the other two billboards dropped).
      const sinkRect = { addRect() {}, addFrame() { return true; } };
      const sinkHolder = { children: [sinkRect] };
      const sinkBillboard = { children: [{ children: [sinkRect] }] };
      const suppressBillboards: any = typeof Proxy === 'function'
        ? new Proxy([], { get: (_t, k) => (k === 'length' ? 0 : sinkBillboard) })
        : null;
      // Paint world row W's billboard for map columns [x0, x1): it receives wall tiles from rows
      // W-1, W-2, W-3 (TF's billboards[y + k] with k = W - r - 1), drawn relative to paint origin pox.
      const paintBillboard = (tm: any, b: any, W: number, x0: number, x1: number, pox: number) => {
        if (x1 <= x0) return;
        const realL = tm.lowerLayer;
        const realU = tm.upperLayer;
        const realBB = tm.TF_billboards;
        const tmp = [sinkBillboard, sinkBillboard, sinkBillboard];
        tm.lowerLayer = sinkHolder;
        tm.upperLayer = sinkHolder;
        try {
          for (let k = 0; k < 3; k++) {
            const r = W - k - 1;
            tmp[0] = sinkBillboard; tmp[1] = sinkBillboard; tmp[2] = sinkBillboard;
            tmp[k] = b;
            tm.TF_billboards = tmp;
            for (let mx = x0; mx < x1; mx++) {
              tm._paintTiles(pox, r, mx - pox, 0);
              tmIncCells++;
            }
          }
        } finally {
          tm.lowerLayer = realL;
          tm.upperLayer = realU;
          tm.TF_billboards = realBB;
        }
      };
      // Keep billboards assigned to world rows startY+1 .. startY+N (TF's own window), reusing the
      // billboard of a row that left the window for the row that entered it.
      const updateBillboards = (tm: any, startX: number, startY: number, cols: number, pox: number, ox: number, oy: number) => {
        const bbs = tm.TF_billboards;
        const tw = tm._tileWidth;
        const th = tm._tileHeight;
        const N = bbs.length;
        const lo = startY + 1;
        const hi = startY + N;
        const vx1 = startX + cols;
        const key = startX + ',' + startY + ',' + pox;
        if (tm.__drBBKey !== key) {
          tm.__drBBKey = key;
          const byRow = new Map<number, any>();
          const free: any[] = [];
          for (const b of bbs) {
            if (b.__drRow !== undefined && b.__drRow >= lo && b.__drRow <= hi && !byRow.has(b.__drRow)) byRow.set(b.__drRow, b);
            else free.push(b);
          }
          for (let W = lo; W <= hi; W++) {
            let b = byRow.get(W);
            if (!b) {
              b = free.pop();
              if (!b) break;
              b.clear();
              b.__drRow = W;
              paintBillboard(tm, b, W, startX, vx1, pox);
              b.__drX0 = startX;
              b.__drX1 = vx1;
              continue;
            }
            if (startX < b.__drX0 || vx1 > b.__drX1) {
              const nx0 = Math.min(b.__drX0, startX);
              const nx1 = Math.max(b.__drX1, vx1);
              if (nx1 - nx0 > cols * MAX_AREA_SCREENS) {
                b.clear();
                paintBillboard(tm, b, W, startX, vx1, pox);
                b.__drX0 = startX;
                b.__drX1 = vx1;
              } else {
                if (startX < b.__drX0) paintBillboard(tm, b, W, startX, b.__drX0, pox);
                if (vx1 > b.__drX1) paintBillboard(tm, b, W, b.__drX1, vx1, pox);
                b.__drX0 = nx0;
                b.__drX1 = nx1;
              }
            }
          }
        }
        const bx = pox * tw - ox;
        for (const b of bbs) {
          b.position.x = bx;
          b.position.y = (b.__drRow ?? startY) * th - oy;
        }
      };
      const patchTiledTilemapProto = (tm: any) => {
        const TiledProto = tm ? Object.getPrototypeOf(tm) : null;
        if (
          !TiledProto ||
          TiledProto === ShaderTmProto ||
          TiledProto.__drTiledProtoFast ||
          typeof TiledProto._paintTilesLayer !== 'function' ||
          typeof TiledProto._getTextureId !== 'function' ||
          !Array.isArray(tm.tiledData?.layers)
        ) {
          return;
        }
        TiledProto.__drTiledProtoFast = true;
        // Replace Babel `Symbol.iterator` + `try/finally` hot loops in YED_Tiled (OMORI):
        // stock `_getTextureId` allocated an iterator per tile (~2,500x/step) and `_paintTilesLayer`
        // allocated `Array(n).keys()[Symbol.iterator]()` per row/col, while `_updateLayerPositions`
        // iterated 256 hidden `_priorityTiles` every frame setting `sprite.y = NaN`.
        TiledProto._getTextureId = function (this: any, tileId: number) {
          const ts = this.tiledData?.tilesets;
          if (!ts) return 0;
          const len = ts.length;
          for (let i = 0; i < len; i++) {
            const t = ts[i];
            if (tileId >= t.firstgid && tileId < t.firstgid + t.tilecount) return i;
          }
          return len;
        };
        TiledProto._updateLayerPositions = function (this: any, startX: number, startY: number) {
          const ox = this.roundPixels ? Math.floor(this.origin.x) : this.origin.x;
          const oy = this.roundPixels ? Math.floor(this.origin.y) : this.origin.y;
          const baseX = startX * this._tileWidth - ox;
          const baseY = startY * this._tileHeight - oy;
          const layers = this._layers;
          const tLayers = this.tiledData?.layers;
          if (layers && tLayers) {
            for (let i = 0, len = layers.length; i < len; i++) {
              const layer = layers[i];
              const ld = tLayers[layer.layerId];
              layer.position.x = baseX + (ld?.offsetx || 0);
              layer.position.y = baseY + (ld?.offsety || 0);
            }
          }
          const prio = this._priorityTiles;
          if (prio && tLayers) {
            const active = Math.min(prio.length, this._priorityTilesCount || 0);
            for (let i = 0; i < active; i++) {
              const sp = prio[i];
              const ld = tLayers[sp.layerId];
              sp.x = (sp.origX || 0) + baseX + (ld?.offsetx || 0) + sp.width / 2;
              sp.y = (sp.origY || 0) + baseY + (ld?.offsety || 0) + sp.height;
            }
          }
        };
        TiledProto._paintTilesLayer = function (this: any, layer: any, startX: number, startY: number) {
          const tileCols = Math.ceil(this._width / this._tileWidth) + 1;
          const tileRows = Math.ceil(this._height / this._tileHeight) + 1;
          for (let y = 0; y < tileRows; y++) {
            for (let x = 0; x < tileCols; x++) {
              this._paintTile(layer, startX, startY, x, y);
            }
          }
        };
        TiledProto._paintAllTiles = function (this: any, startX: number, startY: number) {
          const prevCount = this.__drTiledPrioInit ? (this._priorityTilesCount || 0) : -1;
          this.__drTiledPrioInit = true;
          this._priorityTilesCount = 0;
          const layers = this._layers;
          if (layers) {
            for (let i = 0, len = layers.length; i < len; i++) {
              const layer = layers[i];
              layer.clear();
              this._paintTiles(layer, startX, startY);
            }
          }
          const tLayers = this.tiledData?.layers;
          if (tLayers && typeof this._paintObjectLayers === 'function') {
            for (let id = 0, len = tLayers.length; id < len; id++) {
              if (tLayers[id]?.type === 'objectgroup') {
                this._paintObjectLayers(id, startX, startY);
              }
            }
          }
          const prio = this._priorityTiles;
          if (prio) {
            const hideEnd = prevCount >= 0 ? Math.min(prio.length, prevCount) : prio.length;
            for (let i = this._priorityTilesCount; i < hideEnd; i++) {
              const sp = prio[i];
              sp.hide?.();
              sp.layerId = -1;
              sp.y = 0;
            }
          }
        };
      };
      // YED_Tiled adds 256 `Sprite_Base` instances (`_priorityTiles`) to `this._tilemap.children` on
      // every map even when 0-5 priority tiles are visible, causing `Tilemap.prototype.update` and
      // `PIXI.Container.prototype.updateTransform` to visit 256 hidden sprites every tick/frame.
      const patchTiledPrioritySprites = (tm: any) => {
        if (!tm || tm.__drPrioSpritesFast) return;
        const prio = tm._priorityTiles;
        if (!Array.isArray(prio) || prio.length === 0) return;
        tm.__drPrioSpritesFast = true;
        for (let i = 0, len = prio.length; i < len; i++) {
          const sp = prio[i];
          if (!sp || sp.__drPrioFast) continue;
          sp.__drPrioFast = true;
          const origUpd = sp.update;
          if (typeof origUpd === 'function') {
            sp.update = function () {
              if (this._hiding && (!this._animationSprites || this._animationSprites.length === 0)) {
                if (this.visible) this.visible = false;
                return;
              }
              return origUpd.call(this);
            };
          }
          const origUT = sp.updateTransform;
          if (typeof origUT === 'function') {
            sp.updateTransform = function () {
              if (!this.visible) return;
              return origUT.call(this);
            };
          }
        }
      };
      const origShaderTmUT = ShaderTmProto.updateTransform;
      ShaderTmProto.updateTransform = function (this: any) {
        // Subclasses like YED_Tiled / PKD_Tiled (`TiledTilemap extends ShaderTilemap`, used by OMORI)
        // override `_createLayers`, `_paintTiles(layer, sx, sy)`, and `_updateLayerPositions` on the
        // subclass prototype using `this._layers` instead of `this.lowerZLayer` / `this.upperZLayer`.
        if (
          !this.lowerZLayer ||
          !this.upperZLayer ||
          this._paintTiles !== ShaderTmProto._paintTiles ||
          this._updateLayerPositions !== ShaderTmProto._updateLayerPositions
        ) {
          if (!this.__drTiledChecked) {
            this.__drTiledChecked = true;
            patchTiledTilemapProto(this);
            patchTiledPrioritySprites(this);
          }
          return origShaderTmUT.apply(this, arguments);
        }
        const ox = this.roundPixels ? Math.floor(this.origin.x) : this.origin.x;
        const oy = this.roundPixels ? Math.floor(this.origin.y) : this.origin.y;
        const tw = this._tileWidth;
        const th = this._tileHeight;
        const startX = Math.floor((ox - this._margin) / tw);
        const startY = Math.floor((oy - this._margin) / th);
        const cols = Math.ceil(this._width / tw) + 1;
        const rows = Math.ceil(this._height / th) + 1;
        let p = this.__drPaint;
        const tf = tfMode && Array.isArray(this.TF_billboards) && suppressBillboards;
        const fullRepaint = () => {
          this._paintAllTiles(startX, startY); // clears both Z layers, paints the view at origin startX/Y
          p = this.__drPaint = { ox: startX, oy: startY, x0: startX, y0: startY, x1: startX + cols, y1: startY + rows, cols, rows };
          this._needsRepaint = false;
          if (tf) {
            // TF's full paint filled billboard i with world row startY+i+1 from the painted rows only;
            // rows whose source rows reach outside [startY, startY+rows) are repainted completely.
            const bbs = this.TF_billboards;
            for (let i = 0; i < bbs.length; i++) {
              const b = bbs[i];
              const W = startY + i + 1;
              b.__drRow = W;
              b.__drX0 = startX;
              b.__drX1 = startX + cols;
              if (W - 3 < startY || W - 1 > startY + rows - 1) {
                b.clear();
                paintBillboard(this, b, W, startX, startX + cols, startX);
              }
            }
            this.__drBBKey = '';
          }
        };
        if (this._needsRepaint || !p || p.cols !== cols || p.rows !== rows) {
          fullRepaint();
        } else if (startX < p.x0 || startY < p.y0 || startX + cols > p.x1 || startY + rows > p.y1) {
          const nx0 = Math.min(p.x0, startX);
          const ny0 = Math.min(p.y0, startY);
          const nx1 = Math.max(p.x1, startX + cols);
          const ny1 = Math.max(p.y1, startY + rows);
          if ((nx1 - nx0) * (ny1 - ny0) > cols * rows * MAX_AREA_SCREENS || layerRects(this) > MAX_LAYER_RECTS) {
            fullRepaint();
          } else {
            const realBB = tf ? this.TF_billboards : null;
            if (tf) this.TF_billboards = suppressBillboards;
            try {
            for (let my = ny0; my < ny1; my++) {
              const rowPainted = my >= p.y0 && my < p.y1;
              for (let mx = nx0; mx < nx1; mx++) {
                if (rowPainted && mx >= p.x0 && mx < p.x1) {
                  mx = p.x1 - 1; // skip the already-painted span of this row
                  continue;
                }
                this._paintTiles(p.ox, p.oy, mx - p.ox, my - p.oy);
                tmIncCells++;
              }
            }
            } finally {
              if (tf) this.TF_billboards = realBB;
            }
            p.x0 = nx0; p.y0 = ny0; p.x1 = nx1; p.y1 = ny1;
          }
        }
        const lx = p.ox * tw - ox;
        const ly = p.oy * th - oy;
        this.lowerZLayer.position.x = lx;
        this.lowerZLayer.position.y = ly;
        this.upperZLayer.position.x = lx;
        this.upperZLayer.position.y = ly;
        if (tf) updateBillboards(this, startX, startY, cols, p.ox, ox, oy);
        this._lastStartX = startX;
        this._lastStartY = startY;
        this._sortChildren();
        ContainerUT.call(this);
      };
      log(
        `[compat] incremental tilemap painting enabled (new rows/columns only while scrolling` +
        `${RectLayerProto?.__drAppendFill ? ', append-only vertex fill' : ''}${tfMode ? ', TF_LayeredMap billboards' : ''})`,
      );
    }
  }
  // 6g3. Fast O(N) nearly-sorted `Tilemap.prototype._sortChildren` (eliminates `.bind(this)` closure
  //      allocation and ~3,500 V8 comparator calls/frame on 400-child maps: `sort=1.4ms/f -> ~0.01ms/f`).
  const BaseTmProto = runtime.Tilemap?.prototype;
  if (
    BaseTmProto &&
    typeof BaseTmProto._sortChildren === 'function' &&
    typeof BaseTmProto._compareChildOrder === 'function' &&
    !BaseTmProto.__drFastSort
  ) {
    const sortSrc = String(BaseTmProto._sortChildren);
    if (sortSrc.includes('this.children.sort') && sortSrc.includes('_compareChildOrder')) {
      BaseTmProto.__drFastSort = true;
      const origCompare = BaseTmProto._compareChildOrder;
      const cmpSrc = String(origCompare);
      const isStockCompare =
        cmpSrc.includes('a.z !== b.z') &&
        cmpSrc.includes('a.y !== b.y') &&
        cmpSrc.includes('a.spriteId - b.spriteId');
      const stockCompareFn = (a: any, b: any): number => {
        if (a.z !== b.z) return a.z - b.z;
        if (a.y !== b.y) return a.y - b.y;
        return a.spriteId - b.spriteId;
      };
      BaseTmProto._sortChildren = function (this: any) {
        const kids = this.children;
        const len = kids ? kids.length : 0;
        if (len <= 1) return;
        if (!isStockCompare || this._compareChildOrder !== origCompare) {
          let sorted = true;
          for (let i = 1; i < len; i++) {
            if (this._compareChildOrder(kids[i - 1], kids[i]) > 0) {
              sorted = false;
              break;
            }
          }
          if (sorted) return;
          let bound = this.__drBoundCompare;
          if (!bound || this.__drBoundCompareFn !== this._compareChildOrder) {
            this.__drBoundCompareFn = this._compareChildOrder;
            bound = this.__drBoundCompare = this._compareChildOrder.bind(this);
          }
          kids.sort(bound);
          return;
        }
        const first = kids[0];
        let pz = first.z;
        let py = first.y;
        let pid = first.spriteId;
        if (pz === pz && py === py && pid === pid) {
          let sorted = true;
          let allFinite = true;
          let failIdx = 1;
          for (let i = 1; i < len; i++) {
            const cur = kids[i];
            const cz = cur.z;
            const cy = cur.y;
            const cid = cur.spriteId;
            if (!(cz === cz && cy === cy && cid === cid)) {
              allFinite = false;
              sorted = false;
              break;
            }
            if (pz !== cz ? pz > cz : py !== cy ? py > cy : pid > cid) {
              sorted = false;
              failIdx = i;
              break;
            }
            pz = cz;
            py = cy;
            pid = cid;
          }
          if (sorted) return;
          if (allFinite) {
            for (let i = failIdx + 1; i < len; i++) {
              const c = kids[i];
              if (!(c.z === c.z && c.y === c.y && c.spriteId === c.spriteId)) {
                allFinite = false;
                break;
              }
            }
          }
          if (allFinite) {
            let inv = 0;
            for (let i = failIdx; i < len; i++) {
              const cur = kids[i];
              const cz = cur.z;
              const cy = cur.y;
              const cid = cur.spriteId;
              let j = i - 1;
              while (j >= 0) {
                const p = kids[j];
                const d = p.z !== cz ? p.z - cz : p.y !== cy ? p.y - cy : p.spriteId - cid;
                if (d <= 0) break;
                kids[j + 1] = p;
                j--;
                if (++inv > 256) {
                  kids[j + 1] = cur;
                  kids.sort(stockCompareFn);
                  return;
                }
              }
              kids[j + 1] = cur;
            }
            return;
          }
        }
        kids.sort(stockCompareFn);
      };
    }
  }

  // 6g4. Direct-to-GPU hoisted `RectTileLayer` & `CompositeRectTileLayer` `renderCanvas` (`directGPU` mode):
  //      NOTE: Do NOT bake layers onto offscreen `<canvas>` surfaces here — in `nx.js` (`directGPU=true`),
  //      `GameCanvas` is a Vulkan GPU `SkSurface` whereas `document.createElement('canvas')` is a CPU raster
  //      surface, so blitting 10 full-screen `672x512` raster canvases uploaded ~14 MB/frame from CPU RAM to
  //      Vulkan! Drawing directly from immutable `<img>` (`SkImage` cached in VRAM) with hoisted `ctx`,
  //      `tileAnim`, and cached `baseTexture.source` (plus skipping empty layers & per-layer CSS `fillStyle`)
  //      keeps everything on the GPU with zero texture uploads.
  const CanvasCompLayerProto = !isWebGLMode ? PIXI?.tilemap?.CompositeRectTileLayer?.prototype : null;
  if (
    CanvasCompLayerProto &&
    typeof CanvasCompLayerProto.renderCanvas === 'function' &&
    !CanvasCompLayerProto.__drDirectCompFast
  ) {
    const ccSrc = String(CanvasCompLayerProto.renderCanvas);
    if (ccSrc.includes('dontUseTransform') && ccSrc.includes('setTransform')) {
      CanvasCompLayerProto.__drDirectCompFast = true;
      const origCompRenderCanvas = CanvasCompLayerProto.renderCanvas;
      CanvasCompLayerProto.renderCanvas = function (this: any, renderer: any) {
        const layers = this.children;
        if (!layers || layers.length === 0) return;
        let hasPoints = false;
        for (let i = 0, len = layers.length; i < len; i++) {
          if (layers[i]?.pointsBuf?.length > 0) {
            hasPoints = true;
            break;
          }
        }
        if (!hasPoints) return;
        return origCompRenderCanvas.call(this, renderer);
      };
    }
  }
  const CanvasRectLayerProto = !isWebGLMode ? PIXI?.tilemap?.RectTileLayer?.prototype : null;
  if (
    CanvasRectLayerProto &&
    typeof CanvasRectLayerProto.renderCanvas === 'function' &&
    !CanvasRectLayerProto.__drDirectCanvasFast
  ) {
    const rcSrc = String(CanvasRectLayerProto.renderCanvas);
    if (rcSrc.includes('pointsBuf') && rcSrc.includes('drawImage')) {
      CanvasRectLayerProto.__drDirectCanvasFast = true;
      const origRlRenderCanvas = CanvasRectLayerProto.renderCanvas;
      CanvasRectLayerProto.renderCanvas = function (this: any, renderer: any) {
        const points = this.pointsBuf;
        const texs = this.textures;
        if (!points || points.length === 0 || !texs || texs.length === 0) return;
        const ctx = renderer?.context;
        const tileAnim = renderer?.plugins?.tilemap?.tileAnim;
        if (!ctx || !tileAnim) return origRlRenderCanvas.call(this, renderer);
        const hasAnim = Boolean(this.hasAnim);
        const anim0 = hasAnim ? tileAnim[0] : 0;
        const anim1 = hasAnim ? tileAnim[1] : 0;
        let lastTexId = -2;
        let lastSrc: any = null;
        let fillSet = false;
        for (let i = 0, n = points.length; i < n; i += 9) {
          const texId = points[i + 8];
          const x2 = points[i + 2];
          const y2 = points[i + 3];
          const w = points[i + 4];
          const h = points[i + 5];
          if (texId === lastTexId) {
            if (lastSrc) {
              const x1 = hasAnim ? points[i] + points[i + 6] * anim0 : points[i];
              const y1 = hasAnim ? points[i + 1] + points[i + 7] * anim1 : points[i + 1];
              ctx.drawImage(lastSrc, x1, y1, w, h, x2, y2, w, h);
            }
            continue;
          }
          if (texId >= 0 && texs[texId] !== undefined) {
            lastTexId = texId;
            lastSrc = texs[texId].baseTexture?.source ?? null;
            if (lastSrc) {
              const x1 = hasAnim ? points[i] + points[i + 6] * anim0 : points[i];
              const y1 = hasAnim ? points[i + 1] + points[i + 7] * anim1 : points[i + 1];
              ctx.drawImage(lastSrc, x1, y1, w, h, x2, y2, w, h);
            }
          } else {
            if (!fillSet) {
              ctx.fillStyle = '#000000';
              fillSet = true;
            }
            ctx.globalAlpha = 0.5;
            ctx.fillRect(x2, y2, w, h);
            ctx.globalAlpha = 1;
          }
        }
      };
    }
  }

  // 6h. Prevent double-tick frame cascade in SceneManager.updateMain (1 update tick per rendered frame)
  //     and emit concise [perf] + [perf-map] timing telemetry + live PRO HUD metrics.
  let mapTicks = 0;
  let mapGameMapMs = 0;
  let mapRefreshMs = 0;
  let mapEventsMs = 0;
  let mapCommonEvMs = 0;
  let mapScreenMs = 0;
  let mapSpritesetMs = 0;
  // Spriteset breakdown (only sampled while profiling is active): characters, pictures, tilemap update,
  // and tilemap repaint/transform during render.
  let ssCharMs = 0;
  let ssPicMs = 0;
  let ssTmUpdMs = 0;
  let ssTmXformMs = 0;
  let ssTmXformFrames = 0;
  // Tilemap breakdown: full repaints (_paintAllTiles on every tile-boundary crossing) vs child sorting,
  // plus frame hitches (>33 ms) so movement stutter shows up even when the 5 s average looks fine.
  let tmPaintCount = 0;
  let tmPaintMs = 0;
  let tmPaintMax = 0;
  let tmSortMs = 0;
  let hitchFrames = 0;
  let hitchMax = 0;
  const timeProto = (proto: any, key: string, add: (dt: number) => void) => {
    const orig = proto?.[key];
    if (typeof orig !== 'function' || orig.__drSsTime) return;
    const w = function (this: any) {
      if (!isProfActiveRef()) return orig.apply(this, arguments);
      const s = performance.now();
      try {
        return orig.apply(this, arguments);
      } finally {
        add(performance.now() - s);
      }
    };
    (w as any).__drSsTime = true;
    proto[key] = w;
  };
  let isProfActiveRef: () => boolean = () => false;
  timeProto(runtime.Sprite_Character?.prototype, 'update', (dt) => { ssCharMs += dt; });
  timeProto(runtime.Sprite_Picture?.prototype, 'update', (dt) => { ssPicMs += dt; });
  for (const tmName of ['Tilemap', 'ShaderTilemap']) {
    const TmP = runtime[tmName]?.prototype;
    if (!TmP || !Object.prototype.hasOwnProperty.call(TmP, 'update')) continue;
    timeProto(TmP, 'update', (dt) => { ssTmUpdMs += dt; });
  }
  for (const tmName of ['Tilemap', 'ShaderTilemap']) {
    const TmP = runtime[tmName]?.prototype;
    if (!TmP || !Object.prototype.hasOwnProperty.call(TmP, 'updateTransform')) continue;
    timeProto(TmP, 'updateTransform', (dt) => { ssTmXformMs += dt; ssTmXformFrames++; });
  }
  for (const tmName of ['Tilemap', 'ShaderTilemap']) {
    const TmP = runtime[tmName]?.prototype;
    if (!TmP) continue;
    if (Object.prototype.hasOwnProperty.call(TmP, '_paintAllTiles')) {
      timeProto(TmP, '_paintAllTiles', (dt) => {
        tmPaintCount++;
        tmPaintMs += dt;
        if (dt > tmPaintMax) tmPaintMax = dt;
      });
    }
    if (Object.prototype.hasOwnProperty.call(TmP, '_sortChildren')) {
      timeProto(TmP, '_sortChildren', (dt) => { tmSortMs += dt; });
    }
  }
  let mapSpritesetTicks = 0;
  let mapWindowMs = 0;
  let mapTotalMs = 0;

  // Live 250ms PRO HUD accumulators & 48-frame ring buffer
  let hudFrames = 0;
  let hudLastMs = performance.now();
  let hudPrevFrameMs = performance.now();
  let hudUpdSum = 0;
  let hudMapTicks = 0;
  let hudGmMs = 0;
  let hudEvMs = 0;
  let hudSsMs = 0;
  let hudSsTicks = 0;
  let hudWinMs = 0;
  let hudPrevGlDraws = 0;
  const HUD_HIST_LEN = 48;
  const hudFrameHist = new Float32Array(HUD_HIST_LEN);
  let hudFrameHistHead = 0;

  const isProfActive = () => perfLogCount < 12 || runtime.__drHudMode === 'pro';
  isProfActiveRef = isProfActive;

  const GameMapProto = runtime.Game_Map?.prototype;
  if (GameMapProto?.update && !GameMapProto.__drProf) {
    GameMapProto.__drProf = true;
    const origGM = GameMapProto.update;
    GameMapProto.update = function () {
      if (!isProfActive()) return origGM.apply(this, arguments);
      const t0 = performance.now();
      const res = origGM.apply(this, arguments);
      const dt = performance.now() - t0;
      mapGameMapMs += dt;
      hudGmMs += dt;
      return res;
    };
    if (typeof GameMapProto.refreshIfNeeded === 'function') {
      const origRefNeed = GameMapProto.refreshIfNeeded;
      GameMapProto.refreshIfNeeded = function () {
        if (!isProfActive()) return origRefNeed.apply(this, arguments);
        const t0 = performance.now();
        const res = origRefNeed.apply(this, arguments);
        mapRefreshMs += performance.now() - t0;
        return res;
      };
    }
    if (typeof GameMapProto.updateEvents === 'function') {
      const origUpdEv = GameMapProto.updateEvents;
      GameMapProto.updateEvents = function () {
        if (!isProfActive()) return origUpdEv.apply(this, arguments);
        const t0 = performance.now();
        const res = origUpdEv.apply(this, arguments);
        const dt = performance.now() - t0;
        mapEventsMs += dt;
        hudEvMs += dt;
        return res;
      };
    }
  }
  const GameCommonEventProto = runtime.Game_CommonEvent?.prototype;
  if (GameCommonEventProto?.update && !GameCommonEventProto.__drProf) {
    GameCommonEventProto.__drProf = true;
    const origCE = GameCommonEventProto.update;
    GameCommonEventProto.update = function () {
      if (!isProfActive()) return origCE.apply(this, arguments);
      const t0 = performance.now();
      const res = origCE.apply(this, arguments);
      mapCommonEvMs += performance.now() - t0;
      return res;
    };
  }
  const GameScreenProto = runtime.Game_Screen?.prototype;
  if (GameScreenProto?.update && !GameScreenProto.__drProf) {
    GameScreenProto.__drProf = true;
    const origGS = GameScreenProto.update;
    GameScreenProto.update = function () {
      if (!isProfActive()) return origGS.apply(this, arguments);
      const t0 = performance.now();
      const res = origGS.apply(this, arguments);
      mapScreenMs += performance.now() - t0;
      return res;
    };
  }
  const SpritesetMapProto = runtime.Spriteset_Map?.prototype;
  let skipSpritesetThisTick = false;
  let liplySkipArmed = false;
  if (SpritesetMapProto?.update && !SpritesetMapProto.__drProf) {
    SpritesetMapProto.__drProf = true;
    const origSM = SpritesetMapProto.update;
    SpritesetMapProto.update = function () {
      // Discover IIFE-scoped Lightmask / Lighting overlays & ponidog_BackLog attached to Spriteset_Map
      if (!this.__drLmScanned) {
        this.__drLmScanned = true;
        if (this._lightmask) patchLightmaskObject(this._lightmask, 'spriteset._lightmask');
        if (this._lighting) patchLightmaskObject(this._lighting, 'spriteset._lighting');
        if (this._lightMask) patchLiplyLightMaskSprite(this._lightMask);
        // ponidog_BackLog_utf8.js calls `this._BackLog.redraw()` every frame even when hidden,
        // clearing & filling a full-screen 1280x720 bitmap 60x/sec (~3ms/tick!). Skip when invisible.
        const bl = this._BackLog;
        if (bl && typeof bl.redraw === 'function' && !bl.__drHiddenSkip) {
          const blProto = Object.getPrototypeOf(bl);
          const target = blProto && typeof blProto.redraw === 'function' ? blProto : bl;
          if (!target.__drHiddenSkip) {
            target.__drHiddenSkip = true;
            const origBlRedraw = target.redraw;
            target.redraw = function () {
              if (typeof this.updateVisibility === 'function') this.updateVisibility();
              if (!this.visible) return;
              return origBlRedraw.call(this);
            };
          }
          bl.__drHiddenSkip = true;
        }
        const scanChildren = (node: any, depth: number) => {
          if (!node || depth > 2 || !Array.isArray(node.children)) return;
          for (let i = 0; i < node.children.length; i++) {
            const ch = node.children[i];
            if (ch && typeof ch._updateMask === 'function') {
              patchLightmaskObject(ch, ch.constructor?.name || 'child._updateMask');
            }
            scanChildren(ch, depth + 1);
          }
        };
        scanChildren(this, 0);
      }
      if (skipSpritesetThisTick) return;
      const runSm = () => {
        if (!isProfActive()) return origSM.apply(this, arguments);
        const t0 = performance.now();
        const res = origSM.apply(this, arguments);
        const dt = performance.now() - t0;
        mapSpritesetMs += dt;
        mapSpritesetTicks++;
        hudSsMs += dt;
        hudSsTicks++;
        return res;
      };
      const out = runSm();
      // Throttle `liply_MobileLight` (`if (Graphics._skipCount === 0) updateLights(...)` right after
      // Scene_Map_update) to 30Hz while moving / 15Hz while stationary.
      const lMask = this._lightMask;
      if (lMask?.__drLiplyFast && Graphics && Graphics._skipCount === 0) {
        patchLiplyLightMaskSprite(lMask);
        const gm = runtime.$gameMap;
        const gp = runtime.$gamePlayer;
        const dx = gm?._displayX ?? 0;
        const dy = gm?._displayY ?? 0;
        const px = gp?._realX ?? 0;
        const py = gp?._realY ?? 0;
        const moved = dx !== this._drLmDX || dy !== this._drLmDY || px !== this._drLmPX || py !== this._drLmPY;
        const fc = Graphics.frameCount || 0;
        const interval = moved ? 2 : 4;
        if (this._drLmReady && (fc % interval) !== 0) {
          Graphics._skipCount = 1;
          liplySkipArmed = true;
        } else {
          this._drLmDX = dx;
          this._drLmDY = dy;
          this._drLmPX = px;
          this._drLmPY = py;
          this._drLmReady = true;
        }
      }
      return out;
    };
  }
  const SceneMapProto = runtime.Scene_Map?.prototype;
  if (SceneMapProto?.update && !SceneMapProto.__drProf) {
    SceneMapProto.__drProf = true;
    const origSceneMapUpdate = SceneMapProto.update;
    SceneMapProto.update = function () {
      liplySkipArmed = false;
      try {
        if (!isProfActive()) return origSceneMapUpdate.apply(this, arguments);
        const t0 = performance.now();
        const res = origSceneMapUpdate.apply(this, arguments);
        mapTotalMs += performance.now() - t0;
        mapTicks++;
        hudMapTicks++;
        return res;
      } finally {
        if (liplySkipArmed && Graphics) {
          Graphics._skipCount = 0;
          liplySkipArmed = false;
        }
      }
    };
  }
  if (WindowLayerProto?.update && !WindowLayerProto.__drProf) {
    WindowLayerProto.__drProf = true;
    const origWLUpd = WindowLayerProto.update;
    WindowLayerProto.update = function () {
      if (!isProfActive()) return origWLUpd.apply(this, arguments);
      const t0 = performance.now();
      const res = origWLUpd.apply(this, arguments);
      const dt = performance.now() - t0;
      mapWindowMs += dt;
      hudWinMs += dt;
      return res;
    };
  }

  function installFastJsonEx(): void {
    const J = runtime.JsonEx;
    if (!J || J.__drFast || typeof J._encode !== 'function' || typeof J._decode !== 'function') return;
    const encSrc = String(J._encode);
    const decSrc = String(J._decode);
    // Stock MV 1.6 encoder / decoder (no plugin wrapping them)?
    const encStock = encSrc.includes("'@c'") && encSrc.includes('_generateId') &&
      String(J.stringify).includes('_encode(') && String(J.stringify).includes('_restoreCircularReference');
    const decStock = decSrc.includes('_resetPrototype') && decSrc.includes("'@a'") &&
      String(J.parse).includes('_decode(JSON.parse(');
    // A plugin may wrap _decode (e.g. a Spine plugin fixing Game_Spine objects after the stock decode):
    // then keep the game's decode chain and only swap the slow Object.setPrototypeOf step.
    const resetHook = !decStock && typeof J._resetPrototype === 'function' &&
      typeof J._linkCircularReference === 'function';
    if (!encStock && !decStock && !resetHook) {
      const brief = (s: string) => s.replace(/\s+/g, ' ').slice(0, 220);
      log('[compat] JsonEx differs from stock MV 1.6; keeping stock save/load code');
      log(`[compat]   JsonEx._encode: ${brief(encSrc)}`);
      log(`[compat]   JsonEx._decode: ${brief(decSrc)}`);
      return;
    }
    J.__drFast = true;
    const hasOwn = Object.prototype.hasOwnProperty;
    const toStr = Object.prototype.toString;
    const META = /^@./;
    const FALLBACK = {};
    const origStringify = J.stringify;
    const origParse = J.parse;

    if (encStock) J.stringify = function (object: any) {
      try {
        const ids = new Map<any, number>();
        let nextId = 1;
        const maxDepth = Number(J.maxDepth) || 100;
        const enc = (value: any, depth: number): any => {
          if (++depth >= maxDepth) throw new Error('Object too deep');
          const type = toStr.call(value);
          if (type !== '[object Object]' && type !== '[object Array]') return value;
          if (typeof value.toJSON === 'function') throw FALLBACK;
          const id = nextId++;
          ids.set(value, id);
          const isArr = type === '[object Array]';
          const out: any = isArr ? new Array(value.length) : {};
          for (const key in value) {
            if (!hasOwn.call(value, key)) continue;
            const v = value[key];
            if (META.test(key)) { out[key] = v; continue; }
            if (v && typeof v === 'object') {
              const seen = ids.get(v);
              if (seen) {
                out[key] = { '@r': seen };
              } else {
                const e = enc(v, depth + 1);
                if (Array.isArray(v)) {
                  out[key] = { '@c': ids.get(v), '@a': e };
                } else {
                  out[key] = e;
                }
              }
            } else {
              out[key] = enc(v, depth + 1);
            }
          }
          if (!isArr) {
            out['@c'] = id;
            const cname = J._getConstructorName(value);
            if (cname !== 'Object' && cname !== 'Array') out['@'] = cname;
          }
          return out;
        };
        J._id = 1;
        return JSON.stringify(enc(object, 0));
      } catch (err) {
        if (err === FALLBACK) return origStringify.call(this, object);
        throw err;
      }
    };

    if (decStock) J.parse = function (json: string) {
      const circular: any[] = [];
      const registry: Record<string, any> = {};
      const dec = (value: any, regId?: any): any => {
        const type = toStr.call(value);
        if (type !== '[object Object]' && type !== '[object Array]') return value;
        if (type === '[object Object]') {
          let proto = Object.prototype;
          const cname = value['@'];
          if (cname) {
            const ctor = runtime[cname];
            if (typeof ctor === 'function' && ctor.prototype) proto = ctor.prototype;
          }
          const fresh = Object.create(proto);
          for (const key in value) {
            if (!hasOwn.call(value, key) || key === '@' || key === '@c') continue;
            if (key in fresh) {
              Object.defineProperty(fresh, key, { value: value[key], writable: true, enumerable: true, configurable: true });
            } else {
              fresh[key] = value[key];
            }
          }
          registry[value['@c']] = fresh;
          value = fresh;
        } else if (regId !== undefined) {
          registry[regId] = value;
        }
        for (const key in value) {
          if (!hasOwn.call(value, key)) continue;
          let v = value[key];
          let wrapId: any;
          if (v && v['@a']) {
            wrapId = v['@c'];
            v = v['@a'];
            value[key] = v;
          }
          if (v && v['@r']) circular.push([key, value, v['@r']]);
          value[key] = dec(v, wrapId);
        }
        return value;
      };
      try {
        const contents = dec(JSON.parse(json));
        for (const c of circular) c[1][c[0]] = registry[c[2]];
        return contents;
      } catch (err) {
        log(`[compat] fast JsonEx.parse failed (${String(err)}); using stock parser`);
        return origParse.call(this, json);
      }
    };
    if (resetHook) {
      // Object.create(proto) + copy instead of Object.setPrototypeOf (6x slower objects in jitless V8).
      // The stock decoder registers each object for circular references *before* resetting its
      // prototype, so remap the registry to the fresh copies before links are restored.
      const fresher = new WeakMap<object, object>();
      const origReset = J._resetPrototype;
      J._resetPrototype = function (value: any, prototype: any) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !prototype) {
          return origReset.apply(this, arguments);
        }
        const fresh = Object.create(prototype);
        for (const key in value) {
          if (!hasOwn.call(value, key) || key === '@' || key === '@c') continue;
          if (key in fresh) {
            Object.defineProperty(fresh, key, { value: value[key], writable: true, enumerable: true, configurable: true });
          } else {
            fresh[key] = value[key];
          }
        }
        fresher.set(value, fresh);
        return fresh;
      };
      const origLink = J._linkCircularReference;
      J._linkCircularReference = function (contents: any, circulars: any, registry: any) {
        if (registry && typeof registry === 'object') {
          for (const id in registry) {
            const r = registry[id];
            const f = r && typeof r === 'object' ? fresher.get(r) : undefined;
            if (f) registry[id] = f;
          }
        }
        return origLink.apply(this, arguments);
      };
    }
  }

  // 6j. Scene-transition profiler (menu open / map restore). Wraps scene create*/start methods, Window_*
  //     constructors + refresh, Spriteset_Map builders and Bitmap drawing; only logs transitions that
  //     actually take noticeable time (>= 250ms) so fast transitions keep debug.log clean.
  const transitionProf = {
    active: false,
    label: '',
    t0: 0,
    frames: 0,
    items: new Map<string, { ms: number; n: number }>(),
    logged: 0,
    begin(label: string) {
      if (this.logged >= 8) return;
      this.active = true;
      this.label = label;
      this.t0 = performance.now();
      this.frames = 0;
      this.items.clear();
    },
    end(extraSuffix = '') {
      if (!this.active) return;
      this.active = false;
      const total = performance.now() - this.t0;
      if (total < 250) return;
      this.logged++;
      const top = [...this.items.entries()]
        .filter(([, v]) => v.ms >= 6)
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 10)
        .map(([k, v]) => `${k}=${v.ms.toFixed(0)}ms${v.n > 1 ? `x${v.n}` : ''}`);
      log(
        `[prof] ${this.label}${extraSuffix ? ` (${extraSuffix})` : ''}: ` +
        `total=${total.toFixed(0)}ms frames=${this.frames}${top.length ? ` | ${top.join(' ')}` : ''}`,
      );
    },
  };
  function installTransitionProfiler(): void {
    const wrap = (obj: any, key: string, label: string) => {
      let orig: any;
      try { orig = obj[key]; } catch { return; }
      if (typeof orig !== 'function' || orig.__drTp) return;
      const w = function (this: any) {
        if (!transitionProf.active) return orig.apply(this, arguments);
        const s = performance.now();
        try {
          return orig.apply(this, arguments);
        } finally {
          const dt = performance.now() - s;
          let it = transitionProf.items.get(label);
          if (!it) transitionProf.items.set(label, (it = { ms: 0, n: 0 }));
          it.ms += dt;
          it.n++;
        }
      };
      (w as any).__drTp = true;
      try { obj[key] = w; } catch { /* ignore */ }
    };
    const ownFns = (proto: any): string[] => {
      try {
        return Object.getOwnPropertyNames(proto).filter((k) => {
          if (k === 'constructor') return false;
          const d = Object.getOwnPropertyDescriptor(proto, k);
          return Boolean(d && typeof d.value === 'function' && d.writable);
        });
      } catch {
        return [];
      }
    };
    for (const name of Object.getOwnPropertyNames(runtime)) {
      let C: any;
      try { C = runtime[name]; } catch { continue; }
      if (typeof C !== 'function' || !C.prototype) continue;
      const proto = C.prototype;
      if (/^Scene_/.test(name)) {
        for (const k of ownFns(proto)) {
          if (/^(create|start|onMapLoaded|terminate|refresh|load|initialize)/.test(k)) {
            wrap(proto, k, `${name}.${k}`);
          }
        }
      } else if (/^Window_/.test(name)) {
        for (const k of ['initialize', 'refresh', 'drawAllItems', 'drawItem', 'drawFace', 'drawActorFace']) {
          if (Object.prototype.hasOwnProperty.call(proto, k)) {
            wrap(proto, k, `${name}.${k}`);
          }
        }
      } else if (/^Spriteset_/.test(name)) {
        for (const k of ownFns(proto)) {
          if (/^(create|initialize|load)/.test(k)) {
            wrap(proto, k, `${name}.${k}`);
          }
        }
      }
    }
    const BmpP = runtime.Bitmap?.prototype;
    if (BmpP) {
      for (const k of ['initialize', 'drawText', 'blt', 'fillRect', 'gradientFillRect', 'clear', 'resize']) {
        wrap(BmpP, k, `Bitmap.${k}`);
      }
    }
    const IM = runtime.ImageManager;
    if (IM) {
      for (const k of ['loadBitmap', 'loadNormalBitmap', 'reserveBitmap']) wrap(IM, k, `ImageManager.${k}`);
    }
    if (runtime.DataManager) wrap(runtime.DataManager, 'loadMapData', 'DataManager.loadMapData');
    if (SceneManager) wrap(SceneManager, 'snapForBackground', 'SceneManager.snapForBackground');
    if (typeof SceneManager?.renderScene === 'function') {
      const origRender = SceneManager.renderScene;
      SceneManager.renderScene = function () {
        if (transitionProf.active) transitionProf.frames++;
        return origRender.apply(this, arguments);
      };
    }
  }

  function installFastMenuRoundTrip(): void {
    const SceneMapP = runtime.Scene_Map?.prototype;
    const DM = runtime.DataManager;
    if (options?.fastMenu === false) {
      log('[fastmenu] disabled by mv-loader.json');
      return;
    }
    if (!SceneMapP || !DM || typeof DM.loadMapData !== 'function' || SceneMapP.__drFastMenu) return;
    if (typeof SceneMapP.create !== 'function' || typeof SceneMapP.terminate !== 'function') return;
    SceneMapP.__drFastMenu = true;

    type Trip = {
      gameMap: any;
      mapId: number;
      tilesetId: number;
      data: any;
      mapLoader?: any;
      tempTiledData?: any;
      tiledLoaded?: any;
      tilesetToLoad?: any;
      spriteset: any;
      baseline: Map<any, Set<any>> | null;
      extras: Array<{ parent: any; child: any }>;
    };
    let trip: Trip | null = null;
    let reuseData: Trip | null = null;

    // Spriteset reuse. With the stock Scene_Map.createSpriteset we simply re-attach the cached spriteset.
    // When a plugin replaced createSpriteset (its override may store extra layers on the *scene*, so it
    // must still run), we instead make the next `new Spriteset_Map()` inside it return the cached
    // instance, by swapping the global constructor for a thin wrapper sharing the same prototype.
    const csSrc = String(SceneMapP.createSpriteset || '').replace(/\s+/g, '');
    const coreCreateSpriteset =
      /^function(createSpriteset)?\(\)\{this\._spriteset=newSpriteset_Map\(\);?this\.addChild\(this\._spriteset\);?\}$/.test(csSrc);
    let pendingSpriteset: any = null;
    let ctorWrapped = false;
    const OrigSpritesetMap = runtime.Spriteset_Map;
    if (!coreCreateSpriteset && typeof OrigSpritesetMap === 'function' && !OrigSpritesetMap.__drFastMenuCtor) {
      const Wrapped: any = function (this: any, ...args: any[]) {
        const reuse = pendingSpriteset;
        pendingSpriteset = null;
        if (reuse) return reuse;
        const obj = Reflect.construct(OrigSpritesetMap, args, new.target || Wrapped);
        try { obj.__drBaseline = snapshotTree(obj); } catch { /* ignore */ }
        return obj;
      };
      Wrapped.prototype = OrigSpritesetMap.prototype;
      Object.setPrototypeOf(Wrapped, OrigSpritesetMap);  // inherit static members
      try { Object.defineProperty(Wrapped, 'name', { value: OrigSpritesetMap.name || 'Spriteset_Map' }); } catch { /* ignore */ }
      Wrapped.__drFastMenuCtor = true;
      try {
        runtime.Spriteset_Map = Wrapped;
        ctorWrapped = runtime.Spriteset_Map === Wrapped;
      } catch {
        ctorWrapped = false;
      }
    }
    const canReuseSpriteset =
      (coreCreateSpriteset || ctorWrapped) && typeof SceneMapP.start === 'function' &&
      typeof SceneMapP.createSpriteset === 'function';

    // Snapshot the spriteset's own children (2 levels) right after it was built, so children that
    // scene-level plugin code attaches later (createDisplayObjects / onMapLoaded / start) can be told apart.
    const snapshotTree = (root: any): Map<any, Set<any>> => {
      const m = new Map<any, Set<any>>();
      const walk = (node: any, depth: number) => {
        if (!node || !Array.isArray(node.children)) return;
        m.set(node, new Set(node.children));
        if (depth < 1) for (let i = 0; i < node.children.length; i++) walk(node.children[i], depth + 1);
      };
      walk(root, 0);
      return m;
    };
    const collectExtras = (
      baseline: Map<any, Set<any>> | null,
      exclude?: Array<{ parent: any; child: any }>,
    ): Array<{ parent: any; child: any }> => {
      const out: Array<{ parent: any; child: any }> = [];
      if (!baseline) return out;
      const ex = new Set((exclude || []).map((e) => e.child));
      baseline.forEach((kids, parent) => {
        const ch = parent?.children;
        if (!Array.isArray(ch)) return;
        for (let i = 0; i < ch.length; i++) {
          const c = ch[i];
          if (!kids.has(c) && !ex.has(c)) out.push({ parent, child: c });
        }
      });
      return out;
    };

    const origLoadMapData = DM.loadMapData;
    DM.loadMapData = function (mapId: number) {
      const r = reuseData;
      if (r && r.data && mapId === r.mapId) {
        reuseData = null;
        runtime.$dataMap = r.data;
        if (r.mapLoader !== undefined) DM._mapLoader = r.mapLoader;
        if (r.tempTiledData !== undefined) DM._tempTiledData = r.tempTiledData;
        if (r.tiledLoaded !== undefined) DM._tiledLoaded = r.tiledLoaded;
        if (r.tilesetToLoad !== undefined) DM._tilesetToLoad = r.tilesetToLoad;
        return;
      }
      return origLoadMapData.apply(this, arguments);
    };

    const origCreate = SceneMapP.create;
    SceneMapP.create = function () {
      const t = trip;
      trip = null;
      const gm = runtime.$gameMap;
      const ok = Boolean(
        t &&
        gm &&
        t.gameMap === gm &&
        !runtime.$gamePlayer?.isTransferring?.() &&
        gm.mapId?.() === t.mapId &&
        t.data,
      );
      this.__drTripT0 = performance.now();
      this.__drTrip = ok ? t : null;
      transitionProf.begin(ok ? 'map restore after menu' : 'map load');
      reuseData = ok ? t : null;
      try {
        return origCreate.apply(this, arguments);
      } finally {
        reuseData = null;
      }
    };

    if (canReuseSpriteset) {
      const origCreateSpriteset = SceneMapP.createSpriteset;
      SceneMapP.createSpriteset = function () {
        const t: Trip | null = this.__drTrip;
        const ss = t?.spriteset;
        const ok = Boolean(
          t &&
          ss &&
          !ss._destroyed &&
          Array.isArray(ss.children) &&
          !ss.parent &&
          runtime.$gameMap?.tilesetId?.() === t.tilesetId,
        );
        if (ok && coreCreateSpriteset) {
          this._spriteset = ss;
          this.addChild(ss);
          this.__drSpritesetReused = true;
          return;
        }
        pendingSpriteset = ok ? ss : null;
        try {
          origCreateSpriteset.apply(this, arguments);
        } finally {
          pendingSpriteset = null;
        }
        const cur = this._spriteset;
        this.__drSpritesetReused = Boolean(ok && cur === ss);
        if (cur && !this.__drSpritesetReused && !cur.__drBaseline) {
          try { cur.__drBaseline = snapshotTree(cur); } catch { /* ignore */ }
        }
        if (!this.__drSpritesetReused) this.__drBaseline = cur?.__drBaseline || null;
      };
    }

    const origStart = SceneMapP.start;
    if (typeof origStart === 'function') {
      SceneMapP.start = function () {
        const res = origStart.apply(this, arguments);
        const t: Trip | null = this.__drTrip;
        try {
          if (this.__drSpritesetReused && t) {
            this.__drBaseline = t.baseline || this._spriteset?.__drBaseline || null;
            // Re-attach Live2D Sprite_Live2d children (`enc_lv2d.js`) if Spriteset_ForLive2d moved them to a menu scene!
            const ss = this._spriteset;
            const l2dHash = ss?.live2dSpriteHash;
            const picKids = ss?._pictureContainer?.children;
            if (l2dHash && Array.isArray(picKids)) {
              for (const k of Object.keys(l2dHash)) {
                const l2dSp = l2dHash[k];
                if (!l2dSp) continue;
                const pid = l2dSp._pictureId ?? l2dSp.pictureId;
                if (typeof pid === 'number') {
                  for (let pi = 0; pi < picKids.length; pi++) {
                    const pSp = picKids[pi];
                    if (pSp && pSp._pictureId === pid && l2dSp.parent !== pSp) {
                      pSp.addChild(l2dSp);
                      break;
                    }
                  }
                }
              }
            }
            // Children attached by scene-level plugin code on the first build: if that code attached fresh
            // ones again this time, the old ones are stale duplicates (no longer updated) -> remove them.
            const fresh = collectExtras(this.__drBaseline, t.extras);
            if (fresh.length > 0 && t.extras.length > 0) {
              for (const e of t.extras) {
                try { e.parent?.removeChild?.(e.child); } catch { /* ignore */ }
              }
              this.__drExtras = fresh;
            } else {
              this.__drExtras = t.extras.concat(fresh);
            }
          } else if (canReuseSpriteset) {
            this.__drExtras = collectExtras(this.__drBaseline || null);
          }
          // Preload party face & GALV_BustMenu bust images asynchronously while on Scene_Map so Scene_Menu opens instantly
          const IM = runtime.ImageManager;
          const party = runtime.$gameParty?.members?.();
          if (IM && Array.isArray(party)) {
            for (let i = 0; i < party.length; i++) {
              const actor = party[i];
              const fn = actor?.faceName?.();
              if (fn) {
                IM.loadFace?.(fn);
                if (runtime.Imported?.Galv_BustMenu && typeof IM.loadPicture === 'function') {
                  const fi = (Number(actor?.faceIndex?.()) || 0) + 1;
                  IM.loadPicture(`${fn}_${fi}`);
                }
              }
            }
          }
        } catch { /* ignore */ }
        transitionProf.end(`mapData=${t ? 'reused' : 'loaded'} spriteset=${this.__drSpritesetReused ? 'reused' : 'built'}`);
        this.__drTrip = null;
        return res;
      };
    }

    const MenuBaseP = runtime.Scene_MenuBase?.prototype;
    if (MenuBaseP && typeof MenuBaseP.start === 'function') {
      const origMenuStart = MenuBaseP.start;
      MenuBaseP.start = function () {
        const res = origMenuStart.apply(this, arguments);
        if (transitionProf.active && transitionProf.label.startsWith('menu open')) transitionProf.end();
        return res;
      };
    }

    const origTerminate = SceneMapP.terminate;
    SceneMapP.terminate = function () {
      const nextScene = SceneManager?._nextScene;
      const toMenu = Boolean(nextScene && isMenuLikeScene(nextScene));
      if (toMenu) transitionProf.begin(`menu open (${nextScene?.constructor?.name || 'menu'})`);
      const res = origTerminate.apply(this, arguments);
      try {
        const next = SceneManager?._nextScene;
        const gm = runtime.$gameMap;
        if (next && isMenuLikeScene(next) && gm && runtime.$dataMap) {
          const ss = this._spriteset;
          const keepSs = canReuseSpriteset && ss && !ss._destroyed && Array.isArray(ss.children);
          if (keepSs && ss.parent) {
            try { ss.parent.removeChild(ss); } catch { /* ignore */ }
          }
          trip = {
            gameMap: gm,
            mapId: gm.mapId?.() ?? 0,
            tilesetId: gm.tilesetId?.() ?? 0,
            data: runtime.$dataMap,
            mapLoader: DM._mapLoader,
            tempTiledData: DM._tempTiledData,
            tiledLoaded: DM._tiledLoaded,
            tilesetToLoad: DM._tilesetToLoad,
            spriteset: keepSs && !ss.parent ? ss : null,
            baseline: this.__drBaseline || null,
            extras: this.__drExtras || [],
          };
        } else {
          trip = null;
        }
      } catch {
        trip = null;
      }
      return res;
    };

    // Drop the cached map/spriteset as soon as a non-menu, non-map scene starts (title, battle, gameover...)
    if (typeof SceneManager?.onSceneCreate === 'function') {
      const origOnSceneCreate = SceneManager.onSceneCreate;
      SceneManager.onSceneCreate = function () {
        const sc = this._scene;
        if (trip && sc && !isMenuLikeScene(sc) && !(runtime.Scene_Map && sc instanceof runtime.Scene_Map)) {
          trip = null;
        }
        return origOnSceneCreate.apply(this, arguments);
      };
    }
  }

  let lastAutoGcMs = 0;
  const runAutoGc = (reason: string, mgr?: any) => {
    if (typeof runtime.gc !== 'function') return;
    try {
      const t0 = performance.now();
      runtime.gc();
      const t1 = performance.now();
      lastAutoGcMs = t1;
      if (mgr) {
        const nowMs = typeof mgr._getTimeInMsWithoutMobileSafari === 'function'
          ? mgr._getTimeInMsWithoutMobileSafari()
          : (typeof mgr.getTimeInMs === 'function' ? mgr.getTimeInMs() : performance.now());
        mgr._currentTime = nowMs;
        mgr._accumulator = 0;
      }
      if (t1 - t0 >= 25) {
        log(`[gc] scene gc (${reason}) took ${(t1 - t0).toFixed(1)}ms`);
      }
    } catch { /* ignore */ }
  };

  // Never run blocking auto-GC on pause-menu open/close (saves 115-140ms on every menu open!).
  const MENU_SCENES = new Set([
    'Scene_Menu',
    'Scene_Item',
    'Scene_Skill',
    'Scene_Equip',
    'Scene_Status',
    'Scene_Options',
    'Scene_Save',
    'Scene_GameEnd',
  ]);
  // Any Scene_MenuBase subclass (custom quest/bestiary/shop/name scenes too) counts as a pause-menu scene.
  const isMenuLikeScene = (scene: any): boolean => {
    if (!scene) return false;
    const MenuBase = runtime.Scene_MenuBase;
    if (typeof MenuBase === 'function' && scene instanceof MenuBase) return true;
    return MENU_SCENES.has(scene.constructor?.name || '');
  };

  // 6i. Fast pause-menu round-trips: when Scene_Map pushes a menu scene and the player returns without
  //     transferring, stock MV re-reads + re-parses the map JSON from SD and rebuilds the whole
  //     Spriteset_Map (tilemap, 100+ character sprites, pictures, lightmask bitmaps, ...). With V8 in
  //     interpreter mode that costs hundreds of ms on big maps. Keep the parsed $dataMap and the
  //     detached Spriteset_Map alive across the menu trip and re-attach them instead.
  //     Opt out per game with `"fastMenu": false` in mv-loader.json.
  installFastMenuRoundTrip();
  installTransitionProfiler();

  // Only run stop-the-world V8 mark-compact GC during non-menu scene transitions (while faded out),
  // NEVER mid-gameplay on Scene_Map (where large old-gen heaps like OMORI's YAML tree stall 180-300ms!).
  if (SceneManager?.changeScene && !SceneManager.__drAutoGcHooked) {
    SceneManager.__drAutoGcHooked = true;
    const origChangeScene = SceneManager.changeScene;
    SceneManager.changeScene = function () {
      const prevScene = this._scene;
      const res = origChangeScene.call(this);
      if (prevScene && this._scene !== prevScene) {
        const now = performance.now();
        const prevName = prevScene.constructor?.name || '?';
        const nextName = this._scene?.constructor?.name || '?';
        const isMenuTransition =
          MENU_SCENES.has(prevName) || MENU_SCENES.has(nextName) || isMenuLikeScene(prevScene) || isMenuLikeScene(this._scene);
        if (!isMenuTransition && now - lastAutoGcMs >= 45000) {
          runAutoGc(`${prevName}->${nextName}`, this);
        }
      }
      return res;
    };
  }

  // Browsers expose no gamepad before the player presses a button, so plugins' gamepad hooks never ran
  // before the first scene existed on PC. The Switch controller is always connected: e.g. In Stars And
  // Time's Input._updateGamepadState reads SceneManager._scene._mytextSprite and crashed on frame 1.
  const InputCls = runtime.Input;
  if (InputCls && typeof InputCls._pollGamepads === 'function' && !InputCls.__drPollAfterScene) {
    InputCls.__drPollAfterScene = true;
    const origPoll = InputCls._pollGamepads;
    InputCls._pollGamepads = function (this: any) {
      if (SceneManager && !SceneManager._scene) return;
      return origPoll.apply(this, arguments);
    };
  }

  let loggedFirstMapPerf = false;
  if (SceneManager?.updateMain && !SceneManager.__drUpdateCap) {
    SceneManager.__drUpdateCap = true;
    SceneManager.updateMain = function () {
      // Universal fixed-timestep stabilizer for ALL RPG Maker MV versions (1.0 - 1.6.2+) AND
      // TDDP_FluidTimestep.js (e.g. Fear & Hunger v1.6.0, where _deltaTime is undefined and _dt = 1/60!).
      const dt = (typeof this._deltaTime === 'number' && this._deltaTime > 0)
        ? this._deltaTime
        : (typeof this._dt === 'number' && this._dt > 0 ? this._dt : 1 / 60);
      const newTime = typeof this._getTimeInMsWithoutMobileSafari === 'function'
        ? this._getTimeInMsWithoutMobileSafari()
        : (typeof this.getTimeInMs === 'function' ? this.getTimeInMs() : performance.now());
      if (typeof this._currentTime !== 'number' || this._currentTime <= 0) {
        this._currentTime = newTime;
      }
      if (typeof this._accumulator !== 'number' || Number.isNaN(this._accumulator)) {
        this._accumulator = 0;
      }
      if (runtime.__drOverlayOpen) {
        this._currentTime = newTime;
        this._accumulator = 0;
        this._skipCount = 0;
        this.renderScene();
        this.requestUpdate();
        return;
      }
      let fTime = (newTime - this._currentTime) / 1000;
      if (fTime > 0.25) fTime = 0.25;
      if (fTime < 0) fTime = 0;
      this._currentTime = newTime;
      this._accumulator += fTime;
      const maxAccum = dt * 2;
      if (this._accumulator > maxAccum) this._accumulator = maxAccum;
      // VSync phase-lock: Switch 2 refresh can run slightly faster than 60.000Hz (~16.5ms/frame vs
      // 16.667ms dt), causing _accumulator to land just under dt every ~10 frames and skip an update
      // tick (visible 1-frame camera stutter while walking). Snap to dt when within 2.5ms of a tick.
      if (this._accumulator < dt && this._accumulator >= dt - 0.0025) {
        this._accumulator = dt;
      }

      const u0 = performance.now();
      while (this._accumulator >= dt) {
        this._accumulator -= dt;
        if (typeof this._t === 'number') this._t += dt;
        // Support NupuSetting.js (Ruins Seeker) melee hitstop counter
        if (typeof runtime.hitstopflame === 'number' && runtime.hitstopflame > 0) {
          runtime.hitstopflame -= 1;
          continue;
        }
        // Guard against IEEE-754 1-ULP underflow when _accumulator === dt * 2; also signal
        // `Graphics._skipCount = 1` on catch-up ticks so plugins checking `Graphics._skipCount === 0`
        // (e.g. `liply_MobileLight` in Noel) never double-render heavy canvas passes on a lag frame!
        skipSpritesetThisTick = this._accumulator >= dt * 0.99 && !this.isSceneChanging();
        const prevSkip = Graphics ? Graphics._skipCount : undefined;
        if (skipSpritesetThisTick && Graphics) Graphics._skipCount = Math.max(1, prevSkip || 0);
        try {
          this.updateInputData();
          this.changeScene();
          this.updateScene();
        } finally {
          if (skipSpritesetThisTick && Graphics) Graphics._skipCount = prevSkip ?? 0;
        }
      }
      skipSpritesetThisTick = false;
      const udt = performance.now() - u0;
      perfUpdateSum += udt;
      hudUpdSum += udt;

      this.renderScene();
      perfFrames++;
      hudFrames++;
      const now = performance.now();
      const frameDelta = Math.max(0, Math.min(250, now - hudPrevFrameMs));
      hudPrevFrameMs = now;
      if (frameDelta > 33.4) {
        hitchFrames++;
        if (frameDelta > hitchMax) hitchMax = frameDelta;
      }
      if (runtime.__drHudMode === 'pro') {
        hudFrameHist[hudFrameHistHead] = frameDelta;
        hudFrameHistHead = (hudFrameHistHead + 1) % HUD_HIST_LEN;
        const hudElapsed = now - hudLastMs;
        if (hudElapsed >= 250 && hudFrames > 0) {
          const hn = hudFrames;
          const sceneName = this._scene?.constructor?.name || 'none';
          const glSt = isWebGLMode ? host?.getWebGLContext?.()?.__drGetStats?.() : null;
          const glDrawsDelta = glSt ? Math.max(0, glSt.draws - hudPrevGlDraws) : 0;
          if (glSt) hudPrevGlDraws = glSt.draws;
          const hmt = Math.max(1, hudMapTicks);
          const hst = Math.max(1, hudSsTicks);
          const isMap = sceneName === 'Scene_Map';
          runtime.__drPerfStats = {
            fps: (hn * 1000) / hudElapsed,
            frameMs: hudElapsed / hn,
            updateMs: hudUpdSum / hn,
            renderMs: hudLastRenderMs / hn,
            ticksPerFrame: isMap ? hudMapTicks / hn : undefined,
            sceneName,
            map: isMap
              ? {
                  ev: runtime.$gameMap?._events?.length ?? 0,
                  ch: this._scene?._spriteset?._characterSprites?.length ?? 0,
                  pic: this._scene?._spriteset?._pictureContainer?.children?.length ?? 0,
                  gmMs: hudGmMs / hmt,
                  evMs: hudEvMs / hmt,
                  ssMs: hudSsMs / hst,
                  winMs: hudWinMs / hmt,
                }
              : null,
            gl: glSt
              ? {
                  drawsPerFrame: glDrawsDelta / hn,
                  texUploads: glSt.texUploads,
                  err: glSt.err,
                }
              : null,
            frameHistory: hudFrameHist,
            frameHistoryHead: hudFrameHistHead,
          };
          hudFrames = 0;
          hudUpdSum = 0;
          hudLastRenderMs = 0;
          hudMapTicks = 0;
          hudGmMs = 0;
          hudEvMs = 0;
          hudSsMs = 0;
          hudSsTicks = 0;
          hudWinMs = 0;
          hudLastMs = now;
        }
      } else {
        hudFrames = 0;
        hudUpdSum = 0;
        hudLastRenderMs = 0;
        hudMapTicks = 0;
        hudGmMs = 0;
        hudEvMs = 0;
        hudSsMs = 0;
        hudSsTicks = 0;
        hudWinMs = 0;
        hudLastMs = now;
      }

      const elapsed = now - perfLastLog;
      if (elapsed >= 10000) {
        const n = Math.max(1, perfFrames);
        const fps = (perfFrames * 1000) / elapsed;
        const sceneName = this._scene?.constructor?.name || 'none';
        const firstMapSample = sceneName === 'Scene_Map' && !loggedFirstMapPerf;
        const shouldLogPerf =
          perfLogCount < 24 &&
          sceneName !== 'Scene_Boot' &&
          (firstMapSample || fps < 55 || hitchFrames >= 4 || runtime.__drHudMode === 'pro');
        if (shouldLogPerf) {
          perfLogCount++;
          if (sceneName === 'Scene_Map') loggedFirstMapPerf = true;
          const avgFrame = elapsed / n;
          const avgUpd = perfUpdateSum / n;
          const avgRen = perfRenderSum / n;
          const glSt = isWebGLMode ? host?.getWebGLContext?.()?.__drGetStats?.() : null;
          const glSuffix = glSt
            ? ` draws=${glSt.draws} tex=${glSt.texUploads} rbFix=${glSt.rbFixes} glErr=0x${(glSt.err >>> 0).toString(16)}`
            : '';
          const l2d = typeof runtime.__drTakeL2dStats === 'function' ? runtime.__drTakeL2dStats() : null;
          const l2dSuffix = l2d && l2d.calls > 0
            ? ` l2d[models/f=${(l2d.calls / n).toFixed(1)} core=${(l2d.upd / n).toFixed(1)}ms ` +
              `draw=${(l2d.draw / n).toFixed(1)}ms phys=${(l2d.phys / n).toFixed(1)}ms motion=${(l2d.motion / n).toFixed(1)}ms]`
            : '';
          log(
            `[perf] fps=${fps.toFixed(1)} frame=${avgFrame.toFixed(1)}ms ` +
            `(update=${avgUpd.toFixed(1)}ms render=${avgRen.toFixed(1)}ms) ` +
            `scene=${sceneName} directGPU=${host.isDirectGpu()}${glSuffix}${l2dSuffix}`,
          );
          if (mapTicks > 0 && (fps < 55 || firstMapSample || runtime.__drHudMode === 'pro')) {
            const mt = mapTicks;
            const evCount = runtime.$gameMap?._events?.length ?? 0;
            const chCount = this._scene?._spriteset?._characterSprites?.length ?? 0;
            const picCount = this._scene?._spriteset?._pictureContainer?.children?.length ?? 0;
            const fastPct = charTotalTicks > 0 ? Math.round((charFastTicks * 100) / charTotalTicks) : 0;
            const offPct = charTotalTicks > 0 ? Math.round((charOffSkips * 100) / charTotalTicks) : 0;
            const slowTop = [...charSlowWhy.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 4)
              .map(([k, v]) => `${k}:${charTotalTicks > 0 ? Math.round((v * 100) / charTotalTicks) : 0}%`)
              .join(' ');
            const st = Math.max(1, mapSpritesetTicks);
            const lmSuffix = lightmaskMs > 0 ? ` lm(${lightmaskHookedName})=${(lightmaskMs / st).toFixed(1)}ms` : '';
            log(
              `[perf-map] tick=${(mapTotalMs / mt).toFixed(1)}ms ` +
              `(gameMap=${(mapGameMapMs / mt).toFixed(1)}ms[ref=${(mapRefreshMs / mt).toFixed(1)} ev=${(mapEventsMs / mt).toFixed(1)} ce=${(mapCommonEvMs / mt).toFixed(1)}] ` +
              `spriteset=${(mapSpritesetMs / st).toFixed(1)}ms[ch=${(ssCharMs / st).toFixed(1)} pic=${(ssPicMs / st).toFixed(1)} tm=${(ssTmUpdMs / st).toFixed(1)}]${lmSuffix} ` +
              `tmRender=${(ssTmXformMs / Math.max(1, n)).toFixed(1)}ms/f` +
              `[paint=${tmPaintCount}x${(tmPaintMs / Math.max(1, tmPaintCount)).toFixed(1)}ms max=${tmPaintMax.toFixed(0)} inc=${tmIncCells}cells ` +
              `sort=${(tmSortMs / Math.max(1, n)).toFixed(1)}ms/f] hitch=${hitchFrames}(max ${hitchMax.toFixed(0)}ms) ` +
              `win=${(mapWindowMs / mt).toFixed(1)}ms) ` +
              `ticks/f=${(mt / n).toFixed(2)} ev=${evCount} ch=${chCount} fast=${fastPct}% off=${offPct}% slow[${slowTop}] pic=${picCount}`,
            );
          }
        }
        perfFrames = 0;
        perfUpdateSum = 0;
        perfRenderSum = 0;
        mapTicks = 0;
        mapGameMapMs = 0;
        mapRefreshMs = 0;
        mapEventsMs = 0;
        mapCommonEvMs = 0;
        mapScreenMs = 0;
        mapSpritesetMs = 0;
        ssCharMs = 0;
        ssPicMs = 0;
        ssTmUpdMs = 0;
        ssTmXformMs = 0;
        tmPaintCount = 0;
        tmIncCells = 0;
        tmPaintMs = 0;
        tmPaintMax = 0;
        tmSortMs = 0;
        hitchFrames = 0;
        hitchMax = 0;
        ssTmXformFrames = 0;
        mapSpritesetTicks = 0;
        mapWindowMs = 0;
        mapTotalMs = 0;
        lightmaskMs = 0;
        charFastTicks = 0;
        charTotalTicks = 0;
        charOffSkips = 0;
        charSlowWhy.clear();
        perfLastLog = now;
      }
      this.requestUpdate();
    };
  }

  log('[compat] Universal Switch 2 RPG Maker MV compatibility & GPU acceleration layer installed');
}
