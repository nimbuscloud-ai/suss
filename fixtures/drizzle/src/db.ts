// The database, made once with a schema spread from two modules.

import { drizzle } from "drizzle-orm";

import * as accounts from "./accounts.js";
import * as core from "./schema.js";

export const db = drizzle({}, { schema: { ...core, ...accounts } });
