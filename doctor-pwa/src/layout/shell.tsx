import type { ReactNode } from "react";
import { CalendarCheck, CalendarDays, CalendarOff, CloudOff, Clock, UserRound } from "lucide-react";
import { cn } from "@clinica/calendar";
import { useConnection } from "../lib/connection";
import { Link, useRoute } from "../router";
import { StatusBanners } from "./status";

export const NAV = [
  { path: "/hoy", label: "Hoy", icon: CalendarCheck },
  { path: "/semana", label: "Semana", icon: CalendarDays },
  { path: "/ausencias", label: "Ausencias", icon: CalendarOff },
  { path: "/horario", label: "Horario", icon: Clock },
  { path: "/cuenta", label: "Cuenta", icon: UserRound },
] as const;

function Brand() {
  return (
    <a href="#/hoy" aria-label="Clínica CUBAMEX, ir a Hoy" className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft">
      <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-brand-fg">
        <svg viewBox="0 0 32 32" className="h-5 w-5" fill="currentColor">
          <path d="M14 7h4v7h7v4h-7v7h-4v-7H7v-4h7z" />
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block text-[15px] font-bold tracking-tight">Mi agenda</span>
        <span className="kicker block">Clínica CUBAMEX</span>
      </span>
    </a>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const { online } = useConnection();

  return (
    <div className="flex h-dvh flex-col bg-subtle">
      <header className="flex items-center gap-3 border-b bg-background px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] sm:px-5">
        <Brand />
        {/* Un solo <nav>: en el celular es la barra de abajo; en escritorio, las pestañas del encabezado. */}
        <nav
          aria-label="Secciones"
          className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background pb-[env(safe-area-inset-bottom)] sm:static sm:z-auto sm:ml-4 sm:gap-1 sm:border-0 sm:bg-transparent sm:pb-0"
        >
          {NAV.map((n) => {
            const Icon = n.icon;
            const current = route.path === n.path;
            return (
              <Link
                key={n.path}
                to={n.path}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft sm:h-9 sm:flex-none sm:flex-row sm:gap-1.5 sm:rounded-full sm:px-3.5 sm:py-0 sm:text-[13px]",
                  current ? "text-brand-text sm:bg-brand-tint" : "text-text-2 hover:text-foreground sm:hover:bg-accent"
                )}
              >
                <Icon className="h-5 w-5 sm:h-4 sm:w-4" aria-hidden />
                {n.label}
              </Link>
            );
          })}
        </nav>
        {!online && (
          <span className="ml-auto flex items-center gap-1.5 rounded-full bg-warning-tint px-2.5 py-1 text-xs font-semibold text-warning-text" data-testid="offline-pill">
            <CloudOff className="h-3.5 w-3.5" aria-hidden />
            Sin conexión
          </span>
        )}
      </header>
      <StatusBanners />
      <main className="flex min-h-0 flex-1 flex-col overflow-auto pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0">{children}</main>
    </div>
  );
}
