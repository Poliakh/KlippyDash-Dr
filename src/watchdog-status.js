/*
 * watchdog-status.js — add-on for KlippyDash (dev; not part of upstream).
 * Small "eye" indicator next to the gear button showing whether the print-watchdog AI
 * failure-monitor (print-watchdog/, separate process) is alive and watching. Polls its status
 * endpoint (print-watchdog/watchdog.py, port 3334 — shared by both the prod and dev dashboard,
 * since only one watchdog process ever runs against prod's printer list).
 *
 * Three states, all driven by real eyelid+eyelash blink animation (CSS, see watchdog-status.css)
 * rather than an opacity/color pulse — the lid slides down over the eye and back up, lashes ride
 * along on its leading edge:
 *   - "down"    — status endpoint unreachable (watchdog not running) — gray, no blinking.
 *   - "idle"    — reachable, enabled, but no printer currently printing — dim, slow occasional blink.
 *   - "watching"— reachable, actively checking a printer that IS printing — vivid, faster blink.
 *
 * Click the eye to open a report card: per-printer watching duration + last alert. The card also
 * has a persistent event log ("Журнал" — GET/POST on watchdog.py's own :3334/events endpoints,
 * file-backed so it survives both a print restart and a watchdog.py restart, unlike the live
 * per-print status which resets whenever a printer stops printing) and a "Очистить" button to
 * clear it. A small red badge on the eye shows the uncleared alert count at a glance.
 */
