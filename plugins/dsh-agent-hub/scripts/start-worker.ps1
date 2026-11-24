# start-worker.ps1 -- start (or stop) the local dsh-hub worker, detached from this shell.
#
# Reproducible start command:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\dsh-agent-hub\scripts\start-worker.ps1
#
# Verify:  powershell -NoProfile -File ...\start-worker.ps1   (again -> "already running")
#          Get-Content "$env:USERPROFILE\.dsh\worker\run.log" -Tail 20
#          python .\plugins\dsh-agent-hub\scripts\agent_client.py status
# Stop:    powershell -NoProfile -ExecutionPolicy Bypass -File ...\start-worker.ps1 -Stop
param(
  [switch]$Stop,
  [string]$WorkerDir = (Join-Path $env:USERPROFILE '.dsh\worker'),
  [string]$Pythonw = $(if ($c = Get-Command pythonw.exe -ErrorAction SilentlyContinue) { $c.Source } elseif ($p = Get-Command python.exe -ErrorAction SilentlyContinue) { Join-Path (Split-Path $p.Source) 'pythonw.exe' } else { Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\pythonw.exe' }),
  [string]$Runner = (Join-Path $PSScriptRoot 'worker_run.py')
)

$ErrorActionPreference = 'Stop'

$running = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like '*worker_run.py*' -or $_.CommandLine -like '*worker-run.py*') })

if ($Stop) {
  if ($running.Count -eq 0) { "not running"; return }
  foreach ($p in $running) {
    Stop-Process -Id $p.ProcessId -Force
    "stopped: PID $($p.ProcessId)"
  }
  return
}

if ($running.Count -gt 0) {
  "already running: PID $($running.ProcessId -join ',')"
  "log:     $WorkerDir\run.log"
  return
}

foreach ($p in @($Pythonw, $Runner)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "missing: $p" }
}

$cmdline = '"' + $Pythonw + '" "' + $Runner + '"'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = $cmdline
  CurrentDirectory = $WorkerDir
}
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed: ReturnValue=$($r.ReturnValue)" }
Start-Sleep -Milliseconds 800
$alive = Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue
"started: PID $($r.ProcessId) alive=$([bool]$alive)"
"cmd:     $cmdline"
"log:     $WorkerDir\run.log"
