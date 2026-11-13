/**
 * Revisar un logotipo SIN decodificarlo: tipo real, ancho y alto salen de la cabecera del archivo (igual que
 * `server/app/images.py`, con los mismos mensajes). La usan el simulador y la web (para avisar antes de subir); el servidor
 * vuelve a revisar todo, porque lo del navegador no es de fiar.
 *
 * El tipo se deduce de los BYTES, no del nombre ni de `file.type`. SVG no se acepta a proposito: puede llevar scripts.
 */

export const LOGO_MAX_BYTES = 1024 * 1024; // 1 MB
export const LOGO_MIN_SIDE = 64; // px
export const LOGO_MAX_SIDE = 2048; // px
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** Los bytes de un archivo. `Blob.arrayBuffer()` si existe; si no (jsdom), `FileReader`. */
export async function readBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el archivo."));
    reader.readAsArrayBuffer(file);
  });
}

/** `data:image/png;base64,...` para mostrar la imagen en un `<img>` sin pedirla otra vez (y sin `URL.createObjectURL`). */
export function imageDataUrl(bytes: Uint8Array, contentType: string): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${contentType};base64,${btoa(text)}`;
}

export type ImageInfo = { contentType: (typeof LOGO_TYPES)[number]; width: number; height: number };
export type LogoCheck = { ok: true; info: ImageInfo } | { ok: false; message: string };

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const le32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const at = (b: Uint8Array, i: number, text: string) => [...text].every((c, k) => b[i + k] === c.charCodeAt(0));
const startsWith = (b: Uint8Array, bytes: number[]) => bytes.every((v, k) => b[k] === v);

function png(b: Uint8Array): ImageInfo | string {
  if (b.length < 24 || !at(b, 12, "IHDR")) return "El archivo PNG está dañado.";
  return { contentType: "image/png", width: be32(b, 16), height: be32(b, 20) };
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(b: Uint8Array): ImageInfo | string {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const seg = be16(b, i + 2);
    if (seg < 2) break;
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > b.length) break;
      return { contentType: "image/jpeg", width: be16(b, i + 7), height: be16(b, i + 5) };
    }
    i += 2 + seg;
  }
  return "El archivo JPG está dañado.";
}

function webp(b: Uint8Array): ImageInfo | string {
  const broken = "El archivo WebP está dañado.";
  if (b.length < 30) return broken;
  if (at(b, 12, "VP8 ")) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return broken;
    return { contentType: "image/webp", width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (at(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return broken;
    const bits = le32(b, 21);
    return { contentType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (at(b, 12, "VP8X")) return { contentType: "image/webp", width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return broken;
}

/** Tipo y medidas por los bytes, o el mensaje de por que no sirve. NO revisa el tamano en pixeles ni si es cuadrada: eso es `checkLogo`. */
export function inspectImage(bytes: Uint8Array): ImageInfo | string {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return png(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return jpeg(bytes);
  if (at(bytes, 0, "RIFF") && at(bytes, 8, "WEBP")) return webp(bytes);
  return "Sube una imagen PNG, JPG o WebP.";
}

/** Valida el logotipo: <= 1 MB, PNG/JPG/WebP, CUADRADO (1:1) y de 64 a 2048 px por lado. Mismos mensajes que el servidor. */
export function checkLogo(bytes: Uint8Array): LogoCheck {
  const fail = (message: string): LogoCheck => ({ ok: false, message });
  if (bytes.length === 0) return fail("No llegó ningún archivo.");
  if (bytes.length > LOGO_MAX_BYTES) return fail(`La imagen pesa más de ${LOGO_MAX_BYTES / (1024 * 1024)} MB.`);
  const info = inspectImage(bytes);
  if (typeof info === "string") return fail(info);
  const { width, height } = info;
  if (width !== height) return fail(`La imagen debe ser cuadrada (1:1); esta mide ${width} × ${height} px.`);
  if (width < LOGO_MIN_SIDE) return fail(`La imagen es muy pequeña: mínimo ${LOGO_MIN_SIDE} × ${LOGO_MIN_SIDE} px (esta mide ${width} × ${height}).`);
  if (width > LOGO_MAX_SIDE) return fail(`La imagen es muy grande: máximo ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} px (esta mide ${width} × ${height}).`);
  return { ok: true, info };
}
