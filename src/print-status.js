/*
 * print-status.js — экспериментальная надстройка для KlippyDash (dev, отдельный модуль).
 * Карточка "3D PRINT STATUS" (по референсу пользователя): статус-пилюля, крупное "Remaining
 * Time" + ETA, прогресс-бар, три плитки (Total Time / Print Time / Filament Used) с иконками
 * и цветовым акцентом, снизу — имя файла + бейдж Z-offset (перенесён из своей строки, которую
 * создал custom-controls.js). Заменяет собой штатные .section-file/.section-printstats
 * (они скрываются CSS-ом, но НЕ трогаем их код — стало быть, времена/прогресс/имя файла всё
 * так же считает и пишет туда штатный klippydash.js; мы просто ЧИТАЕМ те же цифры сами через
 * свой независимый опрос, используя штатные formatTime()/isSameDay() для единообразия).
 *
 * Пока это ЧЕРНОВИК ("давай поиграем") — цвета/размеры/раскладка ожидаемо будут донастраиваться.
 */
(function () {
	var POLL_MS = 2000;
	var state = {}; // index -> { host, printer }
	var metaCache = {}; // index -> { filename, total, weightTotal } — общие длина(мм)/масса(г) филамента файла, из /server/files/metadata
	var filamentUnit = {}; // index -> "m" | "g" — текущая единица отображения плитки FILAMENT USED
	var filamentRevertTimers = {}; // index -> timeout id (авто-возврат в метры через 5с)

	var STATE_META = {
		printing: { label: "PRINTING", cls: "ps-s-printing" },
		paused: { label: "PAUSED", cls: "ps-s-paused" },
		complete: { label: "COMPLETE", cls: "ps-s-complete" },
		cancelled: { label: "CANCELLED", cls: "ps-s-cancelled" },
		error: { label: "ERROR", cls: "ps-s-error" },
		standby: { label: "STANDBY", cls: "ps-s-standby" },
		ready: { label: "STANDBY", cls: "ps-s-standby" }
	};

	function ajaxGetJSON(url, timeout) {
		var controller = new AbortController();
		var timer = timeout ? setTimeout(function () { controller.abort(); }, timeout) : null;
		return fetch(url, { method: "GET", signal: controller.signal }).then(function (response) {
			if (timer) clearTimeout(timer);
			if (!response.ok) return Promise.reject(response);
			return response.json();
		}).catch(function (err) {
			if (timer) clearTimeout(timer);
			return Promise.reject(err);
		});
	}

	function buildCard(tile, index, printer, host) {
		state[index] = { host: host, printer: printer };

		var cardHtml =
			'<div class="ps-card">' +
			'<div class="ps-header">' +
			'<i class="fa-solid fa-cube ps-header-icon"></i><span class="ps-title">3D Print Status</span>' +
			'<span class="ps-status"><span class="ps-status-dot"></span><span class="ps-status-text">–</span></span>' +
			'</div>' +
			'<div class="ps-body">' +
			'<div class="ps-progress-row">' +
			'<div class="ps-progress-header">' +
			'<span class="ps-label">PRINT PROGRESS</span>' +
			'<span class="ps-progress-pct">0%</span>' +
			'</div>' +
			'<div class="ps-progress-bar"><div class="ps-progress-fill"></div></div>' +
			'</div>' +
			'<div class="ps-stats-row">' +
			'<div class="ps-stat"><div class="ps-stat-head"><i class="fa-solid fa-hourglass-half"></i><span class="ps-label">REMAINING TIME</span></div><div class="ps-stat-value ps-remaining-tile">–</div></div>' +
			'<div class="ps-stat"><div class="ps-stat-head"><i class="fa-solid fa-clock"></i><span class="ps-label">PRINT TIME</span></div><div class="ps-stat-value ps-print-time">–</div></div>' +
			'<div class="ps-stat"><div class="ps-stat-head"><i class="fa-solid fa-ruler-horizontal"></i><span class="ps-label">FILAMENT USED</span></div><div class="ps-stat-value ps-filament">–</div></div>' +
			'<div class="ps-stat"><div class="ps-stat-head"><i class="fa-solid fa-gauge-high"></i><span class="ps-label">FLOW / SPEED</span></div><div class="ps-stat-value ps-flow-speed">–</div></div>' +
			'</div>' +
			'</div>' +
			'<div class="ps-footer">' +
			'<span class="ps-filename">–</span>' +
			'<span class="ps-footer-right">' +
			'<span class="ps-eta">ETA <span class="ps-eta-value">–</span></span>' +
			'<span class="ps-zoffset"><i class="fa-solid fa-arrows-up-down"></i><span class="ps-zoffset-value"></span></span>' +
			'</span>' +
			'</div>' +
			'</div>';

		var wrapper = document.createElement("div");
		wrapper.innerHTML = cardHtml;
		var card = wrapper.firstElementChild;

		var filamentStat = card.querySelector(".ps-filament").closest(".ps-stat");
		filamentStat.classList.add("ps-stat-clickable");
		filamentStat.addEventListener("click", function () {
			filamentUnit[index] = (filamentUnit[index] === "g") ? "m" : "g";
			updateFilamentTile(index);
			clearTimeout(filamentRevertTimers[index]);
			if (filamentUnit[index] === "g") {
				filamentRevertTimers[index] = setTimeout(function () {
					filamentUnit[index] = "m";
					updateFilamentTile(index);
				}, 5000);
			}
		});

		// Прячем штатные "File Name" + "Print Stats" — эта карточка их заменяет визуально
		// (сами элементы не трогаем: их продолжает обновлять штатный klippydash.js).
		var sectionFile = tile.querySelector(".section-file");
		var sectionPrintstats = tile.querySelector(".section-printstats");
		if (sectionFile) sectionFile.classList.add("ps-superseded");
		if (sectionPrintstats) sectionPrintstats.classList.add("ps-superseded");
		// Z-offset считаем и пишем САМИ (см. render()) из gcode_move.homing_origin — тот же
		// источник, что использует штатный .section-z-offset (который теперь скрыт вместе с
		// остальной .section-extruder и больше не трогается, во избежание поломки его апдейта).

		// Две ОТДЕЛЬНЫЕ карточки (каждая — свой фон/бордер/скругления), просто выровненные
		// в ряд через flex-обёртку (.ps-row): отступ между ними и одинаковая высота даёт чистый
		// CSS (align-items:stretch по умолчанию) — никакого JS для этого не нужно.
		var row = document.createElement("div");
		row.className = "ps-row";
		row.appendChild(card);
		var fans = tile.querySelector(".info-right");
		if (fans) {
			fans.remove();
			row.appendChild(fans);
		}

		// Вставляем ряд туда же, где раньше была "File Name" (сразу под ней/над ней).
		var anchor = tile.querySelector(".section-file");
		if (anchor) anchor.insertAdjacentElement("beforebegin", row);
		else { var camDiv = tile.querySelector("div.cam"); if (camDiv) camDiv.insertAdjacentElement("afterend", row); }

		// Часы поверх камеры (вместо штатной строки-даты .section-time, которая скрыта в CSS).
		var clock = document.createElement("span");
		clock.className = "cam-clock";
		var camDiv2 = tile.querySelector("div.cam");
		if (camDiv2) camDiv2.appendChild(clock);
		updateClock(clock);
		setInterval(function () { updateClock(clock); }, 30000);

		pollStatus(index);
		setInterval(function () { pollStatus(index); }, POLL_MS);
	}

	function updateClock(clockEl) {
		var d = new Date();
		var pad = function (n) { return (n < 10 ? "0" : "") + n; };
		var yy = pad(d.getFullYear() % 100);
		clockEl.textContent = d.getDate() + "." + pad(d.getMonth() + 1) + "." + yy + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
	}

	// Общая длина филамента (мм) берём из метаданных gcode-файла — print_stats её не содержит.
	// Кэшируем по имени файла, чтобы не дёргать /server/files/metadata на каждый опрос (2с).
	function fetchFilamentTotal(index, filename) {
		var st = state[index];
		metaCache[index] = { filename: filename, total: null }; // сразу помечаем "уже запрошено"
		ajaxGetJSON(st.host + "/server/files/metadata?filename=" + encodeURIComponent(filename),
			(typeof _ajaxTimeout !== "undefined" ? _ajaxTimeout : 15000))
			.then(function (r) {
				var res = (r && r.result) || {};
				var total = typeof res.filament_total === "number" ? res.filament_total : null;
				var weightTotal = typeof res.filament_weight_total === "number" ? res.filament_weight_total : null;
				if (metaCache[index] && metaCache[index].filename === filename) {
					metaCache[index].total = total;
					metaCache[index].weightTotal = weightTotal;
				}
			})
			.catch(function () { /* silent, mirrors previous .done()-only jQuery behavior */ });
	}

	// Плитка FILAMENT USED: по умолчанию метры (использовано/всего), по клику на 5с
	// переключается в граммы (масса пропорциональна длине — метраж и общая масса из
	// метаданных файла), затем сама возвращается обратно в метры.
	function updateFilamentTile(index) {
		var f = state[index] && state[index].lastFilament;
		var valEl = document.querySelector("#tile" + index + " .ps-filament");
		if (!valEl) return;
		if (!f) { valEl.textContent = "–"; return; }

		var unit = filamentUnit[index] || "m";
		if (unit === "g") {
			if (typeof f.weightTotal === "number" && typeof f.totalMM === "number" && f.totalMM > 0) {
				var usedG = f.weightTotal * (f.usedMM / f.totalMM);
				valEl.textContent = usedG.toFixed(1) + " / " + f.weightTotal.toFixed(1) + " g";
			} else {
				valEl.textContent = "… / … g";
			}
		} else {
			var usedM = (f.usedMM / 1000).toFixed(2);
			var totalM = typeof f.totalMM === "number" ? (f.totalMM / 1000).toFixed(2) + " m" : "…";
			valEl.textContent = usedM + " / " + totalM;
		}
	}

	function pollStatus(index) {
		var st = state[index];
		ajaxGetJSON(st.host + "/printer/objects/query?print_stats&display_status&gcode_move",
			(typeof _ajaxTimeout !== "undefined" ? _ajaxTimeout : 15000))
			.then(function (r) {
				var s = (r && r.result && r.result.status) || {};
				render(index, s.print_stats || {}, s.display_status || {}, s.gcode_move || {});
			})
			.catch(function () { /* silent, mirrors previous .done()-only jQuery behavior */ });
	}

	function render(index, ps, ds, gm) {
		var card = document.querySelector("#tile" + index + " .ps-card");
		if (!card) return;

		var printState = (ps.state || "ready").toLowerCase();
		var meta = STATE_META[printState] || STATE_META.standby;
		card.querySelector(".ps-status").className = "ps-status " + meta.cls;
		card.querySelector(".ps-status-text").textContent = meta.label;

		card.querySelector(".ps-filename").textContent = ps.filename || "–";

		// Z-offset — всегда показываем, включая ровный ноль (раньше прятали при |babystep| < 0.001,
		// но тогда на принтере без бэбистепа бейджа не было вообще, а на другом с офсетом — был,
		// выглядело как будто что-то не работает).
		var zOffset = (gm.homing_origin && typeof gm.homing_origin[2] === "number") ? gm.homing_origin[2] : 0;
		var zw = card.querySelector(".ps-zoffset");
		var sign = zOffset > 0 ? "+" : "";
		zw.querySelector(".ps-zoffset-value").textContent = sign + zOffset.toFixed(3) + "mm";

		// Flow/Speed — множители из gcode_move (уже запрашиваем его ради z-offset, доп.
		// запрос не нужен). 1.0 = 100%; штатно эти значения показывались только внутри
		// скрытой теперь .section-extruder, поэтому дублируем их тут отдельной плиткой.
		var flow = typeof gm.extrude_factor === "number" ? Math.round(gm.extrude_factor * 100) : 100;
		var speed = typeof gm.speed_factor === "number" ? Math.round(gm.speed_factor * 100) : 100;
		card.querySelector(".ps-flow-speed").textContent = flow + "% / " + speed + "%";

		var progress = typeof ds.progress === "number" ? ds.progress : 0;
		var pct = Math.round(progress * 100);
		card.querySelector(".ps-progress-pct").textContent = pct + "%";
		card.querySelector(".ps-progress-fill").style.width = pct + "%";

		var showTimes = printState === "printing" || printState === "paused" || printState === "complete";
		if (showTimes) {
			card.querySelector(".ps-print-time").innerHTML = formatTime(ps.print_duration || 0);

			var filename = ps.filename || "";
			var cache = metaCache[index];
			if (filename && (!cache || cache.filename !== filename)) fetchFilamentTotal(index, filename);
			state[index].lastFilament = {
				usedMM: ps.filament_used || 0,
				totalMM: (cache && cache.filename === filename) ? cache.total : null,
				weightTotal: (cache && cache.filename === filename) ? cache.weightTotal : null
			};
			updateFilamentTile(index);

			// порог 1% (а не буквально >0, как в штатном коде) — при доле процента экстраполяция
			// "print_duration/progress" даёт абсурдные оценки (типа "1d 21h" на 3-й минуте печати)
			if (progress > 0.01 && printState !== "complete") {
				var estimatedTotal = ps.print_duration / progress;
				var remaining = estimatedTotal - ps.print_duration;
				card.querySelector(".ps-remaining-tile").innerHTML = formatTime(remaining);
				var endTime = new Date(Date.now() + remaining * 1000);
				card.querySelector(".ps-eta-value").textContent = isSameDay(endTime, new Date()) ? endTime.toLocaleTimeString() : endTime.toLocaleString();
			} else if (printState === "complete") {
				card.querySelector(".ps-remaining-tile").textContent = "0s";
				card.querySelector(".ps-eta-value").textContent = "–";
			} else {
				card.querySelector(".ps-remaining-tile").textContent = "Calculating…";
				card.querySelector(".ps-eta-value").textContent = "Calculating…";
			}
		} else {
			card.querySelector(".ps-print-time").textContent = "–";
			card.querySelector(".ps-filament").textContent = "–";
			card.querySelector(".ps-remaining-tile").textContent = "–";
			card.querySelector(".ps-eta-value").textContent = "–";
		}
	}

	// см. custom-controls.js — плитки появляются после асинхронного fetch("settings.json"),
	// поэтому стартуем по "klippydash:ready", а не по DOMContentLoaded.
	window.addEventListener("klippydash:ready", function () {
		document.querySelectorAll(".tile").forEach(function (tile) {
			var index;
			try { index = JSON.parse(tile.getAttribute("data")).index; } catch (e) { index = tile.id.replace("tile", ""); }
			var printer = (typeof _printers !== "undefined" && _printers[index]) ? _printers[index] : null;
			if (!printer) return;
			var host = (printer.host || "").replace(/\/+$/, "");
			buildCard(tile, index, printer, host);
		});
	});
})();
