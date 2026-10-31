import unittest

import registry
from errors import PluginError
from runner import run_all


class HiddenRunnerTest(unittest.TestCase):
    def setUp(self):
        registry.clear()

    def test_priority_small_first_then_registration_order(self):
        order = []
        for name, prio in [('late', 200), ('first', 1), ('mid_a', 50), ('default', 100), ('mid_b', 50)]:
            registry.register(name, priority=prio)(lambda ctx, n=name: order.append(n))
        run_all()
        self.assertEqual(order, ['first', 'mid_a', 'mid_b', 'default', 'late'])

    def test_plugin_error_is_collected_and_rest_still_run(self):
        @registry.register('bad1', priority=1)
        def bad1(ctx):
            raise PluginError('坏了一')

        @registry.register('good', priority=2)
        def good(ctx):
            ctx['good'] = True

        @registry.register('bad2', priority=3)
        def bad2(ctx):
            raise PluginError('坏了二')

        ctx = run_all()
        self.assertTrue(ctx['good'])
        self.assertEqual([str(e) for e in ctx['errors']], ['坏了一', '坏了二'])

    def test_other_exceptions_propagate(self):
        @registry.register('boom')
        def boom(ctx):
            raise KeyError('x')

        with self.assertRaises(KeyError):
            run_all()

    def test_context_passed_through(self):
        @registry.register('w', priority=1)
        def w(ctx):
            ctx['cfg'] = 1

        @registry.register('r', priority=2)
        def r(ctx):
            ctx['seen'] = ctx['cfg']

        ctx = run_all({'x': 0})
        self.assertEqual(ctx.pop('errors', []), [], '没出错时 errors 要么没有、要么是空的（README 没定是哪种）')
        self.assertEqual(ctx, {'x': 0, 'cfg': 1, 'seen': 1})


if __name__ == '__main__':
    unittest.main()
