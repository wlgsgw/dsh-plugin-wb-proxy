# start.ps1 - start the wb-proxy plugin (port from config.json, default 8787).
# Idempotent: a service already listening is left alone, so the one-minute watchdog
# can call this unconditionally.
#
# Optional python relay (workbuddy2api on 8790) starts only when config points at
# 127.0.0.1:8790 and a relay directory exists:
#   $env:WB_RELAY_DIR, else <plugin>\py-packages, else <plugin>\relay
#
# Note: the proxy itself is spawned WITHOUT stdout/stderr redirection. Redirecting a
# child's pipes makes Start-Process block until the child exits, which would hang the
# scheduled task. Server output goes nowhere; request logs land in <plugin>\logs.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logs = Join-Path $here 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs -Force | Out-Null }

$cfgPath = Join-Path $here 'config.json'
if (-not (Test-Path $cfgPath)) { Copy-Item (Join-Path $here 'config\config.credits.json') $cfgPath }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json

$port = 8787
if ($cfg.listen.port) { $port = [int]$cfg.listen.port }
if ($env:WB_PROXY_PORT -match '^\d+$') { $port = [int]$env:WB_PROXY_PORT }

# ---- optional python relay on 8790 ----
$pyDir = $env:WB_RELAY_DIR
if (-not $pyDir) { $pyDir = Join-Path $here 'py-packages' }
if (-not (Test-Path $pyDir)) { $pyDir = Join-Path $here 'relay' }
$wb2 = 8790
$base = [string]$cfg.upstream.baseURL
if ($base -match '127\.0\.0\.1:8790' -and (Test-Path $pyDir)) {
    $listen = Get-NetTCPConnection -LocalPort $wb2 -State Listen -ErrorAction SilentlyContinue
    if ($listen) {
        Write-Output "workbuddy2api already listening on 127.0.0.1:$wb2 (pid $($listen[0].OwningProcess))"
    } else {
        $py = 'C:\Users\56100\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
        if ($env:WB_PYTHON) { $py = $env:WB_PYTHON }
        if (-not (Test-Path $py)) { $py = 'python' }
        $env:PYTHONPATH = $pyDir
        $wb2args = @(
            '-m', 'codebuddy_proxy', '--port', "$wb2", '--desensitize',
            '--session-file', (Join-Path $logs 'wb2api-session.json'),
            '--log-file', (Join-Path $logs 'wb2api.jsonl')
        )
        $wb2out = Join-Path $logs 'wb2api.out.log'
        $wb2err = Join-Path $logs 'wb2api.err.log'
        $pyproc = Start-Process -FilePath $py -ArgumentList $wb2args -WorkingDirectory $here -WindowStyle Hidden -PassThru -RedirectStandardOutput $wb2out -RedirectStandardError $wb2err
        Start-Sleep -Seconds 8
        $listen = Get-NetTCPConnection -LocalPort $wb2 -State Listen -ErrorAction SilentlyContinue
        if ($listen) { Write-Output "started workbuddy2api pid $($pyproc.Id) on 127.0.0.1:$wb2" }
        else { Write-Output 'workbuddy2api FAILED, see logs\wb2api.err.log' }
    }
}

# ---- the proxy itself ----
$listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listen) {
    Write-Output "already listening on 127.0.0.1:$port (pid $($listen[0].OwningProcess))"
    exit 0
}

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
    $nodeExe = 'C:\Users\56100\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\node.exe'
}
$proc = Start-Process -FilePath $nodeExe -ArgumentList 'src\server.mjs' -WorkingDirectory $here -WindowStyle Hidden -PassThru

Start-Sleep -Seconds 2
$listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listen) {
    Write-Output "started pid $($proc.Id), listening on 127.0.0.1:$port"
} else {
    Write-Output 'FAILED to start (port is not listening). Check that node >= 18 is on PATH and that config.json exists.'
    exit 1
}
