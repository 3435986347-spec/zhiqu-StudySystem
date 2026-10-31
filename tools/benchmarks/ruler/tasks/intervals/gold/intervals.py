def merge(intervals):
    """合并重叠的区间。intervals 是 [start, end] 的列表。"""
    out = []
    for start, end in sorted(intervals):
        if out and start <= out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return out
