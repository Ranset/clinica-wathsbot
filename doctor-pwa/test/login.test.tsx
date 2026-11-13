import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LOGIN_MAX_FAILURES } from "@clinica/api-client/mock";
import { Combobox, filterOptions, fold, type ComboOption } from "../src/ui/combobox";
import { doctorCredentials, freezeClock, makeServer, mountApp, signIn } from "./helpers";

beforeEach(freezeClock);

/** Un servidor simulado con VARIOS doctores con cuenta (el de ejemplo trae uno solo): 1001 Cervantes, 1002 Pérez Lago, 1003 Bordas, 1007 Argüelles. */
function serverWithDoctors(opts: Parameters<typeof makeServer>[0] = {}) {
  const server = makeServer(opts);
  const extra = [
    { id: "u50", doctorId: "d2", name: "Dr. Pérez Lago", email: "perez@clinica.test", password: "clave-perez-2026" },
    { id: "u51", doctorId: "d3", name: "Dra. Bordas Rodríguez", email: "bordas@clinica.test", password: "clave-bordas-2026" },
    { id: "u52", doctorId: "d7", name: "Dra. Ana del Carmen Argüelles", email: "arguelles@clinica.test", password: "clave-arguelles-2026" },
  ];
  for (const u of extra) server.mock.db.users.push({ ...u, role: "doctor", active: true });
  return server;
}

const field = () => screen.findByRole("combobox", { name: "Usuario" });
/** El campo de usuario, ya con la lista cargada (mientras carga está bloqueado). */
const ready = async () => {
  const combo = await field();
  await waitFor(() => expect(combo).toBeEnabled());
  return combo as HTMLInputElement;
};
const optionTexts = () => screen.queryAllByRole("option").map((o) => o.textContent);
const requestedLogin = (log: ReturnType<typeof makeServer>["log"]) => log.some((r) => r.path === "/api/auth/doctor-login");

