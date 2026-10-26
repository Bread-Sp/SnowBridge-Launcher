# SnowBridge Launcher 托盘宿主
# 作用：让「关掉窗口」变成「收进托盘」，真正结束进程要走托盘菜单的「退出」。
# 说明：界面是 Edge 的应用窗口，系统不给外部程序拦截它的关闭按钮，所以这里的语义是——
#   窗口被关掉 → 进程本来就没死（服务是独立进程），托盘继续留着并弹一条提示；
#   托盘右键 →「退出」→ 停掉两个服务、关掉服务端、图标消失，这才算结束。
# 双击托盘图标：窗口还在就把它叫到最前面（只置顶 400ms，不做永久置顶），不在才新开一个。
param(
  [switch]$NoWindow   # 只挂托盘，不主动弹窗口（后台自启时用）
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Title = 'SnowBridge Launcher'
$script:Version = '0.0.1'
$script:Here = $PSScriptRoot
$script:DataDir = Join-Path $env:LOCALAPPDATA 'QQbot'
$script:LogFile = Join-Path $script:DataDir 'tray.log'
$script:Port = 3220
$script:WindowOpen = $false
$script:BackgroundTipShown = $false   # 每次启动只提示一次「已转入后台」
$script:ServerAlive = $false
$script:ServerDownTicks = 0
$script:LastServerStart = (Get-Date).AddMinutes(-10)

function LogMsg([string]$m) {
  try {
    if (-not (Test-Path $script:DataDir)) { New-Item -ItemType Directory -Path $script:DataDir -Force | Out-Null }
    Add-Content -LiteralPath $script:LogFile -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) -Encoding UTF8
  } catch { }
}

# ── 单实例：已经有托盘在跑，就让它把窗口叫出来（便携版/安装版同时双击也不打架）────
$mutex = New-Object System.Threading.Mutex($false, 'Local\QQbotLauncherTray')
if (-not $mutex.WaitOne(0)) {
  # 设置了「启动时最小化到系统栏」：第二实例只是挂托盘，不弹窗口。
  if ($NoWindow) { exit 0 }
  try {
    # 不去自己开窗口：留个请求文件，由已在跑的那个托盘走「置顶」逻辑，
    # 这样第二次双击的结果和「双击托盘图标」完全一致（置顶一下，不会多开窗口）。
    $req = Join-Path (Join-Path $env:LOCALAPPDATA 'QQbot') 'show.request'
    $dir = Split-Path $req -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Set-Content -LiteralPath $req -Value ([DateTime]::Now.ToString('o')) -Encoding ASCII
    Start-Sleep -Milliseconds 900
  } catch { }
  exit 0
}

function Get-NodeExe {
  $candidates = @('E:\Node\node.exe', (Join-Path ${env:ProgramFiles} 'nodejs\node.exe'))
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$script:NodeExe = Get-NodeExe

function Read-PortFile {
  try {
    $p = [int](Get-Content (Join-Path $script:DataDir 'launcher.port') -Raw -ErrorAction Stop).Trim()
    if ($p -gt 0) { return $p }
  } catch { }
  return 3220
}

function Test-Launcher([int]$port) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/ping" -TimeoutSec 1 -ErrorAction Stop
    return ($r.name -eq 'qqbot-launcher')
  } catch { return $false }
}

function Find-LauncherPort {
  $p = Read-PortFile
  if (Test-Launcher $p) { return $p }
  for ($i = 0; $i -lt 12; $i++) {
    $candidate = 3220 + $i
    if ($candidate -eq $p) { continue }
    if (Test-Launcher $candidate) { return $candidate }
  }
  return 0
}

function Get-State {
  # 注意：/api/state 会顺带做外部实例探测（PowerShell 扫进程），慢的时候要 2 秒多。
  # 超时给短了会被误判成「服务端挂了」，然后每 3 秒重复拉起一个多余的 server.mjs。
  if (-not $script:Port) { return $null }
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$($script:Port)/api/state" -TimeoutSec 8 -ErrorAction Stop }
  catch { return $null }
}

function Get-Ping {
  # 轻量存活探测：只问「服务端还在不在」，不走外部实例探测。
  if (-not $script:Port) { return $null }
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$($script:Port)/api/ping" -TimeoutSec 2 -ErrorAction Stop }
  catch { return $null }
}

