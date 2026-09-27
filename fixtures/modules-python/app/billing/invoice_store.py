from sqlalchemy import text


def save_invoice(pool, invoice_id):
    pool.execute(
        text("INSERT INTO invoices (id, status) VALUES (:id, 'charged')"),
        {"id": invoice_id},
    )
