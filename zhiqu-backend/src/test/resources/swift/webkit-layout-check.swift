// DesktopWebKitLayoutTest 的检查程序（第五十三轮）：在真的 WebKit（WKWebView，桌面应用就是它）里，用发布的 zhiqu-ui.css 量几样东西 ——
// 内置浏览器是 Chromium，有的样子（appearance: base-select）只有它认，在桌面应用里是另一副样子，只在 Chromium 里看过的话照不出来。
// 不开窗口：WKWebView 不放进窗口也会排版、跑脚本。用法：check <目录>（里面有 zhiqu-ui.css、week.html、pomo.html），每一项打印一行「键=值」。
import AppKit
import WebKit

let dir = URL(fileURLWithPath: CommandLine.arguments[1])
func out(_ key: String, _ value: Any) { print("\(key)=\(value)"); fflush(stdout) }
let week = try! String(contentsOf: dir.appendingPathComponent("week.html"), encoding: .utf8)
let pomo = try! String(contentsOf: dir.appendingPathComponent("pomo.html"), encoding: .utf8)
// 三种宽度的日历：322 是 960 宽的窗口里日历那张卡片的宽度（内置浏览器里量的），802 是 1440 宽时的，200 是 320 宽的手机上
let page = """
<!DOCTYPE html><html lang="zh-CN" data-zq-mode="light" data-zq-accent="mono"><head><meta charset="utf-8"><link rel="stylesheet" href="zhiqu-ui.css"></head>
<body style="margin:0;padding:20px;">
<div id="narrow" style="width:322px"><div class="zq-week">\(week)</div></div>
<div id="wide" style="width:802px;margin-top:20px"><div class="zq-week">\(week)</div></div>
<div id="tiny" style="width:200px;margin-top:20px"><div class="zq-week">\(week)</div></div>
<div id="pomo-host" style="width:260px;margin-top:20px">\(pomo)</div>
<select class="zq-composer-model" id="model"><option>DeepSeek（我的）</option></select>
</body></html>
"""
let pageURL = dir.appendingPathComponent("page.html")
try! page.write(to: pageURL, atomically: true, encoding: .utf8)

final class Waiter: NSObject, WKNavigationDelegate {
    var loaded = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 1400), configuration: config)
let waiter = Waiter()
web.navigationDelegate = waiter
web.loadFileURL(pageURL, allowingReadAccessTo: dir)

let measure = """
(function(){
  // 日期、星期、那一排点，哪个出了格子（左右、下边）都算
  function over(root){ var m = 0; root.querySelectorAll('.zq-day').forEach(function(d){ var a = d.getBoundingClientRect();
    d.querySelectorAll('.zq-day-num,.zq-day-week,.zq-day-dots').forEach(function(e){ var n = e.getBoundingClientRect();
      m = Math.max(m, n.right - a.right, a.left - n.left, n.bottom - a.bottom); }); }); return Math.round(m * 10) / 10; }
  function head(root){ return getComputedStyle(root.querySelector('.zq-day-head')).flexDirection; }
  var task = document.getElementById('zq-pomo-task');
  var long = document.createElement('option'); long.textContent = '整理第三季度风控规则的回归用例并且和两边的同事一起确认每一条的预期结果'; long.value = '9';
  task.appendChild(long); task.value = '9';
  var card = document.querySelector('.zq-pomo').getBoundingClientRect(), sel = task.getBoundingClientRect();
  var app = function(el){ var s = getComputedStyle(el); return s.appearance || s.webkitAppearance; };
  var result = {
    days: document.querySelectorAll('#narrow .zq-day').length,
    narrowOverflow: over(document.getElementById('narrow')), narrowHead: head(document.getElementById('narrow')),
    wideOverflow: over(document.getElementById('wide')), wideHead: head(document.getElementById('wide')),
    tinyOverflow: over(document.getElementById('tiny')),
    selectOver: Math.round((sel.right - card.right) * 10) / 10,
    selectAppearance: app(task), modelAppearance: app(document.getElementById('model')),
    baseSelect: CSS.supports('appearance', 'base-select')
  };
  // 第六十五轮：合成长文，不读取真实 Wiki；读取和 contenteditable 共用发布的 .zq-prose / .zq-md。
  // 1120px 会揭示旧的 42em（630px）上限，三种宽度都得让宽表格和代码在自己的容器里滚。
  var wikiCases = 0;
  [['wide',1120],['narrow',660],['tiny',240]].forEach(function(size){
    ['read','edit'].forEach(function(mode){
      var doc = document.createElement('div'); doc.className = 'zq-prose'; doc.contentEditable = mode === 'edit';
      doc.style.cssText = 'width:' + size[1] + 'px;padding:22px 26px 30px;overflow-y:auto';
      doc.innerHTML = '<div class="zq-md"><p>' + '知识库正文应使用当前卡片的可用宽度。'.repeat(30)
        + ' synthetic_' + 'a'.repeat(400) + '</p><p><span class="zq-md-image"><img alt="合成图片" width="1800" height="20" '
        + 'src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221800%22 height=%2220%22%3E%3C/svg%3E"></span></p>'
        + '<pre><code>' + 'long_unbroken_code_'.repeat(150) + '</code></pre>'
        + '<div class="zq-md-table"><table><tr><td>' + 'wide_table_cell_'.repeat(150) + '</td></tr></table></div></div>';
      document.body.appendChild(doc);
      var md = doc.firstElementChild, style = getComputedStyle(doc), pre = md.querySelector('pre'), table = md.querySelector('.zq-md-table');
      var key = 'wiki.' + size[0] + '.' + mode;
      result[key + '.unusedWidth'] = doc.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - md.getBoundingClientRect().width;
      result[key + '.overflow'] = Math.max(0, doc.scrollWidth - doc.clientWidth);
      result[key + '.codeScroll'] = pre.scrollWidth - pre.clientWidth;
      result[key + '.tableScroll'] = table.scrollWidth - table.clientWidth;
      wikiCases++;
    });
  });
  result.wikiCases = wikiCases;
  return JSON.stringify(result);
})()
"""
var started = Date()
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { timer in
    if Date().timeIntervalSince(started) > 20 { out("timeout", true); exit(1) }
    guard waiter.loaded else { return }
    timer.invalidate()
    // 等字体、样式表排好
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        web.evaluateJavaScript(measure) { result, error in
            if let error { out("jsError", error.localizedDescription); exit(1) }
            guard let text = result as? String, let data = text.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { out("badResult", "\(String(describing: result))"); exit(1) }
            for key in obj.keys.sorted() { out(key, obj[key]!) }
            out("done", true)
            exit(0)
        }
    }
}
app.run()
