import re
import unicodedata


def slugify(text):
    """把标题变成网址里用的短名。"""
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii')
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')
