// KV, R2 and D1 calls on env bindings. The store types are not
// installed, so the pack goes by the type written on each binding.

interface Env {
  SESSIONS: KVNamespace;
  ARCHIVE: R2Bucket;
  LEDGER: D1Database;
  GREETING: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    void request;
    const current = await env.SESSIONS.get("session:current");
    await env.SESSIONS.put("session:current", "started");
    const listed = await env.SESSIONS.list();
    const report = await env.ARCHIVE.get("reports/latest.csv");
    await env.ARCHIVE.head("reports/previous.csv");
    const rows = await env.LEDGER.prepare(
      "SELECT total FROM entries WHERE day = ?",
    )
      .bind("today")
      .all();
    await env.LEDGER.prepare("INSERT INTO entries (day) VALUES (?)");
    await env.LEDGER.exec("DELETE FROM entries WHERE day < date('now', '-30 days')");
    return Response.json({ current, listed, report, rows, hi: env.GREETING });
  },
};
