import { describe, expect, it } from "vitest";

import {
  createTsSubUnitContext,
  createTypeScriptAdapter,
} from "@suss/adapter-typescript";
import { effectsOverFile, packWithOnly } from "@suss/pack-harness";
import { createTestProject } from "@suss/test-project";

import {
  nodeRuntimePack,
  nodeSchedulingSubUnits,
  schedulingRecognizer,
} from "./index.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { Node, SourceFile } from "ts-morph";

function makeFile(source: string): SourceFile {
  const project = createTestProject();
  return project.createSourceFile("user.ts", source);
}

function recognizeAll(file: SourceFile): Effect[] {
  return effectsOverFile(
    file,
    packWithOnly(nodeRuntimePack(), { invocation: [schedulingRecognizer] }),
  );
}

const subUnitContext = createTsSubUnitContext();

function scheduleEffectsOf(effects: Effect[]): Array<
  Extract<Effect, { type: "interaction" }> & {
    interaction: { class: "schedule" };
  }
> {
  return effects.filter(
    (
      e,
    ): e is Extract<Effect, { type: "interaction" }> & {
      interaction: { class: "schedule" };
    } => e.type === "interaction" && e.interaction.class === "schedule",
  );
}

describe("scheduling recognizer", () => {
  it("recognizes setImmediate with literal arrow callback", () => {
    const file = makeFile(`
      function handler() {
        setImmediate(() => {});
      }
    `);
    const effects = scheduleEffectsOf(recognizeAll(file));
    expect(effects).toHaveLength(1);
    expect(effects[0]?.interaction).toMatchObject({
      class: "schedule",
      via: "setImmediate",
      callbackRef: { type: "literal" },
      hasDelay: false,
    });
  });

  it("recognizes setTimeout with delay arg", () => {
    const file = makeFile(`
      function handler() {
        setTimeout(() => {}, 100);
      }
    `);
    const effects = scheduleEffectsOf(recognizeAll(file));
    expect(effects).toHaveLength(1);
    expect(effects[0]?.interaction).toMatchObject({
      via: "setTimeout",
      hasDelay: true,
    });
  });

  it("marks identifier callbacks with their name", () => {
    const file = makeFile(`
      function task() {}
      function handler() {
        setImmediate(task);
      }
    `);
    const effects = scheduleEffectsOf(recognizeAll(file));
    expect(effects).toHaveLength(1);
    expect(effects[0]?.interaction.callbackRef).toEqual({
      type: "identifier",
      name: "task",
    });
  });

  it("marks non-trivial expression callbacks as opaque", () => {
    const file = makeFile(`
      function getHandler(): () => void { return () => {}; }
      function handler() {
        setImmediate(getHandler());
      }
    `);
    const effects = scheduleEffectsOf(recognizeAll(file));
    expect(effects).toHaveLength(1);
    expect(effects[0]?.interaction.callbackRef).toEqual({
      type: "opaque",
      reason: "non-literal-callback",
    });
  });

  it("recognizes process.nextTick", () => {
    const file = makeFile(`
      function handler() {
        process.nextTick(() => {});
      }
    `);
    const effects = scheduleEffectsOf(recognizeAll(file));
    expect(effects).toHaveLength(1);
    expect(effects[0]?.interaction.via).toBe("process.nextTick");
  });

  it("recognizes queueMicrotask and setInterval", () => {
    const file = makeFile(`
      function handler() {
        queueMicrotask(() => {});
        setInterval(() => {}, 5000);
      }
    `);
    const vias = scheduleEffectsOf(recognizeAll(file)).map(
      (e) => e.interaction.via,
    );
    expect(vias.sort()).toEqual(["queueMicrotask", "setInterval"]);
  });

  it("does NOT recognize unrelated calls", () => {
    const file = makeFile(`
      function handler() {
        Math.floor(1.5);
        console.log("hello");
        someUserFn(() => {});
      }
      function someUserFn(_cb: () => void) {}
    `);
    expect(scheduleEffectsOf(recognizeAll(file))).toHaveLength(0);
  });

  it("does NOT match nextTick-shaped calls on a non-process root", () => {
    const file = makeFile(`
      const customScheduler = { nextTick(_cb: () => void) {} };
      function handler() {
        customScheduler.nextTick(() => {});
      }
    `);
    expect(scheduleEffectsOf(recognizeAll(file))).toHaveLength(0);
  });

  it("reads a timer imported from node:timers under another name", () => {
    const file = makeFile(`
      import { setTimeout as later } from "node:timers";
      function handler() {
        later(() => {}, 5);
      }
    `);
    const effects = scheduleEffectsOf(recognizeAll(file));
    expect(effects.map((e) => [e.callee, e.interaction])).toEqual([
      [
        "later",
        {
          class: "schedule",
          via: "later",
          callbackRef: { type: "literal" },
          hasDelay: true,
        },
      ],
    ]);
  });

  it("leaves out a promise timer, which takes no callback", () => {
    const file = makeFile(`
      import { setTimeout } from "node:timers/promises";
      async function handler() {
        await setTimeout(10);
      }
    `);
    expect(scheduleEffectsOf(recognizeAll(file))).toHaveLength(0);
  });

  it("leaves out a function the file declares under a timer's name", () => {
    const file = makeFile(`
      function handler() {
        const setTimeout = (fn: () => void) => fn();
        setTimeout(() => {});
      }
    `);
    expect(scheduleEffectsOf(recognizeAll(file))).toHaveLength(0);
  });

  it("reads the callee and the callback through parentheses and a cast", () => {
    const file = makeFile(`
      function handler() {
        (setTimeout)((() => {}) as () => void, 5);
        (process as NodeJS.Process).nextTick(() => {});
      }
    `);
    const effects = scheduleEffectsOf(recognizeAll(file));
    expect(
      effects.map((e) => [
        e.callee,
        e.interaction.callbackRef,
        e.interaction.hasDelay,
      ]),
    ).toEqual([
      ["setTimeout", { type: "literal" }, true],
      ["(process as NodeJS.Process).nextTick", { type: "literal" }, false],
    ]);
  });

  it("reads undefined as no function", () => {
    const file = makeFile(`
      function handler() {
        setTimeout(undefined, 5);
      }
    `);
    const effects = scheduleEffectsOf(recognizeAll(file));
    expect(effects[0]?.interaction.callbackRef).toEqual({
      type: "opaque",
      reason: "non-literal-callback",
    });
  });

  it("says when the call hands over nothing", () => {
    const file = makeFile(`
      function handler() {
        setImmediate();
      }
    `);
    const effects = scheduleEffectsOf(recognizeAll(file));
    expect(effects[0]?.interaction.callbackRef).toEqual({
      type: "opaque",
      reason: "missing-callback-argument",
    });
  });
});

