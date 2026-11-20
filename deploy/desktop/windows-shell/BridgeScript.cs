namespace Zhiqu.Desktop
{
    internal static class BridgeScript
    {
        internal static string For(bool local)
        {
            return @"(function () {
  if (window.top !== window || !window.chrome || !chrome.webview) return;
  var pending = {}, seq = 0;
  var post = function (bridge, body) { chrome.webview.postMessage({ bridge: bridge, body: body }); };
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.zqNotify = { postMessage: function (body) { post('zqNotify', body); } };
  window.webkit.messageHandlers.zqMini = { postMessage: function (body) { post('zqMini', body); } };
" + (local ? @"  window.webkit.messageHandlers.zqLocal = { postMessage: function (body) {
    return new Promise(function (resolve, reject) {
      var id = 'w' + (++seq);
      pending[id] = { resolve: resolve, reject: reject };
      chrome.webview.postMessage({ bridge: 'zqLocal', id: id, body: body });
    });
  } };
  chrome.webview.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.bridge !== 'zqLocal.reply' || !pending[data.id]) return;
    var waiter = pending[data.id]; delete pending[data.id];
    if (data.ok) waiter.resolve(data.value); else waiter.reject(new Error(String(data.error || '本机代码助手没有回应')));
  });
" : string.Empty) + @"})();";
        }

        internal const string MiniDrag = @"(function () {
  if (window.top !== window || !window.chrome || !chrome.webview) return;
  document.addEventListener('mousedown', function (event) {
    if (event.button !== 0 || !event.target.closest('.zq-mini-body')) return;
    event.preventDefault();
    chrome.webview.postMessage({ bridge: 'zqMiniDrag', body: {} });
  }, true);
})();";
    }
}
