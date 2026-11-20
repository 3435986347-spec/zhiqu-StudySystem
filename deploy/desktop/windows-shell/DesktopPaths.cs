using System;
using System.IO;

namespace Zhiqu.Desktop
{
    internal static class DesktopPaths
    {
        internal static string DataFolder(string name)
        {
            string profile = Environment.GetEnvironmentVariable("ZHIQU_DESKTOP_PROFILE");
            if (!string.IsNullOrEmpty(profile) && Path.IsPathRooted(profile)) return Path.Combine(profile, name);
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "zhiqu", name);
        }
    }
}
