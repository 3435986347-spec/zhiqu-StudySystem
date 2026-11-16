class ShopError(Exception):
    """Base class for every error this package raises on purpose."""


class UnknownProduct(ShopError):
    def __init__(self, sku):
        super().__init__(f"unknown product: {sku}")
        self.sku = sku


class UnknownRegion(ShopError):
    def __init__(self, region):
        super().__init__(f"unknown region: {region}")
        self.region = region


class InvalidQuantity(ShopError):
    def __init__(self, sku, quantity):
        super().__init__(f"invalid quantity {quantity!r} for {sku}")
        self.sku = sku
        self.quantity = quantity


class UnknownDiscount(ShopError):
    def __init__(self, code):
        super().__init__(f"unknown discount code: {code}")
        self.code = code
