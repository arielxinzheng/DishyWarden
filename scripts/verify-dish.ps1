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
    [int]   $WebPort = 9201,
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

# grpc-web unary probe: POST /SpaceX.API.Device.Device/Handle
# body = 0x00 flag + 4-byte big-endian length + protobuf payload ({id:1} => 08 01)
function Test-GrpcWeb($Ip, $Port, $TimeoutSec = 5, $FieldNumber = 0) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($Ip, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutSec * 1000)) {
            $client.Close()
            return 'timeout (port not answering)'
        }
        $client.EndConnect($iar)
        $stream = $client.GetStream()
        $stream.ReadTimeout = $TimeoutSec * 1000
        $stream.WriteTimeout = $TimeoutSec * 1000

        # payload = {id:1} + optional branch field (fieldNumber<<3|2, length 0)
        # fieldNumber 0 => id only (empty request, dish usually answers UNIMPLEMENTED=12)
        $payload = [System.Collections.Generic.List[byte]]::new()
        $payload.AddRange([byte[]](0x08, 0x01))
        if ($FieldNumber -gt 0) {
            $tag = [UInt32](($FieldNumber -shl 3) -bor 2)
            $tagBytes = [System.Collections.Generic.List[byte]]::new()
            while ($tag -gt 0x7f) {
                $tagBytes.Add([byte](($tag -band 0x7f) -bor 0x80))
                $tag = $tag -shr 7
            }
            $tagBytes.Add([byte]$tag)
            $payload.AddRange($tagBytes.ToArray())
            $payload.Add(0x00)
        }
        $payload = $payload.ToArray()
        $lenBytes = [System.BitConverter]::GetBytes([UInt32]$payload.Length)
        [Array]::Reverse($lenBytes)
        $frame = New-Object byte[] (5 + $payload.Length)
        $frame[0] = 0x00
        [Array]::Copy($lenBytes, 0, $frame, 1, 4)
        [Array]::Copy($payload, 0, $frame, 5, $payload.Length)

        $head = "POST /SpaceX.API.Device.Device/Handle HTTP/1.1`r`n" +
                "Host: $Ip`:$Port`r`n" +
                "Content-Type: application/grpc-web+proto`r`n" +
                "Accept: application/grpc-web+proto`r`n" +
                "X-Grpc-Web: 1`r`n" +
                "TE: trailers`r`n" +
                "Content-Length: $($frame.Length)`r`n" +
                "Connection: close`r`n`r`n"
        $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
        $stream.Write($headBytes, 0, $headBytes.Length)
        $stream.Write($frame, 0, $frame.Length)
        $stream.Flush()

        # Read the WHOLE response: grpc-status lives in the trailers frame
        # (flag 0x80), which usually comes AFTER the message frame.
        # A single Read() often misses it.
        # 256 KB: the biggest real response is the obstruction map
        # (60803 B measured on the user's dish) plus the history response
        # (22446 B). A 64 KB buffer leaves too little room for the trailers
        # frame, and an 8 KB buffer truncated the response outright.
        $buf = New-Object byte[] 262144
        $total = 0
        while ($true) {
            $n = $stream.Read($buf, $total, $buf.Length - $total)
            if ($n -le 0) { break }
            $total += $n
            if ($total -ge $buf.Length) { break }
        }
        $client.Close()
        if ($total -le 0) { return 'no-response (connection opened but nothing came back)' }
        $text = [System.Text.Encoding]::ASCII.GetString($buf, 0, $total)
        $http = ''
        if ($text -match 'HTTP/1\.[01] (\d+)') { $http = $Matches[1] }
        $gs = ''
        if ($text -match 'grpc-status:\s*(\d+)') { $gs = $Matches[1] }
        $gm = ''
        if ($text -match 'grpc-message:\s*([^\r\n]+)') { $gm = $Matches[1] }
        $trunc = ''
        if ($total -ge $buf.Length) {
            $trunc = ' TRUNCATED(response bigger than 256KB, trailers not read)'
        } elseif ($gs -eq '' -and $http -eq '200') {
            $trunc = ' NO-GRPC-STATUS(trailers not found)'
        }
        return ("http=$http grpc-status=$gs msg=$gm bytes=$total" + $trunc)
    } catch {
        $client.Close()
        return ('error: ' + $_.Exception.Message)
    }
}

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

