import { describe, expect, it } from "vitest";

import { imported, typed } from "./ops.js";
import { pack } from "./pack.js";
import { sqlStatements } from "./sqlStatements.js";
import { storageCalls } from "./storage.js";

import type { Effect } from "@suss/behavioral-ir";
import type { PassedTo, StatedSlot } from "@suss/extractor";
import type { CallStep } from "./chain.js";
import type { CallOps, ValueOps } from "./ops.js";
import type { Match } from "./pack.js";

/** A call, as the ops see it, with only what these chains ask. */
interface Written {
  method?: string | null;
  callee?: string;
  /** Whether the call's receiver is a session, by the test's own say. */
  onSession?: boolean;
  receiver?: CallOps;
  chained?: CallOps | "unsaid";
  passedTo?: PassedTo;
  keywords?: Record<string, string>;
  /** What each positional argument is, by position. */
  args?: readonly ValueOps[];
}

function callOps(written: Written): CallOps {
  const keywords = written.keywords ?? {};
  const args = written.args ?? [];
  const ops: CallOps = {
    method: () => written.method ?? null,
    calleeText: () => written.callee ?? "db.call",
    receiverIsFrom: () => written.onSession === true,
    isFrom: () => written.onSession === true,
    argumentCount: () => args.length,
    nameAt: (index) => args[index]?.name("nothing") ?? null,
    receiver: () => written.receiver ?? null,
    argument: () => null,
    callee: () => null,
    namedCallee: () => written.method === undefined,
    propertyAt: () => null,
    valueAt: (index) => args[index] ?? null,
    keywordAt: (name) => (name in keywords ? text(keywords[name] ?? "") : null),
    keywordNames: () => Object.keys(keywords),
    passedTo: () => written.passedTo ?? null,
  };
  return written.chained === "unsaid"
    ? ops
    : { ...ops, chainedOn: () => (written.chained as CallOps) ?? null };
}

/** A value whose text is `said`, and which reads `reads` off the value called `off`. */
function text(said: string, reads: readonly string[] = []): ValueOps {
  return {
    text: () => said,
    name: () => said,
    flag: () => null,
    entries: () => [],
    items: () => [],
    property: () => null,
    asArg: () => ({ kind: "string", value: said }),
    parts: () => [said],
    holes: () => [],
    readsOff: () => reads,
  };
}

/** An object whose entries are `entries`. */
function objectOf(entries: Record<string, string>): ValueOps {
  return {
    ...text(""),
    parts: () => null,
    entries: () =>
      Object.entries(entries).map(([key, value]) => ({
        key,
        value: text(value),
      })),
    property: (name) => (name in entries ? text(entries[name] ?? "") : null),
  };
}

const SESSION = typed({ from: ["vault"], named: ["Session"] });

/** The effects every hook the matches compile to makes of one call, and the slots they state. */
function run(
  matches: readonly Match[],
  ops: CallOps,
): { effects: Effect[]; slots: string[] } {
  const declared = pack("vault", matches, {
    languages: ["python"],
    recognizedAs: "@suss/vault-test",
  });
  const slots: string[] = [];
  const listening: CallOps = {
    ...ops,
    statesSlots: (_effect: Effect, stated: readonly StatedSlot[]) => {
      for (const one of stated) {
        slots.push(`${one.slot} ${one.name} ${one.value.text()}`);
      }
    },
  };
  const effects = [
    ...(declared.invocationRecognizers ?? []),
    ...(declared.accessRecognizers ?? []),
  ].flatMap((hook) => hook(null, { ops: listening }) ?? []);
  return { effects, slots };
}

/** The operation, kind, fields and selector of each storage access. */
function accesses(effects: readonly Effect[]): unknown[] {
  return effects.map((effect) =>
    effect.type === "interaction" &&
    effect.interaction.class === "storage-access"
      ? [
          effect.interaction.operation,
          effect.interaction.kind,
          effect.interaction.fields,
          effect.interaction.selector ?? [],
        ]
      : null,
  );
}

