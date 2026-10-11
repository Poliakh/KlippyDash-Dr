#!/usr/bin/env python3
"""
Windowless launcher for Obico's ml_api (print-watchdog/ml_api/server.py).

Why this exists: start-klippydash.bat used to run ml_api and watchdog inside minimised console
windows so their output could be redirected to a log file by the shell. Those windows can be
closed by accident (or by a session logoff), which silently kills print monitoring while the
dashboard — launched with pythonw, so it has no window at all — keeps running, hiding the fact
that nothing is being watched any more. That actually happened: watchdog.log ended with a "^C".

So everything is launched with pythonw now (no console to close) and the log redirection moved
here, into Python. server.py itself is vendored Obico code and stays untouched.
"""
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(HERE, "logs", "ml_api.log")
ML_API_DIR = os.path.join(HERE, "ml_api")

os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
# line-buffered so the log is readable while the process is still running
_log = open(LOG_PATH, "a", encoding="utf-8", buffering=1, errors="replace")
sys.stdout = _log
sys.stderr = _log

# server.py loads its model via paths relative to its own directory
os.chdir(ML_API_DIR)
sys.path.insert(0, ML_API_DIR)

runpy.run_path(os.path.join(ML_API_DIR, "server.py"), run_name="__main__")
