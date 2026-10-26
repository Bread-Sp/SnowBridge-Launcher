# Third-party notices

## Microsoft.Web.WebView2

`Microsoft.Web.WebView2.Core.dll`、`Microsoft.Web.WebView2.WinForms.dll`、`WebView2Loader.dll`
来自 **Microsoft Edge WebView2 SDK**（NuGet 包 `Microsoft.Web.WebView2`），随本仓库一起分发，
仅用于编译 `SnowBridgeHost.exe`（无边框窗口宿主）。

- 版权：© Microsoft Corporation。保留所有权利。
- 许可：Microsoft 的 WebView2 SDK 许可条款（随 SDK 分发，参见
  <https://www.nuget.org/packages/Microsoft.Web.WebView2> 与
  <https://learn.microsoft.com/microsoft-edge/webview2/>）。
- 本项目不修改这些二进制文件，只在构建时引用/打包；运行时由用户机器上已安装的
  WebView2 Runtime 提供实际的浏览器内核。

本项目的其余代码以 MIT 许可发布，见仓库根目录的 [LICENSE](../LICENSE)。
