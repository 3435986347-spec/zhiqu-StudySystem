import unittest

from duration import parse_duration


class HiddenDurationTest(unittest.TestCase):
    def test_issue_examples(self):
        self.assertEqual(parse_duration('1h30m'), 5400)
        self.assertEqual(parse_duration('2h5s'), 7205)
        self.assertEqual(parse_duration('90s'), 90)
        self.assertEqual(parse_duration(' 1H '), 3600)

    def test_more(self):
        self.assertEqual(parse_duration('1h1m1s'), 3661)
        self.assertEqual(parse_duration('30m'), 1800)
        self.assertEqual(parse_duration('0s'), 0)
        self.assertIsInstance(parse_duration('2h'), int)

    def test_errors(self):
        for bad in ['', '   ', '-5m', '5d', 'abc', '10', '1h30', 'h']:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    parse_duration(bad)


if __name__ == '__main__':
    unittest.main()
