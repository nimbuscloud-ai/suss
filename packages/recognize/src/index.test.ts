import { describe, expect, it } from "vitest";

import { astLink } from "./ast.js";
import { examplesMissing, runExamples } from "./example.js";
import { messageSends } from "./messageSends.js";
import { constructedFrom, declaredBy, opsIn } from "./ops.js";
import { pack } from "./pack.js";
import { sqlStatements } from "./sqlStatements.js";
import { storageCalls } from "./storage.js";
import { unitInvokes } from "./unitInvokes.js";

import type { Effect } from "@suss/behavioral-ir";
import type { SqlMethod, StorageMethod } from "./chain.js";
import type { CallOps, ReceiverOrigin, ValueOps } from "./ops.js";

/** The container one storage effect reached, or null for anything else. */
const containerOf = (effect: Effect | undefined): string | null =>
  effect?.type === "interaction" && effect.binding?.semantics.name === "storage"
    ? effect.binding.semantics.container
    : null;

/** A call, as the ops see it, so a chain can run with no compiler here. */
function callOps(over: {
  method?: string | null;
  from?: readonly string[];
  args?: ReadonlyArray<string | null>;
  callee?: string;
  node?: unknown;
  /** The calls this one's arguments are, by position. */
  built?: Record<number, CallOps>;
  /** The call the receiver is. */
  receiver?: CallOps;
  /** What each argument's properties say, by position. */
  properties?: Record<number, Record<string, string>>;
  /** What each argument states, by position, as plain data. */
  values?: Record<number, unknown>;
  /** The call the callee was written as. */
  writtenAs?: CallOps;
  /** Whether the callee is a bound name. */
  namedCallee?: boolean;
  /** What a selector lambda reads, by argument position. */
  selectorReads?: Record<number, readonly string[]>;
}): CallOps {
  const args = over.args ?? [];
  const from = over.from ?? [];
  const values = over.values ?? {};
  return {
    valueAt: (index) => (index in values ? valueOps(values[index]) : null),
    method: () => over.method ?? null,
    receiverIsFrom: (origin: ReceiverOrigin) =>
      origin.importedFrom.some((module) => from.includes(module)),
    isFrom: (origin: ReceiverOrigin) =>
      origin.importedFrom.some((module) => from.includes(module)),
    argumentCount: () => args.length,
    nameAt: (index) => args[index] ?? null,
    calleeText: () => over.callee ?? "client.get",
    receiver: () => over.receiver ?? null,
    argument: (index) => over.built?.[index] ?? null,
    callee: () => over.writtenAs ?? null,
    namedCallee: () => over.namedCallee ?? false,
    parameterReadsAt: (index: number) => over.selectorReads?.[index] ?? null,
    propertyAt: (index, property) =>
      over.properties?.[index]?.[property] ??
      (index in values
        ? (valueOps(values[index]).property(property)?.text() ?? null)
        : null),
    ast: () => over.node ?? null,
  } as CallOps;
}

/** A value, as the ops see it, from what a call would have stated. */
function valueOps(stated: unknown): ValueOps {
  const object =
    typeof stated === "object" && stated !== null && !Array.isArray(stated)
      ? (stated as Record<string, unknown>)
      : null;
  return {
    text: () => (typeof stated === "string" ? stated : null),
    name: () => (typeof stated === "string" ? stated : null),
    asArg: () =>
      typeof stated === "string" ? { kind: "string", value: stated } : null,
    flag: () => (typeof stated === "boolean" ? stated : null),
    items: () =>
      Array.isArray(stated) ? stated.map((item) => valueOps(item)) : [],
    entries: () =>
      Object.entries(object ?? {}).map(([key, value]) => ({
        key,
        value: valueOps(value),
      })),
    property: (name) =>
      object === null || !(name in object) ? null : valueOps(object[name]),
    parts: () => interpolated(stated)?.parts ?? partsOf(stated),
    holes: () => interpolated(stated)?.holes ?? [],
  };
}

/** A statement a test writes as its pieces of text and what fills its holes. */
interface Interpolated {
  readonly parts: string[];
  readonly holes: (CallOps | null)[];
}

/** Whether a test wrote a statement with the holes spelled out. */
function interpolated(stated: unknown): Interpolated | null {
  const written = stated as Partial<Interpolated> | null;
  const spelled =
    typeof written === "object" &&
    written !== null &&
    Array.isArray(written.parts) &&
    Array.isArray(written.holes);
  return spelled ? (written as Interpolated) : null;
}

/**
 * The text a value states, in pieces. A test writes a plain string for
 * a statement with no holes and a list of strings for one with them.
 */
function partsOf(stated: unknown): string[] | null {
  if (typeof stated === "string") {
    return [stated];
  }
  if (Array.isArray(stated) && stated.every((it) => typeof it === "string")) {
    return stated as string[];
  }
  return null;
}

/** What the properties of an object a call states are called. */
function keysIn(value: ValueOps): string[] {
  const found: string[] = [];
  for (const entry of value.entries("nothing")) {
    if (entry.key !== null) {
      found.push(entry.key);
    }
  }
  return found;
}

const READ_KEY: StorageMethod = { kind: "read", selector: { at: 0 } };
const READ_KEYS: StorageMethod = { kind: "read", selector: { from: 0 } };
const WRITE_FIELD: StorageMethod = {
  kind: "write",
  selector: { at: 0 },
  fields: { at: 1 },
};

const store = (over: { ignoringCase?: boolean } = {}) =>
  storageCalls({ system: "cassette", client: declaredBy("tapedeck") })
    .methods(
      { get: READ_KEY, mget: READ_KEYS, hset: WRITE_FIELD },
      { ignoringCase: over.ignoringCase ?? false },
    )
    .example('deck.get("side_a:1")');

