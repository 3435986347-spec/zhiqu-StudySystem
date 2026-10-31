import re

_PATTERN = re.compile(r'(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?')


def parse_duration(text):
    """把 '2h'、'30m'、'1h30m' 这样的写法换成秒数。"""
    cleaned = text.strip().lower()
    match = _PATTERN.fullmatch(cleaned)
    if not cleaned or not match or not any(match.groups()):
        raise ValueError(f'看不懂的时长：{text!r}')
    hours, minutes, seconds = (int(g) if g else 0 for g in match.groups())
    return hours * 3600 + minutes * 60 + seconds
