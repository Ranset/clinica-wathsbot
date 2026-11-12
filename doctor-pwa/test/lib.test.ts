import { describe, expect, it } from "vitest";
import { affectedMessage, describeAbsence, overlapsRange } from "../src/lib/absence";
import { ago, fmtSyncTime } from "../src/lib/fmt";
import { compactHours, sameHours } from "../src/lib/hours";
import { rangeToUtc } from "../src/lib/range";
import { MAX_AGENDA_ENTRIES, PREFIX, clearStoredData, createSnapshotStore, readStoredSession, writeStoredSession } from "../src/lib/storage";
import { detectPush, isIos, urlBase64ToUint8Array, type PushEnv } from "../src/pwa/push";
import { parsePushPayload, safeUrl } from "../src/pwa/push-payload";

/** La hora se muestra con un espacio duro entre el número y AM/PM (para que no se parta en dos renglones). */
const nb = (s: string) => s.replace(/ (AM|PM)/g, " $1");

/** Un `Storage` en memoria (lo que haga falta romper se rompe aquí sin tocar el de jsdom). */
function memoryStorage(opts: { quota?: number; blocked?: boolean } = {}): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const total = () => [...data.values()].reduce((n, v) => n + v.length, 0);
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => {
      if (opts.blocked) throw new DOMException("blocked", "SecurityError");
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.blocked) throw new DOMException("blocked", "SecurityError");
      if (opts.quota !== undefined && total() - (data.get(k)?.length ?? 0) + v.length > opts.quota) throw new DOMException("full", "QuotaExceededError");
      data.set(k, String(v));
    },
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

describe("fechas y textos", () => {
  it("rangeToUtc: lunes 00:00 de Cancun hasta el lunes siguiente 00:00 (UTC-5)", () => {
    expect(rangeToUtc({ from: "2026-11-09", to: "2026-11-15" })).toEqual({ from: "2026-11-09T05:00:00.000Z", to: "2026-11-16T05:00:00.000Z" });
  });

  it("ago: segundos, minutos, horas y días", () => {
    const now = new Date("2026-11-10T15:00:00Z");
    expect(ago(new Date(now.getTime() - 2_000), now)).toBe("ahora mismo");
    expect(ago(new Date(now.getTime() - 30_000), now)).toBe("hace 30 s");
    expect(ago(new Date(now.getTime() - 5 * 60_000), now)).toBe("hace 5 min");
    expect(ago(new Date(now.getTime() - 3 * 3600_000), now)).toBe("hace 3 h");
    expect(ago(new Date(now.getTime() - 50 * 3600_000), now)).toBe("hace 2 d");
  });

  it("fmtSyncTime: «hoy», «ayer» o el día, siempre en hora de Cancún", () => {
    const now = new Date("2026-11-10T15:00:00Z"); // martes 10:00 en Cancún
    expect(fmtSyncTime(new Date("2026-11-10T14:42:00Z"), now)).toBe(nb("hoy 9:42 AM"));
    expect(fmtSyncTime(new Date("2026-11-09T23:30:00Z"), now)).toBe(nb("ayer 6:30 PM"));
    expect(fmtSyncTime(new Date("2026-11-05T15:00:00Z"), now)).toBe(nb("jue 5 nov 10:00 AM"));
    // 04:00 UTC del 10 es todavía el 9 en Cancún
    expect(fmtSyncTime(new Date("2026-11-10T04:00:00Z"), now)).toBe(nb("ayer 11:00 PM"));
  });
});

describe("ausencias", () => {
  it("describeAbsence: todo el día, varios días o con horas", () => {
    // 12 nov completo (00:00 a 00:00 de Cancún)
    expect(describeAbsence({ startUtc: "2026-11-12T05:00:00Z", endUtc: "2026-11-13T05:00:00Z" })).toBe("jue 12 nov (todo el día)");
    expect(describeAbsence({ startUtc: "2026-11-12T05:00:00Z", endUtc: "2026-11-14T05:00:00Z" })).toBe("jue 12 nov al vie 13 nov (todo el día)");
    expect(describeAbsence({ startUtc: "2026-11-12T14:00:00Z", endUtc: "2026-11-12T17:00:00Z" })).toBe(nb("jue 12 nov · 9:00 AM → jue 12 nov · 12:00 PM"));
  });

  it("overlapsRange: intervalos semiabiertos", () => {
    const a = { startUtc: "2026-11-12T05:00:00Z", endUtc: "2026-11-13T05:00:00Z" };
    expect(overlapsRange(a, "2026-11-12T00:00:00Z", "2026-11-12T06:00:00Z")).toBe(true);
    expect(overlapsRange(a, "2026-11-13T05:00:00Z", "2026-11-14T05:00:00Z")).toBe(false); // empieza justo cuando termina
    expect(overlapsRange(a, "2026-11-11T05:00:00Z", "2026-11-12T05:00:00Z")).toBe(false);
  });

  it("affectedMessage: ninguna, una o varias citas afectadas", () => {
    expect(affectedMessage(0)).toMatch(/No tienes citas agendadas/);
    expect(affectedMessage(1)).toMatch(/Tienes 1 cita agendada .* No se canceló/);
    expect(affectedMessage(4)).toMatch(/Tienes 4 citas agendadas .* No se cancelaron/);
  });
});

