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
        self.repo.update(user_id, **fields)
