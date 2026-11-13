import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { freezeClock, mountApp } from "./helpers";
import { gif, jpeg, padTo, png, svg, webpLossless } from "../../shared/api-client/test/images";

beforeEach(freezeClock);

/** Cada prueba cierra comprobando que ninguna peticion/respuesta salio del contrato. */
let violations: string[] = [];
afterEach(() => {
  expect(violations).toEqual([]);
  violations = [];
});

const file = (bytes: Uint8Array, name = "logo.png", type = "image/png") => new File([bytes as BlobPart], name, { type });
const logoOf = (el: ParentNode = document) => Array.from(el.querySelectorAll<HTMLImageElement>("img[data-brand-logo]"));
const defaultIcons = (el: ParentNode = document) => Array.from(el.querySelectorAll<HTMLElement>("[data-brand-default]"));
/** El encabezado de la web (el primer <header>: el de la pantalla va dentro de <main>). */
const shellHeader = () => document.querySelector<HTMLElement>("header")!;

/** Entra a «Clínica» como administrador y devuelve la pantalla ya cargada. */
async function openClinic(opts: Parameters<typeof mountApp>[0] = {}) {
  const m = await mountApp({ as: "admin", hash: "#/clinica", ...opts });
  violations = m.violations;
  await screen.findByRole("heading", { name: "Clínica", level: 1 });
  return m;
}

describe("marca de la clínica: quién ve la opción", () => {
  it("el administrador ve «Clínica» en el menú y puede entrar; el personal no (ni escribiendo la dirección)", async () => {
    const admin = await mountApp({ as: "admin" });
    violations = admin.violations;
    const nav = await screen.findByRole("navigation", { name: "Secciones" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent?.replace(/\d+$/, ""))).toEqual(["Calendario", "Doctores", "Atención", "Usuarios", "Clínica"]);
    await admin.user.click(within(nav).getByRole("link", { name: "Clínica" }));
    expect(await screen.findByRole("heading", { name: "Clínica", level: 1 })).toBeInTheDocument();
    admin.unmount();

    const staff = await mountApp({ as: "staff", hash: "#/clinica" });
    violations = [...violations, ...staff.violations];
    expect(await screen.findByText("Esta sección no está disponible para tu rol")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Clínica", level: 1 })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Secciones" })).queryByRole("link", { name: "Clínica" })).toBeNull();
  });
});

describe("marca de la clínica: cómo se ve", () => {
  it("por defecto: el icono (la cruz) y «Clínica CUBAMEX», en el inicio de sesión y en el encabezado", async () => {
    const anon = await mountApp({ as: null });
    violations = anon.violations;
    expect(await screen.findByRole("heading", { level: 1, name: "Clínica CUBAMEX" })).toBeInTheDocument();
    expect(defaultIcons()).toHaveLength(1);
    expect(logoOf()).toHaveLength(0);
    anon.unmount();

    const staff = await mountApp({ as: "staff" });
    violations = [...violations, ...staff.violations];
    expect(await screen.findByRole("link", { name: "Clínica CUBAMEX, ir al calendario" })).toBeInTheDocument();
    expect(document.title).toBe("Clínica CUBAMEX · Administración");
  });

  it("con un nombre y un logotipo guardados, el inicio de sesión (sin iniciar sesión) ya los muestra", async () => {
    const { mock, ...m } = await mountApp({
      as: null,
      prepare: (mock) => {
        mock.db.branding.name = "Clínica Santa María";
        mock.db.branding.logo = { contentType: "image/png", bytes: png(128), hash: "abc12345" };
      },
    });
    violations = m.violations;
    expect(await screen.findByRole("heading", { level: 1, name: "Clínica Santa María" })).toBeInTheDocument();
    await waitFor(() => expect(logoOf()).toHaveLength(1));
    expect(logoOf()[0]!.src).toMatch(/^data:image\/png;base64,/);
    expect(defaultIcons()).toHaveLength(0);
    expect(document.title).toBe("Clínica Santa María · Administración");
  });

  it("si la marca no se puede leer (servidor sin actualizar o sin red) la pantalla sigue con la marca por defecto", async () => {
    const m = await mountApp({
      as: "staff",
      prepare: (mock) => {
        const original = mock.fetch;
        mock.fetch = (input, init) => (String(input).includes("/api/branding") ? Promise.reject(new TypeError("Failed to fetch")) : original(input, init));
      },
    });
    violations = m.violations;
    expect(await screen.findByRole("link", { name: "Clínica CUBAMEX, ir al calendario" })).toBeInTheDocument();
    expect(defaultIcons().length).toBeGreaterThan(0);
  });
});

