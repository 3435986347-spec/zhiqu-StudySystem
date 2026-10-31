def slugify(text):
    """把标题变成网址里用的短名。"""
    return text.lower().replace(' ', '-')
