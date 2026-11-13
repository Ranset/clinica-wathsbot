import { useState } from "react";
import { Link2 } from "lucide-react";
import type { Doctor } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { copyText } from "../../lib/clipboard";
import { messageFor } from "../../lib/errors";
import { passwordLinkMessage } from "../../lib/password-link";
import { useToast } from "../../toast";
import { BusyButton, FormError } from "../../ui/controls";

/**
 * El acceso del doctor a su app. Su cuenta se creó sola al darlo de alta, SIN contraseña: este botón genera el enlace con el que la crea
 * (la primera vez) o pone una nueva (si olvidó la suya) y COPIA al portapapeles un mensaje corto, con su nombre, su código y el enlace,
 * para mandarlo por WhatsApp o por donde prefiera el personal. El enlace se usa una sola vez, vale 3 días y reemplaza al anterior.
 */
export function PasswordLinkSection({ doctor }: { doctor: Doctor }) {
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; copied: boolean } | null>(null);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const link = await api.doctors.createPasswordLink(doctor.id);
      const text = passwordLinkMessage(doctor, link);
      const copied = await copyText(text);
      setResult({ text, copied });
      toast.show(copied ? "Mensaje copiado. Pégalo en WhatsApp o donde prefieras." : "Enlace generado. No se pudo copiar solo: cópialo del recuadro.");
    } catch (e) {
      setResult(null);
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="password-link-h" className="rounded-lg border p-4">
      <h3 id="password-link-h" className="text-sm font-bold">
        Acceso del doctor a su app
      </h3>
      <p className="mt-1 text-sm text-text-2">
        El doctor entra con su código y su contraseña. Genera un enlace para que la <strong>cree por primera vez</strong> o para que ponga una{" "}
        <strong>nueva si olvidó la suya</strong>. Se copia un mensaje listo para enviarlo por WhatsApp o por donde prefieras. El enlace se usa una sola vez, vale 3 días y
        reemplaza al anterior.
      </p>
      <BusyButton variant="outline" className="mt-3" busy={busy} onClick={() => void generate()}>
        <Link2 className="h-4 w-4" aria-hidden />
        Generar enlace y copiar
      </BusyButton>
      <FormError>{error}</FormError>
      {result && (
        <div className="mt-3 flex flex-col gap-1.5">
          <p role="status" className={result.copied ? "text-sm font-semibold text-success-text" : "text-sm font-semibold text-warning-text"}>
            {result.copied ? "Copiado al portapapeles. Pégalo en el mensaje." : "No se pudo copiar solo: selecciona el texto de abajo y cópialo."}
          </p>
          <textarea
            readOnly
            rows={4}
            value={result.text}
            aria-label="Mensaje para el doctor"
            onFocus={(e) => e.currentTarget.select()}
            className="w-full resize-none rounded-md border border-input bg-subtle px-2.5 py-2 font-mono text-xs text-text-2 focus-visible:border-brand focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-soft"
          />
        </div>
      )}
    </section>
  );
}
