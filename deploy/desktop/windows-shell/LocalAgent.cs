using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Zhiqu.Desktop
{
    internal sealed class LocalRunRequest
    {
        internal string Folder, Message, Level, Command, Token, Effort, SessionId;
        internal int? ModelId;
        internal object[] History;
        private static readonly Regex TokenShape = new Regex(@"^zqp_[A-Za-z0-9_-]{16,200}$", RegexOptions.Compiled);
        private static readonly Regex SessionShape = new Regex(@"^[A-Za-z0-9_-]{1,64}$", RegexOptions.Compiled);

        internal static LocalRunRequest Parse(Dictionary<string, object> body, out string error)
        {
            error = null;
            string folder = Json.Text(body, "folder"), level = Json.Text(body, "level"), token = Json.Text(body, "token");
            if (string.IsNullOrEmpty(folder)) { error = "没说用哪个项目文件夹"; return null; }
            if (level != "READ" && level != "WRITE" && level != "EXEC") { error = "档位是关的（close）或者认不出：本机代码要 plan / manual / auto"; return null; }
            if (token == null || !TokenShape.IsMatch(token)) { error = "没拿到本机代码的登录令牌"; return null; }
            string command = Json.Text(body, "command");
            if (command != "init" && command != "review") command = null;
            string message = Json.Text(body, "message") ?? string.Empty;
            if (message.Length == 0 && command == null) { error = "没有要做的事"; return null; }
            if (message.Length > 200000) { error = "这句话太长了"; return null; }
            var history = new List<object>();
            IEnumerable items = body.ContainsKey("history") ? body["history"] as IEnumerable : null;
            if (items != null && !(items is string))
            {
                var incoming = items.Cast<object>().ToList();
                foreach (object item in incoming.Skip(Math.Max(0, incoming.Count - 200)))
                {
                    var h = Json.Object(item);
                    if (h == null) continue;
                    string role = Json.Text(h, "role"), content = Json.Text(h, "content");
                    if ((role != "user" && role != "assistant") || content == null) continue;
                    var clean = new Dictionary<string, object> { { "role", role }, { "content", Json.Limit(content, 200000) } };
                    int? id = Json.Integer(h, "id");
                    if (id > 0) clean["id"] = id.Value.ToString();
                    history.Add(clean);
                }
            }
            string session = Json.Text(body, "sessionId");
            string effort = Json.Text(body, "effort");
            return new LocalRunRequest
            {
                Folder = folder, Message = message, Level = level, Command = command, Token = token, History = history.ToArray(),
                ModelId = Json.Integer(body, "model"), SessionId = session != null && SessionShape.IsMatch(session) ? session : null,
                Effort = effort == "medium" || effort == "high" || effort == "extra" || effort == "max" ? effort : "instant",
            };
        }
    }

    internal sealed class LocalAgent : IDisposable
    {
        internal sealed class Config
        {
            internal string Runtime, Home = LocalAgent.DefaultHome();
            internal Uri Server;
            internal string Network = NetworkSetting();
            internal int TimeoutMs = 0;
            internal int MaxRounds = RoundsSetting();
            internal int SayTimeoutMs = 5000;
            internal string Node { get { return LocalRuntime.NodePath(Runtime ?? string.Empty); } }
            internal string Host { get { return LocalRuntime.HostPath(Runtime ?? string.Empty); } }
        }

        private readonly object _gate = new object();
        private readonly Config _config;
        private readonly Dictionary<int, TaskCompletionSource<bool>> _sayWaiters = new Dictionary<int, TaskCompletionSource<bool>>();
        private System.Diagnostics.Process _process;
        private Stream _input;
        private WindowsJob _job;
        private Action<Dictionary<string, object>> _onMessage;
        private string _work, _token;
        private byte[] _buffer = new byte[65536];
        private int _bufferCount;
        private readonly byte[] _stderr = new byte[4096];
        private int _stderrCount;
        private bool _running, _gotResult, _stdoutDone, _exited, _stopping;
        private int _saySeq;

        private static string DefaultHome()
        {
            string profile = Environment.GetEnvironmentVariable("ZHIQU_DESKTOP_PROFILE");
            return !string.IsNullOrEmpty(profile) && Path.IsPathRooted(profile) ? Path.Combine(profile, "home") : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        }

        internal LocalAgent(Config config) { _config = config; }
        internal bool Available { get { return _config.Runtime == null ? LocalRuntime.Bundled : File.Exists(_config.Node) && File.Exists(_config.Host); } }
        internal bool Running { get { lock (_gate) return _running; } }
        internal int TimeoutMs { get { return _config.TimeoutMs; } }
        internal int MaxRounds { get { return _config.MaxRounds; } }
        internal string Network { get { return _config.Network; } }

        internal static int RoundsSetting()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\zhiqu\desktop"))
                {
                    int value = key == null ? 0 : Convert.ToInt32(key.GetValue("maxRounds", 0));
                    return value > 0 && value <= 100000 ? value : 0;
                }
            }
            catch { return 0; }
        }

        internal static string NetworkSetting()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\zhiqu\desktop"))
                {
                    string value = key == null ? "on" : key.GetValue("sandboxNetwork", "on") as string;
                    return value == "off" || value == "local" || value == "on" ? value : "off";
                }
            }
            catch { return "on"; }
        }

        internal Dictionary<string, object> Payload(LocalRunRequest req, string root)
        {
            bool write = req.Level != "READ" && req.Command != "review";
            return new Dictionary<string, object>
            {
                { "type", "run" }, { "root", root }, { "home", _config.Home }, { "message", req.Message }, { "history", req.History },
                { "command", req.Command }, { "sessionId", req.SessionId }, { "canWrite", write }, { "canExec", false }, { "canShell", true },
                { "shellWrite", write && req.Level == "EXEC" }, { "shellMode", write && req.Level == "EXEC" && _config.Network == "on" ? "direct" : null },
                { "sandboxNetwork", _config.Network }, { "maxRounds", _config.MaxRounds },
                { "timeoutMs", _config.TimeoutMs }, { "model", new Dictionary<string, object> { { "id", req.ModelId } } }, { "effort", req.Effort },
                { "local", new Dictionary<string, object> { { "server", _config.Server.AbsoluteUri }, { "token", req.Token } } },
            };
        }

        internal static Dictionary<string, string> EnvironmentFor(string node, string home, string tmp)
        {
            var paths = new List<string>();
            string given = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            foreach (string path in given.Split(Path.PathSeparator))
                if (path.Length > 0 && Path.IsPathRooted(path) && Directory.Exists(path) && !paths.Contains(path)) paths.Add(path);
            string system = Environment.GetFolderPath(Environment.SpecialFolder.System);
            if (!paths.Contains(system)) paths.Add(system);
            paths.Add(Path.GetDirectoryName(node));
            var result = new Dictionary<string, string>
            {
                { "PATH", string.Join(Path.PathSeparator.ToString(), paths) }, { "HOME", home }, { "USERPROFILE", home },
                { "TMP", tmp }, { "TEMP", tmp }, { "TMPDIR", tmp }, { "SystemRoot", Environment.GetEnvironmentVariable("SystemRoot") },
                { "WINDIR", Environment.GetEnvironmentVariable("WINDIR") }, { "ComSpec", Path.Combine(system, "cmd.exe") },
                { "PATHEXT", ".COM;.EXE;.BAT;.CMD" }, { "LOCALAPPDATA", Path.Combine(home, "AppData", "Local") },
                { "APPDATA", Path.Combine(home, "AppData", "Roaming") },
            };
            foreach (string name in new[] { "JAVA_HOME", "GOROOT", "GOPATH", "GOMODCACHE", "CARGO_HOME", "RUSTUP_HOME", "VIRTUAL_ENV", "CONDA_PREFIX" })
            {
                string value = Environment.GetEnvironmentVariable(name);
                if (!string.IsNullOrEmpty(value) && Path.IsPathRooted(value)) result[name] = value;
            }
            return result;
        }

        internal async Task<string> Start(LocalRunRequest req, string root, Action<Dictionary<string, object>> onMessage)
        {
            if (Running) return "上一轮还没完，先停下它";
            if (_config.Runtime == null) _config.Runtime = await LocalRuntime.PrepareAsync().ConfigureAwait(false);
            if (!Available) return "安装包里缺本机代码助手（node 或命令行源码），请重新安装";
            string work = Path.Combine(Path.GetTempPath(), "zhiqu-local-" + Guid.NewGuid().ToString("N"));
            string home = Path.Combine(work, "home"), tmp = Path.Combine(work, "tmp");
            Directory.CreateDirectory(home); Directory.CreateDirectory(tmp);
            var start = new System.Diagnostics.ProcessStartInfo
            {
                FileName = _config.Node, Arguments = Quote(_config.Host), WorkingDirectory = work,
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            };
            start.EnvironmentVariables.Clear();
            foreach (var pair in EnvironmentFor(_config.Node, home, tmp)) start.EnvironmentVariables[pair.Key] = pair.Value;
            var process = new System.Diagnostics.Process { StartInfo = start, EnableRaisingEvents = true };
            WindowsJob job = null;
            try
            {
                lock (_gate)
                {
                    if (_running) return "上一轮还没完，先停下它";
                    _process = process; _onMessage = onMessage; _work = work; _token = req.Token;
                    _bufferCount = 0; _stderrCount = 0; _gotResult = false; _stdoutDone = false; _exited = false; _stopping = false;
                }
                process.Exited += delegate { Exited(); };
                if (!process.Start()) throw new InvalidOperationException("进程没有启动");
                job = WindowsJob.Create(process);
                lock (_gate) { _job = job; _input = process.StandardInput.BaseStream; _running = true; }
                Task reading = ReadStdout(process);
                Task errors = ReadStderr(process);
                GC.KeepAlive(reading); GC.KeepAlive(errors);
                Send(Payload(req, root));
                return null;
            }
            catch (Exception error)
            {
                lock (_gate) { _running = false; _onMessage = null; _token = string.Empty; }
                try { if (job != null) job.Dispose(); } catch { }
                try { if (!process.HasExited) process.Kill(); } catch { }
                process.Dispose();
                try { Directory.Delete(work, true); } catch { }
                return "本机代码助手起不来：" + error.Message;
            }
        }

        private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }

        private void Send(Dictionary<string, object> message)
        {
            try
            {
                Stream input;
                lock (_gate) input = _input;
                if (input == null) return;
                byte[] bytes = Encoding.UTF8.GetBytes(Json.Stringify(message) + "\n");
                input.Write(bytes, 0, bytes.Length); input.Flush();
            }
            catch { }
        }

        private async Task ReadStdout(System.Diagnostics.Process process)
        {
            try
            {
                byte[] chunk = new byte[16384];
                while (true)
                {
                    int count = await process.StandardOutput.BaseStream.ReadAsync(chunk, 0, chunk.Length).ConfigureAwait(false);
                    if (count == 0) break;
                    Take(chunk, count);
                }
            }
            catch { }
            lock (_gate) _stdoutDone = true;
            FinishIfDone();
        }

        private async Task ReadStderr(System.Diagnostics.Process process)
        {
            try
            {
                byte[] chunk = new byte[4096];
                while (true)
                {
                    int count = await process.StandardError.BaseStream.ReadAsync(chunk, 0, chunk.Length).ConfigureAwait(false);
                    if (count == 0) break;
                    lock (_gate)
                    {
                        int keep = Math.Min(count, _stderr.Length);
                        if (keep < count) Buffer.BlockCopy(chunk, count - keep, _stderr, 0, keep);
                        else
                        {
                            int move = Math.Min(_stderrCount, _stderr.Length - keep);
                            Buffer.BlockCopy(_stderr, _stderrCount - move, _stderr, 0, move);
                            Buffer.BlockCopy(chunk, 0, _stderr, move, keep);
                            _stderrCount = move + keep;
                        }
                    }
                }
            }
            catch { }
        }

        private void Take(byte[] bytes, int count)
        {
            int start = 0;
            for (int i = 0; i < count; i++)
            {
                if (bytes[i] != 10) continue;
                Append(bytes, start, i - start);
                byte[] line;
                lock (_gate) { line = new byte[_bufferCount]; Buffer.BlockCopy(_buffer, 0, line, 0, _bufferCount); _bufferCount = 0; }
                Handle(line);
                start = i + 1;
            }
            Append(bytes, start, count - start);
        }

        private void Append(byte[] bytes, int start, int count)
        {
            if (count <= 0) return;
            lock (_gate)
            {
                if ((long)_bufferCount + count > 64 * 1024 * 1024)
                {
                    _bufferCount = 0;
                    Fail("本机代码助手的输出一行超过 64 MB，停下了");
                    return;
                }
                if (_buffer.Length < _bufferCount + count) Array.Resize(ref _buffer, Math.Min(64 * 1024 * 1024, Math.Max(_bufferCount + count, _buffer.Length * 2)));
                Buffer.BlockCopy(bytes, start, _buffer, _bufferCount, count); _bufferCount += count;
            }
        }

        private void Handle(byte[] bytes)
        {
            if (bytes.Length == 0 || bytes.Length > 64 * 1024 * 1024) return;
            Dictionary<string, object> message;
            try { message = Json.Object(Encoding.UTF8.GetString(bytes)); } catch { return; }
            string type = Json.Text(message, "type");
            if (type == "step" || type == "trace" || type == "steered") Deliver(message);
            else if (type == "result" || type == "fatal") { lock (_gate) _gotResult = true; Deliver(message); }
            else if (type == "say_ack")
            {
                int? id = Json.Integer(message, "id"); TaskCompletionSource<bool> waiter = null;
                if (id.HasValue) lock (_gate) if (_sayWaiters.TryGetValue(id.Value, out waiter)) _sayWaiters.Remove(id.Value);
                if (waiter != null) waiter.TrySetResult(message.ContainsKey("accepted") && message["accepted"] is bool && (bool)message["accepted"]);
            }
            else if (type != null) Fail("本机代码助手要了外壳不做的事（" + Json.Limit(type, 20) + "），停下了");
        }

        private void Fail(string why)
        {
            bool duplicate;
            lock (_gate) { duplicate = _gotResult; _gotResult = true; }
            if (!duplicate) Deliver(new Dictionary<string, object> { { "type", "fatal" }, { "message", why } });
            Stop();
        }

        private void Deliver(Dictionary<string, object> message)
        {
            Action<Dictionary<string, object>> receiver; string token;
            lock (_gate) { receiver = _onMessage; token = _token; }
            if (receiver == null) return;
            string text = Json.Stringify(message);
            if (!string.IsNullOrEmpty(token)) text = text.Replace(token, "zqp_…");
            try
            {
                var clean = Json.Object(text);
                if (clean == null) throw new InvalidOperationException("empty host message");
                receiver(clean);
            }
            catch
            {
                try { receiver(new Dictionary<string, object> { { "type", "fatal" }, { "message", "本机代码助手的回包认不出来" } }); } catch { }
            }
        }

        internal Task<bool> Say(string text)
        {
            TaskCompletionSource<bool> waiter;
            lock (_gate)
            {
                if (!_running || _stopping || _input == null) return Task.FromResult(false);
                int id = ++_saySeq;
                waiter = new TaskCompletionSource<bool>(); _sayWaiters[id] = waiter;
                Send(new Dictionary<string, object> { { "type", "say" }, { "id", id }, { "text", text } });
                TimeoutSay(id, waiter);
                return waiter.Task;
            }
        }

        private async void TimeoutSay(int id, TaskCompletionSource<bool> waiter)
        {
            await Task.Delay(_config.SayTimeoutMs).ConfigureAwait(false);
            lock (_gate) _sayWaiters.Remove(id);
            waiter.TrySetResult(false);
        }

        internal void Stop()
        {
            lock (_gate)
            {
                if (!_running || _stopping) return;
                _stopping = true;
            }
            Send(new Dictionary<string, object> { { "type", "stop" } });
            KillAfter();
        }

        private async void KillAfter()
        {
            await Task.Delay(5000).ConfigureAwait(false);
            Terminate();
        }

        internal void Terminate()
        {
            WindowsJob job; System.Diagnostics.Process process;
            lock (_gate) { job = _job; process = _process; }
            try { if (job != null) job.Dispose(); } catch { }
            try { if (process != null && !process.HasExited) process.Kill(); } catch { }
        }

        private void Exited()
        {
            lock (_gate) _exited = true;
            FinishIfDone();
        }

        private void FinishIfDone()
        {
            Action<Dictionary<string, object>> receiver = null;
            int code = 0; string work = null; string tail = string.Empty; bool missingResult = false;
            var waiters = new List<TaskCompletionSource<bool>>();
            lock (_gate)
            {
                if (!_exited || !_stdoutDone || _process == null) return;
                code = _process.ExitCode;
                receiver = _onMessage;
                if (!_gotResult)
                {
                    missingResult = true;
                    tail = Encoding.UTF8.GetString(_stderr, 0, _stderrCount).Trim().Replace(_token, "zqp_…");
                }
                _bufferCount = 0;
                _running = false; _gotResult = true;
                waiters.AddRange(_sayWaiters.Values); _sayWaiters.Clear();
                _onMessage = null; _token = string.Empty; work = _work; _work = null;
                try { if (_input != null) _input.Dispose(); } catch { } _input = null;
                try { if (_job != null) _job.Dispose(); } catch { } _job = null;
                _process.Dispose(); _process = null;
            }
            foreach (var waiter in waiters) waiter.TrySetResult(false);
            if (missingResult)
            {
                string text = "本机代码助手意外退出了（退出码 " + code + "）" + (tail.Length == 0 ? string.Empty : "：" + Json.Limit(tail, 600));
                DeliverTo(receiver, new Dictionary<string, object> { { "type", "fatal" }, { "message", text } });
            }
            if (receiver != null) DeliverTo(receiver, new Dictionary<string, object> { { "type", "exit" }, { "code", code } });
            try { if (work != null) Directory.Delete(work, true); } catch { }
        }

        private void DeliverTo(Action<Dictionary<string, object>> receiver, Dictionary<string, object> message)
        {
            if (receiver == null || message == null) return;
            try { receiver(message); } catch { }
        }

        public void Dispose()
        {
            Terminate();
            lock (_gate) { _running = false; }
        }
    }
}
