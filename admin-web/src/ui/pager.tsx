import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@clinica/calendar";

/** Cuántos elementos se muestran por página en las listas largas. */
export const PAGE_SIZE = 10;

/** Cuántas páginas hacen falta para `total` elementos (siempre al menos una). */
export const pageCountOf = (total: number, pageSize = PAGE_SIZE): number => (Number.isFinite(total) ? Math.max(1, Math.ceil(total / pageSize)) : 1);

/**
 * Paginación sencilla de una lista que ya está en memoria: «Mostrando 11–20 de 47», Anterior / Siguiente y «Página 2 de 5».
 * No se pinta si todo cabe en una página. `page` va de 1 a `pageCountOf(total)`.
 */
export function Pager({
  page,
  total,
  pageSize = PAGE_SIZE,
  onPage,
  label,
}: {
  page: number;
  total: number;
  pageSize?: number;
  onPage: (page: number) => void;
  /** Qué se está paginando, para el lector de pantalla («Paginación de casos atendidos»). */
  label: string;
}) {
  const pages = pageCountOf(total, pageSize);
  if (!Number.isFinite(total) || total <= pageSize) return null;   // sin un total válido no se pinta (nunca «NaN»)
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-1">
      <p className="text-xs text-text-3">
        Mostrando {from}–{to} de {total}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Anterior
        </Button>
        <span className="text-xs font-semibold text-text-2" aria-live="polite">
          Página {page} de {pages}
        </span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Siguiente
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
