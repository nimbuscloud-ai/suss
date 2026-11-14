import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { constructedFrom, declaredBy, global, typed } from "@suss/recognize";
import { factCallOps } from "@suss/recognize/ops";
import { GLOBAL_MODULE } from "@suss/resolution";
import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { callOpsFor } from "./callOps.js";
import { factSourceFor, readOpsAt, statedFactKey } from "./factSource.js";

import type {
  AstCapableValueOps,
  CallOps,
  PatternPack,
  ValueOps,
} from "@suss/extractor";
import type { CallExpression, Project } from "ts-morph";

const LIBRARY = `
  export default class Deck {
    play(track: string, options?: unknown, loud?: boolean, times?: number): Promise<void>;
    run(statement: unknown): Promise<void>;
  }
  export declare function sql(parts: TemplateStringsArray, ...values: unknown[]): unknown;
`;

const SOURCE = `
  import Deck, { sql } from "tapedeck";

  const deck = new Deck();
  const key = "volume";
  const draft = { name: "draft", loop: "always" };
  const options = { ...draft, name: "intro", [key]: 3, tags: ["a", "b"] };
  var ring = { ...ring, name: "ring" };

  function makeDeck() {
    return new Deck();
  }

  export async function play(id: string) {
    await deck.play("intro", options, true, 0);
    await makeDeck().run(sql\`SELECT * FROM tracks WHERE id = \${id}\`);
    await deck.play("ring", ring);
  }
`;

/**
 * Both kinds of ops for each call in the fixture, in source order. A
 * function the run reaches as a library gets no import check from the
 * store, so `storeImports: false` builds the ops the way it gets them.
 */
function bothOps({ storeImports = true, source = SOURCE } = {}): {
  fromNodes: CallOps;
  fromFacts: CallOps | null;
}[] {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/tapedeck/package.json",
    JSON.stringify({ name: "tapedeck", types: "index.d.ts" }),
  );
  project.createSourceFile("/node_modules/tapedeck/index.d.ts", LIBRARY);
  const file = project.createSourceFile("/repo.ts", source);
  const store = new ResolutionStore();
  const originatesFrom = storeImports
    ? (value: Node, module: string): boolean =>
        store.importOriginsOf(value, [module]).length > 0
    : undefined;
  const calls: CallExpression[] = [];
  file.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      calls.push(node);
    }
  });
  return calls.map((call) => ({
    fromNodes: callOpsFor(call, {
      resolve: (value) => store.resolveWrittenValue(value),
      resolution: store,
      ...(originatesFrom === undefined ? {} : { originatesFrom }),
      anchorCallsOf: (value, matches) => store.anchorCallsOf(value, matches),
    }),
    fromFacts: factCallOps(
      statedFactKey(call, store),
      factSourceFor(store, originatesFrom),
    ),
  }));
}

/** The answers a pack would read off one call. */
function answers(ops: CallOps | null) {
  const value = ops?.valueAt(1);
  return {
    method: ops?.method(),
    callee: ops?.calleeText(),
    count: ops?.argumentCount(),
    track: ops?.nameAt(0, "nothing"),
    loud: ops?.valueAt(2)?.flag(),
    times: ops?.valueAt(3)?.flag(),
    entries: value?.entries("nothing").map((entry) => entry.key),
    tags: value
      ?.property("tags")
      ?.items()
      .map((item) => item.text()),
    name: ops?.propertyAt(1, "name", "nothing"),
    loop: ops?.propertyAt(1, "loop", "nothing"),
    missing: value?.property("missing"),
    constructed: ops?.receiverIsFrom(constructedFrom("tapedeck")),
    declared: ops?.receiverIsFrom(declaredBy("tapedeck")),
    anchor: ops?.anchorCall?.(constructedFrom("tapedeck"))?.calleeText(),
    receiver: ops?.receiver()?.calleeText(),
    statement: ops?.valueAt(0)?.parts(),
    holes: ops
      ?.valueAt(0)
      ?.interpolated?.()
      .map((hole) => hole.asArg()),
  };
}

