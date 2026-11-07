# Stop wb-deepseek-proxy (kills the listener on the configured port).
$port = 8787
if ($env:WB_PROXY_PORT -match '^\d+$') { $port = [int]$env:WB_PROXY_PORT }
$listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listen) { "not running"; exit 0 }
foreach ($conn in $listen) {
    try {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
        "stopped pid $($conn.OwningProcess)"
    } catch {
        "could not stop pid $($conn.OwningProcess): $($_.Exception.Message)"
    }
}
