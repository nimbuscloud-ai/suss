// A statement the pack cannot read, and one a local function returns.

interface Env {
  LEDGER: D1Database;
}

declare function buildQuery(): string;

function ledgerQuery(): string {
  return "SELECT * FROM ledger";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    void request;
    await env.LEDGER.prepare(buildQuery());
    await env.LEDGER.prepare(ledgerQuery());
    return new Response("ok");
  },
};
