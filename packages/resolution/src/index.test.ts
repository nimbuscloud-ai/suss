// The rules on their own, fed facts by hand.
//
// Every case here is written as facts rather than as source, so what is
// being tested is the inference and nothing else. A language adapter
// that can produce these facts inherits every answer below without
// writing a rule.

import { describe, expect, it } from "vitest";

import { Database, evaluate } from "@suss/datalog";

import { RESOLUTION_RULES } from "./index.js";

/**
 * Feed facts in, run the rules, and read one relation back, keeping the
 * tuples with `subject` in column `at`. Every relation here is keyed by
 * the value asked about except `paramAt`, which is keyed by the call.
 */
function derive(
  facts: Array<[string, ...string[]]>,
  relation: string,
  subject: string,
  at = 0,
): ReadonlyArray<ReadonlyArray<string | number>> {
  const db = new Database();
  for (const [name, ...tuple] of facts) {
    db.add(name, tuple);
  }
  return evaluate(db, RESOLUTION_RULES)
    .facts(relation)
    .filter((t) => t[at] === subject);
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

/** What calling a value gives back. */
function resultsOf(
  facts: Array<[string, ...string[]]>,
  value: string,
): string[] {
  return derive(facts, "givesBack", value)
    .map((t) => String(t[1]))
    .sort();
}

/** The expressions a value is written as. */
function writtenAsOf(
  facts: Array<[string, ...string[]]>,
  value: string,
): string[] {
  return derive(facts, "isWrittenAs", value)
    .map((t) => String(t[1]))
    .sort();
}

/** What each call site put in a parameter, as `call:value`. */
function perCallSite(
  facts: Array<[string, ...string[]]>,
  param: string,
): string[] {
  return derive(facts, "paramAt", param, 1)
    .map((t) => `${t[0]}:${t[2]}`)
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

  it("follows an argument into a function the caller imported", () => {
    // import { take } from "mod"; take(handler)
    expect(
      resolutionsOf(
        [
          ["func", "handler"],
          ["func", "take"],
          ["exportsAs", "mod", "take", "take"],
          ["imports", "takeImport", "mod", "take"],
          ["binds", "takeRef", "takeImport"],
          ["binds", "handlerRef", "handler"],
          ["paramOf", "take", "0", "take#h"],
          ["call", "site", "takeRef"],
          ["callArg", "site", "0", "handlerRef"],
        ],
        "take#h",
      ),
    ).toEqual(["handler"]);
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

  it("puts a construction's argument in the constructor's parameter", () => {
    // class Service { constructor(dao) {} }; new Service(dao)
    expect(
      resolutionsOf(
        [
          ["func", "dao"],
          ["objectValue", "Service"],
          ["paramOf", "Service", "0", "Service#dao"],
          ["binds", "ServiceRef", "Service"],
          ["binds", "daoRef", "dao"],
          ["call", "made", "ServiceRef"],
          ["callArg", "made", "0", "daoRef"],
        ],
        "Service#dao",
      ),
    ).toEqual(["dao"]);
  });

  it("follows a call through a field the constructor was handed", () => {
    // new Service(new Dao()), and the service calls this.dao.find()
    expect(
      resolutionsOf(
        [
          ["func", "find"],
          ["objectValue", "Dao"],
          ["holdsProperty", "Dao", "find", "find"],
          ["objectValue", "Service"],
          ["paramOf", "Service", "0", "Service#dao"],
          ["binds", "DaoRef", "Dao"],
          ["binds", "ServiceRef", "Service"],
          ["call", "madeDao", "DaoRef"],
          ["call", "madeService", "ServiceRef"],
          ["callArg", "madeService", "0", "madeDao"],
          ["binds", "thisDao", "Service#dao"],
          ["readsProperty", "callee", "thisDao", "find"],
        ],
        "callee",
      ),
    ).toEqual(["find"]);
  });

  it("gives both methods when two construction sites pass different classes", () => {
    expect(
      resolutionsOf(
        [
          ["func", "find"],
          ["func", "findAgain"],
          ["objectValue", "Dao"],
          ["objectValue", "OtherDao"],
          ["holdsProperty", "Dao", "find", "find"],
          ["holdsProperty", "OtherDao", "find", "findAgain"],
          ["objectValue", "Service"],
          ["paramOf", "Service", "0", "Service#dao"],
          ["binds", "DaoRef", "Dao"],
          ["binds", "OtherDaoRef", "OtherDao"],
          ["binds", "ServiceRef", "Service"],
          ["call", "madeDao", "DaoRef"],
          ["call", "madeOther", "OtherDaoRef"],
          ["call", "siteA", "ServiceRef"],
          ["callArg", "siteA", "0", "madeDao"],
          ["call", "siteB", "ServiceRef"],
          ["callArg", "siteB", "0", "madeOther"],
          ["binds", "thisDao", "Service#dao"],
          ["readsProperty", "callee", "thisDao", "find"],
        ],
        "callee",
      ),
    ).toEqual(["find", "findAgain"]);
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

describe("what a call gives back", () => {
  // function makeDao() { return new Dao(); }; const dao = makeDao()
  const factory: Array<[string, ...string[]]> = [
    ["func", "load"],
    ["objectValue", "Dao"],
    ["holdsProperty", "Dao", "load", "load"],
    ["binds", "DaoRef", "Dao"],
    ["call", "madeDao", "DaoRef"],
    ["func", "makeDao"],
    ["returnsValue", "makeDao", "madeDao"],
    ["binds", "makeDaoRef", "makeDao"],
    ["call", "site", "makeDaoRef"],
  ];

  it("gives back the class the factory made one of", () => {
    expect(resultsOf(factory, "site")).toEqual(["Dao"]);
  });

  it("gives back the same through the name the call was declared as", () => {
    expect(resultsOf([...factory, ["binds", "dao", "site"]], "dao")).toEqual([
      "Dao",
    ]);
  });

  it("gives back the same through the parameter the call was passed to", () => {
    // new Service(makeDao()), and the service calls this.dao.load().
    const passedIn: Array<[string, ...string[]]> = [
      ...factory,
      ["objectValue", "Service"],
      ["paramOf", "Service", "0", "Service#dao"],
      ["binds", "ServiceRef", "Service"],
      ["call", "madeService", "ServiceRef"],
      ["callArg", "madeService", "0", "site"],
    ];
    expect(resultsOf(passedIn, "Service#dao")).toEqual(["Dao"]);
  });

  it("gives back the same through the property an object contains", () => {
    // const deps = { dao: makeDao() }; deps.dao.load()
    const inAnObject: Array<[string, ...string[]]> = [
      ...factory,
      ["objectValue", "deps"],
      ["holdsProperty", "deps", "dao", "site"],
      ["binds", "depsRef", "deps"],
      ["readsProperty", "read", "depsRef", "dao"],
    ];
    expect(resultsOf(inAnObject, "read")).toEqual(["Dao"]);
  });

  it("gives back the same through the module the factory is imported from", () => {
    const imported: Array<[string, ...string[]]> = [
      ...factory.filter(([r, x]) => !(r === "binds" && x === "makeDaoRef")),
      ["exportsAs", "factoryMod", "makeDao", "makeDao"],
      ["imports", "makeDaoImport", "factoryMod", "makeDao"],
      ["binds", "makeDaoRef", "makeDaoImport"],
    ];
    expect(resultsOf(imported, "site")).toEqual(["Dao"]);
  });

  it("gives back what the inner call does, for a factory returning a factory", () => {
    // const dao = daoBuilder()(), where daoBuilder returns () => new Dao().
    const twoHops: Array<[string, ...string[]]> = [
      ...factory.filter(([r, x]) => !(r === "call" && x === "site")),
      ["func", "builtFactory"],
      ["returnsValue", "builtFactory", "madeDao"],
      ["func", "daoBuilder"],
      ["returnsValue", "daoBuilder", "builtFactory"],
      ["binds", "daoBuilderRef", "daoBuilder"],
      ["call", "inner", "daoBuilderRef"],
      ["call", "outer", "inner"],
      ["binds", "dao", "outer"],
    ];
    expect(resultsOf(twoHops, "dao")).toEqual(["Dao"]);
  });

  it("gives back nothing when the returned value resolves to nothing", () => {
    // The factory returns a name nothing says anything about.
    const opaque = factory.filter(([r]) => r !== "call" && r !== "binds");
    expect(
      resultsOf(
        [
          ...opaque,
          ["binds", "makeDaoRef", "makeDao"],
          ["call", "site", "makeDaoRef"],
        ],
        "site",
      ),
    ).toEqual([]);
  });

  it("gives back nothing for a call whose callee resolves to nothing", () => {
    expect(resultsOf([["call", "site", "unknown"]], "site")).toEqual([]);
  });

  it("leaves the call's own comesTo alone, so a wrapper still unwraps", () => {
    expect(resolutionsOf(factory, "site")).toEqual([]);
  });

  it("reaches a method read off a name the factory built", () => {
    expect(
      resolutionsOf(
        [
          ...factory,
          ["binds", "dao", "site"],
          ["readsProperty", "callee", "daoRef", "load"],
          ["binds", "daoRef", "dao"],
        ],
        "callee",
      ),
    ).toEqual(["load"]);
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

describe("a value written as a fallback", () => {
  // The client singleton: `const client = global.client || new Client()`.
  // The global read resolves to nothing, so the construction is the only
  // claim the source makes.
  const singleton: Array<[string, ...string[]]> = [
    ["binds", "client", "fallback"],
    ["fallbackBranch", "fallback", "globalRead"],
    ["readsProperty", "globalRead", "globalObj", "client"],
    ["fallbackBranch", "fallback", "construction"],
    ["call", "construction", "clsRef"],
    ["writtenValue", "construction"],
  ];

  it("is written as the branch that resolves when the other makes no claim", () => {
    expect(writtenAsOf(singleton, "client")).toEqual(["construction"]);
  });

  it("comes to the function a resolvable branch reaches", () => {
    expect(
      resolutionsOf(
        [
          ["func", "handler"],
          ["binds", "picked", "fallback"],
          ["fallbackBranch", "fallback", "globalRead"],
          ["readsProperty", "globalRead", "globalObj", "cached"],
          ["fallbackBranch", "fallback", "handlerRef"],
          ["binds", "handlerRef", "handler"],
        ],
        "picked",
      ),
    ).toEqual(["handler"]);
  });

  it("derives both answers when both branches resolve, for the caller to refuse", () => {
    expect(
      resolutionsOf(
        [
          ["func", "primary"],
          ["func", "secondary"],
          ["binds", "picked", "fallback"],
          ["fallbackBranch", "fallback", "primaryRef"],
          ["binds", "primaryRef", "primary"],
          ["fallbackBranch", "fallback", "secondaryRef"],
          ["binds", "secondaryRef", "secondary"],
        ],
        "picked",
      ),
    ).toEqual(["primary", "secondary"]);
  });

  it("comes to the class a construction branch makes one of", () => {
    expect(
      derive(
        [
          ["objectValue", "Cls"],
          ["binds", "clsRef", "Cls"],
          ["binds", "client", "fallback"],
          ["fallbackBranch", "fallback", "globalRead"],
          ["readsProperty", "globalRead", "globalObj", "client"],
          ["fallbackBranch", "fallback", "construction"],
          ["call", "construction", "clsRef"],
          ["writtenValue", "construction"],
        ],
        "comesTo",
        "client",
      ).map((t) => String(t[1])),
    ).toEqual(["Cls"]);
  });

  it("gives back through a fallback whose branch is a factory call", () => {
    expect(
      resultsOf(
        [
          ["func", "makeClient"],
          ["func", "made"],
          ["returnsValue", "makeClient", "made"],
          ["binds", "factoryRef", "makeClient"],
          ["binds", "client", "fallback"],
          ["fallbackBranch", "fallback", "globalRead"],
          ["readsProperty", "globalRead", "globalObj", "client"],
          ["fallbackBranch", "fallback", "factoryCall"],
          ["call", "factoryCall", "factoryRef"],
          ["writtenValue", "factoryCall"],
        ],
        "client",
      ),
    ).toEqual(["made"]);
  });

  it("reaches a method off the instance a fallback's construction makes", () => {
    expect(
      resolutionsOf(
        [
          ["objectValue", "Cls"],
          ["func", "load"],
          ["holdsProperty", "Cls", "load", "load"],
          ["binds", "clsRef", "Cls"],
          ["binds", "client", "fallback"],
          ["fallbackBranch", "fallback", "globalRead"],
          ["readsProperty", "globalRead", "globalObj", "client"],
          ["fallbackBranch", "fallback", "construction"],
          ["call", "construction", "clsRef"],
          ["writtenValue", "construction"],
          ["readsProperty", "methodRead", "client", "load"],
        ],
        "methodRead",
      ),
    ).toEqual(["load"]);
  });

  it("follows a nested fallback branch by branch", () => {
    expect(
      resolutionsOf(
        [
          ["func", "f"],
          ["binds", "picked", "outer"],
          ["fallbackBranch", "outer", "inner"],
          ["fallbackBranch", "outer", "deadRight"],
          ["fallbackBranch", "inner", "deadLeft"],
          ["fallbackBranch", "inner", "fRef"],
          ["binds", "fRef", "f"],
        ],
        "picked",
      ),
    ).toEqual(["f"]);
  });
});

describe("the same steps, whichever question is asked", () => {
  it("reads a name handed to a constructor back off the field", () => {
    // new Dao("orders-v1"), and the class reads this.table.
    expect(
      writtenAsOf(
        [
          ["writtenValue", "orders-v1"],
          ["objectValue", "Dao"],
          ["paramOf", "Dao", "0", "Dao#table"],
          ["binds", "DaoRef", "Dao"],
          ["call", "made", "DaoRef"],
          ["callArg", "made", "0", "orders-v1"],
          ["binds", "thisTable", "Dao#table"],
        ],
        "thisTable",
      ),
    ).toEqual(["orders-v1"]);
  });

  it("follows a parameter to the library its argument was imported from", () => {
    // take(client), where client is the SDK's own export.
    expect(
      originsOf(
        [
          ["func", "take"],
          ["paramOf", "take", "0", "take#client"],
          ["binds", "takeRef", "take"],
          ["call", "site", "takeRef"],
          ["callArg", "site", "0", "clientRef"],
          ["binds", "clientRef", "clientImport"],
          ["imports", "clientImport", "@aws-sdk/client-s3", "S3Client"],
        ],
        "take#client",
      ),
    ).toEqual(["@aws-sdk/client-s3:S3Client"]);
  });

  it("reads a property out of an object a caller passed in", () => {
    // new Service({ table: "orders-v1" }), and the class reads
    // this.deps.table.
    expect(
      writtenAsOf(
        [
          ["writtenValue", "orders-v1"],
          ["objectValue", "deps"],
          ["holdsProperty", "deps", "table", "orders-v1"],
          ["objectValue", "Service"],
          ["paramOf", "Service", "0", "Service#deps"],
          ["binds", "ServiceRef", "Service"],
          ["binds", "depsRef", "deps"],
          ["call", "made", "ServiceRef"],
          ["callArg", "made", "0", "depsRef"],
          ["binds", "thisDeps", "Service#deps"],
          ["readsProperty", "read", "thisDeps", "table"],
        ],
        "read",
      ),
    ).toEqual(["orders-v1"]);
  });

  it("tells two call sites apart, where the parameter's own answer cannot", () => {
    const twoCallers: Array<[string, ...string[]]> = [
      ["func", "first"],
      ["func", "second"],
      ["func", "take"],
      ["binds", "takeRef", "take"],
      ["paramOf", "take", "0", "take#h"],
      ["call", "siteA", "takeRef"],
      ["callArg", "siteA", "0", "first"],
      ["call", "siteB", "takeRef"],
      ["callArg", "siteB", "0", "second"],
    ];
    expect(resolutionsOf(twoCallers, "take#h")).toEqual(["first", "second"]);
    expect(perCallSite(twoCallers, "take#h")).toEqual([
      "siteA:first",
      "siteB:second",
    ]);
  });
});
