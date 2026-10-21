// With the store types declared, the checker resolves each binding's
// type, through an interface that extends one as well.

type Sessions = KVNamespace & { readonly region: string };
type MaybeArchive = R2Bucket | undefined;

interface TaggedSessions extends KVNamespace {
  readonly tag: string;
}

interface Env {
  PLAIN: KVNamespace;
  EXTENDED: TaggedSessions;
  JOINED: KVNamespace & { readonly region: string };
  ALIASED_JOIN: Sessions;
  ALIASED_OPTIONAL: MaybeArchive;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    void request;
    await env.PLAIN.get("a");
    await env.EXTENDED.get("e");
    await env.JOINED.get("b");
    await env.ALIASED_JOIN.get("c");
    await env.ALIASED_OPTIONAL?.get("d");
    return new Response("ok");
  },
};
