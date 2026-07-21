@echo off
cd /d "C:\Users\agust\Documents\IDEA Projects\express-gateway-automation"
echo Iniciando Express Gateway Server en modo Auto-Reload (se reinicia al cambiar el codigo)...
node --watch server.js
pause