# ── 非阻塞状态读取 ─────────────────────────────────────────────────────────
# /api/state 要 2 秒多（服务端会顺带做外部实例探测）。在托盘的 UI 线程里同步调用，
# 右键菜单就会「点了没反应、退出卡住」。这里改成 WebClient 异步任务在后台取，
# Timer 每次只读一下结果，菜单和退出永远不被 HTTP 请求堵住。
$script:StateTask = $null
$script:StateCache = $null
$script:StateCacheAt = [DateTime]::MinValue
$script:StateFetchAt = [DateTime]::MinValue
$script:StateTheme = $null
$script:ThemeSig = ''

function Start-StateFetch {
  if ($script:StateTask -and -not $script:StateTask.IsCompleted) { return }
  if (-not $script:Port) { return }
  try {
    $wc = New-Object System.Net.WebClient
    $wc.Headers['Accept'] = 'application/json'
    $script:StateTask = $wc.DownloadStringTaskAsync("http://127.0.0.1:$($script:Port)/api/state")
    $script:StateFetchAt = Get-Date
  } catch { $script:StateTask = $null }
}

function Apply-TrayTheme {
  $theme = $script:StateTheme
  if (-not $theme -or -not $script:Menu) { return }
  $sig = [string]$theme.sig
  if ($sig -and $script:ThemeSig -eq $sig) { return }
  $script:ThemeSig = $sig
  try {
    $script:Menu.SetTheme([string]$theme.bg, [string]$theme.text, [string]$theme.muted, [string]$theme.line, [string]$theme.hover, [string]$theme.danger)
    LogMsg ("菜单主题已更新：{0}" -f $sig)
  } catch { LogMsg "菜单主题应用失败：$($_.Exception.Message)" }
}

function Poll-StateFetch {
  $task = $script:StateTask
  if (-not $task) { return }
  if (-not $task.IsCompleted) {
    # 服务端忙/假死时任务可能永远不回来：超过 12 秒就丢掉，免得缓存永远不过期、托盘一直以为它活着。
    if (((Get-Date) - $script:StateFetchAt).TotalSeconds -gt 12) {
      $script:StateTask = $null
      LogMsg '状态读取超时（丢弃本次请求）'
    }
    return
  }
  try {
    if ($task.Status -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) {
      $script:StateCache = ($task.Result | ConvertFrom-Json)
      $script:StateCacheAt = Get-Date
      $script:StateTheme = $script:StateCache.theme
    }
  } catch { }
  $script:StateTask = $null
}

# ── 窗口辅助（查找/聚焦/关闭）与自绘菜单都在 winhelp 里，避免两套实现 ──────
# 有预编译的 winhelp.dll（构建时 csc 生成）就直接加载，省掉每次启动 0.5 秒的现场编译；
# 没有 dll 时退回编译 winhelp.cs（开发/便携场景）。
if (-not ('SnowBridge.Native' -as [type])) {
  $dll = Join-Path $script:Here 'winhelp.dll'
  if (Test-Path $dll) {
    try { [void][System.Reflection.Assembly]::LoadFrom($dll) } catch { LogMsg "加载 winhelp.dll 失败，回退编译：$($_.Exception.Message)" }
  }
  if (-not ('SnowBridge.Native' -as [type])) {
    Add-Type -Path (Join-Path $script:Here 'winhelp.cs') -ReferencedAssemblies @('System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll')
  }
}

function Test-WindowOpen {
  try { return [SnowBridge.Native]::Exists($script:Title) } catch { return $false }
}

# 无边框外壳（SnowBridgeHost.exe）在跑时，窗口动画和置前都由宿主自己做：
# 这里只写一个 summon.request 唤醒它，不再用 Win32 直接 ShowWindow（那样没有动画）。
function Test-HostRunning {
  try { return [bool](Get-Process -Name 'SnowBridgeHost', 'SnowBridgeShell' -ErrorAction SilentlyContinue) } catch { return $false }
}

function Request-Summon {
  try {
    $file = Join-Path $script:DataDir 'summon.request'
    [System.IO.File]::WriteAllText($file, [DateTime]::UtcNow.Ticks.ToString())
    return $true
  } catch { return $false }
}

