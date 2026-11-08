import { describe, expect, it } from "vitest";

import { byOrigin } from "@suss/extractor";

import { compile } from "./compile.js";
import {
  anyOf,
  constructedFrom,
  declaredBy,
  global,
  imported,
  returnedBy,
  typed,
} from "./ops.js";
import { pack } from "./pack.js";
import { storageCalls } from "./storage.js";
import { streamWrites } from "./streamWrites.js";

import type { Effect, TypeShape } from "@suss/behavioral-ir";
import type { ByOrigin } from "@suss/extractor";
import type { CallOps, ReceiverOrigin, ValueOps } from "./ops.js";

/** One written value: its shape, and what an encoder or a template says about it. */
interface Written {
  shape?: TypeShape;
  encodes?: Written;
  /** A template that puts this text either side of one hole. */
  around?: { parts: [string, string]; hole: Written };
}

function writtenValue(written: Written): ValueOps {
  return {
    text: () => null,
    name: () => null,
    flag: () => null,
    entries: () => [],
    items: () => [],
    property: () => null,
    asArg: () => null,
    parts: () => written.around?.parts ?? null,
    holes: () => [],
    interpolated: () =>
      written.around === undefined ? [] : [writtenValue(written.around.hole)],
    shape: () => written.shape ?? null,
    encoded: () =>
      written.encodes === undefined
        ? null
        : { codec: "json", value: writtenValue(written.encodes) },
  };
}

/** A call, as the ops see it, with the global its receiver is. */
function writeCall(over: {
  method: string | null;
  callee: string;
  /** What `receiverGlobal` says, whatever paths it is asked about. */
  receiverGlobal?: string | null;
  /** The global the call goes to with no receiver. */
  bareGlobal?: string;
  typed?: boolean;
  args?: readonly Written[];
}): CallOps {
  const args = over.args ?? [];
  const receiverFrom: ByOrigin<boolean> = {
    global: (origin) =>
      over.receiverGlobal !== undefined &&
      (over.receiverGlobal === null ||
        origin.paths.includes(over.receiverGlobal)),
    typed: () => over.typed === true,
    anyOf: (origin) => origin.of.some((one) => byOrigin(receiverFrom, one)),
    declaredBy: () => false,
    constructed: () => false,
    returnedBy: () => false,
    imported: () => false,
  };
  return {
    method: () => over.method,
    receiverIsFrom: (origin: ReceiverOrigin) => byOrigin(receiverFrom, origin),
    receiverGlobal: (paths) =>
      over.receiverGlobal === undefined ||
      (over.receiverGlobal !== null && !paths.includes(over.receiverGlobal))
        ? undefined
        : over.receiverGlobal,
    isFrom: (origin: ReceiverOrigin) =>
      origin.origin === "global" &&
      over.bareGlobal !== undefined &&
      origin.paths.includes(over.bareGlobal),
    argumentCount: () => args.length,
    nameAt: () => null,
    calleeText: () => over.callee,
    namedCallee: () => over.method === null,
    receiver: () => null,
    argument: () => null,
    callee: () => null,
    propertyAt: () => null,
    valueAt: (index) => {
      const written = args[index];
      return written === undefined ? null : writtenValue(written);
    },
  };
}

const STDOUT_AND_STDERR = streamWrites({
  streams: { "process.stdout": "stdout", "process.stderr": "stderr" },
  client: anyOf(
    global("process.stdout", "process.stderr"),
    typed({ from: ["global"], named: ["NodeJS.WriteStream"] }),
  ),
})
  .methods({ write: { to: "receiver" } })
  .example('process.stdout.write("done")');

const CONSOLE = streamWrites({
  streams: {},
  client: anyOf(
    global("console"),
    typed({ from: ["global"], named: ["Console"] }),
  ),
})
  .methods({ log: { to: "stdout" }, error: { to: "stderr" } })
  .example('console.error("failed")');

const PUTS = streamWrites({ streams: {}, client: global("puts") }).methods({
  puts: { to: "stdout" },
});

function writes(
  chain: { declared: Parameters<typeof compile>[0] },
  call: CallOps,
): Effect[] | null {
  return compile(chain.declared, "@suss/streams")(null, { ops: call });
}

/** The stream each effect says it writes to. */
function targetsOf(effects: Effect[] | null): (string | null)[] {
  return (effects ?? []).map((effect) =>
    effect.type === "interaction" && effect.binding?.semantics.name === "io"
      ? effect.binding.semantics.target
      : "not io",
  );
}

const TEXT: Written = { shape: { type: "text" } };
const REPORT: TypeShape = { type: "record", properties: {} };

