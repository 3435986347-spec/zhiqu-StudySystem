using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Zhiqu.Desktop
{
    internal sealed class WindowsJob : IDisposable
    {
        private const uint JobObjectExtendedLimitInformation = 9;
        private const uint LimitKillOnJobClose = 0x2000;
        private IntPtr _handle;

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            internal ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            internal long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            internal BasicLimitInformation BasicLimitInformation;
            internal IoCounters IoInfo;
            internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, uint type, ref ExtendedLimitInformation information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        internal static WindowsJob Create(Process process)
        {
            IntPtr handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("建不了进程回收边界");
            var info = new ExtendedLimitInformation();
            info.BasicLimitInformation.LimitFlags = LimitKillOnJobClose;
            if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation)))
                || !AssignProcessToJobObject(handle, process.Handle))
            {
                CloseHandle(handle);
                throw new InvalidOperationException("本机代码助手加不进进程回收边界（" + Marshal.GetLastWin32Error() + "）");
            }
            return new WindowsJob { _handle = handle };
        }

        public void Dispose()
        {
            IntPtr handle = _handle;
            _handle = IntPtr.Zero;
            if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
}
