// SnowBridge Launcher 的窗口/托盘辅助类（由 tray.ps1 用 Add-Type 加载）。
// 为什么单独放一个 .cs 文件：这样自检脚本也能加载同一份代码，不会出现「两套实现」
// 导致的「界面看着一样、点下去不一样」。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace SnowBridge
{
    /// <summary>窗口查找 / 聚焦 / 关闭。</summary>
    public static class Native
    {
        private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

        private const int SW_RESTORE = 9;
        private const int SW_SHOW = 5;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

        private static bool IsBrowserWindow(IntPtr h)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == 0) return false;
            try
            {
                string name = Process.GetProcessById((int)pid).ProcessName;
                return string.Equals(name, "msedge", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "chrome", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "SnowBridgeHost", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(name, "SnowBridgeShell", StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        /// <summary>找出「标题含 title 且属于浏览器进程」的可见窗口。</summary>
        public static List<IntPtr> Find(string title)
        {
            var found = new List<IntPtr>();
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                if (!IsWindowVisible(h)) return true;
                var sb = new StringBuilder(512);
                GetWindowText(h, sb, sb.Capacity);
                if (sb.Length > 0 && sb.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0 && IsBrowserWindow(h)) found.Add(h);
                return true;
            }, IntPtr.Zero);
            return found;
        }

        public static bool Exists(string title) { return Find(title).Count > 0; }

        /// <summary>
        /// 把窗口叫到最前面：「置顶一下」而不是永久置顶 —— 400ms 后自动取消 TOPMOST，
        /// 否则会盖住别的窗口，用户会以为程序在耍流氓。
        /// </summary>
        public static bool Focus(string title)
        {
            var list = Find(title);
            if (list.Count == 0) return false;
            IntPtr h = list[0];
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            // 直接 SetForegroundWindow 常被前台锁拦下来（尤其是从托盘图标点过来时），
            // 先把本线程挂到当前前台窗口的输入队列上，再抢，成功率明显高。
            uint dummy;
            uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
            uint myThread = GetCurrentThreadId();
            bool attached = false;
            try
            {
                if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
                ShowWindow(h, SW_SHOW);
                SetForegroundWindow(h);
                SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            }
            finally
            {
                if (attached) AttachThreadInput(myThread, fgThread, false);
            }
            IntPtr target = h;
            ThreadPool.QueueUserWorkItem(delegate
            {
                Thread.Sleep(400);
                SetWindowPos(target, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            });
            return true;
        }

        public static void CloseAll(string title)
        {
            foreach (IntPtr h in Find(title)) PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
        }
    }

    /// <summary>自绘的深色托盘菜单：圆角、悬停高亮、点外面任意位置就关。</summary>
    // 托盘右键菜单。尺寸与质感参照 DSH（DeepSeek Harness）自带的右键菜单：
    // 容器 padding 4~6、行 padding 4px 7px、12px 字号、单项细边框、无标题栏、无大图标，
    // 靠「内容宽度」自适应而不是固定一个大方块。
    public sealed class TrayMenu : Form
    {
        private sealed class Row
        {
            public string Id;
            public string Label;
            public string Kind; // item / status / sep
        }

        private readonly List<Row> _rows = new List<Row>();
        private int _hover = -1;
        private int _w = MinWidth;

        private const int MinWidth = 168;
        private const int MaxWidth = 268;
        private const int PadX = 6;
        private const int PadY = 5;
        private const int ItemH = 30;
        private const int SepH = 7;
        private const int Radius = 10;

        private static readonly Color Bg = Color.FromArgb(23, 31, 46);
        private static readonly Color Border = Color.FromArgb(46, 60, 82);
        private static readonly Color Hover = Color.FromArgb(34, 46, 68);
        private static readonly Color SepLine = Color.FromArgb(38, 50, 70);
        private static readonly Color ItemText = Color.FromArgb(214, 224, 238);
        private static readonly Color MutedText = Color.FromArgb(124, 138, 160);
        private static readonly Color QuitText = Color.FromArgb(255, 140, 140);

        private readonly Font _itemFont = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
        private readonly Font _statusFont = new Font("Microsoft YaHei UI", 8.25f, FontStyle.Regular, GraphicsUnit.Point);

        // ---- 全局鼠标钩子：菜单弹出后，点菜单外的任何地方都收起 ----
        // 只靠 OnDeactivate 不可靠：从托盘右键弹出时焦点还在任务栏上，
        // 菜单很可能一次都没被激活过，此时点外面根本不会触发 Deactivate。
        private const int WH_MOUSE_LL = 14;
        private const int WM_LBUTTONDOWN = 0x0201;
        private const int WM_RBUTTONDOWN = 0x0204;
        private const int WM_MBUTTONDOWN = 0x0207;

        private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSLLHOOKSTRUCT
        {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        private DateTime _shownAt = DateTime.MinValue;

        private IntPtr _hook = IntPtr.Zero;
        private LowLevelMouseProc _hookProc; // 必须留住引用，否则被 GC 回收后回调会崩

        private void InstallOutsideClickHook()
        {
            if (_hook != IntPtr.Zero) return;
            _hookProc = HookCallback;
            _hook = SetWindowsHookEx(WH_MOUSE_LL, _hookProc, GetModuleHandle(null), 0);
        }

        private void RemoveOutsideClickHook()
        {
            if (_hook == IntPtr.Zero) return;
            try { UnhookWindowsHookEx(_hook); } catch { }
            _hook = IntPtr.Zero;
            _hookProc = null;
        }

        private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN)
                {
                    MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                    var pt = new Point(data.pt.X, data.pt.Y);
                    if (Visible && !Bounds.Contains(pt))
                    {
                        // 钩子里不能直接关窗体（会重入消息循环），排到 UI 队列
                        try { BeginInvoke(new Action(Dismiss)); } catch { }
                    }
                }
            }
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            if (Visible) InstallOutsideClickHook();
            else RemoveOutsideClickHook();
        }

        public event EventHandler<string> Chosen;

        public TrayMenu()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Bg;
            Font = _itemFont;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
            KeyPreview = true;
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
                return cp;
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try { _itemFont.Dispose(); } catch { }
                try { _statusFont.Dispose(); } catch { }
            }
            base.Dispose(disposing);
        }

        public void ClearRows() { _rows.Clear(); _hover = -1; }

        public void AddRow(string id, string label, string kind)
        {
            _rows.Add(new Row { Id = id, Label = label, Kind = kind });
        }

        private static int RowH(Row r)
        {
            if (r.Kind == "sep") return SepH;
            return ItemH;
        }

        public void Commit()
        {
            int h = PadY * 2;
            int widest = 0;
            foreach (Row r in _rows)
            {
                h += RowH(r);
                if (r.Kind == "sep") continue;
                Font f = r.Kind == "status" ? _statusFont : _itemFont;
                Size sz = TextRenderer.MeasureText(r.Label ?? string.Empty, f,
                    new Size(MaxWidth * 4, ItemH), TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
                if (sz.Width > widest) widest = sz.Width;
            }
            _w = Math.Max(MinWidth, Math.Min(MaxWidth, widest + PadX * 2 + 14));
            Size = new Size(_w, h);
            using (GraphicsPath path = Rounded(new Rectangle(0, 0, _w, h), Radius))
            {
                Region = new Region(path);
            }
            Invalidate();
        }

        private static GraphicsPath Rounded(Rectangle rect, int radius)
        {
            var path = new GraphicsPath();
            int d = radius * 2;
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        private Rectangle RowRect(int index)
        {
            int y = PadY;
            for (int i = 0; i < index; i++) y += RowH(_rows[i]);
            return new Rectangle(0, y, _w, RowH(_rows[index]));
        }

        private int HitRow(Point p)
        {
            for (int i = 0; i < _rows.Count; i++)
            {
                if (RowRect(i).Contains(p)) return i;
            }
            return -1;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            var all = new Rectangle(0, 0, _w - 1, Height - 1);
            using (var bgBrush = new SolidBrush(Bg)) g.FillRectangle(bgBrush, ClientRectangle);
            using (GraphicsPath path = Rounded(all, Radius))
            {
                using (var pen = new Pen(Border)) g.DrawPath(pen, path);
            }

            for (int i = 0; i < _rows.Count; i++)
            {
                Row r = _rows[i];
                Rectangle rect = RowRect(i);
                if (r.Kind == "sep")
                {
                    int y = rect.Y + rect.Height / 2;
                    using (var pen = new Pen(SepLine)) g.DrawLine(pen, PadX + 4, y, _w - PadX - 4, y);
                    continue;
                }

                bool hovered = (i == _hover) && r.Kind != "status";
                if (hovered)
                {
                    Rectangle hr = new Rectangle(PadX - 2, rect.Y + 1, _w - (PadX - 2) * 2, rect.Height - 2);
                    using (GraphicsPath hp = Rounded(hr, 6))
                    using (var hb = new SolidBrush(Hover)) g.FillPath(hb, hp);
                }

                Color color = r.Kind == "status" ? MutedText : (r.Kind == "quit" ? QuitText : ItemText);
                Font f = r.Kind == "status" ? _statusFont : _itemFont;
                var textRect = new Rectangle(PadX + 6, rect.Y, _w - (PadX + 6) - PadX, rect.Height);
                TextFormatFlags flags = TextFormatFlags.Left | TextFormatFlags.VerticalCenter |
                                        TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis |
                                        TextFormatFlags.NoPrefix;
                TextRenderer.DrawText(g, r.Label ?? string.Empty, f, textRect, color, flags);
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int row = HitRow(e.Location);
            if (row >= 0 && _rows[row].Kind == "status") row = -1;
            if (row != _hover)
            {
                _hover = row;
                Invalidate();
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (_hover != -1) { _hover = -1; Invalidate(); }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            int index = HitRow(e.Location);
            if (index < 0) return;
            Row row = _rows[index];
            if (row.Kind != "item" && row.Kind != "quit") return;
            EventHandler<string> handler = Chosen;
            Dismiss();
            if (handler != null) handler(this, row.Id);
        }

        /// <summary>收起菜单（不销毁窗体，下次右键能直接复用）。</summary>
        public void Dismiss()
        {
            RemoveOutsideClickHook();
            if (Visible) Hide();
        }

        // 点菜单外的任意位置（任何别的窗口、桌面、任务栏）都会让本窗体失去激活 —— 直接收起来。
        // 注意：这里刻意不重写 OnDeactivate。
        // 托盘右键弹出时，焦点通常还在任务栏，我们拿不到前台权；Windows 随后会补一个
        // WM_ACTIVATE(WA_INACTIVE)，若在失焦里收起菜单就会「一闪就没」（踩过）。
        // 收起统一由：点菜单项 / Esc / 全局鼠标钩子（点菜单外任意位置）负责。

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Escape) { Dismiss(); return true; }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        /// <summary>在鼠标位置弹出；超出屏幕就自动往回缩。</summary>
        public void PopupAt(Point screenPoint)
        {
            Rectangle work = Screen.FromPoint(screenPoint).WorkingArea;
            int x = screenPoint.X - _w + 16;
            int y = screenPoint.Y - Height - 8;
            if (x < work.Left + 4) x = work.Left + 4;
            if (x + _w > work.Right - 4) x = work.Right - _w - 4;
            if (y < work.Top + 4) y = screenPoint.Y + 10;
            if (y + Height > work.Bottom - 4) y = work.Bottom - Height - 4;
            Location = new Point(x, y);
            _shownAt = DateTime.UtcNow;
            Show();
            try { SetForegroundWindow(Handle); } catch { }
            Activate();
            BringToFront();
        }
    }
}

/// <summary>让托盘通知的归属写成 SnowBridge Launcher，而不是 Windows PowerShell。
/// 放在这里是为了跟 Native/TrayMenu 一起被预编译进 winhelp.dll，托盘启动时不用再现场编译。</summary>
public static class AumidHelper
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
}