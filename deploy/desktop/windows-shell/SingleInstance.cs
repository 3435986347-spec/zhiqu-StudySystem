using System;
using System.Threading;

namespace Zhiqu.Desktop
{
    /// <summary>
    /// 只允许开一个窗口。对应 macOS 外壳的「单实例」逻辑（<c>docs/notes/desktop.md</c> 里那张表）。
    ///
    /// <para>为什么要有：双击第二次时不该出现两个窗口、两份缓存、两个登录态。第二个进程把已有窗口叫到前面，
    /// 自己退出。用 <c>Local\</c> 前缀 —— 同一个用户的会话内互斥，不跨用户、不影响远程桌面另一个人登录。</para>
    /// </summary>
    internal sealed class SingleInstance : IDisposable
    {
        private const string DefaultMutexName = @"Local\zhiqu-desktop-shell";

        private readonly Mutex _mutex;

        private SingleInstance(Mutex mutex)
        {
            _mutex = mutex;
        }

        /// <summary>拿到互斥体就返回它；已经有一个在跑就把那个叫到前面、返回 <c>null</c>。</summary>
        internal static SingleInstance Acquire()
        {
            bool created;
            string suffix = Environment.GetEnvironmentVariable("ZHIQU_DESKTOP_INSTANCE");
            string name = !string.IsNullOrEmpty(suffix) && System.Text.RegularExpressions.Regex.IsMatch(suffix, "^[A-Za-z0-9-]{1,64}$")
                ? DefaultMutexName + "-" + suffix : DefaultMutexName;
            var mutex = new Mutex(true, name, out created);
            if (created)
            {
                return new SingleInstance(mutex);
            }
            mutex.Dispose();
            BringRunningToFront();
            return null;
        }

        /// <summary>
        /// 按窗口标题找已有窗口。找不到不是错误（对方可能正好在退出）—— 那就不叫了，用户再点一次就好。
        /// 标题是常量、整个应用只有这一个窗口，所以按标题找是够的；自定义类名要注册窗口类，为这一件事不值得。
        /// </summary>
        private static void BringRunningToFront()
        {
            IntPtr window = NativeMethods.FindWindow(null, ShellForm.WindowTitle);
            if (window == IntPtr.Zero)
            {
                return;
            }
            if (NativeMethods.IsIconic(window))
            {
                NativeMethods.ShowWindow(window, NativeMethods.SwRestore);
            }
            NativeMethods.SetForegroundWindow(window);
        }

        public void Dispose()
        {
            try
            {
                _mutex.ReleaseMutex();
            }
            catch (ApplicationException)
            {
                // 没持有（理论上不会走到）—— 释放失败不该影响退出
            }
            _mutex.Dispose();
        }
    }
}
