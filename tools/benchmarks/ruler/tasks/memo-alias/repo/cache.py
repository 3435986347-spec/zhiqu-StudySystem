import functools


def memoize(fn):
    """按参数缓存函数的结果。"""
    store = {}

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        key = (args, tuple(kwargs.items()))
        if key not in store:
            store[key] = fn(*args, **kwargs)
        return store[key]
    return wrapper
