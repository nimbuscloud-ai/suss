type Handler = (payload: string) => number;

function onCreated(payload: string): number {
  return payload.length;
}

function onDeleted(payload: string): number {
  return payload.length + 1;
}

function onArchived(payload: string): number {
  return payload.length + 2;
}

function runLater(payload: string, task: () => number): number {
  return task();
}

const TABLE: Record<string, Handler> = {
  created: onCreated,
  deleted: onDeleted,
  archived: (payload) => {
    return onArchived(payload);
  },
};

export function viaTable(kind: string, payload: string): number {
  return TABLE[kind](payload);
}

export function viaNarrowedKey(
  kind: "created" | "deleted",
  payload: string,
): number {
  return TABLE[kind](payload);
}

export function viaLiteralKey(payload: string): number {
  return TABLE["created"](payload);
}

const HOOKS: Record<string, Handler> = {
  beforeSave: onCreated,
  beforeDelete: onDeleted,
  afterSave: onArchived,
};

export function viaTemplateKey(step: string, payload: string): number {
  return HOOKS[`before${step}`](payload);
}

const BY_NAME = new Map<string, Handler>();
BY_NAME.set("created", onCreated);
BY_NAME.set("deleted", onDeleted);

export function viaMap(kind: string, payload: string): number {
  const handler = BY_NAME.get(kind);
  return handler === undefined ? 0 : handler(payload);
}

const REGISTRY: Record<string, Handler> = {};

function register(name: string, handler: Handler): void {
  REGISTRY[name] = handler;
}

register("created", onCreated);
register("archived", onArchived);

export function viaRegistry(kind: string, payload: string): number {
  return REGISTRY[kind](payload);
}

export function viaClosure(payload: string): number {
  return runLater(payload, () => onCreated(payload));
}

export function viaPassedName(payload: string): number {
  return runLater(payload, onDeletedLater);
}

function onDeletedLater(): number {
  return onDeleted("later");
}
