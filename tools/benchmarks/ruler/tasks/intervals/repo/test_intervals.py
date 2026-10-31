import unittest

from intervals import merge


class MergeTest(unittest.TestCase):
    def test_overlap(self):
        self.assertEqual(merge([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]])


if __name__ == '__main__':
    unittest.main()
