import unittest
from datetime import date

from weeks import week_range


class HiddenWeekRangeTest(unittest.TestCase):
    def test_issue_example(self):
        self.assertEqual(week_range(date(2024, 3, 6)), (date(2024, 3, 4), date(2024, 3, 10)))

    def test_monday_and_sunday(self):
        self.assertEqual(week_range(date(2024, 3, 4)), (date(2024, 3, 4), date(2024, 3, 10)))
        self.assertEqual(week_range(date(2024, 3, 10)), (date(2024, 3, 4), date(2024, 3, 10)))

    def test_year_and_leap_boundaries(self):
        self.assertEqual(week_range(date(2025, 1, 1)), (date(2024, 12, 30), date(2025, 1, 5)))
        self.assertEqual(week_range(date(2024, 2, 29)), (date(2024, 2, 26), date(2024, 3, 3)))
        self.assertEqual(week_range(date(2023, 1, 1)), (date(2022, 12, 26), date(2023, 1, 1)))


if __name__ == '__main__':
    unittest.main()
