from tags import normalize_tags


def describe(tags):
    """搜索结果页顶上那一行：第一个标签是主标签，加粗显示，其余的跟在后面。"""
    clean = normalize_tags(tags)
    if not clean:
        return '（没有标签）'
    head, *rest = clean
    return f'**{head}**' + ''.join(f' · {t}' for t in rest)
