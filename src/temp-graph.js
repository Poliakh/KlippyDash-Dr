/*
 * temp-graph.js — add-on for KlippyDash (dev; not part of upstream, not in custom-controls.js).
 * Adds a Fluidd-style "Temperatures" card per printer tile: a table (element / power /
 * change °C/s / current / EDITABLE target) plus a live-updating line chart below it,
 * rendered with uPlot (src/vendor/uPlot.iife.min.js, ~50KB, no framework dependency).
 *
 * Data:
 *  - History seed: one-time GET {host}/server/temperature_store on load (Moonraker's
 *    built-in ring buffer, ~1 sample/sec, K1C configured for 600 samples/10min, QIDI
 *    default 1200/20min).
 *  - Live: this module runs its OWN poll loop (every 2s) via /printer/objects/query for
 *    extruder + heater_bed + the printer's chamberSensor (independent of custom-controls.js's
 *    poller, so this module has zero dependency on it and can be dropped/reverted alone).
 *  - Buffer: one shared time array + one value array per series per tile (all series are
 *    fetched in the same request, so they share timestamps). Capped at MAX_POINTS; when
 *    the cap is hit the buffer is decimated (every other point kept), so an all-night
 *    print keeps memory/render cost bounded while still covering the whole session.
 *
 * Editable target: a number input per row. While the user has it focused we do not
 * overwrite its value from polls (so we don't fight their typing). On Enter or blur, if
 * the value is a valid number, it POSTs the matching gcode (M104/M140/chamberTargetGcode()).
 */
