import contextlib
import copy


class Store:
    """内存里的库存表。改库存要在 transaction() 里改：块里抛异常，整个块的改动都撤回。"""

    def __init__(self, stock):
        self._stock = dict(stock)

    def get(self, sku):
        return self._stock.get(sku)

    def set(self, sku, qty):
        self._stock[sku] = qty

    def snapshot(self):
        return dict(self._stock)

    @contextlib.contextmanager
    def transaction(self):
        saved = copy.deepcopy(self._stock)
        try:
            yield self
        except BaseException:
            self._stock = saved
            raise