Section ("3c) TCP " + $DishIp + ":" + $WebPort + "  (grpc-web port, the app's fallback path)")
Write-Output 'The dish serves TWO protocols: 9200 = native gRPC (HTTP/2, reflection),'
Write-Output '9201 = grpc-web (HTTP/1.1). The app falls back to 9201 when 9200 refuses'
Write-Output 'or answers UNIMPLEMENTED, so check this port too.'
$webTcp = $null
try { $webTcp = Test-NetConnection -ComputerName $DishIp -Port $WebPort -WarningAction SilentlyContinue } catch {}
if ($webTcp) {
    Write-Output ('TcpTestSucceeded : ' + $webTcp.TcpTestSucceeded)
} else { Write-Output 'TCP test failed to run' }

Section ("3d) grpc-web probe on " + $DishIp + ":" + $WebPort)
Write-Output 'Send a grpc-web POST (1-byte flag 0x00 + 4-byte length + payload) and'
Write-Output 'look for an HTTP status line and/or grpc-status.'
Write-Output 'An empty request (no branch field) normally answers UNIMPLEMENTED (12).'
Write-Output 'That means the endpoint is alive but the branch field is missing or misnamed.'
Write-Output 'So we then try the known branch field numbers one by one:'
Write-Output '  1004 get_status | 1007 get_history | 2006 dish_get_history |'
Write-Output '  2008 dish_get_obstruction_map | 1008 get_device_info'
Write-Output ''
$branchResults = @()
Write-Output ('  empty request          => ' + (Test-GrpcWeb -Ip $DishIp -Port $WebPort -TimeoutSec 6))
foreach ($fn in 1004, 1007, 2006, 2008, 1008) {
    $r = Test-GrpcWeb -Ip $DishIp -Port $WebPort -TimeoutSec 6 -FieldNumber $fn
    Write-Output ('  branch field ' + $fn + '       => ' + $r)
    $branchResults += [pscustomobject]@{ field = $fn; result = $r }
}
$working = $branchResults | Where-Object { $_.result -match 'grpc-status=0(\s|$)' }
if ($working) {
    Write-Output ''
    Write-Output ('  ==> WORKING BRANCHES: ' + (($working | ForEach-Object { $_.field }) -join ', '))
    Write-Output '      The app already tries getHistory then dishGetHistory; if one of the'
    Write-Output '      above is 1007 or 2006, the app should pick it up automatically.'
} else {
    Write-Output ''
    $unimpl = $branchResults | Where-Object { $_.result -match 'grpc-status=12' }
    $other = $branchResults | Where-Object { $_.result -notmatch 'grpc-status=12' -and $_.result -notmatch 'grpc-status=0' }
    Write-Output '  ==> no branch returned grpc-status=0'
    if ($unimpl) {
        Write-Output ('      UNIMPLEMENTED (branch absent on this firmware): ' +
            (($unimpl | ForEach-Object { $_.field }) -join ', '))
    }
    if ($other) {
        Write-Output ('      answered but no grpc-status seen: ' +
            (($other | ForEach-Object { $_.field }) -join ', '))
        Write-Output '      -> these DID return a body. If the line says TRUNCATED,'
        Write-Output '         the response was bigger than the 64 KB buffer, so the'
        Write-Output '         trailers frame was never read => the branch is probably FINE.'
    }
}

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

Write-Output 'NOTE: this script does NOT verify the gRPC reflection service.'
Write-Output '      Reflection is what lets the app decode responses; run'
Write-Output '      DishyWarden.exe --dump-dish-api and look for'
Write-Output '      "[DishGrpc] reflection success" (port 9200).'
Write-Output ''
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
Write-Output '  failure logs: "Dish collect failed: ... ECONNREFUSED 127.0.0.1:9200" (config still points at the mock address)'
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
