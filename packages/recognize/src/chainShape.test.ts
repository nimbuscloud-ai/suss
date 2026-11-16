import { describe, expect, it } from "vitest";

import { imported, typed } from "./ops.js";
import { pack } from "./pack.js";
import { sqlStatements } from "./sqlStatements.js";
import { storageCalls } from "./storage.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Comparison, PassedTo, StatedSlot } from "@suss/extractor";
import type { CallStep, ClassPick, ToReceiver } from "./chain.js";
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
  site?: string;
  /** The value the call is made on, as the source writes it. */
  on?: ValueOps;
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
    ...(written.site === undefined ? {} : { site: () => written.site ?? "" }),
    ...(written.on === undefined
      ? {}
      : { receiverValue: () => written.on ?? null }),
  };
  return written.chained === "unsaid"
    ? ops
    : { ...ops, chainedOn: () => (written.chained as CallOps) ?? null };
}

/**
 * The calls of one chain written in place, first call first: each is
 * made on the one before it, which knows it is chained on.
 */
function chainOf(...links: readonly Written[]): CallOps[] {
  const calls: CallOps[] = [];
  links.forEach((link, at) => {
    const ops = callOps({ ...link, site: link.site ?? `call${at}` });
    calls.push({
      ...ops,
      receiver: () => calls[at - 1] ?? link.receiver ?? null,
      chainedOn: () => calls[at + 1] ?? null,
    });
  });
  return calls;
}

/** The last call of a chain, the one a chain read at its last call reads. */
function lastOf(calls: readonly CallOps[]): CallOps {
  const last = calls[calls.length - 1];
  if (last === undefined) {
    throw new Error("a chain of no calls");
  }
  return last;
}

/** A value whose class the adapter reads as `name`. */
function classNamed(name: string | null, written = name ?? ""): ValueOps {
  return { ...text(written), className: () => name };
}

/** A column read off a class in place, `User.id`. */
function column(owner: string, key: string): ValueOps {
  return {
    ...text(`${owner}.${key}`),
    form: () => "other",
    read: () => ({ key, object: classNamed(owner) }),
  };
}

/** A comparison of its operands, with the operators between them. */
function compared(
  left: ValueOps,
  ...rest: readonly (string | ValueOps)[]
): ValueOps {
  const comparisons: Comparison[] = [];
  let before = left;
  for (let at = 0; at + 1 < rest.length; at += 2) {
    const operator = rest[at] as string;
    const right = rest[at + 1] as ValueOps;
    comparisons.push({ left: before, operator, right });
    before = right;
  }
  return { ...text("compared"), comparisons: () => comparisons };
}

