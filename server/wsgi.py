"""Punto de entrada WSGI (PythonAnywhere) y `flask --app wsgi ...`."""
from app import create_app

app = create_app()
