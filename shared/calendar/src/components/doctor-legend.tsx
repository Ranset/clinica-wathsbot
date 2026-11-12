import { colorOf } from "../lib/doctor-color";
import { cn } from "../lib/utils";

type LegendDoctor = { id: string; name: string; specialty?: string; color?: string | null };

/**
 * La leyenda de colores: cada doctor con su color. Con `onSelect` los nombres son botones que filtran por ese doctor
 * (otro clic en el mismo, o en «Todos», vuelve a mostrarlos a todos); sin el, es solo una referencia.
 */
export function DoctorLegend({
  doctors,
  selectedId = null,
  onSelect,
  className,
}: {
  doctors: LegendDoctor[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  className?: string;
}) {
  if (doctors.length === 0) return null;
  return (
    <ul aria-label="Colores por doctor" className={cn("m-0 flex list-none flex-wrap items-center gap-x-1 gap-y-1 p-0", className)}>
      {doctors.map((d) => {
        const color = colorOf(d) ?? "transparent";
        const dimmed = selectedId !== null && selectedId !== d.id;
        const body = (
          <>
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="truncate">{d.name}</span>
          </>
        );
        const look = cn("flex max-w-[15rem] items-center gap-1.5 rounded-full px-2 py-1 text-[12px] font-medium text-text-2", dimmed && "opacity-45");
        return (
          <li key={d.id} data-doctor={d.id}>
            {onSelect ? (
              <button
                type="button"
                title={d.specialty ? `${d.name} · ${d.specialty}` : d.name}
                aria-pressed={selectedId === d.id}
                onClick={() => onSelect(selectedId === d.id ? null : d.id)}
                className={cn(look, "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft", selectedId === d.id && "bg-accent font-semibold text-foreground")}
              >
                {body}
              </button>
            ) : (
              <span title={d.specialty ? `${d.name} · ${d.specialty}` : d.name} className={look}>
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
