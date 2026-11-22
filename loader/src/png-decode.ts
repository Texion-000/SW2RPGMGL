/**
 * Compact, spec-compliant PNG -> RGBA32 decoder using native Web `DecompressionStream('deflate')`.
 *
 * Handles all standard PNG color types (Grayscale 0, RGB 2, Indexed Palette 3 + tRNS,
 * Grayscale+Alpha 4, RGBA 6), bit depths (1, 2, 4, 8, 16), all 5 PNG scanline filters,
 * and both non-interlaced and Adam7 interlaced images.
 *
 * Used by the Game Select screen so game icons always render accurately regardless of
 * PNG color type (bypassing nx.js's libpng RGBA8-only assumptions).
 */

export interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  rgba: Uint8ClampedArray;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readU32(u8: Uint8Array, off: number): number {
  return (
    ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0
  );
}

function readU16(u8: Uint8Array, off: number): number {
  return (u8[off] << 8) | u8[off + 1];
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

async function inflateZlib(compressed: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream;
  if (typeof DS !== 'function') {
    throw new Error('DecompressionStream unavailable');
  }
  const ds = new DS('deflate');
  const writer = ds.writable.getWriter();
  const writePromise = writer.write(compressed).then(() => writer.close());
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const u = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(u);
    total += u.byteLength;
  }
  await writePromise;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

function samplesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0: return 1; // Grayscale
    case 2: return 3; // RGB
    case 3: return 1; // Palette index
    case 4: return 2; // Grayscale + Alpha
    case 6: return 4; // RGBA
    default: throw new Error(`Unsupported PNG colorType ${colorType}`);
  }
}

