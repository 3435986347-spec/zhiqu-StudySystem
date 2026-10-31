import unittest

from cache import Cache
from repo import UserRepo
from users import UserService


def make():
    repo = UserRepo()
    repo.insert({'id': 1, 'name': 'A', 'email': 'a@x.com'})
    repo.insert({'id': 2, 'name': 'B', 'email': 'b@x.com'})
    cache = Cache()
    return repo, cache, UserService(repo, cache)


class HiddenUserCacheTest(unittest.TestCase):
    def test_name_change_seen_by_get(self):
        repo, cache, svc = make()
        svc.get(1)
        svc.update(1, name='A2')
        self.assertEqual(svc.get(1)['name'], 'A2')

    def test_email_change_seen_by_both_lookups(self):
        repo, cache, svc = make()
        svc.get(1)
        self.assertEqual(svc.by_email('A@X.com')['id'], 1)
        svc.update(1, email='new@x.com')
        self.assertEqual(svc.get(1)['email'], 'new@x.com')
        self.assertIsNone(svc.by_email('a@x.com'), '按旧邮箱还能查到人')
        self.assertEqual(svc.by_email('NEW@x.com')['id'], 1)

    def test_name_change_seen_by_email_lookup(self):
        repo, cache, svc = make()
        svc.by_email('a@x.com')
        svc.update(1, name='A3')
        self.assertEqual(svc.by_email('a@x.com')['name'], 'A3')

    def test_other_users_stay_cached(self):
        repo, cache, svc = make()
        svc.get(2)
        svc.by_email('b@x.com')
        svc.update(1, name='A2')
        reads = repo.reads   # update 自己读不读库不管，只看改完以后用户 2 还在不在缓存里
        svc.get(2)
        svc.by_email('b@x.com')
        self.assertEqual(repo.reads, reads, '改用户 1，用户 2 的缓存被清掉了')


if __name__ == '__main__':
    unittest.main()
