// The generator wrote the client into the project, so the only way to
// reach it is a relative path and no file imports "@prisma/client".

import { PrismaClient } from "../generated/client/index.js";

export const db = new PrismaClient();
