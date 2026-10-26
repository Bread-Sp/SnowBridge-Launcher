# SnowBridge Launcher

当前版本：**0.1.1**

把 SnowLuma 和 qq-bridge 收进一个窗口：一键启动、两份日志合并、关掉窗口只在托盘后台运行。

## 怎么用

双击 **SnowBridge Launcher.exe**（便携版）或桌面的「SnowBridge Launcher」快捷方式。没有黑框，界面是一个独立窗口，窗口/任务栏图标和托盘图标是同一只小鲸鱼。

- **无边框窗口**：窗口由自带的 `SnowBridgeHost.exe`（WebView2 外壳）创建，没有 Windows 标题栏/边框。顶部那条**独立的标题栏**就是界面自己的（左边是名字，右边是 `— ▢ ✕`）：拖空白处移动窗口，双击标题栏最大化/还原，`— ▢ ✕` 是最小化/最大化/关闭（关闭只是收进托盘，服务照常跑）；最小化和关闭都有整窗淡出+下沉的过渡，不会硬切消失。靠边缘 6px 还能拖动缩放。

- **首次运行**：装好后第一次打开会弹「首次设置」，让你选 SnowLuma 和 qq-bridge 的目录。可以点「跳过」，但目录没填齐之前每次启动都会再弹一次；点「完成」就不再打扰。选目录时会检查内容：选中的文件夹里必须能找到 SnowLuma（index.mjs）或 qq-bridge（src\bridge.js）；如果选中的是包含它们的父目录，会自动往下找到那一层。老用户升级不会弹（已经有 `launcher.json` 且两个目录都有效，视为已完成）。

- **两张服务卡**：运行状态、PID、已运行时长、绑定目录。目录改到设置里（齿轮 → 目录，见下）；卡片上只显示当前绑定的路径（「目录：」+ 路径，纯文字、没有框）。
  - `启动` / `停止` / `重启` 只管这一个服务；`打开 SnowLuma 界面` 打开 SnowLuma 自己的 WebUI（端口从它 `config\runtime.json` 的 `webuiPort` 读，默认 5099），`打开桥接控制台` 打开 3100。SnowLuma 的登录态只存在内存里，它一重启就要重新输入访问令牌 —— 忘了密码就把 `config\webui.json` 备份后移走、再启动 SnowLuma，初始密码会打印在启动台日志里（`initial credentials: user=admin password=…`）。
