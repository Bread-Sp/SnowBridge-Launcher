# SnowBridge Launcher

> 把 SnowLuma 和 qq-bridge 拧成一个桌面应用：无边框窗口、托盘常驻、一键启动、日志与记忆面板、QQ hook 自动加载、内置更新检查。

![界面截图](docs/screenshot.png)

## 这是什么

SnowLuma 是 OneBot v11 网关，qq-bridge 是把 QQ 消息接进 DSH 的桥接。两者分开跑的时候，要开两个终端、盯三条日志、重启顺序还不能反。这个启动台把它们做成一个 Windows 桌面应用：

- **一键启动 / 停止 / 重启 / 接管**，顺序和等待都由启动台负责（先 SnowLuma，等 OneBot 端口起来再拉桥接；桥接不会对着正在死的 SnowLuma 刷 `code=1006`）
- **接管现有服务**：服务是外面手动起的也能收编，启动台会先掐守护脚本、按正确顺序停掉旧实例、再重新拉起
- **日志面板**：桥接 / SnowLuma 两个页签，贴底自动跟随，往上翻停住，右下角箭头一键回到底部
- **记忆面板**（只读）：直接读桥接的日记和便签，看它记得什么
- **QQ hook 自动加载**：给指定的 QQ 号自动注入 SnowLuma 的 hook（登录 SnowLuma 控制台后只加载你点名的那一个账号）
- **设置**：开机自启、打开时自动启动服务、服务意外退出自动重启、检查更新（SnowLuma / qq-bridge / 本软件）
- **无边框窗口**：标题栏、拖拽、`— ▢ ✕`、边缘缩放全部在页面里；关闭只是收进托盘，真正的退出是「退出并停止」
- **呼出 / 退出动画**：整窗淡入浮现，退出时窗口一起淡出

## 下载

