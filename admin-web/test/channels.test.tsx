import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { bookingButton, freezeClock, localDay, mountApp, pickBooking } from "./helpers";

/**
 * Canales de mensajería (WhatsApp, Messenger = `facebook`, Instagram): los tres interruptores del bot, la pantalla de Atención con su
 * canal y el detalle de la cita con canal y teléfono de contacto. Todo contra la API simulada y validado contra el contrato.
 */
beforeEach(freezeClock);

let violations: string[] = [];
afterEach(() => {
  expect(violations).toEqual([]);
  violations = [];
});

const NUM = "529990000001";
const IG = "17841400000000000";
const CONTACT = "9981234567";
const sw = (name: string) => screen.findByRole("switch", { name });
/** El bot es UN elemento en el encabezado: este es su botón (el nombre accesible empieza con «Canales del bot»). */
const botButton = () => screen.findByRole("button", { name: /^Canales del bot/ });
/** Lo abre y devuelve el panel con los tres interruptores. */
async function openBot(user: Awaited<ReturnType<typeof mountApp>>["user"]) {
  await user.click(await botButton());
  return screen.findByRole("group", { name: "Bot por canal" });
}

describe("el bot: un solo elemento que resume los canales y despliega un interruptor por cada uno", () => {
  it("cerrado dice por qué canales contesta; al darle clic se despliegan WhatsApp, Messenger e Instagram", async () => {
    const { user, violations: v } = await mountApp({ prepare: (m) => (m.db.bot.channels.instagram = true) });
    violations = v;
    const button = await botButton();
    await waitFor(() => expect(button).toHaveAttribute("aria-label", "Canales del bot: activos: WhatsApp, Instagram"));
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument(); // cerrado: ningún interruptor suelto en el encabezado
    expect(screen.getAllByRole("button", { name: /^Canales del bot/ })).toHaveLength(1);

    const panel = await openBot(user);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual(["Bot de WhatsApp", "Bot de Messenger", "Bot de Instagram"]);
    expect(within(panel).getByRole("switch", { name: "Bot de WhatsApp" })).toHaveAttribute("aria-checked", "true");
    expect(within(panel).getByRole("switch", { name: "Bot de Messenger" })).toHaveAttribute("aria-checked", "false");
    expect(within(panel).getByRole("switch", { name: "Bot de Instagram" })).toHaveAttribute("aria-checked", "true");
    expect(within(panel).getByRole("switch", { name: "Bot de Messenger" })).toHaveTextContent("Bot apagado");
  });

  it("el resumen sigue a los canales: todos, ninguno, algunos y el estado mientras carga", async () => {
    const { user, mock, violations: v } = await mountApp({ prepare: (m) => (m.db.bot.channels.whatsapp = false) });
    violations = v;
    const button = await botButton();
    await waitFor(() => expect(button).toHaveAttribute("aria-label", "Canales del bot: todos apagados"));
    expect(button).toHaveAttribute("title", "Bot: todos apagados");
    await openBot(user);
    await user.click(await sw("Bot de Messenger"));
    await waitFor(() => expect(button).toHaveAttribute("aria-label", "Canales del bot: activos: Messenger"));
    await user.click(await sw("Bot de WhatsApp"));
    await user.click(await sw("Bot de Instagram"));
    await waitFor(() => expect(button).toHaveAttribute("aria-label", "Canales del bot: todos activos"));
    expect(mock.db.bot.channels).toEqual({ whatsapp: true, facebook: true, instagram: true });
  });

  it("se cierra con Esc (y el foco vuelve al botón), con un clic fuera y al volver a darle clic al botón", async () => {
    const { user, violations: v } = await mountApp();
    violations = v;
    const button = await botButton();
    await openBot(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Bot por canal" })).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();

    await openBot(user);
    await user.click(document.body); // clic fuera
    expect(screen.queryByRole("group", { name: "Bot por canal" })).not.toBeInTheDocument();

    await openBot(user);
    await user.click(button); // el mismo botón lo cierra
    expect(screen.queryByRole("group", { name: "Bot por canal" })).not.toBeInTheDocument();
  });

  it("Messenger e Instagram nacen apagados y WhatsApp conserva su estado", async () => {
    const { user, violations: v } = await mountApp();
    violations = v;
    const panel = await openBot(user);
    await waitFor(() => expect(within(panel).getByRole("switch", { name: "Bot de WhatsApp" })).toHaveAttribute("aria-checked", "true"));
    expect(within(panel).getByRole("switch", { name: "Bot de Messenger" })).toHaveAttribute("aria-checked", "false");
    expect(within(panel).getByRole("switch", { name: "Bot de Instagram" })).toHaveAttribute("aria-checked", "false");
    expect(await botButton()).toHaveAttribute("aria-label", "Canales del bot: activos: WhatsApp");
  });

  it("cada fila dice quién cambió el canal y cuándo (visible, no solo al pasar el puntero)", async () => {
    const { user, violations: v } = await mountApp();
    violations = v;
    await openBot(user);
    const fb = await sw("Bot de Messenger");
    expect(fb).toHaveTextContent("Interruptor del bot de Messenger"); // nadie lo ha cambiado
    await user.click(fb); // encender no pide confirmación
    await waitFor(() => expect(fb).toHaveAttribute("aria-checked", "true"));
    expect(fb).toHaveTextContent("Lo cambió Recepción Clínica");
    expect(fb).toHaveAttribute("title", expect.stringContaining("Lo cambió Recepción Clínica"));
    expect(await screen.findByText(/contesta los mensajes de Messenger/)).toBeInTheDocument();
  });

  it("encender Messenger no toca WhatsApp ni Instagram", async () => {
    const { user, mock, violations: v } = await mountApp();
    violations = v;
    await openBot(user);
    const wa = await sw("Bot de WhatsApp");
    const fb = await sw("Bot de Messenger");
    const ig = await sw("Bot de Instagram");
    await waitFor(() => expect(wa).toHaveAttribute("aria-checked", "true"));
    await user.click(fb);
    await waitFor(() => expect(fb).toHaveAttribute("aria-checked", "true"));
    expect(mock.db.bot.channels).toEqual({ whatsapp: true, facebook: true, instagram: false });
    expect(wa).toHaveAttribute("aria-checked", "true");
    expect(ig).toHaveAttribute("aria-checked", "false");
    expect(ig).not.toHaveTextContent("Lo cambió");
  });

  it("apagar uno pide confirmación (con el nombre del canal) y NO afecta a los demás; cancelar no cambia nada; el panel sigue abierto", async () => {
    const { user, mock, violations: v } = await mountApp({ prepare: (m) => (m.db.bot.channels.instagram = true) });
    violations = v;
    await openBot(user);
    const wa = await sw("Bot de WhatsApp");
    const fb = await sw("Bot de Messenger");
    const ig = await sw("Bot de Instagram");
    await waitFor(() => expect(ig).toHaveAttribute("aria-checked", "true"));

    await user.click(ig);
    const confirm = await screen.findByRole("dialog", { name: "¿Apagar el bot?" });
    expect(confirm).toHaveTextContent("Instagram");
    expect(mock.db.bot.channels.instagram).toBe(true); // todavía no
    await user.click(within(confirm).getByRole("button", { name: "Cancelar" }));
    expect(mock.db.bot.channels.instagram).toBe(true);
    expect(screen.getByRole("group", { name: "Bot por canal" })).toBeInTheDocument(); // cancelar no cierra el panel

    await user.click(ig);
    await user.click(within(await screen.findByRole("dialog", { name: "¿Apagar el bot?" })).getByRole("button", { name: "Sí, apagar el bot" }));
    await waitFor(() => expect(ig).toHaveAttribute("aria-checked", "false"));
    expect(mock.db.bot.channels).toEqual({ whatsapp: true, facebook: false, instagram: false });
    expect(wa).toHaveAttribute("aria-checked", "true"); // apagar Instagram no cambia WhatsApp
    expect(fb).toHaveAttribute("aria-checked", "false");
    expect(mock.db.bot.channelUpdates!.instagram.updatedBy).toBe("Recepción Clínica");
    expect(mock.db.bot.active).toBe(true); // `active` sigue siendo el de WhatsApp
    expect(screen.getByRole("group", { name: "Bot por canal" })).toBeInTheDocument();
  });

  it("apagar WhatsApp deja a Messenger como estaba", async () => {
    const { user, mock, violations: v } = await mountApp({ prepare: (m) => (m.db.bot.channels.facebook = true) });
    violations = v;
    await openBot(user);
    const wa = await sw("Bot de WhatsApp");
    const fb = await sw("Bot de Messenger");
    await waitFor(() => expect(fb).toHaveAttribute("aria-checked", "true"));
    await user.click(wa);
    await user.click(within(await screen.findByRole("dialog", { name: "¿Apagar el bot?" })).getByRole("button", { name: "Sí, apagar el bot" }));
    await waitFor(() => expect(wa).toHaveAttribute("aria-checked", "false"));
    expect(fb).toHaveAttribute("aria-checked", "true");
    expect(mock.db.bot).toMatchObject({ active: false, channels: { whatsapp: false, facebook: true, instagram: false } });
    expect(await botButton()).toHaveAttribute("aria-label", "Canales del bot: activos: Messenger");
  });

  it("refleja lo que otra persona cambió en un canal (consulta periódica), también con el panel abierto", async () => {
    const { user, mock, violations: v } = await mountApp();
    violations = v;
    await openBot(user);
    const wa = await sw("Bot de WhatsApp");
    const fb = await sw("Bot de Messenger");
    await waitFor(() => expect(wa).toHaveAttribute("aria-checked", "true"));
    mock.db.bot.channels.facebook = true; // la otra persona enciende Messenger
    mock.db.bot.channelUpdates!.facebook = { updatedAt: "2026-11-10T15:00:00.000Z", updatedBy: "Otra Persona" };
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fb).toHaveAttribute("aria-checked", "true"));
    expect(fb).toHaveTextContent("Lo cambió Otra Persona");
    expect(wa).toHaveAttribute("aria-checked", "true");
    expect(await botButton()).toHaveAttribute("aria-label", "Canales del bot: activos: WhatsApp, Messenger");
  });

  it("con un servidor de la versión anterior (solo `active`) WhatsApp se ve bien y los otros canales quedan apagados, nunca activos", async () => {
    const { user } = await mountApp({
      prepare: (m) => {
        m.db.bot = { active: true, updatedAt: "2026-11-10T14:00:00.000Z", updatedBy: "Admin" } as never; // sin `channels`: fuera del contrato a proposito
      },
    });
    await openBot(user);
    const wa = await sw("Bot de WhatsApp");
    await waitFor(() => expect(wa).toHaveAttribute("aria-checked", "true"));
    expect(await sw("Bot de Messenger")).toHaveAttribute("aria-checked", "false");
    expect(await sw("Bot de Instagram")).toHaveAttribute("aria-checked", "false");
    expect(wa).toHaveAttribute("title", expect.stringContaining("Lo cambió Admin"));
    expect(await botButton()).toHaveAttribute("aria-label", "Canales del bot: activos: WhatsApp");
    violations = []; // la respuesta del "servidor viejo" no cumple el contrato nuevo, y eso es justo lo que se prueba
  });
});

