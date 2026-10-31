# 迷你插件框架

插件用 `@register(name, priority=...)` 注册。

- **priority 越小越先执行**（默认 100）；priority 一样的按注册的先后。
- 插件之间靠 `context` 这个 dict 传东西：前面的插件写进去，后面的读。
- 一个插件抛了 `PluginError`，后面的照样跑，错误收进 `context['errors']`（列表，按发生的顺序）；别的异常直接往外抛。
