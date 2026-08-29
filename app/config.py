"""Configuración central del Mapa de Absorción.

Todos los valores críticos viven aquí (nada repartido por el código),
y pueden sobrescribirse con variables de entorno `ABS_*`.

El tick_size se autodetecta del instrumento (Bybit instruments-info);
solo se usa el de entorno como fallback.
"""
import os


def _f(name, default):
    try:
        return float(os.environ.get(name, default))
    except (ValueError, TypeError):
        return float(default)


def _i(name, default):
    try:
        return int(os.environ.get(name, default))
    except (ValueError, TypeError):
        return int(default)


class Config:
    def __init__(self):
        # --- Mercado ---
        self.symbol = os.environ.get("ABS_SYMBOL", "BTCUSDT")
        self.category = os.environ.get("ABS_CATEGORY", "linear")  # linear=perpetuo, spot
        self.interval = os.environ.get("ABS_INTERVAL", "5")       # minutos por slice
        self.tick_size = _f("ABS_TICK", 0.1)                      # fallback (autodetectado)
        self.history_limit = _i("ABS_HISTORY_LIMIT", 500)         # velas a cargar (rango)

        # --- Pesos del Score (deben sumar ~1.0) ---
        self.w_aggression = _f("ABS_W_AGGR", 0.25)
        self.w_volume = _f("ABS_W_VOL", 0.20)
        self.w_inefficiency = _f("ABS_W_INEF", 0.25)
        self.w_rejection = _f("ABS_W_REJ", 0.15)
        self.w_persistence = _f("ABS_W_PERS", 0.10)
        self.w_context = _f("ABS_W_CTX", 0.05)

        # --- Baseline robusto (volumen) ---
        self.baseline_window = _i("ABS_BASELINE_WIN", 300)   # slices de historia
        self.min_relative_volume = _f("ABS_MIN_RELVOL", 2.0)  # volumen >= Nx baseline
        self.min_volume_percentile = _f("ABS_MIN_PCT", 70.0)  # percentil mínimo

        # --- Delta / agresión ---
        self.min_delta_ratio = _f("ABS_MIN_DELTA_RATIO", 0.40)  # |delta|/total mínimo
        self.min_abs_volume = _f("ABS_MIN_ABS_VOL", 0.0)        # piso de volumen absoluto

        # --- Desplazamiento / eficiencia ---
        self.max_displacement_ticks = _i("ABS_MAX_DISPL", 4)   # ticks máx. para "precio congelado"

        # --- Confirmación (sin look-ahead) ---
        self.confirm_window_slices = _i("ABS_CONFIRM_WIN", 3)
        self.rejection_ticks = _i("ABS_REJECTION_TICKS", 5)

        # --- Zonas / agrupación espacial ---
        self.group_distance_ticks = _i("ABS_GROUP_TICKS", 4)    # fusionar niveles próximos
        self.min_zone_range_ticks = _i("ABS_MIN_RANGE_TICKS", 2)

        # --- Recencia / acumulación ---
        self.decay_halflife_sec = _f("ABS_DECAY_HALFLIFE", 7200.0)   # 2 horas
        self.accumulation_coef = _f("ABS_ACCUM_COEF", 5.0)            # A en A*log(1+N)

        # --- Salud / consumo / invalidación ---
        self.consumption_per_break = _f("ABS_CONS_BREAK", 18.0)   # % consumido por ruptura fuerte
        self.consumption_per_test = _f("ABS_CONS_TEST", 6.0)      # % por test normal
        self.invalid_break_ticks = _i("ABS_INVALID_BREAK_TICKS", 12)
        self.invalid_continuation_ticks = _i("ABS_INVALID_CONT_TICKS", 8)

        # --- Render ---
        self.noise_floor = _f("ABS_NOISE_FLOOR", 20.0)   # score < esto => no pintar
        self.max_render_zones = _i("ABS_MAX_ZONES", 60)
        self.color_stops = [
            (0.0, "#1e3a8a"),    # azul profundo (ruido / muy débil)
            (25.0, "#2563eb"),   # azul
            (45.0, "#06b6d4"),   # cian
            (55.0, "#22c55e"),   # verde
            (68.0, "#facc15"),   # amarillo
            (80.0, "#f97316"),   # naranja
            (92.0, "#ef4444"),   # rojo
            (100.0, "#dc2626"),  # rojo intenso
        ]

        # --- Capa 1: evaluación tick por tick ---
        self.tick_window_sec = _f("ABS_TICK_WIN", 2.0)        # ventana de micro-agregación
        self.tick_effort_threshold = _f("ABS_EFFORT", 1.5)    # E_tick > 1.5 => esfuerzo anómalo
        self.tick_displacement_threshold = _i("ABS_R_TICKS", 2)   # R_tick < 2 ticks => absorción local
        self.tick_disp_measure_sec = _f("ABS_R_MEASURE", 6.0) # ventana para medir desplazamiento posterior

        # --- Capa 2: evaluación vela por vela ---
        self.atr_period = _i("ABS_ATR", 20)
        self.zscore_window = _i("ABS_Z_WIN", 50)              # velas para el z-score de volumen

        # --- Capa 3: score final y saturación ---
        self.sat_rate = _f("ABS_SAT", 0.4)                    # S += 0.4*(100-S)*(Score/100)
        self.sigmoid_scale = _f("ABS_SIG", 0.6)               # escala del argumento de la sigmoide
        self.min_zone_score = _f("ABS_MIN_ZONE", 35.0)        # score mínimo para crear una zona

        # --- Footprint: agrupación de ticks por cluster ---
        self.cluster_step = _i("ABS_CLUSTER_STEP", 5)         # ticks por cluster (1,2,5,10,50,100)
        self.max_clusters_per_candle = _i("ABS_MAX_CLUSTERS", 100)

        # --- API (opcional, privadas) ---
        self.api_key = os.environ.get("ABS_API_KEY", "")
        self.api_secret = os.environ.get("ABS_API_SECRET", "")

    def ws_url(self):
        return (
            "wss://stream.bybit.com/v5/public/linear"
            if self.category == "linear"
            else "wss://stream.bybit.com/v5/public/spot"
        )

    # Intervalos que Bybit acepta realmente (en minutos) + D/W/M.
    STANDARD_MINUTES = [1, 3, 5, 15, 30, 60, 120, 240, 360, 720]
    STANDARD_INTERVALS = {"1", "3", "5", "15", "30", "60", "120", "240", "360", "720", "D", "W", "M"}

    def interval_meta(self):
        """(intervalo_base_bybit, factor_custom).

        - Intervalo estándar (1,3,5,...,720,D,W,M) -> (intervalo, None)
        - Intervalo personalizado en minutos (2, 10, 45, 180...) -> (base_divisora, factor)
          La base es el mayor intervalo estándar que divide exactamente al solicitado
          (p.ej. 10m -> base 5m x2; 45m -> base 15m x3; 3h=180m -> base 60m x3).
        """
        iv = self.interval
        if iv in self.STANDARD_INTERVALS:
            return iv, None
        try:
            n = int(iv)
        except (ValueError, TypeError):
            return "1", None
        if n < 1:
            n = 1
        if str(n) in self.STANDARD_INTERVALS:
            return str(n), None
        base = 1
        for b in self.STANDARD_MINUTES:
            if n % b == 0 and b > base:
                base = b
        return str(base), n // base

    def base_url(self):
        return "https://api.bybit.com"

    def decay_lambda(self):
        import math
        return math.log(2) / max(self.decay_halflife_sec, 1.0)

    def to_dict(self):
        return {
            "symbol": self.symbol,
            "category": self.category,
            "interval": self.interval,
            "tick_size": self.tick_size,
            "weights": {
                "aggression": self.w_aggression,
                "volume": self.w_volume,
                "inefficiency": self.w_inefficiency,
                "rejection": self.w_rejection,
                "persistence": self.w_persistence,
                "context": self.w_context,
            },
            "noise_floor": self.noise_floor,
            "group_distance_ticks": self.group_distance_ticks,
            "min_relative_volume": self.min_relative_volume,
            "cluster_step": self.cluster_step,
            "color_stops": self.color_stops,
        }


def load_config():
    return Config()
