/*
 * custom-controls.js — надстройка для KlippyDash (наш локальный форк; штатные файлы не трогаем).
 * Подключается в index.html ПОСЛЕ klippydash.js.
 *
 * Добавляет для КАЖДОГО принтера (шаблон один — применяется ко всем .tile):
 *  - панель управления ПОД камерой:
 *      [ Resume | Pause | Cancel | Clear ] [ Light ] [ Restart ] [ Fluidd ] [ E-Stop ]
 *  - строку Z-offset (вынута из штатной .section-extruder, которая теперь полностью скрыта)
 *  - плавающий ПРАВЫЙ столбец с анимированными иконками вентиляторов (скорость вращения ∝ оборотам)
 *  - переключатель света (SET_PIN), отражающий текущее состояние
 *
 * Resume/Pause/Cancel/Clear/E-Stop — это ТЕ ЖЕ штатные элементы, перенесённые под камеру;
 * чтобы их динамика (показ по состоянию) продолжала работать, ослабляем штатный getTileControl.
 * ПРИМЕЧАНИЕ: температуру/мощность нагревателей и Preheat/Cooldown теперь полностью показывает
 * карточка «Температуры» (temp-graph.js, свой независимый опрос) — здесь этого больше нет.
 * Остался только опциональный хук window.__tgCancelStage(index), который temp-graph.js
 * подставляет сам — используем его (если есть) при Cancel/Restart/E-Stop, чтобы оборвать
 * незавершённую ступень преднагрева. Опрос раз в 2.5с здесь обновляет только вентиляторы/свет.
 */
