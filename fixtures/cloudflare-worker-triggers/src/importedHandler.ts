export interface Env {
  REMOTE_ORIGIN: string;
}

export const fetch = async (request: Request, env: Env) => {
  void request;
  return new Response(env.REMOTE_ORIGIN);
};
