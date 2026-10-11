#!/usr/bin/env python3
"""
KlippyDash static file server + tiny settings API — stdlib only (no Flask/Node/etc),
so it runs unchanged on Windows (dev) and on the Linux box a printer eventually hosts it on
(Python is already there for Moonraker itself).

Serves src/ as static files, plus:
  GET  /api/settings   -> current src/settings.json
  POST /api/settings   -> replaces src/settings.json (validated, written atomically)

Usage: python serve.py [--port 8900]
"""
import argparse
import json
import mimetypes
import os
import shutil
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src")
SETTINGS_PATH = os.path.join(ROOT, "settings.json")

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("application/manifest+json", ".webmanifest")


def validate_settings(data):
	"""Minimal shape check — just enough to stop obviously-broken saves from wiping the file."""
	if not isinstance(data, dict):
		return "top-level value must be an object"
	if "printers" not in data or not isinstance(data["printers"], list):
		return "\"printers\" must be an array"
	for i, p in enumerate(data["printers"]):
		if not isinstance(p, dict):
			return "printers[%d] must be an object" % i
		if not p.get("name") or not isinstance(p["name"], str):
			return "printers[%d].name is required" % i
		if not p.get("host") or not isinstance(p["host"], str):
			return "printers[%d].host is required" % i
	return None


class Handler(BaseHTTPRequestHandler):
	server_version = "KlippyDashPy/1.0"

	def log_message(self, fmt, *args):
		print("%s - %s" % (self.address_string(), fmt % args))

	def _send_json(self, status, obj):
		body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
		self.send_response(status)
		self.send_header("Content-Type", "application/json; charset=utf-8")
		self.send_header("Content-Length", str(len(body)))
		self.end_headers()
		self.wfile.write(body)

	def _send_file(self, path):
		ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
		# без charset браузер иногда угадывает кодировку JS/CSS/HTML неверно и превращает
		# кириллицу в файле (строки, не только комментарии) в кракозябры
		if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "application/manifest+json"):
			ctype += "; charset=utf-8"
		with open(path, "rb") as f:
			data = f.read()
		self.send_response(200)
		self.send_header("Content-Type", ctype)
		self.send_header("Content-Length", str(len(data)))
		self.end_headers()
		self.wfile.write(data)

	def do_GET(self):
		route = urlsplit(self.path).path
		if route == "/api/settings":
			try:
				with open(SETTINGS_PATH, "rb") as f:
					data = f.read()
			except FileNotFoundError:
				self._send_json(404, {"error": "settings.json not found"})
				return
			self.send_response(200)
			self.send_header("Content-Type", "application/json; charset=utf-8")
			self.send_header("Content-Length", str(len(data)))
			self.end_headers()
			self.wfile.write(data)
			return

		rel = unquote(route).lstrip("/")
		if rel == "":
			rel = "index.html"
		full = os.path.normpath(os.path.join(ROOT, rel))
		if not (full == ROOT or full.startswith(ROOT + os.sep)):
			self.send_response(403)
			self.end_headers()
			return
		if os.path.isfile(full):
			self._send_file(full)
		else:
			self.send_response(404)
			body = ("404 Not Found: " + rel).encode("utf-8")
			self.send_header("Content-Type", "text/plain; charset=utf-8")
			self.send_header("Content-Length", str(len(body)))
			self.end_headers()
			self.wfile.write(body)

	def do_POST(self):
		route = urlsplit(self.path).path
		if route != "/api/settings":
			self.send_response(404)
			self.end_headers()
			return

		length = int(self.headers.get("Content-Length", 0))
		raw = self.rfile.read(length) if length else b""
		try:
			data = json.loads(raw.decode("utf-8"))
		except (json.JSONDecodeError, UnicodeDecodeError) as e:
			self._send_json(400, {"error": "invalid JSON: %s" % e})
			return

		err = validate_settings(data)
		if err:
			self._send_json(400, {"error": err})
			return

		# atomic write: temp file in the same dir, then replace (avoids a torn/partial
		# settings.json if the process dies mid-write, or a concurrent GET reads a half-written file)
		fd, tmp_path = tempfile.mkstemp(dir=ROOT, prefix=".settings.", suffix=".json.tmp")
		try:
			with os.fdopen(fd, "w", encoding="utf-8") as f:
				json.dump(data, f, ensure_ascii=False, indent="\t")
				f.write("\n")
			shutil.move(tmp_path, SETTINGS_PATH)
		except Exception as e:
			try:
				os.remove(tmp_path)
			except OSError:
				pass
			self._send_json(500, {"error": "write failed: %s" % e})
			return

		self._send_json(200, {"ok": True})


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument("--port", type=int, default=8900)
	args = ap.parse_args()

	server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
	print("KlippyDash serving %s" % ROOT)
	print("Open:  http://localhost:%d/" % args.port)
	print("Press Ctrl+C to stop.")
	try:
		server.serve_forever()
	except KeyboardInterrupt:
		pass


if __name__ == "__main__":
	main()
