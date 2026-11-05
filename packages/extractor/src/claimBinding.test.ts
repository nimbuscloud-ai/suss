import { describe, expect, it } from "vitest";

import {
  functionCallBinding,
  messageBusBinding,
  moduleExportBinding,
  restBinding,
} from "@suss/behavioral-ir";

import { claimBinding } from "./claimBinding.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

/** A parent with only what a claim's binding is decided from. */
function parent(
  kind: BehavioralSummary["kind"],
  boundaryBinding: BoundaryBinding | null,
): BehavioralSummary {
  return {
    kind,
    location: { file: "x.ts", range: { start: 0, end: 1 }, exportName: null },
    identity: { name: "parent", exportPath: null, boundaryBinding },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

const REACHABLE = functionCallBinding({
  transport: "in-process",
  recognition: "reachable",
});

const ROUTE = restBinding({
  transport: "http",
  method: "GET",
  path: "/later",
  recognition: "express",
});

const COMPONENT = functionCallBinding({
  transport: "in-process",
  recognition: "react",
});

describe("claimBinding", () => {
  it("makes a timer callback in a route handler internal code, not a client of the route", () => {
    expect(
      claimBinding(parent("handler", ROUTE), "scheduled-callback"),
    ).toEqual(REACHABLE);
  });

  it("does not let a claim that serves take a route or a channel its parent serves", () => {
    const channel = messageBusBinding({
      messageBus: "bullmq",
      channel: "email",
      recognition: "bullmq",
    });

    expect(claimBinding(parent("handler", ROUTE), "handler")).toEqual(
      REACHABLE,
    );
    expect(claimBinding(parent("worker", channel), "handler")).toEqual(
      REACHABLE,
    );
  });

  it("gives an event handler in a component the component's binding", () => {
    expect(claimBinding(parent("component", COMPONENT), "handler")).toBe(
      COMPONENT,
    );
  });

  it("does not make a callback a component schedules a caller of the component", () => {
    expect(
      claimBinding(parent("component", COMPONENT), "scheduled-callback"),
    ).toEqual(REACHABLE);
  });

  it("does not give a claim an export another module calls its parent by", () => {
    const exported = moduleExportBinding({
      recognition: "module",
      module: "store",
      exportName: "enqueue",
    });

    expect(claimBinding(parent("library", exported), "handler")).toEqual(
      REACHABLE,
    );
    expect(
      claimBinding(parent("library", exported), "scheduled-callback"),
    ).toEqual(REACHABLE);
  });

  it("makes a claim under a caller internal code", () => {
    const call = restBinding({
      transport: "http",
      method: "POST",
      path: "/generations",
      recognition: "fetch",
    });

    expect(claimBinding(parent("client", call), "scheduled-callback")).toEqual(
      REACHABLE,
    );
  });

  it("gives no binding under a parent that has none", () => {
    expect(claimBinding(parent("handler", null), "handler")).toBeNull();
  });
});
