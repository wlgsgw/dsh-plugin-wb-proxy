# Show proxy status: listener, health, last requests.
$port = 8787
if ($env:WB_PROXY_PORT -match '^\d+$') { $port = [int]$env:WB_PROXY_PORT }
$listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listen) {
    "listening on 127.0.0.1:$port (pid $($listen[0].OwningProcess))"
    try {
        (Invoke-WebRequest "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 5).Content
    } catch {
        "health check failed: $($_.Exception.Message)"
    }
} else {
    "not running on port $port"
}
$logDir = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'logs'
$today = Get-Date -Format 'yyyy-MM-dd'
$jsonl = Join-Path $logDir "proxy-$today.jsonl"
if (Test-Path $jsonl) {
    ""
    "recent requests:"
    Get-Content $jsonl | Select-Object -Last 5
}
