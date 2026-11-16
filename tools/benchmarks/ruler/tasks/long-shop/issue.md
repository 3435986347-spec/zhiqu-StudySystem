Discount codes don't do anything yet.

`shop/discounts.py` has a `CODES` table, and `Order` already has a `discount_code` field, but `compute_total` ignores it and receipts never show a discount. Please wire it in:

1. `compute_total(order)` applies `order.discount_code` (case-insensitive, surrounding spaces ignored; `None` or blank means no code). An unknown code raises `UnknownDiscount` from `shop/errors.py`.
2. Percent codes take that percent off the subtotal, **capped at 50%** (`MEGA80` gives 50%, not 80%). Round to the cent half-up, like tax does (`tax.round_half_up`).
3. Fixed codes take that many cents off, but never more than the subtotal (the discounted subtotal can't go below zero).
4. Tax is charged on what the customer actually pays: spread the discount over the lines in proportion to their amount, then tax each line's discounted amount by its category (exempt categories stay untaxed). The spread must add up exactly to the discount.
5. Free shipping still looks at the subtotal **before** the discount.
6. `Totals` gets two new fields, `discount` (cents, default 0) and `discount_code` (the normalized upper-case code, default `None`); `total` = subtotal − discount + tax + shipping. Existing callers that build `Totals` positionally must keep working.
7. `report.receipt` shows a line `Discount (CODE)` with the negative amount right after `Subtotal`, only when there is a discount.

Keep the existing tests passing.
