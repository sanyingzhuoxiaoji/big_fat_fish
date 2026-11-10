@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_CACHE=%CD%\.local\electron-cache"
if not exist "node_modules\electron\dist\electron.exe" (
  call npm install --cache .local/npm-cache
  if errorlevel 1 goto failed
)
call npm run setup
if errorlevel 1 goto failed
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo Startup failed. See the error above.
pause
exit /b 1
