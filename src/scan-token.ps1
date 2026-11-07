# Read-only scan of WorkBuddy process memory for bearer tokens (JWT-shaped strings).
# Does not modify, inject, or suspend anything.
#
# On-disk output is deliberately minimal:
#   logs\token.json   only the token direct-upstream.mjs must send (it cannot hash it)
#   logs\mem-tokens.json  one summary line per hit: 8-char prefix, length, exp, aud, sub
# No payload, no full JWT is ever printed to the console by this script.
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

# secret-bearing output lives in logs\\ next to this script, owner-only
$logDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$acl = Get-Acl -LiteralPath $logDir
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $logDir -AclObject $acl

function Protect-SecretFile([string] $path) {
    $fileAcl = Get-Acl -LiteralPath $path
    $fileAcl.SetAccessRuleProtection($true, $false)
    $fileAcl.Access | ForEach-Object { $fileAcl.RemoveAccessRule($_) | Out-Null }
    $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($me, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $path -AclObject $fileAcl
}

function ConvertFrom-JwtSegment([string] $segment) {
    $pad = $segment.Replace('-','+').Replace('_','/')
    while ($pad.Length % 4) { $pad += '=' }
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($pad))
}

function Get-TokenFacts([string] $token) {
    $exp = $null
    $aud = ''
    $sub = ''
    try {
        $p = ConvertFrom-JwtSegment ($token.Split('.')[1]) | ConvertFrom-Json
        if ($null -ne $p.exp) { $exp = [double]$p.exp }
        if ($null -ne $p.aud) { $aud = [string]$p.aud }
        if ($null -ne $p.sub) { $sub = [string]$p.sub }
    } catch { }
    [pscustomobject]@{ exp = $exp; aud = $aud; sub = $sub }
}

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
    $facts = Get-TokenFacts $t
    $records += [pscustomobject]@{
        peek = $t.Substring(0, [Math]::Min(8, $t.Length))
        len = $t.Length
        exp = $facts.exp
        aud = $facts.aud
        sub = $facts.sub
    }
    "--- token $($t.Substring(0, [Math]::Min(8, $t.Length)))... len=$($t.Length) exp=$($facts.exp)"
}
$out = Join-Path $logDir 'mem-tokens.json'
$records | ConvertTo-Json -Depth 4 | Set-Content -Path $out -Encoding utf8
Protect-SecretFile $out
"saved summary: $out"

# 选一条 best token 给 counter 使用：aud=account 且 exp 最大
$best = $null
foreach ($t in $hits) {
    $facts = Get-TokenFacts $t
    if ($facts.aud -notmatch '\baccount\b') { continue }
    if ($null -eq $facts.exp) { continue }
    if (-not $best -or $facts.exp -gt $best.exp) { $best = [pscustomobject]@{ exp = $facts.exp; token = $t; sub = $facts.sub } }
}
if ($best) {
    $tokenFile = Join-Path $logDir 'token.json'
    $payload = [pscustomobject]@{ token = $best.token; exp = $best.exp; sub = $best.sub; scannedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($tokenFile, $payload, (New-Object Text.UTF8Encoding($false)))
    Protect-SecretFile $tokenFile
    "best token saved: $tokenFile (exp=$($best.exp) sub=$($best.sub))"
} else {
    "no aud=account token found"
}