- **一键启动**：先起 SnowLuma；如果工具栏「hook」里配了账号，会等 hook 就绪、OneBot 端口（默认 3000）真的监听上（最多 30 秒）再起桥接 —— 桥接一启动就直接连上，不会刷一串 `code=1006`。没配 hook（或 QQ 没登录、等待超时）时只等 1 秒就起桥接，不把「一键启动」卡死；这种情况下桥接会自己反复重连，等 QQ 登录、hook 加载好就自动恢复。
- **自动接管外部服务**：设置 → 常规里默认开启，启动台每分钟检查一次；发现 SnowLuma / qq-bridge 是外面用 `start.bat` / 守护脚本起的（能认出进程 PID 的才算），就自动掐掉守护脚本、按「先桥接后 SnowLuma」的顺序停掉旧实例、等 3000/3100 端口真的空出来，再重新拉起。OneBot 端口 40 秒内没起来不算失败，桥接会自己重连。
- **自动加载 QQ hook**：启动台拉起 SnowLuma 之后会自己登录它的 WebUI，只给工具栏「hook」里配置的账号加载 hook（不需要开 SnowLuma 的 `hookAutoLoad`，开了会连你其它登录的 QQ 一起注入）。第一次先点工具栏 **hook**，填机器人 QQ 号和控制台密码；密码用 DPAPI 加密后存进 `launcher.json`，只有当前 Windows 用户能解开。QQ 还没登录时会每 10 秒重试、最多等 10 分钟；控制台密码改了要重新填一次；想立刻重试可以 `POST /api/hook-load`。
- **记忆面板**：只读展示她自己的日记和便签（`GET /api/memory`）。日记按日期折叠、便签单独一栏；不提供编辑 —— 这段文字是她换会话后唯一的连续感来源，界面上能改就等于随时可能被手滑覆盖。面板顶部只显示当前「记忆目录」的只读路径；要改去设置（齿轮 → 目录 → 记忆目录），留空就跟随桥接的 `fs.root`。
- **检查更新**：设置（齿轮）里点「检查更新」，一次查 SnowLuma、qq-bridge 和本软件是不是最新版（只查不升级，弹窗里给发布页/下载页链接）。SnowLuma 优先用它自己的 `/api/update/check`（由它自己配镜像、判断预发布），它没运行时退回 GitHub 发布页；qq-bridge 只有发布页可读；本软件读自己的 GitHub Releases。本机直连 `github.com` 是不通的（`fetch failed`），所以和 SnowLuma 一样按 `github.chenc.dev` / `gh.noki.icu` / `cors.isteed.cc` / `ghfast.top` 等镜像并发试，有一个通就行；全不通就显示「无法检查」并把原因列在弹窗底部。
- **日志两个页签**：清屏、复制；滚动跟随看位置 —— 贴在底部就自动跟随新日志，往上翻停在原处并露出日志框右下角的圆形「回到底部」箭头（点它平滑回到底部并恢复跟随，有弹簧式入场动画）；按语义配色（成功绿、失败红、连接抖动黄、启动台动作蓝 —— 不是「含『错误』就标红」，启动日志里大量正常流程也带「错误」字样，全标红反而看不出真问题），ANSI 颜色码已剥掉。
- **呼出动画**：从托盘 / 快捷方式把后台窗口叫回来时，整扇窗轻轻浮现一下（460ms：透明度 0→1 + 向上 14px 归位 + 三次缓出曲线）。动画在 `SnowBridgeHost.exe` 里直接对窗口做，而且**等页面加载完成才开始播** —— 所以不会再出现「窗口先弹出来、内容慢半拍才出现」。Edge 回退模式（没有 WebView2 时）仍在页面里播 `summon-in` 动画。
- **退出动画**：点「退出并停止」（或托盘右键「退出」）时，界面先轻轻上浮淡出、窗口同时淡出（260ms），播完才真正结束进程，不会「啪」一下消失。
- **关闭窗口**：点右上角 ✕ 弹出「是否关闭窗口」，只有「结束进程」「后台运行」两个按钮和一个「不再提醒」；勾选后按这次的选择记住（设置 → 常规可切回每次询问）。「结束进程」等同退出并停止。
- **设置**：标题栏右上角的齿轮（`#win-settings`）打开设置，分成五页（「目录」页里也管记忆目录，「外观」页换配色/背景）：
- **启动时最小化**：设置 → 常规里可以勾「启动 SnowBridge Launcher 时最小化到系统栏」，之后双击图标只挂托盘、不弹窗口（托盘双击仍可呼出）。
  - **常规**：五个开关**点一下即时生效**、没有「保存」按钮：开机自动启动（管理 `Startup\SnowBridge Launcher.lnk`，带 `-NoWindow` 进托盘不弹窗）、打开启动台时自动启动服务、服务意外退出后自动重启、自动接管外部服务、关闭窗口时后台运行（不询问）。
  - **目录**：SnowLuma / qq-bridge 两个目录，点「选择目录」弹系统原生文件夹框，选完立刻校验（SnowLuma 目录里要有 `index.mjs` 或 `snowluma*.exe`，qq-bridge 目录里要有 `src\bridge.js`），校验不过不落盘。改动即时保存，正在跑的服务重启一次才会用新目录。
  - **版本与更新**：一次查 SnowLuma、qq-bridge、本软件三项是否最新；旁边有「Bug 反馈」按钮，点开 GitHub 的 new issue 页面。
  - **关于**：版本号、安装目录、数据目录、当前记忆目录；关于页里是程序图标 + 名称/版本/三个目录，底部 By.Bread_Sp 是链接（点开 GitHub 个人主页），旁边的绿色「赏」按钮会弹出支付宝收款码。
  - **外观**：预设 `默认`（上一版的深蓝黑底）、日落、森林、深海、雪蓝（白+淡蓝）、银灰（白+灰）、黑灰（DeepSeek Harness 风的黑灰）。除「默认」外每套都带苹果味渐变；也可以自己挑一个颜色，界面会从它派生整套背景渐变、按钮和文字对比度；还能把一张图片设为窗口背景（铺满窗口并压暗保证文字可读），图片存在数据目录。用预设时「自定义颜色」显示为黑色。
  弹窗和切页都有苹果味动画：打开从左下 12px 外 + 96.6% 放大回弹（380ms 三次缓出），关闭反向（200ms）；切页时旧页淡出、新页淡入（320ms）。Edge 回退模式没有标题栏，齿轮不显示。
