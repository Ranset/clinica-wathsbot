// Genera los iconos de la PWA (public/icons/*.png) sin dependencias: dibuja el logo de la clinica
// (la cruz blanca sobre el verde de marca) con suavizado 4x4 y escribe PNG RGBA con zlib.
//   npm run icons        (desde doctor-pwa/)
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const BRAND = [0x0f, 0x76, 0x6e];
const WHITE = [0xff, 0xff, 0xff];

// La cruz del logo en una cuadricula de 32 x 32: dos rectangulos.
const CROSS = [
  [14, 7, 18, 25],
  [7, 14, 25, 18],
];

const inCross = (u, v, k) => CROSS.some(([x0, y0, x1, y1]) => u >= 0.5 + (x0 / 32 - 0.5) * k && u < 0.5 + (x1 / 32 - 0.5) * k && v >= 0.5 + (y0 / 32 - 0.5) * k && v < 0.5 + (y1 / 32 - 0.5) * k);

/** `round`: esquinas redondeadas con fondo transparente. `k`: escala de la cruz (1 = la del logo). */
function render(size, { round, k }) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  const r = round ? 0.25 : 0; // radio relativo: 8/32
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          // dentro del cuadrado redondeado
          const cx = Math.min(Math.max(u, r), 1 - r);
          const cy = Math.min(Math.max(v, r), 1 - r);
          if ((u - cx) ** 2 + (v - cy) ** 2 <= r * r + 1e-9) {
            bg++;
            if (inCross(u, v, k)) fg++;
          }
        }
      }
      const total = S * S;
      const a = bg / total;
      const f = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      px[i] = Math.round(BRAND[0] * (1 - f) + WHITE[0] * f);
      px[i + 1] = Math.round(BRAND[1] * (1 - f) + WHITE[1] * f);
      px[i + 2] = Math.round(BRAND[2] * (1 - f) + WHITE[2] * f);
      px[i + 3] = Math.round(255 * a);
    }
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); // filtro 0 (primer byte de cada fila)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
const files = [
  ["icon-192.png", 192, { round: true, k: 1 }],
  ["icon-512.png", 512, { round: true, k: 1 }],
  // «maskable»: el sistema recorta; el fondo llega al borde y la cruz queda en la zona segura.
  ["maskable-512.png", 512, { round: false, k: 0.9 }],
  // iOS pone fondo negro a lo transparente y redondea solo: fondo lleno.
  ["apple-touch-icon.png", 180, { round: false, k: 1 }],
];
for (const [name, size, opts] of files) {
  writeFileSync(join(OUT, name), png(size, render(size, opts)));
  console.log(`public/icons/${name} (${size}x${size})`);
}
