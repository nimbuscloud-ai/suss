import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { global } from "./ops.js";
import { declarationsIn, pack } from "./pack.js";
import { runtimeReads } from "./runtimeReads.js";

import type { Effect } from "@suss/behavioral-ir";
import type { EntryMeaning } from "./chain.js";
import type {
  CallOps,
  ReadOps,
  RuntimeObject,
  SuppliedKey,
  ValueOps,
} from "./ops.js";

const CONFIG: EntryMeaning = { reads: "config" };
const META: EntryMeaning = { reads: "metadata" };

/** A value that settles to `settled` and is written as `source`. */
function value(settled: string | number | null, source = String(settled)) {
  return {
    evaluated: () => settled,
    source: () => source,
  } as unknown as ValueOps;
}

/** What a read site says, with nothing defaulted, assigned or read off it unless the test says so. */
interface Site {
  /** The path the object is spelled as. */
  object?: string;
  entry?: string | null;
  defaulted?: boolean;
  fallback?: ValueOps;
  assigned?: ValueOps;
  source?: string;
  readsOff?: ReadOps[];
  keys?: SuppliedKey[];
}

function site(spec: Site): ReadOps {
  return {
    isOff: (object: RuntimeObject) =>
      object.origin === "global" &&
      spec.object !== undefined &&
      object.paths.includes(spec.object),
    objectPath: (paths) =>
      spec.object !== undefined && paths.includes(spec.object)
        ? spec.object
        : undefined,
    entry: () => spec.entry,
    readsOff: () => spec.readsOff ?? [],
    defaulted: () => spec.defaulted ?? false,
    fallback: () => spec.fallback ?? null,
    assigned: () => spec.assigned ?? null,
    source: () => spec.source ?? "",
    keysSuppliedTo: () => spec.keys ?? [],
  };
}

function run(
  chain: ReturnType<typeof runtimeReads>,
  ctx: { read?: ReadOps; ops?: CallOps },
): Effect[] {
  return compile(chain.declared, "@suss/test")(null, ctx) ?? [];
}

const ENV = runtimeReads({
  object: global("process.env"),
  deployment: { instanceName: "Job" },
})
  .entries({ MODE: { reads: "metadata", callee: "dotted" } }, CONFIG)
  .throughHelpers();