describe("clínica: el nombre", () => {
  it("se cambia, se normaliza, y se ve en el encabezado y en la pestaña; con el campo sin tocar no hay nada que guardar", async () => {
    const { user, mock } = await openClinic();
    const form = screen.getByRole("form", { name: "Nombre de la clínica" });
    const guardar = within(form).getByRole("button", { name: "Guardar nombre" });
    expect(within(form).getByLabelText("Nombre")).toHaveValue("Clínica CUBAMEX");
    expect(guardar).toBeDisabled();

    const campo = within(form).getByLabelText("Nombre");
    await user.clear(campo);
    await user.type(campo, "  Clínica   Santa  María ");
    expect(guardar).toBeEnabled();
    // la vista previa cambia mientras se escribe, pero lo guardado no
    expect(within(screen.getByTestId("brand-preview")).getByText("Clínica Santa María")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clínica CUBAMEX, ir al calendario" })).toBeInTheDocument();

    await user.click(guardar);
    expect(await screen.findByText("Nombre guardado.")).toBeInTheDocument();
    expect(mock.db.branding.name).toBe("Clínica Santa María");                           // espacios normalizados
    expect(await screen.findByRole("link", { name: "Clínica Santa María, ir al calendario" })).toBeInTheDocument();
    expect(document.title).toBe("Clínica Santa María · Administración");
    expect(within(form).getByLabelText("Nombre")).toHaveValue("Clínica Santa María");
    expect(within(form).getByRole("button", { name: "Guardar nombre" })).toBeDisabled();
  });

  it("vacío no se guarda, y el campo no pasa de 80 caracteres", async () => {
    const { user, mock } = await openClinic();
    const form = screen.getByRole("form", { name: "Nombre de la clínica" });
    const campo = within(form).getByLabelText("Nombre");
    await user.clear(campo);
    expect(within(form).getByRole("button", { name: "Guardar nombre" })).toBeDisabled();
    await user.type(campo, "    ");
    expect(within(form).getByRole("button", { name: "Guardar nombre" })).toBeDisabled();
    expect(campo).toHaveAttribute("maxlength", "80");
    fireEvent.submit(form);                                                              // aunque se fuerce el envío
    expect(await within(form).findByRole("alert")).toHaveTextContent("Escribe el nombre de la clínica.");
    expect(mock.db.branding.name).toBe("Clínica CUBAMEX");
  });
});

describe("clínica: el logotipo", () => {
  /** Elegir el archivo en el selector. Con `fireEvent` (no `user.upload`): este ultimo respeta `accept` y descartaria un SVG o un GIF,
   *  que en un navegador real SÍ se pueden elegir (el selector deja ver «todos los archivos»). */
  const pick = async (_user: Awaited<ReturnType<typeof mountApp>>["user"], f: File) => {
    fireEvent.change(screen.getByLabelText("Archivo del logotipo"), { target: { files: [f] } });
  };

  it("sin logotipo se ve el icono por defecto y la regla de la imagen (cuadrada 1:1)", async () => {
    await openClinic();
    const sec = screen.getByRole("region", { name: "Logotipo" });
    expect(within(sec).getByText(/Todavía no hay logotipo/)).toBeInTheDocument();
    expect(within(sec).getByText(/cuadrada \(1:1\)/)).toBeInTheDocument();
    expect(within(sec).getByText(/de 64 a 2048 px por lado · hasta 1 MB/)).toBeInTheDocument();
    expect(within(sec).queryByRole("button", { name: "Quitar logotipo" })).toBeNull();
    expect(screen.getByLabelText("Archivo del logotipo")).toHaveAttribute("accept", "image/png,image/jpeg,image/webp");
    expect(defaultIcons(sec)).toHaveLength(1);
  });

  it("elige una imagen cuadrada: sale la vista previa SIN guardar; «Guardar logotipo» la sube y aparece en el encabezado", async () => {
    const { user, mock } = await openClinic();
    const sec = screen.getByRole("region", { name: "Logotipo" });
    await pick(user, file(png(256), "mi-logo.png"));
    expect(await within(sec).findByText(/mi-logo\.png/)).toHaveTextContent("Vista previa");
    expect(within(sec).getByText(/Aún no se guardó/)).toBeInTheDocument();
    expect(logoOf(sec)).toHaveLength(1);                                                  // la vista previa
    expect(logoOf(screen.getByTestId("brand-preview"))).toHaveLength(1);                  // y en «Así se verá»
    expect(logoOf(shellHeader())).toHaveLength(0);                           // pero el encabezado todavía no cambia
    expect(mock.db.branding.logo).toBeNull();                                             // y nada se subió

    await user.click(within(sec).getByRole("button", { name: "Guardar logotipo" }));
    expect(await screen.findByText("Logotipo guardado.")).toBeInTheDocument();
    expect(mock.db.branding.logo).toMatchObject({ contentType: "image/png" });
    expect([...mock.db.branding.logo!.bytes]).toEqual([...png(256)]);
    await waitFor(() => expect(logoOf(shellHeader())).toHaveLength(1));      // ya en el encabezado
    expect(defaultIcons(shellHeader())).toHaveLength(0);
    expect(within(sec).queryByText(/Vista previa/)).toBeNull();
    expect(within(sec).getByText("Este es el logotipo actual.")).toBeInTheDocument();
    expect(within(sec).getByRole("button", { name: "Quitar logotipo" })).toBeInTheDocument();
  });

  it("acepta JPG y WebP, y el tipo sale de los bytes (un JPG que se llama .png)", async () => {
    const { user, mock } = await openClinic();
    await pick(user, file(jpeg(300), "foto.png", "image/png"));
    await user.click(await screen.findByRole("button", { name: "Guardar logotipo" }));
    await waitFor(() => expect(mock.db.branding.logo?.contentType).toBe("image/jpeg"));
    await pick(user, file(webpLossless(200), "logo.webp", "image/webp"));
    await user.click(await screen.findByRole("button", { name: "Guardar logotipo" }));
    await waitFor(() => expect(mock.db.branding.logo?.contentType).toBe("image/webp"));
  });

  it.each([
    ["no es cuadrada", () => file(png(800, 600)), "La imagen debe ser cuadrada (1:1); esta mide 800 × 600 px."],
    ["es muy chica", () => file(png(32)), "muy pequeña: mínimo 64 × 64 px"],
    ["es muy grande", () => file(png(4096)), "muy grande: máximo 2048 × 2048 px"],
    ["es un SVG", () => file(svg(), "logo.svg", "image/svg+xml"), "Sube una imagen PNG, JPG o WebP."],
    ["es un GIF", () => file(gif(), "logo.gif", "image/gif"), "Sube una imagen PNG, JPG o WebP."],
    ["pesa más de 1 MB", () => file(padTo(png(128), 1024 * 1024 + 1)), "La imagen pesa más de 1 MB."],
    ["está vacía", () => file(new Uint8Array(), "vacio.png"), "No llegó ningún archivo."],
  ])("si %s: avisa con el motivo, no hay vista previa ni botón de guardar y no se sube nada", async (_caso, make, mensaje) => {
    const { user, mock } = await openClinic();
    await pick(user, make());
    const sec = screen.getByRole("region", { name: "Logotipo" });
    expect(await within(sec).findByRole("alert")).toHaveTextContent(mensaje);
    expect(within(sec).queryByRole("button", { name: "Guardar logotipo" })).toBeNull();
    expect(within(sec).queryByText(/Vista previa/)).toBeNull();
    expect(mock.db.branding.logo).toBeNull();
  });

  it("un archivo malo después de uno bueno quita la vista previa (no queda guardable el anterior)", async () => {
    const { user } = await openClinic();
    await pick(user, file(png(128)));
    await screen.findByRole("button", { name: "Guardar logotipo" });
    await pick(user, file(png(800, 600)));
    expect(await screen.findByRole("alert")).toHaveTextContent("cuadrada");
    expect(screen.queryByRole("button", { name: "Guardar logotipo" })).toBeNull();
  });

  it("«Cancelar» descarta la vista previa sin subir nada", async () => {
    const { user, mock } = await openClinic();
    await pick(user, file(png(128)));
    await user.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText(/Vista previa/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar logotipo" })).toBeNull();
    expect(mock.db.branding.logo).toBeNull();
  });

  it("«Quitar logotipo» pide confirmar; al confirmar vuelve el icono por defecto y el nombre no cambia", async () => {
    const { user, mock } = await openClinic({
      prepare: (mock) => {
        mock.db.branding.name = "Clínica Santa María";
        mock.db.branding.logo = { contentType: "image/png", bytes: png(128), hash: "abc12345" };
      },
    });
    await waitFor(() => expect(logoOf(shellHeader())).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Quitar logotipo" }));
    const dlg = await screen.findByRole("dialog", { name: "¿Quitar el logotipo?" });
    await user.click(within(dlg).getByRole("button", { name: "Cancelar" }));
    expect(mock.db.branding.logo).not.toBeNull();                                          // cancelar no quita nada

    await user.click(screen.getByRole("button", { name: "Quitar logotipo" }));
    await user.click(within(await screen.findByRole("dialog", { name: "¿Quitar el logotipo?" })).getByRole("button", { name: "Quitar logotipo" }));
    expect(await screen.findByText(/Logotipo quitado/)).toBeInTheDocument();
    expect(mock.db.branding).toMatchObject({ name: "Clínica Santa María", logo: null });
    await waitFor(() => expect(logoOf(shellHeader())).toHaveLength(0));
    expect(defaultIcons(shellHeader())).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Clínica Santa María, ir al calendario" })).toBeInTheDocument();
  });

  it("si el servidor rechaza la imagen (otra regla) muestra su motivo y no cambia el logotipo", async () => {
    const { user, mock } = await openClinic({
      prepare: (mock) => {
        mock.db.branding.logo = { contentType: "image/png", bytes: png(64), hash: "viejo" };
        const original = mock.fetch;
        mock.fetch = (input, init) =>
          String(input).includes("/api/settings/branding/logo") && init?.method === "PUT"
            ? Promise.resolve(new Response(JSON.stringify({ error: "validacion", detail: "El servidor dice que no." }), { status: 422, headers: { "Content-Type": "application/json" } }))
            : original(input, init);
      },
    });
    await pick(user, file(png(128)));
    await user.click(await screen.findByRole("button", { name: "Guardar logotipo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("El servidor dice que no.");
    expect(mock.db.branding.logo!.hash).toBe("viejo");
    expect(screen.getByRole("button", { name: "Guardar logotipo" })).toBeEnabled();         // se puede reintentar
  });
});
