tags.py 的 normalize_tags 要再做两件事：大小写不同的算同一个标签（统一成小写），重复的只留一个。
现在 `['Python', 'python ', 'WEB']` 整理出来是 `['Python', 'python', 'WEB']`，应该是两个标签：python 和 web。
