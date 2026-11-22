using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Zhiqu.Desktop
{
    internal static partial class WindowsChecks
    {
        private const string Token = "zqp_windowsShellCheck_0123456789abcdef";
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Length == 0)
            {
                File.WriteAllText(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "restarted.marker"), "yes");
                return;
            }
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), Utf8) { AutoFlush = true });
            try
            {
                Directory.CreateDirectory(args[1]);
                switch (args[0])
                {
                    case "logic": Logic(args[1]); break;
                    case "agent": Agent(args[2], args[1]).GetAwaiter().GetResult(); break;
                    case "update": Update(args[2], args[1]).GetAwaiter().GetResult(); break;
                    case "web": Web(args[2], args[1]); break;
                    default: throw new InvalidOperationException("unknown check " + args[0]);
                }
                Log("done", "true");
            }
            catch (Exception error)
            {
                Log("FAIL", error.ToString());
                Environment.ExitCode = 1;
            }
        }

        private static void Log(string key, object value) { Console.WriteLine(key + "=" + Convert.ToString(value)); }
        private static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
        private static string Text(Dictionary<string, object> body, string key) { return Json.Text(body, key); }

        private static void Logic(string work)
        {
            Check(UpdateCheck.IsNewer("1.0.10", "1.0.9"), "numeric version compare");
            Check(UpdateCheck.IsNewer("1.1", "1.0.9"), "short version compare");
            Check(!UpdateCheck.IsNewer("1.0.0", "1.0.0") && !UpdateCheck.IsNewer("1.0.0", "1.0.1"), "downgrade guard");
            string sha = new string('a', 64);
            string manifest = "{\"code\":200,\"data\":{\"windows\":{\"version\":\"1.1.0\",\"size\":3,\"sha256\":\"" + sha + "\",\"url\":\"/api/desktop/downloads/windows\"}}}";
            var release = UpdateCheck.Parse(manifest, new Uri("https://zhiqustudy.com"));
            Check(release != null && release.Version == "1.1.0" && release.Size == 3 && release.Url.Host == "zhiqustudy.com", "manifest parse");
            Check(UpdateCheck.Parse(manifest.Replace("/api/desktop/downloads/windows", "https://example.com/a.exe"), new Uri("https://zhiqustudy.com")) == null, "cross-origin download accepted");
            Check(UpdateCheck.Parse(manifest.Replace(sha, string.Empty), new Uri("https://zhiqustudy.com")) == null, "empty sha accepted");
            Check(Updater.HelperScript.Contains("$OwnerPid") && !Updater.HelperScript.Contains("$Pid") && Updater.HelperScript.Contains("$Target + '.old'"), "update helper safety");
            Check(BridgeScript.For(true).Contains("zqLocal") && !BridgeScript.For(false).Contains("zqLocal") && BridgeScript.For(true).Contains("window.top !== window"), "bridge injection boundary");

            string root = Directory.CreateDirectory(Path.Combine(work, "project")).FullName;
            string home = Directory.CreateDirectory(Path.Combine(work, "home")).FullName;
            string registry = @"Software\zhiqu\desktop-check-" + Guid.NewGuid().ToString("N");
            var folders = new LocalFolders(home, registry);
            try
            {
                Check(folders.Add(root) == LocalPath.Real(root) && folders.Contains(root), "selected folder persistence");
                bool rejected = false;
                try { folders.Add(home); } catch (InvalidOperationException) { rejected = true; }
                Check(rejected, "home accepted as project");
                string file = Path.Combine(root, "a.txt");
                File.WriteAllText(file, "hello-project\n", Utf8);
                string original = LocalDrafts.Sha256(File.ReadAllBytes(file));
                string stale = LocalDrafts.Apply(root, Files("a.txt", "next\n", new string('0', 64)));
                Check(stale != null && File.ReadAllText(file, Utf8) == "hello-project\n", "stale baseline wrote");
                Check(LocalDrafts.Apply(root, Files("a.txt", "next\n", original)) == null && File.ReadAllText(file, Utf8) == "next\n", "confirmed draft not written");
                Check(LocalDrafts.Apply(root, Files("a.txt", "next\n", original)) == null, "idempotent confirm");
                string duplicate = LocalDrafts.Apply(root, new object[] { Draft("a.txt", "one", LocalDrafts.Sha256(Utf8.GetBytes("next\n"))), Draft("A.TXT", "two", LocalDrafts.Sha256(Utf8.GetBytes("next\n"))) });
                Check(duplicate != null && duplicate.Contains("两次"), "case-insensitive duplicate accepted");
                foreach (string path in new[] { "../outside", "/absolute", "a.txt:stream", "NUL", "dir/.", "dir/bad " }) Check(LocalDrafts.Resolve(root, path) == null, "unsafe path accepted " + path);
                string readError;
                Check(Text(LocalDrafts.Read(root, "a.txt", out readError), "content") == "next\n", "confirmed read");
                File.WriteAllBytes(Path.Combine(root, "large.txt"), new byte[1000001]);
                Check(LocalDrafts.Read(root, "large.txt", out readError) == null && readError.Contains("太大"), "large read accepted");
                string outside = Directory.CreateDirectory(Path.Combine(work, "outside")).FullName;
                string link = Path.Combine(root, "linked");
                var mklink = Process.Start(new ProcessStartInfo { FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                    Arguments = "/d /s /c mklink /J \"" + link + "\" \"" + outside + "\"", UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true });
                mklink.WaitForExit();
                Check(mklink.ExitCode == 0, "cannot create test junction");
                Check(LocalDrafts.Resolve(root, "linked/escape.txt") == null, "junction escaped project");
                Directory.Delete(link);
                Check(!File.Exists(Path.Combine(outside, "escape.txt")), "junction wrote outside");
            }
            finally { try { Registry.CurrentUser.DeleteSubKeyTree(registry); } catch { } }
            var env = LocalAgent.EnvironmentFor(Path.Combine(root, "node.exe"), home, Path.Combine(home, "tmp"));
            Check(!env.ContainsKey("ZHIQU_TOKEN") && env.ContainsKey("PATH") && env.ContainsKey("SystemRoot") && env["HOME"] == home, "host environment");
            Log("logic.ok", "true");
        }

        private static object[] Files(string path, string content, string baseline) { return new[] { Draft(path, content, baseline) }; }
        private static Dictionary<string, object> Draft(string path, string content, string baseline)
        {
            return new Dictionary<string, object> { { "path", path }, { "content", content }, { "baseline", baseline } };
        }

        private static void ExtractRuntime(string package, string destination)
        {
            var assembly = Assembly.LoadFrom(package);
            using (Stream stream = assembly.GetManifestResourceStream(LocalRuntime.ResourceName))
            {
                Check(stream != null, "packaged runtime resource missing");
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    foreach (var entry in zip.Entries)
                    {
                        string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        Check(!Path.IsPathRooted(relative) && !relative.Split(Path.DirectorySeparatorChar).Contains(".."), "runtime zip traversal");
                        string target = Path.Combine(destination, relative);
                        if (entry.Name == string.Empty) Directory.CreateDirectory(target);
                        else { Directory.CreateDirectory(Path.GetDirectoryName(target)); entry.ExtractToFile(target, true); }
                    }
                }
            }
            Check(File.Exists(LocalRuntime.NodePath(destination)) && File.Exists(LocalRuntime.HostPath(destination)), "runtime incomplete");
        }

        private static async Task Agent(string package, string work)
        {
            string runtime = Path.Combine(work, "runtime");
            ExtractRuntime(package, runtime);
            string root = Directory.CreateDirectory(Path.Combine(work, "agent-project")).FullName;
            string home = Directory.CreateDirectory(Path.Combine(work, "agent-home")).FullName;
            var server = new FakeGateway();
            server.Start();
            var agent = new LocalAgent(new LocalAgent.Config { Runtime = runtime, Server = server.Uri, Home = home, Network = "on" });
            try
            {
                Check(agent.Available && agent.TimeoutMs == 0 && agent.MaxRounds == 0, "packaged agent unavailable");
                var body = RunBody(root, "WINDOWS-DIRECT");
                string parseError;
                var request = LocalRunRequest.Parse(body, out parseError);
                Check(request != null, parseError);
                var payload = agent.Payload(request, root);
                Check((string)payload["shellMode"] == "direct" && (string)((Dictionary<string, object>)payload["local"])["server"] == server.Uri.AbsoluteUri, "shell/server payload");
                var first = await Turn(agent, request, root, 30000);
                Check(Text(first.Result, "conclusion") == "WINDOWS-DONE", "agent conclusion " + Json.Stringify(first.Result));
                Check(File.ReadAllText(Path.Combine(root, "command.txt"), Utf8) == "ok", "direct command did not run");
                Check(!File.Exists(Path.Combine(root, "new.txt")), "write tool bypassed draft");
                Check(first.Result["drafts"] is object[], "drafts missing");
                Check(LocalDrafts.Apply(root, first.Result["drafts"]) == null && File.ReadAllText(Path.Combine(root, "new.txt"), Utf8) == "draft-content\n", "draft confirm");
                Check(!first.Events.Any(e => Json.Stringify(e).Contains(Token)), "token leaked to page");
                Check(server.Seen.All(s => s.Auth == "Bearer " + Token && !s.Body.Contains(Token)), "token transport");
                Check(server.Streams.Count >= 3 && server.Streams[0].Contains("Windows 本机直接运行"), "direct boundary absent from model prompt");

                var decisionBody = RunBody(root, "DECIDE-WINDOWS");
                decisionBody["userDecision"] = true;
                var decisionRequest = LocalRunRequest.Parse(decisionBody, out parseError);
                Check(decisionRequest.UserDecision && (bool)agent.Payload(decisionRequest, root)["userDecision"], "decision capability not forwarded");
                Check(!LocalRunRequest.Parse(RunBody(root, "PLAIN"), out parseError).UserDecision, "decision enabled without page opt-in");
                decisionBody["userDecision"] = "true";
                Check(!LocalRunRequest.Parse(decisionBody, out parseError).UserDecision, "string opt-in accepted");
                var decision = await DecisionTurn(agent, decisionRequest, root, false);
                Check(Text(decision.Result, "conclusion") == "WINDOWS-DECISION", "decision result " + Json.Stringify(decision.Result));
                Check(decision.Answers.Count == 4 && !((bool)decision.Answers[0]["accepted"]), "incomplete answers accepted");
                Check((bool)decision.Answers[1]["accepted"] && !((bool)decision.Answers[1]["duplicate"]), "first answer rejected");
                Check((bool)decision.Answers[2]["accepted"] && (bool)decision.Answers[2]["duplicate"], "normalized duplicate woke host");
                Check(!((bool)decision.Answers[3]["accepted"]), "conflicting answer replaced first answer");
                Check(server.Streams.Count(s => s.Contains("DECIDE-WINDOWS")) == 2, "duplicate answer caused another model turn");
                Check(server.Streams.Any(s => s.Contains("DECIDE-WINDOWS") && s.Contains("保留现有") && s.Contains("其他输入：真 WebView2 验证")), "actual choices missing from model request");
                var late = agent.Answer("d1", DecisionAnswers("真 WebView2 验证"));
                Check(!((bool)late["accepted"]), "late answer accepted after result");
                var waitBody = RunBody(root, "DECIDE-WAIT"); waitBody["userDecision"] = true;
                var stoppedDecision = await DecisionTurn(agent, LocalRunRequest.Parse(waitBody, out parseError), root, true);
                Check(stoppedDecision.Result != null && stoppedDecision.Result.ContainsKey("stopped"), "pending decision did not stop cleanly");
                Check(!((bool)agent.Answer("d1", DecisionAnswers("真 WebView2 验证"))["accepted"]), "answer accepted after stop");

                var stopping = await Turn(agent, LocalRunRequest.Parse(RunBody(root, "STOP"), out parseError), root, 1200, true);
                Check(Text(stopping.Result, "conclusion").Contains("停") && stopping.Result.ContainsKey("stopped"), "stop result " + Json.Stringify(stopping.Result));
                Check(!agent.Running, "agent still running after stop");
                await Task.Delay(6000);
                Check(!File.Exists(Path.Combine(root, "late.txt")), "stopped child process survived");
                File.WriteAllText(LocalRuntime.HostPath(runtime), "process.stdin.on('data',c=>{const r=JSON.parse(c.toString().trim());console.error('boom '+r.local.token);process.exit(3);});", Utf8);
                var broken = await Turn(agent, LocalRunRequest.Parse(RunBody(root, "BROKEN"), out parseError), root, 30000, false, true);
                string brokenTypes = string.Join(",", broken.Events.Select(e => Text(e, "type")));
                Check(brokenTypes == "fatal,exit" && brokenTypes.Contains("fatal"), "broken host did not finish cleanly: " + brokenTypes);
                string fatalText = Json.Stringify(broken.Events);
                Check(fatalText.Contains("boom") && fatalText.Contains("退出码 3") && !fatalText.Contains(Token), "fatal exit/stderr redaction");
                Log("agent.brokenHost", "fatal,exit,redacted");
                Log("agent.streams", server.Streams.Count);
                Log("agent.ok", "true");
            }
            finally { agent.Dispose(); server.Stop(); }
        }

        private static Dictionary<string, object> RunBody(string root, string message)
        {
            return new Dictionary<string, object> { { "folder", root }, { "message", message }, { "history", new object[0] }, { "model", 1 },
                { "level", "EXEC" }, { "effort", "instant" }, { "token", Token }, { "sessionId", message == "STOP" ? "stop-check" : "app-check" } };
        }

        private sealed class TurnResult
        {
            internal Dictionary<string, object> Result;
            internal readonly List<Dictionary<string, object>> Events = new List<Dictionary<string, object>>();
            internal readonly List<Dictionary<string, object>> Answers = new List<Dictionary<string, object>>();
        }
        private static async Task<TurnResult> Turn(LocalAgent agent, LocalRunRequest request, string root, int waitMs, bool stop = false, bool allowFatal = false)
        {
            var result = new TurnResult();
            var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            string failed = await agent.Start(request, root, message =>
            {
                lock (result.Events) result.Events.Add(message);
                if (Text(message, "type") == "result") result.Result = message;
                if (Text(message, "type") == "exit") done.TrySetResult(true);
            });
            Check(failed == null, failed);
            if (stop) { await Task.Delay(waitMs); agent.Stop(); }
            Check(await Task.WhenAny(done.Task, Task.Delay(30000)) == done.Task, "agent turn timeout");
            Check(result.Result != null || allowFatal, "agent result missing");
            return result;
        }

        private static object[] DecisionAnswers(string other)
        {
            return new object[] {
                new Dictionary<string, object> { { "questionId", "q1" }, { "optionId", "o1" } },
                new Dictionary<string, object> { { "questionId", "q2" }, { "optionId", "__other__" }, { "otherText", other } },
            };
        }

        private static async Task<TurnResult> DecisionTurn(LocalAgent agent, LocalRunRequest request, string root, bool stop)
        {
            var result = new TurnResult();
            var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            bool acted = false;
            string failed = await agent.Start(request, root, message =>
            {
                lock (result.Events) result.Events.Add(message);
                if (Text(message, "type") == "question" && !acted)
                {
                    acted = true;
                    if (stop) { agent.Stop(); return; }
                    result.Answers.Add(agent.Answer("d1", new object[] { DecisionAnswers("真 WebView2 验证")[0] }));
                    result.Answers.Add(agent.Answer("d1", DecisionAnswers("真 WebView2 验证")));
                    result.Answers.Add(agent.Answer("d1", DecisionAnswers("  真 WebView2 验证\n")));
                    result.Answers.Add(agent.Answer("d1", new object[] {
                        new Dictionary<string, object> { { "questionId", "q1" }, { "optionId", "o2" } }, DecisionAnswers("真 WebView2 验证")[1] }));
                }
                if (Text(message, "type") == "result") result.Result = message;
                if (Text(message, "type") == "exit") done.TrySetResult(true);
            });
            Check(failed == null, failed);
            Check(await Task.WhenAny(done.Task, Task.Delay(30000)) == done.Task, "decision turn timeout");
            Check(result.Result != null, "decision result missing");
            return result;
        }

        private static async Task Update(string package, string work)
        {
            string oldProfile = Environment.GetEnvironmentVariable("ZHIQU_DESKTOP_PROFILE");
            Environment.SetEnvironmentVariable("ZHIQU_DESKTOP_PROFILE", Path.Combine(work, "update-profile"));
            var server = new UpdateServer(Application.ExecutablePath);
            server.Start();
            string install = Directory.CreateDirectory(Path.Combine(work, "install")).FullName;
            string target = Path.Combine(install, "app.exe");
            File.Copy(package, target);
            string before = UpdateCheck.Sha256(target);
            try
            {
                var updater = new Updater(server.Uri, "1.0.0");
                await updater.Check();
                Check(updater.Phase.State == UpdateState.Available, "update not offered");
                await updater.Download();
                Check(updater.Phase.State == UpdateState.Failed && updater.Phase.Error.Contains("sha256"), "bad sha accepted");
                Check(UpdateCheck.Sha256(target) == before, "bad sha changed target");
                server.Good = true;
                var good = new Updater(server.Uri, "1.0.0");
                await good.Check();
                await good.Download();
                Check(good.Phase.State == UpdateState.Ready, "good package not ready " + good.Phase.Error);
                good.ApplicationExecutable = () => target;
                bool exited = false;
                good.ApplicationExit = () => { exited = true; };
                good.Restart();
                Check(exited && good.Phase.State == UpdateState.Installing, "restart not requested");
                Log("update.expected", UpdateCheck.Sha256(Application.ExecutablePath));
                Log("update.target", target);
                Log("update.ok", "true");
            }
            finally { server.Stop(); Environment.SetEnvironmentVariable("ZHIQU_DESKTOP_PROFILE", oldProfile); }
        }

        private sealed class SeenRequest { internal string Auth, Body; }
        private sealed class FakeGateway
        {
            private HttpListener _listener;
            private int _port;
            internal Uri Uri { get { return new Uri("http://127.0.0.1:" + _port); } }
            internal readonly List<SeenRequest> Seen = new List<SeenRequest>();
            internal readonly List<string> Streams = new List<string>();
            internal Func<HttpListenerContext, bool> PageHandler;
            internal void Start()
            {
                _port = FreePort();
                _listener = new HttpListener(); _listener.Prefixes.Add(Uri.AbsoluteUri); _listener.Start();
                Task.Run((Action)Loop);
            }
            private void Loop()
            {
                while (_listener.IsListening)
                {
                    HttpListenerContext context;
                    try { context = _listener.GetContext(); } catch { break; }
                    Task.Run(() => { try { Handle(context); } catch { try { context.Response.Abort(); } catch { } } });
                }
            }
            private void Handle(HttpListenerContext context)
            {
                string body = new StreamReader(context.Request.InputStream, Encoding.UTF8).ReadToEnd();
                string path = context.Request.Url.AbsolutePath;
                if (PageHandler != null && PageHandler(context)) return;
                lock (Seen) Seen.Add(new SeenRequest { Auth = context.Request.Headers["Authorization"], Body = body });
                if (context.Request.Headers["Authorization"] != "Bearer " + Token) { Reply(context, 401, "{\"code\":401}"); return; }
                if (path == "/api/harness/models") { Reply(context, 200, "{\"code\":200,\"data\":{\"models\":[{\"id\":1,\"label\":\"fake\",\"modelName\":\"fake\",\"toolCalling\":true,\"effectiveContextWindow\":100000}],\"defaultModelId\":1}}"); return; }
                if (path == "/api/harness/tools") { Reply(context, 200, "{\"code\":200,\"data\":[]}"); return; }
                if (path == "/api/harness/memory/brief") { Reply(context, 200, "{\"code\":200,\"data\":{\"enabled\":false}}"); return; }
                if (path != "/api/harness/model/stream") { Reply(context, 404, "{\"code\":404}"); return; }
                lock (Streams) Streams.Add(body);
                int tools = Count(body, "\"role\":\"tool\"");
                bool stopping = body.Contains("STOP");
                Dictionary<string, object> message;
                bool decision = body.Contains("DECIDE-WINDOWS") || body.Contains("DECIDE-WAIT");
                if (decision && tools == 0) message = Call("ask_user", DecisionSpec());
                else if (decision && body.Contains("保留现有") && body.Contains("其他输入：真 WebView2 验证")) message = new Dictionary<string, object> { { "role", "assistant" }, { "content", "WINDOWS-DECISION" } };
                else if (decision) message = new Dictionary<string, object> { { "role", "assistant" }, { "content", "WINDOWS-DECISION-MISSING" } };
                else if (stopping && tools == 0) message = Call("shell", new Dictionary<string, object> { { "command", "node -e \"setTimeout(()=>require('fs').writeFileSync('late.txt','bad'),5000)\"" } });
                else if (stopping) return;
                else if (tools == 0) message = Call("write_file", new Dictionary<string, object> { { "path", "new.txt" }, { "content", "draft-content\n" } });
                else if (tools == 1) message = Call("shell", new Dictionary<string, object> { { "command", "node -e \"require('fs').writeFileSync('command.txt','ok');console.log(process.env.ZHIQU_TOKEN||'clean')\"" } });
                else message = new Dictionary<string, object> { { "role", "assistant" }, { "content", "WINDOWS-DONE" } };
                var payload = new Dictionary<string, object> { { "message", message }, { "finishReason", message.ContainsKey("tool_calls") ? "tool_calls" : "stop" }, { "maxTokens", 1000 },
                    { "usage", new Dictionary<string, object> { { "promptTokens", 1 }, { "completionTokens", 1 }, { "estimated", false } } } };
                string sse = "event:start\ndata:{\"contextWindow\":100000,\"droppedMessages\":0,\"elidedToolOutputs\":0}\n\nevent:done\ndata:" + Json.Stringify(payload) + "\n\n";
                context.Response.ContentType = "text/event-stream; charset=utf-8";
                byte[] bytes = Utf8.GetBytes(sse); context.Response.ContentLength64 = bytes.Length;
                context.Response.OutputStream.Write(bytes, 0, bytes.Length); context.Response.Close();
            }
            internal void Stop() { try { _listener.Close(); } catch { } }
        }

        private static Dictionary<string, object> DecisionSpec()
        {
            return new Dictionary<string, object> { { "questions", new object[] {
                new Dictionary<string, object> { { "header", "实现" }, { "question", "采用哪种实现" }, { "allowOther", false }, { "options", new object[] {
                    new Dictionary<string, object> { { "label", "保留现有" }, { "description", "非推荐项" } },
                    new Dictionary<string, object> { { "label", "重写" }, { "recommended", true } },
                } } },
                new Dictionary<string, object> { { "header", "验证" }, { "question", "怎样验证" }, { "allowOther", true }, { "options", new object[] {
                    new Dictionary<string, object> { { "label", "命令行" }, { "recommended", true } },
                    new Dictionary<string, object> { { "label", "应用" } },
                } } },
            } } };
        }

        private static Dictionary<string, object> Call(string name, Dictionary<string, object> arguments)
        {
            return new Dictionary<string, object> { { "role", "assistant" }, { "content", string.Empty }, { "tool_calls", new object[] {
                new Dictionary<string, object> { { "id", "c-" + name }, { "type", "function" }, { "function", new Dictionary<string, object> { { "name", name }, { "arguments", Json.Stringify(arguments) } } } } } } };
        }
        private static int Count(string text, string part) { int count = 0, at = 0; while ((at = text.IndexOf(part, at, StringComparison.Ordinal)) >= 0) { count++; at += part.Length; } return count; }
        private static void Reply(HttpListenerContext context, int status, string body)
        {
            byte[] bytes = Utf8.GetBytes(body); context.Response.StatusCode = status; context.Response.ContentType = "application/json"; context.Response.ContentLength64 = bytes.Length;
            context.Response.OutputStream.Write(bytes, 0, bytes.Length); context.Response.Close();
        }
        internal static int FreePort()
        {
            var tcp = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0); tcp.Start(); int port = ((IPEndPoint)tcp.LocalEndpoint).Port; tcp.Stop(); return port;
        }

        private sealed class UpdateServer
        {
            private HttpListener _listener;
            private readonly byte[] _app;
            internal bool Good;
            internal Uri Uri { get; private set; }
            internal UpdateServer(string app) { _app = File.ReadAllBytes(app); }
            internal void Start()
            {
                Uri = new Uri("http://127.0.0.1:" + FreePort());
                _listener = new HttpListener(); _listener.Prefixes.Add(Uri.AbsoluteUri); _listener.Start();
                Task.Run((Action)Loop);
            }
            private void Loop()
            {
                while (_listener.IsListening)
                {
                    HttpListenerContext context;
                    try { context = _listener.GetContext(); } catch { break; }
                    if (context.Request.Url.AbsolutePath == "/update.exe")
                    {
                        context.Response.ContentLength64 = _app.Length; context.Response.OutputStream.Write(_app, 0, _app.Length); context.Response.Close(); continue;
                    }
                    string sha;
                    using (var hasher = SHA256.Create()) sha = Good ? BitConverter.ToString(hasher.ComputeHash(_app)).Replace("-", string.Empty).ToLowerInvariant() : new string('0', 64);
                    string json = "{\"code\":200,\"data\":{\"windows\":{\"version\":\"9.9.9\",\"size\":" + _app.Length + ",\"sha256\":\"" + sha + "\",\"url\":\"/update.exe\"}}}";
                    Reply(context, 200, json);
                }
            }
            internal void Stop() { try { _listener.Close(); } catch { } }
        }
    }
}
