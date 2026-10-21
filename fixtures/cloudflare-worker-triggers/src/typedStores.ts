// Store types reached through an intersection, an optional, and aliases
// of each.

type Sessions = KVNamespace & { readonly region: string };
type MaybeArchive = R2Bucket | undefined;

interface Env {
  JOINED: KVNamespace & { readonly region: string };
  OPTIONAL: KVNamespace | undefined;
  ALIASED_JOIN: Sessions;
  ALIASED_OPTIONAL: MaybeArchive;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    void request;
    await env.JOINED.get("a");
    await env.OPTIONAL?.get("b");
    await env.ALIASED_JOIN.get("c");
    await env.ALIASED_OPTIONAL?.get("d");
    return new Response("ok");
  },
};
