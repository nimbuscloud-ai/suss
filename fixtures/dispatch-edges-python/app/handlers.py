def on_created(payload):
    return len(payload)


def on_deleted(payload):
    return len(payload) + 1


def on_archived(payload):
    return len(payload) + 2


HANDLERS = {
    "created": on_created,
    "deleted": on_deleted,
    "archived": lambda payload: on_archived(payload),
}


def run_later(payload, task):
    return task()


REGISTRY = {}


def register(name):
    def decorate(fn):
        REGISTRY[name] = fn
        return fn

    return decorate


@register("created")
def registered_created(payload):
    return on_created(payload)


@register("deleted")
def registered_deleted(payload):
    return on_deleted(payload)


class Events:
    def handle(self, kind, payload):
        return getattr(self, kind)(payload)

    def handle_named(self, payload):
        return getattr(self, "created")(payload)

    def finish(self, kind, payload):
        return getattr(self, f"finish_{kind}")(payload)

    def finish_created(self, payload):
        return on_created(payload)

    def finish_deleted(self, payload):
        return on_deleted(payload)

    def created(self, payload):
        return on_created(payload)

    def deleted(self, payload):
        return on_deleted(payload)
