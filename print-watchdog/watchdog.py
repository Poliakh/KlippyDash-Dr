#!/usr/bin/env python3
"""
print-watchdog — periodically checks each printer's camera against the local Obico ml_api
(failure-detection model, see ml_api/) and messages Telegram if it looks like the print has
failed (detached part / spaghetti). No cloud, no Docker — just this script + ml_api's Flask
process (server.py, port 3333).

Printer list AND all tunable behavior (enabled/threshold/sustain/poll interval/cooldown) come
from KlippyDash's own settings API — same source of truth as the dashboard's settings panel
("Print monitoring" section). Add a printer there, it's covered automatically; flip "enabled"
off there, this script goes idle without needing to be killed.

Exposes its own tiny status endpoint (GET /status, port 3334) so the dashboard can show a live
"being watched" indicator without depending on ml_api's own /hc/ (which only proves the model
loaded, not that this loop is actually running/enabled).
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

KLIPPYDASH_API = "http://localhost:8899/api/settings"  # prod only — dev is not watched (would double-alert)
ML_API = "http://localhost:3333/p/"
STATUS_PORT = 3334

TELEGRAM_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "telegram_config.json")
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "watchdog.log")

# Секунды ожидания перед первым опросом: ml_api грузит ONNX-модель (~193MB) и какое-то время не
# отвечает. Без паузы первая же проверка кадра падает и пишет ошибку в журнал на ровном месте.
STARTUP_DELAY_SECONDS = 12
EVENTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "events.json")
MAX_EVENTS = 200

DEFAULT_MONITORING = {
	"enabled": True,
	"confidenceThreshold": 0.4,
	"sustainCount": 3,
	"pollSeconds": 20,
	"cooldownSeconds": 600,
}

state = {}  # printer name -> {"streak": int, "last_alert": float, "since": float}
status = {"alive": True, "lastCycle": 0, "enabled": True, "printers": {}, "config": {}, "alertCount": 0}
status_lock = threading.Lock()

# Журнал событий — ОТДЕЛЬНО от per-print `state` (который сбрасывается при каждой остановке
# печати), поэтому переживает и остановку/перезапуск печати, и перезапуск самого watchdog.py
# (пишется в файл). "alert" — реально сработавшее уведомление о возможном сбое; "error" —
# разовая неудачная проверка кадра (сетевой сбой и т.п., не обязательно проблема с печатью).
events = []  # [{"ts": float, "printer": str, "kind": "alert"|"error", "message": str}, ...]
events_lock = threading.Lock()


def _load_events():
	global events
	try:
		with open(EVENTS_PATH, encoding="utf-8") as f:
			events = json.load(f)
	except Exception:
		events = []


def _save_events():
	try:
		with open(EVENTS_PATH, "w", encoding="utf-8") as f:
			json.dump(events, f)
	except Exception as e:
		print("Не удалось сохранить журнал событий:", e)


def log_event(printer, kind, message):
	with events_lock:
		events.append({"ts": time.time(), "printer": printer, "kind": kind, "message": message})
		del events[:-MAX_EVENTS]
		_save_events()
	with status_lock:
		status["alertCount"] = sum(1 for e in events if e["kind"] == "alert")


def get_settings():
	r = requests.get(KLIPPYDASH_API, timeout=5)
	r.raise_for_status()
	return r.json()


def get_monitoring_config(settings):
	cfg = dict(DEFAULT_MONITORING)
	cfg.update(settings.get("monitoring") or {})
	return cfg


def is_printing(host):
	try:
		r = requests.get(host.rstrip("/") + "/printer/objects/query?print_stats", timeout=5)
		return r.json()["result"]["status"]["print_stats"]["state"] == "printing"
	except Exception:
		return False


def check_frame(host):
	snapshot_url = host.rstrip("/") + "/webcam/?action=snapshot"
	r = requests.get(ML_API, params={"img": snapshot_url}, timeout=15)
	r.raise_for_status()
	detections = r.json().get("detections", [])
	return max((d[1] for d in detections), default=0.0)


def _load_telegram_config():
	try:
		with open(TELEGRAM_CONFIG_PATH, encoding="utf-8") as f:
			cfg = json.load(f)
		token, chat_id = cfg.get("bot_token"), cfg.get("chat_id")
		if not token or "ВСТАВЬ_СЮДА" in token or not chat_id or "ВСТАВЬ_СЮДА" in str(chat_id):
			return None, None
		return token, chat_id
	except Exception:
		return None, None


def notify(title, message):
	token, chat_id = _load_telegram_config()
	if not token:
		print("Telegram не настроен (telegram_config.json) — уведомление только в консоль:", title, message)
		return
	try:
		requests.post(
			"https://api.telegram.org/bot%s/sendMessage" % token,
			json={"chat_id": chat_id, "text": "🚨 %s\n%s" % (title, message)},
			timeout=10,
		)
	except Exception as e:
		print("Не удалось отправить уведомление в Telegram:", e)


# --- крошечный HTTP-статус для дашборда (глазик) ---
class StatusHandler(BaseHTTPRequestHandler):
	def log_message(self, fmt, *args):
		pass  # тихо — не засорять консоль на каждый опрос глазика

	def _send_json(self, obj):
		body = json.dumps(obj).encode("utf-8")
		self.send_response(200)
		self.send_header("Access-Control-Allow-Origin", "*")  # дашборд может открываться с другого порта (8900)
		self.send_header("Content-Type", "application/json; charset=utf-8")
		self.send_header("Content-Length", str(len(body)))
		self.end_headers()
		self.wfile.write(body)

	def do_GET(self):
		path = self.path.rstrip("/")
		if path == "/status":
			with status_lock:
				self._send_json(status)
		elif path == "/events":
			with events_lock:
				self._send_json({"events": list(reversed(events))})  # новые сверху
		else:
			self.send_response(404)
			self.end_headers()

	def do_POST(self):
		if self.path.rstrip("/") == "/events/clear":
			with events_lock:
				events.clear()
				_save_events()
			with status_lock:
				status["alertCount"] = 0
			self._send_json({"ok": True})
		else:
			self.send_response(404)
			self.end_headers()

	def do_OPTIONS(self):
		self.send_response(204)
		self.send_header("Access-Control-Allow-Origin", "*")
		self.send_header("Access-Control-Allow-Methods", "GET, POST")
		self.end_headers()


def run_status_server():
	server = ThreadingHTTPServer(("0.0.0.0", STATUS_PORT), StatusHandler)
	server.serve_forever()


def _redirect_output_to_log():
	"""Под pythonw консоли нет и sys.stdout is None — любой print() тогда падает с ошибкой.

	Запускаемся именно без окна намеренно: раньше ml_api и watchdog жили в свёрнутых окнах
	консоли ради перенаправления вывода средствами оболочки, и закрытие такого окна молча
	убивало наблюдение (в логе оставался "^C"), тогда как дашборд на pythonw продолжал
	работать — пропажа была незаметна. Теперь вывод перенаправляем здесь, изнутри.
	"""
	if sys.stdout is not None:
		return
	os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
	log = open(LOG_PATH, "a", encoding="utf-8", buffering=1, errors="replace")
	sys.stdout = log
	sys.stderr = log


def main():
	_redirect_output_to_log()
	_load_events()
	with status_lock:
		status["alertCount"] = sum(1 for e in events if e["kind"] == "alert")
	threading.Thread(target=run_status_server, daemon=True).start()
	print("print-watchdog started — status on http://localhost:%d/status" % STATUS_PORT)

	# статус-эндпоинт уже поднят (глазик на дашборде отвечает), ждём только перед первой проверкой
	if STARTUP_DELAY_SECONDS:
		print("waiting %ds for ml_api to finish loading its model" % STARTUP_DELAY_SECONDS)
		time.sleep(STARTUP_DELAY_SECONDS)

	while True:
		try:
			settings = get_settings()
		except Exception as e:
			print("Failed to fetch settings from KlippyDash:", e)
			with status_lock:
				status["alive"] = False
			time.sleep(DEFAULT_MONITORING["pollSeconds"])
			continue

		cfg = get_monitoring_config(settings)
		printers = settings.get("printers", [])

		with status_lock:
			status["alive"] = True
			status["enabled"] = cfg["enabled"]
			status["lastCycle"] = time.time()
			status["config"] = {
				"confidenceThreshold": cfg["confidenceThreshold"],
				"sustainCount": cfg["sustainCount"],
				"pollSeconds": cfg["pollSeconds"],
				"cooldownSeconds": cfg["cooldownSeconds"],
			}

		if not cfg["enabled"]:
			with status_lock:
				status["printers"] = {}
			time.sleep(cfg["pollSeconds"])
			continue

		printer_status = {}
		for p in printers:
			name, host = p.get("name", "?"), p.get("host", "")
			if not host or not is_printing(host):
				state.pop(name, None)
				printer_status[name] = {"printing": False}
				continue

			st = state.setdefault(name, {"streak": 0, "last_alert": 0, "since": time.time(), "checks": 0})

			try:
				conf = check_frame(host)
			except Exception as e:
				print("[%s] check failed: %s" % (name, e))
				log_event(name, "error", str(e))
				printer_status[name] = {
					"printing": True, "error": str(e),
					"since": st["since"], "watchingSeconds": time.time() - st["since"],
				}
				continue

			st["streak"] = st["streak"] + 1 if conf >= cfg["confidenceThreshold"] else 0
			st["checks"] += 1
			printer_status[name] = {
				"printing": True,
				"confidence": conf,
				"streak": st["streak"],
				"checks": st["checks"],
				"since": st["since"],
				"watchingSeconds": time.time() - st["since"],
				"lastAlertAt": st["last_alert"] or None,
			}
			print("[%s] confidence=%.2f streak=%d" % (name, conf, st["streak"]))

			if st["streak"] >= cfg["sustainCount"] and time.time() - st["last_alert"] > cfg["cooldownSeconds"]:
				msg = "%s: похоже на отклеившуюся деталь / спагетти (уверенность %.0f%%)" % (name, conf * 100)
				notify("Возможен сбой печати!", msg)
				log_event(name, "alert", msg)
				st["last_alert"] = time.time()
				printer_status[name]["lastAlertAt"] = st["last_alert"]

		with status_lock:
			status["printers"] = printer_status

		time.sleep(cfg["pollSeconds"])


if __name__ == "__main__":
	main()