describe("a stream-write chain", () => {
  it("writes to the stream the receiver's path gives", () => {
    const call = writeCall({
      method: "write",
      callee: "process.stderr.write",
      receiverGlobal: "process.stderr",
      args: [TEXT],
    });
    expect(writes(STDOUT_AND_STDERR, call)).toEqual([
      {
        type: "interaction",
        binding: {
          transport: "in-process",
          semantics: { name: "io", target: "stderr" },
          recognition: "@suss/streams",
        },
        callee: "process.stderr.write",
        interaction: {
          class: "stream-write",
          payload: { type: "text" },
          serialized: "text",
        },
        groupId: expect.stringMatching(/^process\.stderr\.write:[0-9a-f]{7}$/),
      },
    ]);
  });

  it("writes to no stream in particular through a receiver matched by its type, or reached by two", () => {
    const typedOnly = writeCall({
      method: "error",
      callee: "out.error",
      typed: true,
    });
    const reachedByTwo = writeCall({
      method: "write",
      callee: "out.write",
      receiverGlobal: null,
    });
    expect(targetsOf(writes(CONSOLE, typedOnly))).toEqual([null]);
    expect(targetsOf(writes(STDOUT_AND_STDERR, reachedByTwo))).toEqual([null]);
  });

  it("reads a call of the global with no receiver by its callee, whatever its method is", () => {
    // Ruby says `puts` is a method on self.
    const call = writeCall({
      method: "puts",
      callee: "puts",
      bareGlobal: "puts",
    });
    expect(targetsOf(writes(PUTS, call))).toEqual(["stdout"]);
    expect(
      writes(PUTS, writeCall({ method: "p", callee: "p", bareGlobal: "p" })),
    ).toBeNull();
  });

  it("reads what an encoder was handed, alone or with only whitespace around it", () => {
    const encoded: Written = { encodes: { shape: REPORT } };
    const cases: readonly (readonly Written[])[] = [
      [encoded],
      [{ around: { parts: ["", "\n"], hole: encoded } }],
      [{ around: { parts: ["report: ", ""], hole: encoded }, ...TEXT }],
      [TEXT, { shape: { type: "number" } }],
    ];
    const payloads = cases.map((args) => {
      const [effect] =
        writes(
          STDOUT_AND_STDERR,
          writeCall({
            method: "write",
            callee: "process.stdout.write",
            receiverGlobal: "process.stdout",
            args,
          }),
        ) ?? [];
      return effect?.type === "interaction" ? effect.interaction : null;
    });
    expect(payloads).toEqual([
      { class: "stream-write", payload: REPORT, serialized: "json" },
      { class: "stream-write", payload: REPORT, serialized: "json" },
      { class: "stream-write", payload: { type: "text" }, serialized: "text" },
      {
        class: "stream-write",
        payload: {
          type: "record",
          properties: { "0": { type: "text" }, "1": { type: "number" } },
        },
        serialized: "text",
      },
    ]);
  });

  it("reads the path of the global among any other origins the client lists", () => {
    const everyOrigin = streamWrites({
      streams: { "process.stdout": "stdout" },
      client: anyOf(
        declaredBy("tape"),
        constructedFrom("tape"),
        returnedBy("deck", declaredBy("tape")),
        imported({ from: ["tape"] }),
        global("process.stdout"),
      ),
    }).methods({ write: { to: "receiver" } });
    const call = writeCall({
      method: "write",
      callee: "process.stdout.write",
      receiverGlobal: "process.stdout",
    });
    expect(targetsOf(writes(everyOrigin, call))).toEqual(["stdout"]);
  });

  it("matches a bare call of a global through a calls link, when the client lists one", () => {
    const tracked = storageCalls({
      system: "tally",
      client: anyOf(global("track"), declaredBy("tally")),
    }).calls({ kind: "write" });
    const call = writeCall({
      method: null,
      callee: "track",
      bareGlobal: "track",
    });
    const [effect] = writes(tracked, call) ?? [];
    expect(effect).toMatchObject({
      callee: "track",
      interaction: { class: "storage-access", operation: "track" },
    });
  });

  it("never reads a method every object inherits as one the table lists", () => {
    const call = writeCall({
      method: "toString",
      callee: "console.toString",
      receiverGlobal: "console",
    });
    expect(writes(CONSOLE, call)).toBeNull();
  });

  it("goes on the invocation walk, in process, and a global gates on no import", () => {
    const assembled = pack("streams", [PUTS, CONSOLE], {
      languages: ["ruby"],
      recognizedAs: "@suss/streams",
    });
    expect(assembled.invocationRecognizers).toHaveLength(2);
    expect(assembled.accessRecognizers).toBeUndefined();
    expect(assembled.protocol).toBe("in-process");
    expect(
      pack("puts", [PUTS], {
        languages: ["ruby"],
        recognizedAs: "@suss/streams",
      }).requiresImport,
    ).toEqual([]);
    expect(assembled.declarations?.declarations.map((one) => one.name)).toEqual(
      ["streamWrite", "streamWrite"],
    );
  });
});
