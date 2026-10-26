# SnowBridge Launcher 安装程序
# 图形安装界面；也支持静默安装（自动化/批量部署）：
#   powershell -File install.ps1 -Silent -Dir "D:\SnowBridge Launcher" -NoAutoStart -NoLaunch
#   或 set QQBOT_SILENT=1 后直接跑安装包
param(
  [string]$Dir = '',
  [switch]$Silent,
  [switch]$NoDesktop,
  [switch]$NoAutoStart,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Source = $PSScriptRoot
$script:RegKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SnowBridgeLauncher'
$script:AppFiles = @('server.mjs', 'ui.html', 'launch.mjs', 'tray.ps1', 'winhelp.cs', 'winhelp.dll', 'SnowBridgeHost.exe', 'SnowBridgeHost.cs', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'hidehost.exe', 'hidehost.cs', 'icon.ico', 'icon.png', 'launcher.exe')

function Get-DefaultDir { Join-Path $env:LOCALAPPDATA 'Programs\SnowBridge Launcher' }

function Test-Node {
  foreach ($c in @('E:\Node\node.exe', (Join-Path ${env:ProgramFiles} 'nodejs\node.exe'))) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ''
}

function New-Shortcut {
  param([string]$Path, [string]$Target, [string]$WorkDir, [string]$IconPath, [string]$Description, [string]$Arguments = '')
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($Path)
  if ($Arguments) { $sc.Arguments = $Arguments }
  $sc.TargetPath = $Target
  $sc.WorkingDirectory = $WorkDir
  if ($IconPath) { $sc.IconLocation = $IconPath }
  if ($Description) { $sc.Description = $Description }
  $sc.Save()
}

function Get-UninstallScript {
  # 用普通字符串数组拼，避免 here-string 里大量反引号转义出错
  $parts = @(
    '# 卸载 SnowBridge Launcher：停掉本安装目录的托盘与服务，清理快捷方式/注册表/程序文件。',
    'param([string]$Root = '''')',
    'if (-not $Root) { $Root = Split-Path -Parent $PSCommandPath }',
    '$root = $Root.TrimEnd(''\\'')',
    'Start-Sleep -Milliseconds 1200',
    'try {',
    "  `$pf = Join-Path `$env:LOCALAPPDATA 'QQbot\launcher.port'",
    '  if (Test-Path $pf) {',
    '    $port = (Get-Content $pf -Raw).Trim()',
    "    Invoke-RestMethod -Uri ('http://127.0.0.1:' + `$port + '/api/quit') -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 20 | Out-Null",
    '  }',
    '} catch { }',
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {',
    "  `$_.Name -match '^(node|powershell|wscript)\.exe$' -and `$_.CommandLine -and",
    "  (`$_.CommandLine -match '(?i)\\app\\(server|launch|tray)\\.(mjs|ps1)') -and",
    '  ($_.CommandLine.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)',
    '} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    'Start-Sleep -Milliseconds 400',
    "Remove-Item (Join-Path `$env:USERPROFILE 'Desktop\SnowBridge Launcher.lnk') -Force -ErrorAction SilentlyContinue",
    "Remove-Item (Join-Path `$env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SnowBridge Launcher.lnk') -Force -ErrorAction SilentlyContinue",
    "Remove-Item (Join-Path `$env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\SnowBridge Launcher.lnk') -Force -ErrorAction SilentlyContinue",
    "Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SnowBridgeLauncher' -Recurse -Force -ErrorAction SilentlyContinue",
    "Remove-Item 'HKCU:\Software\Classes\AppUserModelId\SnowBridge.Launcher.Tray' -Recurse -Force -ErrorAction SilentlyContinue",
    'Start-Sleep -Milliseconds 600',
    'try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop } catch { }',
    "try { Remove-Item (Join-Path `$env:TEMP 'qqbot-uninstall.ps1') -Force -ErrorAction SilentlyContinue } catch { }",
    'exit 0'
  )
  return ($parts -join [Environment]::NewLine)
}

function Install-Files {
  param([string]$Target, [bool]$Desktop, [bool]$AutoStart, [scriptblock]$Progress)

  $appDir = Join-Path $Target 'app'
  New-Item -ItemType Directory -Force -Path $appDir | Out-Null

  $i = 0
  foreach ($f in $script:AppFiles) {
    $src = Join-Path $script:Source $f
    if (-not (Test-Path $src)) { throw "安装包缺少文件：$f" }
    Copy-Item $src (Join-Path $appDir $f) -Force
    $i++
    if ($Progress) { & $Progress ([int]($i / ($script:AppFiles.Count + 3) * 100)) "复制 $f" }
  }

  # 启动入口（安装包里叫 launcher-entry.vbs，ZIP 里保持 ASCII，装完是中文名）
  $vbs = Join-Path $script:Source 'launcher-entry.vbs'
  if (-not (Test-Path $vbs)) { $vbs = Join-Path $script:Source 'SnowBridge Launcher.vbs' }
  if (Test-Path $vbs) { Copy-Item $vbs (Join-Path $Target 'SnowBridge Launcher.vbs') -Force }
  $readme = Join-Path $script:Source 'README.md'
  if (Test-Path $readme) { Copy-Item $readme (Join-Path $Target 'README.md') -Force }

  if ($Progress) { & $Progress 80 '写卸载器' }

  $uninstallPs = Join-Path $Target 'uninstall.ps1'
  [System.IO.File]::WriteAllText($uninstallPs, (Get-UninstallScript), (New-Object System.Text.UTF8Encoding($true)))

  $uninstallCmd = Join-Path $Target 'uninstall.cmd'
  $cmdLines = @(
    '@echo off',
    'chcp 65001 >nul',
    'set "HERE=%~dp0"',
    'set "HERE=%HERE:~0,-1%"',
    'copy /y "%HERE%\uninstall.ps1" "%TEMP%\qqbot-uninstall.ps1" >nul',
    'start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\qqbot-uninstall.ps1" -Root "%HERE%"',
    'exit /b 0'
  )
  [System.IO.File]::WriteAllText($uninstallCmd, (($cmdLines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)

  $icon = Join-Path $appDir 'icon.ico'
  $launcherExe = Join-Path $appDir 'launcher.exe'
  # 入口优先用 launcher.exe：带图标、双击直接进托盘，不弹任何控制台
  $entryTarget = if (Test-Path $launcherExe) { $launcherExe } else { Join-Path $env:WINDIR 'System32\wscript.exe' }
  $entryArgs = if (Test-Path $launcherExe) { '' } else { '"' + (Join-Path $appDir 'SnowBridge Launcher.vbs') + '"' }

  $uninstallLnk = Join-Path $Target '卸载 SnowBridge Launcher.lnk'
  $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($uninstallLnk)
  $sc.TargetPath = $uninstallCmd
  $sc.WorkingDirectory = $Target
  $sc.IconLocation = $icon
  $sc.WindowStyle = 7
  $sc.Save()

  $desktopLnk = Join-Path $env:USERPROFILE 'Desktop\SnowBridge Launcher.lnk'
  if ($Desktop) {
    New-Shortcut -Path $desktopLnk -Target $entryTarget -WorkDir $Target -IconPath $icon -Arguments $entryArgs -Description 'SnowBridge Launcher · SnowLuma + qq-bridge 一键启动'
  } else {
    Remove-Item $desktopLnk -Force -ErrorAction SilentlyContinue
  }
  New-Shortcut -Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SnowBridge Launcher.lnk') -Target $entryTarget -WorkDir $Target -IconPath $icon -Arguments $entryArgs -Description 'SnowBridge Launcher'

  $startupLnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\SnowBridge Launcher.lnk'
  if ($AutoStart) {
    New-Shortcut -Path $startupLnk -Target $entryTarget -WorkDir $Target -IconPath $icon -Arguments ($entryArgs + ' -NoWindow') -Description 'SnowBridge Launcher（开机自启，进托盘）'
  } else {
    Remove-Item $startupLnk -Force -ErrorAction SilentlyContinue
  }

  if ($Progress) { & $Progress 92 '写卸载信息' }

  New-Item -Path $script:RegKey -Force | Out-Null
  Set-ItemProperty -Path $script:RegKey -Name 'DisplayName' -Value 'SnowBridge Launcher'
  Set-ItemProperty -Path $script:RegKey -Name 'DisplayVersion' -Value '0.0.1'
  Set-ItemProperty -Path $script:RegKey -Name 'Publisher' -Value 'SnowBridge'
  Set-ItemProperty -Path $script:RegKey -Name 'InstallLocation' -Value $Target
  Set-ItemProperty -Path $script:RegKey -Name 'DisplayIcon' -Value $icon
  Set-ItemProperty -Path $script:RegKey -Name 'UninstallString' -Value ('cmd /c ""' + $uninstallCmd + '""')
  Set-ItemProperty -Path $script:RegKey -Name 'NoModify' -Value 1 -Type DWord
  Set-ItemProperty -Path $script:RegKey -Name 'NoRepair' -Value 1 -Type DWord

  if ($Progress) { & $Progress 100 '完成' }
  return $true
}

function Start-App {
  param([string]$Target)
  $vbs = Join-Path $Target 'SnowBridge Launcher.vbs'
  if (Test-Path $vbs) {
    Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '"')
  }
}

# ── 静默安装 ────────────────────────────────────────────────────────────────
if ($Silent -or $env:QQBOT_SILENT -eq '1') {
  $target = if ($Dir) { $Dir } elseif ($env:QQBOT_INSTALL_DIR) { $env:QQBOT_INSTALL_DIR } else { Get-DefaultDir }
  $desktop = -not $NoDesktop -and $env:QQBOT_NO_SHORTCUT -ne '1'
  $auto = -not $NoAutoStart -and $env:QQBOT_NO_AUTOSTART -ne '1'
  Install-Files -Target $target -Desktop $desktop -AutoStart $auto -Progress { param($p, $msg) Write-Host "[$p%] $msg" } | Out-Null
  Write-Host "installed to $target"
  if (-not $NoLaunch -and $env:QQBOT_NO_LAUNCH -ne '1') { Start-App -Target $target; Write-Host 'launched' }
  exit 0
}

# ── 图形安装界面 ────────────────────────────────────────────────────────────
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
# 图标直接用 payload 里的 icon.ico（见下方 $script:Source）
$form.Text = 'SnowBridge Launcher v0.0.1 · 安装'
$form.Size = New-Object System.Drawing.Size(560, 340)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
try { $form.Icon = New-Object System.Drawing.Icon((Join-Path $script:Source 'icon.ico')) } catch { }

$title = New-Object System.Windows.Forms.Label
$title.Text = '把 SnowLuma 和 qq-bridge 收进一个窗口'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(20, 18)
$form.Controls.Add($title)

$desc = New-Object System.Windows.Forms.Label
$desc.Text = '装好后双击桌面「SnowBridge Launcher」：一键启动两个服务、日志合在一个窗口；关掉窗口只在右下角托盘后台运行，托盘右键「退出」才算结束。'
$desc.Size = New-Object System.Drawing.Size(500, 42)
$desc.Location = New-Object System.Drawing.Point(22, 52)
$form.Controls.Add($desc)

$lblDir = New-Object System.Windows.Forms.Label
$lblDir.Text = '安装位置'
$lblDir.AutoSize = $true
$lblDir.Location = New-Object System.Drawing.Point(22, 104)
$form.Controls.Add($lblDir)

$txtDir = New-Object System.Windows.Forms.TextBox
$txtDir.Text = if ($Dir) { $Dir } else { Get-DefaultDir }
$txtDir.Size = New-Object System.Drawing.Size(400, 24)
$txtDir.Location = New-Object System.Drawing.Point(22, 126)
$form.Controls.Add($txtDir)

$btnBrowse = New-Object System.Windows.Forms.Button
$btnBrowse.Text = '浏览…'
$btnBrowse.Size = New-Object System.Drawing.Size(70, 24)
$btnBrowse.Location = New-Object System.Drawing.Point(428, 125)
$btnBrowse.add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.SelectedPath = $txtDir.Text
  if ($dlg.ShowDialog() -eq 'OK') { $txtDir.Text = $dlg.SelectedPath }
})
$form.Controls.Add($btnBrowse)

$chkDesktop = New-Object System.Windows.Forms.CheckBox
$chkDesktop.Text = '创建桌面快捷方式'
$chkDesktop.Checked = $true
$chkDesktop.AutoSize = $true
$chkDesktop.Location = New-Object System.Drawing.Point(22, 162)
$form.Controls.Add($chkDesktop)

$chkAuto = New-Object System.Windows.Forms.CheckBox
$chkAuto.Text = '开机自动启动（进托盘）'
$chkAuto.AutoSize = $true
$chkAuto.Location = New-Object System.Drawing.Point(220, 162)
$form.Controls.Add($chkAuto)

$nodeExe = Test-Node
$lblWarn = New-Object System.Windows.Forms.Label
$lblWarn.Size = New-Object System.Drawing.Size(500, 20)
$lblWarn.Location = New-Object System.Drawing.Point(22, 190)
$lblWarn.ForeColor = [System.Drawing.Color]::FromArgb(190, 60, 60)
if (-not $nodeExe) {
  $lblWarn.Text = '没有找到 Node.js：程序需要 Node.js 22+ 才能运行，请先安装。'
} else {
  $lblWarn.Text = "将使用 Node：$nodeExe"
  $lblWarn.ForeColor = [System.Drawing.Color]::FromArgb(110, 110, 110)
}
$form.Controls.Add($lblWarn)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Size = New-Object System.Drawing.Size(400, 14)
$progress.Location = New-Object System.Drawing.Point(22, 228)
$progress.Visible = $false
$form.Controls.Add($progress)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.AutoSize = $true
$lblStatus.Location = New-Object System.Drawing.Point(22, 250)
$lblStatus.Text = ''
$form.Controls.Add($lblStatus)

$btnInstall = New-Object System.Windows.Forms.Button
$btnInstall.Text = '安装'
$btnInstall.Size = New-Object System.Drawing.Size(96, 30)
$btnInstall.Location = New-Object System.Drawing.Point(340, 252)
$form.Controls.Add($btnInstall)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = '取消'
$btnClose.Size = New-Object System.Drawing.Size(96, 30)
$btnClose.Location = New-Object System.Drawing.Point(442, 252)
$btnClose.add_Click({ $form.Close() })
$form.Controls.Add($btnClose)

$btnInstall.add_Click({
  $target = $txtDir.Text.Trim()
  if (-not $target) { [System.Windows.Forms.MessageBox]::Show('请先选一个安装位置。', 'SnowBridge Launcher'); return }
  if (-not $nodeExe) { [System.Windows.Forms.MessageBox]::Show('没有找到 Node.js，请先安装 Node.js 22 以上版本。', 'SnowBridge Launcher'); return }
  $btnInstall.Enabled = $false
  $btnBrowse.Enabled = $false
  $progress.Visible = $true
  $progress.Value = 0
  $lblStatus.Text = '正在安装…'
  [System.Windows.Forms.Application]::DoEvents()
  try {
    Install-Files -Target $target -Desktop $chkDesktop.Checked -AutoStart $chkAuto.Checked -Progress {
      param($p, $msg)
      $progress.Value = [Math]::Min(100, $p)
      $lblStatus.Text = $msg
      [System.Windows.Forms.Application]::DoEvents()
    } | Out-Null
    $lblStatus.Text = "安装完成：$target"
    $answer = [System.Windows.Forms.MessageBox]::Show("安装完成，现在打开 SnowBridge Launcher？`n`n程序位置：$target", 'SnowBridge Launcher', 'YesNo', 'Information')
    if ($answer -eq 'Yes') { Start-App -Target $target }
    $form.Close()
  } catch {
    [System.Windows.Forms.MessageBox]::Show("安装失败：$($_.Exception.Message)", 'SnowBridge Launcher', 'OK', 'Error')
    $lblStatus.Text = '安装失败'
    $btnInstall.Enabled = $true
    $btnBrowse.Enabled = $true
  }
})

[void]$form.ShowDialog()
