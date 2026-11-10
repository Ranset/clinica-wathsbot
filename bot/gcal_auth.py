#!/opt/venv/bin/python
"""Autorizacion minima de Google Calendar para Wathsbot (solo scope calendar.events).
Uso:  gcal_auth.py url            -> imprime la URL de autorizacion
      gcal_auth.py code "<URL o codigo>"  -> guarda google_token.json
      gcal_auth.py check           -> prueba el token
"""
import json, os, sys
from urllib.parse import urlparse, parse_qs
from google_auth_oauthlib.flow import Flow

HOME = "/data/profiles/wathsbot"
SECRET = f"{HOME}/google_client_secret.json"
TOKEN = f"{HOME}/google_token.json"
PENDING = f"{HOME}/google_oauth_pending.json"
SCOPES = ["https://www.googleapis.com/auth/calendar.events"]
REDIRECT = "http://localhost:1"


def flow():
    return Flow.from_client_secrets_file(SECRET, scopes=SCOPES, redirect_uri=REDIRECT)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "url":
        f = flow()
        url, state = f.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="false")
        json.dump({"state": state, "code_verifier": f.code_verifier}, open(PENDING, "w"))
        os.chmod(PENDING, 0o600)
        print(url)
    elif cmd == "code":
        raw = sys.argv[2].strip()
        code = parse_qs(urlparse(raw).query).get("code", [raw])[0] if raw.startswith("http") else raw
        p = json.load(open(PENDING))
        f = flow()
        f.code_verifier = p["code_verifier"]
        f.fetch_token(code=code)
        c = f.credentials
        json.dump({"token": c.token, "refresh_token": c.refresh_token, "token_uri": c.token_uri,
                   "client_id": c.client_id, "client_secret": c.client_secret, "scopes": list(c.scopes or SCOPES)},
                  open(TOKEN, "w"))
        os.chmod(TOKEN, 0o600)
        os.remove(PENDING)
        print("OK: token guardado. scopes:", list(c.scopes or SCOPES))
    elif cmd == "check":
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build
        d = json.load(open(TOKEN))
        c = Credentials(**{k: d[k] for k in ("token", "refresh_token", "token_uri", "client_id", "client_secret")}, scopes=d["scopes"])
        c.refresh(Request())
        print("OK: token valido; scopes:", d["scopes"])
    else:
        print(__doc__)


main()
