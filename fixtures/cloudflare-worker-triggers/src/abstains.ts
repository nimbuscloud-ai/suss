// Calls the pack does not record: methods outside its tables, a
// statement it cannot parse, a prepare with no statement, and a store
// reached through an object other than the trigger's env.

interface Env {
  SESSIONS: KVNamespace;
  LEDGER: D1Database;
}

declare const elsewhere: Env;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    void request;
    await env.SESSIONS.getMany(["a", "b"]);
    await env.LEDGER.batch([]);
    await env.LEDGER.prepare("NOT A STATEMENT ;;;");
    await env.LEDGER.prepare();
    await elsewhere.SESSIONS.get("k");
    return new Response("ok");
  },
};
