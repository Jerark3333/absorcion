@echo off
REM Mapa de Absorcion - launcher
cd /d "%~dp0"
python -m pip install -r requirements.txt -q
python run.py
pause
