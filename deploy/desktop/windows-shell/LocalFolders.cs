using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Zhiqu.Desktop
{
    internal static class LocalPath
    {
        private const uint FileFlagBackupSemantics = 0x02000000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(string name, uint access, FileShare share, IntPtr security, FileMode mode, uint flags, IntPtr template);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);

        internal static string Real(string path)
        {
            string full = Path.GetFullPath(path);
            string root = Path.GetPathRoot(full);
            if (full.Length > root.Length) full = full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string suffix = string.Empty;
            string current = full;
            while (!File.Exists(current) && !Directory.Exists(current))
            {
                string parent = Directory.GetParent(current) == null ? null : Directory.GetParent(current).FullName;
                if (string.IsNullOrEmpty(parent)) break;
                suffix = Path.GetFileName(current) + (suffix.Length == 0 ? string.Empty : Path.DirectorySeparatorChar + suffix);
                current = parent;
            }
            string resolved = Final(current);
            return suffix.Length == 0 ? resolved : Path.Combine(resolved, suffix);
        }

        private static string Final(string path)
        {
            using (SafeFileHandle handle = CreateFile(path, 0, FileShare.ReadWrite | FileShare.Delete, IntPtr.Zero,
                       FileMode.Open, FileFlagBackupSemantics, IntPtr.Zero))
            {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                var text = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0);
                if (length == 0 || length >= (uint)text.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
                string value = text.ToString(0, (int)length);
                if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\" + value.Substring(8);
                if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) return value.Substring(4);
                return value;
            }
        }

        internal static bool Under(string path, string root)
        {
            string p = Real(path).TrimEnd('\\', '/');
            string r = Real(root).TrimEnd('\\', '/');
            return string.Equals(p, r, StringComparison.OrdinalIgnoreCase)
                   || p.StartsWith(r + "\\", StringComparison.OrdinalIgnoreCase);
        }

        internal static bool IsDirectory(string path)
        {
            return !string.IsNullOrEmpty(path) && Directory.Exists(path);
        }
    }

    internal sealed class LocalFolders
    {
        private const string RegistryPath = @"Software\zhiqu\desktop";
        private const string RegistryValue = "localFolders";
        private const int Limit = 20;
        private readonly string _home;
        private readonly string _registryPath;

        internal LocalFolders() : this(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), DefaultRegistryPath()) { }

        private static string DefaultRegistryPath()
        {
            string profile = Environment.GetEnvironmentVariable("ZHIQU_DESKTOP_PROFILE");
            if (string.IsNullOrEmpty(profile) || !Path.IsPathRooted(profile)) return RegistryPath;
            using (var sha = System.Security.Cryptography.SHA256.Create())
            {
                string suffix = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(profile)))).Replace("-", string.Empty).Substring(0, 16);
                return RegistryPath + "-check-" + suffix;
            }
        }

        internal LocalFolders(string home) : this(home, RegistryPath) { }

        internal LocalFolders(string home, string registryPath)
        {
            _home = LocalPath.Real(home);
            _registryPath = registryPath;
        }

        internal string[] All()
        {
            var found = new List<string>();
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(_registryPath))
                {
                    string[] saved = key == null ? null : key.GetValue(RegistryValue) as string[];
                    foreach (string item in saved ?? new string[0])
                    {
                        try
                        {
                            string path = LocalPath.Real(item);
                            if (LocalPath.IsDirectory(path) && !found.Contains(path)) found.Add(path);
                        }
                        catch { }
                    }
                }
            }
            catch { }
            return found.ToArray();
        }

        internal string Add(string selected)
        {
            string path = LocalPath.Real(selected);
            string root = Path.GetPathRoot(path).TrimEnd('\\', '/');
            if (string.Equals(path.TrimEnd('\\', '/'), root, StringComparison.OrdinalIgnoreCase)
                || LocalPath.Under(_home, path))
                throw new InvalidOperationException("不能把整个磁盘、整个家目录（或者装着它的文件夹）当项目文件夹，选一个具体的项目");
            if (!LocalPath.IsDirectory(path)) throw new InvalidOperationException("这个文件夹不在了");
            var list = new List<string>(All());
            list.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
            list.Insert(0, path);
            if (list.Count > Limit) list.RemoveRange(Limit, list.Count - Limit);
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(_registryPath))
            {
                key.SetValue(RegistryValue, list.ToArray(), RegistryValueKind.MultiString);
            }
            return path;
        }

        internal bool Contains(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            string real;
            try { real = LocalPath.Real(path); } catch { return false; }
            foreach (string allowed in All())
                if (string.Equals(real, allowed, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
    }
}