/** A call written as an argument, `and_(a, b)`. */
function calledWith(callee: string, ...args: readonly ValueOps[]): ValueOps {
  const call = callOps({ callee, args });
  return { ...text(callee), asCall: () => call };
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

/** The container each storage access records. */
function containers(effects: readonly Effect[]): (string | null)[] {
  return effects.map((effect) =>
    effect.type === "interaction" &&
    effect.binding?.semantics.name === "storage"
      ? effect.binding.semantics.container
      : null,
  );
}

// The chain's first call, unless it closes the session, and the calls
// out from it: one of them is made on the session.
const FIRST: readonly CallStep[] = [
  { to: "chainStart", except: ["close"] },
  { to: "chained", fromItself: true, every: true },
];

// Every call after the chain's first call.
const LATER: ToReceiver = {
  to: "receiver",
  every: true,
  inPlace: true,
  until: SESSION,
};

const SESSION_CHAIN = storageCalls(
  {
    system: "vault",
    client: SESSION,
    clientAt: FIRST,
    unsettledName: "nothing",
  },
  { outermost: true },
)
  .otherwise({
    kind: "read",
    fields: { keywordsOf: { of: [{ to: "chainStart" }] } },
    selector: { keywordsOf: { of: [LATER], itself: true } },
  })
  .container({
    class: [
      { of: [{ to: "chainStart" }], at: 0 },
      { of: [{ to: "chainStart" }], receiver: true },
    ],
    notFrom: ["vault"],
  });

describe("a chain read from the first call on its session", () => {
  it("reads the calls after the first one, the call in hand last, and the first one's keywords as fields", () => {
    const calls = chainOf(
      { method: "query", onSession: true, keywords: { user: "U" } },
      { method: "filter", keywords: { a: "1" } },
      { method: "filter", keywords: { b: "2" } },
      { method: "first", keywords: { c: "3" } },
    );

    expect(accesses(run([SESSION_CHAIN], lastOf(calls)).effects)).toEqual([
      ["first", "read", ["user"], ["b", "a", "c"]],
    ]);
  });

  it("reads a call on the session alone as its own first call, with no call after it", () => {
    const calls = chainOf({
      method: "get",
      onSession: true,
      keywords: { id: "1" },
    });

    expect(accesses(run([SESSION_CHAIN], lastOf(calls)).effects)).toEqual([
      ["get", "read", ["id"], []],
    ]);
  });

  it("reads nothing when the chain starts with a method the step leaves out, and reads a chain that only ends with one", () => {
    const alone = chainOf({ method: "close", onSession: true });
    const chained = chainOf(
      { method: "close", onSession: true },
      { method: "all" },
    );
    const ending = chainOf(
      { method: "query", onSession: true },
      { method: "close" },
    );

    expect(run([SESSION_CHAIN], lastOf(alone)).effects).toEqual([]);
    expect(run([SESSION_CHAIN], lastOf(chained)).effects).toEqual([]);
    expect(accesses(run([SESSION_CHAIN], lastOf(ending)).effects)).toEqual([
      ["close", "read", [], []],
    ]);
  });

  it("starts the chain at the call in hand when its receiver is kept in a name, and a walk that does not keep to the chain goes past it", () => {
    // q = db.query(User, k=1); q.first()
    const query = callOps({
      method: "query",
      onSession: true,
      keywords: { k: "1" },
      site: "q",
    });
    const first = callOps({ method: "first", receiver: query, site: "f" });
    const keywordsUp = (step: ToReceiver) =>
      accesses(
        run(
          [
            storageCalls({ system: "vault" }).otherwise({
              kind: "read",
              selector: { keywordsOf: { of: [step] } },
            }),
          ],
          first,
        ).effects,
      );

    expect(run([SESSION_CHAIN], first).effects).toEqual([]);
    expect(keywordsUp({ to: "receiver", every: true })).toEqual([
      ["first", "read", [], ["k"]],
    ]);
    expect(keywordsUp({ to: "receiver", every: true, inPlace: true })).toEqual([
      ["first", "read", [], []],
    ]);
  });

  it("starts the chain at the call the session is, when the first call on the session is made on a call written in place", () => {
    // Orders.query().filter_by(id=1).first(), where query() gives the session
    const calls = chainOf(
      { method: "query", on: classNamed("Orders") },
      { method: "filter_by", onSession: true, keywords: { id: "1" } },
      { method: "first" },
    );
    const read = run([SESSION_CHAIN], lastOf(calls));

    expect(accesses(read.effects)).toEqual([["first", "read", [], ["id"]]]);
    expect(containers(read.effects)).toEqual(["Orders"]);
  });
});

describe("a step that reaches the calls of several methods", () => {
  it("keeps each call to one of them, in the order the walk meets them", () => {
    const calls = chainOf(
      { method: "query", onSession: true },
      { method: "join", keywords: { j: "1" } },
      { method: "filter", keywords: { f: "1" } },
      { method: "select_from", keywords: { s: "1" } },
      { method: "first" },
    );
    const tables = storageCalls(
      { system: "vault", client: SESSION, clientAt: FIRST },
      { outermost: true },
    ).otherwise({
      kind: "read",
      selector: {
        keywordsOf: {
          of: [{ ...LATER, method: ["join", "select_from"] }],
        },
      },
    });

    expect(accesses(run([tables], lastOf(calls)).effects)).toEqual([
      ["first", "read", [], ["s", "j"]],
    ]);
  });
});

describe("the class a chain works on", () => {
  it("is the first class one of the sources reaches, in the order the pick lists them", () => {
    const calls = chainOf(
      {
        method: "query",
        onSession: true,
        args: [text("count")],
        on: classNamed("Ledger"),
      },
      { method: "select_from", args: [classNamed("User")] },
      { method: "first" },
    );
    const classes = (pick: ClassPick) =>
      containers(
        run(
          [
            storageCalls(
              { system: "vault", client: SESSION, clientAt: FIRST },
              { outermost: true },
            )
              .otherwise({ kind: "read" })
              .container(pick),
          ],
          lastOf(calls),
        ).effects,
      );

    expect(
      classes({
        class: [
          { of: [{ to: "chainStart" }], at: 0 },
          { of: [{ ...LATER, method: "select_from" }], itself: true, at: 0 },
          { of: [{ to: "chainStart" }], receiver: true },
        ],
        notFrom: [],
      }),
    ).toEqual(["User"]);
    expect(
      classes({
        class: { of: [{ to: "chainStart" }], receiver: true },
        notFrom: [],
      }),
    ).toEqual(["Ledger"]);
    expect(
      classes({ class: { of: [{ to: "chainStart" }], at: 0 }, notFrom: [] }),
    ).toEqual([null]);
  });

  it("hands the adapter the modules whose own types are no class", () => {
    const asked: (readonly string[])[] = [];
    const typedValue: ValueOps = {
      ...text("q"),
      className: (notFrom) => {
        asked.push(notFrom);
        return null;
      },
    };
    const calls = chainOf({
      method: "get",
      onSession: true,
      args: [typedValue],
    });
    run(
      [
        storageCalls({ system: "vault", client: SESSION, clientAt: FIRST })
          .otherwise({ kind: "read" })
          .container({ class: { at: 0 }, notFrom: ["vault"] }),
      ],
      lastOf(calls),
    );

    expect(asked).toEqual([["vault"]]);
  });
});

describe("the columns a query's conditions pick rows by", () => {
  const conditions = (calls: readonly CallOps[]) =>
    run(
      [
        storageCalls(
          { system: "vault", client: SESSION, clientAt: FIRST },
          { outermost: true },
        ).otherwise({
          kind: "read",
          selector: {
            conditions: { of: [LATER], itself: true },
            ofClass: {
              class: { of: [{ to: "chainStart" }], at: 0 },
              notFrom: [],
            },
            combinedBy: ["and_", "or_"],
            pinnedBy: ["and_"],
            equality: ["=="],
          },
        }),
      ],
      lastOf(calls),
    );

  it("reads each call's keywords and the columns it pins with the value each is compared with, then every column compared", () => {
    const read = conditions(
      chainOf(
        { method: "query", onSession: true, args: [classNamed("User")] },
        {
          method: "filter",
          args: [
            compared(column("User", "id"), "==", text("x")),
            compared(column("User", "age"), ">", text("3")),
          ],
        },
        {
          method: "filter",
          keywords: { org: "o" },
          args: [
            calledWith(
              "and_",
              compared(text("t"), "==", column("User", "team")),
              compared(column("User", "kind"), "!=", text("k")),
            ),
          ],
        },
        {
          method: "filter",
          args: [
            calledWith("or_", compared(column("User", "a"), "==", text("1"))),
          ],
        },
        { method: "first" },
      ),
    );

    expect(accesses(read.effects)).toEqual([
      ["first", "read", [], ["org", "team", "id", "a", "kind", "age"]],
    ]);
    expect(read.slots).toEqual([
      "selector org o",
      "selector team t",
      "selector id x",
    ]);
  });

  it("pins no column compared in a chain of three operands, a column of another class, or a column kept in a name", () => {
    const kept: ValueOps = { ...column("User", "id"), form: () => "name" };
    const read = conditions(
      chainOf(
        { method: "query", onSession: true, args: [classNamed("User")] },
        {
          method: "filter",
          args: [
            compared(column("User", "b"), "==", text("1"), "==", text("2")),
            compared(column("Team", "id"), "==", text("y")),
            compared(kept, "==", text("z")),
          ],
        },
        { method: "first" },
      ),
    );

    expect(accesses(read.effects)).toEqual([["first", "read", [], ["b"]]]);
    expect(read.slots).toEqual([]);
  });

  it("passes over a value that compares nothing and a call that joins no conditions, and asks for the class once", () => {
    let asked = 0;
    const counted: ValueOps = {
      ...text("User"),
      className: () => {
        asked += 1;
        return "User";
      },
    };
    const model: ClassPick = {
      class: { of: [{ to: "chainStart" }], at: 0 },
      notFrom: [],
    };
    const calls = chainOf(
      { method: "query", onSession: true, args: [counted] },
      {
        method: "filter",
        args: [
          text("raw"),
          calledWith(
            "lower",
            compared(column("User", "name"), "==", text("n")),
          ),
          compared(column("User", "id"), "==", text("x")),
        ],
      },
      { method: "first" },
    );
    const read = run(
      [
        storageCalls(
          { system: "vault", client: SESSION, clientAt: FIRST },
          { outermost: true },
        )
          .otherwise({
            kind: "read",
            selector: {
              conditions: { of: [LATER], itself: true },
              ofClass: model,
              combinedBy: ["and_"],
              pinnedBy: ["and_"],
              equality: ["=="],
            },
          })
          .container(model),
      ],
      lastOf(calls),
    );

    expect(accesses(read.effects)).toEqual([["first", "read", [], ["id"]]]);
    expect(containers(read.effects)).toEqual(["User"]);
    expect(asked).toBe(1);
  });

  it("reads only the keywords when the chain works on no class", () => {
    const read = conditions(
      chainOf(
        { method: "query", onSession: true },
        {
          method: "filter",
          keywords: { id: "1" },
          args: [compared(column("User", "age"), "==", text("3"))],
        },
        { method: "first" },
      ),
    );

    expect(accesses(read.effects)).toEqual([["first", "read", [], ["id"]]]);
  });
});

describe("the arguments that are columns of the class", () => {
  it("reads each argument written as a read off the class, each once, alongside the picks listed with it", () => {
    const calls = chainOf({
      method: "query",
      onSession: true,
      keywords: { name: "n" },
      args: [
        classNamed("User"),
        column("User", "id"),
        column("User", "name"),
        calledWith("count", column("User", "id")),
        column("Team", "id"),
      ],
    });
    const read = run(
      [
        storageCalls({
          system: "vault",
          client: SESSION,
          clientAt: FIRST,
        }).otherwise({
          kind: "read",
          fields: [
            {
              columns: { of: [{ to: "chainStart" }], from: 0 },
              ofClass: { class: { at: 0 }, notFrom: [] },
            },
            { keywordsOf: { of: [{ to: "chainStart" }] } },
          ],
        }),
      ],
      lastOf(calls),
    );

    expect(accesses(read.effects)).toEqual([
      ["query", "read", ["id", "name"], []],
    ]);
    expect(read.slots).toEqual(["field name n"]);
  });
});

describe("the calls a pick reaches, the call it starts from among them", () => {
  /** The keywords a pick over these steps reads, starting from the call in hand. */
  const keywordsFrom = (of: readonly CallStep[], ops: CallOps) =>
    accesses(
      run(
        [
          storageCalls({ system: "vault" }).otherwise({
            kind: "read",
            selector: { keywordsOf: { of, itself: true } },
          }),
        ],
        ops,
      ).effects,
    );

  it("adds the call in hand when a chained step or a step that says nothing about its calls would keep it", () => {
    // db.update(t, u=1).where(w=1)
    const update = callOps({
      method: "update",
      keywords: { u: "1" },
      args: [text("t")],
      chained: callOps({ method: "where", keywords: { w: "1" } }),
    });

    expect(keywordsFrom([{ to: "chained", method: "where" }], update)).toEqual([
      ["update", "read", [], ["w"]],
    ]);
    expect(keywordsFrom([{ to: "chained", every: true }], update)).toEqual([
      ["update", "read", [], ["w", "u"]],
    ]);
    expect(keywordsFrom([{ to: "argument", at: 0 }], update)).toEqual([
      ["update", "read", [], ["u"]],
    ]);
  });

  it("walks to the end of the chain when no call on it is the origin's", () => {
    const calls = chainOf(
      { method: "query", keywords: { q: "1" } },
      { method: "filter", keywords: { a: "1" } },
      { method: "first" },
    );

    expect(keywordsFrom([LATER], lastOf(calls))).toEqual([
      ["first", "read", [], ["a", "q"]],
    ]);
  });

  it("finds the chain start of a call made on no call, and of receivers that come back round", () => {
    const alone = callOps({ method: "query", keywords: { k: "q" } });
    // a = b.next(); b = a.next(), each written in place on the other
    const loop: { a?: CallOps; b?: CallOps } = {};
    loop.a = {
      ...callOps({ method: "next", site: "a", keywords: { k: "a" } }),
      receiver: () => loop.b ?? null,
      chainedOn: () => loop.b ?? null,
    };
    loop.b = {
      ...callOps({ method: "next", site: "b", keywords: { k: "b" } }),
      receiver: () => loop.a ?? null,
      chainedOn: () => loop.a ?? null,
    };
    const fromStart = (ops: CallOps) =>
      accesses(
        run(
          [
            storageCalls({ system: "vault" }).otherwise({
              kind: "read",
              selector: { keywordsOf: { of: [{ to: "chainStart" }] } },
            }),
          ],
          ops,
        ).effects,
      );

    expect(fromStart(alone)).toEqual([["query", "read", [], ["k"]]]);
    expect(fromStart(loop.a)).toEqual([["next", "read", [], ["k"]]]);
  });
});

describe("the arguments that are columns of a class nothing names", () => {
  it("reads none", () => {
    const calls = chainOf({
      method: "query",
      onSession: true,
      args: [text("count"), column("User", "id")],
    });
    const read = run(
      [
        storageCalls({
          system: "vault",
          client: SESSION,
          clientAt: FIRST,
        }).otherwise({
          kind: "read",
          fields: {
            columns: { from: 0 },
            ofClass: { class: { at: 0 }, notFrom: [] },
          },
        }),
      ],
      lastOf(calls),
    );

    expect(accesses(read.effects)).toEqual([["query", "read", [], []]]);
  });
});

describe("a call on the client that records nothing", () => {
  // db.execute(stmt).scalars().all(), read at its first call
  const nothing = storageCalls(
    { system: "vault", client: SESSION },
    { outermost: true },
  )
    .about({ to: "chainStart" })
    .methods({ execute: { kind: "nothing" } });
  const hooksOf = (match: typeof nothing) =>
    pack("vault", [match], {
      languages: ["python"],
      recognizedAs: "@suss/vault-test",
    }).invocationRecognizers ?? [];

  it("matches with no effect, so the call counts as the client's, and a method the table leaves out does not match", () => {
    const [hook] = hooksOf(nothing);
    const ran = chainOf(
      { method: "execute", onSession: true },
      { method: "scalars" },
      { method: "all" },
    );
    const other = chainOf({ method: "query", onSession: true });

    expect(hook?.(null, { ops: lastOf(ran) })).toEqual([]);
    expect(hook?.(null, { ops: lastOf(other) })).toBeNull();
  });

  it("is a hook that claims the call that starts its chain, as every chain read at its last call is", () => {
    const [read] = hooksOf(nothing);
    const [everyCall] = hooksOf(
      storageCalls({ system: "vault", client: SESSION }).otherwise({
        kind: "read",
      }),
    );

    expect(read?.claimsChainStart).toBe(true);
    expect(everyCall?.claimsChainStart).toBeUndefined();
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
