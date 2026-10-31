import re
from datetime import date

from errors import ValidationError


def parse_date(text):
    """解析 'YYYY-MM-DD' 或 'YYYY/MM/DD'。格式不对、日期不存在都抛 ValidationError。"""
    match = re.fullmatch(r'(\d{4})([-/])(\d{1,2})\2(\d{1,2})', text)
    if not match:
        raise ValidationError(f'日期格式不对：{text}')
    try:
        return date(int(match.group(1)), int(match.group(3)), int(match.group(4)))
    except ValueError as e:
        raise ValidationError(f'没有这一天：{text}') from e
