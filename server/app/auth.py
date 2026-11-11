"""Autenticacion y usuarios (F4): contrasenas, sesiones por cookie, bloqueo de intentos y administracion de usuarios.

- **Contrasenas**: `werkzeug.security` (scrypt, o pbkdf2 si el Python no lo trae): sin dependencias nuevas. Minimo 10
  caracteres. Un usuario desconocido o inactivo gasta el mismo tiempo de verificacion (no se distingue por la demora).
- **Sesiones**: la cookie lleva un token aleatorio de 256 bits; la BD guarda solo su SHA-256. Caducan por inactividad
  (`idle_minutes`) o en forma absoluta (`max_days`), y se cierran al desactivar al usuario, cambiarle el rol o la contrasena.
  El token CSRF es estable durante toda la sesion.
- **Bloqueo**: `max_failures` contrasenas erroneas seguidas bloquean al usuario `lock_minutes` (429). El contador se CONFIRMA
  antes de rechazar (por eso el rechazo se lanza despues de la transaccion).
"""
from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Callable

from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from werkzeug.security import check_password_hash, generate_password_hash

from .agenda.audit import SYSTEM, Actor, audit
from .agenda.errors import NO_ENCONTRADO, VALIDACION, AgendaError
from .agenda.rules import Rules
from .agenda.uow import Unit
from .db import is_unique_violation, to_db
from .models import ROLES, Doctor, User, UserSession

EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
MIN_PASSWORD, MAX_PASSWORD = 10, 128
TOUCH_EVERY = timedelta(minutes=5)          # cada cuanto se actualiza `last_seen_at` (evita una escritura por peticion)


class AuthError(Exception):
    """Fallo de autenticacion: `credenciales_invalidas` (401) o `demasiados_intentos` (429, con `retry_after` en segundos)."""

    def __init__(self, code: str, status: int, retry_after: int | None = None):
        super().__init__(code)
        self.code, self.status, self.retry_after = code, status, retry_after


@dataclass(frozen=True)
class UserView:
    id: int
    email: str
    name: str
    role: str
    doctor_id: int | None
    active: bool


@dataclass(frozen=True)
class Principal:
    """Quien hace la peticion (resultado de resolver la cookie de sesion)."""
    session_id: int
    user: UserView
    csrf_token: str

    @property
    def role(self) -> str:
        return self.user.role

    @property
    def doctor_id(self) -> int | None:
        return self.user.doctor_id


def _view(u: User) -> UserView:
    return UserView(u.id, u.email, u.name, u.role, u.doctor_id, bool(u.active))


