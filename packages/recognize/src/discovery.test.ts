// The declared discovery reader over a fact database written by hand, so
// each member's reads are pinned without an adapter. The members run over
// TypeScript, Python and Ruby source in the CLI's language tests.

import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { discoverDeclared } from "./discovery.js";
import { factCallOps, factModuleOps, inheritsFrom } from "./factOps.js";
import { imported } from "./ops.js";
import { describeDiscovery } from "./pack.js";

import type {
  DeclaredDiscoveryMatch,
  FactSource,
  ModuleOps,
  ValueForm,
} from "@suss/extractor";
import type { ModuleWritten } from "./factOps.js";

const FILE = "/app/worker.ts";

/** One module's facts: functions, a class tree, an exported object, marks, an element and two calls. */
function moduleFacts(extra: readonly string[][] = []): FactSource {
  const db = new Database();
  for (const [relation, ...row] of extra) {
    db.add(relation ?? "", row);
  }
  const add = (relation: string, ...row: string[]) => db.add(relation, row);
  for (const fn of [
    "handle",
    "real",
    "run",
    "inst",
    "save",
    "inline",
    "App",
    "serve",
    "fetchFn",
    "card",
  ]) {
    add("func", fn);
  }
  add("exportsAs", FILE, "handle", "handle");
  add("exportsAs", FILE, "aliased", "aliasName");
  add("exportsAs", FILE, "Reports", "reportsModule");
  add("objectValue", "reportsModule");
  add("holdsProperty", "reportsModule", "Nightly", "nightly");
  add("objectValue", "nightly");
  add("holdsProperty", "nightly", ".run", "run");
  add("holdsProperty", "nightly", "inst", "inst");
  add("holdsProperty", "nightly", "label", "labelText");
  add("exportsAs", FILE, "Jobs::Weekly", "weekly");
  add("objectValue", "weekly");
  add("holdsProperty", "weekly", ".run", "run");
  add("extends", "nightly", "baseName");
  add("extends", "weekly", "middle");
  add("extends", "middle", "nightlyName");
  add("exportsAs", FILE, "default", "entry");
  add("objectValue", "entry");
  add("holdsProperty", "entry", "fetch", "fetchFn");
  add("writtenEntryAt", "entry", "0", "fetchFn", "value");
  add("holdsProperty", "entry", "other", "serve");
  add("writtenEntryAt", "entry", "1", "serve", "value");
  add("exportsAs", FILE, "Card", "card");
  add("returnsValue", "card", "element");
  add("exportsAs", FILE, "Total", "handle");
  add("marks", FILE, "use server");
  add("marks", "inline", "use server");
  add("marks", "save", "use server");
  add("marks", "handle", "use server");
  add("jsxElement", "element", "tag");
  add("call", "boot", "hooks.register");
  add("readsProperty", "hooks.register", "hooks", "register");
  add("callArg", "boot", "0", "fetchName");
  add("callArg", "boot", "1", "serve");
  add("call", "mount", "hooks.register");
  add("callArg", "mount", "0", "rootName");
  add("callArg", "mount", "1", "element");

  const comesTo: Record<string, string[]> = {
    aliasName: ["real"],
    middle: ["nightly"],
    nightlyName: ["nightly"],
    tag: ["App"],
  };
  const forms: Record<string, ValueForm> = { element: "element" };
  const names: Record<string, string> = {
    fetchName: "fetch",
    rootName: "root",
  };
  return {
    db,
    read: () => undefined,
    writtenAs: () => null,
    anchorCalls: () => [],
    importedFrom: () => false,
    importedAs: (key, module) => {
      if (module === "lib" && key === "baseName") {
        return ["Base"];
      }
      return module === "lib" && key === "hooks" ? ["hooks"] : [];
    },
    shapeOf: (key) => (key === "entry" ? "object" : null),
    textOf: (key) => (key === "tag" ? "App" : key),
    formOf: (key) => forms[key] ?? "other",
    literalOf: () => null,
    nameOf: (key) => names[key] ?? null,
    argOf: () => null,
    comesTo: (key) => comesTo[key] ?? [],
    extendValue: (key, ops) => Object.assign(ops, { ast: () => key }),
  };
}

/** The module, with what the adapter lists about it, less the reads a language leaves unset. */
function moduleOf(
  leaveOut: readonly ("qualifier" | "functions")[] = [],
): ModuleOps {
  const source = moduleFacts();
  const written: ModuleWritten = {
    calls: () =>
      ["boot", "mount"].flatMap((key) => {
        const ops = factCallOps(key, source);
        return ops === null ? [] : [ops];
      }),
  };
  if (!leaveOut.includes("functions")) {
    written.functions = () => [
      { key: "save", assignedName: "save" },
      { key: "inline", assignedName: null },
      { key: "handle", assignedName: "handle" },
    ];
  }
  if (!leaveOut.includes("qualifier")) {
    written.qualifier = "::";
  }
  return factModuleOps(FILE, source, written);
}

