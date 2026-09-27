from sqlalchemy import text

from .invoice_store import save_invoice


class CardDeclined(Exception):
    pass


def charge_invoice(pool, invoice_id):
    result = pool.execute(
        text("UPDATE accounts SET balance = balance - 1 WHERE invoice_id = :id"),
        {"id": invoice_id},
    )
    if result.rowcount == 0:
        raise CardDeclined(invoice_id)
    save_invoice(pool, invoice_id)
    return "charged"
