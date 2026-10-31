import unittest

from search import describe
from tags import normalize_tags


class HiddenTagsTest(unittest.TestCase):
    def test_issue_example(self):
        self.assertEqual(sorted(normalize_tags(['Python', 'python ', 'WEB'])), ['python', 'web'])

    def test_order_of_first_appearance_kept(self):
        # search.describe 拿第一个当主标签：去重不能把顺序打乱
        self.assertEqual(normalize_tags(['Web', 'python', 'web', 'API', 'Python']), ['web', 'python', 'api'])
        self.assertEqual(describe(['Zeta', 'alpha', 'zeta']), '**zeta** · alpha')
        self.assertEqual(describe(['  ', '']), '（没有标签）')


if __name__ == '__main__':
    unittest.main()