function unfilterPass(
  raw: Uint8Array,
  rawOffset: number,
  passW: number,
  passH: number,
  bitsPerPixel: number,
): { pixels: Uint8Array; nextOffset: number; stride: number } {
  const stride = Math.ceil((passW * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const out = new Uint8Array(stride * passH);
  let src = rawOffset;

  for (let y = 0; y < passH; y++) {
    const filter = raw[src++];
    const rowOff = y * stride;
    const prevOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const xVal = raw[src++] ?? 0;
      const a = x >= bpp ? out[rowOff + x - bpp] : 0;
      const b = y > 0 ? out[prevOff + x] : 0;
      const c = x >= bpp && y > 0 ? out[prevOff + x - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0: v = xVal; break;
        case 1: v = (xVal + a) & 0xff; break;
        case 2: v = (xVal + b) & 0xff; break;
        case 3: v = (xVal + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (xVal + paethPredictor(a, b, c)) & 0xff; break;
        default: throw new Error(`Invalid PNG filter ${filter}`);
      }
      out[rowOff + x] = v;
    }
  }
  return { pixels: out, nextOffset: src, stride };
}

function sampleBits(row: Uint8Array, rowOff: number, idx: number, bitDepth: number): number {
  if (bitDepth === 8) return row[rowOff + idx];
  if (bitDepth === 16) return row[rowOff + idx * 2]; // MSB -> 8-bit
  const perByte = 8 / bitDepth;
  const byteVal = row[rowOff + Math.floor(idx / perByte)];
  const shift = 8 - bitDepth * ((idx % perByte) + 1);
  const mask = (1 << bitDepth) - 1;
  return (byteVal >> shift) & mask;
}

function writeRowToRgba(
  rgba: Uint8ClampedArray,
  fullWidth: number,
  passPixels: Uint8Array,
  stride: number,
  passW: number,
  passH: number,
  startX: number,
  startY: number,
  stepX: number,
  stepY: number,
  colorType: number,
  bitDepth: number,
  plte: Uint8Array | null,
  trns: Uint8Array | null,
): void {
  const maxSample = bitDepth === 16 ? 255 : (1 << bitDepth) - 1;
  const scaleGray = (v: number) => (bitDepth >= 8 ? v : Math.round((v * 255) / maxSample));

  const trnsGray = colorType === 0 && trns && trns.length >= 2
    ? (bitDepth === 16 ? trns[0] : readU16(trns, 0))
    : -1;
  const trnsR = colorType === 2 && trns && trns.length >= 6 ? (bitDepth === 16 ? trns[0] : trns[1]) : -1;
  const trnsG = colorType === 2 && trns && trns.length >= 6 ? (bitDepth === 16 ? trns[2] : trns[3]) : -1;
  const trnsB = colorType === 2 && trns && trns.length >= 6 ? (bitDepth === 16 ? trns[4] : trns[5]) : -1;

  for (let py = 0; py < passH; py++) {
    const rowOff = py * stride;
    const dstY = startY + py * stepY;
    for (let px = 0; px < passW; px++) {
      const dstX = startX + px * stepX;
      const di = (dstY * fullWidth + dstX) * 4;
      if (colorType === 6) {
        const base = px * 4;
        rgba[di] = sampleBits(passPixels, rowOff, base, bitDepth);
        rgba[di + 1] = sampleBits(passPixels, rowOff, base + 1, bitDepth);
        rgba[di + 2] = sampleBits(passPixels, rowOff, base + 2, bitDepth);
        rgba[di + 3] = sampleBits(passPixels, rowOff, base + 3, bitDepth);
      } else if (colorType === 2) {
        const base = px * 3;
        const r = sampleBits(passPixels, rowOff, base, bitDepth);
        const g = sampleBits(passPixels, rowOff, base + 1, bitDepth);
        const b = sampleBits(passPixels, rowOff, base + 2, bitDepth);
        rgba[di] = r;
        rgba[di + 1] = g;
        rgba[di + 2] = b;
        rgba[di + 3] = (r === trnsR && g === trnsG && b === trnsB) ? 0 : 255;
      } else if (colorType === 3) {
        const idx = sampleBits(passPixels, rowOff, px, bitDepth);
        const pi = idx * 3;
        rgba[di] = plte && pi + 2 < plte.length ? plte[pi] : 0;
        rgba[di + 1] = plte && pi + 2 < plte.length ? plte[pi + 1] : 0;
        rgba[di + 2] = plte && pi + 2 < plte.length ? plte[pi + 2] : 0;
        rgba[di + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        const rawG = sampleBits(passPixels, rowOff, px, bitDepth);
        const g = scaleGray(rawG);
        rgba[di] = g;
        rgba[di + 1] = g;
        rgba[di + 2] = g;
        rgba[di + 3] = rawG === trnsGray ? 0 : 255;
      } else if (colorType === 4) {
        const base = px * 2;
        const g = sampleBits(passPixels, rowOff, base, bitDepth);
        const a = sampleBits(passPixels, rowOff, base + 1, bitDepth);
        rgba[di] = g;
        rgba[di + 1] = g;
        rgba[di + 2] = g;
        rgba[di + 3] = a;
      }
    }
  }
}

export async function decodePngToRgba(buffer: ArrayBuffer | Uint8Array): Promise<DecodedPng> {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8.byteLength < 33) throw new Error('PNG too small');
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== PNG_SIG[i]) throw new Error('Invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];
  let idatTotal = 0;

  let pos = 8;
  while (pos + 12 <= u8.byteLength) {
    const len = readU32(u8, pos);
    const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > u8.byteLength) break;

    if (type === 'IHDR' && len >= 13) {
      width = readU32(u8, dataStart);
      height = readU32(u8, dataStart + 4);
      bitDepth = u8[dataStart + 8];
      colorType = u8[dataStart + 9];
      interlace = u8[dataStart + 12];
    } else if (type === 'PLTE') {
      plte = u8.subarray(dataStart, dataEnd);
    } else if (type === 'tRNS') {
      trns = u8.subarray(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idatChunks.push(u8.subarray(dataStart, dataEnd));
      idatTotal += len;
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4; // skip CRC
  }

  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    throw new Error(`Invalid PNG dimensions ${width}x${height}`);
  }
  if (idatTotal === 0) throw new Error('Missing IDAT');

  const idat = new Uint8Array(idatTotal);
  let off = 0;
  for (const ch of idatChunks) {
    idat.set(ch, off);
    off += ch.byteLength;
  }

  const raw = await inflateZlib(idat);
  const bitsPerPixel = samplesPerPixel(colorType) * bitDepth;
  const rgba = new Uint8ClampedArray(width * height * 4);

  if (interlace === 0) {
    const { pixels, stride } = unfilterPass(raw, 0, width, height, bitsPerPixel);
    writeRowToRgba(rgba, width, pixels, stride, width, height, 0, 0, 1, 1, colorType, bitDepth, plte, trns);
  } else if (interlace === 1) {
    // Adam7 interlacing
    const startX = [0, 4, 0, 2, 0, 1, 0];
    const startY = [0, 0, 4, 0, 2, 0, 1];
    const stepX = [8, 8, 4, 4, 2, 2, 1];
    const stepY = [8, 8, 8, 4, 4, 2, 2];
    let rawOff = 0;
    for (let p = 0; p < 7; p++) {
      const pw = Math.ceil((width - startX[p]) / stepX[p]);
      const ph = Math.ceil((height - startY[p]) / stepY[p]);
      if (pw <= 0 || ph <= 0) continue;
      const res = unfilterPass(raw, rawOff, pw, ph, bitsPerPixel);
      rawOff = res.nextOffset;
      writeRowToRgba(rgba, width, res.pixels, res.stride, pw, ph, startX[p], startY[p], stepX[p], stepY[p], colorType, bitDepth, plte, trns);
    }
  } else {
    throw new Error(`Unsupported PNG interlace method ${interlace}`);
  }

  return { width, height, bitDepth, colorType, rgba };
}
