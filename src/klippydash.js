/*
KlippyDash
https://github.com/nixkor/KlippyDash
*/
var _ajaxTimeout = 10 * 1000;
var _printers;
var _printerState = new Array();
var _refreshInterval = 1000;
var _refreshTimer;
var settings = { printers: [] }; // populated by fetch("settings.json") before setup() runs (see bottom of file)

const PrintStatsState = {
	Printing: "printing",
	Paused: "paused",
	Complete: "complete",
	Cancelled: "cancelled",
	Error: "error",
	Standby: "standby"
};

const PrintInfoState = {
	Ready: "ready",
	Error: "error",
	Shutdown: "shutdown"
};

const HtmlCode = {
	Celsius:"&#8451;",
	Octagon:"<i class='fa-solid fa-triangle-exclamation icon'></i>",
	Play:"<i class='fa-solid fa-play icon'></i>",
	Stop:"<i class='fa-solid fa-stop icon'></i>",
	Pause:"<i class='fa-solid fa-pause icon'></i>",
	Refresh:"<i class='fa-solid fa-arrows-rotate icon'></i>"
};

const SvgIcon = {
	Flow:"M7,2H17V7H19V13H16.5L13,17H11L7.5,13H5V7H7V2M10,22H2V20H10A1,1 0 0,0 11,19V18H13V19A3,3 0 0,1 10,22M7,9V11H8.5L12,15L15.5,11H17V9H15V4H9V9H7Z",
	Speed:"M12,16A3,3 0 0,1 9,13C9,11.88 9.61,10.9 10.5,10.39L20.21,4.77L14.68,14.35C14.18,15.33 13.17,16 12,16M12,3C13.81,3 15.5,3.5 16.97,4.32L14.87,5.53C14,5.19 13,5 12,5A8,8 0 0,0 4,13C4,15.21 4.89,17.21 6.34,18.65H6.35C6.74,19.04 6.74,19.67 6.35,20.06C5.96,20.45 5.32,20.45 4.93,20.07V20.07C3.12,18.26 2,15.76 2,13A10,10 0 0,1 12,3M22,13C22,15.76 20.88,18.26 19.07,20.07V20.07C18.68,20.45 18.05,20.45 17.66,20.06C17.27,19.67 17.27,19.04 17.66,18.65V18.65C19.11,17.2 20,15.21 20,13C20,12 19.81,11 19.46,10.1L20.67,8C21.5,9.5 22,11.18 22,13Z",
	Offset:"M12,18.54L19.37,12.8L21,14.07L12,21.07L3,14.07L4.62,12.81L12,18.54M12,16L3,9L12,2L21,9L12,16M12,4.53L6.26,9L12,13.47L17.74,9L12,4.53Z",
}

const Sounds = {
	Success:"audio/success.mp3",
}

//--- vanilla replacement for $.ajax ---
//Mimics jQuery's $.ajax({url,type,contentType,timeout,success,error}) shape closely enough for this
//codebase: success/error callbacks fire the same way, and a non-2xx HTTP response is routed to the
//error callback (NOT a resolved success) just like jQuery does. Returns a Promise that resolves on
//success and rejects on error/timeout, so existing Promise.allSettled(...) usage keeps working.
function ajaxRequest(opts) {
	var controller = new AbortController();
	var timedOut = false;
	var timer = opts.timeout ? setTimeout(function() { timedOut = true; controller.abort(); }, opts.timeout) : null;

	var fetchOpts = { method: opts.type || 'GET', signal: controller.signal };
	if (opts.contentType) fetchOpts.headers = { 'Content-Type': opts.contentType };

	return fetch(opts.url, fetchOpts).then(function(response) {
		if (timer) clearTimeout(timer);
		if (!response.ok) {
			var err = { status: response.status, statusText: response.statusText };
			if (opts.error) opts.error(err);
			return Promise.reject(err);
		}
		return response.text().then(function(text) {
			var data;
			try { data = text ? JSON.parse(text) : undefined; } catch (e) { data = undefined; }
			if (opts.success) opts.success(data);
			return data;
		});
	}).catch(function(err) {
		if (timer) clearTimeout(timer);
		if (err && typeof err.status !== "undefined") throw err; //already routed to opts.error above
		var errObj = timedOut ? { status: 0, statusText: "timeout" } : { status: 0, statusText: (err && err.message) || "error" };
		if (opts.error) opts.error(errObj);
		throw errObj;
	});
}

