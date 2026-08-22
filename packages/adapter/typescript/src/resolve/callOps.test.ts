import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { callOpsFor } from "./callOps.js";

import type { CallOps, ReceiverOrigin } from "@suss/recognize";
import type { CallExpression, Project } from "ts-morph";

const LIBRARY = `
  export default class Deck {
    play(track: string): Promise<void>;
  }
  export declare function makeDeck(): Deck;
`;

function withLibrary(): Project {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/tapedeck/package.json",
    JSON.stringify({ name: "tapedeck", types: "index.d.ts" }),
  );
  project.createSourceFile("/node_modules/tapedeck/index.d.ts", LIBRARY);
  return project;
}

/** The ops for the last call in a file, which is the one under test. */
function opsForLastCall(source: string): CallOps {
  const project = withLibrary();
  const file = project.createSourceFile("/repo.ts", source);
  const store = new ResolutionStore();
  const calls: CallExpression[] = [];
  file.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      calls.push(node);
    }
  });
  const last = calls[calls.length - 1];
  if (last === undefined) {
    throw new Error("the fixture contains no call");
  }
  return callOpsFor(last, (value) => store.resolveWrittenValue(value));
}

describe("what the adapter can tell a declared pack", () => {
  const ops = () =>
    opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play(track: string) {
        return deck.play("side_a:" + track);
      }
    `);

  it("gives the method as the source spells it", () => {
    expect(ops().method()).toBe("play");
  });

  it("gives the callee as the source writes it", () => {
    expect(ops().calleeText()).toBe("deck.play");
  });

  it("counts the arguments and reads a name with a hole in it", () => {
    expect(ops().argumentCount()).toBe(1);
    expect(ops().nameAt(0, "reference")).toBe("side_a:{track}");
  });

  it("gives null for an argument position the call never filled", () => {
    expect(ops().nameAt(3, "reference")).toBeNull();
  });

  it("says nothing about a call that reaches for no method", () => {
    const bare = opsForLastCall(`
      declare function play(track: string): void;
      export function go() {
        return play("a");
      }
    `);

    expect(bare.method()).toBeNull();
    expect(
      bare.receiverIsFrom({ origin: "declaredBy", importedFrom: ["tapedeck"] }),
    ).toBe(false);
  });
});

describe("pinning down the receiver", () => {
  const declaredBy: ReceiverOrigin = {
    origin: "declaredBy",
    importedFrom: ["tapedeck"],
  };
  const constructed: ReceiverOrigin = {
    origin: "constructed",
    importedFrom: ["tapedeck"],
  };

  it("matches a receiver whose method the module declared", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.play("a");
      }
    `);

    expect(ops.receiverIsFrom(declaredBy)).toBe(true);
  });

  it("leaves the same method on somebody else's object alone", () => {
    const ops = opsForLastCall(`
      declare const deck: { play(track: string): void };
      export function play() {
        return deck.play("a");
      }
    `);

    expect(ops.receiverIsFrom(declaredBy)).toBe(false);
    expect(ops.receiverIsFrom(constructed)).toBe(false);
  });

  it("matches a client the source made from the module, whatever its type says", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      const deck: any = new Deck();
      export function play() {
        return deck.play("a");
      }
    `);

    expect(ops.receiverIsFrom(constructed)).toBe(true);
  });

  it("matches a client a factory from the module handed back", () => {
    const ops = opsForLastCall(`
      import { makeDeck } from "tapedeck";
      const deck: any = makeDeck();
      export function play() {
        return deck.play("a");
      }
    `);

    expect(ops.receiverIsFrom(constructed)).toBe(true);
  });

  it("says no when nothing in the source says what made the receiver", () => {
    const ops = opsForLastCall(`
      declare const deck: any;
      export function play() {
        return deck.play("a");
      }
    `);

    expect(ops.receiverIsFrom(constructed)).toBe(false);
  });
});