(function () {
	var statusTimers = {};   // index -> id интервала опроса вентиляторов/камеры/света
	var lightState = {};     // index -> bool (свет включён)

	function cancelPreheatStage(index) {
		if (typeof window.__tgCancelStage === "function") window.__tgCancelStage(index);
	}

	// Штатный getTileControl использует жёсткий путь «прямой потомок»; ослабляем до поиска
	// по потомкам в пределах плитки, чтобы контролы обновлялись после переноса под камеру.
	window.getTileControl = function (index, name) { return document.querySelectorAll("#tile" + index + " .control-" + name); };

	// Разрешить «Отмену» прямо во время печати. Штатно в состоянии "printing" Cancel скрыт
	// (появляется только на паузе). Оборачиваем setControls и до-включаем cancel при печати.
	if (typeof setControls === "function") {
		var _origSetControls = setControls;
		window.setControls = function (index, state) {
			_origSetControls(index, state);
			if (state === "printing") setControlVisibility(index, "cancel", true);
		};
	}

	function scriptEndpoint(host, gcode) { return host + "/printer/gcode/script?script=" + encodeURIComponent(gcode); }
	function ajaxPost(url) {
		var controller = new AbortController();
		var timeout = (typeof _ajaxTimeout !== "undefined" ? _ajaxTimeout : 15000);
		var timer = setTimeout(function () { controller.abort(); }, timeout);
		fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal })
			.then(function (response) {
				clearTimeout(timer);
				if (!response.ok) {
					var err = { status: response.status, statusText: response.statusText };
					alert("KlippyDash: command failed\n" + (err && err.statusText ? err.statusText : ""));
				}
			})
			.catch(function (err) {
				clearTimeout(timer);
				alert("KlippyDash: command failed\n" + (err && err.statusText ? err.statusText : ""));
			});
	}
	function mkBtn(cls, iconClass, label, title) {
		var el = document.createElement("span");
		el.className = "cc-btn " + cls;
		el.title = title;
		el.innerHTML = '<i class="fa-solid ' + iconClass + ' icon"></i>' +
			'<span class="cc-label">' + label + '</span>';
		return el;
	}
	function labelExisting(el, text) {
		if (el && el.querySelector(".cc-label") === null) el.insertAdjacentHTML("beforeend", '<span class="cc-label">' + text + '</span>');
	}

	// --- состояние вентиляторов/света ---
	// Температуру/мощность нагревателей теперь полностью показывает карточка "Температуры"
	// (temp-graph.js, свой независимый опрос) — здесь эти данные больше не нужны.
	function fanValue(obj) {
		if (!obj) return null;
		if (typeof obj.speed === "number") return obj.speed;   // fan / heater_fan / temperature_fan
		if (typeof obj.value === "number") return obj.value;   // output_pin
		return null;
	}
	function statusQuery(printer) {
		var objs = [];
		(printer.fans || []).forEach(function (f) { objs.push(f.object); });
		if (printer.light) objs.push("output_pin " + printer.light);
		return objs.map(function (o) { return encodeURIComponent(o); }).join("&");
	}
	function pollStatus(index, host, printer) {
		var q = statusQuery(printer);
		if (!q) return;
		fetch(host + "/printer/objects/query?" + q, { method: "GET" })
			.then(function (response) { return response.ok ? response.json() : Promise.reject(response); })
			.then(function (r) {
				var st = (r && r.result && r.result.status) || {};
				(printer.fans || []).forEach(function (f, i) {
					var v = fanValue(st[f.object]);
					var row = document.querySelector("#tile" + index + " .cc-fan-row[data-fan='" + i + "']");
					if (!row) return;
					var icon = row.querySelector(".cc-fan-icon");
					var valEl = row.querySelector(".cc-fan-val");
					if (v === null) { valEl.textContent = "–"; icon.classList.remove("spin"); row.classList.remove("cc-fan-active"); return; }
					valEl.textContent = Math.round(v * 100) + "%";
					if (v > 0.001) {
						// логарифмическая скорость вращения: низкие обороты различимее; медленно ~2.6с, быстро 0.60с при 100%
						var rr = Math.log(1 + 9 * v) / Math.LN10;        // 0..1 (v в 0..1), лог-кривая
						var dur = (0.60 + 2.00 * (1 - rr)).toFixed(2);   // с/оборот: 0.60 при 100% .. 2.60 у нуля
						icon.style.animationDuration = dur + "s";
						icon.classList.add("spin");
						row.classList.add("cc-fan-active");
					} else { icon.classList.remove("spin"); row.classList.remove("cc-fan-active"); }
				});
				if (printer.light && st["output_pin " + printer.light]) {
					var on = (st["output_pin " + printer.light].value || 0) > 0.001;
					lightState[index] = on;
					var lightBtn = document.querySelector("#tile" + index + " .cc-light");
					if (lightBtn) lightBtn.classList.toggle("cc-on", on);
				}
			})
			.catch(function () { /* silent, mirrors previous .done()-only jQuery behavior */ });
	}
	function startStatus(index, host, printer) {
		if (statusTimers[index]) clearInterval(statusTimers[index]);
		pollStatus(index, host, printer);
		statusTimers[index] = setInterval(function () { pollStatus(index, host, printer); }, 2500);
	}

	// Плитки создаёт klippydash.js внутри setup(), который теперь ждёт fetch("settings.json") —
	// поэтому стартуем не по DOMContentLoaded (может случиться раньше плиток), а по отдельному
	// событию "klippydash:ready", которое klippydash.js шлёт сам сразу после createTiles().
	window.addEventListener("klippydash:ready", function () {
		document.querySelectorAll(".tile").forEach(function (tile) {
			var index;
			try { index = JSON.parse(tile.getAttribute("data")).index; } catch (e) { index = tile.id.replace("tile", ""); }
			var printer = (typeof _printers !== "undefined" && _printers[index]) ? _printers[index] : { host: "", name: "Printer" };
			var host = (printer.host || "").replace(/\/+$/, "");

			// "Нет сигнала" — если снимок с камеры не загрузился (offline/недоступна), вместо
			// сломанной иконки картинки показываем тестовую таблицу в стиле старого ТВ (CSS,
			// theme-tweaks.css .cam-offline). Src меняется периодически (updateCamera в
			// klippydash.js), обработчики на том же <img> остаются навсегда.
			var camImg = tile.querySelector("div.cam img.cam");
			if (camImg) {
				var offlineImg = document.createElement("img");
				offlineImg.className = "cam-offline-img";
				offlineImg.src = "cam-offline.svg";
				offlineImg.alt = "";
				camImg.insertAdjacentElement("afterend", offlineImg);
				var offlineLabel = document.createElement("span");
				offlineLabel.className = "cam-offline-label";
				offlineLabel.textContent = "NO SIGNAL";
				offlineImg.insertAdjacentElement("afterend", offlineLabel);
				camImg.addEventListener("error", function () { this.closest("div.cam").classList.add("cam-offline"); });
				camImg.addEventListener("load", function () { this.closest("div.cam").classList.remove("cam-offline"); });
			}

			// Подсказка "-> Fluidd" рядом с заголовком принтера (стили/анимация — theme-tweaks.css).
			var titleEl = tile.querySelector(".title-container .title");
			if (titleEl) {
				titleEl.insertAdjacentHTML("beforeend",
					'<span class="title-hint"><i class="fa-solid fa-angles-right"></i>Fluidd</span>'
				);
			}

			var bar = document.createElement("div");
			bar.className = "custom-controls";

			// Перенос штатных кнопок печати (их обработчики и динамика показа сохраняются)
			[["control-resume", "Resume"], ["control-pause", "Pause"],
			 ["control-cancel", "Cancel"], ["control-clear", "Clear"]].forEach(function (m) {
				var c = tile.querySelector("." + m[0]);
				if (c) { labelExisting(c, m[1]); bar.appendChild(c); }
			});
			var cancelBtn = tile.querySelector(".control-cancel");
			if (cancelBtn) cancelBtn.addEventListener("click", function () { cancelPreheatStage(index); });

			// Переключатель света (SET_PIN)
			if (printer.light) {
				var light = mkBtn("cc-light", "fa-lightbulb", "Light", "Toggle camera light");
				light.addEventListener("click", function () {
					var on = !!lightState[index], nv = on ? 0 : 1;
					lightState[index] = !on;
					this.classList.toggle("cc-on", !on);
					ajaxPost(scriptEndpoint(host, "SET_PIN PIN=" + printer.light + " VALUE=" + nv));
				});
				bar.appendChild(light);
			}

			// Firmware Restart (с подтверждением) — иконка перезагрузки; перезапускает прошивку Klipper
			var fw = mkBtn("cc-fw", "fa-rotate-right", "Restart", "Firmware Restart (Klipper)");
			fw.addEventListener("click", function () {
				cancelPreheatStage(index);
				showConfirmation("Firmware Restart?", "Restart Klipper firmware? Active print will be interrupted.<br/><br/>Printer: " + printer.name, host + "/printer/firmware_restart");
			});
			bar.appendChild(fw);

			// Открыть полный Fluidd
			var fl = document.createElement("a");
			fl.className = "cc-btn cc-fluidd";
			fl.target = "_blank";
			fl.title = "Open full Fluidd";
			fl.innerHTML = '<i class="fa-solid fa-up-right-from-square icon"></i><span class="cc-label">Fluidd</span>';
			fl.href = host + "/";
			bar.appendChild(fl);

			// E-Stop последним
			var es = tile.querySelector(".control-e-stop");
			if (es) {
				labelExisting(es, "E-Stop");
				es.addEventListener("click", function () { cancelPreheatStage(index); });
				bar.appendChild(es);
			}

			var controlWrap = tile.querySelector(".control-wrap");
			if (controlWrap) controlWrap.remove();
			var camDiv = tile.querySelector("div.cam");
			if (camDiv) camDiv.insertAdjacentElement("afterend", bar);
			// Z-offset теперь считает и показывает сама карточка "3D Print Status" (print-status.js,
			// напрямую из gcode_move.homing_origin) — штатный .section-z-offset больше не трогаем:
			// detach() ломал его обновление (штатный код ищет его через .section-extruder.find(...),
			// а после detach его там уже нет).

			// Правый столбец: анимированные вентиляторы (плавающий блок, оформлен карточкой
			// в стиле "Температуры"/"3D Print Status" — тот же заголовок, фон, бордер).
			if (printer.fans && printer.fans.length) {
				var right = document.createElement("div");
				right.className = "info-right";
				right.innerHTML =
					'<div class="info-right-header"><i class="fa-solid fa-fan info-right-icon"></i>' +
					'<span class="info-right-title">Fans</span></div>';
				var body = document.createElement("div");
				body.className = "info-right-body";
				printer.fans.forEach(function (f, i) {
					// цвет иконки — по смыслу вентилятора (задан в settings.js), всегда виден;
					// активность/простой показываем прозрачностью строки (.cc-fan-active), не сменой цвета
					var color = f.color || "var(--lowlight-color)";
					// Свой SVG-пропеллер вместо иконки шрифта fa-fan: у fa-fan визуальный центр (втулка)
					// не совпадает с геометрическим центром бокса (проверено скриншотами на 0°/90°/180° —
					// втулка описывала круг при вращении, а не крутилась на месте; поправка transform-origin
					// не спасала стабильно). Тут вся геометрия рисуется сама, четыре лопасти — через
					// rotate() вокруг (50,50) внутри SVG, поэтому центр вращения гарантированно точный.
					body.insertAdjacentHTML("beforeend", '<div class="cc-fan-row" data-fan="' + i + '">' +
						'<svg class="cc-fan-icon" viewBox="0 0 100 100" style="color:' + color + '">' +
						'<g fill="currentColor">' +
						'<ellipse cx="50" cy="29" rx="12" ry="21" transform="rotate(0 50 50)"/>' +
						'<ellipse cx="50" cy="29" rx="12" ry="21" transform="rotate(90 50 50)"/>' +
						'<ellipse cx="50" cy="29" rx="12" ry="21" transform="rotate(180 50 50)"/>' +
						'<ellipse cx="50" cy="29" rx="12" ry="21" transform="rotate(270 50 50)"/>' +
						'</g>' +
						'<circle cx="50" cy="50" r="10" fill="rgba(0,0,0,.65)"/>' +
						'</svg>' +
						'<span class="cc-fan-label">' + f.label + '</span>' +
						'<span class="cc-fan-val">–</span></div>');
				});
				right.appendChild(body);
				var progressBar = tile.querySelector(".progress-bar");
				if (progressBar) progressBar.insertAdjacentElement("afterend", right);
			}

			startStatus(index, host, printer);
		});
	});
})();
