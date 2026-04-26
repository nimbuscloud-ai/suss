import {
  type CallExpression,
  Node,
  Project,
  ScriptTarget,
  type SourceFile,
} from "ts-morph";
import { describe, expect, it } from "vitest";

import {
  nodeRuntimePack,
  nodeSchedulingSubUnits,
  schedulingRecognizer,
} from "./index.js";

import type { Effect } from "@suss/behavioral-ir";

function makeFile(source: string): SourceFile {
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      strict: true,
      moduleResolution: 100,
    },
    useInMemoryFileSystem: true,
  });
  return project.createSourceFile("user.ts", source);
}

function recognizeAll(file: SourceFile): Effect[] {
  const out: Effect[] = [];
  file.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const emitted = schedulingRecognizer(node as CallExpression, {
      sourceFile: file,
    });
    if (emitted !== null) {
      out.push(...emitted);
    }
  });
  return out;
}

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
      {},
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
      {},
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
      {},
    );
    expect(sub).toHaveLength(0);
  });

  it("skips scheduling calls inside nested functions", () => {
    const file = makeFile(`
      function parent() {
        setImmediate(() => {});
        function nested() {
          setImmediate(() => {});  // belongs to nested, not parent
        }
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      {},
    );
    expect(sub).toHaveLength(1);
  });

  it("recognizes process.nextTick literal callbacks", () => {
    const file = makeFile(`
      function parent() {
        process.nextTick(() => {});
      }
    `);
    const sub = nodeSchedulingSubUnits(
      { func: findFunction(file, "parent"), name: "parent", kind: "handler" },
      {},
    );
    expect(sub).toHaveLength(1);
    expect(sub[0]?.name).toBe("parent.process.nextTick#0");
  });
});

describe("nodeRuntimePack — pack shape", () => {
  it("declares the expected pack interface", () => {
    const pack = nodeRuntimePack();
    expect(pack.name).toBe("node");
    expect(pack.protocol).toBe("in-process");
    expect(pack.languages).toEqual(["typescript", "javascript"]);
    expect(pack.discovery).toEqual([]);
    expect(pack.terminals).toEqual([]);
    expect(pack.invocationRecognizers).toHaveLength(1);
    expect(pack.subUnits).toBe(nodeSchedulingSubUnits);
  });
});
