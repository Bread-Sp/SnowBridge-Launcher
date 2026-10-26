// SnowBridge Launcher 安装程序（自解压启动器）
// 设计：把 payload.zip 作为嵌入资源打进 exe，运行时释放到临时目录，再用 PowerShell 跑
// install.ps1（图形界面 / 静默模式都由 install.ps1 决定），结束后清理临时目录。
// 之所以不用 IExpress：实测它在当前环境里根本不会执行 AppLaunched，静默安装返回 0 却什么都没做。
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

[assembly: System.Reflection.AssemblyTitle("SnowBridge Launcher Setup")]
[assembly: System.Reflection.AssemblyProduct("SnowBridge Launcher")]
[assembly: System.Reflection.AssemblyCompany("SnowBridge")]
[assembly: System.Reflection.AssemblyVersion("0.0.1.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.0.1.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.0.1")]

class Program
{
    static int Main(string[] args)
    {
        string temp = Path.Combine(Path.GetTempPath(), "SnowBridgeSetup_" + Guid.NewGuid().ToString("N").Substring(0, 8));
        Directory.CreateDirectory(temp);
        try
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            Stream stream = asm.GetManifestResourceStream("payload.zip");
            if (stream == null)
            {
                Fail("安装包损坏：找不到内置的 payload.zip");
                return 2;
            }
            using (stream)
            using (ZipArchive zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                zip.ExtractToDirectory(temp);
            }

            string script = Path.Combine(temp, "install.ps1");
            if (!File.Exists(script))
            {
                Fail("安装包损坏：缺少 install.ps1");
                return 2;
            }

            StringBuilder argLine = new StringBuilder();
            argLine.Append("-NoProfile -Sta -ExecutionPolicy Bypass -File \"").Append(script).Append("\"");
            foreach (string a in args)
            {
                argLine.Append(' ').Append(QuoteArg(a));
            }

            ProcessStartInfo psi = new ProcessStartInfo("powershell.exe", argLine.ToString());
            psi.UseShellExecute = false;
            psi.WorkingDirectory = temp;
            Process p = Process.Start(psi);
            p.WaitForExit();
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            Fail("安装失败：" + ex.Message);
            return 1;
        }
        finally
        {
            try { Directory.Delete(temp, true); } catch { }
        }
    }

    static string QuoteArg(string s)
    {
        if (s.IndexOf(' ') < 0 && s.IndexOf('"') < 0) return s;
        return "\"" + s.Replace("\"", "\\\"") + "\"";
    }

    static void Fail(string message)
    {
        try
        {
            System.Windows.Forms.MessageBox.Show(message, "SnowBridge Launcher 安装程序");
        }
        catch
        {
            Console.Error.WriteLine(message);
        }
    }
}
