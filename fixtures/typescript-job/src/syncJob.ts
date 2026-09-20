// A job with no handler. Everything it does runs while the module
// loads, and none of these functions is exported, so module scope is
// the only thing that reaches them.

import { pool } from "./db.js";
import { startLogger } from "./logging.js";

const logger = startLogger();

async function syncAccounts(): Promise<number> {
  const result = await pool.query("SELECT id, name FROM dim_account");
  return result.rowCount;
}

async function pruneAccounts(): Promise<void> {
  await pool.query("DELETE FROM dim_account WHERE retired_at IS NOT NULL");
}

function describeRun(count: number): string {
  return `synced ${count} accounts`;
}

const synced = await syncAccounts();
logger.info(describeRun(synced));

if (process.env.PRUNE_ACCOUNTS === "1") {
  await pruneAccounts();
}
