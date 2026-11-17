import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { profileEvaluation } from "@suss/datalog";
import {
  anyOf,
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
} from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import { fetchRequests } from "../__fixtures__/fetchRequests.js";
import { ResolutionStore } from "../facts/store.js";
import { clientReceiverCheckFor } from "./clientCall.js";
import { discoverUnits } from "./index.js";

import type { DiscoveryPattern, RequestRecognizer } from "@suss/extractor";
import type { SourceFile } from "ts-morph";

type ClientCallMatch = Extract<
  DiscoveryPattern["match"],
  { type: "clientCall" }
>;

const DECK_TYPES = `
  export default class Deck {
    play(track: string): Promise<void>;
  }
  export declare function makeDeck(): Deck;
`;

function projectWithDeck() {
  const project = createTestProject();
  project.createSourceFile(
    "/node_modules/tapedeck/package.json",
    JSON.stringify({ name: "tapedeck", types: "index.d.ts" }),
  );
  project.createSourceFile("/node_modules/tapedeck/index.d.ts", DECK_TYPES);
  return project;
}

function subjectNamed(
  source: string,
  name: string,
  project = projectWithDeck(),
) {
  const file = project.createSourceFile("/consumer.ts", source);
  const found = file
    .getDescendants()
    .filter((node) => Node.isIdentifier(node) && node.getText() === name);
  const last = found[found.length - 1];
  if (last === undefined) {
    throw new Error(`no identifier ${name} in the fixture`);
  }
  return { file, subject: last };
}

/** The client units one `clientCall` pattern finds in the file. */
function unitsOf(file: SourceFile, match: ClientCallMatch) {
  return discoverUnits(
    file,
    [{ kind: "client", match }],
    new ResolutionStore(),
  );
}

/** The client units a pack's request hooks find in the file. */
function requestUnitsOf(
  file: SourceFile,
  hooks: RequestRecognizer[],
  store = new ResolutionStore(),
) {
  return discoverUnits(file, [], store, undefined, undefined, {
    requestRecognizers: hooks,
  });
}

describe("clientReceiverCheckFor without a store", () => {
  const match = { importModule: "tapedeck", importName: "Deck" };

  it("recognizes the default import under its conventional name", () => {
    const { file, subject } = subjectNamed(
      `import Deck from "tapedeck";\nconst d = Deck;\n`,
      "Deck",
    );
    expect(clientReceiverCheckFor(file, match, undefined)(subject)).toBe(true);
  });

  it("recognizes a named import by its alias", () => {
    const { file, subject } = subjectNamed(
      `import { makeDeck as build } from "tapedeck";\nconst d = build;\n`,
      "build",
    );
    const named = { importModule: "tapedeck", importName: "makeDeck" };
    expect(clientReceiverCheckFor(file, named, undefined)(subject)).toBe(true);
  });

  it("recognizes a parameter typed as the client class", () => {
    const { file, subject } = subjectNamed(
      `import Deck from "tapedeck";\nexport const play = (deck: Deck) => deck;\nconst use = play;\nconst deck = 0;\n`,
      "deck",
    );
    expect(clientReceiverCheckFor(file, match, undefined)(subject)).toBe(true);
  });

  it("recognizes a namespace import spelled as the client name", () => {
    const { file, subject } = subjectNamed(
      `import * as Deck from "tapedeck";\nconst d = Deck;\n`,
      "Deck",
    );
    expect(clientReceiverCheckFor(file, match, undefined)(subject)).toBe(true);
  });

  it("says no for a name from somewhere else", () => {
    const { file, subject } = subjectNamed(
      "const other = { play: () => null };\nconst d = other;\n",
      "other",
    );
    expect(clientReceiverCheckFor(file, match, undefined)(subject)).toBe(false);
  });
});

describe("clientReceiverCheckFor with a store", () => {
  it("recognizes an instance a factory call builds, at any callee shape", () => {
    const project = projectWithDeck();
    const { file, subject } = subjectNamed(
      `import { makeDeck } from "tapedeck";\nconst deck = makeDeck();\nconst chained = (makeDeck())!;\nconst use = deck;\n`,
      "deck",
      project,
    );
    const check = clientReceiverCheckFor(
      file,
      { importModule: "tapedeck", importName: "makeDeck" },
      new ResolutionStore(),
    );
    expect(check(subject)).toBe(true);
  });
});

