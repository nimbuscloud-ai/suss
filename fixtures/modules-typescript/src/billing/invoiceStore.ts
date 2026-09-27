import { pool } from "../db.js";

export async function saveInvoice(invoiceId: string): Promise<void> {
  await pool.query(
    "INSERT INTO invoices (id, status) VALUES ($1, 'charged')",
    [invoiceId],
  );
}
