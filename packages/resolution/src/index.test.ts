// The rules on their own, fed facts by hand.
//
// Every case here is written as facts rather than as source, so what is
// being tested is the inference and nothing else. A language adapter
// that can produce these facts inherits every answer below without
// writing a rule.

import { describe, expect, it } from "vitest";

import { Database, evaluate } from "@suss/datalog";

import { RESOLUTION_RULES } from "./index.js";

/** Feed facts in, run the rules, and read one relation back. */
function derive(
  facts: Array<[string, ...string[]]>,
  relation: string,
  subject: string,
): ReadonlyArray<ReadonlyArray<string | number>> {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return evaluate(db, RESOLUTION_RULES)
    .facts(relation)
    .filter((t) => t[0] === subject);
}

/** What a value comes down to. */
function resolutionsOf(
  facts: Array<[string, ...string[]]>,
  value: string,
): string[] {
  return derive(facts, "resolves", value)
    .map((t) => String(t[1]))
    .sort();
}

/** The (module, name) pairs a value's chain arrives at. */
function originsOf(
  facts: Array<[string, ...string[]]>,
  value: string,
): string[] {
  return pairs(derive(facts, "comesFrom", value));
}

/** The (module, name) pairs calling a function ends up reaching. */
function callsOf(facts: Array<[string, ...string[]]>, fn: string): string[] {
  return pairs(derive(facts, "callsInto", fn));
}

const pairs = (
  tuples: ReadonlyArray<ReadonlyArray<string | number>>,
): string[] => tuples.map((t) => `${t[1]}:${t[2]}`).sort();

describe("following a name to a function", () => {
  it("stops at a function, which resolves to itself", () => {
    expect(resolutionsOf([["func", "f"]], "f")).toEqual(["f"]);
  });

  it("follows a name declared as another name", () => {
    expect(
      resolutionsOf(
        [
          ["func", "f"],
          ["binds", "alias", "f"],
          ["binds", "again", "alias"],
        ],
        "again",
      ),
    ).toEqual(["f"]);
  });

  it("follows an import to what the module exports", () => {
    expect(
      resolutionsOf(
        [
          ["func", "f"],
          ["exportsAs", "mod", "thing", "f"],
          ["imports", "here", "mod", "thing"],
        ],
        "here",
      ),
    ).toEqual(["f"]);
  });

  it("follows a chain of barrels", () => {
    expect(
      resolutionsOf(
        [
          ["func", "f"],
          ["exportsAs", "deep", "thing", "f"],
          ["reExports", "middle", "thing", "deep", "thing"],
          ["reExports", "top", "thing", "middle", "thing"],
          ["imports", "here", "top", "thing"],
        ],
        "here",
      ),
    ).toEqual(["f"]);
  });

  it("follows a barrel that forwards everything, under a new name", () => {
    // The re-export renames on the way through, which is what makes a
    // star export more than a shortcut.
    expect(
      resolutionsOf(
        [
          ["func", "f"],
          ["exportsAs", "deep", "inner", "f"],
          ["reExportsAll", "top", "deep"],
          ["imports", "here", "top", "inner"],
        ],
        "here",
      ),
    ).toEqual(["f"]);
  });
});

