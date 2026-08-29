"""Almacén de Footprint en RAM (módulo-global).

Vive a nivel de módulo para SOBREVIVIR a los cambios de configuración
(símbolo / temporalidad / garrapata) dentro del mismo proceso del servidor,
pero se limpia de forma natural al reiniciar Python (RAM volátil).

Guarda el footprint POR TICK de cada vela cerrada (cluster_step=1), de modo que
cualquier garrapata (1,2,5,10,50,100) pueda re-agrupar el histórico sin perder datos.
"""
FOOTPRINT_CACHE = {}   # "symbol|interval|time" -> {"ohlc": {...}, "ticks": {tick_key: {"buy","sell"}}}
CACHE_MAX = 1000
