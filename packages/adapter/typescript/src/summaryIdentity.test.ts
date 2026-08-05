// A summary has to be nameable, or nothing can refer to it. Two copies
// of a service, and a function called the same thing in both, are the
// case this exists for.

import { describe, expect, it } from "vitest";

import { nameSummaries } from "./summaryIdentity.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

function summary(over: {
  name: string;
  file: string;
  start?: number;
  calls?: string[];
  binding?: BehavioralSummary["identity"]["boundaryBinding"];
}): BehavioralSummary {
  const start = over.start ?? 1;
  return {
    kind: "handler",
    location: {
      file: over.file,
      range: { start, end: start + 8 },
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
        effects: (over.calls ?? []).map((callee) => ({
          type: "invocation" as const,
          callee,
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
    // Two summaries agreeing on everything a name is built from.
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
    // The boundary settled it, so nothing had to fall back to the line.
    expect(asRest.identity.id).not.toContain("@10");
  });
});

describe("a call", () => {
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

  it("prefers the summary in its own file", () => {
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

  it("says nothing when two summaries answer to the name", () => {
    const caller = summary({
      name: "handler",
      file: "src/h.ts",
      calls: ["read"],
    });
    const one = summary({ name: "read", file: "src/a.ts" });
    const other = summary({ name: "read", file: "src/b.ts" });

    nameSummaries([caller, one, other], {
      workspace: "svc",
      projectRoot: undefined,
    });

    // A gap a reader can see beats a link that might be wrong.
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
