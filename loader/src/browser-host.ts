/**
 * Browser / DOM host shim for running RPG Maker MV (+ PIXI.js v4)
 * on nx.js for Nintendo Switch 2 (Skia Ganesh GL over OunceVK + FFmpeg Video).
 */
import type { AssetReader } from './assets';
import { decodeUtf8Safe, encodeUtf8Safe } from './node-compat';
import { RepeatedPattern } from './repeated-pattern';
import { log } from './log';

export type DisplayMode = 'fit' | 'stretch' | 'pixel';
export type FilterMode = 'auto' | 'nearest' | 'bilinear' | 'trilinear' | 'bicubic';

export interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
  gw: number;
  gh: number;
}

export type ScriptFilter = (path: string, source: string) => string | null;

export interface BrowserHost {
  loadScript(path: string): Promise<void>;
  settled(): Promise<void>;
  beginFrame(): void;
  endFrame(activeVideo?: any | null): void;
  present(activeVideo?: any | null): void;
  isDirectGpu(): boolean;
  markLetterboxDirty(): void;
  setDisplayMode(mode: DisplayMode): void;
  getDisplayMode(): DisplayMode;
  setFilterMode(mode: FilterMode): void;
  getFilterMode(): FilterMode;
  getViewport(): ViewportRect;
  getScreenContext(): any;
  getWebGLContext(): any;
  ensureWebGLContext(): any;
  getGameCanvas(): any;
  forceStopVideos(): void;
  getSkippedScripts?(): string[];
}

/** Rewrites GLSL `lowp`/`mediump` qualifiers (incl. `precision ... float;`) to `highp`. */
export function promoteShaderPrecision(source: string): string {
  return source.replace(/\b(?:lowp|mediump)\b/g, 'highp');
}

export function computeViewport(
  gw: number,
  gh: number,
  sw: number,
  sh: number,
  mode: DisplayMode,
): ViewportRect {
  if (gw <= 0 || gh <= 0 || sw <= 0 || sh <= 0) {
    return { x: 0, y: 0, w: sw, h: sh, gw, gh };
  }
  if (mode === 'stretch') {
    return { x: 0, y: 0, w: sw, h: sh, gw, gh };
  }
  if (mode === 'pixel') {
    const scale = Math.max(1, Math.floor(Math.min(sw / gw, sh / gh)));
    const w = Math.min(sw, gw * scale);
    const h = Math.min(sh, gh * scale);
    return { x: Math.floor((sw - w) / 2), y: Math.floor((sh - h) / 2), w, h, gw, gh };
  }
  // 'fit': preserve 816:624 aspect ratio centered with black letterboxing
  const scale = Math.min(sw / gw, sh / gh);
  const w = Math.round(gw * scale);
  const h = Math.round(gh * scale);
  return { x: Math.floor((sw - w) / 2), y: Math.floor((sh - h) / 2), w, h, gw, gh };
}

export interface BrowserHostOptions {
  gameTitle?: string;
  displayMode?: DisplayMode;
  filterMode?: FilterMode;
  enableWebGL?: boolean;
}

/**
 * Patch native CanvasRenderingContext2D / OffscreenCanvasRenderingContext2D `font` property:
 * 1. Strips CSS weight/style tokens ('bold', 'italic', 'oblique') before calling nx.js's native setter,
 *    preventing `addSystemFont()` (`$.getSystemFont(0)`) from leaking ~6 MiB of PlSharedFontType_Standard
 *    buffers per bold/italic call.
 * 2. Preserves the exact logical CSS `font` string on `this.__drCssFont` so custom JS font renderers
 *    like `OpenTypePixelFont.js` (`getFont(this.font)`) always see the exact family, size, and italic
 *    flags (even for virtual font families such as `rmmz-tinyfont` or `Tiny Pixel`).
 */
export function installFontLeakGuard(ctx: any): void {
  if (!ctx) return;
  try {
    const ctxProto = Object.getPrototypeOf(ctx);
    const fontDesc = ctxProto ? Object.getOwnPropertyDescriptor(ctxProto, 'font') : null;
    if (fontDesc?.set && !(ctxProto as any).__drFontPatched) {
      (ctxProto as any).__drFontPatched = true;
      const origSetFont = fontDesc.set;
      const origGetFont = fontDesc.get;
      let inNativeSetFont = false;
      Object.defineProperty(ctxProto, 'font', {
        configurable: true,
        enumerable: true,
        get() {
          // IMPORTANT: nx.js's native `set font(v)` starts with `if (!v || this.font === v) return;`!
          // While inside `origSetFont`, we MUST return the real C++ Skia font (`origGetFont`), never
          // `__drCssFont`, otherwise `this.font === v` short-circuits and Skia never loads the font!
          if (inNativeSetFont) {
            return origGetFont ? origGetFont.call(this) : '';
          }
          return (this as any).__drCssFont || (origGetFont ? origGetFont.call(this) : '16px sans-serif');
        },
        set(v: string) {
          const raw = String(v ?? '').trim();
          if (!raw) return;
          const clean = raw.replace(
            /\b(?:italic|oblique|bold|bolder|lighter|[1-9]00)\s+/gi,
            '',
          );
          inNativeSetFont = true;
          try {
            origSetFont.call(this, clean);
          } finally {
            inNativeSetFont = false;
          }
          (this as any).__drCssFont = raw;
        },
      });
    }
  } catch { /* ignore */ }
}

/**
 * Mirror plugin-added or overridden text/drawing methods (such as `OpenTypePixelFont.js`'s
 * `_groupTextForDrawing`, `_measureText`, `measureText`, `_pathText`, `_fillText`, `fillText`,
 * `_strokeText`, `strokeText`) from `CanvasRenderingContext2D.prototype` onto
 * `OffscreenCanvasRenderingContext2D.prototype` so `OffscreenCanvas`-backed RPG Maker Bitmaps
 * render pixel/custom fonts identically to HTMLCanvasElement!
 */
export function syncCanvas2DPluginPrototypes(runtime: Record<string, any> = globalThis as any): any[] {
  const protos: any[] = [];
  const c2dProto = runtime?.CanvasRenderingContext2D?.prototype;
  if (c2dProto) protos.push(c2dProto);

  let offProto = runtime?.OffscreenCanvasRenderingContext2D?.prototype ?? null;
  if (!offProto && typeof runtime?.OffscreenCanvas === 'function') {
    try {
      const probe = new runtime.OffscreenCanvas(1, 1).getContext('2d');
      if (probe) {
        installFontLeakGuard(probe);
        offProto = Object.getPrototypeOf(probe);
      }
    } catch { /* ignore */ }
  }
  if (offProto && offProto !== c2dProto) {
    protos.push(offProto);
    if (c2dProto) {
      const syncKeys = [
        '_groupTextForDrawing',
        '_measureText',
        'measureText',
        '_pathText',
        '_fillText',
        'fillText',
        '_strokeText',
        'strokeText',
      ];
      for (const key of syncKeys) {
        if (typeof c2dProto[key] === 'function' && offProto[key] !== c2dProto[key]) {
          // Only overwrite built-in methods (measureText/fillText/strokeText) when a plugin actually
          // installed custom OpenType/canvas text hooks or explicitly replaced them.
          const isCustomHook = key.startsWith('_') || typeof c2dProto._groupTextForDrawing === 'function';
          if (isCustomHook) {
            const origOff = typeof offProto[key] === 'function' ? offProto[key] : null;
            const c2dFn = c2dProto[key];
            try {
              offProto[key] = origOff && !key.startsWith('_')
                ? function (this: any) {
                    try {
                      return c2dFn.apply(this, arguments as any);
                    } catch {
                      return origOff.apply(this, arguments as any);
                    }
                  }
                : c2dFn;
            } catch { /* ignore */ }
          }
        }
      }
    }
  }
  return protos;
}

