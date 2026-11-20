using System;
using System.Drawing;
using System.Windows.Forms;

namespace Zhiqu.Desktop
{
    internal sealed class UpdateBadge : Panel
    {
        private readonly Label _text = new Label();
        private readonly Button _close = new Button();
        internal Action Activated, Skipped;

        internal UpdateBadge()
        {
            AutoSize = false;
            Visible = false;
            BackColor = Color.FromArgb(249, 251, 255);
            ForeColor = Color.FromArgb(39, 63, 92);
            Padding = new Padding(12, 0, 8, 0);
            Anchor = AnchorStyles.Left | AnchorStyles.Bottom;
            Cursor = Cursors.Hand;
            _text.AutoSize = false;
            _text.Dock = DockStyle.Fill;
            _text.TextAlign = ContentAlignment.MiddleLeft;
            _text.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular);
            _close.Dock = DockStyle.Right;
            _close.Width = 26;
            _close.FlatStyle = FlatStyle.Flat;
            _close.FlatAppearance.BorderSize = 0;
            _close.Text = "×";
            _close.Cursor = Cursors.Default;
            _close.Click += delegate { if (Skipped != null) Skipped(); };
            Controls.Add(_text); Controls.Add(_close);
            _text.Click += delegate { Activate(); };
            Click += delegate { Activate(); };
        }

        private void Activate() { if (Activated != null) Activated(); }

        internal void Show(UpdatePhase phase, float scale, int parentHeight)
        {
            Visible = phase.State != UpdateState.Idle;
            _close.Visible = phase.State == UpdateState.Available || phase.State == UpdateState.Ready || phase.State == UpdateState.Failed;
            Cursor = phase.State == UpdateState.Available || phase.State == UpdateState.Ready ? Cursors.Hand : Cursors.Default;
            switch (phase.State)
            {
                case UpdateState.Available: _text.Text = "有新版本 " + phase.Release.Version; break;
                case UpdateState.Downloading:
                    int percent = phase.Total > 0 ? (int)Math.Min(100, Math.Round(100D * phase.Received / phase.Total)) : 0;
                    _text.Text = "正在下载 " + percent + "%"; break;
                case UpdateState.Ready: _text.Text = "重启完成更新 " + phase.Release.Version; break;
                case UpdateState.Installing: _text.Text = "正在更新…"; break;
                case UpdateState.Failed: _text.Text = "更新失败：" + Json.Limit(phase.Error, 70); break;
                default: return;
            }
            _text.Font = new Font("Microsoft YaHei UI", 9F * scale, FontStyle.Regular);
            _text.Cursor = Cursor;
            _close.Font = new Font("Microsoft YaHei UI", 9F * scale, FontStyle.Regular);
            Size = new Size((int)Math.Round(300 * scale), (int)Math.Round(36 * scale));
            _close.Width = (int)Math.Round(26 * scale);
            Location = new Point((int)Math.Round(16 * scale), Math.Max(0, parentHeight - Height - (int)Math.Round(72 * scale)));
            BringToFront();
        }
    }
}
