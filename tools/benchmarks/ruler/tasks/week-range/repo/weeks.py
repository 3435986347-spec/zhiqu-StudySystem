from datetime import date, timedelta


def week_range(day):
    """返回 day 所在那一周的 (周一, 周日)。"""
    start = day - timedelta(days=day.isoweekday())
    return start, start + timedelta(days=6)
