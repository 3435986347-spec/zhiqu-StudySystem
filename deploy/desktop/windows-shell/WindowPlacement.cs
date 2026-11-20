using System;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Windows.Forms;

namespace Zhiqu.Desktop
{
    /// <summary>
    /// 记住窗口大小和位置。macOS 外壳用 <c>NSWindow.setFrameAutosaveName</c>，Windows 这边自己存一个文本文件
    /// （<c>%LOCALAPPDATA%\zhiqu\window.ini</c>）—— 就五个数字，为它引一个 JSON 库不值得。
    ///
    /// <para>读的时候要校验：上次是在外接显示器上关的，这次那台显示器不在，保存的坐标会落在屏幕外，
    /// 用户看到一个「打开就没了」的窗口。所以要确认矩形还在某块屏幕的工作区里。</para>
    /// </summary>
    internal static class WindowPlacement
    {
        private static string FilePath
        {
            get
            {
                return DesktopPaths.DataFolder("window.ini");
            }
        }

        internal static bool TryLoad(out Rectangle bounds, out bool maximized)
        {
            bounds = Rectangle.Empty;
            maximized = false;
            try
            {
                if (!File.Exists(FilePath))
                {
                    return false;
                }
                int left = 0, top = 0, width = 0, height = 0;
                foreach (string raw in File.ReadAllLines(FilePath))
                {
                    int equals = raw.IndexOf('=');
                    if (equals <= 0)
                    {
                        continue;
                    }
                    string key = raw.Substring(0, equals).Trim();
                    string value = raw.Substring(equals + 1).Trim();
                    int number;
                    if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out number))
                    {
                        continue;
                    }
                    switch (key)
                    {
                        case "left": left = number; break;
                        case "top": top = number; break;
                        case "width": width = number; break;
                        case "height": height = number; break;
                        case "maximized": maximized = number != 0; break;
                    }
                }
                var candidate = new Rectangle(left, top, width, height);
                if (candidate.Width < 640 || candidate.Height < 480 || !OnSomeScreen(candidate))
                {
                    return false;
                }
                bounds = candidate;
                return true;
            }
            catch (Exception)
            {
                // 文件坏了、没权限：用默认大小打开就是，不该因此起不来
                return false;
            }
        }

        private static bool OnSomeScreen(Rectangle bounds)
        {
            foreach (Screen screen in Screen.AllScreens)
            {
                Rectangle overlap = Rectangle.Intersect(screen.WorkingArea, bounds);
                // 露出来的部分太小就等于看不见（只擦到一个角，标题栏可能还是够不着）
                if (overlap.Width >= 160 && overlap.Height >= 80)
                {
                    return true;
                }
            }
            return false;
        }

        internal static void Save(Form form)
        {
            try
            {
                // 最大化时 Bounds 是整块屏幕；存「还原后」的那个大小，下次才恢复得回来
                Rectangle bounds = form.WindowState == FormWindowState.Normal ? form.Bounds : form.RestoreBounds;
                if (bounds.Width <= 0 || bounds.Height <= 0)
                {
                    return;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                File.WriteAllLines(FilePath, new[]
                {
                    "left=" + bounds.Left.ToString(CultureInfo.InvariantCulture),
                    "top=" + bounds.Top.ToString(CultureInfo.InvariantCulture),
                    "width=" + bounds.Width.ToString(CultureInfo.InvariantCulture),
                    "height=" + bounds.Height.ToString(CultureInfo.InvariantCulture),
                    "maximized=" + (form.WindowState == FormWindowState.Maximized ? "1" : "0"),
                });
            }
            catch (Exception)
            {
                // 记不住下次窗口大小不是错误
            }
        }
    }
}
