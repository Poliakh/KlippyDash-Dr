# KlippyDash — локальная установка (K1C + QIDI)

Мультипринтерная приборная панель на базе Moonraker API. Одна страница показывает
оба принтера, камеры, статус, температуры и штатные кнопки управления.
Источник проекта: https://github.com/nixkor/KlippyDash

## Как запустить
1. Дважды кликнуть **`start-klippydash.bat`** (в этой папке).
   Он поднимает локальный веб-сервер на `http://localhost:8899/` и открывает браузер.
2. Сервер отдаёт файлы из `src\`. Закрыть — Ctrl+C в открывшемся окне PowerShell.

> На ПК нет Python/Node, поэтому сервер написан на PowerShell (`serve.ps1`,
> `System.Net.HttpListener`). Слушает только `localhost` — наружу ничего не открывает.

## Архитектура (браузер ходит в LAN напрямую)
```
Browser (ПК) → http://localhost:8899   (KlippyDash, статические файлы)
   ├── K1C   Moonraker+камера: http://192.168.30.215:4408
   └── QIDI  Moonraker+камера: http://192.168.30.216:10088
```
`host` у каждого принтера — это порт nginx (Fluidd), который на обоих принтерах
проксирует И Moonraker API (`/printer`, `/server`), И камеру (`/webcam/`) с одного
origin. Camera-режим: snapshot раз в секунду, стрим при наведении мыши (штатное
поведение KlippyDash — щадит слабый WiFi QIDI, не требует открытого Fluidd).

## Где что настраивается
- **`src/settings.js`** — список принтеров (`name` + `host` + `preheatABS`). Чтобы
  добавить 3-й принтер, дописать ещё один объект в массив `printers`.
- Темы: `?theme=dark|light|miami|orcaslicer|default`. Фильтр принтеров: `?printer=0`.
  Полноэкранный (для вкладки OrcaSlicer Device): `?fullscreen=1`.

## Кастомные надстройки (свои файлы, upstream не тронут)
Подключены в `index.html` после штатных. KlippyDash можно обновлять, не теряя их.
- **`src/custom-controls.js` + `.css`** — ряд кнопок ПОД камерой каждого принтера:
  `[ ABS ] [ Cooldown ] [ Resume | Pause | Cancel | Clear ] [ Light ] [ Restart ] [ Fluidd ] [ E-Stop ]`,
  а также **левый столбец данных** (в т.ч. строка `Chamber:` — температура камеры) и
  **правый плавающий столбец `FANS`** с анимированными иконками вентиляторов.
  - Resume/Pause/Cancel/Clear/E-Stop — это штатные элементы KlippyDash, перенесённые под
    камеру (динамика показа по состоянию сохранена; для этого переопределён `getTileControl`).
  - Опасные (Cooldown, Cancel, Restart, E-Stop) — через диалог подтверждения.
  - **ABS (преднагрев)** — ступенчато и НЕ блокируя очередь принтера: сразу ставит стол+
    камеру, а сопло греет только когда стол дойдёт до `nozzleAfterBed`. Опрос идёт из
    браузера (`/printer/objects/query?heater_bed`); иконка пульсирует, пока сопло ждёт.
    Cooldown/Cancel/Restart/E-Stop отменяют ожидание.
  - **Light** — toggle подсветки через `SET_PIN PIN=<light> VALUE=0/1` (K1C `LED`, QIDI
    `caselight`); горит жёлтым, когда свет включён.
  - **FANS / Chamber** — отдельный поллер (2.5с) читает `chamberSensor` и `fans` из
    `settings.js` и обновляет температуру камеры и вентиляторы. Активный вентилятор —
    синяя крутящаяся иконка (скорость вращения ∝ скорости, логарифмически: 0.60с/оборот
    при 100%, ~2.6с у ~0), простаивающий — приглушён. Значения: `.speed`
    (fan/heater_fan/temperature_fan) или `.value` (output_pin), 0..1.
  - **Chamber current/target** — строка камеры показывает «текущая / целевая» (как сопло/
    стол). Источник с полем target: K1C `temperature_fan chamber_fan` (target=порог вытяжки),
    QIDI `heater_generic hot` (активный нагрев). Без target — показывает только текущую.
  - **Power (мощность нагревателей)** — столбец после температур (тонкий бар + %, стиль Fluidd):
    Extruder `extruder.power`, Bed `heater_bed.power`, Chamber — только если это реальный
    нагреватель (`.power`; на K1C камера — вентилятор, столбец скрыт). Z-offset сдвинут правее.
  - **Кнопки не скрываются** — Resume/Pause/Cancel/Clear всегда на панели; когда неприменимы,
    затеняются (opacity .45) и не кликаются (CSS переопределяет `.hidden` только внутри панели).
  - **Restart** — иконка перезагрузки (`fa-rotate-right`), делает `firmware_restart` (прошивка).
  - **Панель времени печати** (`section-printstats`, видна только при печати) перенесена ПОД
    температуры и выстроена в один столбец с выравниванием значений (`.label` min-width 138).
- **`src/theme-tweaks.css`** — палитра под **Fluidd** (Material-dark: high 0.87 / medium 0.60
  белого; фон `#121212`, карточки `#1e1e1e`, синий акцент `#2196f3`) — комфортный контраст,
  без пересвеченных надписей. + выравнивание значений температур в колонку (`.label` min-width).
  Убрать = убрать `<link>` в `index.html`.

