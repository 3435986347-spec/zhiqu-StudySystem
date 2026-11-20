using System;
using System.Windows.Forms;

namespace Zhiqu.Desktop
{
    internal sealed class DesktopNotifications : IDisposable
    {
        private readonly NotifyIcon _icon;

        internal DesktopNotifications(System.Drawing.Icon icon, Action open)
        {
            _icon = new NotifyIcon
            {
                Icon = icon,
                Text = ShellForm.WindowTitle,
                Visible = true,
            };
            _icon.BalloonTipClicked += delegate { open(); };
            _icon.DoubleClick += delegate { open(); };
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开知趣象限", null, delegate { open(); });
            menu.Items.Add("退出", null, delegate { Application.Exit(); });
            _icon.ContextMenuStrip = menu;
        }

        internal Action<string, string, string> Sink;

        internal void Authorize()
        {
        }

        internal void Notify(string title, string body, string tag)
        {
            if (Sink != null) { Sink(title, body, tag); return; }
            string heading = Json.Limit(string.IsNullOrWhiteSpace(title) ? "知趣" : title, 63);
            string text = Json.Limit(body, 240);
            _icon.ShowBalloonTip(6000, heading, text, ToolTipIcon.Info);
        }

        public void Dispose()
        {
            _icon.Visible = false;
            _icon.Dispose();
        }
    }
}
