import unittest

from handlers import collect_handlers


class Base:
    handlers = ['log']


class Child(Base):
    handlers = ['auth']


class CollectTest(unittest.TestCase):
    def test_single_inheritance(self):
        self.assertEqual(collect_handlers(Child), ['log', 'auth'])


if __name__ == '__main__':
    unittest.main()
