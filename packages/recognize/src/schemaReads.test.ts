import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { constructedFrom, global } from "./ops.js";
import { schemaReads } from "./schemaReads.js";

import type { Effect } from "@suss/behavioral-ir";
import type { SchemaParse } from "./chain.js";
import type {
  CallOps,
  CallsAndOptions,
  ReadOps,
  ReceiverOrigin,
  RuntimeObject,
  ValueEntry,
  ValueOps,
} from "./ops.js";

/** What a value says, with nothing stated unless the test says so. */
interface Value {
  entries?: ValueEntry[];
  /** The path among the object's this value is. */
  path?: string;
  /** Whether the value mentions one of the defaulting words. */
  defaults?: boolean;
  properties?: Record<string, ValueOps>;
  settles?: string | number;
}

function value(spec: Value = {}): ValueOps {
  const ops: ValueOps = {
    text: () => null,
    name: () => null,
    flag: () => null,
    entries: () => spec.entries ?? [],
    items: () => [],
    property: (name) => spec.properties?.[name] ?? null,
    asArg: () => null,
    parts: () => null,
    holes: () => [],
    object: () => (spec.entries === undefined ? null : ops),
    runtimePath: (object: RuntimeObject) =>
      object.origin === "global" &&
      spec.path !== undefined &&
      object.paths.includes(spec.path)
        ? spec.path
        : undefined,
    mentions: (words: CallsAndOptions) =>
      spec.defaults === true && words.calls.includes("default"),
    evaluated: () => spec.settles ?? null,
  };
  return ops;
}

/** One key of a schema, with whether its schema defaults it. */
function key(name: string | null, defaults = false): ValueEntry {
  return { key: name, value: value({ defaults }) };
}

/** What a call says, with nothing stated unless the test says so. */
interface Call {
  method?: string | null;
  callee?: string;
  from?: boolean;
  args?: ValueOps[];
  receiver?: CallOps | null;
  imported?: string | null;
  importedAs?: string | null;
  inCallee?: CallOps[];
}

function call(spec: Call): CallOps {
  return {
    method: () => spec.method ?? null,
    calleeText: () => spec.callee ?? spec.method ?? "",
    receiverIsFrom: () => spec.from ?? false,
    isFrom: () => false,
    argumentCount: () => spec.args?.length ?? 0,
    nameAt: () => null,
    receiver: () => spec.receiver ?? null,
    argument: () => null,
    callee: () => null,
    propertyAt: () => null,
    valueAt: (index) => spec.args?.[index] ?? null,
    calleeImport: () => spec.imported ?? null,
    calleeImportedAs: () => spec.importedAs ?? null,
    callsInCallee: () => spec.inCallee ?? [],
  };
}

function readAt(at: CallOps | null, fallback: ValueOps | null = null): ReadOps {
  return {
    isOff: () => false,
    objectPath: () => undefined,
    entry: () => undefined,
    byKey: () => false,
    computedKey: () => null,
    readsOff: () => [],
    defaulted: () => false,
    fallback: () => fallback,
    assigned: () => null,
    source: () => "",
    keysSuppliedTo: () => [],
    call: () => at,
  };
}

const ENVIRONMENT = global("process.env", "import.meta.env");
const DEFAULTED = { calls: ["default"], options: ["devDefault"] };
const CLEAN: SchemaParse = { environment: { at: 0 }, schema: [{ at: 1 }] };

function envalid(client?: ReceiverOrigin) {
  return schemaReads({
    object: ENVIRONMENT,
    deployment: { instanceName: "Job" },
    ...(client === undefined ? {} : { client }),
  })
    .methods({ cleanEnv: CLEAN })
    .defaultedWhen(DEFAULTED)
    .throughHelpers()
    .example("cleanEnv(process.env, { PORT: port() })");
}

const ENVALID = envalid(constructedFrom("envalid"));

function run(
  chain: { declared: Parameters<typeof compile>[0] },
  read: ReadOps | undefined,
): Effect[] {
  return compile(chain.declared, "@suss/test")(null, { read }) ?? [];
}

/** The callee, the name and whether it is defaulted, for each config read. */
function readsIn(effects: readonly Effect[]) {
  return effects.map((effect) =>
    effect.type === "interaction" && effect.interaction.class === "config-read"
      ? [effect.callee, effect.interaction.name, effect.interaction.defaulted]
      : null,
  );
}

/** `cleanEnv(<environment>, { PORT, TOKEN })`, PORT defaulted. */
function cleanEnv(over: Partial<Call> = {}, path = "process.env"): CallOps {
  return call({
    callee: "cleanEnv",
    from: true,
    args: [
      value({ path }),
      value({ entries: [key("PORT", true), key("TOKEN"), key(null), key("")] }),
    ],
    ...over,
  });
}

