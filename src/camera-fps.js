/* camera-fps.js — частота обновления картинки в углу камеры.

   Что именно показывается, зависит от режима камеры, и это не каприз, а предел возможного.

   Режим снимков (по умолчанию): дашборд сам дёргает новый кадр каждый опрос, поэтому каждое
   обновление приходит событием load у <img>. Считаем их в скользящем окне - цифра измеренная
   и честная.

   Режим потока (cameraStream: true): внутри <img> идёт MJPEG, и браузер не даёт никакого
   события на кадр - ни load, ни чего-либо ещё. Обычный обходной путь, рисовать <img> в canvas
   и ловить смену пикселей, здесь не работает: картинка приходит с другого origin, камера
   заголовков CORS не отдаёт (проверено на обоих принтерах), и canvas становится tainted -
   getImageData бросает SecurityError. Открывать ради замера второе соединение к потоку -
   значит удвоить нагрузку на плату принтера ради одной цифры в углу, что явно не стоит того.
   Поэтому в этом режиме берём настроенную частоту из Moonraker (/server/webcams/list,
   поле target_fps) и честно помечаем её как расчётную: тильда и приглушённый цвет.
   Если принтер список камер не отдаёт (у QIDI он пустой) - значка просто нет. */
(function () {
	"use strict";

	// Окно усреднения. Снимки приходят редко - у QIDI около 0.6 кадра в секунду, - поэтому
	// окно широкое: в трёхсекундное попадали всего две отметки, и значок мигал, то появляясь,
	// то пропадая. Шести секунд хватает на четыре-пять отметок даже у медленной камеры.
	var WINDOW_MS = 6000;
	var TICK_MS = 500;
	// Сколько терпеть тишину, прежде чем признать, что кадры кончились. Больше любого разумного
	// интервала опроса, чтобы редкая камера не гасила свой же счётчик.
	var STALE_MS = 12000;

	var cams = [];  // {img, badge, value, stamps[]}

	function el(tag, cls, html) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (html !== undefined) e.innerHTML = html;
		return e;
	}

	function fmt(v) {
		// Ниже десяти кадров десятая доля осмысленна, выше - только шум.
		return v >= 10 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
	}

	/* --- измеренный режим (снимки) ------------------------------------------------------- */

	function attachMeasured(c) {
		c.img.addEventListener("load", function () {
			c.last = performance.now();
			c.stamps.push(c.last);
		});
	}

	function tickMeasured(c, now) {
		var cutoff = now - WINDOW_MS;
		while (c.stamps.length && c.stamps[0] < cutoff) c.stamps.shift();

		// Кадров давно нет - гасим: застывшая цифра врала бы сильнее, чем её отсутствие.
		if (c.last && now - c.last > STALE_MS) { c.badge.classList.remove("cf-on"); return; }

		// Для частоты нужны интервалы, а не отметки: n отметок дают n-1 интервал. Делить на
		// длину окна нельзя, пока окно не заполнилось, - первые секунды цифра была бы занижена.
		// Пока отметок мало, прошлое значение оставляем на месте: у медленной камеры окно
		// опустошается между кадрами, и сброс превращался бы в мигание.
		if (c.stamps.length < 2) return;
		var span = (c.stamps[c.stamps.length - 1] - c.stamps[0]) / 1000;
		if (span <= 0) return;
		c.value.textContent = fmt((c.stamps.length - 1) / span);
		c.badge.classList.add("cf-on");
	}

	/* --- расчётный режим (поток) ---------------------------------------------------------- */

	function loadNominal(c, printer) {
		fetch(printer.host + "/server/webcams/list")
			.then(function (r) { return r.ok ? r.json() : null; })
			.then(function (d) {
				var list = d && d.result && d.result.webcams;
				if (!list || !list.length) return;              // QIDI: список пустой - значка не будет
				var w = list[0];
				var fps = Number(w.target_fps);
				if (!isFinite(fps) || fps <= 0) return;
				c.value.textContent = "~" + fmt(fps);
				c.badge.classList.add("cf-on", "cf-nominal");
				c.badge.title = "Настроенная частота камеры (" + (w.name || "webcam") +
					"). В режиме трансляции браузер не даёт считать кадры.";
			})
			.catch(function () { /* принтер недоступен - значок просто не появится */ });
	}

	/* --- старт ----------------------------------------------------------------------------- */

	function build() {
		var printers = (typeof _printers !== "undefined" && _printers) ? _printers : [];

		printers.forEach(function (printer, i) {
			var img = document.querySelector("#tile" + i + ">div.cam>img.cam");
			if (!img) return;
			var wrap = img.closest("div.cam");
			if (!wrap) return;

			var badge = el("div", "cf-badge",
				'<span class="cf-value">—</span><span class="cf-unit">fps</span>');
			wrap.appendChild(badge);

			var c = { img: img, badge: badge, value: badge.querySelector(".cf-value"),
			          stamps: [], last: 0 };
			cams.push(c);

			if (printer.cameraStream) loadNominal(c, printer);
			else attachMeasured(c);
		});

		if (!cams.length) return;
		setInterval(function () {
			var now = performance.now();
			cams.forEach(function (c) { if (!c.badge.classList.contains("cf-nominal")) tickMeasured(c, now); });
		}, TICK_MS);
	}

	window.addEventListener("klippydash:ready", build);
})();
