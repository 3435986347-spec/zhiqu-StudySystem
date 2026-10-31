from datetime import date

from errors import ValidationError


def parse_date(text):
    """解析 'YYYY-MM-DD'。格式不对抛 ValidationError。"""
    parts = text.split('-')
    if len(parts) != 3:
        raise ValidationError(f'日期格式不对：{text}')
    year, month, day = (int(p) for p in parts)
    return date(year, month, day)
