def parse_duration(text):
    """把 '2h'、'30m' 这样的写法换成秒数。"""
    unit = text[-1]
    value = int(text[:-1])
    return value * {'h': 3600, 'm': 60}[unit]
