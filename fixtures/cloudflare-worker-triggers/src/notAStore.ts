// A binding with a `get` method that is not a Cloudflare store.

interface Env {
  CLIENT: { get(key: string): string };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    void request;
    return new Response(env.CLIENT.get("greeting"));
  },
};
