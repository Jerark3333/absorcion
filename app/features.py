"""Feature Engine.

Agrega los trades en slices (velas) y calcula, por nivel de precio
normalizado a tick, las características usadas por el motor de absorción:

  - volumen absoluto, relativo y percentil histórico (baseline robusto)
  - delta y delta_ratio (con el lado agresor que ya entrega Bybit)
  - agresión 0-100 (desequilibrio + anomalía de volumen + percentil)
  - desplazamiento en ticks y eficiencia del precio (vs movimiento esperado)
"""
import math
import statistics
from collections import deque

from .config import Config


def clamp(x, lo=0.0, hi=100.0):
    return max(lo, min(hi, x))


class FeatureEngine:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.tick = cfg.tick_size
        self.current = None          # footprint: key_int -> {"buy","sell","bn","sn"}
        self.meta = None             # open/high/low/close/volume/start
        # baseline robusto
        self.slice_medians = deque(maxlen=cfg.baseline_window)      # mediana nivel/slice
        self.slice_ticks_per_vol = deque(maxlen=cfg.baseline_window)
        # distribución global de volumen por nivel (histograma log) -> percentiles
        self._lo, self._hi, self._step = -8.0, 6.0, 0.05
        self._nbin = int(round((self._hi - self._lo) / self._step))
        self._edges = [self._lo + i * self._step for i in range(self._nbin + 1)]
        self._counts = [0] * self._nbin
        self._n_obs = 0

    # ---------------------------------------------------------------
    def _key(self, p):
        # Anclaje de rejilla por REDONDEO SIMÉTRICO (igual que Quantower):
        #   banda_paso = tick_size * cluster_step
        #   cluster    = round(precio / banda_paso)   # casilla MÁS CERCANA
        banda = self.tick * self.cfg.cluster_step
        if banda <= 0:
            banda = 1e-9
        return int(round((p + 1e-9) / banda))

    def _price(self, k):
        banda = self.tick * self.cfg.cluster_step
        if banda <= 0:
            banda = 1e-9
        return round(k * banda, 4)

    def cluster_step_price(self):
        return round(self.tick * self.cfg.cluster_step, 8)

    def _candle_ms(self):
        """Duración de la vela en ms, para alinear aperturas por TIMESTAMP del
        exchange: candle_start = (trade_time // candle_ms) * candle_ms.

        Solo intervalos con duración fija y límites en múltiplos exactos
        (intradiarios estándar y personalizados). D/W/M usan cierres de
        calendario (no múltiplos fijos) => se devuelve 0 y el cierre queda
        gobernado por el kline del exchange.
        """
        try:
            base, factor = self.cfg.interval_meta()
            if not str(base).isdigit():
                return 0
            mins = int(base)
            return int(mins * 60000 * (factor or 1))
        except Exception:
            return 0

    def _bin(self, v):
        import bisect
        if v <= 0:
            return 0
        x = math.log10(v)
        i = bisect.bisect_right(self._edges, x) - 1
        return clamp(i, 0, self._nbin - 1)

    def _percentile(self, v):
        if self._n_obs < 20:
            return 50.0
        i = self._bin(v)
        below = sum(self._counts[:i]) + self._counts[i] * 0.5
        return clamp(below / self._n_obs * 100.0, 0.0, 100.0)

    # ---------------------------------------------------------------
    def on_trade(self, t):
        try:
            price = float(t["p"])
            vol = float(t["v"])
            trade_time = int(t.get("T") or t.get("trade_time") or 0)
        except (KeyError, TypeError, ValueError):
            return None
        # Clasificación de agresividad idéntica a la del engine (isBuyerMaker):
        #   - Comprador agresivo (isBuyerMaker == False) -> ASK (verde)   [buy]
        #   - Vendedor agresivo  (isBuyerMaker == True)  -> BID (rojo)    [sell]
        m = t.get("m")
        if m is not None:
            agg_buy = not bool(m)
        else:
            try:
                agg_buy = t["S"] == "Buy"   # fallback: lado del taker (REST)
            except (KeyError, TypeError):
                return None
        # (1) APERTURA/CIERRE POR TIMESTAMP DEL EXCHANGE (NUNCA reloj local):
        #   candle_start = (trade_time // candle_duration_ms) * candle_duration_ms
        candle_ms = self._candle_ms()
        candle_start = (trade_time // candle_ms) * candle_ms if (trade_time > 0 and candle_ms > 0) else None
        closed = None
        if (candle_start is not None
                and self.meta is not None and self.meta.get("start") is not None):
            if candle_start < self.meta["start"]:
                # (2) TICK ATRASADO / REORDEN (bucket ya cerrado, cruzó el :00):
                # NO se mete en la vela activa ni se re-abre el bucket anterior —
                # evita descalzar la atribución tick->vela (Time Bucket).
                return False
            if candle_start > self.meta["start"]:
                # (1) tick de la vela NUEVA (avance de bucket): congelar e
                # insertar la saliente AHORA MISMO
                closed = self._close_slice()
        if self.current is None:
            self.current = {}
        if self.meta is None:
            # nueva vela: se crea inmediatamente con este primer tick
            self.meta = {"open": price, "high": price, "low": price, "close": price,
                         "volume": 0.0, "start": candle_start}
        elif self.meta.get("start") is None and candle_start is not None:
            self.meta["start"] = candle_start
        meta = self.meta
        meta["close"] = price
        meta["high"] = max(meta["high"], price)
        meta["low"] = min(meta["low"], price)
        meta["volume"] += vol
        key = self._key(price)
        slot = self.current.get(key)
        if slot is None:
            slot = {"buy": 0.0, "sell": 0.0, "bn": 0, "sn": 0}
            self.current[key] = slot
        if agg_buy:
            slot["buy"] += vol
            slot["bn"] += 1
        else:
            slot["sell"] += vol
            slot["sn"] += 1
        return closed

    # ---------------------------------------------------------------
    def on_kline(self, c, confirmed):
        """Devuelve la slice cerrada (con features) si corresponde, o None."""
        start = int(c["start"])
        # kline de una vela YA superada por el cierre por timestamp de los ticks:
        # no se vuelve a cerrar nada (evita doble cierre y velas vacías).
        if self.meta is not None and self.meta.get("start") is not None and start < self.meta["start"]:
            return None
        closed = None
        if self.meta is not None and self.meta["start"] is not None and self.meta["start"] != start:
            closed = self._close_slice()
        if self.current is None:
            self.current = {}
        self.meta = {
            "open": float(c["open"]), "high": float(c["high"]),
            "low": float(c["low"]), "close": float(c["close"]),
            "volume": float(c["volume"]), "start": start,
        }
        if confirmed and closed is None:
            closed = self._close_slice()
        return closed

    # ---------------------------------------------------------------
    def _close_slice(self):
        if self.meta is None or self.meta["start"] is None:
            self.current = {}
            self.meta = None
            return None
        m = self.meta
        levels = []
        base_med = self._baseline_median()
        exp_ticks_per_vol = self._expected_ticks_per_vol()
        total_slice = m["volume"] or 0.0
        for key, slot in self.current.items():
            feats = self._level_features(key, slot, m, base_med, exp_ticks_per_vol, total_slice)
            levels.append(feats)
            # alimentar histograma y métricas por nivel
            self._add_obs(slot["buy"] + slot["sell"])
        # métricas del slice para el baseline
        if levels:
            lv = sorted(x["total"] for x in levels)
            self.slice_medians.append(statistics.median(lv))
        rng_ticks = (m["high"] - m["low"]) / self.tick if total_slice > 0 else 0.0
        if total_slice > 0:
            self.slice_ticks_per_vol.append(rng_ticks / total_slice)
        summary = {
            "start": m["start"], "open": m["open"], "high": m["high"],
            "low": m["low"], "close": m["close"], "volume": total_slice,
            "range_ticks": rng_ticks, "nlevels": len(levels),
            "baseline": base_med, "exp_ticks_per_vol": exp_ticks_per_vol,
        }
        self.current = {}
        self.meta = None
        return {"summary": summary, "levels": levels}

    def _baseline_median(self):
        if self.slice_medians:
            return max(statistics.median(self.slice_medians), 1e-9)
        return 1e-6

    def _expected_ticks_per_vol(self):
        if not self.slice_ticks_per_vol:
            return 0.0
        return statistics.median(self.slice_ticks_per_vol)

    def _add_obs(self, v):
        i = self._bin(v)
        self._counts[i] += 1
        self._n_obs += 1

    # ---------------------------------------------------------------
    def _level_features(self, key, slot, m, base_med, exp_ticks_per_vol, total_slice):
        cfg = self.cfg
        buy, sell = slot["buy"], slot["sell"]
        total = buy + sell
        delta = buy - sell
        price = self._price(key)
        delta_ratio = (delta / total) if total > 0 else 0.0
        relvol = total / base_med if base_med > 0 else 0.0
        pct = self._percentile(total)

        # agresión 0-100 (magnitud de presión direccional)
        imbalance = abs(delta_ratio)
        rel_norm = clamp(relvol / 5.0, 0.0, 1.0)
        pct_norm = clamp((pct - 50.0) / 50.0, 0.0, 1.0)
        aggression = 100.0 * clamp(0.45 * imbalance + 0.30 * rel_norm + 0.25 * pct_norm, 0.0, 1.0)

        # fuerza de volumen 0-100 (absoluto + relativo + percentil)
        abs_norm = clamp(total / max(base_med * 10.0, 1e-9), 0.0, 1.0)
        vol_strength = 100.0 * clamp(0.4 * rel_norm + 0.3 * (pct / 100.0) + 0.3 * abs_norm, 0.0, 1.0)

        # desplazamiento y eficiencia
        movement_ticks = abs(m["close"] - price) / self.tick
        expected_ticks = max(exp_ticks_per_vol * total, 1e-6)
        efficiency = movement_ticks / expected_ticks
        inefficiency = 100.0 * clamp(1.0 - efficiency, 0.0, 1.0)

        # concentración (qué fracción del slice se ejecutó aquí)
        concentration = (total / total_slice) if total_slice > 0 else 0.0

        return {
            "key": key, "price": price, "buy": buy, "sell": sell,
            "bn": slot["bn"], "sn": slot["sn"], "total": total, "delta": delta,
            "delta_ratio": delta_ratio, "relvol": relvol, "pct": pct,
            "aggression": aggression, "vol_strength": vol_strength,
            "movement_ticks": movement_ticks, "expected_ticks": expected_ticks,
            "inefficiency": inefficiency, "concentration": concentration,
        }

    # ---------------------------------------------------------------
    def live_levels(self, n=18):
        if not self.current or self.meta is None:
            return []
        base_med = self._baseline_median()
        out = []
        for key, slot in self.current.items():
            buy, sell = slot["buy"], slot["sell"]
            out.append({
                "price": self._price(key), "buy": buy, "sell": sell,
                "delta": buy - sell, "total": buy + sell,
                "relvol": (buy + sell) / base_med if base_med > 0 else 0.0,
            })
        out.sort(key=lambda x: abs(x["delta"]), reverse=True)
        return out[:n]

    def live_clusters(self):
        """Clusters (bid/ask/delta/is_poc) de la vela EN FORMACIÓN."""
        if not self.current:
            return []
        clusters = []
        for key, slot in self.current.items():
            buy, sell = slot["buy"], slot["sell"]
            clusters.append({
                "price": self._price(key),
                "bid": round(sell, 3),
                "ask": round(buy, 3),
                "delta": round(buy - sell, 3),
                "is_poc": False,
            })
        if not clusters:
            return clusters
        clusters.sort(key=lambda x: x["price"], reverse=True)   # High -> Low (Quantower)
        if len(clusters) > self.cfg.max_clusters_per_candle:
            clusters.sort(key=lambda x: x["bid"] + x["ask"], reverse=True)
            clusters = clusters[:self.cfg.max_clusters_per_candle]
            clusters.sort(key=lambda x: x["price"], reverse=True)
        mt = max(c["bid"] + c["ask"] for c in clusters)
        for c in clusters:
            if c["bid"] + c["ask"] == mt:
                c["is_poc"] = True
        return clusters
