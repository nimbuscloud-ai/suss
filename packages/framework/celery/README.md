# @suss/framework-celery

This pack reads Celery tasks as background jobs, so a route that enqueues a task reaches what the task does.

## What this package is

A pattern pack for the Python adapter. A function decorated as a Celery task becomes a `consumer` unit on a `message-bus` binding, and a call that enqueues it becomes a `message-send` effect on the unit that makes the call. The two have the same channel, so `suss check` pairs them and `suss ask "what does <route> reach"` follows the enqueue into the task.

```ts
import { celeryFramework } from "@suss/framework-celery";

const pack = celeryFramework();
```

```bash
npx @suss/cli extract --lang python -f fastapi -f celery -o summaries/python.json
```

Given this code:

```python
from celery import Celery

celery_app = Celery("shop")

@celery_app.task(name="orders.ship", queue="fulfilment")
def ship_order(order_id):
    ...

@app.post("/orders/{order_id}/ship")
def ship(order_id: int):
    ship_order.delay(order_id)
```

`ship_order` is a consumer on `bus:celery fulfilment#orders.ship`, and the route sends to `bus:celery orders.ship`. A channel is written `<queue>#<task name>`. The enqueue does not say a queue, so it pairs with the task on whichever queue the task runs on.

## What each part contributes

| Written as | What it becomes |
| --- | --- |
| `@app.task` or `@shared_task`, with or without arguments | a consumer unit on the function |
| `name="..."` on the decorator | the task's name |
| no `name` | Celery's default name, the function's dotted module path and its name, `shop.tasks.ship_order` |
| `queue="..."` on the decorator | the queue in front of the name on the consumer's channel |
| `task.delay(a, b, c=1)` | a send to the task's name, with the arguments as the body |
| `task.apply_async((a, b), {"c": 1})`, or `args=` and `kwargs=` | the same |
| `app.send_task("orders.ship", args=[...])` | a send to the name written there |

The body is the positional arguments as an array and the keyword arguments as an object. A call that passes both gets an array of the two, the way Celery's message sends them. A call that passes `*args` or `**kwargs` gets no body, since nothing in the source says what is in them.

The app is anything built by `Celery(...)`, wherever it is built and however it is imported, and `celery.current_app`. The decorator is read through a project function that wraps it, as long as the wrapper passes its parameters straight through. Both the task's name and its queue go through the adapter's value evaluator, so a constant defined in another module reads the same as a string written in place.

## When an enqueue does not settle

The task behind `.delay` has to resolve to one function with a task decorator on it. When it does not, the send is recorded with no channel, and the summary has an `unfollowedCall` gap that says the job could not be settled. That happens when the task is a parameter, an attribute set somewhere the run does not follow, or a name imported inside an `if` or a `try`. A `.delay` or `.apply_async` on a value the run can tell is something else, such as a `multiprocessing` pool, records nothing.

## What it will not tell you

A per-call queue, `apply_async(queue="other")`, is left off the send's channel, so the send still pairs with the task. Routing set in Celery's configuration, such as `task_routes`, is not read, and neither is a schedule in `beat_schedule`. A task scheduled only from configuration has no producer in the run, and the message-bus check does not report it as an orphan for that reason.

`task.s(...)`, `signature`, `chain`, `group` and `chord` are not read as enqueues. A class-based task, registered with `app.register_task`, is not read as a task.

A function's default name assumes Celery imported its module under the same dotted path the adapter uses to resolve imports. A task in a `__main__` module, or an app that overrides `gen_task_name`, gets a name that Celery would not give it.

## Where it fits in suss

The pack depends on `@suss/adapter-python` for the `PythonPack` contract it fills in, and on `@suss/ir-core` for the declaration. The adapter's DESIGN.md says how a task and an enqueue are read. The message-bus pass in `@suss/checker` pairs what this pack records.

When the same run also reads a web service, combine this pack with a route pack using `withCelery(fastapiFramework(...))`, or pass both with `-f`.