describe("the fact source", () => {
  it("gives a declared pack the same answers the node ops give", () => {
    const calls = bothOps();

    expect(calls.length).toBeGreaterThan(1);
    for (const { fromNodes, fromFacts } of calls) {
      expect(answers(fromFacts)).toEqual(answers(fromNodes));
    }
  });

  it("reads a call's arguments, its receiver's construction and a tagged statement", () => {
    const [played, ran] = bothOps().filter(
      ({ fromNodes }) => fromNodes.method() !== null,
    );

    expect(answers(played?.fromFacts ?? null)).toMatchObject({
      method: "play",
      track: "intro",
      loud: true,
      times: false,
      entries: ["name", "loop", "volume", "tags"],
      tags: ["a", "b"],
      name: "intro",
      loop: "always",
      constructed: true,
      declared: true,
    });
    expect(answers(ran?.fromFacts ?? null)).toMatchObject({
      method: "run",
      statement: ["SELECT * FROM tracks WHERE id = ", ""],
    });
  });

  it("reads an object that spreads itself once", () => {
    const [, , ringed] = bothOps().filter(
      ({ fromNodes }) => fromNodes.method() !== null,
    );

    expect(answers(ringed?.fromFacts ?? null)).toMatchObject({
      entries: ["name"],
      name: "ring",
      missing: null,
    });
  });

  it("finds the construction behind a receiver through the file's import when the store's check is missing", () => {
    const anchorsOf = (storeImports: boolean) =>
      bothOps({ storeImports })
        .filter(({ fromNodes }) => fromNodes.method() !== null)
        .map(({ fromNodes, fromFacts }) => [
          answers(fromNodes).anchor,
          answers(fromFacts).anchor,
        ]);
    const anchors = anchorsOf(false);

    expect(anchors[0]).toEqual(["Deck", "Deck"]);
    expect(anchors).toEqual(anchorsOf(true));
  });
});

const SHAPES = `
  import Deck from "tapedeck";

  const deck = new Deck();
  const users = ["a", "b"];
  const toRow = (user: string) => ({ name: user });
  function makeRow() {
    return { made: 1, kind: "row" };
  }
  function pick(flag: boolean) {
    if (flag) {
      return { a: 1 };
    }
    return { b: 2 };
  }
  const kept = users.map((user) => {
    const row = { viaName: user };
    return row;
  });

  export async function play(flag: boolean) {
    await deck.play("inline", users.map((user) => ({ inline: user })));
    await deck.play("named", users.map(toRow));
    await deck.play("kept", kept);
    await deck.play("made", makeRow());
    await deck.play("spread", { ...makeRow(), extra: 2 });
    await deck.play("twice", pick(flag));
    await deck.play("each", users.forEach((user) => ({ no: user })));
    await deck.play("built", new Deck());
  }
`;

/** What a pack reading a payload's shape gets off the second argument of each `play`. */
function shapesRead(ops: CallOps | null) {
  const value = ops?.valueAt(1);
  return {
    track: ops?.nameAt(0, "nothing"),
    items: value
      ?.items()
      .map((item) => item.entries("nothing").map((entry) => entry.key)),
    entries: value?.entries("nothing").map((entry) => entry.key),
    kind: ops?.propertyAt(1, "kind", "nothing"),
    text: value?.text(),
  };
}

