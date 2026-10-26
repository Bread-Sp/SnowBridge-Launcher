// hidehost.exe —— 用「已存在但不可见」的控制台启动一个命令，等它结束后把退出码带回来。
//
// 为什么需要它：SnowLuma 的外层 index.mjs 起来后会再 spawn 一个同命令行的子进程（父子两层）。
// 启动台用 detached:true（DETACHED_PROCESS，没有控制台）起的它，子进程被系统分配一个**新的
// 可见控制台**；Win11 的默认终端是 Windows Terminal，屏幕上凭空弹出标题为
// "E:\SnowLuma\node.exe" 的终端窗口（窗口类 CASCADIA_HOSTING_WINDOW_CLASS，按窗口类去 hide
// 无效），还会抢焦点。先给它一个「已经存在、但不可见」的控制台，子进程继承后就不再新建窗口。
//
// 以前这里套的是 `conhost.exe --headless`：在 Windows 11 24H2/25H2（build 26100/26200）上
// 已经变成空操作 —— 只往 stdout 吐一串 VT 控制码就退出 0，根本不执行后面的命令行。启动台
// 于是看到「code=0 意外退出」，每 3 秒自动重起来（这正是「一启动就退出、无限重启」的真因）。
// 这个宿主直接调 CreateProcess(CREATE_NEW_CONSOLE | SW_HIDE)，行为确定、可测。
//
// 约定：
//   - 参数：hidehost.exe <程序> [参数...]（第一个参数是 exe 路径，其余原样转发）。
//   - 退出码：镜像子进程的退出码；CreateProcess 失败时返回 1（错误写到 stderr）。
//   - stdout/stderr：原样继承启动台给的文件句柄（日志照旧落在 logs\snowluma.log）。
//   - 不打印任何正常输出，避免污染 SnowLuma 的日志。
using System;
using System.Runtime.InteropServices;
using System.Text;

[assembly: System.Reflection.AssemblyTitle("hidehost")]
[assembly: System.Reflection.AssemblyProduct("SnowBridge Launcher")]
[assembly: System.Reflection.AssemblyCompany("SnowBridge")]
[assembly: System.Reflection.AssemblyVersion("0.0.1.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.0.1.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.0.1")]

namespace SnowBridge
{
    internal static class Program
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public bool bInheritHandle;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcess(
            string lpApplicationName,
            string lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateFile(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            ref SECURITY_ATTRIBUTES lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        private const uint CREATE_NEW_CONSOLE = 0x00000010;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const int STARTF_USESHOWWINDOW = 0x00000001;
        private const int STARTF_USESTDHANDLES = 0x00000100;
        private const short SW_HIDE = 0;
        private const uint INFINITE = 0xFFFFFFFF;
        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const uint GENERIC_READ = 0x80000000;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

        /// <summary>按 Windows 的引号规则拼命令行（CreateProcess 需要一整条字符串）。</summary>
        private static string Quote(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return value;
            }

            var sb = new StringBuilder();
            sb.Append('"');
            var backslashes = 0;
            foreach (var ch in value)
            {
                if (ch == '\\')
                {
                    backslashes++;
                    continue;
                }

                if (ch == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(ch);
                }

                backslashes = 0;
            }

            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        private static bool IsUsableHandle(IntPtr handle)
        {
            return handle != IntPtr.Zero && handle != INVALID_HANDLE_VALUE;
        }

        /// <summary>没有可继承的 std 句柄时（比如手动在终端里跑），退回一个可写的 NUL。</summary>
        private static IntPtr OpenNul()
        {
            var security = new SECURITY_ATTRIBUTES();
            security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            security.bInheritHandle = true;
            return CreateFile(
                "NUL",
                GENERIC_READ | GENERIC_WRITE,
                3, // FILE_SHARE_READ | FILE_SHARE_WRITE
                ref security,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                IntPtr.Zero);
        }

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length < 1)
            {
                Console.Error.WriteLine("usage: hidehost.exe <program> [args...]");
                return 2;
            }

            var commandLine = new StringBuilder();
            for (var i = 0; i < args.Length; i++)
            {
                if (i > 0)
                {
                    commandLine.Append(' ');
                }

                commandLine.Append(Quote(args[i]));
            }

            var stdOut = GetStdHandle(STD_OUTPUT_HANDLE);
            var stdErr = GetStdHandle(STD_ERROR_HANDLE);
            var stdIn = GetStdHandle(STD_INPUT_HANDLE);
            if (!IsUsableHandle(stdOut)) stdOut = OpenNul();
            if (!IsUsableHandle(stdErr)) stdErr = OpenNul();
            if (!IsUsableHandle(stdIn)) stdIn = OpenNul();

            var startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
            startup.wShowWindow = SW_HIDE; // 新控制台用隐藏方式创建（不弹终端窗口）
            startup.hStdInput = stdIn;
            startup.hStdOutput = stdOut;
            startup.hStdError = stdErr;

            PROCESS_INFORMATION process;
            var ok = CreateProcess(
                args[0],
                commandLine.ToString(),
                IntPtr.Zero,
                IntPtr.Zero,
                true, // 让子进程继承上面这几个句柄（日志文件）
                CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
                IntPtr.Zero, // 环境块：继承本进程的（启动台已经把 SNOWLUMA_HOME 放好了）
                Environment.CurrentDirectory,
                ref startup,
                out process);
            if (!ok)
            {
                Console.Error.WriteLine("hidehost: CreateProcess failed, win32=" + Marshal.GetLastWin32Error());
                return 1;
            }

            // 一直等到子进程结束，再把它的退出码原样返回 —— 启动台靠这个退出码判断
            // 「意外退出」还是「正常停止」，提前返回会被误判成崩溃并触发自动重启。
            WaitForSingleObject(process.hProcess, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
            {
                exitCode = 1;
            }

            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            return unchecked((int)exitCode);
        }
    }
}
