using System;
using Microsoft.Win32;

namespace Zhiqu.Desktop
{
    /// <summary>
    /// 桌面应用打开哪个网站（对应 macOS 外壳的 <c>Server.swift</c>）。
    ///
    /// <para>默认 <c>https://zhiqustudy.com</c>。开发时指到本机的后端：</para>
    /// <code>
    /// set ZHIQU_DESKTOP_SERVER=http://127.0.0.1:8080        （只对这次启动有效）
    /// reg add HKCU\Software\zhiqu\desktop /v server /d http://127.0.0.1:8080      （一直有效）
    /// reg delete HKCU\Software\zhiqu\desktop /v server /f   （改回去）
    /// </code>
    ///
    /// <para>只认 https，http 只给本机（登录令牌不能走明文过公网）；认不出的照默认来。</para>
    /// </summary>
    internal static class ServerConfig
    {
        internal static readonly Uri Fallback = new Uri("https://zhiqustudy.com");

        private const string EnvironmentVariable = "ZHIQU_DESKTOP_SERVER";
        private const string RegistryPath = @"Software\zhiqu\desktop";
        private const string RegistryValue = "server";

        private static readonly string[] LoopbackHosts = { "127.0.0.1", "localhost" };

        /// <summary>这次启动打开哪个网站。</summary>
        internal static Uri Resolve()
        {
            string given = Environment.GetEnvironmentVariable(EnvironmentVariable);
            if (string.IsNullOrWhiteSpace(given))
            {
                given = ReadRegistry();
            }
            Uri accepted = string.IsNullOrWhiteSpace(given) ? null : Acceptable(given);
            return accepted ?? Fallback;
        }

        private static string ReadRegistry()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryPath))
                {
                    return key == null ? null : key.GetValue(RegistryValue) as string;
                }
            }
            catch (Exception)
            {
                // 注册表读不到不算错：照默认网站打开，别让一个配置项把应用卡在启动前
                return null;
            }
        }

        /// <summary>
        /// 认得的地址：https 的任何主机，或者本机的 http；只要「协议 + 主机 + 端口」，
        /// 路径、查询、用户名密码一概不收（照 macOS 那份的规则，两边行为要一致）。
        /// </summary>
        internal static bool IsOrigin(Uri server, string source)
        {
            Uri origin;
            if (!Uri.TryCreate(source, UriKind.Absolute, out origin)) return false;
            return string.Equals(origin.Scheme, server.Scheme, StringComparison.OrdinalIgnoreCase)
                   && string.Equals(origin.Host, server.Host, StringComparison.OrdinalIgnoreCase)
                   && origin.Port == server.Port;
        }

        internal static Uri Acceptable(string text)
        {
            Uri parsed;
            if (!Uri.TryCreate((text ?? string.Empty).Trim(), UriKind.Absolute, out parsed))
            {
                return null;
            }
            if (parsed.Scheme != Uri.UriSchemeHttps && parsed.Scheme != Uri.UriSchemeHttp)
            {
                return null;
            }
            if (string.IsNullOrEmpty(parsed.Host) || !string.IsNullOrEmpty(parsed.UserInfo))
            {
                return null;
            }
            if (!(parsed.AbsolutePath == "/" || parsed.AbsolutePath.Length == 0) || parsed.Query.Length > 0)
            {
                return null;
            }
            if (parsed.Fragment.Length > 0)
            {
                return null;
            }

            string host = parsed.Host.ToLowerInvariant();
            bool loopback = Array.IndexOf(LoopbackHosts, host) >= 0;
            if (parsed.Scheme == Uri.UriSchemeHttp && !loopback)
            {
                return null;
            }

            // 主机名一律小写：页面里导航的地址 WebView2 给的是小写的，
            // 按原样比就成了「A.com 不是自己的网站」，什么都往外开（macOS 那份踩过同一个坑）
            string built = parsed.Scheme + "://" + host;
            if (!parsed.IsDefaultPort)
            {
                built += ":" + parsed.Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            return new Uri(built + "/");
        }
    }
}
