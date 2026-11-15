#Requires -Version 5.1
<#
.DESCRIPTION
    DishyWarden connectivity diagnostic (ASCII only).

    Runs a batch of independent checks and prints a PASS/FAIL table.
    Every check is independent so one failure does not hide the others.

    Usage:
        powershell -ExecutionPolicy Bypass -File verify-dish-diag.ps1
        powershell -ExecutionPolicy Bypass -File verify-dish-diag.ps1 -DishIp 192.168.100.1
#>

param(
    [string]$DishIp = "192.168.100.1",
    [int]$NativePort = 9200,
    [int]$WebPort = 9201
)

$ErrorActionPreference = "Continue"
$script:Results = @()

function Add-Result {
    param([string]$Name, [string]$Status, [string]$Detail = "")
    $script:Results += [PSCustomObject]@{
        Check = $Name; Status = $Status; Detail = $Detail
    }
    $color = switch ($Status) {
        "PASS" { "Green" }
        "FAIL" { "Red" }
        "WARN" { "Yellow" }
        default { "Gray" }
    }
    Write-Host ("{0,-34} {1,-5} {2}" -f $Name, $Status, $Detail) -ForegroundColor $color
}

Write-Host ""
Write-Host "DishyWarden connectivity diagnostic" -ForegroundColor Cyan
Write-Host ("Target: {0}  native={1}  web={2}" -f $DishIp, $NativePort, $WebPort) -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------- 1. ping
try {
    $r = Test-Connection -ComputerName $DishIp -Count 2 -Quiet -ErrorAction SilentlyContinue
    if ($r) { Add-Result "ICMP ping" "PASS" "" }
    else    { Add-Result "ICMP ping" "WARN" "no reply (normal: router may drop ICMP)" }
} catch {
    Add-Result "ICMP ping" "WARN" $_.Exception.Message
}

# ------------------------------------------------- 2. TCP port reachable
foreach ($p in @($NativePort, $WebPort)) {
    $ok = Test-NetConnection -ComputerName $DishIp -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($ok) { Add-Result "TCP port $p" "PASS" "" }
    else     { Add-Result "TCP port $p" "FAIL" "refused or filtered" }
}

# --------------------------------------------- 3. IPv4 vs IPv6 resolution
try {
    $v4 = Resolve-DnsName -Name "example.com" -Type A -ErrorAction SilentlyContinue
    $v6 = Resolve-DnsName -Name "example.com" -Type AAAA -ErrorAction SilentlyContinue
    if ($v4) { Add-Result "example.com A record" "PASS" "" } else { Add-Result "example.com A record" "FAIL" "no A record" }
    if ($v6) {
        Add-Result "example.com AAAA record" "WARN" "IPv6 exists - traceroute must use -4"
    } else {
        Add-Result "example.com AAAA record" "PASS" "no IPv6 (tracert -4 not strictly needed)"
    }
} catch {
    Add-Result "example.com DNS" "FAIL" $_.Exception.Message
}

# ------------------------------------------------ 4. tracert with and without -4
Write-Host ""
Write-Host "Running tracert (this can take 10-30 seconds each)..." -ForegroundColor Gray
try {
    $o1 = & tracert -h 8 -w 1000 -d example.com 2>&1 | Out-String
    $hasHop = ($o1 -split "`n" | Where-Object { $_ -match '^\s*\d+\s' }).Count -gt 0
    if ($hasHop) {
        Add-Result "tracert (default)" "PASS" ""
    } else {
        $first = ($o1 -split "`n" | Where-Object { $_.Trim() -ne "" } | Select-Object -First 1)
        Add-Result "tracert (default)" "FAIL" $first.Trim()
    }
} catch {
    Add-Result "tracert (default)" "FAIL" $_.Exception.Message
}

try {
    $o2 = & tracert -4 -h 8 -w 1000 -d example.com 2>&1 | Out-String
    $hasHop2 = ($o2 -split "`n" | Where-Object { $_ -match '^\s*\d+\s' }).Count -gt 0
    if ($hasHop2) {
        Add-Result "tracert -4" "PASS" ""
    } else {
        $first2 = ($o2 -split "`n" | Where-Object { $_.Trim() -ne "" } | Select-Object -First 1)
        Add-Result "tracert -4" "FAIL" $first2.Trim()
    }
} catch {
    Add-Result "tracert -4" "FAIL" $_.Exception.Message
}

# ---------------------------------------- 5. IPv4 route to the dish (critical)
Write-Host ""
try {
    $routes = Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue |
              Where-Object { $_.DestinationPrefix -eq "0.0.0.0/0" } |
              Sort-Object { $_.RouteMetric }
    if ($routes) {
        $gw = $routes[0].NextHop
        Add-Result "default IPv4 gateway" "PASS" $gw
    } else {
        Add-Result "default IPv4 gateway" "WARN" "not found (run as admin?)"
    }
} catch {
    Add-Result "default IPv4 gateway" "WARN" $_.Exception.Message
}

# --------------------------- 6. IPv6 present? (affects tracert behaviour)
try {
    $v6if = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue |
             Where-Object { $_.IPAddress -notlike "fe80*" -and $_.IPAddress -ne "::1" }
    if ($v6if) {
        Add-Result "IPv6 on this host" "WARN" ($v6if | ForEach-Object { $_.IPAddress }) -join ","
    } else {
        Add-Result "IPv6 on this host" "PASS" "none"
    }
} catch {
    Add-Result "IPv6 on this host" "WARN" $_.Exception.Message
}

# --------------------------------------------------- 7. app log location
$logDir = Join-Path $env:APPDATA "DishyWarden\logs"
if (Test-Path $logDir) {
    $latest = Get-ChildItem -Path $logDir -Filter "dishywarden-*.log" -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latest) {
        Add-Result "app log found" "PASS" $latest.FullName
        Write-Host ""
        Write-Host "---- last 40 collector / grpc lines ----" -ForegroundColor Cyan
        Get-Content -Path $latest.FullName -Encoding UTF8 -Tail 400 -ErrorAction SilentlyContinue |
        # (non-ASCII removed for PowerShell 5.1 ANSI compatibility)
            Select-Object -Last 40 | ForEach-Object { Write-Host $_.Line }
    } else {
        Add-Result "app log found" "WARN" "dir exists but no log file yet"
    }
} else {
    Add-Result "app log found" "WARN" "no log dir: $logDir"
}

# ------------------------------------------------------------- summary
Write-Host ""
Write-Host "==================== SUMMARY ====================" -ForegroundColor Cyan
$script:Results | ForEach-Object {
    $c = switch ($_.Status) {
        "PASS" { "Green" }; "FAIL" { "Red" }; "WARN" { "Yellow" }; default { "Gray" }
    }
    Write-Host ("{0,-34} {1,-5} {2}" -f $_.Check, $_.Status, $_.Detail) -ForegroundColor $c
}
$fail = @($script:Results | Where-Object { $_.Status -eq "FAIL" }).Count
$warn = @($script:Results | Where-Object { $_.Status -eq "WARN" }).Count
Write-Host ""
Write-Host ("FAILED: {0}   WARN: {1}   TOTAL: {2}" -f $fail, $warn, $script:Results.Count) -ForegroundColor Cyan
Write-Host ""
Write-Host "Copy this whole output back to the developer." -ForegroundColor Cyan