/** `fetch(url)` sending a GET, whatever the call's options say. */
const FETCH = fetchRequests({ sends: "GET", url: { at: 0 } });

describe("naming a unit by its enclosing shape", () => {
  it("uses the method name and the property name the call is written under", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/consumer.ts",
      `
      export class Api {
        getUser() {
          return fetch("/users/1");
        }
      }
      export const handlers = {
        listOrders: () => fetch("/orders"),
      };
      `,
    );
    const names = requestUnitsOf(file, FETCH).map((unit) => unit.name);
    expect(names.sort()).toEqual(["getUser", "listOrders"]);
  });

  it("names a quoted method and a quoted property by the key, without its quotes", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/consumer.ts",
      `
      export class Api {
        "get-user"() {
          return fetch("/users/1");
        }
      }
      export const handlers = {
        "list-orders": () => fetch("/orders"),
      };
      `,
    );
    const names = requestUnitsOf(file, FETCH).map((unit) => unit.name);
    expect(names.sort()).toEqual(["get-user", "list-orders"]);
  });

  it("matches the global through globalThis and window, and not a method of that name elsewhere", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/consumer.ts",
      `
      export const proxied = () => globalThis.fetch("/proxied");
      export const fromWindow = () => window.fetch("/from-window");
      export const notAGlobal = (api: { fetch: (p: string) => unknown }) => api.fetch("/x");
      `,
    );
    const units = requestUnitsOf(file, FETCH);
    expect(units.map((unit) => unit.name).sort()).toEqual([
      "fromWindow",
      "proxied",
    ]);
    // A function read off the global object is called as itself.
    expect(units.map((unit) => unit.callSite?.methodName)).toEqual([
      null,
      null,
    ]);
  });
});

describe("a path a constructor argument states", () => {
  const RESOURCE = `
      export class Resource {
        constructor(private base: string) {}
        list() { return fetch(\`\${this.base}\`); }
        one(id: string) { return fetch(\`\${this.base}/\${id}\`); }
      }
  `;

  /** The path of each request the function makes, as its unit's request says, with "unresolved" for none. */
  function pathsUnder(source: string, name = "list"): string[] {
    const project = createTestProject();
    const file = project.createSourceFile("/consumer.ts", source);
    return requestUnitsOf(file, FETCH)
      .filter((unit) => unit.name === name)
      .map((unit) => unit.callSite?.request?.path ?? "unresolved")
      .sort();
  }

  it("gives one call per construction of the class", () => {
    expect(
      pathsUnder(`${RESOURCE}
      export const users = new Resource("/users");
      export const orders = new Resource("/orders");
      `),
    ).toEqual(["/orders", "/users"]);
  });

  it("gives one call when the class is constructed once", () => {
    expect(
      pathsUnder(`${RESOURCE}
      export const users = new Resource("/users");
      `),
    ).toEqual(["/users"]);
  });

  it("gives a call with no path when nothing constructs the class", () => {
    expect(pathsUnder(RESOURCE)).toEqual(["unresolved"]);
  });

  it("gives one call when two constructions state the same path", () => {
    expect(
      pathsUnder(`${RESOURCE}
      export const users = new Resource("/users");
      export const same = new Resource("/users");
      `),
    ).toEqual(["/users"]);
  });

  it("keeps a construction whose argument it cannot read, beside one it can", () => {
    expect(
      pathsUnder(`
      export class Versioned {
        constructor(private base: string) {}
        list() { return fetch(\`/v1\${this.base}\`); }
      }
      export const users = new Versioned("/users");
      export const configured = new Versioned(\`/\${process.env.KIND}\`);
      `),
    ).toEqual(["/v1/users", "/v1/{KIND}"]);
  });

  it("keeps the call's own path when no construction gives it one", () => {
    expect(
      pathsUnder(
        `
        import logger from "./logger";
        const HOST = "api.example.com";
        class Mailer {
          private url = \`https://\${HOST}/v1\`;
          private log: unknown;
          private auth: { token: string };
          constructor(private key: string) {
            this.auth = this.authFor(key);
            this.log = logger.child(key);
          }
          private authFor = (key: string) => ({ token: key });
          send(endpoint: string) {
            return fetch(\`\${this.url}\${endpoint}\`, { method: "GET" });
          }
        }
        export default function build(key: string) {
          return new Mailer(key);
        }
        `,
        "send",
      ),
    ).toEqual(["/v1{endpoint}"]);
  });

  it("asks nothing under a site for a path written out at the call", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/consumer.ts",
      `
      export class Resource {
        constructor(private base: string) {}
        list() { return fetch("/users"); }
      }
      export const users = new Resource("/users");
      `,
    );
    const store = new ResolutionStore();
    let asked = 0;
    const watched = new Proxy(store, {
      get(target, name, receiver) {
        if (name === "constructionSitesOf") {
          asked += 1;
        }
        return Reflect.get(target, name, receiver) as unknown;
      },
    });
    const units = requestUnitsOf(file, FETCH, watched);

    expect(units).toHaveLength(1);
    expect(units[0]?.callSite?.under).toBeUndefined();
    expect(asked).toBe(0);
  });
});

