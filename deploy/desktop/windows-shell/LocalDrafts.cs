using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Zhiqu.Desktop
{
    internal static class LocalDrafts
    {
        internal const string Absent = "ABSENT";
        private const int MaxFiles = 40;
        private const int MaxBytes = 1000000;
        private static readonly Regex ShaShape = new Regex("^[0-9a-f]{64}$", RegexOptions.Compiled);
        private static readonly Regex DeviceName = new Regex(@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        internal static string Sha256(byte[] data)
        {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(data)).Replace("-", string.Empty).ToLowerInvariant();
        }

        private static string Sha256File(string path)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty).ToLowerInvariant();
        }

        private static bool ValidPart(string part)
        {
            return !string.IsNullOrEmpty(part) && part != "." && part != ".." && !part.EndsWith(".") && !part.EndsWith(" ")
                && part.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && part.IndexOf(':') < 0 && !DeviceName.IsMatch(part);
        }

        internal static string Resolve(string root, string relative)
        {
            if (string.IsNullOrEmpty(relative) || relative.Length > 512 || relative.IndexOf('\0') >= 0
                || relative.IndexOf('\\') >= 0 || relative.StartsWith("/")) return null;
            string[] parts = relative.Split('/');
            foreach (string part in parts) if (!ValidPart(part)) return null;
            string basePath;
            try { basePath = LocalPath.Real(root); } catch { return null; }
            if (!LocalPath.IsDirectory(basePath)) return null;
            string current = basePath;
            for (int i = 0; i < parts.Length; i++)
            {
                string next = Path.Combine(current, parts[i]);
                if (File.Exists(next) || Directory.Exists(next))
                {
                    string resolved = LocalPath.Real(next);
                    if (!LocalPath.Under(resolved, basePath)) return null;
                    if (i == parts.Length - 1) return Directory.Exists(resolved) ? null : resolved;
                    if (!Directory.Exists(resolved)) return null;
                    current = resolved;
                }
                else
                {
                    string destination = next;
                    for (int j = i + 1; j < parts.Length; j++) destination = Path.Combine(destination, parts[j]);
                    return LocalPath.Under(destination, basePath) ? Path.GetFullPath(destination) : null;
                }
            }
            return null;
        }

        private sealed class Job
        {
            internal string Relative;
            internal string Destination;
            internal byte[] Data;
        }

        internal static string Apply(string folder, object rawFiles)
        {
            if (!LocalPath.IsDirectory(folder)) return "这个项目文件夹不在了";
            IEnumerable items = rawFiles as IEnumerable;
            if (items == null || rawFiles is string) return "没有要写入的文件";
            var jobs = new List<Job>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            int total = 0;
            foreach (object item in items)
            {
                var raw = Json.Object(item);
                if (raw == null) return "有一个文件认不出来";
                string rel = Json.Text(raw, "path");
                if (string.IsNullOrEmpty(rel)) return "有一个文件没写路径";
                if (!seen.Add(rel)) return "同一个文件写了两次：" + rel;
                if (seen.Count > MaxFiles) return "一次最多写 " + MaxFiles + " 个文件";
                string dest = Resolve(folder, rel);
                if (dest == null) return "这个路径不能写：" + rel;
                string baseline = Json.Text(raw, "baseline");
                if (baseline != Absent && (baseline == null || !ShaShape.IsMatch(baseline))) return "基线不对：" + rel;
                byte[] data = new UTF8Encoding(false).GetBytes(Json.Text(raw, "content") ?? string.Empty);
                if (data.Length > MaxBytes) return rel + " 太大了";
                total += data.Length;
                if (total > MaxBytes * 8) return "这一批太大了";
                string now;
                try { now = File.Exists(dest) ? Sha256File(dest) : Absent; }
                catch { return "读不到现在的文件：" + rel; }
                if (now == Sha256(data)) continue;
                if (now != baseline) return rel + " 和你看到的不一样了，没有写入";
                jobs.Add(new Job { Relative = rel, Destination = dest, Data = data });
            }
            if (seen.Count == 0) return "没有要写入的文件";
            foreach (Job job in jobs)
            {
                string parent = Path.GetDirectoryName(job.Destination);
                try { Directory.CreateDirectory(parent); } catch { return "建不了目录：" + parent; }
                if (!LocalPath.Under(parent, folder)) return "这个路径不能写：" + job.Relative;
                string temporary = job.Destination + ".zhiqu-confirm-" + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    File.WriteAllBytes(temporary, job.Data);
                    if (File.Exists(job.Destination)) File.Replace(temporary, job.Destination, null);
                    else File.Move(temporary, job.Destination);
                }
                catch { try { File.Delete(temporary); } catch { } return "写不进去：" + job.Relative; }
            }
            return null;
        }

        internal static Dictionary<string, object> Read(string folder, string path, out string error)
        {
            error = null;
            string destination = Resolve(folder, path);
            if (destination == null) { error = "这个路径不能读"; return null; }
            if (!File.Exists(destination)) return new Dictionary<string, object> { { "content", "" }, { "absent", true } };
            try
            {
                if (new FileInfo(destination).Length > MaxBytes) { error = "这个文件太大，确认框里对不了"; return null; }
                byte[] data = File.ReadAllBytes(destination);
                string content = new UTF8Encoding(false, true).GetString(data);
                return new Dictionary<string, object> { { "content", content }, { "absent", false } };
            }
            catch (DecoderFallbackException) { error = "这个文件不是 UTF-8 文本"; return null; }
            catch { error = "读不到这个文件"; return null; }
        }
    }
}
