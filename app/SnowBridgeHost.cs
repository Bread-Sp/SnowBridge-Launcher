using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class HostLog
{
    static readonly object Gate = new object();
    public static string PathFile = Pick("SNOWBRIDGE_HOST_LOG", System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QQbot", "host.log"));
    public static string Pick(string env, string fallback)
    {
        try { string v = Environment.GetEnvironmentVariable(env); if (!string.IsNullOrEmpty(v)) return v; } catch { }
        return fallback;
    }
    public static void Write(string text)
    {
        try
        {
            var dir = System.IO.Path.GetDirectoryName(PathFile);
            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
            lock (Gate)
            {
                File.AppendAllText(PathFile, DateTime.Now.ToString("HH:mm:ss.fff") + " " + text + Environment.NewLine);
            }
        }
        catch { }
    }
}

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        bool created;
        using (var mutex = new Mutex(true, "Local\\SnowBridgeShell", out created))
        {
            if (!created)
            {
                try { File.WriteAllText(System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QQbot", "summon.request"), DateTime.UtcNow.Ticks.ToString()); } catch { }
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string url = args.Length > 0 ? args[0] : "http://127.0.0.1:3220/";
            HostLog.Write("host start pid=" + Process.GetCurrentProcess().Id + " url=" + url);
            Application.Run(new ShellForm(url));
            HostLog.Write("host exit");
            GC.KeepAlive(mutex);
        }
    }
}

class ShellForm : Form
{
    const int WM_NCHITTEST = 0x0084;
    const int WM_NCLBUTTONDOWN = 0x00A1;
    const int HTCAPTION = 2;
    const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17, HTCLIENT = 1;
    const int ResizeBorder = 6;
    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    const int DWMWA_BORDER_COLOR = 34;

    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    WebView2 web;
    readonly string url;
    readonly string appDir;
    readonly string summonFile;
    readonly string exitFile;
    long lastSummonTicks;
    long lastExitTicks;
    bool exiting;
    System.Windows.Forms.Timer pollTimer;
    System.Windows.Forms.Timer animTimer;
    System.Windows.Forms.Timer pingTimer;
    int pingFails;
    bool quitting;
    bool animating;
    bool shown;
    bool maximized;
    Rectangle restoreBounds;
    int animStep;
    System.Windows.Forms.Timer navFallbackTimer;
    readonly Stopwatch navWatch = new Stopwatch();

    public ShellForm(string url)
    {
        this.url = url;
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        appDir = System.IO.Path.Combine(local, "QQbot");
        summonFile = System.IO.Path.Combine(appDir, "summon.request");
        exitFile = System.IO.Path.Combine(appDir, "exit.request");
        Text = "SnowBridge Launcher";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        int w = Math.Min(1280, area.Width - 80), h = Math.Min(860, area.Height - 80);
        Bounds = new Rectangle(area.Left + (area.Width - w) / 2, area.Top + (area.Height - h) / 2, w, h);
        MinimumSize = new Size(900, 600);
        BackColor = Color.FromArgb(15, 17, 21);
        ShowInTaskbar = true;
        Opacity = 0.0;
        web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Color.FromArgb(15, 17, 21);
        Controls.Add(web);
        Load += OnLoad;
        FormClosing += OnClosing;
        Shown += delegate { HostLog.Write("form shown bounds=" + Bounds); };
    }

    void ApplyDwm()
    {
        try
        {
            int round = 2;
            DwmSetWindowAttribute(Handle, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, 4);
            int border = (15 << 16) | (17 << 8) | 21;
            DwmSetWindowAttribute(Handle, DWMWA_BORDER_COLOR, ref border, 4);
        }
        catch { }
    }

    async void OnLoad(object sender, EventArgs e)
    {
        ApplyDwm();
        HostLog.Write("form load, init webview2");
        try
        {
            string dataDir = HostLog.Pick("SNOWBRIDGE_WEBVIEW2_DATA", System.IO.Path.Combine(appDir, "webview2"));
            Directory.CreateDirectory(dataDir);
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await web.EnsureCoreWebView2Async(env);
            HostLog.Write("webview2 ready");
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.Settings.AreDevToolsEnabled = true;
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.Settings.IsZoomControlEnabled = true;
            web.CoreWebView2.WebMessageReceived += OnMessage;
            web.CoreWebView2.NavigationCompleted += OnNav;
            web.CoreWebView2.ProcessFailed += delegate (object s, CoreWebView2ProcessFailedEventArgs ev) { HostLog.Write("webview process failed: " + ev.ProcessFailedKind); };
            navWatch.Start();
            web.CoreWebView2.Navigate(url);
            // 兜底：万一带宽/服务端卡住导致导航迟迟不完成，也别让窗口一直隐形。
            navFallbackTimer = new System.Windows.Forms.Timer { Interval = 8000 };
            navFallbackTimer.Tick += delegate
            {
                navFallbackTimer.Stop();
                navFallbackTimer.Dispose();
                navFallbackTimer = null;
                if (!shown)
                {
                    HostLog.Write("nav fallback show");
                    StartAnimation();
                }
            };
            navFallbackTimer.Start();
            StartPolling();
        }
        catch (Exception ex)
        {
            HostLog.Write("webview2 init FAILED: " + ex);
            MessageBox.Show("WebView2 初始化失败：" + ex.Message, "SnowBridge Launcher");
            Close();
        }
    }

    async void OnNav(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        navWatch.Stop();
        if (navFallbackTimer != null)
        {
            navFallbackTimer.Stop();
            navFallbackTimer.Dispose();
            navFallbackTimer = null;
        }
        if (!e.IsSuccess) { HostLog.Write("nav failed: " + e.WebErrorStatus + " after " + navWatch.ElapsedMilliseconds + "ms"); StartAnimation(); return; }
        HostLog.Write("nav completed: " + web.CoreWebView2.Source + " (" + navWatch.ElapsedMilliseconds + "ms)");
        // 关键：页面真正加载完再显示窗口并整窗淡入，避免「先弹一个黑窗、内容慢半拍」。
        StartAnimation();
        try
        {
            string title = await web.CoreWebView2.ExecuteScriptAsync("document.title");
            HostLog.Write("doc title=" + title);
            string probe = await web.CoreWebView2.ExecuteScriptAsync("JSON.stringify({w:innerWidth,h:innerHeight,wv:!!(window.chrome&&window.chrome.webview)})");
            HostLog.Write("page probe=" + probe);
        }
        catch (Exception ex) { HostLog.Write("probe failed: " + ex.Message); }
        string capturePath = HostLog.Pick("SNOWBRIDGE_CAPTURE", "");
        if (!string.IsNullOrEmpty(capturePath))
        {
            var timer = new System.Windows.Forms.Timer();
            timer.Interval = 1500;
            timer.Tick += async delegate
            {
                timer.Stop();
                try
                {
                    using (var fs = File.Create(capturePath))
                    {
                        await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
                    }
                    HostLog.Write("capture saved " + capturePath);
                }
                catch (Exception ex2) { HostLog.Write("capture failed " + ex2.Message); }
            };
            timer.Start();
        }
    }

    void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string raw;
        try { raw = e.TryGetWebMessageAsString(); } catch { raw = ""; }
        HostLog.Write("message: " + raw);
        string action = raw != null ? raw.Trim().Trim('"') : "";
        if (action.EndsWith("drag"))
        {
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
        }
        else if (action.EndsWith("minimize")) WindowState = FormWindowState.Minimized;
        else if (action.EndsWith("maximize")) ToggleMaximize();
        else if (action.EndsWith("close")) HideToTray();
        else if (action.EndsWith("exit")) FadeOutAndExit();
    }

    // 退出动画：窗口淡出 + 轻微下移，播完再真正退出进程。
    void FadeOutAndExit()
    {
        if (exiting) return;
        exiting = true;
        quitting = true;
        if (animTimer != null)
        {
            animTimer.Stop();
            animTimer.Dispose();
            animTimer = null;
            animating = false;
        }
        int baseTop = Top;
        int step = 0;
        var timer = new System.Windows.Forms.Timer { Interval = 16 };
        timer.Tick += delegate
        {
            step++;
            double t = Math.Min(1.0, step / 17.0);
            double eased = t * t;
            Opacity = 1 - eased;
            Top = (int)(baseTop + 8 * eased);
            if (t >= 1.0)
            {
                timer.Stop();
                timer.Dispose();
                HostLog.Write("exit animation done");
                Close();
                Application.Exit();
            }
        };
        HostLog.Write("exit requested");
        timer.Start();
    }

    void ToggleMaximize()
    {
        // 无边框窗口用 WindowState.Maximized 会盖住任务栏，也不参与 Win11 贴靠布局；
        // 这里手动按工作区取尺寸，行为更像普通应用的最大化/还原。
        if (maximized)
        {
            if (restoreBounds.Width > 0 && restoreBounds.Height > 0) Bounds = restoreBounds;
            maximized = false;
            HostLog.Write("window restore");
        }
        else
        {
            restoreBounds = Bounds;
            Bounds = Screen.FromHandle(Handle).WorkingArea;
            maximized = true;
            HostLog.Write("window maximize");
        }
    }

    void HideToTray()
    {
        Hide();
        HostLog.Write("window hidden");
    }

    void OnClosing(object sender, FormClosingEventArgs e)
    {
        if (quitting) return;
        e.Cancel = true;
        Hide();
        HostLog.Write("close intercepted -> hide");
    }

    void StartAnimation()
    {
        if (animating) return;
        animating = true;
        shown = true;
        int baseTop = Top;
        Opacity = 0;
        Top = baseTop + 14;
        animStep = 0;
        animTimer = new System.Windows.Forms.Timer();
        animTimer.Interval = 16;
        animTimer.Tick += delegate
        {
            animStep++;
            double t = Math.Min(1.0, animStep / 18.0);
            double eased = 1 - Math.Pow(1 - t, 3);
            Opacity = eased;
            Top = (int)(baseTop + 14 * (1 - eased));
            if (t >= 1.0)
            {
                animTimer.Stop();
                animTimer.Dispose();
                animTimer = null;
                Opacity = 1;
                Top = baseTop;
                animating = false;
                HostLog.Write("show animation done");
            }
        };
        animTimer.Start();
        Show();
        SetForegroundWindow(Handle);
    }

    void StartPolling()
    {
        // 启动时先记下已有的 exit.request 时间戳，避免上一次留下的退出请求把新进程立刻关掉。
        try { if (File.Exists(exitFile)) lastExitTicks = File.GetLastWriteTimeUtc(exitFile).Ticks; } catch { }
        pollTimer = new System.Windows.Forms.Timer();
        // 120ms 轮询：呼出/退出都更跟手（文件很小，开销可忽略）。
        pollTimer.Interval = 120;
        pollTimer.Tick += delegate
        {
            try
            {
                if (File.Exists(exitFile))
                {
                    long eticks = File.GetLastWriteTimeUtc(exitFile).Ticks;
                    if (eticks != lastExitTicks)
                    {
                        lastExitTicks = eticks;
                        FadeOutAndExit();
                        return;
                    }
                }
                if (File.Exists(summonFile))
                {
                    long ticks = File.GetLastWriteTimeUtc(summonFile).Ticks;
                    if (ticks != lastSummonTicks)
                    {
                        lastSummonTicks = ticks;
                        Summon();
                    }
                }
            }
            catch { }
        };
        pollTimer.Start();
        pingTimer = new System.Windows.Forms.Timer();
        pingTimer.Interval = 5000;
        pingTimer.Tick += async delegate
        {
            try
            {
                using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) })
                {
                    var resp = await http.GetAsync(url.TrimEnd('/') + "/api/ping");
                    pingFails = resp.IsSuccessStatusCode ? 0 : pingFails + 1;
                }
            }
            catch { pingFails++; }
            if (pingFails >= 3)
            {
                HostLog.Write("server unreachable, exiting");
                FadeOutAndExit();
            }
        };
        pingTimer.Start();
    }

    void Summon()
    {
        HostLog.Write("summon requested");
        if (!Visible)
        {
            // 隐藏状态下重新呼出：重播一次整窗动画。
            StartAnimation();
            return;
        }
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        if (animating) return;
        BringToFront();
        TopMost = true;
        TopMost = false;
        SetForegroundWindow(Handle);
        try
        {
            web.CoreWebView2.PostWebMessageAsJson("{\"action\":\"summoned\"}");
        }
        catch { }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_NCHITTEST && WindowState == FormWindowState.Normal && !maximized)
        {
            base.WndProc(ref m);
            if ((int)m.Result == HTCLIENT)
            {
                int x = m.LParam.ToInt32() & 0xFFFF;
                int y = (m.LParam.ToInt32() >> 16) & 0xFFFF;
                Point pt = PointToClient(new Point(x, y));
                bool left = pt.X <= ResizeBorder, right = pt.X >= ClientSize.Width - ResizeBorder;
                bool top = pt.Y <= ResizeBorder, bottom = pt.Y >= ClientSize.Height - ResizeBorder;
                if (top && left) m.Result = (IntPtr)HTTOPLEFT;
                else if (top && right) m.Result = (IntPtr)HTTOPRIGHT;
                else if (bottom && left) m.Result = (IntPtr)HTBOTTOMLEFT;
                else if (bottom && right) m.Result = (IntPtr)HTBOTTOMRIGHT;
                else if (left) m.Result = (IntPtr)HTLEFT;
                else if (right) m.Result = (IntPtr)HTRIGHT;
                else if (top) m.Result = (IntPtr)HTTOP;
                else if (bottom) m.Result = (IntPtr)HTBOTTOM;
            }
            return;
        }
        base.WndProc(ref m);
    }
}