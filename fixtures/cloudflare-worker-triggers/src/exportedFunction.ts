interface Env {
  UPSTREAM: string;
}

export const handle = async (request: Request, env: Env) => {
  void request;
  return new Response(env.UPSTREAM);
};

export default { fetch: handle };
