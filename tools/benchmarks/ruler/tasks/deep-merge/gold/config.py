import copy


def deep_merge(base, override):
    """把 override 合并进 base，返回合并后的配置（两个参数都不改）。"""
    result = copy.deepcopy(base)
    for key, value in override.items():
        if value is None:
            result.pop(key, None)
        elif isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result
