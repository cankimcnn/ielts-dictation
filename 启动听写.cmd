@echo off
setlocal
cd /d "%~dp0"

set "PYTHON=C:\Users\huawei\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if not exist "%PYTHON%" goto python_missing

powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4173/api/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 goto server_ready

start "IELTS Dictation Server" /min "%PYTHON%" -u "%~dp0server.py"

for /L %%I in (1,1,10) do (
  powershell.exe -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4173/api/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
  if not errorlevel 1 goto server_ready
  powershell.exe -NoProfile -Command "Start-Sleep -Milliseconds 500"
)

echo Failed to start the IELTS dictation server.
echo Please keep this window open and send a screenshot of this message.
pause
exit /b 1

:server_ready
start "" "http://127.0.0.1:4173/?v=20260708-11"
exit /b 0

:python_missing
echo Python runtime was not found.
echo Please ask Codex to repair the launcher.
pause
exit /b 1
