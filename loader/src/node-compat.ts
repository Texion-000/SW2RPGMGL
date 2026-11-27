/**
 * Minimal, safe Node.js / NW.js compatibility shim for RPG Maker MV plugins:
 *   - path, fs, nw.gui, child_process, process, Buffer
 *   - Confines all plugin file writes safely inside the active game's directory & save folder.
 */
import { ensureDir, type SwitchApi } from './log';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

export function encodeUtf8Safe(str: string): Uint8Array {
  if (!str) return new Uint8Array(0);
  const len = str.length;
  // Worst-case UTF-8 is 3 bytes per UTF-16 code unit (surrogate pairs use 2 units -> 4 bytes <= 6).
  // Note: nx.js's built-in TextEncoder only allocates 1.5x `len` and silently truncates binary strings
  // (such as RPG Maker MZ's `pako.deflate(..., { to: 'string' })` .rmmzsave streams)!
  const target = new Uint8Array(len * 3);
  let at = 0;
  for (let pos = 0; pos < len; ) {
    let value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff) {
      if (pos < len) {
        const extra = str.charCodeAt(pos);
        if ((extra & 0xfc00) === 0xdc00) {
          pos++;
          value = ((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000;
        } else {
          value = 0xfffd;
        }
      } else {
        value = 0xfffd;
      }
    } else if (value >= 0xdc00 && value <= 0xdfff) {
      value = 0xfffd;
    }

    if ((value & 0xffffff80) === 0) {
      target[at++] = value;
    } else if ((value & 0xfffff800) === 0) {
      target[at++] = ((value >>> 6) & 0x1f) | 0xc0;
      target[at++] = (value & 0x3f) | 0x80;
    } else if ((value & 0xffff0000) === 0) {
      target[at++] = ((value >>> 12) & 0x0f) | 0xe0;
      target[at++] = ((value >>> 6) & 0x3f) | 0x80;
      target[at++] = (value & 0x3f) | 0x80;
    } else {
      target[at++] = ((value >>> 18) & 0x07) | 0xf0;
      target[at++] = ((value >>> 12) & 0x3f) | 0x80;
      target[at++] = ((value >>> 6) & 0x3f) | 0x80;
      target[at++] = (value & 0x3f) | 0x80;
    }
  }
  return target.slice(0, at);
}

export function decodeUtf8Safe(bytes: Uint8Array, stripBom = false): string {
  if (!bytes || bytes.length === 0) return '';
  const len = bytes.length;
  const CHUNK = 8192;
  const pending = new Uint16Array(CHUNK);
  let pendingIdx = 0;
  let out = '';
  let i = 0;
  if (stripBom && len >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    i = 3;
  }
  while (i < len) {
    if (pendingIdx >= CHUNK - 2) {
      out += String.fromCharCode.apply(null, pending.subarray(0, pendingIdx) as unknown as number[]);
      pendingIdx = 0;
    }
    const b1 = bytes[i++];
    if ((b1 & 0x80) === 0) {
      pending[pendingIdx++] = b1;
    } else if ((b1 & 0xe0) === 0xc0) {
      const b2 = bytes[i++];
      if (b2 === undefined || (b2 & 0xc0) !== 0x80) {
        pending[pendingIdx++] = 0xfffd;
        if (b2 !== undefined) i--;
      } else {
        pending[pendingIdx++] = ((b1 & 0x1f) << 6) | (b2 & 0x3f);
      }
    } else if ((b1 & 0xf0) === 0xe0) {
      const b2 = bytes[i++];
      if (b2 === undefined || (b2 & 0xc0) !== 0x80) {
        pending[pendingIdx++] = 0xfffd;
        if (b2 !== undefined) i--;
      } else {
        const b3 = bytes[i++];
        if (b3 === undefined || (b3 & 0xc0) !== 0x80) {
          pending[pendingIdx++] = 0xfffd;
          if (b3 !== undefined) i--;
        } else {
          pending[pendingIdx++] = ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        }
      }
    } else if ((b1 & 0xf8) === 0xf0) {
      const b2 = bytes[i++];
      if (b2 === undefined || (b2 & 0xc0) !== 0x80) {
        pending[pendingIdx++] = 0xfffd;
        if (b2 !== undefined) i--;
      } else {
        const b3 = bytes[i++];
        if (b3 === undefined || (b3 & 0xc0) !== 0x80) {
          pending[pendingIdx++] = 0xfffd;
          if (b3 !== undefined) i--;
        } else {
          const b4 = bytes[i++];
          if (b4 === undefined || (b4 & 0xc0) !== 0x80) {
            pending[pendingIdx++] = 0xfffd;
            if (b4 !== undefined) i--;
          } else {
            let cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
            if (cp > 0xffff) {
              cp -= 0x10000;
              pending[pendingIdx++] = ((cp >>> 10) & 0x3ff) | 0xd800;
              pending[pendingIdx++] = 0xdc00 | (cp & 0x3ff);
            } else {
              pending[pendingIdx++] = cp;
            }
          }
        }
      }
    } else {
      pending[pendingIdx++] = 0xfffd;
    }
  }
  if (pendingIdx > 0) {
    out += String.fromCharCode.apply(null, pending.subarray(0, pendingIdx) as unknown as number[]);
  }
  return out;
}

function encodeUtf8(str: string): Uint8Array {
  return encodeUtf8Safe(str);
}

function decodeUtf8(bytes: Uint8Array): string {
  return decodeUtf8Safe(bytes, false);
}

function decodeBase64(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const a = chars.indexOf(clean[i]);
    const b = chars.indexOf(clean[i + 1] ?? '=');
    const c = chars.indexOf(clean[i + 2] ?? '=');
    const d = chars.indexOf(clean[i + 3] ?? '=');
    out.push((a << 2) | (b >> 4));
    if (c >= 0 && clean[i + 2] !== '=') out.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0 && clean[i + 3] !== '=') out.push(((c & 3) << 6) | d);
  }
  return new Uint8Array(out);
}

export function encodeBase64Bytes(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const c = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >= 0 ? b >> 4 : 0)];
    out += b < 0 ? '=' : chars[((b & 15) << 2) | (c >= 0 ? c >> 6 : 0)];
    out += c < 0 ? '=' : chars[c & 63];
  }
  return out;
}

export function decodeBase64Bytes(b64: string): Uint8Array {
  return decodeBase64(b64);
}

function encodeHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function decodeHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const len = clean.length >>> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

function encodeLatin1(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    const end = Math.min(bytes.length, i + 8192);
    const chunk: number[] = [];
    for (let j = i; j < end; j++) chunk.push(bytes[j]);
    out += String.fromCharCode.apply(null, chunk);
  }
  return out;
}

function isRawArrayBuffer(x: unknown): x is ArrayBuffer {
  return x instanceof ArrayBuffer || Object.prototype.toString.call(x) === '[object ArrayBuffer]';
}

export class MiniBuffer extends Uint8Array {
  constructor(arg: any, encodingOrOffset?: string | number, length?: number) {
    if (typeof arg === 'string') {
      const enc = (typeof encodingOrOffset === 'string' ? encodingOrOffset : 'utf8').toLowerCase();
      if (enc === 'base64') super(decodeBase64(arg));
      else if (enc === 'hex') super(decodeHex(arg));
      else if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') super(encodeLatin1(arg));
      else super(encodeUtf8(arg));
    } else if (typeof arg === 'number') {
      super(Math.max(0, arg | 0));
    } else if (isRawArrayBuffer(arg)) {
      if (typeof encodingOrOffset === 'number') {
        if (typeof length === 'number') super(arg, encodingOrOffset, length);
        else super(arg, encodingOrOffset);
      } else {
        // Zero-copy view over raw ArrayBuffer (matches Node Buffer.from(arrayBuffer))
        super(arg, 0, arg.byteLength);
      }
    } else if (ArrayBuffer.isView(arg)) {
      super(new Uint8Array(arg.buffer, arg.byteOffset, arg.byteLength));
    } else if (Array.isArray(arg)) {
      super(arg);
    } else {
      super(0);
    }
  }
  static override from(val: any, encOrMap?: any, _thisArg?: any): MiniBuffer {
    if (typeof val === 'number') {
      return new MiniBuffer(0);
    }
    return new MiniBuffer(val, typeof encOrMap === 'string' ? encOrMap : undefined);
  }
  static alloc(size: number, fill = 0): MiniBuffer {
    const b = new MiniBuffer(size);
    if (fill) b.fill(fill & 0xff);
    return b;
  }
  static allocUnsafe(size: number): MiniBuffer {
    return new MiniBuffer(size);
  }
  static isBuffer(x: unknown): x is MiniBuffer {
    return x instanceof MiniBuffer || x instanceof Uint8Array;
  }
  static concat(list: ArrayLike<Uint8Array | ArrayBufferView>, totalLength?: number): MiniBuffer {
    let total = 0;
    let nonEmptyCount = 0;
    let singleItem: any = null;
    if (typeof totalLength === 'number') {
      total = Math.max(0, totalLength | 0);
    } else {
      for (let i = 0; i < list.length; i++) {
        const bl = list[i]?.byteLength ?? 0;
        if (bl > 0) {
          total += bl;
          nonEmptyCount++;
          singleItem = list[i];
        }
      }
      // Zero-copy fast-path for `Buffer.concat([decipher.update(buf), decipher.final()])` where final() is empty
      if (nonEmptyCount === 1 && singleItem instanceof MiniBuffer && singleItem.byteLength === total) {
        return singleItem;
      }
    }
    const out = new MiniBuffer(total);
    let offset = 0;
    for (let i = 0; i < list.length && offset < total; i++) {
      const item = list[i];
      if (!item || item.byteLength === 0) continue;
      const u = item instanceof Uint8Array
        ? item
        : new Uint8Array(item.buffer, item.byteOffset || 0, item.byteLength);
      const take = Math.min(u.byteLength, total - offset);
      out.set(u.subarray(0, take), offset);
      offset += take;
    }
    return out;
  }
  static byteLength(str: string | Uint8Array, encoding = 'utf8'): number {
    if (typeof str !== 'string') return str.byteLength;
    return MiniBuffer.from(str, encoding).byteLength;
  }
  equals(other: Uint8Array): boolean {
    if (!other || this.byteLength !== other.byteLength) return false;
    for (let i = 0; i < this.byteLength; i++) {
      if (this[i] !== other[i]) return false;
    }
    return true;
  }
  override subarray(start?: number, end?: number): MiniBuffer {
    const sub = Uint8Array.prototype.subarray.call(this, start, end);
    Object.setPrototypeOf(sub, MiniBuffer.prototype);
    return sub as MiniBuffer;
  }
  override slice(start?: number, end?: number): MiniBuffer {
    // Node.js Buffer.prototype.slice returns a zero-copy view sharing memory (unlike Uint8Array.prototype.slice)
    return this.subarray(start, end);
  }
  override toString(encoding = 'utf8', start = 0, end = this.byteLength): string {
    const sub = (start === 0 && end === this.byteLength) ? this : this.subarray(start, end);
    const enc = String(encoding || 'utf8').toLowerCase();
    if (enc === 'base64') return encodeBase64Bytes(sub);
    if (enc === 'hex') return encodeHex(sub);
    if (enc === 'latin1' || enc === 'binary' || enc === 'ascii') return decodeLatin1(sub);
    return decodeUtf8(sub);
  }
}

