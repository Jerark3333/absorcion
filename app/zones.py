"""Zone Manager (modelo: Tick -> Vela -> Zona -> Corte por barrido).

Cada zona = un nivel de precio con:
  - S_nivel por SATURACIÓN:
        S(t) = S(t-1) + 0.4 * (100 - S(t-1)) * (Score_Evento / 100)
  - nacimiento en la vela del evento (first_ts)
  - MITIGACIÓN: si una vela posterior cierra ATRAVESANDO el nivel
    (Close < Precio_Soporte  o  Close > Precio_Resistencia),
    la zona se corta en esa vela (last_ts = t_corte, state = Mitigated).
"""
import time

from .config import Config


def clamp(x, lo=0.0, hi=100.0):
    return max(lo, min(hi, x))


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def score_color(score, stops):
    if score <= stops[0][0]:
        return hex2rgb(stops[0][1])
    if score >= stops[-1][0]:
        return hex2rgb(stops[-1][1])
    for i in range(len(stops) - 1):
        lo_s, lo_c = stops[i]
        hi_s, hi_c = stops[i + 1]
        if lo_s <= score <= hi_s:
            t = (score - lo_s) / max(hi_s - lo_s, 1e-9)
            a, b = hex2rgb(lo_c), hex2rgb(hi_c)
            return tuple(round(a[j] + (b[j] - a[j]) * t) for j in range(3))
    return hex2rgb(stops[-1][1])


class Zone:
    def __init__(self, zid, direction, price, cfg: Config):
        self.id = zid
        self.direction = direction            # 'buy' (soporte) | 'sell' (resistencia)
        self.cfg = cfg
        self.price = price
        half = cfg.group_distance_ticks * cfg.tick_size
        self.center = price
        self.low = price - half
        self.high = price + half
        self.s = 0.0                          # S_nivel (saturación)
        self.first_ts = None                  # vela de nacimiento (t_inicio)
        self.last_ts = None                   # última actividad / t_corte
        self.mitigated = False
        self.events = 0
        self.total_volume = 0.0
        self.breakdown = {}
        self.source = "live"

    def add_event(self, score, volume, ts, breakdown):
        """Acumulación por saturación: S += 0.4*(100-S)*(Score/100)."""
        self.s = self.s + self.cfg.sat_rate * (100.0 - self.s) * (score / 100.0)
        self.events += 1
        self.total_volume += volume
        self.first_ts = ts if self.first_ts is None else min(self.first_ts, ts)
        self.last_ts = ts if self.last_ts is None else max(self.last_ts, ts)
        self.breakdown = breakdown

    def mitigate(self, ts):
        """Corte por barrido: una vela cerró atravesando el nivel."""
        self.mitigated = True
        self.last_ts = ts
        self.state = "Mitigated"

    def to_dict(self):
        state = "Mitigated" if self.mitigated else ("Active" if self.events else "Candidate")
        stops = self.cfg.color_stops
        rgb = score_color(self.s, stops)
        opacity = 0.15 + 0.85 * (0.35 if self.mitigated else 1.0)
        health = 35.0 if self.mitigated else clamp(100.0 - 4.0 * self.events, 20.0, 100.0)
        return {
            "id": self.id,
            "direction": self.direction,
            "center": round(self.center, 8),
            "low": round(self.low, 8),
            "high": round(self.high, 8),
            "state": state,
            "score": round(self.s, 1),
            "strength": round(self.s, 1),
            "health": round(health, 1),
            "activity": round(20.0 if self.mitigated else 100.0, 1),
            "consumption": round(100.0 if self.mitigated else 0.0, 1),
            "events": self.events,
            "confirmed": self.events,
            "reabsorptions": max(0, self.events - 1),
            "tests": 0,
            "volume": round(self.total_volume, 4),
            "buy_volume": 0.0,
            "sell_volume": 0.0,
            "delta": 0.0,
            "relvol": round(self.breakdown.get("e_tick", 0.0), 2),
            "pct": round(self.breakdown.get("z_vol", 0.0), 1),
            "inefficiency": round(self.breakdown.get("ineficiencia_vela", 0.0) * 50.0, 1),
            "breakdown": self.breakdown,
            "source": self.source,
            "color": f"rgba({rgb[0]},{rgb[1]},{rgb[2]},{opacity:.2f})",
            "glow": round(1.0 if not self.mitigated else 0.1, 2),
            "first_ts": self.first_ts,
            "last_ts": self.last_ts,
        }


class ZoneManager:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._zones = []
        self._zid = 0

    def _find_zone(self, direction, price):
        margin = self.cfg.group_distance_ticks * self.cfg.tick_size
        best, best_d = None, 1e18
        for z in self._zones:
            if z.direction != direction:
                continue
            if (z.low - margin) <= price <= (z.high + margin):
                d = abs(z.center - price)
                if d < best_d:
                    best, best_d = z, d
        return best

    def register_event(self, price, direction, score, volume, ts, breakdown, source="live"):
        if score < self.cfg.min_zone_score:
            return None
        zone = self._find_zone(direction, price)
        if zone is None:
            self._zid += 1
            zone = Zone(self._zid, direction, price, self.cfg)
            zone.source = source
            self._zones.append(zone)
        zone.add_event(score, volume, ts, breakdown)
        return zone

    def apply_slice(self, summary):
        """Corte por barrido: vela que cierra ATRAVESANDO el nivel => zona mitigada."""
        close = summary["close"]
        ts = summary["start"] / 1000.0
        for z in self._zones:
            if z.mitigated:
                continue
            if z.direction == "buy" and close < z.price:      # cerró bajo el soporte
                z.mitigate(ts)
            elif z.direction == "sell" and close > z.price:   # cerró sobre la resistencia
                z.mitigate(ts)

    def snapshot(self):
        out = [z.to_dict() for z in self._zones]
        out.sort(key=lambda x: x["score"], reverse=True)
        return out
