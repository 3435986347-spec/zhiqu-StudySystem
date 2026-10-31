from registry import registered


def run_all(context=None):
    """按顺序跑所有插件，返回 context。"""
    context = {} if context is None else context
    for plugin in registered():
        plugin['fn'](context)
    return context