describe("pantalla de entrada del doctor", () => {
  it("la lista trae código y nombre de cada doctor CON cuenta, por código (sin correos ni doctores sin cuenta)", async () => {
    const t = await mountApp({ as: null, server: serverWithDoctors() });
    const combo = await ready();
    await t.user.click(combo);
    expect(optionTexts()).toEqual(["1001Dr. Cervantes Peláez", "1002Dr. Pérez Lago", "1003Dra. Bordas Rodríguez", "1007Dra. Ana del Carmen Argüelles"]);
    expect(document.body.textContent).not.toMatch(/@clinica\.test/); // la lista no expone correos
    expect(screen.queryByLabelText("Correo")).toBeNull();
    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("type", "password");
    expect(t.violations).toEqual([]);
  });

  it("mientras carga la lista, el campo y «Entrar» están bloqueados; al llegar se habilitan", async () => {
    const t = await mountApp({ as: null });
    const combo = await field();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeDisabled();
    await waitFor(() => expect(combo).toBeEnabled());
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
    expect(t.violations).toEqual([]);
  });

  it("se autocompleta por CÓDIGO: al escribir el código completo se elige y el campo dice «código · nombre»", async () => {
    const t = await mountApp({ as: null, server: serverWithDoctors() });
    const combo = await ready();
    await t.user.type(combo, "100");
    expect(optionTexts()).toHaveLength(4); // 1001, 1002, 1003 y 1007 empiezan con «100»
    await t.user.type(combo, "3");
    expect(combo.value).toBe("1003 · Dra. Bordas Rodríguez");
    expect(screen.queryByRole("listbox")).toBeNull(); // elegido: la lista se cierra
  });

  it("se autocompleta por NOMBRE, sin importar mayúsculas ni acentos, y la lista se reduce al escribir", async () => {
    const t = await mountApp({ as: null, server: serverWithDoctors() });
    const combo = await ready();
    await t.user.type(combo, "PEREZ");
    expect(optionTexts()).toEqual(["1002Dr. Pérez Lago"]);
    await t.user.clear(combo);
    await t.user.type(combo, "ana carmen");
    expect(optionTexts()).toEqual(["1007Dra. Ana del Carmen Argüelles"]); // varias palabras: todas deben coincidir
    await t.user.clear(combo);
    await t.user.type(combo, "dra");
    expect(optionTexts()).toEqual(["1003Dra. Bordas Rodríguez", "1007Dra. Ana del Carmen Argüelles"]);
  });

  it("con el teclado: ↓ y Enter eligen (sin enviar el formulario) y el foco pasa a la contraseña", async () => {
    const t = await mountApp({ as: null, server: serverWithDoctors() });
    const combo = await ready();
    await t.user.type(combo, "dr");
    expect(combo).toHaveAttribute("aria-expanded", "true");
    await t.user.keyboard("{ArrowDown}");
    expect(document.getElementById(combo.getAttribute("aria-activedescendant")!)).toHaveTextContent("Pérez Lago"); // el segundo de la lista
    await t.user.keyboard("{Enter}");
    expect(combo.value).toBe("1002 · Dr. Pérez Lago");
    expect(screen.getByLabelText("Contraseña")).toHaveFocus();
    expect(requestedLogin(t.log)).toBe(false); // Enter eligió: todavía no entró
  });

  it("Esc cierra la lista; Tab acepta la opción resaltada", async () => {
    const t = await mountApp({ as: null, server: serverWithDoctors() });
    const combo = await ready();
    await t.user.type(combo, "bordas");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await t.user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(combo).toHaveAttribute("aria-expanded", "false");
    await t.user.keyboard("{ArrowDown}"); // vuelve a abrirla
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await t.user.tab();
    expect(combo.value).toBe("1003 · Dra. Bordas Rodríguez");
    expect(screen.getByLabelText("Contraseña")).toHaveFocus();
  });

  it("al hacer clic en una opción se elige; al volver al campo muestra TODA la lista con la elegida resaltada", async () => {
    const t = await mountApp({ as: null, server: serverWithDoctors() });
    const combo = await ready();
    await t.user.click(combo);
    await t.user.click(screen.getByRole("option", { name: /Argüelles/ }));
    expect(combo.value).toBe("1007 · Dra. Ana del Carmen Argüelles");
    expect(screen.getByLabelText("Contraseña")).toHaveFocus();
    await t.user.click(combo);
    expect(optionTexts()).toHaveLength(4);
    expect(document.getElementById(combo.getAttribute("aria-activedescendant")!)).toHaveTextContent("Argüelles");
  });

  it("lo que no coincide con nadie lo dice, y «Entrar» sin elegir a un doctor avisa sin llamar al servidor", async () => {
    const t = await mountApp({ as: null, server: serverWithDoctors() });
    const combo = await ready();
    await t.user.type(combo, "zzz");
    expect(await screen.findByText("Ningún doctor coincide con «zzz».")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
    await t.user.type(screen.getByLabelText("Contraseña"), "lo-que-sea-1234");
    await t.user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByText("Elige tu código o tu nombre en la lista.")).toBeInTheDocument();
    expect(requestedLogin(t.log)).toBe(false);
    // y al elegir bien el aviso se va
    await t.user.clear(combo);
    await t.user.type(combo, "1002");
    expect(screen.queryByText("Elige tu código o tu nombre en la lista.")).toBeNull();
  });

  it("cambiar de elección: lo que se escribe reemplaza al doctor anterior, y entra como el nuevo", async () => {
    const t = await mountApp({ as: null, server: serverWithDoctors() });
    const combo = await ready();
    await t.user.type(combo, "1001");
    expect(combo.value).toBe("1001 · Dr. Cervantes Peláez");
    await t.user.click(combo); // el texto queda marcado: lo que se escribe lo reemplaza
    await t.user.keyboard("1003");
    expect(combo.value).toBe("1003 · Dra. Bordas Rodríguez");
    await t.user.type(screen.getByLabelText("Contraseña"), "clave-bordas-2026");
    await t.user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect((await screen.findAllByText("Dra. Bordas Rodríguez")).length).toBeGreaterThan(0); // entró como Bordas, no como Cervantes
    expect(t.log.find((r) => r.path === "/api/auth/doctor-login")?.body).toEqual({ doctorCode: "1003", password: "clave-bordas-2026" });
  });

  it("entra con el doctor elegido por nombre y la contraseña escrita a mano: se manda código y contraseña, no correo", async () => {
    const t = await mountApp({ as: null, server: serverWithDoctors() });
    const combo = await ready();
    await t.user.type(combo, "perez");
    await t.user.keyboard("{Enter}");
    await t.user.keyboard("clave-perez-2026");
    await t.user.keyboard("{Enter}"); // Enter en la contraseña envía el formulario
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Martes, 10 de noviembre de 2026");
    expect((await screen.findAllByText("Dr. Pérez Lago")).length).toBeGreaterThan(0);
    expect(t.log.find((r) => r.path === "/api/auth/doctor-login")?.body).toEqual({ doctorCode: "1002", password: "clave-perez-2026" });
    expect(t.log.some((r) => r.path === "/api/auth/login")).toBe(false);
    expect(t.violations).toEqual([]);
  });

  it("una contraseña mala conserva al doctor elegido y avisa; tras demasiados intentos, bloquea", async () => {
    const t = await mountApp({ as: null });
    const combo = await ready();
    await t.user.type(combo, doctorCredentials().code);
    for (let i = 0; i <= LOGIN_MAX_FAILURES; i++) {
      await t.user.clear(screen.getByLabelText("Contraseña"));
      await t.user.type(screen.getByLabelText("Contraseña"), `mala-${i}`);
      await t.user.click(screen.getByRole("button", { name: "Entrar" }));
      if (i === 0) expect(await screen.findByText("Usuario o contraseña incorrectos.")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled());
    }
    expect(await screen.findByText(/Demasiados intentos/)).toBeInTheDocument();
    expect(combo.value).toBe("1001 · Dr. Cervantes Peláez"); // sigue elegido
  });

  it("si la lista no carga, avisa y «Reintentar» la pide de nuevo", async () => {
    let down = true;
    const t = await mountApp({ as: null, server: makeServer({ fail: (p) => down && p === "/api/auth/doctors" }) });
    expect(await screen.findByText(/No se pudo cargar la lista de doctores/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Usuario" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Entrar" })).toBeDisabled();
    down = false;
    await t.user.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Usuario" })).toBeEnabled());
    expect(screen.queryByText(/No se pudo cargar la lista/)).toBeNull();
    await signIn(t.user);
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  it("si ningún doctor tiene cuenta, lo dice", async () => {
    const server = makeServer();
    server.mock.db.users.splice(0, server.mock.db.users.length, ...server.mock.db.users.filter((u) => u.role !== "doctor"));
    await mountApp({ as: null, server });
    expect(await screen.findByText(/Todavía no hay doctores con acceso/)).toBeInTheDocument();
  });
});

describe("filtro del autocompletado", () => {
  const options: ComboOption[] = [
    { value: "1001", lead: "1001", label: "Dr. Cervantes Peláez" },
    { value: "1002", lead: "1002", label: "Dr. Pérez Lago" },
    { value: "1010", lead: "1010", label: "Dra. Pérez Soto" },
    { value: "2001", lead: "2001", label: "Dr. Soto Pérez" },
  ];
  const values = (list: ComboOption[]) => list.map((o) => o.value);

  it("fold quita acentos, mayúsculas y espacios repetidos", () => {
    expect(fold("  Dra.  ÁRGÜELLES ")).toBe("dra. arguelles");
  });

  it("sin texto devuelve todas; con texto, las que coinciden por código o por una palabra del nombre", () => {
    expect(filterOptions(options, "")).toEqual(options);
    expect(filterOptions(options, "   ")).toEqual(options);
    expect(values(filterOptions(options, "1001"))).toEqual(["1001"]);
    expect(values(filterOptions(options, "cervantes"))).toEqual(["1001"]);
    expect(values(filterOptions(options, "pelaez"))).toEqual(["1001"]);
    expect(values(filterOptions(options, "perez"))).toEqual(["1002", "1010", "2001"]);
  });

  it("las que EMPIEZAN con lo escrito van antes que las que solo lo contienen; el resto conserva su orden", () => {
    const list: ComboOption[] = [{ value: "3001", lead: "3001", label: "Dra. Esperanza Díaz" }, ...options];
    // «per»: Esperanza lo CONTIENE (va después) y las Pérez lo EMPIEZAN (van antes, en su orden)
    expect(values(filterOptions(list, "per"))).toEqual(["1002", "1010", "2001", "3001"]);
    // «01» está dentro de los códigos pero no empieza ninguno: se conserva el orden original
    expect(values(filterOptions(options, "01"))).toEqual(["1001", "1010", "2001"]);
    // «10» empieza 1001, 1002 y 1010; 2001 no lo contiene
    expect(values(filterOptions(options, "10"))).toEqual(["1001", "1002", "1010"]);
  });

  it("todas las palabras escritas deben coincidir", () => {
    expect(values(filterOptions(options, "dra perez"))).toEqual(["1010"]);
    expect(values(filterOptions(options, "soto perez"))).toEqual(["1010", "2001"]);
    expect(filterOptions(options, "xyz")).toEqual([]);
  });
});

describe("Combobox (aislado)", () => {
  it("es un combobox de ARIA con la lista enlazada y avisa de la elección con onChange (y de la elección a mano con onPick)", async () => {
    const changes: (string | null)[] = [];
    const picks: string[] = [];
    function Host() {
      const [v, setV] = useState<string | null>(null);
      return (
        <Combobox
          label="Doctor"
          options={[{ value: "a", lead: "1001", label: "Uno" }, { value: "b", lead: "1002", label: "Dos" }]}
          value={v}
          onChange={(x) => {
            changes.push(x);
            setV(x);
          }}
          onPick={(o) => picks.push(o.value)}
        />
      );
    }
    render(<Host />);
    const user = userEvent.setup();
    const combo = screen.getByRole("combobox", { name: "Doctor" });
    expect(combo).toHaveAttribute("aria-autocomplete", "list");
    expect(combo).toHaveAttribute("aria-expanded", "false");
    await user.click(combo);
    const list = screen.getByRole("listbox", { name: "Doctor" });
    expect(combo.getAttribute("aria-controls")).toBe(list.id);
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    await user.keyboard("1002"); // código completo: se elige solo, SIN onPick
    expect(changes).toEqual(["b"]);
    expect(picks).toEqual([]);
    await user.click(combo);
    await user.click(screen.getByRole("option", { name: /Uno/ })); // clic: sí hay onPick
    expect(changes).toEqual(["b", "a"]);
    expect(picks).toEqual(["a"]);
  });
});
