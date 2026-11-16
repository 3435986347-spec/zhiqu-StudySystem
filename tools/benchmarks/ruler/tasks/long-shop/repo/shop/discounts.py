"""Discount codes. Not wired into pricing yet (see the issue)."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Discount:
    code: str
    kind: str        # "percent" (value = whole percent) or "fixed" (value = cents)
    value: int


CODES = {
    "WELCOME10": Discount("WELCOME10", "percent", 10),
    "HALFOFF": Discount("HALFOFF", "percent", 50),
    "MEGA80": Discount("MEGA80", "percent", 80),
    "FIVEOFF": Discount("FIVEOFF", "fixed", 500),
    "BIGFIXED": Discount("BIGFIXED", "fixed", 100_000),
}
