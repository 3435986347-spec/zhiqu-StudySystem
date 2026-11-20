using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Zhiqu.Desktop
{
    internal sealed class MiniWindow : Form
    {
        internal const int DipWidth = 300;
        internal const int DipHeight = 68;
        private const int WmNclButtonDown = 0xA1;
        private const int HtCaption = 2;
        private const int WsExNoActivate = 0x08000000;
        private const int WsExToolWindow = 0x00000080;

        private readonly WebView2 _web;
        private readonly Action _expand;
        private readonly float _scale;
        private bool _ready;
        private bool _moving;

        internal MiniWindow(CoreWebView2Environment environment, Uri server, Icon icon, float scale, Action expand, Action<string> notify)
        {
            _scale = scale;
            _expand = expand;
            Text = "迷你番茄钟";
            Icon = icon;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Color.Black;
            Size = new Size(Scaled(DipWidth), Scaled(DipHeight));
            Restore();

            _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Transparent };
            Controls.Add(_web);
            Load += async delegate
            {
                try
                {
                    await _web.EnsureCoreWebView2Async(environment);
                    CoreWebView2 core = _web.CoreWebView2;
                    core.Settings.IsStatusBarEnabled = false;
                    core.Settings.AreDevToolsEnabled = false;
                    core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                    await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript.For(false));
                    await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript.MiniDrag);
                    core.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e)
                    {
                        if (!ServerConfig.IsOrigin(server, e.Source)) return;
                        Dictionary<string, object> message;
                        try { message = Json.Object(e.WebMessageAsJson); } catch { return; }
                        string bridge = Json.Text(message, "bridge");
                        var body = Json.Object(message.ContainsKey("body") ? message["body"] : null);
                        string action = Json.Text(body, "action");
                        if (bridge == "zqMiniDrag") Drag();
                        else if (bridge == "zqMini" && action == "expand") _expand();
                        else if (bridge == "zqNotify") notify(e.WebMessageAsJson);
                    };
                    _ready = true;
                    core.Navigate(new Uri(server, "/mini.html").AbsoluteUri);
                }
                catch (Exception error)
                {
                    MessageBox.Show("迷你番茄钟起不来：" + error.Message, ShellForm.WindowTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    _expand();
                }
            };
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Margins
        {
            internal int Left, Right, Top, Bottom;
            internal Margins(int value) { Left = Right = Top = Bottom = value; }
        }
        [DllImport("dwmapi.dll")]
        private static extern int DwmExtendFrameIntoClientArea(IntPtr window, ref Margins margins);

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                var margins = new Margins(-1);
                DwmExtendFrameIntoClientArea(Handle, ref margins);
            }
            catch { }
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WsExNoActivate | WsExToolWindow;
                return cp;
            }
        }

        internal void ReloadPage()
        {
            if (_ready && _web.CoreWebView2 != null) _web.CoreWebView2.Reload();
        }

        private int Scaled(int value)
        {
            return (int)Math.Round(value * _scale);
        }

        private void Drag()
        {
            if (_moving) return;
            _moving = true;
            try
            {
                NativeMethods.ReleaseCapture();
                NativeMethods.SendMessage(Handle, WmNclButtonDown, new IntPtr(HtCaption), IntPtr.Zero);
            }
            finally { _moving = false; }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                _expand();
                return;
            }
            Save();
            base.OnFormClosing(e);
        }

        private string PlacementFile
        {
            get { return DesktopPaths.DataFolder("mini-window.ini"); }
        }

        private void Restore()
        {
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            Bounds = new Rectangle(area.Right - Width - Scaled(24), area.Top + Scaled(24), Width, Height);
            try
            {
                string[] lines = File.ReadAllLines(PlacementFile);
                int left = 0, top = 0;
                foreach (string line in lines)
                {
                    string[] pair = line.Split(new[] { '=' }, 2);
                    if (pair.Length != 2) continue;
                    if (pair[0] == "left") int.TryParse(pair[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out left);
                    if (pair[0] == "top") int.TryParse(pair[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out top);
                }
                var candidate = new Rectangle(left, top, Width, Height);
                foreach (Screen screen in Screen.AllScreens)
                {
                    Rectangle visible = Rectangle.Intersect(screen.WorkingArea, candidate);
                    if (visible.Width >= Scaled(120) && visible.Height >= Scaled(40)) { Location = candidate.Location; break; }
                }
            }
            catch { }
        }

        private void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(PlacementFile));
                File.WriteAllLines(PlacementFile, new[]
                {
                    "left=" + Left.ToString(CultureInfo.InvariantCulture),
                    "top=" + Top.ToString(CultureInfo.InvariantCulture),
                });
            }
            catch { }
        }

        internal void SavePlacement() { Save(); }
    }
}
