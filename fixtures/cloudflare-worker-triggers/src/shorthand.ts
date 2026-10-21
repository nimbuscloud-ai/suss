// Triggers written as shorthand properties, with a redirect response.

interface Env {
  LOOKUP_TABLE: string;
}

const fetch = async (request: Request, env: Env): Promise<Response> => {
  void request;
  return Response.redirect(env.LOOKUP_TABLE);
};

const scheduled = async () => {};

export default { fetch, scheduled };