(function () {
	var STATUS_URL = "http://localhost:3334/status";
	var EVENTS_URL = "http://localhost:3334/events";
	var CLEAR_EVENTS_URL = "http://localhost:3334/events/clear";
	var POLL_MS = 9000;
	var FETCH_TIMEOUT_MS = 4000;

	var wrapEl, lidGroupEl, reportEl, tipEl, badgeEl;
	var logOpen = false;
	var blinkTimer = null;
	var currentState = "down";
	var lastData = null;

	// "Око Саурона" — пасхалка/тревожный индикатор: включается либо когда watchdog реально
	// обнаружил возможный сбой печати (в течение ALERT_DISPLAY_SECONDS после алерта — не навсегда,
	// иначе глаз останется "пылающим" до конца печати), либо вручную на 5 быстрых кликов подряд
	// (просто ради веселья). Оба источника делят один визуальный класс/флаг, чтобы не мешать
	// друг другу — на глаз/тултип это выглядит одинаково в обоих случаях.
	var ALERT_DISPLAY_SECONDS = 120;
	var sauronReason = null; // "alert" | "egg" | null
	var sauronEggTimer = null;
	var eggClicks = [];

	// Веко — та же почти самая форма, что и вырез глаза (ws-eye-clip), поэтому в закрытом виде
	// (scaleY(1)) она перекрывает глаз ИДЕАЛЬНО без зазоров, а в открытом (scaleY(0), от центра
	// по вертикали) схлопывается в нулевую высоту — то есть по-настоящему невидима, а не просто
	// сдвинута за край (та версия давала артефакт: реснички оставались частично внутри выреза
	// глаза даже в состоянии покоя). Реснички — потомки того же <g>, масштабируются вместе с
	// веком: у самого низа века в закрытом виде, стягиваются к центру и пропадают в открытом.
	var EYE_SVG =
		'<svg viewBox="0 0 40 24" class="ws-eye-svg">' +
		'<defs>' +
		'<clipPath id="ws-eye-clip"><path d="M3,12 Q20,1 37,12 Q20,23 3,12 Z"/></clipPath>' +
		'<radialGradient id="ws-sauron-gradient" cx="50%" cy="45%" r="65%">' +
		'<stop offset="0%" stop-color="#ffe07a" /><stop offset="45%" stop-color="#ff8a1a" /><stop offset="100%" stop-color="#7a0e00" />' +
		'</radialGradient>' +
		'</defs>' +
		'<g clip-path="url(#ws-eye-clip)">' +
		'<rect class="ws-sclera" x="0" y="0" width="40" height="24" />' +
		'<circle class="ws-iris" cx="20" cy="12" r="6.4" />' +
		'<circle class="ws-pupil" cx="20" cy="12" r="2.8" />' +
		'<circle class="ws-glint" cx="17.8" cy="9.8" r="1" />' +
		'<g class="ws-lid-group">' +
		'<path class="ws-lid" d="M3,12 Q20,1 37,12 Q20,23 3,12 Z" />' +
		'<g class="ws-lashes">' +
		'<line vector-effect="non-scaling-stroke" x1="8" y1="19" x2="5.5" y2="23" />' +
		'<line vector-effect="non-scaling-stroke" x1="14" y1="21.3" x2="12.5" y2="25.3" />' +
		'<line vector-effect="non-scaling-stroke" x1="20" y1="22" x2="20" y2="26.2" />' +
		'<line vector-effect="non-scaling-stroke" x1="26" y1="21.3" x2="27.5" y2="25.3" />' +
		'<line vector-effect="non-scaling-stroke" x1="32" y1="19" x2="34.5" y2="23" />' +
		'</g>' +
		'</g>' +
		'</g>' +
		'<path class="ws-outline" d="M3,12 Q20,1 37,12 Q20,23 3,12 Z" />' +
		'</svg>';

	function fetchJSON(url, opts, onDone) {
		var controller = new AbortController();
		var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
		fetch(url, Object.assign({ signal: controller.signal }, opts || {}))
			.then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
			.then(function (data) { onDone(data); })
			.catch(function () { onDone(null); });
	}

	function fetchStatus(onDone) { fetchJSON(STATUS_URL, null, onDone); }

	function computeState(data) {
		if (!data || !data.alive) return "down";
		if (!data.enabled) return "down";
		var printers = data.printers || {};
		var watching = Object.keys(printers).some(function (k) { return printers[k] && printers[k].printing; });
		return watching ? "watching" : "idle";
	}

	function hasRecentAlert(data) {
		if (!data) return false;
		var printers = data.printers || {};
		var now = Date.now() / 1000;
		return Object.keys(printers).some(function (k) {
			var p = printers[k];
			return p && p.printing && p.lastAlertAt && (now - p.lastAlertAt) < ALERT_DISPLAY_SECONDS;
		});
	}

	function shortLabel(state) {
		if (sauronReason) return "сбой!";
		if (state === "down") return "неактивно";
		if (state === "watching") return "наблюдение";
		return "активно";
	}

	function setSauronReason(reason) {
		sauronReason = reason;
		wrapEl.classList.toggle("ws-sauron", !!sauronReason);
		if (tipEl) tipEl.textContent = shortLabel(currentState);
	}

	function checkAutoSauron(data) {
		var alerted = hasRecentAlert(data);
		if (alerted && sauronReason !== "egg") {
			setSauronReason("alert");
		} else if (!alerted && sauronReason === "alert") {
			setSauronReason(null);
		}
	}

	function checkEasterEgg() {
		var now = Date.now();
		eggClicks.push(now);
		eggClicks = eggClicks.filter(function (t) { return now - t < 1800; });
		if (eggClicks.length < 5) return;
		eggClicks = [];
		setSauronReason("egg");
		clearTimeout(sauronEggTimer);
		sauronEggTimer = setTimeout(function () {
			// после пасхалки — вернуться к реальному тревожному состоянию, если оно есть, иначе снять
			setSauronReason(hasRecentAlert(lastData) ? "alert" : null);
		}, 5000);
	}

	function applyState(state, data) {
		lastData = data;
		if (state !== currentState) {
			wrapEl.classList.remove("ws-state-down", "ws-state-idle", "ws-state-watching");
			wrapEl.classList.add("ws-state-" + state);
			currentState = state;
			scheduleBlink();
		}
		checkAutoSauron(data);
		if (tipEl) tipEl.textContent = shortLabel(state);
		if (badgeEl) {
			var n = (data && data.alertCount) || 0;
			badgeEl.textContent = n > 9 ? "9+" : String(n);
			badgeEl.hidden = n === 0;
		}
		if (reportEl && !reportEl.hidden) renderReport();
	}

	function formatDuration(seconds) {
		seconds = Math.max(0, Math.round(seconds || 0));
		var h = Math.floor(seconds / 3600);
		var m = Math.floor((seconds % 3600) / 60);
		if (h > 0) return h + "ч " + m + "м";
		if (m > 0) return m + "м";
		return seconds + "с";
	}

	function formatClock(epochSeconds) {
		var d = new Date(epochSeconds * 1000);
		function pad(n) { return (n < 10 ? "0" : "") + n; }
		return pad(d.getHours()) + ":" + pad(d.getMinutes());
	}

	function formatDate(epochSeconds) {
		var d = new Date(epochSeconds * 1000);
		function pad(n) { return (n < 10 ? "0" : "") + n; }
		return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " + formatClock(epochSeconds);
	}

	function renderLog() {
		var logEl = reportEl.querySelector(".ws-log-body");
		if (!logEl) return;
		logEl.innerHTML = '<div class="ws-report-line ws-report-muted">Загрузка…</div>';
		fetchJSON(EVENTS_URL, null, function (data) {
			if (!logOpen) return; // панель успели закрыть, пока грузилось
			var items = (data && data.events) || [];
			if (!items.length) {
				logEl.innerHTML = '<div class="ws-report-line ws-report-muted">Журнал пуст.</div>';
				return;
			}
			logEl.innerHTML = items.map(function (e) {
				var isAlert = e.kind === "alert";
				return '<div class="ws-log-item ' + (isAlert ? "ws-log-alert" : "ws-log-error") + '">' +
					'<span class="ws-log-time">' + formatDate(e.ts) + '</span> ' +
					'<span class="ws-log-printer">' + e.printer + '</span>: ' +
					'<span class="ws-log-msg">' + (isAlert ? "⚠ " : "") + e.message + '</span>' +
					'</div>';
			}).join("");
		});
	}

	function toggleLog() {
		logOpen = !logOpen;
		var logEl = reportEl.querySelector(".ws-log-body");
		var btn = reportEl.querySelector(".ws-log-toggle-btn");
		if (logEl) logEl.hidden = !logOpen;
		if (btn) btn.classList.toggle("ws-log-open", logOpen);
		if (logOpen) renderLog();
	}

	function clearLog() {
		fetchJSON(CLEAR_EVENTS_URL, { method: "POST" }, function () {
			if (badgeEl) badgeEl.hidden = true;
			if (logOpen) renderLog();
		});
	}

	function renderReport() {
		if (!reportEl) return;
		var data = lastData;
		var html = '<div class="ws-report-title"><i class="fa-solid fa-eye"></i> Наблюдение за печатью (ИИ)</div>';

		if (!data || !data.alive) {
			html += '<div class="ws-report-line ws-report-muted">Сервис недоступен — процесс мониторинга не запущен или не отвечает.</div>';
		} else if (!data.enabled) {
			html += '<div class="ws-report-line ws-report-muted">Мониторинг выключен в настройках (шестерёнка → «Наблюдение за печатью»).</div>';
		} else {
			var printers = data.printers || {};
			var names = Object.keys(printers);
			if (!names.length) {
				html += '<div class="ws-report-line ws-report-muted">Принтеры не настроены.</div>';
			}
			names.forEach(function (name) {
				var p = printers[name] || {};
				html += '<div class="ws-report-printer">';
				html += '<div class="ws-report-pname">' + name + '</div>';
				if (!p.printing) {
					html += '<div class="ws-report-line ws-report-muted">Сейчас не печатает — наблюдение приостановлено.</div>';
				} else if (p.error) {
					html += '<div class="ws-report-line ws-report-warn">Ошибка проверки кадра: ' + p.error + '</div>';
				} else {
					html += '<div class="ws-report-line">Веду наблюдение уже ' + formatDuration(p.watchingSeconds) + '.</div>';
					if (p.lastAlertAt) {
						html += '<div class="ws-report-line ws-report-warn">⚠ Возможен сбой — обнаружено в ' + formatClock(p.lastAlertAt) + '.</div>';
					} else {
						html += '<div class="ws-report-line ws-report-ok">Сбоев не обнаружено.</div>';
					}
					if (typeof p.confidence === "number") {
						html += '<div class="ws-report-line ws-report-muted">Последняя уверенность модели: ' + Math.round(p.confidence * 100) + '%.</div>';
					}
				}
				html += '</div>';
			});
		}

		if (data && data.alive) {
			var n = data.alertCount || 0;
			html += '<div class="ws-report-footer">' +
				'<button type="button" class="ws-log-toggle-btn' + (logOpen ? " ws-log-open" : "") + '">' +
				'<i class="fa-solid fa-list"></i> Журнал' + (n ? " (" + n + ")" : "") + '</button>' +
				'<button type="button" class="ws-log-clear-btn"><i class="fa-solid fa-trash"></i> Очистить</button>' +
				'</div>' +
				'<div class="ws-log-body" hidden></div>';
		}

		reportEl.innerHTML = html;

		var toggleBtn = reportEl.querySelector(".ws-log-toggle-btn");
		var clearBtn = reportEl.querySelector(".ws-log-clear-btn");
		if (toggleBtn) toggleBtn.addEventListener("click", toggleLog);
		if (clearBtn) clearBtn.addEventListener("click", function () {
			if (confirm("Очистить журнал событий?")) clearLog();
		});
		var logEl = reportEl.querySelector(".ws-log-body");
		if (logEl) { logEl.hidden = !logOpen; if (logOpen) renderLog(); }
	}

	function openReport() {
		renderReport();
		reportEl.hidden = false;
	}
	function closeReport() { reportEl.hidden = true; }
	function toggleReport() { if (reportEl.hidden) openReport(); else closeReport(); }

	function blinkOnce() {
		if (!lidGroupEl || sauronReason) return; // Саурон не моргает — немигающий огненный глаз
		lidGroupEl.classList.remove("ws-blink");
		// force reflow so re-adding the class restarts the CSS animation
		void lidGroupEl.offsetWidth;
		lidGroupEl.classList.add("ws-blink");
	}

	function scheduleBlink() {
		if (blinkTimer) clearTimeout(blinkTimer);
		if (currentState === "down") return; // статично — не моргает
		var min = currentState === "watching" ? 1500 : 4000;
		var max = currentState === "watching" ? 3200 : 8500;
		var delay = min + Math.random() * (max - min);
		blinkTimer = setTimeout(function () {
			blinkOnce();
			scheduleBlink();
		}, delay);
	}

	function poll() {
		fetchStatus(function (data) {
			applyState(computeState(data), data);
		});
	}

	function build() {
		wrapEl = document.createElement("div");
		wrapEl.id = "ws-eye";
		wrapEl.className = "ws-state-down";
		wrapEl.innerHTML = EYE_SVG;
		document.body.appendChild(wrapEl);
		lidGroupEl = wrapEl.querySelector(".ws-lid-group");

		// Бейдж с числом накопленных алертов (не сброшенных кнопкой "Очистить") — виден без
		// открытия отчёта, чтобы не пропустить, что что-то произошло, пока не смотрел на экран.
		badgeEl = document.createElement("div");
		badgeEl.id = "ws-badge";
		badgeEl.hidden = true;
		wrapEl.appendChild(badgeEl);

		// Свой всплывающий текст вместо стандартного браузерного title-тултипа (тот выглядит
		// "не по-нашему" — системный жёлтый прямоугольник). Короткое слово-статус на прозрачном
		// фоне, в стиле проекта, появляется под иконкой при наведении.
		tipEl = document.createElement("div");
		tipEl.id = "ws-tip";
		tipEl.textContent = "проверка…";
		document.body.appendChild(tipEl);

		reportEl = document.createElement("div");
		reportEl.id = "ws-report";
		reportEl.hidden = true;
		document.body.appendChild(reportEl);

		wrapEl.addEventListener("click", function (e) { e.stopPropagation(); checkEasterEgg(); toggleReport(); });
		document.addEventListener("click", function (e) {
			if (reportEl.hidden) return;
			if (reportEl.contains(e.target) || wrapEl.contains(e.target)) return;
			closeReport();
		});
		document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeReport(); });

		poll();
		setInterval(poll, POLL_MS);
	}

	window.addEventListener("klippydash:ready", build);
})();
