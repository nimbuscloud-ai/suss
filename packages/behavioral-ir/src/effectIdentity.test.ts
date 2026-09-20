import { describe, expect, it } from "vitest";

import {
  effectKey,
  foldRepeatedEffects,
  normalizeCalleeText,
} from "./effectIdentity.js";

import type { Effect } from "./index.js";

type Interaction = Extract<Effect, { type: "interaction" }>;
type Invocation = Extract<Effect, { type: "invocation" }>;

const tableWrite = (groupId?: string): Interaction => ({
  type: "interaction",
  binding: {
    transport: "aws-sdk",
    semantics: {
      name: "storage",
      storageSystem: "aws.dynamodb",
      scope: "default",
      container: "orders",
      accessPath: null,
    },
    recognition: "@suss/framework-aws-dynamodb",
  },
  callee: "store.send",
  ...(groupId === undefined ? {} : { groupId }),
  interaction: {
    class: "storage-access",
    kind: "write",
    fields: ["id"],
  },
});

const call = (callee: string): Invocation => ({
  type: "invocation",
  callee,
  args: [],
  async: false,
});

describe("effectKey", () => {
  it("gives two effects that differ only in their group the same key", () => {
    expect(effectKey(tableWrite("a"))).toBe(effectKey(tableWrite("b")));
    expect(effectKey(tableWrite("a"))).toBe(effectKey(tableWrite()));
  });

  it("gives an effect the fold has already counted the same key", () => {
    expect(effectKey({ ...tableWrite(), count: 4 })).toBe(
      effectKey(tableWrite()),
    );
  });

  it("gives two effects that differ in any other field different keys", () => {
    const read: Interaction = {
      ...tableWrite(),
      interaction: { class: "storage-access", kind: "read", fields: ["id"] },
    };
    expect(effectKey(read)).not.toBe(effectKey(tableWrite()));
    expect(effectKey(call("save"))).not.toBe(effectKey(call("load")));
  });

  it("does not ignore a field called count inside an argument", () => {
    const withCount: Invocation = {
      ...call("report"),
      args: [
        { kind: "object", fields: { count: { kind: "number", value: 2 } } },
      ],
    };
    expect(effectKey(withCount)).not.toBe(effectKey(call("report")));
  });

  it("ignores the order the fields were written in", () => {
    const written: Invocation = {
      callee: "save",
      async: false,
      args: [],
      type: "invocation",
    };
    expect(effectKey(written)).toBe(effectKey(call("save")));
  });
});

describe("normalizeCalleeText", () => {
  it("spells a chain broken across lines the way the one-line chain is spelt", () => {
    expect(normalizeCalleeText("tx\n        .select()\n        .from")).toBe(
      normalizeCalleeText("tx.select().from"),
    );
  });

  it("keeps an optional chain together", () => {
    expect(normalizeCalleeText("client\n  ?.query")).toBe("client?.query");
  });
});

describe("foldRepeatedEffects", () => {
  it("counts an effect that three sites produced and keeps the first", () => {
    const folded = foldRepeatedEffects([
      tableWrite("a"),
      tableWrite("b"),
      tableWrite("c"),
    ]);

    expect(folded).toEqual([{ ...tableWrite("a"), count: 3 }]);
  });

  it("leaves distinct effects alone and says nothing about a count", () => {
    const folded = foldRepeatedEffects([call("save"), call("load")]);

    expect(folded).toEqual([call("save"), call("load")]);
  });

  it("keeps the order the effects first appeared in", () => {
    const folded = foldRepeatedEffects([
      call("save"),
      call("load"),
      call("save"),
    ]);

    expect(folded).toEqual([{ ...call("save"), count: 2 }, call("load")]);
  });
});