describe("a schema chain", () => {
  it("states the object first, then the start, the table and the rest", () => {
    expect(ENVALID.declared.links.map((link) => link.asks)).toEqual([
      "off",
      "start",
      "methods",
      "defaultedWhen",
      "throughHelpers",
    ]);
    expect(ENVALID.declared.ending).toEqual({
      yields: "runtimeRead",
      deployment: { instanceName: "Job" },
    });
    expect(envalid().declared.links.map((link) => link.asks)).not.toContain(
      "start",
    );
  });

  it("reads one config read per key a parse of the environment states", () => {
    const effects = run(ENVALID, readAt(cleanEnv()));
    expect(readsIn(effects)).toEqual([
      ["process.env.PORT", "PORT", true],
      ["process.env.TOKEN", "TOKEN", false],
    ]);
    expect(effects[0]).toMatchObject({
      binding: {
        semantics: { name: "runtime-config", instanceName: "Job" },
        recognition: "@suss/test",
      },
    });
  });

  it("names each read off the environment the call was handed", () => {
    expect(
      readsIn(run(ENVALID, readAt(cleanEnv({}, "import.meta.env")))),
    ).toEqual([
      ["import.meta.env.PORT", "PORT", true],
      ["import.meta.env.TOKEN", "TOKEN", false],
    ]);
  });

  it("records the value the call falls back to on a defaulted key only", () => {
    const [port, token] = run(
      ENVALID,
      readAt(cleanEnv(), value({ settles: 8080 })),
    );
    expect(port).toMatchObject({ interaction: { default: 8080 } });
    expect(token).not.toHaveProperty("interaction.default");
  });

  it("says nothing where the call is not one the start accepts", () => {
    expect(run(ENVALID, readAt(cleanEnv({ from: false })))).toEqual([]);
  });

  it("says nothing where the call is handed something other than the environment", () => {
    expect(run(ENVALID, readAt(cleanEnv({}, "request.body")))).toEqual([]);
  });

  it("says nothing where the schema has no keys, or the call passes none", () => {
    const empty = cleanEnv({ args: [value({ path: "process.env" })] });
    expect(run(ENVALID, readAt(empty))).toEqual([]);
  });

  it("reads a bare call the file imported under another name as the export", () => {
    const aliased = cleanEnv({ callee: "load", imported: "cleanEnv" });
    expect(readsIn(run(ENVALID, readAt(aliased)))).toHaveLength(2);
    const other = cleanEnv({ callee: "load", imported: "port" });
    expect(run(ENVALID, readAt(other))).toEqual([]);
    const method = cleanEnv({ method: "load", imported: "cleanEnv" });
    expect(run(ENVALID, readAt(method))).toEqual([]);
  });

  it("reads no alias for a chain with no module to have imported it from", () => {
    const aliased = cleanEnv({ callee: "load", imported: "cleanEnv" });
    expect(run(envalid(), readAt(aliased))).toEqual([]);
  });

  it("reads what a project function the call reaches parses, at the call", () => {
    const helper = call({
      callee: "loadConfig",
      inCallee: [call({ callee: "other" }), cleanEnv()],
    });
    expect(readsIn(run(ENVALID, readAt(helper)))).toEqual([
      ["process.env.PORT", "PORT", true],
      ["process.env.TOKEN", "TOKEN", false],
    ]);
  });

  it("reads nothing through a helper when the chain does not say to", () => {
    const direct = schemaReads({ object: ENVIRONMENT }).methods({
      cleanEnv: CLEAN,
    });
    const helper = call({ callee: "loadConfig", inCallee: [cleanEnv()] });
    expect(run(direct, readAt(helper))).toEqual([]);
    expect(readsIn(run(direct, readAt(cleanEnv())))).toEqual([
      ["process.env.PORT", "PORT", false],
      ["process.env.TOKEN", "TOKEN", false],
    ]);
  });

  it("reads nothing at a site that is no call, or with no read ops", () => {
    expect(run(ENVALID, readAt(null))).toEqual([]);
    expect(run(ENVALID, undefined)).toEqual([]);
  });
});

describe("a builder step", () => {
  const ZOD = schemaReads({ object: ENVIRONMENT })
    .methods({
      parse: {
        environment: { at: 0 },
        schema: [
          {
            of: [
              { to: "receiver" },
              { to: "builder", method: "object", from: ["zod"] },
            ],
            at: 0,
          },
        ],
      },
    })
    .defaultedWhen(DEFAULTED);

  const SHAPE = value({ entries: [key("URL")] });

  /** `<receiver>.parse(process.env)`. */
  function parse(receiver: CallOps): CallOps {
    return call({
      method: "parse",
      args: [value({ path: "process.env" })],
      receiver,
    });
  }

  it("climbs the receivers to the builder the module's value was called with", () => {
    const built = call({ method: "object", from: true, args: [SHAPE] });
    const strict = call({ method: "strict", receiver: built });
    expect(readsIn(run(ZOD, readAt(parse(strict))))).toEqual([
      ["process.env.URL", "URL", false],
    ]);
  });

  it("takes a bare call imported as the builder", () => {
    const built = call({ callee: "obj", importedAs: "object", args: [SHAPE] });
    expect(readsIn(run(ZOD, readAt(parse(built))))).toHaveLength(1);
  });

  it("passes over a call of the builder's name off a value from elsewhere", () => {
    const built = call({ method: "object", from: false, args: [SHAPE] });
    expect(run(ZOD, readAt(parse(built)))).toEqual([]);
  });

  it("reads through eight refinements and stops at a ninth", () => {
    const built = call({ method: "object", from: true, args: [SHAPE] });
    const refined = (hops: number): CallOps =>
      Array.from({ length: hops }).reduce<CallOps>(
        (inner) => call({ method: "strict", receiver: inner }),
        built,
      );
    expect(run(ZOD, readAt(parse(refined(8))))).toHaveLength(1);
    expect(run(ZOD, readAt(parse(refined(9))))).toEqual([]);
  });
});
