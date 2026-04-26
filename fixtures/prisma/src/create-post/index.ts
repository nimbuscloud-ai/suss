// Writes to Post table — exercises the storage-access recognizer
// for write operations. Includes a deliberate typo ("bdoy") that
// the checker should flag as storageWriteFieldUnknown.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

export async function handler(event: {
  title: string;
  authorId: number;
  body: string;
}): Promise<unknown> {
  return await db.post.create({
    // biome-ignore lint/suspicious/noExplicitAny: deliberate typo
    // for the integration test.
    data: {
      title: event.title,
      authorId: event.authorId,
      bdoy: event.body as any,
    } as any,
  });
}