const packOf = (calls: ReturnType<typeof store>) =>
  pack("tapedeck", [calls], {
    languages: ["typescript"],
    recognizedAs: "@suss/framework-tapedeck",
  });

function run(calls: ReturnType<typeof store>, ops: CallOps): Effect[] | null {
  const [recognizer] = packOf(calls).invocationRecognizers ?? [];
  if (recognizer === undefined) {
    throw new Error("the pack compiled no recognizer");
  }
  return recognizer(null, { ops });
}

describe("a storage chain", () => {
  it("emits one access for a method the table lists on the right client", () => {
    const effects = run(
      store(),
      callOps({ method: "get", from: ["tapedeck"], args: ["side_a:1"] }),
    );

    expect(effects).toEqual([
      {
        type: "interaction",
        binding: {
          transport: "cassette",
          semantics: {
            name: "storage",
            storageSystem: "cassette",
            scope: "default",
            container: "side_a:1",
            accessPath: null,
          },
          recognition: "@suss/framework-tapedeck",
        },
        callee: "client.get",
        interaction: {
          class: "storage-access",
          kind: "read",
          fields: [],
          operation: "get",
          selector: ["side_a:1"],
        },
      },
    ]);
  });

  it("leaves a method the table does not list alone", () => {
    expect(
      run(store(), callOps({ method: "ping", from: ["tapedeck"] })),
    ).toBeNull();
  });

  it("leaves the same method on somebody else's client alone", () => {
    expect(
      run(store(), callOps({ method: "get", from: ["other"], args: ["k"] })),
    ).toBeNull();
  });

  it("takes two spellings of one method as one when the pack says to", () => {
    const effects = run(
      store({ ignoringCase: true }),
      callOps({ method: "hSet", from: ["tapedeck"], args: ["a", "b"] }),
    );

    expect(effects?.[0]).toMatchObject({
      interaction: { kind: "write", operation: "hSet", fields: ["b"] },
    });
  });

  it("reads every argument from a position on when the method takes a list", () => {
    const effects = run(
      store(),
      callOps({ method: "mget", from: ["tapedeck"], args: ["a", "b", "c"] }),
    );

    expect(effects?.[0]).toMatchObject({
      interaction: { selector: ["a", "b", "c"] },
    });
  });

  it("drops an argument nothing settles rather than inventing a name", () => {
    const effects = run(
      store(),
      callOps({ method: "mget", from: ["tapedeck"], args: ["a", null] }),
    );

    expect(effects?.[0]).toMatchObject({ interaction: { selector: ["a"] } });
  });

  it("states no container when the call reached nothing it could name", () => {
    const effects = run(
      store(),
      callOps({ method: "get", from: ["tapedeck"], args: [null] }),
    );

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: null } },
      interaction: { fields: [] },
    });
    expect(effects?.[0]).not.toHaveProperty("interaction.selector");
  });

  it("matches nothing on an adapter that has not implemented the ops", () => {
    const [recognizer] = packOf(store()).invocationRecognizers ?? [];
    expect(recognizer?.(null, {})).toBeNull();
  });

  it("matches nothing where the call reaches for no method at all", () => {
    expect(run(store(), callOps({ method: null }))).toBeNull();
  });
});

describe("a container rule the pack wrote itself", () => {
  const withNamespace = store().container((selector) => {
    const [first] = selector;
    return first?.split(":")[0] ?? null;
  });

  it("decides the container from the names the call reached", () => {
    const effects = run(
      withNamespace,
      callOps({ method: "get", from: ["tapedeck"], args: ["side_a:1"] }),
    );

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: "side_a" } },
    });
  });

  it("prices the chain: one link written as code, the rest data", () => {
    expect(packOf(withNamespace).declarations).toEqual({
      declarations: [
        {
          name: "cassette",
          dataLinks: 2,
          functionLinks: ["container"],
          astLinks: [],
          example: 'deck.get("side_a:1")',
        },
      ],
    });
  });
});

describe("the escape to the raw syntax tree", () => {
  const reading = store().container(
    astLink((node: unknown, _selector: readonly string[]) => String(node)),
  );

  it("hands the link the adapter's own node", () => {
    const effects = run(
      reading,
      callOps({
        method: "get",
        from: ["tapedeck"],
        args: ["k"],
        node: "the node",
      }),
    );

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: "the node" } },
    });
  });

  it("reports the link, so the escape is never quiet", () => {
    expect(packOf(reading).declarations?.declarations[0]).toMatchObject({
      functionLinks: ["container"],
      astLinks: ["container"],
    });
  });
});

describe("the pack a chain assembles into", () => {
  it("gates on the modules the client came from and takes the wire as protocol", () => {
    expect(packOf(store())).toMatchObject({
      name: "tapedeck",
      protocol: "cassette",
      languages: ["typescript"],
      requiresImport: ["tapedeck"],
      discovery: [],
      terminals: [],
    });
  });

  it("takes the wire over the store's own name when the pack states one", () => {
    const overWire = storageCalls({
      system: "cassette",
      transport: "reel",
      client: constructedFrom("tapedeck"),
      scope: "b_side",
      unsettledName: "nothing",
    }).methods({ get: READ_KEY });

    expect(packOf(overWire).protocol).toBe("reel");
    expect(
      run(
        overWire,
        callOps({ method: "get", from: ["tapedeck"], args: ["k"] }),
      )?.[0],
    ).toMatchObject({ binding: { transport: "reel" } });
  });

  it("stamps a version when the pack states one", () => {
    const stamped = pack("tapedeck", [store()], {
      languages: ["typescript"],
      recognizedAs: "@suss/framework-tapedeck",
      version: "1.2.3",
    });

    expect(stamped.version).toBe("1.2.3");
    expect(packOf(store()).version).toBeUndefined();
  });

  it("refuses a pack whose chains reach two different wires", () => {
    const other = storageCalls({
      system: "reel",
      client: declaredBy("tapedeck"),
    }).methods({ get: READ_KEY });

    expect(() =>
      pack("tapedeck", [store(), other], {
        languages: ["typescript"],
        recognizedAs: "@suss/framework-tapedeck",
      }),
    ).toThrow("split it into one pack per wire");
  });
});

