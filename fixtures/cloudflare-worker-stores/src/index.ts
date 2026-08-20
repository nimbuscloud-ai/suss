// A Worker that touches every store wrangler.toml binds, plus one it
// forgot to declare: AUDIT_KV has no binding block, so `env.AUDIT_KV`
// is undefined the moment this deploys.

interface Env {
  SESSIONS: KVNamespace;
  ARCHIVE: R2Bucket;
  LEDGER: D1Database;
  AUDIT_KV: KVNamespace;
  GREETING: string;
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

    return Response.json({
      greeting: env.GREETING,
      current,
      hasReport: report !== null,
      rows,
    });
  },
};
