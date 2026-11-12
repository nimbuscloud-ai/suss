// One trigger registered both ways in one file, on two functions. The
// platform calls whichever form the Worker is deployed as, so each
// registration is a unit.

interface Env {
  GREETING: string;
}

addEventListener("fetch", (event: FetchEvent) => {
  event.respondWith(new Response("from the listener", { status: 200 }));
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    void request;
    return new Response(env.GREETING, { status: 200 });
  },
};
