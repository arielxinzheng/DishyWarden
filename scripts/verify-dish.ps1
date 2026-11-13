# verify-dish.ps1 -- verify the Starlink dish gRPC endpoint (192.168.100.1:9200) on Windows.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\verify-dish.ps1
#   powershell -ExecutionPolicy Bypass -File .\verify-dish.ps1 -DishIp 192.168.100.1 -DishPort 9200
#
# KEY IDEA: "TCP connect succeeded" is NOT proof. A TUN-mode proxy (Clash/Surge/Clash Verge/
# V2Ray), a VPN, or an AV web-shield can accept connections to ANY address and port.
# So this script also probes a CONTROL PORT and an HTTP/2 (h2c) response:
#   - control port also "open"  -> proxy/tunnel is faking reachability  => verdict INVALID
#   - h2c answers with a status -> real gRPC endpoint present           => verdict VALID
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI.

param(
    [string]$DishIp   = '192.168.100.1',
    [int]   $DishPort = 9200,
    [string]$RouterIp = '192.168.1.1',
    [int]   $ControlPort = 45999,
    [switch]$NoPause,
    [string]$ReportPath = ''
)

$ErrorActionPreference = 'Continue'
$notes = @()
$proxyFake = $false

Write-Output '=============================================================='
Write-Output ' Dish endpoint verification (Starlink gRPC)'
Write-Output ' The window stays open until you press Enter.'
Write-Output ' A copy of this report is saved next to the script.'
Write-Output '=============================================================='

# Keep a copy on disk: "Open with -> PowerShell" opens a transient console that
# closes the moment the script ends, so console-only output would be lost.
if (-not $ReportPath) {
    $dir = if ($PSScriptRoot) { $PSScriptRoot } else { $env:TEMP }
    $ReportPath = Join-Path $dir ('verify-dish-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
}
try { Start-Transcript -Path $ReportPath -Force | Out-Null } catch { $ReportPath = '' }

function Section($t) { Write-Output ''; Write-Output ("== " + $t + " ==") }

Section '0) proxy / VPN check (this is the #1 source of false positives)'
$winhttpOut = (netsh winhttp show proxy 2>$null | Out-String)
$m = [regex]::Match($winhttpOut, '([A-Za-z0-9\.\-]+):(\d{2,5})')
if ($m.Success) { Write-Output ('WinHTTP proxy: ' + $m.Value); $notes += 'winhttp-proxy' }
else { Write-Output 'WinHTTP proxy: none (direct)' }
try {
    $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
    Write-Output ('IE/WinINET ProxyEnable=' + $ie.ProxyEnable + ' ProxyServer=' + $ie.ProxyServer)
} catch { Write-Output 'IE/WinINET proxy settings not readable' }
$procs = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match 'clash|mihomo|verge|v2ray|sing-box|surge|netch|wireguard|openvpn|tap|wintun|ss-local|shadowsocks|qv2ray|xray|nekoray' }
if ($procs) {
    Write-Output ('proxy/VPN-like processes: ' + (($procs | Select-Object -ExpandProperty ProcessName -Unique) -join ', '))
    $notes += 'proxy-process'
}
$tun = Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceDescription -match 'TAP|TUN|Wintun|WireGuard|VPN' -or $_.Name -match 'Clash|Mihomo|TUN|VPN' }
if ($tun) {
    Write-Output ('tunnel-like adapters: ' + (($tun | Select-Object -ExpandProperty Name) -join ', '))
    $notes += 'tun-adapter'
}

Section '1) local IPv4 addresses'
$v4 = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object IPAddress, PrefixLength, InterfaceAlias
Write-Output ($v4 | Format-Table -AutoSize | Out-String).Trim()
$onDishSubnet = $v4 | Where-Object { $_.IPAddress -like '192.168.100.*' }
Write-Output ('on 192.168.100.0/24: ' + [bool]$onDishSubnet)

Section ("2) ping " + $DishIp + "  (informational only; dish may ignore ICMP)")
$pingOk = Test-Connection -ComputerName $DishIp -Count 2 -Quiet -ErrorAction SilentlyContinue
Write-Output ('ping ok: ' + $pingOk)

Section ("3) TCP " + $DishIp + ":" + $DishPort)
$tcp = $null
try { $tcp = Test-NetConnection -ComputerName $DishIp -Port $DishPort -WarningAction SilentlyContinue } catch {}
if ($tcp) {
    Write-Output ('TcpTestSucceeded : ' + $tcp.TcpTestSucceeded)
} else { Write-Output 'TCP test failed to run' }

Section ("3b) CONTROL PORT " + $DishIp + ":" + $ControlPort + "  <-- false-positive detector")
Write-Output 'A real host must REFUSE an unused port. If this also "succeeds",'
Write-Output 'the path is a proxy/tunnel accepting everything => section 3 is meaningless.'
$ctl = $null
try { $ctl = Test-NetConnection -ComputerName $DishIp -Port $ControlPort -WarningAction SilentlyContinue } catch {}
if ($ctl -and $ctl.TcpTestSucceeded) {
    Write-Output 'CONTROL PORT ALSO OPEN  => PROXY/TUNNEL INTERCEPTION DETECTED'
    Write-Output 'Fix: quit the proxy client, or use its direct/skip-proxy rules for 192.168.100.0/24,'
    Write-Output '     then re-run this script. Until this control port is refused, nothing else counts.'
    $proxyFake = $true
} else {
    Write-Output 'control port refused (expected) => TCP result in section 3 can be trusted'
}

