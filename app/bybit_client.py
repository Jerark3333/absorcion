"""Cliente público de BYBIT (WebSocket + REST).

Recibe en tiempo real:
  - publicTrade.<sym>  -> trades con lado agresivo (S: Buy/Sell)
  - kline.<int>.<sym>  -> límites de slice (confirm=True al cerrar)
  - orderbook.1.<sym>  -> top of book (bid/ask) de referencia

Y por REST: info del instrumento (tick size), lista de símbolos, velas
históricas y últimos trades. Todo público (sin API keys).
"""
import asyncio
import json
import logging
from urllib.parse import urlencode

import requests
import websockets

log = logging.getLogger("bybit")


class BybitPublic:
    def __init__(self, cfg):
        self.cfg = cfg
        self.ws_url = cfg.ws_url()
        self.base = cfg.base_url()
        self.on_trade = None
        self.on_kline = None
        self.on_book = None
        self._running = False
        # intervalo base (Bybit) + factor de agregación para temporalidades personalizadas
        self.base_interval, self.custom_factor = cfg.interval_meta()
        self.base_minutes = int(self.base_interval) if self.custom_factor else 1
        self._bucket = None   # acumulador de klines base para el intervalo custom (WS)
        # [aggTrade] agrupación en memoria: ticks que comparten trade_id (i) y
        # timestamp (T) en el mismo milisegundo se consolidan en UN solo trade
        # (una orden contra varios niveles del libro no se desparrama en micro-ticks).
        self._agg_key = None
        self._agg = None

    # ---------------------------------------------------------------
    def topics(self):
        s = self.cfg.symbol
        return [f"publicTrade.{s}", f"kline.{self.base_interval}.{s}", f"orderbook.1.{s}"]

    async def run(self):
        self._running = True
        while self._running:
            try:
                async with websockets.connect(
                    self.ws_url,
                    ping_interval=20,
                    ping_timeout=25,
                    open_timeout=25,
                    max_size=2 ** 22,
                ) as ws:
                    await ws.send(json.dumps({"op": "subscribe", "args": self.topics()}))
                    log.info("WS conectado: %s %s", self.cfg.category, self.cfg.symbol)
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except Exception:
                            continue
                        self._dispatch(msg)
            except asyncio.CancelledError:
                self._running = False
                raise
            except Exception as e:
                log.warning("Error WS (%s) — reconectando en 3s...", e)
                await asyncio.sleep(3)

    def stop(self):
        self._running = False

    # ---------------------------------------------------------------
    def _dispatch(self, msg):
        topic = msg.get("topic", "")
        try:
            if topic.startswith("publicTrade") and self.on_trade:
                for t in msg.get("data", []):
                    self._feed_trade(t)
                # emitir el grupo agregado pendiente YA (al final de cada lote):
                # el primer tick del bucket nuevo llega al engine al instante =>
                # la vela cierra y la nueva abre en el segundo exacto del exchange,
                # sin esperar al siguiente evento/kline.
                self._flush_agg()
            elif topic.startswith("kline") and self.on_kline:
                self._flush_agg()
                data = msg.get("data", [])
                if data:
                    c = data[-1]
                    self._handle_kline(c)
            elif topic.startswith("orderbook.1") and self.on_book:
                self._flush_agg()
                b = msg.get("data", {})
                if b:
                    self.on_book(b)
        except Exception as e:
            log.warning("dispatch error: %s", e)

    def _flush_agg(self):
        """Emite el grupo agregado pendiente (si existe) como un solo trade."""
        if self._agg is not None and self.on_trade:
            self.on_trade(self._agg)
        self._agg = None
        self._agg_key = None

    def _feed_trade(self, t):
        """Consolida en memoria los ticks que comparten trade_id (i) y timestamp
        (T) del mismo milisegundo (aggTrade-like)."""
        try:
            key = (str(t.get("i") or ""), int(t.get("T") or 0))
        except (KeyError, TypeError, ValueError):
            self._flush_agg()
            self.on_trade(t)
            return
        if self._agg is not None and key == self._agg_key:
            # mismo grupo: sumar volumen, conservando el último precio y lado
            try:
                self._agg["v"] = str(float(self._agg["v"]) + float(t["v"]))
            except (KeyError, ValueError, TypeError):
                pass
            self._agg["p"] = t["p"]
            return
        # grupo nuevo: emitir el anterior y empezar uno
        self._flush_agg()
        self._agg_key = key
        self._agg = dict(t)

    # ---------------------------------------------------------------
    # Agregación de klines para intervalos personalizados (en vivo)
    # ---------------------------------------------------------------
    def _handle_kline(self, c):
        n = self.custom_factor
        if n is None or n <= 1:
            self.on_kline(c, c.get("confirm") is True)
            return
        step_ms = n * self.base_minutes * 60_000
        start = int(c["start"])
        bucket = (start // step_ms) * step_ms
        if self._bucket is None or self._bucket["start"] != bucket:
            # cerrar el bucket anterior (ya completo)
            if self._bucket is not None:
                self.on_kline(self._bucket_to_kline(self._bucket, True), True)
            self._bucket = {
                "start": bucket,
                "open": float(c["open"]), "high": float(c["high"]),
                "low": float(c["low"]), "close": float(c["close"]), "volume": float(c["volume"]),
            }
        else:
            b = self._bucket
            b["high"] = max(b["high"], float(c["high"]))
            b["low"] = min(b["low"], float(c["low"]))
            b["close"] = float(c["close"])
            b["volume"] += float(c["volume"])
        # emitir el bucket en curso (no confirmado) para que la vela se vaya formando
        self.on_kline(self._bucket_to_kline(self._bucket, False), False)

    def _bucket_to_kline(self, b, confirm):
        return {
            "start": str(b["start"]),
            "open": str(b["open"]), "high": str(b["high"]),
            "low": str(b["low"]), "close": str(b["close"]),
            "volume": str(b["volume"]), "confirm": confirm,
        }

    def _aggregate_history(self, klines, n):
        """Agrega klines base (cronológicos) en buckets de n*base_minutos minutos."""
        step_ms = n * self.base_minutes * 60_000
        out = []
        bucket = None
        for k in klines:
            ts = k["ts"]
            b0 = (ts // step_ms) * step_ms
            if bucket is None or bucket["ts"] != b0:
                if bucket is not None:
                    out.append(bucket)
                bucket = {"ts": b0, "open": k["open"], "high": k["high"],
                          "low": k["low"], "close": k["close"], "volume": k["volume"], "turnover": 0.0}
            else:
                bucket["high"] = max(bucket["high"], k["high"])
                bucket["low"] = min(bucket["low"], k["low"])
                bucket["close"] = k["close"]
                bucket["volume"] += k["volume"]
        if bucket is not None:
            out.append(bucket)
        return out

    # ---------------------------------------------------------------
    # REST helpers
    # ---------------------------------------------------------------
    def _get(self, path, params):
        url = f"{self.base}{path}?{urlencode(params)}"
        r = requests.get(url, timeout=20)
        r.raise_for_status()
        d = r.json()
        if d.get("retCode") != 0:
            raise RuntimeError(d.get("retMsg"))
        return d.get("result", {})

    def instrument_info(self):
        """tick size y precisiones del instrumento actual."""
        r = self._get("/v5/market/instruments-info", {
            "category": self.cfg.category,
            "symbol": self.cfg.symbol,
        })
        items = r.get("list", [])
        if not items:
            return {}
        it = items[0]
        pf = it.get("priceFilter", {}) or {}
        return {
            "symbol": it.get("symbol"),
            "tick_size": float(pf.get("tickSize", self.cfg.tick_size)),
            "min_price": float(pf.get("minPrice", 0)),
            "max_price": float(pf.get("maxPrice", 0)),
            "price_scale": int(pf.get("priceScale", 2) or 2),
        }

    def list_symbols(self, limit=500):
        """Lista de símbolos disponibles (para el buscador de la UI)."""
        r = self._get("/v5/market/instruments-info", {
            "category": self.cfg.category,
            "limit": str(limit),
        })
        out = []
        for it in r.get("list", []):
            out.append({
                "symbol": it.get("symbol"),
                "base": it.get("baseCoin"),
                "quote": it.get("quoteCoin"),
                "status": it.get("status"),
            })
        return out

    def fetch_klines(self, limit=500):
        """Velas OHLCV (con paginación) para el intervalo solicitado.

        Si la temporalidad es PERSONALIZADA (p.ej. 2m, 10m, 45m), se descarga el
        intervalo base divisor y se AGREGAn las velas al intervalo solicitado.
        """
        base, factor = self.base_interval, self.custom_factor
        raw = self._fetch_raw(base, limit * (factor or 1))
        if factor is not None and factor > 1:
            agg = self._aggregate_history(raw, factor)
            return agg[-limit:]
        return raw

    def _fetch_raw(self, interval, limit):
        """Paginación sobre el endpoint de klines con el intervalo base."""
        per_page = 1000
        limit = min(int(limit), 10000)
        raw = []
        end = None
        while len(raw) < limit:
            take = min(per_page, limit - len(raw))
            params = {
                "category": self.cfg.category,
                "symbol": self.cfg.symbol,
                "interval": interval,
                "limit": str(take),
            }
            if end is not None:
                params["end"] = str(end)
            r = self._get("/v5/market/kline", params)
            rows = r.get("list", [])
            if not rows:
                break
            raw.extend(rows)
            if len(rows) < take:
                break                     # ya no hay más velas
            end = int(rows[-1][0])        # siguiente lote termina en la vela más antigua
        # orden cronológico + dedupe por timestamp + recorte al límite
        seen = set()
        uniq = []
        for x in sorted(raw, key=lambda r0: int(r0[0])):
            if x[0] in seen:
                continue
            seen.add(x[0])
            uniq.append(x)
        uniq = uniq[-limit:]
        return [
            {
                "ts": int(x[0]),
                "open": float(x[1]),
                "high": float(x[2]),
                "low": float(x[3]),
                "close": float(x[4]),
                "volume": float(x[5]),
                "turnover": float(x[6]),
            }
            for x in uniq
        ]

    def recent_trades(self, limit=200):
        r = self._get("/v5/market/recent-trade", {
            "category": self.cfg.category,
            "symbol": self.cfg.symbol,
            "limit": str(limit),
        })
        return r.get("list", [])
