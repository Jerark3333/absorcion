# Mapa de Absorción — imagen del servidor (Python/FastAPI + WebSocket Bybit)
FROM python:3.12-slim

WORKDIR /app

# dependencias primero (cachea mejor la capa)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# código de la app
COPY app ./app
COPY run.py .

ENV PORT=8899
EXPOSE 8899

CMD ["python", "run.py"]
