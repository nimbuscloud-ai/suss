// The bindings read through a cast and through a non-null assertion.

interface Env {
  CAST_ORIGIN: string;
  ASSERTED_ORIGIN: string;
}

export default {
  async fetch(request: Request, env: Env | undefined): Promise<Response> {
    void request;
    const origin = (env as Env).CAST_ORIGIN;
    return new Response(`${origin}${env!.ASSERTED_ORIGIN}`, { status: 200 });
  },
};
