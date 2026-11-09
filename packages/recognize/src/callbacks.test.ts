import { describe, expect, it } from "vitest";

import { callbacks } from "./callbacks.js";
import { constructedFrom, modulesOf } from "./ops.js";
import { pack } from "./pack.js";

import type { Effect } from "@suss/behavioral-ir";
import type { ValueForm } from "@suss/extractor";
import type { CallbackPick } from "./chain.js";
import type { CallOps, ReceiverOrigin, ValueOps } from "./ops.js";

/** A value as a test writes it: how the source wrote it, and what reading it finds. */
interface Written {
  readonly form: ValueForm;
  readonly source?: string;
  /** Whether the value comes to an object, as a name for an options object does. */
  readonly object?: boolean;
  /** The object's own properties. */
  readonly own?: Readonly<Record<string, Written>>;
  readonly node?: string;
}

function valueOps(written: Written): ValueOps {
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
    form: () => written.form,
    source: () => written.source ?? "",
    object: () =>
      written.object === true ? valueOps({ form: "object" }) : null,
    ownProperty: (name) => {
      const held = written.own?.[name];
      return held === undefined ? null : valueOps(held);
    },
    ast: () => written.node ?? null,
  } as ValueOps;
}

/** A call to `callee`, made off the library `from` names, with these arguments. */
function callOps(over: {
  callee: string;
  from?: readonly string[];
  args?: readonly Written[];
  block?: Written;
}): CallOps {
  const from = over.from ?? ["@acme/jobs"];
  const args = over.args ?? [];
  const fromHere = (origin: ReceiverOrigin) =>
    modulesOf(origin).some((module) => from.includes(module));
  return {
    method: () => null,
    calleeText: () => over.callee,
    receiverIsFrom: fromHere,
    isFrom: fromHere,
    valueAt: (index) => {
      const written = args[index];
      return written === undefined ? null : valueOps(written);
    },
    block: () => (over.block === undefined ? null : valueOps(over.block)),
    argumentCount: () => args.length,
    nameAt: () => null,
    receiver: () => null,
    argument: () => null,
    callee: () => null,
    propertyAt: () => null,
  } as CallOps;
}

/** The v3 positional form or an options object, as the react-query pack reads a query. */
function functionAt(property: string, from: number): CallbackPick[] {
  return [0, 1, 2].flatMap((at): CallbackPick[] => [
    ...(at >= from ? [{ written: "callback" as const, at }] : []),
    { written: "here", at, property: [property] },
  ]);
}

const JOBS = callbacks({ client: constructedFrom("@acme/jobs") })
  .methods({
    later: { callback: functionAt("run", 1) },
    now: { callback: [{ written: "block" }] },
  })
  .schedules({
    via: "asWritten",
    unread: { missing: "missing-job", other: "unread-job" },
  })
  .unitWhenInPlace({
    kind: "scheduled-callback",
    name: ["parent", "callee", "countPerCallee"],
  })
  .example('later("nightly", () => sweep())');

const JOBS_PACK = pack("jobs", [JOBS], {
  languages: ["typescript"],
  recognizedAs: "@suss/framework-jobs",
});

function scheduled(ops: CallOps): Effect[] | null {
  const [recognizer] = JOBS_PACK.invocationRecognizers ?? [];
  if (recognizer === undefined) {
    throw new Error("the pack compiled no recognizer");
  }
  return recognizer(null, { ops });
}

/** What the effect says about the callback a call hands over. */
function callbackRefOf(ops: CallOps): unknown {
  const [effect] = scheduled(ops) ?? [];
  return effect?.type === "interaction" &&
    effect.interaction.class === "schedule"
    ? effect.interaction.callbackRef
    : null;
}

const KEY: Written = { form: "other", source: '"nightly"' };
const INLINE: Written = { form: "function", node: "the arrow" };

