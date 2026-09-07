@echo off
cd /d "%~dp0"

:: Check if running with Administrator privileges
net session >nul 2>&1
if %errorLevel% == 0 (
    echo [OK] Privilegios de Administrador detectados (Control total sobre Task Manager y ventanas protegidas).
) else (
    echo [AVISO] Ejecutando con permisos estandar. Para interactuar con ventanas elevadas (como Administrador de Tareas),
    echo puedes cerrar y abrir haciendo clic derecho -^> "Ejecutar como administrador".
)

echo Iniciando Express Gateway Server...
node server.js
pause