- 顶部三个健康灯：DSH 端点（显示当前实际端口）、SnowLuma OneBot、桥接控制台。
- 底部两个开关：打开启动台时自动起服务、服务意外退出自动重启（和设置弹窗里的是同一份配置）。

## 关掉窗口 ≠ 关掉程序

这是刻意的设计：

| 你的操作 | 实际发生的事 |
| --- | --- |
| 点窗口右上角的 ✕ | 窗口隐藏，**服务都还在跑**；右下角托盘里还留着图标。**每次启动只有第一次关窗**会弹「转为后台运行」的提示，之后关窗静默 |
| 再双击入口 exe / 桌面快捷方式 | 窗口没关 → 整窗置顶，同时界面播放「浮现」动画；窗口已关 → 重新显示，同样播整窗浮现动画，且永远只有一个窗口 |
| 双击托盘图标 | 和上面一样：呼出窗口并播放浮现动画 |
| 托盘右键 | 弹出深色菜单（打开主窗口 / 打开桥接控制台 / 状态 / 退出），**点菜单外任意位置或按 Esc 就收起** |
| 托盘右键 →「退出（结束所有进程）」 | 停 SnowLuma、停桥接、关掉后台服务，图标消失 —— **这才算结束** |
| 电脑重启 | 只有勾选了「开机自动启动」才会自动回来 |

安装时勾了「开机自动启动」的话，登录后会自动进托盘并按你保存的开关决定要不要起服务。

## 数据与日志在哪

- 配置：`%LOCALAPPDATA%\QQbot\launcher.json`（两个目录、两个开关、端口、hook 账号和加密后的 WebUI 密码）
- 日志：`%LOCALAPPDATA%\QQbot\logs\{snowluma,bridge}.log`（每次启动重写，界面跟随的就是它）
- 托盘诊断：`%LOCALAPPDATA%\QQbot\tray.log`
- 端口：界面服务固定监听 `127.0.0.1:3220`（被占则顺延到 3231）；桥接自己的控制台是 3100，两者不相干

程序目录删了不影响配置；重装也会沿用原来的目录绑定。

## 卸载

开始菜单或安装目录里的「卸载 SnowBridge Launcher」，或者控制面板 → 程序和功能。会先停掉托盘和服务，再删快捷方式与程序文件（`%LOCALAPPDATA%\QQbot` 里的配置和日志保留，想彻底清干净手动删掉即可）。

## 十九个技术细节（改代码前请看）