describe("a factory that hands back what it was given", () => {
  // handler = make(body): make returns a function whose body calls its
  // parameter, so calling make gives back body.
  const wrapper: Array<[string, ...string[]]> = [
    ["func", "body"],
    ["func", "make"],
    ["func", "returned"],
    ["paramOf", "make", "0", "p"],
    ["returnsValue", "make", "returned"],
    ["containsFn", "make", "returned"],
    ["bodyCalls", "returned", "pRef"],
    ["binds", "pRef", "p"],
    ["call", "handler", "makeRef"],
    ["binds", "makeRef", "make"],
    ["callArg", "handler", "0", "body"],
  ];

  it("resolves the call to the argument the factory wraps", () => {
    expect(resolutionsOf(wrapper, "handler")).toEqual(["body"]);
  });

  it("reaches the argument through a closure two levels down", () => {
    // The returned function declares a closure that declares another,
    // and the innermost one makes the call. No rule mentions depth.
    const nested: Array<[string, ...string[]]> = [
      ...wrapper.filter(([r, f]) => !(r === "bodyCalls" && f === "returned")),
      ["containsFn", "returned", "inner"],
      ["containsFn", "inner", "innermost"],
      ["bodyCalls", "innermost", "pRef"],
    ];
    expect(resolutionsOf(nested, "handler")).toEqual(["body"]);
  });

  it("carries through a factory that hands off to another factory", () => {
    // outer(body) returns inner(cfg, body), and inner is the wrapper.
    // Neither rule says anything about two factories.
    const delegating: Array<[string, ...string[]]> = [
      ...wrapper.filter(([r]) => r !== "call" && r !== "callArg"),
      ["func", "outer"],
      ["paramOf", "outer", "1", "outerBody"],
      ["returnsValue", "outer", "innerCall"],
      ["call", "innerCall", "makeRef"],
      ["callArg", "innerCall", "0", "outerBodyRef"],
      ["binds", "outerBodyRef", "outerBody"],
      ["call", "handler", "outerRef"],
      ["binds", "outerRef", "outer"],
      ["callArg", "handler", "1", "body"],
    ];
    expect(resolutionsOf(delegating, "handler")).toEqual(["body"]);
  });

  it("says nothing when the factory ignores its argument", () => {
    const ignores = wrapper.filter(([r]) => r !== "bodyCalls");
    expect(resolutionsOf(ignores, "handler")).toEqual([]);
  });
});

describe("a value reached through a property", () => {
  it("follows a name to what an object holds under it", () => {
    // const routes = { list: f }; routes.list
    expect(
      resolutionsOf(
        [
          ["func", "f"],
          ["objectValue", "obj"],
          ["holdsProperty", "obj", "list", "f"],
          ["binds", "routes", "obj"],
          ["readsProperty", "x", "routesRef", "list"],
          ["binds", "routesRef", "routes"],
        ],
        "x",
      ),
    ).toEqual(["f"]);
  });

  it("keeps sibling properties apart", () => {
    expect(
      resolutionsOf(
        [
          ["func", "f"],
          ["func", "g"],
          ["objectValue", "obj"],
          ["holdsProperty", "obj", "list", "f"],
          ["holdsProperty", "obj", "remove", "g"],
          ["readsProperty", "x", "objRef", "remove"],
          ["binds", "objRef", "obj"],
        ],
        "x",
      ),
    ).toEqual(["g"]);
  });

  it("follows a property read off a factory call", () => {
    // make(f).handle, where make returns { handle: g }.
    expect(
      resolutionsOf(
        [
          ["func", "g"],
          ["func", "make"],
          ["objectValue", "ret"],
          ["holdsProperty", "ret", "handle", "g"],
          ["returnsValue", "make", "ret"],
          ["call", "site", "makeRef"],
          ["binds", "makeRef", "make"],
          ["readsProperty", "x", "site", "handle"],
        ],
        "x",
      ),
    ).toEqual(["g"]);
  });

  it("answers nothing for a property the object does not hold", () => {
    expect(
      resolutionsOf(
        [
          ["func", "f"],
          ["objectValue", "obj"],
          ["holdsProperty", "obj", "list", "f"],
          ["readsProperty", "x", "objRef", "missing"],
          ["binds", "objRef", "obj"],
        ],
        "x",
      ),
    ).toEqual([]);
  });
});

