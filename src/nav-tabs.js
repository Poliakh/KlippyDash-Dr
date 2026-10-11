/* nav-tabs.js — вертикальные вкладки у левого края: дашборд + отдельная страница Fluidd
   на каждый принтер.

   Идея: приложение остаётся одностраничным. Все iframe'ы с Fluidd создаются сразу при
   старте KlippyDash и дальше живут в DOM постоянно — переключение вкладки только меняет
   видимость, ничего не перезагружается. Поэтому переход мгновенный, а Fluidd сохраняет
   своё состояние (открытую вкладку, прокрутку, консоль) между переключениями.

   Почему именно так, а не ленивое создание по первому клику: ленивый вариант экономит
   трафик на старте, но первый вход на принтер стоит несколько секунд загрузки Fluidd —
   ровно того ожидания, ради избавления от которого всё и затевалось.

   Скрытие сделано через display:none у контейнера, а не через перенос iframe в другое
   место DOM: перемещение узла с iframe в DOM перезагружает документ внутри него, то есть
   убило бы весь смысл предзагрузки. */
(function () {
	"use strict";

	var RAIL_ID = "nt-rail";
	var VIEW_CLASS = "nt-view";
	var HASH_PREFIX = "#printer-";
	// Через сколько считать, что Fluidd не отдался. Запас большой: на свежем старте принтера
	// веб-морда поднимается небыстро, а ложная ошибка раздражает сильнее лишних секунд спиннера.
	var LOAD_TIMEOUT_MS = 25000;

	// Пауза между запусками соседних iframe. См. startLoadQueue - там объяснение, почему
	// грузим по очереди, а не все разом.
	var LOAD_GAP_MS = 1500;
	// Сколько ждать первый принтер после старта дашборда: даём ему разобрать settings.json,
	// построить плитки и отстреляться первым опросом, чтобы Fluidd не делил с ним канал.
	var FIRST_LOAD_DELAY_MS = 1200;

	var tabs = [];   // кнопки рельсы: {el, key}
	var views = [];  // страницы принтеров: {el, frame, msg, index}
	var queue = [];  // отложенные загрузки Fluidd: {frame, printer, start}
	var tip = null;

	function el(tag, cls, html) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (html !== undefined) e.innerHTML = html;
		return e;
	}

	/* --- подсказка с полным именем ----------------------------------------------------- */

	function showTip(anchor, text) {
		if (!tip) { tip = el("div", ""); tip.id = "nt-tip"; document.body.appendChild(tip); }
		tip.textContent = text;
		var r = anchor.getBoundingClientRect();
		tip.style.left = (r.right + 10) + "px";
		tip.style.top = (r.top + r.height / 2) + "px";
		tip.classList.add("nt-tip-on");
	}
	function hideTip() { if (tip) tip.classList.remove("nt-tip-on"); }

	/* --- переключение ------------------------------------------------------------------ */

	function activate(key, pushHash) {
		var dash = document.getElementById("klippydash");
		// Дашборд не удаляем и не размонтируем — он продолжает опрашивать принтеры в фоне,
		// поэтому при возврате показывает актуальные данные без паузы на первый опрос.
		if (dash) dash.style.display = (key === "dashboard") ? "" : "none";

		views.forEach(function (v) {
			v.el.classList.toggle("nt-view-on", key === ("printer-" + v.index));
		});
		tabs.forEach(function (t) {
			t.el.classList.toggle("nt-active", t.key === key);
		});

		if (pushHash !== false) {
			// replaceState, а не location.hash: не хотим засорять историю браузера — «назад»
			// должно уводить со страницы, а не перебирать вкладки по одной.
			try {
				history.replaceState(null, "", key === "dashboard"
					? location.pathname + location.search
					: location.pathname + location.search + HASH_PREFIX + key.slice("printer-".length));
			} catch (e) { /* file:// и т.п. — не критично, просто не будет ссылки на вкладку */ }
		}
	}

	/* --- страница принтера -------------------------------------------------------------- */

	function spinnerHtml() {
		return '<div class="nt-spinner"></div>' +
			'<div>Loading Fluidd…</div>' +
			'<div class="nt-msg-host"></div>';
	}

	function buildView(printer, index) {
		var view = el("div", VIEW_CLASS);
		view.setAttribute("data-index", String(index));

		var msg = el("div", "nt-view-msg", spinnerHtml());
		msg.querySelector(".nt-msg-host").textContent = printer.host;

		var frame = document.createElement("iframe");
		frame.title = printer.name + " — Fluidd";
		// Без sandbox - намеренно. Сам по себе он Fluidd не ломает, но и пользы не несёт:
		// содержимое и так с чужого origin, а лишние ограничения только мешают (в кадре
		// нужны localStorage/IndexedDB, где Fluidd держит свои настройки).
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.setAttribute("allow", "fullscreen");

		var settled = false;

		function ok() {
			if (settled) return;
			settled = true;
			msg.hidden = true;
		}

		function fail() {
			if (settled) return;
			settled = true;
			msg.hidden = false;
			msg.innerHTML =
				'<div>Fluidd не открылся во встроенной вкладке</div>' +
				'<div class="nt-msg-host"></div>' +
				'<div class="nt-msg-hint">Принтер может запрещать встраивание (заголовки ' +
				'X-Frame-Options / Content-Security-Policy) или просто быть сейчас недоступен.</div>' +
				'<a class="nt-msg-btn" target="_blank" rel="noopener">' +
				'<i class="fa-solid fa-up-right-from-square"></i>Открыть в новой вкладке</a>' +
				'<span class="nt-msg-btn nt-retry"><i class="fa-solid fa-rotate-right"></i>Повторить</span>';
			msg.querySelector(".nt-msg-host").textContent = printer.host;
			msg.querySelector("a.nt-msg-btn").href = printer.host + "/";
			msg.querySelector(".nt-retry").addEventListener("click", function () { retry(); });
		}

		function retry() {
			settled = false;
			msg.innerHTML = spinnerHtml();
			msg.querySelector(".nt-msg-host").textContent = printer.host;
			msg.hidden = false;
			setTimeout(function () { if (!settled) fail(); }, LOAD_TIMEOUT_MS);
			frame.src = printer.host + "/?nt=" + Date.now();
		}

		// onload у iframe срабатывает и на странице с ошибкой, и даже на пустом документе,
		// который браузер подставляет вместо заблокированного — поэтому onload только снимает
		// спиннер, а настоящую страховку даёт таймаут: если за LOAD_TIMEOUT_MS ничего не
		// пришло, показываем объяснение и ссылку наружу.
		function armTimeout() { setTimeout(function () { if (!settled) fail(); }, LOAD_TIMEOUT_MS); }

		frame.addEventListener("load", ok);
		frame.addEventListener("error", fail);

		view.appendChild(frame);
		view.appendChild(msg);
		document.body.appendChild(view);

		// src назначаем не здесь, а из очереди (startLoadQueue) — см. комментарий там.
		queue.push({ frame: frame, printer: printer, start: function () { armTimeout(); } });

		views.push({ el: view, frame: frame, msg: msg, index: index });
		return view;
	}

	/* --- очередь загрузки ------------------------------------------------------------------ */

	// Все Fluidd грузятся при старте, но строго по очереди, а не одновременно.
	//
	// Причина конкретная и проверенная. Когда у Fluidd нет сохранённого адреса Moonraker, он
	// определяет его сам: перебирает кандидатов (свой origin, затем порты 7125/7130) запросом
	// /server/info с таймаутом ровно 1 секунда (видно в его бандле: axios.get(..., {timeout:1e3})).
	// Не ответили за секунду - принтер считается недоступным и показывается "No moonraker
	// connection / Add Printer".
	//
	// А сохранённого адреса у кадра как раз и нет: localStorage у встроенного фрейма браузер
	// разделяет по верхнему домену, поэтому запись, сделанная при обычном заходе на принтер,
	// внутри нашей страницы не видна - автоопределение запускается каждый раз заново.
	//
	// Дальше арифметика: если поднимать оба Fluidd разом, да ещё параллельно с первым опросом
	// дашборда, в эту секунду уложиться успевает не каждый. QIDI на MKS SKIPR медленнее K1C и
	// проигрывал гонку стабильно, поэтому и показывал "Add Printer", хотя при одиночной загрузке
	// подключается без вопросов - проверено на обоих принтерах.
	//
	// Поэтому: пауза после старта дашборда, затем принтеры по одному. На переключение вкладок
	// это не влияет - к моменту, когда пользователь дотянется до рельсы, всё давно загружено.
	function startLoadQueue() {
		var i = 0;
		function next() {
			if (i >= queue.length) return;
			var item = queue[i++];
			item.start();
			item.frame.src = item.printer.host + "/";
			if (i < queue.length) setTimeout(next, LOAD_GAP_MS);
		}
		setTimeout(next, FIRST_LOAD_DELAY_MS);
	}

	/* --- рельса -------------------------------------------------------------------------- */

	function addTab(rail, key, iconHtml, label, fullTitle) {
		var t = el("div", "nt-tab",
			'<span class="nt-tab-icon">' + iconHtml + '</span>' +
			'<span class="nt-tab-label"></span>');
		t.querySelector(".nt-tab-label").textContent = label;
		t.addEventListener("click", function () { activate(key); hideTip(); });
		t.addEventListener("mouseenter", function () { showTip(t, fullTitle); });
		t.addEventListener("mouseleave", hideTip);
		rail.appendChild(t);
		tabs.push({ el: t, key: key });
		return t;
	}

	/* --- переход из заголовка плитки ------------------------------------------------------ */

	// Ссылка в заголовке плитки (klippydash.js, createTiles) раньше открывала Fluidd в новом
	// окне. Теперь она ведёт на свою боковую вкладку. href оставляем прежним, чтобы
	// Ctrl/средняя кнопка по-прежнему открывали принтер в отдельном окне браузера, когда это
	// действительно нужно; перехватываем только обычный левый клик.
	function hijackTileTitles() {
		var tiles = document.querySelectorAll("#klippydash .tile");
		Array.prototype.forEach.call(tiles, function (tile, i) {
			var a = tile.querySelector(".title a");
			if (!a) return;
			a.removeAttribute("target");
			a.title = "Открыть Fluidd во вкладке слева";
			a.addEventListener("click", function (ev) {
				if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
				ev.preventDefault();
				activate("printer-" + i);
			});
		});
	}

	/* --- старт ----------------------------------------------------------------------------- */

	function build() {
		var printers = (typeof _printers !== "undefined" && _printers) ? _printers : [];
		if (!printers.length) return;

		var rail = el("nav", "");
		rail.id = RAIL_ID;
		document.body.appendChild(rail);
		document.body.classList.add("nt-on");

		addTab(rail, "dashboard", '<i class="fa-solid fa-table-cells-large"></i>',
			"Обзор", "Дашборд — все принтеры");
		rail.appendChild(el("div", "nt-sep"));

		printers.forEach(function (p, i) {
			buildView(p, i);
			addTab(rail, "printer-" + i, '<i class="fa-solid fa-print"></i>',
				p.name, p.name + " — Fluidd");
		});

		hijackTileTitles();
		startLoadQueue();

		// Открытая вкладка переживает перезагрузку страницы: адрес вида ...#printer-1.
		var m = /^#printer-(\d+)$/.exec(location.hash);
		activate((m && printers[+m[1]]) ? "printer-" + m[1] : "dashboard", false);
	}

	window.addEventListener("klippydash:ready", build);
})();
