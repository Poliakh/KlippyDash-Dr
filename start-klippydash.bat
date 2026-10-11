@echo off
REM Starts the whole KlippyDash (prod) stack from a single double-click:
REM   - serve.py                     - the dashboard itself (port 8899)
REM   - print-watchdog/run_ml_api.py - local Obico failure-detection model (port 3333)
REM   - print-watchdog/watchdog.py   - print monitoring + status feed for the eye icon (port 3334)
REM
REM All three run through pythonw, i.e. WITHOUT A CONSOLE WINDOW. ml_api and watchdog used to
REM live in minimised console windows so the shell could redirect their output to a log file.
REM Closing those windows silently killed monitoring while the dashboard (already windowless)
REM kept running, so the loss went unnoticed - that is exactly what happened on 2026-09-27,
REM leaving a "^C" at the end of watchdog.log. Logging now happens inside Python instead (see
REM run_ml_api.py and _redirect_output_to_log in watchdog.py), so there is no window to close.
REM Use stop-klippydash.bat to shut everything down.
REM
REM NOTE: these comments are in English on purpose. cmd.exe reads .bat files in the OEM code
REM page, so Cyrillic saved as UTF-8 breaks parsing - some bytes turn into shell metacharacters.
REM
REM The interpreter path is absolute: a bare "pythonw" in a fresh cmd.exe can resolve to the
REM Microsoft Store stub instead of the real interpreter.
set PYW="C:\Users\User\AppData\Local\Programs\Python\Python312\pythonw.exe"
set ROOT=%~dp0
set WATCHDOG_ROOT=%ROOT%print-watchdog\

if not exist "%WATCHDOG_ROOT%logs" mkdir "%WATCHDOG_ROOT%logs"

start "" %PYW% "%ROOT%serve.py" --port 8899
start "" %PYW% "%WATCHDOG_ROOT%run_ml_api.py"

REM No delay before watchdog here: it waits STARTUP_DELAY_SECONDS on its own before the first
REM check, while ml_api loads the ONNX model. Its status endpoint comes up immediately, so the
REM eye icon on the dashboard is alive straight away.
start "" %PYW% "%WATCHDOG_ROOT%watchdog.py"

start "" http://localhost:8899/
