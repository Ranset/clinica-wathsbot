"""Color elegido para un doctor (se ve en el calendario). Se guarda como `#rrggbb` en minusculas.

Las citas agendadas se rellenan con el color del doctor y llevan texto BLANCO encima, asi que un color demasiado claro
(amarillo, gris claro...) las dejaria ilegibles: se exige contraste WCAG AA (>= 4.5:1) contra el blanco. La misma regla
esta en `shared/calendar/src/lib/doctor-color.ts` (`isReadableOnWhite`), que la web usa para avisar antes de guardar;
las dos comparten casos de prueba.
"""
from __future__ import annotations

import re

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
MIN_CONTRAST_WITH_WHITE = 4.5


def _linear(channel: int) -> float:
    c = channel / 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def contrast_with_white(color: str) -> float:
    """Contraste WCAG entre `#rrggbb` y el blanco (1 = igual, 21 = negro sobre blanco)."""
    r, g, b = (int(color[i:i + 2], 16) for i in (1, 3, 5))
    luminance = 0.2126 * _linear(r) + 0.7152 * _linear(g) + 0.0722 * _linear(b)
    return 1.05 / (luminance + 0.05)


def is_readable_on_white(color: str) -> bool:
    return contrast_with_white(color) >= MIN_CONTRAST_WITH_WHITE
