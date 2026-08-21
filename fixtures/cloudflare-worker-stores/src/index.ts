// A Worker that touches every store wrangler.toml binds, one it
// forgot to declare (AUDIT_KV has no binding block), and a DynamoDB
// table that only the manifest's [vars] value gives a name to.

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

declare const dynamo: DynamoDBClient;

interface Env {
  SESSIONS: KVNamespace;
  ARCHIVE: R2Bucket;
  LEDGER: D1Database;
  AUDIT_KV: KVNamespace;
  GREETING: string;
  SUBSCRIBERS_TABLE: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const current = await env.SESSIONS.get("session:current");
    await env.SESSIONS.put("session:current", "started");

    const report = await env.ARCHIVE.get("reports/latest.csv");

    const rows = await env.LEDGER.prepare(
      "SELECT total FROM entries WHERE day = ?",
    )
      .bind("today")
      .all();

    await env.AUDIT_KV.put("audit:latest", "seen");

    await dynamo.send(
      new PutItemCommand({
        TableName: env.SUBSCRIBERS_TABLE,
        Item: { email: { S: "reader@example.com" } },
      }),
    );

    return Response.json({
      greeting: env.GREETING,
      current,
      hasReport: report !== null,
      rows,
    });
  },
};
