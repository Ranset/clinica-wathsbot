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