describe("cada canal: manual o por horario", () => {
  type User = Awaited<ReturnType<typeof mountApp>>["user"];
  /** Abre la ventana de «Horario» de un canal. */
  async function openSchedule(user: User, name: string) {
    await openBot(user);
    await user.click(await screen.findByRole("button", { name: `Horario de ${name}` }));
    return screen.findByRole("dialog", { name: "Horario del bot" });
  }
  const pickDays = async (user: User, dlg: HTMLElement, names: string[]) => {
    for (const n of names) await user.click(within(dlg).getByRole("button", { name: n }));
  };

  it("cada canal tiene su botón «Horario»; la ventana empieza en Manual y, al elegir «Por horario», pide días y horas", async () => {
    const { user, violations: v } = await mountApp();
    violations = v;
    await openBot(user);
    expect(screen.getAllByRole("button", { name: /^Horario de / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Horario de WhatsApp", "Horario de Messenger", "Horario de Instagram"]);
    await user.click(screen.getByRole("button", { name: "Horario de Messenger" }));
    const dlg = await screen.findByRole("dialog", { name: "Horario del bot" });
    expect(dlg).toHaveTextContent("Messenger");
    expect(within(dlg).getByRole("radio", { name: /Manual/ })).toBeChecked();
    expect(within(dlg).queryByRole("group", { name: "Días" })).not.toBeInTheDocument();

    await user.click(within(dlg).getByRole("radio", { name: /Por horario/ }));
    expect(within(dlg).getByRole("group", { name: "Días" })).toBeInTheDocument();
    expect(within(dlg).getAllByRole("button", { pressed: true })).toHaveLength(7); // por omisión: todos los días, de 6:00 PM a 9:00 AM
    expect(within(dlg).getByLabelText("Desde")).toHaveValue("18:00");
    expect(within(dlg).getByLabelText("Hasta")).toHaveValue("09:00");
    expect(within(dlg).getByRole("status")).toHaveTextContent("Todos los días · 6:00 PM a 9:00 AM (al día siguiente)");
  });

  it("guarda el horario: el canal pasa a «por horario», el interruptor se deshabilita y dice cuándo contesta", async () => {
    const { user, mock, violations: v } = await mountApp();
    violations = v;
    const dlg = await openSchedule(user, "Messenger");
    await user.click(within(dlg).getByRole("radio", { name: /Por horario/ }));
    await pickDays(user, dlg, ["Sábado", "Domingo"]); // de lunes a viernes
    await user.selectOptions(within(dlg).getByLabelText("Desde"), "19:00");
    await user.selectOptions(within(dlg).getByLabelText("Hasta"), "08:00");
    expect(within(dlg).getByRole("status")).toHaveTextContent("Lun–Vie · 7:00 PM a 8:00 AM (al día siguiente)");
    await user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Horario del bot" })).not.toBeInTheDocument());

    expect(mock.db.bot.modes?.facebook).toBe("schedule");
    expect(mock.db.bot.schedules?.facebook).toEqual({ days: ["mon", "tue", "wed", "thu", "fri"], start: "19:00", end: "08:00" });
    expect(mock.db.bot.modes?.whatsapp).toBe("manual"); // los otros canales no cambian
    const fb = await sw("Bot de Messenger");
    expect(fb).toBeDisabled(); // el horario manda: el interruptor no se usa
    expect(fb).toHaveTextContent("Bot apagado · por horario"); // martes 10:00: fuera de 7:00 PM a 8:00 AM
    expect(fb).toHaveTextContent("Lun–Vie · 7:00 PM a 8:00 AM (al día siguiente)");
    expect(fb).toHaveAttribute("title", expect.stringContaining("cambia a Manual"));
    expect(await screen.findByText(/se encenderá y apagará solo/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Horario de Messenger" })).toHaveClass("bg-brand-tint"); // se nota que usa horario
  });

  it("dentro del horario el canal está activo y el botón de arriba lo dice; el interruptor manual se conserva", async () => {
    const { user, mock, violations: v } = await mountApp({ prepare: (m) => (m.db.bot.channels.facebook = true) });
    violations = v;
    const dlg = await openSchedule(user, "Messenger");
    await user.click(within(dlg).getByRole("radio", { name: /Por horario/ }));
    await pickDays(user, dlg, ["Sábado", "Domingo"]);
    await user.selectOptions(within(dlg).getByLabelText("Desde"), "09:00");
    await user.selectOptions(within(dlg).getByLabelText("Hasta"), "18:00");
    expect(within(dlg).getByRole("status")).not.toHaveTextContent("al día siguiente");
    await user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Horario del bot" })).not.toBeInTheDocument());
    const fb = await sw("Bot de Messenger");
    await waitFor(() => expect(fb).toHaveAttribute("aria-checked", "true")); // martes 10:00: dentro de 9:00 AM a 6:00 PM
    expect(fb).toHaveTextContent("Bot activo · por horario");
    expect(await botButton()).toHaveAttribute("aria-label", "Canales del bot: activos: WhatsApp, Messenger");
    expect(mock.db.bot.channels.facebook).toBe(true); // el manual sigue guardado
  });

  it("volver a «Manual» devuelve el mando al interruptor y deja el horario guardado", async () => {
    const { user, mock, violations: v } = await mountApp({
      prepare: (m) => {
        m.db.bot.modes = { whatsapp: "manual", facebook: "schedule", instagram: "manual" };
        m.db.bot.schedules = { whatsapp: null, facebook: { days: ["mon", "tue"], start: "19:00", end: "08:00" }, instagram: null };
      },
    });
    violations = v;
    const dlg = await openSchedule(user, "Messenger");
    expect(within(dlg).getByRole("radio", { name: /Por horario/ })).toBeChecked(); // abre con lo que ya tiene
    expect(within(dlg).getByLabelText("Desde")).toHaveValue("19:00");
    expect(within(dlg).getAllByRole("button", { pressed: true }).map((b) => b.getAttribute("aria-label"))).toEqual(["Lunes", "Martes"]);
    await user.click(within(dlg).getByRole("radio", { name: /Manual/ }));
    await user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(mock.db.bot.modes?.facebook).toBe("manual"));
    expect(mock.db.bot.schedules?.facebook).toEqual({ days: ["mon", "tue"], start: "19:00", end: "08:00" });
    const fb = await sw("Bot de Messenger");
    await waitFor(() => expect(fb).toBeEnabled());
    expect(fb).toHaveTextContent("Bot apagado");
    expect(fb).not.toHaveTextContent("por horario");
  });

  it("no deja guardar sin días o con la misma hora; no cambia nada", async () => {
    const { user, mock, violations: v } = await mountApp();
    violations = v;
    const dlg = await openSchedule(user, "Instagram");
    await user.click(within(dlg).getByRole("radio", { name: /Por horario/ }));
    await pickDays(user, dlg, ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]);
    expect(within(dlg).getByRole("status")).toHaveTextContent("Elige los días y dos horas distintas.");
    await user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("Elige al menos un día.");
    await user.click(within(dlg).getByRole("button", { name: "Lunes" }));
    await user.selectOptions(within(dlg).getByLabelText("Hasta"), "18:00");
    await user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("no pueden ser la misma hora");
    expect(mock.db.bot.modes?.instagram ?? "manual").toBe("manual");
    expect(mock.db.bot.schedules?.instagram ?? null).toBeNull();
  });

  it("si el servidor falla, la ventana sigue abierta con el aviso y no cambia nada; al reintentar se guarda", async () => {
    const { user, mock, violations: v } = await mountApp();
    violations = v;
    const dlg = await openSchedule(user, "Messenger");
    await user.click(within(dlg).getByRole("radio", { name: /Por horario/ }));
    mock.controls.failNext(1);
    await user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    expect(await within(dlg).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Horario del bot" })).toBeInTheDocument();
    expect(mock.db.bot.modes?.facebook ?? "manual").toBe("manual");
    await user.click(within(dlg).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(mock.db.bot.modes?.facebook).toBe("schedule"));
    violations = []; // la pagina de error 503 que se provoco no es una violacion del contrato
  });

  it("la ventana de horario no cierra el panel de los canales al abrirse ni al cancelar", async () => {
    const { user, violations: v } = await mountApp();
    violations = v;
    const dlg = await openSchedule(user, "WhatsApp");
    await user.click(within(dlg).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog", { name: "Horario del bot" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Bot por canal" })).toBeInTheDocument();
  });
});

describe("Atención: canal de cada caso", () => {
  const withCases = (mock: Parameters<NonNullable<Parameters<typeof mountApp>[0]>["prepare"] & object>[0]) => {
    mock.bot.handoff({ conversationId: "conv-fb-9", reason: "pidio_persona", canal: "facebook", contacto_id: NUM, detail: "Quiere hablar del costo" });
    mock.bot.handoff({ conversationId: "conv-ig-7", reason: "fuera_de_alcance", canal: "instagram", contacto_id: IG });
  };

  it("cada caso lleva la etiqueta de su canal; sin teléfono dice «Contestar desde el inbox de Zernio» con la conversación copiable", async () => {
    const { user, violations: v } = await mountApp({ hash: "#/atencion", prepare: withCases });
    violations = v;
    const list = await screen.findByRole("list", { name: "Casos pendientes" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(5); // los 3 de siempre + Messenger + Instagram

    const fb = items.find((i) => i.textContent?.includes("conv-fb-9"))!;
    expect(fb).toHaveTextContent("Canal: Messenger");
    expect(fb).toHaveTextContent("Contestar desde el inbox de Zernio");
    expect(fb).toHaveTextContent("conv-fb-9");
    expect(fb).not.toHaveTextContent(NUM); // el id de Meta no se muestra como si fuera un teléfono
    expect(within(fb).queryByRole("button", { name: /Copiar el teléfono/ })).not.toBeInTheDocument();

    const ig = items.find((i) => i.textContent?.includes("conv-ig-7"))!;
    expect(ig).toHaveTextContent("Canal: Instagram");
    expect(ig).toHaveTextContent("Contestar desde el inbox de Zernio");

    const wa = items.find((i) => i.textContent?.includes("conv-demo-1"))!;
    expect(wa).toHaveTextContent("Canal: WhatsApp");
    expect(wa).toHaveTextContent("+52 998 000 0777"); // WhatsApp: el teléfono, como siempre
    expect(wa).not.toHaveTextContent("Contestar desde el inbox de Zernio");

    // el id de la conversación se copia
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void writes.push(t) }, configurable: true });
    await user.click(within(fb).getByRole("button", { name: "Copiar el id de la conversación conv-fb-9" }));
    expect(writes).toEqual(["conv-fb-9"]);
  });

  it("se filtra por canal (también los atendidos) y «Todos los canales» vuelve a mostrar todo", async () => {
    const { user, violations: v } = await mountApp({ hash: "#/atencion", prepare: withCases });
    violations = v;
    const list = () => within(screen.getByRole("list", { name: "Casos pendientes" })).getAllByRole("listitem");
    await waitFor(() => expect(list()).toHaveLength(5));
    const filter = screen.getByRole("group", { name: "Canal" });

    await user.click(within(filter).getByRole("button", { name: "Messenger" }));
    await waitFor(() => expect(list()).toHaveLength(1));
    expect(list()[0]).toHaveTextContent("conv-fb-9");
    expect(within(filter).getByRole("button", { name: "Messenger" })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(filter).getByRole("button", { name: "Instagram" }));
    await waitFor(() => expect(list()[0]).toHaveTextContent("conv-ig-7"));
    expect(list()).toHaveLength(1);

    await user.click(within(filter).getByRole("button", { name: "WhatsApp" }));
    await waitFor(() => expect(list()).toHaveLength(3)); // los 3 de ejemplo (WhatsApp es el canal por omisión)
    for (const it of list()) expect(it).not.toHaveTextContent(/Messenger|Instagram/);

    await user.click(within(filter).getByRole("button", { name: "Todos los canales" }));
    await waitFor(() => expect(list()).toHaveLength(5));
  });

  it("un caso sin conversación no ofrece copiar y uno de ausencia de doctor no lleva etiqueta de canal", async () => {
    const { violations: v } = await mountApp({ hash: "#/atencion" });
    violations = v;
    const list = await screen.findByRole("list", { name: "Casos pendientes" });
    const ausencia = within(list).getAllByRole("listitem").find((i) => i.textContent?.includes("Ausencia de doctor"))!;
    expect(ausencia).not.toHaveTextContent("Canal:");
    expect(ausencia).not.toHaveTextContent("Contestar desde el inbox de Zernio");
  });
});

describe("detalle de la cita: canal y teléfono de contacto", () => {
  it("una cita de Messenger muestra su canal y el teléfono de CONTACTO, sin confundirlo con el id de Meta", async () => {
    const { user, mock, violations: v } = await mountApp({
      prepare: (m) => {
        m.bot.book({ canal: "facebook", contacto_id: NUM }, { patientName: "Nora Messenger", doctorId: "d4", contactPhone: CONTACT });
      },
    });
    violations = v;
    const made = mock.db.bookings.find((b) => b.patient?.name === "Nora Messenger")!;
    window.location.hash = `#/calendario?dia=${localDay(made.scheduledAtUtc)}`;
    await user.click(await bookingButton(made));
    const dialog = await screen.findByRole("dialog", { name: "Nora Messenger" });
    expect(dialog).toHaveTextContent("Canal");
    expect(within(dialog).getByText("Messenger", { selector: "span" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Teléfono de contacto");
    expect(dialog).toHaveTextContent("998 123 4567");
    expect(dialog).toHaveTextContent("Agendó el bot de Messenger");
    expect(dialog).not.toHaveTextContent(NUM); // el id de Meta nunca se muestra como teléfono
  });

  it("una cita de WhatsApp sigue diciendo «Teléfono» y su canal", async () => {
    const { user, mock, violations: v } = await mountApp({ hash: "#/calendario?dia=2026-11-12" });
    violations = v;
    const booking = pickBooking(mock, "2026-11-12", { doctorId: "d1", nth: 0 });
    await user.click(await bookingButton(booking));
    const dialog = await screen.findByRole("dialog", { name: booking.patient!.name });
    expect(within(dialog).getByText("Teléfono")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("WhatsApp");
    expect(dialog).not.toHaveTextContent("Teléfono de contacto");
  });
});
