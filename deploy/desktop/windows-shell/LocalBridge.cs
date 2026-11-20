using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace Zhiqu.Desktop
{
    internal sealed class LocalBridge : IDisposable
    {
        private sealed class Snapshot
        {
            internal readonly List<Dictionary<string, object>> Events = new List<Dictionary<string, object>>();
            internal Dictionary<string, object> Result;
            internal bool Running = true;
            internal readonly int TimeoutMs, MaxRounds;
            internal Snapshot(LocalAgent agent) { TimeoutMs = agent.TimeoutMs; MaxRounds = agent.MaxRounds; }
            internal Dictionary<string, object> Budget(string id) { return new Dictionary<string, object> { { "runId", id }, { "timeoutMs", TimeoutMs }, { "maxRounds", MaxRounds } }; }
        }

        private static readonly Regex RunIdShape = new Regex(@"^[A-Za-z0-9-]{1,100}$", RegexOptions.Compiled);
        private readonly LocalAgent _agent;
        private readonly LocalFolders _folders;
        private readonly Func<CoreWebView2> _web;
        private readonly Uri _server;
        private readonly IWin32Window _owner;
        private readonly SynchronizationContext _context;
        private readonly Dictionary<string, Snapshot> _snapshots = new Dictionary<string, Snapshot>();
        private readonly List<string> _order = new List<string>();
        internal Func<string> ChooseFolder;
        private readonly SemaphoreSlim _runGate = new SemaphoreSlim(1, 1);
        private bool _starting, _cancelStart;
        private string _current;
        private int _sequence;

        internal LocalBridge(Uri server, Func<CoreWebView2> web, IWin32Window owner) : this(server, web, owner, null, null) { }

        internal LocalBridge(Uri server, Func<CoreWebView2> web, IWin32Window owner, LocalAgent agent, LocalFolders folders)
        {
            _web = web; _owner = owner; _context = SynchronizationContext.Current;
            _server = server;
            _folders = folders ?? new LocalFolders();
            _agent = agent ?? new LocalAgent(new LocalAgent.Config { Server = server });
            ChooseFolder = PickFolder;
        }

        internal async Task Handle(string id, Dictionary<string, object> body)
        {
            string action = Json.Text(body, "action");
            try
            {
                object value;
                switch (action)
                {
                    case "status":
                        value = new Dictionary<string, object> { { "available", _agent.Available }, { "running", _agent.Running }, { "folders", _folders.All() }, { "network", _agent.Network } };
                        break;
                    case "pick":
                        string picked = ChooseFolder();
                        if (string.IsNullOrEmpty(picked)) value = new Dictionary<string, object> { { "cancelled", true } };
                        else value = new Dictionary<string, object> { { "folder", _folders.Add(picked) } };
                        break;
                    case "run": value = await Run(body); break;
                    case "resume":
                        Snapshot resumed = SnapshotFor(body);
                        value = resumed == null ? (object)new Dictionary<string, object> { { "found", false } }
                            : new Dictionary<string, object> { { "found", true }, { "events", resumed.Events.ToArray() }, { "result", resumed.Result }, { "running", resumed.Running } };
                        break;
                    case "ack":
                        string ackId = RunId(body);
                        bool acknowledged = ackId != null && _snapshots.ContainsKey(ackId) && _snapshots[ackId].Result != null;
                        if (acknowledged) Remove(ackId);
                        value = new Dictionary<string, object> { { "acknowledged", acknowledged } };
                        break;
                    case "stop":
                        bool running = _agent.Running;
                        if (_starting) _cancelStart = true;
                        if (running) _agent.Stop();
                        value = new Dictionary<string, object> { { "stopping", running || _starting } };
                        break;
                    case "say":
                        string sayId = RunId(body);
                        if (sayId == null) throw new InvalidOperationException("本机任务编号不对");
                        string text = (Json.Text(body, "text") ?? string.Empty).Trim();
                        if (text.Length == 0) throw new InvalidOperationException("没有要补充的话");
                        if (text.Length > 4000) throw new InvalidOperationException("补充最多 4000 字");
                        bool accepted = sayId == _current && _agent.Running && _snapshots.ContainsKey(sayId) && _snapshots[sayId].Running && await _agent.Say(text);
                        value = new Dictionary<string, object> { { "accepted", accepted } };
                        break;
                    case "read":
                        string folder = AuthorizedFolder(body);
                        string readError;
                        var read = LocalDrafts.Read(folder, Json.Text(body, "path"), out readError);
                        if (readError != null) throw new InvalidOperationException(readError);
                        value = read;
                        break;
                    case "apply":
                        string writeFolder = AuthorizedFolder(body);
                        object files = body.ContainsKey("files") ? body["files"] : null;
                        string writeError = LocalDrafts.Apply(writeFolder, files);
                        if (writeError != null) throw new InvalidOperationException(writeError);
                        int count = files is Array ? ((Array)files).Length : files is System.Collections.ICollection ? ((System.Collections.ICollection)files).Count : 0;
                        value = new Dictionary<string, object> { { "written", count } };
                        break;
                    default: throw new InvalidOperationException("认不出的请求");
                }
                Reply(id, value, null);
            }
            catch (Exception error) { Reply(id, null, error.Message); }
        }

        private string PickFolder()
        {
            using (var dialog = new FolderBrowserDialog
            {
                Description = "选一个项目文件夹：本机代码助手只在这里面读写、跑命令（读不到你的家目录）",
                ShowNewFolderButton = true,
            }) return dialog.ShowDialog(_owner) == DialogResult.OK ? dialog.SelectedPath : null;
        }

        private string RunId(Dictionary<string, object> body)
        {
            string id = Json.Text(body, "runId");
            return id != null && RunIdShape.IsMatch(id) ? id : null;
        }

        private Snapshot SnapshotFor(Dictionary<string, object> body)
        {
            string id = RunId(body);
            return id != null && _snapshots.ContainsKey(id) ? _snapshots[id] : null;
        }

        private string AuthorizedFolder(Dictionary<string, object> body)
        {
            string folder = Json.Text(body, "folder");
            if (string.IsNullOrEmpty(folder) || !_folders.Contains(folder)) throw new InvalidOperationException("这个文件夹还没在「选文件夹」里选过");
            return LocalPath.Real(folder);
        }

        private async Task<object> Run(Dictionary<string, object> body)
        {
            await _runGate.WaitAsync();
            try
            {
                string error;
                LocalRunRequest req = LocalRunRequest.Parse(body, out error);
                if (req == null) throw new InvalidOperationException(error);
                if (!_folders.Contains(req.Folder)) throw new InvalidOperationException("这个文件夹还没在「选文件夹」里选过");
                string runId;
                if (body.ContainsKey("clientRunId") && body["clientRunId"] != null)
                {
                    runId = Json.Text(body, "clientRunId");
                    if (runId == null || !RunIdShape.IsMatch(runId)) throw new InvalidOperationException("本机任务编号只能用字母、数字、连字符，最多 100 字符");
                    if (_snapshots.ContainsKey(runId)) return _snapshots[runId].Budget(runId);
                }
                else do { runId = "local-" + (++_sequence); } while (_snapshots.ContainsKey(runId));
                if (_agent.Running) throw new InvalidOperationException("上一轮还没完，先停下它");
                string evict = _order.FirstOrDefault(id => _snapshots.ContainsKey(id) && _snapshots[id].Result != null && !_snapshots[id].Running);
                if (_snapshots.Count >= 8 && evict == null) throw new InvalidOperationException("本机任务快照已满，未结束的任务不能覆盖");
                var snapshot = new Snapshot(_agent);
                _snapshots[runId] = snapshot;
                string failed;
                _starting = true; _cancelStart = false;
                try { failed = await _agent.Start(req, LocalPath.Real(req.Folder), message => Emit(runId, snapshot, message)); }
                catch { Remove(runId); throw; }
                finally { _starting = false; }
                if (failed != null)
                {
                    Remove(runId);
                    throw new InvalidOperationException(failed);
                }
                if (_cancelStart) _agent.Stop();
                if (_snapshots.Count > 8 && evict != null) Remove(evict);
                _order.Add(runId);
                if (snapshot.Running) _current = runId;
                return snapshot.Budget(runId);
            }
            finally { _runGate.Release(); }
        }

        private void Remove(string id)
        {
            _snapshots.Remove(id); _order.Remove(id);
            if (_current == id) _current = null;
        }

        private void Emit(string runId, Snapshot snapshot, Dictionary<string, object> message)
        {
            Action deliver = delegate
            {
                if (!_snapshots.ContainsKey(runId) || !ReferenceEquals(_snapshots[runId], snapshot)) return;
                var detail = new Dictionary<string, object>(message) { { "runId", runId } };
                string type = Json.Text(message, "type");
                if (type == "trace")
                {
                    var step = Json.Object(message.ContainsKey("step") ? message["step"] : null);
                    string stepId = Json.Text(step, "id");
                    if (stepId != null)
                    {
                        int index = snapshot.Events.FindIndex(e => Json.Text(Json.Object(e.ContainsKey("step") ? e["step"] : null), "id") == stepId);
                        if (index >= 0) snapshot.Events[index] = detail;
                        else { snapshot.Events.Add(detail); Trim(snapshot.Events); }
                    }
                }
                else if (type == "steered") { snapshot.Events.Add(detail); Trim(snapshot.Events); }
                else if (type == "result" || type == "fatal") snapshot.Result = detail;
                else if (type == "exit")
                {
                    snapshot.Running = false;
                    if (_current == runId) _current = null;
                }
                CoreWebView2 web;
                try { web = _web(); } catch { return; }
                if (web == null) return;
                try
                {
                    if (!ServerConfig.IsOrigin(_server, web.Source)) return;
                    string script = "window.dispatchEvent(new CustomEvent('zq-local', { detail: " + Json.Stringify(detail) + " }));0";
                    Task<string> sending = web.ExecuteScriptAsync(script);
                    GC.KeepAlive(sending);
                }
                catch { }
            };
            if (_context != null) _context.Post(_ => deliver(), null);
            else if (SynchronizationContext.Current == null) deliver();
            else SynchronizationContext.Current.Send(_ => deliver(), null);
        }

        private static void Trim(List<Dictionary<string, object>> events) { if (events.Count > 400) events.RemoveAt(0); }

        private void Reply(string id, object value, string error)
        {
            try
            {
                CoreWebView2 web = _web();
                if (web == null) return;
                var reply = new Dictionary<string, object> { { "bridge", "zqLocal.reply" }, { "id", id }, { "ok", error == null }, { "value", value }, { "error", error } };
                web.PostWebMessageAsJson(Json.Stringify(reply));
            }
            catch { }
        }

        public void Dispose() { _agent.Dispose(); }
    }
}
