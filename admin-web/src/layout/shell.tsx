import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, ChevronDown, Inbox, LogOut, Stethoscope, Users } from "lucide-react";
import { cn } from "@clinica/calendar";
import { isAbortError } from "@clinica/api-client";
import { useApi } from "../api-context";
import { useAuth } from "../auth";
import { ROLE_LABEL } from "../lib/fmt";
import { usePolling } from "../lib/use-polling";
import { NAV, canOpen } from "../permissions";
import { Link, useRoute } from "../router";
import { BotToggle } from "./bot-toggle";

const ICON = { "/calendario": CalendarDays, "/doctores": Stethoscope, "/atencion": Inbox, "/usuarios": Users } as const;

/** Cuántos casos esperan a una persona (la insignia de «Atención»). */
function useOpenCases(enabled: boolean): number | null {
  const api = useApi();
  const [count, setCount] = useState<number | null>(null);
  usePolling(
    useCallback(
      async (signal) => {
        try {
          setCount((await api.attention.list("open", { signal })).length);
        } catch (e) {
          if (!isAbortError(e)) setCount(null);
        }
      },
      [api]
    ),
    20_000,
    enabled
  );
  return count;
}

function Brand() {
  return (
    <a href="#/calendario" aria-label="Clínica CUBAMEX, ir al calendario" className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft">
      <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-brand-fg">
        <svg viewBox="0 0 32 32" className="h-5 w-5" fill="currentColor">
          <path d="M14 7h4v7h7v4h-7v7h-4v-7H7v-4h7z" />
        </svg>
      </span>
      <span className="hidden leading-tight sm:block">
        <span className="block text-[15px] font-bold tracking-tight">Clínica CUBAMEX</span>
        <span className="kicker hidden sm:block">Administración</span>
      </span>
    </a>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;
  const initial = user.name.trim().charAt(0).toUpperCase();
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Cuenta de ${user.name}`}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1.5 rounded-full border bg-background pl-1 pr-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
      >
        <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-tint text-[13px] font-bold text-brand-text">
          {initial}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-text-3" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-40 w-64 rounded-lg border bg-background p-1 shadow-lg">
          <div className="border-b px-3 py-2">
            <p className="truncate text-sm font-semibold">{user.name}</p>
            <p className="truncate text-xs text-text-3">{user.email}</p>
            <p className="mt-0.5 text-xs font-medium text-brand-text">{ROLE_LABEL[user.role]}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => void logout()}
            className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, permissions } = useAuth();
  const route = useRoute();
  const items = NAV.filter((n) => canOpen(user?.role, n.path));
  const open = useOpenCases(permissions.handleAttention);

  return (
    <div className="flex h-dvh flex-col bg-subtle">
      <header className="flex items-center gap-3 border-b bg-background px-3 py-2 sm:px-5">
        <Brand />
        {/* Un solo <nav>: en el celular es la barra de abajo; en escritorio, las pestañas del encabezado. */}
        <nav
          aria-label="Secciones"
          className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background pb-[env(safe-area-inset-bottom)] sm:static sm:z-auto sm:ml-4 sm:gap-1 sm:border-0 sm:bg-transparent sm:pb-0"
        >
          {items.map((n) => {
            const Icon = ICON[n.path as keyof typeof ICON];
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
                <span className="relative">
                  <Icon className="h-5 w-5 sm:h-4 sm:w-4" aria-hidden />
                  {n.path === "/atencion" && open !== null && open > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 rounded-full bg-danger px-1 text-[10px] font-bold leading-4 text-white sm:hidden" aria-label={`${open} casos abiertos`}>
                      {open}
                    </span>
                  )}
                </span>
                {n.label}
                {n.path === "/atencion" && open !== null && open > 0 && (
                  <span aria-hidden className="hidden rounded-full bg-danger px-1.5 text-[11px] font-bold leading-[18px] text-white sm:inline">
                    {open}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <BotToggle />
          <UserMenu />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-auto pb-14 sm:pb-0">{children}</main>
    </div>
  );
}
