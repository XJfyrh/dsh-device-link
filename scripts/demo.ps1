# 启动本机第二个 DSH 实例（演示「设备连接」用），自动挑选空闲端口，退出时清理整个子进程树。
#
#   .\scripts\demo.ps1                 # 自动选端口
#   .\scripts\demo.ps1 -Port 30991     # 指定端口
#   .\scripts\demo.ps1 -Profile dl-a -TestHome E:\dsh-device-link.test-home
#
# 为什么要这个脚本：直接 `dsh --profile dl-a --port 30991` 被 Ctrl+C / 关掉终端时，
# 外层 shim 退出但 node 子进程可能残留，再启动就会 EADDRINUSE。这里用 taskkill /T 兜底。

[CmdletBinding()]
param(
  [int]$Port = 0,
  [string]$Profile = 'dl-a',
  [string]$TestHome = 'E:\dsh-device-link.test-home',
  [string]$DshCmd = 'C:\Users\12898\AppData\Local\npm\dsh.cmd',
  [int]$BootTimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

function Test-PortFree([int]$candidate) {
  $connection = Get-NetTCPConnection -LocalPort $candidate -State Listen -ErrorAction SilentlyContinue
  return -not $connection
}

function Stop-Tree([int]$processId) {
  if (-not $processId) { return }
  try { & taskkill.exe /PID $processId /T /F 2>&1 | Out-Null } catch { }
}

if (-not (Test-Path $TestHome)) {
  throw "测试 DSH_HOME 不存在：$TestHome（应包含 profiles\$Profile）"
}
if (-not (Test-Path (Join-Path $TestHome "profiles\$Profile"))) {
  throw "profile 不存在：$TestHome\profiles\$Profile"
}

if ($Port -le 0) {
  do { $Port = Get-FreeLoopbackPort } while (-not (Test-PortFree $Port))
} elseif (-not (Test-PortFree $Port)) {
  throw "端口 $Port 已被占用；用 -Port 0 自动挑选，或先清理占用进程。"
}

$env:DSH_HOME = $TestHome
$logFile = Join-Path $env:TEMP "dsh-device-link-demo-$Port.log"
if (Test-Path $logFile) { Remove-Item $logFile -Force }

Write-Host "[demo] DSH_HOME=$TestHome  profile=$Profile  port=$Port" -ForegroundColor Cyan
Write-Host "[demo] 启动第二个实例…（Ctrl+C 退出，会自动清理子进程）" -ForegroundColor Cyan

$process = Start-Process -FilePath $DshCmd `
  -ArgumentList '--profile', $Profile, '--port', "$Port", '--no-open' `
  -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"

try {
  $deadline = (Get-Date).AddSeconds($BootTimeoutSeconds)
  $url = $null
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 400
    if (-not (Test-Path $logFile)) { continue }
    $match = Select-String -Path $logFile -Pattern 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($match) { $url = $match.Matches[0].Value; break }
  }

  if (-not $url) {
    $err = if (Test-Path "$logFile.err") { Get-Content "$logFile.err" -Raw } else { '' }
    throw "实例没有在 ${BootTimeoutSeconds}s 内打印访问地址。`n$err"
  }

  $deviceLinkPort = 30990
  Write-Host ""
  Write-Host "[demo] 第二个实例已就绪：" -ForegroundColor Green
  Write-Host "  界面   : $url"
  Write-Host "  设备端 : http://127.0.0.1:$deviceLinkPort/dl/info"
  Write-Host ""
  Write-Host "接下来：" -ForegroundColor Yellow
  Write-Host "  1) 浏览器打开上面的【界面】地址，在聊天框输入 /device allow，拿到 8 位配对码"
  Write-Host "  2) 回到本机 DSH 聊天框： /device pair 127.0.0.1:$deviceLinkPort <配对码>"
  Write-Host "  3) /device list  →  /device open <设备名>  打开对端界面"
  Write-Host ""
  Write-Host "[demo] 按 Ctrl+C 结束（会同时结束 gui:$Port 与 device-link 子进程）" -ForegroundColor Cyan

  Wait-Process -Id $process.Id
}
finally {
  Write-Host "[demo] 正在清理：" -ForegroundColor DarkYellow
  Stop-Tree $process.Id
  Start-Sleep -Milliseconds 600
  foreach ($candidate in @($Port, 30990)) {
    $still = Get-NetTCPConnection -LocalPort $candidate -State Listen -ErrorAction SilentlyContinue
    if ($still) {
      foreach ($owner in ($still | Select-Object -ExpandProperty OwningProcess -Unique)) {
        Write-Host "[demo] 端口 $candidate 仍被 PID $owner 占用，强制结束" -ForegroundColor DarkYellow
        Stop-Tree $owner
      }
    }
  }
  Write-Host "[demo] 已退出。" -ForegroundColor DarkYellow
}
