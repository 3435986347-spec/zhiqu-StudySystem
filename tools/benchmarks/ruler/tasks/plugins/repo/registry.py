_PLUGINS = []


def register(name, priority=100):
    def decorate(fn):
        _PLUGINS.append({'name': name, 'priority': priority, 'fn': fn})
        return fn
    return decorate


def clear():
    _PLUGINS.clear()


def registered():
    return list(_PLUGINS)
