// The pool both modules query through. It belongs to no module.

import { Pool } from "pg";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
