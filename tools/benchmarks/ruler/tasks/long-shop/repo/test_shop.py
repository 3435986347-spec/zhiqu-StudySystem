import unittest

from shop import catalog, report, shipping, tax
from shop.pricing import Line, Order, compute_total


class ShopTest(unittest.TestCase):
    def test_catalog_lookup_is_forgiving(self):
        self.assertEqual(catalog.get(" sku-001 ").sku, "SKU-001")

    def test_round_half_up(self):
        self.assertEqual(tax.round_half_up(5, 10), 1)
        self.assertEqual(tax.round_half_up(-5, 10), -1)

    def test_free_shipping_threshold(self):
        self.assertEqual(shipping.cost(800, 5_000), 0)
        self.assertGreater(shipping.cost(800, 4_999), 0)

    def test_total_adds_up(self):
        t = compute_total(Order([Line("SKU-001", 2), Line("SKU-002", 1)], "CA"))
        self.assertEqual(t.total, t.subtotal + t.tax + t.shipping)

    def test_receipt_has_total(self):
        self.assertIn("Total", report.receipt(Order([Line("SKU-003", 1)], "NY")))


if __name__ == "__main__":
    unittest.main()