/** What a run found, as `kind name at`, with the function each unit is on. */
function found(match: DeclaredDiscoveryMatch, module = moduleOf()): string[] {
  return discoverDeclared(match, "handler", module).map(
    (unit) =>
      `${unit.kind} ${unit.name} ${String(unit.func)} ${unit.foundAt?.join("/") ?? "-"}`,
  );
}

describe("manifest", () => {
  it("finds an export, a name bound to a function, and a class method through a nested class or a whole-path class", () => {
    const units = found({
      type: "manifest",
      entries: (file) =>
        file === FILE
          ? [
              {
                path: ["handle"],
                units: [{ kind: "handler", name: "Orders.handle" }],
              },
              {
                path: ["aliased"],
                units: [{ kind: "handler", name: "Orders.aliased" }],
              },
              {
                path: ["Reports", "Nightly"],
                member: { name: "run", singleton: true },
                units: [{ kind: "worker", name: "Nightly.run" }],
              },
              {
                path: ["Jobs", "Weekly"],
                member: { name: "run", singleton: true },
                units: [{ kind: "worker", name: "Weekly.run" }],
              },
              {
                path: ["Reports", "Nightly"],
                member: { name: "run", singleton: false },
                units: [{ kind: "worker", name: "missing" }],
              },
              {
                path: ["absent"],
                units: [{ kind: "handler", name: "absent" }],
              },
              { path: [], units: [{ kind: "handler", name: "empty" }] },
            ]
          : [],
    });

    expect(units).toEqual([
      "handler Orders.handle handle handle",
      "handler Orders.aliased real aliased",
      "worker Nightly.run run Reports/Nightly/run",
      "worker Weekly.run run Jobs/Weekly/run",
    ]);
  });

  it("finds no whole-path class where the language writes none", () => {
    const units = found(
      {
        type: "manifest",
        entries: () => [
          {
            path: ["Jobs", "Weekly"],
            member: { name: "run", singleton: true },
            units: [{ kind: "worker", name: "Weekly.run" }],
          },
        ],
      },
      moduleOf(["qualifier"]),
    );

    expect(units).toEqual([]);
  });
});

describe("namedExport", () => {
  it("takes the exports a pattern matches, outside skipped files, and only those returning an element when asked", () => {
    expect(found({ type: "namedExport", pattern: "^[A-Z][a-z]" })).toEqual([
      "handler Card card Card",
      "handler Total handle Total",
    ]);
    expect(
      found({
        type: "namedExport",
        pattern: "^[A-Z][a-z]",
        bodyEndsIn: "element",
      }),
    ).toEqual(["handler Card card Card"]);
    expect(
      found({
        type: "namedExport",
        names: ["handle"],
        skipFiles: ["**/worker.*"],
      }),
    ).toEqual([]);
    expect(
      found({ type: "namedExport", names: ["handle"], skipFiles: [] }),
    ).toEqual(["handler handle handle handle"]);
  });

  it("takes every export that settles to a function when the pattern lists no names", () => {
    expect(found({ type: "namedExport" })).toEqual([
      "handler handle handle handle",
      "handler aliased real aliased",
      "handler Card card Card",
      "handler Total handle Total",
    ]);
  });

  it("takes the listed members of the exported object as the units each one says, the first under each name", () => {
    expect(
      found({
        type: "namedExport",
        names: ["default", "handle"],
        members: {
          named: {
            fetch: {
              kind: "handler",
              name: "fetch",
              routeInfo: { method: "*", path: null },
            },
          },
        },
      }),
    ).toEqual(["handler fetch fetchFn default/fetch"]);
  });
});

