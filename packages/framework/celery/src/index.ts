/**
 * Celery tasks, and the calls that enqueue one. The pack lists Celery's
 * own names: the decorators that make a function a task, the keywords on
 * them, and the methods that put a task on its queue. The Python adapter
 * resolves each one through the project's imports and values. The README
 * shows what a task and an enqueue become.
 */

import type { PyJobQueue, PythonPack } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * Celery's names. `task` is the decorator on an app built by `Celery()`,
 * and `shared_task` the one the library exports for code that has no app
 * in hand. `current_app` is the object Celery exports for whichever app
 * is running.
 */
export function celeryJobQueue(): PyJobQueue {
  return {
    messageBus: "celery",
    module: "celery",
    taskDecorators: ["task", "shared_task"],
    nameKeyword: "name",
    queueKeyword: "queue",
    defaultName: "modulePath",
    enqueueMethods: [
      { method: "delay", arguments: { type: "spread" } },
      {
        method: "apply_async",
        arguments: {
          type: "packed",
          args: { argument: 0, keyword: "args" },
          kwargs: { argument: 1, keyword: "kwargs" },
        },
      },
    ],
    sendByName: [
      {
        method: "send_task",
        name: { argument: 0, keyword: "name" },
        arguments: {
          type: "packed",
          args: { argument: 1, keyword: "args" },
          kwargs: { argument: 2, keyword: "kwargs" },
        },
      },
    ],
    apps: ["Celery", "current_app"],
  };
}

/**
 * Adds Celery's tasks to the pack a run already uses. A project picks
 * its web framework and its job queue separately, so the two combine.
 */
export function withCelery(pack: PythonPack): PythonPack {
  return {
    ...pack,
    jobQueues: [...(pack.jobQueues ?? []), celeryJobQueue()],
  };
}

export function celeryFramework(): PythonPack {
  return {
    name: "celery",
    protocol: "celery",
    discovery: [],
    jobQueues: [celeryJobQueue()],
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-celery",
  dependencies: [{ ecosystem: "pypi", name: "celery" }],
  reads:
    "Celery tasks (Python). A function under `@app.task` or `@shared_task` is the consumer of its task, and `.delay`, `.apply_async` and `send_task` are sends to it, so a route that enqueues a task reaches what the task does.",
};

export default celeryFramework;
