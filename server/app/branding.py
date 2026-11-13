"""Marca de la clinica: su NOMBRE (en `settings`, clave `clinic_name`) y su LOGOTIPO (tabla `clinic_logo`, una sola fila).

Lo ve cualquiera (hasta quien aun no inicia sesion: sale en el login) y solo lo cambia un administrador. Participa en la
transaccion de quien llama (no hace commit).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from .agenda.audit import SYSTEM, Actor, audit
from .db import utcnow
from .images import check_logo
from .models import ClinicLogo, Setting

CLINIC_NAME = "clinic_name"
DEFAULT_NAME = "Clínica CUBAMEX"
NAME_MAX = 80
LOGO_ID = 1


class BrandingError(ValueError):
    """Dato invalido (nombre vacio o largo...); el mensaje es para el administrador."""


@dataclass(frozen=True)
class Branding:
    name: str
    #: `sha256` del logotipo actual, o None si no hay (se usa la marca por defecto)
    logo_sha256: str | None


def clean_name(value) -> str:
    """Nombre de la clinica: texto de 1 a 80 caracteres, con los espacios y saltos de linea normalizados."""
    if not isinstance(value, str):
        raise BrandingError("El nombre debe ser texto.")
    name = " ".join(value.split())
    if not name:
        raise BrandingError("Escribe el nombre de la clínica.")
    if len(name) > NAME_MAX:
        raise BrandingError(f"El nombre admite hasta {NAME_MAX} caracteres.")
    return name


def get_branding(s: Session) -> Branding:
    row = s.get(Setting, CLINIC_NAME)
    name = row.value if row is not None and isinstance(row.value, str) and row.value.strip() else DEFAULT_NAME
    sha = s.scalar(select(ClinicLogo.sha256).where(ClinicLogo.id == LOGO_ID))
    return Branding(name, sha)


def set_name(s: Session, name, actor: Actor = SYSTEM) -> Branding:
    name = clean_name(name)
    row = s.get(Setting, CLINIC_NAME)
    if row is None:
        row = Setting(key=CLINIC_NAME, value=name)
        s.add(row)
    row.value = name
    row.updated_at = utcnow()
    row.updated_by_id = actor.user_id
    audit(s, actor, "branding.name", "setting", CLINIC_NAME, {"name": name})
    s.flush()
    return get_branding(s)


def set_logo(s: Session, data: bytes, actor: Actor = SYSTEM) -> Branding:
    """Guarda (o reemplaza) el logotipo. Lanza `images.ImageError` si no cumple (PNG/JPG/WebP, cuadrado, 64-2048 px, <= 1 MB)."""
    info = check_logo(data)
    sha = hashlib.sha256(data).hexdigest()
    row = s.get(ClinicLogo, LOGO_ID)
    if row is None:
        row = ClinicLogo(id=LOGO_ID, content_type=info.content_type, data=data, width=info.width, height=info.height, sha256=sha)
        s.add(row)
    row.content_type, row.data, row.width, row.height, row.sha256 = info.content_type, data, info.width, info.height, sha
    row.updated_at = utcnow()
    row.updated_by_id = actor.user_id
    # la bitacora guarda medidas y huella, nunca la imagen
    audit(s, actor, "branding.logo_set", "setting", "logo",
          {"bytes": len(data), "width": info.width, "height": info.height, "type": info.content_type, "sha256": sha[:12]})
    s.flush()
    return get_branding(s)


def delete_logo(s: Session, actor: Actor = SYSTEM) -> Branding:
    row = s.get(ClinicLogo, LOGO_ID)
    if row is not None:
        s.delete(row)
        audit(s, actor, "branding.logo_delete", "setting", "logo")
        s.flush()
    return get_branding(s)


def read_logo(s: Session) -> ClinicLogo | None:
    return s.get(ClinicLogo, LOGO_ID)
