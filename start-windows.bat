@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js from https://nodejs.org then run again & pause & exit /b)
if not exist node_modules call npm install
start "" http://localhost:3000
node server/index.js
pause
