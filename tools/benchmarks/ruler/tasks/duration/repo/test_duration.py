import unittest

from duration import parse_duration


class DurationTest(unittest.TestCase):
    def test_hours(self):
        self.assertEqual(parse_duration('2h'), 7200)


if __name__ == '__main__':
    unittest.main()