describe("a URL fetch reads without a request", () => {
  it("is no client call, written out, named or built from a template", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/consumer.ts",
      `
      const ICON = "data:image/svg+xml;base64,PHN2Zz4=";
      export const icon = () => fetch(ICON);
      export const inline = (b64: string) => fetch(\`data:image/png;base64,\${b64}\`);
      export const page = () => fetch("about:blank");
      export const orders = () => fetch("/orders");
      export const any = (url: string) => fetch(url);
      `,
    );
    const names = requestUnitsOf(file, FETCH).map((unit) => unit.name);
    expect(names.sort()).toEqual(["any", "orders"]);
  });
});

describe("a file's receivers, asked about together", () => {
  /** `play(track)` on the default import, or on what constructing it builds, sends a GET. */
  const PLAYS = requestRecognizersOf([
    httpRequests({
      client: anyOf(
        imported({ from: ["tapedeck"], named: ["default"] }),
        constructedFrom({ from: ["tapedeck"], named: ["default"] }),
      ),
    }).methods({ play: { sends: "GET", url: { at: 0 } } }),
  ]);

  /** A consumer beside a module that builds the client two ways. */
  function consumerOf(source: string) {
    const project = projectWithDeck();
    project.createSourceFile(
      "/deck.ts",
      `import Deck from "tapedeck";
      export const deck = new Deck();
      export const makeDeck = () => new Deck();
      `,
    );
    return project.createSourceFile("/consumer.ts", source);
  }

  it("matches the import, an instance built elsewhere, and one a project function returns", () => {
    const file = consumerOf(`
      import Deck from "tapedeck";
      import { deck, makeDeck } from "./deck";
      const other = { play: (track: string) => track };
      export function onImport() { return Deck.play("a"); }
      export function onInstance() { return deck.play("b"); }
      export function onReturned() { return makeDeck().play("c"); }
      export function onOther() { return other.play("d"); }
      export function notPlayed() { return deck.side("a"); }
    `);
    const names = requestUnitsOf(file, PLAYS).map((unit) => unit.name);
    expect(names.sort()).toEqual(["onImport", "onInstance", "onReturned"]);
  });

  it("asks no more questions of a file with ten other receivers than of one with two", () => {
    const costWith = (receivers: number) => {
      const others = Array.from(
        { length: receivers },
        (_, i) => `const other${i} = { play: (track: string) => track };
        export function play${i}() { return other${i}.play("x"); }`,
      );
      const file = consumerOf(`
        import { deck } from "./deck";
        ${others.join("\n")}
        export function played() { return deck.play("y"); }
      `);
      return profileEvaluation(() => requestUnitsOf(file, PLAYS)).profile
        .evaluations;
    };

    expect(costWith(10)).toBe(costWith(2));
  });
});

describe("a client built from a contract", () => {
  const DECK: ClientCallMatch = {
    type: "clientCall",
    importModule: "tapedeck",
    importName: "makeDeck",
  };

  it("takes every method called on what the builder made, and on nothing else", () => {
    const project = projectWithDeck();
    const file = project.createSourceFile(
      "/consumer.ts",
      `
      import { makeDeck } from "tapedeck";
      const deck = makeDeck();
      const other = { play: (track: string) => track };
      export function played() { return deck.play("a"); }
      export function turned() { return deck.side("b"); }
      export function elsewhere() { return other.play("c"); }
      export function called() { return makeDeck(); }
      `,
    );
    const units = unitsOf(file, DECK);
    expect(units.map((unit) => unit.name).sort()).toEqual(["played", "turned"]);
    expect(units.map((unit) => unit.callSite?.methodName).sort()).toEqual([
      "play",
      "side",
    ]);
  });
});
