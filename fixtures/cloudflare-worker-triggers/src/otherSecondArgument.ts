// A helper whose second parameter is not the env, called from a trigger.
// Its `item.publicationId` read is not a config read.

interface Env {
  UPSTREAM: string;
}

function label(prefix: string, item: { publicationId: string }) {
  return prefix + item.publicationId;
}

export default {
  async fetch(request: Request, env: Env) {
    void request;
    return new Response(label(env.UPSTREAM, { publicationId: "p" }));
  },
};