1. **子进程输出不能走 pipe**：父进程一死读端就关，子进程下一次 `console.log` 会拿到 EPIPE，Node 默认当未捕获错误退出 —— 表现是「重启启动台顺手把桥接杀了」。现在子进程的 stdout/stderr 直接重定向到日志文件，界面跟随文件。
2. **`spawn` 必须 `detached: true`**：不加的话子进程挂在这条控制台上，父进程退出、控制台销毁时系统会发 `CTRL_CLOSE_EVENT`，子进程当场死掉且不留日志。实测同样参数 `detached=false` 必死、`detached=true` 必活。
3. **SnowLuma 要用自带的 `hidehost.exe` 包一层**：它起来后自己还会再拉一个同命令行的子进程。我们原本 `windowsHide: true` 起它，等于父进程完全没有控制台，子进程被系统**新分配一个可见控制台** —— Win11 的默认终端是 Windows Terminal，屏幕上就凭空弹出标题为 `E:\SnowLuma\node.exe` 的终端窗口（窗口类是 `CASCADIA_HOSTING_WINDOW_CLASS`，按窗口类 hide 无效），那个窗口还会抢焦点，看着像是「QQ 里打不了字」。给它一个已存在但不可见的控制台，子进程继承它，窗口不再出现。**不能用 `conhost.exe --headless`**：Windows 11 24H2/25H2（build 26100/26200）上它已经变成空操作，只往 stdout 吐一串 VT 控制码就退出 0、根本不执行后面的命令行，表现就是启动台刚拉起 SnowLuma 就显示「■ SnowLuma 已退出（code=0）」并每 3 秒自动重启。现在改用 `app\hidehost.exe`（源码 `app\hidehost.cs`，用 `csc` 编译）：`CreateProcess(CREATE_NEW_CONSOLE + SW_HIDE)` 起 SnowLuma、stdout/stderr 直接继承启动台给的日志文件句柄，宿主自己不退出，一直等到子进程结束后把退出码原样带回来（启动台靠这个退出码判断「意外退出」）；`taskkill /T` 杀 hidehost 能带走整棵树。
4. **自绘菜单要靠全局鼠标钩子收起来**：从托盘右键弹出菜单时，焦点还在任务栏上，菜单很可能一次都没被激活过 —— 此时点别处根本不会触发 WinForms 的 `Deactivate`，菜单就挂在那儿关不掉（这就是「右键菜单关不掉」的真因）。现在 `winhelp.cs` 在菜单显示期间挂一个 `WH_MOUSE_LL` 低级鼠标钩子，任何在菜单矩形之外的按下都会把它收起；`Esc` 同样有效。
5. **「接管」先掐守护、按桥接→SnowLuma 的顺序停**：外面的启动方式常常带着 `start-bridge-bg.cmd` / `restart.bat` 这类守护脚本，不先结束它们，停掉的服务会被立刻拉回来；而停服务必须**先 bridge 后 SnowLuma**，反过来桥接会对着一个正在死的 SnowLuma 疯狂重连。之后要等 3000/3100 端口真空（`waitPortClosed`）才重新拉起。另外用 PowerShell 拼命令行时多条语句必须用换行拼（`join('\n')`）：用空格拼会得到 `$ErrorActionPreference = 'SilentlyContinue' Get-CimInstance ...` 这种语法错，`Get-CimInstance` 根本不执行、函数静默返回空数组，表现为「接管永远找不到外部进程」。匹配守护脚本时只认 `cmd.exe` / `wscript.exe` / `cscript.exe`，否则会误伤当前 shell。
6. **记忆是只读的**：`/api/memory` 只从桥接自己的文件读（`<fs.root>\diary\*.md` 里的 `- HH:MM` 行；旧的 `state\diary\*.txt` 也兼容；便签读 `state\memo.json`，没有就显示空），不提供任何写接口。理由和第 5 条里的顺序一样，都是为了别让工具伤到她的东西。
7. **「停止中」必须自己收尾，不能只靠 `exit` 事件**：停止时只把 `stopping=true` 挂出去、指望子进程的 `exit` 回调复位，事件一丢（`taskkill /T` 先杀了宿主、Windows 丢事件、hidehost 换手）状态就永远停在「停止中」——界面上「启动/停止/重启」一起变灰，表现就是「启动不了」。现在 `stopService` 会主动轮询 PID 直到真的消失再复位（最多 5 秒，真没死就报错并保持停止中），`exit` 回调里也兜底复位；`startService` 开头还会自愈「进程已死但状态还挂着旧 PID」的残留。界面的 `withBusy` 同样必须在 `finally` 里放开（网络抖动不能让按钮永久锁死）。**外部实例探测也要核对锁文件里的 PID**：桥接的 `state\bridge.lock` 不随进程退出清理，PID 被系统复用后只看「进程还在」就会误判成「已在运行（外部启动）」，启动被挡下——也是「启动不了」的一种。所以锁文件里的 PID 与 `detectExternal` 给出的 PID 都要先核对命令行（`pidMatches`），确认真是 `E:\qq bridge\src\bridge.js` / `E:\SnowLuma\index.mjs` 才认；`pidsByCommandLine` 同时匹配 `ExecutablePath` 和「命令行里的目录」，因为桥接用的是外面的 `E:\Node\node.exe`，只看可执行文件路径永远找不到它。
8. **hook 是启动台替 SnowLuma 加载的，别用 `hookAutoLoad` 代替**：SnowLuma 的 `hookAutoLoad` 只有一个总开关——开了会给**所有**已登录的 QQ 进程注入 hook（实测三个号全被接进 OneBot，本人号也跟着跑），关了又会在 QQ 重启后把机器人的 hook 弄丢（OneBot 3000/3001 不再监听，桥接只能反复报 `code=1006`，看着就像「又坏了」）。所以启动台在 SnowLuma 起来后自己登录它的 WebUI（`POST /api/login` 取 token），`GET /api/processes` 按 UIN 找到进程，只对 `hookUins` 里点名的账号 `POST /api/processes/:pid/load`。控制台密码用 `ConvertFrom-SecureString`（DPAPI，绑当前 Windows 用户）存进 `launcher.json`，换用户或换机器解不开；密码错就立刻停手不重试（SnowLuma 连续 5 次错会锁 15 分钟），QQ 还没登录时每 10 秒查一次、最多盯 10 分钟，超时后点工具栏「hook」或 `POST /api/hook-load` 再来一次。启动顺序也配合 hook 调整：配了 hook 时「一键启动」会先等 OneBot 监听再拉桥接，「重启 SnowLuma」会先停桥接、重启并等 OneBot 重新监听后再把桥接拉回来（反过来桥接会对着正在死的 SnowLuma 刷一屏 `code=1006`）；hook 就绪日志做了去重，同一组账号 2 分钟内只记一次，一键启动不会重复刷屏。
9. **Edge 回退模式的呼出动画做在页面里，不要动 Chromium 的窗口几何**：没有 WebView2 时窗口用 Edge `--app` 打开，托盘/快捷方式把窗口叫回来时 `tray.ps1` 先 `POST /api/summon`，服务端通过 SSE 广播 `summon`，页面给 `body` 加 `.summoning` 播 460ms 的 `summon-in`。不要用 `SetWindowPos` 去缩放窗口、也不要给窗口加 `WS_EX_LAYERED` 做透明度：Chromium 的 app 窗口一 resize 就重排，动画会抖，还容易把窗口尺寸/位置写坏。正常模式（SnowBridgeHost）下 `playSummon()` 直接 return，整窗动画由宿主负责，避免两层动画叠加。
10. **无边框窗口用自建 WebView2 外壳，别试图改 Edge 窗口样式**：Edge `--app` 的标题栏其实是 Chromium 画在客户区里的（约 31px），Win32 去掉 `WS_CAPTION` 后客户区只多 2px、视觉没变化；非安装型 PWA 也不会启用 Window Controls Overlay（实测 `navigator.windowControlsOverlay.visible=false`、inner 比 outer 少 31px）。所以改成 `app\SnowBridgeHost.exe`（源码 `app\SnowBridgeHost.cs`）自己创建 `FormBorderStyle.None` 窗口并内嵌 WebView2：页面检测到 `window.chrome?.webview` 就加 `body.shell`，标题栏空白处 mousedown 发 `drag`（宿主 `ReleaseCapture` + `WM_NCLBUTTONDOWN/HTCAPTION`）、`#win-min`/`#win-max`/`#win-close` 发 `minimize`/`maximize`/`close`；宿主负责 DWM 圆角、6px 边缘缩放、手动最大化（按工作区取尺寸，避免无边框最大化盖住任务栏）、**`NavigationCompleted` 之后才播整窗淡入**（先等内容就绪，否则就是「窗口先弹、内容后到」）、`✕` 只隐藏窗口；单实例用互斥量，第二个实例写 `%LOCALAPPDATA%\QQbot\summon.request` 唤醒已有窗口；每 5 秒 ping 一次 `/api/ping`，服务端没了就自己退出。没装 WebView2 运行时会自动退回 Edge `--app`。
11. **退出也要有过渡，别直接杀进程**：点「退出并停止」时页面先给 `body` 加 `.quitting` 播 `quitting-out`（260ms 上浮淡出），无边框模式下同时 `postMessage('exit')`，宿主把窗口 Opacity 做 1→0、下移 8px，再 `Close()` + `Application.Exit()`。托盘右键「退出」走 `%LOCALAPPDATA%\QQbot\exit.request`（宿主 120ms 轮询一次），写文件后等 420ms 再兜底 `Stop-Process`，这样窗口不会硬切消失。不要在这条路径上直接 `Stop-Process` 宿主：窗口会瞬间消失，没有过渡。

