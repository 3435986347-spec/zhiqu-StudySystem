import unittest

from errors import InsufficientStock, ShopError, UnknownProduct
from service import OrderService
from store import Store


class HiddenOrderTest(unittest.TestCase):
    def test_insufficient_is_rejected_with_shop_error(self):
        store = Store({'apple': 2})
        with self.assertRaises(InsufficientStock) as cm:
            OrderService(store).place_order({'apple': 5})
        self.assertIsInstance(cm.exception, ShopError)
        self.assertEqual(store.get('apple'), 2)

    def test_multi_item_order_is_all_or_nothing(self):
        # 第一件够、第二件不够：第一件也不能已经扣掉
        store = Store({'apple': 5, 'pear': 1})
        with self.assertRaises(InsufficientStock):
            OrderService(store).place_order({'apple': 2, 'pear': 3})
        self.assertEqual(store.snapshot(), {'apple': 5, 'pear': 1})

    def test_unknown_in_middle_rolls_back_too(self):
        store = Store({'apple': 5, 'pear': 1})
        with self.assertRaises(UnknownProduct):
            OrderService(store).place_order({'apple': 2, 'durian': 1})
        self.assertEqual(store.snapshot(), {'apple': 5, 'pear': 1})

    def test_exact_amount_is_allowed(self):
        store = Store({'apple': 2})
        OrderService(store).place_order({'apple': 2})
        self.assertEqual(store.get('apple'), 0)


if __name__ == '__main__':
    unittest.main()
