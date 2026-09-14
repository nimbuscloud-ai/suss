import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import { pathFromArgument } from "../resolve/routePath.js";
import { clientReceiverCheckFor, discoverClientCalls } from "./clientCall.js";

import type { DiscoveryPattern } from "@suss/extractor";

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

describe("naming a unit by its enclosing shape", () => {
  const match = {
    type: "clientCall",
    importModule: "global",
    importName: "fetch",
  } as Extract<DiscoveryPattern["match"], { type: "clientCall" }>;

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
    const names = discoverClientCalls(file, match, "client").map(
      (unit) => unit.name,
    );
    expect(names.sort()).toEqual(["getUser", "listOrders"]);
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
    const names = discoverClientCalls(file, match, "client").map(
      (unit) => unit.name,
    );
    expect(names.sort()).toEqual(["fromWindow", "proxied"]);
  });
});

describe("a path a constructor argument states", () => {
  const match = {
    type: "clientCall",
    importModule: "global",
    importName: "fetch",
  } as Extract<DiscoveryPattern["match"], { type: "clientCall" }>;

  const binding = {
    method: { type: "literal", value: "GET" },
    path: { type: "fromArgument", position: 0 },
  } as NonNullable<DiscoveryPattern["bindingExtraction"]>;

  const RESOURCE = `
      export class Resource {
        constructor(private base: string) {}
        list() { return fetch(\`\${this.base}\`); }
        one(id: string) { return fetch(\`\${this.base}/\${id}\`); }
      }
  `;

  function pathsUnder(source: string): string[] {
    const project = createTestProject();
    const file = project.createSourceFile("/consumer.ts", source);
    const store = new ResolutionStore();
    return discoverClientCalls(file, match, "client", store, binding)
      .filter((unit) => unit.name === "list")
      .map((unit) =>
        pathFromArgument(
          unit.callSite?.callExpression.getArguments()[0] as Node,
          store,
          unit.callSite?.under,
        ),
      )
      .map((path) => path ?? "unresolved")
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

  it("leaves the hole in place when nothing constructs the class", () => {
    expect(pathsUnder(RESOURCE)).toEqual(["{base}"]);
  });

  it("gives one call when two constructions state the same path", () => {
    expect(
      pathsUnder(`${RESOURCE}
      export const users = new Resource("/users");
      export const same = new Resource("/users");
      `),
    ).toEqual(["/users"]);
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
    const units = discoverClientCalls(file, match, "client", watched, binding);

    expect(units).toHaveLength(1);
    expect(units[0]?.callSite?.under).toBeUndefined();
    expect(asked).toBe(0);
  });
});