12. **「开机自启」只有一个真相：那条 Startup 快捷方式**：安装器、卸载器、设置弹窗都读写同一个 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SnowBridge Launcher.lnk`。不要在 `launcher.json` 里再存一份「要不要自启」的布尔值：两处状态早晚会打架，用户会遇到「设置里明明关了，下次开机又回来」。打开开关 = 用 PowerShell（`WScript.Shell` COM）创建快捷方式，指向安装目录的 `SnowBridge Launcher.exe`、参数 `-NoWindow`、图标用 exe 自己的；关掉 = 删文件。创建后要再 `Test-Path` 一次确认真的落盘（被安全软件拦下时给前端 400 和原因），弹窗收到失败会把开关拨回真实状态。另外两个开关（打开时自动起服务、意外退出自动重启）仍然走 `POST /api/config` → `saveConfig`，和底部开关完全等价。

13. **界面卡顿要怪同步探测，不怪按钮**：`/api/state` 原来每次请求都会 `await` 两次外部实例探测（每次都起一个 PowerShell 扫进程表，1.5–1.9 秒），而 `withBusy` 又习惯在打开弹窗前先 `await refresh()` —— 于是点齿轮、点记忆都要先卡两秒。现在服务端用 stale-while-revalidate：`externalHint` 缓存（`EXTERNAL_TTL_MS = 20000`），`snapshotAsync` 立刻返回缓存并后台单飞刷新，`/api/state` 从 1.9 秒降到 2 毫秒；`withBusy` 不再在 `fn()` 前 `await refresh()`，只在 `finally` 里刷新。启动慢则是另一条链：入口 `entry.cs` 现在不先等托盘（PowerShell 冷启动约 1 秒），而是先探服务端端口、直接拉起 `SnowBridgeHost.exe`，再在后台起托盘；`winhelp.cs` 在构建时预编译成 `winhelp.dll`，托盘直接 `Assembly.LoadFrom`，省掉 `Add-Type` 的 0.5 秒。实测双击到窗口完整出现从约 3 秒降到 1.8 秒。
14. **本软件的更新检查读自己的 Releases**：版本号写死在 `server.mjs` 顶部的 `const VERSION`，最新版由 `checkLauncherVersion()` 读 `LAUNCHER_REPO`（`Bread-Sp/SnowBridge-Launcher`）的发布页 latest 标签，和 `compareVersions()` 比；`checkUpdates()` 现在并行查 SnowLuma / qq-bridge / 本软件三项，界面在设置弹窗里展示。**不自动升级**：只提示，覆盖安装新安装包即可，配置和日志都不动。镜像会缓存旧发布页，所以 `latestReleaseTag()` 会把所有成功响应里的版本取最高，而不是谁先返回用谁（否则新版本刚发时会读到镜像里的旧 tag）。发新版时记得改 `VERSION`，否则新包会一直显示「有新版本」。
15. **首次运行向导和设置分页都靠一个 `setupDone`**：`launcher.json` 里已有两个目录、没有 `setupDone` 字段的（老版本升级上来的）自动视为已完成，不弹向导；全新安装（没有 `launcher.json`）才会弹。「跳过」只关弹窗、不改状态，所以下次启动还会弹；只有点「完成」（或设置里两个目录都校验通过）才写 `setupDone:true`。挑目录时 `saveConfig` 允许一次只绑一个目录（首次引导期间只校验这次改的那个），点完成时才做全量 `validateDirs`。弹窗动画都在 `ui.html`：`openModal/closeModal` 用 `.open`/`.closing` 两个类 + 210ms 定时器收尾，设置页切换用 `.settings-page.active/.leaving` 配 `page-in`/`page-out` 关键帧；改时长只动 CSS，别在 JS 里再 `setTimeout` 对齐，容易和 `_closeTimer` 打架。
16. **「退出」是异步的，必须防住和重开的撞车**：用户点完「退出」马上又双击，旧服务端可能还在停服务的路上，新窗口会连上一个将死的实例（表现是窗口开着突然「127.0.0.1 拒绝连接」）。现在：托盘点退出先写 `quitting.flag`（含本次服务端 PID），再让后台隐藏 PowerShell 发 `POST /api/quit {"stopAll":true,"pid":<旧PID>}`；服务端只接受 `pid` 等于自己的请求（否则 409），迟到的退出杀不到新实例。入口 `EnsureServer` 不再「端口开着就复用」：先看 `quitting.flag`（120 秒内有效）等旧实例把端口放出来，再用 `/api/ping` 确认真的在应答才复用，否则起新的。宿主窗口在服务端短暂失联时也不立刻退出：导航失败 800ms 后自动重试（最多 60 次），ping 连续失败 3 次先重新导航，24 次（约 2 分钟）都没回来才收窗口。
17. **最小化/关闭也是窗口级过渡，别让窗口硬切**：页面的 #win-min / #win-close 只发 minimize / close 消息，真正动画在宿主里做——AnimateWindowOut(bool) 用 16ms×12 帧把窗口 Opacity 从 1 到 0、Top 下沉 10px（ease-in），播完才最小化或隐藏，随后把 Opacity/Top 复位，这样从任务栏还原或再次呼出不会残留半透明。winAnimating 守卫同一时刻只播一次；quitting/exiting 期间直接跳过，避免和退出动画抢计时器。页面里的 summon-in 只管「呼出」，关窗/最小化别再叠一层 CSS 动画，否则两层缓动会互相拖后腿。

18. **外观是一层 CSS 变量，不是另做一套界面**：`ui.html` 里所有颜色都走 `:root` 变量（`--bg`/`--panel`/`--text`/`--accent`/`--green`/`--log-ok` 等），`applyAppearance()` 只改 `document.documentElement.style` 上的这组变量和 `--app-bg`/`--wallpaper` 两个组合量，不重排 DOM。预设的渐变色由 `themeFor()` 从主色算（`radial-gradient` 叠在 `linear-gradient` 上，再按相对亮度决定用深色还是浅色文字——所以浅色主题（暖沙）也能读）；自定义颜色走 `mode:'color'`，渐变从该色派生；`mode:'image'` 时不加渐变、改用 `--wallpaper` 指向 `/api/wallpaper`（图片存在 `%LOCALAPPDATA%\QQbot\wallpaper.png`，由 `POST /api/pick-image` 弹出系统图片框写入，`GET /api/wallpaper` 读出来，永远不写进代码/安装包）。配置存在 `launcher.json` 的 `appearance` 字段，服务端 `normalizeAppearance()` 白名单校验；改外观不用重启服务端。浅色主题下语义色（成功绿/失败红/警告黄/日志色）也会换成深色版本，否则在浅底上看不清——停止/退出这类危险按钮另有 `--danger-bg`/`--danger-border`/`--danger-text` 三个变量，浅色下自动换成深红字+红边+淡红底，且 `:disabled` 透明度单独放宽到 0.62，不至于灰到看不见。这些也都是自动算的，不是写死的两套主题。
19. **托盘右键菜单也要跟随外观**：菜单是原生自绘窗口，拿不到 WebView 的 CSS 变量，所以服务端在 `/api/state` 里附一份 `theme`——`themePalette(appearance)` 把预设/自定义色/图片三种外观折算成 `bg`/`text`/`muted`/`line`/`hover`/`danger` 六个 `#rrggbb`，并带 `sig`（mode|preset|color|image）。托盘 `Poll-StateFetch` 收到后与上次 `ThemeSig` 比较，变了就 `TrayMenu.SetTheme(...)`，下次右键弹出的菜单就是新配色。预设色在服务端按同一套规则重新算一遍（不读 ui.html），所以两边不会不同步；**加新预设要同时改 `PRESETS`（ui.html）和 `PRESET_SPECS`（server.mjs）**。菜单默认色只是初始值，服务端没起来时也能正常显示。