function Start-Window {
  LogMsg 'Start-Window 调用'
  # 有 WebView2 宿主就直接起，省掉 node + launch.mjs 的约 0.4 秒启动；
  # 宿主自己导航到服务端，没装/被删时退回 launch.mjs（Edge 模式）。
  $hostExe = Join-Path $script:Here 'SnowBridgeHost.exe'
  $port = $script:Port
  if (-not $port) { $port = Find-LauncherPort }
  if ((Test-Path $hostExe) -and $port) {
    try {
      $url = "http://127.0.0.1:$port/"
      Start-Process -FilePath $hostExe -ArgumentList @($url) -WorkingDirectory $script:Here -ErrorAction Stop | Out-Null
      return
    } catch {
      LogMsg "直接启动宿主失败，回退 launch.mjs：$($_.Exception.Message)"
    }
  }
  if (-not $script:NodeExe) { LogMsg 'Start-Window: NodeExe 为空'; return }
  Start-Process -FilePath $script:NodeExe -ArgumentList @("`"$(Join-Path $script:Here 'launch.mjs')`"") -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
}

# 拉起本地服务端（3220）。托盘发现服务端没在跑时会自己补一个，
# 免得出现「托盘还在、服务端已经死了」的半死状态。
function Start-Server {
  if (-not $script:NodeExe) { return $false }
  try {
    Start-Process -FilePath $script:NodeExe -ArgumentList @("`"$(Join-Path $script:Here 'server.mjs')`"") -WindowStyle Hidden -WorkingDirectory $script:Here -ErrorAction Stop | Out-Null
    $script:LastServerStart = Get-Date
    LogMsg '服务端未运行，已重新拉起 server.mjs'
    return $true
  } catch {
    LogMsg "拉起服务端失败：$($_.Exception.Message)"
    return $false
  }
}

# 呼出动画：通知已打开的界面播放入场动画（页面收到 summon 事件后自己播）。
# 先发事件再置顶：这样窗口升到前台时动画刚好从头开始；失败也不影响呼出本身。
function Send-SummonEvent {
  $port = $script:Port
  if (-not $port) { $port = Find-LauncherPort }
  if (-not $port) { return }
  try {
    Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/summon" -f $port) -Method Post -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop | Out-Null
  } catch { }
}

# 呼出窗口：宿主进程在就让它播放呼出动画；否则退回「置顶 Edge 窗口 / 开新窗口」
function Show-Or-FocusWindow {
  if (Test-HostRunning) {
    $ok = Request-Summon
    LogMsg "呼出窗口：无边框宿主在跑，已请求呼出动画=$ok"
    return
  }
  if (Test-WindowOpen) {
    Send-SummonEvent
    $ok = $false
    try { $ok = [SnowBridge.Native]::Focus($script:Title) } catch { LogMsg "Focus 失败：$($_.Exception.Message)" }
    LogMsg "呼出窗口：窗口已开，置顶=$ok"
    if (-not $ok) { Start-Window }
  } else {
    LogMsg '呼出窗口：窗口不在，开新窗口'
    Start-Window
  }
}

function Get-ConsoleUrl {
  # 用后台轮询缓存的 state，别在点菜单时同步等 2 秒。
  $state = $script:StateCache
  $port = 3100
  if ($state -and $state.ports -and $state.ports.console) { $port = [int]$state.ports.console }
  # 控制台要带 token：桥接把 token 写在 <bridgeDir>\state\console-token
  $bridgeDir = ''
  try {
    $cfg = Get-Content (Join-Path $script:DataDir 'launcher.json') -Raw | ConvertFrom-Json
    if ($cfg.bridgeDir) { $bridgeDir = $cfg.bridgeDir }
  } catch { }
  $token = ''
  if ($bridgeDir) {
    $tokenFile = Join-Path $bridgeDir 'state\console-token'
    if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
  }
  $url = "http://127.0.0.1:$port/"
  if ($token) { $url += "?token=$token" }
  return $url
}

