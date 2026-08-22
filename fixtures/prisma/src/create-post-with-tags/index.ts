// Two relation writes whose payloads an array callback builds. The
// `tags` callback is written out at the call, so the recognizer reads
// the column it sets; `labels` goes through a name it cannot follow.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const toLabelRow = (label: string) => ({
  create: { name: label },
  where: { name: label },
});

export async function handler(event: {
  title: string;
  authorId: number;
  tags: string[];
  labels: string[];
}): Promise<unknown> {
  return await db.post.create({
    data: {
      title: event.title,
      authorId: event.authorId,
      tags: {
        connectOrCreate: event.tags.map((tag: string) => ({
          create: { name: tag },
          where: { name: tag },
        })),
      },
      labels: {
        connectOrCreate: event.labels.map(toLabelRow),
      },
    },
    include: {
      tags: { select: { name: true } },
    },
  });
}
