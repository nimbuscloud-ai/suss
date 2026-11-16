import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { constructedFrom, global } from "@suss/recognize";
import { factValueOps } from "@suss/recognize/ops";
import { createTestProject } from "@suss/test-project";

import { nodeId } from "../facts/extract.js";
import { ResolutionStore } from "../facts/store.js";
import { deferredCallOps } from "./deferredCallOps.js";
import { factSourceFor, readOpsAt, statedFactKey } from "./factSource.js";
import { opsOverFacts } from "./opsOverFacts.js";

import type { CallOps, PatternPack } from "@suss/extractor";
import type { CallExpression, SourceFile } from "ts-morph";

const SOURCE = `
  import { clean as load, port } from "envlib";
  import * as lib from "envlib";

  const settings = { PORT: port() };

  function loadConfig(source: Record<string, string | undefined>) {
    const parse = () => lib.clean(source, settings);
    return load(source, settings) ?? parse();
  }

  export const config = loadConfig(process.env);
  export const other = String(process.env.HOME);
`;

/** A pack that says which objects are the environment, and nothing else. */
const ENVIRONMENT_PACK: PatternPack = {
  name: "environment",
  languages: ["typescript"],
  protocol: "in-process",
  discovery: [],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
  environmentObjects: ["process.env", "import.meta.env"],
};

function fixture(): { file: SourceFile; store: ResolutionStore } {
  const project = createTestProject();
  const file = project.createSourceFile("/src/config.ts", SOURCE);
  const store = ResolutionStore.forPacks([ENVIRONMENT_PACK]);
  store.notePossibleCallers([file]);
  return { file, store };
}

function callWritten(file: SourceFile, text: string): CallExpression {
  const found = file
    .getDescendants()
    .find((node) => Node.isCallExpression(node) && node.getText() === text);
  if (found === undefined || !Node.isCallExpression(found)) {
    throw new Error(`no call ${text}`);
  }
  return found;
}

/** What each kind of ops says about one call, for the members a chain reads. */
function said(ops: CallOps) {
  return {
    method: ops.method(),
    callee: ops.calleeText(),
    arguments: ops.argumentCount(),
    name: ops.nameAt(0, "reference"),
    fromLib: ops.receiverIsFrom(constructedFrom("envlib")),
    calleeFromLib: ops.isFrom(constructedFrom("envlib")),
    receiver: ops.receiver()?.calleeText() ?? null,
    global: ops.receiverGlobal?.(["process.env"]),
    argument: ops.argument(0)?.calleeText() ?? null,
    calledName: ops.callee()?.calleeText() ?? null,
    named: ops.namedCallee?.(),
    importedAs: ops.calleeImportedAs?.(["envlib"]),
    property: ops.propertyAt(1, "PORT", "reference"),
    value: ops.valueAt(1)?.source?.() ?? null,
    chained: ops.chainedOn?.() ?? null,
    member: ops.member?.()?.method() ?? null,
    selector: ops.parameterReadsAt?.(0) ?? null,
    anchor: ops.anchorCall?.(constructedFrom("envlib")) ?? null,
    cls: ops.classAt?.(0) ?? null,
  };
}

