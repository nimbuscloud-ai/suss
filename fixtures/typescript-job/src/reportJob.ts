// The same job written around a `main`, called through `.catch`. Both
// `main` and the failure handler it is passed are private to the file.

import { pool } from "./db.js";

async function main(): Promise<void> {
  await pool.query("SELECT day, total FROM report_totals ORDER BY day");
}

function reportFailure(error: unknown): void {
  console.error(error);
  process.exit(1);
}

main().catch(reportFailure);
