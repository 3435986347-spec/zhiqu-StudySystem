class ShopError(Exception):
    """这个项目里所有业务错误的基类。接口层只把 ShopError 的子类翻译成给用户看的提示，别的异常一律当成 500。"""


class UnknownProduct(ShopError):
    def __init__(self, sku):
        super().__init__(f'没有这个商品：{sku}')
        self.sku = sku


class InsufficientStock(ShopError):
    def __init__(self, sku, wanted, left):
        super().__init__(f'{sku} 库存不够：要 {wanted}，只剩 {left}')
        self.sku, self.wanted, self.left = sku, wanted, left
