// A helper that never mentions express. Its parameter is typed with an
// interface of the project's own, so nothing in this file says the
// object it registers on is an app.

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
