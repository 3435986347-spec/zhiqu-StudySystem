using System;
using System.Windows.Forms;

namespace Zhiqu.Desktop
{
    internal static class Program
    {
        /// <summary>
        /// 一个消息循环、一个窗口。窗口本身就是全部界面 —— 这里不启动任何后端（macOS 外壳从第一百二十五轮起也是）。
        /// </summary>
        [STAThread]
        private static void Main()
        {
            using (SingleInstance instance = SingleInstance.Acquire())
            {
                if (instance == null)
                {
                    // 已经有一个在跑，而且已经被叫到前面了。第二个进程直接退出，不留窗口、不抢焦点。
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new ShellForm());
            }
        }
    }
}