describe("the example every declaration states", () => {
  it("runs each one and hands back what it produced", () => {
    const ran = runExamples(packOf(store()), (code) => [
      { type: "invocation", callee: code } as unknown as Effect,
    ]);

    expect(ran).toEqual([
      {
        match: "cassette",
        example: 'deck.get("side_a:1")',
        effects: [{ type: "invocation", callee: 'deck.get("side_a:1")' }],
      },
    ]);
  });

  it("says which declarations state none, and runs nothing for them", () => {
    const bare = storageCalls({
      system: "cassette",
      client: declaredBy("tapedeck"),
    });
    const built = packOf(bare.methods({ get: READ_KEY }) as never);

    expect(examplesMissing(built)).toEqual(["cassette"]);
    expect(runExamples(built, () => [])).toEqual([]);
    expect(examplesMissing(packOf(store()))).toEqual([]);
  });

  it("says nothing about a pack that declared nothing", () => {
    expect(examplesMissing({ name: "x" } as never)).toEqual([]);
  });
});

describe("a chain about the command a call was handed", () => {
  const commandCalls = storageCalls({
    system: "cassette",
    client: constructedFrom("tapedeck"),
  })
    .about({ to: "argument", at: { from: 0 } })
    .methods({
      PlaySideCommand: {
        kind: "read",
        selector: { at: 0, property: ["Track"] },
      },
    })
    .container({ at: 0, property: ["Side"] })
    .example('deck.send(new PlaySideCommand({ Side: "a", Track: "1" }))');

  const command = callOps({
    callee: "PlaySideCommand",
    from: ["tapedeck"],
    args: [null],
    properties: { 0: { Side: "a", Track: "1" } },
  });

  it("reads the operation off the command and the rest out of its inputs", () => {
    const effects = run(
      commandCalls,
      callOps({
        method: "send",
        callee: "deck.send",
        args: [null],
        built: { 0: command },
      }),
    );

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: "a" } },
      callee: "deck.send",
      interaction: { operation: "PlaySideCommand", selector: ["1"] },
    });
  });

  it("takes the command wherever the call passes it", () => {
    const effects = run(
      commandCalls,
      callOps({
        method: "sign",
        args: [null, null],
        built: { 1: command },
      }),
    );

    expect(effects?.[0]).toMatchObject({
      interaction: { operation: "PlaySideCommand" },
    });
  });

  it("leaves a call whose arguments are no command it knows alone", () => {
    expect(
      run(commandCalls, callOps({ method: "send", args: [null] })),
    ).toBeNull();
  });

  it("stops on the argument the step says the library built", () => {
    const guarded = storageCalls({ system: "cassette" })
      .about({
        to: "argument",
        at: { from: 0 },
        origin: constructedFrom("tapedeck"),
      })
      .methods({ PlaySideCommand: { kind: "read" } })
      .container({ at: 0, property: ["Side"] });
    const ours = callOps({ callee: "PlaySideCommand", args: [null] });

    const sending = (built: Record<number, CallOps>) =>
      run(guarded, callOps({ method: "send", args: [null, null], built }));

    expect(sending({ 0: ours, 1: command })).toMatchObject([
      { binding: { semantics: { container: "a" } } },
    ]);
    expect(sending({ 0: ours })).toBeNull();
  });

  it("gates on the module a step says the command came from", () => {
    const guarded = storageCalls({ system: "cassette" })
      .about({
        to: "argument",
        at: 0,
        origin: constructedFrom("tapedeck"),
      })
      .methods({ PlaySideCommand: { kind: "read" } });

    expect(packOf(guarded).requiresImport).toEqual(["tapedeck"]);
  });
});

describe("a chain read back up its receivers", () => {
  const side = callOps({ method: "side", args: ["a"] });
  const track = callOps({ method: "track", args: ["1"], receiver: side });

  const chainCalls = storageCalls({
    system: "cassette",
    client: declaredBy("tapedeck"),
  })
    .methods({
      play: {
        kind: "read",
        selector: { of: [{ to: "receiver", method: "track" }], at: 0 },
      },
    })
    .container({ of: [{ to: "receiver", method: "side" }], at: 0 })
    .example('deck.side("a").track("1").play()');

  it("finds each hop by the method it calls, however far back it is", () => {
    const effects = run(
      chainCalls,
      callOps({ method: "play", from: ["tapedeck"], receiver: track }),
    );

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: "a" } },
      interaction: { operation: "play", selector: ["1"] },
    });
  });

  it("gives up on a receiver that comes back round to itself", () => {
    const loop = { ops: null as CallOps | null };
    const circular = callOps({ method: "wound", args: ["x"] });
    Object.assign(circular, { receiver: () => loop.ops });
    loop.ops = circular;

    const effects = run(
      chainCalls,
      callOps({ method: "play", from: ["tapedeck"], receiver: circular }),
    );

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: null } },
    });
  });
});

describe("a method the caller says which way round it goes", () => {
  const signing = storageCalls({
    system: "cassette",
    client: declaredBy("tapedeck"),
  }).methods({
    sign: {
      kind: {
        asks: { at: 0, property: ["action"] },
        means: { write: "write" },
        otherwise: "read",
      },
    },
  });

  it("takes the kind from what the call asked for", () => {
    const effects = run(
      signing,
      callOps({
        method: "sign",
        from: ["tapedeck"],
        args: [null],
        properties: { 0: { action: "write" } },
      }),
    );

    expect(effects?.[0]).toMatchObject({ interaction: { kind: "write" } });
  });

  it("falls back to what the library does when the call says nothing", () => {
    const effects = run(
      signing,
      callOps({ method: "sign", from: ["tapedeck"], args: [null] }),
    );

    expect(effects?.[0]).toMatchObject({ interaction: { kind: "read" } });
  });
});