describe("scheduling subUnits", () => {
  function findFunction(file: SourceFile, name: string) {
    const fn = file.getFunctionOrThrow(name);
    return fn;
  }

  it("emits one sub-unit per literal-callback scheduling call", () => {
    const file = makeFile(`
      function parent() {
        setImmediate(() => {});
        queueMicrotask(() => {});
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      subUnitContext,
    );
    expect(sub).toHaveLength(2);
    expect(sub.map((s) => s.kind)).toEqual([
      "scheduled-callback",
      "scheduled-callback",
    ]);
    expect(sub.map((s) => s.name)).toEqual([
      "parent.setImmediate#0",
      "parent.queueMicrotask#0",
    ]);
  });

  it("indexes multiple calls to the same primitive", () => {
    const file = makeFile(`
      function parent() {
        setImmediate(() => {});
        setImmediate(() => {});
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      subUnitContext,
    );
    expect(sub.map((s) => s.name)).toEqual([
      "parent.setImmediate#0",
      "parent.setImmediate#1",
    ]);
  });

  it("does NOT emit a sub-unit for identifier-referenced callbacks", () => {
    const file = makeFile(`
      function task() {}
      function parent() {
        setImmediate(task);
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      subUnitContext,
    );
    expect(sub).toHaveLength(0);
  });

  it("leaves a timer inside a nested function declaration to that declaration", () => {
    const file = makeFile(`
      function parent() {
        setImmediate(() => {});
        function nested() {
          setImmediate(() => {});
        }
        return () => {
          function later() {
            setImmediate(() => {});
          }
          return later;
        };
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      subUnitContext,
    );
    expect(sub.map((s) => s.name)).toEqual(["parent.setImmediate#0"]);
  });

  it("claims a timer set inside a `.then` callback", () => {
    const file = makeFile(`
      declare function work(): void;
      function parent(load: Promise<void>) {
        return load.then(() => setTimeout(() => work(), 10));
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      subUnitContext,
    );
    expect(sub.map((s) => [s.name, (s.func as Node).getText()])).toEqual([
      ["parent.setTimeout#0", "() => work()"],
    ]);
  });

  it("claims a timer set inside a function expression handed to a library", () => {
    const file = makeFile(`
      declare const emitter: { on(event: string, cb: () => void): void };
      function parent() {
        emitter.on("ready", function onReady() {
          setImmediate(() => {});
        });
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      subUnitContext,
    );
    expect(sub.map((s) => s.name)).toEqual(["parent.setImmediate#0"]);
  });

  it("numbers timers by where they start, a timer set inside another included", () => {
    const file = makeFile(`
      function parent(load: Promise<void>) {
        setTimeout(() => {
          setTimeout(() => {}, 5);
        }, 10);
        load.then(() => setTimeout(function last() {}));
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      subUnitContext,
    );
    expect(sub.map((s) => s.name)).toEqual([
      "parent.setTimeout#0",
      "parent.setTimeout#1",
      "parent.setTimeout#2",
    ]);
    expect((sub[1]?.func as Node).getText()).toBe("() => {}");
    expect((sub[2]?.func as Node).getText()).toBe("function last() {}");
  });

  it("recognizes process.nextTick literal callbacks", () => {
    const file = makeFile(`
      function parent() {
        process.nextTick(() => {});
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      subUnitContext,
    );
    expect(sub).toHaveLength(1);
    expect(sub[0]?.name).toBe("parent.process.nextTick#0");
  });

  it("names a claim by the callee as written, and claims a callback in a cast", () => {
    const file = makeFile(`
      import { setTimeout as later } from "node:timers";
      import { setTimeout as delay } from "node:timers/promises";
      function parent() {
        later((() => {}) as () => void, 5);
        delay(5);
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      subUnitContext,
    );
    expect(
      sub.map((s) => [s.name, (s.func as Node).getText(), s.metadata]),
    ).toEqual([
      [
        "parent.later#0",
        "() => {}",
        { node: { schedulingPrimitive: "later" } },
      ],
    ]);
  });

  it("claims no timer a project module re-exports, since only a direct import is read", () => {
    const project = createTestProject();
    project.createSourceFile(
      "/timers.ts",
      'export { setTimeout as later } from "node:timers";',
    );
    const file = project.createSourceFile(
      "/user.ts",
      `
        import { later } from "./timers";
        function parent() {
          later(() => {}, 5);
        }
      `,
    );
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      subUnitContext,
    );
    expect(sub).toHaveLength(0);
  });
});

describe("scheduling sub-units in an extraction", () => {
  const handlerPack: PatternPack = {
    name: "handlers",
    protocol: "in-process",
    languages: ["typescript"],
    discovery: [
      { kind: "handler", match: { type: "namedExport", names: ["handle"] } },
    ],
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
    ],
    inputMapping: { type: "positionalParams", params: [] },
  };

  function calleesOf(summary: BehavioralSummary | undefined): string[] {
    return (summary?.transitions ?? []).flatMap((t) =>
      t.effects.flatMap((e) => (e.type === "invocation" ? [e.callee] : [])),
    );
  }

  it("gives a timer set inside a `.then` callback its own unit, and the handler stops at it", async () => {
    const project = createTestProject();
    project.createSourceFile(
      "/handler.ts",
      `
        declare function load(): Promise<void>;
        declare function work(): void;
        export function handle() {
          return load().then(() => {
            setTimeout(() => {
              work();
            }, 10);
          });
        }
      `,
    );
    const adapter = createTypeScriptAdapter({
      project,
      frameworks: [handlerPack, nodeRuntimePack()],
      includeReachable: false,
    });
    const summaries = await adapter.extractAll();

    const handler = summaries.find((s) => s.identity.name === "handle");
    const timer = summaries.find(
      (s) => s.identity.name === "handle.setTimeout#0",
    );
    expect(timer?.kind).toBe("scheduled-callback");
    const scheduled = (handler?.transitions ?? []).flatMap((t) =>
      scheduleEffectsOf(t.effects),
    );
    expect(scheduled.map((e) => e.interaction.via)).toEqual(["setTimeout"]);
    expect(calleesOf(handler)).not.toContain("work");
    expect(calleesOf(timer)).toContain("work");
  });
});

describe("nodeRuntimePack — pack shape", () => {
  it("declares the expected pack interface", () => {
    const pack = nodeRuntimePack();
    expect(pack.name).toBe("node");
    expect(pack.protocol).toBe("in-process");
    expect(pack.languages).toEqual(["typescript", "javascript"]);
    expect(pack.discovery).toEqual([]);
    expect(pack.terminals.map((terminal) => terminal.kind)).toEqual(["exit"]);
    expect(pack.terminals.every((terminal) => terminal.inEveryUnit)).toBe(true);
    // Scheduling, then the console writes and the stream writes.
    expect(pack.invocationRecognizers).toHaveLength(3);
    expect(pack.subUnits).toBe(nodeSchedulingSubUnits);
  });
});