describe("horario semanal", () => {
  it("sameHours ignora el orden de los tramos y los días vacíos", () => {
    const a = { mon: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "18:00" }], tue: [] };
    const b = { mon: [{ start: "15:00", end: "18:00" }, { start: "09:00", end: "13:00" }] };
    expect(sameHours(a, b)).toBe(true);
    expect(sameHours(a, { mon: [{ start: "09:00", end: "13:00" }] })).toBe(false);
    expect(compactHours(a)).toEqual({ mon: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "18:00" }] });
  });
});

describe("copias de lectura en el dispositivo (storage)", () => {
  const snap = <T,>(data: T, savedAt = "2026-11-10T15:00:00.000Z") => ({ savedAt, data, etag: 'W/"abc"' });

  it("lee lo que escribió, con su ETag, y solo para ese usuario", () => {
    const storage = memoryStorage();
    createSnapshotStore(storage, "u3").write("agenda:a_b", snap([{ id: "b1" }]));
    expect(createSnapshotStore(storage, "u3").read("agenda:a_b")).toEqual(snap([{ id: "b1" }]));
    expect(createSnapshotStore(storage, "u4").read("agenda:a_b")).toBeNull(); // otro usuario no lo ve
  });

  it("un valor corrupto o sin forma de copia se ignora", () => {
    const storage = memoryStorage();
    storage.setItem(`${PREFIX}u3:profile`, "{no es json");
    storage.setItem(`${PREFIX}u3:absences`, JSON.stringify({ hola: 1 }));
    const store = createSnapshotStore(storage, "u3");
    expect(store.read("profile")).toBeNull();
    expect(store.read("absences")).toBeNull();
  });

  it("conserva solo las últimas semanas de agenda (descarta la más vieja)", () => {
    const storage = memoryStorage();
    const store = createSnapshotStore(storage, "u3");
    for (let i = 0; i < MAX_AGENDA_ENTRIES + 3; i++) store.write(`agenda:w${i}`, snap([i]));
    expect(store.read("agenda:w0")).toBeNull();
    expect(store.read("agenda:w2")).toBeNull();
    expect(store.read("agenda:w3")).not.toBeNull();
    expect(store.read(`agenda:w${MAX_AGENDA_ENTRIES + 2}`)).not.toBeNull();
    // lo que no es agenda (perfil, ausencias…) no entra en ese tope
    store.write("profile", snap({ id: "d1" }));
    expect(store.read("profile")).not.toBeNull();
  });

  it("si el almacenamiento se llena, suelta la semana más vieja y guarda la nueva", () => {
    const one = JSON.stringify(snap(["x".repeat(200)]));
    const storage = memoryStorage({ quota: one.length * 2 + 40 });
    const store = createSnapshotStore(storage, "u3");
    store.write("agenda:w1", snap(["x".repeat(200)]));
    store.write("agenda:w2", snap(["x".repeat(200)]));
    store.write("agenda:w3", snap(["x".repeat(200)])); // no cabe: sale w1
    expect(store.read("agenda:w1")).toBeNull();
    expect(store.read("agenda:w3")).not.toBeNull();
  });

  it("un almacenamiento bloqueado o ausente NO lanza: simplemente no hay copia", () => {
    for (const storage of [memoryStorage({ blocked: true }), null]) {
      const store = createSnapshotStore(storage, "u3");
      expect(() => store.write("profile", snap({}))).not.toThrow();
      expect(store.read("profile")).toBeNull();
      expect(() => clearStoredData(storage)).not.toThrow();
      expect(() => writeStoredSession(storage, null)).not.toThrow();
      expect(readStoredSession(storage)).toBeNull();
    }
  });

  it("clearStoredData borra todo lo de la app (y nada de lo ajeno); con exceptUser conserva a ese usuario y su sesión", () => {
    const storage = memoryStorage();
    storage.setItem("otra-app:dato", "1");
    createSnapshotStore(storage, "u3").write("profile", snap({}));
    createSnapshotStore(storage, "u4").write("profile", snap({}));
    writeStoredSession(storage, { user: { id: "u3", email: "a@b.c", name: "A", role: "doctor", doctorId: "d1", active: true }, savedAt: "2026-11-10T15:00:00.000Z" });

    clearStoredData(storage, { exceptUser: "u3" });
    expect(createSnapshotStore(storage, "u3").read("profile")).not.toBeNull();
    expect(createSnapshotStore(storage, "u4").read("profile")).toBeNull();
    expect(readStoredSession(storage)?.user.id).toBe("u3");

    clearStoredData(storage);
    expect([...storage.data.keys()]).toEqual(["otra-app:dato"]);
  });
});