describe("the runtime's globals, read by both kinds of ops", () => {
  const STREAMS = ["process.stdout", "process.stderr"];
  const WRITES = `
    function say(out, line: string) {
      out.write(line);
    }
    function report(sink: Console, stream: NodeJS.WriteStream) {
      sink.log("x");
      stream.write("y");
    }
    export function run() {
      console.log({ a: 1 });
      process.stdout.write("b" as string);
      say(process.stderr, "c");
      setTimeout(() => null);
    }
  `;

  /** What the stream-write ending asks of one call. */
  function asked(ops: CallOps | null) {
    return {
      callee: ops?.calleeText(),
      global: ops?.receiverGlobal?.(["console", ...STREAMS]),
      bare: ops?.isFrom(global("setTimeout")),
      console: ops?.receiverIsFrom(
        typed({ from: [GLOBAL_MODULE], named: ["Console"] }),
      ),
      shape: ops?.valueAt(0)?.shape?.()?.type,
    };
  }

  function bothAsked() {
    const project = createTestProject();
    const file = project.createSourceFile("/cli.ts", WRITES);
    const streams: PatternPack = {
      name: "streams",
      languages: ["typescript"],
      protocol: "in-process",
      discovery: [],
      terminals: [],
      inputMapping: { type: "positionalParams", params: [] },
      streamObjects: STREAMS,
    };
    const store = ResolutionStore.forPacks([streams]);
    return file.getDescendantsOfKind(SyntaxKind.CallExpression).map((call) => ({
      fromNodes: asked(callOpsFor(call, { resolution: store })),
      fromFacts: asked(
        factCallOps(statedFactKey(call, store), factSourceFor(store)),
      ),
    }));
  }

  it("answers the same from the facts as from the nodes", () => {
    for (const { fromNodes, fromFacts } of bothAsked()) {
      expect(fromFacts).toEqual(fromNodes);
    }
  });

  it("takes a spelled global, a stream passed in, an annotated Console and a bare call", () => {
    const byCallee = new Map(
      bothAsked().map(({ fromFacts }) => [fromFacts.callee, fromFacts]),
    );

    expect(byCallee.get("console.log")).toMatchObject({
      global: "console",
      shape: "record",
    });
    expect(byCallee.get("process.stdout.write")).toMatchObject({
      global: "process.stdout",
    });
    expect(byCallee.get("out.write")?.global).toBe("process.stderr");
    expect(byCallee.get("sink.log")).toMatchObject({
      global: undefined,
      console: true,
    });
    expect(byCallee.get("stream.write")?.console).toBe(false);
    expect(byCallee.get("setTimeout")?.bare).toBe(true);
    expect(byCallee.get("console.log")?.bare).toBe(false);
  });

  it("reads a name the program binds as that binding, not as the global", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/timers.ts",
      `
        import { setTimeout } from "node:timers/promises";
        export async function run() {
          (setInterval)(() => null, 5);
          await setTimeout(10);
        }
      `,
    );
    const store = ResolutionStore.forPacks([]);
    const asked = file
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .map((call) => {
        const global = {
          origin: "global",
          paths: ["setTimeout", "setInterval"],
        } as const;
        return [
          callOpsFor(call, { resolution: store }).isFrom(global),
          factCallOps(statedFactKey(call, store), factSourceFor(store))?.isFrom(
            global,
          ),
        ];
      });
    expect(asked).toEqual([
      [true, true],
      [false, false],
    ]);
  });
});

describe("a mapped list and a project call, read by both kinds of ops", () => {
  const played = () =>
    bothOps({ source: SHAPES }).filter(
      ({ fromNodes }) => fromNodes.method() === "play",
    );

  it("reads the same shapes off the facts as off the nodes", () => {
    const calls = played();

    expect(calls).toHaveLength(8);
    for (const { fromNodes, fromFacts } of calls) {
      expect(shapesRead(fromFacts)).toEqual(shapesRead(fromNodes));
    }
  });

  it("reads a mapped list as the one value its callback returns, and a project call as the value it returns", () => {
    const read = played().map(({ fromFacts }) => shapesRead(fromFacts));
    const byTrack = new Map(read.map((one) => [one.track, one]));

    expect(byTrack.get("inline")?.items).toEqual([["inline"]]);
    expect(byTrack.get("named")?.items).toEqual([["name"]]);
    expect(byTrack.get("kept")?.items).toEqual([["viaName"]]);
    expect(byTrack.get("made")).toMatchObject({
      entries: ["made", "kind"],
      kind: "row",
      text: null,
    });
    expect(byTrack.get("spread")?.entries).toEqual(["made", "kind", "extra"]);
    expect(byTrack.get("twice")).toMatchObject({ entries: [], kind: null });
    expect(byTrack.get("each")?.items).toEqual([]);
    expect(byTrack.get("built")).toMatchObject({ entries: [], items: [] });
  });
});

const VALUES = `
  import { Chip as Tag } from "./chip";
  import * as kit from "./chip";

  const kind = "primary";
  function keep<T>(value: T): T {
    return value;
  }
  function makeRender() {
    return () => null;
  }
  const options = keep({
    label: \`\${kind} x\`,
    count: 2,
    tag: Tag,
    kit,
    local: kind,
    member: kit.Chip,
    render: makeRender(),
    inline: () => 1,
  });

  register(options);
`;

/** The object `register` is handed, as the value ops over the facts read it. */
function registered(): ValueOps | null {
  const project = createTestProject();
  project.createSourceFile("/chip.ts", "export function Chip() {}");
  const file = project.createSourceFile("/use.ts", VALUES);
  const call = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((found) => found.getExpression().getText() === "register");
  if (call === undefined) {
    throw new Error("no call to register");
  }
  const store = new ResolutionStore();
  const ops = factCallOps(statedFactKey(call, store), factSourceFor(store));
  return ops?.valueAt(0)?.object?.() ?? null;
}

