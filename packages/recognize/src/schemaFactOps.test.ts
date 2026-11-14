import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import {
  type FactSource,
  factCallOps,
  factReadOps,
  factValueOps,
} from "./factOps.js";
import { global, handedIn, readOff } from "./ops.js";

import type { CallOps } from "@suss/extractor";

const DEFAULTED = {
  calls: ["default", "optional"],
  options: ["default", "devDefault"],
};

/**
 * The facts for a parse whose schema writes each key a different way,
 * the comment above each key's rows saying how, then a helper whose
 * function writes calls in its body and in a function inside it:
 *
 *   import { optional as opt, cleanEnv as load } from "lib";
 *   load(env, { PORT: ..., NAME: ..., ... });
 *   function helper() { inner(); const f = () => nested(); }
 *   helper();
 *
 * Keys are spelled after what they are.
 */
function schema(
  over: Partial<FactSource> = {},
  more: readonly (readonly [string, ...string[]])[] = [],
): FactSource {
  const db = new Database();
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  for (const [relation, ...row] of more) {
    add(relation, ...row);
  }
  add("call", "load()", "load");
  add("binds", "load", "load#decl");
  add("imports", "load#decl", "lib", "cleanEnv");
  add("callArg", "load()", "0", "env");
  add("callArg", "load()", "1", "shape");
  add("objectValue", "shape");

  const keys = [
    "PORT",
    "NAME",
    "QUEUE",
    "HOOK",
    "LATE",
    "EITHER",
    "KEYED",
    "PLAIN",
    "NESTED",
    "TWICE",
  ];
  keys.forEach((name, at) => {
    add("holdsProperty", "shape", name, name);
    add("writtenEntryAt", "shape", String(at), name, "value");
  });

  // PORT: z.string().default(8080)
  add("call", "PORT", "PORT.default");
  add("readsProperty", "PORT.default", "z.string()", "default");
  add("call", "z.string()", "z.string");
  add("readsProperty", "z.string", "z", "string");
  // NAME: opt(str()), where opt is imported as `optional`
  add("call", "NAME", "opt");
  add("binds", "opt", "opt#decl");
  add("imports", "opt#decl", "lib", "optional");
  add("callArg", "NAME", "0", "str()");
  add("call", "str()", "str");
  // QUEUE: str({ devDefault: "q" })
  add("call", "QUEUE", "str");
  add("callArg", "QUEUE", "0", "options");
  add("holdsProperty", "options", "devDefault", "q");
  // HOOK: () => z.string().default()
  add("func", "HOOK");
  // LATE: z.string().transform((v) => v.default())
  add("call", "LATE", "LATE.transform");
  add("readsProperty", "LATE.transform", "z.string()", "transform");
  add("callArg", "LATE", "0", "arrow");
  add("func", "arrow");
  add("makesCall", "arrow", "v.default()");
  // EITHER: flag ? str() : z.string().optional()
  add("conditionalBranch", "EITHER", "str()");
  add("conditionalBranch", "EITHER", "optionalCall");
  add("call", "optionalCall", "optionalCall.optional");
  add("readsProperty", "optionalCall.optional", "z.string()", "optional");
  // KEYED: Field(default=1), the way Python passes an option
  add("call", "KEYED", "Field");
  add("callKeywordArg", "KEYED", "default", "one");
  // PLAIN: str()
  add("call", "PLAIN", "str");
  // NESTED: str({ choices: z.string().optional() })
  add("call", "NESTED", "str");
  add("callArg", "NESTED", "0", "nestedOptions");
  add("holdsProperty", "nestedOptions", "choices", "optionalCall");
  // TWICE: both(value, value)
  add("call", "TWICE", "both");
  add("callArg", "TWICE", "0", "value");
  add("callArg", "TWICE", "1", "value");

  // helper(), and the function it reaches. `f` is written inside both
  // `helper` and `g`, which `helper` writes too.
  add("func", "helper#fn");
  add("makesCall", "helper#fn", "file.ts:40-47");
  add("containsFn", "helper#fn", "f#fn");
  add("containsFn", "helper#fn", "g#fn");
  add("func", "g#fn");
  add("containsFn", "g#fn", "f#fn");
  add("func", "f#fn");
  add("makesCall", "f#fn", "file.ts:60-68");
  add("makesCall", "f#fn", "file.ts:20-28");
  add("call", "file.ts:40-47", "inner");
  add("call", "file.ts:60-68", "nested");
  add("call", "file.ts:20-28", "early");
  add("call", "helperCall", "helper");

  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: () => [],
    shapeOf: (key) => (key === "shape" || key === "options" ? "object" : null),
    textOf: (key) => key,
    literalOf: () => null,
    nameOf: () => null,
    argOf: () => null,
    comesTo: (key) => (key === "helper" ? ["helper#fn"] : []),
    ...over,
  };
}

