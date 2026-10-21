// An env typed by a class instead of an interface.

class EnvBag {
  SESSIONS: KVNamespace = undefined as unknown as KVNamespace;
}

export default {
  async fetch(request: Request, env: EnvBag): Promise<Response> {
    void request;
    await env.SESSIONS.get("k");
    return new Response("ok");
  },
};
