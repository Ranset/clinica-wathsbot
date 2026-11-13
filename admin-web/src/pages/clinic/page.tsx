import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button } from "@clinica/calendar";
import { LOGO_MAX_BYTES, LOGO_MAX_SIDE, LOGO_MIN_SIDE, checkLogo, imageDataUrl, readBytes } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { BrandMark, useBrand } from "../../brand";
import { messageFor } from "../../lib/errors";
import { useToast } from "../../toast";
import { BusyButton, Field, FormError, Notice, TextInput, dangerButton } from "../../ui/controls";
import { Modal } from "../../ui/modal";

const NAME_MAX = 80;

/** Un logotipo ya elegido y revisado, listo para guardarse (la vista previa sale de él). */
type Pending = { bytes: Uint8Array; contentType: string; preview: string; fileName: string; size: number };

/**
 * «Clínica» (solo administrador): personalizar el nombre y el logotipo de la clínica. Salen en el encabezado de esta web, en el
 * inicio de sesión y en la app del doctor. El logotipo es una imagen CUADRADA (1:1) PNG, JPG o WebP, de 64 a 2048 px y de hasta
 * 1 MB: aquí se avisa antes de subirla y el servidor vuelve a revisarla.
 */
export function ClinicPage() {
  const api = useApi();
  const toast = useToast();
  const brand = useBrand();
  const picker = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(brand.name);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);

  // el nombre guardado llega (o cambia) desde el servidor: el campo lo sigue mientras nadie lo esté editando
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setName(brand.name);
  }, [brand.name, dirty]);

  const cleaned = name.split(/\s+/).filter(Boolean).join(" ");
  const nameChanged = cleaned !== brand.name;

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (nameBusy) return;
    if (!cleaned) return setNameError("Escribe el nombre de la clínica.");
    if (cleaned.length > NAME_MAX) return setNameError(`El nombre admite hasta ${NAME_MAX} caracteres.`);
    setNameBusy(true);
    setNameError(null);
    try {
      await api.branding.setName(cleaned);
      await brand.reload();
      setDirty(false);
      toast.show("Nombre guardado.");
    } catch (err) {
      setNameError(messageFor(err));
    } finally {
      setNameBusy(false);
    }
  };

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // para poder elegir otra vez el mismo archivo
    if (!file) return;
    setFileError(null);
    setPending(null);
    if (file.size > LOGO_MAX_BYTES) return setFileError("La imagen pesa más de 1 MB.");
    try {
      const bytes = await readBytes(file);
      const check = checkLogo(bytes);
      if (!check.ok) return setFileError(check.message);
      setPending({ bytes, contentType: check.info.contentType, preview: imageDataUrl(bytes, check.info.contentType), fileName: file.name, size: bytes.length });
    } catch {
      setFileError("No se pudo leer el archivo. Elige otra imagen.");
    }
  };

  const saveLogo = async () => {
    if (!pending || logoBusy) return;
    setLogoBusy(true);
    setFileError(null);
    try {
      await api.branding.uploadLogo(pending.bytes, pending.contentType);
      await brand.reload();
      setPending(null);
      toast.show("Logotipo guardado.");
    } catch (err) {
      setFileError(messageFor(err));
    } finally {
      setLogoBusy(false);
    }
  };

  const removeLogo = async () => {
    if (removeBusy) return;
    setRemoveBusy(true);
    try {
      await api.branding.removeLogo();
      await brand.reload();
      setRemoving(false);
      setPending(null);
      toast.show("Logotipo quitado: se usa el icono por defecto.");
    } catch (err) {
      setRemoving(false);
      toast.show(messageFor(err), "error");
    } finally {
      setRemoveBusy(false);
    }
  };

  const shownName = cleaned || brand.name;
  const kb = (n: number) => (n < 1024 * 10 ? `${(n / 1024).toFixed(1)} KB` : `${Math.round(n / 1024)} KB`);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight">Clínica</h1>
        <p className="mt-1 text-sm text-text-3">Personaliza cómo se ve la clínica: el nombre y el logotipo salen en esta web, en el inicio de sesión y en la app del doctor.</p>
      </header>

      <section aria-labelledby="clinic-name-h" className="rounded-xl border bg-background p-4">
        <h2 id="clinic-name-h" className="text-sm font-bold">
          Nombre de la clínica
        </h2>
        <form onSubmit={saveName} noValidate aria-label="Nombre de la clínica" className="mt-3 flex flex-col gap-3">
          <Field label="Nombre" hint={`Hasta ${NAME_MAX} caracteres.`} error={nameError}>
            <TextInput
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
                setNameError(null);
              }}
            />
          </Field>
          <div>
            <BusyButton type="submit" busy={nameBusy} disabled={!nameChanged || !cleaned}>
              Guardar nombre
            </BusyButton>
          </div>
        </form>
      </section>

      <section aria-labelledby="clinic-logo-h" className="rounded-xl border bg-background p-4">
        <h2 id="clinic-logo-h" className="text-sm font-bold">
          Logotipo
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <BrandMark className="h-24 w-24 rounded-2xl border" logo={pending ? pending.preview : undefined} iconClassName="h-3/5 w-3/5" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {pending ? (
              <p className="text-sm">
                <span className="font-semibold">Vista previa</span> · {pending.fileName} ({kb(pending.size)}). Aún no se guardó.
              </p>
            ) : (
              <p className="text-sm text-text-2">{brand.logo ? "Este es el logotipo actual." : "Todavía no hay logotipo: se usa el icono por defecto."}</p>
            )}
            <p className="text-xs text-text-3">
              PNG, JPG o WebP · <strong className="font-semibold text-text-2">cuadrada (1:1)</strong> · de {LOGO_MIN_SIDE} a {LOGO_MAX_SIDE} px por lado · hasta 1 MB.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Archivo del logotipo" className="sr-only" onChange={(e) => void pick(e)} />
              <Button variant="outline" size="sm" onClick={() => picker.current?.click()}>
                <ImagePlus className="h-4 w-4" aria-hidden />
                {pending || brand.logo ? "Elegir otra imagen…" : "Elegir imagen…"}
              </Button>
              {pending && (
                <>
                  <BusyButton size="sm" busy={logoBusy} onClick={() => void saveLogo()}>
                    Guardar logotipo
                  </BusyButton>
                  <Button variant="ghost" size="sm" onClick={() => { setPending(null); setFileError(null); }}>
                    Cancelar
                  </Button>
                </>
              )}
              {!pending && brand.logo && (
                <Button variant="ghost" size="sm" className="text-danger-text" onClick={() => setRemoving(true)}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                  Quitar logotipo
                </Button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3">
          <FormError>{fileError}</FormError>
        </div>
      </section>

      <section aria-labelledby="clinic-preview-h" className="rounded-xl border bg-background p-4">
        <h2 id="clinic-preview-h" className="text-sm font-bold">
          Así se verá
        </h2>
        <div data-testid="brand-preview" className="mt-3 flex items-center gap-2.5 rounded-lg border bg-subtle px-3 py-2">
          <BrandMark className="h-8 w-8" logo={pending ? pending.preview : undefined} />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[15px] font-bold tracking-tight">{shownName}</span>
            <span className="kicker block">Administración</span>
          </span>
        </div>
        {(pending || nameChanged) && <Notice className="mt-3 text-xs">Es una vista previa: los cambios se aplican al guardarlos.</Notice>}
      </section>

      {removing && (
        <Modal
          title="¿Quitar el logotipo?"
          onClose={() => setRemoving(false)}
          initialFocus="panel"
          footer={
            <>
              <Button variant="outline" onClick={() => setRemoving(false)}>
                Cancelar
              </Button>
              <BusyButton className={dangerButton} busy={removeBusy} onClick={() => void removeLogo()}>
                Quitar logotipo
              </BusyButton>
            </>
          }
        >
          <p className="text-sm">Se vuelve a usar el icono por defecto en esta web, en el inicio de sesión y en la app del doctor. El nombre no cambia.</p>
        </Modal>
      )}
    </div>
  );
}
