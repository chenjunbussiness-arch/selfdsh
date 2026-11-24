# start-worker.ps1 -- start (or stop) the local dsh-hub worker, detached from this shell.
#
# Reproducible start command:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\plugins\dsh-agent-hub\scripts\start-worker.ps1
#
# Verify:  powershell -NoProfile -File ...\start-worker.ps1   (again -> "already running")
#          Get-Content "$env:USERPROFILE\.dsh\worker\logs\<agent>.log" -Tail 20
# Several agents in <DSH home>\worker\agents\: pick one with -Agent <id> (or DSH_AGENT).
#          python .\plugins\dsh-agent-hub\scripts\agent_client.py status
# Stop:    powershell -NoProfile -ExecutionPolicy Bypass -File ...\start-worker.ps1 -Stop [-Agent <id>]
param(
  [switch]$Stop,
  [string]$Agent = $env:DSH_AGENT,
  [string]$WorkerDir = (Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }) 'worker'),
  [string]$Pythonw = $(if ($c = Get-Command pythonw.exe -ErrorAction SilentlyContinue) { $c.Source } elseif ($p = Get-Command python.exe -ErrorAction SilentlyContinue) { Join-Path (Split-Path $p.Source) 'pythonw.exe' } else { Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\pythonw.exe' }),
  [string]$Runner = (Join-Path $PSScriptRoot 'worker_run.py')
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
$log = $files.log_file

$running = @(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like '*worker_run.py*' -or $_.CommandLine -like '*worker-run.py*') -and
                 (-not $files.agent -or $_.CommandLine -like "*--agent `"$($files.agent)`"*" -or $_.CommandLine -notlike '*--agent*') })

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
  "log:     $log"
  return
}

foreach ($p in @($Pythonw, $Runner)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "missing: $p" }
}

$cmdline = '"' + $Pythonw + '" "' + $Runner + '" --worker-dir "' + $WorkerDir + '"' + $agentArgs
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = $cmdline
  CurrentDirectory = $WorkerDir
}
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed: ReturnValue=$($r.ReturnValue)" }
Start-Sleep -Milliseconds 800
$alive = Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue
"started: PID $($r.ProcessId) alive=$([bool]$alive)"
"cmd:     $cmdline"
"agent:   $(if ($files.agent) { $files.agent } else { '(single-agent folder)' })"
"log:     $log"
