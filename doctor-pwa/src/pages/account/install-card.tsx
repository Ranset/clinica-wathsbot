import { useState } from "react";
import { Download, Smartphone } from "lucide-react";
import { Button } from "@clinica/calendar";
import { useInstall } from "../../pwa/install";
import { Notice } from "../../ui/controls";

/** Instalar la app en la pantalla de inicio: botón donde el navegador lo ofrece, instrucciones donde no (iPhone). */
export function InstallCard() {
  const install = useInstall();
  const [declined, setDeclined] = useState(false);

  return (
    <section aria-label="Instalar la app" className="flex flex-col gap-3 rounded-lg border bg-background p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-tint text-brand-text">
          <Smartphone className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold">Instalar la app</h2>
          <p className="text-xs text-text-3">Ábrela desde la pantalla de inicio, a pantalla completa y sin barra del navegador. La agenda guardada se puede leer aunque no haya internet.</p>
        </div>
      </div>

      {install.standalone ? (
        <Notice tone="ok">La app ya está instalada en este dispositivo.</Notice>
      ) : install.canPrompt ? (
        <div>
          <Button
            onClick={() =>
              void install.prompt().then((r) => {
                if (r === "dismissed") setDeclined(true);
              })
            }
          >
            <Download className="h-4 w-4" aria-hidden />
            Instalar la app
          </Button>
        </div>
      ) : install.ios ? (
        <Notice>
          En iPhone o iPad: abre esta página en <strong>Safari</strong>, toca <strong>Compartir</strong> y elige <strong>«Añadir a pantalla de inicio»</strong>.
        </Notice>
      ) : (
        <Notice>Usa el menú del navegador y elige «Instalar app» (o «Añadir a la pantalla de inicio»). Si no aparece, es posible que este navegador no permita instalarla.</Notice>
      )}
      {declined && <p className="text-xs text-text-3">Puedes instalarla cuando quieras desde aquí o desde el menú del navegador.</p>}
    </section>
  );
}
