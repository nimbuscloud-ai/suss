import { describe, expect, it } from "vitest";

import {
  functionCallBinding,
  messageBusBinding,
  restBinding,
} from "@suss/ir-core";

import {
  boundaryInputReads,
  type CarriesPayload,
  carriesPayloadFor,
  checkReceivedInput,
  compareSupplied,
  formatPath,
  messageBodyReadSet,
  readPathOf,
  readSetOf,
} from "./inputContract.js";

import type { BehavioralSummary, Input } from "../index.js";

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

  it("knows a hook return by its hook, and leaves a parameter's role alone", () => {
    const carriesHook: CarriesPayload = (input) => input.type === "hookReturn";
    const result = readSetOf(
      receiver({
        inputs: [
          { type: "hookReturn", hook: "useQuery", destructuredFields: [] },
          parameter("props", "props"),
        ],
        reads: [
          { input: "useQuery", path: ["data", "id"] },
          { input: "props", path: ["label"] },
        ],
      }),
      carriesHook,
    );
    expect(result).toEqual({
      read: true,
      reads: {
        paths: [
          ["data", "id"],
          ["props", "label"],
        ],
        rootedAtPayload: false,
      },
    });
  });

  it("knows a context value by its context", () => {
    const carriesContext: CarriesPayload = (input) =>
      input.type === "contextValue";
    const result = readSetOf(
      receiver({
        inputs: [
          { type: "contextValue", context: "Tenant", accessedFields: [] },
        ],
        reads: [{ input: "Tenant", path: ["id"] }],
      }),
      carriesContext,
    );
    expect(result).toEqual({
      read: true,
      reads: { paths: [["id"]], rootedAtPayload: false },
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

  it("declines when a sender passed something with no fields to read", () => {
    const result = compareSupplied(readsInvoiceId, ["a bare string"]);
    expect(result).toEqual({ compared: false, reason: "sender-opaque" });
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

describe("messageBodyReadSet", () => {
  it("declines when the handler read a field of the platform's own record", () => {
    const result = messageBodyReadSet(
      receiver({
        inputs: [parameter("event", "event")],
        reads: [{ input: "event", path: ["Records", "body"] }],
      }),
      "aws_sqs",
    );
    expect(result).toEqual({ read: false, reason: "platform-envelope" });
  });

  it("treats a handler that read no envelope field as holding the parsed message", () => {
    const result = messageBodyReadSet(
      receiver({
        inputs: [parameter("event", "event")],
        reads: [{ input: "event", path: ["orderId"] }],
      }),
      "aws_sqs",
    );
    expect(result).toEqual({
      read: true,
      reads: { paths: [["orderId"]], rootedAtPayload: true },
    });
  });

  it("passes a read set too short to compare straight through", () => {
    const result = messageBodyReadSet(
      receiver({ inputs: [parameter("event", "event")] }),
      "aws_sqs",
    );
    expect(result).toEqual({ read: false, reason: "no-reads" });
  });

  it("leaves the read set alone for a bus with no envelope of its own", () => {
    const result = messageBodyReadSet(
      receiver({
        inputs: [parameter("event", "event")],
        reads: [{ input: "event", path: ["orderId"] }],
      }),
      "kafka",
    );
    expect(result).toEqual({
      read: true,
      reads: { paths: [["orderId"]], rootedAtPayload: false },
    });
  });
});

describe("boundaryInputReads", () => {
  it("gives every parameter of a function-call boundary under its own role", () => {
    const result = boundaryInputReads(
      receiver({
        inputs: [parameter("provider", "provider"), parameter("c", "consumer")],
        reads: [
          { input: "provider", path: [] },
          { input: "c", path: ["identity"] },
        ],
      }),
      functionCallBinding({
        transport: "in-process",
        recognition: "code",
        package: "@suss/checker",
      }),
    );
    expect(result).toEqual({
      read: true,
      reads: {
        paths: [["provider"], ["consumer", "identity"]],
        rootedAtPayload: true,
      },
    });
  });

  it("goes through the envelope for a message-bus boundary", () => {
    const result = boundaryInputReads(
      receiver({
        inputs: [parameter("event", "event")],
        reads: [{ input: "event", path: ["Records", "body"] }],
      }),
      messageBusBinding({
        recognition: "code",
        messageBus: "aws_sqs",
        channel: "orders",
      }),
    );
    expect(result).toEqual({ read: false, reason: "platform-envelope" });
  });

  it("declines for REST, whose sections no framework has spelled out here", () => {
    const result = boundaryInputReads(
      receiver({
        inputs: [parameter("req", "request")],
        reads: [{ input: "req", path: ["headers", "x-tenant-id"] }],
      }),
      restBinding({
        transport: "http",
        method: "GET",
        path: "/invoices",
        recognition: "code",
      }),
    );
    expect(result).toEqual({ read: false, reason: "unmapped-protocol" });
  });
});

describe("carriesPayloadFor", () => {
  it("says the event parameter for a message-bus boundary", () => {
    const carriesPayload = carriesPayloadFor(
      messageBusBinding({
        recognition: "code",
        messageBus: "aws_sqs",
        channel: "orders",
      }),
    );
    expect(carriesPayload?.(parameter("event", "event"))).toBe(true);
    expect(carriesPayload?.(parameter("ctx", "context"))).toBe(false);
  });

  it("says no input at all for a function-call boundary", () => {
    const carriesPayload = carriesPayloadFor(
      functionCallBinding({
        transport: "in-process",
        recognition: "code",
        package: "@suss/checker",
      }),
    );
    expect(carriesPayload?.(parameter("provider", "provider"))).toBe(false);
  });

  it("has nothing to say for a protocol that never settled it", () => {
    expect(
      carriesPayloadFor(
        restBinding({
          transport: "http",
          method: "GET",
          path: "/invoices",
          recognition: "code",
        }),
      ),
    ).toBeNull();
  });
});

describe("readPathOf", () => {
  it("spells a guard on a parameter the way a read of it is spelled", () => {
    const summary = receiver({ inputs: [parameter("opts", "options")] });
    expect(
      readPathOf(
        summary,
        { type: "input", inputRef: "opts", path: ["stream"] },
        () => false,
      ),
    ).toEqual(["options", "stream"]);
  });

  it("drops the payload's own name, the way a read off it does", () => {
    const summary = receiver({ inputs: [parameter("message", "event")] });
    expect(
      readPathOf(
        summary,
        { type: "input", inputRef: "message", path: ["orderId"] },
        arrivesAsEvent,
      ),
    ).toEqual(["orderId"]);
  });

  it("has no path for the payload taken whole", () => {
    const summary = receiver({ inputs: [parameter("message", "event")] });
    expect(
      readPathOf(
        summary,
        { type: "input", inputRef: "message", path: [] },
        arrivesAsEvent,
      ),
    ).toBeNull();
  });

  it("has no path for a reference to something other than an input", () => {
    const summary = receiver({ inputs: [parameter("message", "event")] });
    expect(
      readPathOf(summary, { type: "state", name: "count" }, arrivesAsEvent),
    ).toBeNull();
  });

  it("has no path for an input the summary never declared", () => {
    const summary = receiver({ inputs: [parameter("message", "event")] });
    expect(
      readPathOf(
        summary,
        { type: "input", inputRef: "nowhere", path: ["id"] },
        arrivesAsEvent,
      ),
    ).toBeNull();
  });
});
