import copy
import unittest

from config import deep_merge


class HiddenDeepMergeTest(unittest.TestCase):
    def test_issue_example(self):
        self.assertEqual(deep_merge({'db': {'host': 'a', 'port': 1}}, {'db': {'port': 2}}),
                         {'db': {'host': 'a', 'port': 2}})

    def test_nested_and_lists(self):
        base = {'a': {'b': {'c': 1, 'd': 2}}, 'tags': [1, 2], 'x': {'y': 1}}
        over = {'a': {'b': {'d': 3, 'e': 4}}, 'tags': [3], 'x': 5, 'new': {'k': 'v'}}
        self.assertEqual(deep_merge(base, over),
                         {'a': {'b': {'c': 1, 'd': 3, 'e': 4}}, 'tags': [3], 'x': 5, 'new': {'k': 'v'}})

    def test_none_deletes(self):
        self.assertEqual(deep_merge({'a': 1, 'b': 2}, {'a': None}), {'b': 2})
        self.assertEqual(deep_merge({'db': {'host': 'a', 'port': 1}}, {'db': {'port': None}}), {'db': {'host': 'a'}})
        self.assertEqual(deep_merge({'a': 1}, {'missing': None}), {'a': 1})

    def test_inputs_not_changed(self):
        base = {'db': {'host': 'a', 'port': 1}, 'keep': [1]}
        over = {'db': {'port': 2, 'extra': {'z': 1}}, 'keep': None}
        b0, o0 = copy.deepcopy(base), copy.deepcopy(over)
        result = deep_merge(base, over)
        self.assertEqual(base, b0)
        self.assertEqual(over, o0)
        result['db']['extra']['z'] = 99
        self.assertEqual(over, o0, '结果里的嵌套 dict 不能和 override 共用')


if __name__ == '__main__':
    unittest.main()
