"""Quien hizo un cambio de agenda, y la bitacora (`audit_log`). La bitacora no guarda nombres ni telefonos."""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from ..models import AuditLog


@dataclass(frozen=True)
class Actor:
    kind: str  # user | bot | system
    user_id: int | None = None

    @classmethod
    def user(cls, user_id: int) -> "Actor":
        return cls("user", user_id)


BOT = Actor("bot")
SYSTEM = Actor("system")


def audit(s: Session, actor: Actor, action: str, entity_type: str, entity_id, data: dict | None = None) -> None:
    s.add(AuditLog(actor_kind=actor.kind, actor_user_id=actor.user_id, action=action, entity_type=entity_type,
                   entity_id=None if entity_id is None else str(entity_id), data=data))
