@echo off
REM DEV copy of KlippyDash — runs on port 8900 (production stays on 8899).
REM Launches in the background (no console window, terminal is freed immediately).
REM pythonw.exe = windowless Python; full path used because a bare "python"/"pythonw" in a fresh
REM cmd.exe can resolve to the Microsoft Store stub alias instead of the real interpreter.
set PYW="C:\Users\User\AppData\Local\Programs\Python\Python312\pythonw.exe"
start "" http://localhost:8900/
start "" %PYW% "%~dp0serve.py" --port 8900
