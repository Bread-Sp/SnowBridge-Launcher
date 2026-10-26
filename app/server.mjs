// QQ 启动台 —— 把 SnowLuma 与 qq-bridge 的「启动/停止/日志」收进一个窗口。
//
// 为什么是「本地小 Web 服务 + 系统 Edge 的应用窗口」而不是 Electron：
//   ① 零依赖：不需要 npm install、不需要下载 100MB 的 Electron，双击就能用；
//   ② 两个被管理的程序本来就是长跑进程，日志必须由**一个常驻的父进程**接管
//      （cmd 窗口里的 start.bat 会把日志锁在那个窗口里，这正是要消掉的东西）；
//   ③ Edge 的 --app 模式没有地址栏和标签页，看起来就是一个独立程序。
//
// 职责边界：
//   - 这里只管「进程的生死」和「日志的搬运」，不实现任何 QQ 逻辑；
//     桥接自己的控制台（3100）依旧存在，UI 里给一个按钮打开它。
//   - 关闭窗口不会杀掉被管理的服务（它们是被 spawn 的子进程，父进程退出后继续跑），
//     想全停要点「全部停止」或「退出并停止」。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 程序自己（代码）住在这里，运行数据（配置/日志/端口）住在 AppData：
// 这样把程序目录整个拷走、或者重新装一遍，配置和日志都还在。
const APP_DIR = process.env.QQBOT_HOME || path.join(os.homedir(), 'AppData', 'Local', 'QQbot');
const CONFIG_FILE = path.join(APP_DIR, 'launcher.json');
const UI_FILE = path.join(HERE, 'ui.html');
// 给 SnowLuma 一个「已存在但不可见」的控制台（原因见 SERVICES.snowluma.resolveCommand 的注释）。
const HIDEHOST = path.join(HERE, 'hidehost.exe');
const DEFAULT_PORT = 3220;
const MAX_LINES = 3000;
const POLL_MS = 3000;

/** 程序版本：显示在窗口标题、界面角标、托盘提示和安装包里，也是以后升级判断的依据。 */
const VERSION = '0.0.3';

// ── 配置 ────────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  snowlumaDir: 'E:\\SnowLuma',
  bridgeDir: 'E:\\qq bridge',
  autoStartAll: false,   // 打开启动台就自动拉起两个服务
  autoRestart: true,     // 服务意外退出后自动重启（只对「本启动台启动的」生效）
  port: DEFAULT_PORT,
  // 自动加载 hook 的账号（UIN 字符串）。SnowLuma 自带的 hookAutoLoad 只能全开/全关，
  // 全开会把电脑上登录的每一个 QQ 都注入一遍（用户明确不要），所以这里只认点名的号。
  hookUins: [],
  // SnowLuma 控制台密码（DPAPI 加密，只有当前 Windows 用户能解开）：调它自己的 /api/login 用。
  webuiPasswordEnc: ''
};

function ensureAppDir() {
  fs.mkdirSync(APP_DIR, { recursive: true });
}

function loadConfig() {
  ensureAppDir();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    stored = {};
  }
  // 首次运行：猜一个合理的默认桥接目录（本文件就在 <bridge>/tools/launcher/ 里）
  const guessBridge = path.resolve(HERE, '..', '..');
  const guessSnowluma = fs.existsSync('E:\\SnowLuma') ? 'E:\\SnowLuma' : '';
  return {
    ...DEFAULT_CONFIG,
    bridgeDir: fs.existsSync(path.join(guessBridge, 'src', 'bridge.js')) ? guessBridge : DEFAULT_CONFIG.bridgeDir,
    snowlumaDir: guessSnowluma || DEFAULT_CONFIG.snowlumaDir,
    ...stored
  };
}

function saveConfig(patch) {
  const next = { ...config };
  for (const key of ['snowlumaDir', 'bridgeDir']) {
    if (typeof patch[key] === 'string' && patch[key].trim()) next[key] = path.resolve(patch[key].trim());
  }
  for (const key of ['autoStartAll', 'autoRestart']) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key];
  }
  // 路径必须先验过再落盘：绑错目录的后果是「点启动没反应」，比报错更难查。
  const errors = validateDirs(next);
  if (errors.length > 0) return { ok: false, errors };
  config = next;
  ensureAppDir();
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  broadcastState();
  return { ok: true, config };
}

function validateDirs(cfg) {
  const errors = [];
  if (!cfg.snowlumaDir || !fs.existsSync(cfg.snowlumaDir)) errors.push(`SnowLuma 目录不存在：${cfg.snowlumaDir || '(空)'}`);
  else if (!fs.existsSync(path.join(cfg.snowlumaDir, 'index.mjs'))
    && !fs.readdirSync(cfg.snowlumaDir).some((f) => /^snowluma.*\.exe$/i.test(f))) {
    errors.push(`SnowLuma 目录里没有 index.mjs：${cfg.snowlumaDir}`);
  }
  if (!cfg.bridgeDir || !fs.existsSync(cfg.bridgeDir)) errors.push(`qq-bridge 目录不存在：${cfg.bridgeDir || '(空)'}`);
  else if (!fs.existsSync(path.join(cfg.bridgeDir, 'src', 'bridge.js'))) {
    errors.push(`qq-bridge 目录里没有 src\\bridge.js：${cfg.bridgeDir}`);
  }
  return errors;
}

let config = loadConfig();

// ── 日志环形缓冲 + 广播 ──────────────────────────────────────────────────────
const rings = { snowluma: [], bridge: [] };
const seqs = { snowluma: 0, bridge: 0 };
const sseClients = new Set();

function pushLine(id, text) {
  const clean = String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '');
  if (!clean) return;
  const ring = rings[id];
  if (!ring) return;
  seqs[id] += 1;
  const line = { seq: seqs[id], t: Date.now(), text: clean.length > 4000 ? `${clean.slice(0, 4000)}…` : clean };
  ring.push(line);
  if (ring.length > MAX_LINES) ring.splice(0, ring.length - MAX_LINES);
  broadcast({ type: 'log', svc: id, line });
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch { sseClients.delete(res); }
  }
}

function broadcastState() {
  broadcast({ type: 'state', state: snapshot() });
}

// ── 进程管理 ────────────────────────────────────────────────────────────────
/** 每个服务的运行时状态（不持久化）。 */
const runtime = {
  snowluma: { proc: null, pid: null, startedAt: 0, restarts: 0, lastExitCode: null, stopping: false, wanted: false },
  bridge: { proc: null, pid: null, startedAt: 0, restarts: 0, lastExitCode: null, stopping: false, wanted: false }
};

const SERVICES = {
  snowluma: {
    id: 'snowluma',
    label: 'SnowLuma',
    // 直接用引擎自带的 node.exe，避开 PATH 里 node 版本不符的问题（官方 launcher.bat 也是这个思路）。
    resolveCommand: (dir) => {
      const bundled = path.join(dir, 'node.exe');
      const nodeExe = fs.existsSync(bundled) ? bundled : process.execPath;
      const entry = path.join(dir, 'index.mjs');
      // 为什么要套一层 hidehost.exe：
      // SnowLuma 起来后会再拉一个同命令行的子进程（父子两层）。我们是 detached +
      // windowsHide:true 起的它，也就是**完全没有控制台**，子进程被系统分配一个新的可见控制台；
      // Win11 的默认终端是 Windows Terminal，于是屏幕上凭空弹出一个标题为 "E:\SnowLuma\node.exe"
      // 的终端窗口（窗口类是 CASCADIA_HOSTING_WINDOW_CLASS，不是 ConsoleWindowClass，按窗口类
      // 去 hide 无效），而且会抢焦点。先给它一个「已经存在、但不可见」的控制台，子进程继承后
      // 就不再新建窗口。hidehost.exe 用 CreateProcess(CREATE_NEW_CONSOLE + SW_HIDE) 起 SnowLuma，
      // 自己不退出、等子进程结束后把退出码原样带回来（启动台靠它判断「意外退出」）。
      // 以前这里套的是 `conhost.exe --headless`：在 Windows 11 24H2/25H2（build 26100/26200）
      // 上它已经变成空操作 —— 只往 stdout 吐一串 VT 控制码就退出 0，根本不执行后面的命令行，
      // 于是启动台看到「code=0 意外退出」，每 3 秒自动重启一次（就是那个无限重启的 bug）。
      if (process.platform === 'win32' && fs.existsSync(HIDEHOST)) {
        return { node: HIDEHOST, args: [nodeExe, entry], display: `${nodeExe} ${entry}` };
      }
      // 兜底：没有 hidehost.exe 就直接起（能跑，但 SnowLuma 的孙进程可能弹一个可见终端窗口）。
      return { node: nodeExe, args: [entry] };
    },
    env: (dir) => ({ ...process.env, SNOWLUMA_HOME: dir }),
    hint: 'index.mjs'
  },
  bridge: {
    id: 'bridge',
    label: 'qq-bridge',
    resolveCommand: (dir) => ({ node: process.execPath, args: [path.join(dir, 'src', 'bridge.js')] }),
    env: () => process.env,
    hint: 'src/bridge.js'
  }
};

function dirOf(id) {
  return id === 'snowluma' ? config.snowlumaDir : config.bridgeDir;
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function tcpProbe(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等端口真的空出来（杀完进程后端口释放有延迟，抢跑会 EADDRINUSE）。 */
async function waitPortClosed(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await tcpProbe('127.0.0.1', port, 700))) return true;
    await sleep(400);
  }
  return false;
}

/** 等端口起来（SnowLuma 登录 QQ 后才会监听 OneBot HTTP 3000，所以超时要给够）。 */
async function waitPortOpen(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpProbe('127.0.0.1', port, 700)) return true;
    await sleep(500);
  }
  return false;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15000, ...options }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), error });
    });
  });
}

