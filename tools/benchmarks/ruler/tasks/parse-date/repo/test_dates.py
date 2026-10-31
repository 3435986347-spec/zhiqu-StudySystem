import unittest
from datetime import date

from dates import parse_date


class ParseDateTest(unittest.TestCase):
    def test_dash(self):
        self.assertEqual(parse_date('2024-03-05'), date(2024, 3, 5))


if __name__ == '__main__':
    unittest.main()
