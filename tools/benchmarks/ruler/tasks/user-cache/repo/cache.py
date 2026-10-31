class Cache:
    """进程内缓存。键一律用 key(...) 拼，别自己拼字符串 —— 拼法改过一次，手拼的地方全错了。"""

    def __init__(self):
        self._data = {}

    @staticmethod
    def key(kind, value):
        return f'{kind}:{str(value).lower()}'

    def get(self, k):
        return self._data.get(k)

    def set(self, k, v):
        self._data[k] = v

    def delete(self, k):
        self._data.pop(k, None)

    def clear(self):
        self._data.clear()

    def keys(self):
        return list(self._data)
