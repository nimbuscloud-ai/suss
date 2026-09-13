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

/** The objects an expression refers to. */
function objectsOf(
  facts: Array<[string, ...string[]]>,
  value: string,
): string[] {
  return derive(facts, "objectOf", value)
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

  // const app = new App(); `app` is written as two things at once, the
  // construction and the class it made one of. See issue #1055, item 8.
  it.skip("is written as both the construction and the class it made one of", () => {
    expect(
      writtenAsOf(
        [
          ["objectValue", "App"],
          ["binds", "AppRef", "App"],
          ["call", "made", "AppRef"],
          ["writtenValue", "made"],
          ["binds", "app", "made"],
        ],
        "app",
      ),
    ).toEqual(["made"]);
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

describe("what a function is annotated as returning", () => {
  // def current_user() -> User: ...; u = current_user(); u.save()
  const annotated: Array<[string, ...string[]]> = [
    ["func", "save"],
    ["objectValue", "User"],
    ["holdsProperty", "User", "save", "save"],
    ["binds", "UserRef", "User"],
    ["func", "currentUser"],
    ["returnsClass", "currentUser", "UserRef"],
    ["binds", "currentUserRef", "currentUser"],
    ["call", "site", "currentUserRef"],
  ];

  it("gives back the class the annotation names", () => {
    expect(resultsOf(annotated, "site")).toEqual(["User"]);
  });

  it("reads a method off the result through the name the call was declared as", () => {
    expect(
      resolutionsOf(
        [
          ...annotated,
          ["binds", "u", "site"],
          ["readsProperty", "callee", "u", "save"],
        ],
        "callee",
      ),
    ).toEqual(["save"]);
  });

  it("gives back nothing when the annotation names something the run has no class for", () => {
    expect(
      resultsOf(
        [
          ["func", "currentUser"],
          ["returnsClass", "currentUser", "RouterRef"],
          ["binds", "currentUserRef", "currentUser"],
          ["call", "site", "currentUserRef"],
        ],
        "site",
      ),
    ).toEqual([]);
  });
});

describe("a call written as what its callee returns", () => {
  // function client() { return construction; }, and construction is
  // itself a call, so it has no comesTo answer of its own.
  const wrapper: Array<[string, ...string[]]> = [
    ["writtenValue", "construction"],
    ["call", "construction", "clsRef"],
    ["func", "client"],
    ["returnsValue", "client", "construction"],
    ["binds", "clientRef", "client"],
    ["call", "site", "clientRef"],
  ];

  it("is written as the construction its callee returns", () => {
    expect(writtenAsOf(wrapper, "site")).toEqual(["construction"]);
  });

  it("comes to nothing", () => {
    expect(resolutionsOf(wrapper, "site")).toEqual([]);
  });

  it("is written as nothing when the callee returns one of its own parameters", () => {
    expect(
      writtenAsOf(
        [
          ["func", "pick"],
          ["paramOf", "pick", "0", "pick#a"],
          ["returnsValue", "pick", "pick#a"],
          ["binds", "pickRef", "pick"],
          ["call", "site", "pickRef"],
        ],
        "site",
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

/**
 * `class ApplicationRecord < ActiveRecord::Base` and `class Account <
 * ApplicationRecord`, with `suspend!` written on Account. The library
 * base is two `extends` hops above the model, which is what a Rails
 * project looks like, and the pack's word is that `find`, `where` and
 * `first` each give back one of the class.
 */
const MODEL_FACTS: Array<[string, ...string[]]> = [
  ["objectValue", "AppRecord"],
  ["extendsNamed", "AppRecord", "ActiveRecord::Base"],
  ["objectValue", "Account"],
  ["extends", "Account", "#AppRecord"],
  ["extendsNamed", "Account", "ApplicationRecord"],
  ["binds", "#AppRecord", "AppRecord"],
  ["binds", "#Account", "Account"],
  ["func", "suspend"],
  ["holdsProperty", "Account", "suspend!", "suspend"],
  ["givesBackOne", "ActiveRecord::Base", "find"],
  ["givesBackOne", "ActiveRecord::Base", "where"],
  ["givesBackOne", "ActiveRecord::Base", "first"],
];

describe("a method a pack says gives back one of the class", () => {
  it("follows a finder on the class object to the class two extends hops below the base", () => {
    // Account.find(id)
    expect(
      objectsOf(
        [
          ...MODEL_FACTS,
          ["readsProperty", "findCallee", "#Account", "find"],
          ["call", "findCall", "findCallee"],
        ],
        "findCall",
      ),
    ).toEqual(["Account"]);
  });

  it("reads a method off what a finder gave back", () => {
    // @account = Account.find(id); @account.suspend!
    expect(
      resolutionsOf(
        [
          ...MODEL_FACTS,
          ["readsProperty", "findCallee", "#Account", "find"],
          ["call", "findCall", "findCallee"],
          ["binds", "account", "findCall"],
          ["readsProperty", "suspendCallee", "account", "suspend!"],
        ],
        "suspendCallee",
      ),
    ).toEqual(["suspend"]);
  });

  it("follows a relation chain one declared method at a time", () => {
    // account = Account.where(x).first; account.suspend!
    expect(
      resolutionsOf(
        [
          ...MODEL_FACTS,
          ["readsProperty", "whereCallee", "#Account", "where"],
          ["call", "whereCall", "whereCallee"],
          ["readsProperty", "firstCallee", "whereCall", "first"],
          ["call", "firstCall", "firstCallee"],
          ["binds", "account", "firstCall"],
          ["readsProperty", "suspendCallee", "account", "suspend!"],
        ],
        "suspendCallee",
      ),
    ).toEqual(["suspend"]);
  });

  it("follows a project method whose own body returns a finder result", () => {
    // def self.by_name(n) = Account.find(name: n); Account.by_name(n).suspend!
    expect(
      resolutionsOf(
        [
          ...MODEL_FACTS,
          ["func", "byName"],
          ["holdsProperty", "Account", "by_name", "byName"],
          ["readsProperty", "findCallee", "#Account", "find"],
          ["call", "findCall", "findCallee"],
          ["returnsValue", "byName", "findCall"],
          ["readsProperty", "byNameCallee", "#Account", "by_name"],
          ["call", "byNameCall", "byNameCallee"],
          ["binds", "account", "byNameCall"],
          ["readsProperty", "suspendCallee", "account", "suspend!"],
        ],
        "suspendCallee",
      ),
    ).toEqual(["suspend"]);
  });

  it("leaves a class on another hierarchy that writes a method of the same name alone", () => {
    // class Registry; def self.find(k); end; end
    expect(
      objectsOf(
        [
          ["objectValue", "Registry"],
          ["binds", "#Registry", "Registry"],
          ["func", "registryFind"],
          ["holdsProperty", "Registry", "find", "registryFind"],
          ["givesBackOne", "ActiveRecord::Base", "find"],
          ["readsProperty", "findCallee", "#Registry", "find"],
          ["call", "findCall", "findCallee"],
        ],
        "findCall",
      ),
    ).toEqual([]);
  });

  it("gives one answer when a class overrides the method and its own body agrees", () => {
    // def self.find(id) = where(id: id).first, written on Account itself.
    expect(
      objectsOf(
        [
          ...MODEL_FACTS,
          ["func", "ownFind"],
          ["holdsProperty", "Account", "find", "ownFind"],
          ["readsProperty", "whereCallee", "#Account", "where"],
          ["call", "whereCall", "whereCallee"],
          ["readsProperty", "firstCallee", "whereCall", "first"],
          ["call", "firstCall", "firstCallee"],
          ["returnsValue", "ownFind", "firstCall"],
          ["readsProperty", "findCallee", "#Account", "find"],
          ["call", "findCall", "findCallee"],
        ],
        "findCall",
      ),
    ).toEqual(["Account"]);
  });

  it("gives both when an override hands back one of another class", () => {
    // The single-answer policy is what refuses the pair; the rules
    // report the declared step and the written method side by side.
    expect(
      objectsOf(
        [
          ...MODEL_FACTS,
          ["objectValue", "Cache"],
          ["func", "ownFind"],
          ["holdsProperty", "Account", "find", "ownFind"],
          ["binds", "cached", "Cache"],
          ["returnsValue", "ownFind", "cached"],
          ["readsProperty", "findCallee", "#Account", "find"],
          ["call", "findCall", "findCallee"],
        ],
        "findCall",
      ),
    ).toEqual(["Account", "Cache"]);
  });
});

/**
 * A second model alongside the one above, and the finder that leaves an
 * Account behind for an association to be read off: `@account =
 * Account.find(id)`.
 */
const ASSOCIATION_FACTS: Array<[string, ...string[]]> = [
  ...MODEL_FACTS,
  ["objectValue", "Status"],
  ["extends", "Status", "#AppRecord"],
  ["binds", "#Status", "Status"],
  ["binds", "statusesTarget", "Status"],
  ["readsProperty", "findCallee", "#Account", "find"],
  ["call", "findCall", "findCallee"],
  ["binds", "account", "findCall"],
  ["readsProperty", "statusesRead", "account", "statuses"],
];

describe("an association a class declares", () => {
  it("settles a read of its name on the class it targets", () => {
    // @account.statuses
    expect(
      objectsOf(
        [
          ...ASSOCIATION_FACTS,
          ["declaresAssociation", "Account", "statuses", "statusesTarget"],
        ],
        "statusesRead",
      ),
    ).toEqual(["Status"]);
  });

  it("is reached through what the model mixes in", () => {
    // module Account::Associations, included by Account
    expect(
      objectsOf(
        [
          ...ASSOCIATION_FACTS,
          ["objectValue", "Associations"],
          ["binds", "#Associations", "Associations"],
          ["extends", "Account", "#Associations"],
          ["declaresAssociation", "Associations", "statuses", "statusesTarget"],
        ],
        "statusesRead",
      ),
    ).toEqual(["Status"]);
  });

  it("composes with a finder on the target", () => {
    // @account.statuses.find(params[:id])
    expect(
      objectsOf(
        [
          ...ASSOCIATION_FACTS,
          ["declaresAssociation", "Account", "statuses", "statusesTarget"],
          ["readsProperty", "statusFindCallee", "statusesRead", "find"],
          ["call", "statusFindCall", "statusFindCallee"],
        ],
        "statusFindCall",
      ),
    ).toEqual(["Status"]);
  });

  it("says nothing about a name no class in the ancestry declares", () => {
    expect(
      objectsOf(
        [
          ...ASSOCIATION_FACTS,
          ["declaresAssociation", "Status", "account", "accountTarget"],
        ],
        "statusesRead",
      ),
    ).toEqual([]);
  });
});

/**
 * The other way an adapter can say a class has one: it read a field
 * given a call, `statuses = relationship("Status")`, and a pack said
 * which callable makes that call an association.
 */
const FIELD_CALL_FACTS: Array<[string, ...string[]]> = [
  ...ASSOCIATION_FACTS,
  ["fieldCall", "Account", "statuses", "#relationship", "statusesTarget"],
  ["imports", "#relationship", "sqlalchemy.orm", "relationship"],
];

describe("an association a pack's own constructor declares", () => {
  it("settles a read of the field on the class the call is about", () => {
    expect(
      objectsOf(
        [
          ...FIELD_CALL_FACTS,
          ["associationConstructor", "sqlalchemy.orm", "relationship"],
        ],
        "statusesRead",
      ),
    ).toEqual(["Status"]);
  });

  it("leaves a field alone when the callable comes from somewhere else", () => {
    // A project function of the same name, imported from the project.
    expect(
      objectsOf(
        [
          ...ASSOCIATION_FACTS,
          ["fieldCall", "Account", "statuses", "#own", "statusesTarget"],
          ["imports", "#own", "app.helpers", "relationship"],
          ["associationConstructor", "sqlalchemy.orm", "relationship"],
        ],
        "statusesRead",
      ),
    ).toEqual([]);
  });

  it("leaves a field alone when no pack declared the callable", () => {
    expect(objectsOf(FIELD_CALL_FACTS, "statusesRead")).toEqual([]);
  });
});

/**
 * `class User(SQLModel, table=True)`, with `deactivate` written on it.
 * The pack's word is that `get`, `query` and `exec` take the class at
 * argument 0, that `select` does the same when it is imported from
 * `sqlmodel`, and that `filter` and `first` give back the same again.
 */
const SQLMODEL_FACTS: Array<[string, ...string[]]> = [
  ["objectValue", "User"],
  ["extendsNamed", "User", "SQLModel"],
  ["binds", "#User", "User"],
  ["func", "deactivate"],
  ["holdsProperty", "User", "deactivate", "deactivate"],
  ["givesBackOneOfArgument", "SQLModel", "get", "0"],
  ["givesBackOneOfArgument", "SQLModel", "query", "0"],
  ["givesBackOneOfArgument", "SQLModel", "exec", "0"],
  ["givesBackOneOfImport", "sqlmodel", "select", "0"],
  ["givesBackOne", "SQLModel", "filter"],
  ["givesBackOne", "SQLModel", "first"],
];

/** `select(User)`, imported from the module the pack named. */
const SELECT_CALL: Array<[string, ...string[]]> = [
  ["imports", "#select", "sqlmodel", "select"],
  ["writtenValue", "selectCall"],
  ["call", "selectCall", "#select"],
  ["callArg", "selectCall", "0", "#User"],
];

describe("a method a pack says gives back one of the class it was passed", () => {
  it("follows a call that takes the class at the declared argument", () => {
    // session.get(User, item_id)
    expect(
      objectsOf(
        [
          ...SQLMODEL_FACTS,
          ["readsProperty", "getCallee", "session", "get"],
          ["call", "getCall", "getCallee"],
          ["callArg", "getCall", "0", "#User"],
          ["callArg", "getCall", "1", "itemId"],
        ],
        "getCall",
      ),
    ).toEqual(["User"]);
  });

  it("reads a method off what such a call gave back", () => {
    // user = session.get(User, item_id); user.deactivate()
    expect(
      resolutionsOf(
        [
          ...SQLMODEL_FACTS,
          ["readsProperty", "getCallee", "session", "get"],
          ["call", "getCall", "getCallee"],
          ["callArg", "getCall", "0", "#User"],
          ["binds", "user", "getCall"],
          ["readsProperty", "deactivateCallee", "user", "deactivate"],
        ],
        "deactivateCallee",
      ),
    ).toEqual(["deactivate"]);
  });

  it("carries on through the chain methods the same pack declared", () => {
    // session.query(User).filter(...).first()
    expect(
      objectsOf(
        [
          ...SQLMODEL_FACTS,
          ["readsProperty", "queryCallee", "session", "query"],
          ["call", "queryCall", "queryCallee"],
          ["callArg", "queryCall", "0", "#User"],
          ["readsProperty", "filterCallee", "queryCall", "filter"],
          ["call", "filterCall", "filterCallee"],
          ["readsProperty", "firstCallee", "filterCall", "first"],
          ["call", "firstCall", "firstCallee"],
        ],
        "firstCall",
      ),
    ).toEqual(["User"]);
  });

  it("says nothing when the argument is no class of the pack's base", () => {
    // config.get("timeout")
    expect(
      objectsOf(
        [
          ...SQLMODEL_FACTS,
          ["objectValue", "config"],
          ["readsProperty", "getCallee", "config", "get"],
          ["call", "getCall", "getCallee"],
          ["callArg", "getCall", "0", "timeoutKey"],
        ],
        "getCall",
      ),
    ).toEqual([]);
  });

  it("reaches the base through a class the project wrote a call to build", () => {
    // Base = declarative_base(); class Model(Base); class Incident(Model)
    expect(
      objectsOf(
        [
          [
            "imports",
            "#declarative_base",
            "sqlalchemy.orm",
            "declarative_base",
          ],
          ["writtenValue", "baseCall"],
          ["call", "baseCall", "#declarative_base"],
          ["binds", "#Base", "baseCall"],
          ["objectValue", "Model"],
          ["extends", "Model", "#Base"],
          ["binds", "#Model", "Model"],
          ["objectValue", "Incident"],
          ["extends", "Incident", "#Model"],
          ["binds", "#Incident", "Incident"],
          ["givesBackOneOfArgument", "declarative_base", "get", "0"],
          ["readsProperty", "getCallee", "session", "get"],
          ["call", "getCall", "getCallee"],
          ["callArg", "getCall", "0", "#Incident"],
        ],
        "getCall",
      ),
    ).toEqual(["Incident"]);
  });
});

describe("a bare function a pack says gives back one of the class it was passed", () => {
  it("follows a call of the function the pack's module exports", () => {
    // select(User)
    expect(
      objectsOf([...SQLMODEL_FACTS, ...SELECT_CALL], "selectCall"),
    ).toEqual(["User"]);
  });

  it("leaves a function of the same name from another module alone", () => {
    expect(
      objectsOf(
        [
          ...SQLMODEL_FACTS,
          ["imports", "#select", "app.helpers", "select"],
          ["writtenValue", "selectCall"],
          ["call", "selectCall", "#select"],
          ["callArg", "selectCall", "0", "#User"],
        ],
        "selectCall",
      ),
    ).toEqual([]);
  });

  it("hands the statement on to the method that runs it, and to the read after that", () => {
    // item = session.exec(select(User)).first(); item.deactivate()
    expect(
      resolutionsOf(
        [
          ...SQLMODEL_FACTS,
          ...SELECT_CALL,
          ["readsProperty", "execCallee", "session", "exec"],
          ["call", "execCall", "execCallee"],
          ["callArg", "execCall", "0", "selectCall"],
          ["readsProperty", "firstCallee", "execCall", "first"],
          ["call", "firstCall", "firstCallee"],
          ["binds", "item", "firstCall"],
          ["readsProperty", "deactivateCallee", "item", "deactivate"],
        ],
        "deactivateCallee",
      ),
    ).toEqual(["deactivate"]);
  });
});

/** `with httpx.Client() as client`, read off a whole-module import. */
const ENTERED_CLIENT: Array<[string, ...string[]]> = [
  ["imports", "#httpx", "httpx", "*"],
  ["readsProperty", "clientCallee", "#httpx", "Client"],
  ["writtenValue", "clientCall"],
  ["call", "clientCall", "clientCallee"],
  ["entersAs", "#client", "clientCall"],
];

describe("a name a block opens over a call", () => {
  it("is the call, when a pack says entering one gives back the object", () => {
    expect(
      writtenAsOf(
        [...ENTERED_CLIENT, ["entersAsSelf", "httpx", "Client"]],
        "#client",
      ),
    ).toEqual(["clientCall"]);
  });

  it("is the call for a constructor imported by name as well", () => {
    expect(
      writtenAsOf(
        [
          ["imports", "#Client", "httpx", "Client"],
          ["writtenValue", "clientCall"],
          ["call", "clientCall", "#Client"],
          ["entersAs", "#client", "clientCall"],
          ["entersAsSelf", "httpx", "Client"],
        ],
        "#client",
      ),
    ).toEqual(["clientCall"]);
  });

  it("is nothing when no pack said what entering the call gives back", () => {
    expect(writtenAsOf(ENTERED_CLIENT, "#client")).toEqual([]);
  });

  it("is nothing when the pack declared a different class of the module", () => {
    expect(
      writtenAsOf(
        [...ENTERED_CLIENT, ["entersAsSelf", "httpx", "AsyncClient"]],
        "#client",
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

  it("reads a member off a whole-module import as that module's export", () => {
    expect(
      originsOf(
        [
          ["imports", "ns", "fastapi", "*"],
          ["readsProperty", "member", "ns", "APIRouter"],
        ],
        "member",
      ),
    ).toEqual(["fastapi:APIRouter"]);
  });

  it("reads a member off a name for a whole-module import", () => {
    expect(
      originsOf(
        [
          ["imports", "ns", "express", "*"],
          ["binds", "local", "ns"],
          ["readsProperty", "member", "local", "Router"],
        ],
        "member",
      ),
    ).toEqual(["express:Router"]);
  });

  it("says nothing about a member read off a named import", () => {
    expect(
      originsOf(
        [
          ["imports", "client", "httpx", "Client"],
          ["readsProperty", "member", "client", "get"],
        ],
        "member",
      ),
    ).toEqual([]);
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

  it("comes to both writes when nothing says which of them ran last", () => {
    expect(
      resolutionsOf(
        [
          ["func", "first"],
          ["func", "second"],
          ["mayHold", "panel", "first"],
          ["mayHold", "panel", "second"],
          ["writesAllStated", "panel"],
        ],
        "panel",
      ),
    ).toEqual(["first", "second"]);
  });

  it("comes to neither write when one of them states no value", () => {
    expect(
      resolutionsOf(
        [
          ["func", "first"],
          ["func", "second"],
          ["mayHold", "panel", "first"],
          ["mayHold", "panel", "second"],
          ["writesUnstated", "panel"],
        ],
        "panel",
      ),
    ).toEqual([]);
  });

  it("carries both writes on through an alias", () => {
    expect(
      resolutionsOf(
        [
          ["func", "first"],
          ["func", "second"],
          ["mayHold", "panel", "first"],
          ["mayHold", "panel", "second"],
          ["writesAllStated", "panel"],
          ["binds", "alias", "panel"],
        ],
        "alias",
      ),
    ).toEqual(["first", "second"]);
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
