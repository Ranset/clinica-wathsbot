import type { Role } from "@clinica/api-client";

/**
 * Qué puede hacer cada rol en esta web. El servidor es quien manda (`x-roles` del
 * contrato): esto solo esconde lo que el servidor rechazaría con 403, para no
 * ofrecer botones que no sirven.
 *
 * - `admin` (técnico): todo, incluida la administración de usuarios, eliminar doctores sin historial y personalizar el logotipo y el
 *   nombre de la clínica (lo único que no hace el personal).
 * - `staff` (personal / recepción): agenda, horario de la clínica, doctores (alta, edición y baja), sus horarios y
 *   ausencias, bot y casos.
 * - `doctor`: usa la PWA del doctor; en esta web no tiene pantallas.
 */
export type Permissions = {
  /** Entrar a esta web. */
  useAdminWeb: boolean;
  manageAppointments: boolean;
  manageDoctorSchedules: boolean;
  /** Alta, edición y baja de doctores. */
  manageDoctors: boolean;
  /** Eliminar DEFINITIVAMENTE un doctor (solo si nunca tuvo citas ni cuenta); el personal solo lo da de baja. */
  deleteDoctors: boolean;
  editClinicHours: boolean;
  manageUsers: boolean;
  /** Cambiar el logotipo y el nombre de la clínica (pantalla «Clínica»). */
  editBranding: boolean;
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
    manageDoctors: staff,
    deleteDoctors: admin,
    editClinicHours: staff,
    manageUsers: admin,
    editBranding: admin,
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
  { path: "/clinica", label: "Clínica", needs: "editBranding" },
];

export const canOpen = (role: Role | null | undefined, path: string): boolean => {
  const item = NAV.find((n) => n.path === path);
  return !!item && (!item.needs || permissionsFor(role)[item.needs]);
};
