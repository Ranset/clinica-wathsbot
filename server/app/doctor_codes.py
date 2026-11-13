"""Codigo de acceso de cada doctor: 4 digitos que la clinica asigna al darlo de alta.

Es el «usuario» con el que el doctor entra a su app (junto con su contrasena): lo elige en una lista que muestra codigo y nombre.
No es un secreto (la lista es publica, igual que el nombre del doctor): lo que protege la cuenta es la contrasena. Por eso se
asigna solo y en orden, empezando en 1001 (asi nunca empieza con cero ni se confunde en un teclado numerico).
"""
from __future__ import annotations

import re
from typing import Iterable

from .agenda.errors import VALIDACION, AgendaError

CODE_RE = re.compile(r"[0-9]{4}")
FIRST_CODE, LAST_CODE = 1001, 9999


def next_code(used: Iterable[str]) -> str:
    """El menor codigo libre desde 1001. Los de un doctor eliminado se pueden volver a usar (ese doctor nunca tuvo historial)."""
    taken = set(used)
    for n in range(FIRST_CODE, LAST_CODE + 1):
        if str(n) not in taken:
            return str(n)
    raise AgendaError(VALIDACION, "ya no quedan codigos de doctor libres (1001 a 9999)")