describe("a read chain", () => {
  it("reads an entry the table does not list through otherwise", () => {
    const effects = run(ENV, {
      read: site({
        object: "process.env",
        entry: "PORT",
        defaulted: true,
        fallback: value(8080),
        source: "process.env.PORT",
      }),
    });
    expect(effects).toEqual([
      {
        type: "interaction",
        binding: {
          transport: "os",
          semantics: { name: "runtime-config", instanceName: "Job" },
          recognition: "@suss/test",
        },
        callee: "process.env.PORT",
        interaction: {
          class: "config-read",
          name: "PORT",
          defaulted: true,
          default: 8080,
        },
      },
    ]);
  });

  it("spells a listed metadata entry as the dotted read, with no deployment", () => {
    const [effect] = run(ENV, {
      read: site({ object: "process.env", entry: "MODE", source: "x" }),
    });
    expect(effect).toMatchObject({
      binding: { semantics: { name: "runtime-config" } },
      callee: "process.env.MODE",
      interaction: { class: "metadata-read", name: "process.env.MODE" },
    });
  });

  it("names a computed key's read by the site as written", () => {
    const [effect] = run(ENV, {
      read: site({
        object: "process.env",
        entry: null,
        source: "process.env[key]",
      }),
    });
    expect(effect).toMatchObject({
      callee: "process.env[key]",
      interaction: { name: null },
    });
  });

  it("reads nothing at an empty key, a site that reads no entry, or a site off another object", () => {
    expect(
      [
        site({ object: "process.env", entry: "" }),
        site({ object: "process.env" }),
        site({ object: "import.meta.env", entry: "PORT" }),
      ].flatMap((read) => run(ENV, { read })),
    ).toEqual([]);
  });

  it("reports the reads off the object at the object's own site", () => {
    const off = site({ object: "process.env", entry: "HOST", source: "x" });
    const effects = run(ENV, {
      read: site({ object: "process", entry: "env", readsOff: [off] }),
    });
    expect(effects).toMatchObject([{ callee: "process.env.HOST" }]);
    expect(effects).toHaveLength(1);
  });

  it("asks nothing read off a site that is not the object", () => {
    const off = site({ object: "process.env", entry: "HOST" });
    expect(
      run(ENV, {
        read: site({ object: "process", entry: "argv", readsOff: [off] }),
      }),
    ).toEqual([]);
  });

  it("reads a key a helper is supplied, once per name, defaulted only where every site is", () => {
    const sites = [
      site({ object: "process.env", defaulted: true }),
      site({ defaulted: false }),
    ];
    const effects = run(ENV, {
      read: site({ source: 'requireEnv("TABLE")' }),
      ops: {} as CallOps,
    });
    expect(effects).toEqual([]);
    const supplied = run(ENV, {
      read: site({
        keys: [
          { at: 0, value: value("TABLE"), forwarded: false, sites },
          { at: 1, value: value("TABLE"), forwarded: false, sites },
          { at: 2, value: value("SKIPPED"), forwarded: true, sites },
          { at: 3, value: value(7), forwarded: false, sites },
        ],
      }),
    });
    expect(
      supplied.map((effect) =>
        effect.type === "interaction"
          ? [effect.callee, effect.interaction]
          : [],
      ),
    ).toEqual([
      [
        "process.env.TABLE",
        { class: "config-read", name: "TABLE", defaulted: false },
      ],
    ]);
  });

  it("reads an entry with a name of its own and its callee as written", () => {
    const chain = runtimeReads({ object: global("process") }).entries({
      argv: { reads: "config", named: "argv", callee: "site" },
    });
    const [effect] = run(chain, {
      read: site({ object: "process", entry: "argv", source: "process.argv" }),
    });
    expect(effect).toMatchObject({
      callee: "process.argv",
      interaction: { name: "argv", defaulted: false },
    });
  });

  it("reads an entry off an indexed entry's value as one of its own, and a key worked out at run time as nothing more", () => {
    const chain = runtimeReads({ object: global("process") }).entries({
      argv: {
        reads: "config",
        named: "argv",
        callee: "site",
        indexed: "argv[{key}]",
      },
      cwd: META,
    });
    const offArgv = [
      site({ entry: "2", source: "process.argv[2]", defaulted: true }),
      site({ entry: null, source: "process.argv[i]" }),
      site({ entry: "" }),
      site({}),
    ];
    const effects = run(chain, {
      read: site({
        object: "process",
        entry: "argv",
        source: "process.argv",
        readsOff: offArgv,
      }),
    });
    const metadata = run(chain, {
      read: site({ object: "process", entry: "cwd", readsOff: offArgv }),
    });
    expect([...effects, ...metadata]).toMatchObject([
      { callee: "process.argv", interaction: { name: "argv" } },
      {
        callee: "process.argv[2]",
        interaction: { name: "argv[2]", defaulted: true },
      },
      { interaction: { class: "metadata-read" } },
    ]);
    expect(effects).toHaveLength(2);
  });

  it("spells a callee as the object alone", () => {
    const chain = runtimeReads({ object: global("__dirname") }).entries(
      {},
      { reads: "metadata", callee: "object" },
    );
    const [effect] = run(chain, {
      read: site({ object: "__dirname", entry: "length" }),
    });
    expect(effect).toMatchObject({ callee: "__dirname" });
  });

  it("reads nothing for an entry it says reads nothing, nor for an entry it leaves out", () => {
    const chain = runtimeReads({ object: global("import.meta") }).entries({
      env: { reads: "nothing" },
      url: META,
    });
    expect(
      [
        site({ object: "import.meta", entry: "env" }),
        site({ object: "import.meta", entry: "dirname" }),
      ].flatMap((read) => run(chain, { read })),
    ).toEqual([]);
  });

  it("records an assignment to a listed entry as a state change, and a read of it as nothing", () => {
    const chain = runtimeReads({ object: global("process") })
      .entries({ argv: CONFIG })
      .writes({ exitCode: { changes: "state" } });
    const write = (assigned: ValueOps) =>
      run(chain, {
        read: site({
          object: "process",
          entry: "exitCode",
          assigned,
          source: "process.exitCode",
        }),
      });
    expect([
      ...write(value(1)),
      ...write(value(null, "await run()")),
      ...run(chain, { read: site({ object: "process", entry: "exitCode" }) }),
    ]).toEqual([
      { type: "stateChange", variable: "process.exitCode", newValue: 1 },
      {
        type: "stateChange",
        variable: "process.exitCode",
        newValue: "await run()",
      },
    ]);
  });

  it("makes an assignment to any entry nothing when it says so, and still reads one", () => {
    const chain = runtimeReads({ object: global("os.environ") })
      .entries({}, CONFIG)
      .writes({}, { changes: "nothing" });
    const assigned = run(chain, {
      read: site({ object: "os.environ", entry: "W", assigned: value("1") }),
    });
    const read = run(chain, {
      read: site({ object: "os.environ", entry: "W" }),
    });
    expect([assigned.length, read.length]).toEqual([0, 1]);
  });

  it("reads nothing through a helper that only assigns the entry it is handed, when an assignment is nothing", () => {
    const chain = runtimeReads({ object: global("process.env") })
      .entries({}, CONFIG)
      .writes({}, { changes: "nothing" })
      .throughHelpers();
    const assigns = site({
      object: "process.env",
      entry: null,
      assigned: value(null, "value"),
    });
    const reads = site({ object: "process.env", entry: null, defaulted: true });
    const namesAt = (sites: ReadOps[]) =>
      run(chain, {
        read: site({
          keys: [{ at: 0, value: value("TABLE"), forwarded: false, sites }],
        }),
      }).map((effect) =>
        effect.type === "interaction" ? effect.interaction : null,
      );
    expect([namesAt([assigns]), namesAt([assigns, reads])]).toEqual([
      [],
      [{ class: "config-read", name: "TABLE", defaulted: true }],
    ]);
  });

  it("reads through a helper that assigns the entry when the chain says nothing about assignments", () => {
    const sites = [
      site({ object: "process.env", entry: null, assigned: value("1") }),
    ];
    expect(
      run(ENV, {
        read: site({
          keys: [{ at: 0, value: value("TABLE"), forwarded: false, sites }],
        }),
      }),
    ).toHaveLength(1);
  });

  it("reads nothing off a parameter a platform fills, since none is stated yet", () => {
    const chain = runtimeReads({
      object: { origin: "handedIn", name: "env" },
    }).entries({}, CONFIG);
    expect(
      run(chain, { read: site({ object: "env", entry: "PORT" }) }),
    ).toEqual([]);
  });

  it("reads nothing where the adapter hands no read ops", () => {
    expect(run(ENV, {})).toEqual([]);
  });

  it("refuses a read chain that says no object its reads are off", () => {
    expect(() =>
      compile(
        {
          links: [],
          ending: { yields: "runtimeRead", deployment: {} },
          example: null,
        },
        "@suss/test",
      ),
    ).toThrow("states the object its reads are off");
  });

  it("goes on the access walk of a pack, which reaches the process it runs in", () => {
    const built = pack("node-reads", [ENV], {
      languages: ["typescript"],
      recognizedAs: "@suss/test",
    });
    expect([
      built.protocol,
      built.invocationRecognizers?.length,
      built.accessRecognizers?.length,
    ]).toEqual(["in-process", 0, 1]);
  });

  it("is described as data, with the example it was given", () => {
    const chain = runtimeReads({ object: global("process.env") })
      .entries({}, CONFIG)
      .example("process.env.PORT");
    expect(declarationsIn([chain]).declarations).toEqual([
      {
        name: "runtimeRead",
        dataLinks: 2,
        functionLinks: [],
        astLinks: [],
        example: "process.env.PORT",
      },
    ]);
  });
});

