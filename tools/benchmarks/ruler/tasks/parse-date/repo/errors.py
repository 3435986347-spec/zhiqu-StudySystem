class ValidationError(Exception):
    """用户填的东西不合法。前端只认这一种错误，按它给用户提示。"""
