using System;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Zhiqu.Desktop
{
    internal static partial class WindowsChecks
    {
        private static T Field<T>(object target, string name)
        {
            return (T)target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(target);
        }
        private static void SetField(object target, string name, object value)
        {
            target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).SetValue(target, value);
        }
        private static async Task<string> Eval(CoreWebView2 core, string script) { return await core.ExecuteScriptAsync(script); }
        private static async Task<string> EvalString(CoreWebView2 core, string script)
        {
            string raw = await Eval(core, script);
            return new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<string>(raw);
        }
        private static async Task WaitUntil(Func<Task<bool>> condition, int timeoutMs = 30000)
        {
            DateTime until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < until)
            {
                if (await condition()) return;
                await Task.Delay(100);
            }
            throw new TimeoutException("WebView check timed out");
        }

        [DllImport("user32.dll")]
        private static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")]
        private static extern void mouse_event(uint flags, uint x, uint y, uint data, System.UIntPtr extra);
        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(Point point);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr window, System.Text.StringBuilder name, int count);
        private static string ClassName(IntPtr window)
        {
            var name = new System.Text.StringBuilder(256);
            GetClassName(window, name, name.Capacity);
            return name.ToString();
        }

        private static async Task DragMini(MiniWindow mini, CoreWebView2 core)
        {
            bool bridgeMessage = false;
            core.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e) { if (e.WebMessageAsJson.Contains("zqMiniDrag")) bridgeMessage = true; };
            await Eval(core, "window.hits=[];document.addEventListener('mousedown',function(e){hits.push({x:e.clientX,y:e.clientY,target:e.target.className||e.target.tagName});},true);0");
            mini.Location = new Point(100, 100);
            await Task.Delay(200);
            Point start = mini.PointToScreen(new Point(mini.Width / 2, mini.Height / 2));
            IntPtr hit = WindowFromPoint(start);
            uint hitPid;
            GetWindowThreadProcessId(hit, out hitPid);
            Log("web.hit", hit + "," + hitPid + ",self=" + Process.GetCurrentProcess().Id + ",mini=" + mini.Handle + ",root=" + GetAncestor(hit, 2) + ",class=" + ClassName(hit));
            using (var bitmap = new Bitmap(600, 300))
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(0, 0, 0, 0, bitmap.Size);
                bitmap.Save(DesktopPaths.DataFolder("mini-debug.png"), System.Drawing.Imaging.ImageFormat.Png);
            }
            Point old = Cursor.Position;
            int left = mini.Left, top = mini.Top;
            await Task.Run(() =>
            {
                SetCursorPos(start.X, start.Y);
                Thread.Sleep(150);
                mouse_event(2, 0, 0, 0, System.UIntPtr.Zero);
                Thread.Sleep(500);
                for (int i = 1; i <= 10; i++)
                {
                    SetCursorPos(start.X + i * 14, start.Y + i * 8);
                    Thread.Sleep(25);
                }
                mouse_event(4, 0, 0, 0, System.UIntPtr.Zero);
                SetCursorPos(old.X, old.Y);
            });
            await Task.Delay(200);
            Check(Math.Abs(mini.Left - left) > 50 && Math.Abs(mini.Top - top) > 30, "mini did not drag: " + mini.Location + " bridge=" + bridgeMessage + " hits=" + await Eval(core, "window.hits"));
            Log("web.drag", (mini.Left - left) + "," + (mini.Top - top));
        }

        private static void Web(string package, string work)
        {
            string oldServer = Environment.GetEnvironmentVariable("ZHIQU_DESKTOP_SERVER");
            string oldProfile = Environment.GetEnvironmentVariable("ZHIQU_DESKTOP_PROFILE");
            string oldInstance = Environment.GetEnvironmentVariable("ZHIQU_DESKTOP_INSTANCE");
            string registry = @"Software\zhiqu\desktop-web-check-" + Guid.NewGuid().ToString("N");
            var gate = new ManualResetEventSlim(false);
            var server = new FakeGateway();
            server.Start();
            bool frameReported = false, frameBridge = true;
            server.PageHandler = context =>
            {
                string path = context.Request.Url.AbsolutePath;
                if (path == "/api/desktop/downloads") { Reply(context, 200, "{\"code\":200,\"data\":{}}"); return true; }
                if (path == "/api/auth/info") { Reply(context, 200, "{\"code\":200,\"data\":{\"id\":1,\"username\":\"check\",\"role\":\"USER\"}}"); return true; }
                if (path == "/api/record/list") { Reply(context, 200, "{\"code\":200,\"data\":[]}"); return true; }
                if (path.StartsWith("/api/") && !path.StartsWith("/api/harness/")) { Reply(context, 200, "{\"code\":200,\"data\":[]}"); return true; }
                if (path == "/dashboard.html") { gate.Wait(15000); Page(context, DashboardHtml.Replace("__TOKEN__", Token)); return true; }
                if (path == "/mini.html") { Page(context, File.ReadAllText(Path.Combine(StaticRoot(), "mini.html"))); return true; }
                if (ServeStatic(context, path)) return true;
                if (path == "/frame.html") { Page(context, "<script>fetch('/frame-report?bridge=' + Boolean(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.zqLocal));</script>"); return true; }
                if (path == "/frame-report") { frameReported = true; frameBridge = context.Request.QueryString["bridge"] == "true"; Reply(context, 200, "{}"); return true; }
                if (path == "/favicon.ico") { context.Response.StatusCode = 204; context.Response.Close(); return true; }
                return false;
            };
            Environment.SetEnvironmentVariable("ZHIQU_DESKTOP_SERVER", server.Uri.AbsoluteUri);
            Environment.SetEnvironmentVariable("ZHIQU_DESKTOP_PROFILE", Path.Combine(work, "webview-profile"));
            Environment.SetEnvironmentVariable("ZHIQU_DESKTOP_INSTANCE", Guid.NewGuid().ToString("N"));
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                var form = new ShellForm { ShowInTaskbar = false };
                form.Shown += async delegate
                {
                    try { await RunWeb(form, server, package, work, registry, gate, () => frameReported, () => frameBridge); Log("web.ok", "true"); }
                    catch (Exception error) { Log("FAIL", error.ToString()); Environment.ExitCode = 1; }
                    finally { try { gate.Set(); form.Close(); } catch { } }
                };
                Application.Run(form);
            }
            finally
            {
                gate.Set(); server.Stop();
                try { Registry.CurrentUser.DeleteSubKeyTree(registry); } catch { }
                Environment.SetEnvironmentVariable("ZHIQU_DESKTOP_SERVER", oldServer);
                Environment.SetEnvironmentVariable("ZHIQU_DESKTOP_PROFILE", oldProfile);
                Environment.SetEnvironmentVariable("ZHIQU_DESKTOP_INSTANCE", oldInstance);
            }
        }

        private static async Task RunWeb(ShellForm form, FakeGateway server, string package, string work, string registry, ManualResetEventSlim gate,
            Func<bool> frameReported, Func<bool> frameBridge)
        {
            await WaitUntil(async () => Field<WebView2>(form, "_web") != null && Field<WebView2>(form, "_web").CoreWebView2 != null);
            WebView2 view = Field<WebView2>(form, "_web");
            string runtime = Path.Combine(work, "web-runtime");
            ExtractRuntime(package, runtime);
            string root = Directory.CreateDirectory(Path.Combine(work, "web-project")).FullName;
            string home = Directory.CreateDirectory(Path.Combine(work, "web-home")).FullName;
            var agent = new LocalAgent(new LocalAgent.Config { Runtime = runtime, Server = server.Uri, Home = home, Network = "on" });
            var folders = new LocalFolders(home, registry);
            var local = new LocalBridge(server.Uri, () => view.CoreWebView2, form, agent, folders) { ChooseFolder = () => root };
            LocalBridge previous = Field<LocalBridge>(form, "_local");
            previous.Dispose();
            SetField(form, "_local", local);
            var notices = new List<string>();
            DesktopNotifications notifications = Field<DesktopNotifications>(form, "_notifications");
            notifications.Sink = (title, body, tag) => { lock (notices) notices.Add(title + "|" + body + "|" + tag); };
            form.WindowState = FormWindowState.Minimized;
            gate.Set();
            CoreWebView2 core = view.CoreWebView2;
            await WaitUntil(async () =>
            {
                if (core.Source != server.Uri.AbsoluteUri + "dashboard.html") return false;
                string status = await EvalString(core, "window.testStatus || ''");
                if (status == "error") throw new InvalidOperationException(await EvalString(core, "window.testError || ''"));
                return status == "done";
            });
            await Eval(core, "window.finishChecks();0");
            await WaitUntil(async () => await EvalString(core, "window.checkStatus || ''") == "done");
            var results = Json.Object(await Eval(core, "window.checkResults"));
            Check(Json.Object(results["status"]) != null && (bool)Json.Object(results["status"])["available"], "status unavailable");
            Check((string)results["folder"] == LocalPath.Real(root), "picked wrong folder");
            Check((string)results["runId"] == "web-run" && (string)results["duplicate"] == "web-run", "run id/idempotence");
            Check((string)results["staleError"] != string.Empty, "stale draft accepted");
            Check((bool)results["applied"] && Text(Json.Object(results["read"]), "content") == "draft-content\n", "apply/read bridge");
            Check((bool)results["resumeFound"] && (bool)results["acked"] && !(bool)results["missing"], "snapshot lifecycle");
            Check(!(bool)results["tokenLeak"], "token reached web events");
            Check(File.ReadAllText(Path.Combine(root, "command.txt")) == "ok" && File.ReadAllText(Path.Combine(root, "new.txt")) == "draft-content\n", "web local turn disk");
            Check(server.Streams.Count == 3, "duplicate clientRunId started another turn: " + server.Streams.Count);
            lock (notices) Check(notices.Any(n => n.StartsWith("CHECK-NOTIFY|")), "main notification not delivered");
            await Eval(core, "window.runDecision();0");
            await WaitUntil(async () =>
            {
                if (await EvalString(core, "window.decisionStatus || ''") == "error") throw new InvalidOperationException(await EvalString(core, "window.decisionError || ''"));
                return await EvalString(core, "window.decisionStatus || ''") == "done";
            });
            var decision = Json.Object(await Eval(core, "window.decisionResults"));
            Check((bool)decision["question"] && (bool)decision["pending"] && (bool)decision["resolved"], "decision snapshot events missing");
            Check(!(bool)decision["invalid"] && (bool)decision["accepted"] && (bool)decision["duplicate"], "decision answer/idempotence");
            Check(!(bool)decision["conflict"] && !(bool)decision["late"], "conflicting or late decision accepted");
            Check((string)decision["conclusion"] == "WINDOWS-DECISION", "decision did not reach model");
            Check(server.Streams.Count == 5, "decision bridge caused an extra model turn: " + server.Streams.Count);
            await WaitUntil(async () => frameReported());
            Check(!frameBridge(), "iframe received zqLocal");

            await Eval(core, "webkit.messageHandlers.zqMini.postMessage({action:'shrink'});0");
            await WaitUntil(async () => Field<MiniWindow>(form, "_mini") != null && Field<MiniWindow>(form, "_mini").Visible);
            MiniWindow mini = Field<MiniWindow>(form, "_mini");
            WebView2 miniView = Field<WebView2>(mini, "_web");
            await WaitUntil(async () => miniView.CoreWebView2 != null && miniView.CoreWebView2.Source == server.Uri.AbsoluteUri + "mini.html"
                && await EvalString(miniView.CoreWebView2, "localStorage.getItem('check-shared') || ''") == "same-login"
                && await EvalString(miniView.CoreWebView2, "document.getElementById('zq-mini-go').dataset.wired || ''") == "1");
            Check(mini.TopMost && !mini.ShowInTaskbar && mini.Width >= 300 && mini.Height >= 68, "mini window style");
            Check(await Eval(miniView.CoreWebView2, "document.documentElement.classList.contains('zq-signed-out')") != "true", "official mini is signed out");
            var visual = Json.Object(await Eval(miniView.CoreWebView2, "({radius:getComputedStyle(document.querySelector('.zq-main')).borderRadius,time:document.getElementById('zq-mini-time').textContent,go:getComputedStyle(document.getElementById('zq-mini-go')).display})"));
            Check((string)visual["radius"] == "999px" && (string)visual["go"] != "none" && !string.IsNullOrWhiteSpace((string)visual["time"]), "official mini appearance");
            await Eval(miniView.CoreWebView2, "document.getElementById('zq-mini-go').click();0");
            await WaitUntil(async () => await EvalString(miniView.CoreWebView2, "Object.keys(localStorage).filter(k=>k.startsWith('zq.pomo.')).map(k=>JSON.parse(localStorage.getItem(k)).phase).join(',')") == "running");
            await Eval(miniView.CoreWebView2, "document.getElementById('zq-mini-go').click();0");
            await WaitUntil(async () => await EvalString(miniView.CoreWebView2, "Object.keys(localStorage).filter(k=>k.startsWith('zq.pomo.')).map(k=>JSON.parse(localStorage.getItem(k)).phase).join(',')") == "paused");
            Log("web.pomo", "running,paused");
            Check(!(bool)Json.Object(await Eval(miniView.CoreWebView2, "({hasLocal:Boolean(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.zqLocal)})"))["hasLocal"], "mini has local bridge");
            await DragMini(mini, miniView.CoreWebView2);
            await Eval(miniView.CoreWebView2, "webkit.messageHandlers.zqNotify.postMessage({action:'notify',title:'MINI-NOTIFY',body:'mini',tag:'m'});0");
            await WaitUntil(async () => { lock (notices) return notices.Any(n => n.StartsWith("MINI-NOTIFY|")); });
            await Eval(miniView.CoreWebView2, "document.getElementById('zq-mini-expand').click();0");
            await WaitUntil(async () => !mini.Visible && form.Visible);
            lock (notices) Check(!notices.Any(n => n.StartsWith("FRAME|")), "iframe notification accepted");
            Log("web.streams", server.Streams.Count);
            Check(server.Streams.Count == 5, "unexpected total model turns");
            Log("web.notifications", notices.Count);
            Log("web.mini", "shared,expanded");
        }

        private static string StaticRoot()
        {
            return Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "zhiqu-backend", "src", "main", "resources", "static"));
        }
        private static bool ServeStatic(HttpListenerContext context, string path)
        {
            string relative = Uri.UnescapeDataString(path.TrimStart('/')).Replace('/', Path.DirectorySeparatorChar);
            string file = Path.Combine(StaticRoot(), relative);
            if (!File.Exists(file) || !LocalPath.Under(file, StaticRoot())) return false;
            string extension = Path.GetExtension(file).ToLowerInvariant();
            string type = extension == ".css" ? "text/css" : extension == ".js" ? "text/javascript" : extension == ".json" ? "application/json" : extension == ".png" ? "image/png" : extension == ".svg" ? "image/svg+xml" : "application/octet-stream";
            byte[] bytes = File.ReadAllBytes(file);
            context.Response.ContentType = type + (type.StartsWith("text/") ? "; charset=utf-8" : string.Empty);
            context.Response.ContentLength64 = bytes.Length;
            context.Response.OutputStream.Write(bytes, 0, bytes.Length);
            context.Response.Close();
            return true;
        }

        private static void Page(HttpListenerContext context, string html)
        {
            byte[] bytes = Utf8.GetBytes(html);
            context.Response.ContentType = "text/html; charset=utf-8";
            context.Response.Headers["Cache-Control"] = "no-store";
            context.Response.ContentLength64 = bytes.Length;
            context.Response.OutputStream.Write(bytes, 0, bytes.Length);
            context.Response.Close();
        }

        private const string MiniHtml = @"<!doctype html><meta charset='utf-8'><style>html,body{margin:0;background:transparent}main{height:56px;margin:6px;background:#222;color:white;display:flex}.zq-mini-body{flex:1}</style>