describe("a getter on a read chain", () => {
  const GETTER = runtimeReads({ object: global("ENV") })
    .entries({}, CONFIG)
    .getters({
      fetch: {
        key: { at: 0 },
        fallback: [{ at: 1 }, { block: true }],
        raisesWithout: true,
      },
    });

  function call(spec: {
    method?: string;
    receiverIsFrom?: boolean;
    args?: ValueOps[];
    block?: ValueOps | null;
  }): CallOps {
    return {
      method: () => spec.method ?? "fetch",
      receiverIsFrom: () => spec.receiverIsFrom ?? true,
      receiverGlobal: () => "ENV",
      valueAt: (index: number) => spec.args?.[index] ?? null,
      keywordAt: () => null,
      block: () => spec.block ?? null,
    } as unknown as CallOps;
  }

  it("reads the key, and copes with a missing value through the fallback passed", () => {
    const effects = run(GETTER, {
      read: site({ defaulted: true }),
      ops: call({ args: [value("B"), value("d")] }),
    });
    expect(effects).toMatchObject([
      {
        callee: "ENV.B",
        interaction: { name: "B", defaulted: true, default: "d" },
      },
    ]);
  });

  it("takes a block as the fallback when the call passes no argument", () => {
    const [effect] = run(GETTER, {
      read: site({}),
      ops: call({ args: [value("C")], block: value(null) }),
    });
    expect(effect).toMatchObject({ interaction: { defaulted: true } });
  });

  it("is not defaulted without a fallback, since the getter raises", () => {
    const [effect] = run(GETTER, {
      read: site({ defaulted: true }),
      ops: call({ args: [value("H")] }),
    });
    expect(effect).toMatchObject({ interaction: { defaulted: false } });
  });

  it("reads nothing for another method or another receiver", () => {
    expect([
      ...run(GETTER, {
        read: site({}),
        ops: call({ method: "key?", args: [value("B")] }),
      }),
      ...run(GETTER, {
        read: site({}),
        ops: call({ receiverIsFrom: false, args: [value("B")] }),
      }),
    ]).toEqual([]);
  });

  it("reads a key nothing settles as a read with no name", () => {
    const [effect] = run(GETTER, {
      read: site({ source: "ENV.fetch(name)" }),
      ops: call({ args: [value(null)] }),
    });
    expect(effect).toMatchObject({
      callee: "ENV.fetch(name)",
      interaction: { name: null },
    });
  });

  it("reads nothing at an empty key, and takes the call's own coping when the getter has no fallback", () => {
    const plain = runtimeReads({ object: global("ENV") })
      .entries({}, CONFIG)
      .getters({ fetch: { key: { at: 0 } } });
    const [effect] = run(plain, {
      read: site({ defaulted: true, fallback: value("z") }),
      ops: call({ args: [value("B"), value("d")] }),
    });
    expect([
      run(GETTER, { read: site({}), ops: call({ args: [value("")] }) }),
      effect,
    ]).toMatchObject([
      [],
      { interaction: { name: "B", defaulted: true, default: "z" } },
    ]);
  });
});

describe("a read chain with less said", () => {
  it("reads nothing off an object whose entries it does not say", () => {
    const chain = runtimeReads({ object: global("process") }).writes({
      exitCode: { changes: "state" },
    });
    expect(
      run(chain, { read: site({ object: "process", entry: "argv" }) }),
    ).toEqual([]);
  });

  it("reads nothing at a call whose keys settle to no name", () => {
    const sites = [site({ object: "process.env" })];
    expect(
      run(ENV, {
        read: site({
          keys: [
            { at: 0, value: value("TABLE"), forwarded: true, sites },
            { at: 1, value: value(null), forwarded: false, sites },
            { at: 2, value: value("NONE"), forwarded: false, sites: [] },
          ],
        }),
      }),
    ).toEqual([]);
  });
});