describe("a methods table with a meaning for every method it leaves out", () => {
  const sessions = storageCalls({ system: "vault", client: SESSION })
    .methods({ add: { kind: "write" } })
    .otherwise({ kind: "read" });

  it("gives an unlisted method that meaning, and a listed one its own", () => {
    const listed = run([sessions], callOps({ method: "add", onSession: true }));
    const unlisted = run(
      [sessions],
      callOps({ method: "refresh", onSession: true }),
    );

    expect(accesses(listed.effects)).toEqual([["add", "write", [], []]]);
    expect(accesses(unlisted.effects)).toEqual([["refresh", "read", [], []]]);
  });

  it("reads nothing on a receiver the start turns down, or a call with no method", () => {
    expect(run([sessions], callOps({ method: "refresh" })).effects).toEqual([]);
    expect(run([sessions], callOps({ onSession: true })).effects).toEqual([]);
  });

  it("is a table of its own when the chain has no other", () => {
    const anything = storageCalls({ system: "vault", client: SESSION })
      .otherwise({ kind: "read" })
      .methods({ add: { kind: "write" } });
    const table = anything.declared.links.find(
      (link) => link.asks === "methods",
    );

    expect(table).toMatchObject({ table: {}, otherwise: { kind: "read" } });
  });
});

describe("a chain read only at the last call", () => {
  const sessions = storageCalls(
    { system: "vault", client: SESSION },
    { outermost: true },
  ).otherwise({ kind: "read" });

  it("passes over a call something is chained on, and reads the call that ends the chain", () => {
    const first = callOps({ method: "first" });
    const query = callOps({ method: "query", onSession: true, chained: first });

    expect(run([sessions], query).effects).toEqual([]);
    expect(
      accesses(
        run([sessions], callOps({ method: "query", onSession: true })).effects,
      ),
    ).toEqual([["query", "read", [], []]]);
  });

  it("reads every call in an adapter that cannot say what is chained on one", () => {
    const query = callOps({
      method: "query",
      onSession: true,
      chained: "unsaid",
    });

    expect(run([sessions], query).effects).toHaveLength(1);
  });
});

describe("steps that reach every call along a chain", () => {
  // db.query(User).filter(a=1).options(o=2).filter(b=3).first()
  const query = callOps({
    method: "query",
    onSession: true,
    keywords: { user: "User" },
  });
  const filterA = callOps({
    method: "filter",
    receiver: query,
    keywords: { a: "1" },
  });
  const options = callOps({
    method: "options",
    receiver: filterA,
    keywords: { o: "2" },
  });
  const filterB = callOps({
    method: "filter",
    receiver: options,
    keywords: { b: "3" },
  });
  const first = callOps({ method: "first", receiver: filterB });

  it("reads the keywords of every receiver but the ones the step passes over, and states each one's value", () => {
    const filtered = storageCalls(
      {
        system: "vault",
        client: SESSION,
        clientAt: [{ to: "receiver", every: true, origin: SESSION }],
      },
      { outermost: true },
    ).otherwise({
      kind: "read",
      selector: {
        keywordsOf: {
          of: [{ to: "receiver", every: true, except: ["options", "query"] }],
        },
      },
    });
    const read = run([filtered], first);

    expect(accesses(read.effects)).toEqual([["first", "read", [], ["b", "a"]]]);
    expect(read.slots).toEqual(["selector b 3", "selector a 1"]);
  });

  it("reads each call of one method, and every call, out along the chain", () => {
    const outFrom = (step: CallStep) =>
      storageCalls({ system: "vault", client: SESSION })
        .methods({
          query: { kind: "read", selector: { keywordsOf: { of: [step] } } },
        })
        .slots("none");
    const chainedQuery = callOps({
      method: "query",
      onSession: true,
      chained: callOps({
        method: "filter",
        keywords: { a: "1" },
        chained: callOps({
          method: "options",
          keywords: { o: "2" },
          chained: callOps({ method: "filter", keywords: { b: "3" } }),
        }),
      }),
    });

    expect(
      accesses(
        run(
          [outFrom({ to: "chained", method: "filter", every: true })],
          chainedQuery,
        ).effects,
      ),
    ).toEqual([["query", "read", [], ["a", "b"]]]);
    expect(
      accesses(
        run(
          [outFrom({ to: "chained", every: true, except: ["filter"] })],
          chainedQuery,
        ).effects,
      ),
    ).toEqual([["query", "read", [], ["o"]]]);
    expect(
      accesses(run([outFrom({ to: "chained" })], chainedQuery).effects),
    ).toEqual([["query", "read", [], ["a"]]]);
  });
});