到 [Releases](https://github.com/Bread-Sp/SnowBridge-Launcher/releases) 下载：

- `SnowBridgeLauncherSetup.exe` —— 安装包（Windows 10/11 x64）
- `source.zip` —— 对应版本的源码

运行环境：

- Windows 10 / 11 x64
- [Node.js](https://nodejs.org/) 18+（SnowLuma 自身要求 Node 24，二者可以分别安装；启动台会优先用 `E:\Node\node.exe`，找不到就用 PATH 里的 `node`）
- Microsoft Edge WebView2 Runtime（Windows 11 自带；Windows 10 一般随 Edge 装好）

## 安装

双击 `SnowBridgeLauncherSetup.exe`，安装到默认目录（`%LOCALAPPDATA%\Programs\SnowBridge Launcher`），会创建桌面快捷方式、开始菜单项和卸载项。

静默安装 / 自定义目录：

```powershell
# 静默安装到 D:\Apps\SnowBridge Launcher，不建桌面快捷方式、不自动启动
.\SnowBridgeLauncherSetup.exe -Silent -Dir 'D:\Apps\SnowBridge Launcher' -NoDesktop -NoAutoStart -NoLaunch
```

卸载：设置 → 应用 → SnowBridge Launcher，或开始菜单里的卸载项。安装目录、快捷方式、注册表项会被清理。

## 怎么用

**双击 `SnowBridge Launcher.exe`**：入口会先确保服务端在跑，再拉起无边框窗口；窗口已经在托盘里时，双击只是把它带回来。

- 顶部标题栏（无边框模式）：左边是名字，右边是 `—` 最小化、`▢` 最大化/还原、`✕` 关闭（关闭 = 收进托盘）。拖标题栏移动窗口，双击标题栏最大化/还原，窗口四边 6px 内可以拖动缩放。
- 两张服务卡：显示运行状态、PID、外部接管提示；`启动 / 停止 / 重启`，以及 `打开 SnowLuma 界面`、`打开桥接控制台`。
- **一键启动**：先起 SnowLuma，隔 1 秒起 qq-bridge，**不**去等 OneBot 3000 端口 —— SnowLuma 没登录 QQ 时那个端口永远不会开，干等只会让「一键启动」点完半天没反应；桥接自己会重连，启动时那几行 `code=1006` 是正常的。
- **接管现有服务**：把外面手动起的服务（包括守护脚本）收进来，按「掐守护脚本 → 停桥接 → 停 SnowLuma → 等端口真空 → 起 SnowLuma → 等 OneBot → 起桥接」的顺序换成启动台自己管理。
- **记忆**：只读面板，显示桥接的日记（`fs.root\diary\*.md`）和便签（`state\memo.json`，若有）。刻意只读 —— 那是它换会话后唯一的连续感来源。
- **hook**：填机器人 QQ 号和 SnowLuma 控制台密码，启动台登录 SnowLuma 后只给这个 QQ 号加载 hook（密码用 Windows DPAPI 加密保存，只有当前用户能解）。
- **设置**（齿轮）：开机自启、打开启动台时自动启动服务、服务意外退出后自动重启、检查更新。开关即时生效，没有保存按钮。
- **日志**：贴底自动跟随；往上翻会停住，右下角出现回到底部箭头（弹簧入场动画）。

## 关掉窗口 ≠ 关掉程序

| 操作 | 结果 |
| --- | --- |
| 点窗口右上角 `✕` / Alt+F4 | 窗口收进托盘，服务继续运行 |
| 托盘图标双击 / 右键「呼出窗口」 | 窗口带整窗动画回来 |
| 右键菜单「退出并停止」/ 设置里「退出并停止」 | 停掉 SnowLuma、qq-bridge、服务端、窗口，一起退出 |

## 数据与日志

- 配置：`%LOCALAPPDATA%\QQbot\launcher.json`（`snowlumaDir` / `bridgeDir` / `port` / `hookUins` / `webuiPasswordEnc` 等）
- 日志：`%LOCALAPPDATA%\QQbot\logs\{snowluma,bridge}.log`，启动台自己的日志 `tray.log`、`host.log` 也在同一目录
- SnowLuma 自己的日志：`<SnowLuma 目录>\logs\`
- 启动台和安装目录里不保存密码明文；控制台密码用 DPAPI 密文存在 `launcher.json`

## 技术细节（改代码前请看）

1. **子进程输出不走 pipe**：stdout/stderr 直接写日志文件、`child.unref()`，否则启动台一退出服务就跟着断。
2. **spawn 必须 `detached: true`**：否则启动台窗口关掉会带走服务；配合 `windowsHide` 与自写的 `hidehost.exe`（CREATE_NEW_CONSOLE + SW_HIDE + 传递 std 句柄）给 SnowLuma 一个隐藏控制台，避免它再拉子进程时弹出 Windows Terminal 窗口。
3. **Edge `--app` 的标题栏去不掉**：那一行约 31px 是 Chromium 画在客户区里的；`SetWindowLong` 去掉 `WS_CAPTION` 客户区只多 2px，WCO 在非安装 PWA 下不启用。所以无边框窗口由自写的 `SnowBridgeHost.exe`（WinForms + WebView2）创建。
4. **`/api/state` 要快**：外部实例探测（PowerShell 扫进程）改成 20 秒 stale-while-revalidate 缓存，`snapshotAsync()` 立即返回缓存、后台刷新，接口从 1.9 秒降到毫秒级。
5. **UI 打开弹窗不要先 `await refresh()`**：`withBusy()` 先执行动作、`finally` 里再刷新状态，否则每次点齿轮/记忆都要等一次状态请求。
6. **入口快路径**：入口 `launcher.exe` 先探 `launcher.port`，没在跑就起 `server.mjs`，再直接拉起 `SnowBridgeHost.exe`，跳过 node + launch.mjs 的启动开销；托盘随后并行补起。
7. **托盘预编译 `winhelp.dll`**：`winhelp.cs` 在构建时编成 DLL，托盘 `Add-Type` 直接加载，省掉每次冷启动约 0.5 秒的现场编译。
8. **`hookAutoLoad` 是全账号总开关**：SnowLuma 的 `hookAutoLoad: true` 会给所有已登录 QQ 进程注入，没有按账号过滤的配置；所以启动台自己在 WebUI 进程页只对指定 UIN `load`，把 SnowLuma 的 `hookAutoLoad` 保持 `false`。
9. **外部实例探测要核对锁文件 PID**：`bridge.lock` 不随进程退出清理，Windows 会复用 PID；只看 `isAlive(lockPid)` 会误判「已在运行」。用命令行/可执行路径的 `pidMatches` 复核。
10. **检查更新走 GitHub 镜像**：本机直连 GitHub 不稳定，`latestReleaseTag()` 直连 + 多镜像并发 `Promise.any`，从发布页 `og:url` 抠 tag；SnowLuma 运行时优先用它的 `/api/update/check`。
11. **所有 `.ps1` 必须是 UTF-8 带 BOM**：PowerShell 5.1 按 ANSI 读无 BOM 文件，中文注释会把脚本解析崩（`tray.ps1` 丢 BOM 就表现为「双击 exe 没反应」）。
12. **托盘状态轮询全部非阻塞**：`DownloadStringTaskAsync` + 缓存 + 超时丢弃，UI 线程不做任何同步网络调用，否则右键菜单会卡死。
13. **窗口动画分层**：页面管内容（`.summoning` / `.quitting`），宿主管整窗（`Opacity` + `Top` 三次缓出）；首次显示等 `NavigationCompleted` 之后再播，避免「窗口先出来、内容后到」。
14. **启动顺序**：一键启动 / 重启 SnowLuma 时，如果配置了 hook，先等 OneBot 监听（最多 30 秒）再拉桥接；等不到也照常起桥接，桥接会自己重连。

## 目录结构

```
SnowBridge-Launcher/
├─ app/                 运行时代码
│  ├─ server.mjs        启动台服务端（HTTP API + 进程管理 + 日志 + 设置）
│  ├─ ui.html           界面（单文件，含 CSS/JS）
│  ├─ SnowBridgeHost.cs 无边框 WebView2 宿主源码
│  ├─ entry.cs          入口 launcher.exe（快路径）
│  ├─ tray.ps1          托盘（WinForms + 自绘菜单）
│  ├─ winhelp.cs        窗口查找/置前等 P/Invoke，构建时编成 winhelp.dll
│  ├─ hidehost.cs       给子进程准备隐藏控制台的中间宿主
│  ├─ launch.mjs        打开窗口（宿主优先，Edge 回退）
│  └─ icon.ico / icon.png / make-icon.py
├─ third_party/webview2/  WebView2 托管 DLL（构建时复制进安装包）
├─ ins/                 安装与构建
│  ├─ launcher.cs       安装包外壳（自解压 payload.zip）
│  ├─ install.ps1 / install.cmd / launcher-entry.vbs
│  ├─ build-installer.ps1   一键构建安装包
│  └─ test-install-cycle.ps1 安装/卸载冒烟测试
├─ docs/screenshot.png
└─ README.md / LICENSE
```

## 自己重新构建

```powershell
# 需要 .NET Framework 4.x 的 csc.exe（Windows 自带）
powershell -NoProfile -ExecutionPolicy Bypass -File .\ins\build-installer.ps1
# 产物：ins\SnowBridgeLauncherSetup.exe
```

构建脚本会自动：编译 `winhelp.dll`、`hidehost.exe`、`SnowBridgeHost.exe`、`launcher.exe`，把 `app/`、`third_party/webview2/`、`ins/` 里的安装脚本和 README 打进 `payload.zip`，再嵌进安装包外壳 —— 不需要手工同步任何 payload 目录。

## 许可证

MIT，见 [LICENSE](LICENSE)。

第三方组件：Microsoft WebView2 SDK（`third_party/webview2/`），遵循其各自许可，见 [third_party/webview2/NOTICE.md](third_party/webview2/NOTICE.md)。
