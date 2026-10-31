import unittest

from cache import memoize


class MemoizeTest(unittest.TestCase):
    def test_caches(self):
        calls = []

        @memoize
        def f(x):
            calls.append(x)
            return x * 2

        self.assertEqual(f(2), 4)
        self.assertEqual(f(2), 4)
        self.assertEqual(calls, [2])


if __name__ == '__main__':
    unittest.main()
