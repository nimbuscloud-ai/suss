import { describe, expect, it } from "vitest";

import { astLink } from "./ast.js";
import { examplesMissing, runExamples } from "./example.js";
import { constructedFrom, declaredBy, opsIn } from "./ops.js";
import { pack } from "./pack.js";
import { storageCalls } from "./storage.js";

import type { Effect } from "@suss/behavioral-ir";
import type { StorageMethod } from "./chain.js";
import type { CallOps, ReceiverOrigin } from "./ops.js";

/** A call, as the ops see it, so a chain can run with no compiler here. */
function callOps(over: {
  method?: string | null;
  from?: readonly string[];
  args?: ReadonlyArray<string | null>;
  callee?: string;
  node?: unknown;
}): CallOps {
  const args = over.args ?? [];
  const from = over.from ?? [];
  return {
    method: () => over.method ?? null,
    receiverIsFrom: (origin: ReceiverOrigin) =>
      origin.importedFrom.some((module) => from.includes(module)),
    argumentCount: () => args.length,
    nameAt: (index) => args[index] ?? null,
    calleeText: () => over.callee ?? "client.get",
    ast: () => over.node ?? null,
  } as CallOps;
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

describe("reading the ops off a context", () => {
  it("gives null for a context with none", () => {
    expect(opsIn(undefined)).toBeNull();
    expect(opsIn({})).toBeNull();
  });
});