# ── 托盘图标 ───────────────────────────────────────────────────────────────
$iconPath = Join-Path $script:Here 'icon.ico'
# ── 通知归属：让系统提示的标题写 “SnowBridge Launcher”，而不是 “Windows PowerShell” ──
# 托盘图标的通知是宿主进程（powershell.exe）发的，Windows 默认拿进程名当应用名。
# 显式指定 AppUserModelID，并在 HKCU 注册它的显示名，通知头就归我们自己了。
$script:Aumid = 'SnowBridge.Launcher.Tray'
try {
  # winhelp 里已经带了 AumidHelper（预编译 dll 或编译 cs 时一起进来），没有才现场编译。
  # winhelp 里已经带了 AumidHelper（预编译 dll 或编译 cs 时一起进来），没有才现场编译。
  if (-not ('AumidHelper' -as [type])) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class AumidHelper { [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int SetCurrentProcessExplicitAppUserModelID(string appId); }'
  }
  [void][AumidHelper]::SetCurrentProcessExplicitAppUserModelID($script:Aumid)
  $aumidKey = "HKCU:\Software\Classes\AppUserModelId\$($script:Aumid)"
  if (-not (Test-Path $aumidKey)) { New-Item -Path $aumidKey -Force | Out-Null }
  Set-ItemProperty -Path $aumidKey -Name 'DisplayName' -Value $script:Title -ErrorAction SilentlyContinue
  $aumidIcon = Join-Path $script:Here 'icon.ico'
  if (Test-Path $aumidIcon) { Set-ItemProperty -Path $aumidKey -Name 'IconUri' -Value $aumidIcon -ErrorAction SilentlyContinue }
  New-ItemProperty -Path $aumidKey -Name 'ShowInSettings' -Value 1 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null
} catch {
  LogMsg "通知归属设置失败（不影响使用）：$($_.Exception.Message)"
}

$notify = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $iconPath) {
  $notify.Icon = New-Object System.Drawing.Icon($iconPath)
} else {
  $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Text = "$($script:Title) v$($script:Version)"
$notify.Visible = $true

# ── 自绘菜单 ───────────────────────────────────────────────────────────────
$script:Menu = New-Object SnowBridge.TrayMenu
$script:StatusText = '状态：正在读取…'

$script:Menu.add_Chosen({
  param($sender, $id)
  switch ($id) {
    'open'    { LogMsg '菜单：点打开'; Show-Or-FocusWindow }
    'console' { try { Start-Process (Get-ConsoleUrl) | Out-Null } catch { LogMsg "打开控制台失败：$($_.Exception.Message)" } }
    'quit'    { LogMsg '菜单：点退出'; $script:DoQuit.Invoke() }
  }
})

function Show-TrayMenu {
  try {
    $script:Menu.ClearRows()
    $script:Menu.AddRow('open', '打开主窗口', 'item')
    $script:Menu.AddRow('console', '打开桥接控制台', 'item')
    $script:Menu.AddRow('', '', 'sep')
    $script:Menu.AddRow('', $script:StatusText, 'status')
    $script:Menu.AddRow('', '', 'sep')
    $script:Menu.AddRow('quit', '退出', 'quit')
    Apply-TrayTheme
    $script:Menu.Commit()
    LogMsg '菜单：弹出'
    $pos = [System.Windows.Forms.Cursor]::Position
    $script:Menu.PopupAt($pos)
  } catch {
    LogMsg "菜单弹出失败：$($_.Exception.Message)"
  }
}

$notify.add_MouseUp({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) { Show-TrayMenu }
})
$notify.add_DoubleClick({ Show-Or-FocusWindow })