describe("a chain over calls that take a callback", () => {
  it("records a schedule effect on the callee as written, for a function written in place", () => {
    expect(
      scheduled(callOps({ callee: "later", args: [KEY, INLINE] })),
    ).toEqual([
      {
        type: "interaction",
        binding: {
          transport: "in-process",
          semantics: { name: "function-call" },
          recognition: "@suss/framework-jobs",
        },
        callee: "later",
        interaction: {
          class: "schedule",
          via: "later",
          callbackRef: { type: "literal" },
          hasDelay: false,
        },
      },
    ]);
  });

  it("records a name by what the source wrote", () => {
    const sweep: Written = { form: "name", source: "sweep" };
    expect(
      callbackRefOf(callOps({ callee: "later", args: [KEY, sweep] })),
    ).toEqual({ type: "identifier", name: "sweep" });
  });

  it("passes over a name for an options object and an argument written as undefined", () => {
    const options: Written = { form: "name", source: "options", object: true };
    const nothing: Written = { form: "other", source: "undefined" };
    expect(
      callbackRefOf(callOps({ callee: "later", args: [KEY, options] })),
    ).toEqual({ type: "opaque", reason: "missing-job" });
    expect(
      callbackRefOf(
        callOps({
          callee: "later",
          args: [KEY, nothing, { form: "object", own: { run: INLINE } }],
        }),
      ),
    ).toEqual({ type: "literal" });
  });

  it("reads an options object by its own keys, and only one written at the call", () => {
    const bySpread: Written = { form: "object", own: {} };
    const named: Written = {
      form: "name",
      object: true,
      own: { run: INLINE },
    };
    expect(
      callbackRefOf(callOps({ callee: "later", args: [bySpread] })),
    ).toEqual({ type: "opaque", reason: "missing-job" });
    expect(callbackRefOf(callOps({ callee: "later", args: [named] }))).toEqual({
      type: "opaque",
      reason: "missing-job",
    });
  });

  it("gives the pack's other reason for a value that is neither a function nor a name", () => {
    const read: Written = {
      form: "object",
      own: { run: { form: "other", source: "api.sweep" } },
    };
    expect(callbackRefOf(callOps({ callee: "later", args: [read] }))).toEqual({
      type: "opaque",
      reason: "unread-job",
    });
    const nested: Written = {
      form: "object",
      own: { run: { form: "object" } },
    };
    expect(callbackRefOf(callOps({ callee: "later", args: [nested] }))).toEqual(
      { type: "opaque", reason: "unread-job" },
    );
    const element: Written = {
      form: "object",
      own: { run: { form: "element", source: "<Job />" } },
    };
    expect(
      callbackRefOf(callOps({ callee: "later", args: [element] })),
    ).toEqual({ type: "opaque", reason: "unread-job" });
  });

  it("reads the block a call is written with", () => {
    expect(
      callbackRefOf(callOps({ callee: "now", block: { form: "function" } })),
    ).toEqual({ type: "literal" });
    expect(callbackRefOf(callOps({ callee: "now" }))).toEqual({
      type: "opaque",
      reason: "missing-job",
    });
  });

  it("matches nothing off another library", () => {
    expect(
      scheduled(
        callOps({
          callee: "later",
          from: ["@acme/other"],
          args: [KEY, INLINE],
        }),
      ),
    ).toBeNull();
  });
});

describe("the unit a callback written in place becomes", () => {
  const subUnits = JOBS_PACK.subUnits;
  const parent = { func: "the component", name: "Sweeper", kind: "component" };

  it("claims each function written in place, counted per callee in source order", () => {
    const calls = [
      callOps({ callee: "later", args: [KEY, { ...INLINE, node: "first" }] }),
      callOps({
        callee: "later",
        args: [KEY, { form: "name", source: "sweep" }],
      }),
      callOps({ callee: "now", block: { form: "function", node: "block" } }),
      callOps({ callee: "elsewhere", from: [], args: [INLINE] }),
      callOps({ callee: "later", args: [KEY, { ...INLINE, node: "second" }] }),
    ];
    const claimed = subUnits?.(parent, { calls: () => calls }) ?? [];
    expect(claimed.map((one) => [one.func, one.name, one.kind])).toEqual([
      ["first", "Sweeper.later#0", "scheduled-callback"],
      ["block", "Sweeper.now#0", "scheduled-callback"],
      ["second", "Sweeper.later#1", "scheduled-callback"],
    ]);
  });

  it("claims nothing from a context that lists no calls", () => {
    expect(subUnits?.(parent, {})).toEqual([]);
    expect(subUnits?.(parent, null)).toEqual([]);
  });

  it("is left off a pack whose chains say nothing about it", () => {
    const plain = callbacks({ client: constructedFrom("@acme/jobs") }).methods({
      later: { callback: functionAt("run", 1) },
    });
    const built = pack("jobs", [plain], {
      languages: ["typescript"],
      recognizedAs: "@suss/framework-jobs",
    });
    expect(built.subUnits).toBeUndefined();
    expect(built.protocol).toBe("in-process");
    expect(built.requiresImport).toEqual(["@acme/jobs"]);
  });

  it("goes by the schedule ending in the pack health report", () => {
    expect(JOBS_PACK.declarations?.declarations).toEqual([
      expect.objectContaining({
        name: "schedule",
        example: 'later("nightly", () => sweep())',
      }),
    ]);
  });
});