(function () {
	var MAX_POINTS = 4000;      // per series; decimates (halves) when exceeded
	var POLL_MS = 2000;
	var HISTORY_ASSUMED_HZ = 1; // Moonraker's default temperature_store sample rate
	var Y_SCALE_MIN = 0;        // fixed y-axis range (NOT auto-scaling) — always 0..300
	var Y_SCALE_MAX = 300;

	var state = {}; // index -> { u, seriesDefs, buf:{t:[],y:[[],[],...]}, lastTs, editing:{}, host, printer, chartVisible }

	function ajaxPost(url, onDone) {
		var controller = new AbortController();
		var timeout = (typeof _ajaxTimeout !== "undefined" ? _ajaxTimeout : 15000);
		var timer = setTimeout(function () { controller.abort(); }, timeout);
		fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal })
			.then(function (response) {
				clearTimeout(timer);
				if (!response.ok) {
					var err = { statusText: response.statusText };
					alert("Temperatures: command failed\n" + (err && err.statusText ? err.statusText : ""));
					if (onDone) onDone(false);
					return;
				}
				if (onDone) onDone(true);
			})
			.catch(function (err) {
				clearTimeout(timer);
				alert("Temperatures: command failed\n" + (err && err.statusText ? err.statusText : ""));
				if (onDone) onDone(false);
			});
	}
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
	function scriptEndpoint(host, gcode) { return host + "/printer/gcode/script?script=" + encodeURIComponent(gcode); }

	// Универсальная команда "выключить" для одного объекта из printer.fans — выводится из
	// префикса имени объекта Klipper, без какого-либо per-printer gcode в settings.json:
	//   "fan"                    -> M107 (штатный part-cooling fan, управляется M106/M107)
	//   "output_pin X"           -> SET_PIN PIN=X VALUE=0
	//   "temperature_fan X"      -> SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=X (без TARGET —
	//                                сброс к дефолту из конфига принтера, читает сам Klipper)
	//   "heater_fan X"           -> null (сам гаснет по порогу температуры — не трогаем)
	//   что-то незнакомое        -> null (не угадываем)
	function fanOffGcode(object) {
		if (object === "fan") return "M107";
		if (object.indexOf("output_pin ") === 0) return "SET_PIN PIN=" + object.slice("output_pin ".length) + " VALUE=0";
		if (object.indexOf("temperature_fan ") === 0) return "SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=" + object.slice("temperature_fan ".length);
		return null;
	}

	// Универсальная команда "поставить цель T" для объекта камеры (printer.chamberSensor) —
	// выводится из префикса имени объекта, без per-printer chamberSetGcode/chamberGcode в
	// settings.json. Покрывает два реальных случая на К1С/QIDI; для незнакомого типа возвращает
	// null (кнопка/поле ввода просто не создаётся — см. buildSeriesDefs).
	function chamberTargetGcode(chamberSensor, target) {
		if (!chamberSensor) return null;
		if (chamberSensor.indexOf("temperature_fan ") === 0) {
			return "SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=" + chamberSensor.slice("temperature_fan ".length) + " TARGET=" + target;
		}
		if (chamberSensor.indexOf("heater_generic ") === 0) {
			return "SET_HEATER_TEMPERATURE HEATER=" + chamberSensor.slice("heater_generic ".length) + " TARGET=" + target;
		}
		return null;
	}

	// Полный g-code для Cooldown: гасит ВСЕ нагреватели (TURN_OFF_HEATERS — штатная команда
	// Klipper, срабатывает на extruder/heater_bed/heater_generic* разом, для любого принтера)
	// плюс все кулеры из printer.fans, кроме heater_fan (тот сам следит за порогом). Ничего
	// per-printer вписывать не нужно — только список fans, который и так заполняется ради
	// отображения статуса в панели "Fans".
	function buildCooldownGcode(printer) {
		var lines = ["TURN_OFF_HEATERS"];
		(printer.fans || []).forEach(function (f) {
			var g = fanOffGcode(f.object);
			if (g) lines.push(g);
		});
		return lines.join("\n");
	}

	// --- ступенчатый неблокирующий преднагрев (кнопка "Preheat" в шапке карточки) ---
	// Профиль {name, extruder, bed, chamber?, nozzleAfterBed?} — см. settings.json. chamber (число) —
	// команда на камеру выводится сама из printer.chamberSensor через chamberTargetGcode(), без
	// отдельного chamberGcode в профиле.
	// Сначала стол+камера сразу; сопло — либо сразу (если nozzleAfterBed не задан), либо когда
	// стол достигнет nozzleAfterBed (опрос раз в 3с, не блокируя очередь принтера).
	var stagePollers = {}; // index -> id интервала ступени
	function clearStage(index) {
		if (stagePollers[index]) { clearInterval(stagePollers[index]); delete stagePollers[index]; }
		var btn = document.querySelector("#tile" + index + " .tg-preheat-btn");
		if (btn) btn.classList.remove("tg-waiting");
	}
	window.__tgCancelStage = clearStage; // хук для custom-controls.js (Cancel/Restart/E-Stop)

	function startPreheat(index, host, printer, profile) {
		clearStage(index);
		var chamberGcode = profile.chamber ? chamberTargetGcode(printer.chamberSensor, profile.chamber) : null;
		ajaxPost(scriptEndpoint(host, "M140 S" + profile.bed + (chamberGcode ? "\n" + chamberGcode : "")));
		var threshold = Number(profile.nozzleAfterBed) || 0;
		if (!threshold) { ajaxPost(scriptEndpoint(host, "M104 S" + profile.extruder)); return; }
		var btn = document.querySelector("#tile" + index + " .tg-preheat-btn");
		if (btn) btn.classList.add("tg-waiting");
		var started = Date.now();
		var check = function () {
			ajaxGetJSON(host + "/printer/objects/query?heater_bed", 8000).then(function (r) {
				var t = 0; try { t = r.result.status.heater_bed.temperature; } catch (e) { t = 0; }
				if (t >= threshold) { ajaxPost(scriptEndpoint(host, "M104 S" + profile.extruder)); clearStage(index); }
				else if (Date.now() - started > 12 * 60 * 1000) { clearStage(index); } // сдаёмся через 12 мин
			}).catch(function () { /* silent, mirrors previous .done()-only jQuery behavior */ });
		};
		check(); stagePollers[index] = setInterval(check, 3000);
	}

	function buildSeriesDefs(printer) {
		// Цвета подобраны под палитру Fluidd: Extruder — красный, Heater Bed — голубой, Chamber — зелёный
		var defs = [
			{ key: "extruder", label: "Extruder", color: "#ef5350", setGcode: function (t) { return "M104 S" + t; } },
			{ key: "heater_bed", label: "Heater Bed", color: "#29b6f6", setGcode: function (t) { return "M140 S" + t; } }
		];
		if (printer.chamberSensor) {
			// setGcode остаётся null для нераспознанного типа объекта — строка для этого поля
			// рисуется без input'а (просто "–"), вместо попытки отправить непонятную команду.
			var chamberKnownType = chamberTargetGcode(printer.chamberSensor, 0) !== null;
			defs.push({
				key: printer.chamberSensor, label: "Chamber", color: "#66bb6a",
				setGcode: chamberKnownType ? function (t) { return chamberTargetGcode(printer.chamberSensor, t); } : null
			});
		}
		return defs;
	}

	// --- history seed ---
	function seedHistory(index) {
		var st = state[index];
		ajaxGetJSON(st.host + "/server/temperature_store", 10000).then(function (r) {
			var result = (r && r.result) || {};
			var nowSec = Math.floor(Date.now() / 1000);
			// find the longest series to use as the reference length; series with fewer
			// points (shouldn't normally happen - same ring buffer) are left-padded with their own first value.
			var arrays = st.seriesDefs.map(function (d) {
				var obj = result[d.key];
				return (obj && obj.temperatures) ? obj.temperatures : [];
			});
			var targetArrays = st.seriesDefs.map(function (d) {
				var obj = result[d.key];
				return (obj && obj.targets) ? obj.targets : [];
			});
			var len = arrays.reduce(function (m, a) { return Math.max(m, a.length); }, 0);
			if (len === 0) return; // nothing to seed with; live polling will populate from scratch
			var t = [];
			for (var i = 0; i < len; i++) t.push(nowSec - (len - 1 - i) * HISTORY_ASSUMED_HZ);
			function align(a) {
				if (a.length === len) return a.slice();
				var pad = a.length ? a[0] : null;
				var out = [];
				for (var i = 0; i < len - a.length; i++) out.push(pad);
				return out.concat(a);
			}
			st.buf.t = t;
			st.buf.y = arrays.map(align);
			st.buf.target = targetArrays.map(align);
			st.lastTs = t.length ? t[t.length - 1] : null;
			renderChartData(index);
		}).catch(function () { /* silent, mirrors previous .done()-only jQuery behavior */ });
	}

	// --- decimation to keep buffers bounded over long (overnight) sessions ---
	function decimateIfNeeded(buf) {
		if (buf.t.length <= MAX_POINTS) return;
		var lastIdx = buf.t.length - 1;
		var nt = [];
		var ny = buf.y.map(function () { return []; });
		var ntg = buf.target.map(function () { return []; });
		for (var i = 0; i < buf.t.length; i += 2) {
			nt.push(buf.t[i]);
			for (var s = 0; s < buf.y.length; s++) ny[s].push(buf.y[s][i]);
			for (var s3 = 0; s3 < buf.target.length; s3++) ntg[s3].push(buf.target[s3][i]);
		}
		if (lastIdx % 2 !== 0) {
			nt.push(buf.t[lastIdx]);
			for (var s2 = 0; s2 < buf.y.length; s2++) ny[s2].push(buf.y[s2][lastIdx]);
			for (var s4 = 0; s4 < buf.target.length; s4++) ntg[s4].push(buf.target[s4][lastIdx]);
		}
		buf.t = nt;
		buf.y = ny;
		buf.target = ntg;
	}

	// Столбец "Мощность" — тонкий бар + %, тот же визуальный стиль (.hp-bar/.hp-fill/.hp-val),
	// что раньше стоял у старых inline-строк Extruder/Bed (custom-controls.css); тут просто
	// другая обёртка (.tg-power-wrap, обычный inline-flex, без absolute-позиционирования).
	function updatePowerCell(row, obj) {
		var p = null;
		if (obj) {
			if (typeof obj.power === "number") p = obj.power;
			else if (typeof obj.speed === "number") p = obj.speed;
		}
		var fillEl = row.querySelector(".hp-fill");
		var valEl = row.querySelector(".hp-val");
		if (p === null) { valEl.textContent = "–"; fillEl.style.width = "0%"; return; }
		var pct = Math.round(p * 100);
		fillEl.style.width = Math.max(pct, 0) + "%";
		valEl.textContent = pct <= 0 ? "off" : pct + "%";
	}
	function fmtChange(buf, seriesIdx) {
		var t = buf.t, y = buf.y[seriesIdx];
		if (!y || y.length < 2) return "";
		var n = y.length;
		var dt = t[n - 1] - t[n - 2];
		if (dt <= 0) dt = 1;
		var rate = (y[n - 1] - y[n - 2]) / dt;
		var sign = rate >= 0 ? "+" : "";
		return sign + rate.toFixed(1) + "°C/s";
	}

	// Подстраховка на случай, если ResizeObserver/window-resize не долетели (некоторые мобильные
	// браузеры "замораживают" наблюдатели у фоновой вкладки, а при возврате не всегда сами досылают
	// событие) — сверяем реальную ширину контейнера с тем, что нарисовано, раз в цикл опроса (2с).
	function syncChartSize(index) {
		var st = state[index];
		if (!st.u || !st.chartVisible) return;
		var el = document.querySelector("#tile" + index + " .tg-chart");
		if (!el) return;
		var w = Math.max(el.clientWidth, 100);
		var isNarrow = window.innerWidth < 560;
		var h = isNarrow ? 140 : 220;
		if (Math.abs(st.u.width - w) > 2 || st.u.height !== h) st.u.setSize({ width: w, height: h });
	}

	// --- live poll ---
	function pollLive(index) {
		var st = state[index];
		syncChartSize(index);
		var objs = ["extruder", "heater_bed"].concat(st.printer.chamberSensor ? [st.printer.chamberSensor] : []);
		var q = objs.map(function (o) { return encodeURIComponent(o); }).join("&");
		ajaxGetJSON(st.host + "/printer/objects/query?" + q, (typeof _ajaxTimeout !== "undefined" ? _ajaxTimeout : 15000))
			.then(function (r) {
				var stat = (r && r.result && r.result.status) || {};
				var nowSec = Math.floor(Date.now() / 1000);
				if (st.lastTs !== null && nowSec <= st.lastTs) nowSec = st.lastTs + 1; // keep x strictly increasing
				st.buf.t.push(nowSec);
				st.seriesDefs.forEach(function (d, i) {
					var obj = stat[d.key];
					var temp = obj && typeof obj.temperature === "number" ? obj.temperature : null;
					st.buf.y[i].push(temp);
					var target = obj && typeof obj.target === "number" ? obj.target : null;
					st.buf.target[i].push(target);
				});
				st.lastTs = nowSec;
				decimateIfNeeded(st.buf);
				updateTable(index, stat);
				renderChartData(index);
			})
			.catch(function () { /* silent, mirrors previous .done()-only jQuery behavior */ });
	}

	function updateTable(index, stat) {
		var st = state[index];
		st.seriesDefs.forEach(function (d, i) {
			var obj = stat[d.key];
			var row = document.querySelector("#tile" + index + " .tg-row[data-idx='" + i + "']");
			if (!obj || !row) return;
			updatePowerCell(row, obj);
			row.querySelector(".tg-change").textContent = fmtChange(st.buf, i);
			row.querySelector(".tg-current").textContent = typeof obj.temperature === "number" ? obj.temperature.toFixed(1) + "°C" : "–";
			var input = row.querySelector(".tg-target-input");
			var isEditing = st.editing[d.key];
			if (input && !isEditing && typeof obj.target === "number" && document.activeElement !== input) {
				input.value = Math.round(obj.target);
			}
		});
	}

	function renderChartData(index) {
		var st = state[index];
		if (!st.u || !st.buf.t.length) return;
		// значения, потом (тем же порядком) целевые — соответствует порядку серий в makeUplot
		var data = [st.buf.t].concat(st.buf.y).concat(st.buf.target);
		st.u.setData(data);
	}

	// Значения прямо у точек пересечения курсора с линиями, каждое цветом своей линии.
	// Штатная легенда uPlot показывает то же самое, но отдельным блоком под графиком — она
	// отключена (legend: {show:false}), чтобы не занимать место и не выбиваться из оформления.
	function cursorValuesPlugin(seriesDefs) {
		var labels = [];
		var MIN_GAP = 15; // px между подписями по вертикали, чтобы не наезжали друг на друга

		return {
			hooks: {
				init: function (u) {
					seriesDefs.forEach(function (d) {
						var el = document.createElement("div");
						el.className = "tg-point-val";
						el.style.color = d.color;
						el.hidden = true;
						u.over.appendChild(el);
						labels.push(el);
					});
				},
				setCursor: function (u) {
					var idx = u.cursor.idx;
					var left = u.cursor.left;

					if (idx == null || left == null || left < 0) {
						labels.forEach(function (el) { el.hidden = true; });
						return;
					}

					// сначала посчитать позиции, потом развести по вертикали — иначе близкие
					// значения (например, стол 104 и цель 105) сливаются в нечитаемую кашу
					var shown = [];
					seriesDefs.forEach(function (d, i) {
						var el = labels[i];
						var v = u.data[i + 1] ? u.data[i + 1][idx] : null;
						if (v == null) { el.hidden = true; return; }
						el.textContent = v.toFixed(1) + "°";
						el.hidden = false;
						shown.push({ el: el, y: u.valToPos(v, "y") });
					});

					shown.sort(function (a, b) { return a.y - b.y; });
					for (var i = 1; i < shown.length; i++) {
						if (shown[i].y - shown[i - 1].y < MIN_GAP) shown[i].y = shown[i - 1].y + MIN_GAP;
					}

					shown.forEach(function (s) {
						var w = s.el.offsetWidth;
						var h = s.el.offsetHeight;
						// справа от курсора, а у правого края графика — слева, иначе обрежется
						var x = left + 8;
						if (x + w > u.over.clientWidth) x = left - w - 8;
						var y = Math.min(Math.max(s.y - h / 2, 0), u.over.clientHeight - h);
						s.el.style.transform = "translate(" + Math.max(0, x) + "px," + y + "px)";
					});
				}
			}
		};
	}

	function makeUplot(index, containerEl) {
		var st = state[index];
		var w = Math.max(containerEl.clientWidth, 100);
		var isNarrow = window.innerWidth < 560;
		var opts = {
			width: w,
			height: isNarrow ? 140 : 220,
			padding: [8, 8, 0, 0],
			legend: { show: false },
			cursor: {},
			plugins: [cursorValuesPlugin(st.seriesDefs)],
			scales: { x: { time: true }, y: { range: [Y_SCALE_MIN, Y_SCALE_MAX] } },
			axes: [
				{ stroke: "#8a8f98", grid: { stroke: "rgba(255,255,255,.06)" } },
				// основные линии с подписями; splits заданы явно — шкала всё равно закреплена 0..300
				{ stroke: "#8a8f98", grid: { stroke: "rgba(255,255,255,.06)" }, size: 42, splits: [0, 100, 200, 300] },
				// Промежуточные 50/150/250 — отдельной осью на той же шкале: у одной оси все линии
				// сетки рисуются одним стилем, а эти нужны тоньше и пунктиром. Подписей и делений
				// нет, ширины не занимает (size: 0), поэтому на раскладку графика не влияет.
				// Прозрачность чуть выше, чем у основных: пунктир зрительно читается бледнее сплошной.
				{
					scale: "y",
					side: 3,
					size: 0,
					gap: 0,
					ticks: { show: false },
					splits: [50, 150, 250],
					values: function (u, splits) { return splits.map(function () { return ""; }); },
					grid: { stroke: "rgba(255,255,255,.10)", width: 1, dash: [2, 4] }
				}
			],
			series: [{}]
				.concat(st.seriesDefs.map(function (d) {
					return { label: d.label, stroke: d.color, width: 2, points: { show: false }, spanGaps: true };
				}))
				// пунктирные линии цели — тем же цветом, тоньше; идут ПОСЛЕ обычных серий,
				// поэтому индексы в data должны совпадать (см. renderChartData/initialData ниже)
				.concat(st.seriesDefs.map(function (d) {
					return { label: d.label + " target", stroke: d.color, width: 1, dash: [6, 4], points: { show: false }, spanGaps: true };
				}))
		};
		var emptyLen = [Math.floor(Date.now() / 1000)];
		var initialData = [st.buf.t.length ? st.buf.t : emptyLen]
			.concat(st.seriesDefs.map(function (d, i) { return st.buf.y[i] && st.buf.y[i].length ? st.buf.y[i] : [null]; }))
			.concat(st.seriesDefs.map(function (d, i) { return st.buf.target[i] && st.buf.target[i].length ? st.buf.target[i] : [null]; }));
		st.u = new uPlot(opts, initialData, containerEl);
	}

	function attachResize(index, wrapEl) {
		var st = state[index];
		var timer = null;
		function doResize() {
			if (!st.u || !st.chartVisible) return;
			var w = Math.max(wrapEl.clientWidth, 100);
			var isNarrow = window.innerWidth < 560;
			st.u.setSize({ width: w, height: isNarrow ? 140 : 220 });
		}
		if (typeof ResizeObserver !== "undefined") {
			new ResizeObserver(function () {
				clearTimeout(timer);
				timer = setTimeout(doResize, 80);
			}).observe(wrapEl);
		}
		window.addEventListener("resize", function () {
			clearTimeout(timer);
			timer = setTimeout(doResize, 80);
		});
	}

	function buildCard(tile, index, printer, host) {
		var seriesDefs = buildSeriesDefs(printer);
		state[index] = { u: null, seriesDefs: seriesDefs,
			buf: { t: [], y: seriesDefs.map(function () { return []; }), target: seriesDefs.map(function () { return []; }) },
			lastTs: null, editing: {}, host: host, printer: printer, chartVisible: true };

		var card = document.createElement("div");
		card.className = "tg-card";
		var header = document.createElement("div");
		header.className = "tg-header";
		var controlsRow = document.createElement("div");
		controlsRow.className = "tg-header-controls";
		controlsRow.insertAdjacentHTML("beforeend", '<i class="fa-solid fa-fire tg-header-icon"></i><span class="tg-title">Temperatures</span>');

		if (printer.preheatProfiles && printer.preheatProfiles.length) {
			var preheatWrap = document.createElement("span");
			preheatWrap.className = "tg-preheat-wrap";
			var preheatWrapEl = document.createElement("div");
			preheatWrapEl.innerHTML =
				'<span class="tg-hdr-btn tg-preheat-btn" title="Preheat">' +
				'<i class="fa-solid fa-fire"></i><span class="tg-hdr-btn-label">Preheat</span>' +
				'<i class="fa-solid fa-caret-down tg-caret"></i></span>';
			var preheatBtn = preheatWrapEl.firstElementChild;
			var menu = document.createElement("div");
			menu.className = "tg-preheat-menu";
			printer.preheatProfiles.forEach(function (profile) {
				var sub = profile.extruder + "° / " + profile.bed + "°" + (profile.chamber ? " / " + profile.chamber + "°" : "");
				var itemWrap = document.createElement("div");
				itemWrap.innerHTML = '<div class="tg-preheat-item">' + profile.name + '<span class="tg-preheat-item-sub">' + sub + '</span></div>';
				var item = itemWrap.firstElementChild;
				item.addEventListener("click", function () {
					startPreheat(index, host, printer, profile);
					menu.classList.remove("tg-open");
				});
				menu.appendChild(item);
			});
			preheatBtn.addEventListener("click", function (e) {
				e.stopPropagation();
				document.querySelectorAll(".tg-preheat-menu").forEach(function (m) { if (m !== menu) m.classList.remove("tg-open"); }); // закрыть другие открытые меню
				menu.classList.toggle("tg-open");
			});
			preheatWrap.appendChild(preheatBtn);
			preheatWrap.appendChild(menu);
			controlsRow.appendChild(preheatWrap);
		}

		var coolWrap = document.createElement("div");
		coolWrap.innerHTML =
			'<span class="tg-hdr-btn tg-cooldown-btn" title="Turn off all heaters">' +
			'<i class="fa-solid fa-snowflake"></i><span class="tg-hdr-btn-label">Cooldown</span></span>';
		var cool = coolWrap.firstElementChild;
		cool.addEventListener("click", function () {
			clearStage(index);
			var g = buildCooldownGcode(printer);
			showConfirmation("Cooldown?", "Turn off ALL heaters and fans?<br/><br/>Printer: " + printer.name, scriptEndpoint(host, g));
		});
		controlsRow.appendChild(cool);

		controlsRow.insertAdjacentHTML("beforeend",
			'<span class="tg-toggle-chart" title="Show/hide chart"><i class="fa-solid fa-chart-line"></i> <span class="tg-toggle-label">Hide chart</span></span>'
		);
		header.appendChild(controlsRow);
		card.appendChild(header);

		var tableWrap = document.createElement("div");
		tableWrap.className = "tg-table-wrap";
		var tableHolder = document.createElement("div");
		tableHolder.innerHTML =
			'<table class="tg-table">' +
			'<thead><tr>' +
			'<th class="tg-col-elem">Item</th>' +
			'<th class="tg-col-power">Power</th>' +
			'<th class="tg-col-change">Change</th>' +
			'<th class="tg-col-current">Current</th>' +
			'<th class="tg-col-target">Target</th>' +
			'</tr></thead><tbody></tbody></table>';
		var table = tableHolder.firstElementChild;
		var tbody = table.querySelector("tbody");
		seriesDefs.forEach(function (d, i) {
			var rowHolder = document.createElement("tbody");
			rowHolder.innerHTML =
				'<tr class="tg-row" data-idx="' + i + '">' +
				'<td class="tg-elem"><i class="fa-solid fa-fire tg-icon" style="color:' + d.color + '"></i><span class="tg-elem-label">' + d.label + '</span></td>' +
				'<td class="tg-power"><span class="tg-power-wrap"><span class="hp-bar"><span class="hp-fill"></span></span><span class="hp-val">–</span></span></td>' +
				'<td class="tg-change"></td>' +
				'<td class="tg-current">–</td>' +
				'<td class="tg-target-cell">' +
				(d.setGcode ? '<input type="number" class="tg-target-input" step="1" min="0" max="350" inputmode="numeric">' : '<span class="tg-no-target">–</span>') +
				(d.setGcode ? '<sup>°C</sup>' : '') +
				'</td>' +
				'</tr>';
			var row = rowHolder.firstElementChild;
			tbody.appendChild(row);
			if (d.setGcode) {
				var input = row.querySelector(".tg-target-input");
				input.addEventListener("focus", function () { state[index].editing[d.key] = true; });
				function commit() {
					state[index].editing[d.key] = false;
					var v = parseFloat(input.value);
					if (!isNaN(v) && v >= 0) ajaxPost(scriptEndpoint(host, d.setGcode(v)));
				}
				input.addEventListener("blur", commit);
				input.addEventListener("keydown", function (e) { if (e.key === "Enter") { input.blur(); } });
			}
		});
		tableWrap.appendChild(table);
		card.appendChild(tableWrap);

		var chartWrap = document.createElement("div");
		chartWrap.className = "tg-chart-wrap";
		var chart = document.createElement("div");
		chart.className = "tg-chart";
		chartWrap.appendChild(chart);
		card.appendChild(chartWrap);

		card.querySelector(".tg-toggle-chart").addEventListener("click", function () {
			var st = state[index];
			st.chartVisible = !st.chartVisible;
			chartWrap.classList.toggle("tg-hidden", !st.chartVisible);
			card.querySelector(".tg-toggle-label").textContent = st.chartVisible ? "Hide chart" : "Show chart";
			if (st.chartVisible && st.u) {
				// size may be stale after being hidden (display:none collapses width)
				setTimeout(function () {
					var w = Math.max(chart.clientWidth, 100);
					st.u.setSize({ width: w, height: window.innerWidth < 560 ? 140 : 220 });
				}, 0);
			}
		});

		tile.appendChild(card);

		setTimeout(function () {
			makeUplot(index, chart);
			attachResize(index, chart);
			renderChartData(index);
		}, 0);
		seedHistory(index);
		pollLive(index);
		setInterval(function () { pollLive(index); }, POLL_MS);
	}

	// закрыть открытое меню преднагрева по клику вне его / по Escape
	document.addEventListener("click", function () {
		document.querySelectorAll(".tg-preheat-menu").forEach(function (m) { m.classList.remove("tg-open"); });
	});
	document.addEventListener("keydown", function (e) {
		if (e.key === "Escape") document.querySelectorAll(".tg-preheat-menu").forEach(function (m) { m.classList.remove("tg-open"); });
	});

	// см. custom-controls.js — плитки появляются после асинхронного fetch("settings.json"),
	// поэтому стартуем по "klippydash:ready", а не по DOMContentLoaded.
	window.addEventListener("klippydash:ready", function () {
		if (typeof uPlot === "undefined") { console.error("temp-graph.js: uPlot not loaded"); return; }
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