Section '4) HTTP/2 (h2c) handshake on the gRPC port  <-- protocol-level proof'
Write-Output 'Send the HTTP/2 connection preface and look for a SETTINGS frame (type 0x04).'
Write-Output 'A real gRPC server replies with SETTINGS; a proxy/fake either stays silent or resets.'
function Test-H2C([string]$TargetIp, [int]$TargetPort, [int]$TimeoutMs = 3500) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($TargetIp, $TargetPort, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(2500)) { return 'connect-timeout' }
        $client.EndConnect($iar)
        $stream = $client.GetStream()
        $preface = [Text.Encoding]::ASCII.GetBytes("PRI * HTTP/2.0`r`n`r`nSM`r`n`r`n")
        $stream.Write($preface, 0, $preface.Length)
        $stream.Flush()
        $stream.ReadTimeout = $TimeoutMs
        $buf = New-Object byte[] 64
        $n = $stream.Read($buf, 0, 64)
        if ($n -le 0) { return 'no-response (0 bytes)' }
        $frameType = $buf[3]
        $len = ($buf[0] * 65536) + ($buf[1] * 256) + $buf[2]
        if ($frameType -eq 4) { return ('h2c-ok (SETTINGS frame, len=' + $len + ')') }
        return ('responded but not SETTINGS (type=0x' + $frameType.ToString('x2') + ', len=' + $len + ')')
    } catch {
        # exception text is localized (GBK/CP936 on zh-CN Windows) -> keep it ASCII
        return 'no-response (timeout / reset / connection closed)'
    } finally {
        try { $client.Close() } catch {}
    }
}
$h2c = Test-H2C $DishIp $DishPort
Write-Output ('h2c probe => ' + $h2c)
if ($h2c -like 'h2c-ok*') { $notes += 'h2c-ok' }

Section '5) ARP / L2 presence'
$arp = arp -a $DishIp 2>$null | Select-String ([regex]::Escape($DishIp) + '\s+([0-9a-f-]{11,17})')
if ($arp) { Write-Output ($arp -join "`n") } else { Write-Output 'no ARP entry (target is not on the same L2 segment)' }

Section '6) route to target'
$rt = route print -4 2>$null | Select-String '192\.168\.100'
if ($rt) { Write-Output ($rt -join "`n") } else { Write-Output 'no explicit route for 192.168.100.0/24 (falls back to default gateway)' }

Section '7) router (LAN gateway) sanity'
Write-Output ('router ' + $RouterIp + ':80 reachable = ' + [bool](Test-NetConnection -ComputerName $RouterIp -Port 80 -WarningAction SilentlyContinue).TcpTestSucceeded)

Section 'VERDICT'
if ($proxyFake) {
    Write-Output 'INVALID: proxy/tunnel is intercepting the traffic. Fix that first.'
} elseif ($tcp -and $tcp.TcpTestSucceeded -and ($notes -contains 'h2c-ok') -and -not ($ctl -and $ctl.TcpTestSucceeded)) {
    Write-Output 'VALID: dish gRPC endpoint looks real (TCP open + HTTP/2 answers).'
    Write-Output ("        In DishyWarden settings set device address = " + $DishIp + ", port = " + $DishPort)
} elseif ($tcp -and $tcp.TcpTestSucceeded) {
    Write-Output 'SUSPICIOUS: TCP open but no HTTP/2 SETTINGS answer. Either a proxy, or a'
    Write-Output '            non-gRPC service on that port. Confirm with the app itself (last note).'
} else {
    Write-Output 'NOT REACHABLE: wrong subnet (see topology note), firewall/AV block, or device down.'
}

Write-Output ''
Write-Output 'TOPOLOGY NOTE (Starlink defaults)'
Write-Output '  dish gRPC  : 192.168.100.1:9200   (internal link, 192.168.100.0/24)'
Write-Output '  router LAN : 192.168.1.1          (Starlink Gen2/Gen3 default gateway)'
Write-Output '  Behind the Starlink router (192.168.1.x) the dish IP is usually NOT routable.'
Write-Output '  Reach it by: direct connection to the dish (PoE injector), bypass mode,'
Write-Output '  or a static route via your own router WAN (many routers drop it).'
Write-Output ''
Write-Output 'STRONGEST CHECK: skip this script and let the app testify --'
Write-Output '  "C:\Program Files\DishyWarden\DishyWarden.exe" --enable-logging'
Write-Output '  success looks like: [Collector] ... and the dashboard showing telemetry,'
Write-Output '  failure logs: "Dish collect failed: ... ECONNREFUSED 127.0.0.1:9200" (still the mock address)'
Write-Output '                or "14 UNAVAILABLE ... 192.168.100.1:9200"'

if ($ReportPath) {
    try { Stop-Transcript | Out-Null } catch {}
    Write-Output ''
    Write-Output ('report saved to: ' + $ReportPath)
}

if (-not $NoPause) {
    Write-Output ''
    try { [void](Read-Host 'Press Enter to close this window') } catch {}
}
