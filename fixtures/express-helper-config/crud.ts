// A helper that never mentions express. Nothing here says the object it
// registers on is an app, so the routes come from the config file rather
// than from reading this body.

interface Handlers {
  list(req: unknown, res: { json(body: unknown): void }): void;
}

interface RouteSink {
  get(path: string, handler: Handlers["list"]): void;
}

export function registerCrud(
  sink: RouteSink,
  name: string,
  handlers: Handlers,
): void {
  sink.get(`/${name}`, handlers.list);
}