function toBytes(data: string | Uint8Array | ArrayBuffer, encoding = 'utf8'): Uint8Array {
  if (typeof data === 'string') return MiniBuffer.from(data, encoding);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (isRawArrayBuffer(data)) return new Uint8Array(data);
  return new Uint8Array(0);
}

// ============================================================================
// Pure-TS SHA-256 & AES-CTR/CBC (for Coffin SHA-256 asset hashing & OMORI AES-256-CTR)
// ============================================================================
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Bytes(msg: Uint8Array): MiniBuffer {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const len = msg.length;
  const bitLenHi = Math.floor((len * 8) / 0x100000000) >>> 0;
  const bitLenLo = (len * 8) >>> 0;
  const padLen = ((len + 9 + 63) & ~63);
  const padded = new Uint8Array(padLen);
  padded.set(msg);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 8, bitLenHi, false);
  dv.setUint32(padLen - 4, bitLenLo, false);
  const w = new Uint32Array(64);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const v15 = w[i - 15], v2 = w[i - 2];
      const s0 = ((v15 >>> 7) | (v15 << 25)) ^ ((v15 >>> 18) | (v15 << 14)) ^ (v15 >>> 3);
      const s1 = ((v2 >>> 17) | (v2 << 15)) ^ ((v2 >>> 19) | (v2 << 13)) ^ (v2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new MiniBuffer(32);
  const odv = new DataView(out.buffer, out.byteOffset, 32);
  odv.setUint32(0, h0, false); odv.setUint32(4, h1, false);
  odv.setUint32(8, h2, false); odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false); odv.setUint32(20, h5, false);
  odv.setUint32(24, h6, false); odv.setUint32(28, h7, false);
  return out;
}

// Precomputed AES S-box & T-tables for fast pure-JS AES-128/192/256-CTR (used by OMORI .OMORI/.KEL/.PLUTO/.AUBREY/.HERO)
let aesInitDone = false;
const AES_SBOX = new Uint8Array(256);
const AES_RCON = new Uint32Array(11);
const AES_TE0 = new Uint32Array(256);
const AES_TE1 = new Uint32Array(256);
const AES_TE2 = new Uint32Array(256);
const AES_TE3 = new Uint32Array(256);

function initAesTables(): void {
  if (aesInitDone) return;
  aesInitDone = true;
  const exp = new Uint8Array(512);
  const logTbl = new Uint8Array(256);
  let p = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = exp[i + 255] = p;
    logTbl[p] = i;
    p ^= (p << 1) ^ ((p & 0x80) ? 0x11b : 0);
  }
  for (let i = 0; i < 256; i++) {
    const inv = i === 0 ? 0 : exp[255 - logTbl[i]];
    let s = inv ^ (inv << 1) ^ (inv << 2) ^ (inv << 3) ^ (inv << 4);
    s = ((s >>> 8) ^ (s & 0xff) ^ 0x63) & 0xff;
    AES_SBOX[i] = s;
    const s2 = (s << 1) ^ ((s & 0x80) ? 0x11b : 0);
    const s3 = s2 ^ s;
    const te0 = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    AES_TE0[i] = te0;
    AES_TE1[i] = ((te0 >>> 8) | (te0 << 24)) >>> 0;
    AES_TE2[i] = ((te0 >>> 16) | (te0 << 16)) >>> 0;
    AES_TE3[i] = ((te0 >>> 24) | (te0 << 8)) >>> 0;
  }
  let r = 1;
  for (let i = 1; i <= 10; i++) {
    AES_RCON[i] = (r << 24) >>> 0;
    r = (r << 1) ^ ((r & 0x80) ? 0x11b : 0);
  }
}

function aesExpandEncKey(key: Uint8Array): Uint32Array {
  initAesTables();
  const nk = key.length >>> 2;
  if (nk !== 4 && nk !== 6 && nk !== 8) {
    throw new Error(`Invalid AES key length: ${key.length} bytes`);
  }
  const nr = nk + 6;
  const totalWords = 4 * (nr + 1);
  const rk = new Uint32Array(totalWords);
  for (let i = 0; i < nk; i++) {
    rk[i] = ((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0;
  }
  for (let i = nk; i < totalWords; i++) {
    let temp = rk[i - 1];
    if (i % nk === 0) {
      temp = (
        (AES_SBOX[(temp >>> 16) & 0xff] << 24) |
        (AES_SBOX[(temp >>> 8) & 0xff] << 16) |
        (AES_SBOX[temp & 0xff] << 8) |
        AES_SBOX[(temp >>> 24) & 0xff]
      ) ^ AES_RCON[(i / nk) | 0];
    } else if (nk > 6 && i % nk === 4) {
      temp = (
        (AES_SBOX[(temp >>> 24) & 0xff] << 24) |
        (AES_SBOX[(temp >>> 16) & 0xff] << 16) |
        (AES_SBOX[(temp >>> 8) & 0xff] << 8) |
        AES_SBOX[temp & 0xff]
      ) >>> 0;
    }
    rk[i] = (rk[i - nk] ^ temp) >>> 0;
  }
  return rk;
}

function aesEncryptBlock(rk: Uint32Array, block: Uint8Array, out: Uint8Array): void {
  const nr = (rk.length >>> 2) - 1;
  let s0 = (((block[0] << 24) | (block[1] << 16) | (block[2] << 8) | block[3]) ^ rk[0]) >>> 0;
  let s1 = (((block[4] << 24) | (block[5] << 16) | (block[6] << 8) | block[7]) ^ rk[1]) >>> 0;
  let s2 = (((block[8] << 24) | (block[9] << 16) | (block[10] << 8) | block[11]) ^ rk[2]) >>> 0;
  let s3 = (((block[12] << 24) | (block[13] << 16) | (block[14] << 8) | block[15]) ^ rk[3]) >>> 0;
  let rOff = 4;
  for (let round = 1; round < nr; round++) {
    const t0 = (AES_TE0[s0 >>> 24] ^ AES_TE1[(s1 >>> 16) & 0xff] ^ AES_TE2[(s2 >>> 8) & 0xff] ^ AES_TE3[s3 & 0xff] ^ rk[rOff]) >>> 0;
    const t1 = (AES_TE0[s1 >>> 24] ^ AES_TE1[(s2 >>> 16) & 0xff] ^ AES_TE2[(s3 >>> 8) & 0xff] ^ AES_TE3[s0 & 0xff] ^ rk[rOff + 1]) >>> 0;
    const t2 = (AES_TE0[s2 >>> 24] ^ AES_TE1[(s3 >>> 16) & 0xff] ^ AES_TE2[(s0 >>> 8) & 0xff] ^ AES_TE3[s1 & 0xff] ^ rk[rOff + 2]) >>> 0;
    const t3 = (AES_TE0[s3 >>> 24] ^ AES_TE1[(s0 >>> 16) & 0xff] ^ AES_TE2[(s1 >>> 8) & 0xff] ^ AES_TE3[s2 & 0xff] ^ rk[rOff + 3]) >>> 0;
    s0 = t0; s1 = t1; s2 = t2; s3 = t3;
    rOff += 4;
  }
  const o0 = ((AES_SBOX[s0 >>> 24] << 24) | (AES_SBOX[(s1 >>> 16) & 0xff] << 16) | (AES_SBOX[(s2 >>> 8) & 0xff] << 8) | AES_SBOX[s3 & 0xff]) ^ rk[rOff];
  const o1 = ((AES_SBOX[s1 >>> 24] << 24) | (AES_SBOX[(s2 >>> 16) & 0xff] << 16) | (AES_SBOX[(s3 >>> 8) & 0xff] << 8) | AES_SBOX[s0 & 0xff]) ^ rk[rOff + 1];
  const o2 = ((AES_SBOX[s2 >>> 24] << 24) | (AES_SBOX[(s3 >>> 16) & 0xff] << 16) | (AES_SBOX[(s0 >>> 8) & 0xff] << 8) | AES_SBOX[s1 & 0xff]) ^ rk[rOff + 2];
  const o3 = ((AES_SBOX[s3 >>> 24] << 24) | (AES_SBOX[(s0 >>> 16) & 0xff] << 16) | (AES_SBOX[(s1 >>> 8) & 0xff] << 8) | AES_SBOX[s2 & 0xff]) ^ rk[rOff + 3];
  out[0] = (o0 >>> 24) & 0xff; out[1] = (o0 >>> 16) & 0xff; out[2] = (o0 >>> 8) & 0xff; out[3] = o0 & 0xff;
  out[4] = (o1 >>> 24) & 0xff; out[5] = (o1 >>> 16) & 0xff; out[6] = (o1 >>> 8) & 0xff; out[7] = o1 & 0xff;
  out[8] = (o2 >>> 24) & 0xff; out[9] = (o2 >>> 16) & 0xff; out[10] = (o2 >>> 8) & 0xff; out[11] = o2 & 0xff;
  out[12] = (o3 >>> 24) & 0xff; out[13] = (o3 >>> 16) & 0xff; out[14] = (o3 >>> 8) & 0xff; out[15] = o3 & 0xff;
}

function aesBuildInvKeyAndTables() {
  // Lazy inverse S-box for AES-CBC block decryption if needed
  const invSbox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) invSbox[AES_SBOX[i]] = i;
  return invSbox;
}
let aesInvSbox: Uint8Array | null = null;

function aesInvSubMixBlock(rk: Uint32Array, block: Uint8Array, out: Uint8Array): void {
  if (!aesInvSbox) aesInvSbox = aesBuildInvKeyAndTables();
  const invS = aesInvSbox;
  const nr = (rk.length >>> 2) - 1;
  const state = new Uint8Array(16);
  const tmp = new Uint8Array(16);
  // AddRoundKey(nr)
  let rOff = nr << 2;
  for (let c = 0; c < 4; c++) {
    const w = rk[rOff + c];
    state[c * 4] = block[c * 4] ^ ((w >>> 24) & 0xff);
    state[c * 4 + 1] = block[c * 4 + 1] ^ ((w >>> 16) & 0xff);
    state[c * 4 + 2] = block[c * 4 + 2] ^ ((w >>> 8) & 0xff);
    state[c * 4 + 3] = block[c * 4 + 3] ^ (w & 0xff);
  }
  const mul = (a: number, b: number): number => {
    let p = 0, x = a & 0xff, y = b & 0xff;
    for (let i = 0; i < 8; i++) {
      if (y & 1) p ^= x;
      const hi = x & 0x80;
      x = (x << 1) & 0xff;
      if (hi) x ^= 0x1b;
      y >>>= 1;
    }
    return p;
  };
  for (let round = nr - 1; round >= 0; round--) {
    // InvShiftRows + InvSubBytes
    tmp[0] = invS[state[0]]; tmp[4] = invS[state[4]]; tmp[8] = invS[state[8]]; tmp[12] = invS[state[12]];
    tmp[1] = invS[state[13]]; tmp[5] = invS[state[1]]; tmp[9] = invS[state[5]]; tmp[13] = invS[state[9]];
    tmp[2] = invS[state[10]]; tmp[6] = invS[state[14]]; tmp[10] = invS[state[2]]; tmp[14] = invS[state[6]];
    tmp[3] = invS[state[7]]; tmp[7] = invS[state[11]]; tmp[11] = invS[state[15]]; tmp[15] = invS[state[3]];
    // AddRoundKey(round)
    rOff = round << 2;
    for (let c = 0; c < 4; c++) {
      const w = rk[rOff + c];
      tmp[c * 4] ^= (w >>> 24) & 0xff;
      tmp[c * 4 + 1] ^= (w >>> 16) & 0xff;
      tmp[c * 4 + 2] ^= (w >>> 8) & 0xff;
      tmp[c * 4 + 3] ^= w & 0xff;
    }
    if (round > 0) {
      // InvMixColumns
      for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = tmp[i], a1 = tmp[i + 1], a2 = tmp[i + 2], a3 = tmp[i + 3];
        state[i] = mul(a0, 0x0e) ^ mul(a1, 0x0b) ^ mul(a2, 0x0d) ^ mul(a3, 0x09);
        state[i + 1] = mul(a0, 0x09) ^ mul(a1, 0x0e) ^ mul(a2, 0x0b) ^ mul(a3, 0x0d);
        state[i + 2] = mul(a0, 0x0d) ^ mul(a1, 0x09) ^ mul(a2, 0x0e) ^ mul(a3, 0x0b);
        state[i + 3] = mul(a0, 0x0b) ^ mul(a1, 0x0d) ^ mul(a2, 0x09) ^ mul(a3, 0x0e);
      }
    } else {
      out.set(tmp);
    }
  }
}

