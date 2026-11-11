import { useCallback, useMemo, useSyncExternalStore, type AnchorHTMLAttributes } from "react";

/**
 * Navegación por hash ("#/calendario?vista=semana"): no necesita que el servidor
 * reescriba rutas, y el mismo bundle sirve en "/" o en "/admin/". Los filtros del
 * calendario viajan en la propia dirección, así que se puede compartir o recargar.
 */

const EVENT = "clinica:route";

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}
const snapshot = () => window.location.hash;

export type Route = { path: string; query: URLSearchParams };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const q = raw.indexOf("?");
  const path = (q === -1 ? raw : raw.slice(0, q)) || "/";
  return { path: path.startsWith("/") ? path : `/${path}`, query: new URLSearchParams(q === -1 ? "" : raw.slice(q + 1)) };
}

export function hrefFor(path: string, params?: Record<string, string | null | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v) usp.set(k, v);
  const s = usp.toString();
  return `#${path}${s ? `?${s}` : ""}`;
}

export function navigate(path: string, params?: Record<string, string | null | undefined>, opts: { replace?: boolean } = {}) {
  const target = hrefFor(path, params);
  if (window.location.hash === target) return;
  if (opts.replace) {
    window.history.replaceState(null, "", target);
    window.dispatchEvent(new Event(EVENT));
  } else {
    window.location.hash = target;
  }
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => "");
  return useMemo(() => parseHash(hash), [hash]);
}

/** Cambia solo algunos parámetros de la consulta de la ruta actual (null los quita). */
export function useQueryState() {
  const route = useRoute();
  const set = useCallback(
    (changes: Record<string, string | null>, opts?: { replace?: boolean }) => {
      const next = parseHash(window.location.hash);
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) next.query.delete(k);
        else next.query.set(k, v);
      }
      navigate(next.path, Object.fromEntries(next.query), { replace: opts?.replace ?? true });
    },
    []
  );
  return [route.query, set] as const;
}

export function Link({ to, params, ...rest }: { to: string; params?: Record<string, string | null | undefined> } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return <a {...rest} href={hrefFor(to, params)} />;
}
