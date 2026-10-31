def collect_handlers(cls):
    """收集一个类和它的父类上声明的 handlers（类属性 `handlers`，一个列表）。"""
    own = list(cls.__dict__.get('handlers', []))
    base = cls.__bases__[0] if cls.__bases__ and cls.__bases__[0] is not object else None
    inherited = collect_handlers(base) if base else []
    return inherited + own