function ghashMul(x: Uint8Array, h: Uint8Array): void {
  const z = new Uint8Array(16);
  const v = new Uint8Array(h);
  for (let i = 0; i < 16; i++) {
    const xi = x[i];
    for (let bit = 7; bit >= 0; bit--) {
      if ((xi >>> bit) & 1) {
        for (let k = 0; k < 16; k++) z[k] ^= v[k];
      }
      const lsb = v[15] & 1;
      for (let k = 15; k > 0; k--) v[k] = (v[k] >>> 1) | ((v[k - 1] & 1) << 7);
      v[0] >>>= 1;
      if (lsb) v[0] ^= 0xe1;
    }
  }
  x.set(z);
}

function ghashDeriveJ0(h: Uint8Array, iv: Uint8Array): Uint8Array {
  const j0 = new Uint8Array(16);
  if (iv.length === 12) {
    j0.set(iv, 0);
    j0[15] = 1;
    return j0;
  }
  for (let off = 0; off < iv.length; off += 16) {
    const end = Math.min(16, iv.length - off);
    for (let k = 0; k < end; k++) j0[k] ^= iv[off + k];
    ghashMul(j0, h);
  }
  const bitLenHi = Math.floor((iv.length * 8) / 0x100000000) >>> 0;
  const bitLenLo = (iv.length * 8) >>> 0;
  const lenBlk = new Uint8Array(16);
  const dv = new DataView(lenBlk.buffer);
  dv.setUint32(8, bitLenHi, false);
  dv.setUint32(12, bitLenLo, false);
  for (let k = 0; k < 16; k++) j0[k] ^= lenBlk[k];
  ghashMul(j0, h);
  return j0;
}

