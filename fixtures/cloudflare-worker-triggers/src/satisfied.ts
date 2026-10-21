// A quoted trigger key on an object checked with `satisfies` and
// exported by name.

interface Handlers {
  "fetch"(request: Request): Promise<Response>;
}

const worker = {
  async "fetch"(request: Request) {
    return new Response(request.url);
  },
} satisfies Handlers;

export default worker;
