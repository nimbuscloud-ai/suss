import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractPythonProject, findPythonFiles } from "@suss/adapter-python";

import {
  celeryFramework,
  celeryJobQueue,
  declares,
  withCelery,
} from "./index.js";

import type { PythonPack } from "@suss/adapter-python";

/** The part of the fastapi pack a route needs to be found. */
const fastapiLike: PythonPack = {
  name: "fastapi",
  protocol: "http",
  discovery: [
    {
      type: "decoratedFunctionRoute",
      importModule: ["fastapi"],
      verbAttributeNames: { post: "POST" },
      pathParamSyntax: "braces",
    },
  ],
};

describe("what the Celery pack declares", () => {
  it("says which decorators make a task and which calls enqueue one", () => {
    const queue = celeryJobQueue();
    expect(queue).toMatchObject({
      messageBus: "celery",
      module: "celery",
      taskDecorators: ["task", "shared_task"],
      nameKeyword: "name",
      queueKeyword: "queue",
      defaultName: "modulePath",
    });
    expect(queue.enqueueMethods.map((one) => one.method)).toEqual([
      "delay",
      "apply_async",
    ]);
    expect(queue.sendByName?.map((one) => one.method)).toEqual(["send_task"]);
  });

  it("is suggested for a project that depends on celery", () => {
    expect(declares.dependencies).toEqual([
      { ecosystem: "pypi", name: "celery" },
    ]);
  });

  it("composes onto a route pack rather than replacing it", () => {
    const composed = withCelery(fastapiLike);
    expect(composed.discovery).toBe(fastapiLike.discovery);
    expect(composed.jobQueues).toEqual([celeryJobQueue()]);
    expect(celeryFramework().jobQueues).toEqual([celeryJobQueue()]);
  });
});

describe("a route that enqueues a task", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-celery-"));
    const write = (rel: string, lines: string[]): void => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), lines.join("\n"));
    };
    write("shop/__init__.py", [""]);
    write("shop/worker.py", [
      "from celery import Celery",
      "",
      'celery_app = Celery("shop")',
      "",
    ]);
    write("shop/tasks.py", [
      "from shop.worker import celery_app",
      "",
      '@celery_app.task(name="orders.ship", queue="fulfilment")',
      "def ship_order(order_id):",
      "    return order_id",
      "",
    ]);
    write("shop/api.py", [
      "from fastapi import FastAPI",
      "from shop.tasks import ship_order",
      "",
      "app = FastAPI()",
      "",
      '@app.post("/orders/{order_id}/ship")',
      "def ship(order_id: int):",
      "    ship_order.delay(order_id)",
      '    return {"queued": True}',
      "",
    ]);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("sends to the task the route's handler enqueues, and the task consumes it", async () => {
    const { summaries } = await extractPythonProject({
      files: findPythonFiles(root),
      packs: [fastapiLike, celeryFramework()],
      workspaceRoot: root,
      roots: [root],
    });
    const task = summaries.find((s) => s.identity.name === "ship_order");
    expect(task?.kind).toBe("consumer");
    expect(task?.identity.boundaryBinding).toMatchObject({
      recognition: "celery",
      semantics: { messageBus: "celery", channel: "fulfilment#orders.ship" },
    });

    const route = summaries.find((s) => s.kind === "handler");
    const sent = route?.transitions
      .flatMap((transition) => transition.effects)
      .find(
        (effect) =>
          effect.type === "interaction" &&
          effect.interaction.class === "message-send",
      );
    expect(sent).toMatchObject({
      callee: "ship_order.delay",
      binding: {
        recognition: "celery",
        semantics: { messageBus: "celery", channel: "orders.ship" },
      },
      interaction: {
        body: {
          kind: "array",
          items: [{ kind: "identifier", name: "order_id" }],
        },
      },
    });
  });
});
