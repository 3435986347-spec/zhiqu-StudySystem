"""Plain-text receipts."""
from . import catalog
from .pricing import compute_total

WIDTH = 40


def money(cents):
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100:,}.{cents % 100:02d}"


def row(label, amount):
    text = money(amount)
    return f"{label}{' ' * max(1, WIDTH - len(label) - len(text))}{text}"


def receipt(order):
    t = compute_total(order)
    out = []
    for sku, qty, amount in t.lines:
        out.append(row(f"{qty} x {catalog.get(sku).name}", amount))
    out.append("-" * WIDTH)
    out.append(row("Subtotal", t.subtotal))
    if t.discount:
        out.append(row(f"Discount ({t.discount_code})", -t.discount))
    out.append(row("Tax", t.tax))
    out.append(row("Shipping", t.shipping) if t.shipping else row("Shipping (free)", 0))
    out.append("=" * WIDTH)
    out.append(row("Total", t.total))
    return "\n".join(out)