/** 从 netstat 里找出「正在监听某个本地端口」的 PID（用于接管/结束外部实例）。 */
async function listenerPid(port) {
  const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP']);
  const re = new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
  const m = re.exec(stdout);
  return m ? Number(m[1]) : null;
}

/** 桥接自己的单实例锁文件里记着 PID，比端口更准（能区分「端口被别的程序占了」）。 */
function bridgeLockPid() {
  try {
    const raw = fs.readFileSync(path.join(config.bridgeDir, 'state', 'bridge.lock'), 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * 核对一个 PID 现在确实还是「某个目录下的 node 在跑某个脚本」。
 *
 * 为什么不能只看 PID 还在不在：桥接的 state\bridge.lock 记着 PID，但**进程退出时不会清锁**
 * （崩溃、被 taskkill、被别处结束都一样）。等系统把这个 PID 复用给随便一个进程，只看
 * isAlive 就会把它当成「桥接在跑」，于是启动被挡下（「已在运行（外部启动）」）、
 * 界面又点不动 —— 用户看到的就是「启动不了」。锁文件不归启动台管（不能删），
 * 所以只在「真要用这个 PID」时花一次查询核对命令行。
 */
async function pidMatches(pid, exeDir, pattern) {
  if (!pid) return false;
  const dir = String(exeDir ?? '').replace(/'/g, "''");
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" |`,
    `  Where-Object { ($_.ExecutablePath -like '${dir}*' -or $_.CommandLine -like '*${dir}*') -and $_.CommandLine -match '${pattern}' } |`,
    `  ForEach-Object { $_.ProcessId }`
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { timeout: 10000 });
  return r.stdout.split(/\r?\n/).some((s) => Number(s.trim()) === pid);
}

/** SnowLuma 原生 WebUI 的端口/协议：读它自己的 config/runtime.json，读不到就兜底 5099。 */
function snowlumaWebui() {
  let port = Number(process.env.SNOWLUMA_WEBUI_PORT) || 0;
  let tls = false;
  try {
    const raw = fs.readFileSync(path.join(config.snowlumaDir, 'config', 'runtime.json'), 'utf8').replace(/^\uFEFF/, '');
    const rt = JSON.parse(raw);
    if (!port) port = Number(rt?.webuiPort) || 0;
    tls = Boolean(rt?.webuiTls?.enabled);
  } catch { /* 没配置就按默认端口 */ }
  if (!(port > 0 && port < 65536)) port = 5099;
  return { port, tls };
}

// ── SnowLuma 自动加载 hook ──────────────────────────────────────────────────
// 为什么需要这一层：SnowLuma 自带的 hookAutoLoad 只有「全开/全关」——全开会把电脑上
// 登录的每个 QQ 都注入一遍（用户明确不要）；关掉之后 QQ 一重启（比如开机）hook 就没了，
// OneBot 的 3000/3001 不会监听，桥接只能反复报 1006（用户看到的就是「又坏了」）。
// 所以：启动台在 SnowLuma 起来之后，用它的 WebUI 接口只给配置里点名的账号加载 hook。
// 控制台密码用 DPAPI 加密后存 launcher.json，只有当前 Windows 用户能解开。
let hookTask = null;
let cachedPassword = { enc: '', value: '' };
// 防日志刷屏：同一组账号在 2 分钟内只记一次「已就绪」（一键启动会同时触发两次检查）。
let hookReadySig = '';
let hookReadyAt = 0;

/** 加密密码：ConvertTo-SecureString/ConvertFrom-SecureString（DPAPI，绑当前用户）。 */
async function dpapiEncrypt(plain) {
  const text = String(plain).replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$s = ConvertTo-SecureString -String '${text}' -AsPlainText -Force`,
    '[Console]::Out.Write((ConvertFrom-SecureString $s))'
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { timeout: 20000 });
  const enc = r.stdout.trim();
  if (!r.ok || !enc) throw new Error(`无法加密密码：${r.error?.message ?? '未知错误'}`);
  return enc;
}

/** 解密：DPAPI 绑当前 Windows 用户，换用户/换机器解不开。 */
async function webuiPassword() {
  const enc = String(config.webuiPasswordEnc ?? '');
  if (!enc) return '';
  if (cachedPassword.enc === enc) return cachedPassword.value;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$s = ConvertTo-SecureString '${enc}'`,
    "[Console]::Out.Write([System.Net.NetworkCredential]::new('', $s).Password)"
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { timeout: 20000 });
  if (!r.ok) throw new Error(`无法解出控制台密码：${r.error?.message ?? '未知错误'}`);
  cachedPassword = { enc, value: r.stdout };
  return r.stdout;
}

/** 调 SnowLuma 自己的 WebUI 接口（登录令牌放 x-snowluma-token 头）。 */
async function snowlumaFetch(port, tls, pathname, { method = 'GET', token = '', body = null } = {}) {
  const url = `${tls ? 'https' : 'http'}://127.0.0.1:${port}${pathname}`;
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-snowluma-token'] = token;
  const res = await fetch(url, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  let data = {};
  try { data = await res.json(); } catch { /* 空响应也按失败处理 */ }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/** 配置里要自动加载 hook 的账号（UIN）。 */
function hookTargets() {
  const list = Array.isArray(config.hookUins) ? config.hookUins : [];
  return list.map((v) => String(v).trim()).filter((v) => /^\d{5,12}$/.test(v)).slice(0, 5);
}

/** 登录一次，用于「填密码时立刻校验」。 */
async function verifyWebuiLogin(password) {
  const { port, tls } = snowlumaWebui();
  try {
    const r = await snowlumaFetch(port, tls, '/api/login', { method: 'POST', body: { password } });
    return r?.token ? { ok: true } : { ok: false, error: '登录没有返回 token' };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 等 SnowLuma 起来 → 登录 WebUI → 只给 hookTargets() 里的账号加载 hook。
 * QQ 可能还没登录，所以最多盯 10 分钟；SnowLuma 退出就收工。同一时间只跑一个循环。
 */
function scheduleHookEnsure(reason) {
  setTimeout(() => { void ensureSnowlumaHook(reason); }, 2500);
}

async function ensureSnowlumaHook(reason = '启动') {
  if (hookTask) return hookTask;
  const initialTargets = hookTargets();
  if (initialTargets.length === 0) {
    pushLine('snowluma', '⚙ SnowLuma hook：还没配置机器人 QQ 号（点工具栏「hook」填一次即可）');
    return { ok: false, error: 'no-targets' };
  }
  let password = '';
  try {
    password = await webuiPassword();
  } catch (error) {
    pushLine('snowluma', `⚙ SnowLuma hook：${error.message}`);
  }
  if (!password) {
    pushLine('snowluma', '⚙ SnowLuma hook：还没配置控制台密码（点工具栏「hook」填一次即可）');
    return { ok: false, error: 'no-password' };
  }
  hookTask = (async () => {
    const { port, tls } = snowlumaWebui();
    const deadline = Date.now() + 10 * 60 * 1000;
    let token = '';
    let announced = false;
    let loadedPid = 0;
    try {
      while (Date.now() < deadline) {
        if (!runtime.snowluma.proc || !isAlive(runtime.snowluma.pid)) return { ok: false, error: 'snowluma-exited' };
        // 每轮都重新读配置：用户可能在循环里改了要加载的账号。
        const targets = hookTargets();
        if (targets.length === 0) return { ok: false, error: 'no-targets' };
        try {
          if (!token) {
            const login = await snowlumaFetch(port, tls, '/api/login', { method: 'POST', body: { password } });
            token = String(login?.token ?? '');
          }
          const list = (await snowlumaFetch(port, tls, '/api/processes', { token }))?.list ?? [];
          const online = [];
          for (const uin of targets) {
            const proc = list.find((item) => String(item?.account?.uin ?? '') === uin);
            if (!proc) continue;
            if (proc.injected && (proc.status === 'online' || proc.connected)) { online.push(uin); continue; }
            if (!proc.injected && proc.pid && proc.pid !== loadedPid) {
              loadedPid = proc.pid;
              pushLine('snowluma', `⚙ SnowLuma hook：正在给 QQ 进程 ${proc.pid}（UIN ${uin}）加载…`);
              await snowlumaFetch(port, tls, `/api/processes/${proc.pid}/load`, { method: 'POST', token, body: {} });
            }
          }
          if (targets.every((uin) => online.includes(uin))) {
            const sig = targets.join(',');
            if (sig !== hookReadySig || Date.now() - hookReadyAt > 2 * 60 * 1000) {
              hookReadySig = sig;
              hookReadyAt = Date.now();
              pushLine('snowluma', `⚙ SnowLuma hook 已就绪：UIN ${targets.join('、')}（${reason}）`);
              if (runtime.bridge.proc) pushLine('bridge', '⚙ SnowLuma hook 已就绪，桥接会自动重连上来');
            }
            return { ok: true, uins: targets };
          }
          if (!announced) {
            announced = true;
            pushLine('snowluma', `⚙ SnowLuma hook：等 QQ 账号 ${targets.join('、')} 登录后自动加载（每 10 秒查一次，最多 10 分钟）…`);
          }
        } catch (error) {
          const message = String(error?.message ?? error);
          // 密码错误就别重试了：重试也是错，且会撞上 SnowLuma 的「5 次锁定 15 分钟」。
          if (message === '密码错误') {
            pushLine('snowluma', '⚙ SnowLuma hook：控制台密码不对，自动加载失败（点工具栏「hook」重新填）');
            return { ok: false, error: 'bad-password' };
          }
          token = '';
          if (!announced) {
            announced = true;
            pushLine('snowluma', `⚙ SnowLuma hook：暂未连上 SnowLuma WebUI（${message}），继续重试…`);
          }
        }
        await sleep(10000);
      }
      pushLine('snowluma', '⚙ SnowLuma hook：10 分钟内没等到账号登录，先放弃；登录后点工具栏「hook」重新加载');
      return { ok: false, error: 'timeout' };
    } finally {
      hookTask = null;
    }
  })();
  return hookTask;
}

/** 保存 hook 配置（账号 + 加密后的密码）。 */
function saveHookConfig(patch) {
  const next = { ...config };
  if (Array.isArray(patch.uins)) {
    next.hookUins = patch.uins.map((v) => String(v).trim()).filter((v) => /^\d{5,12}$/.test(v)).slice(0, 5);
  }
  if (typeof patch.webuiPasswordEnc === 'string' && patch.webuiPasswordEnc) {
    next.webuiPasswordEnc = patch.webuiPasswordEnc;
    cachedPassword = { enc: '', value: '' };
  }
  config = next;
  hookReadySig = '';
  hookReadyAt = 0;
  ensureAppDir();
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  broadcastState();
  return config;
}

// ── 版本检查 ────────────────────────────────────────────────────────────────
// 「是不是最新版」不自己猜：SnowLuma 有官方更新检查接口（走它自己配置的镜像、预发布比较也由它做），
// 优先问它；没运行就退回到 GitHub 发布页。qq-bridge 没有自检接口，直接读发布页的 latest 标签。
// 本机直连 github.com 是不通的（实测 fetch failed），所以和 SnowLuma 一样按镜像并发试。
const GH_MIRRORS = [
  'https://github.chenc.dev',
  'https://gh.noki.icu',
  'https://cors.isteed.cc',
  'https://ghfast.top',
  'https://gh-proxy.com',
  'https://ghproxy.net',
  'https://fastgit.cc'
];
const SNOWLUMA_REPO = 'SnowLuma/SnowLuma';
const BRIDGE_REPO = 'Derpyu520/qq-bridge';
const LAUNCHER_REPO = 'Bread-Sp/SnowBridge-Launcher';

function versionParts(value) {
  const raw = String(value ?? '').trim().replace(/^v/i, '');
  const matched = /^(\d+(?:\.\d+)*)(?:[-+](.+))?$/.exec(raw);
  if (!matched) return null;
  return { nums: matched[1].split('.').map(Number), suffix: (matched[2] ?? '').trim() };
}

/** 比版本号：数字段逐段比；只差后缀时「正式版 > 预发布」，其余按字符串比。返回 1/0/-1，解析不了返回 NaN。 */
function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return String(a) === String(b) ? 0 : Number.NaN;
  const len = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = left.nums[i] ?? 0;
    const y = right.nums[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (left.suffix === right.suffix) return 0;
  if (!left.suffix) return 1;
  if (!right.suffix) return -1;
  return left.suffix > right.suffix ? 1 : -1;
}

function readJsonIfExists(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function localSnowlumaVersion() {
  const rel = readJsonIfExists(path.join(config.snowlumaDir, 'release.json'));
  const pkg = readJsonIfExists(path.join(config.snowlumaDir, 'package.json'));
  return String(rel?.version ?? pkg?.version ?? '').trim() || '未知';
}

function localBridgeVersion() {
  const pkg = readJsonIfExists(path.join(config.bridgeDir, 'package.json'));
  return String(pkg?.version ?? '').trim() || '未知';
}

/** 从 GitHub 发布页（直连 + 各镜像并发）读 latest 标签；失败把原因放进 errors，返回空串。 */
async function latestReleaseTag(repo, errors) {
  const original = `https://github.com/${repo}/releases/latest`;
  const targets = [original, ...GH_MIRRORS.map((mirror) => `${mirror}/${original}`)];
  const attempts = targets.map(async (target) => {
    const res = await fetch(target, {
      headers: { 'user-agent': 'SnowBridge-Launcher-UpdateCheck/1.0' },
      signal: AbortSignal.timeout(9000)
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const html = await res.text();
    const ogTag = /<meta\b[^>]*property=["']og:url["'][^>]*>/i.exec(html)?.[0] ?? '';
    const canonical = /content=["']([^"']+)["']/i.exec(ogTag)?.[1] ?? '';
    const tag = /\/releases\/tag\/([^/"'?#]+)/.exec(canonical || res.url)?.[1] ?? '';
    if (!tag) throw new Error('发布页里没有版本号');
    return decodeURIComponent(tag).replace(/^[vV]/, '');
  });
  // 镜像会缓存旧页面：不能「谁先回信用谁」，要把所有成功结果里版本最高的那个挑出来。
  const results = await Promise.allSettled(attempts);
  const tags = [];
  const failures = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) tags.push(result.value);
    else if (result.status === 'rejected') failures.push(`${repo}: ${String(result.reason?.message ?? result.reason)}`);
  }
  if (!tags.length) {
    errors.push(...failures);
    return '';
  }
  tags.sort((a, b) => {
    const cmp = compareVersions(a, b);
    return Number.isNaN(cmp) ? 0 : cmp;
  });
  return tags[tags.length - 1];
}

/** SnowLuma：先问它自己的更新接口；没运行或接口不可用时退回发布页。 */
async function checkSnowlumaVersion(errors) {
  const current = localSnowlumaVersion();
  const fallbackUrl = `https://github.com/${SNOWLUMA_REPO}/releases`;
  if (runtime.snowluma.proc && isAlive(runtime.snowluma.pid)) {
    try {
      const password = await webuiPassword();
      if (password) {
        const { port, tls } = snowlumaWebui();
        const login = await snowlumaFetch(port, tls, '/api/login', { method: 'POST', body: { password } });
        const token = String(login?.token ?? '');
        if (token) {
          const info = await snowlumaFetch(port, tls, '/api/update/check?force=true', { token });
          if (info && !info.error && info.latest) {
            return {
              current: String(info.current ?? current),
              latest: String(info.latest),
              hasUpdate: Boolean(info.hasUpdate),
              url: String(info.htmlUrl || fallbackUrl),
              source: 'snowluma'
            };
          }
          if (info?.error) errors.push(`SnowLuma 自检：${info.error}`);
        } else {
          errors.push('SnowLuma 登录没有返回 token');
        }
      } else {
        errors.push('还没配置控制台密码，跳过 SnowLuma 自检');
      }
    } catch (error) {
      errors.push(`SnowLuma 自检失败：${String(error?.message ?? error)}`);
    }
  }
  const latest = await latestReleaseTag(SNOWLUMA_REPO, errors);
  return {
    current,
    latest: latest || null,
    hasUpdate: latest ? compareVersions(latest, current) > 0 : null,
    url: latest ? `https://github.com/${SNOWLUMA_REPO}/releases/tag/v${latest}` : fallbackUrl,
    source: 'page'
  };
}

/** qq-bridge：没有自检接口，读发布页最新标签和本地 package.json 比。 */
async function checkBridgeVersion(errors) {
  const current = localBridgeVersion();
  const latest = await latestReleaseTag(BRIDGE_REPO, errors);
  return {
    current,
    latest: latest || null,
    hasUpdate: latest ? compareVersions(latest, current) > 0 : null,
    url: latest ? `https://github.com/${BRIDGE_REPO}/releases/tag/v${latest}` : `https://github.com/${BRIDGE_REPO}/releases`,
    source: 'page'
  };
}

/** 本软件自己：版本写死在这里，最新版读本仓库的 releases。 */
async function checkLauncherVersion(errors) {
  const current = VERSION;
  const latest = await latestReleaseTag(LAUNCHER_REPO, errors);
  return {
    current,
    latest: latest || null,
    hasUpdate: latest ? compareVersions(latest, current) > 0 : null,
    url: latest ? `https://github.com/${LAUNCHER_REPO}/releases/tag/v${latest}` : `https://github.com/${LAUNCHER_REPO}/releases`,
    source: 'page'
  };
}

let updateCheckTask = null;
/** 三个服务并行查；同一时间只跑一次，界面连点也不会叠加请求。 */
function checkUpdates() {
  if (!updateCheckTask) {
    updateCheckTask = (async () => {
      const errors = [];
      const [snowluma, bridge, launcher] = await Promise.all([
        checkSnowlumaVersion(errors).catch((error) => ({ current: localSnowlumaVersion(), latest: null, hasUpdate: null, error: String(error?.message ?? error) })),
        checkBridgeVersion(errors).catch((error) => ({ current: localBridgeVersion(), latest: null, hasUpdate: null, error: String(error?.message ?? error) })),
        checkLauncherVersion(errors).catch((error) => ({ current: VERSION, latest: null, hasUpdate: null, error: String(error?.message ?? error) }))
      ]);
      return { ok: true, checkedAt: Date.now(), snowluma, bridge, launcher, errors };
    })().finally(() => { updateCheckTask = null; });
  }
  return updateCheckTask;
}

/** 读桥接的配置，拿到它探测 SnowLuma / 控制台用的端口（不硬编码）。 */
function bridgePorts() {
  try {
    const raw = fs.readFileSync(path.join(config.bridgeDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    const portOf = (url, fallback) => {
      try { return Number(new URL(url).port) || fallback; } catch { return fallback; }
    };
    const webui = snowlumaWebui();
    return {
      console: Number(cfg.consolePort) || 3100,
      onebotHttp: portOf(cfg.snowluma?.httpUrl, 3000),
      onebotWs: portOf(cfg.snowluma?.wsUrl, 3001),
      webui: webui.port,
      webuiTls: webui.tls,
      dshBaseUrl: String(cfg.dsh?.baseUrl ?? '')
    };
  } catch {
    const webui = snowlumaWebui();
    return {
      console: 3100,
      onebotHttp: 3000,
      onebotWs: 3001,
      webui: webui.port,
      webuiTls: webui.tls,
      dshBaseUrl: ''
    };
  }
}

/**
 * 按「命令行特征 + 可执行文件目录」找出某目录下所有匹配的进程。
 *
 * 为什么不只用 PID：SnowLuma 是**父子两层**（父进程 `index.mjs` 拉子进程再监听端口），
 * 只杀监听端口那个子进程，父进程会把端口让出去但不退出，下次启动容易撞上「端口被占」。
 * 桥接同理：start.bat 的 :loop 会重启 node，只杀子进程等于没杀。
 * 为什么还要看命令行：桥接用的是外面的 `E:\Node\node.exe` 跑 `"E:\qq bridge\src\bridge.js"`，
 * 它的 ExecutablePath 根本不在桥接目录里；只按 ExecutablePath 过滤会永远找不到桥接进程
 * （接管/停止都变成「没有在运行」）。命令行的脚本路径里带着目录，才找得到。
 */
async function pidsByCommandLine(exeDir, pattern) {
  const dir = String(exeDir ?? '').replace(/'/g, "''");
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='snowluma.exe'" |`,
    `  Where-Object { ($_.ExecutablePath -like '${dir}*' -or $_.CommandLine -like '*${dir}*') -and $_.CommandLine -match '${pattern}' } |`,
    `  ForEach-Object { $_.ProcessId }`
  // 必须用换行拼：PowerShell 的语句之间要换行或分号，用空格拼出来的是
  // `$ErrorActionPreference = 'SilentlyContinue' Get-CimInstance ...`，
  // 解析成语法错误、函数永远返回空数组，于是「按命令行找外部进程」静默失效。
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { timeout: 20000 });
  return r.stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * 按「命令行正则」找**守护脚本**类进程（cmd / wscript / cscript）。
 *
 * 为什么不限定进程名：这些脚本通常是 `cmd /c state\start-bridge-bg.cmd` 或
 * `cscript //nologo xxx.vbs`，杀掉 node 之后它们几秒内就会把桥接再拉起来，
 * 接管会永远卡在「外部运行」。只认这三个宿主进程名，避免误伤命令行里
 * 恰好含这些字样的普通程序（包括启动台自己）。
 */
async function pidsByCommandLineRegex(pattern) {
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='wscript.exe' OR Name='cscript.exe'" |`,
    `  Where-Object { $_.CommandLine -match '${pattern}' } |`,
    `  ForEach-Object { $_.ProcessId }`
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { timeout: 20000 });
  return r.stdout.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

async function killTree(pid, { force = true } = {}) {
  if (!pid) return { ok: false, error: '没有 PID' };
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  const r = await execFileAsync('taskkill', args);
  return { ok: r.ok, error: r.ok ? null : r.stdout.trim() || r.error?.message };
}

/**
 * 跟随一个日志文件（子进程的 stdout/stderr 直接重定向进这个文件）。
 *
 * 为什么不是用 pipe 接子进程输出 —— 这是踩过的真实坑：
 *   子进程的 stdout 是一条管道，**父进程一死，读端就关了**，子进程下一次 console.log
 *   会拿到 EPIPE，Node 默认把它当未捕获错误直接退出。于是「重启启动台」= 顺手把
 *   正在跑的桥接也杀了，而用户看到的只是「桥接莫名其妙没了」。
 *   改成写文件后，子进程持有的是普通文件句柄，父进程死不死都影响不到它；
 *   启动台再起来时还能从文件里把上次的日志读回来。
 */
class LogTail {
  constructor(file, onLine) {
    this.file = file;
    this.onLine = onLine;
    this.offset = 0;
    this.pending = '';
    this.decoder = new TextDecoder('utf-8');
    this.timer = null;
  }

  start() {
    this.stop();
    try { this.offset = fs.statSync(this.file).size; } catch { this.offset = 0; }
    this.timer = setInterval(() => this.pump(), 350);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pump() {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.offset) { // 文件被截断（清空/重建）：从头读，避免读不到还乱跳
      this.offset = 0;
      this.pending = '';
      this.decoder = new TextDecoder('utf-8');
    }
    if (size === this.offset) return;
    let chunk;
    try {
      const fd = fs.openSync(this.file, 'r');
      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, this.offset);
      fs.closeSync(fd);
      chunk = buffer;
    } catch {
      return;
    }
    this.offset = size;
    const text = this.pending + this.decoder.decode(chunk, { stream: true });
    const parts = text.split(/\r?\n/);
    this.pending = parts.pop() ?? '';
    for (const line of parts) this.onLine(line);
  }
}

const tails = { snowluma: null, bridge: null };

function logFilePath(id) {
  return path.join(APP_DIR, 'logs', `${id}.log`);
}

/** 外部实例的「上次确认过的 PID」，用来扛住 netstat 偶尔抽风导致的界面闪烁。 */
const externalCache = { snowluma: null, bridge: null };

async function startService(id) {
  const svc = SERVICES[id];
  const rt = runtime[id];
  if (!svc || !rt) return { ok: false, error: `未知服务 ${id}` };
  // 残留状态自愈：进程其实已经没了、退出事件却没派发（见过：taskkill /T 先杀了宿主、
  // hidehost 换手、Windows 丢事件），rt.proc / stopping 就会一直挂着旧值，
  // 表现就是「启动不了」——先把死进程的状态清干净再判断。
  if (rt.proc && !isAlive(rt.pid)) {
    rt.proc = null;
    rt.pid = null;
    rt.stopping = false;
    rt.startedAt = 0;
  }
  if (rt.proc && isAlive(rt.pid)) return { ok: false, error: `${svc.label} 已在运行（PID ${rt.pid}）` };
  const external = await detectExternal(id);
  // port-open 只说明端口上有人，未必是它（可能是别的程序占着），所以这一层不挡启动。
  if (external.running && external.source !== 'port-open') {
    return { ok: false, error: `${svc.label} 已在运行（外部启动，PID ${external.pid}）。先点「停止」接管它。` };
  }
  const dir = dirOf(id);
  if (!configValidFor(id)) return { ok: false, error: `${svc.label} 的目录没绑定好，请先在设置里选目录` };

  const { node, args, display } = svc.resolveCommand(dir);
  const cmdText = display || `${node} ${args.join(' ')}`;
  const logFile = logFilePath(id);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // 每次启动清空本轮日志：区分「这次运行的输出」和「上次残留」，也避免文件无限长大。
  fs.writeFileSync(logFile, `===== ${new Date().toLocaleString()} 启动 ${svc.label}：${cmdText} =====\n`, 'utf8');
  pushLine(id, `▶ 启动 ${svc.label}：${cmdText}`);

  let fd;
  try {
    fd = fs.openSync(logFile, 'a');
  } catch (error) {
    return { ok: false, error: `打不开日志文件：${error?.message ?? error}` };
  }
  let child;
  try {
    child = spawn(node, args, {
      cwd: dir,
      env: svc.env(dir),
      windowsHide: true,
      // detached 是必须的，不是「顺带」：不加它，子进程会**挂在这条控制台上**，
      // 父进程一退出、控制台被销毁，系统就给子进程发 CTRL_CLOSE_EVENT，它当场死掉
      // —— 表现就是「重启启动台顺手把桥接杀了」，而且不留任何错误日志。
      // 实测：同样参数下 detached=false 必死，detached=true 必活。
      detached: true,
      stdio: ['ignore', fd, fd]
    });
  } catch (error) {
    fs.closeSync(fd);
    pushLine(id, `✖ 启动失败：${error?.message ?? error}`);
    return { ok: false, error: String(error?.message ?? error) };
  }
  fs.closeSync(fd); // 子进程已拿到自己的句柄，父进程这份必须关掉，否则文件永远删不掉/截不断
  child.unref(); // 别让启动台的退出与否被「子进程还活着」拖住
  rt.proc = child;
  rt.pid = child.pid;
  rt.startedAt = Date.now();
  rt.stopping = false;
  rt.wanted = true;
  rt.lastExitCode = null;
  tails[id]?.stop();
  tails[id] = new LogTail(logFile, (line) => pushLine(id, line));
  tails[id].start();
  bindLifecycle(id, child);
  // SnowLuma 起来之后自动把机器人账号的 hook 加载上（否则 OneBot 端口不会监听）。
  if (id === 'snowluma') scheduleHookEnsure('启动');
  broadcastState();
  return { ok: true, pid: child.pid };
}

/** 只处理生命周期事件（输出已经由 LogTail 从文件里读了，这里不再碰 stdout）。 */
function bindLifecycle(id, child) {
  const label = SERVICES[id].label;
  child.once('error', (error) => pushLine(id, `✖ ${label} 进程错误：${error?.message ?? error}`));
  child.once('exit', (code, signal) => {
    const rt = runtime[id];
    const wasStopping = rt.stopping;
    rt.proc = null;
    rt.pid = null;
    rt.lastExitCode = code;
    rt.startedAt = 0;
    // 进程已经没了，就不存在「正在停止」了。以前只在外部实例分支复位 stopping，
    // 自有进程停完 stopping 会永远停在 true（界面上启动/停止/重启一起变灰）。
    rt.stopping = false;
    // 退出前把文件里剩下的几行冲出来，否则最后一条错误信息会看不到。
    setTimeout(() => { tails[id]?.pump(); tails[id]?.stop(); }, 200);
    pushLine(id, `■ ${label} 已退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`);
    broadcastState();
    // 自动重启：只对「本启动台启动、且用户没点停止」的服务生效，并做 3 秒退避。
    if (!wasStopping && rt.wanted && config.autoRestart) {
      rt.restarts += 1;
      pushLine(id, `↻ ${label} 意外退出，3 秒后自动重启（第 ${rt.restarts} 次）`);
      setTimeout(() => {
        if (rt.wanted && !isAlive(rt.pid)) void startService(id);
      }, 3000);
    }
  });
}

async function stopService(id) {
  const rt = runtime[id];
  const svc = SERVICES[id];
  if (!rt || !svc) return { ok: false, error: `未知服务 ${id}` };
  rt.wanted = false;
  // 进程已经没了但状态没清（退出事件丢了）：先自愈，别把它当成「外部实例」再找一遍。
  if (rt.proc && !isAlive(rt.pid)) {
    rt.proc = null;
    rt.pid = null;
    rt.stopping = false;
    rt.startedAt = 0;
  }
  if (rt.proc && isAlive(rt.pid)) {
    const pid = rt.pid;
    rt.stopping = true;
    pushLine(id, `⏹ 正在停止 ${svc.label}（PID ${pid}）…`);
    const r = await killTree(pid);
    if (!r.ok) pushLine(id, `   结束进程失败：${r.error}`);
    // 等它真的消失再收尾：只依赖 'exit' 事件不够——事件偶尔会丢，
    // stopping 就会永远卡在 true，界面上启动/停止/重启全灰，只能重启启动台。
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (isAlive(pid)) {
      // 进程还在：保持 stopping=true（确实还在停），但把失败原因报出去。
      broadcastState();
      return { ok: false, error: `${svc.label} 进程没有退出（PID ${pid}），请稍后再试` };
    }
    rt.proc = null;
    rt.pid = null;
    rt.stopping = false;
    rt.startedAt = 0;
    invalidateExternalHint(id);
    broadcastState();
    return { ok: true };
  }
  // 不是本启动台启动的：按「命令行 + 目录」找出整族进程再收掉，实现「接管外部实例」。
  const external = await detectExternal(id);
  const dir = dirOf(id);
  const pattern = id === 'snowluma' ? 'index\\.mjs' : 'bridge\\.js';
  const pids = await pidsByCommandLine(dir, pattern);
  // 外部探测给的 PID 也要核对过命令行才敢杀：它可能来自过期的锁文件（PID 被系统复用），
  // 照着杀就等于杀掉一个无关进程。
  const trustedExternal = external.pid && await pidMatches(external.pid, dir, pattern) ? [external.pid] : [];
  const targets = [...new Set([...trustedExternal, ...pids])];
  if (targets.length === 0) {
    rt.stopping = false; // 没东西可停，别把上一轮的「停止中」留在状态里
    return { ok: false, error: `${svc.label} 没有在运行` };
  }
  rt.stopping = true;
  pushLine(id, `⏹ 正在停止外部 ${svc.label}（PID ${targets.join(', ')}）…`);
  for (const pid of targets) {
    const r = await killTree(pid);
    if (!r.ok) pushLine(id, `   结束 PID ${pid} 失败：${r.error}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
  rt.stopping = false;
  invalidateExternalHint(id);
  broadcastState();
  return { ok: true };
}

/**
 * 接管：把「外面启动的」SnowLuma / qq-bridge 收归启动台管理。
 *
 * 顺序是踩出来的，不能随便换：
 *   ① 先掐守护脚本（start-bridge-bg.cmd / restart.bat 之类）：它们几秒内就会把
 *      桥接重新拉起来，不先掐掉，下面「等端口空」永远等不到，接管永远卡在「外部运行」；
 *   ② 先停 bridge 再停 snowluma：桥接会疯狂重连一个正在死的 SnowLuma，顺序反了先刷一屏 1006；
 *   ③ 等 3000 / 3001 / 3100 真的空出来（端口释放有延迟）；
 *   ④ 起 SnowLuma → 等 OneBot HTTP 通（最多 40 秒）→ 起 bridge。
 *      SnowLuma 还没登录 QQ 时 3000 不会开，这时仍然把 bridge 起起来（它会自己重连），
 *      结果里注明「没等到 OneBot 端口」，避免用户以为接管失败。
 */
async function adoptServices() {
  const ports = bridgePorts();
  const steps = [];
  // 只认 cmd / wscript / cscript 宿主，避免误伤命令行里恰好含这些字样的进程。
  const guards = await pidsByCommandLineRegex('start-bridge-bg|start-bridge-hidden|restart\\.bat|start\\.bat')
    .catch(() => []);
  // 服务已经全由启动台管着、外面也没有实例时，接管无事可做：
  // 直接返回，别把好好的服务停一遍再傻等 40 秒端口。
  const [bridgeExt, snowExt] = await Promise.all([detectExternal('bridge'), detectExternal('snowluma')]);
  const ownedBridge = Boolean(runtime.bridge.proc && isAlive(runtime.bridge.pid));
  const ownedSnow = Boolean(runtime.snowluma.proc && isAlive(runtime.snowluma.pid));
  if (guards.length === 0 && !bridgeExt.running && !snowExt.running && !ownedBridge && !ownedSnow) {
    return { ok: true, onebotReady: false, steps: [], notes: ['没有发现运行中的服务，点「一键启动」即可'] };
  }
  if (guards.length === 0 && !bridgeExt.running && !snowExt.running && (ownedBridge || ownedSnow)) {
    const onebotNow = await tcpProbe('127.0.0.1', ports.onebotHttp);
    pushLine('bridge', '⚙ 接管：没有发现外部实例，服务已由启动台管理');
    broadcastState();
    return {
      ok: true,
      onebotReady: onebotNow,
      steps: [{ step: 'nothing-to-adopt', bridge: ownedBridge, snowluma: ownedSnow }],
      notes: ['没有发现外部启动的实例，当前服务已由启动台管理']
    };
  }
  for (const pid of guards) {
    const r = await killTree(pid);
    steps.push({ step: 'guard', pid, ok: r.ok });
    pushLine('bridge', `⚙ 结束守护脚本 PID ${pid}${r.ok ? '' : `（失败：${r.error}）`}`);
  }
  const bridgeStop = await stopService('bridge');
  steps.push({ step: 'stop-bridge', ok: bridgeStop.ok });
  const snowStop = await stopService('snowluma');
  steps.push({ step: 'stop-snowluma', ok: snowStop.ok });

  const closedHttp = await waitPortClosed(ports.onebotHttp);
  const closedWs = await waitPortClosed(ports.onebotWs);
  const closedConsole = await waitPortClosed(ports.console);
  steps.push({ step: 'wait-closed', http: closedHttp, ws: closedWs, console: closedConsole });

  const snowStart = await startService('snowluma');
  steps.push({ step: 'start-snowluma', ok: snowStart.ok });
  const onebotReady = snowStart.ok ? await waitPortOpen(ports.onebotHttp, 40000) : false;
  steps.push({ step: 'wait-onebot', ok: onebotReady, port: ports.onebotHttp });
  const bridgeStart = await startService('bridge');
  steps.push({ step: 'start-bridge', ok: bridgeStart.ok });

  const notes = [];
  if (!onebotReady) notes.push(`${ports.onebotHttp} 端口没等到（SnowLuma 可能还没登录 QQ），桥接会自己重连`);
  if (!snowStart.ok) notes.push(`SnowLuma 启动失败：${snowStart.error || '看日志'}`);
  if (!bridgeStart.ok) notes.push(`桥接启动失败：${bridgeStart.error || '看日志'}`);
  const ok = Boolean(snowStart.ok && bridgeStart.ok);
  pushLine('bridge', `⚙ 接管完成：SnowLuma=${snowStart.ok ? '已接管' : '失败'}，桥接=${bridgeStart.ok ? '已接管' : '失败'}`);
  broadcastState();
  return { ok, onebotReady, steps, notes };
}

/** 外部实例探测：既看端口，也看锁文件，避免「端口被别的程序占了」被误判成桥接在跑。 */
/**
 * 判断「这个服务是不是被别处启动着」。
 *
 * 三层回退，因为每一种单独用都有洞：netstat 偶尔拿不到 PID（无输出/超时）、锁文件可能过期、
 * 端口可能被别的程序占着。这里先用便宜的（锁文件/端口→PID），再退到命令行匹配，最后用
 * 「端口能不能连上」兜底 —— 兜底那层标 source='port-open'、pid=null，界面上显示「PID 未知」，
 * 并且**允许启动**（否则端口被别的程序占着时，用户会卡在「显示在跑但起不来」）。
 */
async function detectExternal(id) {
  const cached = externalCache[id];
  if (cached?.pid && Date.now() - cached.at < 30000 && isAlive(cached.pid)) {
    return { running: true, pid: cached.pid, source: 'cache' };
  }
  const ports = bridgePorts();
  const remember = (pid) => {
    externalCache[id] = { pid, at: Date.now() };
    return { running: true, pid, source: 'port' };
  };
  if (id === 'bridge') {
    const lockPid = bridgeLockPid();
    // 锁文件里的 PID 必须核对过命令行才算数：锁不会随进程退出而清，PID 又会被系统复用。
    if (lockPid && isAlive(lockPid) && await pidMatches(lockPid, config.bridgeDir, 'bridge\\.js')) return remember(lockPid);
    const byPort = await listenerPid(ports.console);
    if (byPort) return remember(byPort);
    const byCmd = await pidsByCommandLine(config.bridgeDir, 'bridge\\.js');
    if (byCmd.length) return remember(byCmd[0]);
    if (await tcpProbe('127.0.0.1', ports.console)) return { running: true, pid: null, source: 'port-open' };
    return { running: false, pid: null };
  }
  const byPort = await listenerPid(ports.onebotHttp);
  if (byPort) return remember(byPort);
  const byCmd = await pidsByCommandLine(config.snowlumaDir, 'index\\.mjs');
  if (byCmd.length) return remember(byCmd[0]);
  if (await tcpProbe('127.0.0.1', ports.onebotHttp)) return { running: true, pid: null, source: 'port-open' };
  return { running: false, pid: null };
}

// /api/state 被界面每 5 秒轮询、托盘每 3 秒读一次。detectExternal 要起 PowerShell 扫进程，
// 一次要 1.5–2 秒；如果每次都 await，界面点开设置、切换页签都会被拖住（2026-10-26 实测）。
// 所以外部实例探测改成「先用上次结果、后台刷新」：快照立即返回，刷新在后台跑，失败保留旧值。
const externalHint = {
  bridge: { at: 0, value: null },
  snowluma: { at: 0, value: null }
};
const EXTERNAL_TTL_MS = 20000;
let externalRefreshTask = null;

function refreshExternalAsync() {
  if (externalRefreshTask) return externalRefreshTask;
  const now = Date.now();
  const stale = now - externalHint.bridge.at > EXTERNAL_TTL_MS || now - externalHint.snowluma.at > EXTERNAL_TTL_MS;
  if (!stale) return null;
  externalRefreshTask = (async () => {
    try {
      const [bridge, snowluma] = await Promise.all([detectExternal('bridge'), detectExternal('snowluma')]);
      const at = Date.now();
      externalHint.bridge = { at, value: bridge };
      externalHint.snowluma = { at, value: snowluma };
    } catch { /* 探测失败就保留上一次结果 */ } finally {
      externalRefreshTask = null;
    }
  })();
  return externalRefreshTask;
}

// 停止/接管外部实例后立刻让缓存失效，否则界面最多 20 秒还显示「外部实例在跑」。
function invalidateExternalHint(id) {
  if (id === 'bridge') externalHint.bridge = { at: 0, value: null };
  else if (id === 'snowluma') externalHint.snowluma = { at: 0, value: null };
  else { externalHint.bridge = { at: 0, value: null }; externalHint.snowluma = { at: 0, value: null }; }
}

function configValidFor(id) {
  if (id === 'bridge') return fs.existsSync(path.join(config.bridgeDir, 'src', 'bridge.js'));
  const dir = config.snowlumaDir;
  if (!dir || !fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, 'index.mjs'))) return true;
  try { return fs.readdirSync(dir).some((f) => /^snowluma.*\.exe$/i.test(f)); } catch { return false; }
}

// ── 健康检查 ────────────────────────────────────────────────────────────────
const health = {
  dsh: { ok: false, baseUrl: '', checkedAt: 0, note: '' },
  snowlumaHttp: false,
  snowlumaWs: false,
  bridgeConsole: false,
  bridgeProcess: false,
  snowlumaProcess: false
};
let dshModuleByDir = null;
let dshLastScan = 0;

async function dshModule() {
  const dir = path.join(config.bridgeDir, 'src', 'dsh-discover.js');
  if (dshModuleByDir && dshModuleByDir.dir === dir) return dshModuleByDir.mod;
  if (!fs.existsSync(dir)) return null;
  try {
    const mod = await import(pathToFileURL(dir).href);
    dshModuleByDir = { dir, mod };
    return mod;
  } catch {
    return null;
  }
}

async function checkDsh() {
  const ports = bridgePorts();
  const mod = await dshModule();
  if (!mod) {
    // 兜底：有些版本/裁剪版的 qq-bridge 没有 src/dsh-discover.js。
    // 这时只探端口——DSH 的 `/` 返回 401（要 token），用 HTTP 判断会把「活着」误判成「死了」，
    // 所以这里只看 TCP 通不通，并注明「未做鉴权校验」。
    let port = 0;
    try { port = Number(new URL(ports.dshBaseUrl).port) || 0; } catch { /* 没有 baseUrl 就探不了 */ }
    const open = port ? await tcpProbe('127.0.0.1', port, 900) : false;
    health.dsh = {
      ok: open,
      baseUrl: open ? ports.dshBaseUrl : '',
      checkedAt: Date.now(),
      note: open ? '端口已开（未做鉴权校验）' : '找不到 dsh-discover.js，端口也不通'
    };
    return;
  }
  const candidates = [health.dsh.baseUrl, ports.dshBaseUrl].filter(Boolean);
  // 已知端点先探一下（快、无副作用）；不通且距上次扫描超过 15 秒才重新发现，避免每轮都跑 netstat。
  for (const base of candidates) {
    const r = await mod.probeDshBase(base, { timeoutMs: 900 });
    if (r.kind === 'dsh') {
      health.dsh = { ok: true, baseUrl: mod.normalizeBase(base), checkedAt: Date.now(), note: r.authenticated ? '已鉴权' : '' };
      return;
    }
  }
  if (Date.now() - dshLastScan < 15000) {
    health.dsh = { ok: false, baseUrl: health.dsh.baseUrl, checkedAt: Date.now(), note: '刚刚扫过，稍后重试' };
    return;
  }
  dshLastScan = Date.now();
  const found = await mod.discoverDshBaseUrl({ candidates, probeTimeoutMs: 900 });
  health.dsh = {
    ok: Boolean(found.baseUrl),
    baseUrl: found.baseUrl || '',
    checkedAt: Date.now(),
    note: found.source === 'scan' ? '自动发现' : found.baseUrl ? '' : '未找到'
  };
}

async function pollHealth() {
  const ports = bridgePorts();
  const [httpOk, wsOk, consoleOk] = await Promise.all([
    tcpProbe('127.0.0.1', ports.onebotHttp),
    tcpProbe('127.0.0.1', ports.onebotWs),
    tcpProbe('127.0.0.1', ports.console)
  ]);
  health.snowlumaHttp = httpOk;
  health.snowlumaWs = wsOk;
  health.bridgeConsole = consoleOk;
  health.bridgeProcess = Boolean(runtime.bridge.proc && isAlive(runtime.bridge.pid));
  health.snowlumaProcess = Boolean(runtime.snowluma.proc && isAlive(runtime.snowluma.pid));
  await checkDsh();
}

// ── 状态快照 ────────────────────────────────────────────────────────────────
function serviceSnapshot(id) {
  const rt = runtime[id];
  const running = Boolean(rt.proc && isAlive(rt.pid));
  return {
    id,
    label: SERVICES[id].label,
    dir: dirOf(id),
    running,
    pid: running ? rt.pid : null,
    startedAt: rt.startedAt || 0,
    uptimeMs: running && rt.startedAt ? Date.now() - rt.startedAt : 0,
    restarts: rt.restarts,
    lastExitCode: rt.lastExitCode,
    stopping: rt.stopping
  };
}

function snapshot() {
  const external = { bridge: null };
  // 加密后的密码没必要发给前端（只给「有没有配」这个事实）。
  const { webuiPasswordEnc, ...safeConfig } = config;
  return {
    ok: true,
    version: VERSION,
    config: { ...safeConfig, webuiPasswordConfigured: Boolean(webuiPasswordEnc) },
    services: { snowluma: serviceSnapshot('snowluma'), bridge: serviceSnapshot('bridge') },
    health: { ...health },
    ports: bridgePorts(),
    hook: { uins: hookTargets(), configured: Boolean(webuiPasswordEnc), loading: Boolean(hookTask) },
    seqs: { ...seqs },
    external
  };
}

/** 外部实例的探测是异步的（要起 PowerShell），所以单独走一个异步快照给 UI 用。
 *  这里不 await 探测：立即返回缓存结果，刷新在后台跑——否则 /api/state 要 1.5–2 秒，
 *  界面打开设置、切换页签都会被拖住。 */
async function snapshotAsync() {
  const base = snapshot();
  refreshExternalAsync();
  const bridgeExt = externalHint.bridge.value;
  const snowExt = externalHint.snowluma.value;
  base.services.bridge.external = base.services.bridge.running || !bridgeExt || !bridgeExt.running ? null : bridgeExt;
  base.services.snowluma.external = base.services.snowluma.running || !snowExt || !snowExt.running ? null : snowExt;
  return base;
}

// ── 基础设置（开机自启等） ─────────────────────────────────────────────────
// 开机自启管理的是安装时创建的那个 Startup 快捷方式（带 -NoWindow，进托盘不弹窗），
// 和安装器用同一条路径，避免出现「设置里关了、下次开机又出来」的两份真相。
const STARTUP_LNK = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'SnowBridge Launcher.lnk'
);

function startupShortcutExists() {
  try {
    return fs.existsSync(STARTUP_LNK);
  } catch {
    return false;
  }
}

function settingsSnapshot() {
  return {
    ok: true,
    version: VERSION,
    autoStartAll: Boolean(config.autoStartAll),
    autoRestart: Boolean(config.autoRestart),
    startWithWindows: startupShortcutExists(),
    installDir: path.resolve(HERE, '..'),
    dataDir: APP_DIR,
    startupShortcut: STARTUP_LNK,
    snowlumaDir: config.snowlumaDir,
    bridgeDir: config.bridgeDir
  };
}

async function setStartWithWindows(enabled) {
  if (!enabled) {
    try {
      fs.rmSync(STARTUP_LNK, { force: true });
    } catch (error) {
      throw new Error(`删除开机自启快捷方式失败：${error?.message ?? error}`);
    }
    return false;
  }
  const entry = path.join(HERE, '..', 'SnowBridge Launcher.exe');
  if (!fs.existsSync(entry)) throw new Error(`找不到入口程序：${entry}`);
  const q = (s) => String(s).replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut('${q(STARTUP_LNK)}')`,
    `$sc.TargetPath = '${q(entry)}'`,
    "$sc.Arguments = '-NoWindow'",
    `$sc.WorkingDirectory = '${q(path.resolve(HERE, '..'))}'`,
    `$sc.IconLocation = '${q(entry)},0'`,
    "$sc.Description = 'SnowBridge Launcher（开机自启，进托盘）'",
    '$sc.WindowStyle = 7',
    '$sc.Save()'
  ].join('\n');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { timeout: 20000 });
  if (!startupShortcutExists()) throw new Error('快捷方式没有创建成功（可能被安全软件拦截）');
  return true;
}

async function applySettings(patch = {}) {
  const errors = [];
  if (Object.prototype.hasOwnProperty.call(patch, 'startWithWindows')) {
    if (typeof patch.startWithWindows !== 'boolean') {
      errors.push('startWithWindows 必须是布尔值');
    } else {
      try {
        await setStartWithWindows(patch.startWithWindows);
      } catch (error) {
        errors.push(String(error?.message ?? error));
      }
    }
  }
  const cfgPatch = {};
  for (const key of ['autoStartAll', 'autoRestart']) {
    if (typeof patch[key] === 'boolean') cfgPatch[key] = patch[key];
  }
  if (Object.keys(cfgPatch).length > 0) {
    const saved = saveConfig(cfgPatch);
    if (!saved.ok) errors.push(...(saved.errors ?? ['配置保存失败']));
  }
  if (errors.length > 0) return { ok: false, errors };
  return settingsSnapshot();
}

// ── 记忆（只读） ────────────────────────────────────────────────────────────
// 日记和便签都是她自己的东西：界面上只展示、不提供编辑入口。
// （这段文字是她换会话后唯一的连续感来源，能编辑就等于随时可能被手滑覆盖。）
function parseDiaryMd(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const m = /^-\s+(\d{1,2}:\d{2})\s+(.*)$/.exec(line.trim());
    if (m) entries.push({ stamp: m[1], text: m[2] });
  }
  return entries;
}

/** 旧版桥接的日记格式：`## 时间` 开头、`---` 分隔块。 */
function parseDiaryTxt(text) {
  const entries = [];
  for (const block of text.split(/^---\s*$/m).map((s) => s.trim()).filter(Boolean)) {
    const lines = block.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const head = lines[0].replace(/^#+\s*/, '');
    const body = lines.slice(1).join('\n').trim();
    entries.push(body ? { stamp: head, text: body } : { stamp: '', text: head });
  }
  return entries;
}

/** 读桥接的 fs 沙箱根目录（日记就在它下面的 diary\ 里，路径每台机器不同，不能写死）。 */
async function bridgeFsRoot() {
  try {
    const raw = await fsp.readFile(path.join(config.bridgeDir, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return String(cfg?.fs?.root ?? '');
  } catch {
    return '';
  }
}

async function readMemory() {
  // 全局便签：state\memo.json（旧版/另一些桥接有，这份没有就显示空）。
  const memo = { ok: true, entries: [] };
  const memoFile = path.join(config.bridgeDir, 'state', 'memo.json');
  try {
    const raw = JSON.parse((await fsp.readFile(memoFile, 'utf8')).replace(/^\uFEFF/, ''));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
    memo.entries = list
      .map((item) => ({
        id: String(item?.id ?? ''),
        text: String(item?.text ?? ''),
        from: String(item?.from ?? ''),
        at: Number(item?.at) || 0
      }))
      .filter((item) => item.text);
  } catch { /* 没有便签文件不算错误 */ }

  // 日记两个可能的家：新版在 fs.root\diary\*.md，旧版在 state\diary\*.txt。
  const dirs = [];
  const fsRoot = await bridgeFsRoot();
  if (fsRoot) dirs.push({ dir: path.join(fsRoot, 'diary'), ext: '.md', format: 'md' });
  dirs.push({ dir: path.join(config.bridgeDir, 'state', 'diary'), ext: '.txt', format: 'txt' });

  const diaries = [];
  for (const { dir, ext, format } of dirs) {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(ext)) continue;
      const file = path.join(dir, name);
      let stat;
      let content;
      try {
        stat = await fsp.stat(file);
        content = await fsp.readFile(file, 'utf8');
      } catch { continue; }
      const text = content.replace(/\r/g, '').slice(0, 30000);
      diaries.push({
        key: name.slice(0, -ext.length),
        updatedAt: stat.mtimeMs,
        content: text,
        entries: format === 'txt' ? parseDiaryTxt(text) : parseDiaryMd(text)
      });
    }
  }
  diaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return { ok: true, memo, diary: { ok: true, diaries } };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 256 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

/** 原生「选择文件夹」对话框（浏览器拿不到真实路径，只能借 PowerShell 的 WinForms）。 */
async function pickDirectory({ title, initial }) {
  const safeTitle = String(title ?? '选择文件夹').replace(/'/g, "''");
  const safeInitial = String(initial ?? '').replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.WindowState = "Minimized"',
    '$owner.Show() | Out-Null',
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dlg.Description = '${safeTitle}'`,
    safeInitial ? `$dlg.SelectedPath = '${safeInitial}'` : '',
    '$dlg.ShowNewFolderButton = $false',
    'if ($dlg.ShowDialog($owner) -eq "OK") { [Console]::Out.Write($dlg.SelectedPath) }',
    '$owner.Close()'
  ].filter(Boolean).join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const powershell = fs.existsSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    : 'powershell.exe';
  const r = await execFileAsync(powershell, ['-NoProfile', '-STA', '-EncodedCommand', encoded], { timeout: 300000 });
  return { ok: true, path: r.stdout.trim() };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await fsp.readFile(UI_FILE, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    // 图标：Edge 的 --app 窗口会拿页面 favicon 当窗口图标/任务栏图标，
    // 所以这里把托盘用的同一份 icon.png / icon.ico 露出去，三处图标才不会各长各样。
    if (req.method === 'GET' && (url.pathname === '/icon.png' || url.pathname === '/favicon.ico' || url.pathname === '/icon.ico')) {
      const file = url.pathname === '/icon.png' ? path.join(HERE, 'icon.png') : path.join(HERE, 'icon.ico');
      const type = file.endsWith('.png') ? 'image/png' : 'image/x-icon';
      try {
        const buf = await fsp.readFile(file);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
        res.end(buf);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('icon not found');
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      sendJson(res, { ok: true, name: 'qqbot-launcher', version: VERSION, pid: process.pid, port: actualPort });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, await snapshotAsync());
      return;
    }
    // 设置弹窗用：开关状态 + 路径信息（只读展示）。
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      sendJson(res, settingsSnapshot());
      return;
    }
    // 只读：把她的日记和便签给界面看；没有写接口，刻意如此。
    if (req.method === 'GET' && url.pathname === '/api/memory') {
      sendJson(res, await readMemory());
      return;
    }
    // 版本检查：SnowLuma 优先问它自己的更新接口（没运行就退回发布页），qq-bridge 读发布页；
    // 哪个源不通都只是把原因带回去，界面显示「无法检查」，不抛错。
    if (req.method === 'GET' && url.pathname === '/api/check-updates') {
      sendJson(res, await checkUpdates());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/log') {
      const svc = String(url.searchParams.get('svc') ?? '');
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const ring = rings[svc];
      if (!ring) { sendJson(res, { ok: false, error: '未知服务' }, 400); return; }
      sendJson(res, { ok: true, lines: ring.filter((l) => l.seq > since), last: seqs[svc] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      res.write(`data: ${JSON.stringify({ type: 'hello', seqs })}\n\n`);
      const timer = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 断开由 close 处理 */ }
      }, 15000);
      req.on('close', () => {
        clearInterval(timer);
        sseClients.delete(res);
      });
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      // 窗口「呼出」时（双击托盘 / 快捷方式）由 tray.ps1 调用：给所有打开的界面发一个
      // summon 事件，页面据此播放入场动画。窗口本身的置顶仍由 Native.Focus 负责。
      if (url.pathname === '/api/summon') {
        broadcast({ type: 'summon' });
        sendJson(res, { ok: true });
        return;
      }
      if (url.pathname === '/api/start') {
        const r = await startService(String(body.svc ?? ''));
        sendJson(res, r, r.ok ? 200 : 400);
        return;
      }
      if (url.pathname === '/api/stop') {
        const r = await stopService(String(body.svc ?? ''));
        sendJson(res, r, r.ok ? 200 : 400);
        return;
      }
      if (url.pathname === '/api/restart') {
        // 停完等半秒再起：端口从 TIME_WAIT 里放出来需要一点时间，抢跑会吃 EADDRINUSE。
        const svc = String(body.svc ?? '');
        // 重启 SnowLuma 时把启动台托管的桥接先停掉：否则桥接会对着正在死的 SnowLuma
        // 反复刷 code=1006 / token 自愈失败，看着像又坏了；等 OneBot 回来再按顺序拉起。
        const managedBridge = svc === 'snowluma' && runtime.bridge.proc && isAlive(runtime.bridge.pid);
        if (managedBridge) await stopService('bridge');
        await stopService(svc);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const r = await startService(svc);
        if (managedBridge) {
          if (r.ok && hookTargets().length > 0) {
            await Promise.race([ensureSnowlumaHook('重启'), new Promise((resolve) => setTimeout(resolve, 30000))]);
            await waitPortOpen(bridgePorts().onebotHttp, 5000);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          const rb = await startService('bridge');
          sendJson(res, { ok: r.ok && rb.ok, results: { snowluma: r, bridge: rb } });
          return;
        }
        sendJson(res, r, r.ok ? 200 : 400);
        return;
      }
      if (url.pathname === '/api/start-all') {
        const first = await startService('snowluma');
        // SnowLuma 先起，桥接要在它之后连 WS。配了「自动加载 hook」时，先等 hook 把
        // OneBot 3000/3001 带起来（最多 30 秒），这样桥接一起来就能连上，不会刷一串
        // code=1006；没配 hook、或者 QQ 还没登录等不到端口，也照样起桥接（它自己会重连），
        // 不能把「一键启动」一直卡住。
        if (first.ok && hookTargets().length > 0) {
          pushLine('snowluma', '⚙ 等 SnowLuma 的 OneBot 起来再启动桥接…');
          await Promise.race([ensureSnowlumaHook('一键启动'), new Promise((resolve) => setTimeout(resolve, 30000))]);
          await waitPortOpen(bridgePorts().onebotHttp, 5000);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const second = await startService('bridge');
        sendJson(res, { ok: first.ok || second.ok, results: { snowluma: first, bridge: second } });
        return;
      }
      if (url.pathname === '/api/stop-all') {
        const second = await stopService('bridge');
        const first = await stopService('snowluma');
        sendJson(res, { ok: true, results: { snowluma: first, bridge: second } });
        return;
      }
      // 接管外面启动的实例：先掐守护脚本 → 停 bridge → 停 snowluma → 等端口空 → 重新拉起。
      if (url.pathname === '/api/adopt') {
        sendJson(res, await adoptServices());
        return;
      }
      // 配置「自动加载 hook」：机器人 QQ 号 + SnowLuma 控制台密码（DPAPI 加密存储）。
      if (url.pathname === '/api/hook-config') {
        const uins = Array.isArray(body.uins) ? body.uins : [];
        const password = typeof body.password === 'string' ? body.password.trim() : '';
        if (uins.length === 0) { sendJson(res, { ok: false, error: '至少要填一个机器人 QQ 号' }, 400); return; }
        if (password) {
          const login = await verifyWebuiLogin(password);
          // 密码错就明确拒绝；SnowLuma 没起来（连不上）时允许先存下来，等它起来再验证。
          if (!login.ok && String(login.error).includes('密码错误')) {
            sendJson(res, { ok: false, error: `控制台密码验证失败：${login.error}` }, 400);
            return;
          }
          if (!login.ok) pushLine('snowluma', `⚙ SnowLuma hook：密码已保存，但暂时没法验证（${login.error}），等 SnowLuma 起来后再试`);
        }
        let enc = '';
        if (password) {
          try {
            enc = await dpapiEncrypt(password);
          } catch (error) {
            sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
            return;
          }
        }
        saveHookConfig({ uins, webuiPasswordEnc: enc });
        void ensureSnowlumaHook('手动配置');
        sendJson(res, { ok: true, hookUins: hookTargets(), webuiPasswordConfigured: Boolean(config.webuiPasswordEnc) });
        return;
      }
      // 立刻重跑一次自动加载（「等 QQ 登录」超时之后用的）。
      if (url.pathname === '/api/hook-load') {
        void ensureSnowlumaHook('手动触发');
        sendJson(res, { ok: true, uins: hookTargets(), configured: Boolean(config.webuiPasswordEnc) });
        return;
      }
      if (url.pathname === '/api/config') {
        sendJson(res, saveConfig(body));
        return;
      }
      if (url.pathname === '/api/settings') {
        const result = await applySettings(body);
        sendJson(res, result, result.ok ? 200 : 400);
        return;
      }
      if (url.pathname === '/api/pick-dir') {
        sendJson(res, await pickDirectory({ title: body.title, initial: body.initial }));
        return;
      }
      if (url.pathname === '/api/open') {
        const target = String(body.url ?? '');
        // 只允许打开本机这几个已知界面，避免被当成任意 URL 打开器。
        const ports = bridgePorts();
        // SnowLuma 的 WebUI 用 http(s)://127.0.0.1:<webuiPort>，其它两个是本地控制台。
        const webuiUrl = `${ports.webuiTls ? 'https' : 'http'}://127.0.0.1:${ports.webui}`;
        const allowed = [
          `http://127.0.0.1:${ports.console}/`,
          `http://127.0.0.1:${ports.console}`,
          `${webuiUrl}/`,
          webuiUrl,
          `http://127.0.0.1:${ports.onebotHttp}/`
        ];
        if (!allowed.some((a) => target.startsWith(a))) { sendJson(res, { ok: false, error: '只允许打开本机控制台' }, 400); return; }
        await execFileAsync('cmd', ['/c', 'start', '', target]);
        sendJson(res, { ok: true });
        return;
      }
      if (url.pathname === '/api/clear-log') {
        const svc = String(body.svc ?? '');
        if (rings[svc]) rings[svc] = [];
        sendJson(res, { ok: true });
        return;
      }
      if (url.pathname === '/api/quit') {
        // 「退出」= 结束所有进程，所以默认就停服务；只有显式传 stopAll:false 才保留服务。
        // （早期版本默认不停，导致托盘右键「退出（结束所有进程）」其实留着两个服务在跑。）
        if (body.stopAll !== false) {
          await stopService('bridge');
          await stopService('snowluma');
        }
        sendJson(res, { ok: true });
        setTimeout(() => process.exit(0), 300);
        return;
      }
      sendJson(res, { ok: false, error: '未知接口' }, 404);
      return;
    }
    sendJson(res, { ok: false, error: 'not found' }, 404);
  } catch (error) {
    sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
  }
});

// ── 启动 ────────────────────────────────────────────────────────────────────
let actualPort = 0;

/** 端口上是不是另一个「自己」（单实例判定；不能只看端口被占，那样会和别的程序撞）。 */
async function isAnotherLauncher(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(700) });
    const data = await res.json();
    return data?.name === 'qqbot-launcher' && data?.pid !== process.pid;
  } catch {
    return false;
  }
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 启动台重启后「接住」上一次自己启动的服务写在日志文件里的内容。
 * 服务本身没死（detached），只是没人看日志了；这里从文件末尾继续跟随，
 * 让用户看不到「重启了个界面，日志全空了」这种断档。
 */
function resumeExternalTails() {
  for (const id of ['snowluma', 'bridge']) {
    const file = logFilePath(id);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) continue; // 太旧的是历史残留，别误导
    if (tails[id]) continue;
    // 先把文件末尾一段读进环形缓冲，界面不至于一打开就是空白。
    try {
      const size = stat.size;
      const from = Math.max(0, size - 8000);
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      fs.closeSync(fd);
      for (const line of buffer.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) pushLine(id, line);
      }
    } catch { /* 读不到就只跟新行 */ }
    tails[id] = new LogTail(file, (line) => pushLine(id, line));
    tails[id].start();
    pushLine(id, `（接管：继续跟随 ${file}，内容可能来自上一次启动的实例）`);
  }
}

async function main() {
  ensureAppDir();
  const startPort = Number(process.env.LAUNCHER_PORT || config.port) || DEFAULT_PORT;
  // 单实例：端口被占时先问一句「是不是启动台自己」——是就安静退出，让 launch.mjs 去开窗口，
  // 而不是在 3211 上再起一个（两个界面同时管同一批进程，状态会互相覆盖）。
  if (await isAnotherLauncher(startPort)) {
    process.stdout.write(`ALREADY_RUNNING ${startPort}\n`);
    process.exit(0);
  }
  for (let i = 0; i < 12; i += 1) {
    const port = startPort + i;
    try {
      actualPort = await listenOn(port);
      break;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      process.stdout.write(`PORT_BUSY ${port}\n`);
    }
  }
  if (!actualPort) {
    console.error('没有可用端口，启动台退出');
    process.exit(3);
  }
  fs.writeFileSync(path.join(APP_DIR, 'launcher.pid'), String(process.pid), 'utf8');
  fs.writeFileSync(path.join(APP_DIR, 'launcher.port'), String(actualPort), 'utf8');
  pushLine('bridge', `启动台已就绪：http://127.0.0.1:${actualPort}（窗口关掉不影响服务，点「退出并停止」才全停）`);
  resumeExternalTails();

  // 预热外部实例探测：第一屏 /api/state 就能带上缓存结果，不用等 2 秒。
  refreshExternalAsync();

  // 打印就绪行，launch.mjs 用它来开窗口。
  process.stdout.write(`READY ${actualPort}\n`);

  // 后台轮询：每 3 秒刷新健康度并广播，UI 不需要自己算。
  setInterval(() => {
    void pollHealth().then(() => broadcastState()).catch(() => {});
  }, POLL_MS);
  void pollHealth().then(() => broadcastState()).catch(() => {});

  // 自动启动：等 DSH/端口探测第一轮完成再拉，避免刚起来就判定失败。
  if (config.autoStartAll) {
    setTimeout(() => {
      void (async () => {
        const bridgeExt = await detectExternal('bridge');
        if (!bridgeExt.running) {
          pushLine('bridge', '⚙ config.autoStartAll=true，自动启动服务…');
          await startService('snowluma');
          let waited = 0;
          while (waited < 60000) {
            if (await tcpProbe('127.0.0.1', bridgePorts().onebotHttp)) break;
            await new Promise((r) => setTimeout(r, 1000));
            waited += 1000;
          }
          await startService('bridge');
        }
      })();
    }, 2500);
  }

  // 退出时收拾干净：先把子进程杀掉，避免留下孤儿进程占着端口。
  const shutdown = () => {
    try { fs.rmSync(path.join(APP_DIR, 'launcher.pid'), { force: true }); } catch {}
    for (const id of ['bridge', 'snowluma']) {
      const rt = runtime[id];
      if (rt.proc && isAlive(rt.pid)) {
        try { void killTree(rt.pid); } catch {}
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('message', (msg) => { if (msg === 'shutdown') shutdown(); });
}

void main();
