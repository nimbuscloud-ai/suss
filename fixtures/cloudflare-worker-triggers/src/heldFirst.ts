// The binding is put in a local before the call.

interface Env {
  SESSIONS: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    void request;
    const sessions = env.SESSIONS;
    await sessions.delete("session:stale");
    return new Response("ok");
  },
};
