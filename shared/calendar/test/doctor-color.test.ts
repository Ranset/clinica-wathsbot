import { describe, expect, it } from "vitest";
import { DOCTOR_COLORS, ON_DOCTOR_COLOR, colorOf, contrastWithWhite, doctorColor, doctorColorIndex, isHexColor, isReadableOnWhite } from "../src";

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
/** Contraste WCAG entre dos colores. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** Distancia de color percibida (CIE76 en Lab): >= ~20 se distingue claramente; < ~10 se confunde. */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const deltaE = (a: string, b: string) => Math.hypot(...(lab(a).map((v, i) => v - lab(b)[i]!) as [number, number, number]));
const pairs = <T,>(xs: readonly T[]) => xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b] as const));

describe("color de cada doctor", () => {
  it("el mismo doctor siempre tiene el mismo color, venga el id como '3' (servidor) o 'd3' (simulador)", () => {
    expect(doctorColor("3")).toBe(doctorColor("3"));
    expect(doctorColor("d3")).toBe(doctorColor("3"));
    for (let n = 1; n <= 30; n++) expect(doctorColor(`d${n}`)).toBe(doctorColor(String(n)));
  });

  it("los primeros 10 doctores no comparten color (los 7 de la clinica incluidos) y a partir del 11 la paleta se repite", () => {
    const first = Array.from({ length: 10 }, (_, i) => doctorColor(String(i + 1)));
    expect(new Set(first).size).toBe(10);
    expect(first).toEqual([...DOCTOR_COLORS]);
    expect(doctorColor("11")).toBe(doctorColor("1"));
    expect(doctorColor("17")).toBe(doctorColor("7"));
  });

  it("no cambia cuando se da de baja o se elimina a otro: depende solo de su propio id", () => {
    const antes = ["1", "2", "3", "4", "5", "6", "7"].map(doctorColor);
    // un doctor nuevo (id 8) o la baja del 3 no mueven a los demas
    expect(["1", "2", "3", "4", "5", "6", "7"].map(doctorColor)).toEqual(antes);
    expect(doctorColor("8")).not.toBe(antes[0]);
  });

  it("un id sin numero recibe un color estable; sin doctor (bloqueo) no hay color", () => {
    expect(doctorColor("dra-geydi")).toBe(doctorColor("dra-geydi"));
    expect(DOCTOR_COLORS).toContain(doctorColor("dra-geydi") as (typeof DOCTOR_COLORS)[number]);
    expect(doctorColorIndex("dra-geydi")).toBeGreaterThanOrEqual(0);
    expect(doctorColorIndex("dra-geydi")).toBeLessThan(DOCTOR_COLORS.length);
    for (const nada of [null, undefined, ""]) expect(doctorColor(nada)).toBeNull();
    expect(doctorColor("0")).not.toBeNull();   // un id raro igual recibe color
  });

  it("todos son legibles con texto blanco (contraste AA >= 4.5:1)", () => {
    for (const c of DOCTOR_COLORS) expect(contrast(c, ON_DOCTOR_COLOR), c).toBeGreaterThanOrEqual(4.5);
  });

  it("se distinguen entre si: los 7 de la clinica bien separados, y toda la paleta sin confundirse", () => {
    for (const [a, b] of pairs(DOCTOR_COLORS.slice(0, 7))) expect(deltaE(a, b), `${a} vs ${b}`).toBeGreaterThanOrEqual(20);
    for (const [a, b] of pairs(DOCTOR_COLORS)) expect(deltaE(a, b), `${a} vs ${b}`).toBeGreaterThanOrEqual(10);
  });

  it("ninguno se parece al verde azulado de la marca (botones y «hoy»)", () => {
    for (const c of DOCTOR_COLORS) expect(deltaE(c, "#0f766e"), c).toBeGreaterThanOrEqual(20);
  });
});

describe("color elegido para un doctor", () => {
  it("colorOf: el elegido manda; sin elegir (null, ausente o invalido) vale el automatico por su id", () => {
    expect(colorOf({ id: "1", color: "#be185d" })).toBe("#be185d");
    expect(colorOf({ id: "1", color: "#BE185D" })).toBe("#be185d");                    // se normaliza a minusculas
    for (const nada of [null, undefined, "", "rojo", "#fff", "#12345g"]) expect(colorOf({ id: "1", color: nada }), String(nada)).toBe(doctorColor("1"));
    expect(colorOf({ id: "d3" })).toBe(doctorColor("3"));
    expect(colorOf(null)).toBeNull();
    expect(colorOf(undefined)).toBeNull();
  });

  it("isHexColor: solo #rrggbb", () => {
    for (const ok of ["#1d4ed8", "#1D4ED8", "#000000"]) expect(isHexColor(ok), ok).toBe(true);
    for (const mal of ["1d4ed8", "#1d4ed", "#1d4ed88", "#12345g", "azul", "", "#1d4ed8 ", "rgb(0,0,0)", 123, null, undefined]) expect(isHexColor(mal), String(mal)).toBe(false);
  });

  // Los mismos casos que `server/tests/test_colors.py`: el servidor y la web deben decidir igual.
  it("isReadableOnWhite: la paleta pasa, lo claro no, y el borde es el de WCAG AA (igual que el servidor)", () => {
    for (const c of DOCTOR_COLORS) expect(isReadableOnWhite(c), c).toBe(true);
    for (const c of ["#ffffff", "#ffff00", "#cccccc", "#a3e635", "#fde68a", "#777777", "#22c55e"]) expect(isReadableOnWhite(c), c).toBe(false);
    expect(contrastWithWhite("#767676").toFixed(2)).toBe("4.54");
    expect(contrastWithWhite("#777777").toFixed(2)).toBe("4.48");
    expect(isReadableOnWhite("#767676")).toBe(true);
    expect(contrastWithWhite("#000000").toFixed(1)).toBe("21.0");
    expect(contrastWithWhite("#ffffff").toFixed(1)).toBe("1.0");
    expect(isReadableOnWhite("no-es-un-color")).toBe(false);
  });
});
