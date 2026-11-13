import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { imageDataUrl } from "@clinica/api-client";
import { cn } from "@clinica/calendar";
import { useApi } from "./api-context";

/**
 * La marca de la clínica: su nombre y su logotipo (los cambia el administrador en la web, en «Clínica»). Se lee ANTES de iniciar
 * sesión (`GET /api/branding` es público) para que el login ya la muestre. Es la marca de la clínica, no datos del doctor ni de
 * pacientes: por eso la última que se leyó se guarda en el dispositivo (clave propia, que NO se borra al cerrar sesión) y la app
 * abre con ella aunque no haya conexión. Si nunca se pudo leer, queda la marca por defecto: jamás bloquea la pantalla.
 */

export const DEFAULT_CLINIC_NAME = "Clínica CUBAMEX";
export const BRAND_CACHE_KEY = "clinica-brand:v1";

type Cached = { name: string; logoUrl: string | null; logo: string | null };
type Brand = { name: string; logo: string | null };

function readCache(): Cached | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(BRAND_CACHE_KEY) ?? "null") as Partial<Cached> | null;
    if (v && typeof v.name === "string" && v.name.trim()) {
      return { name: v.name, logoUrl: typeof v.logoUrl === "string" ? v.logoUrl : null, logo: typeof v.logo === "string" && v.logo.startsWith("data:image/") ? v.logo : null };
    }
  } catch {
    /* almacenamiento bloqueado o dañado: sin copia */
  }
  return null;
}

function writeCache(c: Cached) {
  try {
    window.localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* sin espacio o bloqueado: no pasa nada */
  }
}

const BrandContext = createContext<Brand>({ name: DEFAULT_CLINIC_NAME, logo: null });

export function BrandProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [initial] = useState(readCache);
  const [state, setState] = useState<Brand>({ name: initial?.name ?? DEFAULT_CLINIC_NAME, logo: initial?.logo ?? null });
  const known = useRef<Cached | null>(initial);

  const load = useCallback(async () => {
    try {
      const b = await api.branding.get();
      let logo: string | null = null;
      if (b.logoUrl) {
        // la imagen solo se baja si cambió su dirección (lleva la huella: `?v=`)
        if (known.current?.logoUrl === b.logoUrl && known.current.logo) logo = known.current.logo;
        else {
          const img = await api.branding.logo(b.logoUrl);
          logo = img ? imageDataUrl(img.bytes, img.contentType) : null;
        }
      }
      known.current = { name: b.name, logoUrl: b.logoUrl, logo };
      writeCache(known.current);
      setState({ name: b.name, logo });
    } catch {
      /* sin conexión (o un servidor sin actualizar): se queda la marca que ya se tenía */
    }
  }, [api]);

  useEffect(() => {
    void load();
    // al volver a la app (o la red) se confirma por si el administrador la cambió
    const wake = () => document.visibilityState !== "hidden" && void load();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [load]);

  useEffect(() => {
    document.title = `Mi agenda · ${state.name}`;
  }, [state.name]);

  const value = useMemo(() => state, [state]);
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export const useBrand = () => useContext(BrandContext);

/** El logotipo de la clínica en un cuadro (o el icono por defecto, la cruz). Decorativo: el nombre va al lado como texto. */
export function BrandMark({ className }: { className?: string }) {
  const { logo } = useBrand();
  if (logo) return <img src={logo} alt="" aria-hidden data-brand-logo="" className={cn("shrink-0 rounded-lg bg-background object-cover", className)} />;
  return (
    <span aria-hidden data-brand-default="" className={cn("flex shrink-0 items-center justify-center rounded-lg bg-brand text-brand-fg", className)}>
      <svg viewBox="0 0 32 32" className="h-3/5 w-3/5" fill="currentColor">
        <path d="M14 7h4v7h7v4h-7v7h-4v-7H7v-4h7z" />
      </svg>
    </span>
  );
}
