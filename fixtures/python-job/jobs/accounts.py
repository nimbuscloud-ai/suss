# The work the job does, every statement written as SQL by the project.

from sqlalchemy import text


def sync_accounts(pool, batch_size):
    rows = pool.execute(
        text("SELECT id, status FROM dim_account ORDER BY id LIMIT :limit"),
        {"limit": batch_size},
    )
    return list(rows)


def archive_accounts(pool):
    return pool.execute(
        text("UPDATE dim_account SET status = 'archived' WHERE status = 'stale'")
    )


def count_orders(pool):
    return pool.execute(text("SELECT count(*) FROM orders")).scalar()