$script:DoQuit = {
  LogMsg '托盘退出：停止服务并关闭（立即退出，停服务交给后台）'
  $script:Timer.Stop()
  # 先让菜单和图标消失，用户点完「退出」立刻有反馈，不会像卡死。
  try { if ($script:Menu.Visible) { $script:Menu.Hide() } } catch { }
  $notify.Visible = $false
  # 无边框宿主收到 exit.request 会先播 260ms 的淡出，再自己结束进程。
  try { [System.IO.File]::WriteAllText((Join-Path $script:DataDir 'exit.request'), [DateTime]::UtcNow.Ticks.ToString()) } catch { }
  # 记下「正在退出」和这次要退出的服务端 PID：
  # 用户点完退出马上又双击时，入口看到 quitting.flag 会等旧实例退干净；
  # 后台迟到的 /api/quit 带着旧 PID，新服务端会拒绝，不会误杀。
  $serverPid = 0
  try {
    $pidFile = Join-Path $script:DataDir 'launcher.pid'
    if (Test-Path $pidFile) { [void][int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$serverPid) }
    [System.IO.File]::WriteAllText((Join-Path $script:DataDir 'quitting.flag'), "$([DateTime]::UtcNow.Ticks) $serverPid")
  } catch { }
  # 停 SnowLuma/桥接可能要好几秒：交给一个隐藏的后台 powershell 去做（-EncodedCommand 避免引号被拆），
  # 托盘自己马上退出，右键退出不再「卡顿」。
  if ($script:Port) {
    $url = "http://127.0.0.1:$($script:Port)/api/quit"
    $bodyJson = '{"stopAll":true,"pid":' + $serverPid + '}'
    $cmd = "try { Invoke-WebRequest -Uri '$url' -Method Post -Body '$bodyJson' -ContentType 'application/json' -TimeoutSec 120 -UseBasicParsing | Out-Null } catch { }"
    try {
      $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd))
      Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', $enc) -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
    } catch { LogMsg "拉起退出助手失败：$($_.Exception.Message)" }
  }
  # 给宿主留出淡出时间，然后再兜底收掉（正常情况它自己已经退了）。
  Start-Sleep -Milliseconds 420
  try { Get-Process -Name 'SnowBridgeHost', 'SnowBridgeShell' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch { }
  try { $notify.Dispose() } catch { }
  [System.Windows.Forms.Application]::Exit()
}

# ── 定时轮询：更新状态、发现窗口被关掉就提示「已转入后台」 ──────────────────
$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 3000
# 轮询体包成函数：外面加一层计时，轮询里哪一步慢了会在托盘日志里留记录。
function Invoke-TrayTick {
  # 菜单开着的时候不刷新：HTTP 调用会卡住 UI 线程，菜单会变成「点不动、关不掉」。
  try { if ($script:Menu.Visible) { return } } catch { }

  # menu.request：外部想直接弹出托盘菜单时用（自检/脚本触发，正常使用不会出现这个文件）。
  try {
    $menuReq = Join-Path $script:DataDir 'menu.request'
    if (Test-Path $menuReq) {
      Remove-Item $menuReq -Force -ErrorAction SilentlyContinue
      Show-TrayMenu
      return
    }
  } catch { }
  # quit.request：脚本/卸载程序让托盘退出时用（和右键「退出」同一条路径）。
  try {
    $quitReq = Join-Path $script:DataDir 'quit.request'
    if (Test-Path $quitReq) {
      Remove-Item $quitReq -Force -ErrorAction SilentlyContinue
      LogMsg '收到 quit.request，执行退出'
      $script:DoQuit.Invoke()
      return
    }
  } catch { }

  # show.request 由第二实例写入：双击 exe/快捷方式时，由这里统一走「置顶」逻辑。
  try {
    $reqFile = Join-Path $script:DataDir 'show.request'
    if (Test-Path $reqFile) {
      Remove-Item $reqFile -Force -ErrorAction SilentlyContinue
      Show-Or-FocusWindow
    }
  } catch { }

  # 端口只读 launcher.port（毫秒级）。不要在 UI 线程里扫端口：服务端忙的时候每次探测都要等满 1 秒超时，
  # 右键菜单就会跟着「未响应」——这是老版本偶发卡顿的根源。
  $portFromFile = Read-PortFile
  if ($portFromFile) { $script:Port = $portFromFile }
  # 状态在后台取，这里只消费缓存（解析 10KB JSON 是毫秒级）。
  Poll-StateFetch
  $state = $script:StateCache
  Apply-TrayTheme
  $cacheAge = ((Get-Date) - $script:StateCacheAt).TotalSeconds
  if ($script:Port -and ($cacheAge -gt 3 -or -not $state)) { Start-StateFetch }
  # 存活判定只看缓存年龄：既不阻塞 UI 线程，也不会因为一次 2 秒的超时就把菜单卡住。
  $script:ServerAlive = [bool]($state -and $cacheAge -le 15)

  if (-not $script:ServerAlive) {
    $notify.Text = "$($script:Title) v$($script:Version)｜服务端未运行"
    $script:StatusText = '状态：服务端未运行'
    # 连续两次都连不上，且距上次拉起超过 15 秒，就自己补一个服务端
    $script:ServerDownTicks = [int]$script:ServerDownTicks + 1
    $elapsed = ((Get-Date) - $script:LastServerStart).TotalSeconds
    if ($script:ServerDownTicks -ge 2 -and $elapsed -gt 15 -and -not $script:StateTask) {
      $script:ServerDownTicks = 0
      # 不在这里等端口/睡眠：下一次 tick 会重新读取状态，UI 线程一滴都别卡。
      [void](Start-Server)
    }
    return
  }
  $script:ServerDownTicks = 0
  if (-not $state) { $notify.Text = "$($script:Title) v$($script:Version)｜正在读取…"; return }

  $bridge = $state.services.bridge
  $snow = $state.services.snowluma
  $bridgeUp = [bool]($bridge.running -or $bridge.external)
  $snowUp = [bool]($snow.running -or $snow.external)
  $dshUp = [bool]$state.health.dsh.ok
  $bridgeText = if ($bridgeUp) { '桥接 运行中' } else { '桥接 已停止' }
  $snowText = if ($snowUp) { 'SnowLuma 运行中' } else { 'SnowLuma 已停止' }
  $dshText = if ($dshUp) { 'DSH 已连接' } else { 'DSH 未连接' }

  $tip = "$($script:Title) v$($script:Version)｜$snowText｜$bridgeText"
  if ($tip.Length -gt 62) { $tip = $tip.Substring(0, 62) }
  $notify.Text = $tip
  # 菜单里的状态行要短：正常就一行「运行正常」，有异常只列异常项
  $bad = @()
  if (-not $snowUp) { $bad += 'SnowLuma 未运行' }
  if (-not $bridgeUp) { $bad += '桥接 未运行' }
  if (-not $dshUp) { $bad += 'DSH 未连接' }
  $script:StatusText = if ($bad.Count -eq 0) { '运行正常' } else { $bad -join ' · ' }

  $open = Test-WindowOpen
  if ($script:WindowOpen -and -not $open -and -not $script:BackgroundTipShown) {
    # 每次启动只提示这一次；之后再关窗口就安安静静收进托盘。
    $notify.ShowBalloonTip(5000, $script:Title, "转为后台运行。`n图标右键 →「退出」结束进程。", [System.Windows.Forms.ToolTipIcon]::None)
    $script:BackgroundTipShown = $true
  }
  $script:WindowOpen = $open
}

