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

describe("an argument reaching a parameter", () => {
  it("follows a positional argument into the parameter it lands in", () => {
    // function take(h) { ... }; take(handler)
    expect(
      resolutionsOf(
        [
          ["func", "handler"],
          ["func", "take"],
          ["binds", "takeRef", "take"],
          ["binds", "handlerRef", "handler"],
          ["paramOf", "take", "0", "take#h"],
          ["call", "site", "takeRef"],
          ["callArg", "site", "0", "handlerRef"],
        ],
        "take#h",
      ),
    ).toEqual(["handler"]);
  });

  it("follows a keyword argument by the name the caller wrote", () => {
    expect(
      resolutionsOf(
        [
          ["func", "handler"],
          ["func", "take"],
          ["binds", "takeRef", "take"],
          ["binds", "handlerRef", "handler"],
          ["paramNamed", "take", "h", "take#h"],
          ["call", "site", "takeRef"],
          ["callKeywordArg", "site", "h", "handlerRef"],
        ],
        "take#h",
      ),
    ).toEqual(["handler"]);
  });

  it("passes a parameter on through a second call", () => {
    expect(
      resolutionsOf(
        [
          ["func", "handler"],
          ["func", "outer"],
          ["func", "inner"],
          ["binds", "outerRef", "outer"],
          ["binds", "innerRef", "inner"],
          ["binds", "handlerRef", "handler"],
          ["paramNamed", "outer", "h", "outer#h"],
          ["paramNamed", "inner", "h", "inner#h"],
          ["call", "top", "outerRef"],
          ["callKeywordArg", "top", "h", "handlerRef"],
          ["call", "mid", "innerRef"],
          ["callKeywordArg", "mid", "h", "outer#h"],
        ],
        "inner#h",
      ),
    ).toEqual(["handler"]);
  });

  it("gives a parameter every value its callers pass, so the caller can see there is more than one", () => {
    expect(
      resolutionsOf(
        [
          ["func", "first"],
          ["func", "second"],
          ["func", "take"],
          ["binds", "takeRef", "take"],
          ["binds", "firstRef", "first"],
          ["binds", "secondRef", "second"],
          ["paramOf", "take", "0", "take#h"],
          ["call", "siteA", "takeRef"],
          ["callArg", "siteA", "0", "firstRef"],
          ["call", "siteB", "takeRef"],
          ["callArg", "siteB", "0", "secondRef"],
        ],
        "take#h",
      ),
    ).toEqual(["first", "second"]);
  });

  it("says nothing about a parameter of a function nobody calls by name", () => {
    expect(
      resolutionsOf(
        [
          ["func", "handler"],
          ["func", "take"],
          ["paramOf", "take", "0", "take#h"],
          ["call", "site", "someUnknownThing"],
          ["callArg", "site", "0", "handler"],
        ],
        "take#h",
      ),
    ).toEqual([]);
  });
});

describe("a class the caller makes one of", () => {
  it("follows a method read off an instance to the method the class declares", () => {
    // class Loader { load() {} }; new Loader().load
    expect(
      resolutionsOf(
        [
          ["func", "load"],
          ["objectValue", "Loader"],
          ["holdsProperty", "Loader", "load", "load"],
          ["binds", "LoaderRef", "Loader"],
          ["call", "made", "LoaderRef"],
          ["binds", "loader", "made"],
          ["readsProperty", "x", "loader", "load"],
        ],
        "x",
      ),
    ).toEqual(["load"]);
  });

  it("leaves a factory call alone, since a function is not a class", () => {
    expect(
      resolutionsOf(
        [
          ["func", "make"],
          ["func", "inner"],
          ["binds", "makeRef", "make"],
          ["returnsValue", "make", "inner"],
          ["call", "made", "makeRef"],
        ],
        "made",
      ),
    ).toEqual([]);
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

describe("a name written more than once", () => {
  it("comes to the value the writes leave it holding", () => {
    expect(
      resolutionsOf(
        [
          ["func", "first"],
          ["func", "second"],
          ["endsHolding", "panel", "second"],
        ],
        "panel",
      ),
    ).toEqual(["second"]);
  });

  it("comes to nothing when the adapter cannot say which write reaches", () => {
    // A write inside a branch, a loop, or a function body: the adapter
    // emits no `endsHolding`, and two values with no way to tell which
    // one a read sees is not an answer.
    expect(
      resolutionsOf(
        [
          ["func", "first"],
          ["func", "second"],
        ],
        "panel",
      ),
    ).toEqual([]);
  });

  it("carries the surviving value through an alias and an import", () => {
    expect(
      resolutionsOf(
        [
          ["func", "second"],
          ["endsHolding", "panel", "second"],
          ["exportsAs", "mod", "Panel", "panel"],
          ["imports", "here", "mod", "Panel"],
          ["binds", "alias", "here"],
        ],
        "alias",
      ),
    ).toEqual(["second"]);
  });

  it("follows the surviving value through a wrapper call", () => {
    expect(
      resolutionsOf(
        [
          ["func", "body"],
          ["func", "wrap"],
          ["call", "wrapped", "wrapRef"],
          ["binds", "wrapRef", "wrap"],
          ["paramOf", "wrap", "0", "p"],
          ["returnsValue", "wrap", "inner"],
          ["func", "inner"],
          ["bodyCalls", "inner", "pRef"],
          ["binds", "pRef", "p"],
          ["callArg", "wrapped", "0", "body"],
          ["endsHolding", "panel", "wrapped"],
        ],
        "panel",
      ),
    ).toEqual(["body"]);
  });
});
