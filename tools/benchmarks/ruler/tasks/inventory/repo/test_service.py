import unittest

from errors import UnknownProduct
from service import OrderService
from store import Store


class OrderServiceTest(unittest.TestCase):
    def test_order_reduces_stock(self):
        store = Store({'apple': 5, 'pear': 2})
        OrderService(store).place_order({'apple': 2})
        self.assertEqual(store.get('apple'), 3)

    def test_restock_unknown_rolls_back(self):
        store = Store({'apple': 5})
        with self.assertRaises(UnknownProduct):
            OrderService(store).restock({'apple': 1, 'durian': 1})
        self.assertEqual(store.get('apple'), 5)


if __name__ == '__main__':
    unittest.main()