export function createBrowserHost(
  assets: AssetReader,
  filter: ScriptFilter,
  screenSurface: any,
  options?: BrowserHostOptions,
): BrowserHost {
  const enableWebGL = Boolean(options?.enableWebGL);
  const screenCtx = enableWebGL ? null : screenSurface.getContext('2d');
  if (screenCtx) {
    installFontLeakGuard(screenCtx);
  } else {
    try {
      const probe = new OffscreenCanvas(1, 1).getContext('2d');
      installFontLeakGuard(probe);
    } catch { /* ignore */ }
  }
  let webglCtx: any = null;
  let webglDrawFbo: any = null;
  let webglRawViewport = false;
  let displayMode: DisplayMode = options?.displayMode ?? 'fit';
  let filterMode: FilterMode = options?.filterMode ?? 'auto';
  let gameCanvas: CanvasNode | undefined;
  let lastViewport: ViewportRect = computeViewport(816, 624, screenSurface.width, screenSurface.height, displayMode);

  function getOrCreateWebGL2(): any {
    if (!enableWebGL || !screenSurface) return null;
    if (webglCtx) return webglCtx;
    const gl = screenSurface.getContext?.('webgl2');
    if (!gl) {
      log('[webgl] screen.getContext("webgl2") returned null!');
      return null;
    }
    webglCtx = gl;
    if (!gl.__drMzPatched) {
      gl.__drMzPatched = true;
      const origBindFb = gl.bindFramebuffer.bind(gl);
      const origViewport = gl.viewport.bind(gl);
      const origScissor = gl.scissor.bind(gl);
      const origEnable = typeof gl.enable === 'function' ? gl.enable.bind(gl) : null;
      const origDisable = typeof gl.disable === 'function' ? gl.disable.bind(gl) : null;
      const origTexImage2D = gl.texImage2D.bind(gl);
      const origTexSubImage2D = gl.texSubImage2D.bind(gl);
      const nativeTexImage2DSource = typeof gl.texImage2DSource === 'function'
        ? gl.texImage2DSource.bind(gl)
        : null;
      const nativeTexSubImage2DSource = typeof gl.texSubImage2DSource === 'function'
        ? gl.texSubImage2DSource.bind(gl)
        : null;
      const origUseProgram = typeof gl.useProgram === 'function' ? gl.useProgram.bind(gl) : null;
      const origBindBuffer = typeof gl.bindBuffer === 'function' ? gl.bindBuffer.bind(gl) : null;
      const origBufferData = typeof gl.bufferData === 'function' ? gl.bufferData.bind(gl) : null;
      const origBufferSubData = typeof gl.bufferSubData === 'function' ? gl.bufferSubData.bind(gl) : null;
      const origActiveTexture = typeof gl.activeTexture === 'function' ? gl.activeTexture.bind(gl) : null;
      const origBindTexture = typeof gl.bindTexture === 'function' ? gl.bindTexture.bind(gl) : null;
      const origBindRenderbuffer = typeof gl.bindRenderbuffer === 'function' ? gl.bindRenderbuffer.bind(gl) : null;
      const origBindVao = typeof gl.bindVertexArray === 'function' ? gl.bindVertexArray.bind(gl) : null;
      const origGetParameter = typeof gl.getParameter === 'function' ? gl.getParameter.bind(gl) : null;
      const origIsEnabled = typeof gl.isEnabled === 'function' ? gl.isEnabled.bind(gl) : null;
      const origBlendFunc = typeof gl.blendFunc === 'function' ? gl.blendFunc.bind(gl) : null;
      const origBlendFuncSep = typeof gl.blendFuncSeparate === 'function' ? gl.blendFuncSeparate.bind(gl) : null;
      const origBlendEq = typeof gl.blendEquation === 'function' ? gl.blendEquation.bind(gl) : null;
      const origBlendEqSep = typeof gl.blendEquationSeparate === 'function' ? gl.blendEquationSeparate.bind(gl) : null;
      const origColorMask = typeof gl.colorMask === 'function' ? gl.colorMask.bind(gl) : null;
      const origDepthMask = typeof gl.depthMask === 'function' ? gl.depthMask.bind(gl) : null;
      const origFrontFace = typeof gl.frontFace === 'function' ? gl.frontFace.bind(gl) : null;
      const origCullFace = typeof gl.cullFace === 'function' ? gl.cullFace.bind(gl) : null;
      const origPixelStorei = typeof gl.pixelStorei === 'function' ? gl.pixelStorei.bind(gl) : null;
      const SCISSOR_TEST = gl.SCISSOR_TEST ?? 0x0c11;
      const BLEND = gl.BLEND ?? 0x0be2;
      const CULL_FACE = gl.CULL_FACE ?? 0x0b44;
      const DEPTH_TEST = gl.DEPTH_TEST ?? 0x0b71;
      const STENCIL_TEST = gl.STENCIL_TEST ?? 0x0b90;
      const TEXTURE0 = gl.TEXTURE0 ?? 0x84c0;
      let lastScissor: [number, number, number, number] | null = null;
      let lastGlViewport: [number, number, number, number] | null = null;
      let scissorEnabled = false;

      // Shadow live WebGL state in JS so Live2D Cubism SaveProfile/RestoreProfile, PIXI state sync,
      // and Spine/Filter passes perform zero C++/Mesa/Zink roundtrips and preserve logical game viewport.
      let boundProgram: any = null;
      let boundArrayBuf: any = null;
      let boundElemBuf: any = null;
      let boundRenderbuffer: any = null;
      let boundVao: any = null;
      let activeTexSlot = 0;
      const boundTex2D: any[] = new Array(32).fill(null);
      const boundTexCube: any[] = new Array(32).fill(null);
      const capState = new Map<number, boolean>([
        [SCISSOR_TEST, false],
        [BLEND, false],
        [CULL_FACE, false],
        [DEPTH_TEST, false],
        [STENCIL_TEST, false],
      ]);
      let blendSrcRgb = gl.ONE ?? 1;
      let blendDstRgb = gl.ZERO ?? 0;
      let blendSrcAlpha = gl.ONE ?? 1;
      let blendDstAlpha = gl.ZERO ?? 0;
      let blendEqRgb = gl.FUNC_ADD ?? 0x8006;
      let blendEqAlpha = gl.FUNC_ADD ?? 0x8006;
      let colorMaskState: [boolean, boolean, boolean, boolean] = [true, true, true, true];
      let depthMaskState = true;
      let frontFaceState = gl.CCW ?? 0x0901;
      let cullFaceState = gl.BACK ?? 0x0405;
      let unpackFlipY = false;
      let unpackPremultiply = false;
      let unpackAlignment = 4;
      let glFrameId = 1;

      if (origUseProgram) {
        gl.useProgram = function (prog: any) {
          const next = prog || null;
          if (boundProgram === next) return;
          boundProgram = next;
          return origUseProgram(prog);
        };
      }
      if (origBindBuffer) {
        const ARRAY_BUFFER = gl.ARRAY_BUFFER ?? 0x8892;
        const ELEMENT_ARRAY_BUFFER = gl.ELEMENT_ARRAY_BUFFER ?? 0x8893;
        gl.bindBuffer = function (target: number, buf: any) {
          const next = buf || null;
          if (target === ARRAY_BUFFER) boundArrayBuf = next;
          else if (target === ELEMENT_ARRAY_BUFFER) boundElemBuf = next;
          return origBindBuffer(target, buf);
        };
        if (origBufferData) {
          gl.bufferData = function (...args: any[]) {
            if (args.length === 3) {
              const target = args[0];
              const src = args[1];
              const curBuf = target === ARRAY_BUFFER ? boundArrayBuf : (target === ELEMENT_ARRAY_BUFFER ? boundElemBuf : null);
              if (curBuf && src && ArrayBuffer.isView(src)) {
                if (curBuf.__drImmutableBuf) return;
                if (curBuf.__drSubDataSize === src.byteLength && origBufferSubData) {
                  if (curBuf.__drUploadedFrame === glFrameId) return;
                  curBuf.__drUploadedFrame = glFrameId;
                  return origBufferSubData(target, 0, src);
                }
                if (curBuf.__drSubDataSize !== undefined) {
                  curBuf.__drSubDataSize = src.byteLength;
                  curBuf.__drUploadedFrame = glFrameId;
                }
              }
            }
            return origBufferData(...args);
          };
        }
      }
      if (typeof gl.shaderSource === 'function') {
        // Shaders ask for mediump; desktop GPUs run that at full 32-bit precision, but this GPU honours it
        // as 16-bit. MZ's tilemap shader works in atlas pixel coordinates up to 2048 and clamps to the tile
        // rect: at 16 bits values above 1024 are only accurate to 1 px, so tiles sample their neighbour's
        // edge -> thin dark horizontal/vertical seams. Force highp everywhere (same output as on PC).
        const origShaderSource = gl.shaderSource.bind(gl);
        gl.shaderSource = function (shader: any, source: string) {
          return origShaderSource(shader, typeof source === 'string' ? promoteShaderPrecision(source) : source);
        };
      }
      if (origBufferSubData) {
        // PIXI v5 (MZ) uploads empty Float32Arrays for empty geometry; that's a no-op but raises
        // GL_INVALID_VALUE (0x501) on this driver and hides real errors in the perf log.
        gl.bufferSubData = function (...args: any[]) {
          const src = args[2];
          if (src && ArrayBuffer.isView(src) && src.byteLength === 0) return;
          return origBufferSubData(...args);
        };
      }
      if (origActiveTexture) {
        gl.activeTexture = function (unit: number) {
          const idx = (unit | 0) - TEXTURE0;
          if (idx >= 0 && idx < boundTex2D.length) {
            if (activeTexSlot === idx) return;
            activeTexSlot = idx;
          }
          return origActiveTexture(unit);
        };
      }
      if (origBindTexture) {
        const TEXTURE_2D = gl.TEXTURE_2D ?? 0x0de1;
        const TEXTURE_CUBE_MAP = gl.TEXTURE_CUBE_MAP ?? 0x8513;
        gl.bindTexture = function (target: number, tex: any) {
          const next = tex || null;
          if (target === TEXTURE_2D) boundTex2D[activeTexSlot] = next;
          else if (target === TEXTURE_CUBE_MAP) boundTexCube[activeTexSlot] = next;
          return origBindTexture(target, tex);
        };
      }
      if (origBindRenderbuffer) {
        gl.bindRenderbuffer = function (target: number, rb: any) {
          boundRenderbuffer = rb || null;
          return origBindRenderbuffer(target, rb);
        };
      }
      if (origBindVao) {
        gl.bindVertexArray = function (vao: any) {
          boundVao = vao || null;
          return origBindVao(vao);
        };
      }
      if (origBlendFunc) {
        gl.blendFunc = function (sfactor: number, dfactor: number) {
          const s = sfactor | 0;
          const d = dfactor | 0;
          if (blendSrcRgb === s && blendDstRgb === d && blendSrcAlpha === s && blendDstAlpha === d) return;
          blendSrcRgb = blendSrcAlpha = s;
          blendDstRgb = blendDstAlpha = d;
          return origBlendFunc(s, d);
        };
      }
      if (origBlendFuncSep) {
        gl.blendFuncSeparate = function (srcRGB: number, dstRGB: number, srcAlpha: number, dstAlpha: number) {
          const sr = srcRGB | 0, dr = dstRGB | 0, sa = srcAlpha | 0, da = dstAlpha | 0;
          if (blendSrcRgb === sr && blendDstRgb === dr && blendSrcAlpha === sa && blendDstAlpha === da) return;
          blendSrcRgb = sr; blendDstRgb = dr; blendSrcAlpha = sa; blendDstAlpha = da;
          return origBlendFuncSep(sr, dr, sa, da);
        };
      }
      if (origBlendEq) {
        gl.blendEquation = function (mode: number) {
          const m = mode | 0;
          if (blendEqRgb === m && blendEqAlpha === m) return;
          blendEqRgb = blendEqAlpha = m;
          return origBlendEq(m);
        };
      }
      if (origBlendEqSep) {
        gl.blendEquationSeparate = function (modeRGB: number, modeAlpha: number) {
          const mr = modeRGB | 0, ma = modeAlpha | 0;
          if (blendEqRgb === mr && blendEqAlpha === ma) return;
          blendEqRgb = mr; blendEqAlpha = ma;
          return origBlendEqSep(mr, ma);
        };
      }
      if (origColorMask) {
        gl.colorMask = function (r: boolean, g: boolean, b: boolean, a: boolean) {
          const br = Boolean(r), bg = Boolean(g), bb = Boolean(b), ba = Boolean(a);
          if (
            colorMaskState[0] === br &&
            colorMaskState[1] === bg &&
            colorMaskState[2] === bb &&
            colorMaskState[3] === ba
          ) return;
          colorMaskState = [br, bg, bb, ba];
          return origColorMask(br, bg, bb, ba);
        };
      }
      if (origDepthMask) {
        gl.depthMask = function (flag: boolean) {
          const bf = Boolean(flag);
          if (depthMaskState === bf) return;
          depthMaskState = bf;
          return origDepthMask(bf);
        };
      }
      if (origFrontFace) {
        gl.frontFace = function (mode: number) {
          const m = mode | 0;
          if (frontFaceState === m) return;
          frontFaceState = m;
          return origFrontFace(m);
        };
      }
      if (origCullFace) {
        gl.cullFace = function (mode: number) {
          const m = mode | 0;
          if (cullFaceState === m) return;
          cullFaceState = m;
          return origCullFace(m);
        };
      }
      if (origPixelStorei) {
        gl.pixelStorei = function (pname: number, param: any) {
          if (pname === 0x9240) unpackFlipY = Boolean(param);
          else if (pname === 0x9241) unpackPremultiply = Boolean(param);
          else if (pname === 0x0cf5) unpackAlignment = Number(param) || 4;
          return origPixelStorei(pname, param);
        };
      }
      if (origIsEnabled) {
        gl.isEnabled = function (cap: number) {
          if (capState.has(cap)) return capState.get(cap)!;
          return origIsEnabled(cap);
        };
      }
      gl.__drBoundProgram = () => boundProgram;
      gl.__drBoundTex2D = (slot: number) => boundTex2D[slot] ?? null;

      if (origGetParameter) {
        const CURRENT_PROGRAM = gl.CURRENT_PROGRAM ?? 0x8b8d;
        const ARRAY_BUFFER_BINDING = gl.ARRAY_BUFFER_BINDING ?? 0x8894;
        const ELEMENT_ARRAY_BUFFER_BINDING = gl.ELEMENT_ARRAY_BUFFER_BINDING ?? 0x8895;
        const TEXTURE_BINDING_2D = gl.TEXTURE_BINDING_2D ?? 0x8069;
        const TEXTURE_BINDING_CUBE_MAP = gl.TEXTURE_BINDING_CUBE_MAP ?? 0x8514;
        const FRAMEBUFFER_BINDING = gl.FRAMEBUFFER_BINDING ?? 0x8ca6;
        const RENDERBUFFER_BINDING = gl.RENDERBUFFER_BINDING ?? 0x8ca7;
        const VERTEX_ARRAY_BINDING = gl.VERTEX_ARRAY_BINDING ?? 0x85b5;
        const ACTIVE_TEXTURE = gl.ACTIVE_TEXTURE ?? 0x84e0;
        const VIEWPORT = gl.VIEWPORT ?? 0x0ba2;
        const SCISSOR_BOX = gl.SCISSOR_BOX ?? 0x0c10;
        const COLOR_WRITEMASK = gl.COLOR_WRITEMASK ?? 0x0c23;
        const DEPTH_WRITEMASK = gl.DEPTH_WRITEMASK ?? 0x0b72;
        const FRONT_FACE = gl.FRONT_FACE ?? 0x0b46;
        const CULL_FACE_MODE = gl.CULL_FACE_MODE ?? 0x0b45;
        const BLEND_DST_RGB = gl.BLEND_DST_RGB ?? 0x80c8;
        const BLEND_SRC_RGB = gl.BLEND_SRC_RGB ?? 0x80c9;
        const BLEND_DST_ALPHA = gl.BLEND_DST_ALPHA ?? 0x80ca;
        const BLEND_SRC_ALPHA = gl.BLEND_SRC_ALPHA ?? 0x80cb;
        const BLEND_EQUATION_RGB = gl.BLEND_EQUATION_RGB ?? 0x8009;
        const BLEND_EQUATION_ALPHA = gl.BLEND_EQUATION_ALPHA ?? 0x883d;
        gl.getParameter = function (pname: number) {
          switch (pname) {
            case CURRENT_PROGRAM: return boundProgram;
            case ARRAY_BUFFER_BINDING: return boundArrayBuf;
            case ELEMENT_ARRAY_BUFFER_BINDING: return boundElemBuf;
            case TEXTURE_BINDING_2D: return boundTex2D[activeTexSlot] ?? null;
            case TEXTURE_BINDING_CUBE_MAP: return boundTexCube[activeTexSlot] ?? null;
            case FRAMEBUFFER_BINDING: return webglDrawFbo;
            case RENDERBUFFER_BINDING: return boundRenderbuffer;
            case VERTEX_ARRAY_BINDING: return boundVao;
            case ACTIVE_TEXTURE: return TEXTURE0 + activeTexSlot;
            case VIEWPORT: {
              if (lastGlViewport) return new Int32Array(lastGlViewport);
              const vp = refreshViewport();
              return new Int32Array([0, 0, vp.gw, vp.gh]);
            }
            case SCISSOR_BOX: {
              if (lastScissor) return new Int32Array(lastScissor);
              const vp = refreshViewport();
              return new Int32Array([0, 0, vp.gw, vp.gh]);
            }
            case SCISSOR_TEST: return scissorEnabled;
            case BLEND:
            case CULL_FACE:
            case DEPTH_TEST:
            case STENCIL_TEST:
              return capState.get(pname) ?? false;
            case COLOR_WRITEMASK: return colorMaskState.slice();
            case DEPTH_WRITEMASK: return depthMaskState;
            case FRONT_FACE: return frontFaceState;
            case CULL_FACE_MODE: return cullFaceState;
            case BLEND_SRC_RGB: return blendSrcRgb;
            case BLEND_DST_RGB: return blendDstRgb;
            case BLEND_SRC_ALPHA: return blendSrcAlpha;
            case BLEND_DST_ALPHA: return blendDstAlpha;
            case BLEND_EQUATION_RGB: return blendEqRgb;
            case BLEND_EQUATION_ALPHA: return blendEqAlpha;
            case 0x9240: return unpackFlipY;
            case 0x9241: return unpackPremultiply;
            case 0x0cf5: return unpackAlignment;
            default: return origGetParameter(pname);
          }
        };
      }
      const origRbStorage = typeof gl.renderbufferStorage === 'function'
        ? gl.renderbufferStorage.bind(gl)
        : null;
      const origRbStorageMs = typeof gl.renderbufferStorageMultisample === 'function'
        ? gl.renderbufferStorageMultisample.bind(gl)
        : null;
      const origDrawElements = typeof gl.drawElements === 'function' ? gl.drawElements.bind(gl) : null;
      const origDrawArrays = typeof gl.drawArrays === 'function' ? gl.drawArrays.bind(gl) : null;
      const origLinkProgram = typeof gl.linkProgram === 'function' ? gl.linkProgram.bind(gl) : null;

      let glDrawCount = 0;
      let glTexUploadCount = 0;
      let glTexUploadMs = 0;
      let glTexUploadMaxMs = 0;
      let glTexUploadMaxPx = 0;
      let glRbFixCount = 0;

      // OpenGL ES 3.0 requires sized internal formats for glRenderbufferStorage (unlike
      // WebGL1/ANGLE which accepts unsized GL_DEPTH_STENCIL = 0x84F9). PIXI v5 passes
      // gl.DEPTH_STENCIL for every FilterSystem/ColorFilter offscreen FBO — passing 0x84F9
      // raw to GLES3 fails with GL_INVALID_ENUM and makes every offscreen FBO incomplete!
      const mapRenderbufferFormat = (internalFormat: number): number => {
        switch (internalFormat) {
          case 0x84f9: // GL_DEPTH_STENCIL -> GL_DEPTH24_STENCIL8
            glRbFixCount++;
            return gl.DEPTH24_STENCIL8 ?? 0x88f0;
          case 0x1902: // GL_DEPTH_COMPONENT -> GL_DEPTH_COMPONENT16
            glRbFixCount++;
            return gl.DEPTH_COMPONENT16 ?? 0x81a5;
          case 0x1901: // GL_STENCIL_INDEX -> GL_STENCIL_INDEX8
            glRbFixCount++;
            return gl.STENCIL_INDEX8 ?? 0x8d48;
          case 0x1908: // GL_RGBA -> GL_RGBA8
            glRbFixCount++;
            return gl.RGBA8 ?? 0x8058;
          case 0x1907: // GL_RGB -> GL_RGB8
            glRbFixCount++;
            return gl.RGB8 ?? 0x8051;
          default:
            return internalFormat;
        }
      };

      if (origRbStorage) {
        gl.renderbufferStorage = function (target: number, internalFormat: number, w: number, h: number) {
          return origRbStorage(target, mapRenderbufferFormat(internalFormat), Math.max(1, w | 0), Math.max(1, h | 0));
        };
      }
      if (origRbStorageMs) {
        gl.renderbufferStorageMultisample = function (
          target: number,
          samples: number,
          internalFormat: number,
          w: number,
          h: number,
        ) {
          return origRbStorageMs(target, samples, mapRenderbufferFormat(internalFormat), Math.max(1, w | 0), Math.max(1, h | 0));
        };
      }
      if (origDrawElements) {
        gl.drawElements = function (...args: any[]) {
          glDrawCount++;
          return origDrawElements(...args);
        };
      }
      if (origDrawArrays) {
        gl.drawArrays = function (...args: any[]) {
          glDrawCount++;
          return origDrawArrays(...args);
        };
      }
      if (origLinkProgram) {
        gl.linkProgram = function (program: any) {
          const res = origLinkProgram(program);
          try {
            if (!gl.getProgramParameter(program, gl.LINK_STATUS ?? 0x8b82)) {
              const info = gl.getProgramInfoLog?.(program) || '(no program log)';
              log(`[webgl] linkProgram FAILED: ${info}`);
            }
          } catch { /* ignore */ }
          return res;
        };
      }
      // One-shot GL error tracer: the periodic perf check only sees that SOME call failed since the
      // last check (e.g. glErr=0x501). The first time that happens, check getError() after every GL call
      // for ~10 s and log each distinct failing call with its arguments, then restore the originals.
      const origGetError = typeof gl.getError === 'function' ? gl.getError.bind(gl) : null;
      let errTraceState: 'idle' | 'tracing' | 'done' = 'idle';
      const describeGlArg = (a: any): string => {
        if (a === null || a === undefined) return String(a);
        if (typeof a === 'number') return Number.isInteger(a) && a > 255 ? `0x${a.toString(16)}` : String(a);
        if (typeof a === 'boolean' || typeof a === 'string') return String(a);
        if (ArrayBuffer.isView(a)) return `${a.constructor?.name}[${(a as any).length}]`;
        if (a instanceof ArrayBuffer) return `ArrayBuffer[${a.byteLength}]`;
        return a.constructor?.name || typeof a;
      };
      const startErrTrace = () => {
        if (errTraceState !== 'idle' || !origGetError) return;
        errTraceState = 'tracing';
        const saved = new Map<string, any>();
        const seen = new Set<string>();
        let logged = 0;
        const keys = new Set<string>();
        for (let o = gl; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          for (const k of Object.getOwnPropertyNames(o)) keys.add(k);
        }
        for (const k of keys) {
          if (k === 'getError' || k.startsWith('__dr') || k === 'constructor') continue;
          let fn: any;
          try { fn = gl[k]; } catch { continue; }
          if (typeof fn !== 'function') continue;
          saved.set(k, Object.prototype.hasOwnProperty.call(gl, k) ? fn : undefined);
          gl[k] = function (...args: any[]) {
            const r = fn.apply(gl, args);
            const e = origGetError();
            if (e && logged < 12) {
              const sig = `${k}:${e}`;
              if (!seen.has(sig)) {
                seen.add(sig);
                logged++;
                let extra = '';
                if (k === 'bufferSubData' || k === 'bufferData') {
                  try {
                    const target = args[0];
                    const size = gl.getBufferParameter?.(target, gl.BUFFER_SIZE ?? 0x8764);
                    extra = ` boundBufferSize=${size}`;
                  } catch { /* ignore */ }
                }
                log(`[webgl] GL error 0x${(e >>> 0).toString(16)} from ${k}(${args.map(describeGlArg).join(', ')})${extra}`);
              }
            }
            return r;
          };
        }
        log('[webgl] GL error seen -> tracing failing GL calls for ~10s');
        setTimeout(() => {
          for (const [k, fn] of saved) {
            if (fn === undefined) delete gl[k];
            else gl[k] = fn;
          }
          errTraceState = 'done';
          log(`[webgl] GL error trace finished (${seen.size} distinct failing call(s))`);
        }, 10000);
      };
      // Cheap per-frame counters (no getError round trip): [uploads, uploadMs, maxUploadMs, maxUploadPx]
      gl.__drTexCounters = () => [glTexUploadCount, glTexUploadMs, glTexUploadMaxMs, glTexUploadMaxPx];
      gl.__drResetTexMax = () => {
        glTexUploadMaxMs = 0;
        glTexUploadMaxPx = 0;
      };
      gl.__drGetStats = () => {
        const err = origGetError ? origGetError() : -1;
        if (err > 0) startErrTrace();
        return {
          draws: glDrawCount,
          texUploads: glTexUploadCount,
          texUploadMs: glTexUploadMs,
          texUploadMaxMs: glTexUploadMaxMs,
          texUploadMaxPx: glTexUploadMaxPx,
          rbFixes: glRbFixCount,
          err,
        };
      };

      const FRAMEBUFFER = gl.FRAMEBUFFER ?? 0x8d40;
      const DRAW_FRAMEBUFFER = gl.DRAW_FRAMEBUFFER ?? 0x8ca9;

      const getGlScreenSize = (): [number, number] => [
        gl.drawingBufferWidth > 0 ? gl.drawingBufferWidth : (screenSurface.width || 1280),
        gl.drawingBufferHeight > 0 ? gl.drawingBufferHeight : (screenSurface.height || 720),
      ];

      const mapScreenRect = (x: number, y: number, w: number, h: number): [number, number, number, number] => {
        const vp = refreshViewport();
        const gw = Math.max(1, vp.gw);
        const gh = Math.max(1, vp.gh);
        const sx = vp.w / gw;
        const sy = vp.h / gh;
        const [, sh] = getGlScreenSize();
        const glBaseY = sh - (vp.y + vp.h);
        const cw = Math.max(0, Number(w) || 0);
        const ch = Math.max(0, Number(h) || 0);
        const rx = Math.round(vp.x + (Number(x) || 0) * sx);
        const ry = Math.round(glBaseY + (Number(y) || 0) * sy);
        const rw = cw > 0 ? Math.max(1, Math.round(cw * sx)) : 0;
        const rh = ch > 0 ? Math.max(1, Math.round(ch * sy)) : 0;
        return [rx, ry, rw, rh];
      };

      const syncViewportForCurrentFbo = () => {
        if (!lastGlViewport) {
          if (!webglDrawFbo && !webglRawViewport) {
            const vp = refreshViewport();
            const [rx, ry, rw, rh] = mapScreenRect(0, 0, vp.gw, vp.gh);
            origViewport(rx, ry, rw, rh);
          }
          return;
        }
        const [vx, vy, vw, vh] = lastGlViewport;
        if (webglDrawFbo || webglRawViewport) {
          origViewport(vx, vy, vw, vh);
        } else {
          const [rx, ry, rw, rh] = mapScreenRect(vx, vy, vw, vh);
          origViewport(rx, ry, rw, rh);
        }
      };

      const syncScissorForCurrentFbo = () => {
        if (!lastScissor) return;
        const [sx, sy, sw, sh] = lastScissor;
        if (webglDrawFbo || webglRawViewport) {
          origScissor(sx, sy, sw, sh);
        } else {
          const [rx, ry, rw, rh] = mapScreenRect(sx, sy, sw, sh);
          origScissor(rx, ry, rw, rh);
        }
      };

      gl.__drSetRawViewport = (raw: boolean) => {
        webglRawViewport = raw;
      };
      gl.__drSyncViewport = () => {
        syncViewportForCurrentFbo();
        if (scissorEnabled) syncScissorForCurrentFbo();
      };
      gl.__drClearScreen = () => {
        glFrameId = (glFrameId + 1) | 0;
        const prevRaw = webglRawViewport;
        webglRawViewport = true;
        try {
          origBindFb(FRAMEBUFFER, null);
          webglDrawFbo = null;
          if (origDisable) origDisable(SCISSOR_TEST);
          else gl.disable(SCISSOR_TEST);
          const [sw, sh] = getGlScreenSize();
          origViewport(0, 0, sw, sh);
          gl.clearColor(0, 0, 0, 1);
          gl.clear((gl.COLOR_BUFFER_BIT ?? 0x4000) | (gl.DEPTH_BUFFER_BIT ?? 0x0100) | (gl.STENCIL_BUFFER_BIT ?? 0x0400));
        } finally {
          webglRawViewport = prevRaw;
        }
        // Restore mapped game viewport & scissor state so PIXI v5's cached GL state stays in sync.
        syncViewportForCurrentFbo();
        if (scissorEnabled) {
          if (origEnable) origEnable(SCISSOR_TEST);
          else gl.enable(SCISSOR_TEST);
          syncScissorForCurrentFbo();
        }
      };

      if (origEnable) {
        gl.enable = function (cap: number) {
          if (cap === SCISSOR_TEST) {
            scissorEnabled = true;
            capState.set(SCISSOR_TEST, true);
            syncScissorForCurrentFbo();
            return origEnable(cap);
          }
          if (capState.has(cap)) {
            if (capState.get(cap) === true) return;
            capState.set(cap, true);
          }
          return origEnable(cap);
        };
      }
      if (origDisable) {
        gl.disable = function (cap: number) {
          if (cap === SCISSOR_TEST) {
            scissorEnabled = false;
            capState.set(SCISSOR_TEST, false);
            return origDisable(cap);
          }
          if (capState.has(cap)) {
            if (capState.get(cap) === false) return;
            capState.set(cap, false);
          }
          return origDisable(cap);
        };
      }

      gl.bindFramebuffer = function (target: number, fb: any) {
        const prevIsScreen = !webglDrawFbo;
        if (target === FRAMEBUFFER || target === DRAW_FRAMEBUFFER) {
          webglDrawFbo = fb || null;
        }
        const res = origBindFb(target, fb);
        const nowIsScreen = !webglDrawFbo;
        if ((target === FRAMEBUFFER || target === DRAW_FRAMEBUFFER) && prevIsScreen !== nowIsScreen) {
          // PIXI v5 FramebufferSystem caches its logical viewport (0, 0, gw, gh) and skips calling
          // gl.viewport() when switching between FBO 0 and a same-sized offscreen FBO (e.g. ColorFilter).
          // Re-project both viewport and scissor immediately on every screen <-> offscreen FBO switch!
          syncViewportForCurrentFbo();
          if (lastScissor) syncScissorForCurrentFbo();
        }
        return res;
      };

      gl.viewport = function (x: number, y: number, w: number, h: number) {
        const cx = Math.round(Number(x) || 0);
        const cy = Math.round(Number(y) || 0);
        const cw = Math.max(0, Math.round(Number(w) || 0));
        const ch = Math.max(0, Math.round(Number(h) || 0));
        if (webglRawViewport) {
          return origViewport(cx, cy, cw, ch);
        }
        lastGlViewport = [cx, cy, cw, ch];
        if (webglDrawFbo) {
          return origViewport(cx, cy, cw, ch);
        }
        const [rx, ry, rw, rh] = mapScreenRect(cx, cy, cw, ch);
        return origViewport(rx, ry, rw, rh);
      };

      gl.scissor = function (x: number, y: number, w: number, h: number) {
        const cx = Math.round(Number(x) || 0);
        const cy = Math.round(Number(y) || 0);
        const cw = Math.max(0, Math.round(Number(w) || 0));
        const ch = Math.max(0, Math.round(Number(h) || 0));
        if (webglRawViewport) {
          return origScissor(cx, cy, cw, ch);
        }
        lastScissor = [cx, cy, cw, ch];
        if (webglDrawFbo) {
          return origScissor(cx, cy, cw, ch);
        }
        const [rx, ry, rw, rh] = mapScreenRect(cx, cy, cw, ch);
        return origScissor(rx, ry, rw, rh);
      };

      // Unwrap CanvasNode / OffscreenCanvas / native Image so C++ `texImage2DSource` uploads
      // premultiplied BGRA8 directly via ARM64 NEON with zero intermediate OffscreenCanvas or
      // getImageData float-division allocations!
      const unwrapNativeTexSource = (src: any): any | null => {
        if (!src || typeof src !== 'object' || ArrayBuffer.isView(src) || src instanceof VideoNode) return null;
        if (src instanceof CanvasNode) return src.surface();
        if (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas) return src;
        if (typeof src.width === 'number' && typeof src.height === 'number' && !('data' in src)) return src;
        return null;
      };

      // Fallback CanvasNode / OffscreenCanvas -> Uint8Array RGBA extraction when native fast-path is absent.
      const extractCanvasPixels = (src: any): { data: Uint8Array; w: number; h: number } | null => {
        if (!src || typeof src !== 'object') return null;
        let surf: any = null;
        if (src instanceof CanvasNode) {
          surf = src.surface();
        } else if (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas) {
          surf = src;
        } else {
          return null;
        }
        const w = Math.max(1, surf.width | 0);
        const h = Math.max(1, surf.height | 0);
        const ctx2d = surf.getContext('2d');
        const id = ctx2d.getImageData(0, 0, w, h);
        return {
          data: new Uint8Array(id.data.buffer, id.data.byteOffset, id.data.byteLength),
          w,
          h,
        };
      };

      const texImage2DInner = function (...args: any[]) {
        const last = args[args.length - 1];
        if (last instanceof VideoNode && last.nativeVideo) {
          const copy = args.slice();
          copy[copy.length - 1] = last.nativeVideo;
          return origTexImage2D(...copy);
        }
        if (nativeTexImage2DSource) {
          const nativeSrc = unwrapNativeTexSource(last);
          if (nativeSrc) {
            if (args.length === 6) {
              if (nativeTexImage2DSource(args[0], args[1], args[2], args[3], args[4], nativeSrc) === true) return;
            } else if (
              args.length === 9 &&
              args[3] === nativeSrc.width &&
              args[4] === nativeSrc.height &&
              args[5] === 0
            ) {
              if (nativeTexImage2DSource(args[0], args[1], args[2], args[6], args[7], nativeSrc) === true) return;
            }
          }
        }
        const px = extractCanvasPixels(last);
        if (px) {
          if (args.length === 6) {
            return origTexImage2D(args[0], args[1], args[2], px.w, px.h, 0, args[3], args[4], px.data);
          }
          const copy = args.slice();
          copy[copy.length - 1] = px.data;
          return origTexImage2D(...copy);
        }
        return origTexImage2D(...args);
      };

      const texSubImage2DInner = function (...args: any[]) {
        const last = args[args.length - 1];
        if (last instanceof VideoNode && last.nativeVideo) {
          const copy = args.slice();
          copy[copy.length - 1] = last.nativeVideo;
          return origTexSubImage2D(...copy);
        }
        if (nativeTexSubImage2DSource) {
          const nativeSrc = unwrapNativeTexSource(last);
          if (nativeSrc) {
            if (args.length === 7) {
              if (nativeTexSubImage2DSource(args[0], args[1], args[2], args[3], args[4], args[5], nativeSrc) === true) return;
            } else if (
              args.length === 9 &&
              args[4] === nativeSrc.width &&
              args[5] === nativeSrc.height
            ) {
              if (nativeTexSubImage2DSource(args[0], args[1], args[2], args[3], args[6], args[7], nativeSrc) === true) return;
            }
          }
        }
        const px = extractCanvasPixels(last);
        if (px) {
          if (args.length === 7) {
            return origTexSubImage2D(args[0], args[1], args[2], args[3], px.w, px.h, args[4], args[5], px.data);
          }
          const copy = args.slice();
          copy[copy.length - 1] = px.data;
          return origTexSubImage2D(...copy);
        }
        return origTexSubImage2D(...args);
      };

      // Time every texture upload: canvas-backed textures (text, lighting layers) are converted to
      // pixels here, and a large one costs tens of ms -> shows up as periodic frame hitches.
      // texImage2D(target, level, ifmt, w, h, border, fmt, type, pixels) / texSubImage2D(target, level,
      // x, y, w, h, fmt, type, pixels); the 6/7-argument forms take a canvas/image source last.
      const uploadSize = (args: any[], sub: boolean): number => {
        const last = args[args.length - 1];
        if (last && typeof last.width === 'number' && typeof last.height === 'number') return last.width * last.height;
        if (args.length < 9) return 0;
        const w = Number(args[sub ? 4 : 3]) || 0;
        const h = Number(args[sub ? 5 : 4]) || 0;
        return w * h;
      };
      const timedUpload = (inner: (...a: any[]) => any, sub: boolean) => function (...args: any[]) {
        glTexUploadCount++;
        const t0 = performance.now();
        try {
          return inner(...args);
        } finally {
          const ms = performance.now() - t0;
          glTexUploadMs += ms;
          if (ms > glTexUploadMaxMs) {
            glTexUploadMaxMs = ms;
            glTexUploadMaxPx = uploadSize(args, sub);
          }
        }
      };
      gl.texImage2D = timedUpload(texImage2DInner, false);
      gl.texSubImage2D = timedUpload(texSubImage2DInner, true);

      gl.getContextAttributes = () => ({
        alpha: true,
        antialias: false,
        depth: true,
        desynchronized: false,
        failIfMajorPerformanceCaveat: false,
        powerPreference: 'high-performance',
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        stencil: true,
      });

      // Expose safe WebGL1 extension aliases for PIXI v4 & Live2D Cubism 4.
      // Deliberately omit OES_vertex_array_object so PIXI v4 uses its non-VAO path and
      // WebGL1-era Live2D Cubism shaders (which never call bindVertexArray) cannot corrupt
      // a still-bound PIXI VAO! (PIXI v5 uses WebGL2 core createVertexArray directly.)
      const origGetExt = typeof gl.getExtension === 'function' ? gl.getExtension.bind(gl) : null;
      const instExt = typeof gl.drawElementsInstanced === 'function' ? {
        VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: gl.VERTEX_ATTRIB_ARRAY_DIVISOR ?? 0x88fe,
        drawArraysInstancedANGLE: (m: number, f: number, c: number, p: number) => gl.drawArraysInstanced(m, f, c, p),
        drawElementsInstancedANGLE: (m: number, c: number, t: number, o: number, p: number) => gl.drawElementsInstanced(m, c, t, o, p),
        vertexAttribDivisorANGLE: (i: number, d: number) => gl.vertexAttribDivisor(i, d),
      } : null;
      gl.getExtension = function (name: string) {
        const lower = String(name ?? '').toLowerCase();
        if (lower === 'angle_instanced_arrays' && instExt) return instExt;
        if (lower === 'oes_element_index_uint') return {};
        if (lower === 'webgl_depth_texture') return { UNSIGNED_INT_24_8_WEBGL: gl.UNSIGNED_INT_24_8 ?? 0x84fa };
        if (lower === 'webgl_lose_context') return { loseContext() {}, restoreContext() {} };
        return origGetExt ? origGetExt(name) : null;
      };

      try {
        Object.defineProperty(gl, 'canvas', {
          configurable: true,
          get: () => gameCanvas || screenSurface,
        });
      } catch { /* ignore */ }
      log(`[webgl] Hardware WebGL2 (OunceVK ES3) initialized (${screenSurface.width}x${screenSurface.height})`);
    }
    return gl;
  }

  function applyFilterMode(ctx: any, logicalSmoothing: boolean, isSharpTile = false): void {
    if (!ctx) return;
    switch (filterMode) {
      case 'nearest':
        ctx.imageSmoothingEnabled = false;
        break;
      case 'bilinear':
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'low';
        break;
      case 'trilinear':
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        break;
      case 'bicubic':
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        break;
      case 'auto':
      default:
        if (displayMode === 'pixel') {
          ctx.imageSmoothingEnabled = logicalSmoothing;
          ctx.imageSmoothingQuality = 'low';
        } else if (isSharpTile) {
          // Map tilemap layers & tileset events use NEAREST in FIT/STRETCH to prevent
          // any 1px bilinear tile/quadrant seam lines, while menus/text/battles stay BILINEAR.
          ctx.imageSmoothingEnabled = false;
        } else {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'low';
        }
        break;
    }
  }
  let vpSx = lastViewport.w / Math.max(1, lastViewport.gw);
  let vpSy = lastViewport.h / Math.max(1, lastViewport.gh);
  let viewportDirty = true;
  let letterboxDirty = true;
  let inDirectFrame = false;
  const activeVideos = new Set<VideoNode>();

  let lastLoggedVpKey = '';

  function refreshViewport(): ViewportRect {
    const sw = (enableWebGL && webglCtx?.drawingBufferWidth > 0) ? webglCtx.drawingBufferWidth : screenSurface.width;
    const sh = (enableWebGL && webglCtx?.drawingBufferHeight > 0) ? webglCtx.drawingBufferHeight : screenSurface.height;
    const gw = gameCanvas?.width || 816;
    const gh = gameCanvas?.height || 624;
    if (
      viewportDirty ||
      lastViewport.gw !== gw ||
      lastViewport.gh !== gh ||
      (sw > 0 && sh > 0 && (lastViewport.w > sw || lastViewport.h > sh))
    ) {
      lastViewport = computeViewport(gw, gh, sw, sh, displayMode);
      vpSx = lastViewport.w / Math.max(1, gw);
      vpSy = lastViewport.h / Math.max(1, gh);
      viewportDirty = false;
      letterboxDirty = true;
      const vpKey = `${displayMode}|${gw}x${gh}|${sw}x${sh}|${lastViewport.x},${lastViewport.y},${lastViewport.w}x${lastViewport.h}`;
      if (vpKey !== lastLoggedVpKey && gameCanvas) {
        lastLoggedVpKey = vpKey;
        log(`[viewport] mode=${displayMode} game=${gw}x${gh} screen=${sw}x${sh} -> (${lastViewport.x},${lastViewport.y} ${lastViewport.w}x${lastViewport.h})`);
      }
    }
    return lastViewport;
  }

  function clearLetterboxIfNeeded(vp: ViewportRect) {
    if (!letterboxDirty || !screenCtx) return;
    letterboxDirty = false;
    const sw = screenSurface.width;
    const sh = screenSurface.height;
    if (vp.x > 0 || vp.y > 0 || vp.w < sw || vp.h < sh) {
      screenCtx.save();
      screenCtx.setTransform(1, 0, 0, 1, 0, 0);
      screenCtx.globalAlpha = 1;
      screenCtx.globalCompositeOperation = 'source-over';
      screenCtx.fillStyle = '#000000';
      if (vp.y > 0) screenCtx.fillRect(0, 0, sw, vp.y);
      if (vp.y + vp.h < sh) screenCtx.fillRect(0, vp.y + vp.h, sw, sh - (vp.y + vp.h));
      if (vp.x > 0) screenCtx.fillRect(0, vp.y, vp.x, vp.h);
      if (vp.x + vp.w < sw) screenCtx.fillRect(vp.x + vp.w, vp.y, sw - (vp.x + vp.w), vp.h);
      screenCtx.restore();
    }
  }

  const rawFetch: typeof fetch = (globalThis as any).__drNativeFetch || globalThis.fetch.bind(globalThis);
  (globalThis as any).__drNativeFetch = rawFetch;

  // Ordered script queue (preserves RPG Maker MV plugin load order)
  let scriptChain: Promise<void> = Promise.resolve();
  let pendingCount = 0;

  function decodeScriptBytes(raw: ArrayBuffer | Uint8Array): string {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      // UTF-16LE BOM
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
      }
      return out;
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      // UTF-16BE BOM
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return out;
    }
    let slice = bytes;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      slice = bytes.subarray(3);
    }
    return new TextDecoder().decode(slice);
  }

  function sanitizeShiftJisScript(source: string): string {
    // Shift-JIS full-width space (0x81 0x40) decodes in UTF-8 as "\uFFFD@",
    // which triggers SyntaxError outside strings/comments. Replace with spaces.
    return source.replace(/\uFFFD@/g, '  ').replace(/\uFFFD/g, ' ');
  }

  const skippedScripts: string[] = [];
  const seenMissingScripts = new Set<string>();
  const seenFailedXhr = new Set<string>();

  function recordSkippedScript(path: string): void {
    const clean = path.split('/').pop() || path;
    if (!skippedScripts.includes(clean)) skippedScripts.push(clean);
  }

  function enqueueScript(path: string, onDone?: () => void, onErr?: (e: unknown) => void): Promise<void> {
    pendingCount++;
    const job = scriptChain.then(async () => {
      const rawBytes = await assets.read(path);
      if (!rawBytes) {
        const err = new Error(`Script not found: ${path}`);
        if (!seenMissingScripts.has(path) && seenMissingScripts.size < 40) {
          seenMissingScripts.add(path);
          log(`[script] MISSING: ${path}`);
        }
        onErr?.(err);
        return;
      }
      const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
      const source = decodeScriptBytes(bytes);
      const prepared = filter(path, source);
      if (prepared === null) {
        recordSkippedScript(path);
        onDone?.();
        return;
      }
      const scriptEl = new ScriptNode();
      scriptEl.src = path;
      const prevCurrentScript = document.currentScript;
      document.currentScript = scriptEl;
      try {
        try {
          (0, eval)(`${prepared}\n//# sourceURL=${path}`);
        } catch (firstErr) {
          if (firstErr instanceof SyntaxError && prepared.includes('\uFFFD')) {
            const sanitized = sanitizeShiftJisScript(prepared);
            log(`[script] retrying ${path} after Shift-JIS/non-UTF8 sanitization`);
            (0, eval)(`${sanitized}\n//# sourceURL=${path}`);
          } else {
            throw firstErr;
          }
        }
        onDone?.();
      } catch (err) {
        let msg: string;
        if (err instanceof Error) {
          const header = `${err.name || 'Error'}: ${err.message || ''}`;
          const stack = err.stack || '';
          msg = stack.includes(err.message) && stack.startsWith(err.name) ? stack : `${header}\n${stack}`;
        } else {
          msg = String(err);
        }
        if (err instanceof SyntaxError) {
          const hexHead = Array.from(bytes.subarray(0, 16))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(' ');
          log(`[script] ERROR in ${path}: ${msg} (len=${bytes.length}, head=${hexHead}, hasFFFD=${prepared.includes('\uFFFD')})`);
        } else {
          log(`[script] ERROR in ${path}: ${msg}`);
        }
        onErr?.(err);
      } finally {
        document.currentScript = prevCurrentScript;
      }
    }).finally(() => {
      pendingCount--;
    });
    scriptChain = job.catch(() => {});
    return job;
  }

  function createDomStyle(): Record<string, any> {
    let rawFont = '';
    const st: Record<string, any> = {
      fontStyle: 'normal',
      fontWeight: 'normal',
      fontSize: '16px',
      fontFamily: '',
    };
    Object.defineProperty(st, 'font', {
      configurable: true,
      enumerable: true,
      get() {
        return rawFont;
      },
      set(v: unknown) {
        const s = String(v ?? '').trim();
        rawFont = s;
        if (!s) return;
        st.fontStyle = /\b(?:italic|oblique)\b/i.test(s) ? 'italic' : 'normal';
        const wm = /\b(bold|bolder|lighter|[1-9]00)\b/i.exec(s);
        st.fontWeight = wm ? wm[1].toLowerCase() : 'normal';
        const sm = /(\d+(?:\.\d+)?(?:px|pt|em|rem|%))(?:\s*\/\s*[^\s]+)?\s+(.+)$/i.exec(s);
        if (sm) {
          st.fontSize = sm[1];
          st.fontFamily = sm[2].trim();
        }
      },
    });
    return st;
  }

  class DomNode extends EventTarget {
    children: DomNode[] = [];
    parentNode: DomNode | null = null;
    style: Record<string, any> = createDomStyle();
    attributes: Record<string, string> = {};
    id = '';
    className = '';
    textContent = '';
    innerHTML = '';
    innerText = '';
    constructor(public tagName: string) { super(); }
    appendChild<T extends DomNode>(child: T): T {
      child.parentNode = this;
      this.children.push(child);
      if (this === document.body && child instanceof CanvasNode && (child.id === 'GameCanvas' || child.id === 'gameCanvas')) {
        gameCanvas = child;
        viewportDirty = true;
        if (!enableWebGL) child.enableDirectScreen();
      }
      if (child instanceof ScriptNode) {
        if (child.src) {
          void enqueueScript(
            child.src,
            () => child.onload?.(),
            (e) => child.onerror?.(e),
          );
        } else {
          const inlineSource = child.textContent || child.innerHTML;
          if (inlineSource) {
            const vpath = child._url || 'inline-script.js';
            const prepared = filter(vpath, inlineSource);
            if (prepared === null) {
              recordSkippedScript(vpath);
              child.onload?.();
            } else {
              const prevScript = document.currentScript;
              document.currentScript = child;
              try {
                try {
                  (0, eval)(`${prepared}\n//# sourceURL=${vpath}`);
                } catch (firstErr) {
                  if (firstErr instanceof SyntaxError && prepared.includes('\uFFFD')) {
                    const sanitized = sanitizeShiftJisScript(prepared);
                    log(`[script] retrying ${vpath} after Shift-JIS/non-UTF8 sanitization`);
                    (0, eval)(`${sanitized}\n//# sourceURL=${vpath}`);
                  } else {
                    throw firstErr;
                  }
                }
                child.onload?.();
              } catch (err) {
                const msg = err instanceof Error ? (err.stack || `${err.name}: ${err.message}`) : String(err);
                log(`[script] ERROR in ${vpath}: ${msg}`);
                child.onerror?.({ target: child, error: err });
              } finally {
                document.currentScript = prevScript;
              }
            }
          }
        }
      }
      return child;
    }
    insertBefore<T extends DomNode>(child: T, ref: DomNode | null): T {
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx < 0) return this.appendChild(child);
      child.parentNode = this;
      this.children.splice(idx, 0, child);
      return child;
    }
    removeChild<T extends DomNode>(child: T): T {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    }
    remove(): void {
      this.parentNode?.removeChild(this);
    }
    setAttribute(k: string, v: string): void { this.attributes[k] = String(v); }
    getAttribute(k: string): string | null { return this.attributes[k] ?? null; }
    removeAttribute(k: string): void { delete this.attributes[k]; }
    getElementsByTagName(name: string): DomNode[] {
      const upper = name.toUpperCase();
      const out: DomNode[] = [];
      for (const ch of this.children) {
        if (upper === '*' || ch.tagName === upper) out.push(ch);
        out.push(...ch.getElementsByTagName(name));
      }
      (out as any).item = (i: number) => out[i] ?? null;
      return out;
    }
    getBoundingClientRect() {
      const vp = lastViewport;
      return { x: vp.x, y: vp.y, left: vp.x, top: vp.y, right: vp.x + vp.w, bottom: vp.y + vp.h, width: vp.w, height: vp.h };
    }
    focus() {}
    blur() {}
    select() {}
  }

  class ScriptNode extends DomNode {
    src = '';
    _url = '';
    type = 'text/javascript';
    async = false;
    onload: (() => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    constructor() { super('SCRIPT'); }
  }

  /**
   * HTMLVideoElement backed by nx.js's native FFmpeg `Video` class (streaming
   * directly from `sdmc:/.../www/movies/*.webm` with integrated WebAudio).
   */
  class VideoNode extends DomNode {
    static readonly HAVE_NOTHING = 0;
    static readonly HAVE_METADATA = 1;
    static readonly HAVE_CURRENT_DATA = 2;
    static readonly HAVE_FUTURE_DATA = 3;
    static readonly HAVE_ENOUGH_DATA = 4;
    readonly HAVE_NOTHING = 0;
    readonly HAVE_METADATA = 1;
    readonly HAVE_CURRENT_DATA = 2;
    readonly HAVE_FUTURE_DATA = 3;
    readonly HAVE_ENOUGH_DATA = 4;

    private _src = '';
    private _loop = false;
    private _volume = 1;
    private _muted = false;
    private _playbackRate = 1;
    private _paused = true;
    private _ended = false;
    private _readyState = 0;
    private _native: any = null;
    private _fallbackTimer: any = null;
    private _width: number | null = null;
    private _height: number | null = null;

    x = 0;
    y = 0;
    scaleX = 1;
    scaleY = 1;
    autoplay = false;
    playsInline = true;
    preload = 'auto';
    onloadeddata: ((e: Event) => void) | null = null;
    onloadedmetadata: ((e: Event) => void) | null = null;
    oncanplay: ((e: Event) => void) | null = null;
    oncanplaythrough: ((e: Event) => void) | null = null;
    onended: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onplay: ((e: Event) => void) | null = null;
    onpause: ((e: Event) => void) | null = null;

    constructor(tag = 'VIDEO') { super(tag); }

    get nativeVideo(): any { return this._native; }
    get videoWidth(): number { return this._native?.videoWidth || gameCanvas?.width || 816; }
    get videoHeight(): number { return this._native?.videoHeight || gameCanvas?.height || 624; }
    get width(): number { return this._width ?? this.videoWidth; }
    set width(v: number) { this._width = Number(v) || 0; }
    get height(): number { return this._height ?? this.videoHeight; }
    set height(v: number) { this._height = Number(v) || 0; }
    get paused(): boolean { return this._native ? Boolean(this._native.paused) : this._paused; }
    get ended(): boolean { return this._native ? Boolean(this._native.ended) : this._ended; }
    get readyState(): number { return this._native ? (this._native.readyState ?? this._readyState) : this._readyState; }
    get duration(): number { return this._native?.duration || 0; }
    get currentTime(): number { return this._native?.currentTime || 0; }
    set currentTime(t: number) {
      if (this._native) {
        try { this._native.currentTime = t; } catch { /* ignore */ }
      }
    }
    get loop(): boolean { return this._loop; }
    set loop(v: boolean) {
      this._loop = Boolean(v);
      if (this._native) { try { this._native.loop = this._loop; } catch { /* ignore */ } }
    }
    get volume(): number { return this._volume; }
    set volume(v: number) {
      this._volume = Math.max(0, Math.min(1, Number(v) || 0));
      if (this._native) { try { this._native.volume = this._volume; } catch { /* ignore */ } }
    }
    get muted(): boolean { return this._muted; }
    set muted(v: boolean) {
      this._muted = Boolean(v);
      if (this._native) { try { this._native.muted = this._muted; } catch { /* ignore */ } }
    }
    get playbackRate(): number { return this._playbackRate; }
    set playbackRate(v: number) { this._playbackRate = Number(v) || 1; }

    get src(): string { return this._src; }
    set src(value: string) {
      this._src = String(value ?? '');
      this._destroyNative();
      if (!this._src) return;
      this._attachNative(this._src);
    }

    private _emit(type: string) {
      const ev = new Event(type);
      const prop = (this as any)[`on${type}`];
      if (typeof prop === 'function') {
        try { prop.call(this, ev); } catch (e) { log(`[video] on${type} error: ${String(e)}`); }
      }
      this.dispatchEvent(ev);
    }

    private _destroyNative() {
      if (this._fallbackTimer) { clearTimeout(this._fallbackTimer); this._fallbackTimer = null; }
      activeVideos.delete(this);
      if (this._native) {
        try { this._native.pause?.(); } catch { /* ignore */ }
        try { this._native.close?.(); } catch { /* ignore */ }
        this._native = null;
      }
    }

    private _attachNative(rawUrl: string) {
      const NativeVideo = (globalThis as any).Video;
      const resolved = rawUrl.startsWith('sdmc:/')
        ? rawUrl
        : (assets.resolvePath(rawUrl) ??
          assets.resolvePath(`${rawUrl}.webm`) ??
          assets.resolvePath(`${rawUrl}.mp4`));
      if (!NativeVideo || !resolved) {
        log(`[video] fallback skip (unavailable): ${rawUrl}`);
        this._readyState = 4;
        this._ended = false;
        setTimeout(() => {
          this._emit('loadedmetadata');
          this._emit('loadeddata');
          this._emit('canplay');
          if (this.autoplay || !this._paused) {
            this._fallbackTimer = setTimeout(() => {
              this._ended = true;
              this._paused = true;
              this._emit('ended');
            }, 50);
          }
        }, 0);
        return;
      }

      try {
        const v = new NativeVideo();
        this._native = v;
        this._readyState = 0;
        this._ended = false;
        v.loop = this._loop;
        v.volume = this._volume;
        v.muted = this._muted;
        v.addEventListener('loadedmetadata', () => {
          this._readyState = Math.max(this._readyState, 1);
          this._emit('loadedmetadata');
        });
        v.addEventListener('canplay', () => {
          this._readyState = 4;
          this._emit('loadeddata');
          this._emit('canplay');
        });
        v.addEventListener('canplaythrough', () => {
          this._readyState = 4;
          this._emit('canplaythrough');
        });
        v.addEventListener('play', () => {
          this._paused = false;
          this._ended = false;
          activeVideos.add(this);
          this._emit('play');
        });
        v.addEventListener('pause', () => {
          this._paused = true;
          this._emit('pause');
        });
        v.addEventListener('ended', () => {
          this._ended = true;
          this._paused = true;
          activeVideos.delete(this);
          this._emit('ended');
        });
        v.addEventListener('error', (ev: any) => {
          log(`[video] decode error for ${resolved}: ${ev?.message || 'unknown'}`);
          this._ended = true;
          this._paused = true;
          activeVideos.delete(this);
          // Fire ended after error so RPG Maker MV events never softlock waiting on a video
          this._emit('error');
          setTimeout(() => this._emit('ended'), 16);
        });
        log(`[video] loading native FFmpeg stream: ${resolved}`);
        v.src = resolved;
        if (this.autoplay) {
          void this.play();
        }
      } catch (err) {
        log(`[video] init failed for ${rawUrl}: ${String(err)}`);
        this._native = null;
        this._ended = true;
        setTimeout(() => this._emit('ended'), 16);
      }
    }

    override appendChild<T extends DomNode>(child: T): T {
      super.appendChild(child);
      if (!this._src && child.tagName === 'SOURCE') {
        const childSrc = String((child as any).src || child.attributes?.src || '');
        if (childSrc) this._src = childSrc;
      }
      return child;
    }

    load(): void {
      if (!this._src) {
        for (const ch of this.children) {
          if (ch.tagName === 'SOURCE') {
            const childSrc = String((ch as any).src || ch.attributes?.src || '');
            if (childSrc) {
              this._src = childSrc;
              break;
            }
          }
        }
      }
      if (this._src && !this._native) this._attachNative(this._src);
    }

    play(): Promise<void> {
      this._paused = false;
      this._ended = false;
      if (this._native) {
        activeVideos.add(this);
        return Promise.resolve(this._native.play()).catch((err) => {
          log(`[video] play rejected: ${String(err)}`);
          this._ended = true;
          this._paused = true;
          activeVideos.delete(this);
          this._emit('ended');
        });
      }
      this._fallbackTimer = setTimeout(() => {
        this._ended = true;
        this._paused = true;
        this._emit('ended');
      }, 50);
      return Promise.resolve();
    }

    pause(): void {
      this._paused = true;
      if (this._native) {
        try { this._native.pause(); } catch { /* ignore */ }
      }
      activeVideos.delete(this);
    }

    forceFinish(): void {
      this._destroyNative();
      this._ended = true;
      this._paused = true;
      this._emit('ended');
    }

    canPlayType(mime: string): string {
      const m = String(mime ?? '').toLowerCase();
      if (m.includes('webm') || m.includes('mp4') || m.includes('ogg')) return 'probably';
      return '';
    }
  }

  class CanvasNode extends DomNode {
    private _w = 300;
    private _h = 150;
    private _canvas: any = null;
    private _ctx: any = null;
    direct = false;
    preserveSize = false;
    revision = 0;
    _resetDirectState: (() => void) | null = null;

    constructor() { super('CANVAS'); }

    enableDirectScreen(): void {
      if (this.direct || !screenSurface || !screenCtx) return;
      if (this._canvas) return; // already materialized as OffscreenCanvas
      this._canvas = screenSurface;
      this.direct = true;
      viewportDirty = true;
      letterboxDirty = true;
      log(`[gpu] GameCanvas bound directly to GPU screen surface (${screenSurface.width}x${screenSurface.height})`);
    }

    get width(): number { return this._w; }
    set width(v: number) {
      const n = Math.max(0, Number(v) | 0);
      if (n === this._w) return;
      if (this.preserveSize && n === this._w) return;
      this._w = n;
      this.revision++;
      if (this.direct) {
        viewportDirty = true;
        return;
      }
      if (this._canvas) this._canvas.width = Math.max(1, n);
    }

    get height(): number { return this._h; }
    set height(v: number) {
      const n = Math.max(0, Number(v) | 0);
      if (n === this._h) return;
      if (this.preserveSize && n === this._h) return;
      this._h = n;
      this.revision++;
      if (this.direct) {
        viewportDirty = true;
        return;
      }
      if (this._canvas) this._canvas.height = Math.max(1, n);
    }

    surface(): any {
      if (!this._canvas) {
        this._canvas = new OffscreenCanvas(Math.max(1, this._w), Math.max(1, this._h));
      }
      return this._canvas;
    }

    getContext(kind: string): any {
      if (kind === 'webgl2' || kind === 'webgl' || kind === 'experimental-webgl') {
        if (!enableWebGL) return null;
        if (this.id === 'gameCanvas' || this.id === 'GameCanvas') {
          gameCanvas = this;
          this.direct = true;
          viewportDirty = true;
        }
        return getOrCreateWebGL2();
      }
      if (kind !== '2d') return null;
      if (this._ctx) return this._ctx;
      if (!enableWebGL && this.id === 'GameCanvas' && !this.direct && !this._canvas) {
        this.enableDirectScreen();
      }

      const target = this.direct ? screenCtx : this.surface().getContext('2d');
      if (!target) return null;
      installFontLeakGuard(target);

      const owner = this;
      let activePattern: RepeatedPattern | null = null;
      const patternStack: (RepeatedPattern | null)[] = [];
      const wrapper: Record<string, any> = {};

      const bindAll = (obj: any) => {
        if (!obj) return;
        for (const key of Object.getOwnPropertyNames(obj)) {
          if (key === 'constructor' || key in wrapper) continue;
          let val: any;
          try { val = obj[key]; } catch { continue; }
          if (typeof val === 'function') wrapper[key] = val.bind(target);
        }
      };
      bindAll(target);
      try { bindAll(Object.getPrototypeOf(target)); } catch { /* ignore */ }

      const props = [
        'strokeStyle', 'globalAlpha', 'globalCompositeOperation',
        'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
        'font', 'textAlign', 'textBaseline', 'direction',
        'imageSmoothingEnabled', 'imageSmoothingQuality',
        'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
        'filter',
      ];
      for (const prop of props) {
        Object.defineProperty(wrapper, prop, {
          configurable: true,
          enumerable: true,
          get: () => target[prop],
          set: (v: any) => { target[prop] = v; },
        });
      }

      Object.defineProperty(wrapper, 'fillStyle', {
        configurable: true,
        enumerable: true,
        get: () => activePattern || target.fillStyle,
        set: (v: any) => {
          if (v instanceof RepeatedPattern) {
            activePattern = v;
          } else {
            activePattern = null;
            target.fillStyle = v;
          }
        },
      });
      Object.defineProperty(wrapper, 'canvas', {
        configurable: true,
        enumerable: true,
        get: () => owner,
      });

      wrapper.createPattern = (img: any, repeat = 'repeat') => {
        const src = img instanceof CanvasNode ? img.surface() : img;
        if (!src?.width || !src?.height) return null;
        return new RepeatedPattern(src, repeat, () => (img instanceof CanvasNode ? img.revision : 0));
      };
      wrapper.save = () => { patternStack.push(activePattern); target.save(); };
      wrapper.restore = () => {
        if (patternStack.length) activePattern = patternStack.pop()!;
        target.restore();
      };
      wrapper.fillRect = (x: number, y: number, w: number, h: number) => {
        owner.revision++;
        if (activePattern) {
          activePattern.fill(target, x, y, w, h, (cw, ch) => new OffscreenCanvas(cw, ch));
          return;
        }
        target.fillRect(x, y, w, h);
      };
      wrapper.drawImage = (img: any, ...args: any[]) => {
        owner.revision++;
        const src = img instanceof CanvasNode
          ? img.surface()
          : img instanceof VideoNode
            ? img.nativeVideo
            : img;
        if (!src) return;
        return target.drawImage(src, ...args);
      };
      wrapper.fillText = (text: any, x: number, y: number, maxWidth?: number) => {
        owner.revision++;
        return maxWidth === undefined ? target.fillText(text, x, y) : target.fillText(text, x, y, maxWidth);
      };
      wrapper.strokeText = (text: any, x: number, y: number, maxWidth?: number) => {
        owner.revision++;
        return maxWidth === undefined ? target.strokeText(text, x, y) : target.strokeText(text, x, y, maxWidth);
      };

      // Fast scalar HarfBuzz text width binding (`$.canvasContext2dMeasureTextWidth`) + memoized
      // `ctx.measureText` so direct canvas text measurement (CBR_Status_main, PIXI.Text, MV Bitmap)
      // avoids double HarfBuzz shaping, SkFont::getBounds, and 12-property V8 TextMetrics allocs,
      // while deferring to plugin text renderers (e.g. OpenTypePixelFont.js) when installed!
      const nativeMeasureWidth = typeof (globalThis as any).$?.canvasContext2dMeasureTextWidth === 'function'
        ? (globalThis as any).$.canvasContext2dMeasureTextWidth.bind((globalThis as any).$)
        : null;
      if (nativeMeasureWidth) {
        wrapper.__drMeasureTextWidth = (text: string): number => {
          if (typeof (target as any)._groupTextForDrawing === 'function') {
            return Number((target as any).measureText(text)?.width) || 0;
          }
          return nativeMeasureWidth(target, text);
        };
        wrapper.measureText = (text: any, maxWidth?: any) => {
          if (typeof (target as any)._groupTextForDrawing === 'function') {
            return (target as any).measureText(text, maxWidth);
          }
          const str = String(text ?? '');
          const w = str.length === 0 ? 0 : nativeMeasureWidth(target, str);
          return {
            width: w,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: w,
            actualBoundingBoxAscent: 0,
            actualBoundingBoxDescent: 0,
            fontBoundingBoxAscent: 0,
            fontBoundingBoxDescent: 0,
            emHeightAscent: 0,
            emHeightDescent: 0,
            hangingBaseline: 0,
            alphabeticBaseline: 0,
            ideographicBaseline: 0,
          };
        };
      } else {
        wrapper.measureText = (text: any, maxWidth?: any) => target.measureText(text, maxWidth);
        wrapper.__drMeasureTextWidth = (text: string): number => Number(target.measureText(text)?.width) || 0;
      }

      // Bounds-safe getImageData: nx.js's native canvasContext2dGetImageData underflows
      // size_t (RangeError: failed to allocate 18446744073709550904 bytes) when sx/sy are
      // negative or outside the canvas bounds (e.g. Bitmap.getAlphaPixel on hover plugins).
      const origGetImageData = typeof target.getImageData === 'function'
        ? target.getImageData.bind(target)
        : null;
      if (origGetImageData) {
        wrapper.getImageData = (sx: number, sy: number, sw: number, sh: number, settings?: any) => {
          let x = Math.trunc(Number(sx) || 0);
          let y = Math.trunc(Number(sy) || 0);
          let w = Math.trunc(Number(sw) || 0);
          let h = Math.trunc(Number(sh) || 0);
          if (w < 0) { x += w; w = -w; }
          if (h < 0) { y += h; h = -h; }
          w = Math.max(1, w);
          h = Math.max(1, h);
          const cw = Math.max(0, (owner.direct ? screenSurface.width : owner.surface().width) | 0);
          const ch = Math.max(0, (owner.direct ? screenSurface.height : owner.surface().height) | 0);
          if (x >= 0 && y >= 0 && x + w <= cw && y + h <= ch) {
            return origGetImageData(x, y, w, h, settings);
          }
          const out = new Uint8ClampedArray(w * h * 4);
          const ix0 = Math.max(0, x);
          const iy0 = Math.max(0, y);
          const ix1 = Math.min(cw, x + w);
          const iy1 = Math.min(ch, y + h);
          if (ix1 > ix0 && iy1 > iy0) {
            const sub = origGetImageData(ix0, iy0, ix1 - ix0, iy1 - iy0, settings);
            const srcData = sub.data;
            const subW = ix1 - ix0;
            const dx = ix0 - x;
            const dy = iy0 - y;
            for (let row = 0; row < iy1 - iy0; row++) {
              const sOff = row * subW * 4;
              const dOff = ((dy + row) * w + dx) * 4;
              out.set(srcData.subarray(sOff, sOff + subW * 4), dOff);
            }
          }
          const ImageDataCtor = (globalThis as any).ImageData;
          return typeof ImageDataCtor === 'function'
            ? new ImageDataCtor(out, w, h)
            : { data: out, width: w, height: h };
        };
      }

      // Direct GPU screen mode:
      // 1. Track game-space 2D affine matrix [gA, gB, gC, gD, gE, gF] so axis-aligned
      //    drawImage calls can snap both edges (gx0, gy0) and (gx1, gy1) to exact integer
      //    physical screen pixels via Math.round(vp.x + gx * vpSx). Because shared edges
      //    in game space (such as Tilemap._lowerLayer/_upperLayer 4-quadrant split at (w1, h1)
      //    and adjacent 48x48 tile events) evaluate identical floating-point numbers,
      //    their device-space edges meet at the exact same integer pixel with 0.0 sub-pixel
      //    anti-aliasing black bleed and 0px seam lines.
      // 2. Keep hardware bilinear filtering active on the direct screen surface in non-integer
      //    FIT (942x720) / STRETCH (1280x720) modes even when PIXI sets per-sprite NEAREST,
      //    eliminating 15/13 nearest-neighbor pixel-doubling stripes.
      if (owner.direct) {
        const origSetTransform = target.setTransform.bind(target);
        const origScale = target.scale.bind(target);
        const origTranslate = target.translate.bind(target);
        const origRotate = target.rotate.bind(target);
        const origTransform = target.transform.bind(target);

        let gA = 1, gB = 0, gC = 0, gD = 1, gE = 0, gF = 0;
        const matrixStack: [number, number, number, number, number, number][] = [];
        let deviceIsIdentity = false;
        let deviceMatrixDirty = false;
        let logicalSmoothing = true;
        let lastAutoSharp: boolean | null = null;

        const syncDeviceMatrix = () => {
          if (deviceIsIdentity || deviceMatrixDirty) {
            origSetTransform(
              gA * vpSx,
              gB * vpSy,
              gC * vpSx,
              gD * vpSy,
              lastViewport.x + gE * vpSx,
              lastViewport.y + gF * vpSy,
            );
            deviceIsIdentity = false;
            deviceMatrixDirty = false;
          }
        };

        owner._resetDirectState = () => {
          gA = 1; gB = 0; gC = 0; gD = 1; gE = 0; gF = 0;
          matrixStack.length = 0;
          deviceIsIdentity = false;
          deviceMatrixDirty = false;
          lastAutoSharp = null;
          applyFilterMode(target, logicalSmoothing, false);
        };

        Object.defineProperty(wrapper, 'imageSmoothingEnabled', {
          configurable: true,
          enumerable: true,
          get: () => logicalSmoothing,
          set: (v: any) => {
            logicalSmoothing = Boolean(v);
            lastAutoSharp = null;
            applyFilterMode(target, logicalSmoothing, false);
          },
        });
        Object.defineProperty(wrapper, 'imageSmoothingQuality', {
          configurable: true,
          enumerable: true,
          get: () => target.imageSmoothingQuality,
          set: () => {
            lastAutoSharp = null;
            applyFilterMode(target, logicalSmoothing, false);
          },
        });

        wrapper.save = () => {
          syncDeviceMatrix();
          patternStack.push(activePattern);
          matrixStack.push([gA, gB, gC, gD, gE, gF]);
          target.save();
        };
        wrapper.restore = () => {
          if (patternStack.length) activePattern = patternStack.pop()!;
          if (matrixStack.length) {
            const m = matrixStack.pop()!;
            gA = m[0]; gB = m[1]; gC = m[2]; gD = m[3]; gE = m[4]; gF = m[5];
          }
          target.restore();
          deviceIsIdentity = false;
          deviceMatrixDirty = true;
          lastAutoSharp = null;
          applyFilterMode(target, logicalSmoothing, false);
        };
        wrapper.setTransform = (a: number, b: number, c: number, d: number, e: number, f: number) => {
          gA = a; gB = b; gC = c; gD = d; gE = e; gF = f;
          deviceMatrixDirty = true;
        };
        wrapper.resetTransform = () => {
          gA = 1; gB = 0; gC = 0; gD = 1; gE = 0; gF = 0;
          deviceMatrixDirty = true;
        };
        wrapper.scale = (sx: number, sy: number) => {
          syncDeviceMatrix();
          gA *= sx; gB *= sx; gC *= sy; gD *= sy;
          origScale(sx, sy);
        };
        wrapper.translate = (tx: number, ty: number) => {
          syncDeviceMatrix();
          gE += gA * tx + gC * ty;
          gF += gB * tx + gD * ty;
          origTranslate(tx, ty);
        };
        wrapper.rotate = (rad: number) => {
          syncDeviceMatrix();
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const na = gA * cos + gC * sin;
          const nb = gB * cos + gD * sin;
          const nc = gA * -sin + gC * cos;
          const nd = gB * -sin + gD * cos;
          gA = na; gB = nb; gC = nc; gD = nd;
          origRotate(rad);
        };
        wrapper.transform = (a: number, b: number, c: number, d: number, e: number, f: number) => {
          syncDeviceMatrix();
          const na = gA * a + gC * b;
          const nb = gB * a + gD * b;
          const nc = gA * c + gC * d;
          const nd = gB * c + gD * d;
          const ne = gA * e + gC * f + gE;
          const nf = gB * e + gD * f + gF;
          gA = na; gB = nb; gC = nc; gD = nd; gE = ne; gF = nf;
          origTransform(a, b, c, d, e, f);
        };
        wrapper.fillRect = (x: number, y: number, w: number, h: number) => {
          owner.revision++;
          syncDeviceMatrix();
          if (activePattern) {
            activePattern.fill(target, x, y, w, h, (cw, ch) => new OffscreenCanvas(cw, ch));
            return;
          }
          target.fillRect(x, y, w, h);
        };
        wrapper.clearRect = (x: number, y: number, w: number, h: number) => {
          owner.revision++;
          syncDeviceMatrix();
          if (x <= 0 && y <= 0 && w >= owner._w && h >= owner._h) {
            const prevFill = target.fillStyle;
            const prevAlpha = target.globalAlpha;
            const prevOp = target.globalCompositeOperation;
            target.globalAlpha = 1;
            target.globalCompositeOperation = 'source-over';
            target.fillStyle = '#000000';
            target.fillRect(x, y, w, h);
            target.fillStyle = prevFill;
            target.globalAlpha = prevAlpha;
            target.globalCompositeOperation = prevOp;
            return;
          }
          target.clearRect(x, y, w, h);
        };
        wrapper.drawImage = (img: any, ...args: any[]) => {
          owner.revision++;
          const src = img instanceof CanvasNode
            ? img.surface()
            : img instanceof VideoNode
              ? img.nativeVideo
              : img;
          if (!src) return;
          if (filterMode === 'auto' && displayMode !== 'pixel') {
            const isSharp = Boolean(img?.__drSharpTile || src?.__drSharpTile);
            if (isSharp !== lastAutoSharp) {
              lastAutoSharp = isSharp;
              applyFilterMode(target, logicalSmoothing, isSharp);
            }
          }
          if (gB === 0 && gC === 0 && gA > 0 && gD > 0) {
            const alen = args.length;
            if (alen >= 8) {
              const sx = args[0], sy = args[1], sw = args[2], sh = args[3];
              const dx = args[4], dy = args[5], dw = args[6], dh = args[7];
              const gx0 = gE + dx * gA;
              const gy0 = gF + dy * gD;
              const gx1 = gE + (dx + dw) * gA;
              const gy1 = gF + (dy + dh) * gD;
              const rx0 = Math.round(lastViewport.x + gx0 * vpSx);
              const ry0 = Math.round(lastViewport.y + gy0 * vpSy);
              const rx1 = Math.round(lastViewport.x + gx1 * vpSx);
              const ry1 = Math.round(lastViewport.y + gy1 * vpSy);
              const rw = rx1 - rx0;
              const rh = ry1 - ry0;
              if (rw <= 0 || rh <= 0) return;
              if (!deviceIsIdentity) {
                origSetTransform(1, 0, 0, 1, 0, 0);
                deviceIsIdentity = true;
                deviceMatrixDirty = true;
              }
              return target.drawImage(src, sx, sy, sw, sh, rx0, ry0, rw, rh);
            } else if (alen === 4 || alen === 2) {
              const dx = args[0], dy = args[1];
              const dw = alen === 4 ? args[2] : (src.width || img.width || 0);
              const dh = alen === 4 ? args[3] : (src.height || img.height || 0);
              if (dw > 0 && dh > 0) {
                const gx0 = gE + dx * gA;
                const gy0 = gF + dy * gD;
                const gx1 = gE + (dx + dw) * gA;
                const gy1 = gF + (dy + dh) * gD;
                const rx0 = Math.round(lastViewport.x + gx0 * vpSx);
                const ry0 = Math.round(lastViewport.y + gy0 * vpSy);
                const rx1 = Math.round(lastViewport.x + gx1 * vpSx);
                const ry1 = Math.round(lastViewport.y + gy1 * vpSy);
                const rw = rx1 - rx0;
                const rh = ry1 - ry0;
                if (rw <= 0 || rh <= 0) return;
                if (!deviceIsIdentity) {
                  origSetTransform(1, 0, 0, 1, 0, 0);
                  deviceIsIdentity = true;
                  deviceMatrixDirty = true;
                }
                return target.drawImage(src, rx0, ry0, rw, rh);
              }
            }
          }
          syncDeviceMatrix();
          return target.drawImage(src, ...args);
        };

        const ctmPathKeys = [
          'rect', 'clip', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo',
          'arc', 'arcTo', 'ellipse',
        ];
        for (const key of ctmPathKeys) {
          const fn = target[key];
          if (typeof fn === 'function') {
            wrapper[key] = (...args: any[]) => {
              syncDeviceMatrix();
              return fn.apply(target, args);
            };
          }
        }
        const directDrawKeys = ['strokeRect', 'putImageData', 'stroke'];
        for (const key of directDrawKeys) {
          const fn = target[key];
          if (typeof fn === 'function') {
            wrapper[key] = (...args: any[]) => {
              owner.revision++;
              syncDeviceMatrix();
              return fn.apply(target, args);
            };
          }
        }
        wrapper.fillText = (text: any, x: number, y: number, maxWidth?: number) => {
          owner.revision++;
          syncDeviceMatrix();
          return maxWidth === undefined ? target.fillText(text, x, y) : target.fillText(text, x, y, maxWidth);
        };
        wrapper.strokeText = (text: any, x: number, y: number, maxWidth?: number) => {
          owner.revision++;
          syncDeviceMatrix();
          return maxWidth === undefined ? target.strokeText(text, x, y) : target.strokeText(text, x, y, maxWidth);
        };
        wrapper.fill = (...args: any[]) => {
          owner.revision++;
          syncDeviceMatrix();
          if (activePattern) {
            target.save();
            target.clip();
            target.drawImage(activePattern.source, 0, 0);
            target.restore();
            return;
          }
          return target.fill(...args);
        };
      } else {
        const drawKeys = ['clearRect', 'strokeRect', 'putImageData', 'stroke'];
        for (const key of drawKeys) {
          const fn = target[key];
          if (typeof fn === 'function') {
            wrapper[key] = (...args: any[]) => {
              owner.revision++;
              return fn.apply(target, args);
            };
          }
        }
        wrapper.fill = (...args: any[]) => {
          owner.revision++;
          if (activePattern) {
            target.save();
            target.clip();
            target.drawImage(activePattern.source, 0, 0);
            target.restore();
            return;
          }
          return target.fill(...args);
        };
      }

      this._ctx = wrapper;
      return wrapper;
    }

    toDataURL(): string { return ''; }
    captureStream(): any {
      return {
        getTracks: () => [],
        getVideoTracks: () => [],
        getAudioTracks: () => [],
        addTrack() {},
        removeTrack() {},
      };
    }
  }

  class LocalXHR extends EventTarget {
    readyState = 0;
    status = 0;
    statusText = '';
    responseType = '';
    response: any = null;
    responseText = '';
    responseURL = '';
    onload: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onreadystatechange: ((e: Event) => void) | null = null;
    onprogress: ((e: Event) => void) | null = null;

    private _url = '';

    open(_method: string, url: string) {
      this._url = String(url ?? '');
      this.responseURL = this._url;
      this.readyState = 1;
    }

    setRequestHeader() {}
    overrideMimeType() {}
    abort() {}
    getResponseHeader() { return null; }

    private _fire(type: string) {
      const ev = new Event(type);
      const prop = (this as any)[`on${type}`];
      if (typeof prop === 'function') {
        try { prop.call(this, ev); } catch (e) { log(`[xhr] on${type} (${this._url}): ${String(e)}`); }
      }
      this.dispatchEvent(ev);
    }

    send() {
      const url = this._url;
      void (async () => {
        try {
          const bytes = await assets.read(url);
          if (!bytes) {
            this.status = 404;
            this.statusText = 'Not Found';
            this.readyState = 4;
            this._fire('readystatechange');
            this._fire('onerror' in this ? 'error' : 'error');
            return;
          }
          this.status = 200;
          this.statusText = 'OK';
          if (this.responseType === 'arraybuffer') {
            this.response = bytes;
          } else if (this.responseType === 'blob') {
            this.response = new Blob([bytes]);
          } else if (this.responseType === 'json') {
            const text = new TextDecoder().decode(bytes);
            this.responseText = text;
            this.response = JSON.parse(text);
          } else {
            const text = new TextDecoder().decode(bytes);
            this.responseText = text;
            this.response = text;
          }
          this.readyState = 4;
          this._fire('readystatechange');
          this._fire('load');
        } catch (err) {
          if (!seenFailedXhr.has(url) && seenFailedXhr.size < 40) {
            seenFailedXhr.add(url);
            log(`[xhr] FAILED ${url}: ${String(err)}`);
          }
          this.status = 0;
          this.readyState = 4;
          this._fire('readystatechange');
          this._fire('error');
        }
      })();
    }
  }

  const head = new DomNode('HEAD');
  const body = new DomNode('BODY');
  const htmlEl = new DomNode('HTML');
  const withItem = <T>(arr: T[]): T[] => {
    (arr as any).item = (i: number) => arr[i] ?? null;
    return arr;
  };

  const document: any = new (class extends EventTarget {
    readyState = 'complete';
    title = options?.gameTitle || 'RPG Maker MV';
    currentScript: ScriptNode | null = null;
    head = head;
    body = body;
    documentElement = htmlEl;
    styleSheets: any[] = [];
    cookie = '';
    hidden = false;
    visibilityState = 'visible';
    activeElement: any = body;
    fonts = {
      ready: Promise.resolve(),
      check: () => true,
      add(face: any) {
        try { (globalThis as any).fonts?.add?.(face); } catch { /* ignore */ }
      },
      delete() { return false; },
    };
    createElement(tag: string) {
      switch (tag.toLowerCase()) {
        case 'canvas': return new CanvasNode();
        case 'script': return new ScriptNode();
        case 'video':
        case 'audio': return new VideoNode(tag.toUpperCase());
        case 'style': {
          const st = new DomNode('STYLE') as any;
          st.sheet = {
            cssRules: [] as string[],
            insertRule(rule: string, idx = 0) {
              this.cssRules.splice(Math.max(0, Math.min(this.cssRules.length, idx)), 0, String(rule ?? ''));
              return idx;
            },
            deleteRule() {},
          };
          return st;
        }
        default: return new DomNode(tag.toUpperCase());
      }
    }
    getElementById(id: string) {
      return [...head.getElementsByTagName('*'), ...body.getElementsByTagName('*')]
        .find((n) => n.id === id) || null;
    }
    getElementsByTagName(name: string) {
      const upper = String(name || '').toUpperCase();
      const out: DomNode[] = [];
      if (upper === '*' || upper === 'HTML') out.push(htmlEl);
      out.push(...htmlEl.getElementsByTagName(name));
      return withItem(out);
    }
    createTextNode(text: string) {
      const n = new DomNode('#text');
      n.textContent = text;
      return n;
    }
    createDocumentFragment() {
      return new DomNode('#document-fragment');
    }
    createEvent(_iface?: string) {
      const ev: any = new Event('__uninitialized__');
      const applyInit = (type: string, bubbles = false, cancelable = false, detail: any = null) => {
        for (const [k, v] of [
          ['type', String(type ?? '')],
          ['bubbles', Boolean(bubbles)],
          ['cancelable', Boolean(cancelable)],
          ['detail', detail],
        ] as const) {
          try {
            Object.defineProperty(ev, k, { configurable: true, enumerable: true, writable: true, value: v });
          } catch {
            ev[k] = v;
          }
        }
      };
      ev.initEvent = (type: string, bubbles?: boolean, cancelable?: boolean) => {
        applyInit(type, bubbles, cancelable, null);
      };
      ev.initCustomEvent = (type: string, bubbles?: boolean, cancelable?: boolean, detail?: any) => {
        applyInit(type, bubbles, cancelable, detail);
      };
      ev.initUIEvent = (type: string, bubbles?: boolean, cancelable?: boolean, _view?: any, detail?: any) => {
        applyInit(type, bubbles, cancelable, detail);
      };
      ev.initMouseEvent = (type: string, bubbles?: boolean, cancelable?: boolean, _view?: any, detail?: any) => {
        applyInit(type, bubbles, cancelable, detail);
      };
      return ev;
    }
    getElementsByClassName() { return withItem([]); }
    getElementsByName() { return withItem([]); }
    querySelector(sel?: string) {
      const s = String(sel || '').trim();
      if (!s) return null;
      if (s.startsWith('#')) return this.getElementById(s.slice(1));
      const list = this.getElementsByTagName(s);
      return list[0] ?? null;
    }
    querySelectorAll(sel?: string) {
      const s = String(sel || '').trim();
      if (!s) return withItem([]);
      if (s.startsWith('#')) {
        const el = this.getElementById(s.slice(1));
        return withItem(el ? [el] : []);
      }
      return this.getElementsByTagName(s);
    }
    hasFocus() { return true; }
  })();
  htmlEl.appendChild(head);
  htmlEl.appendChild(body);
  document.fonts.ready = Promise.resolve(document.fonts);

  // Resource fetch bridge for Image / Audio / plugins
  const resourceFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/^(?:blob|data):/i.test(url)) return rawFetch(input, init);
    const bytes = await assets.read(url);
    if (!bytes) return new Response('Not Found', { status: 404 });
    return new Response(bytes, { status: 200 });
  };

  // Fix nx.js's built-in TextEncoder.prototype.encode: upstream nx.js allocates only `1.5 * len` bytes
  // and never grows the buffer, silently truncating any string with >50% non-ASCII code points (such as
  // RPG Maker MZ's `pako.deflate(..., { to: 'string' })` .rmmzsave save files!). Patching prototype.encode
  // in place also fixes nx.js's internal `Switch.writeFileSync` / `Switch.writeFile` encoder instance!
  const NativeTextEncoder = (globalThis as any).TextEncoder;
  if (NativeTextEncoder?.prototype && !NativeTextEncoder.prototype.__drFixedEncode) {
    NativeTextEncoder.prototype.__drFixedEncode = true;
    NativeTextEncoder.prototype.encode = function (input?: string): Uint8Array {
      return encodeUtf8Safe(input ? String(input) : '');
    };
  }

  // Multi-encoding & stack-safe TextDecoder wrapper:
  // 1. nx.js's built-in TextDecoder throws `TypeError: Only "utf-8" decoding is supported` on 'utf-16le',
  //    'latin1', or uppercase 'UTF-8' (breaking Live2D `enc_lv2d.js`, etc.).
  // 2. nx.js's UTF-8 `TextDecoder.prototype.decode` passes 65,535 arguments to `String.fromCharCode.apply`
  //    at once; replace it with 8192-unit chunking (`decodeUtf8Safe`) so large saves/JSONs never overflow stack.
  const NativeTextDecoder = (globalThis as any).TextDecoder;
  if (NativeTextDecoder && !NativeTextDecoder.__drWrapped) {
    if (NativeTextDecoder.prototype) {
      NativeTextDecoder.prototype.decode = function (input?: BufferSource): string {
        if (!input) return '';
        const bytes = input instanceof Uint8Array
          ? input
          : ArrayBuffer.isView(input)
            ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
            : input instanceof ArrayBuffer
              ? new Uint8Array(input)
              : new Uint8Array(0);
        return decodeUtf8Safe(bytes, !this.ignoreBOM);
      };
    }
    const toUint8 = (input?: BufferSource): Uint8Array => {
      if (!input) return new Uint8Array(0);
      if (input instanceof Uint8Array) return input;
      if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      if (input instanceof ArrayBuffer) return new Uint8Array(input);
      return new Uint8Array(0);
    };
    const WrappedTextDecoder = function (this: any, label = 'utf-8', options?: { fatal?: boolean; ignoreBOM?: boolean }) {
      const norm = String(label ?? 'utf-8').trim().toLowerCase();
      if (norm === '' || norm === 'utf-8' || norm === 'utf8' || norm === 'unicode-1-1-utf-8') {
        return new NativeTextDecoder('utf-8', options);
      }
      const mode: 'utf16le' | 'utf16be' | 'latin1' | 'utf8' =
        norm === 'utf-16le' || norm === 'utf-16' || norm === 'utf16' || norm === 'ucs-2' || norm === 'ucs2'
          ? 'utf16le'
          : norm === 'utf-16be'
            ? 'utf16be'
            : norm === 'latin1' || norm === 'iso-8859-1' || norm === 'windows-1252' || norm === 'ascii' || norm === 'us-ascii'
              ? 'latin1'
              : 'utf8';
      const fallbackUtf8 = mode === 'utf8' ? new NativeTextDecoder('utf-8', options) : null;
      return {
        encoding: norm,
        fatal: Boolean(options?.fatal),
        ignoreBOM: Boolean(options?.ignoreBOM),
        decode(input?: BufferSource): string {
          if (fallbackUtf8) return fallbackUtf8.decode(input);
          const bytes = toUint8(input);
          if (bytes.length === 0) return '';
          if (mode === 'latin1') {
            let out = '';
            for (let i = 0; i < bytes.length; i += 8192) {
              const end = Math.min(bytes.length, i + 8192);
              const chunk: number[] = [];
              for (let j = i; j < end; j++) chunk.push(bytes[j]);
              out += String.fromCharCode.apply(null, chunk);
            }
            return out;
          }
          const isBe = mode === 'utf16be';
          let start = 0;
          if (!options?.ignoreBOM && bytes.length >= 2) {
            if (!isBe && bytes[0] === 0xff && bytes[1] === 0xfe) start = 2;
            else if (isBe && bytes[0] === 0xfe && bytes[1] === 0xff) start = 2;
          }
          let out = '';
          const codes: number[] = [];
          for (let i = start; i + 1 < bytes.length; i += 2) {
            codes.push(isBe ? ((bytes[i] << 8) | bytes[i + 1]) : (bytes[i] | (bytes[i + 1] << 8)));
            if (codes.length >= 4096) {
              out += String.fromCharCode.apply(null, codes);
              codes.length = 0;
            }
          }
          if (codes.length) out += String.fromCharCode.apply(null, codes);
          return out;
        },
      };
    } as any;
    WrappedTextDecoder.__drWrapped = true;
    WrappedTextDecoder.prototype = NativeTextDecoder.prototype;
    (globalThis as any).TextDecoder = WrappedTextDecoder;
  }

  // Wrap Image so async load/error events dispatch cleanly and empty src resets don't error
  const NativeImage = (globalThis as any).Image;
  if (NativeImage && !NativeImage.__drWrapped) {
    const WrappedImage = function (this: any) {
      const img = new NativeImage();
      const origDispatch = img.dispatchEvent.bind(img);
      img.dispatchEvent = (ev: Event) => {
        if (ev.type === 'load' || ev.type === 'error') {
          setTimeout(() => origDispatch(ev), 0);
          return true;
        }
        return origDispatch(ev);
      };
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(img), 'src');
      if (desc?.get && desc.set) {
        let isEmpty = false;
        Object.defineProperty(img, 'src', {
          configurable: true,
          get: () => (isEmpty ? '' : desc.get!.call(img)),
          set: (val: string) => {
            isEmpty = !val;
            if (!isEmpty) desc.set!.call(img, val);
          },
        });
      }
      return img;
    } as any;
    WrappedImage.__drWrapped = true;
    WrappedImage.prototype = NativeImage.prototype;
    (globalThis as any).Image = WrappedImage;
  }

  // Wrap FontFace so CSS `url(...)` sources (e.g. Coffin's Font.change `url(blob:...)` / `url(fonts/...)`)
  // and `face.load()` Promises work seamlessly on nx.js (whose native FontFace only accepts ArrayBuffer
  // and throws `Method not implemented` on `.load()`).
  const NativeFontFace = (globalThis as any).FontFace;
  if (NativeFontFace && !NativeFontFace.__drWrapped) {
    const WrappedFontFace = function (this: any, family: string, source: string | BufferSource, descriptors?: any) {
      if (typeof source !== 'string') {
        const face = new NativeFontFace(family, source, descriptors);
        if (typeof face.load !== 'function' || !face.__drLoadPatched) {
          face.__drLoadPatched = true;
          try {
            face.load = () => Promise.resolve(face);
          } catch { /* ignore */ }
        }
        return face;
      }
      const urlMatch = /^\s*url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+))\s*\)/i.exec(source);
      const rawUrl = (urlMatch?.[1] ?? urlMatch?.[2] ?? urlMatch?.[3] ?? source).trim();
      let loadedPromise: Promise<any> | null = null;
      const wrapper: any = {
        family,
        status: 'unloaded',
        style: descriptors?.style ?? 'normal',
        weight: descriptors?.weight ?? 'normal',
        stretch: descriptors?.stretch ?? 'normal',
        display: descriptors?.display ?? 'auto',
        load() {
          if (!loadedPromise) {
            wrapper.status = 'loading';
            loadedPromise = (async () => {
              const res = await resourceFetch(rawUrl);
              if (!res.ok) throw new Error(`Failed to fetch font: ${rawUrl} (${res.status})`);
              const buf = await res.arrayBuffer();
              const nativeFace = new NativeFontFace(family, buf, descriptors);
              try { nativeFace.load = () => Promise.resolve(nativeFace); } catch { /* ignore */ }
              wrapper.status = 'loaded';
              return nativeFace;
            })();
          }
          return loadedPromise;
        },
      };
      Object.defineProperty(wrapper, 'loaded', {
        configurable: true,
        get: () => wrapper.load(),
      });
      return wrapper;
    } as any;
    WrappedFontFace.__drWrapped = true;
    WrappedFontFace.prototype = NativeFontFace.prototype;
    (globalThis as any).FontFace = WrappedFontFace;
  }

  // Provide standard browser Base64 helpers (`atob` / `btoa`) if absent in nx.js (required by Coffin's DRM check).
  const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (typeof (globalThis as any).atob !== 'function') {
    (globalThis as any).atob = (input: string): string => {
      const clean = String(input ?? '').replace(/[\t\n\f\r ]+/g, '');
      let out = '';
      for (let i = 0; i < clean.length; i += 4) {
        const a = B64_CHARS.indexOf(clean[i]);
        const b = B64_CHARS.indexOf(clean[i + 1] ?? '=');
        const cCh = clean[i + 2] ?? '=';
        const dCh = clean[i + 3] ?? '=';
        const c = cCh === '=' ? -1 : B64_CHARS.indexOf(cCh);
        const d = dCh === '=' ? -1 : B64_CHARS.indexOf(dCh);
        if (a < 0 || b < 0) break;
        out += String.fromCharCode(((a << 2) | (b >> 4)) & 0xff);
        if (c >= 0) out += String.fromCharCode((((b & 15) << 4) | (c >> 2)) & 0xff);
        if (d >= 0) out += String.fromCharCode((((c & 3) << 6) | d) & 0xff);
      }
      return out;
    };
  }
  if (typeof (globalThis as any).btoa !== 'function') {
    (globalThis as any).btoa = (input: string): string => {
      const str = String(input ?? '');
      let out = '';
      for (let i = 0; i < str.length; i += 3) {
        const a = str.charCodeAt(i) & 0xff;
        const b = i + 1 < str.length ? (str.charCodeAt(i + 1) & 0xff) : -1;
        const c = i + 2 < str.length ? (str.charCodeAt(i + 2) & 0xff) : -1;
        out += B64_CHARS[a >> 2];
        out += B64_CHARS[((a & 3) << 4) | (b >= 0 ? b >> 4 : 0)];
        out += b < 0 ? '=' : B64_CHARS[((b & 15) << 2) | (c >= 0 ? c >> 6 : 0)];
        out += c < 0 ? '=' : B64_CHARS[c & 63];
      }
      return out;
    };
  }

  const g = globalThis as any;
  Object.assign(g, {
    window: g,
    self: g,
    document,
    XMLHttpRequest: LocalXHR,
    HTMLElement: DomNode,
    HTMLCanvasElement: CanvasNode,
    HTMLImageElement: g.Image,
    HTMLVideoElement: VideoNode,
    HTMLScriptElement: ScriptNode,
    ...(enableWebGL && g.WebGL2RenderingContext && !g.WebGLRenderingContext
      ? { WebGLRenderingContext: g.WebGL2RenderingContext }
      : {}),
    fetch: resourceFetch,
    location: {
      href: 'game:/index.html',
      pathname: '/index.html',
      protocol: 'file:',
      search: '',
      hash: '',
      reload() {},
    },
    devicePixelRatio: 1,
  });
  Object.defineProperty(g, 'innerWidth', {
    configurable: true,
    enumerable: true,
    get: () => gameCanvas?.width || 816,
  });
  Object.defineProperty(g, 'innerHeight', {
    configurable: true,
    enumerable: true,
    get: () => gameCanvas?.height || 624,
  });

  if (!g.navigator) g.navigator = {};
  if (!g.navigator.userAgent) {
    Object.defineProperty(g.navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Nintendo Switch 2; kaiHEN) AppleWebKit/537.36 Chrome/120.0.0.0',
    });
  }
  if (!g.navigator.language) {
    try {
      Object.defineProperty(g.navigator, 'language', { configurable: true, value: 'en-US' });
    } catch { /* ignore */ }
  }
  if (!g.navigator.plugins) {
    try {
      Object.defineProperty(g.navigator, 'plugins', {
        configurable: true,
        value: { length: 0, item: () => null, namedItem: () => null },
      });
    } catch {
      g.navigator.plugins = { length: 0, item: () => null, namedItem: () => null };
    }
  }
  for (const fn of ['moveBy', 'moveTo', 'resizeBy', 'resizeTo', 'focus', 'blur', 'close', 'scrollTo']) {
    if (typeof g[fn] !== 'function') g[fn] = () => {};
  }
  if (typeof g.addEventListener !== 'function' && typeof EventTarget !== 'undefined') {
    const winEvents = new EventTarget();
    g.addEventListener = winEvents.addEventListener.bind(winEvents);
    g.removeEventListener = winEvents.removeEventListener.bind(winEvents);
    g.dispatchEvent = winEvents.dispatchEvent.bind(winEvents);
  }
  if (typeof g.open !== 'function') {
    g.open = (url?: string) => {
      log(`[window.open] ignored external URL on Switch 2: ${String(url ?? '')}`);
      return {
        closed: true,
        opener: g,
        location: { href: String(url ?? '') },
        focus() {},
        blur() {},
        close() {},
      };
    };
  }
  if (typeof Event !== 'undefined' && Event.prototype && typeof (Event.prototype as any).initEvent !== 'function') {
    (Event.prototype as any).initEvent = function (type: string, bubbles = false, cancelable = false) {
      for (const [k, v] of [
        ['type', String(type ?? '')],
        ['bubbles', Boolean(bubbles)],
        ['cancelable', Boolean(cancelable)],
      ] as const) {
        try {
          Object.defineProperty(this, k, { configurable: true, enumerable: true, writable: true, value: v });
        } catch {
          (this as any)[k] = v;
        }
      }
    };
    (Event.prototype as any).initCustomEvent = function (type: string, bubbles = false, cancelable = false, detail: any = null) {
      (this as any).initEvent(type, bubbles, cancelable);
      try {
        Object.defineProperty(this, 'detail', { configurable: true, enumerable: true, writable: true, value: detail });
      } catch {
        (this as any).detail = detail;
      }
    };
  }
  for (const ruVar of ['VoiceMuteSwNo', 'VoiceVolVarNo', 'EnCountVarNo']) {
    if (g[ruVar] === undefined) {
      g[ruVar] = 0;
    }
  }
  if (typeof g.alert !== 'function') {
    g.alert = (msg?: any) => { log(`[alert] ${String(msg ?? '')}`); };
  }
  if (typeof g.confirm !== 'function') {
    g.confirm = (msg?: any) => { log(`[confirm] ${String(msg ?? '')}`); return true; };
  }
  if (typeof g.getComputedStyle !== 'function') {
    const NAMED_COLORS: Record<string, string> = {
      black: 'rgb(0, 0, 0)',
      white: 'rgb(255, 255, 255)',
      red: 'rgb(255, 0, 0)',
      green: 'rgb(0, 128, 0)',
      blue: 'rgb(0, 0, 255)',
      gray: 'rgb(128, 128, 128)',
      grey: 'rgb(128, 128, 128)',
      silver: 'rgb(192, 192, 192)',
      yellow: 'rgb(255, 255, 0)',
      cyan: 'rgb(0, 255, 255)',
      magenta: 'rgb(255, 0, 255)',
      orange: 'rgb(255, 165, 0)',
      purple: 'rgb(128, 0, 128)',
      transparent: 'rgba(0, 0, 0, 0)',
    };
    const parseCssColor = (raw: any): string => {
      const s = String(raw ?? '').trim().toLowerCase();
      if (!s) return 'rgb(255, 255, 255)';
      if (NAMED_COLORS[s]) return NAMED_COLORS[s];
      if (/^rgba?\(/.test(s)) return s;
      const hex6 = /^#([0-9a-f]{6})$/.exec(s);
      if (hex6) {
        const n = parseInt(hex6[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      }
      const hex3 = /^#([0-9a-f]{3})$/.exec(s);
      if (hex3) {
        const h = hex3[1];
        return `rgb(${parseInt(h[0] + h[0], 16)}, ${parseInt(h[1] + h[1], 16)}, ${parseInt(h[2] + h[2], 16)})`;
      }
      return 'rgb(255, 255, 255)';
    };
    g.getComputedStyle = (el?: any) => {
      const st = el?.style ?? {};
      const color = parseCssColor(st.color);
      return {
        ...st,
        color,
        backgroundColor: parseCssColor(st.backgroundColor || 'transparent'),
        getPropertyValue(prop: string) {
          if (prop === 'color') return color;
          return String(st[prop] ?? '');
        },
      };
    };
  }

  // Shim MediaStream / MediaRecorder so PC screen-recorder plugins (e.g. MakeScreenMovie,
  // RecScene, custom ScreenRecorder wrappers) never crash SceneManager.initialize() on Switch 2.
  if (typeof g.MediaStream === 'undefined') {
    g.MediaStream = class MediaStream {
      getTracks() { return []; }
      getVideoTracks() { return []; }
      getAudioTracks() { return []; }
      addTrack() {}
      removeTrack() {}
    };
  }
  if (typeof g.MediaRecorder === 'undefined') {
    g.MediaRecorder = class MediaRecorder extends EventTarget {
      static isTypeSupported(mime?: string) {
        const m = String(mime ?? '').toLowerCase();
        return !m || m.includes('webm');
      }
      state = 'inactive';
      mimeType = 'video/webm';
      ondataavailable: ((ev: any) => void) | null = null;
      onstop: ((ev: any) => void) | null = null;
      onerror: ((ev: any) => void) | null = null;
      constructor(_stream?: any, opts?: { mimeType?: string }) {
        super();
        if (opts?.mimeType) this.mimeType = opts.mimeType;
      }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; }
      pause() { this.state = 'paused'; }
      resume() { this.state = 'recording'; }
      requestData() {}
    };
  }

  // Safe in-memory Storage shim so MV plugins touching localStorage/sessionStorage never
  // trigger Horizon's system save profile selector or throw when undefined.
  const createMemStorage = () => {
    const map = new Map<string, string>();
    return {
      get length() { return map.size; },
      key(i: number) { return Array.from(map.keys())[i] ?? null; },
      getItem(k: string) { return map.has(String(k)) ? map.get(String(k))! : null; },
      setItem(k: string, v: string) { map.set(String(k), String(v)); },
      removeItem(k: string) { map.delete(String(k)); },
      clear() { map.clear(); },
    };
  };
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    try {
      Object.defineProperty(g, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: createMemStorage(),
      });
    } catch { /* ignore if non-configurable */ }
  }

  // Lightweight IndexedDB presence shim so RPG Maker MZ's SceneManager.checkBrowser()
  // (`Utils.canUseIndexedDB()`) and localforage pass cleanly (saves use local SD mode).
  if (typeof g.indexedDB === 'undefined') {
    const makeStubReq = () => {
      const req: any = {
        result: null,
        error: new Error('IndexedDB stub (Switch 2 uses local SD saves)'),
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      setTimeout(() => { try { req.onerror?.({ target: req }); } catch { /* ignore */ } }, 0);
      return req;
    };
    g.indexedDB = {
      open: () => makeStubReq(),
      deleteDatabase: () => makeStubReq(),
    };
  }

  // Shim WebAudio PannerNode onto nx.js's native StereoPannerNode (RPG Maker MV's
  // WebAudio._createNodes calls context.createPanner() + setPosition(x, 0, z),
  // whereas nx.js implements createStereoPanner() and throws on createPanner()).
  const installAudioCompat = () => {
    const protos: any[] = [];
    if (g.BaseAudioContext?.prototype) protos.push(g.BaseAudioContext.prototype);
    if (g.AudioContext?.prototype && !protos.includes(g.AudioContext.prototype)) {
      protos.push(g.AudioContext.prototype);
    }
    const createPannerShim = function (this: any) {
      const node: any = typeof this.createStereoPanner === 'function'
        ? this.createStereoPanner()
        : this.createGain();
      node.panningModel = 'equalpower';
      node.distanceModel = 'inverse';
      node.refDistance = 1;
      node.maxDistance = 10000;
      node.rolloffFactor = 1;
      node.coneInnerAngle = 360;
      node.coneOuterAngle = 360;
      node.coneOuterGain = 0;
      node.setPosition = (x: number, _y = 0, _z = 0) => {
        const clamped = Math.max(-1, Math.min(1, Number(x) || 0));
        try {
          if (node.pan && typeof node.pan.value === 'number') {
            node.pan.value = clamped;
          }
        } catch { /* ignore */ }
      };
      node.setOrientation = () => {};
      node.setVelocity = () => {};
      return node;
    };
    for (const proto of protos) {
      try {
        Object.defineProperty(proto, 'createPanner', {
          configurable: true,
          writable: true,
          value: createPannerShim,
        });
      } catch {
        proto.createPanner = createPannerShim;
      }
      if (typeof proto.createMediaStreamDestination !== 'function') {
        const createMsdShim = function (this: any) {
          const gain = typeof this.createGain === 'function' ? this.createGain() : {};
          gain.stream = new g.MediaStream();
          return gain;
        };
        try {
          Object.defineProperty(proto, 'createMediaStreamDestination', {
            configurable: true,
            writable: true,
            value: createMsdShim,
          });
        } catch {
          proto.createMediaStreamDestination = createMsdShim;
        }
      }
    }
  };
  installAudioCompat();

  return {
    loadScript(path: string) { return enqueueScript(path); },
    async settled() {
      let guard = 0;
      while (pendingCount > 0 && guard++ < 500) {
        await scriptChain;
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    setDisplayMode(mode: DisplayMode) {
      if (displayMode !== mode) {
        displayMode = mode;
        viewportDirty = true;
        letterboxDirty = true;
        webglCtx?.__drSyncViewport?.();
      }
    },
    getDisplayMode() { return displayMode; },
    setFilterMode(mode: FilterMode) {
      filterMode = mode;
    },
    getFilterMode() { return filterMode; },
    getViewport() { return refreshViewport(); },
    getScreenContext() { return screenCtx; },
    getWebGLContext() { return webglCtx; },
    ensureWebGLContext() { return getOrCreateWebGL2(); },
    getGameCanvas() { return gameCanvas; },
    isDirectGpu() { return Boolean(gameCanvas?.direct || webglCtx); },
    markLetterboxDirty() { letterboxDirty = true; },
    forceStopVideos() {
      for (const v of Array.from(activeVideos)) v.forceFinish();
    },
    getSkippedScripts() {
      return skippedScripts.slice();
    },
    beginFrame() {
      if (enableWebGL && webglCtx) {
        webglCtx.__drClearScreen?.();
        return;
      }
      if (!screenCtx || !gameCanvas?.direct) return;
      const vp = refreshViewport();
      clearLetterboxIfNeeded(vp);
      screenCtx.save();
      screenCtx.setTransform(1, 0, 0, 1, 0, 0);
      screenCtx.beginPath();
      screenCtx.rect(vp.x, vp.y, vp.w, vp.h);
      screenCtx.clip();
      applyFilterMode(screenCtx, displayMode !== 'pixel');
      screenCtx.setTransform(vpSx, 0, 0, vpSy, vp.x, vp.y);
      gameCanvas._resetDirectState?.();
      inDirectFrame = true;
    },
    endFrame(activeVideo?: any | null) {
      if (!screenCtx) return;
      if (inDirectFrame) {
        screenCtx.restore();
        inDirectFrame = false;
      }
      const vp = refreshViewport();
      if (!gameCanvas?.direct && gameCanvas) {
        clearLetterboxIfNeeded(vp);
        const prevSmooth = screenCtx.imageSmoothingEnabled;
        const prevQual = screenCtx.imageSmoothingQuality;
        applyFilterMode(screenCtx, displayMode !== 'pixel');
        screenCtx.drawImage(gameCanvas.surface(), 0, 0, gameCanvas.width, gameCanvas.height, vp.x, vp.y, vp.w, vp.h);
        screenCtx.imageSmoothingEnabled = prevSmooth;
        screenCtx.imageSmoothingQuality = prevQual;
      }
      // Composite full-screen Graphics.playVideo() stream if currently playing
      const vidNode = activeVideo instanceof VideoNode ? activeVideo : null;
      if (vidNode && vidNode.nativeVideo && !vidNode.paused && !vidNode.ended) {
        try {
          screenCtx.drawImage(vidNode.nativeVideo, vp.x, vp.y, vp.w, vp.h);
        } catch { /* ignore transient frame decode state */ }
      }
    },
    present(activeVideo?: any | null) {
      if (!screenCtx) return;
      const vp = refreshViewport();
      if (!gameCanvas?.direct && gameCanvas) {
        clearLetterboxIfNeeded(vp);
        const prevSmooth = screenCtx.imageSmoothingEnabled;
        const prevQual = screenCtx.imageSmoothingQuality;
        applyFilterMode(screenCtx, displayMode !== 'pixel');
        screenCtx.drawImage(gameCanvas.surface(), 0, 0, gameCanvas.width, gameCanvas.height, vp.x, vp.y, vp.w, vp.h);
        screenCtx.imageSmoothingEnabled = prevSmooth;
        screenCtx.imageSmoothingQuality = prevQual;
      }
      const vidNode = activeVideo instanceof VideoNode ? activeVideo : null;
      if (vidNode && vidNode.nativeVideo && !vidNode.paused && !vidNode.ended) {
        try {
          screenCtx.drawImage(vidNode.nativeVideo, vp.x, vp.y, vp.w, vp.h);
        } catch { /* ignore transient frame decode state */ }
      }
    },
  };
}
