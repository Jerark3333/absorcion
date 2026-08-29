"""Orquestador del Mapa de Absorción — pipeline en 3 capas + corte por barrido.

Capa 1 (TICK POR TICK): ventanas de micro-agregación (~2s).
    E_tick(p)  = Vol_Agresivo(p) / Baseline_Volumen(p)
    R_tick(p)  = desplazamiento posterior del precio (ticks)
    Si E_tick > 1.5  y  R_tick < 2 ticks  -> absorción local en 'p' (sin look-ahead:
    el desplazamiento se mide en ventanas posteriores).

Capa 2 (VELA POR VELA): métricas estructurales al cerrar la vela.
    Delta_Vela   = Buy_Vol - Sell_Vol
    E_vela       = Z_Score(Volumen_Total_Vela)
    Despl_Neto   = |Close - Open| / ATR_20
    Mecha_Rechazo = mecha superior (resistencia) o inferior (soporte) / Range
    R_vela       = Despl_Neto / (1 + Mecha_Rechazo)
    Ineficiencia_Vela = E_vela * (1 - R_vela)

Capa 3 (SCORE + SATURACIÓN):
    Score_Evento = 100 * Sigmoide(E_tick * Ineficiencia_Vela)
    S_nivel(t)   = S_nivel(t-1) + 0.4 * (100 - S_nivel(t-1)) * (Score_Evento / 100)

Capa 4 (MATRIZ TIEMPO-PRECIO + CORTE):
    cada celda (tiempo, precio) guarda su S_nivel (heat_cells).
    la zona nace en t_inicio; si una vela posterior cierra atravesando el nivel,
    se marca MITIGADA y el dibujo se corta en t_corte.
"""
import logging
import math
import statistics
import time
import asyncio
from collections import deque

from .config import Config
from .features import FeatureEngine, clamp
from .memory import FOOTPRINT_CACHE, CACHE_MAX
from .zones import ZoneManager

log = logging.getLogger("engine")


