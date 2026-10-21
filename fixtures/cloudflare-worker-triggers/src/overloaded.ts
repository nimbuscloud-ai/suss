interface Env {
  SERVICE_ORIGIN: string;
}

async function serve(request: Request, settings: Env): Promise<Response>;
async function serve(request: Request, settings: Env): Promise<Response> {
  void request;
  return new Response(settings.SERVICE_ORIGIN, { status: 200 });
}

export default { fetch: serve };
