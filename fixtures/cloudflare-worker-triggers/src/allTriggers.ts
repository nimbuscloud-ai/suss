// Every trigger the platform calls on a default export, with env reads
// in their bodies.

interface Env {
  GREETING_TABLE: string;
  TIMEOUT_MS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    const table = env.GREETING_TABLE;
    const wait = env.TIMEOUT_MS ?? "500";
    return Response.json({ table, wait }, { status: 201 });
  },
  async scheduled(controller: ScheduledController, env: Env) {
    void controller;
    void env.GREETING_TABLE;
  },
  async queue(batch: MessageBatch, env: Env) {
    void batch;
    void env;
  },
  async tail(events: unknown[]) {
    void events;
  },
};
