// A key-value store on the settings table. Callers pick the row by key,
// some with a key per user and some with one key for the whole site.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function lookup(key: string) {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function enabled(key: string) {
  return (await lookup(key)) === "on";
}
