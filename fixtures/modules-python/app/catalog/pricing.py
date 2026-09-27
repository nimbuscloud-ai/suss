from sqlalchemy import text


def price_for(pool, sku):
    pool.execute(
        text("UPDATE accounts SET last_priced_at = now() WHERE sku = :sku"),
        {"sku": sku},
    )
    return 10
