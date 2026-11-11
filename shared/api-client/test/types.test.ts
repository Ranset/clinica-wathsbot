import { describe, expect, it } from "vitest";
import type { components } from "../src/schema";
import type { Booking, BookingStatus, WeeklyHours } from "../src";
import type { Booking as CalendarBooking, BookingStatus as CalendarStatus, WeeklyHours as CalendarHours } from "@clinica/calendar/src/types";

/**
 * Comprobaciones de TIPOS (las hace `tsc`, por eso viven en el typecheck):
 * el `Booking` que genera el contrato y el de `shared/calendar` deben poder
 * usarse el uno por el otro. Si el contrato o el calendario cambian y dejan de
 * calzar, `npm run typecheck` falla aqui, no en la pantalla.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const bookingMatches: Mutual<components["schemas"]["Booking"], CalendarBooking> = true;
const statusMatches: Mutual<components["schemas"]["BookingStatus"], CalendarStatus> = true;
const hoursMatch: Mutual<components["schemas"]["WeeklyHours"], CalendarHours> = true;
// ... y lo que exporta el cliente ES el del calendario.
const reexported: Mutual<Booking, CalendarBooking> = true;
const reexportedStatus: Mutual<BookingStatus, CalendarStatus> = true;
const reexportedHours: Mutual<WeeklyHours, CalendarHours> = true;

describe("tipos del contrato", () => {
  it("Booking, BookingStatus y WeeklyHours del contrato calzan con shared/calendar", () => {
    expect([bookingMatches, statusMatches, hoursMatch, reexported, reexportedStatus, reexportedHours]).toEqual(Array(6).fill(true));
  });
});
