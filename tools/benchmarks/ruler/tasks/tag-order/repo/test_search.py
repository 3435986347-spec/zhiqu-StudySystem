import unittest

from search import describe


class DescribeTest(unittest.TestCase):
    def test_main_tag_first(self):
        self.assertEqual(describe(['python', 'web']), '**python** · web')


if __name__ == '__main__':
    unittest.main()
