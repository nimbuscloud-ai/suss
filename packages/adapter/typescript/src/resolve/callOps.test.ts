import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { callOpsFor } from "./callOps.js";

import type { CallOps, ReceiverOrigin } from "@suss/recognize";
import type {
  CallExpression,
  Project,
  TaggedTemplateExpression,
  Node as TsNode,
} from "ts-morph";

const LIBRARY = `
  export default class Deck {
    play(track: string): Promise<void>;
    side(name: string): Deck;
    send(command: unknown): Promise<void>;
    query(parts: TemplateStringsArray, ...values: unknown[]): Promise<void>;
    queryText(statement: string): Promise<void>;
  }
  export declare function makeDeck(): Deck;
  export declare class PlayCommand { constructor(input: unknown); }
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

/** The ops for one call in a file, with the library it runs against. */
function opsForCall(source: string, which: "first" | "last"): CallOps {
  const project = withLibrary();
  const file = project.createSourceFile("/repo.ts", source);
  const store = new ResolutionStore();
  const calls: CallExpression[] = [];
  file.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      calls.push(node);
    }
  });
  const under = which === "first" ? calls[0] : calls[calls.length - 1];
  if (under === undefined) {
    throw new Error("the fixture contains no call");
  }
  return callOpsFor(under, (value) => store.resolveWrittenValue(value));
}

/** The ops for the last call in a file, which is the one under test. */
function opsForLastCall(source: string): CallOps {
  return opsForCall(source, "last");
}

/** The ops for the outermost call, which is where a chain is read from. */
function opsForOuterCall(source: string): CallOps {
  return opsForCall(source, "first");
}

/** The ops for the tagged template in a file, which reads as a call. */
function opsForTaggedTemplate(source: string): CallOps {
  const project = withLibrary();
  const file = project.createSourceFile("/repo.ts", source);
  const store = new ResolutionStore();
  let tagged: TsNode | undefined;
  file.forEachDescendant((node) => {
    if (Node.isTaggedTemplateExpression(node)) {
      tagged = node;
    }
  });
  if (tagged === undefined) {
    throw new Error("the fixture contains no tagged template");
  }
  return callOpsFor(tagged as TaggedTemplateExpression, (value) =>
    store.resolveWrittenValue(value),
  );
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

  it("asks the same question of the call itself, off its own callee", () => {
    const ops = opsForLastCall(`
      import Deck, { PlayCommand } from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.send(new PlayCommand({ Track: "1" }));
      }
    `);

    expect(ops.argument(0)?.isFrom(constructed)).toBe(true);
    expect(
      ops
        .argument(0)
        ?.isFrom({ origin: "constructed", importedFrom: ["reel"] }),
    ).toBe(false);
  });

  it("leaves a command of the same name the project wrote itself alone", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      class PlayCommand { constructor(input: unknown) {} }
      declare const deck: Deck;
      export function play() {
        return deck.send(new PlayCommand({ Track: "1" }));
      }
    `);

    expect(ops.argument(0)?.isFrom(constructed)).toBe(false);
  });
});

