import { describe, expect, it } from "vitest";
import { LOGO_MAX_BYTES, checkLogo, imageDataUrl, inspectImage, readBytes } from "../src";
import { gif, jpeg, padTo, png, svg, webpExtended, webpLossless, webpLossy } from "./images";

/** Los MISMOS casos que `server/tests/test_branding.py`: la web avisa antes de subir y el servidor decide igual. */
describe("revisar un logotipo por sus bytes", () => {
  it("lee tipo y medidas de PNG, JPG y WebP (los tres formatos de WebP)", () => {
    expect(inspectImage(png(128))).toEqual({ contentType: "image/png", width: 128, height: 128 });
    expect(inspectImage(jpeg(128))).toEqual({ contentType: "image/jpeg", width: 128, height: 128 });
    for (const w of [webpLossy, webpLossless, webpExtended]) expect(inspectImage(w(128))).toEqual({ contentType: "image/webp", width: 128, height: 128 });
  });

  it("mide imágenes que no son cuadradas y los extremos", () => {
    expect(inspectImage(png(800, 600))).toEqual({ contentType: "image/png", width: 800, height: 600 });
    expect(inspectImage(jpeg(300, 200))).toEqual({ contentType: "image/jpeg", width: 300, height: 200 });
    expect(inspectImage(webpLossless(1, 2048))).toEqual({ contentType: "image/webp", width: 1, height: 2048 });
    expect(inspectImage(webpExtended(2048, 64))).toEqual({ contentType: "image/webp", width: 2048, height: 64 });
    expect(checkLogo(png(64)).ok).toBe(true);
    expect(checkLogo(png(2048)).ok).toBe(true); // los extremos valen
  });

  it("un JPEG con otros segmentos antes del SOF se lee igual", () => {
    const base = jpeg(256);
    const comentario = Uint8Array.from([0xff, 0xfe, 0, 8, 104, 111, 108, 97, 33, 33]);
    const data = Uint8Array.from([...base.slice(0, 2), ...comentario, ...base.slice(2)]);
    expect(inspectImage(data)).toEqual({ contentType: "image/jpeg", width: 256, height: 256 });
  });

  it("rechaza lo que no sirve, con el motivo en español", () => {
    const msg = (b: Uint8Array) => {
      const r = checkLogo(b);
      return r.ok ? "OK" : r.message;
    };
    expect(msg(png(800, 600))).toBe("La imagen debe ser cuadrada (1:1); esta mide 800 × 600 px.");
    expect(msg(jpeg(300, 200))).toMatch(/cuadrada/);
    expect(msg(png(63))).toMatch(/muy pequeña: mínimo 64 × 64/);
    expect(msg(png(2049))).toMatch(/muy grande: máximo 2048 × 2048/);
    expect(msg(new Uint8Array())).toBe("No llegó ningún archivo.");
    for (const raro of [svg(), gif(), Uint8Array.from([...new TextEncoder().encode("%PDF-1.4 hola")]), new TextEncoder().encode("texto cualquiera")]) {
      expect(msg(raro)).toBe("Sube una imagen PNG, JPG o WebP.");
    }
    expect(msg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]))).toMatch(/PNG está dañado/);
    expect(msg(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toMatch(/JPG está dañado/);
  });

  it("1 MB justo cabe; un byte más no (aunque la cabecera sea buena)", () => {
    expect(checkLogo(padTo(png(128), LOGO_MAX_BYTES)).ok).toBe(true);
    const r = checkLogo(padTo(png(128), LOGO_MAX_BYTES + 1));
    expect(r).toEqual({ ok: false, message: "La imagen pesa más de 1 MB." });
  });

  it("el tipo sale de los bytes, no del nombre del archivo", () => {
    expect(inspectImage(jpeg(100))).toMatchObject({ contentType: "image/jpeg" }); // aunque se llame logo.png
  });
});

describe("bytes y direcciones de datos", () => {
  it("readBytes lee un Blob y imageDataUrl arma una dirección que cualquier <img> entiende", async () => {
    const original = png(64);
    const bytes = await readBytes(new Blob([original as BlobPart], { type: "image/png" }));
    expect([...bytes]).toEqual([...original]);
    const url = imageDataUrl(original, "image/png");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const back = Uint8Array.from(atob(url.split(",")[1]!), (c) => c.charCodeAt(0));
    expect([...back]).toEqual([...original]);
  });

  it("imageDataUrl aguanta imágenes grandes (sin desbordar la pila)", () => {
    const big = padTo(png(128), 900_000);
    expect(imageDataUrl(big, "image/png").length).toBeGreaterThan(1_200_000);
  });
});
