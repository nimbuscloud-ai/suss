// A job written as a function the module invokes on the spot. The
// statements inside run while the module loads, so they are the
// module's own behavior rather than a unit somebody else calls.

import { pool } from "./db.js";

void (async () => {
  await pool.query(
    "INSERT INTO dim_account (id, name) SELECT id, name FROM staging_account",
  );
})();
