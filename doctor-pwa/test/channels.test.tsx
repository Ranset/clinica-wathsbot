import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { bookingButton, freezeClock, localDay, makeServer, mountApp } from "./helpers";

/**
 * Canales de mensajería (WhatsApp, Messenger, Instagram) vistos por el DOCTOR: ve el canal (no identifica a nadie) pero NUNCA un
 * teléfono, un teléfono de contacto ni el id de Meta de Messenger / Instagram, ni en lo que recibe ni en lo que pinta.
 */
beforeEach(freezeClock);

const NUM = "529990000001";
const IG = "17841400000000000";
const CONTACT = "9981234567";
const SECRETS = [NUM, IG, CONTACT, "facebook:", "instagram:", "contactPhone", "contactId"];

function seeded() {
  const server = makeServer();
  const fb = server.mock.bot.book({ canal: "facebook", contacto_id: NUM }, { patientName: "Nora Messenger", doctorId: "d1", contactPhone: CONTACT })!;
  const ig = server.mock.bot.book({ canal: "instagram", contacto_id: IG }, { patientName: "Ivan Instagram", doctorId: "d1", contactPhone: CONTACT })!;
  const wa = server.mock.bot.book({ telefono: NUM }, { patientName: "Wanda Whatsapp", doctorId: "d1" })!;
  return { server, fb, ig, wa };
}

describe("el doctor y las citas de otros canales", () => {
  it("lo que RECIBE no trae teléfono, teléfono de contacto ni id de Meta: el paciente es solo el id de la cita", async () => {
    const { server, fb, ig, wa } = seeded();
    await mountApp({ server, hash: `#/semana?dia=${localDay(fb.scheduledAtUtc)}` });
    await waitFor(() => expect(server.log.some((r) => r.path === "/api/doctor/appointments")).toBe(true));
    const range = { from: "2026-11-09T05:00:00.000Z", to: "2026-12-14T05:00:00.000Z" };
    const r = await server.api.doctorSelf.appointments(range);
    if (r.notModified) throw new Error("se esperaba la lista completa");
    const mine = r.data.items.filter((b) => [fb.id, ig.id, wa.id].includes(b.id));
    expect(mine).toHaveLength(3);
    for (const b of mine) expect(b.patient).toEqual({ id: b.id, name: b.patient!.name });
    const text = JSON.stringify(r.data);
    for (const s of SECRETS) expect(text, s).not.toContain(s);
    expect(mine.map((b) => b.channel).sort()).toEqual(["facebook", "instagram", "whatsapp"]); // el canal SI se ve
    expect(server.violations).toEqual([]);
  });

  it("lo que PINTA tampoco los muestra; al pasar el puntero por una cita de Messenger se lee el canal", async () => {
    const { server, fb } = seeded();
    await mountApp({ server, hash: `#/semana?dia=${localDay(fb.scheduledAtUtc)}` });
    const block = await bookingButton(fb);
    const page = document.body.textContent ?? "";
    for (const s of SECRETS) expect(page, s).not.toContain(s);
    expect(document.body.innerHTML).not.toContain(IG);
    expect(block.closest("[title]")?.getAttribute("title") ?? block.getAttribute("title") ?? "").toContain("Messenger");
    expect(server.violations).toEqual([]);
  });
});