describe("the fact source's value members", () => {
  it("follows a name through a call that returns its argument to the object", () => {
    expect(
      registered()
        ?.entries("nothing")
        .map((entry) => entry.key),
    ).toEqual([
      "label",
      "count",
      "tag",
      "kit",
      "local",
      "member",
      "render",
      "inline",
    ]);
  });

  it("settles a template and a number the evaluator folds", () => {
    const options = registered();

    expect(options?.property("label")?.evaluated?.()).toBe("primary x");
    expect(options?.property("count")?.evaluated?.()).toBe(2);
    expect(options?.property("tag")?.evaluated?.()).toBeNull();
  });

  it("gives the specifier of the import statement a name is bound to, and nothing for any other value", () => {
    const options = registered();
    const importOf = (name: string) =>
      options?.property(name)?.importedFrom?.() ?? null;

    expect(importOf("tag")).toBe("./chip");
    expect(importOf("kit")).toBe("./chip");
    expect(importOf("local")).toBeNull();
    expect(importOf("member")).toBeNull();
    expect(importOf("label")).toBeNull();
  });

  it("finds a function written in place, and the one a factory call gives back", () => {
    const options = registered();
    const functionOf = (name: string) =>
      options?.property(name)?.function?.()?.source?.() ?? null;

    expect(functionOf("inline")).toBe("() => 1");
    expect(functionOf("render")).toBe("() => null");
    expect(functionOf("label")).toBeNull();
  });

  it("hands out the node a value was read at, as it was written", () => {
    const tag = registered()?.property("tag") as AstCapableValueOps | undefined;

    expect(tag?.source?.()).toBe("Tag");
    expect(Node.isIdentifier(tag?.ast() as Node)).toBe(true);
  });
});

const READS = `
  declare const settings: Record<string, string>;
  declare function run(): Promise<number>;
  export async function finish(key: string) {
    process.exitCode = await run();
    process.exitCode += 1;
    const { "A-B": quoted, [key]: computed, PLAIN = "p", ...rest } = settings;
    return [quoted, computed, PLAIN, rest, settings.HOST ?? "localhost"];
  }
`;

/** The read ops at the node written as `text`, the one a declaration takes apart when `destructured` says so. */
function readAt(text: string, destructured = false) {
  const project = createTestProject();
  const file = project.createSourceFile("/reads.ts", READS);
  const node = file
    .getDescendants()
    .find(
      (one) => one.getText() === text && (!destructured || isDestructured(one)),
    );
  if (node === undefined) {
    throw new Error(`no node ${text}`);
  }
  return readOpsAt(node, new ResolutionStore());
}

/** Whether the node is the value a variable declaration takes apart. */
function isDestructured(node: Node): boolean {
  const declaration = node.getParent();
  return (
    Node.isVariableDeclaration(declaration) &&
    declaration.getInitializer() === node
  );
}

describe("the fact source's read members", () => {
  it("states the value a plain = assigns, as written, and none for +=", () => {
    expect(readAt("process.exitCode").assigned()?.source?.()).toBe(
      "await run()",
    );
    expect(
      readAt("process.exitCode += 1")
        .readsOff()
        .map((site) => site.assigned()),
    ).toEqual([]);
  });

  it("reads off a destructured value the entries a binding names, and leaves out a computed key and the rest", () => {
    const reads = readAt("settings", true).readsOff();
    expect(reads.map((site) => [site.entry(), site.defaulted()])).toEqual([
      ["A-B", false],
      ["PLAIN", true],
    ]);
    expect(reads[1]?.fallback()?.evaluated?.()).toBe("p");
  });

  it("reads the entries a binding names through a cast or parentheses around the value", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/cast.ts",
      [
        "interface Order { id: string; total: number }",
        "declare function parse(text: string): unknown;",
        "export function read(text: string) {",
        "  const { id, total: amount } = parse(text) as Order;",
        "  const kind = (parse(text) as { kind: string })['kind'];",
        "  return [id, amount, kind];",
        "}",
      ].join("\n"),
    );
    const store = new ResolutionStore();
    const callsOf = file
      .getDescendants()
      .filter((one) => one.getText() === "parse(text)");
    expect(
      callsOf.map((call) =>
        readOpsAt(call, store)
          .readsOff()
          .map((site) => site.entry()),
      ),
    ).toEqual([["id", "total"], ["kind"]]);
  });

  it("says a read falls back to what follows ?? and which object it is off", () => {
    const read = readAt("settings.HOST");
    expect(read.entry()).toBe("HOST");
    expect(read.defaulted()).toBe(true);
    expect(read.fallback()?.evaluated?.()).toBe("localhost");
    expect(read.objectPath(["settings", "process"])).toBe("settings");
    expect(read.keysSuppliedTo(global("process.env"))).toEqual([]);
  });

  it("reads no entry at a call, and nothing is off it", () => {
    const call = readAt("run()");
    expect(call.entry()).toBeUndefined();
    expect(call.isOff(global("run"))).toBe(false);
  });
});

