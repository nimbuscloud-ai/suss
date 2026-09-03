/**
 * A call an adapter placed links to the summary declared there, by
 * location and nothing else, so the same step serves every language.
 */

import { describe, expect, it } from "vitest";

import {
  declarationKey,
  linkCallsToSummaries,
  placeCalls,
} from "./callLinks.js";

import type { DeclaredAt } from "./callLinks.js";
import type { BehavioralSummary } from "./index.js";

type Call =
  | string
  | {
      callee: string;
      declaredAt?: DeclaredAt;
      argsDeclaredAt?: Record<string, DeclaredAt>;
    };

function summary(over: {
  name: string;
  file: string;
  id?: string;
  start?: number;
  calls?: Call[];
  nameKind?: BehavioralSummary["identity"]["nameKind"];
  kind?: BehavioralSummary["kind"];
}): BehavioralSummary {
  const start = over.start ?? 1;
  return {
    kind: over.kind ?? "handler",
    location: {
      file: over.file,
      range: { start, end: start + 8 },
      span: { start: start * 10, end: start * 10 + 80 },
      exportName: over.name,
    },
    identity: {
      ...(over.id === undefined ? {} : { id: over.id }),
      name: over.name,
      ...(over.nameKind === undefined ? {} : { nameKind: over.nameKind }),
      exportPath: [over.name],
      boundaryBinding: null,
    },
    inputs: [],
    transitions: [
      {
        id: "t1",
        conditions: [],
        output: { type: "void" },
        effects: (over.calls ?? []).map((call) => ({
          type: "invocation" as const,
          ...(typeof call === "string" ? { callee: call } : call),
          args: [],
          async: false,
        })),
        location: { start, end: start + 8 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

const declaredAt = (of: BehavioralSummary): DeclaredAt => ({
  file: of.location.file,
  span: of.location.span as { start: number; end: number },
});

const callsOf = (summary: BehavioralSummary) =>
  summary.transitions.flatMap((t) =>
    t.effects.flatMap((e) =>
      e.type === "invocation" ? [{ callee: e.callee, reaches: e.summary }] : [],
    ),
  );

const argEffectOf = (summary: BehavioralSummary) =>
  summary.transitions[0]?.effects[0];

describe("linkCallsToSummaries", () => {
  it("links a placed call to the summary declared there", () => {
    const called = summary({
      name: "read",
      file: "src/store.py",
      id: "svc::src/store.py::read",
      start: 30,
    });
    const nearby = summary({ name: "read", file: "src/h.py", start: 30 });
    const caller = summary({
      name: "handler",
      file: "src/h.py",
      calls: [{ callee: "store.read", declaredAt: declaredAt(called) }],
    });

    linkCallsToSummaries([caller, called, nearby]);

    expect(callsOf(caller)).toEqual([
      { callee: "store.read", reaches: "svc::src/store.py::read" },
    ]);
    expect(caller.transitions[0]?.effects[0]).not.toHaveProperty("declaredAt");
  });

  it("names a summary without an id by its file and export path", () => {
    const called = summary({ name: "read", file: "src/store.py", start: 30 });
    const caller = summary({
      name: "handler",
      file: "src/h.py",
      calls: [{ callee: "read", declaredAt: declaredAt(called) }],
    });

    linkCallsToSummaries([caller, called]);

    expect(callsOf(caller)[0]?.reaches).toBe("src/store.py::read");
  });

  it("links to a provider when one body has several summaries", () => {
    // One function, exported through two packages and calling out to a
    // third: a consumer reading and two provider readings, all at one place.
    const asConsumer = summary({
      name: "read",
      file: "src/store.ts",
      id: "@ex/db::src/store.ts::read",
      start: 30,
      kind: "caller",
    });
    const asInner = summary({
      name: "read",
      file: "src/store.ts",
      id: "@ex/inner::src/store.ts::read",
      start: 30,
      kind: "library",
    });
    const asOuter = summary({
      name: "read",
      file: "src/store.ts",
      id: "@ex/outer::src/store.ts::read",
      start: 30,
      kind: "library",
    });
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: [{ callee: "read", declaredAt: declaredAt(asInner) }],
    });

    linkCallsToSummaries([caller, asConsumer, asInner, asOuter]);

    expect(callsOf(caller)).toEqual([
      { callee: "read", reaches: "@ex/inner::src/store.ts::read" },
    ]);
  });

  it("links to the first summary at a place when none is a provider", () => {
    const first = summary({
      name: "read",
      file: "src/store.ts",
      id: "one",
      start: 30,
      kind: "caller",
    });
    const second = summary({
      name: "read",
      file: "src/store.ts",
      id: "two",
      start: 30,
      kind: "caller",
    });
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: [{ callee: "read", declaredAt: declaredAt(first) }],
    });

    linkCallsToSummaries([caller, first, second]);

    expect(callsOf(caller)).toEqual([{ callee: "read", reaches: "one" }]);
  });

  it("falls back to a same-file name for a call nobody placed", () => {
    const caller = summary({
      name: "handler",
      file: "src/h.py",
      calls: ["load"],
    });
    const near = summary({ name: "load", file: "src/h.py", start: 30 });
    const far = summary({ name: "load", file: "src/other.py" });

    linkCallsToSummaries([caller, near, far]);

    expect(callsOf(caller)[0]?.reaches).toBe("src/h.py::load");
  });

  it("never links a call to a label", () => {
    const caller = summary({
      name: "handler",
      file: "src/h.py",
      calls: ["all"],
    });
    const label = summary({
      name: "all",
      file: "src/h.py",
      start: 30,
      nameKind: "label",
    });

    linkCallsToSummaries([caller, label]);

    expect(callsOf(caller)).toEqual([{ callee: "all", reaches: undefined }]);
  });

  it("leaves an effect that is not a call as it was", () => {
    const caller = summary({ name: "handler", file: "src/h.py" });
    const read = {
      type: "interaction" as const,
      interaction: {
        class: "storage-access" as const,
        target: { system: "postgresql", collection: "orders" },
        operation: "read" as const,
      },
      target: "orders",
      operation: "read",
    };
    caller.transitions[0]?.effects.push(read as never);

    linkCallsToSummaries([caller]);

    expect(caller.transitions[0]?.effects).toEqual([read]);
  });

  it("links an argument that is itself a project function to the summary declared there", () => {
    const handler = summary({
      name: "recordMountStatement",
      file: "src/routers.py",
      id: "svc::src/routers.py::recordMountStatement",
      start: 30,
    });
    const caller = summary({
      name: "collectMounts",
      file: "src/routers.py",
      calls: [
        {
          callee: "walkStatements",
          argsDeclaredAt: { "3": declaredAt(handler) },
        },
      ],
    });

    linkCallsToSummaries([caller, handler]);

    expect(argEffectOf(caller)).toMatchObject({
      argsSummary: { "3": "svc::src/routers.py::recordMountStatement" },
    });
    expect(argEffectOf(caller)).not.toHaveProperty("argsDeclaredAt");
  });

  it("drops argsDeclaredAt with no argsSummary when nothing here is declared there", () => {
    const caller = summary({
      name: "collectMounts",
      file: "src/routers.py",
      calls: [
        {
          callee: "walkStatements",
          argsDeclaredAt: {
            "3": {
              file: "node_modules/lib/index.d.ts",
              span: { start: 0, end: 1 },
            },
          },
        },
      ],
    });

    linkCallsToSummaries([caller]);

    const effect = argEffectOf(caller);
    expect(effect).not.toHaveProperty("argsDeclaredAt");
    expect(effect).not.toHaveProperty("argsSummary");
  });

  it("spells a declaration key by file and offsets", () => {
    expect(declarationKey("src/h.py", { start: 3, end: 9 })).toBe(
      "src/h.py:3-9",
    );
  });
});

describe("placeCalls", () => {
  it("writes declaredAt on the invocation effect a target names", () => {
    const caller = summary({
      name: "handler",
      file: "src/h.py",
      calls: ["orders_for", "untouched"],
    });
    const target = { file: "src/service.py", span: { start: 40, end: 48 } };

    placeCalls(caller, new Map([["orders_for", target]]));

    const effects = caller.transitions[0]?.effects ?? [];
    expect(effects[0]).toMatchObject({
      callee: "orders_for",
      declaredAt: target,
    });
    expect(effects[1]).not.toHaveProperty("declaredAt");
  });

  it("does nothing when there are no targets for this summary", () => {
    const caller = summary({ name: "handler", file: "src/h.py", calls: ["x"] });

    placeCalls(caller, undefined);

    expect(caller.transitions[0]?.effects[0]).not.toHaveProperty("declaredAt");
  });

  it("leaves an effect that is not a call untouched", () => {
    const caller = summary({ name: "handler", file: "src/h.py" });
    const read = {
      type: "interaction" as const,
      interaction: {
        class: "storage-access" as const,
        target: { system: "postgresql", collection: "orders" },
        operation: "read" as const,
      },
      target: "orders",
      operation: "read",
    };
    caller.transitions[0]?.effects.push(read as never);

    placeCalls(
      caller,
      new Map([["read", { file: "x", span: { start: 0, end: 1 } }]]),
    );

    expect(caller.transitions[0]?.effects).toEqual([read]);
  });
});