describe("avisos push (lado del cliente)", () => {
  const ok: PushEnv = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, ios: false, standalone: false, vapidKey: "BJPB" };

  it("detectPush explica por qué no: iPhone sin instalar, sin service worker, sin push, sin notificaciones, sin clave", () => {
    expect(detectPush(ok)).toEqual({ ok: true });
    // En Safari de iPhone no instalado ni existe PushManager: lo útil es decir «instala la app»
    expect(detectPush({ ...ok, ios: true, standalone: false, hasPushManager: false })).toEqual({ ok: false, reason: "ios-instalar" });
    expect(detectPush({ ...ok, ios: true, standalone: true })).toEqual({ ok: true });
    expect(detectPush({ ...ok, hasServiceWorker: false })).toEqual({ ok: false, reason: "sin-service-worker" });
    expect(detectPush({ ...ok, hasPushManager: false })).toEqual({ ok: false, reason: "sin-push" });
    expect(detectPush({ ...ok, hasNotification: false })).toEqual({ ok: false, reason: "sin-notificaciones" });
    expect(detectPush({ ...ok, vapidKey: undefined })).toEqual({ ok: false, reason: "sin-clave" });
  });

  it("isIos reconoce iPhone, iPad y el iPad que se anuncia como Mac", () => {
    expect(isIos("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "iPhone", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0)).toBe(false);
    expect(isIos("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", 0)).toBe(false);
    expect(isIos("Mozilla/5.0 (Linux; Android 14)", "Linux armv8l", 5)).toBe(false);
  });

  it("urlBase64ToUint8Array decodifica la clave VAPID (65 bytes, empieza con 0x04)", () => {
    const key = urlBase64ToUint8Array("BJPBstiuH1goUchCcdvJZClMwfFIjR_sZj7yhlBzL214Av_cdD0H0mJznxpQb9YR961XV-4Qccyqa8dbVjIY6y4");
    expect(key).toHaveLength(65);
    expect(key[0]).toBe(4);
  });

  it("parsePushPayload: JSON, texto plano y vacío; recorta y NO deja salir de la app", () => {
    expect(parsePushPayload(JSON.stringify({ title: "Cita nueva", body: "10:00 · Ana", url: "#/hoy", tag: "agenda" }))).toEqual({ title: "Cita nueva", body: "10:00 · Ana", url: "./#/hoy", tag: "agenda" });
    expect(parsePushPayload("Se canceló una cita")).toEqual({ title: "Mi agenda", body: "Se canceló una cita", url: "./" });
    expect(parsePushPayload(null)).toEqual({ title: "Mi agenda", body: "Tienes novedades en tu agenda.", url: "./" });
    expect(parsePushPayload("{}").title).toBe("Mi agenda");
    expect(parsePushPayload(JSON.stringify({ body: "x".repeat(1000) })).body).toHaveLength(300);
  });

  it("safeUrl solo acepta destinos dentro de la app", () => {
    expect(safeUrl("#/semana?dia=2026-11-12")).toBe("./#/semana?dia=2026-11-12");
    expect(safeUrl("./#/ausencias")).toBe("./#/ausencias");
    expect(safeUrl("https://malo.example/robo")).toBe("./");
    expect(safeUrl("//malo.example")).toBe("./");
    expect(safeUrl("javascript:alert(1)")).toBe("./");
    expect(safeUrl(42)).toBe("./");
  });
});
