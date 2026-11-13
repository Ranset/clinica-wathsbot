import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { imageDataUrl } from "@clinica/api-client";
import { cn } from "@clinica/calendar";
import { useApi } from "./api-context";

/**
 * La marca de la clínica: su nombre y su logotipo (los cambia el administrador en «Clínica»). Se lee ANTES de iniciar sesión
 * (`GET /api/branding` es público) para que el login ya la muestre. Si no se puede leer (sin conexión, o un servidor que aún no
 * la tiene), queda la marca por defecto: nunca bloquea la pantalla.
 */

export const DEFAULT_CLINIC_NAME = "Clínica CUBAMEX";

type Brand = {
  name: string;
  /** El logotipo como dirección de datos (`data:image/png;base64,...`), o `null`: se usa el icono por defecto. */
  logo: string | null;
  /** Vuelve a leer la marca (tras guardar un cambio). */
  reload: () => Promise<void>;
};

const BrandContext = createContext<Brand>({ name: DEFAULT_CLINIC_NAME, logo: null, reload: async () => undefined });

export function BrandProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [state, setState] = useState<{ name: string; logo: string | null }>({ name: DEFAULT_CLINIC_NAME, logo: null });
  // la imagen solo se baja si cambió su dirección (lleva la huella: `?v=`)
  const loaded = useRef<{ url: string | null; logo: string | null }>({ url: null, logo: null });

  const reload = useCallback(async () => {
    try {
      const b = await api.branding.get();
      let logo: string | null = null;
      if (b.logoUrl) {
        if (loaded.current.url === b.logoUrl) logo = loaded.current.logo;
        else {
          const img = await api.branding.logo(b.logoUrl);
          logo = img ? imageDataUrl(img.bytes, img.contentType) : null;
        }
      }
      loaded.current = { url: b.logoUrl, logo };
      setState({ name: b.name, logo });
    } catch {
      /* se queda la última marca que se pudo leer (o la de por defecto) */
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    document.title = `${state.name} · Administración`;
  }, [state.name]);

  const value = useMemo(() => ({ ...state, reload }), [state, reload]);
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export const useBrand = () => useContext(BrandContext);

/**
 * El logotipo de la clínica en un cuadro (o el icono por defecto, la cruz, si no hay). Decorativo: el nombre va al lado como texto.
 * `logo` permite mostrar uno que aún no se guardó (la vista previa).
 */
export function BrandMark({ className, logo, iconClassName }: { className?: string; logo?: string | null; iconClassName?: string }) {
  const brand = useBrand();
  const src = logo === undefined ? brand.logo : logo;
  if (src) {
    return <img src={src} alt="" aria-hidden data-brand-logo="" className={cn("shrink-0 rounded-lg bg-background object-cover", className)} />;
  }
  return (
    <span aria-hidden data-brand-default="" className={cn("flex shrink-0 items-center justify-center rounded-lg bg-brand text-brand-fg", className)}>
      <svg viewBox="0 0 32 32" className={cn("h-3/5 w-3/5", iconClassName)} fill="currentColor">
        <path d="M14 7h4v7h7v4h-7v7h-4v-7H7v-4h7z" />
      </svg>
    </span>
  );
}
