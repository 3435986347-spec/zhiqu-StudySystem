"""Shipping cost by total weight, with a free-shipping threshold."""

FREE_SHIPPING_FROM = 5_000          # cents of goods; at or above this, shipping is free
BANDS = [                            # (up to grams, cost in cents)
    (500, 499),
    (1_000, 699),
    (2_500, 999),
    (5_000, 1_499),
    (10_000, 2_199),
]
PER_EXTRA_KG = 250                   # above the last band, per started kilogram


def cost(weight_grams, goods_cents):
    """Shipping for a parcel. `goods_cents` is what the free-shipping rule looks at."""
    if weight_grams <= 0:
        return 0
    if goods_cents >= FREE_SHIPPING_FROM:
        return 0
    for limit, price in BANDS:
        if weight_grams <= limit:
            return price
    extra = weight_grams - BANDS[-1][0]
    started_kg = -(-extra // 1_000)
    return BANDS[-1][1] + started_kg * PER_EXTRA_KG
