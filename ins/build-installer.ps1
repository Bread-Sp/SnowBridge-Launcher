# 构建安装包：从源码目录收集运行时文件 -> payload.zip -> 自解压安装程序。
# 不依赖任何第三方工具（csc.exe 是 .NET Framework 自带）。
# 用法（仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File .\ins\build-installer.ps1
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$root = Split-Path $here -Parent
$app = Join-Path $root 'app'
$tp = Join-Path $root 'third_party\webview2'
$zip = Join-Path $here 'payload.zip'
$cs = Join-Path $here 'launcher.cs'
$icon = Join-Path $app 'icon.ico'
$out = Join-Path $here 'SnowBridgeLauncherSetup.exe'

$cscCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw '找不到 csc.exe（.NET Framework 4.x 编译器），无法打包' }

$stage = Join-Path $env:TEMP ('SnowBridgePayload_' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  # 1. 运行时文件
  $appFiles = @('server.mjs', 'ui.html', 'launch.mjs', 'tray.ps1', 'winhelp.cs', 'SnowBridgeHost.cs', 'hidehost.cs', 'icon.ico', 'icon.png', 'donate.png')
  foreach ($f in $appFiles) { Copy-Item (Join-Path $app $f) (Join-Path $stage $f) -Force }
  $tpFiles = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')
  foreach ($f in $tpFiles) { Copy-Item (Join-Path $tp $f) (Join-Path $stage $f) -Force }
  foreach ($f in @('install.ps1', 'install.cmd', 'launcher-entry.vbs')) { Copy-Item (Join-Path $here $f) (Join-Path $stage $f) -Force }
  Copy-Item (Join-Path $root 'README.md') (Join-Path $stage 'README.md') -Force

  # 2. 编译期产物（保证和源码一致）
  Write-Host '编译 winhelp.dll…'
  & $csc /nologo /target:library "/out:$(Join-Path $stage 'winhelp.dll')" /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll (Join-Path $app 'winhelp.cs')
  if ($LASTEXITCODE -ne 0) { throw "winhelp.dll 编译失败（退出码 $LASTEXITCODE）" }

  Write-Host '编译 hidehost.exe…'
  & $csc /nologo /target:exe /platform:anycpu /optimize+ "/out:$(Join-Path $stage 'hidehost.exe')" (Join-Path $app 'hidehost.cs')
  if ($LASTEXITCODE -ne 0) { throw "hidehost.exe 编译失败（退出码 $LASTEXITCODE）" }

  Write-Host '编译 SnowBridgeHost.exe…'
  & $csc /nologo /target:winexe /platform:x64 "/out:$(Join-Path $stage 'SnowBridgeHost.exe')" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Net.Http.dll "/reference:$(Join-Path $tp 'Microsoft.Web.WebView2.Core.dll')" "/reference:$(Join-Path $tp 'Microsoft.Web.WebView2.WinForms.dll')" (Join-Path $app 'SnowBridgeHost.cs')
  if ($LASTEXITCODE -ne 0) { throw "SnowBridgeHost.exe 编译失败（退出码 $LASTEXITCODE）" }

  Write-Host '编译入口 launcher.exe…'
  & $csc /nologo /target:winexe /platform:anycpu /optimize+ "/win32icon:$icon" "/out:$(Join-Path $stage 'launcher.exe')" (Join-Path $app 'entry.cs')
  if ($LASTEXITCODE -ne 0) { throw "launcher.exe 编译失败（退出码 $LASTEXITCODE）" }

  # 3. 打包
  $files = Get-ChildItem $stage -File
  Write-Host "打包 $($files.Count) 个文件…"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
  Write-Host ("payload.zip: {0:N0} KB" -f ((Get-Item $zip).Length / 1KB))

  if (Test-Path $out) { Remove-Item $out -Force }
  $refs = @(
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll'
  )
  $cscArgs = @(
    '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+',
    "/out:$out",
    "/win32icon:$icon",
    "/resource:$zip,payload.zip"
  ) + $refs + @($cs)

  & $csc @cscArgs
  if ($LASTEXITCODE -ne 0) { throw "csc 编译失败（退出码 $LASTEXITCODE）" }
  if (-not (Test-Path $out)) { throw '没有产出安装程序' }

  Write-Host ("完成：{0}  {1:N0} KB" -f $out, ((Get-Item $out).Length / 1KB))
}
finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
}
