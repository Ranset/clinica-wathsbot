from flask import Blueprint, jsonify

bp = Blueprint("health", __name__)


@bp.get("/api/health")
def health():
    """Comprobacion de vida (sin autenticacion). Contrato: `health` -> `{"status": "ok"}`."""
    return jsonify(status="ok")
