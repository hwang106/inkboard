// Small DEFLATE decoder (RFC 1951) that reports how many bytes it used, so gzip streams
// packed back to back inside a .whiteboard file can be read without knowing their lengths.
// (The browser's DecompressionStream fails on the data that follows each stream.)

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huff(lengths) {
  const counts = new Uint16Array(16), offs = new Uint16Array(16), symbols = new Uint16Array(lengths.length);
  for (const l of lengths) counts[l]++;
  counts[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
  return { counts, symbols };
}
let FIXED_L, FIXED_D;
function fixed() {
  if (!FIXED_L) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED_L = huff(l); FIXED_D = huff(new Uint8Array(30).fill(5));
  }
  return [FIXED_L, FIXED_D];
}

// Inflate raw DEFLATE data starting at `pos`. Returns { data, end } (end = byte after the stream).
export function inflateRaw(src, pos = 0) {
  let bitBuf = 0, bitCnt = 0, out = new Uint8Array(Math.max(1024, (src.length - pos) * 4)), n = 0;
  const need = k => {
    while (bitCnt < k) {
      if (pos >= src.length) throw new Error("Compressed data ended early");
      bitBuf |= src[pos++] << bitCnt; bitCnt += 8;
    }
  };
  const bits = k => { need(k); const v = bitBuf & ((1 << k) - 1); bitBuf >>>= k; bitCnt -= k; return v; };
  const grow = k => {
    if (n + k <= out.length) return;
    const o = new Uint8Array(Math.max(out.length * 2, n + k)); o.set(out.subarray(0, n)); out = o;
  };
  const decode = h => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.counts[len];
      if (code - c < first) return h.symbols[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error("Bad compressed data");
  };
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      const len = src[pos] | (src[pos + 1] << 8); pos += 4;
      grow(len); out.set(src.subarray(pos, pos + len), n); n += len; pos += len;
      continue;
    }
    let L, D;
    if (type === 1) [L, D] = fixed();
    else if (type === 2) {
      const hl = bits(5) + 257, hd = bits(5) + 1, hc = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hc; i++) cl[CL_ORDER[i]] = bits(3);
      const ch = huff(cl), lens = new Uint8Array(hl + hd);
      for (let i = 0; i < hl + hd;) {
        const s = decode(ch);
        if (s < 16) lens[i++] = s;
        else if (s === 16) { const p = lens[i - 1], r = 3 + bits(2); lens.fill(p, i, i + r); i += r; }
        else if (s === 17) i += 3 + bits(3);
        else i += 11 + bits(7);
      }
      L = huff(lens.subarray(0, hl)); D = huff(lens.subarray(hl));
    } else throw new Error("Bad compressed block");
    for (;;) {
      const s = decode(L);
      if (s < 256) { grow(1); out[n++] = s; continue; }
      if (s === 256) break;
      const li = s - 257, len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
      const di = decode(D), dist = DIST_BASE[di] + bits(DIST_EXTRA[di]);
      grow(len);
      for (let k = 0; k < len; k++, n++) out[n] = out[n - dist];
    }
  }
  return { data: out.subarray(0, n), end: pos };
}

// A gzip member starting at `pos`. Returns { data, end } or throws.
export function gunzipAt(src, pos) {
  if (src[pos] !== 0x1f || src[pos + 1] !== 0x8b || src[pos + 2] !== 8) throw new Error("Not gzip");
  const flg = src[pos + 3];
  let p = pos + 10;
  if (flg & 4) p += 2 + (src[p] | (src[p + 1] << 8));
  if (flg & 8) while (src[p++]);
  if (flg & 16) while (src[p++]);
  if (flg & 2) p += 2;
  const { data, end } = inflateRaw(src, p);
  return { data, end: end + 8 };
}
