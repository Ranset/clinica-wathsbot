"""Errores de agenda. Los codigos son los de `bot/scheduler.py` (parte del contrato con el prompt del bot)
mas los nuevos de `docs/openapi.yaml` (`ErrorCode`)."""
from __future__ import annotations

# Codigos heredados de scheduler.py (conservados tal cual)
HORARIO_OCUPADO = "horario_ocupado"
HORARIO_PASADO = "horario_pasado_o_muy_cercano"
FUERA_DE_RANGO = "fuera_de_rango"
FUERA_DE_HORARIO = "fuera_de_horario"
FALTA_NOMBRE = "falta_nombre_completo"
ESPECIALIDAD = "especialidad_no_encontrada"
CITA_NO_ENCONTRADA = "cita_no_encontrada"
# Nuevos
DOCTOR_NO_DISPONIBLE = "doctor_no_disponible"
TRANSICION_INVALIDA = "transicion_invalida"
VALIDACION = "validacion"
NO_ENCONTRADO = "no_encontrado"

#: estado HTTP que el contrato asigna a cada codigo (lo usara la capa de rutas)
HTTP_STATUS = {
    HORARIO_OCUPADO: 409,
    TRANSICION_INVALIDA: 409,
    CITA_NO_ENCONTRADA: 404,
    NO_ENCONTRADO: 404,
}


class AgendaError(Exception):
    """Regla de agenda incumplida. `code` es uno de los codigos de arriba; `extra` se mezcla en el cuerpo."""

    def __init__(self, code: str, detail: str | None = None, **extra):
        super().__init__(code if not detail else f"{code}: {detail}")
        self.code = code
        self.detail = detail
        self.extra = extra

    @property
    def http_status(self) -> int:
        return HTTP_STATUS.get(self.code, 422)

    def body(self) -> dict:
        """Cuerpo de error del contrato (`{"error": codigo, ...}`); el bot lo recibe tal cual."""
        out = {"error": self.code}
        if self.detail:
            out["detail"] = self.detail
        out.update(self.extra)
        return out
