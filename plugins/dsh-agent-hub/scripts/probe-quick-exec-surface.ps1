#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only probe: can a third-party process hand a task to the local AWS Quick desktop client?

.DESCRIPTION
  Answers one question for the hub onboarding decision: does the installed AWS Quick
  expose a local execution surface that a dsh-agent/2.0 worker could drive?
  It inspects the running Quick processes, its loopback listeners, the auth boundary of
  its local HTTP services, the presence of a CLI / on-disk outpost token, and (when rg is
  available) the token-handover strings inside app.asar.

  It does NOT log in, does NOT start or stop Quick, does NOT touch the hub, does NOT read
  or print any credential, and writes nothing outside -OutFile.

  Verdicts (exit code):
    0  NO-THIRD-PARTY-SURFACE   only /health answered without auth; every other route 401
                                -> a worker cannot drive Quick; do not register one.
    2  SURFACE-MAYBE-OPEN       a non-/health route answered 2xx without a token
                                -> re-evaluate bridging before drawing any conclusion.
    3  NOT-RUNNING              Quick processes absent; nothing to judge.

  The conclusion this probe supports is recorded in
  plugins/dsh-agent-hub/docs/aws-quick-onboarding.md.

.EXAMPLE
  pwsh -File plugins/dsh-agent-hub/scripts/probe-quick-exec-surface.ps1
  pwsh -File plugins/dsh-agent-hub/scripts/probe-quick-exec-surface.ps1 -OutFile .dsh-artifacts\quick-probe.txt
#>
[CmdletBinding()]
param(
  [int[]]$OutpostPorts = @(8780),
  [int[]]$SandboxPorts = @(8768),
  [string]$AsarPath = (Join-Path $env:LOCALAPPDATA 'Programs\quickwork\resources\app.asar'),
  [string]$RgPath = (Join-Path $env:LOCALAPPDATA 'Programs\quickwork\resources\bin\rg.exe'),
  [string]$OutFile
)

$ErrorActionPreference = 'Continue'
$PS7 = $PSVersionTable.PSVersion.Major -ge 7
$lines = New-Object System.Collections.Generic.List[string]

function Emit([string]$text) {
  $lines.Add($text)
  Write-Host $text
}

function Section([string]$title) {
  Emit ''
  Emit "=== $title ==="
}

# Returns the HTTP status code of a request, or -1 when the connection failed.
function Get-Status([string]$Method, [string]$Url) {
  $params = @{
    Uri            = $Url
    Method         = $Method
    TimeoutSec     = 6
    ErrorAction    = 'Stop'
    MaximumRedirection = 0
  }
  if ($PS7) { $params['SkipHttpErrorCheck'] = $true } else { $params['UseBasicParsing'] = $true }
  try {
    $r = Invoke-WebRequest @params
    return [int]$r.StatusCode
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { return [int]$resp.StatusCode }
    return -1
  }
}

Emit "AWS Quick local execution-surface probe (read-only)"
Emit ("time:     " + (Get-Date).ToString('o'))
Emit ("host:     " + $env:COMPUTERNAME)
Emit ("powershell: " + $PSVersionTable.PSVersion.ToString())

# --- A. processes ------------------------------------------------------------
Section 'A. Quick processes'
$quickNames = 'Amazon Quick', 'quickwork-agent', 'quickwork-sandbox'
$procs = @(Get-Process -Name $quickNames -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
  Emit 'none of: ' + ($quickNames -join ', ') + ' is running'
} else {
  foreach ($p in $procs) {
    $start = ''
    try { $start = $p.StartTime.ToString('o') } catch { $start = '<denied>' }
    Emit ("{0,-18} pid={1,-7} start={2}" -f $p.ProcessName, $p.Id, $start)
  }
}

# --- B. loopback listeners ---------------------------------------------------
Section ('B. loopback listeners on ' + (($OutpostPorts + $SandboxPorts) -join ', '))
$allPorts = @($OutpostPorts + $SandboxPorts)
$found = @()
if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
  foreach ($port in $allPorts) {
    $conns = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($conns.Count -eq 0) { Emit ("port {0,-6} not listening" -f $port); continue }
    foreach ($c in $conns) {
      $owner = ''
      try { $owner = (Get-Process -Id $c.OwningProcess -ErrorAction Stop).ProcessName } catch { $owner = '?' }
      Emit ("port {0,-6} {1,-12} -> {2} pid={3}" -f $port, 'LISTENING', $owner, $c.OwningProcess)
      $found += $port
    }
  }
} else {
  foreach ($row in @(netstat -ano | Select-String -Pattern ':(\d+)\s+0\.0\.0\.0:0\s+LISTENING')) {
    $text = $row.ToString()
    foreach ($port in $allPorts) { if ($text -match (":$port\s")) { Emit $text.Trim(); $found += $port } }
  }
}
if ($found.Count -eq 0) { Emit 'nothing listening - the local service is not up' }

# --- C. auth boundary --------------------------------------------------------
Section 'C. auth boundary of the outpost service'
$getPaths = '/health', '/', '/v1/health', '/status', '/docs', '/openapi.json',
            '/local/outpost-id', '/tools', '/v1/tools', '/tasks', '/v1/tasks', '/invoke-tool'
