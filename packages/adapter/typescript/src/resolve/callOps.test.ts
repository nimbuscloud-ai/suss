import { Node, SyntaxKind } from "ts-morph";
import { describe, expect, it, vi } from "vitest";

import { profileEvaluation } from "@suss/datalog";
import { constructedFrom, imported, inherits, typed } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import {
  type CallReading,
  callOpsFor,
  type WalkArguments,
  walkArguments,
} from "./callOps.js";
import { opsOverFacts } from "./opsOverFacts.js";

import type { PatternPack } from "@suss/extractor";
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
    run(statement: unknown): Promise<void>;
  }
  export declare function makeDeck(): Deck;
  export declare class PlayCommand { constructor(input: unknown); }
  export declare function sql(parts: TemplateStringsArray, ...values: unknown[]): unknown;
  export declare function tape(name: string): unknown;
  export declare class Cassette { eject(): void; }
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
  return callOpsFor(under, {
    resolve: (value) => store.resolveWrittenValue(value),
    resolution: store,
  });
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
  return callOpsFor(tagged as TaggedTemplateExpression, {
    resolve: (value) => store.resolveWrittenValue(value),
  });
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

  it("matches a receiver a library method returned, on a receiver from the origin, or any one of several origins", () => {
    const ops = opsForOuterCall(`
      import Deck from "tapedeck";
      const deck = new Deck();
      export function play() {
        return deck.side("b").play("a");
      }
    `);
    const side: ReceiverOrigin = {
      origin: "returnedBy",
      method: "side",
      on: constructed,
    };

    expect(ops.receiverIsFrom(side)).toBe(true);
    expect(ops.receiverIsFrom({ ...side, method: "rewind" })).toBe(false);
    expect(
      ops.receiverIsFrom({
        ...side,
        on: { origin: "constructed", importedFrom: ["elsewhere"] },
      }),
    ).toBe(false);
    expect(
      ops.receiverIsFrom({
        origin: "anyOf",
        of: [{ origin: "constructed", importedFrom: ["elsewhere"] }, side],
      }),
    ).toBe(true);
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

  it("matches a client a project function built and handed back", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      const createDeck = () => new Deck();
      const getDeck = async () => {
        const deck = createDeck();
        return { deck };
      };
      export async function play() {
        const { deck } = await getDeck();
        return deck.play("a");
      }
    `);

    expect(ops.receiverIsFrom(constructed)).toBe(true);
    // The receiver a chain then reads is the same construction.
    expect(ops.receiver()?.calleeText()).toBe("Deck");
  });

  it("leaves a client a project function built from somewhere else alone", () => {
    const ops = opsForLastCall(`
      class Deck { play(track: string) {} }
      const createDeck = () => new Deck();
      export function play() {
        const deck = createDeck();
        return deck.play("a");
      }
    `);

    expect(ops.receiverIsFrom(constructed)).toBe(false);
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

describe("a client the module's generator wrote into the project", () => {
  const generator: PatternPack = {
    name: "tapedeck",
    protocol: "in-process",
    languages: ["typescript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    generatedModules: { of: "tapedeck", dirs: () => ["/generated"] },
  };

  /** The ops for the last call, over a store that knows the generator, or one that does not. */
  function opsOver(source: string, packs: PatternPack[]): CallOps {
    const project = createTestProject();
    project.createSourceFile(
      "/generated/deck.d.ts",
      "export declare class Deck { play(track: string): void; }\n",
    );
    const file = project.createSourceFile("/repo.ts", source);
    const store = ResolutionStore.forPacks(packs);
    const call = file.getDescendantsOfKind(SyntaxKind.CallExpression).at(-1);
    if (call === undefined) {
      throw new Error("the fixture contains no call");
    }
    return callOpsFor(call, {
      resolve: (value) => store.resolveWrittenValue(value),
      originatesFrom: (value, module) => store.originatesFrom(value, module),
      resolution: store,
    });
  }

  const source = `
    import { Deck } from "./generated/deck";
    const deck = new Deck();
    export function play() {
      return deck.play("a");
    }
  `;

  it("matches a client made from the generated module as made from the package", () => {
    expect(
      opsOver(source, [generator]).receiverIsFrom(constructedFrom("tapedeck")),
    ).toBe(true);
    expect(
      opsOver(source, []).receiverIsFrom(constructedFrom("tapedeck")),
    ).toBe(false);
  });

  it("matches a method the generated module declares as declared by the package", () => {
    const declaredBy: ReceiverOrigin = {
      origin: "declaredBy",
      importedFrom: ["tapedeck"],
    };
    const typedDeck = `
      import { Deck } from "./generated/deck";
      declare const deck: Deck;
      export function play() {
        return deck.play("a");
      }
    `;
    expect(opsOver(typedDeck, [generator]).receiverIsFrom(declaredBy)).toBe(
      true,
    );
    expect(opsOver(typedDeck, []).receiverIsFrom(declaredBy)).toBe(false);
  });

  it("reads a receiver of any type the generated module declares as typed by the package", () => {
    const typedDeck = `
      import { Deck } from "./generated/deck";
      declare const deck: Deck;
      export function play() {
        return deck.play("a");
      }
    `;
    const anyType = typed({ from: ["tapedeck"] });

    expect(opsOver(typedDeck, [generator]).receiverIsFrom(anyType)).toBe(true);
    expect(opsOver(typedDeck, []).receiverIsFrom(anyType)).toBe(false);
  });
});

describe("the member a call is made on", () => {
  const ORM = `
    export declare class Users { find(where: unknown): unknown; }
    export declare class Client { users: Users; }
  `;

  /** The last call in `/repo.ts`, over the facts of a store, or over its nodes with none. */
  function lastCall(
    source: string,
    over: "facts" | "nodes",
    installed = true,
  ): CallOps {
    const project = createTestProject();
    if (installed) {
      project.createSourceFile(
        "/node_modules/ormkit/package.json",
        JSON.stringify({ name: "ormkit", types: "index.d.ts" }),
      );
      project.createSourceFile("/node_modules/ormkit/index.d.ts", ORM);
    }
    const file = project.createSourceFile("/repo.ts", source);
    const call = file.getDescendantsOfKind(SyntaxKind.CallExpression).at(-1);
    if (call === undefined) {
      throw new Error("the fixture contains no call");
    }
    if (over === "nodes") {
      return callOpsFor(call);
    }
    const store = new ResolutionStore();
    return opsOverFacts(call, {
      resolve: (value) => store.resolveWrittenValue(value),
      originatesFrom: (value, module) => store.originatesFrom(value, module),
      resolution: store,
    });
  }

  const typedClient = `
    import { Client } from "ormkit";
    declare const db: Client;
    export function list() {
      return db.users.find({});
    }
  `;

  const ANY_ORM_TYPE = typed({ from: ["ormkit"] });

  const declaredByOrm: ReceiverOrigin = {
    origin: "declaredBy",
    importedFrom: ["ormkit"],
  };

  it.each(["facts", "nodes"] as const)(
    "names the member and asks about the object it is read off, over the %s",
    (over) => {
      const ops = lastCall(typedClient, over);
      const member = ops.member?.() ?? null;

      expect(member?.method()).toBe("users");
      expect(member?.calleeText()).toBe("db.users");
      expect(member?.argumentCount()).toBe(0);
      expect(member?.file?.()).toBe("/repo.ts");
      expect(member?.receiverIsFrom(ANY_ORM_TYPE)).toBe(true);
      expect(member?.receiverIsFrom(typed({ from: ["other"] }))).toBe(false);
      expect(ops.receiverIsFrom(ANY_ORM_TYPE)).toBe(true);
      expect(ops.file?.()).toBe("/repo.ts");
    },
  );

  it("reads any type the module declares only where the module declares it", () => {
    const ops = lastCall(
      `
        class Mine { users = { find: (_where: unknown) => ({}) }; }
        const db = new Mine();
        export function list() {
          return db.users.find({});
        }
      `,
      "facts",
    );

    expect(ops.member?.()?.receiverIsFrom(ANY_ORM_TYPE)).toBe(false);
  });

  it("gives no member for a call made on a name", () => {
    expect(
      lastCall(
        `
          import { Client } from "ormkit";
          declare const users: Client["users"];
          export const list = () => users.find({});
        `,
        "nodes",
      ).member?.(),
    ).toBeNull();
  });

  it.each(["facts", "nodes"] as const)(
    "reads the member a local was set to, one declaration and no further, over the %s",
    (over) => {
      const held = lastCall(
        `
          import { Client } from "ormkit";
          declare const db: Client;
          export function list() {
            const users = db.users;
            return users.find({});
          }
        `,
        over,
      ).member?.();

      expect(held?.method()).toBe("users");
      expect(held?.calleeText()).toBe("db.users");
      expect(held?.receiverIsFrom(ANY_ORM_TYPE)).toBe(true);

      const copied = lastCall(
        `
          import { Client } from "ormkit";
          declare const db: Client;
          export function list() {
            const users = db.users;
            const again = users;
            return again.find({});
          }
        `,
        over,
      ).member?.();

      expect(copied).toBeNull();
    },
  );

  it.each(["facts", "nodes"] as const)(
    "gives no member for a local set to the client itself, over the %s",
    (over) => {
      expect(
        lastCall(
          `
            import { Client } from "ormkit";
            export function list() {
              const db = new Client();
              return db.find({});
            }
          `,
          over,
        ).member?.(),
      ).toBeNull();
    },
  );

  it("asks a member its own member, and what declared it", () => {
    const ops = lastCall(
      `
        import { Client } from "ormkit";
        declare const app: { db: Client };
        export const list = () => app.db.users.find({});
      `,
      "nodes",
    );
    const users = ops.member?.() ?? null;

    expect(users?.member?.()?.method()).toBe("db");
    expect(users?.receiver()).toBeNull();
    expect(users?.receiverIsFrom(declaredByOrm)).toBe(true);
  });

  const subclassed = `
    import { Client } from "ormkit";
    class Db extends Client {}
    class Service {
      constructor(private readonly db: Db) {}
      list() { return this.db.users.find({}); }
    }
  `;

  const BASE = inherits({ from: ["ormkit"], named: ["Client"] });

  it.each([true, false])(
    "reads a class the project extends from the client, installed: %s",
    (installed) => {
      const member = lastCall(subclassed, "facts", installed).member?.();

      expect(member?.receiverIsFrom(BASE)).toBe(true);
      expect(
        member?.receiverIsFrom(
          inherits({ from: ["ormkit"], named: ["Other"] }),
        ),
      ).toBe(false);
      expect(member?.receiverIsFrom(declaredByOrm)).toBe(installed);
    },
  );

  it("leaves the ancestry to the facts, which a run with no store does not have", () => {
    expect(lastCall(subclassed, "nodes").member?.()?.receiverIsFrom(BASE)).toBe(
      false,
    );
  });
});

describe("a call the node ops step to", () => {
  it("asks where a name was imported from the way the call in hand does", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/repo.ts",
      `
        import { connect } from "tapedeck/driver";
        const deck = connect();
        export function play() {
          return deck.side("a").play("1");
        }
      `,
    );
    const call = file
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((one) => one.getText() === 'deck.side("a").play("1")');
    if (call === undefined) {
      throw new Error("the fixture contains no call to play");
    }
    const store = new ResolutionStore();
    const ops = callOpsFor(call, {
      resolve: (value) => store.resolveWrittenValue(value),
      originatesFrom: (value, module) => store.originatesFrom(value, module),
      resolution: store,
    });
    const connected = constructedFrom({
      from: ["tapedeck"],
      named: ["connect"],
    });

    expect(ops.receiver()?.method()).toBe("side");
    expect(ops.receiver()?.receiverIsFrom(connected)).toBe(true);
  });
});

describe("the calls chained on a result, and the columns a condition reads", () => {
  const BUILDER = `
    declare const db: any;
    declare const users: any;
    declare const other: any;
    declare function eq(a: unknown, b: unknown): unknown;
    declare function and(...conditions: unknown[]): unknown;
    function onlyActive() {
      return eq(users.active, true);
    }
    export function rename(id: number, flag: boolean) {
      const kept = eq(users.kept, id);
      db.delete(users).where(kept);
      return db
        .update(users)
        .set({ name: "x" })
        .where(
          and(
            eq(users.id, id),
            users.a.gt(1),
            \`\${users.b}\`,
            flag ? users.c : users.d,
            users.e ?? 0,
            [users.f],
            { k: users.g },
            other.h,
            onlyActive(),
            (row: any) => users.i,
            !users.j,
            users.k + 1,
            eq(users.id, 2),
          ),
        );
    }
  `;

  /** The call written as `text` in the builder, over the facts or over its nodes. */
  function callAt(text: string, over: "facts" | "nodes"): CallOps {
    const project = createTestProject();
    const file = project.createSourceFile("/repo.ts", BUILDER);
    const call = file
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((one) => one.getText() === text);
    if (call === undefined) {
      throw new Error(`no call written as ${text}`);
    }
    if (over === "nodes") {
      return callOpsFor(call);
    }
    const store = new ResolutionStore();
    return opsOverFacts(call, {
      resolve: (value) => store.resolveWrittenValue(value),
      resolution: store,
    });
  }

  /** What the condition of the `where` chained on `first` reads off `first`'s table. */
  function columnsRead(first: CallOps): readonly string[] | null {
    const table = first.valueAt(0);
    let where = first.chainedOn?.() ?? null;
    while (where !== null && where.method() !== "where") {
      where = where.chainedOn?.() ?? null;
    }
    const condition = where?.valueAt(0) ?? null;
    return table === null || condition === null
      ? null
      : (condition.readsOff?.(table) ?? null);
  }

  it.each(["facts", "nodes"] as const)(
    "gives the call made on each result in turn, over the %s",
    (over) => {
      const update = callAt("db\n        .update(users)", over);
      const set = update.chainedOn?.() ?? null;

      expect(set?.method()).toBe("set");
      expect(set?.chainedOn?.()?.method()).toBe("where");
      expect(set?.chainedOn?.()?.chainedOn?.()).toBeNull();
    },
  );

  it.each(["facts", "nodes"] as const)(
    "reads the columns through calls, a method on a column, holes, branches and entries, each once, over the %s",
    (over) => {
      expect(columnsRead(callAt("db\n        .update(users)", over))).toEqual([
        "id",
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "g",
      ]);
    },
  );

  it.each(["facts", "nodes"] as const)(
    "reads no column through a condition kept in a name, over the %s",
    (over) => {
      expect(columnsRead(callAt("db.delete(users)", over))).toEqual([]);
    },
  );

  it.each(["facts", "nodes"] as const)(
    "reads the columns off another name for the table, over the %s",
    (over) => {
      const project = createTestProject();
      const file = project.createSourceFile(
        "/repo.ts",
        `
          declare const db: any;
          declare function table(name: string): any;
          declare function eq(a: unknown, b: unknown): unknown;
          const users = table("users");
          export function byAlias(id: number) {
            const u = users;
            return db.update(users).where(eq(u.id, id));
          }
        `,
      );
      const call = file
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .find((one) => one.getText() === "db.update(users)");
      if (call === undefined) {
        throw new Error("the fixture contains no update");
      }
      const store = new ResolutionStore();
      const reading = {
        resolve: (value: TsNode) => store.resolveWrittenValue(value),
        resolution: store,
      };
      const update =
        over === "nodes"
          ? callOpsFor(call, reading)
          : opsOverFacts(call, reading);

      expect(columnsRead(update)).toEqual(["id"]);
    },
  );
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

  it.each(["facts", "nodes"] as const)(
    "gives the same site for a receiver that comes back round to itself, over the %s",
    (over) => {
      const project = createTestProject();
      const file = project.createSourceFile(
        "/repo.ts",
        `
          var cursor: any = cursor.next();
          export function play() {
            return cursor.play("1");
          }
        `,
      );
      const call = file
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .find((one) => one.getText() === 'cursor.play("1")');
      if (call === undefined) {
        throw new Error("the fixture contains no play");
      }
      const store = new ResolutionStore();
      const reading = {
        resolve: (value: TsNode) => store.resolveWrittenValue(value),
        resolution: store,
      };
      const play =
        over === "nodes"
          ? callOpsFor(call, reading)
          : opsOverFacts(call, reading);
      const next = play.receiver();

      expect(next?.calleeText()).toBe("cursor.next");
      expect(next?.receiver()?.site?.()).toBe(next?.site?.());
      expect(next?.site?.()).not.toBe(play.site?.());
    },
  );

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

    const ops = callOpsFor(made, {
      resolve: (value) => store.resolveWrittenValue(value),
    });
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

    expect(ops.valueAt(0)?.property("side")?.text()).toBeNull();
  });

  it("gives every string a value can be, up to the cap it is asked with", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play(side: "a" | "b", track: string) {
        return deck.send({ Side: \`side-\${side}\`, Track: track });
      }
    `);

    const side = ops.valueAt(0)?.property("Side");
    expect(side?.names?.(4)).toEqual(["side-a", "side-b"]);
    expect(side?.names?.(1)).toBeNull();
    expect(ops.valueAt(0)?.property("Track")?.names?.(4)).toBeNull();
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

    const receiver = callOpsFor(call as CallExpression, {
      resolve: (value) => store.resolveWrittenValue(value),
    }).receiver();

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

describe("a statement a call was handed as a tagged template", () => {
  const HANDED = `
    import Deck, { sql, tape } from "tapedeck";
    declare const deck: Deck;
    const tapes = tape("tapes");
    export function play(side: string) {
      return deck.run(sql\`SELECT id FROM \${tapes} WHERE side = \${side}\`);
    }
  `;

  it("gives the text through the tag the source wrote", () => {
    expect(opsForLastCall(HANDED).valueAt(0)?.parts()).toEqual([
      "SELECT id FROM ",
      " WHERE side = ",
      "",
    ]);
  });

  it("gives each hole as the call the source wrote it as", () => {
    const holes = opsForLastCall(HANDED).valueAt(0)?.holes() ?? [];

    expect(holes).toHaveLength(2);
    expect(holes[0]?.nameAt(0, "nothing")).toBe("tapes");
    expect(
      holes[0]?.isFrom({ origin: "constructed", importedFrom: ["tapedeck"] }),
    ).toBe(true);
  });

  it("gives null for a hole the source wrote as something else", () => {
    expect(opsForLastCall(HANDED).valueAt(0)?.holes()[1]).toBeNull();
  });

  it("gives no holes for a statement the source wrote as a string", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      export function play() {
        return deck.queryText("SELECT id FROM tapes");
      }
    `);

    expect(ops.valueAt(0)?.holes()).toEqual([]);
  });

  it("gives each hole as a value, so a name the program settled reads", () => {
    const ops = opsForLastCall(`
      import Deck from "tapedeck";
      declare const deck: Deck;
      const SIDE_TABLE = "archive.sides";
      export function play(side: string) {
        return deck.queryText(\`SELECT id FROM \${SIDE_TABLE} WHERE side = \${side}\`);
      }
    `);
    const values = ops.valueAt(0)?.interpolated?.() ?? [];

    expect(values).toHaveLength(2);
    expect(values[0]?.name("nothing")).toBe("archive.sides");
    expect(values[1]?.name("nothing")).toBeNull();
  });
});

describe("a bare call of a bound name", () => {
  it("says whether the callee is a name the program bound", () => {
    const named = opsForCall(
      `
      import { makeDeck } from "tapedeck";
      const deck = makeDeck;
      deck();
      `,
      "last",
    );
    expect(named.namedCallee?.()).toBe(true);

    const inPlace = opsForCall(
      `
      import { makeDeck } from "tapedeck";
      makeDeck()();
      `,
      "first",
    );
    expect(inPlace.namedCallee?.()).toBe(false);
  });

  it("reads a selector lambda's fields, one per first segment", () => {
    const ops = opsForCall(
      `
      import { tape } from "tapedeck";
      tape((s: { a: { b: number }; c: number }) => s.a.b + s.a.b + s.c);
      `,
      "first",
    );
    expect(ops.parameterReadsAt?.(0)).toEqual(["a", "c"]);
  });

  it("reads a whole-parameter selector as everything", () => {
    const ops = opsForCall(
      `
      import { tape } from "tapedeck";
      tape((s: number) => s);
      `,
      "first",
    );
    expect(ops.parameterReadsAt?.(0)).toEqual(["*"]);
  });

  it("has nothing to read off an argument that is not a function", () => {
    const ops = opsForCall(
      `
      import { tape } from "tapedeck";
      tape("side_a");
      `,
      "first",
    );
    expect(ops.parameterReadsAt?.(0)).toBeNull();
  });
});

describe("anchorCall", () => {
  function anchoredOps(source: string): CallOps {
    const project = withLibrary();
    const file = project.createSourceFile("/repo.ts", source);
    const store = new ResolutionStore();
    const calls: CallExpression[] = [];
    file.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        calls.push(node);
      }
    });
    const under = calls[calls.length - 1];
    if (under === undefined) {
      throw new Error("the fixture contains no call");
    }
    return callOpsFor(under, {
      resolve: (value) => store.resolveWrittenValue(value),
      originatesFrom: (value, module) =>
        store.importOriginsOf(value, [module]).length > 0,
      anchorCallsOf: (value, matches) => store.anchorCallsOf(value, matches),
    });
  }

  const madeDeck: ReceiverOrigin = {
    origin: "constructed",
    importedFrom: ["tapedeck"],
    named: ["makeDeck"],
  };

  it("hands back the factory call behind a cached receiver", () => {
    const ops = anchoredOps(`
      import { makeDeck } from "tapedeck";
      const deck = makeDeck();
      export const play = () => deck.play("a");
    `);
    expect(ops.anchorCall?.(madeDeck)?.calleeText()).toBe("makeDeck");
  });

  it("says nothing when two distinct factory calls both match", () => {
    const ops = anchoredOps(`
      import { makeDeck } from "tapedeck";
      declare const cached: ReturnType<typeof makeDeck> | undefined;
      const deck = cached || makeDeck();
      const other = makeDeck();
      const picked = deck || other;
      export const play = () => picked.play("a");
    `);
    expect(ops.anchorCall?.(madeDeck)).toBeNull();
  });

  it("says nothing for an origin that is not constructed", () => {
    const ops = anchoredOps(`
      import { makeDeck } from "tapedeck";
      const deck = makeDeck();
      export const play = () => deck.play("a");
    `);
    expect(
      ops.anchorCall?.({ origin: "declaredBy", importedFrom: ["tapedeck"] }),
    ).toBeNull();
  });

  it("says nothing when the callbacks are not bound", () => {
    const ops = opsForLastCall(`
      import { makeDeck } from "tapedeck";
      const deck = makeDeck();
      export const play = () => deck.play("a");
    `);
    expect(ops.anchorCall?.(madeDeck)).toBeNull();
  });
});

describe("the arguments of every call one walk visits", () => {
  const BODY = `
    import Deck, { PlayCommand } from "tapedeck";
    declare const deck: Deck;
    declare function log(...values: unknown[]): void;
    export async function play(track: string) {
      const first = new PlayCommand({ Track: "1" });
      const second = new PlayCommand({ Track: track });
      const note = "not a command";
      await deck.send(first);
      await deck.send(second);
      log(note, track);
    }
  `;

  /** A fresh store, and the reading a walk's ops are built with. */
  function readingOf(
    store: ResolutionStore,
    walk?: WalkArguments,
  ): CallReading {
    return {
      resolve: (value: TsNode) => store.resolveWrittenValue(value),
      resolution: store,
      ...(walk === undefined ? {} : { walk }),
    };
  }

  /** The calls in the fixture, and how a subject walk reads their arguments. */
  function fixture() {
    const calls = withLibrary()
      .createSourceFile("/repo.ts", BODY)
      .getDescendantsOfKind(SyntaxKind.CallExpression);
    const argumentsRead = (reading: CallReading): (string | null)[] =>
      calls.flatMap((call) => {
        const ops = callOpsFor(call, reading);
        ops.readingArguments?.(0);
        return Array.from(
          { length: ops.argumentCount() },
          (_, index) => ops.argument(index)?.calleeText() ?? null,
        );
      });
    const walkedWith = (store: ResolutionStore) =>
      readingOf(store, walkArguments(calls, store));
    return { calls, argumentsRead, walkedWith };
  }

  it("reads each argument the way it reads one asked about alone", () => {
    const { argumentsRead, walkedWith } = fixture();
    const together = argumentsRead(walkedWith(new ResolutionStore()));

    expect(together).toEqual(argumentsRead(readingOf(new ResolutionStore())));
    expect(together.filter((callee) => callee === "PlayCommand")).toHaveLength(
      2,
    );
  });

  it("asks one question for the whole walk however often a call says it will read", () => {
    const { calls, argumentsRead, walkedWith } = fixture();
    const evaluationsOf = (read: () => unknown) =>
      profileEvaluation(read).profile.evaluations;
    const identifiers = calls
      .flatMap((call) => call.getArguments())
      .filter((argument) => Node.isIdentifier(argument));

    const together = evaluationsOf(() =>
      argumentsRead(walkedWith(new ResolutionStore())),
    );
    expect(together).toBe(
      evaluationsOf(() =>
        new ResolutionStore().resolveWrittenValues(identifiers),
      ),
    );
    expect(together).toBeLessThan(
      evaluationsOf(() => argumentsRead(readingOf(new ResolutionStore()))),
    );
  });
});

describe("the receivers of every call one walk visits", () => {
  const MADE_BY_DECK: ReceiverOrigin = {
    origin: "constructed",
    importedFrom: ["tapedeck"],
    named: ["makeDeck"],
  };
  const BODY = `
    import { makeDeck } from "tapedeck";
    class Own { play(track: string) { return track; } }
    export class Player {
      private readonly front = makeDeck();
      private readonly back = makeDeck();
      private readonly own = new Own();
      run() {
        this.front.play("a");
        this.back.play("b");
        this.own.play("c");
      }
    }
  `;
  const listsPlay: ReadonlySet<string> = new Set(["play"]);

  /** Whether each `play` call's receiver was made by the library, and how many questions that took. */
  function receiversMade(batched: boolean) {
    const calls = withLibrary()
      .createSourceFile("/repo.ts", BODY)
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText().endsWith(".play"));
    const store = new ResolutionStore();
    const walk = walkArguments(calls, store);
    const { result, profile } = profileEvaluation(() =>
      calls.map((call) => {
        const ops = callOpsFor(call, {
          resolution: store,
          ...(batched
            ? { walk }
            : { resolve: (value: TsNode) => store.resolveWrittenValue(value) }),
        });
        if (batched) {
          ops.readingReceivers?.(listsPlay);
        }
        return ops.receiverIsFrom(MADE_BY_DECK);
      }),
    );
    return { made: result, evaluations: profile.evaluations };
  }

  it("finds the same receivers when it asks about them together", () => {
    expect(receiversMade(true).made).toEqual([true, true, false]);
    expect(receiversMade(false).made).toEqual([true, true, false]);
  });

  it("asks one question for the walk, and nothing for a method the project wrote", () => {
    const libraryReceivers = withLibrary()
      .createSourceFile("/repo.ts", BODY)
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .filter((read) => ["this.front", "this.back"].includes(read.getText()));
    const asOneQuestion = profileEvaluation(() =>
      new ResolutionStore().resolveWrittenValues(libraryReceivers),
    ).profile.evaluations;

    expect(receiversMade(true).evaluations).toBe(asOneQuestion);
    expect(receiversMade(true).evaluations).toBeLessThan(
      receiversMade(false).evaluations,
    );
  });

  it("asks nothing about a receiver whose method the project wrote", () => {
    const call = withLibrary()
      .createSourceFile(
        "/repo.ts",
        `
          class Own { play(track: string) { return track; } }
          const own = new Own();
          export const played = own.play("c");
        `,
      )
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((found) => found.getExpression().getText() === "own.play");
    if (call === undefined) {
      throw new Error("the fixture contains no own.play call");
    }
    const store = new ResolutionStore();
    const { result, profile } = profileEvaluation(() =>
      callOpsFor(call, {
        resolve: (value) => store.resolveWrittenValue(value),
        resolution: store,
      }).receiverIsFrom(MADE_BY_DECK),
    );

    expect(result).toBe(false);
    expect(profile.evaluations).toBe(0);
  });

  it("gives the call a field was written as for the receiver", () => {
    const ops = opsForLastCall(`
      import { makeDeck } from "tapedeck";
      export class Player {
        private readonly deck = makeDeck();
        run() { return this.deck.play("a"); }
      }
    `);
    expect(ops.receiver()?.calleeText()).toBe("makeDeck");
  });
});

describe("the class a call is handed", () => {
  const LABEL: ReceiverOrigin = {
    origin: "constructed",
    importedFrom: ["tapedeck"],
    named: ["tape"],
  };

  function classHanded(order: string) {
    const project = withLibrary();
    project.createSourceFile("/order.ts", order);
    const file = project.createSourceFile(
      "/repo.ts",
      `
        import { tape } from "tapedeck";
        import { Order } from "./order";
        export const labelled = tape(Order);
      `,
    );
    const call = file.getDescendantsOfKind(SyntaxKind.CallExpression)[0];
    if (call === undefined) {
      throw new Error("the fixture contains no call");
    }
    const store = new ResolutionStore();
    return callOpsFor(call, {
      resolve: (value) => store.resolveWrittenValue(value),
      resolution: store,
    }).classAt?.(0);
  }

  it("gives the class's name and the decorator the origin accepts", () => {
    const order = classHanded(`
      import { tape } from "tapedeck";
      @tape("orders")
      export class Order {}
    `);
    expect(order?.name()).toBe("Order");
    expect(order?.decorator(LABEL)?.nameAt(0, "nothing")).toBe("orders");
  });

  it("gives no decorator when the one on the class comes from elsewhere", () => {
    const order = classHanded(`
      import { tape } from "./local";
      @tape("orders")
      export class Order {}
    `);
    expect(order?.decorator(LABEL)).toBeNull();
  });

  it("gives nothing for an argument that is not a class", () => {
    expect(classHanded("export const Order = 1;")).toBeNull();
  });
});

describe("a receiver typed as a library's type, and a value the file imported", () => {
  const SOURCE = `
    import Deck, { Cassette as Tape, tape } from "tapedeck";
    import * as deckModule from "tapedeck";
    import { tape as reel } from "tapedeck";
    import { Recorder } from "uninstalled";
    class Cassette {
      eject(): void {}
    }
    export function go(deck: Deck, kept: Tape, local: Cassette, recorder: Recorder) {
      deck.play("a");
      kept.eject();
      local.eject();
      recorder.record();
      deckModule.tape("c");
      tape("d");
      reel("e");
    }
    export function build() {
      const made = new Tape();
      made.eject();
    }
    export function relay(play: typeof reel, Made: typeof Tape) {
      play("f");
      const again = new Made();
      again.eject();
    }
    export function start() {
      relay(reel, Tape);
    }
  `;

  /** The ops for each call in the source, by callee, read off the nodes and off the facts. */
  function opsByCallee(
    store = new ResolutionStore(),
  ): Record<"nodes" | "facts", Map<string, CallOps>> {
    const project = withLibrary();
    const file = project.createSourceFile("/repo.ts", SOURCE);
    const reading: CallReading = {
      resolve: (value) => store.resolveWrittenValue(value),
      resolution: store,
    };
    const nodes = new Map<string, CallOps>();
    const facts = new Map<string, CallOps>();
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression().getText();
      nodes.set(callee, callOpsFor(call, reading));
      facts.set(callee, opsOverFacts(call, reading));
    }
    return { nodes, facts };
  }

  const cassette = typed({ from: ["tapedeck"], named: ["Cassette"] });
  const wholeModule = imported({ from: ["tapedeck"], named: ["*"] });
  const tapeExport = imported({ from: ["tapedeck"], named: ["tape"] });

  it.each(["nodes", "facts"] as const)(
    "takes a receiver of the type the library exports, and not a local class of the same name, over the %s",
    (reading) => {
      const ops = opsByCallee()[reading];

      expect(ops.get("kept.eject")?.receiverIsFrom(cassette)).toBe(true);
      expect(ops.get("local.eject")?.receiverIsFrom(cassette)).toBe(false);
      expect(
        ops
          .get("kept.eject")
          ?.receiverIsFrom(typed({ from: ["elsewhere"], named: ["Cassette"] })),
      ).toBe(false);
      // Nothing declares the type of a package that is not installed, so
      // the file's import of the name is what says where it is from.
      expect(
        ops
          .get("recorder.record")
          ?.receiverIsFrom(
            typed({ from: ["uninstalled"], named: ["Recorder"] }),
          ),
      ).toBe(true);
    },
  );

  it.each(["nodes", "facts"] as const)(
    "takes the module imported whole and a function imported by name or alias, over the %s",
    (reading) => {
      const ops = opsByCallee()[reading];

      expect(ops.get("deckModule.tape")?.receiverIsFrom(wholeModule)).toBe(
        true,
      );
      expect(ops.get("deck.play")?.receiverIsFrom(wholeModule)).toBe(false);
      expect(ops.get("tape")?.isFrom(tapeExport)).toBe(true);
      expect(ops.get("reel")?.isFrom(tapeExport)).toBe(true);
      expect(ops.get("tape")?.isFrom(imported({ from: ["tapedeck"] }))).toBe(
        true,
      );
      expect(ops.get("deck.play")?.isFrom(tapeExport)).toBe(false);
    },
  );

  it.each(["nodes", "facts"] as const)(
    "reads a name imported under another name as the export it is, over the %s",
    (reading) => {
      const ops = opsByCallee()[reading];

      expect(
        ops
          .get("made.eject")
          ?.receiverIsFrom(
            constructedFrom({ from: ["tapedeck"], named: ["Cassette"] }),
          ),
      ).toBe(true);
      expect(
        ops
          .get("made.eject")
          ?.receiverIsFrom(
            constructedFrom({ from: ["tapedeck"], named: ["Deck"] }),
          ),
      ).toBe(false);
      expect(ops.get("reel")?.calleeImportedAs?.(["tapedeck"])).toBe("tape");
      expect(ops.get("reel")?.calleeImportedAs?.(["elsewhere"])).toBeNull();
      expect(
        ops.get("go")?.calleeImportedAs?.(["tapedeck"]) ?? null,
      ).toBeNull();
    },
  );

  it.each(["nodes", "facts"] as const)(
    "never asks what a parameter was imported as, whatever its callers pass, over the %s",
    (reading) => {
      const store = new ResolutionStore();
      const asked = vi.spyOn(store, "importedAsOf");
      const ops = opsByCallee(store)[reading];

      expect(ops.get("play")?.calleeImportedAs?.(["tapedeck"])).toBeNull();
      expect(
        ops
          .get("again.eject")
          ?.receiverIsFrom(
            constructedFrom({ from: ["tapedeck"], named: ["Cassette"] }),
          ),
      ).toBe(false);
      expect(asked).not.toHaveBeenCalled();
    },
  );
});