describe("the calls one call reaches", () => {
  it("gives the receiver as a call of its own", () => {
    const ops = opsForOuterCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.side("a").play("1");
      }
    `);

    const receiver = ops.receiver();
    expect(receiver?.method()).toBe("side");
    expect(receiver?.nameAt(0, "reference")).toBe("a");
  });

  it("follows a receiver the source wrote into a variable", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      const side = deck.side("a");
      export function play() {
        return side.play("1");
      }
    `);

    expect(ops.receiver()?.method()).toBe("side");
  });

  it("says nothing about a receiver that is not a call", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.play("1");
      }
    `);

    expect(ops.receiver()).toBeNull();
  });

  it("gives a constructed argument as a call whose callee is the class", () => {
    const ops = opsForLastCall(`
      import Deck, { PlayCommand } from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.send(new PlayCommand({ Track: "1" }));
      }
    `);

    const command = ops.argument(0);
    expect(command?.calleeText()).toBe("PlayCommand");
    expect(
      command?.receiverIsFrom({
        origin: "constructed",
        importedFrom: ["tapedeck"],
      }),
    ).toBe(true);
  });

  it("follows an argument the source built a few lines up", () => {
    const ops = opsForLastCall(`
      import Deck, { PlayCommand } from "tapedeck";
      declare const deck: Deck;
      export function play() {
        const command = new PlayCommand({ Track: "1" });
        return deck.send(command);
      }
    `);

    expect(ops.argument(0)?.calleeText()).toBe("PlayCommand");
  });

  it("leaves a class of the same name the project wrote itself alone", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      class PlayCommand { constructor(input: unknown) {} }
      declare const deck: Deck;
      export function play() {
        return deck.send(new PlayCommand({ Track: "1" }));
      }
    `);

    expect(
      ops.argument(0)?.receiverIsFrom({
        origin: "constructed",
        importedFrom: ["tapedeck"],
      }),
    ).toBe(false);
  });

  it("says nothing about an argument that is neither a call nor a construction", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.play("1");
      }
    `);

    expect(ops.argument(0)).toBeNull();
    expect(ops.argument(4)).toBeNull();
  });

  it("gives the call the callee was written as", () => {
    const ops = opsForLastCall(`
      import { makeDeck } from "tapedeck";
      const Nightly = makeDeck();
      export function play() {
        return Nightly.play("1");
      }
    `);

    expect(ops.callee()).toBeNull();
    expect(ops.receiver()?.calleeText()).toBe("makeDeck");
  });

  it("reaches the factory behind the class a construction reaches for", () => {
    const project = withLibrary();
    project.createSourceFile(
      "/decks.ts",
      `
      import { makeDeck } from "tapedeck";
      export const Nightly = makeDeck();
    `,
    );
    const file = project.createSourceFile(
      "/repo.ts",
      `
      import { Nightly } from "./decks.js";
      export function build() {
        return new Nightly();
      }
    `,
    );
    const store = new ResolutionStore();
    const made = file.getFirstDescendantByKindOrThrow(SyntaxKind.NewExpression);

    const ops = callOpsFor(made, (value) => store.resolveWrittenValue(value));
    expect(ops.callee()?.calleeText()).toBe("makeDeck");
  });

  it("reads a receiver through the await the source wrote round it", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export async function play() {
        const side = await deck.side("a");
        return side.play("1");
      }
    `);

    expect(ops.receiver()?.method()).toBe("side");
  });
});

describe("reading inside an argument", () => {
  it("reads a property of the object an argument states", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play(track: string) {
        return deck.send({ Side: "a", Track: track });
      }
    `);

    expect(ops.propertyAt(0, "Side", "reference")).toBe("a");
    expect(ops.propertyAt(0, "Track", "reference")).toBe("{track}");
    expect(ops.propertyAt(0, "Missing", "reference")).toBeNull();
  });

  it("reads a property of the object a construction was given", () => {
    const ops = opsForLastCall(`
      import Deck, { PlayCommand } from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.send(new PlayCommand({ Side: "a" }));
      }
    `);

    expect(ops.propertyAt(0, "Side", "reference")).toBe("a");
  });

  it("says nothing about a property of an argument that states no object", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.play("1");
      }
    `);

    expect(ops.propertyAt(0, "Side", "reference")).toBeNull();
  });
});