/**
 * The four things a call against one request object needs, which a
 * chain of picks over positional arguments could not state.
 */
describe("a call that states one request object", () => {
  const requests = storageCalls({
    system: "cassette",
    client: declaredBy("tapedeck"),
  })
    .methods({
      play: {
        kind: "read",
        fields: ({ input, entry }) =>
          (entry ?? input).property("Tracks")?.text()?.split(",") ?? [],
      },
    })
    .input({ at: 0 })
    .container({ at: 0, property: ["Side"] })
    .accessPath({ at: 0, property: ["Order"] })
    .containersIn({ at: 0, property: ["Sides"] });

  const playing = (values: Record<number, unknown>) =>
    run(requests, callOps({ method: "play", from: ["tapedeck"], values }));

  it("records the way in the call took as the access path", () => {
    const effects = playing({
      0: { Side: "a", Order: "shuffled", Tracks: "one,two" },
    });

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: "a", accessPath: "shuffled" } },
      interaction: { fields: ["one", "two"] },
    });
  });

  it("gives one access per entry of a map of the containers it reached", () => {
    const effects = playing({
      0: { Sides: { a: { Tracks: "one" }, b: { Tracks: "two" } } },
    });

    expect(effects).toHaveLength(2);
    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: "a" } },
      interaction: { fields: ["one"] },
    });
    expect(effects?.[1]).toMatchObject({
      binding: { semantics: { container: "b" } },
      interaction: { fields: ["two"] },
    });
  });

  it("leaves a call that states no request alone", () => {
    expect(playing({})).toBeNull();
  });

  describe("and states the containers as a list of names", () => {
    const byName = storageCalls({
      system: "cassette",
      client: declaredBy("tapedeck"),
    })
      .methods({ play: { kind: "read" } })
      .containersIn({ at: 0, property: ["Sides"] }, { each: "name" });

    const playing = (values: Record<number, unknown>) =>
      run(byName, callOps({ method: "play", from: ["tapedeck"], values }));

    it("gives one access per name", () => {
      const effects = playing({ 0: { Sides: ["a", "b"] } });

      expect(effects).toHaveLength(2);
      expect(effects?.map((e) => containerOf(e))).toEqual(["a", "b"]);
    });

    it("records one access with no container when it cannot read the list", () => {
      const effects = playing({ 0: { Sides: true } });

      expect(effects).toHaveLength(1);
      expect(containerOf(effects?.[0])).toBeNull();
    });
  });

  it("prices the rule the pack wrote over the request", () => {
    expect(packOf(requests).declarations?.declarations[0]).toMatchObject({
      dataLinks: 6,
      functionLinks: ["fields"],
      astLinks: [],
    });
  });
});

/**
 * What a library that spreads one call over several arguments needs. A
 * rule pointed at the value it reads covers it, and a method whose own
 * name settles the answer states it outright.
 */
describe("a rule that says which value it reads", () => {
  const listing = storageCalls({
    system: "cassette",
    client: declaredBy("tapedeck"),
  }).methods({
    play: {
      kind: "read",
      selector: { of: { at: 0 }, by: ({ input }) => keysIn(input) },
      fields: { of: { at: 1 }, by: ({ input }) => keysIn(input) },
    },
    erase: { kind: "write", selector: ["*"], fields: ["*"] },
    scan: {
      kind: "read",
      fields: {
        of: { at: 0 },
        by: ({ input }) => [
          ...(input.text() === null ? [] : ["text"]),
          ...(input.flag() === null ? [] : ["flag"]),
          ...(input.parts() === null ? [] : ["parts"]),
          ...input.holes().map(() => "hole"),
          ...(input.property("side") === null ? [] : ["property"]),
          ...input.items().map(() => "item"),
          ...input.entries("nothing").map(() => "entry"),
        ],
      },
    },
  });

  const playing = (values: Record<number, unknown>) =>
    run(listing, callOps({ method: "play", from: ["tapedeck"], values }));

  it("reads one argument for the selector and the next for the fields", () => {
    const effects = playing({ 0: { side: "a" }, 1: { title: 1 } });

    expect(effects?.[0]).toMatchObject({
      interaction: { selector: ["side"], fields: ["title"] },
    });
  });

  it("runs the rule anyway when the call passed nothing there", () => {
    const effects = playing({ 0: { side: "a" } });

    expect(effects?.[0]).toMatchObject({
      interaction: { selector: ["side"], fields: [] },
    });
  });

  it("gives a rule a value that states nothing, whatever it asks", () => {
    const effects = run(
      listing,
      callOps({ method: "scan", from: ["tapedeck"] }),
    );

    expect(effects?.[0]).toMatchObject({ interaction: { fields: [] } });
  });

  it("takes the answer a method states outright", () => {
    const effects = run(
      listing,
      callOps({ method: "erase", from: ["tapedeck"] }),
    );

    expect(effects?.[0]).toMatchObject({
      interaction: { selector: ["*"], fields: ["*"] },
    });
  });

  it("prices a rule pointed at a value the way it prices any other", () => {
    expect(packOf(listing).declarations?.declarations[0]).toMatchObject({
      dataLinks: 2,
      functionLinks: ["selector", "fields"],
      astLinks: [],
    });
  });
});