## 需要什么

- Windows 10/11
- Node.js 22 及以上（程序本身零依赖，不装 npm 包）
- WebView2 运行时（装 Edge 时一般自带；装了就用无边框外壳 `SnowBridgeHost.exe`）
- 没有 WebView2 时退回 Edge `--app` 窗口；连 Edge 都没有就退回默认浏览器

## 目录结构

```
QQbot\
  SnowBridge Launcher.exe        双击入口（比 vbs 多一个图标，推荐）
  SnowBridge Launcher.vbs        备用入口（等同 exe）
  app\entry.cs        入口 exe 的源码（csc 编译）
  app\server.mjs      本地服务：进程管理、日志跟随、健康探测
  app\hidehost.exe    给 SnowLuma 的隐藏控制台宿主（server.mjs 调它）
  app\hidehost.cs     它的源码（csc 编译）
  app\SnowBridgeHost.exe  无边框窗口外壳（WebView2，自己创建窗口+整窗动画）
  app\SnowBridgeHost.cs   它的源码（csc 编译）
  app\Microsoft.Web.WebView2.*.dll / WebView2Loader.dll  外壳依赖
  app\ui.html         界面（单文件）
  app\launch.mjs      拉起服务并打开窗口
  app\tray.ps1        托盘宿主：关窗口转后台、右键菜单、置顶
  app\winhelp.cs      窗口查找/置顶/自绘菜单/鼠标钩子
  app\icon.ico        图标（托盘、窗口、exe 同源）
  ins\                安装包工程与构建脚本
```

