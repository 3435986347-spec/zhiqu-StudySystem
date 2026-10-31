import unittest

import registry
from runner import run_all


class RunnerTest(unittest.TestCase):
    def setUp(self):
        registry.clear()

    def test_runs_all(self):
        @registry.register('a')
        def a(ctx):
            ctx['a'] = True

        self.assertEqual(run_all(), {'a': True})


if __name__ == '__main__':
    unittest.main()
