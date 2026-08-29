"""Punto de entrada: lanza el Mapa de Absorción.

Uso:
    python run.py
Luego abre http://127.0.0.1:8899 en tu navegador.
"""
import uvicorn

from app.server import app

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8899, log_level="info")
