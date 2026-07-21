@echo off
cd /d "C:\Users\agust\Documents\IDEA Projects\express-gateway-automation"
echo Deteniendo servidor actual en puerto 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    taskkill /f /pid %%a
)
echo Iniciando servidor en segundo plano...
wscript.exe run_silent.vbs
echo Servidor reiniciado con exito en segundo plano.
timeout /t 3
