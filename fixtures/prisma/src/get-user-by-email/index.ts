// Reads from User table — exercises the storage-access recognizer.
// Includes a deliberate typo ("emial") that the checker should flag
// as storageReadFieldUnknown.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

export async function handler(event: { email: string }): Promise<unknown> {
  return await db.user.findUnique({
    where: { email: event.email },
    select: {
      id: true,
      email: true,
      name: true,
      // biome-ignore lint/suspicious/noExplicitAny: deliberate typo
      // for the integration test — Prisma's typed client would catch
      // this at compile time, but the recognizer extracts what's
      // written so the checker can flag the schema mismatch.
      emial: true as any,
    },
  });
}
