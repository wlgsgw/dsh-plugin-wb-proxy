# Query the upstream account balance and append a history record.
# Reads upstream.apiKey from config.json (never prints the key).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$cfg = Get-Content (Join-Path $here 'config.json') -Raw | ConvertFrom-Json
$key = $cfg.upstream.apiKey
if (-not $key) { "no upstream.apiKey in config.json"; exit 1 }

$r = Invoke-RestMethod 'https://api.deepseek.com/user/balance' -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 20
$info = $r.balance_infos | Select-Object -First 1
$record = [pscustomobject]@{
    ts               = (Get-Date).ToUniversalTime().ToString('o')
    currency         = $info.currency
    total_balance    = [double]$info.total_balance
    topped_up        = [double]$info.topped_up_balance
    granted          = [double]$info.granted_balance
    is_available     = $r.is_available
}

$logDir = Join-Path $here 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$hist = Join-Path $logDir 'balance.jsonl'

$prev = $null
if (Test-Path $hist) {
    $last = Get-Content $hist | Select-Object -Last 1
    if ($last) { try { $prev = $last | ConvertFrom-Json } catch { $prev = $null } }
}

$out = [pscustomobject]@{
    time     = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    currency = $record.currency
    total    = $record.total_balance
    toppedUp = $record.topped_up
    granted  = $record.granted
}
if ($prev) {
    $out | Add-Member -NotePropertyName deltaSinceLast -NotePropertyValue ([math]::Round($record.total_balance - [double]$prev.total_balance, 4))
    $out | Add-Member -NotePropertyName lastSeen -NotePropertyValue $prev.ts
}
$out | Format-List

($record | ConvertTo-Json -Compress) | Add-Content -Path $hist -Encoding utf8
