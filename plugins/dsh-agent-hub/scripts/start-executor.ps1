<#
.SYNOPSIS
  Start (or stop) the dsh-hub worker executor: the process that consumes
  <worker>\exchange\inbox\ and writes result.json back for agent_client.py to upload.

.DESCRIPTION
  Why a second resident process and not a loop inside agent_client.py:
   1. the worker client is already online (launcher worker_run.py); adding
      code to it means restarting it, i.e. a needless offline window;
   2. a task that hangs or crashes the executor cannot take the 30 s heartbeat down
      with it -- the hub keeps seeing this worker online while the executor restarts;
   3. it can be stopped / restarted / upgraded on its own.
  Single instance per agent: worker_executor.py takes a byte-range lock on <exchange>\.executor.lock
  (released by the OS when the process dies); this script also refuses to start a
  second copy when one is already running.
  Log: <worker>\logs\<agent>.executor.log (the executor writes it; nothing is inherited from this
  shell, so no DSH_* variable of the calling session reaches a task).

.PARAMETER Stop
  Stop the running executor(s) instead of starting one. The worker stays online.

.PARAMETER Interval
  Seconds between scans of inbox\.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\dsh-agent-hub\scripts\start-executor.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File ...\start-executor.ps1 -Stop
  Get-Content "$env:USERPROFILE\.dsh\worker\logs\<agent>.executor.log" -Tail 20

.PARAMETER Agent
  Which agents\<id>.json (default: DSH_AGENT, or the only one). Same choice as agent_client.py run.
#>
param(
  [switch]$Stop,
  [double]$Interval = 1.5,
  [string]$Agent = $env:DSH_AGENT,
  [string]$WorkerDir = (Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }) 'worker'),
  [string]$Pythonw = $(if ($c = Get-Command pythonw.exe -ErrorAction SilentlyContinue) { $c.Source } elseif ($p = Get-Command python.exe -ErrorAction SilentlyContinue) { Join-Path (Split-Path $p.Source) 'pythonw.exe' } else { Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\pythonw.exe' }),
  [string]$Executor = (Join-Path $PSScriptRoot 'worker_executor.py')
)

$ErrorActionPreference = 'Stop'

# Which agent, and where its files are: asked from agent_client.py itself, so this script,
# worker_run.py and worker_executor.py always agree with `agent_client.py run`.
$Python = Join-Path (Split-Path $Pythonw) 'python.exe'
if (-not (Test-Path -LiteralPath $Python)) { $Python = $Pythonw }
$pathsArgs = @((Join-Path $PSScriptRoot 'agent_client.py'), 'paths', '--worker-dir', $WorkerDir)
if ($Agent) { $pathsArgs += @('--agent', $Agent) }
$files = (& $Python @pathsArgs | Out-String) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $files) { throw "cannot read the worker settings (python agent_client.py paths --worker-dir `"$WorkerDir`" $(if ($Agent) { "--agent $Agent" }))" }
$agentArgs = if ($files.agent) { ' --agent "' + $files.agent + '"' } else { '' }
$log = $files.executor_log

$running = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*worker_executor.py*' -and
                 (-not $files.agent -or $_.CommandLine -like "*--agent `"$($files.agent)`"*" -or $_.CommandLine -notlike '*--agent*') })

if ($Stop) {
  if ($running.Count -eq 0) { "not running"; return }
  foreach ($p in $running) {
    Stop-Process -Id $p.ProcessId -Force
    "stopped: PID $($p.ProcessId)"
  }
  "the worker itself is untouched: agent_client.py run keeps it online"
  return
}

if ($running.Count -gt 0) {
  "already running: PID $($running.ProcessId -join ',')"
  "log:     $log"
  return
}

foreach ($p in @($Pythonw, $Executor)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "missing: $p" }
}

$cmdline = '"' + $Pythonw + '" "' + $Executor + '" --worker-dir "' + $WorkerDir + '"' + $agentArgs + ' --interval ' + $Interval.ToString([Globalization.CultureInfo]::InvariantCulture)
# Win32_Process.Create: the child inherits nothing from this shell and outlives it.
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = $cmdline
  CurrentDirectory = $WorkerDir
}
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed: ReturnValue=$($r.ReturnValue)" }
Start-Sleep -Milliseconds 800
$alive = Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue
"started: PID $($r.ProcessId) alive=$([bool]$alive)"
"cmd:     $cmdline"
"log:     $log"
