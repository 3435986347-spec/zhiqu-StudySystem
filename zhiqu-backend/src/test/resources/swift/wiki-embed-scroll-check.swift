// Real WKWebView with the published CSS and JSON markup. No visible window or user data.
// Programmatic scrolling checks the layout's scroll ownership; CUA separately exercises a real wheel.
import AppKit
import WebKit

let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let markup = try! String(contentsOf: dir.appendingPathComponent("preview.html"), encoding: .utf8)
let fixture = """
<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="zhiqu-ui.css"></head>
<body style="margin:0"><template id="preview">\(markup)</template></body></html>
"""
let page = dir.appendingPathComponent("check.html")
try! fixture.write(to: page, atomically: true, encoding: .utf8)

func out(_ key: String, _ value: Any) { print("\(key)=\(value)"); fflush(stdout) }
final class Waiter: NSObject, WKNavigationDelegate {
    var loaded = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 800), configuration: config)
let waiter = Waiter()
web.navigationDelegate = waiter
web.loadFileURL(page, allowingReadAccessTo: dir)

let measure = """
(function(){
  var result = {}, cases = 0;
  ['read', 'edit'].forEach(function(mode){
    [880, 320].forEach(function(width){
      var doc = document.createElement('div'); doc.className = 'zq-prose';
      doc.contentEditable = mode === 'edit';
      doc.style.cssText = 'width:' + width + 'px;height:650px;overflow:auto;padding:16px';
      var md = document.createElement('div'); md.className = 'zq-md';
      md.innerHTML = document.getElementById('preview').innerHTML;
      doc.appendChild(md); document.body.appendChild(doc);
      var wrapper = md.querySelector('.zq-embed-text'), pre = wrapper.querySelector('pre');
      var code = pre.querySelector('code'), source = code.textContent;
      pre.scrollTop = 180; pre.scrollLeft = 120;
      var key = mode + '.' + width;
      result[key + '.height'] = pre.clientHeight;
      result[key + '.vertical'] = pre.scrollTop;
      result[key + '.horizontal'] = pre.scrollLeft;
      result[key + '.outer'] = doc.scrollTop;
      result[key + '.wrapperOverflow'] = getComputedStyle(wrapper).overflowY;
      result[key + '.documentOverflow'] = Math.max(0, doc.scrollWidth - doc.clientWidth);
      result[key + '.sourceIntact'] = source === code.textContent && source.indexOf('Synthetic JSON') >= 0;
      cases++;
    });
  });
  result.cases = cases;
  return JSON.stringify(result);
})()
"""
let started = Date()
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { timer in
    if Date().timeIntervalSince(started) > 20 { out("timeout", true); exit(1) }
    guard waiter.loaded else { return }
    timer.invalidate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        web.evaluateJavaScript(measure) { value, error in
            if let error { out("jsError", error.localizedDescription); exit(1) }
            guard let text = value as? String, let data = text.data(using: .utf8),
                  let results = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                out("badResult", String(describing: value)); exit(1)
            }
            for key in results.keys.sorted() { out(key, results[key]!) }
            out("done", true); exit(0)
        }
    }
}
app.run()