export function createAesCtrStream(algorithm: string, keyRaw: any, ivRaw: any, isDecrypt = true) {
  const alg = String(algorithm || '').toLowerCase();
  const isCtr = /^aes-(?:128|192|256)-ctr$/.test(alg);
  const isGcm = /^aes-(?:128|192|256)-gcm$/.test(alg);
  const isCbc = /^aes-(?:128|192|256)-cbc$/.test(alg);
  if (!isCtr && !isGcm && !isCbc) {
    throw new Error(`Unsupported cipher algorithm: ${algorithm}`);
  }
  const keyBytes = toBytes(keyRaw, 'utf8');
  const ivBytes = toBytes(ivRaw, 'utf8');
  const rk = aesExpandEncKey(keyBytes);

  // AES-CBC mode (used by some custom MV/MZ decrypter plugins)
  if (isCbc) {
    if (ivBytes.length !== 16) throw new Error(`Invalid AES-CBC IV length: ${ivBytes.length}`);
    let autoPad = true;
    const chunks: Uint8Array[] = [];
    return {
      setAutoPadding(pad = true) { autoPad = Boolean(pad); return this; },
      setAuthTag() { return this; },
      setAAD() { return this; },
      getAuthTag() { return new MiniBuffer(16); },
      update(input: any, inputEncoding?: string, outputEncoding?: string): any {
        chunks.push(typeof input === 'string' ? toBytes(input, inputEncoding || 'utf8') : toBytes(input));
        const empty = new MiniBuffer(0);
        return outputEncoding ? empty.toString(outputEncoding) : empty;
      },
      final(outputEncoding?: string): any {
        const all = chunks.length === 1 ? chunks[0] : MiniBuffer.concat(chunks);
        const prev = new Uint8Array(ivBytes);
        if (isDecrypt) {
          if (all.length % 16 !== 0) throw new Error('Invalid AES-CBC ciphertext length');
          const out = new MiniBuffer(all.length);
          const dec = new Uint8Array(16);
          for (let off = 0; off < all.length; off += 16) {
            const blk = all.subarray(off, off + 16);
            aesInvSubMixBlock(rk, blk, dec);
            for (let k = 0; k < 16; k++) out[off + k] = dec[k] ^ prev[k];
            prev.set(blk);
          }
          let res: MiniBuffer = out;
          if (autoPad && out.length >= 16) {
            const pad = out[out.length - 1];
            if (pad >= 1 && pad <= 16) {
              let ok = true;
              for (let k = 1; k <= pad; k++) if (out[out.length - k] !== pad) { ok = false; break; }
              if (ok) res = out.subarray(0, out.length - pad);
            }
          }
          return outputEncoding ? res.toString(outputEncoding) : res;
        }
        const padLen = autoPad ? 16 - (all.length % 16) : 0;
        const out = new MiniBuffer(all.length + padLen);
        out.set(all, 0);
        if (autoPad) out.fill(padLen, all.length);
        const blk = new Uint8Array(16);
        for (let off = 0; off < out.length; off += 16) {
          for (let k = 0; k < 16; k++) blk[k] = out[off + k] ^ prev[k];
          aesEncryptBlock(rk, blk, prev);
          out.set(prev, off);
        }
        return outputEncoding ? out.toString(outputEncoding) : out;
      },
    };
  }

  // AES-CTR & AES-GCM modes (OMORI uses AES-256-CTR; KageDesu PKD Protector 2 & RmmzEncripterTool use AES-256-GCM)
  if (isCtr && ivBytes.length !== 16) {
    throw new Error(`Invalid AES-CTR IV length: ${ivBytes.length}`);
  }
  const nr = (rk.length >>> 2) - 1;
  let gcmH: Uint8Array | null = null;
  let gcmJ0: Uint8Array | null = null;
  let gcmAad: Uint8Array = new Uint8Array(0);
  let gcmAuthTag: Uint8Array | null = null;
  const gcmCipherChunks: Uint8Array[] = [];

  let ctrInit: Uint8Array;
  if (isGcm) {
    gcmH = new Uint8Array(16);
    aesEncryptBlock(rk, new Uint8Array(16), gcmH);
    gcmJ0 = ghashDeriveJ0(gcmH, ivBytes);
    ctrInit = new Uint8Array(gcmJ0);
    // GCM encryption/decryption starts at inc_32(J0)
    const j3 = (((ctrInit[12] << 24) | (ctrInit[13] << 16) | (ctrInit[14] << 8) | ctrInit[15]) + 1) >>> 0;
    ctrInit[12] = (j3 >>> 24) & 0xff;
    ctrInit[13] = (j3 >>> 16) & 0xff;
    ctrInit[14] = (j3 >>> 8) & 0xff;
    ctrInit[15] = j3 & 0xff;
  } else {
    ctrInit = ivBytes;
  }

  let c0 = ((ctrInit[0] << 24) | (ctrInit[1] << 16) | (ctrInit[2] << 8) | ctrInit[3]) >>> 0;
  let c1 = ((ctrInit[4] << 24) | (ctrInit[5] << 16) | (ctrInit[6] << 8) | ctrInit[7]) >>> 0;
  let c2 = ((ctrInit[8] << 24) | (ctrInit[9] << 16) | (ctrInit[10] << 8) | ctrInit[11]) >>> 0;
  let c3 = ((ctrInit[12] << 24) | (ctrInit[13] << 16) | (ctrInit[14] << 8) | ctrInit[15]) >>> 0;
  const keystream = new Uint8Array(16);
  let ksPos = 16;

  const computeGcmTag = (cipherBytes: Uint8Array): MiniBuffer => {
    const s = new Uint8Array(16);
    for (let off = 0; off < gcmAad.length; off += 16) {
      const end = Math.min(16, gcmAad.length - off);
      for (let k = 0; k < end; k++) s[k] ^= gcmAad[off + k];
      ghashMul(s, gcmH!);
    }
    for (let off = 0; off < cipherBytes.length; off += 16) {
      const end = Math.min(16, cipherBytes.length - off);
      for (let k = 0; k < end; k++) s[k] ^= cipherBytes[off + k];
      ghashMul(s, gcmH!);
    }
    const lenBlk = new Uint8Array(16);
    const dv = new DataView(lenBlk.buffer);
    dv.setUint32(0, Math.floor((gcmAad.length * 8) / 0x100000000) >>> 0, false);
    dv.setUint32(4, (gcmAad.length * 8) >>> 0, false);
    dv.setUint32(8, Math.floor((cipherBytes.length * 8) / 0x100000000) >>> 0, false);
    dv.setUint32(12, (cipherBytes.length * 8) >>> 0, false);
    for (let k = 0; k < 16; k++) s[k] ^= lenBlk[k];
    ghashMul(s, gcmH!);
    const eJ0 = new Uint8Array(16);
    aesEncryptBlock(rk, gcmJ0!, eJ0);
    const tag = new MiniBuffer(16);
    for (let k = 0; k < 16; k++) tag[k] = s[k] ^ eJ0[k];
    return tag;
  };

  return {
    setAutoPadding() { return this; },
    setAuthTag(tag: any) { gcmAuthTag = toBytes(tag); return this; },
    setAAD(aad: any) { gcmAad = toBytes(aad); return this; },
    getAuthTag(): MiniBuffer {
      if (!isGcm) return new MiniBuffer(0);
      const allC = gcmCipherChunks.length === 1 ? gcmCipherChunks[0] : MiniBuffer.concat(gcmCipherChunks);
      return computeGcmTag(allC);
    },
    update(input: any, inputEncoding?: string, outputEncoding?: string): any {
      const src = typeof input === 'string' ? toBytes(input, inputEncoding || 'utf8') : toBytes(input);
      const len = src.length;
      const out = new MiniBuffer(len);
      let i = 0;

      // Drain any leftover partial keystream bytes from a previous unaligned chunk
      while (ksPos < 16 && i < len) {
        out[i] = src[i] ^ keystream[ksPos++];
        i++;
      }

      // Hot 16-byte aligned block loop (zero intermediate array writes/reads)
      const rk0 = rk[0], rk1 = rk[1], rk2 = rk[2], rk3 = rk[3];
      const lastOff = nr << 2;
      while (i + 16 <= len) {
        let s0 = (c0 ^ rk0) >>> 0;
        let s1 = (c1 ^ rk1) >>> 0;
        let s2 = (c2 ^ rk2) >>> 0;
        let s3 = (c3 ^ rk3) >>> 0;
        c3 = (c3 + 1) >>> 0;
        if (c3 === 0 && !isGcm) {
          c2 = (c2 + 1) >>> 0;
          if (c2 === 0) {
            c1 = (c1 + 1) >>> 0;
            if (c1 === 0) c0 = (c0 + 1) >>> 0;
          }
        }
        for (let rOff = 4; rOff < lastOff; rOff += 4) {
          const t0 = (AES_TE0[s0 >>> 24] ^ AES_TE1[(s1 >>> 16) & 0xff] ^ AES_TE2[(s2 >>> 8) & 0xff] ^ AES_TE3[s3 & 0xff] ^ rk[rOff]) >>> 0;
          const t1 = (AES_TE0[s1 >>> 24] ^ AES_TE1[(s2 >>> 16) & 0xff] ^ AES_TE2[(s3 >>> 8) & 0xff] ^ AES_TE3[s0 & 0xff] ^ rk[rOff + 1]) >>> 0;
          const t2 = (AES_TE0[s2 >>> 24] ^ AES_TE1[(s3 >>> 16) & 0xff] ^ AES_TE2[(s0 >>> 8) & 0xff] ^ AES_TE3[s1 & 0xff] ^ rk[rOff + 2]) >>> 0;
          const t3 = (AES_TE0[s3 >>> 24] ^ AES_TE1[(s0 >>> 16) & 0xff] ^ AES_TE2[(s1 >>> 8) & 0xff] ^ AES_TE3[s2 & 0xff] ^ rk[rOff + 3]) >>> 0;
          s0 = t0; s1 = t1; s2 = t2; s3 = t3;
        }
        const o0 = ((AES_SBOX[s0 >>> 24] << 24) | (AES_SBOX[(s1 >>> 16) & 0xff] << 16) | (AES_SBOX[(s2 >>> 8) & 0xff] << 8) | AES_SBOX[s3 & 0xff]) ^ rk[lastOff];
        const o1 = ((AES_SBOX[s1 >>> 24] << 24) | (AES_SBOX[(s2 >>> 16) & 0xff] << 16) | (AES_SBOX[(s3 >>> 8) & 0xff] << 8) | AES_SBOX[s0 & 0xff]) ^ rk[lastOff + 1];
        const o2 = ((AES_SBOX[s2 >>> 24] << 24) | (AES_SBOX[(s3 >>> 16) & 0xff] << 16) | (AES_SBOX[(s0 >>> 8) & 0xff] << 8) | AES_SBOX[s1 & 0xff]) ^ rk[lastOff + 2];
        const o3 = ((AES_SBOX[s3 >>> 24] << 24) | (AES_SBOX[(s0 >>> 16) & 0xff] << 16) | (AES_SBOX[(s1 >>> 8) & 0xff] << 8) | AES_SBOX[s2 & 0xff]) ^ rk[lastOff + 3];
        out[i]      = src[i]      ^ (o0 >>> 24);
        out[i + 1]  = src[i + 1]  ^ ((o0 >>> 16) & 0xff);
        out[i + 2]  = src[i + 2]  ^ ((o0 >>> 8) & 0xff);
        out[i + 3]  = src[i + 3]  ^ (o0 & 0xff);
        out[i + 4]  = src[i + 4]  ^ (o1 >>> 24);
        out[i + 5]  = src[i + 5]  ^ ((o1 >>> 16) & 0xff);
        out[i + 6]  = src[i + 6]  ^ ((o1 >>> 8) & 0xff);
        out[i + 7]  = src[i + 7]  ^ (o1 & 0xff);
        out[i + 8]  = src[i + 8]  ^ (o2 >>> 24);
        out[i + 9]  = src[i + 9]  ^ ((o2 >>> 16) & 0xff);
        out[i + 10] = src[i + 10] ^ ((o2 >>> 8) & 0xff);
        out[i + 11] = src[i + 11] ^ (o2 & 0xff);
        out[i + 12] = src[i + 12] ^ (o3 >>> 24);
        out[i + 13] = src[i + 13] ^ ((o3 >>> 16) & 0xff);
        out[i + 14] = src[i + 14] ^ ((o3 >>> 8) & 0xff);
        out[i + 15] = src[i + 15] ^ (o3 & 0xff);
        i += 16;
      }

      // Tail <16 bytes
      if (i < len) {
        const block = new Uint8Array([
          (c0 >>> 24) & 0xff, (c0 >>> 16) & 0xff, (c0 >>> 8) & 0xff, c0 & 0xff,
          (c1 >>> 24) & 0xff, (c1 >>> 16) & 0xff, (c1 >>> 8) & 0xff, c1 & 0xff,
          (c2 >>> 24) & 0xff, (c2 >>> 16) & 0xff, (c2 >>> 8) & 0xff, c2 & 0xff,
          (c3 >>> 24) & 0xff, (c3 >>> 16) & 0xff, (c3 >>> 8) & 0xff, c3 & 0xff,
        ]);
        aesEncryptBlock(rk, block, keystream);
        c3 = (c3 + 1) >>> 0;
        if (c3 === 0 && !isGcm) {
          c2 = (c2 + 1) >>> 0;
          if (c2 === 0) {
            c1 = (c1 + 1) >>> 0;
            if (c1 === 0) c0 = (c0 + 1) >>> 0;
          }
        }
        ksPos = 0;
        while (i < len) {
          out[i] = src[i] ^ keystream[ksPos++];
          i++;
        }
      }
      if (isGcm) {
        gcmCipherChunks.push(isDecrypt ? src : out);
      }
      return outputEncoding ? out.toString(outputEncoding) : out;
    },
    final(outputEncoding?: string): any {
      if (isGcm && isDecrypt && gcmAuthTag) {
        const allC = gcmCipherChunks.length === 1 ? gcmCipherChunks[0] : MiniBuffer.concat(gcmCipherChunks);
        const expected = computeGcmTag(allC);
        let diff = expected.length >= gcmAuthTag.length && gcmAuthTag.length >= 12 ? 0 : 1;
        for (let k = 0; k < gcmAuthTag.length && k < expected.length; k++) {
          diff |= expected[k] ^ gcmAuthTag[k];
        }
        if (diff !== 0) {
          throw new Error('Unsupported state or unable to authenticate data');
        }
      }
      const empty = new MiniBuffer(0);
      return outputEncoding ? empty.toString(outputEncoding) : empty;
    },
  };
}

// ============================================================================
// Pure-TS RFC 1951 DEFLATE / RFC 1950 ZLIB / RFC 1952 GZIP (for Coffin's zlib.inflateSync)
// ============================================================================
const DEFLATE_LEN_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const DEFLATE_LEN_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const DEFLATE_DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DEFLATE_DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
const DEFLATE_CL_ORDER = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);

function buildHuffmanTable(lengths: Uint8Array, numSyms: number): { table: Int32Array; maxBits: number } {
  let maxBits = 1;
  for (let i = 0; i < numSyms; i++) {
    if (lengths[i] > maxBits) maxBits = lengths[i];
  }
  if (maxBits > 15) maxBits = 15;
  const blCount = new Uint16Array(maxBits + 1);
  for (let i = 0; i < numSyms; i++) {
    const l = lengths[i];
    if (l > 0) blCount[l]++;
  }
  const nextCode = new Uint16Array(maxBits + 1);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const size = 1 << maxBits;
  const table = new Int32Array(size).fill(-1);
  for (let sym = 0; sym < numSyms; sym++) {
    const len = lengths[sym];
    if (len === 0) continue;
    const c = nextCode[len]++;
    // Reverse `len` bits for LSB-first DEFLATE bitstreams
    let rev = 0;
    for (let b = 0; b < len; b++) rev = (rev << 1) | ((c >>> b) & 1);
    const entry = (len << 16) | sym;
    const step = 1 << len;
    for (let idx = rev; idx < size; idx += step) {
      table[idx] = entry;
    }
  }
  return { table, maxBits };
}

