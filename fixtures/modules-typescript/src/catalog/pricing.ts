import { pool } from "../db.js";

export async function priceFor(sku: string): Promise<number> {
  await pool.query("UPDATE accounts SET last_priced_at = now() WHERE sku = $1", [
    sku,
  ]);
  return 10;
}
