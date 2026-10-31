def merge(intervals):
    """合并重叠的区间。intervals 是 [start, end] 的列表。"""
    out = []
    for iv in intervals:
        if out and iv[0] < out[-1][1]:
            out[-1][1] = max(out[-1][1], iv[1])
        else:
            out.append(iv)
    return out
