import { describe, expect, it } from "vitest";

import {
  type CarriesPayload,
  checkReceivedInput,
  compareSupplied,
  formatPath,
  readSetOf,
} from "./inputContract.js";

import type { BehavioralSummary, Input } from "@suss/behavioral-ir";

const arrivesAsEvent: CarriesPayload = (input) =>
  input.type === "parameter" && input.role === "event";

function parameter(name: string, role: string | null, position = 0): Input {
  return { type: "parameter", name, position, role, shape: null };
}

function receiver(opts: {
  inputs: Input[];
  reads?: Array<{ input: string; path: string[] }>;
}): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "src/worker.ts",
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: { name: "worker", exportPath: null, boundaryBinding: null },
    inputs: opts.inputs,
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...(opts.reads !== undefined ? { inputReads: opts.reads } : {}),
  };
}

/** An object literal the way an adapter records a call argument. */
function sent(fields: Record<string, unknown>): unknown {
  return { kind: "object", fields };
}

const NAME = { kind: "identifier", name: "x" };

describe("readSetOf", () => {
  it("gives the path from the payload's root for a read off the event", () => {
    const result = readSetOf(
      receiver({
        inputs: [parameter("message", "event")],
        reads: [{ input: "message", path: ["data", "invoiceId"] }],
      }),
      arrivesAsEvent,
    );
    expect(result).toEqual({
      read: true,
      reads: { paths: [["data", "invoiceId"]], rootedAtPayload: false },
    });
  });

  it("puts a destructured parameter's role first, not the renamed binding", () => {
    const result = readSetOf(
      receiver({
        inputs: [parameter("labelText", "label")],
        reads: [{ input: "labelText", path: [] }],
      }),
      arrivesAsEvent,
    );
    expect(result).toEqual({
      read: true,
      reads: { paths: [["label"]], rootedAtPayload: true },
    });
  });

  it("declines when the summary recorded no reads", () => {
    const result = readSetOf(
      receiver({ inputs: [parameter("message", "event")] }),
      arrivesAsEvent,
    );
    expect(result).toEqual({ read: false, reason: "no-reads" });
  });

  it("declines when a rest parameter could be consuming anything", () => {
    const result = readSetOf(
      receiver({
        inputs: [parameter("message", "event"), parameter("rest", "rest", 1)],
        reads: [{ input: "message", path: ["data"] }],
      }),
      arrivesAsEvent,
    );
    expect(result).toEqual({ read: false, reason: "rest-parameter" });
  });

  it("declines when the payload is used whole and could be forwarded", () => {
    const result = readSetOf(
      receiver({
        inputs: [parameter("message", "event")],
        reads: [
          { input: "message", path: ["data", "invoiceId"] },
          { input: "message", path: [] },
        ],
      }),
      arrivesAsEvent,
    );
    expect(result).toEqual({ read: false, reason: "payload-used-whole" });
  });

  it("declines when every read came through an input it cannot place", () => {
    const result = readSetOf(
      receiver({
        inputs: [parameter("message", "event")],
        reads: [{ input: "somethingElse", path: ["id"] }],
      }),
      arrivesAsEvent,
    );
    expect(result).toEqual({ read: false, reason: "no-reads" });
  });
});

describe("compareSupplied", () => {
  const readsInvoiceId = {
    paths: [["data", "invoiceId"]],
    rootedAtPayload: false,
  };

  it("reports a nested path the sender does not set", () => {
    const result = compareSupplied(readsInvoiceId, [
      sent({ subject: NAME, data: sent({ id: NAME }) }),
    ]);
    expect(result).toEqual({
      compared: true,
      unsupplied: [["data", "invoiceId"]],
    });
  });

  it("reports nothing when the sender sets the path", () => {
    const result = compareSupplied(readsInvoiceId, [
      sent({ subject: NAME, data: sent({ invoiceId: NAME }) }),
    ]);
    expect(result).toEqual({ compared: true, unsupplied: [] });
  });

  it("takes one sender out of several as enough", () => {
    const result = compareSupplied(readsInvoiceId, [
      sent({ data: sent({ id: NAME }) }),
      sent({ data: sent({ invoiceId: NAME }) }),
    ]);
    expect(result).toEqual({ compared: true, unsupplied: [] });
  });

  it("treats a value it cannot see into as supplying what is asked of it", () => {
    const result = compareSupplied(readsInvoiceId, [
      sent({ data: { kind: "call", callee: "buildData", args: [] } }),
    ]);
    expect(result).toEqual({ compared: true, unsupplied: [] });
  });

  it("declines when one sender's whole value cannot be read into", () => {
    const result = compareSupplied(readsInvoiceId, [
      sent({ data: sent({ id: NAME }) }),
      { kind: "identifier", name: "payload" },
    ]);
    expect(result).toEqual({ compared: false, reason: "sender-opaque" });
  });

  it("declines when there is no sender to compare against", () => {
    expect(compareSupplied(readsInvoiceId, [])).toEqual({
      compared: false,
      reason: "sender-opaque",
    });
  });

  it("declines when the receiver is walking the platform's envelope", () => {
    const result = compareSupplied(
      { paths: [["Records"]], rootedAtPayload: false },
      [sent({ id: NAME, total: NAME })],
    );
    expect(result).toEqual({ compared: false, reason: "different-object" });
  });

  it("still reports a wholesale rename read off the parsed message", () => {
    const result = compareSupplied(
      { paths: [["totalAmount"]], rootedAtPayload: true },
      [sent({ id: NAME, total: NAME })],
    );
    expect(result).toEqual({ compared: true, unsupplied: [["totalAmount"]] });
  });

  it("compares the rest when one outermost name is shared", () => {
    const result = compareSupplied(
      { paths: [["data", "invoiceId"], ["subject"]], rootedAtPayload: false },
      [sent({ subject: NAME, data: sent({ id: NAME }) })],
    );
    expect(result).toEqual({
      compared: true,
      unsupplied: [["data", "invoiceId"]],
    });
  });
});

describe("checkReceivedInput", () => {
  it("passes the read-set reason straight through", () => {
    const result = checkReceivedInput({
      receiver: receiver({ inputs: [parameter("message", "event")] }),
      carriesPayload: arrivesAsEvent,
      supplied: [sent({ id: NAME })],
    });
    expect(result).toEqual({ compared: false, reason: "no-reads" });
  });

  it("reports the paths the sender leaves out", () => {
    const result = checkReceivedInput({
      receiver: receiver({
        inputs: [parameter("message", "event")],
        reads: [{ input: "message", path: ["data", "invoiceId"] }],
      }),
      carriesPayload: arrivesAsEvent,
      supplied: [sent({ data: sent({ id: NAME }) })],
    });
    expect(result).toEqual({
      compared: true,
      unsupplied: [["data", "invoiceId"]],
    });
  });
});

describe("formatPath", () => {
  it("writes a path the way the source spells it", () => {
    expect(formatPath(["data", "invoiceId"])).toBe("data.invoiceId");
  });
});
