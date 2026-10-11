/*
 * net-status.js — add-on for KlippyDash (dev; not part of upstream).
 * Real WiFi-glyph indicator (3 nested arcs + a device dot, not bars) overlaid on the top-right
 * corner of each printer's camera: arcs light up progressively for connection QUALITY, and the
 * glyph's own device dot (bottom of the icon, not a separate badge) shows the plain fact of
 * whether the last check reached the printer at all — green when it did, gray when it didn't.
 * Below
 * the icon, a "last seen Ns ago" counter appears ONLY once the printer has been unreachable for
 * more than DISCONNECT_SHOW_MS — while connectivity is fine (the normal case) that element isn't
 * in the layout at all, not just empty text, so it never reserves space over the camera.
 *
 * Klipper/Moonraker does not expose real WiFi RSSI over HTTP — there is no such object to query.
 * As a practical stand-in, this module runs its own lightweight poll of {host}/printer/info
 * (the cheapest Moonraker endpoint there is) and times the round-trip: a fast reply reads as a
 * strong link, a slow one as a weak link, and a failed/timed-out request reads as no connection
 * at all (corner dot off, arcs unlit) — without freezing the "seconds since" counter, since that
 * keeps counting from the last time the printer WAS actually reachable.
 */
(function () {
	var POLL_MS = 5000;
	var FETCH_TIMEOUT_MS = 4000;
	var TICK_MS = 1000;
	var DISCONNECT_SHOW_MS = 30000; // счётчик "Nс" показываем только после 30с без связи

	// Латентность (мс) -> число подсвеченных дуг вай-фай значка, 0..3 (0 = не подключено).
	var THRESHOLDS = [250, 700, 2000]; // <250мс=3 дуги, <700мс=2, <2000мс=1, иначе живо, но еле-еле

	var lastSuccess = {}; // index -> epoch ms of the last ok reply (undefined = ещё ни разу)

	// Настоящий значок WiFi (3 вложенные дуги + точка-"устройство" снизу), а не полоски —
	// дуги подсвечиваются по уровню сигнала (1..3, снизу вверх — сначала ближняя), а сама точка
	// внизу значка отражает не уровень, а факт связи (зелёная/серая) — отдельного бейджа-точки
	// больше нет, эту роль теперь играет точка самого значка.
	var WIFI_SVG =
		'<svg viewBox="0 0 24 18" class="ns-bars-svg">' +
		'<circle class="ns-wifi-dot" cx="12" cy="16" r="1.7" />' +
		'<path class="ns-arc ns-arc-1" d="M8.4,12.2C9.4,11.45 10.65,11 12,11C13.35,11 14.6,11.45 15.6,12.2" fill="none" stroke-linecap="round" stroke-width="2.1" />' +
		'<path class="ns-arc ns-arc-2" d="M4.8,8.4C6.81,6.89 9.3,6 12,6C14.7,6 17.19,6.89 19.2,8.4" fill="none" stroke-linecap="round" stroke-width="2.1" />' +
		'<path class="ns-arc ns-arc-3" d="M1.2,4.6C4.21,2.34 7.95,1 12,1C16.05,1 19.79,2.34 22.8,4.6" fill="none" stroke-linecap="round" stroke-width="2.1" />' +
		'</svg>';

	function levelFor(latencyMs) {
		for (var i = 0; i < THRESHOLDS.length; i++) {
			if (latencyMs < THRESHOLDS[i]) return THRESHOLDS.length - i;
		}
		return 1; // ответил, но очень медленно — хотя бы одна дуга, не "нет связи"
	}

	function applyLevel(iconEl, level, ok) {
		for (var i = 1; i <= 3; i++) {
			iconEl.querySelector(".ns-arc-" + i).classList.toggle("ns-arc-on", i <= level);
		}
		iconEl.querySelector(".ns-wifi-dot").classList.toggle("ns-dot-on", ok);
	}

	function checkOne(index, host, iconEl) {
		var url = host.replace(/\/+$/, "") + "/printer/info";
		var controller = new AbortController();
		var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
		var t0 = performance.now();
		fetch(url, { signal: controller.signal })
			.then(function (r) {
				clearTimeout(timer);
				if (!r.ok) throw new Error("HTTP " + r.status);
				var latency = performance.now() - t0;
				lastSuccess[index] = Date.now();
				applyLevel(iconEl, levelFor(latency), true);
			})
			.catch(function () {
				clearTimeout(timer);
				applyLevel(iconEl, 0, false);
			});
	}

	function formatDuration(ms) {
		var s = Math.max(0, Math.round(ms / 1000));
		if (s < 60) return s + "с";
		if (s < 3600) return Math.floor(s / 60) + "м";
		return Math.floor(s / 3600) + "ч";
	}

	function buildFor(tile, index, printer, host) {
		var cam = tile.querySelector("div.cam");
		if (!cam) return;

		var connectStart = Date.now(); // запасная точка отсчёта, пока ни разу не было успешного ответа

		var wrap = document.createElement("div");
		wrap.className = "ns-wrap";
		wrap.title = "Качество связи с принтером (по скорости ответа API)";
		wrap.innerHTML = '<span class="ns-icon">' + WIFI_SVG + '</span>';
		cam.appendChild(wrap);

		var iconEl = wrap.querySelector(".ns-icon");
		var secondsEl = null; // элемента нет в разметке, пока не понадобится (не резервирует место)

		function poll() { checkOne(index, host, iconEl); }

		function tick() {
			var since = lastSuccess[index] || connectStart;
			var downMs = Date.now() - since;
			if (downMs < DISCONNECT_SHOW_MS) {
				if (secondsEl) { secondsEl.remove(); secondsEl = null; }
				return;
			}
			if (!secondsEl) {
				secondsEl = document.createElement("span");
				secondsEl.className = "ns-seconds";
				wrap.appendChild(secondsEl);
			}
			secondsEl.textContent = formatDuration(downMs);
		}

		poll();
		setInterval(poll, POLL_MS);
		setInterval(tick, TICK_MS);
	}

	// см. custom-controls.js/print-status.js — плитки появляются после асинхронного
	// fetch("settings.json"), поэтому стартуем по "klippydash:ready", а не по DOMContentLoaded.
	window.addEventListener("klippydash:ready", function () {
		document.querySelectorAll(".tile").forEach(function (tile) {
			var index;
			try { index = JSON.parse(tile.getAttribute("data")).index; } catch (e) { index = tile.id.replace("tile", ""); }
			var printer = (typeof _printers !== "undefined" && _printers[index]) ? _printers[index] : null;
			if (!printer || !printer.host) return;
			buildFor(tile, index, printer, printer.host);
		});
	});
})();