$script:Timer.add_Tick({
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try { Invoke-TrayTick } catch { LogMsg "轮询异常：$($_.Exception.Message)" }
  finally {
    if ($sw.ElapsedMilliseconds -gt 800) { LogMsg ("轮询耗时 {0}ms（UI 线程被占用）" -f $sw.ElapsedMilliseconds) }
  }
})
$script:Timer.Start()

# ── 启动：先把服务端拉起来，再决定要不要弹窗口 ──────────────────────────────
$script:Port = Find-LauncherPort
if (-not $script:Port) {
  if ($script:NodeExe) {
    Start-Process -FilePath $script:NodeExe -ArgumentList @("`"$(Join-Path $script:Here 'server.mjs')`"") -WindowStyle Hidden -WorkingDirectory $script:Here | Out-Null
    for ($i = 0; $i -lt 25; $i++) {
      Start-Sleep -Milliseconds 400
      $script:Port = Find-LauncherPort
      if ($script:Port) { break }
    }
  }
} else {
  # 服务端已经在跑：托盘是「补上」来的，只有用户开了窗口才需要再开
  $script:WindowOpen = Test-WindowOpen
}

LogMsg "启动收尾：Port=$($script:Port) WindowOpen=$(Test-WindowOpen) NodeExe=$($script:NodeExe)"
# 用户双击入口时托盘是「补起来」的：即使窗口已经开着，也要把它叫到前面（宿主在跑就发呼出请求）；
# 只有开机自启（-NoWindow）才安安静静留在托盘里。
if (-not $NoWindow) { Show-Or-FocusWindow }

[System.Windows.Forms.Application]::Run()
