// Deletes an author's posts. The where clause picks rows by
// Post.authorId, so that column is read even though no query selects it.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

export async function handler(event: { authorId: number }): Promise<unknown> {
  return await db.post.deleteMany({
    where: { authorId: event.authorId },
  });
}