describe("the ops for a call that state its facts when a question needs them", () => {
  it("say what the ops over the facts say", () => {
    const { file, store } = fixture();
    for (const text of [
      "load(source, settings)",
      "lib.clean(source, settings)",
      "String(process.env.HOME)",
    ]) {
      const call = callWritten(file, text);
      const deferred = deferredCallOps(call, { resolution: store });
      expect(said(deferred)).toEqual(
        said(opsOverFacts(call, { resolution: store })),
      );
      expect(deferred.site?.()).toBe(nodeId(call));
      expect(deferred.file?.()).toBe("/src/config.ts");
      expect(deferred.mentions?.("envlib")).toBe(true);
    }
  });

  it("give the call a result is handed to in place, and where", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/src/run.ts",
      [
        "declare function run(statement: unknown, values: unknown): void;",
        "declare function make(): unknown;",
        "run(make(), [1]);",
      ].join("\n"),
    );
    const store = new ResolutionStore();
    const call = callWritten(file, "make()");
    for (const ops of [
      deferredCallOps(call, { resolution: store }),
      opsOverFacts(call, { resolution: store }),
    ]) {
      const passed = ops.passedTo?.() ?? null;
      expect(passed?.call.calleeText()).toBe("run");
      expect(passed?.at).toBe(0);
    }
  });

  it("read the callee's own import, and nothing past it", () => {
    const { file, store } = fixture();
    const reading = { resolution: store };
    const aliased = deferredCallOps(
      callWritten(file, "load(source, settings)"),
      reading,
    );
    expect(aliased.calleeImport?.(["envlib"])).toBe("clean");
    expect(aliased.calleeImport?.(["other"])).toBeNull();
    const member = deferredCallOps(
      callWritten(file, "lib.clean(source, settings)"),
      reading,
    );
    expect(member.calleeImport?.(["envlib"])).toBeNull();
    expect(
      deferredCallOps(
        callWritten(file, "load(source, settings)"),
        {},
      ).calleeImport?.(["envlib"]),
    ).toBeNull();
  });

  it("list the calls the callee writes, the ones in a function inside it too, once per store", () => {
    const { file, store } = fixture();
    const call = callWritten(file, "loadConfig(process.env)");
    const listed = deferredCallOps(call, {
      resolution: store,
    }).callsInCallee?.();
    expect(listed?.map((one) => one.calleeText())).toEqual([
      "lib.clean",
      "load",
      "parse",
    ]);
    expect(deferredCallOps(call, { resolution: store }).callsInCallee?.()).toBe(
      listed,
    );
    expect(
      deferredCallOps(call, {})
        .callsInCallee?.()
        .map((one) => one.calleeText()),
    ).toEqual(["lib.clean", "load", "parse"]);
    expect(
      deferredCallOps(callWritten(file, "port()"), {
        resolution: store,
      }).callsInCallee?.(),
    ).toEqual([]);
  });
});

describe("the fact source's own reading of a schema parse", () => {
  it("hands a read site's call over without stating it, and nothing at a property read", () => {
    const { file, store } = fixture();
    const call = callWritten(file, "load(source, settings)");
    expect(readOpsAt(call, store).call?.()?.calleeText()).toBe("load");
    const read = file
      .getDescendants()
      .find((node) => node.getText() === "process.env.HOME");
    expect(
      read === undefined ? undefined : readOpsAt(read, store).call?.(),
    ).toBeNull();
  });

  it("lists the calls a callee writes, and reads the callee's own import", () => {
    const { file, store } = fixture();
    const source = factSourceFor(store);
    const call = callWritten(file, "loadConfig(process.env)");
    const key = statedFactKey(call, store);
    expect(source.callsInCallee?.(key).map((one) => one.calleeText())).toEqual([
      "lib.clean",
      "load",
      "parse",
    ]);
    const aliased = callWritten(file, "load(source, settings)");
    const callee = aliased.getExpression();
    statedFactKey(aliased, store);
    expect(source.importedUnder?.(nodeId(callee), ["envlib"])).toEqual([
      "clean",
    ]);
    expect(source.callsInCallee?.(nodeId(callee))).toEqual([]);
  });

  it("gives the environment a value is, or none", () => {
    const { file, store } = fixture();
    const source = factSourceFor(store);
    const ENVIRONMENT = global("process.env", "import.meta.env");
    const handed = callWritten(file, "load(source, settings)");
    statedFactKey(handed, store);
    const [environment, schema] = handed.getArguments();
    const path = (node: Node | undefined) =>
      node === undefined
        ? null
        : factValueOps(nodeId(node), source).runtimePath?.(ENVIRONMENT);
    expect(path(environment)).toBe("process.env");
    expect(path(schema)).toBeUndefined();
    expect(
      environment === undefined
        ? null
        : factValueOps(nodeId(environment), source).runtimePath?.(
            global("import.meta.env"),
          ),
    ).toBeUndefined();
  });
});
