"""Order pricing: line items -> subtotal, tax, shipping, total."""
from dataclasses import dataclass, field

from . import catalog, shipping, tax
from .discounts import CODES
from .errors import InvalidQuantity, UnknownDiscount
from .tax import round_half_up


@dataclass
class Line:
    sku: str
    quantity: int


@dataclass
class Order:
    lines: list
    region: str
    discount_code: str = None


@dataclass(frozen=True)
class Totals:
    subtotal: int
    tax: int
    shipping: int
    total: int
    lines: tuple = field(default=())
    discount: int = 0
    discount_code: str = None


def _check(line):
    if not isinstance(line.quantity, int) or isinstance(line.quantity, bool) or line.quantity <= 0:
        raise InvalidQuantity(line.sku, line.quantity)


def line_amount(line):
    _check(line)
    return catalog.get(line.sku).price * line.quantity


def merge_lines(lines):
    """Same SKU on several lines -> one line, in first-seen order."""
    merged = {}
    for line in lines:
        _check(line)
        key = catalog.get(line.sku).sku
        merged[key] = merged.get(key, 0) + line.quantity
    return [Line(sku, qty) for sku, qty in merged.items()]


MAX_PERCENT = 50


def discount_for(code, subtotal):
    """(normalized code, discount cents) for `code` on `subtotal`. No code -> (None, 0)."""
    if code is None or not str(code).strip():
        return None, 0
    key = str(code).strip().upper()
    d = CODES.get(key)
    if d is None:
        raise UnknownDiscount(code)
    if d.kind == "percent":
        amount = round_half_up(subtotal * min(d.value, MAX_PERCENT), 100)
    else:
        amount = d.value
    return key, min(amount, subtotal)


def compute_total(order):
    lines = merge_lines(order.lines)
    amounts = [(catalog.get(l.sku), l.quantity, line_amount(l)) for l in lines]
    subtotal = sum(a for _, _, a in amounts)
    code, discount = discount_for(order.discount_code, subtotal)
    # spread the discount over lines in proportion to their amount (largest remainder), so each
    # category is taxed on what the customer actually pays for it
    shares = [0] * len(amounts)
    if discount and subtotal:
        raw = [(a * discount) for _, _, a in amounts]
        shares = [r // subtotal for r in raw]
        left = discount - sum(shares)
        order_ = sorted(range(len(amounts)), key=lambda i: (-(raw[i] % subtotal), i))
        for i in order_[:left]:
            shares[i] += 1
    tax_cents = sum(tax.tax_for(a - s, p.category, order.region) for (p, _, a), s in zip(amounts, shares))
    weight = sum(p.weight * q for p, q, _ in amounts)
    ship = shipping.cost(weight, subtotal)
    return Totals(subtotal, tax_cents, ship, subtotal - discount + tax_cents + ship,
                  tuple((p.sku, q, a) for p, q, a in amounts), discount, code)