describe("subclassOf", () => {
  it("takes the members of one kind of a class whose ancestry reaches the base, through a class between", () => {
    const inherits = { from: ["lib"], named: ["Base"] };
    expect(
      found({ type: "subclassOf", inherits, members: { kind: "singleton" } }),
    ).toEqual(["handler Jobs::Weekly.run run Jobs::Weekly/run"]);
    expect(
      found({
        type: "subclassOf",
        inherits,
        members: { kind: "instance", pattern: "^in" },
      }),
    ).toEqual([]);
    expect(
      found({
        type: "subclassOf",
        inherits: { from: ["lib"], named: ["Other"] },
        members: { kind: "singleton" },
      }),
    ).toEqual([]);
  });

  it("reads the ancestry once per class, so a loop ends", () => {
    const source = moduleFacts([["extends", "loopA", "loopB"]]);
    const looped: FactSource = {
      ...source,
      comesTo: (key) => (key === "loopB" ? ["loopA"] : []),
    };
    expect(
      inheritsFrom("loopA", { from: ["lib"], named: ["Base"] }, looped),
    ).toBe(false);
  });

  it("reads the members of a class nested in a module", () => {
    const nested = moduleOf().export(["Reports", "Nightly"]);
    expect(
      nested
        ?.asClass?.()
        ?.members("instance")
        .map((m) => m.name),
    ).toEqual(["inst"]);
    expect(
      nested?.asClass?.()?.inherits({ from: ["lib"], named: ["Base"] }),
    ).toBe(true);
    expect(moduleOf().export(["handle"])?.asClass?.()).toBeNull();
  });
});

describe("marked", () => {
  it("takes the exported functions of a marked module and each marked function, by its name or a count", () => {
    expect(
      found({
        type: "marked",
        word: "use server",
        scopes: ["module", "function"],
        name: ["assignedName", "countInFile"],
        countedAs: "serverAction",
      }),
    ).toEqual([
      "handler handle handle handle",
      "handler aliased real aliased",
      "handler Card card Card",
      "handler save save -",
      "handler serverAction#0 inline -",
    ]);
  });

  it("counts every function when the pattern names none, and leaves out one no rule names", () => {
    const counted = {
      type: "marked" as const,
      word: "use server",
      scopes: ["function"] as const,
      countedAs: "action",
    };
    expect(found({ ...counted, name: ["countInFile"] })).toEqual([
      "handler action#0 save -",
      "handler action#1 inline -",
      "handler action#2 handle -",
    ]);
    expect(found({ ...counted, name: ["assignedName"] })).toEqual([
      "handler save save -",
      "handler handle handle -",
    ]);
  });

  it("finds nothing where the language lists no functions and the module is not marked", () => {
    expect(
      found(
        {
          type: "marked",
          word: "use client",
          scopes: ["module", "function"],
          name: ["assignedName"],
          countedAs: "x",
        },
        moduleOf(["functions"]),
      ),
    ).toEqual([]);
  });

  it("reads only the module's mark when the pattern leaves function scope out, and a function's mark off its value", () => {
    expect(
      found({
        type: "marked",
        word: "use server",
        scopes: ["module"],
        name: ["countInFile"],
        countedAs: "x",
      }),
    ).toEqual([
      "handler handle handle handle",
      "handler aliased real aliased",
      "handler Card card Card",
    ]);
    const module = moduleOf();
    expect(module.export(["handle"])?.marked?.("use server")).toBe(true);
    expect(module.export(["aliased"])?.marked?.("use server")).toBe(false);
    expect(module.export(["Reports"])?.marked?.("use server")).toBe(false);
    expect(
      module.markedFunctions("use server").map((one) => one.assignedName),
    ).toEqual(["save", null, "handle"]);
  });
});

describe("registeredFunction", () => {
  const start = imported({ from: ["lib"], named: ["hooks"] });

  it("takes the function a call hands over, under the name the call states, or the tag of an element", () => {
    expect(
      found({
        type: "registeredFunction",
        start,
        method: "register",
        handler: { at: 1 },
        nameAt: { at: 0, named: { fetch: { kind: "handler", name: "fetch" } } },
      }),
    ).toEqual(["handler fetch serve -"]);
    expect(
      found({
        type: "registeredFunction",
        start,
        method: "register",
        handler: { at: 1, through: "element" },
      }),
    ).toEqual(["handler App App -"]);
  });

  it("matches a callee that is the start itself, and nothing under another method", () => {
    expect(
      found({ type: "registeredFunction", start, handler: { at: 1 } }),
    ).toEqual([]);
    expect(
      found({
        type: "registeredFunction",
        start,
        method: "mount",
        handler: { at: 1 },
      }),
    ).toEqual([]);
  });
});

describe("the pack health report", () => {
  it("counts a manifest's entries as a function link and every other field as data", () => {
    expect(
      describeDiscovery({
        kind: "handler",
        match: { type: "manifest", entries: () => [] },
      }),
    ).toEqual({
      name: "manifest",
      dataLinks: 0,
      functionLinks: ["entries"],
      astLinks: [],
      example: null,
    });
    expect(
      describeDiscovery({
        kind: "component",
        match: {
          type: "namedExport",
          pattern: "^[A-Z]",
          bodyEndsIn: "element",
        },
      }),
    ).toEqual({
      name: "namedExport",
      dataLinks: 2,
      functionLinks: [],
      astLinks: [],
      example: null,
    });
  });
});
