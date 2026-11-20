using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace Zhiqu.Desktop
{
    internal static class LocalRuntime
    {
        internal const string ResourceName = "Zhiqu.Desktop.zhiqu-local.zip";
        private static readonly SemaphoreSlim Gate = new SemaphoreSlim(1, 1);
        private static string _prepared;
        private static string _problem;

        internal static bool Bundled
        {
            get { return typeof(LocalRuntime).Assembly.GetManifestResourceInfo(ResourceName) != null; }
        }

        internal static string NodePath(string root) { return Path.Combine(root, "node", "node.exe"); }
        internal static string HostPath(string root) { return Path.Combine(root, "zhiqu-cli", "src", "host", "code-host.js"); }
        private static string Extended(string path)
        {
            string full = Path.GetFullPath(path);
            if (full.StartsWith(@"\\?\", StringComparison.Ordinal)) return full;
            if (full.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + full.Substring(2);
            return @"\\?\" + full;
        }

        internal static async Task<string> PrepareAsync()
        {
            if (_prepared != null && File.Exists(NodePath(_prepared)) && File.Exists(HostPath(_prepared))) return _prepared;
            if (_problem != null) throw new InvalidOperationException(_problem);
            await Gate.WaitAsync().ConfigureAwait(false);
            try
            {
                if (_prepared != null) return _prepared;
                try
                {
                    Assembly assembly = typeof(LocalRuntime).Assembly;
                    using (Stream source = assembly.GetManifestResourceStream(ResourceName))
                    {
                        if (source == null) throw new InvalidOperationException("安装包里缺本机代码助手，请重新安装");
                        byte[] bytes = new byte[source.Length];
                        int offset = 0;
                        while (offset < bytes.Length)
                        {
                            int read = source.Read(bytes, offset, bytes.Length - offset);
                            if (read == 0) throw new EndOfStreamException();
                            offset += read;
                        }
                        string digest;
                        using (var sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", string.Empty).ToLowerInvariant();
                        string parent = DesktopPaths.DataFolder("runtime");
                        string target = Path.Combine(parent, digest.Substring(0, 16));
                        if (!File.Exists(NodePath(target)) || !File.Exists(HostPath(target)))
                        {
                            Directory.CreateDirectory(parent);
                            string staging = Path.Combine(parent, ".extract-" + Guid.NewGuid().ToString("N"));
                            try
                            {
                                Directory.CreateDirectory(staging);
                                using (var memory = new MemoryStream(bytes, false))
                                using (var archive = new ZipArchive(memory, ZipArchiveMode.Read))
                                {
                                    foreach (ZipArchiveEntry entry in archive.Entries)
                                    {
                                        string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                                        if (Path.IsPathRooted(relative) || relative.StartsWith("..") || relative.Contains(Path.DirectorySeparatorChar + ".."))
                                            throw new InvalidOperationException("安装包里的本机代码助手路径不对");
                                        string destination = Path.Combine(staging, relative);
                                        if (!LocalPath.Under(destination, staging)) throw new InvalidOperationException("安装包里的本机代码助手路径不对");
                                        string writePath = Extended(destination);
                                        if (string.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(writePath); continue; }
                                        Directory.CreateDirectory(Extended(Path.GetDirectoryName(destination)));
                                        entry.ExtractToFile(writePath, true);
                                    }
                                }
                                if (!File.Exists(NodePath(staging)) || !File.Exists(HostPath(staging)))
                                    throw new InvalidOperationException("安装包里的本机代码助手不完整");
                                try { Directory.Move(staging, target); }
                                catch (IOException) when (Directory.Exists(target)) { Directory.Delete(staging, true); }
                            }
                            catch { try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { } throw; }
                        }
                        _prepared = target;
                        return target;
                    }
                }
                catch (Exception error)
                {
                    _problem = "本机代码助手释放不出来：" + error.Message;
                    throw new InvalidOperationException(_problem);
                }
            }
            finally { Gate.Release(); }
        }
    }
}