## 安装包

双击 `ins\SnowBridgeLauncherSetup.exe` 即可（自带图标、自解压，不需要联网）：

- 图形界面里选安装位置（默认 `%LOCALAPPDATA%\Programs\SnowBridge Launcher`）、勾选「创建桌面快捷方式」「开机自动启动」，点「安装」。
- 认到的 Node 会显示在界面里；没有 Node 22+ 会给出警告。
- 静默安装（批量部署用）：

  ```bat
  set QQBOT_SILENT=1
  set QQBOT_INSTALL_DIR=D:\QQbot
  set QQBOT_NO_AUTOSTART=1
  SnowBridgeLauncherSetup.exe
  ```

  也支持 `-Silent -Dir D:\QQbot -NoAutoStart -NoLaunch`。其它开关：`-NoDesktop`（不建桌面图标）、`-NoLaunch`（装完不启动）。
- 安装内容：程序拷到 `<安装目录>\app`，快捷方式指向 `app\launcher.exe`（带鲸鱼图标，双击直接进托盘），生成桌面/开始菜单「SnowBridge Launcher」、可选的启动项、`卸载 SnowBridge Launcher` 和控制面板卸载登记。
- 升级：直接再运行一次安装包覆盖程序文件即可；重启后生效（`%LOCALAPPDATA%\QQbot` 里的配置和日志会保留）。
- 自己重新构建：`ins\build-installer.ps1`（从 `app\`、`ins\`、`third_party\webview2\` 直接打 payload.zip，用 `csc.exe` 编译自解压启动器；不再有 `ins\payload` 中间目录，改完 `app\` 直接重跑这一条即可）。
