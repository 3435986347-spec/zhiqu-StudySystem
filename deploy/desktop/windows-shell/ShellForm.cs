using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Zhiqu.Desktop
{
    /// <summary>
    /// 知趣象限 —— Windows 原生外壳。
    ///
    /// <para>它做的事只有一件：在一个窗口里用 WebView2 打开这个应用的网站（默认 <c>https://zhiqustudy.com</c>）。
    /// 和 macOS 外壳（<c>../macos-shell</c>，Swift + WKWebView）是同一个形状：数据只在服务器上，
    /// 包里不带 Java、JRE、JAR，也不需要 MySQL。来龙去脉见 <c>docs/desktop-remote-plan.md</c>。</para>
    ///
    /// <para>和 macOS 那一版还差的本机能力（系统通知、迷你番茄钟、本机代码助手经 zqLocal 桥跑包里的 node）
    /// 是后面几步 —— 现在 Windows 上「代码」和网页一样只生成到产物。这一点写在
    /// <c>deploy/desktop/README.md</c> 里，别让它悄悄变成「桌面版什么都能碰你的磁盘」。</para>
    /// </summary>
    internal sealed class ShellForm : Form
    {
        internal const string WindowTitle = "知趣象限";

        /// <summary>就绪后打开哪一页（和 macOS 外壳一样开看板；没登录时网站自己会跳到登录页）。</summary>
        private const string LandingPage = "/dashboard.html";

        private const int MinimumWidth = 960;
        private const int MinimumHeight = 640;

        /// <summary>第一次打开的大小（点，和 macOS 外壳的 1280×820 对齐），真正落地时按 DPI 换算成像素。</summary>
        private const int DefaultWidth = 1280;
        private const int DefaultHeight = 820;

        /// <summary>设计稿的图标（deploy/desktop/icon/zhiqu.ico），csproj 里按这个名字嵌进来的。</summary>
        private const string IconResource = "Zhiqu.Desktop.zhiqu.ico";

        private readonly Uri _server;
        private readonly string _host;
        private readonly int _port;
        private readonly string _scheme;

        private WebView2 _web;
        private Panel _overlay;
        private Label _overlayText;
        private Button _retryButton;

        private bool _webReady;
        private bool _placementRestored;
        /// <summary>这台显示器上的缩放（96 DPI 是 1.0；125% 是 1.25）。窗口尺寸、字号都乘它。</summary>
        private float _scale = 1F;

        internal ShellForm()
        {
            _server = ServerConfig.Resolve();
            _host = _server.Host;
            _port = _server.Port;
            _scheme = _server.Scheme;

            Text = WindowTitle;
            Icon appIcon = LoadAppIcon();
            if (appIcon != null)
            {
                Icon = appIcon;
            }
            // 尺寸和字号要乘缩放，但这台机器的 DPI 要等窗口句柄建好才准 —— 放到 OnLoad 里做（ApplyScale）
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.White;
            AutoScaleMode = AutoScaleMode.None;
            KeyPreview = true;
            _placementRestored = RestorePlacement();
        }

        // MARK: - 界面

        /// <summary>
        /// 这台显示器上的缩放（96 DPI = 1.0）。<b>不用 <see cref="Control.DeviceDpi"/>：</b>桌面应用没带 app.config 里的
        /// <c>DpiAwareness</c> 开关（单文件 exe 带不了 .config），WinForms 就一律按 96 DPI 算，报上来的数在 125% 的屏幕上也是 96。
        /// 直接问系统当前窗口在哪个 DPI 上，才是真数。
        /// </summary>
        private void ApplyScale()
        {
            try
            {
                uint dpi = GetDpiForWindow(Handle);
                if (dpi >= 72 && dpi <= 480)
                {
                    _scale = dpi / 96F;
                }
            }
            catch (Exception)
            {
                // 老系统没有这个 API：按 100% 走，界面小一点但能用
            }
            Font = new Font("Microsoft YaHei UI", 9F * _scale, FontStyle.Regular, GraphicsUnit.Point);
            MinimumSize = new Size(
                (int)Math.Round(MinimumWidth * _scale),
                (int)Math.Round(MinimumHeight * _scale));
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr hwnd);

        /// <summary>
        /// 标题栏和任务栏上的图标。不设的话 WinForms 会用它自带的那个彩色方块 —— 和 exe 的资源图标（正确的那个）
        /// 不是一回事，用户看到的是「装的是知趣，打开是个 WinForms 图标」。
        ///
        /// <para>优先用嵌进程序集的那份 ICO（多尺寸，系统按 DPI 自己挑）；万一资源没进去，
        /// 退回从 exe 里取（<c>ApplicationIcon</c> 已经把它写进 exe 了）。两条都失败就留默认，不值得因此起不来。</para>
        /// </summary>
        private static Icon LoadAppIcon()
        {
            try
            {
                using (Stream stream = typeof(ShellForm).Assembly.GetManifestResourceStream(IconResource))
                {
                    if (stream != null)
                    {
                        return new Icon(stream);
                    }
                }
            }
            catch (Exception)
            {
                // 下面还有一条路
            }
            try
            {
                return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// 上次关在哪里就开在哪里。返回 false 表示第一次开（没有存档），交给
        /// <see cref="ApplyDefaultPlacement"/> 按屏幕大小和缩放比例挑一个。
        /// </summary>
        private bool RestorePlacement()
        {
            Rectangle bounds;
            bool maximized;
            if (!WindowPlacement.TryLoad(out bounds, out maximized))
            {
                return false;
            }
            Bounds = bounds;
            if (maximized)
            {
                WindowState = FormWindowState.Maximized;
            }
            return true;
        }

        /// <summary>
        /// 第一次打开的窗口大小：1280×820 是 macOS 外壳的默认值，单位是点（DIP）。
        /// 这里按 <see cref="_scale"/> 换算成像素 —— 不换算的话，125% 缩放的屏幕上窗口会小一圈。
        /// 缩放要在窗口句柄建好之后才问得到，所以由 OnLoad 里的 <see cref="ApplyScale"/> 先备好。
        /// </summary>
        private void ApplyDefaultPlacement()
        {
            if (_placementRestored)
            {
                return;
            }
            Rectangle area = Screen.FromHandle(Handle).WorkingArea;
            int width = Math.Min((int)Math.Round(DefaultWidth * _scale), area.Width);
            int height = Math.Min((int)Math.Round(DefaultHeight * _scale), area.Height);
            Bounds = new Rectangle(
                area.Left + (area.Width - width) / 2,
                area.Top + (area.Height - height) / 2,
                width,
                height);
        }

        private void BuildUi()
        {
            _web = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.White,
            };
            Controls.Add(_web);

            // 说明/错误盖在网页上面：连不上时网页先藏起来，只剩一句话和一个「重试」——
            // 照 macOS 外壳第一百二十六轮的做法（否则用户盯着一个点什么都没反应的旧页面，像卡死）
            _overlay = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Visible = false };
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 };
            grid.RowStyles.Add(new RowStyle(SizeType.Percent, 45F));
            grid.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            grid.RowStyles.Add(new RowStyle(SizeType.Percent, 55F));

            var stack = new FlowLayoutPanel
            {
                FlowDirection = FlowDirection.TopDown,
                AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Anchor = AnchorStyles.None,
                WrapContents = false,
            };
            _overlayText = new Label
            {
                AutoSize = true,
                MaximumSize = new Size((int)Math.Round(640 * _scale), 0),
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Microsoft YaHei UI", 10.5F * _scale, FontStyle.Regular, GraphicsUnit.Point),
                ForeColor = Color.FromArgb(64, 64, 64),
            };
            _retryButton = new Button
            {
                Text = "重试",
                AutoSize = true,
                Padding = new Padding((int)Math.Round(18 * _scale), (int)Math.Round(5 * _scale),
                                       (int)Math.Round(18 * _scale), (int)Math.Round(5 * _scale)),
                Margin = new Padding(0, (int)Math.Round(18 * _scale), 0, 0),
                Visible = false,
            };
            _retryButton.Click += delegate { Retry(); };

            stack.Controls.Add(_overlayText);
            stack.Controls.Add(_retryButton);
            grid.Controls.Add(stack, 0, 1);
            _overlay.Controls.Add(grid);
            Controls.Add(_overlay);
            _overlay.BringToFront();
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            ApplyScale();
            ApplyDefaultPlacement();
            BuildUi();
            await StartAsync();
        }

        // MARK: - 启动

        private async Task StartAsync()
        {
            ShowMessage("正在连接 " + _host + "…", false);
            try
            {
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, UserDataFolder());
                await _web.EnsureCoreWebView2Async(environment);
                _webReady = true;
                Configure(_web.CoreWebView2);
                await ClearOfflineCacheAsync();
                NavigateHome();
            }
            catch (Exception error)
            {
                // 最常见的一种：这台机器上没装 WebView2 运行时（Windows 10 早期版本、或 Edge 被卸了）。
                // 说清楚怎么装，而不是甩一个 .NET 异常堆栈给用户。
                Fail("界面组件起不来：" + error.Message + Environment.NewLine + Environment.NewLine
                     + "这台机器可能缺 WebView2 运行时。装一下再试：" + Environment.NewLine
                     + "https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            }
        }

        private static string UserDataFolder()
        {
            // 登录态（Cookie / localStorage）存在这里。放在 LocalAppData 而不是 exe 旁边：
            // 程序目录可能在 Program Files（只读），解压到哪里都能用同一个登录态、同一份缓存。
            string folder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "zhiqu", "webview2");
            Directory.CreateDirectory(folder);
            return folder;
        }

        private void Configure(CoreWebView2 core)
        {
            // 这是应用窗口，不是浏览器：不要状态栏、不要滑动前进后退
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsSwipeNavigationEnabled = false;
            // 密码和地址自动填充交给网页自己管（和网页版保持一致），否则桌面和网页记住的登录态会打架
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            // Ctrl+R / F5 这些浏览器快捷键留着 —— 断网后重新载入靠它们（网页里也有「重试」按钮）
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;
            core.Settings.AreDevToolsEnabled = true;

            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;
            core.ProcessFailed += OnProcessFailed;
        }

        /// <summary>
        /// 启动前清掉 Service Worker 和它的缓存（照 macOS 外壳第一百二十六轮）：
        /// 断网时浏览器拿缓存的页面顶上，WebView2 当成载入成功，外壳就什么都不说 —— 用户看到的是旧数据。
        /// 登录态在 Cookie / localStorage 里，不清。
        /// </summary>
        private async Task ClearOfflineCacheAsync()
        {
            try
            {
                CoreWebView2BrowsingDataKinds kinds =
                    CoreWebView2BrowsingDataKinds.CacheStorage | CoreWebView2BrowsingDataKinds.ServiceWorkers;
                Task clearing = _web.CoreWebView2.Profile.ClearBrowsingDataAsync(kinds);
                // 清缓存是为了别看到旧页面，不是启动的一部分：3 秒还没完就往下走
                if (await Task.WhenAny(clearing, Task.Delay(3000)) != clearing)
                {
                    return;
                }
                await clearing;
            }
            catch (Exception)
            {
                // 清不掉（运行时版本老、没有 Profile API）不该拦住启动
            }
        }

        private void NavigateHome()
        {
            if (!_webReady)
            {
                return;
            }
            _web.Visible = true;
            Navigate(new Uri(_server, LandingPage));
        }

        private void Navigate(Uri target)
        {
            ShowMessage("正在连接 " + _host + "…", false);
            _web.CoreWebView2.Navigate(target.AbsoluteUri);
        }

        // MARK: - 导航

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            Uri target;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target))
            {
                return;
            }
            if (IsInternal(target))
            {
                return;
            }
            // 不是自己的网站：这一页不在应用里开。http(s) 交给系统浏览器，
            // file:// 之类的直接丢掉（macOS 外壳也不把它交给系统 —— 那是本地文件，不该被网页点名打开）
            e.Cancel = true;
            if (target.Scheme == Uri.UriSchemeHttp || target.Scheme == Uri.UriSchemeHttps)
            {
                OpenExternal(target);
            }
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            Uri target;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target))
            {
                return;
            }
            if (IsInternal(target))
            {
                // 站内的 target=_blank、window.open：还在这个窗口里开，别弹第二个窗口
                Navigate(target);
                return;
            }
            if (target.Scheme == Uri.UriSchemeHttp || target.Scheme == Uri.UriSchemeHttps)
            {
                OpenExternal(target);
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                Fail("连不上 " + _host + "：" + Describe(e.WebErrorStatus) + Environment.NewLine + Environment.NewLine
                     + "数据都在服务器上，断网时看不了。联网后按 Ctrl+R 重新载入。");
                return;
            }
            if (e.HttpStatusCode >= 500)
            {
                Fail(_host + " 回了 " + e.HttpStatusCode + "：服务器那边出了点问题。" + Environment.NewLine + Environment.NewLine
                     + "稍后按 Ctrl+R 重新载入。");
                return;
            }
            ShowPage();
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            // 渲染进程崩了（多半是显存/驱动）：页面没了但窗口还在，说清楚并给一个重试
            Fail("页面进程退出了（" + e.ProcessFailedKind + "）。" + Environment.NewLine + Environment.NewLine
                 + "点「重试」重新载入。");
        }

        private bool IsInternal(Uri target)
        {
            if (target.Scheme != Uri.UriSchemeHttp && target.Scheme != Uri.UriSchemeHttps)
            {
                // about:blank 是 WebView2 自己会走的空页；data: / blob: 是页面内部用的，都不往外开
                return target.Scheme == "about" || target.Scheme == "data" || target.Scheme == "blob";
            }
            return string.Equals(target.Host, _host, StringComparison.OrdinalIgnoreCase)
                   && target.Port == _port
                   && string.Equals(target.Scheme, _scheme, StringComparison.OrdinalIgnoreCase);
        }

        private static void OpenExternal(Uri target)
        {
            try
            {
                Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true });
            }
            catch (Exception)
            {
                // 没有默认浏览器、或者策略不让开：不因此崩，用户自己复制地址也行
            }
        }

        private static string Describe(CoreWebView2WebErrorStatus status)
        {
            switch (status)
            {
                case CoreWebView2WebErrorStatus.HostNameNotResolved:
                    return "域名解析不出来（是不是断网了）";
                case CoreWebView2WebErrorStatus.ServerUnreachable:
                    return "服务器连不上（可能在重启）";
                case CoreWebView2WebErrorStatus.ConnectionAborted:
                case CoreWebView2WebErrorStatus.ConnectionReset:
                case CoreWebView2WebErrorStatus.Disconnected:
                    return "连接被断开了";
                case CoreWebView2WebErrorStatus.Timeout:
                    return "等太久了，服务器没有回应";
                case CoreWebView2WebErrorStatus.CannotConnect:
                    return "连不上服务器";
                case CoreWebView2WebErrorStatus.CertificateExpired:
                case CoreWebView2WebErrorStatus.CertificateIsInvalid:
                case CoreWebView2WebErrorStatus.CertificateCommonNameIsIncorrect:
                case CoreWebView2WebErrorStatus.CertificateRevoked:
                    return "网站的证书有问题";
                default:
                    return status.ToString();
            }
        }

        // MARK: - 载入中 / 失败 / 重试

        private void ShowMessage(string message, bool retryable)
        {
            _overlayText.Text = message;
            _retryButton.Visible = retryable;
            _web.Visible = false;
            _overlay.Visible = true;
            _overlay.BringToFront();
        }

        private void ShowPage()
        {
            _overlay.Visible = false;
            _web.Visible = true;
        }

        private void Fail(string message)
        {
            ShowMessage(message, true);
            _retryButton.Focus();
        }

        private void Retry()
        {
            if (!_webReady)
            {
                // 上次连环境都没建起来：整条启动流程重来
                var restart = StartAsync();
                GC.KeepAlive(restart);
                return;
            }
            NavigateHome();
        }

        // MARK: - 快捷键、退出

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            // 焦点在网页里时，Ctrl+R / F5 由 WebView2 自己处理；网页没焦点（比如刚才没连上、
            // 只剩说明和一个按钮）时落到这里，否则用户会以为「重载键坏了」
            if (keyData == (Keys.Control | Keys.R) || keyData == Keys.F5)
            {
                Retry();
                return true;
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            WindowPlacement.Save(this);
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (_web != null)
            {
                _web.Dispose();
            }
            base.OnFormClosed(e);
        }
    }
}
