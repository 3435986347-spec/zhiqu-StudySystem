import unittest

from shop import catalog, report, tax
from shop.errors import UnknownDiscount
from shop.pricing import Line, Order, Totals, compute_total


def lines(*pairs):
    return [Line(s, q) for s, q in pairs]


class HiddenDiscountTest(unittest.TestCase):
    def setUp(self):
        self.basket = lines(("SKU-001", 2), ("SKU-002", 1), ("SKU-003", 3))
        self.plain = compute_total(Order(self.basket, "CA"))

    def test_no_code_unchanged(self):
        for code in (None, "", "   "):
            t = compute_total(Order(self.basket, "CA", code))
            self.assertEqual(t.discount, 0)
            self.assertIsNone(t.discount_code)
            self.assertEqual(t.total, self.plain.total)

    def test_unknown_code(self):
        with self.assertRaises(UnknownDiscount):
            compute_total(Order(self.basket, "CA", "NOPE"))

    def test_percent_case_insensitive(self):
        t = compute_total(Order(self.basket, "CA", " welcome10 "))
        self.assertEqual(t.discount_code, "WELCOME10")
        self.assertEqual(t.discount, tax.round_half_up(self.plain.subtotal * 10, 100))

    def test_percent_capped(self):
        mega = compute_total(Order(self.basket, "CA", "MEGA80"))
        half = compute_total(Order(self.basket, "CA", "HALFOFF"))
        self.assertEqual(mega.discount, half.discount)
        self.assertEqual(mega.discount, tax.round_half_up(self.plain.subtotal * 50, 100))

    def test_fixed_not_below_zero(self):
        t = compute_total(Order(lines(("SKU-004", 1)), "CA", "BIGFIXED"))
        self.assertEqual(t.discount, t.subtotal)
        self.assertEqual(t.tax, 0)
        self.assertEqual(t.total, t.shipping)

    def test_fixed_small(self):
        t = compute_total(Order(self.basket, "NY", "FIVEOFF"))
        self.assertEqual(t.discount, 500)

    def test_total_formula(self):
        for code in ("WELCOME10", "HALFOFF", "FIVEOFF", "BIGFIXED"):
            t = compute_total(Order(self.basket, "TX", code))
            self.assertEqual(t.total, t.subtotal - t.discount + t.tax + t.shipping, code)

    def test_tax_on_discounted_lines(self):
        region = next(r for r in tax.REGIONS.values() if r.rate_bp and not r.exempt_categories)
        t = compute_total(Order(self.basket, region.code, "HALFOFF"))
        amounts = [a for _, _, a in t.lines]
        sub = sum(amounts)
        raw = [a * t.discount for a in amounts]
        shares = [r // sub for r in raw]
        left = t.discount - sum(shares)
        for i in sorted(range(len(amounts)), key=lambda i: (-(raw[i] % sub), i))[:left]:
            shares[i] += 1
        self.assertEqual(sum(shares), t.discount)
        expected = sum(tax.round_half_up((a - s) * region.rate_bp, 10_000) for a, s in zip(amounts, shares))
        self.assertEqual(t.tax, expected)
        self.assertLess(t.tax, compute_total(Order(self.basket, region.code)).tax)

    def test_exempt_category_stays_untaxed(self):
        for r in tax.REGIONS.values():
            if r.rate_bp and r.exempt_categories:
                cat = sorted(r.exempt_categories)[0]
                p = catalog.in_category(cat)[0]
                t = compute_total(Order(lines((p.sku, 1)), r.code, "WELCOME10"))
                self.assertEqual(t.tax, 0)
                return
        self.skipTest("no region with an exemption")

    def test_free_shipping_uses_pre_discount_subtotal(self):
        p = min((p for p in catalog.PRODUCTS.values() if 5_000 <= p.price < 9_000), key=lambda p: p.price)
        t = compute_total(Order(lines((p.sku, 1)), "CA", "HALFOFF"))
        self.assertEqual(t.shipping, 0)

    def test_totals_positional_still_works(self):
        t = Totals(100, 7, 0, 107)
        self.assertEqual(t.discount, 0)
        self.assertIsNone(t.discount_code)

    def test_receipt_line(self):
        text = report.receipt(Order(self.basket, "CA", "fiveoff")).splitlines()
        i = next(k for k, l in enumerate(text) if l.startswith("Subtotal"))
        self.assertTrue(text[i + 1].startswith("Discount (FIVEOFF)"), text[i + 1])
        self.assertTrue(text[i + 1].rstrip().endswith("-$5.00"), text[i + 1])
        self.assertFalse(any(l.startswith("Discount") for l in report.receipt(Order(self.basket, "CA")).splitlines()))


if __name__ == "__main__":
    unittest.main()
