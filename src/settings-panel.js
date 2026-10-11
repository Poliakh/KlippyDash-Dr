/*
 * settings-panel.js — add-on for KlippyDash (dev; not part of upstream).
 * Slide-out "Settings" panel (gear button, top-right of the page): lists configured printers
 * (drag to reorder, pencil to edit inline, trash to remove, + to add new). Each printer's edit
 * form has its own Test / Save / Close buttons — edits are staged in a local draft until that
 * card's Save is clicked (POSTs the whole printer list to /api/settings, serve.py), so unrelated
 * structural actions (add/delete/reorder, which persist immediately) never leak an in-progress
 * edit. Closing a dirty form (or the whole panel while one is dirty) asks to save or discard.
 * A green/red LED dot per row pings {host}/printer/info every few seconds while the panel is open.
 *
 * fans/preheatProfiles are edited as raw JSON textareas rather than full sub-forms — keeps the
 * form from ballooning into a form-builder; the user already writes gcode templates by hand.
 */
(function () {
	var panelEl, listEl, gearBtn, modalEl, monEl;
	var draftPrinters = null; // working copy of settings.printers while the panel is open
	var draftMonitoring = null; // working copy of settings.monitoring while the panel is open
	var pingTimers = {};
	var openCard = null; // { index, original, local, formEl, saveBtnEl } — at most one form open at a time

	var MONITORING_DEFAULTS = {
		enabled: true,
		confidenceThreshold: 0.4,
		sustainCount: 3,
		pollSeconds: 20,
		cooldownSeconds: 600
	};

	function ajaxTimeout() { return (typeof _ajaxTimeout !== "undefined" ? _ajaxTimeout : 15000); }
	function clone(o) { return JSON.parse(JSON.stringify(o)); }
	function isDirty() { return openCard && JSON.stringify(openCard.local) !== JSON.stringify(openCard.original); }

	function testConnection(host, onDone) {
		var controller = new AbortController();
		var timer = setTimeout(function () { controller.abort(); }, Math.min(ajaxTimeout(), 8000));
		fetch((host || "").replace(/\/+$/, "") + "/printer/info", { signal: controller.signal })
			.then(function (r) { clearTimeout(timer); onDone(r.ok, r.ok ? null : ("HTTP " + r.status)); })
			.catch(function (err) { clearTimeout(timer); onDone(false, err && err.name === "AbortError" ? "timeout" : "unreachable"); });
	}

	function persist(printers, monitoring, onDone) {
		fetch("/api/settings", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ printers: printers, ajaxTimeout: settings.ajaxTimeout, monitoring: monitoring })
		}).then(function (r) {
			if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ("HTTP " + r.status)); });
			// Полная перезагрузка вместо точечного обновления — плитки на странице создаются
			// один раз при старте (createTiles() в klippydash.js), точечно достроить/убрать/
			// переставить их без переоткрытия сложнее и хрупче, чем просто перечитать всё заново.
			location.reload();
		}).catch(function (err) {
			alert("Не удалось сохранить настройки: " + err.message);
			if (onDone) onDone(false);
		});
	}

	// --- модалка "данные не сохранены" ---
	function askUnsaved(onSave, onDiscard) {
		modalEl.querySelector(".sp-modal-save").onclick = function () { hideModal(); onSave(); };
		modalEl.querySelector(".sp-modal-discard").onclick = function () { hideModal(); onDiscard(); };
		modalEl.hidden = false;
	}
	function hideModal() { modalEl.hidden = true; }

	function newPrinter() {
		// Не пустые [] — заготовка с примером структуры, чтобы при первом открытии формы было
		// видно, какие ключи ожидаются, а не гадать с нуля (см. поле "Advanced" тоже: light/
		// chamberSensor остаются пустыми строками намеренно — необязательные, можно стереть).
		return {
			name: "New printer",
			host: "http://192.168.1.100:PORT",
			light: "",
			chamberSensor: "",
			fans: [
				{ label: "Part", object: "output_pin fan0 (или просто fan)", color: "#ef5350" }
			],
			preheatProfiles: [
				{ name: "PLA", extruder: 200, bed: 60 }
			]
		};
	}

	function updateSaveBtnState() {
		if (!openCard) return;
		openCard.saveBtnEl.classList.toggle("sp-dirty", isDirty());
	}

	function closeCard(afterClose) {
		if (!openCard) { if (afterClose) afterClose(); return; }
		var card = openCard;
		function reallyClose() {
			card.formEl.hidden = true;
			openCard = null;
			if (afterClose) afterClose();
		}
		if (isDirty()) {
			askUnsaved(
				function () { saveCard(card, reallyClose); },
				reallyClose // не сохранять — просто закрыть, local-черновик выбрасывается
			);
		} else {
			reallyClose();
		}
	}

	function saveCard(card, afterSave) {
		var next = draftPrinters.slice();
		next[card.index] = clone(card.local);
		persist(next, draftMonitoring, function (ok) {
			if (!ok) return;
			draftPrinters = next;
			card.original = clone(card.local);
			updateSaveBtnState();
			var row = listEl.querySelector('.sp-row[data-index="' + card.index + '"]');
			if (row) row.querySelector(".sp-name").textContent = card.local.name || "(без имени)";
			if (afterSave) afterSave();
		});
	}

	function buildRow(p, i) {
		var row = document.createElement("div");
		row.className = "sp-row";
		row.draggable = true;
		row.dataset.index = i;
		row.innerHTML =
			'<span class="sp-drag" title="Перетащить для изменения порядка"><i class="fa-solid fa-grip-vertical"></i></span>' +
			'<span class="sp-led" title="Статус подключения"></span>' +
			'<span class="sp-name"></span>' +
			'<span class="sp-row-actions">' +
			'<button type="button" class="sp-icon-btn sp-edit-btn" title="Редактировать"><i class="fa-solid fa-pen"></i></button>' +
			'<button type="button" class="sp-icon-btn sp-del-btn" title="Удалить"><i class="fa-solid fa-trash"></i></button>' +
			'</span>';
		row.querySelector(".sp-name").textContent = p.name || "(без имени)";

		var form = document.createElement("div");
		form.className = "sp-form";
		form.hidden = true;
		form.innerHTML =
			'<label>Имя<input type="text" class="sp-f-name" /></label>' +
			'<label>Host (http://ip:port)<input type="text" class="sp-f-host" /></label>' +
			'<label class="sp-toggle-row"><input type="checkbox" class="sp-f-cameraStream" />' +
			'Непрерывная трансляция с камеры' +
			'<span class="sp-hint">выкл. — снимок раз в секунду, поток только при наведении</span></label>' +
			'<label>Advanced (JSON) — light, chamberSensor' +
			'<span class="sp-resizable"><textarea class="sp-f-advanced" rows="4"></textarea>' +
			'<span class="sp-resize-handle" title="Потянуть — изменить высоту"><span></span></span></span></label>' +
			'<label>Fans (JSON)<span class="sp-resizable"><textarea class="sp-f-fans" rows="4"></textarea>' +
			'<span class="sp-resize-handle" title="Потянуть — изменить высоту"><span></span></span></span></label>' +
			'<label>Preheat profiles (JSON)<span class="sp-resizable"><textarea class="sp-f-preheatProfiles" rows="4"></textarea>' +
			'<span class="sp-resize-handle" title="Потянуть — изменить высоту"><span></span></span></span></label>' +
			'<div class="sp-form-row">' +
			'<button type="button" class="sp-test-btn"><i class="fa-solid fa-plug-circle-check"></i> Test</button>' +
			'<button type="button" class="sp-save-card-btn"><i class="fa-solid fa-floppy-disk"></i> Save</button>' +
			'<button type="button" class="sp-close-card-btn"><i class="fa-solid fa-xmark"></i> Close</button>' +
			'<span class="sp-test-result"></span>' +
			'</div>';

		// Кастомная ручка изменения высоты по центру нижней кромки textarea (вместо/в дополнение
		// к нативному resize из угла) — тянем мышью/тачем, меняем textarea.style.height напрямую.
		form.querySelectorAll(".sp-resize-handle").forEach(function (handle) {
			var textarea = handle.previousElementSibling;
			var startY, startH;
			function onMove(e) {
				delete textarea.dataset.spExpanded; // реальное перетаскивание — сбрасываем флаг "развёрнуто по дабл-клику"
				var y = e.touches ? e.touches[0].clientY : e.clientY;
				textarea.style.height = Math.max(60, startH + (y - startY)) + "px";
			}
			function onUp() {
				textarea.classList.remove("sp-resizing");
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				document.removeEventListener("touchmove", onMove);
				document.removeEventListener("touchend", onUp);
			}
			function onDown(e) {
				e.preventDefault();
				textarea.classList.add("sp-resizing"); // без transition — иначе высота "отстаёт" от курсора при драге
				startY = e.touches ? e.touches[0].clientY : e.clientY;
				startH = textarea.offsetHeight;
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onUp);
				document.addEventListener("touchmove", onMove, { passive: false });
				document.addEventListener("touchend", onUp);
			}
			handle.addEventListener("mousedown", onDown);
			handle.addEventListener("touchstart", onDown, { passive: false });
			// Уход с поля — плавно (transition из CSS) схлопнуть обратно к исходной высоте (rows="4").
			textarea.addEventListener("blur", function () { textarea.style.height = ""; delete textarea.dataset.spExpanded; });
			// Двойной клик по ручке — развернуть на всю доступную высоту экрана; повторный двойной
			// клик — свернуть обратно к исходной (rows="4").
			handle.addEventListener("dblclick", function () {
				if (textarea.dataset.spExpanded === "1") {
					textarea.style.height = "";
					delete textarea.dataset.spExpanded;
				} else {
					var top = textarea.getBoundingClientRect().top;
					var maxAvailable = window.innerHeight - top - 20;
					// scrollHeight — естественная высота под весь контент без скролла; но не выше
					// того, что реально влезает на экран (если JSON длиннее — всё равно ограничиваем).
					textarea.style.height = Math.max(60, Math.min(textarea.scrollHeight + 4, maxAvailable)) + "px";
					textarea.dataset.spExpanded = "1";
				}
			});
		});

		function fillForm(data) {
			form.querySelector(".sp-f-name").value = data.name || "";
			form.querySelector(".sp-f-host").value = data.host || "";
			form.querySelector(".sp-f-cameraStream").checked = !!data.cameraStream;
			form.querySelector(".sp-f-advanced").value = JSON.stringify({
				light: data.light || "",
				chamberSensor: data.chamberSensor || ""
			}, null, 2);
			form.querySelector(".sp-f-fans").value = JSON.stringify(data.fans || [], null, 2);
			form.querySelector(".sp-f-preheatProfiles").value = JSON.stringify(data.preheatProfiles || [], null, 2);
			form.querySelectorAll("textarea").forEach(function (t) { t.classList.remove("sp-json-error"); });
		}

		row.querySelector(".sp-edit-btn").addEventListener("click", function () {
			if (openCard && openCard.index === i) { closeCard(); return; }
			closeCard(function () {
				var local = clone(p);
				openCard = { index: i, original: clone(p), local: local, formEl: form, saveBtnEl: form.querySelector(".sp-save-card-btn") };
				fillForm(local);
				form.hidden = false;
				updateSaveBtnState();
			});
		});

		["name", "host"].forEach(function (key) {
			form.querySelector(".sp-f-" + key).addEventListener("input", function () {
				if (!openCard || openCard.index !== i) return;
				openCard.local[key] = this.value;
				updateSaveBtnState();
			});
		});
		form.querySelector(".sp-f-cameraStream").addEventListener("change", function () {
			if (!openCard || openCard.index !== i) return;
			// Пишем ключ только когда включено — выключенное состояние это и есть поведение
			// по умолчанию, незачем засорять им settings.json.
			if (this.checked) openCard.local.cameraStream = true;
			else delete openCard.local.cameraStream;
			updateSaveBtnState();
		});

		["fans", "preheatProfiles"].forEach(function (key) {
			form.querySelector(".sp-f-" + key).addEventListener("input", function () {
				if (!openCard || openCard.index !== i) return;
				try { openCard.local[key] = JSON.parse(this.value || "[]"); this.classList.remove("sp-json-error"); }
				catch (e) { this.classList.add("sp-json-error"); }
				updateSaveBtnState();
			});
		});
		// Advanced (JSON) — плоский объект {light, chamberSensor}, его ключи разворачиваются
		// прямо в корень printer-объекта (не вложенное поле, как fans). cooldownGcode и
		// chamberSetGcode сюда больше не входят — обе команды теперь выводятся автоматически
		// из имени объекта (см. temp-graph.js: buildCooldownGcode/chamberTargetGcode).
		form.querySelector(".sp-f-advanced").addEventListener("input", function () {
			if (!openCard || openCard.index !== i) return;
			try {
				var adv = JSON.parse(this.value || "{}");
				["light", "chamberSensor"].forEach(function (k) {
					if (adv[k]) openCard.local[k] = adv[k]; else delete openCard.local[k];
				});
				this.classList.remove("sp-json-error");
			} catch (e) { this.classList.add("sp-json-error"); }
			updateSaveBtnState();
		});

		form.querySelector(".sp-test-btn").addEventListener("click", function () {
			var resultEl = form.querySelector(".sp-test-result");
			resultEl.textContent = "проверка…";
			resultEl.className = "sp-test-result";
			var host = form.querySelector(".sp-f-host").value;
			testConnection(host, function (ok, err) {
				resultEl.textContent = ok ? "✓ подключение есть" : "✗ " + err;
				resultEl.className = "sp-test-result " + (ok ? "sp-test-ok" : "sp-test-fail");
			});
		});
		form.querySelector(".sp-save-card-btn").addEventListener("click", function () {
			if (form.querySelector(".sp-json-error")) { alert("Исправьте JSON в fans/preheatProfiles перед сохранением."); return; }
			if (openCard && openCard.index === i) saveCard(openCard);
		});
		form.querySelector(".sp-close-card-btn").addEventListener("click", function () { closeCard(); });

		row.querySelector(".sp-del-btn").addEventListener("click", function () {
			if (!confirm('Удалить принтер "' + (p.name || "") + '"?')) return;
			var next = draftPrinters.filter(function (x) { return x !== p; });
			persist(next, draftMonitoring, function (ok) {
				if (!ok) return;
				draftPrinters = next;
				if (openCard && openCard.index === i) openCard = null;
				renderList();
			});
		});

		row.addEventListener("dragstart", function (e) {
			row.classList.add("sp-dragging");
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", String(i));
		});
		row.addEventListener("dragend", function () { row.classList.remove("sp-dragging"); });
		row.addEventListener("dragover", function (e) { e.preventDefault(); row.classList.add("sp-drop-target"); });
		row.addEventListener("dragleave", function () { row.classList.remove("sp-drop-target"); });
		row.addEventListener("drop", function (e) {
			e.preventDefault();
			row.classList.remove("sp-drop-target");
			var fromIndex = Number(e.dataTransfer.getData("text/plain"));
			var toIndex = Number(row.dataset.index);
			if (fromIndex === toIndex || isNaN(fromIndex)) return;
			closeCard(function () {
				var next = draftPrinters.slice();
				var moved = next.splice(fromIndex, 1)[0];
				next.splice(toIndex, 0, moved);
				persist(next, draftMonitoring, function (ok) {
					if (!ok) return;
					draftPrinters = next;
					renderList();
				});
			});
		});

		var wrap = document.createElement("div");
		wrap.appendChild(row);
		wrap.appendChild(form);
		return wrap;
	}

	function stopPings() {
		Object.keys(pingTimers).forEach(function (k) { clearInterval(pingTimers[k]); });
		pingTimers = {};
	}
	function startPings() {
		stopPings();
		draftPrinters.forEach(function (p, i) {
			function ping() {
				var led = listEl.querySelector('.sp-row[data-index="' + i + '"] .sp-led');
				if (!led) return;
				testConnection(p.host || "", function (ok) {
					led.classList.toggle("sp-led-on", ok);
					led.classList.toggle("sp-led-off", !ok);
				});
			}
			ping();
			pingTimers[i] = setInterval(ping, 5000);
		});
	}

	function renderList() {
		listEl.innerHTML = "";
		draftPrinters.forEach(function (p, i) { listEl.appendChild(buildRow(p, i)); });
		startPings();
	}

	function openPanel() {
		draftPrinters = settings.printers ? settings.printers.slice() : [];
		draftMonitoring = Object.assign({}, MONITORING_DEFAULTS, settings.monitoring || {});
		renderList();
		fillMonitoringForm();
		panelEl.classList.add("sp-open");
		gearBtn.classList.add("sp-gear-active");
	}

	function fillMonitoringForm() {
		if (!monEl) return;
		monEl.querySelector(".sp-mon-enabled").checked = !!draftMonitoring.enabled;
		monEl.querySelector(".sp-mon-threshold").value = draftMonitoring.confidenceThreshold;
		monEl.querySelector(".sp-mon-sustain").value = draftMonitoring.sustainCount;
		monEl.querySelector(".sp-mon-poll").value = draftMonitoring.pollSeconds;
		monEl.querySelector(".sp-mon-cooldown").value = Math.round(draftMonitoring.cooldownSeconds / 60);
		monEl.querySelector(".sp-mon-save-btn").classList.remove("sp-dirty");
	}

	// Клик в любом месте экрана вне панели — закрыть (как гир-кнопка). Не мешает закрытию отдельной
	// карточки (там свой "Close"), и не мешает клику по самой шестерёнке (у неё свой toggle-обработчик).
	document.addEventListener("click", function (e) {
		if (!panelEl || !panelEl.classList.contains("sp-open")) return;
		if (panelEl.contains(e.target) || e.target === gearBtn || (gearBtn && gearBtn.contains(e.target))) return;
		if (modalEl && !modalEl.hidden && modalEl.contains(e.target)) return;
		closePanel();
	});
	function reallyClosePanel() {
		panelEl.classList.remove("sp-open");
		gearBtn.classList.remove("sp-gear-active");
		stopPings();
		openCard = null;
	}
	function closePanel() {
		if (isDirty()) {
			askUnsaved(function () { saveCard(openCard, reallyClosePanel); }, reallyClosePanel);
		} else {
			reallyClosePanel();
		}
	}

	function build() {
		gearBtn = document.createElement("button");
		gearBtn.id = "sp-gear-btn";
		gearBtn.title = "Настройки принтеров";
		gearBtn.innerHTML = '<i class="fa-solid fa-gear"></i>';
		gearBtn.addEventListener("click", function () {
			if (panelEl.classList.contains("sp-open")) closePanel(); else openPanel();
		});
		document.body.appendChild(gearBtn);

		panelEl = document.createElement("div");
		panelEl.id = "sp-panel";
		panelEl.innerHTML =
			'<div class="sp-header"><i class="fa-solid fa-gear"></i><span>Настройки принтеров</span></div>' +
			'<div class="sp-list"></div>' +
			'<button type="button" class="sp-add-btn"><i class="fa-solid fa-plus"></i> Добавить принтер</button>' +
			'<div class="sp-mon-section">' +
			'<div class="sp-mon-title"><i class="fa-solid fa-eye"></i> Наблюдение за печатью (ИИ)</div>' +
			'<label class="sp-mon-toggle-row"><input type="checkbox" class="sp-mon-enabled" /> Включено</label>' +
			'<label>Порог уверенности (0–1)<input type="number" class="sp-mon-threshold" min="0" max="1" step="0.05" /></label>' +
			'<label>Подряд срабатываний до оповещения<input type="number" class="sp-mon-sustain" min="1" step="1" /></label>' +
			'<label>Интервал проверки, сек<input type="number" class="sp-mon-poll" min="5" step="1" /></label>' +
			'<label>Пауза между повторными оповещениями, мин<input type="number" class="sp-mon-cooldown" min="1" step="1" /></label>' +
			'<div class="sp-form-row">' +
			'<button type="button" class="sp-save-card-btn sp-mon-save-btn"><i class="fa-solid fa-floppy-disk"></i> Сохранить</button>' +
			'</div>' +
			'</div>';
		document.body.appendChild(panelEl);
		listEl = panelEl.querySelector(".sp-list");
		monEl = panelEl.querySelector(".sp-mon-section");

		monEl.querySelectorAll("input").forEach(function (input) {
			input.addEventListener("input", function () { monEl.querySelector(".sp-mon-save-btn").classList.add("sp-dirty"); });
		});
		monEl.querySelector(".sp-mon-save-btn").addEventListener("click", function () {
			draftMonitoring = {
				enabled: monEl.querySelector(".sp-mon-enabled").checked,
				confidenceThreshold: Number(monEl.querySelector(".sp-mon-threshold").value) || MONITORING_DEFAULTS.confidenceThreshold,
				sustainCount: Math.max(1, Number(monEl.querySelector(".sp-mon-sustain").value) || MONITORING_DEFAULTS.sustainCount),
				pollSeconds: Math.max(5, Number(monEl.querySelector(".sp-mon-poll").value) || MONITORING_DEFAULTS.pollSeconds),
				cooldownSeconds: Math.max(60, (Number(monEl.querySelector(".sp-mon-cooldown").value) || MONITORING_DEFAULTS.cooldownSeconds / 60) * 60)
			};
			persist(draftPrinters, draftMonitoring, function (ok) { if (ok) fillMonitoringForm(); });
		});

		panelEl.querySelector(".sp-add-btn").addEventListener("click", function () {
			closeCard(function () {
				var next = draftPrinters.concat([newPrinter()]);
				persist(next, draftMonitoring, function (ok) {
					if (!ok) return;
					draftPrinters = next;
					renderList();
					var idx = draftPrinters.length - 1;
					var editBtn = listEl.querySelector('.sp-row[data-index="' + idx + '"] .sp-edit-btn');
					if (editBtn) editBtn.click();
				});
			});
		});

		modalEl = document.createElement("div");
		modalEl.id = "sp-modal";
		modalEl.hidden = true;
		modalEl.innerHTML =
			'<div class="sp-modal-box">' +
			'<div class="sp-modal-text">Ваши данные не сохранены</div>' +
			'<div class="sp-modal-actions">' +
			'<button type="button" class="sp-modal-save">Сохранить</button>' +
			'<button type="button" class="sp-modal-discard">Не сохранять</button>' +
			'</div></div>';
		document.body.appendChild(modalEl);
	}

	window.addEventListener("klippydash:ready", build);
})();
