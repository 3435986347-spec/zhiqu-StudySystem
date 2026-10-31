def normalize_tags(tags):
    """把用户填的标签整理一下：去掉首尾空白和空的，统一小写，重复的只留第一次出现的（顺序不变：search.describe 拿第一个当主标签）。"""
    out = []
    for t in tags:
        t = t.strip().lower()
        if t and t not in out:
            out.append(t)
    return out
