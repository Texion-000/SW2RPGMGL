/**
 * Lightweight WebGL2 fullscreen-quad splash & error screen renderer.
 * Draws the exact same MV loading/error layout onto a 1280x720 OffscreenCanvas
 * and presents it over WebGL2 without ever touching `screen.getContext('2d')`.
 */
import { getLogPath, log } from './log';

declare const screen: any;

export interface WebGLSplash {
  draw(title: string, progress: number, status: string, detail?: string, isError?: boolean): Promise<void>;
  dispose(): void;
}

export function createWebGLSplash(
  gl: any,
  subtitle = 'SW2RPGMGL  •  RPG Maker MZ (kaiHEN / OunceVK WebGL2)',
  accentColor = '#3dd6a5',
): WebGLSplash | null {
  if (!gl) return null;
  try {
    const sw = screen?.width || 1280;
    const sh = screen?.height || 720;
    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const vsSrc = `
      attribute vec2 aPos;
      attribute vec2 aUv;
      varying vec2 vUv;
      void main() {
        vUv = aUv;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;
    const fsSrc = `
      precision mediump float;
      varying vec2 vUv;
      uniform sampler2D uTex;
      void main() {
        gl_FragColor = texture2D(uTex, vUv);
      }
    `;

    const compile = (type: number, src: string) => {
      const shd = gl.createShader(type);
      gl.shaderSource(shd, src);
      gl.compileShader(shd);
      if (!gl.getShaderParameter(shd, gl.COMPILE_STATUS)) {
        log(`[webgl-splash] shader compile error: ${gl.getShaderInfoLog(shd)}`);
        gl.deleteShader(shd);
        return null;
      }
      return shd;
    };

    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      log(`[webgl-splash] program link error: ${gl.getProgramInfoLog(prog)}`);
      gl.deleteProgram(prog);
      return null;
    }

    const vao = typeof gl.createVertexArray === 'function' ? gl.createVertexArray() : null;
    const vbo = gl.createBuffer();
    const verts = new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0,
    ]);
    if (vao) gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    const locPos = gl.getAttribLocation(prog, 'aPos');
    const locUv = gl.getAttribLocation(prog, 'aUv');
    const locTex = gl.getUniformLocation(prog, 'uTex');
    if (locPos >= 0) {
      gl.enableVertexAttribArray(locPos);
      gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 16, 0);
    }
    if (locUv >= 0) {
      gl.enableVertexAttribArray(locUv);
      gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 16, 8);
    }
    if (vao) gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    let disposed = false;

    const presentFrame = () => {
      if (disposed) return;
      gl.__drSetRawViewport?.(true);
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.BLEND);
        gl.viewport(0, 0, sw, sh);
        gl.clearColor(0.05, 0.06, 0.09, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL ?? 0x9240, 0);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL ?? 0x9241, 0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        if (locTex !== null) gl.uniform1i(locTex, 0);

        if (vao) {
          gl.bindVertexArray(vao);
        } else {
          gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
          if (locPos >= 0) {
            gl.enableVertexAttribArray(locPos);
            gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 16, 0);
          }
          if (locUv >= 0) {
            gl.enableVertexAttribArray(locUv);
            gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 16, 8);
          }
        }
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (vao) gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.useProgram(null);
      } finally {
        gl.__drSetRawViewport?.(false);
      }
    };

    const nextFrame = () =>
      new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 16);
        }
      });

    return {
      async draw(title: string, progress: number, status: string, detail = '', isError = false) {
        if (disposed) return;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = isError ? '#1a0c12' : '#0d1018';
        ctx.fillRect(0, 0, sw, sh);

        ctx.fillStyle = isError ? '#ff5c72' : '#f1f5ff';
        ctx.font = '40px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(title.length > 36 ? title.slice(0, 35) + '…' : title, 72, 76);

        ctx.fillStyle = isError ? '#d96b7c' : accentColor;
        ctx.font = '20px sans-serif';
        ctx.fillText(subtitle, 72, 130);

        const barX = 72;
        const barY = 204;
        const barW = sw - 144;
        const barH = 18;
        ctx.fillStyle = '#1e2638';
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = isError ? '#ff4d63' : accentColor;
        ctx.fillRect(barX, barY, Math.round(barW * Math.max(0, Math.min(1, progress))), barH);

        ctx.fillStyle = '#ffffff';
        ctx.font = '24px sans-serif';
        ctx.fillText(status, 72, 242);

        if (detail) {
          ctx.fillStyle = '#a8b5d1';
          ctx.font = '18px sans-serif';
          const lines = detail.split('\n');
          for (let i = 0; i < lines.length && i < 14; i++) {
            ctx.fillText(lines[i].slice(0, 110), 72, 288 + i * 26);
          }
        }

        ctx.fillStyle = '#73809e';
        ctx.font = '16px sans-serif';
        ctx.fillText(
          isError
            ? `Press A: Return to Game Select   •   Press +: Exit to hbmenu   •   Log: ${getLogPath()}`
            : 'Press Minus (-) anytime in-game for Display, HUD, Game Select & Exit',
          72,
          sh - 54,
        );
        ctx.restore();

        presentFrame();
        await nextFrame();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          if (vao) gl.deleteVertexArray(vao);
          gl.deleteBuffer(vbo);
          gl.deleteTexture(tex);
          gl.deleteProgram(prog);
        } catch { /* ignore */ }
      },
    };
  } catch (err) {
    log(`[webgl-splash] init failed: ${String(err)}`);
    return null;
  }
}
