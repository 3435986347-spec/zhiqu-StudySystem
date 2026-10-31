import unittest

from cache import memoize


class HiddenMemoizeTest(unittest.TestCase):
    def test_caller_mutation_does_not_leak(self):
        @memoize
        def load(name):
            return {'name': name, 'tags': ['a'], 'nested': {'k': [1]}}

        first = load('x')
        first['extra'] = 1
        first['tags'].append('b')
        first['nested']['k'].append(2)
        again = load('x')
        self.assertEqual(again, {'name': 'x', 'tags': ['a'], 'nested': {'k': [1]}})
        again['tags'].append('c')
        self.assertEqual(load('x')['tags'], ['a'])

    def test_kwargs_order_is_same_key(self):
        calls = []

        @memoize
        def f(a, b):
            calls.append((a, b))
            return a + b

        self.assertEqual(f(a=1, b=2), 3)
        self.assertEqual(f(b=2, a=1), 3)
        self.assertEqual(len(calls), 1)

    def test_still_caches(self):
        calls = []

        @memoize
        def g(x):
            calls.append(x)
            return [x]

        g(1); g(1); g(2)
        self.assertEqual(calls, [1, 2])


if __name__ == '__main__':
    unittest.main()
