def deep_merge(base, override):
    """把 override 合并进 base，返回合并后的配置。"""
    result = base
    result.update(override)
    return result
