import type { Role } from "@clinica/api-client";

/**
 * Qué puede hacer cada rol en esta web. El servidor es quien manda (`x-roles` del
 * contrato): esto solo esconde lo que el servidor rechazaría con 403, para no
 * ofrecer botones que no sirven.
 *
 * - `admin` (técnico): todo, incluidos usuarios, alta de doctores y horario de la clínica.
 * - `staff` (personal): agenda, horarios y ausencias de los doctores, bot y casos.
 * - `doctor`: usa la PWA del doctor; en esta web no tiene pantallas.
 */
export type Permissions = {
  /** Entrar a esta web. */
  useAdminWeb: boolean;
  manageAppointments: boolean;
  manageDoctorSchedules: boolean;
  /** Alta, edición y baja de doctores. */
  manageDoctors: boolean;
  editClinicHours: boolean;
  manageUsers: boolean;
  toggleBot: boolean;
  handleAttention: boolean;
};

export function permissionsFor(role: Role | null | undefined): Permissions {
  const staff = role === "admin" || role === "staff";
  const admin = role === "admin";
  return {
    useAdminWeb: staff,
    manageAppointments: staff,
    manageDoctorSchedules: staff,
    manageDoctors: admin,
    editClinicHours: admin,
    manageUsers: admin,
    toggleBot: staff,
    handleAttention: staff,
  };
}

export type NavItem = { path: string; label: string; needs?: keyof Permissions };

export const NAV: NavItem[] = [
  { path: "/calendario", label: "Calendario", needs: "manageAppointments" },
  { path: "/doctores", label: "Doctores", needs: "manageDoctorSchedules" },
  { path: "/atencion", label: "Atención", needs: "handleAttention" },
  { path: "/usuarios", label: "Usuarios", needs: "manageUsers" },
];

export const canOpen = (role: Role | null | undefined, path: string): boolean => {
  const item = NAV.find((n) => n.path === path);
  return !!item && (!item.needs || permissionsFor(role)[item.needs]);
};