describe("a wrapper the caller declared transparent", () => {
  it("resolves through a named wrapper from the module it names", () => {
    expect(
      resolutionsOf(
        [
          ["func", "body"],
          ["calleeName", "handler", "Sentry.wrapHandler"],
          ["unwrapsByName", "Sentry.wrapHandler", "0"],
          ["wrapperModule", "Sentry.wrapHandler", "@sentry/aws-serverless"],
          ["calleeOrigin", "handler", "@sentry/aws-serverless"],
          ["callArg", "handler", "0", "body"],
        ],
        "handler",
      ),
    ).toEqual(["body"]);
  });

  it("ignores a local function spelled the same way", () => {
    // Same name, different origin. A project's own helper called
    // `wrapHandler` is not the library's.
    expect(
      resolutionsOf(
        [
          ["func", "body"],
          ["calleeName", "handler", "Sentry.wrapHandler"],
          ["unwrapsByName", "Sentry.wrapHandler", "0"],
          ["wrapperModule", "Sentry.wrapHandler", "@sentry/aws-serverless"],
          ["calleeOrigin", "handler", "./lib/sentry"],
          ["callArg", "handler", "0", "body"],
        ],
        "handler",
      ),
    ).toEqual([]);
  });
});

describe("where a name comes from", () => {
  it("answers with the module an import names", () => {
    expect(
      originsOf([["imports", "here", "@nestjs/graphql", "Resolver"]], "here"),
    ).toEqual(["@nestjs/graphql:Resolver"]);
  });

  it("follows aliases to the import underneath", () => {
    expect(
      originsOf(
        [
          ["imports", "spec", "@nestjs/graphql", "Resolver"],
          ["binds", "use", "spec"],
        ],
        "use",
      ),
    ).toEqual(["@nestjs/graphql:Resolver"]);
  });

  it("follows a project barrel to the package behind it", () => {
    // Both hops are true and both are reported. A caller asks whether
    // the module it cares about is among them, so the barrel's own
    // answer costs it nothing.
    expect(
      originsOf(
        [
          ["imports", "here", "barrel", "Resolver"],
          ["exportsAs", "barrel", "Resolver", "local"],
          ["imports", "local", "@nestjs/graphql", "Resolver"],
        ],
        "here",
      ),
    ).toEqual(["@nestjs/graphql:Resolver", "barrel:Resolver"]);
  });
});

describe("what calling a project wrapper reaches", () => {
  // `const Wrapped = (t) => compose(Resolver(t), SetMetadata(k, v))`,
  // as facts: a function whose body calls three imported names.
  const wrapper: Array<[string, ...string[]]> = [
    ["func", "wrapped"],
    ["binds", "Wrapped", "wrapped"],
    ["bodyCalls", "wrapped", "composeRef"],
    ["bodyCalls", "wrapped", "resolverRef"],
    ["bodyCalls", "wrapped", "metadataRef"],
    ["imports", "composeRef", "@nestjs/common", "applyDecorators"],
    ["imports", "resolverRef", "@nestjs/graphql", "Resolver"],
    ["imports", "metadataRef", "@nestjs/common", "SetMetadata"],
  ];

  it("answers with every library name the wrapper applies", () => {
    expect(callsOf(wrapper, "wrapped")).toEqual([
      "@nestjs/common:SetMetadata",
      "@nestjs/common:applyDecorators",
      "@nestjs/graphql:Resolver",
    ]);
  });

  it("reaches through a wrapper of a wrapper", () => {
    expect(
      callsOf(
        [...wrapper, ["func", "outer"], ["bodyCalls", "outer", "Wrapped"]],
        "outer",
      ),
    ).toContain("@nestjs/graphql:Resolver");
  });

  it("reaches a call made from a closure the wrapper declares", () => {
    expect(
      callsOf(
        [
          ["func", "outer"],
          ["func", "inner"],
          ["containsFn", "outer", "inner"],
          ["bodyCalls", "inner", "resolverRef"],
          ["imports", "resolverRef", "@nestjs/graphql", "Resolver"],
        ],
        "outer",
      ),
    ).toEqual(["@nestjs/graphql:Resolver"]);
  });

  it("says nothing about a wrapper that calls only project code", () => {
    expect(
      callsOf(
        [
          ["func", "outer"],
          ["func", "helper"],
          ["bodyCalls", "outer", "helperRef"],
          ["binds", "helperRef", "helper"],
        ],
        "outer",
      ),
    ).toEqual([]);
  });
});