const HELPERS = `
  declare function unknown(name: string): string;
  function need(name: string) {
    return process.env[name] ?? "";
  }
  function viteNeed(name: string) {
    return import.meta.env[name];
  }
  function forward(key: string) {
    return need(key);
  }
  function makeReader(prefix: string) {
    return (name: string) => need(prefix + name);
  }
  const read = makeReader("X_");
  export function reads(key: string) {
    return [need("G"), forward(key), viteNeed("V"), read("Y"), unknown("Z"), need()];
  }
`;

/** A store that knows the environment objects Node and Vite give a program. */
function environmentStore(project: Project): ResolutionStore {
  const environment: PatternPack = {
    name: "environment",
    languages: ["typescript"],
    protocol: "in-process",
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    environmentObjects: ["process.env", "import.meta.env"],
  };
  const store = ResolutionStore.forPacks([environment]);
  store.notePossibleCallers(project.getSourceFiles());
  return store;
}

describe("the keys a helper call supplies", () => {
  function keysAt(source: string, file: string, call: string, path: string) {
    const project = createTestProject();
    const sourceFile = project.createSourceFile(file, source);
    const store = environmentStore(project);
    const node = sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((one) => one.getText() === call);
    if (node === undefined) {
      throw new Error(`no call ${call}`);
    }
    return (readOpsAt(node, store).keysSuppliedTo(global(path)) ?? []).map(
      (key) => [
        key.at,
        key.value.evaluated?.() ?? null,
        key.forwarded,
        key.sites.map((site) => site.objectPath([path])),
      ],
    );
  }

  it("finds the argument a helper's parameter takes a read's key from, off the object the site reads", () => {
    expect(keysAt(HELPERS, "/env.ts", 'need("G")', "process.env")).toEqual([
      [0, "G", false, ["process.env"]],
    ]);
    expect(keysAt(HELPERS, "/env.ts", 'need("G")', "import.meta.env")).toEqual(
      [],
    );
    expect(
      keysAt(HELPERS, "/env.ts", 'viteNeed("V")', "import.meta.env"),
    ).toEqual([[0, "V", false, ["import.meta.env"]]]);
  });

  it("says a key the caller's own parameter forwards belongs to the caller's callers", () => {
    expect(keysAt(HELPERS, "/env.ts", "need(key)", "process.env")).toEqual([
      [0, null, true, ["process.env"]],
    ]);
  });

  it("finds no key through a factory's helper that builds the key, a callee nothing defines, or a call that passes none", () => {
    expect(
      ['read("Y")', 'unknown("Z")', "need()"].flatMap((call) =>
        keysAt(HELPERS, "/env.ts", call, "process.env"),
      ),
    ).toEqual([]);
  });

  it("reads a helper's own body when the store states nothing for its file", () => {
    const knobs = `
      const envInt = (name: string, fallback: number): number => {
        const raw = process.env[name];
        return raw === undefined ? fallback : Number.parseInt(raw, 10);
      };
      const runs = envInt("FUZZ_RUNS", 60);
    `;
    expect(
      keysAt(knobs, "/knobs.test.ts", 'envInt("FUZZ_RUNS", 60)', "process.env"),
    ).toEqual([[0, "FUZZ_RUNS", false, ["process.env"]]]);
  });
});

const REACHED = `
  export function portFrom(env: NodeJS.ProcessEnv = process.env) {
    return env.PORT;
  }
  function hostFrom(source: NodeJS.ProcessEnv) {
    return source.HOST;
  }
  export const host = hostFrom(process.env);
  const settings = { PORT: "1" };
  export const port = settings.PORT;
  export const self = this.PORT;
`;

describe("the environment a name is reached by", () => {
  it("is the one a parameter defaults to or a caller hands it, and none for anything else", () => {
    const project = createTestProject();
    const file = project.createSourceFile("/reached.ts", REACHED);
    const store = environmentStore(project);
    const pathAt = (text: string) => {
      const node = file
        .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
        .find((one) => one.getText() === text);
      return node === undefined
        ? "no site"
        : readOpsAt(node, store).objectPath(["process.env", "import.meta.env"]);
    };

    expect(
      ["env.PORT", "source.HOST", "settings.PORT", "this.PORT"].map(pathAt),
    ).toEqual(["process.env", "process.env", undefined, undefined]);
  });
});
