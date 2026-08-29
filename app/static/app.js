/* Mapa de Absorción — plataforma */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ===============================================================
  // CONFIG GLOBAL DEL USUARIO — leída SÍNCRONAMENTE ANTES de cualquier
  // llamada a la API o dibujo del DOM inicial (carga instantánea, sin
  // parpadeo de estado fallback al mutar el estado tras leer almacenamiento).
  // ===============================================================
  const DEFAULT_USER_CONFIG = {
    timeframe: "1m",
    ticks: 60,
    activeIndicators: { volume: true },
    indicatorSettings: { volume: { colorUp: "#089981", colorDown: "#f23645" } },
  };
  function _loadUserConfig() {
    try {
      const raw = localStorage.getItem("app_user_config");
      if (raw) return { ...DEFAULT_USER_CONFIG, ...JSON.parse(raw) };
      // retro-compat: config antigua por claves separadas
      const tf = localStorage.getItem("user_timeframe");
      const ticks = parseInt(localStorage.getItem("user_custom_ticks"), 10);
      if (tf) return { ...DEFAULT_USER_CONFIG, timeframe: tf, ticks: ticks || DEFAULT_USER_CONFIG.ticks };
    } catch (_) {}
    return { ...DEFAULT_USER_CONFIG };
  }
  let userConfig = _loadUserConfig();

  // Convierte la temporalidad ("1m","5m","1h","1D") al intervalo crudo del
  // backend ("1","5","60","D"), o pasa directo el intervalo crudo si ya lo es.
  function _tfToInterval(tf) {
    if (tf == null) return "1";
    const s = String(tf).trim();
    if (/^D$/i.test(s)) return "D";
    if (/^W$/i.test(s)) return "W";
    if (/^M$/i.test(s)) return "M";
    const m = s.match(/^(\d+)\s*(m|M|h|H|min|hrs?)$/);
    if (m) { const n = parseInt(m[1], 10); return /h/i.test(m[2]) ? String(n * 60) : String(n); }
    const n = parseInt(s, 10);
    if (!isNaN(n)) return String(n);
    return s;
  }

  // ---------------------------------------------------------------
  // Gráfico
  // ---------------------------------------------------------------
  const chart = LightweightCharts.createChart($("chart"), {
    autoSize: true,
    layout: {
      background: { type: "solid", color: "rgba(0,0,0,0)" },
      textColor: "#787b86",
      fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif",
    },
    grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
    // Zoom out LIBERADO: minBarSpacing bajo (2px) permite alejar el gráfico con la
    // rueda hasta mostrar cientos de velas en modo Vela Japonesa estándar (Canvas).
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2a2e39", rightOffset: 8, minBarSpacing: 2 },
    rightPriceScale: { borderColor: "#2a2e39" },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "#565b6b", width: 1, style: 3, labelBackgroundColor: "#2962ff" },
      horzLine: { color: "#565b6b", width: 1, style: 3, labelBackgroundColor: "#2962ff" },
    },
  });

  const candles = chart.addCandlestickSeries({
    upColor: "#26a69a", downColor: "#ef5350",
    borderVisible: false, wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    // la línea de precio la dibujamos nosotros (para que llegue hasta la vela en formación)
    priceLineVisible: false,
    lastValueVisible: false,
  });

  // DESACOPLAMIENTO DE REJILLA: se desactiva SOLO la rejilla vertical nativa de la
  // librería; las líneas verticales se dibujan manualmente en #overlay usando las
  // MISMAS X de las velas (cero descalce al arrastrar). El eje horizontal (fechas)
  // y la rejilla horizontal siguen 100% nativos.
  chart.applyOptions({ grid: { vertLines: { visible: false } } });

  // ---------------------------------------------------------------
  // Canvas de overlay (dibujos) + heatmap (fondo)
  // ---------------------------------------------------------------
  const chartEl = $("chart");
  const overlay = $("overlay");
  const ctx = overlay.getContext("2d");
  const heatCanvas = $("heatmap");
  const hctx = heatCanvas.getContext("2d");

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = chartEl.clientWidth, h = chartEl.clientHeight;
    for (const [c, cx] of [[overlay, ctx], [heatCanvas, hctx]]) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // ---------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------
  const state = { zones: [], levels: [], candles: [], config: null, price: null, book: null, symbol: "BTCUSDT", interval: _tfToInterval(userConfig.timeframe), heat: [] };
  const candleMap = new Map();   // time(seg) -> candle (con clusters)
  // Velas YA cerradas (congeladas): un live_candle atrasado con uno de estos
  // tiempos NO debe sobrescribir los clusters finales (transición limpia de vela).
  const finalizedTimes = new Set();
  // [AUDITORÍA TEMPORAL] vela bajo inspección (debug en consola; eliminar después)
  let debugCandleTime = null;
  let debugCandleLogged = false;
  // Indicador de Volumen (sub-gráfico): serie histograma + visibilidad
  let volumeSeries = null;
  let volumeVisible = true;
  let origVolumeMargins = null;   // márgenes originales del pane de velas
  // Subplot Delta (panel independiente debajo del gráfico)
  const deltaCanvas = $("delta-panel");
  const dctx = deltaCanvas ? deltaCanvas.getContext("2d") : null;
  const deltaCfg = { showValues: true, mode: "bars", colorUp: "#089981", colorDown: "#F23645" };
  // Estado global de indicadores activos (persiste al cambiar de temporalidad)
  const activeIndicators = { volume: !!userConfig.activeIndicators.volume, volume_delta: !!userConfig.activeIndicators.volume_delta };

  // Catálogo formal de indicadores disponibles (genera el menú 'Indicadores').
  const availableIndicators = [
    { id: "volume", name: "Volumen (Vol)", category: "General", enabled: false, options: {} },
    {
      id: "volume_delta",
      name: "Volume Delta",
      category: "Order Flow",
      enabled: false,
      options: { showLabels: true },
    },
  ];
  let zoneFilter = 0;   // umbral de filtro por color (score)

  // ---- Configuración visual (localStorage) ----
  const DEFAULT_CONFIG = {
    showPoc: true,
    showDelta: true,
    showNumbers: true,
    showPriceLine: true,
    showTimer: true,
    colorDeltaPos: "#22c98a",
    colorDeltaNeg: "#ef5350",
    colorPoc: "#ffd600",
    colorBid: "#ffd600",
    colorAsk: "#00e676",
    fontSize: 10,
    deltaOpacity: 1,
    deltaWidth: 1,
  };
  let chartConfig = loadChartConfig();
  function loadChartConfig() {
    try {
      const raw = localStorage.getItem("chartConfig");
      if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (_) {}
    return { ...DEFAULT_CONFIG };
  }
  function saveChartConfig() {
    try { localStorage.setItem("chartConfig", JSON.stringify(chartConfig)); } catch (_) {}
  }

  // ---------------------------------------------------------------
  // [ABSORCIÓN DESACTIVADA] escala de color / filtro por score (estructura conservada):
  const DEFAULT_STOPS = [[0, "#1e3a8a"], [25, "#2563eb"], [45, "#06b6d4"], [55, "#22c55e"], [68, "#facc15"], [80, "#f97316"], [92, "#ef4444"], [100, "#dc2626"]];
  function renderLegend() {
    const el = $("heat-legend");
    if (!el) return;
    const stops = (state.config && state.config.color_stops) ? state.config.color_stops : DEFAULT_STOPS;
    const parts = stops.map((s) => `${s[1]} ${s[0]}%`);
    el.style.background = `linear-gradient(to right, ${parts.join(",")})`;
  }

  function setFilter(v) {
    v = Math.max(0, Math.min(100, Number(v) || 0));
    zoneFilter = v;
    const sl = $("heat-slider"), va = $("heat-value");
    if (sl) sl.value = v;
    if (va) va.value = v;
    renderZones();
    requestRender();
  }

  const heatSlider = $("heat-slider");
  const heatValue = $("heat-value");
  if (heatSlider) heatSlider.addEventListener("input", () => setFilter(heatSlider.value));
  if (heatValue) heatValue.addEventListener("input", () => setFilter(heatValue.value));

  // ---------------------------------------------------------------
  // Render (desacoplado: se dibuja en el ciclo del navegador, máx ~60 FPS)
  // ---------------------------------------------------------------
  // Pase de dibujo ÚNICO y ATÓMICO del Canvas propio (single render pass):
  // todo se dibuja síncronamente, sin esperas ni rAF intermedios, en el MISMO
  // frame que lightweight-charts pinta la rejilla/velas nativas.
  // ---------------------------------------------------------------
  // Rejilla vertical MANUAL en #overlay: las líneas se dibujan usando las MISMAS
  // X de las velas (baseX / timeToCoordinate) => rejilla y velas en el MISMO
  // canvas, misma función y mismo offset (cero descalce al arrastrar).
  // Una línea cada ~90px (según el ancho de vela actual), con la estética nativa.
  function drawGridLines(w, h) {
    const bs = getBarSpacing();
    if (bs < 1) return;
    const vr = chart.timeScale().getVisibleRange();
    if (!vr) return;
    const step = Math.max(1, Math.round(90 / Math.max(bs, 1)));
    ctx.strokeStyle = "#1e222d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    let i = 0;
    for (const c of state.candles) {
      const ts = (typeof c.time === "number" && c.time > 2000000000) ? Math.floor(c.time / 1000) : c.time;
      if (ts < vr.from || ts > vr.to) continue;
      if (i % step !== 0) { i++; continue; }
      i++;
      let x = null;
      if (isDragging && dragBaseX) {
        x = dragBaseX.has(ts) ? dragBaseX.get(ts) : (chart.timeScale().timeToCoordinate(ts) - dragOffsetX);
      } else {
        x = chart.timeScale().timeToCoordinate(ts);
      }
      if (x == null || isNaN(x)) continue;
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    ctx.stroke();
  }

  function drawScene() {
    resizeCanvas();
    const w = chartEl.clientWidth, h = chartEl.clientHeight;
    // (durante el arrastre) actualizar el offset de CÁMARA una vez por frame,
    // derivado del mapeo real de la librería: rejilla y velas comparten el MISMO
    // desplazamiento en píxeles.
    if (isDragging && dragBaseX && dragRefTime != null && dragRefX0 != null) {
      const cur = chart.timeScale().timeToCoordinate(dragRefTime);
      if (cur != null && isFinite(cur)) dragOffsetX = cur - dragRefX0;
    }
    // 1. Fondo estático (heatmap)
    renderHeat(w, h);
    // 2. Limpiar el Canvas de overlay por completo
    ctx.clearRect(0, 0, w, h);   // limpieza TOTAL del lienzo en cada frame
    // reset de estilos por frame: evita que sombras/anchuras de línea residuales
    // de otros dibujos se filtren al footprint (texto nítido, sin sobreedición)
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1;
    // 3. Rejilla: la pinta lightweight-charts (canvas nativo) en este mismo frame
    // 4. CÁMARA (single render pass): ctx.translate aplica el offset en píxeles a
    //    TODAS las velas por igual — se dibujan en coordenadas ESTÁTICAS (baseX)
    //    y la cámara las desplaza como una sola imagen pegada a la rejilla.
    ctx.save();
    if (isDragging) ctx.translate(dragOffsetX, 0);
    drawGridLines(w, h);      // rejilla vertical en las X de las velas (mismo offset)
    drawFootprints(w, h);     // velas (mismo baseX)
    ctx.restore();
    // 5. Superpuestos (coordenadas vivas, sin cámara): línea de precio, dibujos
    drawPriceLine(w, h);
    drawDrawings(w, h);
    updatePriceTimer();
    // Subplot Delta: se pinta en el MISMO frame que el footprint (misma cámara)
    drawDeltaPanel();
  }

  function render() {
    drawScene();
  }

  let rafPending = false;
  function requestRender() {
    // coalesce varias peticiones en un solo frame del navegador
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  // ===============================================================
  // FOOTPRINT (estilo Quantower) — activo al hacer zoom
  // ===============================================================
  const FOOTPRINT_ZOOM = 8;    // (conservado) px mínimos originales
  const FOOTPRINT_ZOOM_THRESHOLD = 15;  // umbral de CAMBIO DE MODO: <15px = velas japonesas, >=15px = footprint
  const FOOTPRINT_TEXT_ZOOM = 32;  // ancho mínimo de vela (px) para mostrar el texto de volúmenes; por debajo se oculta
  const MIN_CANDLE_WIDTH_FOR_TEXT = 45;  // umbral ABSOLUTO: por debajo de este ancho NO se dibujan los números
  let lastFpMode = false;

  function getBarSpacing() {
    try {
      const o = chart.timeScale().options();
      if (o && o.barSpacing) return o.barSpacing;
    } catch (_) {}
    try {
      const lr = chart.timeScale().getVisibleLogicalRange();
      const ps = chart.paneSize ? chart.paneSize() : null;
      if (lr && ps && lr.to > lr.from) return ps.width / (lr.to - lr.from + 1);
    } catch (_) {}
    return 6;
  }

  function fmtVol(v) {
    if (v == null || isNaN(v)) return "";
    return String(Math.round(v * 1000) / 1000);
  }

  function updateCandleVisibility(bs) {
    // < umbral: velas japonesas NATIVAS visibles (modo estándar, ultra-ligero).
    // >= umbral: se ocultan las velas nativas y se dibuja el footprint en Canvas.
    const fp = bs >= FOOTPRINT_ZOOM_THRESHOLD;
    if (fp === lastFpMode) return;
    lastFpMode = fp;
    candles.applyOptions({
      upColor: fp ? "rgba(38,166,154,0)" : "#26a69a",
      downColor: fp ? "rgba(239,83,80,0)" : "#ef5350",
      wickUpColor: fp ? "rgba(38,166,154,0)" : "#26a69a",
      wickDownColor: fp ? "rgba(239,83,80,0)" : "#ef5350",
      borderVisible: !fp,
    });
  }

  function drawFootprints(w, h) {
    const bs = getBarSpacing();
    updateCandleVisibility(bs);
    const vr = chart.timeScale().getVisibleRange();
    if (!vr) return;
    const fontSize = Math.max(8, Math.min(14, chartConfig.fontSize || 10));   // tamaño configurable
    ctx.save();
    ctx.font = `${fontSize}px 'Segoe UI', system-ui, sans-serif`;
    const candleWidth = bs; // ancho en píxeles de cada vela en pantalla
    for (const c of state.candles) {
      // conversión segura: el backend envía segundos; si llegara en ms/string, normalizar
      const ts = (typeof c.time === "number" && c.time > 2000000000) ? Math.floor(c.time / 1000) : c.time;
      if (ts < vr.from || ts > vr.to) continue;
      let x = null;
      if (isDragging && dragBaseX) {
        // coordenadas ESTÁTICAS (baseX): la cámara (ctx.translate) aplica el offset
        // en píxeles a todas las velas por igual (sin timeToX por vela durante el drag)
        x = dragBaseX.has(ts) ? dragBaseX.get(ts) : (chart.timeScale().timeToCoordinate(ts) - dragOffsetX);
      } else {
        x = chart.timeScale().timeToCoordinate(ts);
      }
      if (x == null || isNaN(x)) continue;
      if (candleWidth < FOOTPRINT_ZOOM_THRESHOLD) {
        // === MODO VELA JAPONESA ESTÁNDAR (zoom out) ===
        // Se DIBUJA FÍSICAMENTE en el Canvas: mecha High→Low + cuerpo sólido
        // Open→Close con los colores clásicos de TradingView.
        drawJapaneseCandle(c, x, bs);
        continue;
      }
      // === MODO FOOTPRINT (zoom in) ===
      const clusters = c.clusters;
      if (!clusters || !clusters.length) {
        // sin clusters: dibujar una vela básica para que NUNCA desaparezca
        drawFallbackCandle(c, x, bs);
        continue;
      }
      drawFootprintCandle(c, clusters, x, bs, w);
    }
    ctx.restore();
  }

  // Línea de precio punteada: desde la vela EN FORMACIÓN hacia la derecha (eje Y/label).
  function drawPriceLine(w, h) {
    if (!chartConfig.showPriceLine) return;
    if (state.price == null) return;
    const y = candles.priceToCoordinate(state.price);
    if (y == null) return;
    // punto de inicio = posición de la vela en formación (si existe), sino el borde izquierdo
    let xStart = 0;
    if (state.liveTime != null) {
      const lx = chart.timeScale().timeToCoordinate(state.liveTime);
      if (lx != null) xStart = Math.max(Math.min(lx, w), 0);
    }
    ctx.save();
    ctx.strokeStyle = _prevTimerPrice != null && state.price < _prevTimerPrice ? "#ef5350" : "#26a69a";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(xStart, y);
    ctx.lineTo(w, y);   // se dibuja hasta el borde derecho (hacia el eje Y)
    ctx.stroke();
    ctx.restore();
  }

  function drawFallbackCandle(c, x, bs) {
    const half = Math.max(bs / 2 - 1, 3);
    const highP = candles.priceToCoordinate(c.high);
    const lowP = candles.priceToCoordinate(c.low);
    if (highP == null || lowP == null) return;
    const bull = c.close >= c.open;
    const bodyTopP = candles.priceToCoordinate(Math.max(c.open, c.close));
    const bodyBotP = candles.priceToCoordinate(Math.min(c.open, c.close));
    ctx.strokeStyle = bull ? "#26a69a" : "#ef5350";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, highP); ctx.lineTo(x, bodyTopP == null ? highP : Math.min(bodyTopP, highP));
    ctx.moveTo(x, lowP); ctx.lineTo(x, bodyBotP == null ? lowP : Math.max(bodyBotP, lowP));
    ctx.stroke();
    if (bodyTopP != null && bodyBotP != null) {
      ctx.fillStyle = bull ? "#26a69a" : "#ef5350";
      ctx.fillRect(x - half, bodyTopP, half * 2, Math.max(bodyBotP - bodyTopP, 1));
    }
  }

  // Vela japonesa estándar DIBUJADA FÍSICAMENTE en el Canvas (modo zoom out,
  // cuando candleWidth < FOOTPRINT_ZOOM_THRESHOLD).
  // 1) Mecha: línea vertical desde High hasta Low.
  // 2) Cuerpo: rectángulo sólido desde Open hasta Close (mínimo 1px para Doji).
  function drawJapaneseCandle(c, x, bs) {
    const candleWidth = bs;
    const candleXCenter = x;
    const candleLeft = candleXCenter - candleWidth / 2;
    const yHigh = candles.priceToCoordinate(c.high);
    const yLow = candles.priceToCoordinate(c.low);
    if (yHigh == null || yLow == null) return;
    const yOpen = candles.priceToCoordinate(c.open);
    const yClose = candles.priceToCoordinate(c.close);
    if (yOpen == null || yClose == null) return;
    const isBull = c.close >= c.open;
    const color = isBull ? "#089981" : "#F23645";
    // 1) Mecha: de High a Low
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(candleXCenter, yHigh);
    ctx.lineTo(candleXCenter, yLow);
    ctx.stroke();
    // 2) Cuerpo sólido: de Open a Close
    ctx.fillStyle = color;
    const topY = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(Math.abs(yOpen - yClose), 1);
    ctx.fillRect(candleLeft, topY, candleWidth, bodyHeight);
  }

  function drawFootprintCandle(c, clusters, x, bs, w) {
    const step = c.step || 1;
    const highP = candles.priceToCoordinate(c.high);
    const lowP = candles.priceToCoordinate(c.low);
    if (highP == null || lowP == null) return;
    const bull = c.close >= c.open;
    // Layout Quantower: números (bid|ask) en la vela + ESPACIO FIJO a la derecha
    // (entre velas) donde vive el histograma de Delta.
    const deltaSlotW = Math.max(42, Math.min(70, bs * 0.75));   // hueco fijo del Delta (aún más separación)
    const deltaGap = 6;                                          // espacio entre el Delta y la vela siguiente
    const candleNumW = Math.max(bs - deltaSlotW, 8);            // columna de números de la vela
    const numL = x - candleNumW / 2, numR = x + candleNumW / 2;
    const dSlotL = numR, dSlotR = numR + deltaSlotW;            // hueco del Delta (fuera de la vela)
    const bodyTopP = candles.priceToCoordinate(Math.max(c.open, c.close));
    const bodyBotP = candles.priceToCoordinate(Math.min(c.open, c.close));
    const rows = clusters.slice().sort((a, b) => b.price - a.price);
    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.delta)), 1e-9);
    const m = (ctx.font.match(/(\d+)px/) || [null, 10]);
    const fpx = Number(m[1]) || 10;
    const baseFont = `${fpx}px 'Segoe UI', system-ui, sans-serif`;
    const wickColor = bull ? "#26a69a" : "#ef5350";

    // 1) MECHA CENTRAL primera: línea vertical de High a Low (divide bid|ask).
    const drawWick = () => {
      ctx.strokeStyle = wickColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, highP);
      ctx.lineTo(x, lowP);
      ctx.stroke();
    };
    drawWick();

    // 2) Filas con ALTURA UNIFORME = niveles de cluster CONSOLIDADOS (cuadrícula
    //    absoluta por REDONDEO al nivel más cercano, igual que el backend/
    //    Quantower): el nº de bloques es EXACTAMENTE el de cluster_price distintos
    //    (kMax - kMin + 1), nunca "bandas tocadas" high-low + 1 => sin filas
    //    fantasma (4 bloques, no 5). Cada celda tiene su espacio Y independiente.
    const banda = step;
    let kMin = Infinity, kMax = -Infinity;
    for (const cl of rows) {
      const k = Math.round((cl.price + 1e-9) / banda);
      if (k < kMin) kMin = k;
      if (k > kMax) kMax = k;
    }
    if (!isFinite(kMin) || !isFinite(kMax)) {
      kMin = Math.round((c.low + 1e-9) / banda);   // respaldo: rango OHLC
      kMax = Math.round((c.high + 1e-9) / banda);
    }
    const numRows = Math.max(1, kMax - kMin + 1);   // nº de niveles consolidados
    const yHighPx = Math.min(highP, lowP);        // píxel del High (arriba)
    const yLowPx = Math.max(highP, lowP);         // píxel del Low (abajo)
    const candleH = Math.max(yLowPx - yHighPx, 1);
    const rowH = candleH / numRows;
    // [AUDITORÍA TEMPORAL] acumulador de coordenadas fillText de la vela auditada
    const debugFill = [];

    for (let i = 0; i < rows.length; i++) {
      const cl = rows[i];
      // Índice de fila sobre la cuadrícula EXACTA del backend (redondeo al nivel
      // más cercano): 0 = fila superior (cluster más alto). Cada cluster_price
      // cae en su propia fila.
      const kPrice = Math.round((cl.price + 1e-9) / banda);
      let idx = kMax - kPrice;
      idx = Math.max(0, Math.min(numRows - 1, idx));
      const yTop = Math.floor(yHighPx + idx * rowH);   // alineado a píxel entero
      const rh = Math.max(Math.floor(rowH), 1);
      const yBot = yTop + rh;
      const clusterHeight = Math.abs(yBot - yTop);   // altura REAL de la celda (px)
      // (1) VALIDACIÓN DE ALTURA: si la fila no alcanza FONT_SIZE + PADDING_VERTICAL
      // de alto, los números NO se dibujan (evita que el texto se encime con las
      // celdas vecinas).
      const PADDING_VERTICAL = 2;                     // aire vertical mínimo alrededor del texto
      const showText = clusterHeight >= (chartConfig.fontSize || 10) + PADDING_VERTICAL && bs >= FOOTPRINT_TEXT_ZOOM;
      const poc = cl.is_poc && chartConfig.showPoc;

      // [AUDITORÍA TEMPORAL] registrar la fila de la vela auditada SIEMPRE (con o
      // sin texto dibujado), extrayendo bid/ask de 'niveles' con sus coordenadas Y.
      if (debugCandleTime === c.time) {
        debugFill.push({
          k: kPrice, y: Math.round(yTop + (clusterHeight / 2)),
          xBid: Math.floor(numL + candleNumW * 0.25), xAsk: Math.floor(numL + candleNumW * 0.75),
          bid: fmtVol(cl.bid), ask: fmtVol(cl.ask),
        });
      }

      // SIN cajas de fondo: solo el POC se resalta (configurable). La celda se
      // dibuja en TODO el rango High-Low, también si el nivel cae en una mecha.
      if (poc) {
        ctx.fillStyle = chartConfig.colorPoc;
        ctx.fillRect(Math.floor(numL), yTop, candleNumW, rh);
      }

      // Texto SOLO si el ancho de vela >= MIN_CANDLE_WIDTH_FOR_TEXT (si no, vela limpia).
      // (1) Se pinta en TODOS los niveles entre High y Low (mechas incluidas).
      if (bs >= MIN_CANDLE_WIDTH_FOR_TEXT && chartConfig.showNumbers && showText) {
        const useBold = poc;
        const fixedPx = chartConfig.fontSize || 10;   // tamaño FIJO (no responsivo al zoom)
        ctx.font = useBold ? `bold ${fixedPx}px 'Segoe UI', system-ui, sans-serif` : `${fixedPx}px 'Segoe UI', system-ui, sans-serif`;
        // 1) medir el ancho REAL de ambos números antes de dibujar
        const textBid = fmtVol(cl.bid);
        const textAsk = fmtVol(cl.ask);
        const textWidth = ctx.measureText(textBid).width + ctx.measureText(textAsk).width;
        const PADDING_SEGURIDAD = 10;
        // si el cuerpo de la vela es más estrecho que los números + padding, NO dibujar
        if (candleNumW >= textWidth + PADDING_SEGURIDAD) {
          // 2) máscara de recorte: el texto NUNCA sale de la columna de la vela,
          //    pero SÍ se permite en todo el rango High-Low (mechas incluidas).
          ctx.save();
          ctx.beginPath();
          ctx.rect(Math.floor(numL), Math.floor(yHighPx), candleNumW, Math.ceil(candleH));
          ctx.clip();
          ctx.textAlign = "center";
          // (3) CENTRADO VERTICAL EXACTO dentro de la celda
          ctx.textBaseline = "middle";
          // Coordenada Y SIEMPRE entera (Math.round) => texto nítido, nunca borroso.
          const yCenter = Math.round(yTop + (clusterHeight / 2));
          const xBid = Math.floor(numL + candleNumW * 0.25);
          const xAsk = Math.floor(numL + candleNumW * 0.75);
          ctx.fillStyle = useBold ? "#111111" : chartConfig.colorBid;
          ctx.fillText(textBid, xBid, yCenter);
          ctx.fillStyle = useBold ? "#111111" : chartConfig.colorAsk;
          ctx.fillText(textAsk, xAsk, yCenter);
          ctx.restore();
        }
      }

      // Histograma de Delta (configurable): bloque de altura completa del cluster,
      // ancho ∝ |delta|, con opacidad y ancho relativo ajustables.
      if (chartConfig.showDelta) {
        const nextNumL = x + bs - candleNumW / 2;
        const maxBarW = Math.max(Math.min(deltaSlotW - 2 - deltaGap, nextNumL - dSlotL - 2 - deltaGap), 2);
        const bw = Math.min((Math.abs(cl.delta) / maxAbs) * maxBarW * chartConfig.deltaWidth, maxBarW);
        ctx.save();
        ctx.globalAlpha = chartConfig.deltaOpacity;
        ctx.fillStyle = cl.delta >= 0 ? chartConfig.colorDeltaPos : chartConfig.colorDeltaNeg;
        // pequeña separación vertical entre bloques de cluster (deltaGapV px)
        const deltaGapV = 2;
        ctx.fillRect(dSlotL + 1, yTop + deltaGapV / 2, Math.max(bw, 1.5), Math.max(rh - deltaGapV, 1));
        ctx.restore();
      }
    }

    // 3) Cuerpo: recuadro alineado a la MISMA cuadrícula de niveles que los
    //    clusters (kOpen/kClose = floor(price/step_size)): abarca EXACTAMENTE
    //    desde el nivel de Open hasta el nivel de Close (min..max), sin
    //    desalinearse de las filas del footprint.
    if (bodyTopP != null && bodyBotP != null && bodyBotP > bodyTopP) {
      const kOpen = Math.round((c.open + 1e-9) / banda);
      const kClose = Math.round((c.close + 1e-9) / banda);
      const kBodyTop = Math.min(Math.max(Math.max(kOpen, kClose), kMin), kMax);
      const kBodyBot = Math.min(Math.max(Math.min(kOpen, kClose), kMin), kMax);
      const bTop = Math.floor(yHighPx + (kMax - kBodyTop) * rowH);
      const bBot = Math.floor(yHighPx + (kMax - kBodyBot + 1) * rowH);
      ctx.strokeStyle = wickColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.floor(numL) + 0.5, bTop + 0.5, candleNumW - 1, Math.max(bBot - bTop, 1) - 1);
    }

    // 4) Redibujar la mecha central encima.
    drawWick();

    // [AUDITORÍA TEMPORAL] diagnóstico crudo del renderizado de la vela auditada:
    if (debugCandleTime === c.time && !debugCandleLogged) {
      debugCandleLogged = true;
      console.log("[AUDIT] dibujo vela", c.time, "banda:", banda, "kMin:", kMin, "kMax:", kMax,
                  "numRows:", numRows, "rowH:", rowH, "n_clusters:", rows.length);
      console.log("[AUDIT] niveles:", rows.map((r) => ({ price: r.price, k: Math.floor((r.price + 1e-9) / banda), bid: r.bid, ask: r.ask })));
      console.log("[AUDIT] fillText (y, xBid, xAsk, bid, ask):", debugFill);
    }
  }


  // Escala de calor (azul -> cian -> verde -> amarillo -> naranja -> rojo)
  function heatColor(t) {
    const stops = [
      [0.0, [30, 41, 59]],
      [0.18, [37, 99, 235]],
      [0.36, [6, 182, 212]],
      [0.52, [34, 197, 94]],
      [0.68, [250, 204, 21]],
      [0.82, [249, 115, 22]],
      [1.0, [220, 38, 38]],
    ];
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < stops.length - 1; i++) {
      const [a, ca] = stops[i], [b, cb] = stops[i + 1];
      if (t >= a && t <= b) {
        const k = (t - a) / (b - a || 1e-9);
        const r = Math.round(ca[0] + (cb[0] - ca[0]) * k);
        const g = Math.round(ca[1] + (cb[1] - ca[1]) * k);
        const bl = Math.round(ca[2] + (cb[2] - ca[2]) * k);
        return `rgba(${r},${g},${bl},0.85)`;
      }
    }
    return "rgba(220,38,38,0.85)";
  }

  // [ABSORCIÓN DESACTIVADA] el heatmap solo pinta el fondo; sin bandas ni zonas.
  function renderHeat(w, h) {
    hctx.clearRect(0, 0, w, h);
    hctx.fillStyle = "#0b0f1a";
    hctx.fillRect(0, 0, w, h);
    // (estructura de bandas de absorción conservada en drawZones/heatColor,
    //  simplemente no se invoca: el heat llega vacío desde el backend)
    // drawZones(w, h);
  }

  function drawZones(w, h) {
    const vr = chart.timeScale().getVisibleRange();
    if (!vr) return;
    const x0 = chart.timeScale().timeToCoordinate(vr.from) ?? 0;
    const x1 = chart.timeScale().timeToCoordinate(vr.to) ?? w;
    const minH = 5;   // grosor mínimo visible (px)
    for (const z of state.zones) {
      if (z.score < zoneFilter) continue;
      let yTop = candles.priceToCoordinate(z.high);
      let yBot = candles.priceToCoordinate(z.low);
      if (yTop == null || yBot == null) continue;
      if (yBot - yTop < minH) {
        const cy = (yTop + yBot) / 2;
        yTop = cy - minH / 2;
        yBot = cy + minH / 2;
      }
      const y1 = Math.min(yTop, yBot), y2 = Math.max(yTop, yBot);
      // la banda nace en la vela del evento (first_ts) y se proyecta a la derecha;
      // si la zona está invalidada/consumida, termina en su última vela (last_ts).
      const dead = z.state === "Mitigated" || z.state === "Invalidated" || z.state === "Consumed";
      let sx = z.first_ts ? chart.timeScale().timeToCoordinate(z.first_ts) : x0;
      if (sx == null) sx = x0;
      let ex = dead ? (z.last_ts ? chart.timeScale().timeToCoordinate(z.last_ts) : sx) : x1;
      if (ex == null) ex = sx;
      if (ex < sx) { const t = sx; sx = ex; ex = t; }
      if (ex - sx < 6) ex = sx + 6;
      if (ex < x0 || sx > x1) continue;
      sx = Math.max(sx, x0); ex = Math.min(ex, x1);
      // banda horizontal (detrás de las velas)
      hctx.save();
      if (z.glow > 0.35) { hctx.shadowColor = z.color; hctx.shadowBlur = 8; }
      hctx.fillStyle = z.color;
      hctx.fillRect(sx, y1, ex - sx, y2 - y1);
      hctx.restore();
      hctx.strokeStyle = "rgba(255,255,255,0.22)";
      hctx.lineWidth = 1;
      hctx.beginPath(); hctx.moveTo(sx, y1); hctx.lineTo(ex, y1); hctx.stroke();
      hctx.beginPath(); hctx.moveTo(sx, y2); hctx.lineTo(ex, y2); hctx.stroke();
      // línea central punteada
      const cy = candles.priceToCoordinate(z.center);
      if (cy != null) {
        hctx.save();
        hctx.strokeStyle = "rgba(255,255,255,0.45)";
        hctx.setLineDash([5, 4]);
        hctx.lineWidth = 1;
        hctx.beginPath(); hctx.moveTo(sx, cy); hctx.lineTo(ex, cy); hctx.stroke();
        hctx.restore();
      }
    }
  }

  // ---------------------------------------------------------------
  // Tooltip (desglose de la zona)
  // ---------------------------------------------------------------
  const tooltip = $("tooltip");
  const crossLabel = $("crosshair-label");

  function fmtP(p, d = 2) {
    if (p == null) return "—";
    return Number(p).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }

  function showTooltip(z, x, y) {
    const dir = z.direction === "buy" ? "Absorción compradora · Suelo" : "Absorción vendedora · Techo";
    const bd = z.breakdown || {};
    const stateLabel = { Candidate: "Candidata", Confirmed: "Confirmada", Active: "Activa", Tested: "Testeada", Reabsorbed: "Reabsorbida", Weakened: "Debilitada", Consumed: "Consumida", Invalidated: "Invalidada", Mitigated: "Mitigada", Historical: "Histórica" }[z.state] || z.state;
    tooltip.innerHTML = `
      <h3 class="${z.direction === 'buy' ? 'buy' : 'sell'}">${dir}</h3>
      <div class="row"><span class="k">Precio</span><span class="v">${fmtP(z.center)}</span></div>
      <div class="row"><span class="k">Rango</span><span class="v">${fmtP(z.low)} – ${fmtP(z.high)}</span></div>
      <div class="row"><span class="k">Score actual</span><span class="v">${z.score}</span></div>
      <div class="row"><span class="k">Strength (histórica)</span><span class="v">${z.strength}</span></div>
      <div class="row"><span class="k">Salud (liquidez)</span><span class="v">${z.health}</span></div>
      <div class="row"><span class="k">Actividad</span><span class="v">${z.activity}</span></div>
      <div class="row"><span class="k">Eventos</span><span class="v">${z.events} (${z.reabsorptions} reabs.)</span></div>
      <div class="row"><span class="k">Tests / Consumo</span><span class="v">${z.tests} / ${z.consumption}%</span></div>
      <div class="row"><span class="k">Volumen total</span><span class="v">${fmtP(z.volume, 4)}</span></div>
      <div class="row"><span class="k">Compra / Venta</span><span class="v">${fmtP(z.buy_volume, 4)} / ${fmtP(z.sell_volume, 4)}</span></div>
      <div class="row"><span class="k">Delta</span><span class="v">${fmtP(z.delta, 4)}</span></div>
      <div class="row"><span class="k">Vol. relativo / Percentil</span><span class="v">${z.relvol}x / ${z.pct}%</span></div>
      <div class="row"><span class="k">Ineficiencia</span><span class="v">${z.inefficiency}</span></div>
      <div class="bd">
        <div class="r"><span>Agresión</span><span>${bd.aggression ?? "—"}</span></div>
        <div class="r"><span>Volumen</span><span>${bd.volume ?? "—"}</span></div>
        <div class="r"><span>Ineficiencia</span><span>${bd.inefficiency ?? "—"}</span></div>
        <div class="r"><span>Rechazo</span><span>${bd.rejection ?? "—"}</span></div>
        <div class="r"><span>Persistencia</span><span>${bd.persistence ?? "—"}</span></div>
        <div class="r"><span>Contexto</span><span>${bd.context ?? "—"}</span></div>
      </div>
      <span class="state" style="color:#fff;background:${z.color}">${stateLabel.toUpperCase()}</span>`;
    tooltip.classList.remove("hidden");
    const r = chartEl.getBoundingClientRect();
    let tx = x + 18, ty = y + 14;
    if (tx + 260 > r.width) tx = x - 270;
    if (ty + 320 > r.height) ty = y - 330;
    tooltip.style.left = tx + "px";
    tooltip.style.top = Math.max(0, ty) + "px";
  }

  function hideTooltip() { tooltip.classList.add("hidden"); crossLabel.classList.add("hidden"); }

  // Crosshair/tooltip: las actualizaciones de DOM se canalizan por requestAnimationFrame
  // (una por frame con la ÚLTIMA posición), evitando escrituras de layout en cada
  // mousemove durante el drag/zoom => UI fluida sin lag.
  let crossPending = false;
  let crossLatest = null;
  function applyCrosshair(param) {
    if (!param || !param.point || !param.time) { hideTooltip(); return; }
    const price = candles.coordinateToPrice(param.point.y);
    // etiqueta de cursor
    crossLabel.classList.remove("hidden");
    crossLabel.textContent = `${fmtP(price)}`;
    const r = chartEl.getBoundingClientRect();
    crossLabel.style.left = Math.min(param.point.x + 12, r.width - 70) + "px";
    crossLabel.style.top = Math.max(param.point.y - 16, 0) + "px";
    // zona bajo el cursor
    let hit = null;
    for (const z of state.zones) {
      if (price != null && price >= z.low && price <= z.high) {
        hit = z; break;
      }
    }
    if (hit) showTooltip(hit, param.point.x, param.point.y);
    else tooltip.classList.add("hidden");
  }
  chart.subscribeCrosshairMove((param) => {
    crossLatest = param;
    if (crossPending) return;
    crossPending = true;
    requestAnimationFrame(() => { crossPending = false; applyCrosshair(crossLatest); });
  });

  chart.timeScale().subscribeVisibleTimeRangeChange(() => {
    // Pase SÍNCRONO dentro del repintado de lightweight-charts: el overlay
    // (footprint/velas) se dibuja en el MISMO frame que la rejilla/velas nativas
    // (single render pass) — sin el requestAnimationFrame extra que provocaba
    // que las velas "alcanzaran" a la rejilla con un frame de retraso al arrastrar.
    drawScene();
  });

  // ---------------------------------------------------------------
  // Paneles laterales
  // ---------------------------------------------------------------
  function renderFootprint() {
    const el = $("footprint");
    if (!el) return;   // panel lateral eliminado (gráfico a pantalla completa)
    if (!state.levels || !state.levels.length) {
      el.innerHTML = '<div class="empty">Esperando flujo…</div>'; return;
    }
    const maxD = Math.max(...state.levels.map((l) => Math.abs(l.delta)), 1e-9);
    el.innerHTML = state.levels.map((l) => {
      const cls = l.delta >= 0 ? "delta pos" : "delta neg";
      const sgn = l.delta >= 0 ? "+" : "";
      const wPct = Math.round((Math.abs(l.delta) / maxD) * 100);
      const col = l.delta >= 0 ? "#26a69a" : "#ef5350";
      return `<div class="row">
        <span class="price">${fmtP(l.price)}</span>
        <span class="r" style="color:#26a69a">${Number(l.buy).toFixed(3)}</span>
        <span class="r" style="color:#ef5350">${Number(l.sell).toFixed(3)}</span>
        <span class="r ${cls}">${sgn}${Number(l.delta).toFixed(3)}</span>
        <span class="mini"><i style="width:${wPct}%;background:${col}"></i></span>
      </div>`;
    }).join("");
  }

  // [ABSORCIÓN DESACTIVADA] panel de zonas (estructura conservada; sin elementos en el DOM):
  function renderZones() {
    const el = $("zones");
    if (!el) return;
    const shown = state.zones.filter((z) => z.score >= zoneFilter);
    const zc = $("zonecount");
    if (zc) zc.textContent = shown.length;
    const zh = $("zone-hint");
    if (zh) zh.textContent = shown.length ? `${shown.length} zonas (filtro ${zoneFilter})` : "";
    if (!shown.length) {
      el.innerHTML = `'<div class="empty">Sin zonas que superen el filtro (${zoneFilter}). Baja el slider para ver más.</div>'`;
      return;
    }
    const stateLabel = { Candidate: "Cand", Confirmed: "Conf", Active: "Activa", Tested: "Test", Reabsorbed: "Reabs", Weakened: "Debil", Consumed: "Consum", Invalidated: "Inval", Mitigated: "Mitig", Historical: "Hist" };
    el.innerHTML = shown.slice(0, 60).map((z) => {
      const dir = z.direction === "buy" ? "Suelo" : "Techo";
      return `<div class="zone" data-id="${z.id}">
        <span class="dot" style="background:${z.color}"></span>
        <div class="meta">
          <div class="p">${fmtP(z.center)} <small>${dir} · ${stateLabel[z.state] || z.state}</small></div>
          <div class="s">${fmtP(z.volume, 4)} vol · ${z.events} ev · ${z.health} salud</div>
        </div>
        <div class="score"><b style="color:${z.color}">${z.score}</b><span>score</span></div>
      </div>`;
    }).join("");
  }

  // ---------------------------------------------------------------
  // Cabecera / estado
  // ---------------------------------------------------------------
  function setStatus(s) {
    const el = $("status");
    el.className = "status " + s;
    el.textContent = s === "online" ? "En vivo" : s === "connecting" ? "Conectando…" : "Reconectando…";
  }

  function updateHeader() {
    if (state.price != null) $("price").textContent = fmtP(state.price);
    if (state.book) $("bidask").textContent = fmtP(state.book.bid) + " / " + fmtP(state.book.ask);
    $("sb-market").textContent = `${state.symbol} · ${state.config ? (state.config.category === "linear" ? "Perpetuo" : "Spot") : ""} · ${intervalLabel(state.interval)}`;
    if (state.config) $("kval").textContent = (state.config.min_relative_volume ?? 2.0) + "×";
    setTfLabel();
  }

  function intervalLabel(iv) {
    if (iv === "D") return "1D";
    if (iv === "W") return "1S";
    if (iv === "M") return "1M";
    const n = parseInt(iv, 10) || 1;
    if (n >= 60) return (n / 60) + "H";
    return n + "m";
  }

  // ---- temporalidad (botón desplegable estilo Quantower) ----
  function computeInterval(value, unit) {
    value = Math.max(1, parseInt(value, 10) || 1);
    if (unit === "day") {
      // Bybit: 1 día = "D", ~1 semana = "W", ~1 mes = "M"
      if (value >= 28) return { interval: "M", label: "1M", minutes: value * 1440 };
      if (value >= 6) return { interval: "W", label: "1S", minutes: value * 1440 };
      return { interval: "D", label: "1D", minutes: value * 1440 };
    }
    const m = unit === "hour" ? value * 60 : value;
    if (m >= 1440) {
      // 24h o más: se usa la vela diaria "D"
      return { interval: "D", label: "1D", minutes: m };
    }
    // se envía el valor en minutos tal cual (el backend agrega si no es estándar)
    return { interval: String(m), label: intervalLabel(String(m)), minutes: m };
  }

  function calculateLimit(intervalMinutes, days) {
    // velas necesarias para cubrir N días a esta temporalidad
    const candles = Math.round((days * 1440) / Math.max(intervalMinutes, 1));
    return Math.min(Math.max(candles, 10), 3000);
  }

  function openTfPopover() { $("tf-popover").classList.remove("hidden"); }
  function closeTfPopover() { $("tf-popover").classList.add("hidden"); }

  function setTfLabel() {
    $("tf-label").textContent = "Time - " + intervalLabel(state.interval);
  }

  // ---- Línea de precio activa + temporizador de cierre de vela (eje Y) ----
  const priceTimerEl = $("price-timer");
  let _prevTimerPrice = null;
  function intervalSeconds() {
    const iv = state.interval;
    if (iv === "D") return 86400;
    if (iv === "W") return 604800;
    if (iv === "M") return 2592000;
    return (parseInt(iv, 10) || 5) * 60;
  }

  function countdownText() {
    const total = intervalSeconds();
    // Sincronizado con el reloj del sistema/exchange (UTC, vía NTP): los segundos
    // restantes se derivan del reloj módulo el intervalo, de modo que el contador
    // marca 00 exactamente al cruzar el segundo cero, igual que Quantower.
    //   segundos_restantes = interval_seconds - (now % interval_seconds)
    const rem = (total - (Math.floor(Date.now() / 1000) % total)) % total;
    const h = Math.floor(rem / 3600), m = Math.floor((rem % 3600) / 60), s = rem % 60;
    if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function updatePriceTimer() {
    if (!priceTimerEl) return;
    if (!chartConfig.showTimer) { priceTimerEl.classList.add("hidden"); return; }
    if (state.price == null) { priceTimerEl.classList.add("hidden"); return; }
    const y = candles.priceToCoordinate(state.price);
    if (y == null) { priceTimerEl.classList.add("hidden"); return; }
    priceTimerEl.classList.remove("hidden");
    priceTimerEl.style.top = y + "px";
    // dirección de color según el último precio
    const up = _prevTimerPrice == null || state.price >= _prevTimerPrice;
    _prevTimerPrice = state.price;
    priceTimerEl.classList.toggle("up", up);
    priceTimerEl.classList.toggle("down", !up);
    priceTimerEl.querySelector(".p").textContent = fmtP(state.price);
    priceTimerEl.querySelector(".t").textContent = countdownText();
  }

  // llama al cambiar el símbolo/temporalidad para reiniciar la referencia de precio
  function resetPriceTimer() { _prevTimerPrice = null; updatePriceTimer(); }

  // ---------------------------------------------------------------
  // Aplicar datos
  // ---------------------------------------------------------------
  function loadCandles(list) {
    // dedupe por time: velas duplicadas rompen lightweight-charts y hacen "desaparecer" velas
    const seen = new Set();
    const uniq = list.filter((c) => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
    state.candles = uniq;
    candleMap.clear();
    finalizedTimes.clear();   // dataset nuevo: nada está congelado todavía
    uniq.forEach((c) => candleMap.set(c.time, c));
    candles.setData(uniq.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    updateVolumeData("all");
  }

  function applySnapshot(d) {
    if (d.config) state.config = d.config;
    if (d.candles) loadCandles(d.candles);
    state.zones = d.zones || [];
    state.levels = d.levels || [];
    state.heat = d.heat || [];
    if (d.last_price != null) state.price = d.last_price;
    if (d.book) state.book = d.book;
    if (d.live_candle) applyLiveCandle(d.live_candle);
    renderLegend(); renderFootprint(); renderZones(); updateHeader(); requestRender();
  }

  function applyLiveCandle(lc) {
    // (1) FORMATO DE TIEMPO: UNIX segundos, entero simple (nunca un objeto).
    const t = Math.floor(Number(lc.time));
    if (!isFinite(t)) return;
    // CONGELAR la vela saliente: si este live_candle corresponde a una vela YA
    // cerrada (time en finalizedTimes), se descarta — ningún tick tardío modifica
    // los clusters finales de una vela cerrada.
    if (finalizedTimes.has(t)) return;
    // Defensa "Cannot update oldest data": solo actualizar si el tiempo NO es más
    // viejo que la última vela ya cargada en el gráfico (mensaje atrasado/duplicado).
    const bars = candles.data();
    const lastT = bars.length ? bars[bars.length - 1].time : null;
    if (lastT == null || t >= lastT) {
      candles.update({ time: t, open: lc.open, high: lc.high, low: lc.low, close: lc.close });
    }
    state.liveTime = t;   // tiempo de la vela EN FORMACIÓN (para la línea de precio)
    candleMap.set(t, lc);
    const idx = state.candles.findIndex((x) => x.time === t);
    if (idx >= 0) state.candles[idx] = lc;
    else { state.candles.push(lc); if (state.candles.length > 400) state.candles.shift(); }
    updateVolumeData("last");
  }

  function applyState(d) {
    if (d.config) state.config = d.config;
    state.zones = d.zones || [];
    state.levels = d.levels || [];
    state.heat = d.heat || [];
    if (d.last_price != null) state.price = d.last_price;
    if (d.book) state.book = d.book;
    if (d.live_candle) applyLiveCandle(d.live_candle);
    // defensa: si el gráfico quedó vacío (p. ej. justo tras un cambio), recargar velas
    if (d.candles && d.candles.length && state.candles.length === 0) loadCandles(d.candles);
    renderLegend(); renderFootprint(); renderZones(); updateHeader(); requestRender();
  }

  // ---------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------
  let ws = null;
  function connect() {
    setStatus("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => setStatus("online");
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.type === "init") { applySnapshot(m); setStatus("online"); }
      else if (m.type === "state") applyState(m);
      else if (m.type === "candle") {
        const c = m.candle;
        // (1) FORMATO DE TIEMPO: UNIX segundos, entero simple (nunca un objeto).
        const t = Math.floor(Number(c.time));
        if (!isFinite(t)) return;
        // Cierre de vela: se congela/inmoviliza (ningún live_candle atrasado la tocará)
        finalizedTimes.add(t);
        // [AUDITORÍA TEMPORAL] payload crudo recibido del backend:
        debugCandleTime = t;
        debugCandleLogged = false;
        console.log("[AUDIT] payload candle:", c);
        // Defensa "Cannot update oldest data": solo actualizar si el tiempo NO es
        // más viejo que la última vela ya cargada (mensaje atrasado/duplicado).
        const bars = candles.data();
        const lastT = bars.length ? bars[bars.length - 1].time : null;
        if (lastT == null || t >= lastT) {
          candles.update({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
        }
        candleMap.set(t, c);
        const idx = state.candles.findIndex((x) => x.time === t);
        if (idx >= 0) state.candles[idx] = c;   // reemplazar (no duplicar)
        else { state.candles.push(c); if (state.candles.length > 400) state.candles.shift(); }
        updateVolumeData("last");
        // repintado limpio: el lienzo se limpia por completo (ctx.clearRect) y se
        // vuelve a renderizar la escena con la vela nueva al instante
        requestRender();
      }
    };
    ws.onclose = () => { setStatus("offline"); setTimeout(connect, 2000); };
    ws.onerror = () => {};
  }

  // ---------------------------------------------------------------
  // Cambio de símbolo / temporalidad / rango / garrapata
  // ---------------------------------------------------------------
  async function switchMarket(symbol, interval, limit = 500, cluster_step = 0) {
    setStatus("connecting");
    try {
      await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, interval, limit, cluster_step }),
      });
      state.symbol = symbol; state.interval = interval;
      if (cluster_step) state.cluster_step = cluster_step;
      candles.setData([]); state.zones = [];
      updateHeader();
      const r = await fetch("/api/snapshot"); applySnapshot(await r.json());
      // Auto-escala vertical (Y-axis): fuerza el re-ajuste a la nueva agrupación
      try {
        const ps = chart.priceScale("right");
        ps.applyOptions({ autoScale: false });
        ps.applyOptions({ autoScale: true });
      } catch (_) {}
      renderVolumeIndicator();   // re-acoplar el indicador de volumen al nuevo dataset
      resetPriceTimer();
      setStatus("online");
      closeTfPopover();
    } catch (e) { setStatus("offline"); }
  }

  // ---- Popover de temporalidad ----
  function initTimeframePopover() {
    const btn = $("tf-btn");
    btn.addEventListener("click", (e) => { e.stopPropagation(); openTfPopover(); });
    $("tf-apply").addEventListener("click", (e) => {
      e.stopPropagation();
      const value = parseInt($("tf-value").value, 10) || 1;
      const unit = $("tf-unit").value;
      const days = parseInt($("tf-range").value, 10) || 3;
      const tick = Math.max(1, parseInt($("tf-tick").value, 10) || 5);   // garrapata personalizada (>=1 tick)
      const r = computeInterval(value, unit);
      const limit = calculateLimit(r.minutes, days);
      // Persistencia global: guardar la config del usuario (timeframe/ticks/indicadores)
      try {
        localStorage.setItem("app_user_config", JSON.stringify({
          timeframe: intervalLabel(r.interval),
          ticks: tick,
          activeIndicators: { volume: activeIndicators.volume },
          indicatorSettings: { volume: { colorUp: "#089981", colorDown: "#f23645" } },
        }));
      } catch (_) {}
      // reconecta con el nuevo intervalo, rango y garrapata en una sola llamada
      switchMarket(state.symbol, r.interval, limit, tick);
    });
    $("tf-cancel").addEventListener("click", (e) => { e.stopPropagation(); closeTfPopover(); });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".tf-wrap")) closeTfPopover();
    });
    // sincronizar el formulario con la temporalidad y garrapata activas al abrir
    btn.addEventListener("click", () => {
      const iv = state.interval;
      if (iv === "D" || iv === "W" || iv === "M") {
        $("tf-value").value = 1;
        $("tf-unit").value = "day";
      } else {
        const n = parseInt(iv, 10) || 1;
        if (n >= 60) {
          $("tf-value").value = (n / 60);
          $("tf-unit").value = "hour";
        } else {
          $("tf-value").value = n;
          $("tf-unit").value = "minute";
        }
      }
      $("tf-tick").value = String(state.config ? state.config.cluster_step : 5);
    });
  }

  // ---------------------------------------------------------------
  // Buscador de símbolos
  // ---------------------------------------------------------------
  const symInput = $("symbol-input");
  const symDrop = $("symbol-dropdown");
  let symTimer = null;

  symInput.addEventListener("input", () => {
    clearTimeout(symTimer);
    const q = symInput.value.trim();
    symTimer = setTimeout(async () => {
      if (!q) { symDrop.classList.remove("open"); return; }
      try {
        const r = await fetch("/api/symbols?q=" + encodeURIComponent(q));
        const d = await r.json();
        renderSymbols(d.symbols || []);
      } catch (_) {}
    }, 250);
  });

  symInput.addEventListener("focus", () => { if (symDrop.children.length) symDrop.classList.add("open"); });
  document.addEventListener("click", (e) => { if (!e.target.closest(".symbol-wrap")) symDrop.classList.remove("open"); });

  function renderSymbols(symbols) {
    symDrop.innerHTML = "";
    if (!symbols.length) { symDrop.innerHTML = '<div class="none">Sin resultados</div>'; symDrop.classList.add("open"); return; }
    symbols.forEach((s) => {
      const it = document.createElement("div");
      it.className = "item";
      it.innerHTML = `<span class="sym">${s.symbol}</span><span class="q">${s.quote || ""}</span>`;
      it.onclick = () => { symInput.value = s.symbol; symDrop.classList.remove("open"); switchMarket(s.symbol, state.interval); };
      symDrop.appendChild(it);
    });
    symDrop.classList.add("open");
  }

  symInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { symDrop.classList.remove("open"); switchMarket(symInput.value.trim().toUpperCase(), state.interval); }
  });

  // ---------------------------------------------------------------
  // Herramientas de dibujo (set esencial)
  // ---------------------------------------------------------------
  let tool = "cursor";
  const drawings = [];
  let draft = null;

  document.querySelectorAll(".tool").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.dataset.tool;
      if (t === "clear") { drawings.length = 0; requestRender(); return; }
      tool = t;
      document.querySelectorAll(".tool").forEach((x) => x.classList.toggle("active", x === b));
      chartEl.style.cursor = t === "cursor" ? "crosshair" : "crosshair";
    });
  });

  function pxToData(e) {
    const r = chartEl.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const time = chart.timeScale().coordinateToTime(x);
    const price = candles.coordinateToPrice(y);
    return { x, y, time, price };
  }

  chartEl.addEventListener("mousedown", (e) => {
    if (tool === "cursor" || tool === "clear") return;
    const p = pxToData(e);
    if (p.time == null || p.price == null) return;
    if (tool === "text") {
      const txt = prompt("Texto:", "");
      if (txt) drawings.push({ tool: "text", t: p.time, p: p.price, text: txt });
      tool = "cursor"; document.querySelectorAll(".tool").forEach((x) => x.classList.remove("active"));
      requestRender(); return;
    }
    draft = { tool, t1: p.time, p1: p.price, x1: p.x, y1: p.y, t2: p.time, p2: p.price, x2: p.x, y2: p.y };
  });

  chartEl.addEventListener("mousemove", (e) => {
    if (!draft) return;
    const p = pxToData(e);
    if (p.time == null || p.price == null) return;
    draft.t2 = p.time; draft.p2 = p.price; draft.x2 = p.x; draft.y2 = p.y;
    requestRender();
  });

  chartEl.addEventListener("mouseup", () => {
    if (!draft) return;
    drawings.push(draft); draft = null; requestRender();
  });

  chartEl.addEventListener("mouseleave", () => { if (draft) { draft = null; requestRender(); } });

  function drawDrawings(w, h) {
    for (const d of [...drawings, ...(draft ? [draft] : [])]) {
      const x1 = chart.timeScale().timeToCoordinate(d.t1);
      const x2 = chart.timeScale().timeToCoordinate(d.t2);
      const y1 = candles.priceToCoordinate(d.p1);
      const y2 = candles.priceToCoordinate(d.p2);
      ctx.save();
      ctx.strokeStyle = "#2962ff"; ctx.fillStyle = "#2962ff";
      ctx.lineWidth = 1.5; ctx.font = "11px sans-serif";
      switch (d.tool) {
        case "trend":
          if (x1 != null && x2 != null && y1 != null && y2 != null) { line(x1, y1, x2, y2); }
          break;
        case "hline":
          if (y1 != null) { line(0, y1, w, y1); ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(w, y1); ctx.stroke(); }
          break;
        case "vline":
          if (x1 != null) { ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, h); ctx.stroke(); }
          break;
        case "rect":
          if (x1 != null && x2 != null && y1 != null && y2 != null) {
            ctx.setLineDash([]);
            ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
          }
          break;
        case "text":
          if (x1 != null && y1 != null) { ctx.setLineDash([]); ctx.fillText(d.text || "", x1 + 4, y1 - 4); }
          break;
        case "fib": {
          const ys = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          const top = Math.min(y1, y2), bot = Math.max(y1, y2);
          const pTop = Math.max(d.p1, d.p2), pBot = Math.min(d.p1, d.p2);
          ys.forEach((lv, i) => {
            const yy = top + (bot - top) * lv;
            const col = i === 0 ? "#ef5350" : (i === ys.length - 1 ? "#26a69a" : "#787b86");
            ctx.strokeStyle = col; ctx.fillStyle = col; ctx.setLineDash([]);
            ctx.beginPath(); ctx.moveTo(Math.min(x1, x2), yy); ctx.lineTo(Math.max(x1, x2), yy); ctx.stroke();
            ctx.fillText(`${(lv * 100).toFixed(1)}% · ${fmtP(pTop - (pTop - pBot) * lv)}`, Math.min(x1, x2) + 2, yy - 2);
          });
          break;
        }
        case "measure": {
          if (x1 != null && x2 != null && y1 != null && y2 != null) {
            ctx.strokeStyle = "#ffb74d"; ctx.fillStyle = "#ffb74d"; ctx.setLineDash([]);
            line(x1, y1, x2, y2);
            const diff = d.p2 - d.p1;
            const pct = d.p1 ? (diff / d.p1) * 100 : 0;
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 6;
            ctx.fillText(`${fmtP(Math.abs(diff))} (${pct.toFixed(2)}%)`, mx, my);
          }
          break;
        }
      }
      ctx.restore();
    }
    function line(a, b, c, e) { ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, e); ctx.stroke(); }
  }

  // ---------------------------------------------------------------
  // Configuración visual (panel de ajustes)
  // ---------------------------------------------------------------
  function initSettings() {
    const btn = $("settings-btn");
    const pop = $("settings-popover");
    if (!btn || !pop) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.toggle("hidden");
      if (!pop.classList.contains("hidden")) syncSettingsForm();
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".settings-wrap")) pop.classList.add("hidden");
    });

    const bind = (id, key, transform) => {
      const el = $(id);
      if (!el) return;
      const read = () => {
        if (el.type === "checkbox") chartConfig[key] = el.checked;
        else if (el.type === "color") chartConfig[key] = el.value;
        else if (el.type === "range") chartConfig[key] = transform ? transform(parseFloat(el.value)) : parseFloat(el.value);
      };
      el.addEventListener("input", () => { read(); saveChartConfig(); updateSettingsLabels(); requestRender(); });
      el.addEventListener("change", () => { read(); saveChartConfig(); updateSettingsLabels(); requestRender(); });
    };

    bind("cfg-poc", "showPoc");
    bind("cfg-delta", "showDelta");
    bind("cfg-numbers", "showNumbers");
    bind("cfg-priceline", "showPriceLine");
    bind("cfg-timer", "showTimer");
    bind("cfg-coldpos", "colorDeltaPos");
    bind("cfg-coldneg", "colorDeltaNeg");
    bind("cfg-colpoc", "colorPoc");
    bind("cfg-colbid", "colorBid");
    bind("cfg-colask", "colorAsk");
    bind("cfg-font", "fontSize", (v) => Math.round(v));
    bind("cfg-opacity", "deltaOpacity", (v) => v / 100);
    bind("cfg-width", "deltaWidth", (v) => v / 100);

    function updateSettingsLabels() {
      const fv = $("cfg-font-v"), ov = $("cfg-opacity-v"), wv = $("cfg-width-v");
      if (fv) fv.textContent = chartConfig.fontSize;
      if (ov) ov.textContent = Math.round(chartConfig.deltaOpacity * 100) + "%";
      if (wv) wv.textContent = Math.round(chartConfig.deltaWidth * 100) + "%";
    }
    function syncSettingsForm() {
      const set = (id, val) => { const el = $(id); if (el) el.value = val; };
      set("cfg-poc", chartConfig.showPoc); set("cfg-delta", chartConfig.showDelta);
      set("cfg-numbers", chartConfig.showNumbers); set("cfg-priceline", chartConfig.showPriceLine);
      set("cfg-timer", chartConfig.showTimer);
      set("cfg-coldpos", chartConfig.colorDeltaPos); set("cfg-coldneg", chartConfig.colorDeltaNeg);
      set("cfg-colpoc", chartConfig.colorPoc); set("cfg-colbid", chartConfig.colorBid);
      set("cfg-colask", chartConfig.colorAsk);
      set("cfg-font", chartConfig.fontSize);
      set("cfg-opacity", Math.round(chartConfig.deltaOpacity * 100));
      set("cfg-width", Math.round(chartConfig.deltaWidth * 100));
      updateSettingsLabels();
    }
    updateSettingsLabels();
  }

  // ---------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------
  window.addEventListener("resize", requestRender);
  new ResizeObserver(requestRender).observe(chartEl);

  // ---------------------------------------------------------------
  // ZOOM INTERACTIVO EN EL EJE Y (rueda sobre la barra de precios lateral)
  // ---------------------------------------------------------------
  // NOTA DE TRANSPARENCIA (se sincera): lightweight-charts v4.2.1 NO tiene API
  // pública para fijar el rango vertical de la escala de precios. Verificado
  // empíricamente contra el bundle local: setVisibleRange solo existe en el eje
  // temporal, y la API de la escala de precios solo expone applyOptions/options/
  // width. La solución llega al modelo interno de la escala, alcanzable vía
  // chart.priceScale("right").lw (el ChartWidget), y manipula su objeto de rango
  // congelado (claves internas Ah.Sh / Ah.kh = precio mínimo / máximo), validado
  // con Node contra el archivo lightweight-charts.js 4.2.1 incluido en el
  // proyecto: el rango mutado sobrevive al repintado (Xl) y a las nuevas velas
  // (update). Es estable mientras no se actualice ese bundle.
  // Para que el rango no se recalcule solo, el zoom exige autoScale:false (se
  // congela al primer tick de rueda). Doble clic sobre el eje restablece la
  // auto-escala (comportamiento nativo axisDoubleClickReset).
  let yDragActive = false;
  // Estado de arrastre GLOBAL (pan/drag del gráfico): durante el drag solo se
  // aplica el pase síncrono single-pass; al soltar se ejecuta la reconciliación
  // fina final (requestRender) que fija la posición definitiva de las velas.
  let isDragging = false;
  // drag-offset ÚNICO en píxeles (single render pass): mientras se arrastra, las
  // velas se dibujan con baseX + dragOffsetX — el MISMO desplazamiento en píxeles
  // que aplica la rejilla de la librería — sin llamar timeToCoordinate por vela.
  let dragOffsetX = 0;
  let dragBaseX = null;     // time -> x base capturado al iniciar el arrastre
  let dragRefTime = null;   // tiempo de referencia para medir el offset del gráfico
  let dragRefX0 = 0;        // x de referencia al iniciar el arrastre

  function yAxisWidth() {
    try { return chart.priceScale("right").width() || 0; } catch (_) { return 0; }
  }

  function yOverAxis(clientX) {
    try {
      const rect = chartEl.getBoundingClientRect();
      const w = yAxisWidth();
      return w > 0 && clientX >= rect.right - w - 4;   // 4px de tolerancia
    } catch (_) { return false; }
  }

  // Acceso defensivo al modelo interno de la escala de precios.
  function yScaleModel() {
    try {
      const ps = chart.priceScale("right");
      if (!ps || !ps.lw) return null;                  // ps.lw = ChartWidget interno
      const m = ps.lw.$t ? ps.lw.$t() : null;          // ChartModel interno
      if (!m || typeof m.$c !== "function") return null;
      const s = m.$c("right");
      if (!s || !s.Dt || !s.Dt.Ah) return null;
      return s.Dt;                                     // modelo de la escala de precios
    } catch (_) { return null; }
  }

  // Lee el rango visible actual {lo, hi} desde el modelo interno.
  function yReadRange() {
    const m = yScaleModel();
    if (!m) return null;
    const lo = m.Ah.Sh, hi = m.Ah.kh;
    if (typeof lo !== "number" || typeof hi !== "number" || !isFinite(lo) || !isFinite(hi) || hi <= lo) return null;
    return { lo, hi };
  }

  function yIsFrozen() {
    try { return chart.priceScale("right").options().autoScale === false; } catch (_) { return false; }
  }

  function yFreeze() {
    try { chart.priceScale("right").applyOptions({ autoScale: false }); } catch (_) {}
  }

  function yRepaint() {
    // repintar las capas nativas (velas + etiquetas del eje) y el canvas propio
    try {
      const m = chart.priceScale("right").lw.$t();
      if (m && typeof m.Xl === "function") m.Xl();
    } catch (_) {}
    requestRender();
  }

  function yWriteRange(lo, hi) {
    const m = yScaleModel();
    if (!m) return;
    m.Ah.Sh = lo;
    m.Ah.kh = hi;
    yRepaint();
  }

  function yPriceAt(clientY) {
    try {
      const rect = chartEl.getBoundingClientRect();
      return candles.coordinateToPrice ? candles.coordinateToPrice(clientY - rect.top) : null;
    } catch (_) { return null; }
  }

  // (1) RUEDA sobre el eje Y: zoom vertical continuo en tiempo real.
  // capture:true => este listener corre ANTES que el zoom X nativo (burbuja),
  // así la rueda sobre el eje hace zoom Y y en el resto del gráfico sigue el
  // zoom X de siempre.
  chartEl.addEventListener("wheel", (e) => {
    if (!yOverAxis(e.clientX)) return;
    if (e.cancelable) e.preventDefault();   // cancelar scroll de la página
    e.stopPropagation();                    // el zoom X nativo no debe dispararse
    if (!e.deltaY) return;
    if (!yIsFrozen()) yFreeze();            // congelar auto-escala (primer tick)
    const r = yReadRange();
    if (!r) return;
    // normalizar delta (páginas/líneas/píxeles) y factor exponencial suave:
    // rueda hacia arriba => zoom in, hacia abajo => zoom out.
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 120 : e.deltaY;
    const factor = Math.exp(d * 0.0014);
    const anchor = yPriceAt(e.clientY);
    const mid = (r.lo + r.hi) / 2;
    const anchorP = (anchor != null && isFinite(anchor)) ? anchor : mid;
    const newLo = anchorP - (anchorP - r.lo) * factor;
    const newHi = anchorP + (r.hi - anchorP) * factor;
    const minHalf = Math.max(Math.abs(mid) * 1e-6, 1e-6);   // evita invertir el rango
    if (newHi - newLo < minHalf * 2) return;
    yWriteRange(newLo, newHi);
  }, { capture: true, passive: false });

  // (2) ARRASTRE clic+y-mover sobre el eje Y: el desplazamiento vertical ya es
  // nativo en tiempo real (handleScale.axisPressedMouseMove.price=true). Aquí
  // SOLO forzamos el redibujado del canvas propio en cada fotograma del arrastre
  // para que footprint/velas japonesas sigan al eje sin congelarse hasta soltar.
  chartEl.addEventListener("mousedown", (e) => {
    if (e.button === 0 && yOverAxis(e.clientX)) { yDragActive = true; requestRender(); }
  });
  chartEl.addEventListener("mousemove", (e) => {
    if (yDragActive) requestRender();
  });
  window.addEventListener("mouseup", () => { yDragActive = false; });
  chartEl.addEventListener("mouseleave", () => { yDragActive = false; });

  // (3) ESTADO DE ARRASTRE GLOBAL + RECONCILIACIÓN AL SOLTAR: mientras el ratón
  // está pulsado, el overlay se mueve en el MISMO frame que la rejilla (pase
  // síncrono en subscribeVisibleTimeRangeChange). Al soltar (mouseup) se ejecuta
  // un recalculo fino final para fijar la posición definitiva de las velas.
  chartEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    // Congelar el mapeo de datos durante el drag: capturar baseX de TODAS las
    // velas UNA sola vez (no por frame) y el x de referencia para medir el
    // offset de píxeles del gráfico (rejilla y velas usan el mismo dragOffsetX).
    dragOffsetX = 0;
    dragRefTime = (state.liveTime != null) ? state.liveTime : (state.candles.length ? state.candles[state.candles.length - 1].time : null);
    dragRefX0 = (dragRefTime != null) ? chart.timeScale().timeToCoordinate(dragRefTime) : null;
    dragBaseX = new Map();
    for (const c of state.candles) {
      const x = chart.timeScale().timeToCoordinate(c.time);
      if (x != null && isFinite(x)) dragBaseX.set(c.time, x);
    }
  });
  window.addEventListener("mouseup", () => {
    if (isDragging) { isDragging = false; dragBaseX = null; dragOffsetX = 0; requestRender(); }   // reconciliación final
  });
  chartEl.addEventListener("mouseleave", () => {
    if (isDragging) { isDragging = false; dragBaseX = null; dragOffsetX = 0; requestRender(); }
  });

  // ---------------------------------------------------------------
  // Indicadores (menú + Volumen sub-gráfico, estilo TradingView)
  // ---------------------------------------------------------------
  function updateVolumeData(from) {
    if (!volumeSeries) return;
    const cup = userConfig.indicatorSettings.volume.colorUp;
    const cdn = userConfig.indicatorSettings.volume.colorDown;
    try {
      if (from === "all") {
        const data = state.candles.map((c) => ({
          time: c.time,
          value: Number(c.volume) || 0,
          color: c.close >= c.open ? cup : cdn,
        }));
        volumeSeries.setData(data);
      } else {
        const last = state.candles[state.candles.length - 1];
        if (last) {
          volumeSeries.update({
            time: last.time,
            value: Number(last.volume) || 0,
            color: last.close >= last.open ? cup : cdn,
          });
        }
      }
      const vl = $("vl-value");
      if (vl && state.candles.length) {
        const last = state.candles[state.candles.length - 1];
        vl.textContent = fmtVol(last ? last.volume : null);
      }
    } catch (_) {}
  }

  function addVolumeIndicator() {
    if (volumeSeries) return;
    try {
      // separar el panel inferior 25% (volumen) del área de velas (75% superior)
      origVolumeMargins = chart.priceScale("right").options().scaleMargins;
      chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.05, bottom: 0.25 } });
      volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        color: userConfig.indicatorSettings.volume.colorUp,
      });
      // escala de volumen: solo el 25% inferior del pane, sin etiquetas de eje
      volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.75, bottom: 0.0 }, visible: false });
      volumeVisible = true;
      activeIndicators.volume = true;
      updateVolumeData("all");
      const leg = $("vol-legend"); if (leg) leg.classList.remove("hidden");
      const st = $("ind-vol-state"); if (st) { st.classList.add("on"); st.textContent = ""; }
      const item = document.querySelector('[data-ind="volume"]'); if (item) item.classList.add("active");
    } catch (_) {}
    requestRender();
  }

  function removeVolumeIndicator() {
    if (!volumeSeries) return;
    try {
      chart.removeSeries(volumeSeries);
      if (origVolumeMargins) chart.priceScale("right").applyOptions({ scaleMargins: origVolumeMargins });
    } catch (_) {}
    volumeSeries = null;
    volumeVisible = true;
    activeIndicators.volume = false;
    const leg = $("vol-legend"); if (leg) leg.classList.add("hidden");
    const st = $("ind-vol-state"); if (st) { st.classList.remove("on"); st.textContent = ""; }
    const item = document.querySelector('[data-ind="volume"]'); if (item) item.classList.remove("active");
    requestRender();
  }

  function toggleVolumeIndicator() {
    if (!volumeSeries) return;
    volumeVisible = !volumeVisible;
    try { volumeSeries.applyOptions({ visible: volumeVisible }); } catch (_) {}
    const leg = $("vol-legend"); if (leg) leg.classList.toggle("hidden", !volumeVisible);
  }

  // Re-acopla el indicador de volumen al dataset actual (tras cambio de
  // temporalidad/símbolo): si sigue activo, lo recrea o actualiza sin que desaparezca.
  function renderVolumeIndicator() {
    if (!activeIndicators.volume) return;
    if (volumeSeries) updateVolumeData("all");
    else addVolumeIndicator();
  }

  function filterIndicators(q) {
    let any = false;
    document.querySelectorAll("#ind-list .ind-item").forEach((li) => {
      const text = (li.textContent || "").toLowerCase();
      const show = !q || text.includes(q.toLowerCase());
      li.classList.toggle("hidden", !show);
      if (show) any = true;
    });
    const empty = $("ind-empty"); if (empty) empty.classList.toggle("hidden", any);
  }

  // Genera los ítems del menú 'Indicadores' desde availableIndicators,
  // agrupados por categoría (p. ej. "Order Flow" para Volume Delta).
  function renderIndicatorMenu() {
    const list = $("ind-list");
    if (!list) return;
    list.innerHTML = "";
    let lastCat = null;
    for (const ind of availableIndicators) {
      if (ind.category !== lastCat) {
        const cat = document.createElement("li");
        cat.className = "ind-cat";
        cat.textContent = ind.category;
        list.appendChild(cat);
        lastCat = ind.category;
      }
      const li = document.createElement("li");
      li.className = "ind-item";
      li.setAttribute("data-ind", ind.id);
      li.title = ind.name;
      li.innerHTML = `<span class="ind-item-ico">${ind.id === "volume" ? "▮" : "Δ"}</span>` +
        `<span class="ind-item-name">${ind.name}</span>` +
        `<span class="ind-state" id="ind-${ind.id}-state"></span>`;
      list.appendChild(li);
    }
  }

  function initIndicators() {
    const btn = $("ind-btn"), pop = $("ind-popover"), search = $("ind-search");
    if (!btn || !pop) return;
    renderIndicatorMenu();
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.classList.toggle("hidden");
      if (search) { search.value = ""; filterIndicators(""); if (!pop.classList.contains("hidden")) search.focus(); }
    });
    if (search) search.addEventListener("input", () => filterIndicators(search.value));
    document.querySelectorAll("#ind-list .ind-item").forEach((li) => {
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        const kind = li.getAttribute("data-ind");
        if (kind === "volume") { volumeSeries ? removeVolumeIndicator() : addVolumeIndicator(); }
        else if (kind === "volume_delta") { toggleDeltaIndicator(); }
      });
    });
    // cerrar el popover al hacer clic fuera
    document.addEventListener("click", (e) => {
      if (!pop.classList.contains("hidden") && !pop.contains(e.target) && !btn.contains(e.target)) pop.classList.add("hidden");
    });
    // leyenda del panel de volumen
    const eye = $("vl-eye"), x = $("vl-x"), gear = $("vl-gear");
    if (eye) eye.addEventListener("click", (e) => { e.stopPropagation(); toggleVolumeIndicator(); });
    if (x) x.addEventListener("click", (e) => { e.stopPropagation(); removeVolumeIndicator(); });
    if (gear) gear.addEventListener("click", (e) => { e.stopPropagation(); }); // configuración (placeholder)
  }

  // ---------------------------------------------------------------
  // Subplot Delta (panel independiente debajo del gráfico)
  // ---------------------------------------------------------------
  // Delta Bruto de una vela = Ask_Total - Bid_Total (suma de los clusters).
  function candleDelta(c) {
    const cls = c && c.clusters;
    if (!cls || !cls.length) return 0;
    let d = 0;
    for (const cl of cls) d += (cl.ask || 0) - (cl.bid || 0);
    return d;
  }

  // Delta de una vela con LECTURA CON FALLBACK (evita NaN): intenta primero los
  // campos directos totalAsk/totalBid o ask/bid de la vela; si no existen, suma
  // los clusters (ask - bid por nivel).
  function candleDeltaC(c) {
    if (!c) return 0;
    const ask = Number(c.totalAsk ?? c.ask ?? 0);
    const bid = Number(c.totalBid ?? c.bid ?? 0);
    if (Number.isFinite(ask) && Number.isFinite(bid) && (ask || bid)) return ask - bid;
    const cls = c.clusters;
    if (!cls || !cls.length) return 0;
    let d = 0;
    for (const cl of cls) d += (Number(cl.ask) || 0) - (Number(cl.bid) || 0);
    return Number.isFinite(d) ? d : 0;
  }

  // Formato numérico con 2 decimales + sufijo (ej. +1.92K / -8.62K).
  function fmtDelta(v) {
    const sign = v >= 0 ? "+" : "-";
    const a = Math.abs(v);
    let out;
    if (a >= 1e6) out = (a / 1e6).toFixed(2) + "M";
    else if (a >= 1e3) out = (a / 1e3).toFixed(2) + "K";
    else out = a.toFixed(2);
    return sign + out;
  }

  function updateDeltaHud(items) {
    const t = $("delta-title"), n = $("delta-net");
    if (t) t.textContent = `Delta (${state.cluster_step || 50})`;
    if (n && items.length) {
      const last = items[items.length - 1];
      n.textContent = `Net: ${fmtDelta(deltaCfg.mode === "cum" ? last.cum : last.d)}`;
    }
  }

  // Render del subplot: eje X 100% sincronizado con el gráfico principal
  // (mismo timeToCoordinate y mismo dragOffsetX / cámara). Se pinta en el MISMO
  // requestAnimationFrame que el footprint (drawScene).
  function drawDeltaPanel() {
    if (!activeIndicators.volume_delta) return;   // indicador no activo: no dibujar
    if (!deltaCanvas || !dctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = deltaCanvas.clientWidth, h = deltaCanvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (deltaCanvas.width !== Math.round(w * dpr) || deltaCanvas.height !== Math.round(h * dpr)) {
      deltaCanvas.width = Math.round(w * dpr);
      deltaCanvas.height = Math.round(h * dpr);
    }
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.clearRect(0, 0, w, h);
    dctx.fillStyle = "#0b0f1a";
    dctx.fillRect(0, 0, w, h);

    const vr = chart.timeScale().getVisibleRange();
    if (!vr) return;
    const bs = getBarSpacing();

    // serie visible: delta bruto por vela + delta acumulado desde el inicio de la sesión
    const items = [];
    let cum = 0;
    for (const c of state.candles) {
      const d = candleDeltaC(c);
      cum += d;
      const ts = (typeof c.time === "number" && c.time > 2000000000) ? Math.floor(c.time / 1000) : c.time;
      if (ts < vr.from || ts > vr.to) continue;
      items.push({ ts, d, cum });
    }
    if (!items.length) return;

    const values = items.map((it) => deltaCfg.mode === "cum" ? it.cum : it.d);
    let maxAbs = Math.max(...values.map((v) => (Number.isFinite(v) ? Math.abs(v) : 0)), 1e-9);
    if (!isFinite(maxAbs) || maxAbs <= 0) maxAbs = 1;   // blindaje: escala finita
    const midY = h / 2;
    const usable = h / 2 - 14;              // margen para las etiquetas
    const scale = usable / maxAbs;
    const barW = Math.max(bs - 2, 1);

    // B) EJE DE REFERENCIA: línea discontinua en el cero (modos centrado/acumulado)
    //    o línea base inferior (modo histograma, como el indicador de volumen).
    dctx.strokeStyle = "#2A2E39";
    dctx.lineWidth = 1;
    if (deltaCfg.mode === "hist") {
      dctx.beginPath();
      dctx.moveTo(0, h - 2 + 0.5);
      dctx.lineTo(w, h - 2 + 0.5);
      dctx.stroke();
    } else {
      dctx.setLineDash([4, 4]);
      dctx.beginPath();
      dctx.moveTo(0, Math.round(midY) + 0.5);
      dctx.lineTo(w, Math.round(midY) + 0.5);
      dctx.stroke();
      dctx.setLineDash([]);
    }

    // A) BARRAS DE DELTA (misma X y cámara que las velas del gráfico principal)
    for (const it of items) {
      const v = deltaCfg.mode === "cum" ? it.cum : it.d;
      let x = null;
      if (isDragging && dragBaseX) {
        x = dragBaseX.has(it.ts) ? (dragBaseX.get(it.ts) + dragOffsetX) : chart.timeScale().timeToCoordinate(it.ts);
      } else {
        x = chart.timeScale().timeToCoordinate(it.ts);
      }
      if (x == null || isNaN(x)) continue;
      const color = v >= 0 ? deltaCfg.colorUp : deltaCfg.colorDown;
      let barH, top;
      if (deltaCfg.mode === "hist") {
        // Modo HISTOGRAMA (como el indicador de volumen): barras desde el borde
        // inferior, altura ∝ |delta|, verde/rojo según el signo.
        barH = Math.max(Math.abs(v) / maxAbs * (h - 18), 2);
        top = h - 2 - barH;
      } else {
        // Modo centrado (Barras / Acumulado): barras desde el nivel cero central.
        barH = Math.max(Math.abs(v) * scale, 2);   // mínimo 2px para que SIEMPRE se vea
        top = v >= 0 ? midY - barH : midY;
      }
      // relleno al 80% de opacidad + borde fino 1px del color primario
      dctx.globalAlpha = 0.8;
      dctx.fillStyle = color;
      dctx.fillRect(x - barW / 2, top, barW, barH);
      dctx.globalAlpha = 1;
      dctx.strokeStyle = color;
      dctx.lineWidth = 1;
      dctx.strokeRect(x - barW / 2 + 0.5, top + 0.5, barW - 1, Math.max(barH - 1, 0));

      // C) ETIQUETA NUMÉRICA FLOTANTE (oculta si la vela mide < 15px)
      if (deltaCfg.showValues && bs >= 15) {
        dctx.fillStyle = color;
        dctx.font = "10px 'Segoe UI', system-ui, sans-serif";
        dctx.textAlign = "center";
        if (deltaCfg.mode === "hist") {
          dctx.textBaseline = "bottom";
          dctx.fillText(fmtDelta(v), x, top - 2);
        } else {
          dctx.textBaseline = v >= 0 ? "bottom" : "top";
          dctx.fillText(fmtDelta(v), x, v >= 0 ? top - 2 : top + barH + 2);
        }
      }
    }

    // D) HUD / HEADER del subplot
    updateDeltaHud(items);
  }

  function initDeltaPanel() {
    const tv = $("delta-toggle-values"), tm = $("delta-toggle-mode");
    if (tv) tv.addEventListener("click", () => {
      deltaCfg.showValues = !deltaCfg.showValues;
      tv.classList.toggle("off", !deltaCfg.showValues);
      requestRender();
    });
    if (tm) tm.addEventListener("click", () => {
      deltaCfg.mode = deltaCfg.mode === "bars" ? "hist" : deltaCfg.mode === "hist" ? "cum" : "bars";
      tm.textContent = deltaCfg.mode === "bars" ? "Barras" : deltaCfg.mode === "hist" ? "Hist." : "Acum.";
      requestRender();
    });
  }

  // Activa/desactiva el indicador 'Volume Delta' (subplot) desde el menú.
  function toggleDeltaIndicator() {
    activeIndicators.volume_delta = !activeIndicators.volume_delta;
    const host = $("delta-host");
    if (host) host.classList.toggle("hidden", !activeIndicators.volume_delta);
    const st = $("ind-delta-state");
    if (st) st.classList.toggle("on", activeIndicators.volume_delta);
    const item = document.querySelector('[data-ind="volume_delta"]');
    if (item) item.classList.toggle("active", activeIndicators.volume_delta);
    requestRender();
  }

  // ---------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------
  initSettings();
  initTimeframePopover();
  initIndicators();
  initDeltaPanel();
  updateHeader();
  // Carga SÍNCRONA e instantánea: aplicar la config del usuario (userConfig) al
  // servidor ANTES de conectar, para que la primera instantánea use ya la
  // temporalidad/garrapatas guardadas (sin parpadeo de estado fallback).
  (async () => {
    try {
      const iv = _tfToInterval(userConfig.timeframe);
      await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: state.symbol, interval: iv, limit: 500, cluster_step: userConfig.ticks }),
      });
      state.interval = iv;
      if (userConfig.ticks) state.cluster_step = userConfig.ticks;
      const ti = $("tf-tick"); if (ti) ti.value = String(userConfig.ticks);
      updateHeader();
    } catch (_) {}
    // Historial del footprint (últimas 100 velas con clusters): cargar al inicio
    // para pintar el gráfico inmediatamente con datos 24/7 del backend.
    try {
      const r = await fetch("/api/footprint-history");
      const h = await r.json();
      if (h && h.candles && h.candles.length) loadCandles(h.candles);
    } catch (_) {}
    // re-acoplar indicadores activos (volumen) desde el arranque
    if (activeIndicators.volume) addVolumeIndicator();
    connect();
  })();
  setInterval(updatePriceTimer, 1000);   // temporizador de cierre de vela (1s)
})();