### Пресеты преднагрева (`settings.js` → `preheatABS`)
Текущие значения (оба принтера): `extruder:150, bed:100, chamber:60, nozzleAfterBed:95`.
Камера задаётся разной командой на разных машинах (`chamberGcode`):
- **K1C** — нет chamber-нагревателя: `SET_TEMPERATURE_FAN_TARGET TEMPERATURE_FAN=chamber_fan TARGET=60`
  (цель вытяжного вентилятора, чтобы он не включался до 60°).
- **QIDI** — реальный нагреватель камеры: `SET_HEATER_TEMPERATURE HEATER=hot TARGET=60`.

## Что менялось на принтерах
- **K1C:** ничего. В его `moonraker.conf` уже был `*://localhost:*` в `cors_domains`.
- **QIDI:** в `/home/mks/klipper_config/moonraker.conf` в `cors_domains` добавлены
  `http://localhost`, `http://localhost:8899`, `http://localhost:*`; перезапущен
  сервис moonraker (не Klipper). Бэкап: `moonraker.conf.bak.20260902_084339`.
- Fluidd на обоих принтерах не тронут и работает как раньше.

## Проверено (2026-09-02)
- Оба принтера и обе камеры видны одновременно на одной странице (1280×720).
- Статус/темп/имя файла/время/остаток филамента/Z-offset — тянутся корректно.
- Динамические кнопки по состоянию: K1C (Complete) → Clear+E-Stop; QIDI (Standby) → E-Stop.
  Pause/Resume/Cancel появляются во время реальной печати.
- CORS-preflight (OPTIONS) для POST на оба принтера с origin localhost:8899 → 204 OK
  (управление будет работать кросс-доменно). E-Stop/Cancel специально НЕ нажимались.

## Ограничения / на будущее
- Сервер локальный и живёт, пока запущен `start-klippydash.bat` (после перезагрузки
  ПК запустить снова). Для «всегда открытой вкладки» можно: (а) добавить ярлык bat в
  автозагрузку Windows, либо (б) захостить `src\` на nginx одного из принтеров по пути
  `/klippydash/` — тогда URL будет постоянным и не зависит от ПК. Решаем позже (где жить).
- Открывать по `http://localhost:8899` нужно с этого ПК. Если понадобится открывать с
  других машин LAN — сменить хостинг на принтер и расширить `cors_domains` под нужный origin.
