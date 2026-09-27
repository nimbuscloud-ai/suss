import { pool } from "../db.js";
import { saveInvoice } from "./invoiceStore.js";

export class CardDeclined extends Error {}

export async function chargeInvoice(invoiceId: string): Promise<string> {
  const account = await pool.query(
    "UPDATE accounts SET balance = balance - 1 WHERE invoice_id = $1",
    [invoiceId],
  );
  if (account.rowCount === 0) {
    throw new CardDeclined(invoiceId);
  }
  await saveInvoice(invoiceId);
  return "charged";
}
