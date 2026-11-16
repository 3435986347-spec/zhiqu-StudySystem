"""Order pricing: line items -> subtotal, tax, shipping, total."""
from dataclasses import dataclass, field

from . import catalog, shipping, tax
from .errors import InvalidQuantity
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


def compute_total(order):
    lines = merge_lines(order.lines)
    amounts = [(catalog.get(l.sku), l.quantity, line_amount(l)) for l in lines]
    subtotal = sum(a for _, _, a in amounts)
    tax_cents = sum(tax.tax_for(a, p.category, order.region) for p, _, a in amounts)
    weight = sum(p.weight * q for p, q, _ in amounts)
    ship = shipping.cost(weight, subtotal)
    return Totals(subtotal, tax_cents, ship, subtotal + tax_cents + ship,
                  tuple((p.sku, q, a) for p, q, a in amounts))
