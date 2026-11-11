// The ops that read a body's statements, a call's pairs and loops, and a
// file's classes, each pinned against facts written out by hand.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  type FactSource,
  factCallOps,
  factModuleOps,
  factValueOps,
} from "./factOps.js";

import type { CallOps } from "@suss/extractor";

/**
 * The facts for, in source order:
 *
 *   draw do
 *     get "a"                      # 0
 *     if dev? then mount X => "/x" end   # 1
 *     %w[u v].each_with_index { |name, i| get name }
 *   end
 */
function source(over: Partial<FactSource> = {}): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  add("call", "draw", "draw#callee");
  add("callBlock", "draw", "block");
  add("func", "block");
  add("call", "getA", "get#callee");
  add("callArg", "getA", "0", "a");
  add("call", "mount", "mount#callee");
  add("callPairArg", "mount", "X", "slashX");
  add("call", "each", "each#callee");
  add("readsProperty", "each#callee", "list", "each_with_index");
  add("callBlock", "each", "loop");
  add("func", "loop");
  add("elementOf", "loop#name", "list");
  add("positionOf", "loop#i", "loop#name");
  add("objectValue", "list");
  add("writtenEntryAt", "list", "0", "u", "value");
  add("writtenEntryAt", "list", "1", "v", "value");
  // Stated out of order, which the position settles.
  add("bodyCallAt", "block", "2", "each");
  add("bodyCallAt", "block", "0", "getA");
  add("bodyCallAt", "block", "1", "mount");
  add("bodyCallAt", "app.rb", "0", "draw");
  add("objectValue", "Engine");
  add("rbConstantName", "Engine", "Billing::Engine");
  add("bodyCallAt", "Engine", "0", "isolate");
  add("call", "isolate", "isolate#callee");
  add("objectValue", "Other");
  add("exportsAs", "app.rb", "Other", "Other");

  const text: Record<string, string> = {
    "get#callee": "get",
    "mount#callee": "mount",
    "draw#callee": "draw",
    "isolate#callee": "isolate_namespace",
    "each#callee": "each_with_index",
    "loop#name": "name",
    "loop#i": "i",
    X: "X",
  };
  const literal: Record<string, string> = {
    a: "a",
    slashX: "/x",
    u: "u",
    v: "v",
  };
  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: () => [],
    shapeOf: (key) => (key === "list" ? "list" : null),
    textOf: (key) => text[key] ?? key,
    literalOf: (key) => literal[key] ?? null,
    nameOf: (key) => literal[key] ?? null,
    argOf: () => null,
    parameterOf: (key) =>
      key.startsWith("loop#")
        ? { func: "loop", position: key === "loop#name" ? 0 : 1 }
        : null,
    ...over,
  };
}

function callOf(key: string, facts: FactSource): CallOps {
  const ops = factCallOps(key, facts);
  if (ops === null) {
    throw new Error(`no call at ${key}`);
  }
  return ops;
}

const calleesOf = (calls: readonly CallOps[]) =>
  calls.map((call) => call.calleeText());

describe("the calls a body writes as statements", () => {
  it("lists a block's calls in the order bodyCallAt places them", () => {
    const facts = source();
    expect(calleesOf(factValueOps("block", facts).bodyCalls?.() ?? [])).toEqual(
      ["get", "mount", "each_with_index"],
    );
  });

  it("lists a file's own statements, keyed by its path", () => {
    const module = factModuleOps("app.rb", source(), { calls: () => [] });
    expect(calleesOf(module.bodyCalls())).toEqual(["draw"]);
  });

  it("gives nothing for a value that writes no body", () => {
    expect(factValueOps("a", source()).bodyCalls?.()).toEqual([]);
  });
});

describe("a call's pairs and loops", () => {
  it("reads a pair whose key is a value of its own", () => {
    const [pair, ...more] = callOf("mount", source()).pairArgs?.() ?? [];
    expect(more).toEqual([]);
    expect(pair?.key.source?.()).toBe("X");
    expect(pair?.value.text()).toBe("/x");
  });

  it("reads the list a block runs once per element of, and the variables it gives each element and its position", () => {
    const loop = callOf("each", source()).loopsOver?.();
    expect(loop?.element).toBe("name");
    expect(loop?.position).toBe("i");
    expect(loop?.over.items().map((item) => item.text())).toEqual(["u", "v"]);
  });

  it("finds no loop on a call that runs nothing per element", () => {
    expect(callOf("getA", source()).loopsOver?.()).toBeNull();
    expect(callOf("draw", source()).loopsOver?.()).toBeNull();
  });
});

describe("a value read with names bound", () => {
  it("asks the adapter's evaluator with the bindings", () => {
    const seen: ReadonlyMap<string, string>[] = [];
    const facts = source({
      evaluatedWith: (key, bindings) => {
        seen.push(bindings);
        return `${key}=${bindings.get("name")}`;
      },
    });
    const bindings = new Map([["name", "u"]]);
    expect(factValueOps("tpl", facts).evaluatedWith?.(bindings)).toBe("tpl=u");
    expect(seen).toEqual([bindings]);
  });

  it("reads the value as its name where the adapter has no evaluator to bind them in", () => {
    expect(factValueOps("a", source()).evaluatedWith?.(new Map())).toBe("a");
  });
});

describe("the classes a file writes", () => {
  it("gives each class the adapter lists its full name and its body's calls", () => {
    const module = factModuleOps("app.rb", source(), {
      calls: () => [],
      classes: () => ["Engine", "Other"],
    });
    const [engine, other] = module.classes();
    expect(engine?.name()).toBe("Billing::Engine");
    expect(calleesOf(engine?.bodyCalls() ?? [])).toEqual(["isolate_namespace"]);
    expect(other?.name()).toBe("Other");
    expect(other?.bodyCalls()).toEqual([]);
  });

  it("lists none for an adapter that lists none", () => {
    expect(
      factModuleOps("app.rb", source(), { calls: () => [] }).classes(),
    ).toEqual([]);
  });
});