describe("an operation the call says rather than the name it goes to", () => {
  const helper = storageCalls({ system: "cassette" })
    .methods({
      request: {
        operation: { at: 0 },
        kind: { asks: { at: 0 }, means: { Play: "read", Record: "write" } },
      },
    })
    .input({ at: 1 })
    .container({ at: 1, property: ["Side"] });

  const calling = (operation: string) =>
    run(
      helper,
      callOps({
        callee: "request",
        args: [operation, null],
        values: { 1: { Side: "a" } },
      }),
    );

  it("reports what the argument said and takes the kind from it", () => {
    expect(calling("Record")?.[0]).toMatchObject({
      interaction: { operation: "Record", kind: "write" },
    });
  });

  it("leaves an operation the pack does not list alone", () => {
    expect(calling("Erase")).toBeNull();
  });

  it("gates on nothing, for a helper the project rather than a library wrote", () => {
    expect(packOf(helper).requiresImport).toEqual([]);
  });
});

describe("a pack that reads more files than its chains match in", () => {
  it("takes the further modules the project named for the gate", () => {
    const gated = pack("tapedeck", [store()], {
      languages: ["typescript"],
      recognizedAs: "@suss/framework-tapedeck",
      requiresImport: ["reel-to-reel"],
    });

    expect(gated.requiresImport).toEqual(["tapedeck", "reel-to-reel"]);
  });
});

const STATEMENT: SqlMethod = { statement: { at: 0 } };

const queries = (over: { dialect?: string } = {}) =>
  sqlStatements({
    system: "postgresql",
    dialect: over.dialect ?? "postgresql",
    client: declaredBy("tapedeck"),
  })
    .methods({ query: STATEMENT, exec: STATEMENT })
    .example('deck.query("SELECT id FROM tapes")');

function runQuery(
  calls: ReturnType<typeof queries>,
  ops: CallOps,
): Effect[] | null {
  const [recognizer] =
    pack("tapedeck", [calls], {
      languages: ["typescript"],
      recognizedAs: "@suss/framework-tapedeck",
    }).accessRecognizers ?? [];
  if (recognizer === undefined) {
    throw new Error("the pack compiled no recognizer");
  }
  return recognizer(null, { ops });
}

const asking = (statement: unknown, method = "query") =>
  runQuery(
    queries(),
    callOps({
      method,
      from: ["tapedeck"],
      callee: "deck.query",
      values: { 0: statement },
    }),
  );

/** A table object a query interpolates, with the name its factory gave. */
const tableHole = (from: string, table: string) =>
  callOps({ method: null, from: [from], args: [table] });

/** The same chain, told that a hole is a table its factory call settles. */
const interpolating = (parts: string[], holes: (CallOps | null)[]) =>
  runQuery(
    queries().interpolating({
      from: constructedFrom("tapedeck"),
      named: { at: 0 },
    }),
    callOps({
      method: "query",
      from: ["tapedeck"],
      callee: "deck.query",
      values: { 0: { parts, holes } },
    }),
  );

describe("a chain over statements written as SQL", () => {
  it("emits one access per table the statement touches", () => {
    const effects = asking(
      "SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id = 1",
    );

    expect(effects).toEqual([
      {
        type: "interaction",
        binding: {
          transport: "postgresql",
          semantics: {
            name: "storage",
            storageSystem: "postgresql",
            scope: "default",
            container: "users",
            accessPath: null,
          },
          recognition: "@suss/framework-tapedeck",
        },
        callee: "deck.query",
        interaction: {
          class: "storage-access",
          kind: "read",
          fields: ["email"],
          operation: "query",
          selector: ["id"],
        },
      },
      {
        type: "interaction",
        binding: {
          transport: "postgresql",
          semantics: {
            name: "storage",
            storageSystem: "postgresql",
            scope: "default",
            container: "orders",
            accessPath: null,
          },
          recognition: "@suss/framework-tapedeck",
        },
        callee: "deck.query",
        interaction: {
          class: "storage-access",
          kind: "read",
          fields: ["total"],
          operation: "query",
        },
      },
    ]);
  });

  it("takes the kind from the statement rather than from the method", () => {
    expect(asking("UPDATE tapes SET side = 'b' WHERE id = 1", "exec")).toEqual([
      expect.objectContaining({
        interaction: expect.objectContaining({
          kind: "write",
          fields: ["side"],
          selector: ["id"],
        }),
      }),
    ]);
  });

  it("reads a statement the source wrote with holes in it", () => {
    const effects = asking(["SELECT id FROM tapes WHERE side = ", ""]);

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: "tapes" } },
      interaction: { kind: "read", selector: ["side"] },
    });
  });

  it("says nothing for a statement nobody can read", () => {
    expect(asking("MOUNT tapes")).toBeNull();
  });

  it("puts the name a hole gives into the statement before the parse", () => {
    const effects = interpolating(
      ["SELECT id FROM ", " WHERE side = ", ""],
      [tableHole("tapedeck", "tapes"), null],
    );

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: "tapes" } },
      interaction: { kind: "read", fields: ["id"], selector: ["side"] },
    });
  });

  it("leaves a hole from somewhere else the parameter it was", () => {
    expect(
      interpolating(["SELECT id FROM ", ""], [tableHole("other", "tapes")]),
    ).toBeNull();
  });

  it("reads every hole where the pack says nowhere in particular", () => {
    const effects = runQuery(
      queries().interpolating({ named: { at: 0 } }),
      callOps({
        method: "query",
        from: ["tapedeck"],
        callee: "deck.query",
        values: {
          0: {
            parts: ["SELECT id FROM ", ""],
            holes: [tableHole("other", "tapes")],
          },
        },
      }),
    );

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: "tapes" } },
    });
  });

  it("gates on the modules a hole has to have come from", () => {
    const assembled = pack(
      "tapedeck",
      [
        queries().interpolating({
          from: constructedFrom("tapedeck-schema"),
          named: { at: 0 },
        }),
      ],
      { languages: ["typescript"], recognizedAs: "@suss/framework-tapedeck" },
    );

    expect(assembled.requiresImport).toEqual(["tapedeck", "tapedeck-schema"]);
  });

  it("says nothing where the call states no statement at all", () => {
    expect(
      runQuery(queries(), callOps({ method: "query", from: ["tapedeck"] })),
    ).toBeNull();
  });

  it("leaves the same method on somebody else's client alone", () => {
    expect(
      runQuery(
        queries(),
        callOps({
          method: "query",
          from: ["other"],
          values: { 0: "SELECT id FROM tapes" },
        }),
      ),
    ).toBeNull();
  });

  it("parses in the dialect the pack states, not the store's own name", () => {
    const effects = runQuery(
      queries({ dialect: "sqlite" }),
      callOps({
        method: "query",
        from: ["tapedeck"],
        values: { 0: "SELECT id FROM tapes" },
      }),
    );

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { storageSystem: "postgresql" } },
    });
  });

  it("records the wire a pack states, where it differs from the store", () => {
    const overWire = sqlStatements({
      system: "d1",
      transport: "cloudflare-api",
      dialect: "sqlite",
      client: declaredBy("tapedeck"),
    }).methods({ query: STATEMENT });
    const effects = runQuery(
      overWire,
      callOps({
        method: "query",
        from: ["tapedeck"],
        values: { 0: "SELECT id FROM tapes" },
      }),
    );

    expect(effects?.[0]).toMatchObject({
      binding: { transport: "cloudflare-api" },
    });
  });

  it("matches on the method alone, for a helper a project wrote itself", () => {
    const helper = sqlStatements({
      system: "postgresql",
      dialect: "postgresql",
    }).methods({ runQuery: STATEMENT });
    const effects = runQuery(
      helper,
      callOps({
        method: "runQuery",
        from: [],
        values: { 0: "SELECT id FROM tapes" },
      }),
    );

    expect(effects?.[0]).toMatchObject({
      binding: { semantics: { container: "tapes" } },
    });
  });

  it("goes on the access walk, since a template is not an invocation", () => {
    const assembled = pack("tapedeck", [queries()], {
      languages: ["typescript"],
      recognizedAs: "@suss/framework-tapedeck",
    });

    expect(assembled.invocationRecognizers).toEqual([]);
    expect(assembled.accessRecognizers).toHaveLength(1);
    expect(assembled.declarations?.declarations).toEqual([
      {
        name: "postgresql",
        dataLinks: 2,
        functionLinks: [],
        astLinks: [],
        example: 'deck.query("SELECT id FROM tapes")',
      },
    ]);
  });
});

