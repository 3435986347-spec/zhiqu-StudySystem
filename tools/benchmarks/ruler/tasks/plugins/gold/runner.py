from errors import PluginError
from registry import registered


def run_all(context=None):
    """按 priority 从小到大跑所有插件（一样的按注册先后），返回 context。插件的 PluginError 收进 context['errors']，别的异常往外抛。"""
    context = {} if context is None else context
    for plugin in sorted(registered(), key=lambda p: p['priority']):
        try:
            plugin['fn'](context)
        except PluginError as e:
            context.setdefault('errors', []).append(e)
    return context