<main><button id='go'>go</button><div class='zq-mini-body'>25:00</div><button id='expand'>expand</button></main>
<script>window.sharedValue=localStorage.getItem('check-shared');document.getElementById('expand').onclick=()=>webkit.messageHandlers.zqMini.postMessage({action:'expand'});</script>";

        private const string DashboardHtml = @"<!doctype html><meta charset='utf-8'><title>知趣象限</title><iframe src='/frame.html'></iframe>
<script>
window.localEvents=[];window.testStatus='starting';window.checkStatus='';window.decisionStatus='';
window.addEventListener('zq-local',function(e){
  window.localEvents.push(e.detail);
  if(e.detail.type==='question'&&window.onDecisionQuestion)window.onDecisionQuestion(e.detail);
  if(e.detail.type==='result'&&e.detail.runId==='web-decision'&&window.onDecisionResult)window.onDecisionResult(e.detail);
  if(e.detail.type==='result')window.terminal=e.detail;
  if(e.detail.type==='exit')window.testStatus='done';
});
const local=body=>window.webkit.messageHandlers.zqLocal.postMessage(body);
window.start=async function(){try{
  if(!window.webkit||!webkit.messageHandlers.zqLocal||!webkit.messageHandlers.zqNotify||!webkit.messageHandlers.zqMini)throw new Error('bridge missing');
  localStorage.setItem('check-shared','same-login');
  localStorage.setItem('token','check-web-token');localStorage.setItem('role','USER');
  window.statusValue=await local({action:'status'});
  const picked=await local({action:'pick'});window.picked=picked;
  window.original={action:'run',clientRunId:'web-run',folder:picked.folder,message:'WINDOWS-DIRECT',history:[],model:1,effort:'instant',level:'EXEC',token:'__TOKEN__',server:'http://127.0.0.1:1'};
  window.runReply=await local(window.original);
}catch(e){window.testError=String(e&&e.stack||e);window.testStatus='error';}};
window.finishChecks=async function(){try{
  let staleError='';try{await local({action:'apply',folder:picked.folder,files:[{path:'new.txt',content:'bad',baseline:'0000000000000000000000000000000000000000000000000000000000000000'}]});}catch(e){staleError=String(e&&e.message||e);}
  const applied=await local({action:'apply',folder:picked.folder,files:window.terminal.drafts});
  const read=await local({action:'read',folder:picked.folder,path:'new.txt'});
  const resumed=await local({action:'resume',runId:'web-run'});
  const duplicate=await local(window.original);
  const acked=await local({action:'ack',runId:'web-run'});
  const missing=await local({action:'resume',runId:'web-run'});
  webkit.messageHandlers.zqNotify.postMessage({action:'authorize'});
  webkit.messageHandlers.zqNotify.postMessage({action:'notify',title:'CHECK-NOTIFY',body:'body',tag:'tag'});
  window.checkResults={status:statusValue,folder:picked.folder,runId:runReply.runId,duplicate:duplicate.runId,staleError:staleError,applied:applied.written===1,read:read,resumeFound:resumed.found&&resumed.result.type==='result',acked:acked.acknowledged,missing:missing.found,tokenLeak:JSON.stringify(localEvents).includes('__TOKEN__')};
  window.checkStatus='done';
}catch(e){window.testError=String(e&&e.stack||e);window.testStatus='error';window.checkStatus='error';}};
window.runDecision=async function(){try{
  window.decisionStatus='running';
  const answers=[{questionId:'q1',optionId:'o1'},{questionId:'q2',optionId:'__other__',otherText:'真 WebView2 验证'}];
  let questionResolve,resultResolve;
  const question=new Promise(r=>{questionResolve=r;}),terminal=new Promise(r=>{resultResolve=r;});
  window.onDecisionQuestion=questionResolve;window.onDecisionResult=resultResolve;
  await local({action:'run',clientRunId:'web-decision',folder:picked.folder,message:'DECIDE-WINDOWS',history:[],model:1,effort:'instant',level:'READ',token:'__TOKEN__',userDecision:true});
  const q=await question,decisionId=q.id;
  const pending=await local({action:'resume',runId:'web-decision'});
  const invalid=await local({action:'answer',runId:'web-decision',decisionId:decisionId,answers:[answers[0]]});
  const accepted=local({action:'answer',runId:'web-decision',decisionId:decisionId,answers:answers});
  const duplicate=local({action:'answer',runId:'web-decision',decisionId:decisionId,answers:[answers[0],{questionId:'q2',optionId:'__other__',otherText:'  真 WebView2 验证\n'}]});
  const conflict=local({action:'answer',runId:'web-decision',decisionId:decisionId,answers:[{questionId:'q1',optionId:'o2'},answers[1]]});
  const settled=await Promise.all([accepted,duplicate,conflict]);
  const result=await terminal;
  const resumed=await local({action:'resume',runId:'web-decision'});
  const late=await local({action:'answer',runId:'web-decision',decisionId:decisionId,answers:answers});
  window.decisionResults={question:q.questions.length===2,pending:pending.events.some(e=>e.type==='question'),resolved:resumed.events.some(e=>e.type==='question_resolved'),
    invalid:invalid.accepted,accepted:settled[0].accepted,duplicate:settled[1].accepted&&settled[1].duplicate,conflict:settled[2].accepted,late:late.accepted,conclusion:result.conclusion};
  window.decisionStatus='done';
}catch(e){window.decisionError=String(e&&e.stack||e);window.decisionStatus='error';}};
window.start();
</script>";
    }
}