/** Whether each key's schema mentions one of the defaulting words. */
function defaultedKeys(from: FactSource): Record<string, boolean> {
  const shape = factValueOps("shape", from);
  return Object.fromEntries(
    shape
      .entries("nothing")
      .map((entry) => [entry.key, entry.value.mentions?.(DEFAULTED) ?? false]),
  );
}

function callAt(key: string, from: FactSource): CallOps {
  const ops = factCallOps(key, from);
  if (ops === null) {
    throw new Error(`no call at ${key}`);
  }
  return ops;
}

describe("whether a value mentions a call or an option", () => {
  it("finds a method, an imported name, an option, a keyword and a branch, and goes into no function", () => {
    expect(defaultedKeys(schema())).toEqual({
      PORT: true,
      NAME: true,
      QUEUE: true,
      HOOK: false,
      LATE: false,
      EITHER: true,
      KEYED: true,
      PLAIN: false,
      NESTED: true,
      TWICE: false,
    });
  });
});

describe("the calls a call's callee writes", () => {
  it("lists the calls in the function and the functions inside it, in source order", () => {
    const calls = callAt("helperCall", schema()).callsInCallee?.() ?? [];
    expect(calls.map((one) => one.calleeText())).toEqual([
      "early",
      "inner",
      "nested",
    ]);
  });

  it("lists none for a callee that is no function", () => {
    expect(callAt("load()", schema()).callsInCallee?.()).toEqual([]);
  });

  it("asks the adapter when it works the calls out itself", () => {
    const own = callAt("PLAIN", schema());
    const from = schema({ callsInCallee: () => [own] });
    expect(callAt("helperCall", from).callsInCallee?.()).toEqual([own]);
  });
});

describe("the export a file's own import binds a callee to", () => {
  it("reads it off the imports the callee binds to", () => {
    expect(callAt("load()", schema()).calleeImport?.(["lib"])).toBe("cleanEnv");
    expect(callAt("load()", schema()).calleeImport?.(["other"])).toBeNull();
    expect(callAt("PLAIN", schema()).calleeImport?.(["lib"])).toBeNull();
  });

  it("asks the adapter when it reads the import itself, leaving out the module as a whole", () => {
    const from = schema({ importedUnder: () => ["*", "parseEnv"] });
    expect(callAt("load()", from).calleeImport?.(["lib"])).toBe("parseEnv");
    const two = schema({ importedUnder: () => ["a", "b"] });
    expect(callAt("load()", two).calleeImport?.(["lib"])).toBeNull();
  });
});

describe("the path among a runtime object's that a value is", () => {
  const ENVIRONMENT = global("process.env", "import.meta.env");

  it("is the path the value is spelled as, or the first one the rules followed into it", () => {
    const from = schema({
      spellsGlobal: (key, path) =>
        key === "spelled" && path === "import.meta.env",
      globalsReaching: (key) => (key === "env" ? ["process.env"] : []),
    });
    expect(factValueOps("spelled", from).runtimePath?.(ENVIRONMENT)).toBe(
      "import.meta.env",
    );
    expect(factValueOps("env", from).runtimePath?.(ENVIRONMENT)).toBe(
      "process.env",
    );
    expect(
      factValueOps("shape", from).runtimePath?.(ENVIRONMENT),
    ).toBeUndefined();
  });

  it("is the handed-in name for a value the parameter is", () => {
    const from = schema({}, [["handedIn", "env", "bindings"]]);
    expect(factValueOps("env", from).runtimePath?.(handedIn("bindings"))).toBe(
      "bindings",
    );
    expect(
      factValueOps("shape", from).runtimePath?.(handedIn("bindings")),
    ).toBeUndefined();
    expect(
      factValueOps("env", schema()).runtimePath?.(handedIn("bindings")),
    ).toBeUndefined();
  });

  it("finds no member read off it behind a call with no receiver", () => {
    expect(
      callAt("load()", schema()).receiverIsFrom(readOff(handedIn("bindings"))),
    ).toBe(false);
  });

  it("is what the adapter works out, when it does", () => {
    const from = schema({ runtimePathOf: () => "process.env" });
    expect(factValueOps("shape", from).runtimePath?.(ENVIRONMENT)).toBe(
      "process.env",
    );
  });
});

describe("the call a read site is", () => {
  it("is the call the facts state at the site, or none", () => {
    const from = schema();
    expect(factReadOps("load()", from).call?.()?.calleeText()).toBe("load");
    expect(factReadOps("shape", from).call?.()).toBeNull();
  });

  it("is the adapter's own ops when it builds them, asked for once", () => {
    let built = 0;
    const own = callAt("PLAIN", schema());
    const from = schema({
      callAt: () => {
        built += 1;
        return own;
      },
    });
    const site = factReadOps("load()", from);
    expect(site.call?.()).toBe(own);
    expect(site.call?.()).toBe(own);
    expect(built).toBe(1);
  });
});
