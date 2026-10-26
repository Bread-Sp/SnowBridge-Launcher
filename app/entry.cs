// SnowBridge Launcher 的图形入口：双击它 = 拉起托盘宿主（tray.ps1），不带控制台窗口。
// 便携版放在程序根目录（tray.ps1 在 app\ 下）；安装版放在 app\ 下（和 tray.ps1 同级），
// 两种位置都能找到。命令行参数原样转给 tray.ps1（开机自启快捷方式会传 -NoWindow）。
//
// 2026-10-26 性能改动：窗口不再等托盘（PowerShell 冷启动约 1 秒）才出现——
// 入口自己确认服务端、直接拉起无边框宿主，然后并行去起托盘（托盘只负责图标/菜单/退出）。
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("SnowBridge Launcher")]
[assembly: System.Reflection.AssemblyProduct("SnowBridge Launcher")]
[assembly: System.Reflection.AssemblyCompany("SnowBridge")]
[assembly: System.Reflection.AssemblyVersion("0.0.1.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.0.1.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.0.1")]

static class Program
{
    static string DataDir
    {
        get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QQbot"); }
    }

    [STAThread]
    static void Main(string[] args)
    {
        try
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            string[] candidates = new string[]
            {
                Path.Combine(baseDir, @"app\tray.ps1"),
                Path.Combine(baseDir, "tray.ps1")
            };
            string tray = null;
            foreach (string c in candidates) { if (File.Exists(c)) { tray = c; break; } }
            if (tray == null)
            {
                MessageBox.Show("找不到 tray.ps1，程序文件不完整。\n期望位置：\n" + string.Join("\n", candidates),
                    "SnowBridge Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            string appRoot = Path.GetDirectoryName(tray);

            bool quiet = false;
            foreach (string a in args) if (string.Equals(a, "-NoWindow", StringComparison.OrdinalIgnoreCase)) quiet = true;

            string[] trayArgs = args;
            if (!quiet)
            {
                // 快路径：入口自己把窗口拉起来，不把它压在 PowerShell 冷启动后面。
                int port = EnsureServer(appRoot);
                if (port > 0) OpenWindow(appRoot, port);
                trayArgs = AppendArg(args, "-NoWindow");
            }

            StartTray(tray, appRoot, trayArgs);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "SnowBridge Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static string[] AppendArg(string[] args, string extra)
    {
        string[] result = new string[args.Length + 1];
        Array.Copy(args, result, args.Length);
        result[args.Length] = extra;
        return result;
    }

    static int LauncherPort()
    {
        try
        {
            string file = Path.Combine(DataDir, "launcher.port");
            if (File.Exists(file))
            {
                int parsed;
                if (int.TryParse(File.ReadAllText(file).Trim(), out parsed)) return parsed;
            }
        }
        catch { }
        return 3220;
    }

    static bool PortOpen(int port)
    {
        try
        {
            using (TcpClient client = new TcpClient())
            {
                IAsyncResult ar = client.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(250)) return false;
                client.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    static string NodeExe(string appRoot)
    {
        string[] candidates = new string[]
        {
            @"E:\Node\node.exe",
            Path.Combine(appRoot, "node.exe"),
            "node.exe"
        };
        foreach (string c in candidates) { if (c == "node.exe" || File.Exists(c)) return c; }
        return "node.exe";
    }

    // 服务端已经在跑就直接返回端口；没在跑就拉起来并等它就绪（最多约 8 秒）。
    static int EnsureServer(string appRoot)
    {
        int port = LauncherPort();
        if (PortOpen(port)) return port;
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = NodeExe(appRoot),
                Arguments = "\"" + Path.Combine(appRoot, "server.mjs") + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = appRoot
            };
            Process.Start(psi);
        }
        catch { return 0; }
        for (int i = 0; i < 80; i++)
        {
            Thread.Sleep(100);
            port = LauncherPort();
            if (PortOpen(port)) return port;
        }
        return 0;
    }

    // 直接拉起 WebView2 宿主（有的话）；已经在跑就只写 summon.request 让它播呼出动画。
    static void OpenWindow(string appRoot, int port)
    {
        string host = Path.Combine(appRoot, "SnowBridgeHost.exe");
        if (!File.Exists(host)) return; // 没装宿主：交给托盘走 launch.mjs / Edge 回退
        bool running = false;
        try
        {
            running = Process.GetProcessesByName("SnowBridgeHost").Length > 0
                   || Process.GetProcessesByName("SnowBridgeShell").Length > 0;
        }
        catch { }
        if (running)
        {
            try { File.WriteAllText(Path.Combine(DataDir, "summon.request"), DateTime.UtcNow.Ticks.ToString()); } catch { }
            return;
        }
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = host,
                Arguments = "\"http://127.0.0.1:" + port + "/\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = appRoot
            };
            Process.Start(psi);
        }
        catch { }
    }

    static void StartTray(string tray, string appRoot, string[] args)
    {
        string ps = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
        if (!File.Exists(ps)) ps = "powershell.exe";
        var sb = new StringBuilder();
        sb.Append("-NoProfile -Sta -ExecutionPolicy Bypass -WindowStyle Hidden -File \"");
        sb.Append(tray);
        sb.Append("\"");
        foreach (string a in args) { sb.Append(" \"").Append(a).Append("\""); }
        var psi = new ProcessStartInfo
        {
            FileName = ps,
            Arguments = sb.ToString(),
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = appRoot
        };
        Process.Start(psi);
    }
}