# 安装/卸载全流程自检（供自动化验证用）
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$target = Join-Path $here '_test-install'
$dataDir = Join-Path $env:LOCALAPPDATA 'QQbot'
$portFile = Join-Path $dataDir 'launcher.port'

if (Test-Path $target) { Remove-Item $target -Recurse -Force }
if (Test-Path (Join-Path $here '_test-data')) { Remove-Item (Join-Path $here '_test-data') -Recurse -Force }

$env:QQBOT_SILENT = '1'
$env:QQBOT_INSTALL_DIR = $target
$env:QQBOT_NO_AUTOSTART = '1'
$env:QQBOT_NO_LAUNCH = '1'

Write-Host '=== 静默安装 ==='
$p = Start-Process -FilePath (Join-Path $here 'SnowBridgeLauncherSetup.exe') -Wait -PassThru
Write-Host "install exit: $($p.ExitCode)"
$installed = @{
  files = (Get-ChildItem $target -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
  desktop = Test-Path (Join-Path $env:USERPROFILE 'Desktop\SnowBridge Launcher.lnk')
  startMenu = Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SnowBridge Launcher.lnk')
  registry = Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SnowBridgeLauncher'
}
Write-Host "installed: files=$($installed.files) desktop=$($installed.desktop) startMenu=$($installed.startMenu) registry=$($installed.registry)"

Write-Host '=== 卸载 ==='
# 把端口文件挪开，避免测试卸载去停掉正在运行的正式实例
if (Test-Path $portFile) { Move-Item $portFile "$portFile.bak" -Force }
try {
  $u = Start-Process -FilePath (Join-Path $target 'uninstall.cmd') -Wait -PassThru -WindowStyle Hidden
  Write-Host "uninstall exit: $($u.ExitCode)"
} finally {
  if (Test-Path "$portFile.bak") { Move-Item "$portFile.bak" $portFile -Force }
}
Start-Sleep -Seconds 2
$after = @{
  dirGone = -not (Test-Path $target)
  desktopGone = -not (Test-Path (Join-Path $env:USERPROFILE 'Desktop\SnowBridge Launcher.lnk'))
  registryGone = -not (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SnowBridgeLauncher')
}
Write-Host "after: dirGone=$($after.dirGone) desktopGone=$($after.desktopGone) registryGone=$($after.registryGone)"
