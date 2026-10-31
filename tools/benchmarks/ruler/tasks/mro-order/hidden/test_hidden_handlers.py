import unittest

from handlers import collect_handlers


class A:
    handlers = ['a']


class B:
    handlers = ['b']


class C(A, B):
    handlers = ['c']


class Shared1:
    handlers = ['log', 'x']


class Shared2:
    handlers = ['log', 'y']


class D(Shared1, Shared2):
    pass


class Base:
    handlers = ['log']


class Child(Base):
    handlers = ['auth']


class GrandChild(Child):
    handlers = ['cache']


class HiddenCollectTest(unittest.TestCase):
    def test_multiple_bases_parents_first(self):
        # 和单继承一样：父类的在前、自己的在后（test_handlers 里 Base 的 'log' 在 Child 的 'auth' 前面）。
        # 两个父类之间谁先谁后，现有代码和问题里都没定，这里不查
        got = collect_handlers(C)
        self.assertEqual(sorted(got[:2]), ['a', 'b'])
        self.assertEqual(got[2:], ['c'])

    def test_dedupe(self):
        got = collect_handlers(D)
        self.assertEqual(sorted(got), ['log', 'x', 'y'])

    def test_single_chain_unchanged(self):
        self.assertEqual(collect_handlers(Child), ['log', 'auth'])
        self.assertEqual(collect_handlers(GrandChild), ['log', 'auth', 'cache'])


if __name__ == '__main__':
    unittest.main()
