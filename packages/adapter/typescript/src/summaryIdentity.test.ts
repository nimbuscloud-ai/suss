/**
 * A summary needs a name of its own, or nothing can point at it. The
 * case this exists for is two copies of a service in one repository,
 * each with a function of the same name.
 */

import { describe, expect, it } from "vitest";

import { nameSummaries } from "./summaryIdentity.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

type DeclaredAt = { file: string; span: { start: number; end: number } };
type Call = string | { callee: string; declaredAt: DeclaredAt };

function summary(over: {
  name: string;
  file: string;
  start?: number;
  calls?: Call[];
  binding?: BehavioralSummary["identity"]["boundaryBinding"];
}): BehavioralSummary {
  const start = over.start ?? 1;
  return {
    kind: "handler",
    location: {
      file: over.file,
      range: { start, end: start + 8 },
      span: { start: start * 10, end: start * 10 + 80 },
      exportName: over.name,
    },
    identity: {
      name: over.name,
      exportPath: [over.name],
      boundaryBinding: over.binding ?? null,
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

const callsOf = (summary: BehavioralSummary) =>
  summary.transitions.flatMap((t) =>
    t.effects.flatMap((e) =>
      e.type === "invocation" ? [{ callee: e.callee, reaches: e.summary }] : [],
    ),
  );

describe("naming a summary", () => {
  it("tells two copies of one service apart", () => {
    const a = summary({ name: "handler", file: "src/h.ts" });
    const b = summary({ name: "handler", file: "src/h.ts" });

    nameSummaries([a], { workspace: "svc-a", projectRoot: undefined });
    nameSummaries([b], { workspace: "svc-b", projectRoot: undefined });

    expect(a.identity.id).toBe("svc-a::src/h.ts::handler");
    expect(b.identity.id).toBe("svc-b::src/h.ts::handler");
    expect(a.location.workspace).toBe("svc-a");
  });

  it("gives everything in one run a name of its own", () => {
    // These two agree on every part a name is built from.
    const first = summary({ name: "read", file: "src/a.ts", start: 10 });
    const second = summary({ name: "read", file: "src/a.ts", start: 40 });

    nameSummaries([first, second], {
      workspace: "svc",
      projectRoot: undefined,
    });

    expect(first.identity.id).not.toBe(second.identity.id);
  });

  it("tells apart what a function consumes before reaching for its line", () => {
    const asRest = summary({
      name: "read",
      file: "src/a.ts",
      start: 10,
      binding: {
        transport: "http",
        semantics: { name: "rest", method: "GET", path: "/a" },
        recognition: "test",
      },
    });
    const asOther = summary({
      name: "read",
      file: "src/a.ts",
      start: 10,
      binding: {
        transport: "http",
        semantics: { name: "rest", method: "POST", path: "/b" },
        recognition: "test",
      },
    });

    nameSummaries([asRest, asOther], {
      workspace: "svc",
      projectRoot: undefined,
    });

    expect(asRest.identity.id).not.toBe(asOther.identity.id);
    // The boundary told them apart, so neither had to fall back to
    // the line number.
    expect(asRest.identity.id).not.toContain("@10");
  });
});

const declaredAt = (of: BehavioralSummary): DeclaredAt => ({
  file: of.location.file,
  span: of.location.span as { start: number; end: number },
});

describe("a call the checker placed", () => {
  it("names the summary declared where the checker looked", () => {
    const called = summary({ name: "read", file: "src/store.ts", start: 30 });
    // Same name, same file as the caller: the old answer.
    const nearby = summary({ name: "read", file: "src/h.ts", start: 30 });
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: [{ callee: "store.read", declaredAt: declaredAt(called) }],
    });

    nameSummaries([caller, called, nearby], {
      workspace: "svc",
      projectRoot: undefined,
    });

    expect(callsOf(caller)).toEqual([
      { callee: "store.read", reaches: "svc::src/store.ts::read" },
    ]);
  });

  it("links nothing when the callee is declared outside the run", () => {
    // A function named push in the project is not Array.prototype.push.
    const push = summary({ name: "push", file: "src/h.ts", start: 30 });
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: [
        {
          callee: "items.push",
          declaredAt: {
            file: "/node_modules/typescript/lib/lib.es5.d.ts",
            span: { start: 1, end: 2 },
          },
        },
      ],
    });

    nameSummaries([caller, push], {
      workspace: "svc",
      projectRoot: undefined,
    });

    expect(callsOf(caller)).toEqual([
      { callee: "items.push", reaches: undefined },
    ]);
  });

  it("leaves the declaration out of what it writes", () => {
    const called = summary({ name: "read", file: "src/store.ts", start: 30 });
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: [{ callee: "read", declaredAt: declaredAt(called) }],
    });

    nameSummaries([caller, called], {
      workspace: "svc",
      projectRoot: undefined,
    });

    const effect = caller.transitions[0]?.effects[0];
    expect(effect).not.toHaveProperty("declaredAt");
  });
});

describe("a call the checker could not place", () => {
  it("names the summary it reaches", () => {
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: ["loadAccount"],
    });
    const called = summary({
      name: "loadAccount",
      file: "src/h.ts",
      start: 30,
    });

    nameSummaries([caller, called], {
      workspace: "svc",
      projectRoot: undefined,
    });

    expect(callsOf(caller)).toEqual([
      { callee: "loadAccount", reaches: "svc::src/h.ts::loadAccount" },
    ]);
  });

  it("looks only in its own file", () => {
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: ["read"],
    });
    const near = summary({ name: "read", file: "src/h.ts", start: 30 });
    const far = summary({ name: "read", file: "src/other.ts" });

    nameSummaries([caller, near, far], {
      workspace: "svc",
      projectRoot: undefined,
    });

    expect(callsOf(caller)[0]?.reaches).toBe(near.identity.id);
  });

  it("does not reach across files for a name", () => {
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: ["read"],
    });
    const far = summary({ name: "read", file: "src/other.ts" });

    nameSummaries([caller, far], {
      workspace: "svc",
      projectRoot: undefined,
    });

    // Any file in the run can define a `read`, and nothing about the
    // call says which one it meant.
    expect(callsOf(caller)).toEqual([{ callee: "read", reaches: undefined }]);
  });

  it("says nothing when two summaries in its file answer to the name", () => {
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: ["read"],
    });
    const one = summary({ name: "read", file: "src/h.ts", start: 30 });
    const other = summary({ name: "read", file: "src/h.ts", start: 60 });

    nameSummaries([caller, one, other], {
      workspace: "svc",
      projectRoot: undefined,
    });

    // Leaving the link out is better than pointing at the wrong one,
    // because a reader can see a gap and cannot see a mistake.
    expect(callsOf(caller)).toEqual([{ callee: "read", reaches: undefined }]);
  });

  it("reads a method call by the function on the end of it", () => {
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: ["store.read"],
    });
    const called = summary({ name: "read", file: "src/h.ts", start: 30 });

    nameSummaries([caller, called], {
      workspace: "svc",
      projectRoot: undefined,
    });

    expect(callsOf(caller)[0]?.reaches).toBe(called.identity.id);
  });
});
