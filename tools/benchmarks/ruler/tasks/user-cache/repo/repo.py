class UserRepo:
    """假数据库：按 id 存用户 dict。"""

    def __init__(self):
        self._rows = {}
        self.reads = 0

    def insert(self, user):
        self._rows[user['id']] = dict(user)

    def get(self, user_id):
        self.reads += 1
        row = self._rows.get(user_id)
        return dict(row) if row else None

    def find_by_email(self, email):
        self.reads += 1
        for row in self._rows.values():
            if row['email'].lower() == email.lower():
                return dict(row)
        return None

    def update(self, user_id, **fields):
        self._rows[user_id].update(fields)
