import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { constructedFrom, declaredBy } from "@suss/recognize";
import { factCallOps } from "@suss/recognize/ops";
import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { callOpsFor } from "./callOps.js";
import { factSourceFor, statedFactKey } from "./factSource.js";

import type { CallOps } from "@suss/extractor";
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
function bothOps({ storeImports = true } = {}): {
  fromNodes: CallOps;
  fromFacts: CallOps | null;
}[] {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/tapedeck/package.json",
    JSON.stringify({ name: "tapedeck", types: "index.d.ts" }),
  );
  project.createSourceFile("/node_modules/tapedeck/index.d.ts", LIBRARY);
  const file = project.createSourceFile("/repo.ts", SOURCE);
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
