def normalize_tags(tags):
    """把用户填的标签整理一下。"""
    return [t.strip() for t in tags if t.strip()]
