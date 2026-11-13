"""Quien escribe: la pareja (`canal`, `clave`).

- `whatsapp`: la clave es el TELEFONO (digitos), como siempre.
- `facebook` / `instagram`: la clave es el id de Meta (PSID / IGSID). NO es un telefono ni un dato verificado.

**Aislamiento total entre canales:** dos identidades son la misma persona solo si coinciden el canal Y la clave. El mismo numero en
WhatsApp y en Messenger son dos personas distintas, y nunca se unifican solas. Toda consulta por identidad pasa por `Identity.owns`
(en Python) o `Identity.matches` (en SQL); nadie compara `Appointment.phone` por su cuenta fuera de WhatsApp.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import and_

from ..models import CHANNELS, Appointment

#: id de Meta aceptado (PSID / IGSID): letras, digitos, guion y guion bajo; de 5 a 64 caracteres.
CONTACT_ID_RE = re.compile(r"[0-9A-Za-z_-]{5,64}")
WHATSAPP = "whatsapp"


@dataclass(frozen=True)
class Identity:
    channel: str
    key: str

    def __bool__(self) -> bool:
        """Una identidad sin clave (o de un canal desconocido) no es dueña de nada: evita que `phone IS NULL` empareje citas
        de mostrador sin telefono."""
        return bool(self.key) and self.channel in CHANNELS

    @property
    def is_whatsapp(self) -> bool:
        return self.channel == WHATSAPP

    @staticmethod
    def coerce(who) -> Identity:
        """Acepta una `Identity` o, por compatibilidad con quien solo conoce el telefono, un texto (= WhatsApp)."""
        if isinstance(who, Identity):
            return Identity(who.channel, str(who.key).strip())
        return Identity(WHATSAPP, str(who).strip() if who is not None else "")

    def owns(self, a: Appointment) -> bool:
        """Esta cita es de esta identidad. WhatsApp compara el telefono; los demas canales, SOLO el id de Meta (nunca `phone`)."""
        if not self:
            return False
        if self.is_whatsapp:
            return a.channel == WHATSAPP and a.phone == self.key
        return a.channel == self.channel and a.contact_id == self.key

    def matches(self):
        """La misma regla de `owns`, como condicion SQL."""
        if self.is_whatsapp:
            return and_(Appointment.channel == WHATSAPP, Appointment.phone == self.key)
        return and_(Appointment.channel == self.channel, Appointment.contact_id == self.key)

    def tail(self) -> str:
        """Para mensajes de error y registros: solo los ultimos 4 caracteres del id (nunca el completo)."""
        return "…" + self.key[-4:] if self.key else ""