$postPaths = '/invoke-tool', '/v1/invoke-tool', '/v1/tasks', '/v1/execute', '/v1/prompt', '/mcp'
$unauthenticated = New-Object System.Collections.Generic.List[string]
foreach ($port in $OutpostPorts) {
  if ($found -notcontains $port) { continue }
  Emit ("-- http://127.0.0.1:{0} --" -f $port)
  foreach ($path in $getPaths) {
    $code = Get-Status 'GET' ("http://127.0.0.1:$port$path")
    Emit ("GET  {0,-20} -> {1}" -f $path, $code)
    if ($code -ge 200 -and $code -lt 300 -and $path -ne '/health') { $unauthenticated.Add("GET $path") }
  }
  foreach ($path in $postPaths) {
    $code = Get-Status 'POST' ("http://127.0.0.1:$port$path")
    Emit ("POST {0,-20} -> {1}" -f $path, $code)
    if ($code -ge 200 -and $code -lt 300) { $unauthenticated.Add("POST $path") }
  }
}
foreach ($port in $SandboxPorts) {
  if ($found -notcontains $port) { continue }
  Emit ("-- http://127.0.0.1:{0} (sandbox) --" -f $port)
  foreach ($path in '/health', '/', '/local/outpost-id') {
    $code = Get-Status 'GET' ("http://127.0.0.1:$port$path")
    Emit ("GET  {0,-20} -> {1}" -f $path, $code)
  }
}

# --- D. CLI ------------------------------------------------------------------
Section 'D. command line entry point'
foreach ($name in 'quick', 'quickwork', 'amazon-quick', 'aws-quick', 'quickwork-agent') {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { Emit ("FOUND  {0} -> {1}" -f $name, $cmd.Source) } else { Emit ("absent {0}" -f $name) }
}

# --- E. token on disk --------------------------------------------------------
Section 'E. outpost token on disk (names and sizes only)'
$localAppData = $env:LOCALAPPDATA
if (-not $localAppData) { $localAppData = [Environment]::GetFolderPath('LocalApplicationData') }
$userData = Join-Path $localAppData 'quickwork'
$tokenHits = @()
if (Test-Path $userData) {
  $tokenHits = @(Get-ChildItem -Path $userData -Depth 4 -File -ErrorAction SilentlyContinue |
                 Where-Object { $_.Name -match 'outpost.*token|token.*outpost' })
  if ($tokenHits.Count -eq 0) { Emit ("no outpost token file under " + $userData) }
  foreach ($f in $tokenHits) { Emit ("found {0} ({1} bytes)" -f $f.FullName, $f.Length) }
} else {
  Emit ("missing " + $userData)
}

# --- F. asar strings ---------------------------------------------------------
Section 'F. token handover strings inside app.asar'
if ((Test-Path $AsarPath) -and (Test-Path $RgPath)) {
  Emit ('asar: ' + $AsarPath + ' (' + (Get-Item $AsarPath).Length + ' bytes)')
  foreach ($pattern in 'OUTPOST_TOKEN', 'OUTPOST_PORT', 'QUICKWORK_TOKEN_FILE', 'outpost:invoke-tool', 'mcpServers') {
    $count = (& $RgPath -a -c -e $pattern $AsarPath 2>$null | Out-String).Trim()
    if (-not $count) { $count = '0' }
    Emit ("{0,-24} matching lines: {1}" -f $pattern, $count)
  }
  $ctx = (& $RgPath -a -o -N '.{0,50}OUTPOST_TOKEN.{0,60}' $AsarPath 2>$null | Select-Object -First 1 | Out-String).Trim()
  if ($ctx) { Emit ('context: ' + $ctx) }
  $ctx2 = (& $RgPath -a -o -N '.{0,60}QUICKWORK_TOKEN_FILE.{0,80}' $AsarPath 2>$null | Select-Object -First 2 | Out-String).Trim()
  if ($ctx2) { Emit ('context: ' + ($ctx2 -replace '\s+', ' ')) }
} else {
  Emit 'skipped (app.asar or rg.exe not found)'
}

# --- G. verdict --------------------------------------------------------------
Section 'G. verdict'
if ($procs.Count -eq 0) {
  Emit 'NOT-RUNNING: AWS Quick is not running; start it and re-run to judge the surface.'
  $verdict = 3
} elseif ($unauthenticated.Count -gt 0) {
  Emit ('SURFACE-MAYBE-OPEN: these routes answered without a token: ' + ($unauthenticated -join ', '))
  Emit 'Re-evaluate the bridge design before registering any agent.'
  $verdict = 2
} else {
  Emit 'NO-THIRD-PARTY-SURFACE: only /health answers without auth; every task-shaped route returned 401.'
  Emit 'The outpost token is generated per launch and handed to the Electron main process over stdio.'
  Emit 'A dsh-agent/2.0 worker therefore cannot hand a task to Quick: do not register an aws-quick agent.'
  $verdict = 0
}

if ($OutFile) {
  $dir = Split-Path -Parent $OutFile
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($OutFile, (($lines -join [Environment]::NewLine) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ('written: ' + $OutFile)
}

exit $verdict
