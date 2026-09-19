// The one place the client is built. Every handler imports `db` from
// here, so no handler file imports "@prisma/client" itself.

import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient();
