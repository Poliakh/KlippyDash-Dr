@echo off
REM Polnostyu ostanavlivaet stek KlippyDash (prod): dashboard, ml_api, watchdog.
REM
REM Nuzhen potomu, chto vse tri processa zapuskayutsya BEZ OKON (sm. start-klippydash.bat) -
REM zakryvat vruchnuyu nechego, a v dispetchere zadach oni vyglyadyat kak tri odinakovyh
REM pythonw.exe.
REM
REM Ischet processy dvumya sposobami:
REM   1) po puti - vsyo, v ch'ey komandnoy stroke vstrechaetsya papka etogo skripta
REM      (KlippyDash-dev NE popadaet: u nego drugoy put, dev-stend ne trogaem);
REM   2) po portam 8899 / 3333 / 3334 - lovit processy, zapushchennye inache, naprimer
REM      vruchnuyu iz konsoli, gde polnogo puti v komandnoy stroke net.

setlocal
set "ROOT=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$root='%ROOT%'; $ids=@(); $ids+=(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and $_.CommandLine -notmatch 'stop-klippydash' } | Select-Object -ExpandProperty ProcessId); foreach($port in 8899,3333,3334){ try{ $ids+=(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess) } catch {} }; $ids=$ids | Where-Object { $_ -and $_ -ne $PID } | Sort-Object -Unique; if(-not $ids){ Write-Host 'KlippyDash is not running - nothing to stop.' } else { foreach($id in $ids){ $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p){ Write-Host ('  stopping ' + $p.ProcessName + '  PID ' + $id); Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Milliseconds 800; $left=@(); foreach($port in 8899,3333,3334){ try{ $null=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop; $left+=$port } catch {} }; if($left){ Write-Host ('WARNING: ports still busy: ' + ($left -join ', ')) } else { Write-Host 'Stopped. Ports 8899/3333/3334 are free.' } }"

REM Pauza, chtoby uspet prochitat vyvod pri zapuske dvoynym klikom. Imenno ping, a ne timeout:
REM timeout padaet s "Input redirection is not supported", esli zapustit skript ne iz konsoli.
ping -n 6 127.0.0.1 > nul
endlocal
