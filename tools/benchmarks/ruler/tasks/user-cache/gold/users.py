from cache import Cache


class UserService:
    def __init__(self, repo, cache=None):
        self.repo = repo
        self.cache = cache or Cache()

    def get(self, user_id):
        k = Cache.key('user', user_id)
        hit = self.cache.get(k)
        if hit is None:
            hit = self.repo.get(user_id)
            self.cache.set(k, hit)
        return hit

    def by_email(self, email):
        k = Cache.key('email', email)
        hit = self.cache.get(k)
        if hit is None:
            hit = self.repo.find_by_email(email)
            self.cache.set(k, hit)
        return hit

    def update(self, user_id, **fields):
        old = self.repo.get(user_id)
        self.repo.update(user_id, **fields)
        new = self.repo.get(user_id)
        # 这个用户的几份缓存都清掉：按 id 的、按旧邮箱的、按新邮箱的（新邮箱以前可能缓存过「查无此人」）；别的用户不动
        self.cache.delete(Cache.key('user', user_id))
        for row in (old, new):
            if row:
                self.cache.delete(Cache.key('email', row['email']))
