import unittest
from datetime import date

from weeks import week_range


class WeekRangeTest(unittest.TestCase):
    def test_returns_two_dates(self):
        start, end = week_range(date(2024, 3, 6))
        self.assertEqual((end - start).days, 6)


if __name__ == '__main__':
    unittest.main()