describe("reading the ops off a context", () => {
  it("gives null for a context with none", () => {
    expect(opsIn(undefined)).toBeNull();
    expect(opsIn({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A chain that sends a message
// ---------------------------------------------------------------------------

/** Where every one of these declarations says the message is. */
const IN_THE_COMMAND = {
  send: { input: { at: 0 } },
} as const;

const sends = (over: Partial<Parameters<typeof messageSends>[0]> = {}) =>
  messageSends({
    wire: "aws_sqs",
    client: declaredBy("tapedeck"),
    messages: { each: "theInput" },
    channel: [{ property: ["QueueUrl"] }],
    body: "MessageBody",
    ...over,
  })
    .methods(IN_THE_COMMAND)
    .example('client.send({ QueueUrl: "orders" })');

function runSend(
  calls: ReturnType<typeof sends>,
  ops: CallOps,
): Effect[] | null {
  const [recognizer] =
    pack("tapedeck", [calls], {
      languages: ["typescript"],
      recognizedAs: "@suss/framework-tapedeck",
    }).invocationRecognizers ?? [];
  if (recognizer === undefined) {
    throw new Error("the pack compiled no recognizer");
  }
  return recognizer(null, { ops });
}

const channelsOf = (effects: Effect[] | null) =>
  (effects ?? []).map((effect) =>
    effect.type === "interaction" &&
    effect.binding?.semantics.name === "message-bus"
      ? effect.binding.semantics.channel
      : null,
  );

describe("a chain that sends one message", () => {
  it("reads the channel and the body off the call's input", () => {
    const effects = runSend(
      sends(),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { QueueUrl: "orders", MessageBody: "{}" } },
      }),
    );
    expect(channelsOf(effects)).toEqual(["orders"]);
    expect(
      effects?.[0]?.type === "interaction" ? effects[0].interaction : null,
    ).toEqual({
      class: "message-send", // The body rides as the form an effect records an argument, so
      // the field set a consumer reads pairs against it. Text cannot
      // be paired field by field.
      body: { kind: "string", value: "{}" },
    });
  });

  it("says nothing when the call states no input at all", () => {
    expect(
      runSend(sends(), callOps({ method: "send", from: ["tapedeck"] })),
    ).toBeNull();
  });

  it("takes the library's default for a part the message leaves out", () => {
    const effects = runSend(
      sends({
        channel: [
          { property: ["Bus"], whenAbsent: "default" },
          { property: ["Kind"] },
        ],
      }),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { Kind: "OrderPlaced" } },
      }),
    );
    expect(channelsOf(effects)).toEqual(["default#OrderPlaced"]);
  });

  it("leaves the channel unnamed when a part is written but unsettled", () => {
    // Absent and unsettled are not the same thing. Absent means the
    // library fills the part in. Written-but-unsettled means the code
    // did say, somewhere this run cannot read, and claiming the
    // default there would place the send on a channel it never goes to.
    const effects = runSend(
      sends({
        channel: [{ property: ["QueueUrl"], whenAbsent: "default" }],
        unsettledName: "nothing",
      }),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { QueueUrl: true } },
      }),
    );
    expect(channelsOf(effects)).toEqual([null]);
  });

  it("lets one part keep the reference while another gives nothing", () => {
    const effects = runSend(
      sends({
        channel: [
          { property: ["Bus"], unsettled: "reference" },
          { property: ["Kind"], unsettled: "nothing" },
        ],
        unsettledName: "nothing",
      }),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { Bus: "orders", Kind: "OrderPlaced" } },
      }),
    );
    expect(channelsOf(effects)).toEqual(["orders#OrderPlaced"]);
  });

  it("rides the routing key along without joining the channel", () => {
    const effects = runSend(
      sends({ routingKey: "Source" }),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: {
          0: {
            QueueUrl: "orders",
            Source: "orders.service",
            MessageBody: "{}",
          },
        },
      }),
    );
    expect(channelsOf(effects)).toEqual(["orders"]);
    const sent =
      effects?.[0]?.type === "interaction" &&
      effects[0].interaction.class === "message-send"
        ? effects[0].interaction
        : null;
    expect(sent?.routingKey).toBe("orders.service");
  });

  it("reads a part written once beside the list of messages", () => {
    // A batch command states the queue on the call's input and the
    // messages one entry at a time, so the part says where it is.
    const effects = runSend(
      sends({
        messages: { each: "in", property: "Entries" },
        channel: [{ property: ["QueueUrl"], on: "theInput" }],
      }),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: {
          0: {
            QueueUrl: "orders",
            Entries: [{ MessageBody: "{}" }, { MessageBody: "{}" }],
          },
        },
      }),
    );
    expect(channelsOf(effects)).toEqual(["orders", "orders"]);
  });

  it("leaves the routing key off when the message does not state one", () => {
    const effects = runSend(
      sends({ routingKey: "Source" }),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { QueueUrl: "orders", MessageBody: "{}" } },
      }),
    );
    const sent =
      effects?.[0]?.type === "interaction" &&
      effects[0].interaction.class === "message-send"
        ? effects[0].interaction
        : null;
    expect(sent).not.toBeNull();
    expect(sent?.routingKey).toBeUndefined();
  });
});

