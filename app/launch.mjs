// 启动台引导器：拉起身后的本地服务，再用 Edge 的「应用窗口」把它显示成一个独立程序。
//
// 单实例策略：
//   - 服务（server.mjs）是**独立常驻进程**，用 detached+unref 启动，引导器/窗口退出都不影响它；
//   - 再次双击快捷方式时，只要能探测到已有实例，就只开窗口、不重复起服务。
// 这样「关窗口 = 界面收起来、进程还在后台（托盘可见）」，「退出并停止 = 真结束」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.QQBOT_HOME || path.join(os.homedir(), 'AppData', 'Local', 'QQbot');
const SERVER = path.join(HERE, 'server.mjs');
const PORT_FILE = path.join(APP_DIR, 'launcher.port');
const DEFAULT_PORT = 3220;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function probePort(port) {
  return fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(700) })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      return data?.name === 'qqbot-launcher';
    })
    .catch(() => false);
}

async function findRunning() {
  const candidates = [];
  try {
    const saved = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
    if (Number.isInteger(saved) && saved > 0) candidates.push(saved);
  } catch { /* 没跑过 */ }
  for (let i = 0; i < 12; i += 1) candidates.push(DEFAULT_PORT + i);
  for (const port of [...new Set(candidates)]) {
    if (await probePort(port)) return port;
  }
  return 0;
}

function edgeExe() {
  const paths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft\\Edge\\Application\\msedge.exe')
  ];
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return '';
}

// 自建的无边框外壳（WebView2）：窗口、动画、置前、边缘缩放都由它做，
// 页面里再补标题栏拖动和窗口按钮。缺失就退回 Edge --app。
function hostExe() {
  for (const name of ['SnowBridgeHost.exe', 'SnowBridgeShell.exe']) {
    const p = path.join(HERE, name);
    try {
      if (fs.existsSync(p) && fs.existsSync(path.join(HERE, 'WebView2Loader.dll'))) return p;
    } catch { /* 忽略 */ }
  }
  return '';
}

function openWindow(port) {
  const url = `http://127.0.0.1:${port}/`;
  const host = hostExe();
  if (host) {
    try {
      spawn(host, [url], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return 'host';
    } catch { /* 宿主起不来就退回 Edge */ }
  }
  const edge = edgeExe();
  if (edge) {
    // --app：没有地址栏/标签页，看起来就是一个独立程序；尺寸按常见笔记本屏幕给。
    spawn(edge, [`--app=${url}`, '--window-size=1280,860'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return 'edge-app';
  }
  // 没有 Edge 就退回默认浏览器（会带地址栏，但功能一致）。
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return 'browser';
}

async function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: HERE,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, LAUNCHER_PORT: String(process.env.LAUNCHER_PORT || DEFAULT_PORT) }
  });
  child.unref();
  // 等它真的能应答（比睡固定秒数稳；冷启动 Node 大约 200~600ms）。
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (let i = 0; i < 12; i += 1) {
      if (await probePort(DEFAULT_PORT + i)) return DEFAULT_PORT + i;
    }
    await sleep(400);
  }
  return 0;
}

const existing = await findRunning();
const port = existing || await startServer();
if (!port) {
  process.stderr.write('启动台没能在 20 秒内就绪，请手动运行：node tools\\launcher\\server.mjs\n');
  process.exit(1);
}
const mode = openWindow(port);
process.stdout.write(`启动台已就绪：http://127.0.0.1:${port}/（${existing ? '复用已运行实例' : '新启动'}，窗口=${mode}）\n`);
