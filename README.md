# Mapa de Absorción — BYBIT

Plataforma de **order flow / footprint** que dibuja bandas de calor horizontales
("zonas de absorción") en los niveles de precio donde existe evidencia cuantificable
de absorción institucional: **agresión anómala + volumen anómalo + baja eficiencia
del desplazamiento + rechazo**.

Datos 100% reales de BYBIT en tiempo real (WebSocket público, sin API keys).

## Cómo funciona (motor matemático)

El motor NO pinta "mucho volumen = absorción". Sigue la lógica:

```
AGRESIÓN ANORMAL × VOLUMEN ANORMAL × BAJA EFICIENCIA × INCAPACIDAD DE CONTINUAR
  + RECHAZO + REPETICIÓN + PERSISTENCIA − CONSUMO  =  EVIDENCIA DE ABSORCIÓN
```

Pipeline (arquitectura por capas):

1. **Data** — trades reales de BYBIT (cada trade trae el lado agresor `Buy/Sell`).
2. **Feature Engine** (`app/features.py`) — agrega por nivel de precio (tick real):
   - volumen absoluto, relativo y **percentil histórico** (baseline robusto con mediana)
   - `delta` y `delta_ratio`
   - `aggression` (0–100)
   - desplazamiento en ticks y **PriceEfficiency** (agresión vs movimiento esperado)
3. **Absorption Engine** (`app/engine.py`) — detecta candidatos **sin look-ahead**:
   - comprador: sell agresivo + delta negativo + precio no cae → candidato a **soporte**
   - vendedor: buy agresivo + delta positivo + precio no sube → candidato a **resistencia**
   - `InitialScore` al detectar; `ConfirmationScore` después del **rechazo** (ventana temporal)
4. **Zone Manager** (`app/zones.py`) — agrupa niveles próximos, acumula eventos con
   **rendimientos decrecientes** (`A·log(1+N)`), **recencia** (`e^(−λt)`), calidad ponderada,
   `StrengthScore` (histórica) vs `CurrentScore` (actual).
5. **Zone Health** — consumo, tests, reabsorción, invalidación y estados
   (`Candidate → Confirmed → Active → Tested → Reabsorbed → Weakened → Consumed → Invalidated`).

### Visual (cómo leer el mapa)

| Señal visual | Significado |
|---|---|
| Color | `CurrentScore` (0–20 invisible, azul→verde→amarillo→naranja→rojo→rojo intenso) |
| Opacidad | `LiquidityHealth` (zona fuerte vs agotada) |
| Brillo | `CurrentActivity` (activa ahora vs histórica) |
| Grosor de banda | rango real de precio donde se concentró el volumen |
| Línea punteada central | nivel de máxima concentración |

Al pasar el cursor sobre una banda se ve el **desglose completo** del score
(agresión, volumen, ineficiencia, rechazo, persistencia, contexto).

## Arrancar

```bat
python -m pip install -r requirements.txt
python run.py
```

Abre **http://127.0.0.1:8899** (o doble clic en `run.bat`).

## Uso de la plataforma

- **Cambiar símbolo**: escribe en el buscador (p. ej. `ETHUSDT`) y Enter o clic.
- **Cambiar temporalidad**: botones 1m · 3m · 5m · 15m · 30m · 1h · 4h · 1D.
- **Herramientas de dibujo** (columna izquierda): tendencia, línea h/v, rectángulo,
  texto, retroceso Fibonacci, medir, borrar.
- Crosshair con etiqueta de precio y tooltip de zona al posarse sobre una banda.

## Configuración (variables de entorno `ABS_*`)

| Variable | Default | Descripción |
|---|---|---|
| `ABS_SYMBOL` / `ABS_CATEGORY` / `ABS_INTERVAL` | `BTCUSDT` / `linear` / `5` | mercado |
| `ABS_MIN_RELVOL` | `2.0` | volumen ≥ N× baseline para ser anomalía |
| `ABS_MIN_PCT` | `70` | percentil mínimo de volumen |
| `ABS_MIN_DELTA_RATIO` | `0.40` | desequilibrio buy/sell mínimo (evita "equilibrio") |
| `ABS_MAX_DISPL` | `4` | ticks máx. de "precio congelado" |
| `ABS_W_AGGR/VOL/INEF/REJ/PERS/CTX` | pesos del score (suman 1) |
| `ABS_DECAY_HALFLIFE` | `7200` | vida media de recencia (s) |
| `ABS_ACCUM_COEF` | `5.0` | `A` en la acumulación `A·log(1+N)` |
| `ABS_NOISE_FLOOR` | `20` | score mínimo para pintar |
| `ABS_GROUP_TICKS` | `4` | agrupación espacial de niveles |

Ejemplo: `set ABS_SYMBOL=ETHUSDT & set ABS_MIN_RELVOL=3 & python run.py`

## Estructura

```
Absorcion/
├─ run.py / run.bat / requirements.txt
├─ app/
│  ├─ config.py        # configuración central (pesos, umbrales, colores)
│  ├─ bybit_client.py  # WebSocket + REST públicos de BYBIT
│  ├─ features.py      # Feature Engine
│  ├─ zones.py         # Zone Manager + Zone Health
│  ├─ engine.py        # Absorption Engine (orquestador)
│  ├─ server.py        # FastAPI + WebSocket + cambio de símbolo/temporalidad
│  └─ static/          # plataforma web (index.html, style.css, app.js, lightweight-charts.js)
```

## Notas honestas

- **Tiempo real**: footprint **exacto** (cada trade trae su lado agresor).
- **Histórico**: BYBIT no regala tick-data con lado bid/ask, así que el escaneo
  histórico **aproxima** las zonas por los *mechazos* de las velas OHLCV (marcadas
  `hist`). Para histórico 100% exacto haría falta el feed de tick de pago.
- El motor es **determinista** (sin ML), como recomienda la especificación; deja
  los eventos listos para un análisis/calibración estadística posterior.
