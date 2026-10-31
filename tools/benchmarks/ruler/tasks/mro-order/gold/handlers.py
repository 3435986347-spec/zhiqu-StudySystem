def collect_handlers(cls):
    """收集一个类和它所有父类上声明的 handlers：按 MRO 从最远的父类到自己，父类的在前、自己的在后；重复的只留第一次出现的。"""
    out = []
    for klass in reversed(cls.__mro__):
        for handler in klass.__dict__.get('handlers', []):
            if handler not in out:
                out.append(handler)
    return out