class AbsorptionEngine:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.client = None   # referencia al cliente Bybit (REST, para reconciliación)
        self.features = FeatureEngine(cfg)
        self.zones = ZoneManager(cfg)
        # el gráfico retiene hasta 3000 velas (rango configurable vía history_limit)
        self.candles = deque(maxlen=max(400, min(cfg.history_limit, 3000)))

        # --- Capa 1: tick por tick ---
        self.tick_win = None                       # ventana actual: {start, price, levels}
        self.win_baseline = deque(maxlen=200)      # distribución global de volumen por nivel/ventana
        self.level_hist = {}                       # key -> deque(maxlen=12) (baseline por nivel)
        self.tick_pending = []                     # candidatos midiendo desplazamiento posterior
        self.tick_events = []                      # absorciones locales confirmadas (R < 2 ticks)

        # --- Capa 2: métricas de vela ---
        self.trs = deque(maxlen=max(cfg.atr_period, 5))
        self.prev_close = None
        self.candle_vols = deque(maxlen=cfg.zscore_window)
        self.vela = {"despl": 0.0, "e_vela": 0.0, "wick_lower": 0.0, "wick_upper": 0.0}

        # --- Capa 3/4: scores por nivel + matriz tiempo-precio ---
        self.level_s = {}                          # key -> S_nivel (saturación)
        self.heat_cells = {}                       # time_key(seg) -> {price_key: S}

        self.last_price = None
        self.book = None
        self.on_event = None

        # cachés de snapshot (se invalidan al cerrar vela / sembrar histórico)
        self._lean_candles = None
        self._heat_cache = None

        # footprint POR TICK de la vela en formación (se guarda al cerrarla en RAM)
        self._current_ticks = {}   # tick_key(1 tick) -> {"buy", "sell"}

    # ===============================================================
    # CAPA 1 — TICK POR TICK
    # ===============================================================
    def on_trade(self, t):
        closed = self.features.on_trade(t)
        if closed is False:
            # tick ATRASADO (bucket ya cerrado / reorden del exchange): se ignora
            # por completo — no entra en la vela activa ni en el buffer de ticks.
            return
        if closed is not None:
            # CIERRE POR TIMESTAMP DEL EXCHANGE: la vela saliente se congela e
            # inserta en el historial AHORA MISMO (sin esperar al kline, que
            # llega 2-3s tarde), se emite y se limpia el buffer de ticks.
            self._on_slice_closed(closed)
        try:
            price = float(t["p"])
            vol = float(t["v"])
        except (KeyError, ValueError, TypeError):
            return
        # Clasificación de agresividad (convención Bybit/Quantower):
        #   - Comprador agresivo (isBuyerMaker == False) -> ASK (verde)   [buy]
        #   - Vendedor agresivo  (isBuyerMaker == True)  -> BID (rojo)    [sell]
        m = t.get("m")
        if m is not None:
            agg_buy = not bool(m)
        else:
            try:
                agg_buy = t["S"] == "Buy"   # fallback: lado del taker (REST)
            except (KeyError, TypeError):
                return
        self.last_price = price
        # acumular footprint POR TICK (1 tick) para poder re-agrupar a cualquier garrapata
        tk = int(math.floor((price + 1e-9) / self.cfg.tick_size))
        slot = self._current_ticks.setdefault(tk, {"buy": 0.0, "sell": 0.0})
        if agg_buy:
            slot["buy"] += vol
        else:
            slot["sell"] += vol
        # [ABSORCIÓN DESACTIVADA] Capa 1 tick por tick:
        # self._tick_accumulate(price, side, vol)

    def _tick_accumulate(self, price, side, vol):
        now = time.time()
        if self.tick_win is None or now - self.tick_win["start"] >= self.cfg.tick_window_sec:
            if self.tick_win is not None:
                self._tick_evaluate(now)
            self.tick_win = {"start": now, "price": price, "levels": {}}
        w = self.tick_win
        w["price"] = price
        key = self.features._key(price)
        slot = w["levels"].get(key)
        if slot is None:
            slot = {"buy": 0.0, "sell": 0.0, "vol": 0.0}
            w["levels"][key] = slot
        slot["vol"] += vol
        if side == "Buy":
            slot["buy"] += vol
        else:
            slot["sell"] += vol

    def _level_baseline(self, key):
        hl = self.level_hist.get(key)
        if hl and len(hl) >= 3:
            return max(statistics.median(hl), 1e-9)
        if self.win_baseline:
            return max(statistics.median(self.win_baseline), 1e-9)
        return 1e-6

    def _tick_evaluate(self, now):
        w = self.tick_win
        ref = w["price"]
        # 1) E_tick por nivel (baseline ANTES de incluir esta ventana => sin look-ahead)
        candidates = []
        for key, slot in w["levels"].items():
            baseline = self._level_baseline(key)
            E = slot["vol"] / baseline
            if E > self.cfg.tick_effort_threshold:
                direction = "buy" if slot["sell"] >= slot["buy"] else "sell"
                candidates.append({
                    "key": key,
                    "price": self.features._price(key),
                    "E": min(E, 10.0),
                    "vol": slot["vol"],
                    "direction": direction,
                    "detected": now,
                    "max_disp": 0.0,
                })
        # 2) alimentar historiales (después de evaluar)
        for key, slot in w["levels"].items():
            self.win_baseline.append(slot["vol"])
            hl = self.level_hist.setdefault(key, deque(maxlen=12))
            hl.append(slot["vol"])
        # 3) medir desplazamiento posterior (R_tick) de pendientes previos
        still = []
        for pend in self.tick_pending:
            disp = abs(ref - pend["price"]) / self.cfg.tick_size
            if disp >= self.cfg.tick_displacement_threshold:
                continue                            # el precio se movió -> breakout, se descarta
            pend["max_disp"] = max(pend["max_disp"], disp)
            if now - pend["detected"] >= self.cfg.tick_disp_measure_sec:
                self.tick_events.append(pend)       # R < 2 ticks -> absorción local CONFIRMADA
                continue
            still.append(pend)
        self.tick_pending = still + candidates
        self.tick_win = None

    def on_book(self, b):
        try:
            self.book = {"bid": float(b["b"][0][0]), "ask": float(b["a"][0][0])}
        except Exception:
            pass

    # ===============================================================
    # CAPA 2 — VELA POR VELA
    # ===============================================================
    def on_kline(self, c, confirmed):
        closed = self.features.on_kline(c, confirmed)
        if closed:
            self._on_slice_closed(closed)

    def _on_slice_closed(self, closed):
        summary, levels = closed["summary"], closed["levels"]
        candle = {
            "time": int(summary["start"] // 1000),
            "open": summary["open"], "high": summary["high"],
            "low": summary["low"], "close": summary["close"],
            "volume": round(summary["volume"], 4),
            "step": self.features.cluster_step_price(),
            "clusters": self._clusters_from_levels(levels),
        }
        # INTEGRIDAD MATEMÁTICA: si la vela tiene clusters, su volumen total se
        # deriva de la suma de los clusters (Bid + Ask), garantizando que
        #   Σ(bids) + Σ(asks) == volumen total de la vela.
        if candle["clusters"]:
            candle["volume"] = round(sum(c["bid"] + c["ask"] for c in candle["clusters"]), 4)
        # [AUDITORÍA TEMPORAL] diagnóstico crudo al cerrar la vela (cruce de volumen):
        _vol_clusters = round(sum(c["bid"] + c["ask"] for c in candle["clusters"]), 4) if candle["clusters"] else 0.0
        print(f"[AUDIT] cierre vela time={candle['time']} O={candle['open']} H={candle['high']} "
              f"L={candle['low']} C={candle['close']} tick={self.cfg.tick_size} "
              f"cluster_step={self.cfg.cluster_step} step_vela={candle['step']} "
              f"n_clusters={len(candle['clusters'])} vol_candle={candle['volume']} vol_clusters={_vol_clusters}")
        print(f"[AUDIT] clusters consolidados: "
              f"{ {c['price']: {'bid': c['bid'], 'ask': c['ask']} for c in candle['clusters']} }")
        # IMPORTANTE: el seed histórico incluye la vela EN FORMACIÓN; al cerrarse,
        # si ya existe con ese timestamp, se REEMPLAZA (no se duplica). Velas con el
        # mismo time rompen lightweight-charts (setData) y hacen "desaparecer" velas.
        if self.candles and self.candles[-1]["time"] == candle["time"]:
            self.candles[-1] = candle
        else:
            self.candles.append(candle)
        # guardar el footprint POR TICK en RAM (módulo-global): permite re-agrupar
        # a cualquier garrapata aunque cambie la config en esta misma sesión.
        cache_key = f"{self.cfg.symbol}|{self.cfg.interval}|{candle['time']}"
        FOOTPRINT_CACHE[cache_key] = {
            "ohlc": {"open": candle["open"], "high": candle["high"],
                     "low": candle["low"], "close": candle["close"], "volume": candle["volume"]},
            "ticks": self._current_ticks,
        }
        if len(FOOTPRINT_CACHE) > CACHE_MAX:
            oldest = min(FOOTPRINT_CACHE, key=lambda k: int(k.rsplit("|", 1)[1]))
            FOOTPRINT_CACHE.pop(oldest, None)
        self._current_ticks = {}
        self._invalidate_caches()
        # [ABSORCIÓN DESACTIVADA] Capas 2-4 (vela, score, mitigación):
        # self._candle_metrics(summary)
        # self._score_tick_events(summary)
        # self.zones.apply_slice(summary)
        # while len(self.heat_cells) > 300:
        #     self.heat_cells.pop(next(iter(self.heat_cells)))
        self._emit({"type": "candle", "candle": candle})
        # RECONCILIACIÓN EXACTA tick-por-tick al cierre (REST oficial de Bybit),
        # en 2º plano: se re-consultan los trades del minuto exacto de la vela y
        # se re-agrupan sin estimaciones; se re-emite con los clusters oficiales.
        try:
            asyncio.get_running_loop().create_task(self._reconcile_candle(candle))
        except Exception:
            pass

    def _invalidate_caches(self):
        self._lean_candles = None
        self._heat_cache = None

    def _clusters_from_levels(self, levels):
        """Matriz agrupada por cluster: {price, bid, ask, delta, is_poc}.

        Los niveles llegan con la MISMA cuadrícula absoluta de features._key
        (cluster_price = floor(price/step_size)*step_size); aquí se consolidan
        y ORDENAN por cluster_price exacto antes del payload JSON al frontend.
        """
        clusters = []
        for L in levels:
            if L["total"] <= 0:
                continue
            clusters.append({
                "price": L["price"],
                "bid": round(L["sell"], 3),
                "ask": round(L["buy"], 3),
                "delta": round(L["buy"] - L["sell"], 3),
                "is_poc": False,
            })
        if not clusters:
            return clusters
        clusters.sort(key=lambda x: x["price"], reverse=True)   # consolidación/orden High->Low
        if len(clusters) > self.cfg.max_clusters_per_candle:
            # conservar los de mayor volumen total
            clusters.sort(key=lambda x: x["bid"] + x["ask"], reverse=True)
            clusters = clusters[:self.cfg.max_clusters_per_candle]
            clusters.sort(key=lambda x: x["price"], reverse=True)
        mt = max(c["bid"] + c["ask"] for c in clusters)
        for c in clusters:
            if c["bid"] + c["ask"] == mt:
                c["is_poc"] = True
        return clusters

    def _candle_metrics(self, s):
        tr = s["high"] - s["low"]
        if self.prev_close is not None:
            tr = max(tr, abs(s["high"] - self.prev_close), abs(s["low"] - self.prev_close))
        self.trs.append(tr)
        self.prev_close = s["close"]
        self.atr = statistics.mean(self.trs) if len(self.trs) >= 2 else (tr or 1e-9)
        # z-score del volumen de la vela
        self.candle_vols.append(s["volume"])
        if len(self.candle_vols) >= 8:
            mean = statistics.mean(self.candle_vols)
            std = statistics.pstdev(self.candle_vols) or 1e-9
            z = (s["volume"] - mean) / std
        else:
            z = 0.0
        e_vela = max(z, 0.0)
        despl = abs(s["close"] - s["open"]) / max(self.atr, 1e-9)
        rng = max(s["high"] - s["low"], 1e-9)
        body_lo, body_hi = min(s["open"], s["close"]), max(s["open"], s["close"])
        self.vela = {
            "despl": despl,
            "e_vela": e_vela,
            "wick_lower": (body_lo - s["low"]) / rng,
            "wick_upper": (s["high"] - body_hi) / rng,
        }

    def _ineficiencia_for(self, direction):
        """R_vela = Despl_Neto / (1 + Mecha_Rechazo); Ineficiencia = E_vela*(1 - R_vela)."""
        v = self.vela
        wick = v["wick_lower"] if direction == "buy" else v["wick_upper"]
        r_vela = v["despl"] / (1.0 + wick)
        return v["e_vela"] * max(0.0, 1.0 - r_vela)

    # ===============================================================
    # CAPA 3 — SCORE FINAL + SATURACIÓN POR NIVEL
    # ===============================================================
    def _score_tick_events(self, summary):
        t_key = int(summary["start"] // 1000)
        for ev in self.tick_events:
            inef = self._ineficiencia_for(ev["direction"])
            x = self.cfg.sigmoid_scale * ev["E"] * inef
            # sigmoide desplazada: 0 cuando x=0 (ineficiencia 0 => score 0)
            score = clamp(200.0 * (1.0 / (1.0 + math.exp(-x)) - 0.5), 0.0, 100.0)
            if score < self.cfg.noise_floor:
                continue
            key = self.features._key(ev["price"])
            S = self.level_s.get(key, 0.0)
            S = S + self.cfg.sat_rate * (100.0 - S) * (score / 100.0)
            self.level_s[key] = S
            cells = self.heat_cells.setdefault(t_key, {})
            cells[key] = round(S, 2)
            bd = {
                "aggression": round(min(100.0, ev["E"] * 33.0), 1),
                "volume": round(min(100.0, self.vela["e_vela"] * 33.0), 1),
                "inefficiency": round(min(100.0, inef * 50.0), 1),
                "rejection": round(clamp(100.0 - self.vela["despl"] * 50.0, 0.0, 100.0), 1),
                "persistence": round(min(100.0, S * 0.5), 1),
                "context": 50.0,
                "e_tick": round(ev["E"], 2),
                "ineficiencia_vela": round(inef, 3),
                "r_vela": round(inef / self.vela["e_vela"], 3) if self.vela["e_vela"] > 0 else 0.0,
                "z_vol": round(self.vela["e_vela"], 2),
                "desplazamiento": round(self.vela["despl"], 3),
                "score": round(score, 1),
            }
            self.zones.register_event(ev["price"], ev["direction"], score, ev["vol"], t_key, bd)
        self.tick_events = []

    # ===============================================================
    # CAPA 4 — MATRIZ TIEMPO-PRECIO / HEATMAP
    # ===============================================================
    def heatmap(self):
        """Por nivel: S_nivel máximo, ventana temporal [first_ts, last_ts] y corte por mitigación."""
        per = {}
        for t_key, cells in self.heat_cells.items():
            for key, S in cells.items():
                rec = per.setdefault(key, {"price": self.features._price(key), "s": 0.0,
                                           "first": t_key, "last": t_key, "mit": False})
                rec["s"] = max(rec["s"], S)
                rec["first"] = min(rec["first"], t_key)
                rec["last"] = max(rec["last"], t_key)
        for z in self.zones._zones:
            key = self.features._key(z.center)
            rec = per.get(key)
            if rec is None:
                rec = per[key] = {"price": z.center, "s": z.s, "first": z.first_ts,
                                  "last": z.last_ts, "mit": z.mitigated}
            rec["s"] = max(rec["s"], z.s)
            if z.first_ts is not None:
                rec["first"] = min(rec["first"], z.first_ts)
            if z.mitigated and z.last_ts is not None:
                rec["last"] = min(rec.get("last") or z.last_ts, z.last_ts)
                rec["mit"] = True
        if not per:
            return []
        max_s = max(r["s"] for r in per.values()) or 1.0
        out = [{
            "price": r["price"],
            "intensity": round(clamp((r["s"] / max_s) ** 0.7, 0.0, 1.0), 3),
            "first_ts": r["first"],
            "last_ts": r["last"],
            "mitigated": r["mit"],
        } for r in per.values()]
        out.sort(key=lambda x: x["price"])
        if len(out) > 500:
            step = len(out) / 500
            out = [out[int(i * step)] for i in range(500)]
        return out

    # ===============================================================
    # HISTÓRICO (velas con footprint persistente + bootstrap por ticks reales)
    # ===============================================================
    def on_recent_trade(self, t):
        """Normaliza el formato REST recent-trade {price, size, side} -> {p, v, S}."""
        try:
            self.on_trade({"p": str(t.get("price")), "S": t.get("side"), "v": str(t.get("size"))})
        except Exception:
            pass

    def _aggregate_ticks(self, ticks):
        """Re-agrupa el footprint POR TICK en clusters según el cluster_step ACTUAL.

        ANCLAJE DE REJILLA por REDONDEO SIMÉTRICO (igual que Quantower):
          step_size     = tick_size * cluster_step
          k             = round(price / step_size)   # nivel más cercano
          cluster_price = k * step_size              # casilla exacta de la grilla
        Cada trade se asigna a la casilla MÁS CERCANA (sin truncado flotante ni
        desfases de media fila); el +1e-9 hace determinista la frontera .5.
        """
        step_size = self.cfg.tick_size * self.cfg.cluster_step
        if step_size <= 0:
            step_size = 1e-9
        buckets = {}
        for tk, s in ticks.items():
            price = tk * self.cfg.tick_size
            k = int(round((price + 1e-9) / step_size))
            b = buckets.setdefault(k, {"buy": 0.0, "sell": 0.0})
            b["buy"] += s["buy"]
            b["sell"] += s["sell"]
        clusters = []
        for k, b in buckets.items():
            cluster_price = round(k * step_size, 4)
            clusters.append({
                "price": cluster_price,
                "bid": round(b["sell"], 3),
                "ask": round(b["buy"], 3),
                "delta": round(b["buy"] - b["sell"], 3),
                "is_poc": False,
            })
        if not clusters:
            return clusters
        # CONSOLIDACIÓN por cluster_price exacto + orden High -> Low antes del JSON
        clusters.sort(key=lambda x: x["price"], reverse=True)
        if len(clusters) > self.cfg.max_clusters_per_candle:
            clusters.sort(key=lambda x: x["bid"] + x["ask"], reverse=True)
            clusters = clusters[:self.cfg.max_clusters_per_candle]
            clusters.sort(key=lambda x: x["price"], reverse=True)
        mt = max(c["bid"] + c["ask"] for c in clusters)
        for c in clusters:
            if c["bid"] + c["ask"] == mt:
                c["is_poc"] = True
        # [AUDITORÍA TEMPORAL] diagnóstico crudo del re-agrupado por ticks:
        print(f"[AUDIT] _aggregate_ticks tick={self.cfg.tick_size} cluster_step={self.cfg.cluster_step} "
              f"step_size={step_size} n_clusters={len(clusters)}")
        print(f"[AUDIT] _aggregate_ticks clusters: "
              f"{ {c['price']: {'bid': c['bid'], 'ask': c['ask']} for c in clusters} }")
        return clusters

    def _reconcile_aggregate(self, trades, start_ms, end_ms):
        """Re-agrupa EXACTAMENTE una lista oficial de trades de Bybit dentro del
        rango [start_ms, end_ms) de la vela. Sin ratios ni repartos: cada contrato
        se suma a su casilla de precio MÁS CERCANA (redondeo simétrico
        round(price/step)*step; compra->ASK, venta->BID)."""
        step_size = self.cfg.tick_size * self.cfg.cluster_step
        if step_size <= 0:
            step_size = 1e-9
        buckets = {}
        for t in trades:
            try:
                tm = int(t.get("time") or t.get("execTime") or 0)
                if not (start_ms <= tm < end_ms):
                    continue
                price = float(t.get("price") or t.get("p"))
                size = float(t.get("size") or t.get("qty") or t.get("v") or 0)
                side = t.get("side") or t.get("S")
                agg_buy = (side == "Buy")
                k = int(round((price + 1e-9) / step_size))
                b = buckets.setdefault(k, {"buy": 0.0, "sell": 0.0})
                if agg_buy:
                    b["buy"] += size
                else:
                    b["sell"] += size
            except (KeyError, ValueError, TypeError):
                continue
        clusters = []
        for k, b in buckets.items():
            clusters.append({
                "price": round(k * step_size, 4),
                "bid": round(b["sell"], 3),
                "ask": round(b["buy"], 3),
                "delta": round(b["buy"] - b["sell"], 3),
                "is_poc": False,
            })
        if not clusters:
            return clusters
        clusters.sort(key=lambda x: x["price"], reverse=True)   # High -> Low
        if len(clusters) > self.cfg.max_clusters_per_candle:
            clusters.sort(key=lambda x: x["bid"] + x["ask"], reverse=True)
            clusters = clusters[:self.cfg.max_clusters_per_candle]
            clusters.sort(key=lambda x: x["price"], reverse=True)
        mt = max(c["bid"] + c["ask"] for c in clusters)
        for c in clusters:
            if c["bid"] + c["ask"] == mt:
                c["is_poc"] = True
        return clusters

    async def _reconcile_candle(self, candle):
        """Reemplaza los clusters de la vela cerrada con la lista OFICIAL de trades
        de Bybit (REST 'recent-trade') dentro del minuto exacto de esa vela."""
        if candle is None or self.client is None:
            return
        try:
            interval_ms = self.features._candle_ms()
        except Exception:
            interval_ms = 0
        if interval_ms <= 0:
            return   # D/W/M (bordes de calendario): sin reconciliación
        start_ms = int(candle["time"]) * 1000
        end_ms = start_ms + interval_ms
        try:
            trades = await asyncio.to_thread(self.client.recent_trades, 1000)
        except Exception as e:
            log.warning("reconcile recent_trades falló: %s", e)
            return
        reconciled = self._reconcile_aggregate(trades, start_ms, end_ms)
        if not reconciled:
            return
        # guarda de integridad: si la reconciliación resultara incompleta (menos
        # volumen que el footprint local, p. ej. por truncado del endpoint a 1000
        # trades), se conserva el local (ya exacto) en lugar de perder datos.
        local_total = sum(float(c.get("bid", 0)) + float(c.get("ask", 0)) for c in candle.get("clusters", []))
        rec_total = sum(float(c.get("bid", 0)) + float(c.get("ask", 0)) for c in reconciled)
        if rec_total + 1e-6 < local_total:
            return
        candle["clusters"] = reconciled
        # el volumen de la vela también se alinea a la suma oficial reconciliada:
        # Σ(bids) + Σ(asks) == volumen total (idéntico al reportado por Bybit)
        candle["volume"] = round(sum(c["bid"] + c["ask"] for c in reconciled), 4)
        if self.candles and self.candles[-1]["time"] == candle["time"]:
            self.candles[-1] = candle
        self._emit({"type": "candle", "candle": candle})

    def seed_historical(self, klines, recent_trades=None):
        cfg = self.cfg
        for c in klines:
            t_key = int(c["ts"] // 1000)
            cache_key = f"{cfg.symbol}|{cfg.interval}|{t_key}"
            saved = FOOTPRINT_CACHE.get(cache_key)
            if saved is not None:
                # footprint REAL de la sesión: re-agrupar a la garrapata actual
                clusters = self._aggregate_ticks(saved["ticks"])
                candle = {
                    "time": t_key,
                    "open": saved["ohlc"]["open"], "high": saved["ohlc"]["high"],
                    "low": saved["ohlc"]["low"], "close": saved["ohlc"]["close"],
                    "volume": saved["ohlc"]["volume"],
                    "step": self.features.cluster_step_price(),
                    "clusters": clusters,
                }
            else:
                # sin datos exactos en RAM: clusters vacío (no se inventan proporciones)
                candle = {
                    "time": t_key,
                    "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"],
                    "volume": round(c["volume"], 4),
                    "step": self.features.cluster_step_price(),
                    "clusters": [],
                }
            self.candles.append(candle)
        # 2) bootstrap: reconstruir el footprint de la vela reciente con ticks REALES
        #    de Bybit REST (recent-trade) antes de que llegue el flujo del WebSocket
        if recent_trades:
            for t in recent_trades:
                self.on_recent_trade(t)
        # [ABSORCIÓN DESACTIVADA] escaneo histórico de zonas (estructura conservada):
        # window = 30
        # registered = 0
        # for i, c in enumerate(klines):
        #     summary = {"start": c["ts"], "open": c["open"], "high": c["high"],
        #                "low": c["low"], "close": c["close"], "volume": c["volume"]}
        #     self._candle_metrics(summary)
        #     lo_i = max(0, i - window)
        #     win = [k["volume"] for k in klines[lo_i:i]]
        #     if len(win) < 5:
        #         continue
        #     baseline = statistics.median(win)
        #     relvol = c["volume"] / max(baseline, 1e-9)
        #     if relvol < 1.5:
        #         continue
        #     o, h, l, cl = c["open"], c["high"], c["low"], c["close"]
        #     rng = h - l
        #     if rng / cfg.tick_size < cfg.min_zone_range_ticks:
        #         continue
        #     body_lo, body_hi = min(o, cl), max(o, cl)
        #     lower_wick, upper_wick = body_lo - l, h - body_hi
        #     wick_ratio = max(lower_wick, upper_wick) / rng if rng > 0 else 0.0
        #     if wick_ratio < 0.20:
        #         continue
        #     direction = "buy" if lower_wick >= upper_wick else "sell"
        #     price = l if direction == "buy" else h
        #     inef = self._ineficiencia_for(direction)
        #     x = cfg.sigmoid_scale * min(relvol, 10.0) * inef
        #     score = clamp(200.0 * (1.0 / (1.0 + math.exp(-x)) - 0.5), 0.0, 100.0)
        #     if score < cfg.noise_floor:
        #         continue
        #     t_key = int(c["ts"] // 1000)
        #     key = self.features._key(price)
        #     S = self.level_s.get(key, 0.0)
        #     S = S + cfg.sat_rate * (100.0 - S) * (score / 100.0)
        #     self.level_s[key] = S
        #     cells = self.heat_cells.setdefault(t_key, {})
        #     cells[key] = round(S, 2)
        #     bd = {...}
        #     self.zones.register_event(price, direction, score, c["volume"] * wick_ratio, t_key, bd, source="hist")
        #     registered += 1
        self._invalidate_caches()
        return 0

    # ===============================================================
    def live_candle(self):
        """Vela en formación (OHLC + clusters en vivo) para el footprint actual."""
        m = self.features.meta
        if m is None or m.get("start") is None:
            return None
        return {
            "time": int(m["start"] // 1000),
            "open": m["open"], "high": m["high"], "low": m["low"], "close": m["close"],
            "volume": round(m.get("volume", 0.0), 4),
            "step": self.features.cluster_step_price(),
            "clusters": self.features.live_clusters(),
        }

    def snapshot(self, include_clusters=True):
        if include_clusters:
            candles = list(self.candles)
        else:
            # caché: las velas "ligeras" solo cambian al cerrar vela, no cada segundo
            if self._lean_candles is None:
                self._lean_candles = [{k: v for k, v in c.items() if k != "clusters"} for c in self.candles]
            candles = self._lean_candles
        return {
            "config": self.cfg.to_dict(),
            # [ABSORCIÓN DESACTIVADA] zonas/heatmap vacíos; estructura conservada:
            # "zones": self.zones.snapshot(),
            # "heat": self._heat(),
            "zones": [],
            "heat": [],
            "absorptions": [],
            "candles": candles,
            "levels": self.features.live_levels(),
            "live_candle": self.live_candle(),
            "last_price": self.last_price,
            "book": self.book,
        }

    def _heat(self):
        # el heatmap solo cambia al cerrar vela; se cachea entre slices
        if self._heat_cache is None:
            self._heat_cache = self.heatmap()
        return self._heat_cache

    def _emit(self, ev):
        if self.on_event:
            try:
                self.on_event(ev)
            except Exception as e:
                log.warning("emit error: %s", e)
