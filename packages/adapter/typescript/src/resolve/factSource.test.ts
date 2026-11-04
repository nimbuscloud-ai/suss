import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { constructedFrom, declaredBy } from "@suss/recognize";
import { factCallOps } from "@suss/recognize/ops";
import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { callOpsFor } from "./callOps.js";
import { factSourceFor, statedFactKey } from "./factSource.js";

import type { AstCapableValueOps, CallOps, ValueOps } from "@suss/extractor";
import type { CallExpression } from "ts-morph";

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

  it("reads a project call as the value it returns", () => {
    const read = played().map(({ fromFacts }) => shapesRead(fromFacts));
    const byTrack = new Map(read.map((one) => [one.track, one]));

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