//HTML-escape for values interpolated into innerHTML template strings below (tile host/name come
//from settings.js, but escape anyway to keep the markup well-formed regardless of content).
function escHtml(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function updatePrinterObjects(index, data) {
	var currentState = _printerState[index];

	if(typeof(currentState) == "undefined")
		_printerState[index] = {};

	//check if status flipped from printing to complete.  If so play success sound.
	if(typeof(currentState) !== "undefined" && typeof(currentState.objects) !== "undefined") {
		if(currentState.objects.status.print_stats.state == PrintStatsState.Printing
			&& data.status.print_stats.state == PrintStatsState.Complete) {
			_printerState[index].LastCompletedTime = new Date();
			party.On();
			playAudio(Sounds.Success);
		}
	}

	_printerState[index].objects = data;
	processState(index);
}

function updatePrinterInfo(index, data) {
	var currentState = _printerState[index];
	if(typeof(currentState) !== "undefined"  && typeof(currentState.printer) !== "undefined") {

	}

	if(typeof(currentState) == "undefined")
		_printerState[index] = {};

	_printerState[index].printer = data;
	processState(index);
}

function updateServerInfo(index, data) {
	var currentState = _printerState[index];

	if(typeof(currentState) == "undefined")
		_printerState[index] = {};

	_printerState[index].server = data;
	processState(index);
}

function getPrinterObjects(printer, index) {
	var endpoint = "/printer/objects/query?gcode_move&toolhead&extruder=temperature,target,power&heater_bed&print_stats&display_status&bed_mesh=mesh_min,mesh_max,probed_matrix";

	return ajaxRequest({
		url: printer.host + endpoint,
		type: 'GET',
		contentType: 'application/json',
		timeout: _ajaxTimeout,
		success:function(data)
		{
			updatePrinterObjects(index, data.result);
		},
		error:function(err)
		{
			showError(index, `Error connecting to ${printer.name}`, false);
			setProgressBar(index, 1, PrintStatsState.Error)
		}
	});
}

function getPrinterInfo(printer, index) {
	var endpoint = "/printer/info";

	return ajaxRequest({
		url: printer.host + endpoint,
		type: 'GET',
		contentType: 'application/json',
		timeout: _ajaxTimeout,
		success:function(data)
		{
			updatePrinterInfo(index, data.result);
		},
		error:function(err)
		{
			showError(index, `Error connecting to ${printer.name}`, false);
			setProgressBar(index, 1, PrintStatsState.Error)
		}
	});
}

function getServerInfo(printer, index) {
	var endpoint = "/server/info";

	return ajaxRequest({
		url: printer.host + endpoint,
		type: 'GET',
		contentType: 'application/json',
		timeout: _ajaxTimeout,
		success: function(data) {
			updateServerInfo(index, data.result);
		},
		error: function(err) {
			showError(index, `Error connecting to ${printer.name}`,false);
			setProgressBar(index, 1, PrintStatsState.Error)
		}
	});
}

function processState(index) {
	//sanity check all data is populated
	if(typeof(_printerState[index]) === "undefined"
		|| typeof(_printerState[index].objects) === "undefined"
		|| typeof(_printerState[index].printer) === "undefined"
		|| typeof(_printerState[index].server) === "undefined")
			return;

	var server = _printerState[index].server;
	var printer = _printerState[index].printer;
	var objects = _printerState[index].objects.status;


	//process data
	document.querySelector(`#tile${index}>.section-time`).textContent = Date().toString();

	clearErrors(index);
	setControls(index,"idle");

	//check connections and show warnings / errors
	if(!server.klippy_connected) {
		showError(index, "Klippy not connected!");
		setProgressBar(index, 1, PrintStatsState.Error);
		return;
	}

	if(printer.state == 'error' || printer.state == 'shutdown') {   //!= "ready"
		showError(index, printer.state_message);
		setProgressBar(index, 1, PrintStatsState.Error);
		return;
	}

	if(server.klippy_state != 'ready') {
		showError(index, "Klippy State:" + server.klippy_state);
	}

	setProgressBar(index, objects.display_status.progress, objects.print_stats.state);

	//extruder temps
	var divExtruder = document.querySelector(`#tile${index}>.section-extruder`);
	if(objects.extruder.target > 0 || objects.extruder.temperature > 30 || objects.gcode_move.extrude_factor != 1.0 || objects.gcode_move.speed_factor != 1.0) {
		divExtruder.querySelector(".extruder-temp").textContent = objects.extruder.temperature.toFixed(1);
		divExtruder.querySelector(".extruder-target").textContent = objects.extruder.target;
		divExtruder.classList.remove("hidden");

		//extruder flow
		var divExtruderFlow = divExtruder.querySelector(".section-extruder-flow");
		if(objects.gcode_move.extrude_factor != 1.0) {
			divExtruderFlow.querySelector(".extruder-flow").textContent = objects.gcode_move.extrude_factor * 100;
			divExtruderFlow.classList.remove("hidden");
		}
		else {
			divExtruderFlow.classList.add("hidden");
		}

		//speed factor
		var divSpeedFactor = divExtruder.querySelector(".section-speed-factor");
		if(objects.gcode_move.speed_factor != 1.0) {
			divSpeedFactor.querySelector(".speed-factor").textContent = objects.gcode_move.speed_factor * 100;
			divSpeedFactor.classList.remove("hidden");
		}
		else {
			divSpeedFactor.classList.add("hidden");
		}

		//zoffset
		var divZOffset = divExtruder.querySelector(".section-z-offset");
		if(Math.abs(objects.gcode_move.homing_origin[2]) >= 0.001) { //prevent odd ui like +0.000 due to precision
			var displayText = "";
			if(objects.gcode_move.homing_origin[2]  > 0) {
				displayText += "+";
			}
			displayText += objects.gcode_move.homing_origin[2].toFixed(3);
			divZOffset.querySelector(".z-offset").textContent = displayText;
			divZOffset.classList.remove("hidden");
		}
		else {
			divZOffset.classList.add("hidden");
		}
	}
	else {
		divExtruder.classList.add("hidden");
	}

	//bed temps
	var divHeaterBed = document.querySelector(`#tile${index}>.section-bed`);
	if(objects.heater_bed.target > 0 || objects.heater_bed.temperature > 30) {
		divHeaterBed.querySelector(".bed-temp").textContent = objects.heater_bed.temperature.toFixed(1);
		divHeaterBed.querySelector(".bed-target").textContent = objects.heater_bed.target;
		divHeaterBed.classList.remove("hidden");
	}
	else {
		divHeaterBed.classList.add("hidden");
	}

	//filename
	var divFile = document.querySelector(`#tile${index}>.section-file`);
	if(objects.print_stats.state == "printing" || objects.print_stats.state == "paused" || objects.print_stats.state =="complete" || objects.print_stats.state == "cancelled") {
		divFile.querySelector(".filename").textContent = objects.print_stats.filename;
		divFile.classList.remove("hidden");
	}
	else {
		divFile.classList.add("hidden");
	}

	//print stats
	var divPrintStats = document.querySelector(`#tile${index}>.section-printstats`);
	if(objects.print_stats.state == "printing" || objects.print_stats.state == "paused" || objects.print_stats.state == "complete") {
			divPrintStats.querySelector(".total-time").innerHTML = formatTime(objects.print_stats.total_duration);
			divPrintStats.querySelector(".print-time").innerHTML = formatTime(objects.print_stats.print_duration);
			divPrintStats.querySelector(".filament-used").textContent = (objects.print_stats.filament_used/1000).toFixed(2);

			if(objects.display_status.progress > 0 && objects.print_stats.state != "complete") { //printing or paused
				var estimatedTotalTime = (objects.print_stats.print_duration / objects.display_status.progress);
				var remainingTime = estimatedTotalTime - objects.print_stats.print_duration;
				divPrintStats.querySelector(".remaining-time").innerHTML = formatTime(remainingTime);

				var endTime = new Date();
				endTime = new Date(endTime.getTime() + (remainingTime * 1000));
				if(isSameDay(endTime, new Date())) {
					divPrintStats.querySelector(".eta-time").textContent = endTime.toLocaleTimeString();
				}
				else {
					divPrintStats.querySelector(".eta-time").textContent = endTime.toLocaleString();
				}
				divPrintStats.querySelector(".complete-time").classList.add("hidden");

				divPrintStats.querySelectorAll(".printing-container").forEach(function(el) { el.classList.remove("hidden"); });
				setControls(index, objects.print_stats.state);
			}
			else if(objects.display_status.progress > 0) { //complete
				divPrintStats.querySelectorAll(".printing-container").forEach(function(el) { el.classList.add("hidden"); });

				//if last completed time set display offset since complete
				if(typeof(_printerState[index].LastCompletedTime) != "undefined") {
					var completed = _printerState[index].LastCompletedTime;
					var current = new Date();
					var seconds = (current.getTime() - completed.getTime()) / 1000;
					divPrintStats.querySelector(".complete-time").innerHTML = " +" + formatTime(seconds);
					divPrintStats.querySelector(".complete-time").classList.remove("hidden");
				}
				else {
					divPrintStats.querySelector(".complete-time").classList.add("hidden");
				}

				setControls(index,"complete");
			}
			else{ //starting up
				divPrintStats.querySelector(".remaining-time").innerHTML = "<span class='dynamic-value'>Calculating...</span>";
				divPrintStats.querySelector(".eta-time").textContent = "Calculating...";

				divPrintStats.querySelector(".complete-time").classList.add("hidden");

				divPrintStats.querySelectorAll(".printing-container").forEach(function(el) { el.classList.remove("hidden"); });
				setControls(index, "printing");
			}

			divPrintStats.classList.remove("hidden");
	}
	else if(objects.print_stats.state == "cancelled") { //cancelled
		setControls(index, "cancelled");
	}
	else { //idle
		divPrintStats.classList.add("hidden");
		setControls(index, "idle");
	}

	//errors
	if(objects.print_stats.state == "error") {
		showError(index,`Error: ${objects.print_stats.message}`);
		setProgressBar(index, 1, PrintStatsState.Error);
	}

}

function setControls(index, state) {
	switch(state) {
		case "printing":
			setControlVisibility(index,"resume", false);
			setControlVisibility(index,"pause", true);
			setControlVisibility(index,"cancel",false);
			setControlVisibility(index,"e-stop",true);
			setControlVisibility(index,"clear",false);
			break;
		case "paused":
			setControlVisibility(index,"resume",true);
			setControlVisibility(index,"pause",false);
			setControlVisibility(index,"cancel",true);
			setControlVisibility(index,"e-stop",true);
			setControlVisibility(index,"clear",false);
			break;
		case "cancelled":
			setControlVisibility(index,"resume",false);
			setControlVisibility(index,"pause",false);
			setControlVisibility(index,"cancel",false);
			setControlVisibility(index,"e-stop",true);
			setControlVisibility(index,"clear",true);
			break;
		case "complete":
			setControlVisibility(index,"resume",false);
			setControlVisibility(index,"pause",false);
			setControlVisibility(index,"cancel",false);
			setControlVisibility(index,"e-stop",true);
			setControlVisibility(index,"clear",true);
			break;
		case "error":
		case "idle":
		default:
			setControlVisibility(index,"resume",false);
			setControlVisibility(index,"pause",false);
			setControlVisibility(index,"cancel",false);
			setControlVisibility(index,"e-stop",true);
			setControlVisibility(index,"clear",false);
	}
}

function setControlVisibility(index, name, visible) {
	var ctrl = getTileControl(index,name);
	if(typeof(ctrl) != "undefined" && ctrl.length>0) {
		ctrl.forEach(function(el) {
			if(visible){
				el.classList.remove("hidden");
			}
			else {
				el.classList.add("hidden");
			}
		});
	}
}

function getTileControl(index, name) {
	return document.querySelectorAll(`#tile${index}>.title-container>.control-wrap>.control-${name}`);
}

function formatTime(seconds, mode = "compact-html") {
	const minute = 60;
	const hour = minute * 60;
	const day = hour * 24;

	var d = Math.floor((seconds / day));
	seconds -= d * day;
	var h = Math.floor((seconds / hour));
	seconds -= h * hour;
	var m =  Math.floor((seconds / minute));
	seconds -= m * minute;
	var s = Math.floor(seconds);

	var response = "";

	switch(mode) {
		case "compact-html":
			if (d > 0) {
				response += `<span class="dynamic-value">${d}</span>d`;
			}
			if (h > 0) {
				response += `<span class="dynamic-value">${h}</span>h`;
			}
			if (m > 0) {
				response += `<span class="dynamic-value">${m}</span>m`;
			}
			if (s > 0 || response == "")
				response += `<span class="dynamic-value">${s}</span>s`;
			break;
		case "basic":
			if (d > 0) {
				response += `${d}:`;
			}
			if (h > 0) {
				if(h <= 9) response += "0";
				response += `${h}:`;
			}
			if (m > 0) {
				if(m <= 9) response += "0";
				response += `${m}:`;
			}
			if(s <= 9) response += "0";
			response += `${s}`;

			if(response.substring(0,1) == "0") { //remove leading zeros
				response = response.substring(1);
			}
			break;
		case "compact":
			if (d > 0) {
				response += `${d}d`;
				//if(h+m+s > 0) response += " ";
			}
			if (h > 0) {
				response += `${h}h`;
				//if(m+s > 0) response += " ";
			}
			if (m > 0) {
				response += `${m}m`;
				//if(s > 0) response += " ";
			}
			if (s > 0 || response == "") response += `${s}s`;
			break;
		case "verbose":
		default:
			if (d > 0) {
				response += `${d} days`;
				if(h+m+s > 0) response += ", ";
			}
			if (h > 0) {
				response += `${h} hours`;
				if(m+s > 0) response += ", ";
			}
			if (m > 0) {
				response += `${m} minutes`;
				if(s > 0) response += ", ";
			}
			if (s > 0 || response == "") response += `${s} seconds`;
			break;
	}

	return response;
}

function showExtruder(index, enabled) {
	var div = document.querySelector(`#tile${index}>.section-extruder`);
	if(enabled)
		div.classList.remove("hidden");
	else
	{
		div.classList.add("hidden");
	}
}

function clearErrors(index) {
	var div = document.querySelector(`#tile${index}>.section-error`);
	div.classList.add("hidden");

	//only remove body alert if all errors are silenced.
	if(document.querySelectorAll(".tile>.section-error:not(.hidden)").length == 0 ) {
		document.body.classList.remove("alert");
	}
}

function showError(index, message, alert = true) {
	var div = document.querySelector(`#tile${index}>.section-error`);

	div.innerHTML = message;
	div.classList.remove("hidden");

	if(alert) {
		document.body.classList.add("alert");
	}
}

function updatePrinterData(printer,index) {
	//return the in-flight request handles so the caller can wait for them to settle before scheduling the next tick
	return [
		getPrinterInfo(printer,index),
		getPrinterObjects(printer, index),
		getServerInfo(printer,index)
	];
}

function updatePrinter(printer, index) {
	var pending = updatePrinterData(printer, index);
	updateCamera(printer,index);
	return pending;
}

//Точка входа для обоих режимов камеры: постоянная трансляция (printer.cameraStream) или штатные
//снимки, которые updateCamera() обновляет каждый опрос.
function setCameraSource(el, printer) {
	var action = printer.cameraStream ? "stream" : "snapshot";
	el.setAttribute("src", printer.host + "/webcam/?action=" + action + "&cache=" + Math.random());
}

function updateCamera(printer, index) {
	var cam = document.querySelector(`#tile${index}>div.cam>img.cam`);
	if(!cam) return;
	var src = cam.getAttribute("src") || "";
	if(src.includes("snapshot")) {
		cam.setAttribute("src", printer.host + "/webcam/?action=snapshot&cache=" + Math.random());
	}
	else if(printer.cameraStream && cam.closest("div.cam").classList.contains("cam-offline")) {
		//В режиме потока <img> сам не переподключается: если соединение оборвалось (принтер ушёл в
		//перезагрузку, моргнул wifi), картинка остаётся мёртвой навсегда. В режиме снимков этого нет,
		//там каждый опрос — новый запрос. Класс .cam-offline ставит custom-controls.js по событию
		//error, используем его как сигнал к переподключению.
		setCameraSource(cam, printer);
	}
}

function calculateRemainingTime(duration, progress) {
	if(progress > 0)  //dont divide by 0
	{
		var estTotalTime = (duration / progress);
		return estTotalTime - duration;
	}
	return undefined;
}

//Date has no .day property (it's getDate()/getDay()), so the old endTime.day checks compared undefined==undefined.
//Compare the actual calendar date so "same day" shows just the time and other days show the full date.
function isSameDay(a, b) {
	return a.getFullYear() === b.getFullYear()
		&& a.getMonth() === b.getMonth()
		&& a.getDate() === b.getDate();
}

function calculateEta(remainingTime) {
	if(typeof(remainingTime) === "undefined") return "Calculating..."

	var endTime = new Date();
	endTime = new Date(endTime.getTime() + (remainingTime * 1000));
	if(isSameDay(endTime, new Date())) { //if same day only show time
		return endTime.toLocaleTimeString();
	}
	else {
		return endTime.toLocaleString();
	}
}

function refreshTitle() {
	var title = "";
	if(document.body.classList.contains("alert"))
		title = "!!!ALERT!!!"
	else {
		//some printers may be only partially loaded (a /server/info response arrived but /objects/query hasn't yet),
		//so guard every dereference - an undefined .objects here would otherwise throw and break the whole tick.
		var printing = _printerState.filter(ps => ps?.objects?.status?.print_stats?.state === PrintStatsState.Printing);
		if(printing.length > 0) {
			if(title.length > 0) title += " ";
			var p = printing.sort((a,b) =>  calculateRemainingTime(a.objects.status.print_stats.print_duration, a.objects.status.display_status.progress) - calculateRemainingTime(b.objects.status.print_stats.print_duration, b.objects.status.display_status.progress))[0];

			title += `${p.objects.status.display_status.progress.toLocaleString(undefined,{style: 'percent', minimumFractionDigits:0, maximumFractionDigits:0})}; ETA: ${calculateEta(calculateRemainingTime(p.objects.status.print_stats.print_duration, p.objects.status.display_status.progress))}`;
		}
	}
	if(title.length > 0) title += " - ";
	title = title += "KlippyDash";
	document.title = title;
}

function updateAll() {
	var pending = [];
	_printers.forEach(function(val, index, arr) {
		pending = pending.concat(updatePrinter(val, index));
	});

	refreshTitle();

	//resolve once every request this tick has settled (success or failure) so polling can't stack up on a slow/unreachable printer
	return Promise.allSettled(pending);
}

function setProgressBar(index, percent, state, message = undefined) {
	var statusDict = {  //trying to implement some form of typing status to remove unwanted classes - may be a better way
		"success":{"status":"success"},
		"warning": {"status":"warning"},
		"error": {"status":"error"},
		"party-time": {"status":"party-time"},
		"standby": {"status":"standby"},
		"printing":{"status":"printing"}
	};
	var bonusClass = undefined;

	switch(state) {
		case PrintStatsState.Printing:
			if (typeof(message) == "undefined") message = `Printing - ${percent.toLocaleString(undefined,{style: 'percent', minimumFractionDigits:0, maximumFractionDigits:0})}`;
			bonusClass = statusDict["printing"].status;
			break;
		case "complete":
			if (typeof(message) == "undefined") message = "Complete";
			bonusClass = statusDict["success"].status;
			percent = 1;
			break;
		case "paused":
			if (typeof(message) == "undefined") message = `Paused - ${percent.toLocaleString(undefined,{style: 'percent', minimumFractionDigits:0, maximumFractionDigits:0})}`;
			bonusClass = statusDict["warning"].status;
			break;
		case "error":
			if (typeof(message) == "undefined") message = "Error";
			bonusClass = statusDict["error"].status;
			percent = 1;
			break;
		case "standby":
			message = "Standby";
			bonusClass = statusDict["standby"].status;
			percent = 1;
			break;
		case "cancelled":
			message = "Cancelled";
			bonusClass = statusDict["error"].status;
			percent = 1;
			break;
		default:
			if (typeof(message) == "undefined") message = `Unhandled State: ${state}`;
			bonusClass = statusDict["warning"].status;
			percent = 1;
			break;
	}
	var bar = document.querySelector(`#tile${index}>.progress-bar`);
	var barProgress = bar.querySelector(".progress-bar-progress");
	if(message != undefined) bar.querySelector(".progress-bar-text").textContent = message;


	//remove previous bonus class if it changed.
	for(const key in statusDict) {
		if(statusDict[key].status != bonusClass)
			barProgress.classList.remove(statusDict[key].status);
	}

	if(bonusClass != undefined) barProgress.classList.add(bonusClass);

	if(percent > 0) {
		barProgress.setAttribute("style",`width:${percent.toLocaleString(undefined,{style: 'percent', minimumFractionDigits:0, maximumFractionDigits:0})}`);
		barProgress.classList.remove("hidden");
	}
	else {
		barProgress.setAttribute("style",`width:${percent.toLocaleString(undefined,{style: 'percent', minimumFractionDigits:0, maximumFractionDigits:0})}`);  //if showing bar make sure to set appropriately!
		barProgress.classList.remove("hidden");
	}

	//animate bar if printing
	if(state == PrintStatsState.Printing)
		bar.classList.add("animated");
	else
		bar.classList.remove("animated");
}

function createTiles() {
	var canvas = document.getElementById("klippydash");

	_printers.forEach(function(val, index, arr) {
		var data = {"index": index};
		var dataAttr = escHtml(JSON.stringify(data));

		//build the tile
		var tileHtml =
			`<div class="tile" id="tile${index}" data="${dataAttr}">` +
				`<div class="title-container">` +
					`<div class="title"><a href="${escHtml(val.host)}/" target="_blank">${escHtml(val.name)}</a></div>` +
					`<div class="control-wrap">` +
						`<span class="control-resume hidden" title="Resume" data="${dataAttr}">${HtmlCode.Play}</span>` +
						`<span class="control-pause hidden" title="Pause" data="${dataAttr}">${HtmlCode.Pause}</span>` +
						`<span class="control-cancel hidden" title="Cancel" data="${dataAttr}">${HtmlCode.Stop}</span>` +
						`<span class="control-clear hidden" title="Clear" data="${dataAttr}">${HtmlCode.Refresh}</span>` +
						`<span class="control-e-stop hidden" title="E-Stop" data="${dataAttr}">${HtmlCode.Octagon}</span>` +
					`</div>` +
				`</div>` +
				`<div class="cam"><img class="cam" data="${dataAttr}" /></div>` +
				`<div class="progress-bar">` +
					`<div class="progress-bar-progress" style="width:0%">` +
						`<span id="progressbar-text" class="progress-bar-text"></span>` +
					`</div>` +
				`</div>` +
				`<div class="section-file tile-line hidden">` +
					`<span class="label">File Name: </span>` +
					`<span class="filename dynamic-value"></span>` +
				`</div>` +
				`<div class="section-printstats hidden">` +
					`<div style="display:block;">` +
						`<span class="tile-line" style="display:inline-block;text-align:left;width:50%">` +
							`<span class="label">Total Time: </span>` +
							`<span class="total-time"></span>` +
							`<span class="complete-time"></span>` +
						`</span>` +
						`<span class="printing-container tile-line" style="display:inline-block;text-align:left;width:50%">` +
							`<span class="label">Remaining Time: </span>` +
							`<span class="remaining-time"></span>` +
						`</span>` +
					`</div>` +
					`<div style="display:block;">` +
						`<span class="tile-line" style="display:inline-block;text-align:left;width:50%">` +
							`<span class="label">Print Time: </span>` +
							`<span class="print-time"></span>` +
						`</span>` +
						`<span class="printing-container tile-line" style="display:inline-block;text-align:left;width:50%">` +
							`<span class="label">ETA: </span>` +
							`<span class="eta-time dynamic-value"></span>` +
						`</span>` +
					`</div>` +
					`<div class="tile-line" style="display:block;">` +
						`<span class="label">Filament Used: </span>` +
						`<span class="filament-used dynamic-value"></span>m` +
					`</div>` +
				`</div>` +
				`<div class="section-extruder tile-line hidden">` +
					`<span class="label">Extruder: </span>` +
					`<span class="extruder-temp dynamic-value"></span> / <span class="extruder-target dynamic-value"></span>` +
					`<sup>${HtmlCode.Celsius}</sup>` +
					`<span class="section-extruder-flow" title="Flow">` +
						`<span class="label">${showSvgIcon(SvgIcon.Flow)}</span>` +
						`<span class="extruder-flow dynamic-value"></span>%` +
					`</span>` +
					`<span class="section-speed-factor" title="Speed Factor">` +
						`<span class="label">${showSvgIcon(SvgIcon.Speed)}</span>` +
						`<span class="speed-factor dynamic-value"></span>%` +
					`</span>` +
					`<span class="section-z-offset" title="Z-Offset">` +
						`<span class="label">${showSvgIcon(SvgIcon.Offset)}</span>` +
						`<span class="z-offset dynamic-value"></span>mm` +
					`</span>` +
				`</div>` +
				`<div class="section-bed tile-line hidden">` +
					`<span class="label">Bed: </span>` +
					`<span class="bed-temp dynamic-value"></span> / <span class="bed-target dynamic-value"></span>` +
					`<sup>${HtmlCode.Celsius}</sup>` +
				`</div>` +
				`<div class="section-error hidden"></div>` +
				`<div class="section-time tiny"></div>` +
			`</div>`;

		canvas.insertAdjacentHTML("beforeend", tileHtml);
	});

	//add confirmation dialog (native <dialog> element)
	var dialogHtml =
		`<dialog id="confirmation-dialog">` +
			`<div class="dialog-title"><span class="title-text">Are you sure?</span></div>` +
			`<div class="dialog-content"><span class="message"></span></div>` +
			`<div class="dialog-buttons">` +
				`<button type="button" class="dialog-no">No</button>` +
				`<button type="button" class="dialog-yes">Yes</button>` +
			`</div>` +
		`</dialog>`;
	canvas.insertAdjacentHTML("beforeend", dialogHtml);

	//add footer
	var footerHtml = `<div class="footer"><a href='https://github.com/nixkor/KlippyDash'>KlippyDash</a> - a lightweight Klipper dashboard.</div>`;
	canvas.insertAdjacentHTML("beforeend", footerHtml);
}

function showSvgIcon(icon) {
	var htmlCode = "";
	if(icon.length > 0) {
		htmlCode = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-hidden="true" class="icon-svg" style=""><path d="${icon}"></path></svg>`;
	}
	return htmlCode;
}

//filter printers based on querystring
function filterPrinters(dictQueryString) {
	var allPrinters = settings.printers;

	if("printer" in dictQueryString || "printerFilter" in dictQueryString) {
		var queryStringArray;
		if("printer" in dictQueryString) {
			queryStringArray = dictQueryString["printer"].split(',');  //querystring is expected to be comma separated list of ints - substring removes the leading ?
		}
		else if("printerFilter" in dictQueryString)  {  //DEPRECATED - use printer
			queryStringArray = dictQueryString["printerFilter"].split(',');  //querystring is expected to be comma separated list of ints - substring removes the leading ?
		}
		else { //this should never happen but just in case...
			return allPrinters;
		}

		var filteredPrinters = new Array();
		queryStringArray.forEach(function (val, index, arr) {
			if (Number.parseInt(val) >= 0
				&& Number.parseInt(val) < allPrinters.length) { //do some sanity checking on string value
				filteredPrinters.push(allPrinters[Number.parseInt(val)]);
			}
		});
		return filteredPrinters;
	}
	else {
		return allPrinters;
	}
}

function parseQueryString() {
	var dict = {};
	if(location.search.length > 1) {
			var queryString = location.search.substring(1); //remove the ?
			var pairs = queryString.split("&"); // split querystring on ampersand into kv pairs
			pairs.forEach(function(pair, index, arr) {
				var kvp = pair.split("=");  //split pair on equals into parts
				var key = kvp[0];
				var value = kvp[1];

				value = decodeURIComponent(value);
				value = value.replace(/\+/g, ' ');

				dict[key] = value;
			});
	}

	return dict;
}

function showConfirmation(title, htmlMessage, endpoint) {
	var dialog = document.getElementById("confirmation-dialog");

	dialog.querySelector(".title-text").textContent = title;
	dialog.querySelector(".message").innerHTML = htmlMessage;

	//rebind handlers each time so we don't stack listeners or fire a stale endpoint
	//(assigning to .onclick replaces any previously-assigned handler, same effect as jQuery's .off().on())
	dialog.querySelector(".dialog-yes").onclick = function() {
		ajaxRequest({
			url: endpoint,
			type: 'POST',
			contentType: 'application/json',
			timeout: _ajaxTimeout,
			error: function(err) {
				alert(`failure! ${err}`);
			}
		});
		dialog.close();
	};

	dialog.querySelector(".dialog-no").onclick = function() {
		dialog.close();
	};

	dialog.showModal();
}

function setup() {
	dictQueryString = parseQueryString();

	_printers = filterPrinters(dictQueryString);

	//normalize hosts - strip trailing slashes so host + "/path" never produces a double slash (which 404s on the Moonraker API)
	_printers.forEach(function(printer) {
		if(typeof(printer.host) === "string")
			printer.host = printer.host.replace(/\/+$/, "");
	});

	if(settings.ajaxTimeout > 0) _ajaxTimeout = Number.parseInt(settings.ajaxTimeout);

	createTiles();

	//bind handlers
	bindHandlers();

	//set full screen if passed
	if("fullscreen" in dictQueryString && JSON.parse(dictQueryString["fullscreen"])) {
		document.body.classList.add("full-screen");
	}

	//set theme if passed in querystring
	var theme = settings.theme;
	if("theme" in dictQueryString)
		theme = dictQueryString["theme"];
	document.documentElement.setAttribute("data-theme",theme);

	if(settings.refreshInterval > 0) _refreshInterval = Number.parseInt(settings.refreshInterval);
}

//Schedule the next refresh _refreshInterval ms after the current one fully settles (recursive setTimeout instead of
//setInterval). This guarantees only one set of requests is ever in flight per printer, so a slow or unreachable
//printer (up to the 10s ajax timeout) can't stack up overlapping requests the way a fixed interval would.
function scheduleNextUpdate() {
	_refreshTimer = setTimeout(function() {
		updateAll().then(scheduleNextUpdate);
	}, _refreshInterval);
}

var party = {
	_timer: undefined,
	On: function(seconds = 30) {
		if(this._timer !== undefined) {
			party.Off(); //turn off the previous party!
		}
		document.body.classList.add("party-time");
		this._timer = setTimeout(() => { party.Off(); }, seconds * 1000);
	},
	Off: function() {
		clearInterval(this._timer);
		document.body.classList.remove("party-time");
		this._timer = undefined;
	},
	AreWePartying: function() { return (this._timer !== undefined); }
}

function ready(fn) {
	if(document.readyState !== "loading") fn();
	else document.addEventListener("DOMContentLoaded", fn);
}

// Настройки теперь приходят из settings.json (не из синхронно загруженного settings.js) —
// нужно дождаться fetch() перед setup()/createTiles(). Наши add-on модули (custom-controls.js,
// print-status.js, temp-graph.js) раньше стартовали по DOMContentLoaded одновременно со стоковым
// кодом (порядок <script> гарантировал, что плитки уже созданы к их моменту); теперь это больше
// не гарантировано (fetch асинхронный), поэтому по завершении шлём отдельное событие
// "klippydash:ready", на которое они подписываются вместо DOMContentLoaded.
ready(() => {
	fetch("settings.json")
		.then(function (r) { return r.json(); })
		.then(function (data) {
			settings = data;
			setup();
			updateAll().then(scheduleNextUpdate);
			window.dispatchEvent(new CustomEvent("klippydash:ready"));
		})
		.catch(function (err) {
			console.error("KlippyDash: failed to load settings.json", err);
			document.getElementById("klippydash").textContent =
				"Failed to load settings.json: " + err;
		});
});

function playAudio(sound) {
	var audio = new Audio(sound);
	var promise = audio.play();
	if (promise !== undefined) {
        promise.then(_ => {
			//shouldnt need to do anything.
        }).catch(error => {
            //todo: look into making this more graceful, thrown when player not approved
        });
    }

}

function bindHandlers() {
	document.querySelectorAll(".control-e-stop").forEach(function(el) {
		el.addEventListener("click", function(e) {
			var data = JSON.parse(this.closest(".tile").getAttribute("data"));
			var printer = _printers[data.index];

			showConfirmation("Emergency Stop?",
				`Are you sure you want to emergency stop?<br/><br />Printer: ${printer.name}`,
				`${printer.host}/printer/emergency_stop`
			);
		});
	});

	document.querySelectorAll(".control-pause").forEach(function(el) {
		el.addEventListener("click", function(e) {
			var data = JSON.parse(this.closest(".tile").getAttribute("data"));
			var printer = _printers[data.index];

			showConfirmation("Pause Print?",
				`Are you sure you want to pause?<br/><br />Printer: ${printer.name}`,
				`${printer.host}/printer/print/pause`
			);
		});
	});

	document.querySelectorAll(".control-resume").forEach(function(el) {
		el.addEventListener("click", function(e) {
			var data = JSON.parse(this.closest(".tile").getAttribute("data"));
			var printer = _printers[data.index];

			showConfirmation("Resume?",
				`Are you sure you want to resume?<br/><br />Printer: ${printer.name}`,
				`${printer.host}/printer/print/resume`
			);
		});
	});

	document.querySelectorAll(".control-cancel").forEach(function(el) {
		el.addEventListener("click", function(e) {
			var data = JSON.parse(this.closest(".tile").getAttribute("data"));
			var printer = _printers[data.index];

			showConfirmation("Cancel?",
				`Are you sure you want to cancel?<br/><br />Printer: ${printer.name}`,
				`${printer.host}/printer/print/cancel`
			);
		});
	});

	document.querySelectorAll(".control-clear").forEach(function(el) {
		el.addEventListener("click", function(e) {
			var data = JSON.parse(this.closest(".tile").getAttribute("data"));
			var printer = _printers[data.index];

			var endpoint = "/printer/gcode/script?script=SDCARD_RESET_FILE";
			ajaxRequest({
				url: printer.host + endpoint,
				type: 'POST',
				contentType: 'application/json',
				timeout: _ajaxTimeout,

				error: function(err) {
					alert(`failure! ${err}`);
				}
			});
		});
	});

	//flip x/y image functionality
	document.querySelectorAll("img.cam").forEach(function(el) {
		var data = JSON.parse(el.getAttribute("data"));
		if(_printers[data.index].flip_x) {
			el.classList.add("flipx")

		}
		else {
			el.classList.remove("flipx")
		}

		if(_printers[data.index].flip_y) {
			el.classList.add("flipy")
		}
		else {
			el.classList.remove("flipy")
		}
	});

	//начальный источник: поток или снимок, в зависимости от настройки принтера
	document.querySelectorAll("img.cam").forEach(function(el) {
		var data = JSON.parse(el.getAttribute("data"));
		setCameraSource(el, _printers[data.index]);
	});

	//Наведение переключает на поток только в режиме снимков — при постоянной трансляции
	//переключать уже не на что.
	document.querySelectorAll("img.cam").forEach(function(el) {
		var data = JSON.parse(el.getAttribute("data"));
		if(_printers[data.index].cameraStream) return;

		el.addEventListener("mouseenter", function(e) {
			var d = JSON.parse(this.getAttribute("data"));
			this.setAttribute("src", _printers[d.index].host + "/webcam/?action=stream");
		});
		el.addEventListener("mouseleave", function(e) {
			var d = JSON.parse(this.getAttribute("data"));
			this.setAttribute("src", _printers[d.index].host + "/webcam/?action=snapshot&cache=" + Math.random());
		});
	});

	//toggle full screen view if image is clicked
	document.querySelectorAll("div.cam").forEach(function(el) {
		el.addEventListener("click", function(e) {
			var data = JSON.parse(this.closest(".tile").getAttribute("data"));

			var baseUrl = window.location.href.split('?')[0]

			var theme;
			if("theme" in dictQueryString)
				theme = dictQueryString["theme"];

			//if full screen toggle back to full view
			if("fullscreen" in dictQueryString && JSON.parse(dictQueryString["fullscreen"])) {
				if(typeof(theme) !== "undefined") {
					window.location.href = `${baseUrl}?theme=${theme}`;
				}
				else {
					window.location.href = baseUrl;
				}
			}
			else{
				if(typeof(theme) !== "undefined") {
					window.location.href = `${baseUrl}?theme=${theme}&printer=${data.index}&fullscreen=1`;
				}
				else {
					window.location.href = `${baseUrl}?printer=${data.index}&fullscreen=1`;
				}
			}
		});
	});
}
