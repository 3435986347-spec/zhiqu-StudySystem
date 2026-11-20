using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Zhiqu.Desktop
{
    internal sealed class UpdateRelease
    {
        internal string Version, FileName, Sha256;
        internal long Size;
        internal Uri Url;
    }

    internal struct UpdatePhase
    {
        internal UpdateState State;
        internal UpdateRelease Release;
        internal long Received, Total;
        internal string Error;
    }

    internal enum UpdateState { Idle, Available, Downloading, Ready, Installing, Failed }

    internal static class UpdateCheck
    {
        internal static bool IsNewer(string candidate, string current)
        {
            long[] left = Parts(candidate), right = Parts(current);
            if (left == null || right == null) return false;
            for (int i = 0; i < 3; i++) if (left[i] != right[i]) return left[i] > right[i];
            return false;
        }

        private static long[] Parts(string version)
        {
            if (string.IsNullOrEmpty(version) || version.Length > 64) return null;
            string[] pieces = version.Split('-')[0].Split('.');
            if (pieces.Length == 0 || pieces.Length > 4) return null;
            var result = new long[3];
            for (int i = 0; i < pieces.Length; i++)
            {
                long value;
                if (!long.TryParse(pieces[i], NumberStyles.None, CultureInfo.InvariantCulture, out value)) return null;
                if (i < 3) result[i] = value;
            }
            return result;
        }

        internal static UpdateRelease Parse(string json, Uri server)
        {
            Dictionary<string, object> root;
            try { root = Json.Object(json); } catch { return null; }
            var data = Json.Object(root != null && root.ContainsKey("data") ? root["data"] : null);
            var windows = Json.Object(data != null && data.ContainsKey("windows") ? data["windows"] : null);
            if (windows == null) return null;
            string version = Json.Text(windows, "version"), sha = Json.Text(windows, "sha256"), url = Json.Text(windows, "url");
            if (string.IsNullOrWhiteSpace(version) || version.Length > 64 || sha == null || !Regex.IsMatch(sha, "^[0-9a-fA-F]{64}$")) return null;
            object rawSize = windows.ContainsKey("size") ? windows["size"] : null;
            long size;
            if (rawSize == null || !long.TryParse(Convert.ToString(rawSize, CultureInfo.InvariantCulture), out size) || size <= 0 || size > 1024L * 1024 * 1024) return null;
            Uri target;
            if (!Uri.TryCreate(server, url, out target) || !ServerConfig.IsOrigin(server, target.AbsoluteUri)) return null;
            if (target.AbsolutePath != "/api/desktop/downloads/windows" && !string.Equals(Path.GetExtension(target.AbsolutePath), ".exe", StringComparison.OrdinalIgnoreCase)) return null;
            return new UpdateRelease { Version = version, Sha256 = sha.ToLowerInvariant(), Size = size, Url = target, FileName = Path.GetFileName(Json.Text(windows, "fileName") ?? "ZhiquShell.exe") };
        }

        internal static string Sha256(string file)
        {
            using (var stream = File.OpenRead(file))
            using (var sha = System.Security.Cryptography.SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty).ToLowerInvariant();
        }
    }

    internal sealed class Updater : IDisposable
    {
        private readonly Uri _server;
        private readonly string _current;
        private readonly HttpClient _http;
        private readonly SynchronizationContext _context;
        private readonly SemaphoreSlim _gate = new SemaphoreSlim(1, 1);
        private UpdatePhase _phase = new UpdatePhase { State = UpdateState.Idle };
        private string _package;
        private bool _checking;

        internal event Action<UpdatePhase> Changed;
        internal UpdatePhase Phase { get { return _phase; } }
        internal string Current { get { return _current; } }

        internal Updater(Uri server, string current = null)
        {
            _server = server;
            _current = current ?? typeof(Updater).Assembly.GetName().Version.ToString();
            _context = SynchronizationContext.Current;
            var handler = new HttpClientHandler { AllowAutoRedirect = false, AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate };
            _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(120) };
            _http.DefaultRequestHeaders.UserAgent.ParseAdd("ZhiquDesktop/" + _current);
        }

        internal async Task Check()
        {
            if (_checking || _phase.State == UpdateState.Downloading || _phase.State == UpdateState.Ready || _phase.State == UpdateState.Installing) return;
            _checking = true;
            try
            {
                using (var response = await _http.GetAsync(new Uri(_server, "/api/desktop/downloads")).ConfigureAwait(false))
                {
                    if (!response.IsSuccessStatusCode || (response.Content.Headers.ContentLength ?? 0) > 65536) return;
                    string json = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    if (Encoding.UTF8.GetByteCount(json) > 65536) return;
                    UpdateRelease release = UpdateCheck.Parse(json, _server);
                    if (release != null && UpdateCheck.IsNewer(release.Version, _current)) Set(new UpdatePhase { State = UpdateState.Available, Release = release });
                }
            }
            catch { }
            finally { _checking = false; }
        }

        internal async Task Download()
        {
            UpdateRelease release = _phase.Release;
            if (_phase.State != UpdateState.Available || release == null) return;
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                if (_phase.State != UpdateState.Available) return;
                Set(new UpdatePhase { State = UpdateState.Downloading, Release = release, Total = release.Size });
                string folder = DesktopPaths.DataFolder("updates");
                Directory.CreateDirectory(folder);
                string file = Path.Combine(folder, "ZhiquShell-" + Guid.NewGuid().ToString("N") + ".exe.download");
                try
                {
                    using (var response = await _http.GetAsync(release.Url, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
                    {
                        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("下载服务器回了 " + (int)response.StatusCode);
                        if ((response.Content.Headers.ContentLength ?? release.Size) != release.Size) throw new InvalidOperationException("下载包的大小和清单不一致，没有安装");
                        using (var input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                        using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
                        using (var sha = SHA256.Create())
                        {
                            byte[] buffer = new byte[65536]; long received = 0;
                            while (true)
                            {
                                int count = await input.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                                if (count == 0) break;
                                received += count;
                                if (received > release.Size) throw new InvalidOperationException("下载包比清单大，没有安装");
                                sha.TransformBlock(buffer, 0, count, null, 0);
                                await output.WriteAsync(buffer, 0, count).ConfigureAwait(false);
                                if (received % (1024 * 1024) < buffer.Length) Set(new UpdatePhase { State = UpdateState.Downloading, Release = release, Received = received, Total = release.Size });
                            }
                            sha.TransformFinalBlock(new byte[0], 0, 0);
                            if (received != release.Size) throw new InvalidOperationException("下载包的大小和清单不一致，没有安装");
                            string digest = BitConverter.ToString(sha.Hash).Replace("-", string.Empty).ToLowerInvariant();
                            if (digest != release.Sha256) throw new InvalidOperationException("下载的包和服务器上的对不上（sha256），没有安装。");
                        }
                    }
                    _package = file;
                    Set(new UpdatePhase { State = UpdateState.Ready, Release = release });
                }
                catch (Exception error)
                {
                    try { if (File.Exists(file)) File.Delete(file); } catch { }
                    Set(new UpdatePhase { State = UpdateState.Failed, Release = release, Error = error.Message });
                }
            }
            finally { _gate.Release(); }
        }

        internal void Skip()
        {
            if (_phase.Release != null)
            {
                try
                {
                    using (var key = Registry.CurrentUser.CreateSubKey(@"Software\zhiqu\desktop")) key.SetValue("skippedUpdate", _phase.Release.Version);
                }
                catch { }
            }
            if (_phase.State != UpdateState.Downloading && _phase.State != UpdateState.Installing) Set(new UpdatePhase { State = UpdateState.Idle });
        }

        internal string Skipped()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\zhiqu\desktop")) return key == null ? null : key.GetValue("skippedUpdate") as string;
            }
            catch { return null; }
        }

        internal void Restart()
        {
            if (_phase.State != UpdateState.Ready || _package == null || !File.Exists(_package)) return;
            try
            {
                string target = ApplicationExecutable();
                if (!File.Exists(target)) throw new InvalidOperationException("当前应用文件不在了，没有替换，请到网站手动下载");
                if (!string.Equals(Path.GetExtension(target), ".exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("这一份不是可替换的 Windows 应用，请到网站手动下载");
                string parent = Path.GetDirectoryName(target);
                if (Directory.Exists(parent) && !CanWrite(parent)) throw new InvalidOperationException("没有权限替换应用，请到网站手动下载 " + _phase.Release.Version);
                if (UpdateCheck.Sha256(_package) != _phase.Release.Sha256) throw new InvalidOperationException("下载文件已经变了，没有安装");
                Set(new UpdatePhase { State = UpdateState.Installing, Release = _phase.Release });
                StartHelper(_package, target, Environment.GetFolderPath(Environment.SpecialFolder.System));
                ApplicationExit();
            }
            catch (Exception error) { Set(new UpdatePhase { State = UpdateState.Failed, Release = _phase.Release, Error = error.Message }); }
        }

        internal Func<string> ApplicationExecutable = () => System.Windows.Forms.Application.ExecutablePath;
        internal Action ApplicationExit = () => System.Windows.Forms.Application.Exit();

        internal static bool CanWrite(string folder)
        {
            string file = Path.Combine(folder, ".zhiqu-write-" + Guid.NewGuid().ToString("N"));
            try { File.WriteAllText(file, string.Empty); File.Delete(file); return true; } catch { return false; }
        }

        internal static void StartHelper(string package, string target, string systemFolder)
        {
            string folder = DesktopPaths.DataFolder("updates");
            Directory.CreateDirectory(folder);
            string script = Path.Combine(folder, "install-" + Guid.NewGuid().ToString("N") + ".ps1");
            File.WriteAllText(script, HelperScript, new UTF8Encoding(true));
            string powershell = Path.Combine(systemFolder, "WindowsPowerShell", "v1.0", "powershell.exe");
            var start = new System.Diagnostics.ProcessStartInfo
            {
                FileName = powershell, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(script) + " " + System.Diagnostics.Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
                    + " " + Quote(package) + " " + Quote(target) + " " + Quote(Path.Combine(folder, "last-install.log")),
            };
            var process = System.Diagnostics.Process.Start(start);
            if (process == null) throw new InvalidOperationException("更新程序起不来，没有替换应用");
            process.Dispose();
        }

        private static string Quote(string s) { return "\"" + s.Replace("\"", "`\"") + "\""; }

        internal const string HelperScript = @"param([int]$OwnerPid, [string]$Source, [string]$Target, [string]$Log)
$ErrorActionPreference = 'Stop'
function Note([string]$Text) { Add-Content -LiteralPath $Log -Value $Text -Encoding UTF8 }
try {
    for ($i = 0; $i -lt 600 -and (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 200 }
    if (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue) { throw '原来的应用还没退出' }
    $next = $Target + '.new'
    $old = $Target + '.old'
    Remove-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $Source -Destination $next -Force
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $Target -Destination $old -Force
    try { Move-Item -LiteralPath $next -Destination $Target -Force }
    catch {
        Move-Item -LiteralPath $old -Destination $Target -Force
        throw
    }
    Start-Process -FilePath $Target
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue
    Note 'updated'
} catch {
    Note $_.Exception.Message
    if (Test-Path -LiteralPath ($Target + '.old')) {
        if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force }
        Move-Item -LiteralPath ($Target + '.old') -Destination $Target -Force
        Start-Process -FilePath $Target
    }
    if (-not $env:ZHIQU_DESKTOP_PROFILE) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show('更新没有完成，原来的版本已经放回去了。请稍后再试。', '知趣象限') | Out-Null
    }
    exit 1
} finally { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue }
";

        private void Set(UpdatePhase phase)
        {
            _phase = phase;
            if (_context != null) _context.Post(_ => { if (Changed != null) Changed(phase); }, null);
            else if (Changed != null) Changed(phase);
        }

        public void Dispose() { _http.Dispose(); _gate.Dispose(); }
    }
}
