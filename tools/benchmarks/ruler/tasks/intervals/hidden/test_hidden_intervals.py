import copy
import unittest

from intervals import merge


class HiddenMergeTest(unittest.TestCase):
    def test_issue_examples(self):
        self.assertEqual(merge([[8, 10], [1, 3], [2, 6]]), [[1, 6], [8, 10]])
        self.assertEqual(merge([[1, 2], [2, 3]]), [[1, 3]])
        self.assertEqual(merge([]), [])

    def test_edges(self):
        self.assertEqual(merge([[1, 10], [2, 3]]), [[1, 10]])
        self.assertEqual(merge([[5, 7]]), [[5, 7]])
        self.assertEqual(merge([[3, 4], [1, 2], [2, 3]]), [[1, 4]])
        self.assertEqual(merge([[1, 3], [2, 6], [8, 10]]), [[1, 6], [8, 10]])

    def test_input_not_changed(self):
        data = [[1, 3], [2, 6], [8, 10], [0, 1]]
        before = copy.deepcopy(data)
        merge(data)
        self.assertEqual(data, before)


if __name__ == '__main__':
    unittest.main()
