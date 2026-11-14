import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { messageReceives } from "./messageReceives.js";
import { typed } from "./ops.js";
import { pack } from "./pack.js";

import type { Effect } from "@suss/behavioral-ir";
import type { CallOps, Typed, ValueOps } from "./ops.js";

/** One value as the receive's steps see it: the read it is, the collection it is an element of, and the types it is. */
interface Stated {
  read?: { key: string; object: Stated };
  elementOf?: Stated;
  typedAs?: string;
  keys?: string[];
}

function value(stated: Stated): ValueOps {
  return {
    text: () => null,
    name: () => null,
    flag: () => null,
    entries: () => [],
    items: () => [],
    property: () => null,
    asArg: () => null,
    parts: () => null,
    holes: () => [],
    read: () =>
      stated.read === undefined
        ? null
        : { key: stated.read.key, object: value(stated.read.object) },
    element: () =>
      stated.elementOf === undefined ? null : value(stated.elementOf),
    typed: (origin: Typed) =>
      stated.typedAs !== undefined &&
      (origin.named ?? []).includes(stated.typedAs),
    keysRead: () => stated.keys ?? [],
  };
}

/** A call that decodes `payload` under `codec`, and gives back a value the program reads `keys` off. */
function decodeCall(
  payload: Stated,
  keys: string[] = [],
  codec = "json",
): CallOps {
  return {
    method: () => "parse",
    receiverIsFrom: () => false,
    isFrom: () => false,
    argumentCount: () => 1,
    nameAt: () => null,
    calleeText: () => "JSON.parse",
    receiver: () => null,
    argument: () => null,
    callee: () => null,
    propertyAt: () => null,
    valueAt: () => null,
    decodes: () => ({
      codec,
      value: value(payload),
      result: value({ keys }),
    }),
  };
}

const RECEIVE = messageReceives({
  wire: "aws_sqs",
  codec: "json",
  envelope: [
    { path: [{ read: "Records" }, { each: true }, { read: "body" }] },
    {
      from: typed({ from: ["aws-lambda"], named: ["SQSRecord"] }),
      path: [{ read: "body" }],
    },
  ],
}).example("for (const r of event.Records) JSON.parse(r.body);");

const hook = compile(RECEIVE.declared, "@suss/receive-test");

function receivesAt(ops: CallOps): Effect[] {
  return hook(null, { ops }) ?? [];
}

/** `record`, given one element of `event.Records` each time round. */
const LOOP_RECORD: Stated = {
  elementOf: { read: { key: "Records", object: {} } },
};

describe("messageReceives", () => {
  it("records a receive on the wire, with the keys read off the decoded value as its fields", () => {
    const [effect, ...more] = receivesAt(
      decodeCall({ read: { key: "body", object: LOOP_RECORD } }, [
        "id",
        "total",
      ]),
    );
    expect(more).toEqual([]);
    expect(effect).toEqual({
      type: "interaction",
      binding: {
        transport: "aws_sqs",
        semantics: {
          name: "message-bus",
          messageBus: "aws_sqs",
          channel: null,
        },
        recognition: "@suss/receive-test",
      },
      callee: "JSON.parse",
      interaction: {
        class: "message-receive",
        body: {
          kind: "object",
          fields: {
            id: { kind: "identifier", name: "id" },
            total: { kind: "identifier", name: "total" },
          },
        },
      },
    });
  });

  it("records no body when the program reads no key off the decoded value", () => {
    const [effect] = receivesAt(
      decodeCall({ read: { key: "body", object: LOOP_RECORD } }),
    );
    expect(effect?.type === "interaction" && effect.interaction).toEqual({
      class: "message-receive",
    });
  });

  it("asks the second envelope's type of the object the last step reads off", () => {
    const typedRecord = decodeCall({
      read: { key: "body", object: { typedAs: "SQSRecord" } },
    });
    const otherType = decodeCall({
      read: { key: "body", object: { typedAs: "SNSRecord" } },
    });
    expect(receivesAt(typedRecord)).toHaveLength(1);
    expect(receivesAt(otherType)).toEqual([]);
  });

  it("records one receive where both envelopes reach the payload", () => {
    const both = decodeCall({
      read: {
        key: "body",
        object: { ...LOOP_RECORD, typedAs: "SQSRecord" },
      },
    });
    expect(receivesAt(both)).toHaveLength(1);
  });

  it("matches nothing when a step reads another key, an element comes from no read of Records, or the codec differs", () => {
    const otherKey = decodeCall({
      read: { key: "messageId", object: LOOP_RECORD },
    });
    const otherCollection = decodeCall({
      read: {
        key: "body",
        object: { elementOf: { read: { key: "Items", object: {} } } },
      },
    });
    const notAnElement = decodeCall({ read: { key: "body", object: {} } });
    const yaml = decodeCall(
      { read: { key: "body", object: LOOP_RECORD } },
      [],
      "yaml",
    );
    for (const ops of [otherKey, otherCollection, notAnElement, yaml]) {
      expect(receivesAt(ops)).toEqual([]);
    }
  });

  it("matches nothing at a call that decodes nothing", () => {
    const plain: CallOps = { ...decodeCall({}), decodes: () => null };
    expect(receivesAt(plain)).toEqual([]);
    expect(hook(null, {})).toBeNull();
  });

  it("runs on the invocation walk, keeps the wire as the pack's protocol, and gates on no module", () => {
    const built = pack("sqs", [RECEIVE], {
      languages: ["typescript"],
      recognizedAs: "@suss/receive-test",
    });
    expect(built.invocationRecognizers).toHaveLength(1);
    expect(built.accessRecognizers).toBeUndefined();
    expect(built.protocol).toBe("aws_sqs");
    expect(built.requiresImport).toEqual([]);
    expect(built.declarations?.declarations).toEqual([
      {
        name: "aws_sqs",
        dataLinks: 0,
        functionLinks: [],
        astLinks: [],
        example: "for (const r of event.Records) JSON.parse(r.body);",
      },
    ]);
  });
});