describe("a chain that sends many", () => {
  const batch = () => sends({ messages: { each: "in", property: "Entries" } });

  it("records one message per entry", () => {
    expect(
      channelsOf(
        runSend(
          batch(),
          callOps({
            method: "send",
            from: ["tapedeck"],
            values: {
              0: {
                Entries: [{ QueueUrl: "orders" }, { QueueUrl: "invoices" }],
              },
            },
          }),
        ),
      ),
    ).toEqual(["orders", "invoices"]);
  });

  it("records one send with nothing claimed when the list is unreadable", () => {
    // A batch whose list this run cannot read is still a send. It used
    // to be dropped whole, and a service that sends read as one that
    // sends nothing.
    const effects = runSend(
      batch(),
      callOps({ method: "send", from: ["tapedeck"], values: { 0: {} } }),
    );
    expect(channelsOf(effects)).toEqual([null]);
  });
});

describe("a channel written in more than one place", () => {
  const twoParts = () =>
    sends({
      wire: "eventbridge",
      messages: { each: "in", property: "Entries" },
      channel: [
        { property: ["EventBusName"], whenAbsent: "default" },
        { property: ["DetailType"] },
      ],
      unsettledName: "nothing",
    });

  const entries = (entry: Record<string, unknown>) =>
    callOps({
      method: "send",
      from: ["tapedeck"],
      values: { 0: { Entries: [entry] } },
    });

  it("joins the parts in the order they are written", () => {
    expect(
      channelsOf(
        runSend(
          twoParts(),
          entries({ EventBusName: "orders", DetailType: "Placed" }),
        ),
      ),
    ).toEqual(["orders#Placed"]);
  });

  it("uses what the library uses when a part is left out", () => {
    expect(
      channelsOf(runSend(twoParts(), entries({ DetailType: "Placed" }))),
    ).toEqual(["default#Placed"]);
  });

  it("names no channel when a part is written where nothing can read it", () => {
    // A send named by half of itself would pair across buses.
    expect(
      channelsOf(runSend(twoParts(), entries({ EventBusName: "orders" }))),
    ).toEqual([null]);
  });

  it("joins with whatever separator the pack asks for", () => {
    expect(
      channelsOf(
        runSend(
          sends({
            messages: { each: "in", property: "Entries" },
            channel: [
              { property: ["EventBusName"] },
              { property: ["DetailType"] },
            ],
            channelSeparator: "/",
          }),
          entries({ EventBusName: "orders", DetailType: "Placed" }),
        ),
      ),
    ).toEqual(["orders/Placed"]);
  });
});

describe("what a declaration leaves out", () => {
  it("records no body when the pack does not say where one is", () => {
    const effects = runSend(
      messageSends({
        wire: "aws_sqs",
        client: declaredBy("tapedeck"),
        messages: { each: "theInput" },
        channel: [{ property: ["QueueUrl"] }],
      })
        .methods(IN_THE_COMMAND)
        .example('client.send({ QueueUrl: "orders" })'),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { QueueUrl: "orders", MessageBody: "{}" } },
      }),
    );
    expect(
      effects?.[0]?.type === "interaction" ? effects[0].interaction : null,
    ).toEqual({ class: "message-send" });
  });
});

describe("naming which export a client was made from", () => {
  it("takes the modules and the export names together", () => {
    expect(
      constructedFrom({
        from: ["@aws-sdk/client-sqs"],
        named: ["SendMessageBatchCommand"],
      }),
    ).toEqual({
      origin: "constructed",
      importedFrom: ["@aws-sdk/client-sqs"],
      named: ["SendMessageBatchCommand"],
    });
  });

  it("takes the modules alone, and matches whatever they export", () => {
    expect(constructedFrom("@aws-sdk/client-sqs")).toEqual({
      origin: "constructed",
      importedFrom: ["@aws-sdk/client-sqs"],
    });
  });
});

