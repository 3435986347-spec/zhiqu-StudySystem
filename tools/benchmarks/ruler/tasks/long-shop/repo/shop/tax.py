"""Sales tax. Rates are basis points (1/100 of a percent): 725 means 7.25%."""
from dataclasses import dataclass

from .errors import UnknownRegion


@dataclass(frozen=True)
class Region:
    code: str
    rate_bp: int
    exempt_categories: frozenset


REGIONS = {
    "AL": Region("AL", 650, frozenset(['sports', 'tools'])),
    "AK": Region("AK", 625, frozenset()),
    "AZ": Region("AZ", 825, frozenset()),
    "AR": Region("AR", 0, frozenset(['books', 'kitchen'])),
    "CA": Region("CA", 800, frozenset(['audio', 'sports'])),
    "CO": Region("CO", 725, frozenset(['garden', 'office'])),
    "CT": Region("CT", 250, frozenset()),
    "DE": Region("DE", 800, frozenset(['garden', 'sports'])),
    "FL": Region("FL", 500, frozenset()),
    "GA": Region("GA", 600, frozenset()),
    "HI": Region("HI", 650, frozenset()),
    "ID": Region("ID", 825, frozenset(['toys'])),
    "IL": Region("IL", 500, frozenset()),
    "IN": Region("IN", 400, frozenset(['office', 'sports'])),
    "IA": Region("IA", 250, frozenset()),
    "KS": Region("KS", 250, frozenset(['garden', 'toys'])),
    "KY": Region("KY", 500, frozenset()),
    "LA": Region("LA", 700, frozenset()),
    "ME": Region("ME", 500, frozenset()),
    "MD": Region("MD", 0, frozenset(['sports'])),
    "MA": Region("MA", 575, frozenset(['garden'])),
    "MI": Region("MI", 600, frozenset(['books', 'kitchen'])),
    "MN": Region("MN", 800, frozenset()),
    "MS": Region("MS", 0, frozenset()),
    "MO": Region("MO", 800, frozenset(['audio', 'kitchen'])),
    "MT": Region("MT", 825, frozenset()),
    "NE": Region("NE", 650, frozenset()),
    "NV": Region("NV", 825, frozenset()),
    "NH": Region("NH", 725, frozenset(['toys'])),
    "NJ": Region("NJ", 500, frozenset()),
    "NM": Region("NM", 650, frozenset(['garden', 'toys'])),
    "NY": Region("NY", 600, frozenset()),
    "NC": Region("NC", 600, frozenset(['office'])),
    "ND": Region("ND", 725, frozenset()),
    "OH": Region("OH", 575, frozenset(['office', 'sports'])),
    "OK": Region("OK", 250, frozenset(['garden', 'toys'])),
    "OR": Region("OR", 700, frozenset()),
    "PA": Region("PA", 250, frozenset(['books', 'kitchen'])),
    "RI": Region("RI", 500, frozenset()),
    "SC": Region("SC", 650, frozenset()),
    "SD": Region("SD", 250, frozenset()),
    "TN": Region("TN", 400, frozenset(['office'])),
    "TX": Region("TX", 500, frozenset(['sports'])),
    "UT": Region("UT", 650, frozenset(['garden', 'tools'])),
    "VT": Region("VT", 700, frozenset(['garden', 'tools'])),
    "VA": Region("VA", 625, frozenset()),
    "WA": Region("WA", 600, frozenset(['books'])),
    "WV": Region("WV", 700, frozenset()),
    "WI": Region("WI", 0, frozenset(['books'])),
    "WY": Region("WY", 725, frozenset()),
}


def region(code):
    key = str(code).strip().upper()
    try:
        return REGIONS[key]
    except KeyError:
        raise UnknownRegion(code) from None


def round_half_up(numerator, denominator):
    """Integer division rounding halves away from zero (money never uses banker's rounding here)."""
    if denominator <= 0:
        raise ValueError("denominator must be positive")
    sign = -1 if numerator < 0 else 1
    q, r = divmod(abs(numerator), denominator)
    if r * 2 >= denominator:
        q += 1
    return sign * q


def tax_for(amount, category, region_code):
    """Tax on `amount` cents of goods in `category` shipped to `region_code`."""
    r = region(region_code)
    if category in r.exempt_categories:
        return 0
    return round_half_up(amount * r.rate_bp, 10_000)
