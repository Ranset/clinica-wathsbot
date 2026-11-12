/**
 * Lo que la app guarda en el dispositivo para poder abrirse SIN conexión (solo lectura):
 * la última agenda, el horario, las ausencias y las solicitudes que llegaron del servidor,
 * y quién entró (para abrir la app sin red). Contiene nombres de pacientes, así que:
 *  - solo se escribe en `localStorage` de este origen, con un prefijo propio;
 *  - todo se borra al cerrar sesión (y al entrar otro usuario se borra lo del anterior);
 *  - cada dato lleva el id del usuario: una sesión nunca lee lo de otra.
 * Un almacenamiento bloqueado, lleno o ausente NO rompe la app: simplemente no hay copia.
 */

import type { User } from "@clinica/api-client";

export const PREFIX = "clinica-doctor:v1:";
const SESSION_KEY = `${PREFIX}session`;
/** Copias `agenda:*` que se conservan por usuario (lo más reciente): cada semana guarda dos, sus citas y sus eventos personales. */
export const MAX_AGENDA_ENTRIES = 16;

export type Snapshot<T> = {
  /** Cuándo el servidor confirmó por última vez que esto era lo vigente (ISO UTC). */
  savedAt: string;
  data: T;
  /** El ETag con el que llegó `data` (solo la agenda); va junto con los datos, nunca suelto. */
  etag?: string | null;
};

export function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // almacenamiento bloqueado (modo privado, política del navegador…)
  }
}

function parse(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isSnapshot(v: unknown): v is Snapshot<unknown> {
  return !!v && typeof v === "object" && typeof (v as Snapshot<unknown>).savedAt === "string" && "data" in (v as object) && !Number.isNaN(Date.parse((v as Snapshot<unknown>).savedAt));
}

export type SnapshotStore = {
  read<T>(key: string): Snapshot<T> | null;
  write<T>(key: string, snapshot: Snapshot<T>): void;
};

/** Copias de lectura de UN usuario. `agenda:*` es un caché con tope (se descarta lo más viejo). */
export function createSnapshotStore(storage: Storage | null, userId: string): SnapshotStore {
  const base = `${PREFIX}${userId}:`;
  const indexKey = `${base}agenda-index`;

  const readIndex = (): string[] => {
    const v = parse(storage?.getItem(indexKey) ?? null);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  };
  const drop = (key: string) => {
    try {
      storage?.removeItem(base + key);
    } catch {
      /* nada que hacer */
    }
  };

  return {
    read<T>(key: string): Snapshot<T> | null {
      if (!storage) return null;
      try {
        const v = parse(storage.getItem(base + key));
        return isSnapshot(v) ? (v as Snapshot<T>) : null;
      } catch {
        return null;
      }
    },

    write<T>(key: string, snapshot: Snapshot<T>) {
      if (!storage) return;
      const put = () => storage.setItem(base + key, JSON.stringify(snapshot));
      try {
        try {
          put();
        } catch {
          // Lleno: se suelta lo más viejo de la agenda y se reintenta una vez.
          const idx = readIndex();
          const oldest = idx.find((k) => k !== key);
          if (!oldest) return;
          drop(oldest);
          storage.setItem(indexKey, JSON.stringify(idx.filter((k) => k !== oldest)));
          put();
        }
        if (key.startsWith("agenda:")) {
          // El orden del índice es del más viejo al más reciente.
          const idx = readIndex().filter((k) => k !== key);
          idx.push(key);
          while (idx.length > MAX_AGENDA_ENTRIES) drop(idx.shift()!);
          storage.setItem(indexKey, JSON.stringify(idx));
        }
      } catch {
        /* sin espacio o bloqueado: no hay copia, y no pasa nada */
      }
    },
  };
}

/** Borra TODO lo de esta app en el dispositivo (o todo menos lo de `exceptUser`). */
export function clearStoredData(storage: Storage | null, opts: { exceptUser?: string } = {}) {
  if (!storage) return;
  try {
    const keep = opts.exceptUser ? `${PREFIX}${opts.exceptUser}:` : null;
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(PREFIX) && !(keep && k.startsWith(keep)) && !(keep && k === SESSION_KEY)) doomed.push(k);
    }
    for (const k of doomed) storage.removeItem(k);
  } catch {
    /* nada que hacer */
  }
}

/** Quién entró por última vez en este dispositivo: lo que permite abrir la app sin conexión. */
export type StoredSession = { user: User; savedAt: string };

export function readStoredSession(storage: Storage | null): StoredSession | null {
  if (!storage) return null;
  try {
    const v = parse(storage.getItem(SESSION_KEY)) as StoredSession | null;
    return v && typeof v === "object" && v.user && typeof v.user.id === "string" && typeof v.user.role === "string" ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredSession(storage: Storage | null, session: StoredSession | null) {
  if (!storage) return;
  try {
    if (session) storage.setItem(SESSION_KEY, JSON.stringify(session));
    else storage.removeItem(SESSION_KEY);
  } catch {
    /* nada que hacer */
  }
}
