from fastapi import FastAPI

from app.handlers import HANDLERS, REGISTRY, Events, on_created, on_deleted, run_later

app = FastAPI()


@app.post("/table/{kind}")
def via_table(kind: str, payload: str):
    return HANDLERS[kind](payload)


@app.post("/literal")
def via_literal(payload: str):
    return HANDLERS["created"](payload)


@app.post("/get/{kind}")
def via_get(kind: str, payload: str):
    handler = HANDLERS.get(kind)
    return handler(payload)


@app.post("/conditional/{kind}")
def via_conditional(kind: str, payload: str):
    handler = HANDLERS[kind] if kind in HANDLERS else None
    if handler is None:
        return None
    return handler(payload)


@app.post("/registry/{kind}")
def via_registry(kind: str, payload: str):
    return REGISTRY[kind](payload)


@app.post("/getattr/{kind}")
def via_getattr(kind: str, payload: str):
    return Events().handle(kind, payload)


@app.post("/finish/{kind}")
def via_finish(kind: str, payload: str):
    return Events().finish(kind, payload)


@app.post("/closure")
def via_closure(payload: str):
    return run_later(payload, lambda: on_created(payload))


def on_deleted_later():
    return on_deleted("later")


@app.post("/passed")
def via_passed(payload: str):
    return run_later(payload, on_deleted_later)
