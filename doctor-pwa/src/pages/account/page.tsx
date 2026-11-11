import { useState } from "react";
import { LogOut } from "lucide-react";
import { useAuth, useUser } from "../../auth";
import { useProfile } from "../../profile";
import { BusyButton } from "../../ui/controls";
import { InstallCard } from "./install-card";
import { PushCard } from "./push-card";

/** Cuenta: quién soy, avisos de este dispositivo, instalar la app y cerrar sesión. */
export function AccountPage() {
  const user = useUser();
  const { logout } = useAuth();
  const { doctor } = useProfile();
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4 sm:py-6">
      <h1 className="text-lg font-bold tracking-tight">Mi cuenta</h1>

      <section aria-label="Datos de la cuenta" className="flex items-center gap-3 rounded-lg border bg-background p-4">
        <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-tint text-lg font-bold text-brand-text">
          {user.name.trim().charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{doctor?.name ?? user.name}</p>
          {doctor && <p className="truncate text-xs text-text-2">{doctor.specialty}</p>}
          <p className="truncate text-xs text-text-3">{user.email}</p>
        </div>
      </section>

      <PushCard />
      <InstallCard />

      <section aria-label="Sesión" className="flex flex-col gap-2 rounded-lg border bg-background p-4">
        <h2 className="text-sm font-bold">Sesión</h2>
        <p className="text-xs text-text-3">Al cerrar sesión se borra la agenda guardada en este dispositivo y se desactivan sus avisos.</p>
        <div>
          <BusyButton
            variant="outline"
            busy={busy}
            onClick={() => {
              setBusy(true);
              void logout();
            }}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Cerrar sesión
          </BusyButton>
        </div>
      </section>
    </div>
  );
}
