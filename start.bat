@echo off
rem LanVoice unter Windows per Doppelklick starten (Node.js muss installiert sein).
cd /d "%~dp0"
where node >nul 2>nul || echo Node.js wurde nicht gefunden. Bitte von https://nodejs.org installieren (LTS-Version).
node server\index.js
pause