describe("a bare call of the tracked client", () => {
  const hookStore = () =>
    storageCalls({ system: "cassette", client: constructedFrom("tapedeck") })
      .methods({ get: READ_KEY })
      .calls({ kind: "read", fields: { selectorParam: 0 } })
      .example("useDeck((s) => s.sideA)");

  const written = callOps({ from: ["tapedeck"], callee: "makeDeck()" });

  it("matches by what the callee was written as, reading the selector", () => {
    const effects = run(
      hookStore(),
      callOps({
        callee: "useDeck",
        namedCallee: true,
        writtenAs: written,
        selectorReads: { 0: ["sideA"] },
      }),
    );

    expect(effects).toHaveLength(1);
    expect(effects?.[0]).toMatchObject({
      callee: "useDeck",
      interaction: {
        class: "storage-access",
        kind: "read",
        fields: ["sideA"],
        operation: "useDeck",
      },
    });
  });

  it("leaves a bare call written from another module alone", () => {
    const effects = run(
      hookStore(),
      callOps({
        callee: "useOther",
        namedCallee: true,
        writtenAs: callOps({ from: ["elsewhere"] }),
      }),
    );
    expect(effects).toBeNull();
  });

  it("leaves an expression called in place alone", () => {
    const effects = run(
      hookStore(),
      callOps({
        callee: "makeDeck()",
        namedCallee: false,
        writtenAs: written,
      }),
    );
    expect(effects).toBeNull();
  });

  it("still matches the methods table on the same chain", () => {
    const effects = run(
      hookStore(),
      callOps({ method: "get", from: ["tapedeck"], args: ["side_a:1"] }),
    );
    expect(effects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A chain that invokes a deployed unit
// ---------------------------------------------------------------------------

const invokes = (over: Partial<Parameters<typeof unitInvokes>[0]> = {}) =>
  unitInvokes({
    platform: "lambda",
    client: declaredBy("tapedeck"),
    named: ["FunctionName"],
    payload: "Payload",
    ...over,
  })
    .methods(IN_THE_COMMAND)
    .example('client.send({ FunctionName: "worker" })');

/** The same declaration with no payload property, which is its own shape. */
const invokesWithNoPayload = () =>
  unitInvokes({
    platform: "lambda",
    client: declaredBy("tapedeck"),
    named: ["FunctionName"],
  })
    .methods(IN_THE_COMMAND)
    .example('client.send({ FunctionName: "worker" })');

function runInvoke(
  calls: ReturnType<typeof invokes>,
  ops: CallOps,
): Effect[] | null {
  const [recognizer] =
    pack("tapedeck", [calls], {
      languages: ["typescript"],
      recognizedAs: "@suss/framework-tapedeck",
    }).invocationRecognizers ?? [];
  if (recognizer === undefined) {
    throw new Error("the pack compiled no recognizer");
  }
  return recognizer(null, { ops });
}

const unitsOf = (effects: Effect[] | null) =>
  (effects ?? []).map((effect) =>
    effect.type === "interaction" &&
    effect.binding?.semantics.name === "unit-invocation"
      ? effect.binding.semantics.instanceName
      : null,
  );

describe("a chain that invokes one unit", () => {
  it("reads the unit and the payload off the call's input", () => {
    const effects = runInvoke(
      invokes(),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { FunctionName: "worker", Payload: "{}" } },
      }),
    );
    expect(unitsOf(effects)).toEqual(["worker"]);
    expect(
      effects?.[0]?.type === "interaction" ? effects[0].interaction : null,
    ).toEqual({
      class: "unit-invoke",
      payload: { kind: "string", value: "{}" },
    });
  });

  it("gives one effect per call, however much the call hands over", () => {
    const effects = runInvoke(
      invokes(),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { FunctionName: "worker" } },
      }),
    );
    expect(effects).toHaveLength(1);
  });

  it("takes the function out of an ARN, so two accounts spell one name", () => {
    const effects = runInvoke(
      invokes(),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: {
          0: {
            FunctionName:
              "arn:aws:lambda:us-east-1:123456789012:function:worker",
          },
        },
      }),
    );
    expect(unitsOf(effects)).toEqual(["worker"]);
  });

  it("keeps the env-var reference a deploy-time name arrives as", () => {
    const effects = runInvoke(
      invokes(),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { FunctionName: "{WORKER_FUNCTION}" } },
      }),
    );
    expect(unitsOf(effects)).toEqual(["{WORKER_FUNCTION}"]);
  });

  it("records the call with no unit rather than dropping it", () => {
    const effects = runInvoke(
      invokes(),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { Payload: "{}" } },
      }),
    );
    expect(unitsOf(effects)).toEqual([null]);
  });

  it("tries each property the library may state the unit on, in order", () => {
    const effects = runInvoke(
      invokes({ named: ["FunctionName", "Target"] }),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { Target: "worker" } },
      }),
    );
    expect(unitsOf(effects)).toEqual(["worker"]);
  });

  it("says nothing when the call states no input at all", () => {
    expect(
      runInvoke(invokes(), callOps({ method: "send", from: ["tapedeck"] })),
    ).toBeNull();
  });

  it("leaves the payload off when the pack does not say where it is", () => {
    const effects = runInvoke(
      invokesWithNoPayload(),
      callOps({
        method: "send",
        from: ["tapedeck"],
        values: { 0: { FunctionName: "worker", Payload: "{}" } },
      }),
    );
    expect(
      effects?.[0]?.type === "interaction" ? effects[0].interaction : null,
    ).toEqual({ class: "unit-invoke" });
  });
});