describe("the columns read off every argument from a position", () => {
  it("reads each argument in turn, each column once", () => {
    const picks = storageCalls({ system: "vault", client: SESSION })
      .methods({
        query: {
          kind: "read",
          fields: { fieldsRead: { from: 1 }, off: { at: 0 } },
        },
      })
      .slots("none");
    const query = callOps({
      method: "query",
      onSession: true,
      args: [text("User"), text("User.id", ["id"]), text("u", ["name", "id"])],
    });

    expect(accesses(run([picks], query).effects)).toEqual([
      ["query", "read", ["id", "name"], []],
    ]);
  });

  it("reads nothing when the value it reads off is not passed", () => {
    const picks = storageCalls({ system: "vault", client: SESSION })
      .methods({
        query: {
          kind: "read",
          fields: { fieldsRead: { from: 1 }, off: { at: 3 } },
        },
      })
      .slots("none");
    const query = callOps({
      method: "query",
      onSession: true,
      args: [text("User"), text("User.id", ["id"])],
    });

    expect(accesses(run([picks], query).effects)).toEqual([
      ["query", "read", [], []],
    ]);
  });
});

describe("a statement written through a function the library exports", () => {
  const statements = sqlStatements({
    system: "postgresql",
    dialect: "postgresql",
    client: imported({ from: ["vault"], named: ["text"] }),
  }).calls({
    statement: { at: 0 },
    parameters: [
      { of: [{ to: "chained", method: "bindparams" }], keywords: true },
      { of: [{ to: "passedTo", method: "execute", at: 0 }], at: 1 },
    ],
  });
  const statement = (over: Partial<Written> = {}) =>
    callOps({
      callee: "text",
      onSession: true,
      args: [text("UPDATE notes SET body = :body WHERE id = :id")],
      ...over,
    });

  it("reads the statement a bare call states, with the values the call it is handed to binds", () => {
    const execute = callOps({
      method: "execute",
      args: [text(""), objectOf({ body: "b", id: "7" })],
    });
    const read = run(
      [statements],
      statement({ passedTo: { call: execute, at: 0 } }),
    );

    expect(accesses(read.effects)).toEqual([
      ["text", "write", ["body"], ["id"]],
    ]);
    expect(read.slots).toEqual(["field body b", "selector id 7"]);
  });

  it("reads the keywords the statement is bound with first", () => {
    const bound = callOps({
      method: "bindparams",
      keywords: { body: "k", id: "8" },
    });
    const read = run([statements], statement({ chained: bound }));

    expect(read.slots).toEqual(["field body k", "selector id 8"]);
  });

  it("finds no values where the call it is handed to is some other method, at some other place, or binds no keywords", () => {
    const other = callOps({
      method: "run",
      args: [text(""), objectOf({ body: "b" })],
    });
    const later = callOps({
      method: "execute",
      args: [text(""), objectOf({ body: "b" })],
    });

    for (const over of [
      { passedTo: { call: other, at: 0 } },
      { passedTo: { call: later, at: 1 } },
      { chained: callOps({ method: "bindparams" }) },
    ]) {
      const read = run([statements], statement(over));
      expect(read.effects).toHaveLength(1);
      expect(read.slots).toEqual([]);
    }
  });
});

describe("a pack's words", () => {
  it("are passed through to the pack the adapters load", () => {
    const words = {
      givesBackOneOfArgument: [{ base: "Model", method: "get", argument: 0 }],
    };
    const declared = pack(
      "vault",
      [
        storageCalls({ system: "vault", client: SESSION }).otherwise({
          kind: "read",
        }),
      ],
      { languages: ["python"], recognizedAs: "@suss/vault-test", words },
    );

    expect(declared.words).toEqual(words);
  });
});
