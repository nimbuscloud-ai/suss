// The bindings handed on from the trigger: to a helper that reads two of
// them, and through a local set to the parameter.

interface Env {
  PASSED_ORIGIN: string;
  PASSED_TIMEOUT?: string;
  LOCAL_REGION: string;
}

function originOf(settings: Env): string {
  return `${settings.PASSED_ORIGIN}:${settings.PASSED_TIMEOUT ?? "30"}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    void request;
    const bindings = env;
    return new Response(`${originOf(env)} ${bindings.LOCAL_REGION}`, {
      status: 200,
    });
  },
};
