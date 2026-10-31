from errors import UnknownProduct


class OrderService:
    def __init__(self, store):
        self.store = store

    def restock(self, items):
        """进货：items 是 {sku: 数量}。一单里有不认识的商品，整单都不进。"""
        with self.store.transaction():
            for sku, qty in items.items():
                if self.store.get(sku) is None:
                    raise UnknownProduct(sku)
                self.store.set(sku, self.store.get(sku) + qty)

    def place_order(self, items):
        """下单：items 是 {sku: 数量}，扣库存。"""
        for sku, qty in items.items():
            left = self.store.get(sku)
            if left is None:
                raise UnknownProduct(sku)
            self.store.set(sku, left - qty)