def _sha(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def default_hash_method() -> str:
    return "scrypt" if hasattr(hashlib, "scrypt") else "pbkdf2:sha256"


def check_password_policy(password, email: str = "") -> str:
    if not isinstance(password, str) or not MIN_PASSWORD <= len(password) <= MAX_PASSWORD:
        raise AgendaError(VALIDACION, f"la contrasena debe tener entre {MIN_PASSWORD} y {MAX_PASSWORD} caracteres")
    if email and password.strip().lower() == email.lower():
        raise AgendaError(VALIDACION, "la contrasena no puede ser el correo")
    return password


class AuthService(Unit):
    def __init__(self, session_factory: sessionmaker[Session], rules: Rules | None = None,
                 clock: Callable[[], datetime] | None = None, *, idle_minutes: int = 480, max_days: int = 7,
                 max_failures: int = 5, lock_minutes: int = 15, hash_method: str = ""):
        super().__init__(session_factory, rules, clock)
        self.idle = timedelta(minutes=idle_minutes)
        self.max_age = timedelta(days=max_days)
        self.max_failures = max_failures
        self.lock = timedelta(minutes=lock_minutes)
        self.hash_method = hash_method or default_hash_method()
        self._dummy: str | None = None

    def _utc(self) -> datetime:
        return to_db(self.now()).replace(microsecond=0)

    # ------------------------------------------------------------------ contrasenas
    def hash_password(self, password: str) -> str:
        return generate_password_hash(password, method=self.hash_method)

    def _burn(self, password: str) -> None:
        """Gasta lo mismo que verificar una contrasena real (usuario inexistente o inactivo)."""
        if self._dummy is None:
            self._dummy = self.hash_password("contrasena-de-relleno")
        check_password_hash(self._dummy, password)

    # ------------------------------------------------------------------ login / sesion
    def login(self, email, password) -> tuple[UserView, str, str]:
        """-> (usuario, token de la cookie, token CSRF). Lanza `AuthError`."""
        email = email.strip().lower() if isinstance(email, str) else ""
        password = password if isinstance(password, str) else ""

        def work(repo, s):
            now = self._utc()
            user = s.scalars(select(User).where(User.email == email)).first() if email else None
            if user is None or not user.active:
                return ("invalid", None)
            if user.locked_until is not None:
                if user.locked_until > now:
                    return ("locked", int((user.locked_until - now).total_seconds()) + 1)
                user.failed_logins, user.locked_until = 0, None          # el bloqueo ya vencio
            if not check_password_hash(user.password_hash, password):
                user.failed_logins = (user.failed_logins or 0) + 1
                if user.failed_logins >= self.max_failures:
                    user.locked_until = now + self.lock
                    audit(s, SYSTEM, "auth.lockout", "user", user.id, {"failures": user.failed_logins})
                    return ("locked", int(self.lock.total_seconds()))
                return ("invalid", None)
            user.failed_logins, user.locked_until, user.last_login_at = 0, None, now
            s.execute(delete(UserSession).where(or_(UserSession.expires_at <= now,
                                                    UserSession.last_seen_at <= now - self.idle)))
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            s.add(UserSession(token_hash=_sha(token), user_id=user.id, csrf_token=csrf, created_at=now,
                              last_seen_at=now, expires_at=now + self.max_age))
            audit(s, Actor.user(user.id), "auth.login", "user", user.id)
            return ("ok", (_view(user), token, csrf))
        kind, value = self._write(work)
        if kind == "ok":
            return value
        if kind == "locked":
            raise AuthError("demasiados_intentos", 429, retry_after=value)
        self._burn(password)
        raise AuthError("credenciales_invalidas", 401)

    def resolve(self, token) -> Principal | None:
        """Sesion vigente de esa cookie, o None. Una sesion vencida se borra."""
        if not isinstance(token, str) or not 10 <= len(token) <= 200:
            return None
        h = _sha(token)

        def lookup(s: Session):
            return s.execute(select(UserSession, User).join(User, User.id == UserSession.user_id)
                             .where(UserSession.token_hash == h)).first()

        def state(sess: UserSession, user: User, now: datetime) -> str:
            if sess.expires_at <= now or sess.last_seen_at + self.idle <= now or not user.active:
                return "dead"
            return "touch" if now - sess.last_seen_at >= TOUCH_EVERY else "fresh"

        now = self._utc()
        with self._read() as repo:                                    # camino comun: solo lectura
            row = lookup(repo.s)
            if row is None:
                return None
            sess, user = row
            st = state(sess, user, now)
            if st == "fresh":
                return Principal(sess.id, _view(user), sess.csrf_token)

        def write(repo, s):                                          # hay que borrar o refrescar
            row = lookup(s)
            if row is None:
                return None
            sess, user = row
            st = state(sess, user, now)
            if st == "dead":
                s.delete(sess)
                return None
            sess.last_seen_at = now
            return Principal(sess.id, _view(user), sess.csrf_token)
        return self._write(write)

    def logout(self, token) -> None:
        if isinstance(token, str) and token:
            self._write(lambda repo, s: s.execute(delete(UserSession).where(UserSession.token_hash == _sha(token))))

    # ------------------------------------------------------------------ usuarios (administrador)
    def list_users(self) -> list[UserView]:
        with self._read() as repo:
            return [_view(u) for u in repo.s.scalars(select(User).order_by(User.id))]

    def get_user(self, user_id) -> UserView | None:
        with self._read() as repo:
            u = self._user(repo.s, user_id)
            return _view(u) if u else None

    def find_by_email(self, email) -> UserView | None:
        e = email.strip().lower() if isinstance(email, str) else ""
        with self._read() as repo:
            u = repo.s.scalars(select(User).where(User.email == e)).first() if e else None
            return _view(u) if u else None

    @staticmethod
    def _user(s: Session, user_id) -> User | None:
        try:
            return s.get(User, int(user_id))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _clean_email(email) -> str:
        e = email.strip().lower() if isinstance(email, str) else ""
        if not e or len(e) > 254 or not EMAIL_RE.fullmatch(e):
            raise AgendaError(VALIDACION, "correo invalido")
        return e

    @staticmethod
    def _clean_name(name) -> str:
        n = " ".join(name.split()) if isinstance(name, str) else ""
        if not n or len(n) > 120:
            raise AgendaError(VALIDACION, "nombre: de 1 a 120 caracteres")
        return n

    @staticmethod
    def _check_shape(s: Session, role, doctor_id) -> int | None:
        """Un `doctor` va ligado a un doctor que existe; el resto, a ninguno."""
        if role not in ROLES:
            raise AgendaError(VALIDACION, f"rol desconocido: {role!r}")
        if role == "doctor":
            try:
                did = int(doctor_id)
            except (TypeError, ValueError):
                raise AgendaError(VALIDACION, "un usuario doctor debe ligarse a un doctor (doctorId)") from None
            if s.get(Doctor, did) is None:
                raise AgendaError(VALIDACION, "el doctor no existe")
            return did
        if doctor_id not in (None, ""):
            raise AgendaError(VALIDACION, "solo un usuario con rol doctor lleva doctorId")
        return None

    def create_user(self, *, email, name, role, password, doctor_id=None, actor: Actor = SYSTEM) -> UserView:
        email, name = self._clean_email(email), self._clean_name(name)
        check_password_policy(password, email)
        pw_hash = self.hash_password(password)

        def work(repo, s):
            did = self._check_shape(s, role, doctor_id)
            u = User(email=email, name=name, role=role, doctor_id=did, password_hash=pw_hash, active=True)
            s.add(u)
            s.flush()
            audit(s, actor, "user.create", "user", u.id, {"role": role})
            return _view(u)
        try:
            return self._write(work)
        except IntegrityError as e:
            if is_unique_violation(e):
                raise AgendaError(VALIDACION, "ya existe un usuario con ese correo") from None
            raise

    def update_user(self, user_id, patch: dict, actor: Actor = SYSTEM) -> UserView:
        """`patch` solo con las claves presentes: name, role, doctor_id, active, password."""
        if not patch:
            raise AgendaError(VALIDACION, "no hay nada que cambiar")
        name = self._clean_name(patch["name"]) if "name" in patch else None
        pw_hash = None
        if "password" in patch:
            check_password_policy(patch["password"])
            pw_hash = self.hash_password(patch["password"])
        if "active" in patch and not isinstance(patch["active"], bool):
            raise AgendaError(VALIDACION, "active debe ser verdadero o falso")

        def work(repo, s):
            u = s.get(User, int(user_id), with_for_update=True) if str(user_id).isdigit() else None
            if u is None:
                raise AgendaError(NO_ENCONTRADO)
            if pw_hash is not None and patch["password"].strip().lower() == u.email:
                raise AgendaError(VALIDACION, "la contrasena no puede ser el correo")
            role = patch.get("role", u.role)
            doctor_id = patch.get("doctor_id", u.doctor_id) if role == "doctor" else patch.get("doctor_id")
            if "role" in patch and role != u.role or "doctor_id" in patch:
                new_doctor = self._check_shape(s, role, doctor_id)
            else:
                new_doctor = u.doctor_id
            active = patch.get("active", u.active)
            changed = []
            if actor.user_id == u.id and (not active or role != u.role):
                raise AgendaError(VALIDACION, "no puedes desactivarte ni cambiar tu propio rol")
            if u.role == "admin" and u.active and (role != "admin" or not active):
                others = s.scalar(select(func.count()).select_from(User).where(
                    User.role == "admin", User.active.is_(True), User.id != u.id))
                if not others:
                    raise AgendaError(VALIDACION, "debe quedar al menos un administrador activo")
            revoke = False
            if name is not None and name != u.name:
                u.name = name
                changed.append("name")
            if role != u.role or new_doctor != u.doctor_id:
                u.role, u.doctor_id = role, new_doctor
                changed.append("role")
                revoke = True
            if active != u.active:
                u.active = active
                changed.append("active")
                revoke = revoke or not active
            if pw_hash is not None:
                u.password_hash, u.failed_logins, u.locked_until = pw_hash, 0, None   # tambien desbloquea
                changed.append("password")
                revoke = True
            if revoke:
                s.execute(delete(UserSession).where(UserSession.user_id == u.id))
            s.flush()
            audit(s, actor, "user.update", "user", u.id, {"changed": changed})
            return _view(u)
        return self._write(work)
