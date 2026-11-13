import { deflateSync } from "node:zlib";

/**
 * Imagenes de prueba. El PNG es de VERDAD (lo decodifica cualquier navegador); JPEG y WebP solo traen la cabecera que lee el
 * servidor (mismos casos que `server/tests/test_branding.py`).
 */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const be32 = (n: number) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const be16 = (n: number) => Uint8Array.from([(n >>> 8) & 255, n & 255]);
const le16 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255]);
const le24 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255]);
const le32 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

/** Un PNG de `w` x `h` (por defecto cuadrado), escala de grises, sin interlazado. */
export function png(w: number, h: number = w): Uint8Array {
  const chunk = (kind: string, payload: Uint8Array) => {
    const body = concat(ascii(kind), payload);
    return concat(be32(payload.length), body, be32(crc32(body)));
  };
  const rows = Uint8Array.from({ length: h * (w + 1) }, (_, i) => (i % (w + 1) === 0 ? 0 : 0x80));
  return concat(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", concat(be32(w), be32(h), Uint8Array.from([8, 0, 0, 0, 0]))),
    chunk("IDAT", new Uint8Array(deflateSync(rows))),
    chunk("IEND", new Uint8Array())
  );
}

/** Cabecera JPEG con APP0 y SOF0. */
export function jpeg(w: number, h: number = w): Uint8Array {
  const app0 = concat(Uint8Array.from([0xff, 0xe0]), be16(16), ascii("JFIF"), Uint8Array.from([0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const sof = concat(Uint8Array.from([0xff, 0xc0]), be16(11), Uint8Array.from([8]), be16(h), be16(w), Uint8Array.from([1, 1, 0x11, 0]));
  return concat(Uint8Array.from([0xff, 0xd8]), app0, sof, Uint8Array.from([0xff, 0xd9]));
}

const riff = (chunk: Uint8Array) => concat(ascii("RIFF"), le32(4 + chunk.length), ascii("WEBP"), chunk);

export function webpLossy(w: number, h: number = w): Uint8Array {
  const frame = concat(Uint8Array.from([0, 0, 0, 0x9d, 0x01, 0x2a]), le16(w), le16(h), new Uint8Array(4));
  return riff(concat(ascii("VP8 "), le32(frame.length), frame));
}

export function webpLossless(w: number, h: number = w): Uint8Array {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  const frame = concat(Uint8Array.from([0x2f]), le32(bits), new Uint8Array(12));
  return riff(concat(ascii("VP8L"), le32(frame.length), frame));
}

export function webpExtended(w: number, h: number = w): Uint8Array {
  const frame = concat(new Uint8Array(4), le24(w - 1), le24(h - 1), new Uint8Array(4));
  return riff(concat(ascii("VP8X"), le32(frame.length), frame));
}

/** Rellena con ceros hasta `size` bytes (la cabecera sigue siendo valida). */
export const padTo = (bytes: Uint8Array, size: number): Uint8Array => concat(bytes, new Uint8Array(Math.max(0, size - bytes.length)));

export const svg = (): Uint8Array => ascii("<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><script>alert(1)</script></svg>");
export const gif = (): Uint8Array => concat(ascii("GIF89a"), new Uint8Array(40));