let fixedLitTable: { table: Int32Array; maxBits: number } | null = null;
let fixedDistTable: { table: Int32Array; maxBits: number } | null = null;

export function inflateRawBytes(src: Uint8Array, startOffset = 0): MiniBuffer {
  let bytePos = startOffset;
  let bitBuf = 0;
  let bitCnt = 0;
  const srcLen = src.length;

  const ensureBits = (n: number) => {
    while (bitCnt < n) {
      bitBuf |= (bytePos < srcLen ? src[bytePos++] : 0) << bitCnt;
      bitCnt += 8;
    }
  };
  const readBits = (n: number): number => {
    if (n === 0) return 0;
    ensureBits(n);
    const val = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return val;
  };
  const decodeSym = (huff: { table: Int32Array; maxBits: number }): number => {
    ensureBits(huff.maxBits);
    const entry = huff.table[bitBuf & ((1 << huff.maxBits) - 1)];
    if (entry < 0) throw new Error('Invalid DEFLATE Huffman code');
    const len = entry >>> 16;
    bitBuf >>>= len;
    bitCnt -= len;
    return entry & 0xffff;
  };

  let out = new Uint8Array(Math.max(256, (srcLen - startOffset) * 3));
  let outPos = 0;
  const grow = (need: number) => {
    if (outPos + need <= out.length) return;
    let nextLen = out.length * 2;
    while (nextLen < outPos + need) nextLen *= 2;
    const next = new Uint8Array(nextLen);
    next.set(out.subarray(0, outPos));
    out = next;
  };

  let isFinal = 0;
  while (!isFinal) {
    isFinal = readBits(1);
    const btype = readBits(2);
    if (btype === 0) {
      // Uncompressed block
      bitBuf = 0;
      bitCnt = 0;
      if (bytePos + 4 > srcLen) throw new Error('Truncated uncompressed DEFLATE block');
      const len = src[bytePos] | (src[bytePos + 1] << 8);
      const nlen = src[bytePos + 2] | (src[bytePos + 3] << 8);
      bytePos += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error('Corrupt uncompressed DEFLATE block length');
      if (bytePos + len > srcLen) throw new Error('Truncated uncompressed DEFLATE data');
      grow(len);
      out.set(src.subarray(bytePos, bytePos + len), outPos);
      outPos += len;
      bytePos += len;
    } else if (btype === 1 || btype === 2) {
      let litHuff: { table: Int32Array; maxBits: number };
      let distHuff: { table: Int32Array; maxBits: number };
      if (btype === 1) {
        if (!fixedLitTable || !fixedDistTable) {
          const ll = new Uint8Array(288);
          for (let i = 0; i <= 143; i++) ll[i] = 8;
          for (let i = 144; i <= 255; i++) ll[i] = 9;
          for (let i = 256; i <= 279; i++) ll[i] = 7;
          for (let i = 280; i <= 287; i++) ll[i] = 8;
          const dl = new Uint8Array(32).fill(5);
          fixedLitTable = buildHuffmanTable(ll, 288);
          fixedDistTable = buildHuffmanTable(dl, 32);
        }
        litHuff = fixedLitTable;
        distHuff = fixedDistTable;
      } else {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        const clLens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clLens[DEFLATE_CL_ORDER[i]] = readBits(3);
        const clHuff = buildHuffmanTable(clLens, 19);
        const totalCodes = hlit + hdist;
        const codeLens = new Uint8Array(totalCodes);
        let idx = 0;
        while (idx < totalCodes) {
          const sym = decodeSym(clHuff);
          if (sym < 16) {
            codeLens[idx++] = sym;
          } else if (sym === 16) {
            const rep = readBits(2) + 3;
            const prev = idx > 0 ? codeLens[idx - 1] : 0;
            for (let r = 0; r < rep && idx < totalCodes; r++) codeLens[idx++] = prev;
          } else if (sym === 17) {
            const rep = readBits(3) + 3;
            idx += rep;
          } else {
            const rep = readBits(7) + 11;
            idx += rep;
          }
        }
        litHuff = buildHuffmanTable(codeLens.subarray(0, hlit), hlit);
        distHuff = buildHuffmanTable(codeLens.subarray(hlit, totalCodes), hdist);
      }

      for (;;) {
        const sym = decodeSym(litHuff);
        if (sym < 256) {
          if (outPos >= out.length) grow(1);
          out[outPos++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const lenIdx = sym - 257;
          const length = DEFLATE_LEN_BASE[lenIdx] + readBits(DEFLATE_LEN_EXTRA[lenIdx]);
          const distSym = decodeSym(distHuff);
          const dist = DEFLATE_DIST_BASE[distSym] + readBits(DEFLATE_DIST_EXTRA[distSym]);
          if (dist > outPos) throw new Error('Invalid DEFLATE back-reference distance');
          grow(length);
          let srcIdx = outPos - dist;
          for (let k = 0; k < length; k++) {
            out[outPos++] = out[srcIdx++];
          }
        }
      }
    } else {
      throw new Error(`Invalid DEFLATE block type: ${btype}`);
    }
  }
  return new MiniBuffer(out.subarray(0, outPos));
}

export function inflateZlibBytes(input: Uint8Array): MiniBuffer {
  if (input.length < 2) throw new Error('Truncated zlib stream');
  const cmf = input[0];
  const flg = input[1];
  if ((cmf & 0x0f) !== 8 || ((cmf << 8) + flg) % 31 !== 0) {
    throw new Error('Invalid zlib header');
  }
  const fdict = (flg & 0x20) ? 4 : 0;
  return inflateRawBytes(input, 2 + fdict);
}

export function gunzipBytes(input: Uint8Array): MiniBuffer {
  if (input.length < 10 || input[0] !== 0x1f || input[1] !== 0x8b) {
    throw new Error('Invalid gzip header');
  }
  const flg = input[3];
  let pos = 10;
  if (flg & 0x04) { const xlen = input[pos] | (input[pos + 1] << 8); pos += 2 + xlen; }
  if (flg & 0x08) { while (pos < input.length && input[pos++] !== 0) { /* fname */ } }
  if (flg & 0x10) { while (pos < input.length && input[pos++] !== 0) { /* fcomment */ } }
  if (flg & 0x02) pos += 2;
  return inflateRawBytes(input, pos);
}

export function resolveSafeSdPath(wwwRoot: string, raw: string): string | null {
  let p = String(raw ?? '').trim();
  if (!p) return null;
  p = p.replace(/\\/g, '/');
  if (p.startsWith('sdmc:/')) {
    const segs = p.slice(6).split('/').filter((s) => s && s !== '.');
    const resolved: string[] = [];
    for (const s of segs) {
      if (s === '..') {
        if (resolved.length === 0) return null;
        resolved.pop();
      } else {
        resolved.push(s);
      }
    }
    return `sdmc:/${resolved.join('/')}`;
  }
  const appRoot = wwwRoot.replace(/\/+$/, '').replace(/\/www$/i, '');
  const baseSegs = appRoot.replace(/^sdmc:\/+/i, '').split('/').filter(Boolean);
  const relSegs = p.replace(/^\/+/, '').split('/').filter((s) => s && s !== '.');
  const resolved = [...baseSegs];
  for (const s of relSegs) {
    if (s === '..') {
      if (resolved.length <= 1) return null;
      resolved.pop();
    } else {
      resolved.push(s);
    }
  }
  return `sdmc:/${resolved.join('/')}`;
}

export function installNodeCompat(
  target: Record<string, any>,
  sw: SwitchApi | null,
  wwwRoot: string,
  saveDir: string,
  logFn?: (s: string) => void,
  gameDir?: string,
  gameTitle = 'RPG Maker MV',
): void {
  const cleanWww = wwwRoot.replace(/\/+$/, '');
  const appRoot = (gameDir || cleanWww.replace(/\/www$/i, '')).replace(/\/+$/, '');
  const cleanSaveDir = saveDir.replace(/\/+$/, '');

  const dirCache = new Map<string, Map<string, string>>();
  function resolveExistingSdPath(candidate: string): string | null {
    try {
      if (sw && sw.statSync(candidate) !== null) return candidate;
    } catch { /* fall through */ }
    if (!sw || !candidate.startsWith('sdmc:/')) return null;
    const segs = candidate.slice(6).split('/').filter(Boolean);
    let current = 'sdmc:';
    for (const seg of segs) {
      const exact = `${current}/${seg}`;
      try {
        if (sw.statSync(exact) !== null) {
          current = exact;
          continue;
        }
      } catch { /* try case-insensitive dir scan */ }
      let entries = dirCache.get(current);
      if (!entries) {
        entries = new Map<string, string>();
        try {
          const list = sw.readDirSync(`${current}/`);
          if (list) {
            for (const name of list) entries.set(name.toLowerCase(), name);
          }
        } catch { /* ignore */ }
        dirCache.set(current, entries);
      }
      const matched = entries.get(seg.toLowerCase());
      if (!matched) return null;
      current = `${current}/${matched}`;
    }
    return current;
  }

  function resolveReadPath(raw: string): string | null {
    const mapped = mapWritePath(raw);
    if (mapped) {
      const hit = resolveExistingSdPath(mapped);
      if (hit) return hit;
    }
    const safe = resolveSafeSdPath(cleanWww, raw);
    if (safe) {
      const hit = resolveExistingSdPath(safe);
      if (hit) return hit;
      // Flat web-export fallback when a game requests `www/foo` on a flat gameDir without `/www`
      if (cleanWww === appRoot && safe.toLowerCase().startsWith(`${appRoot.toLowerCase()}/www/`)) {
        const flatAlt = `${appRoot}/${safe.slice(appRoot.length + 5)}`;
        const flatHit = resolveExistingSdPath(flatAlt);
        if (flatHit) return flatHit;
      }
    }
    return mapped ?? safe;
  }

  // Redirect writes targeting `save/` or screenshots safely into the active game's folder.
  function mapWritePath(raw: string): string | null {
    const resolved = resolveSafeSdPath(cleanWww, raw);
    if (!resolved) return null;
    const low = resolved.toLowerCase();
    const lowSave = cleanSaveDir.toLowerCase();
    if (low === lowSave || low.startsWith(`${lowSave}/`)) {
      return resolved;
    }
    if (/\/save(\/|$)/i.test(resolved)) {
      const idx = low.lastIndexOf('/save');
      const tail = resolved.slice(idx + 5);
      return `${cleanSaveDir}${tail}`;
    }
    if (low.includes('game clear') || low.includes('screenshot')) {
      const base = resolved.split('/').pop() || 'capture.png';
      return `${appRoot}/screenshots/${base}`;
    }
    // Never allow arbitrary writes outside appRoot or cleanSaveDir
    if (!low.startsWith(appRoot.toLowerCase()) && !low.startsWith(lowSave)) {
      return `${appRoot}/userdata/${resolved.split('/').pop() || 'file.dat'}`;
    }
    return resolved;
  }

  const pathMod: Record<string, any> = {
    sep: '/',
    dirname(p: string): string {
      const n = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
      const i = n.lastIndexOf('/');
      return i <= 0 ? (n.startsWith('sdmc:') ? 'sdmc:/' : n.startsWith('/') ? '/' : '.') : n.slice(0, i);
    },
    basename(p: string, ext?: string): string {
      const n = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
      const i = n.lastIndexOf('/');
      let base = i >= 0 ? n.slice(i + 1) : n;
      if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
      return base;
    },
    join(...parts: string[]): string {
      const nonEmpty = parts.map((p) => String(p ?? '')).filter((p) => p.length > 0);
      if (nonEmpty.length === 0) return '.';
      const lastPart = nonEmpty[nonEmpty.length - 1].replace(/\\/g, '/');
      const trailingSlash = lastPart.length > 1 && lastPart.endsWith('/');
      const raw = nonEmpty.join('/').replace(/\\/g, '/');
      const prefix = raw.startsWith('sdmc:/') ? 'sdmc:/' : raw.startsWith('/') ? '/' : '';
      const rest = prefix ? raw.slice(prefix.length) : raw;
      const out: string[] = [];
      for (const seg of rest.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
        else out.push(seg);
      }
      const joined = prefix + out.join('/');
      if (!joined) return prefix || '.';
      return trailingSlash && !joined.endsWith('/') ? `${joined}/` : joined;
    },
    resolve(...parts: string[]): string {
      return pathMod.join(...parts).replace(/\/+$/, '') || '/';
    },
    relative(from: string, to: string): string {
      const f = pathMod.resolve(from).replace(/^sdmc:/i, '').split('/').filter(Boolean);
      const t = pathMod.resolve(to).replace(/^sdmc:/i, '').split('/').filter(Boolean);
      let common = 0;
      while (common < f.length && common < t.length && f[common].toLowerCase() === t[common].toLowerCase()) {
        common++;
      }
      const up: string[] = [];
      for (let i = common; i < f.length; i++) up.push('..');
      return [...up, ...t.slice(common)].join('/');
    },
    extname(p: string): string {
      const b = pathMod.basename(p);
      const i = b.lastIndexOf('.');
      return i > 0 ? b.slice(i) : '';
    },
    isAbsolute(p: string): boolean {
      const n = String(p ?? '').replace(/\\/g, '/');
      return n.startsWith('/') || n.startsWith('sdmc:/') || /^[a-zA-Z]:\//.test(n);
    },
  };
  pathMod.posix = pathMod;
  pathMod.win32 = pathMod;

  const fsMod: Record<string, any> = {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    existsSync(raw: string): boolean {
      if (!sw) return false;
      const p = resolveReadPath(raw);
      if (!p) return false;
      try { return sw.statSync(p) !== null; } catch { return false; }
    },
    exists(raw: string, cb?: (ok: boolean) => void): void {
      const ok = fsMod.existsSync(raw);
      if (cb) setTimeout(() => cb(ok), 0);
    },
    accessSync(raw: string): void {
      if (!fsMod.existsSync(raw)) throw new Error(`ENOENT: ${raw}`);
    },
    access(raw: string, modeOrCb?: any, maybeCb?: any): void {
      const cb = typeof modeOrCb === 'function' ? modeOrCb : maybeCb;
      const err = fsMod.existsSync(raw) ? null : new Error(`ENOENT: ${raw}`);
      if (cb) setTimeout(() => cb(err), 0);
    },
    statSync(raw: string) {
      if (!sw) throw new Error(`ENOENT: ${raw}`);
      const p = resolveReadPath(raw);
      const st = p ? sw.statSync(p) : null;
      if (!st) throw new Error(`ENOENT: ${raw}`);
      const mode = st.mode ?? S_IFREG;
      return {
        mode,
        size: st.size ?? 0,
        isDirectory: () => (mode & 0o170000) === S_IFDIR,
        isFile: () => (mode & 0o170000) === S_IFREG,
      };
    },
    stat(raw: string, cb?: (err: Error | null, st?: any) => void): void {
      try {
        const st = fsMod.statSync(raw);
        if (cb) setTimeout(() => cb(null, st), 0);
      } catch (e) {
        if (cb) setTimeout(() => cb(e as Error), 0);
      }
    },
    readFileSync(raw: string, options?: string | { encoding?: string } | null): string | MiniBuffer {
      if (!sw) throw new Error(`ENOENT: ${raw}`);
      const p = resolveReadPath(raw);
      const bytes = p ? sw.readFileSync(p) : null;
      if (bytes === null) throw new Error(`ENOENT: ${raw}`);
      const enc = typeof options === 'string' ? options : options?.encoding;
      if (enc) return new MiniBuffer(bytes).toString(enc);
      return new MiniBuffer(bytes);
    },
    readFile(
      raw: string,
      optionsOrCb?: string | { encoding?: string } | null | ((err: Error | null, data?: any) => void),
      maybeCb?: (err: Error | null, data?: any) => void,
    ): void {
      const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
      const opts = typeof optionsOrCb === 'function' ? undefined : optionsOrCb;
      if (!cb) return;
      if (!sw) {
        setTimeout(() => cb(new Error(`ENOENT: ${raw}`)), 0);
        return;
      }
      const p = resolveReadPath(raw);
      if (!p) {
        setTimeout(() => cb(new Error(`ENOENT: ${raw}`)), 0);
        return;
      }
      const enc = typeof opts === 'string' ? opts : opts?.encoding;
      void (async () => {
        const isAsyncRead = typeof sw.readFile === 'function';
        let out: any;
        try {
          const bytes = isAsyncRead ? await sw.readFile(p) : sw.readFileSync(p);
          if (bytes === null) {
            if (isAsyncRead) cb(new Error(`ENOENT: ${raw}`));
            else setTimeout(() => cb(new Error(`ENOENT: ${raw}`)), 0);
            return;
          }
          const buf = new MiniBuffer(bytes);
          out = enc ? buf.toString(enc) : buf;
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          if (isAsyncRead) cb(e);
          else setTimeout(() => cb(e), 0);
          return;
        }
        if (isAsyncRead) {
          cb(null, out);
        } else {
          setTimeout(() => cb(null, out), 0);
        }
      })();
    },
    writeFileSync(raw: string, data: string | Uint8Array | ArrayBuffer): void {
      if (!sw) return;
      const p = mapWritePath(raw);
      if (!p) return;
      const parent = pathMod.dirname(p);
      ensureDir(sw, parent);
      dirCache.delete(parent);
      if (typeof data === 'string') {
        const encoded = encodeUtf8Safe(data);
        sw.writeFileSync(p, encoded.buffer as ArrayBuffer);
      } else if (isRawArrayBuffer(data)) {
        sw.writeFileSync(p, data);
      } else {
        const copy = new Uint8Array(data.byteLength);
        copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        sw.writeFileSync(p, copy.buffer);
      }
    },
    writeFile(
      raw: string,
      data: string | Uint8Array | ArrayBuffer,
      optionsOrCb?: any,
      maybeCb?: (err: Error | null) => void,
    ): void {
      const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
      try {
        fsMod.writeFileSync(raw, data);
        if (cb) setTimeout(() => cb(null), 0);
      } catch (e) {
        if (cb) setTimeout(() => cb(e as Error), 0);
      }
    },
    appendFileSync(raw: string, data: string | Uint8Array | ArrayBuffer): void {
      if (!sw) return;
      const p = mapWritePath(raw);
      if (!p) return;
      const prev = (() => {
        try { return sw.readFileSync(p); } catch { return null; }
      })();
      const addBytes = toBytes(data);
      if (!prev) {
        fsMod.writeFileSync(raw, addBytes);
        return;
      }
      const prevBytes = new Uint8Array(prev);
      const combined = new Uint8Array(prevBytes.byteLength + addBytes.byteLength);
      combined.set(prevBytes, 0);
      combined.set(addBytes, prevBytes.byteLength);
      fsMod.writeFileSync(raw, combined);
    },
    copyFileSync(srcRaw: string, dstRaw: string): void {
      if (!sw) return;
      const src = resolveReadPath(srcRaw);
      const bytes = src ? sw.readFileSync(src) : null;
      if (bytes === null) throw new Error(`ENOENT: ${srcRaw}`);
      fsMod.writeFileSync(dstRaw, bytes);
    },
    mkdirSync(raw: string): void {
      if (!sw) return;
      const p = mapWritePath(raw);
      if (p) {
        ensureDir(sw, p);
        dirCache.delete(pathMod.dirname(p));
      }
    },
    mkdir(raw: string, optsOrCb?: any, maybeCb?: (err: Error | null) => void): void {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      try {
        fsMod.mkdirSync(raw);
        if (cb) setTimeout(() => cb(null), 0);
      } catch (e) {
        if (cb) setTimeout(() => cb(e as Error), 0);
      }
    },
    unlinkSync(raw: string): void {
      if (!sw) return;
      const p = mapWritePath(raw);
      if (!p) return;
      try {
        if (sw.statSync(p)) {
          sw.removeSync(p);
          dirCache.delete(pathMod.dirname(p));
        }
      } catch { /* ignore */ }
    },
    unlink(raw: string, cb?: (err: Error | null) => void): void {
      try {
        fsMod.unlinkSync(raw);
        if (cb) setTimeout(() => cb(null), 0);
      } catch (e) {
        if (cb) setTimeout(() => cb(e as Error), 0);
      }
    },
    renameSync(oldRaw: string, newRaw: string): void {
      if (!sw) return;
      const src = mapWritePath(oldRaw);
      const dst = mapWritePath(newRaw);
      if (!src || !dst || src === dst) return;
      const bytes = sw.readFileSync(src);
      if (!bytes) return;
      ensureDir(sw, pathMod.dirname(dst));
      sw.writeFileSync(dst, bytes);
      try { sw.removeSync(src); } catch { /* ignore */ }
      dirCache.delete(pathMod.dirname(src));
      dirCache.delete(pathMod.dirname(dst));
    },
    readdirSync(raw: string): string[] {
      if (!sw) return [];
      const p = resolveReadPath(raw);
      if (!p) return [];
      try { return sw.readDirSync(`${p.replace(/\/+$/, '')}/`) ?? []; } catch { return []; }
    },
    readdir(raw: string, cb: (err: Error | null, files: string[]) => void): void {
      try {
        const files = fsMod.readdirSync(raw);
        setTimeout(() => cb(null, files), 0);
      } catch (e) {
        setTimeout(() => cb(e as Error, []), 0);
      }
    },
  };

  const fakeWindow = {
    get width(): number { return (target.Graphics?.width as number) || 816; },
    set width(_v: number) {},
    get height(): number { return (target.Graphics?.height as number) || 624; },
    set height(_v: number) {},
    x: 0,
    y: 0,
    title: gameTitle,
    menu: null,
    isFullscreen: true,
    on() {},
    once() {},
    removeListener() {},
    show() {},
    hide() {},
    focus() {},
    blur() {},
    close() { if (typeof target.close === 'function') target.close(); else sw?.exit(); },
    reload() {},
    reloadIgnoringCache() {},
    showDevTools() {},
    closeDevTools() {},
    isDevToolsOpen() { return false; },
    enterFullscreen() {},
    leaveFullscreen() {},
    toggleFullscreen() {},
    setAlwaysOnTop() {},
    resizeTo() {},
    moveTo() {},
    moveBy() {},
  };

  // Detect custom NW.js launch arguments (e.g. OMORI's Riruka24.ini `Args=--<key>`).
  const nwArgv: string[] = [];
  if (sw) {
    for (const iniCand of [`${appRoot}/Riruka24.ini`, `${cleanWww}/Riruka24.ini`]) {
      try {
        const iniPath = resolveExistingSdPath(iniCand);
        const iniBytes = iniPath ? sw.readFileSync(iniPath) : null;
        if (iniBytes) {
          const iniText = decodeUtf8(new Uint8Array(iniBytes));
          const m = /^\s*Args\s*=\s*(.+)$/im.exec(iniText);
          if (m?.[1]?.trim()) {
            nwArgv.push(...m[1].trim().split(/\s+/).filter(Boolean));
            logFn?.(`[node-compat] loaded launch args from Riruka24.ini (${nwArgv.length} arg(s))`);
            break;
          }
        }
      } catch { /* ignore */ }
    }
    // Fallback if the user copied only `OMORI/www` without `Riruka24.ini`: detect `.OMORI` plugins
    const hasOmoriPlugins = (() => {
      try {
        const pDir = resolveExistingSdPath(`${cleanWww}/js/plugins`);
        const list = pDir ? sw.readDirSync(`${pDir}/`) : null;
        return Boolean(list && list.some((n) => /\.omori$/i.test(n)));
      } catch {
        return false;
      }
    })();
    if (hasOmoriPlugins) {
      if (nwArgv.length === 0) {
        // The decryption key lives in the player's own copy of the game; it is never shipped here.
        logFn?.('[node-compat] .OMORI plugins found but no Riruka24.ini: copy Riruka24.ini from the '
          + 'OMORI install folder next to www/ so the game can decrypt its files');
      }
      // OMORI's Permanent_Manager.load() calls async fs.readFile(LOCALAPPDATA + "/OMORI/CUTSCENE.json")
      // unconditionally on boot and throws an uncaught Error(err) when the file does not exist yet!
      const cutscenePath = `${cleanSaveDir}/OMORI/CUTSCENE.json`;
      if (!resolveExistingSdPath(cutscenePath)) {
        try {
          ensureDir(sw, `${cleanSaveDir}/OMORI`);
          sw.writeFileSync(cutscenePath, '{}');
        } catch { /* ignore */ }
      }
    }
  }

  const nwScreenBounds = { x: 0, y: 0, width: 1280, height: 720 };
  const nwScreenMod = {
    screens: [{ id: 0, bounds: nwScreenBounds, work_area: nwScreenBounds, scaleFactor: 1, isBuiltIn: true }],
    Init() { return nwScreenMod; },
    on() {},
    once() {},
    removeListener() {},
  };

  const nwGuiMod = {
    Window: { get: () => fakeWindow },
    App: { argv: nwArgv, fullArgv: nwArgv, dataPath: cleanSaveDir, quit: () => { if (typeof target.close === 'function') target.close(); else sw?.exit(); } },
    Screen: nwScreenMod,
    Menu: class { items: any[] = []; append(x: any) { this.items.push(x); } createMacBuiltin() {} },
    MenuItem: class { opts: any; constructor(opts: any) { this.opts = opts; } },
    Clipboard: { get: () => ({ get: () => '', set() {} }) },
    Shell: { openExternal() {} },
  };

  const childProcessMod = {
    exec(_cmd: string, cb?: (err: Error | null) => void) {
      logFn?.(`[node-compat] ignored child_process.exec`);
      if (cb) setTimeout(() => cb(null), 0);
    },
    execSync() {
      logFn?.(`[node-compat] ignored child_process.execSync`);
      return new MiniBuffer(0);
    },
    spawn() {
      logFn?.(`[node-compat] ignored child_process.spawn`);
      return { on() {}, stdout: { on() {} }, stderr: { on() {} }, kill() {} };
    },
  };

  // Complete safe Steamworks / Greenworks shim (used by Fear & Hunger, OrangeGreenworks, etc.)
  // Reports initAPI()=true so DRM/init checks pass while keeping Steam Cloud & Overlay disabled
  // so saves stay on SD card. Wrapped in a Proxy so any extra Steam method never throws TypeError.
  const greenworksBase: Record<string, any> = {
    init: () => true,
    initAPI: () => true,
    isSteamRunning: () => true,
    isGameOverlayEnabled: () => false,
    isCloudEnabled: () => false,
    isCloudEnabledForUser: () => false,
    enableCloud: () => {},
    getSteamId: () => ({
      screenName: 'Switch2',
      steamId: '0',
      accountId: 0,
      staticAccountId: '0',
      level: 1,
      isValid: () => false,
    }),
    getCurrentGameLanguage: () => 'english',
    getCurrentUILanguage: () => 'english',
    getNumberOfPlayers: (cb?: (n: number) => void) => { cb?.(1); },
    getNumberOfAchievements: () => 0,
    getAchievementNames: () => [],
    getAchievement: (_name: string, cb?: (achieved: boolean) => void) => { cb?.(false); },
    activateAchievement: (name: string, cb?: () => void) => {
      logFn?.(`[steam] achievement unlocked (offline): ${String(name)}`);
      cb?.();
    },
    clearAchievement: (_name: string, cb?: () => void) => { cb?.(); },
    saveTextToFile: (_name: string, _content: string, cb?: () => void) => { cb?.(); },
    readTextFromFile: (_name: string, _cb?: any, errCb?: (e: Error) => void) => {
      errCb?.(new Error('Steam Cloud disabled on Switch 2'));
    },
    deleteFile: (_name: string, cb?: () => void) => { cb?.(); },
    saveFilesToCloud: (_files: string[], cb?: () => void) => { cb?.(); },
    getCloudQuota: (cb?: (total: number, avail: number) => void) => { cb?.(0, 0); },
    isSubscribedApp: () => true,
    isDLCInstalled: () => false,
    getDLCCount: () => 0,
    setRichPresence: () => true,
    clearRichPresence: () => {},
    on: () => {},
    once: () => {},
    removeListener: () => {},
  };
  const greenworksMod = new Proxy(greenworksBase, {
    get(obj, prop) {
      if (prop in obj) return obj[prop as string];
      if (typeof prop === 'symbol' || prop === 'then' || prop === '__esModule') return undefined;
      return (...args: any[]) => {
        const last = args[args.length - 1];
        if (typeof last === 'function') {
          try { last(); } catch { /* ignore */ }
        }
        return false;
      };
    },
  });

  // Safe Discord RPC stub
  const discordRpcMod = {
    register() {},
    Client: class {
      on() { return this; }
      once() { return this; }
      login() { return Promise.resolve(this); }
      setActivity() { return Promise.resolve(); }
      clearActivity() { return Promise.resolve(); }
      destroy() { return Promise.resolve(); }
    },
  };

  // Minimal Node `os` shim
  const osMod = {
    EOL: '\n',
    platform: () => 'linux',
    arch: () => 'arm64',
    type: () => 'Switch2',
    release: () => '1.0.0',
    hostname: () => 'switch2',
    homedir: () => appRoot,
    tmpdir: () => `${appRoot}/tmp`,
    userInfo: () => ({ username: 'Switch2', uid: 1000, gid: 1000, shell: null, homedir: appRoot }),
    networkInterfaces: () => ({}),
    cpus: () => [{}, {}, {}, {}],
    totalmem: () => 4 * 1024 * 1024 * 1024,
    freemem: () => 2 * 1024 * 1024 * 1024,
  };

  // Minimal Node `events` EventEmitter shim
  class MiniEventEmitter {
    private _listeners = new Map<string, Array<(...a: any[]) => void>>();
    on(ev: string, fn: (...a: any[]) => void) {
      const list = this._listeners.get(ev) ?? [];
      list.push(fn);
      this._listeners.set(ev, list);
      return this;
    }
    addListener(ev: string, fn: (...a: any[]) => void) { return this.on(ev, fn); }
    once(ev: string, fn: (...a: any[]) => void) {
      const wrap = (...a: any[]) => { this.off(ev, wrap); fn(...a); };
      return this.on(ev, wrap);
    }
    off(ev: string, fn: (...a: any[]) => void) {
      const list = this._listeners.get(ev);
      if (list) this._listeners.set(ev, list.filter((f) => f !== fn));
      return this;
    }
    removeListener(ev: string, fn: (...a: any[]) => void) { return this.off(ev, fn); }
    removeAllListeners(ev?: string) {
      if (ev) this._listeners.delete(ev);
      else this._listeners.clear();
      return this;
    }
    emit(ev: string, ...args: any[]) {
      const list = this._listeners.get(ev);
      if (!list || list.length === 0) return false;
      for (const fn of list.slice()) fn(...args);
      return true;
    }
  }
  const eventsMod = Object.assign(MiniEventEmitter, { EventEmitter: MiniEventEmitter });

  // Minimal Node `url` & `util` shims
  const urlMod = {
    parse(str: string) {
      try {
        const u = new URL(str, 'file:///');
        return { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash };
      } catch {
        return { href: str, protocol: '', host: '', hostname: '', pathname: str, search: '', hash: '' };
      }
    },
    format(obj: any) { return typeof obj === 'string' ? obj : String(obj?.href || obj?.pathname || ''); },
    resolve(from: string, to: string) { return pathMod.join(pathMod.dirname(from), to); },
  };
  const utilMod = {
    format(...args: any[]) { return args.map(String).join(' '); },
    inspect(v: any) { try { return JSON.stringify(v); } catch { return String(v); } },
    inherits(ctor: any, superCtor: any) {
      if (ctor && superCtor) {
        ctor.super_ = superCtor;
        Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
      }
    },
  };
  const cryptoMod = {
    randomBytes(size: number) {
      const b = MiniBuffer.alloc(size);
      for (let i = 0; i < size; i++) b[i] = (Math.random() * 256) | 0;
      return b;
    },
    randomUUID() {
      const b = cryptoMod.randomBytes(16);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = b.toString('hex');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    },
    createHash(algorithm: string) {
      const alg = String(algorithm || '').toLowerCase().replace('-', '');
      if (alg !== 'sha256') {
        throw new Error(`Unsupported hash algorithm: ${algorithm}`);
      }
      const chunks: Uint8Array[] = [];
      return {
        update(data: string | Uint8Array | ArrayBuffer, inputEncoding?: string) {
          chunks.push(toBytes(data, inputEncoding || 'utf8'));
          return this;
        },
        digest(encoding?: string): any {
          const all = chunks.length === 1 ? chunks[0] : MiniBuffer.concat(chunks);
          const digest = sha256Bytes(all);
          return encoding ? digest.toString(encoding) : digest;
        },
      };
    },
    createDecipheriv(algorithm: string, key: any, iv: any) {
      return createAesCtrStream(algorithm, key, iv, true);
    },
    createCipheriv(algorithm: string, key: any, iv: any) {
      return createAesCtrStream(algorithm, key, iv, false);
    },
  };

  const zlibMod = {
    inflateRawSync(buf: any): MiniBuffer {
      return inflateRawBytes(toBytes(buf));
    },
    inflateSync(buf: any): MiniBuffer {
      return inflateZlibBytes(toBytes(buf));
    },
    gunzipSync(buf: any): MiniBuffer {
      return gunzipBytes(toBytes(buf));
    },
    unzipSync(buf: any): MiniBuffer {
      const u = toBytes(buf);
      if (u.length >= 2 && u[0] === 0x1f && u[1] === 0x8b) return gunzipBytes(u);
      return inflateZlibBytes(u);
    },
  };

  const bootTimeMs = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
  const hrtimeFn: any = (prev?: [number, number]): [number, number] => {
    const nowMs = (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()) - bootTimeMs;
    const totalNs = Math.max(0, Math.floor(nowMs * 1e6));
    let sec = Math.floor(totalNs / 1e9);
    let nsec = totalNs - sec * 1e9;
    if (Array.isArray(prev) && prev.length === 2) {
      sec -= prev[0] | 0;
      nsec -= prev[1] | 0;
      if (nsec < 0) {
        sec -= 1;
        nsec += 1e9;
      }
    }
    return [sec, nsec];
  };
  hrtimeFn.bigint = () => {
    const [s, ns] = hrtimeFn();
    return BigInt(s) * 1000000000n + BigInt(ns);
  };

  const proc = {
    platform: 'switch2',
    arch: 'arm64',
    execPath: `${appRoot}/Game.exe`,
    env: {
      APPDATA: cleanSaveDir,
      LOCALAPPDATA: cleanSaveDir,
      HOME: appRoot,
      USERPROFILE: appRoot,
    },
    argv: [sw?.argv?.[0] || 'switch2-MV-loader.nro', ...nwArgv],
    cwd: () => appRoot,
    hrtime: hrtimeFn,
    mainModule: { filename: `${cleanWww}/index.html` },
    versions: { node: '18.0.0', nw: '0.29.4', 'nw-flavor': 'normal' },
    nextTick: (fn: (...a: any[]) => void, ...args: any[]) => Promise.resolve().then(() => fn(...args)),
  };

  // CommonJS local module loader for game-shipped JS packages (e.g. OMORI's `./js/libs/js-yaml-master`)
  const cjsCache = new Map<string, { exports: any }>();

  function resolveCjsFile(baseDir: string, reqId: string): string | null {
    if (!sw) return null;
    const rawTarget = reqId.startsWith('sdmc:/')
      ? reqId
      : reqId.startsWith('/')
        ? `${cleanWww}${reqId}`
        : pathMod.join(baseDir, reqId);
    const tryFile = (cand: string): string | null => {
      const hit = resolveExistingSdPath(cand);
      if (!hit) return null;
      try {
        const st = sw.statSync(hit);
        if (st && ((st.mode ?? S_IFREG) & 0o170000) !== S_IFDIR) return hit;
      } catch { /* ignore */ }
      return null;
    };
    const direct = tryFile(rawTarget) || tryFile(`${rawTarget}.js`) || tryFile(`${rawTarget}.json`);
    if (direct) return direct;
    // Directory package resolution (`package.json` main -> `index.js`)
    const pkgJson = tryFile(`${rawTarget}/package.json`);
    if (pkgJson) {
      try {
        const bytes = sw.readFileSync(pkgJson);
        if (bytes) {
          const pkg = JSON.parse(decodeUtf8(new Uint8Array(bytes)));
          if (typeof pkg?.main === 'string' && pkg.main.trim()) {
            const mainCand = pathMod.join(rawTarget, pkg.main.trim());
            const mainHit = tryFile(mainCand) || tryFile(`${mainCand}.js`);
            if (mainHit) return mainHit;
          }
        }
      } catch { /* ignore */ }
    }
    return tryFile(`${rawTarget}/index.js`) || tryFile(`${rawTarget}/index.json`);
  }

  const loggedShims = new Set<string>();
  const IGNORED_OPTIONAL_MODULES = new Set(['esprima', 'bufferutil', 'utf-8-validate']);

  function createScopedRequire(baseDir: string): any {
    const reqFn: any = (id: string) => {
      const cleanId = String(id ?? '').trim().replace(/^node:/i, '');
      const low = cleanId.toLowerCase();
      switch (low) {
        case 'fs': return fsMod;
        case 'path': return pathMod;
        case 'nw.gui': return nwGuiMod;
        case 'child_process': return childProcessMod;
        case 'os': return osMod;
        case 'events': return eventsMod;
        case 'url': return urlMod;
        case 'util': return utilMod;
        case 'crypto': return cryptoMod;
        case 'zlib': return zlibMod;
        case 'buffer': return { Buffer: MiniBuffer };
        case 'pixi.js': return target.PIXI || {};
      }
      if (low.includes('greenworks') || low.includes('steamworks')) {
        if (!loggedShims.has('steam')) {
          loggedShims.add('steam');
          logFn?.(`[node-compat] shimmed Steamworks/Greenworks: require('${cleanId}')`);
        }
        return greenworksMod;
      }
      if (low.includes('discord')) {
        if (!loggedShims.has('discord')) {
          loggedShims.add('discord');
          logFn?.(`[node-compat] shimmed Discord RPC: require('${cleanId}')`);
        }
        return discordRpcMod;
      }
      if (cleanId.startsWith('./') || cleanId.startsWith('../') || cleanId.startsWith('/') || cleanId.startsWith('sdmc:/')) {
        const resolved = resolveCjsFile(baseDir, cleanId) ?? (baseDir !== cleanWww ? resolveCjsFile(cleanWww, cleanId) : null);
        if (resolved) {
          const cached = cjsCache.get(resolved);
          if (cached) return cached.exports;
          const modRecord = { id: resolved, filename: resolved, loaded: false, exports: {} as any };
          cjsCache.set(resolved, modRecord);
          try {
            const bytes = sw?.readFileSync(resolved);
            if (!bytes) throw new Error(`ENOENT: ${resolved}`);
            const text = decodeUtf8(new Uint8Array(bytes)).replace(/^\uFEFF/, '');
            if (resolved.toLowerCase().endsWith('.json')) {
              modRecord.exports = JSON.parse(text);
            } else {
              const modDir = pathMod.dirname(resolved);
              const subReq = createScopedRequire(modDir);
              const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', `${text}\n//# sourceURL=${resolved}`);
              fn(modRecord.exports, subReq, modRecord, resolved, modDir);
            }
            modRecord.loaded = true;
            return modRecord.exports;
          } catch (err) {
            cjsCache.delete(resolved);
            logFn?.(`[node-compat] error loading module '${cleanId}' (${resolved}): ${String(err)}`);
            throw err;
          }
        }
      }
      if (!IGNORED_OPTIONAL_MODULES.has(low) && !loggedShims.has(`unsup:${low}`)) {
        loggedShims.add(`unsup:${low}`);
        logFn?.(`[node-compat] unsupported require('${cleanId}')`);
      }
      return {};
    };
    reqFn.cache = cjsCache;
    reqFn.resolve = (id: string) => resolveCjsFile(baseDir, id) || id;
    return reqFn;
  }

  if (target.TextEncoder?.prototype && !target.TextEncoder.prototype.__drFixedEncode) {
    target.TextEncoder.prototype.__drFixedEncode = true;
    target.TextEncoder.prototype.encode = function (input?: string): Uint8Array {
      return encodeUtf8Safe(input ? String(input) : '');
    };
  }

  (nwGuiMod as any).process = proc;
  target.process = proc;
  target.Buffer = MiniBuffer;
  target.nw = nwGuiMod;
  target.require = createScopedRequire(cleanWww);
}
