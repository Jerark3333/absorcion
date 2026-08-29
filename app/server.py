"""Servidor del Mapa de Absorción (FastAPI + WebSocket).

- /                     -> dashboard
- /api/meta             -> config + tick autodetectado
- /api/symbols?q=       -> buscador de símbolos
- /api/config (POST)    -> cambia símbolo/temporalidad en caliente
- /api/snapshot         -> estado completo
- /ws                   -> init + estado en vivo (1s) + eventos de vela
"""
import asyncio
import logging
import os
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import Config, load_config
from .bybit_client import BybitPublic
from .engine import AbsorptionEngine

log = logging.getLogger("server")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app = FastAPI(title="Mapa de Absorción — BYBIT")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


class SwitchRequest(BaseModel):
    symbol: str
    interval: str
    limit: int = 500
    cluster_step: int = 0


class ClusterStepRequest(BaseModel):
    step: int


class Hub:
    def __init__(self):
        self.cfg = load_config()
        self.engine = None
        self.client = None
        self._ws_task = None
        self._seed_task = None
        self._clients = set()
        self._q = asyncio.Queue(maxsize=5000)
        self._symbols_cache = None
        self._symbols_ts = 0.0
        self.ready = False

    # ---------------------------------------------------------------
    def _wire(self):
        self.engine.on_event = self._q.put_nowait
        self.client.on_trade = self.engine.on_trade
        self.client.on_kline = self.engine.on_kline
        self.client.on_book = self.engine.on_book
        self.engine.client = self.client   # para la reconciliación REST al cierre

    async def _detect_tick(self):
        try:
            info = await asyncio.to_thread(self.client.instrument_info)
            if info.get("tick_size"):
                self.cfg.tick_size = info["tick_size"]
        except Exception as e:
            log.warning("instrument_info falló (%s); uso tick por defecto", e)

    async def _seed(self):
        try:
            await asyncio.sleep(1)
            klines = await asyncio.to_thread(self.client.fetch_klines, self.cfg.history_limit)
            # bootstrap: ticks REALES recientes de Bybit REST para reconstruir
            # el footprint de la vela actual antes de que fluya el WebSocket.
            recent = await asyncio.to_thread(self.client.recent_trades, 1000)
            self.engine.seed_historical(klines, recent)
        except Exception as e:
            log.warning("seed falló: %s", e)

    async def start(self):
        await self._build()

    async def _build(self, await_seed=False):
        # cancelar suscripción anterior
        if self._ws_task:
            self._ws_task.cancel()
            try:
                await self._ws_task
            except (asyncio.CancelledError, Exception):
                pass
        # cancelar un seed en curso para no duplicar velas/zonas
        if self._seed_task:
            self._seed_task.cancel()
            try:
                await self._seed_task
            except (asyncio.CancelledError, Exception):
                pass
        if self.client:
            self.client.stop()
        self.client = BybitPublic(self.cfg)
        await self._detect_tick()
        self.engine = AbsorptionEngine(self.cfg)
        self._wire()
        self._ws_task = asyncio.create_task(self.client.run())
        if await_seed:
            # esperar a que el histórico esté listo (cambios de config desde la UI)
            await self._seed()
        else:
            self._seed_task = asyncio.create_task(self._seed())
        self.ready = True
        log.info("Activo: %s %s (%s) tick=%s cluster_step=%s", self.cfg.category, self.cfg.symbol,
                 self.cfg.interval, self.cfg.tick_size, self.cfg.cluster_step)

    async def switch(self, symbol, interval, limit=None, cluster_step=None):
        self.cfg.symbol = symbol.upper().strip()
        self.cfg.interval = interval.strip()
        if limit is not None and int(limit) > 0:
            self.cfg.history_limit = int(limit)
        if cluster_step is not None and int(cluster_step) > 0:
            self.cfg.cluster_step = int(cluster_step)
        self.ready = False
        await self._build(await_seed=True)

    async def switch_cluster_step(self, step):
        """Cambia el paso de cluster (ticks por cluster) y re-agrupa histórico + vivo."""
        self.cfg.cluster_step = int(step)
        self.ready = False
        await self._build(await_seed=True)

    # ---------------------------------------------------------------
    async def broadcaster(self):
        while True:
            ev = await self._q.get()
            dead = []
            for ws in list(self._clients):
                try:
                    await ws.send_json(ev)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self._clients.discard(ws)

    async def periodic(self):
        while True:
            await asyncio.sleep(1.0)
            if not self.ready or not self.engine:
                continue
            try:
                state = {"type": "state", **self.engine.snapshot(include_clusters=False)}
            except Exception:
                continue
            dead = []
            for ws in list(self._clients):
                try:
                    await ws.send_json(state)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self._clients.discard(ws)

    # ---------------------------------------------------------------
    def register(self, ws):
        self._clients.add(ws)

    def unregister(self, ws):
        self._clients.discard(ws)

    def snapshot(self):
        return self.engine.snapshot() if self.engine else {"config": self.cfg.to_dict(), "zones": [], "candles": [], "levels": [], "last_price": None, "book": None}

    async def symbols(self, q):
        now = time.time()
        if self._symbols_cache is None or now - self._symbols_ts > 120:
            try:
                self._symbols_cache = await asyncio.to_thread(self.client.list_symbols, 500)
                self._symbols_ts = now
            except Exception:
                self._symbols_cache = self._symbols_cache or []
        q = (q or "").upper()
        res = [s for s in self._symbols_cache if q in s["symbol"]]
        res.sort(key=lambda s: s["symbol"])
        return res[:60]


hub = Hub()


@app.on_event("startup")
async def _startup():
    asyncio.create_task(hub.broadcaster())
    asyncio.create_task(hub.periodic())
    await hub.start()


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/meta")
async def meta():
    return {"config": hub.cfg.to_dict()}


@app.get("/api/symbols")
async def symbols(q: str = ""):
    return {"symbols": await hub.symbols(q)}


@app.post("/api/config")
async def set_config(req: SwitchRequest):
    await hub.switch(req.symbol, req.interval, req.limit, req.cluster_step)
    return {"ok": True, "config": hub.cfg.to_dict()}


@app.post("/api/cluster_step")
async def set_cluster_step(req: ClusterStepRequest):
    await hub.switch_cluster_step(req.step)
    return {"ok": True, "config": hub.cfg.to_dict()}


@app.get("/api/snapshot")
async def snapshot():
    return hub.snapshot()


@app.get("/api/footprint-history")
async def footprint_history(limit: int = 100):
    """Historial del footprint: las últimas N velas (por defecto 100) con sus
    clusters Bid/Ask/Delta consolidados (buffer local 24/7 del WebSocket)."""
    if not hub.engine:
        return {"candles": []}
    candles = list(hub.engine.candles)
    return {"candles": candles[-max(1, min(limit, 500)):]}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    hub.register(ws)
    try:
        await ws.send_json({"type": "init", **hub.snapshot()})
        while True:
            await ws.receive_text()
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        hub.unregister(ws)
