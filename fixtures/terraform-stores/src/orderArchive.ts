// Writes finished orders into the archive bucket main.tf declares.

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({});

export async function archiveOrder(id: string, body: string) {
  await client.send(
    new PutObjectCommand({
      Bucket: "acme-archive",
      Key: `orders/${id}.json`,
      Body: body,
    }),
  );
}