describe("reading a value an argument states", () => {
  it("reads the entries of an object, the items of a list, and a string", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.send({
          Sides: [{ Side: "a" }, { Side: "b" }],
          Order: "shuffled",
        });
      }
    `);

    const stated = ops.valueAt(0);
    expect(stated?.property("Order")?.text()).toBe("shuffled");
    expect(
      stated
        ?.property("Sides")
        ?.items()
        .flatMap((item) => item.entries("nothing").map((entry) => entry.key)),
    ).toEqual(["Side", "Side"]);
    expect(stated?.property("Missing")).toBeNull();
  });

  it("reads a key the source computes the way it reads any other name", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export class Player {
        private readonly side: string;
        constructor(stage: string) {
          this.side = \`\${stage}-a\`;
        }
        play() {
          return deck.send({ Sides: { [this.side]: { Track: "1" } } });
        }
      }
    `);

    const sides = ops.valueAt(0)?.property("Sides");
    expect(sides?.entries("nothing").map((entry) => entry.key)).toEqual([
      "{stage}-a",
    ]);
  });

  it("follows a request the source wrote into a variable first", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        const request = { Side: "a" };
        return deck.send(request);
      }
    `);

    expect(ops.valueAt(0)?.property("Side")?.text()).toBe("a");
  });

  it("says nothing about a value the call does not state", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.play("1");
      }
    `);

    expect(ops.valueAt(4)).toBeNull();
    expect(ops.valueAt(0)?.entries("nothing")).toEqual([]);
    expect(ops.valueAt(0)?.items()).toEqual([]);
    expect(ops.valueAt(0)?.text()).toBe("1");
  });

  it("takes a shorthand property as an entry of its own", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play(side: string) {
        return deck.send({ side });
      }
    `);

    expect(
      ops
        .valueAt(0)
        ?.entries("nothing")
        .map((entry) => entry.key),
    ).toEqual(["side"]);
  });
});

describe("stepping to a receiver another file declared", () => {
  it("crosses an import to the call that made the value", () => {
    // A model or a table is declared once and imported everywhere it is
    // used, so a step that stops at the import specifier reaches
    // nothing. This is the case #585 made unreliable and #588 settled.
    const project = withLibrary();
    project.createSourceFile(
      "/decks.ts",
      `import { makeDeck } from "tapedeck";
       export const nightly = makeDeck();`,
    );
    const file = project.createSourceFile(
      "/show.ts",
      `import { nightly } from "./decks";
       export const run = () => nightly.play("intro");`,
    );
    const store = new ResolutionStore();
    let call: CallExpression | undefined;
    file.forEachDescendant((node) => {
      if (
        Node.isCallExpression(node) &&
        node.getExpression().getText().endsWith(".play")
      ) {
        call = node;
      }
    });

    const receiver = callOpsFor(call as CallExpression, (value) =>
      store.resolveWrittenValue(value),
    ).receiver();

    expect(receiver?.calleeText()).toBe("makeDeck");
  });
});

describe("a statement the source wrote as a tagged template", () => {
  const TAGGED = `
    import Deck from "tapedeck";
    declare const deck: Deck;
    export function play(side: string) {
      return deck.query\`SELECT id FROM tapes WHERE side = \${side}\`;
    }
  `;

  it("reads as a call whose one argument is the template", () => {
    const ops = opsForTaggedTemplate(TAGGED);

    expect(ops.method()).toBe("query");
    expect(ops.calleeText()).toBe("deck.query");
    expect(ops.argumentCount()).toBe(1);
    expect(
      ops.receiverIsFrom({ origin: "declaredBy", importedFrom: ["tapedeck"] }),
    ).toBe(true);
  });

  it("gives the text either side of each hole", () => {
    expect(opsForTaggedTemplate(TAGGED).valueAt(0)?.parts()).toEqual([
      "SELECT id FROM tapes WHERE side = ",
      "",
    ]);
  });

  it("gives one piece for a statement the source wrote as a string", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.queryText("SELECT id FROM tapes");
      }
    `);

    expect(ops.valueAt(0)?.parts()).toEqual(["SELECT id FROM tapes"]);
  });

  it("gives nothing for a value that is not text at all", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.send({ Side: "a" });
      }
    `);

    expect(ops.valueAt(0)?.parts()).toBeNull();
  });
});
