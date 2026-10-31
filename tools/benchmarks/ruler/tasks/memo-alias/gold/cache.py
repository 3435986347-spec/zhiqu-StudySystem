import copy
import functools


def memoize(fn):
    """按参数缓存函数的结果。每次给调用方一份副本：调用方改了也不影响缓存。"""
    store = {}

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        key = (args, tuple(sorted(kwargs.items())))
        if key not in store:
            store[key] = fn(*args, **kwargs)
        return copy.deepcopy(store[key])
    return wrapper
