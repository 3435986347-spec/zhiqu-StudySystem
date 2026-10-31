import unittest

from repo import UserRepo
from users import UserService


class UserServiceTest(unittest.TestCase):
    def test_get_is_cached(self):
        repo = UserRepo()
        repo.insert({'id': 1, 'name': 'A', 'email': 'a@x.com'})
        svc = UserService(repo)
        svc.get(1)
        svc.get(1)
        self.assertEqual(repo.reads, 1)


if __name__ == '__main__':
    unittest.main()
