@echo off
echo Buscando y finalizando proceso en el puerto 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    taskkill /f /pid %%a
    echo Servidor detenido (PID: %%a).
)
echo Proceso finalizado.
pause
