# SnowBridge Launcher
非官方第三方工具。 SnowBridge Launcher 与 [SnowLuma](https://github.com/SnowLuma/SnowLuma)、[qq-bridge](https://github.com/Derpyu520/qq-bridge) 的开发者无隶属或合作关系，未获其背书。本项目不包含、不修改、不再分发它们的任何代码或安装包；使用前请自行安装 SnowLuma 与 qq-bridge。
> 让 SnowLuma 和 qq-bridge 的启动变得更加方便

![界面截图](docs/screenshot.png)


## 这是什么

将 [SnowLuma](https://github.com/SnowLuma/SnowLuma) 和 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的CMD窗口整合成一个桌面应用。

- **一键启动 / 停止 / 重启 / 接管**：启动顺序、重启、都可以使用 SnowBridge Launcher 一键操作
- **接管现有服务**：手动运行的 SnowLuma 和 qq-bridge 也可以自动接管
- **日志面板**：更加人性化的界面，丢掉笨重的cmd窗口将 桥接 / SnowLuma 两个页签整合到一个窗口
- **记忆面板**（只读）：若有日记或便签，可以读桥接的日记和便签，看它写了些什么
- **QQ hook 自动加载**：给指定的 QQ 号自动注入 SnowLuma 的 hook
- **控制台网页一键启动**：只需按一下就能打开 SnowLuma 或 qq-bridge 的网页，再也不用手动输入或复制粘贴网址进入控制台
- **自动检查更新**：每次启动都会自动检查你的 SnowLuma 和 qq-bridge 包括 SnowBridge Launcher 版本，提示更新
- **界面美化**:按喜好选择控制台色调，且支持自定义背景图片


运行环境：

- Windows 10 / 11 x64
- [Node.js](https://nodejs.org/) 18+（SnowLuma 自身要求 Node 24，二者可以分别安装；启动台会优先用 `E:\Node\node.exe`，找不到就用 PATH 里的 `node`）
- Microsoft Edge WebView2 Runtime（Windows 11 自带；Windows 10 一般随 Edge 装好）

## 安装
> 本工具不提供 SnowLuma / qq-bridge 安装包，请先按各自官方文档装好，再设置路径。

双击 `SnowBridgeLauncherSetup.exe`，安装到默认目录（`%LOCALAPPDATA%\Programs\SnowBridge Launcher`），会创建桌面快捷方式、开始菜单项和卸载项。


静默安装 / 自定义目录：

```powershell
# 静默安装到 D:\Apps\SnowBridge Launcher，不建桌面快捷方式、不自动启动
.\SnowBridgeLauncherSetup.exe -Silent -Dir 'D:\Apps\SnowBridge Launcher' -NoDesktop -NoAutoStart -NoLaunch
```

卸载：设置 → 应用 → SnowBridge Launcher，或开始菜单里的卸载项。安装目录、快捷方式、注册表项会被清理。

## 如何使用

**双击 `SnowBridge Launcher.exe`**：入口会先确保服务端正在运行后拉起框窗口。

- 设置 SnowLuma 和 qq-Bridge 的路径后点击一键启用即可


## 数据与日志

- 配置：`%LOCALAPPDATA%\QQbot\launcher.json`（`snowlumaDir` / `bridgeDir` / `port` / `hookUins` / `webuiPasswordEnc` 等）
- 日志：`%LOCALAPPDATA%\QQbot\logs\{snowluma,bridge}.log`，启动台自己的日志 `tray.log`、`host.log` 也在同一目录
- SnowLuma 自己的日志：`<SnowLuma 目录>\logs\`
- 启动台和安装目录里不保存密码明文；控制台密码用 DPAPI 密文存在 `launcher.json`

## 免责声明
> 非官方第三方工具。本项目不包含、不修改、不再分发 SnowLuma / qq-bridge
> 的任何代码或安装包，与二者开发者无隶属关系；使用前请自行安装。

**1. 非官方项目**
SnowBridge Launcher（下称“本项目”）是由个人开发者独立开发的第三方工具，与
SnowLuma、qq-bridge 的开发者及 SnowLumaDevs 无任何隶属、合作、授权、赞助或
背书关系，亦不代表其立场。文中出现的“SnowLuma”“qq-bridge”“QQ”“腾讯”等
名称与标识均归其各自权利人所有，仅用于说明兼容性，不构成任何形式的授权或关联。

**2. 不包含、不修改、不再分发**
本项目不包含、不修改、不再分发 SnowLuma、qq-bridge 的任何源代码、二进制文件、
安装包或原生组件；仅调用用户本机已安装的上述软件，并读取其产生的日志与数据。
用户获取、安装、使用 SnowLuma 与 qq-bridge 时，仍须遵守其各自的许可协议
（SnowLuma 适用其 LICENSE 与 EULA.md，qq-bridge 适用其自身许可），本项目不改变、
也不豁免这些条款。本声明不构成对上述许可的替代；如有冲突，以官方许可为准。

**3. 使用风险自负**
本软件通过非官方方式与 QQ 客户端交互，可能违反腾讯《QQ 用户协议》及相关平台
规则，并可能导致账号被限制、封禁或数据丢失。你理解并自愿承担上述全部风险。
请勿将本软件用于任何违法、侵权、骚扰、垃圾信息或破坏性用途，亦不得用于未经
授权访问他人系统或账号。你应自行确保对所使用的 QQ 账号及设备拥有合法使用权。

**4. 无担保**
本软件按“现状（AS-IS）”及“现有（AS-AVAILABLE）”提供，不附带任何明示或默示的
担保，包括但不限于适销性、特定用途适用性、不侵权、准确性、可用性及不中断运行。
作者不保证本软件与任何特定版本的 SnowLuma、qq-bridge、QQ 客户端或 Windows
版本兼容。

**5. 责任限制**
在适用法律允许的最大范围内，作者不对因使用或无法使用本软件而产生的任何直接、
间接、偶然、特殊、惩罚性或后果性损害承担责任，包括但不限于账号封禁、数据丢失、
业务中断、利润损失及第三方索赔。

**6. 数据与隐私**
本项目在本机运行，不包含将聊天记录上传至作者服务器的功能。配置保存在
`%LOCALAPPDATA%\QQbot\launcher.json`，日志保存在同目录 `logs\`。程序在检查更新
时会向 GitHub 查询版本信息。请注意：日志与记忆面板可能包含聊天内容等敏感信息，
公开分享日志、截图或问题反馈前请自行脱敏。控制台密码以加密形式保存，但仍建议
不要在公共设备上登录你的账号。

**7. 第三方组件**
本项目使用 Microsoft Edge WebView2 Runtime 等第三方组件，其遵循各自许可，
详见 `third_party/webview2/NOTICE.md`。本项目自身代码以 MIT 许可发布，
MIT 许可仅覆盖本项目代码，不覆盖任何第三方软件。

**8. 条款变更与可分性**
作者可能不定期更新本声明，更新版本随仓库发布。若本声明任何条款被认定为无效或
不可执行，其余条款仍完全有效。本声明适用中华人民共和国大陆地区法律。


## 许可证

MIT，见 [LICENSE](LICENSE)。

第三方组件：Microsoft WebView2 SDK（`third_party/webview2/`），遵循其各自许可，见 [third_party/webview2/NOTICE.md](third_party/webview2/NOTICE.md)。

## 更新日志

### 2026.10.27 0.1.1 测试版本
- 上传测试版至本仓库

### 2026.10.27 0.1.2 测试版本
- 添加了 **自动检查更新** 功能
