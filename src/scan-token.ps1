# Read-only scan of WorkBuddy process memory for bearer tokens (JWT-shaped strings).
# Does not modify, inject, or suspend anything.
$ErrorActionPreference = 'Stop'

Add-Type -Namespace WbScan -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION64 mbi, IntPtr len);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
[StructLayout(LayoutKind.Sequential)]
public struct MEMORY_BASIC_INFORMATION64 {
  public ulong BaseAddress; public ulong AllocationBase; public uint AllocationProtect;
  public uint __alignment1; public ulong RegionSize; public uint State; public uint Protect; public uint Type; public uint __alignment2;
}
public const int PROCESS_QUERY_INFORMATION = 0x0400;
public const int PROCESS_VM_READ = 0x0010;
public const uint MEM_COMMIT = 0x1000;
public const uint PAGE_NOACCESS = 0x01;
public const uint PAGE_GUARD = 0x100;
'@

$jwt = [regex]'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}'
$hits = [System.Collections.Generic.HashSet[string]]::new()

$procs = Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 8
foreach ($p in $procs) {
    $h = [WbScan.Native]::OpenProcess(0x0410, $false, $p.Id)
    if ($h -eq [IntPtr]::Zero) { "pid $($p.Id): open failed ($([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message))"; continue }

    $addr = [IntPtr]::Zero
    $mbi = New-Object WbScan.Native+MEMORY_BASIC_INFORMATION64
    $scanned = 0
    $found = 0
    while ([WbScan.Native]::VirtualQueryEx($h, $addr, [ref]$mbi, [IntPtr]::new([Runtime.InteropServices.Marshal]::SizeOf($mbi))) -ne [IntPtr]::Zero) {
        $size = [int64]$mbi.RegionSize
        $readable = ($mbi.State -eq 0x1000) -and (($mbi.Protect -band 0x01) -eq 0) -and (($mbi.Protect -band 0x100) -eq 0)
        if ($readable -and $size -gt 0 -and $size -lt 200MB) {
            $buf = New-Object byte[] $size
            $read = [IntPtr]::Zero
            if ([WbScan.Native]::ReadProcessMemory($h, [IntPtr]::new([int64]$mbi.BaseAddress), $buf, [IntPtr]::new($size), [ref]$read)) {
                $scanned += $size
                $text = [Text.Encoding]::ASCII.GetString($buf)
                foreach ($m in $jwt.Matches($text)) {
                    if ($hits.Add($m.Value)) { $found++ }
                }
            }
        }
        $next = [int64]$mbi.BaseAddress + $size
        if ($next -le 0) { break }
        $addr = [IntPtr]::new($next)
    }
    [WbScan.Native]::CloseHandle($h) | Out-Null
    "pid $($p.Id): scanned $([math]::Round($scanned/1MB,0)) MB, new tokens $found"
}

"total unique JWT-like strings: $($hits.Count)"
$records = @()
foreach ($t in $hits) {
    $parts = $t.Split('.')
    $payload = ''
    try {
        $pad = $parts[1].Replace('-','+').Replace('_','/')
        while ($pad.Length % 4) { $pad += '=' }
        $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($pad))
    } catch { }
    $records += [pscustomobject]@{ token = $t; len = $t.Length; payload = $payload }
    "--- token: $($t.Substring(0,12))... len=$($t.Length)"
    if ($payload) { "    payload: " + $payload.Substring(0, [Math]::Min(220, $payload.Length)) }
}
$out = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'logs\mem-tokens.json'
$records | ConvertTo-Json -Depth 4 | Set-Content -Path $out -Encoding utf8
"saved: $out"

# 选一条 best token 给 counter 使用：aud=account 且 exp 最大
$best = $null
foreach ($r in $records) {
    if ($r.payload -notmatch '"aud":"account"') { continue }
    try {
        $p = $r.payload | ConvertFrom-Json
        if (-not $best -or [double]$p.exp -gt [double]$best.exp) { $best = [pscustomobject]@{ exp = [double]$p.exp; token = $r.token } }
    } catch { }
}
if ($best) {
    $tokenFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'logs\token.json'
    $sub = ''
    try {
        $seg = $best.token.Split('.')[1].Replace('-','+').Replace('_','/')
        while ($seg.Length % 4) { $seg += '=' }
        $sub = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($seg)) | ConvertFrom-Json).sub
    } catch { }
    $payload = [pscustomobject]@{ token = $best.token; exp = $best.exp; sub = $sub; scannedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($tokenFile, $payload, (New-Object Text.UTF8Encoding($false)))
    "best token saved: $tokenFile (exp=$($best.exp) sub=$sub)"
} else {
    "no aud=account token found"
}
