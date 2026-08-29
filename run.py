"""Punto de entrada: lanza el Mapa de Absorción.

Uso:
    python run.py
Luego abre http://127.0.0.1:8899 en tu navegador.
"""
import uvicorn

from app.server import app

if __name__ == "__main__":
    # 0.0.0.0: escucha en todas las interfaces (imprescindible para que el proxy
    # de Fly.io pueda alcanzar la app; en local sigue funcionando en 127.0.0.1).
    uvicorn.run(app, host="0.0.0.0", port=8899, log_level="info")
