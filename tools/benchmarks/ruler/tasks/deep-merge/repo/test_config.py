import unittest

from config import deep_merge


class DeepMergeTest(unittest.TestCase):
    def test_top_level(self):
        self.assertEqual(deep_merge({'a': 1}, {'b': 2}), {'a': 1, 'b': 2})


if __name__ == '__main__':
    unittest.main()
