import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { joinedPath } from "./compileRequests.js";
import { httpRequests, verbs } from "./httpRequests.js";
import { anyOf, constructedFrom, imported, modulesOf, spelled } from "./ops.js";
import { declarationsIn, pack, requestRecognizersOf } from "./pack.js";

import type {
  AsCallFollowing,
  CallFork,
  CallForks,
  RequestClaim,
  Splats,
  UrlTarget,
} from "@suss/extractor";
import type { HttpRequests } from "./httpRequests.js";
import type { CallOps, ReceiverOrigin, ValueOps } from "./ops.js";

/** A value as a call states it: what it reads as as a URL, per construction site, and what it evaluates to. */
interface Stated {
  readonly url?: UrlTarget;
  readonly bySite?: Readonly<Record<string, UrlTarget>>;
  readonly evaluated?: string | number | boolean;
  readonly properties?: Readonly<Record<string, Stated>>;
  /** Whether it comes to a string, everywhere or per construction site. */
  readonly string?: boolean | Readonly<Record<string, boolean>>;
  /** What it reads as as a host, with a port's value after a colon. */
  readonly host?: string;
  /** The call it was made by, everywhere or under one construction. */
  readonly madeBy?: CallOps;
  readonly madeBySite?: Readonly<Record<string, CallOps>>;
  /** Whether suss reads it as an object it knows every key of. */
  readonly object?: boolean;
  /** The position of the enclosing function's parameter it is. */
  readonly parameter?: number;
}

/** The function a call with `inFunction` set is written in. */
const ENCLOSING = { function: "enclosing" } as unknown as ValueOps;

function valueOps(stated: Stated): ValueOps {
  const made =
    stated.madeBy === undefined && stated.madeBySite === undefined
      ? {}
      : {
          asCall: (how?: AsCallFollowing) =>
            (how !== undefined && "site" in how && how.site !== undefined
              ? stated.madeBySite?.[how.site]
              : undefined) ??
            stated.madeBy ??
            null,
        };
  const ops: Record<string, unknown> = {
    url: (site?: string) =>
      (site === undefined ? undefined : stated.bySite?.[site]) ??
      stated.url ??
      null,
    object: () => (stated.object === true ? ops : null),
    evaluated: () => stated.evaluated ?? null,
    property: (name: string) => {
      const inside = stated.properties?.[name];
      return inside === undefined ? null : valueOps(inside);
    },
    isString: (site?: string) =>
      typeof stated.string === "object"
        ? site !== undefined && stated.string[site] === true
        : stated.string === true,
    host: (port: ValueOps | null) =>
      stated.host === undefined || port === null
        ? stated.host
        : `${stated.host}:${String(port.evaluated?.())}`,
    ...(stated.parameter === undefined
      ? {}
      : {
          parameterNamed: (fn: ValueOps) =>
            fn === ENCLOSING ? `p${stated.parameter}` : null,
        }),
    ...made,
  };
  return ops as unknown as ValueOps;
}

/** A call as a test writes it, and the questions it was asked. */
interface Call {
  readonly method?: string;
  readonly callee?: string;
  /** The export the callee's own import statement binds. */
  readonly imports?: string;
  readonly args?: readonly Stated[];
  readonly keywords?: Readonly<Record<string, Stated>>;
  /** The modules the receiver, or a bare call's callee, came from. */
  readonly from?: readonly string[];
  /** What the import statement and written value of the receiver, or of a bare call's callee, say, when the adapter can say. */
  readonly settled?: boolean;
  readonly sites?: readonly string[];
  readonly receiver?: CallOps;
  /** The receiver as the source writes it. */
  readonly receiverValue?: Stated;
  readonly built?: Readonly<Record<number, CallOps>>;
  readonly writtenAs?: CallOps;
  readonly splats?: Splats;
  /** Whether the call is written in `ENCLOSING`. Left out, the ops cannot say. */
  readonly inFunction?: boolean;
  /** What reading the call's arguments meets under the arms taken. Left out, the ops cannot take arms. */
  readonly forks?: (arms: ReadonlyMap<string, number>) => CallForks;
  /** The arguments under the arms taken, where they differ from `args`. */
  readonly argsUnder?: (
    arms: ReadonlyMap<string, number>,
  ) => readonly Stated[] | undefined;
}

function callOps(
  call: Call,
  asked: string[] = [],
  arms: ReadonlyMap<string, number> = new Map(),
): CallOps {
  const comesFrom = (origin: ReceiverOrigin) =>
    modulesOf(origin).some((module) => (call.from ?? []).includes(module));
  const args = call.argsUnder?.(arms) ?? call.args;
  const { forks } = call;
  const armed =
    forks === undefined
      ? {}
      : {
          forks: () => forks(arms),
          takingArms: (taken: ReadonlyMap<string, number>) =>
            callOps(call, asked, taken),
        };
  return {
    ...armed,
    method: () => call.method ?? null,
    calleeText: () => call.callee ?? `client.${call.method ?? "call"}`,
    calleeImport: () => call.imports ?? null,
    calleeImportedAs: () => call.imports ?? null,
    receiverIsFrom: (origin: ReceiverOrigin) => {
      asked.push(`receiverIsFrom ${origin.origin}`);
      return comesFrom(origin);
    },
    receiverSettledFrom: (origin: ReceiverOrigin) => {
      asked.push(`receiverSettledFrom ${origin.origin}`);
      return call.settled === undefined
        ? undefined
        : call.settled && comesFrom(origin);
    },
    isFrom: (origin: ReceiverOrigin) => {
      asked.push(`isFrom ${origin.origin}`);
      return comesFrom(origin);
    },
    calleeSettledFrom: (origin: ReceiverOrigin) => {
      asked.push(`calleeSettledFrom ${origin.origin}`);
      return call.settled === undefined
        ? undefined
        : call.settled && comesFrom(origin);
    },
    valueAt: (index: number) => {
      const stated = args?.[index];
      return stated === undefined ? null : valueOps(stated);
    },
    keywordAt: (name: string) => {
      const stated = call.keywords?.[name];
      return stated === undefined ? null : valueOps(stated);
    },
    constructionSites: () => call.sites ?? [],
    receiver: () => call.receiver ?? null,
    receiverValue: () =>
      call.receiverValue === undefined ? null : valueOps(call.receiverValue),
    argument: (index: number) => call.built?.[index] ?? null,
    callee: () => call.writtenAs ?? null,
    splats: () => call.splats ?? { positionalFrom: null, keywords: false },
    ...(call.inFunction === undefined
      ? {}
      : { enclosingBody: () => (call.inFunction ? ENCLOSING : null) }),
  } as unknown as CallOps;
}

function at(path: string | undefined, host?: string): Stated {
  return { url: { path, host } };
}

const URL_FIRST = { at: 0, keyword: "url" };

const CLIENT = anyOf(
  imported({ from: ["httplib"], named: ["*", "get", "post", "request"] }),
  constructedFrom({ from: ["httplib"], named: ["Session"] }),
);

const REQUESTS = httpRequests({ client: CLIENT })
  .methods({
    ...verbs({ get: "GET", post: "POST" }, URL_FIRST),
    head: { sends: "HEAD", url: URL_FIRST, redirects: "response" },
    request: {
      sends: { from: { at: 0, keyword: "method" } },
      url: { at: 1, keyword: "url" },
    },
  })
  .response({
    statusCode: ["status_code"],
    redirectDelivery: "followed",
    redirectOption: { name: "follow", handsBack: [false] },
  })
  .example('httplib.get("/orders")');

/** What the chain's hook reads at the call, every claim whole. */
function readClaimsOf(
  chain: HttpRequests,
  call: Call,
  asked: string[] = [],
): readonly RequestClaim[] | null {
  const [hook] =
    pack("httplib", [chain], {
      languages: ["python"],
      recognizedAs: "httplib",
    }).requestRecognizers ?? [];
  if (hook === undefined) {
    throw new Error("the pack compiled no request hook");
  }
  return hook(null, { ops: callOps(call, asked) });
}

/** The requests the chain's hook reads at the call, without where it read each or which construction it read it under. */
function claimsOf(
  chain: HttpRequests,
  call: Call,
  asked: string[] = [],
): readonly Omit<RequestClaim, "read" | "site">[] | null {
  return (
    readClaimsOf(chain, call, asked)?.map(
      ({ read: _read, site: _site, ...claim }) => claim,
    ) ?? null
  );
}

describe("a request chain", () => {
  it("reads a verb called on the module the client imports", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at("/orders")],
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: undefined }]);
  });

  it("asks nothing about the receiver of a method the table does not list", () => {
    const asked: string[] = [];
    expect(
      claimsOf(
        REQUESTS,
        { method: "items", from: ["httplib"], args: [at("/x")] },
        asked,
      ),
    ).toBeNull();
    expect(asked).toEqual([]);
  });

  it("asks what the receiver's import statement and written value say before the rules", () => {
    const asked: string[] = [];
    expect(
      claimsOf(
        REQUESTS,
        { method: "get", settled: false, args: [at("/x")] },
        asked,
      ),
    ).toBeNull();
    expect(asked).toEqual([
      "receiverSettledFrom imported",
      "receiverSettledFrom constructed",
    ]);
  });

  it("asks the rules only about an origin the receiver's own statements leave open", () => {
    const asked: string[] = [];
    claimsOf(REQUESTS, { method: "get", args: [at("/x")] }, asked);
    expect(asked).toEqual([
      "receiverSettledFrom imported",
      "receiverSettledFrom constructed",
      "receiverIsFrom imported",
      "receiverIsFrom constructed",
    ]);
  });

  it("asks nothing more once the receiver's own statements say yes", () => {
    const asked: string[] = [];
    expect(
      claimsOf(
        REQUESTS,
        {
          method: "get",
          from: ["httplib"],
          settled: true,
          args: [at("/x")],
        },
        asked,
      ),
    ).toEqual([{ method: "GET", path: "/x", host: undefined }]);
    expect(asked).toEqual(["receiverSettledFrom imported"]);
  });

  it("produces no effect where an invocation walk runs it", () => {
    const ops = callOps({ method: "get", from: ["httplib"], args: [at("/x")] });
    expect(compile(REQUESTS.declared, "httplib")(null, { ops })).toBeNull();
  });

  it("needs the client its calls are made on", () => {
    expect(() =>
      requestRecognizersOf([{ declared: { ...REQUESTS.declared, links: [] } }]),
    ).toThrow("a request chain needs the client its calls are made on");
  });

  it("reads a bare call by the export its import statement binds", () => {
    expect(
      claimsOf(REQUESTS, {
        callee: "fetch_it",
        imports: "post",
        from: ["httplib"],
        args: [at("/orders")],
      }),
    ).toEqual([{ method: "POST", path: "/orders", host: undefined }]);
  });

  it("asks nothing about a bare call whose name the table does not list", () => {
    const asked: string[] = [];
    expect(
      claimsOf(
        REQUESTS,
        { callee: "len", from: ["httplib"], args: [at("/x")] },
        asked,
      ),
    ).toBeNull();
    expect(asked).toEqual([]);
  });

  it("reads the method an argument states, upper-cased, and the URL after it", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "request",
        from: ["httplib"],
        args: [{ evaluated: "delete" }],
        keywords: { url: at("/orders/{id}") },
      }),
    ).toEqual([{ method: "DELETE", path: "/orders/{id}", host: undefined }]);
  });

  it("reads a URL a splat fills as a URL suss cannot read", () => {
    const withSplats = (splats: Splats) =>
      claimsOf(REQUESTS, {
        method: "request",
        from: ["httplib"],
        args: [{ evaluated: "get" }],
        splats,
      });
    const unread = [{ method: "GET", path: null, host: undefined }];
    expect(withSplats({ positionalFrom: 1, keywords: false })).toEqual(unread);
    expect(withSplats({ positionalFrom: null, keywords: true })).toEqual(
      unread,
    );
    expect(withSplats({ positionalFrom: 2, keywords: false })).toEqual([]);
  });

  it("makes no request when the method an argument states does not settle", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "request",
        from: ["httplib"],
        args: [{}, at("/orders")],
        inFunction: true,
      }),
    ).toEqual([]);
  });

  it("makes no request when the call states no method and the library has none to fall back on", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "request",
        from: ["httplib"],
        keywords: { url: at("/orders") },
      }),
    ).toEqual([]);
  });

  it("hands back the method's value and no host for a host passed apart from the path", () => {
    const sendTo = httpRequests({ client: CLIENT }).methods({
      send_to: {
        sends: { from: { at: 2 } },
        url: {
          at: 0,
          hostFirst: { host: { at: 0 }, path: { at: 1 } },
        },
      },
    });
    const [claim] =
      readClaimsOf(sendTo, {
        method: "send_to",
        from: ["httplib"],
        args: [
          { ...at("api.example.com"), host: "api.example.com" },
          { ...at("/orders"), string: true },
          { parameter: 0 },
        ],
        inFunction: true,
      }) ?? [];

    expect(claim?.method).toBeNull();
    expect(claim?.read.stated?.method).toBeDefined();
    expect(claim?.read.stated?.host).toBeUndefined();
  });

  it("sends the library's default when a call passes no method argument, and splits nothing on it", () => {
    const withDefault = httpRequests({ client: CLIENT }).methods({
      request: {
        sends: { from: { at: 0, keyword: "method" }, default: "get" },
        url: { at: 1, keyword: "url" },
      },
    });
    expect(
      claimsOf(withDefault, {
        method: "request",
        from: ["httplib"],
        keywords: { url: at("/orders") },
        forks: () => ({ forks: [], reached: true, exhausted: false }),
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: undefined }]);
  });

  it("keeps a request with no method when the method is a parameter of the function the call is in", () => {
    const [claim] =
      readClaimsOf(REQUESTS, {
        method: "request",
        from: ["httplib"],
        args: [{ parameter: 1 }, at("/orders", "api.example.com")],
        inFunction: true,
      }) ?? [];

    expect(claim?.method).toBeNull();
    expect(claim?.path).toBe("/orders");
    expect(claim?.read.stated?.method?.parameterNamed?.(ENCLOSING)).toBe("p1");
    expect(claim?.read.stated?.host?.within).toBe("url");
  });

  it("keeps a URL suss cannot read as a request with no path", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at("{base}{path}")],
      }),
    ).toEqual([{ method: "GET", path: null, host: undefined }]);
  });

  it("keeps a path of holes under a host suss read", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at("/{kid}", "keys.example.com")],
      }),
    ).toEqual([{ method: "GET", path: "/{kid}", host: "keys.example.com" }]);
  });

  it("reads a redirect option the call passes, and the method's own otherwise", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at("/a")],
        keywords: { follow: { evaluated: false } },
      }),
    ).toEqual([
      {
        method: "GET",
        path: "/a",
        host: undefined,
        redirectDelivery: "response",
      },
    ]);
    expect(
      claimsOf(REQUESTS, {
        method: "head",
        from: ["httplib"],
        args: [at("/a")],
      }),
    ).toEqual([
      {
        method: "HEAD",
        path: "/a",
        host: undefined,
        redirectDelivery: "response",
      },
    ]);
  });

  it("gives one request per construction when the call's own URL has a hole", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        sites: ["a", "b", "c"],
        args: [
          {
            url: { path: "{base}/orders", host: undefined },
            bySite: {
              a: { path: "/v1/orders", host: undefined },
              b: { path: "/v2/orders", host: undefined },
              c: { path: "/v1/orders", host: undefined },
            },
          },
        ],
      }),
    ).toEqual([
      { method: "GET", path: "/v1/orders", host: undefined },
      { method: "GET", path: "/v2/orders", host: undefined },
    ]);
  });

  it("leaves out a construction whose URL says nothing, when another one does", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        sites: ["a", "b"],
        args: [
          {
            url: { path: "{base}/orders", host: undefined },
            bySite: {
              a: { path: "{base}", host: undefined },
              b: { path: "/v1/orders", host: undefined },
            },
          },
        ],
      }),
    ).toEqual([{ method: "GET", path: "/v1/orders", host: undefined }]);
  });

  it("keeps the call's own reading when no construction says where it goes", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        sites: ["a"],
        args: [{ url: { path: "{base}/orders", host: undefined } }],
      }),
    ).toEqual([{ method: "GET", path: "{base}/orders", host: undefined }]);
  });

  it("hands the adapter what a caller can read off the response", () => {
    const [hook] =
      pack("httplib", [REQUESTS], {
        languages: ["python"],
        recognizedAs: "httplib",
      }).requestRecognizers ?? [];
    expect(hook?.response).toEqual({
      statusCode: ["status_code"],
      redirectDelivery: "followed",
      redirectOption: { name: "follow", handsBack: [false] },
    });
  });

  it("gates on no import for a client read by the name it is written with", () => {
    const fetched = httpRequests({ client: spelled("fetch") })
      .methods({ fetch: { sends: "GET", url: { at: 0 } } })
      .example('fetch("/orders")');
    expect(modulesOf(spelled("fetch"))).toEqual([]);
    expect(
      pack("fetching", [fetched], {
        languages: ["typescript"],
        recognizedAs: "fetching",
      }).requiresImport,
    ).toEqual([]);
  });

  it("is reported to the pack health report as data, with its example", () => {
    expect(declarationsIn([REQUESTS]).declarations).toEqual([
      {
        name: "httpRequest",
        dataLinks: 2,
        functionLinks: [],
        astLinks: [],
        example: 'httplib.get("/orders")',
      },
    ]);
  });
});

describe("a client called as a function", () => {
  const FETCH_CALL = {
    sends: { from: { at: 1, property: ["method"] }, default: "GET" },
    url: { at: 0 },
  };
  const FETCH = httpRequests({ client: imported({ from: ["httplib"] }) })
    .methods({ fetch: FETCH_CALL })
    .calls(FETCH_CALL);

  it("sends the default when the options state no method", () => {
    expect(
      claimsOf(FETCH, {
        callee: "fetch",
        from: ["httplib"],
        args: [at("/orders")],
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: undefined }]);
  });

  it("reads the method off the options it is passed", () => {
    expect(
      claimsOf(FETCH, {
        callee: "fetch",
        from: ["httplib"],
        args: [
          at("/orders"),
          { properties: { method: { evaluated: "post" } } },
        ],
      }),
    ).toEqual([{ method: "POST", path: "/orders", host: undefined }]);
  });

  it("reads a name written as a call the client made as the client", () => {
    expect(
      claimsOf(FETCH, {
        callee: "api",
        args: [at("/orders")],
        writtenAs: callOps({ method: "create", from: ["httplib"] }),
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: undefined }]);
  });

  it("asks the rules nothing about a callee its own import statement settles", () => {
    const asked: string[] = [];
    expect(
      claimsOf(
        FETCH,
        { callee: "helper", settled: false, args: [at("/orders")] },
        asked,
      ),
    ).toBeNull();
    expect(asked).toEqual(["calleeSettledFrom imported"]);
  });

  it("settles each origin of a client inside another before asking the rules about an open one", () => {
    const nested = httpRequests({
      client: anyOf(
        anyOf(
          imported({ from: ["httplib"] }),
          constructedFrom({ from: ["httplib"], named: ["Session"] }),
        ),
      ),
    }).calls(FETCH_CALL);
    const asked: string[] = [];
    expect(
      claimsOf(
        nested,
        { callee: "helper", settled: false, args: [at("/orders")] },
        asked,
      ),
    ).toBeNull();
    expect(asked).toEqual(["calleeSettledFrom imported", "isFrom constructed"]);
  });
});

describe("a request object", () => {
  const OBJECTS = httpRequests({
    client: imported({ from: ["httplib"] }),
  }).methods({
    request: {
      sends: {
        object: 0,
        classes: { "Http::Get": "GET", "Http::Post": "POST" },
        url: { at: 0 },
      },
    },
  });

  it("states the method by its class and the URL as its argument", () => {
    expect(
      claimsOf(OBJECTS, {
        method: "request",
        from: ["httplib"],
        built: {
          0: callOps({
            method: "new",
            callee: "Http::Post.new",
            args: [at("/orders")],
          }),
        },
      }),
    ).toEqual([{ method: "POST", path: "/orders", host: undefined }]);
  });

  it("makes no request from a class the table does not list", () => {
    expect(
      claimsOf(OBJECTS, {
        method: "request",
        from: ["httplib"],
        built: {
          0: callOps({
            method: "new",
            callee: "Http::Trace.new",
            args: [at("/orders")],
          }),
        },
      }),
    ).toEqual([]);
  });

  it("reads the construction the value the call passes was made by", () => {
    expect(
      claimsOf(OBJECTS, {
        method: "request",
        from: ["httplib"],
        args: [
          {
            madeBy: callOps({
              method: "new",
              callee: "Http::Get.new",
              args: [at("/orders")],
            }),
          },
        ],
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: undefined }]);
  });

  it("reads the request object each construction of the class was handed", () => {
    const made = (callee: string, path: string) =>
      callOps({ method: "new", callee, args: [at(path)] });
    expect(
      claimsOf(OBJECTS, {
        method: "request",
        from: ["httplib"],
        sites: ["users", "orders"],
        args: [
          {
            madeBySite: {
              users: made("Http::Get.new", "/users"),
              orders: made("Http::Post.new", "/orders"),
            },
          },
        ],
      }),
    ).toEqual([
      { method: "GET", path: "/users", host: undefined },
      { method: "POST", path: "/orders", host: undefined },
    ]);
  });

  it("is not read off a call other than a construction", () => {
    expect(
      claimsOf(OBJECTS, {
        method: "request",
        from: ["httplib"],
        built: {
          0: callOps({
            method: "build",
            callee: "Http::Post.build",
            args: [at("/orders")],
          }),
        },
      }),
    ).toEqual([]);
  });
});

describe("a base URL the client was built with", () => {
  const built = (base: UrlTarget) =>
    callOps({ method: "new", args: [{ url: base }] });

  function joined(
    joins: "appended" | "resolved" | "asWritten",
    path: string,
    base = "/v1",
  ) {
    const chain = httpRequests({ client: imported({ from: ["httplib"] }) })
      .methods(verbs({ get: "GET" }, { at: 0 }))
      .baseUrl({ at: 0, joins });
    return claimsOf(chain, {
      method: "get",
      from: ["httplib"],
      args: [at(path)],
      receiver: built({ path: base, host: "api.example.com" }),
    });
  }

  it("appends a path, with one slash between, for a library that appends", () => {
    expect(joined("appended", "orders")).toEqual([
      { method: "GET", path: "/v1/orders", host: "api.example.com" },
    ]);
    expect(joined("appended", "/orders")).toEqual([
      { method: "GET", path: "/v1/orders", host: "api.example.com" },
    ]);
  });

  it("adds nothing for a base of a slash alone", () => {
    expect(joined("appended", "/orders", "/")).toEqual([
      { method: "GET", path: "/orders", host: "api.example.com" },
    ]);
  });

  it("keeps the trailing slash a path that ends at a parent segment resolves to", () => {
    expect(joined("resolved", "orders/..", "/v1/")).toEqual([
      { method: "GET", path: "/v1/", host: "api.example.com" },
    ]);
  });

  it("resolves a path against the base for a library that resolves", () => {
    expect(joined("resolved", "orders")).toEqual([
      { method: "GET", path: "/v1/orders", host: "api.example.com" },
    ]);
    expect(joined("resolved", "/orders")).toEqual([
      { method: "GET", path: "/orders", host: "api.example.com" },
    ]);
    expect(joined("resolved", "../orders")).toEqual([
      { method: "GET", path: "/orders", host: "api.example.com" },
    ]);
  });

  it("goes to an absolute URL the call states, and not under the base", () => {
    const chain = httpRequests({ client: imported({ from: ["httplib"] }) })
      .methods(verbs({ get: "GET" }, { at: 0 }))
      .baseUrl({ at: 0, joins: "appended" });
    expect(
      claimsOf(chain, {
        method: "get",
        from: ["httplib"],
        args: [at("/orders", "other.example.com")],
        receiver: built({ path: "/v1", host: "api.example.com" }),
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: "other.example.com" }]);
  });

  it("keeps a hole at the front of the base in front of the resolved path", () => {
    const chain = httpRequests({ client: imported({ from: ["httplib"] }) })
      .methods(verbs({ get: "GET" }, { at: 0 }))
      .baseUrl({ at: 0, joins: "resolved" });
    expect(
      claimsOf(chain, {
        method: "get",
        from: ["httplib"],
        args: [at("/orders")],
        receiver: built({ path: "{base}/v1", host: undefined }),
      }),
    ).toEqual([{ method: "GET", path: "{base}/orders", host: undefined }]);
  });

  it("reads no base the library refuses for a path with no trailing slash", () => {
    const chain = httpRequests({ client: imported({ from: ["httplib"] }) })
      .methods(verbs({ get: "GET" }, { at: 0 }))
      .baseUrl({ at: 0, joins: "resolved", trailingSlash: "required" });
    const under = (path: string) =>
      claimsOf(chain, {
        method: "get",
        from: ["httplib"],
        args: [at("/orders")],
        receiver: built({ path, host: "api.example.com" }),
      });

    expect(under("/v1")).toEqual([
      { method: "GET", path: "/orders", host: undefined },
    ]);
    expect(under("/v1/{version}")).toEqual([
      { method: "GET", path: "/orders", host: undefined },
    ]);
    expect(under("/v1/")).toEqual([
      { method: "GET", path: "/orders", host: "api.example.com" },
    ]);
    expect(under("")).toEqual([
      { method: "GET", path: "/orders", host: "api.example.com" },
    ]);
  });

  it("sends an empty path to the base, with the slash a library adds", () => {
    const sent = (base: string | undefined, trailingSlash?: "added") => {
      const chain = httpRequests({ client: imported({ from: ["httplib"] }) })
        .methods(verbs({ get: "GET" }, { at: 0 }))
        .baseUrl({
          at: 0,
          joins: "appended",
          ...(trailingSlash === undefined ? {} : { trailingSlash }),
        });
      return claimsOf(chain, {
        method: "get",
        from: ["httplib"],
        args: [{ url: { path: "", host: undefined }, evaluated: "" }],
        receiver: built({ path: base, host: "api.example.com" }),
      });
    };

    expect(sent("/v1")).toEqual([
      { method: "GET", path: "/v1", host: "api.example.com" },
    ]);
    expect(sent("/v1", "added")).toEqual([
      { method: "GET", path: "/v1/", host: "api.example.com" },
    ]);
    expect(sent("")).toEqual([
      { method: "GET", path: "/", host: "api.example.com" },
    ]);
    expect(sent(undefined)).toEqual([
      { method: "GET", path: null, host: "api.example.com" },
    ]);
  });

  it("keeps a hole at the front of a path appended under a base with no path", () => {
    expect(joined("appended", "{base}/orders", "")).toEqual([
      { method: "GET", path: "{base}/orders", host: "api.example.com" },
    ]);
  });

  it("removes dot segments after appending, behind a hole at the front too", () => {
    expect(joined("appended", "/v2/../orders")).toEqual([
      { method: "GET", path: "/v1/orders", host: "api.example.com" },
    ]);
    expect(joined("appended", "{base}/../orders", "")).toEqual([
      { method: "GET", path: "{base}/orders", host: "api.example.com" },
    ]);
  });

  it("sends the path as written, dot segments and all, for a library that sends it as the request target", () => {
    expect(joined("asWritten", "/v2/../orders", "")).toEqual([
      { method: "GET", path: "/v2/../orders", host: "api.example.com" },
    ]);
  });

  it("keeps a URL that starts with // under the base for a library that reads it as a path", () => {
    const chain = httpRequests({ client: imported({ from: ["httplib"] }) })
      .methods(verbs({ get: "GET" }, { at: 0 }))
      .baseUrl({ at: 0, joins: "resolved", schemeRelative: "path" });
    const sent = (written: string, base: string) =>
      claimsOf(chain, {
        method: "get",
        from: ["httplib"],
        args: [
          {
            url: { path: "/orders", host: "other.example.com" },
            evaluated: written,
          },
        ],
        receiver: built({ path: base, host: "api.example.com" }),
      });

    expect(sent("//other.example.com/orders?page=2", "/v1")).toEqual([
      {
        method: "GET",
        path: "/v1///other.example.com/orders",
        host: "api.example.com",
      },
    ]);
    expect(sent("//other.example.com/orders", "/v1/")).toEqual([
      {
        method: "GET",
        path: "/v1///other.example.com/orders",
        host: "api.example.com",
      },
    ]);
    expect(sent("https://other.example.com/orders", "/v1")).toEqual([
      { method: "GET", path: "/orders", host: "other.example.com" },
    ]);
  });

  it("joins a path under a base the way the library does, for an adapter reading the call again", () => {
    expect(joinedPath("appended", "/v1/", "orders")).toBe("/v1/orders");
    expect(joinedPath("resolved", "/v1/", "../orders")).toBe("/orders");
  });

  it("reads the base off the construction the receiver was made by", () => {
    const chain = httpRequests({ client: imported({ from: ["httplib"] }) })
      .methods(verbs({ get: "GET" }, { at: 0 }))
      .baseUrl({ at: 0, joins: "resolved" });
    expect(
      claimsOf(chain, {
        method: "get",
        from: ["httplib"],
        args: [at("orders")],
        receiver: callOps({ method: "conn" }),
        receiverValue: {
          madeBy: built({ path: "/v2", host: "api.example.com" }),
        },
      }),
    ).toEqual([{ method: "GET", path: "/v2/orders", host: "api.example.com" }]);
  });
});

describe("a host passed apart from the path", () => {
  const HOST_FIRST = {
    at: 0,
    hostFirst: { host: { at: 0 }, path: { at: 1 }, port: { at: 2 } },
  };
  const MODULE = httpRequests({ client: imported({ from: ["httplib"] }) })
    .methods(verbs({ get: "GET" }, HOST_FIRST))
    .baseUrl({ at: 0, reads: "host", port: { at: 1 }, joins: "resolved" });

  it("reads the host, the path and the port when the path argument is a string", () => {
    expect(
      claimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        args: [
          { ...at("api.example.com"), host: "api.example.com" },
          { ...at("/orders"), string: true },
          { evaluated: 8080 },
        ],
      }),
    ).toEqual([
      { method: "GET", path: "/orders", host: "api.example.com:8080" },
    ]);
  });

  it("reads the first argument as the URL when the second is not a string", () => {
    expect(
      claimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        args: [at("/orders", "api.example.com"), { string: false }],
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: "api.example.com" }]);
  });

  it("decides the form under each construction", () => {
    expect(
      claimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        sites: ["a", "b"],
        args: [
          {
            ...at("{base}"),
            host: "keys.example.com",
            bySite: { b: { path: "/b", host: "other.example.com" } },
          },
          { ...at("/a"), string: { a: true } },
        ],
      }),
    ).toEqual([
      { method: "GET", path: "/a", host: "keys.example.com" },
      { method: "GET", path: "/b", host: "other.example.com" },
    ]);
  });

  it("sends a call on a client built on a host to that host, with its own path", () => {
    expect(
      claimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        args: [at("orders")],
        receiver: callOps({
          method: "new",
          args: [{ host: "api.example.com" }, { evaluated: 8443 }],
        }),
      }),
    ).toEqual([
      { method: "GET", path: "/orders", host: "api.example.com:8443" },
    ]);
  });

  it("hands back the construction's host argument as the value the host came from", () => {
    const host = { host: "api.example.com", parameter: 0 };
    const [claim] =
      readClaimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        args: [at("/orders")],
        receiver: callOps({ method: "new", args: [host] }),
      }) ?? [];

    expect(claim?.read.stated?.host?.within).toBe("host");
    expect(claim?.read.stated?.host?.value.host?.(null)).toBe(
      "api.example.com",
    );
    expect(claim?.read.stated?.method).toBeUndefined();
  });

  it("hands back no host value for a host passed apart from the path", () => {
    const [claim] =
      readClaimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        args: [
          { ...at("api.example.com"), host: "api.example.com" },
          { ...at("/orders"), string: true },
        ],
      }) ?? [];

    expect(claim?.read.stated).toBeUndefined();
  });

  it("goes to the host of a full URL passed as the path", () => {
    expect(
      claimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        args: [
          { ...at("api.example.com"), host: "api.example.com" },
          { ...at("/orders", "other.example.com"), string: true },
        ],
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: "other.example.com" }]);
  });

  it("leaves out a path that does not start with a slash, which is no request target", () => {
    expect(
      claimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        args: [
          { ...at("api.example.com"), host: "api.example.com" },
          { ...at("orders"), string: true },
        ],
      }),
    ).toEqual([{ method: "GET", path: null, host: "api.example.com" }]);

    const asWritten = httpRequests({ client: imported({ from: ["httplib"] }) })
      .methods(verbs({ get: "GET" }, { at: 0 }))
      .baseUrl({ at: 0, reads: "host", joins: "asWritten" });
    expect(
      claimsOf(asWritten, {
        method: "get",
        from: ["httplib"],
        args: [at("orders")],
        receiver: callOps({
          method: "new",
          args: [{ host: "api.example.com" }],
        }),
      }),
    ).toEqual([{ method: "GET", path: null, host: "api.example.com" }]);
  });

  it("leaves out a host written as a URL, which no connection can be opened to", () => {
    expect(
      claimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        args: [
          { host: "https", evaluated: "https://api.example.com" },
          { ...at("/orders"), string: true },
        ],
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: undefined }]);
    expect(
      claimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        args: [at("/orders")],
        receiver: callOps({
          method: "new",
          args: [{ host: "api.example.com", evaluated: "api.example.com/" }],
        }),
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: undefined }]);
  });

  it("takes no base from a construction that states no host", () => {
    expect(
      claimsOf(MODULE, {
        method: "get",
        from: ["httplib"],
        args: [at("/orders")],
        receiver: callOps({ method: "new", args: [{}] }),
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: undefined }]);
  });
});

// A client whose verbs take an options object after the URL, and whose
// config call takes the URL, the method and the options in one object,
// as axios and fetch do.
const CONFIG_CALL = {
  sends: { from: { at: 0, property: ["method"] }, default: "GET" },
  url: { at: 0, property: ["url"] },
  options: { at: 0 },
} as const;

const CONFIGURED = httpRequests({
  client: anyOf(
    imported({ from: ["confhttp"], named: ["default"] }),
    constructedFrom("confhttp"),
  ),
})
  .methods({
    get: { sends: "GET", url: { at: 0 }, options: { at: 1 } },
    request: CONFIG_CALL,
  })
  .calls(CONFIG_CALL)
  .baseUrl({ at: 0, property: ["baseURL"], joins: "appended" })
  .response({
    redirectDelivery: "followed",
    redirectOption: { name: "maxRedirects", handsBack: [0] },
  });

/** A construction of the client with this config object. */
function builtWith(config: Readonly<Record<string, Stated>>): Stated {
  return {
    madeBy: callOps({
      method: "create",
      args: [{ properties: config, object: true }],
    }),
  };
}

describe("a request chain over options objects", () => {
  it("sends the default when the method the call states does not settle", () => {
    expect(
      claimsOf(CONFIGURED, {
        method: "request",
        from: ["confhttp"],
        args: [{ properties: { url: at("/orders"), method: {} } }],
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: undefined }]);
  });

  it("keeps a call whose object suss cannot read the URL off as a request with no path", () => {
    expect(
      claimsOf(CONFIGURED, {
        callee: "api",
        from: ["confhttp"],
        args: [{}],
      }),
    ).toEqual([{ method: "GET", path: null, host: undefined }]);
    expect(
      claimsOf(CONFIGURED, { callee: "api", from: ["confhttp"], args: [] }),
    ).toEqual([]);
  });

  it("reads the redirect option off the options the call passes", () => {
    expect(
      claimsOf(CONFIGURED, {
        method: "get",
        from: ["confhttp"],
        args: [
          at("/orders"),
          { properties: { maxRedirects: { evaluated: 0 } }, object: true },
        ],
      }),
    ).toEqual([
      {
        method: "GET",
        path: "/orders",
        host: undefined,
        redirectDelivery: "response",
      },
    ]);
  });

  it("reads the option off the client's construction when the call leaves it out", () => {
    const call = {
      method: "get",
      from: ["confhttp"],
      receiverValue: builtWith({ maxRedirects: { evaluated: 0 } }),
    };
    expect(
      claimsOf(CONFIGURED, {
        ...call,
        args: [at("/orders"), { properties: {}, object: true }],
      })?.[0]?.redirectDelivery,
    ).toBe("response");
    // Options suss cannot read could set the option themselves.
    expect(
      claimsOf(CONFIGURED, { ...call, args: [at("/orders"), {}] })?.[0]
        ?.redirectDelivery,
    ).toBeUndefined();
  });

  it("says where the call states its URL, its method and its options, and the base apart", () => {
    const [claim] =
      readClaimsOf(CONFIGURED, {
        method: "get",
        from: ["confhttp"],
        args: [at("/orders")],
        receiverValue: builtWith({ baseURL: at("/api") }),
      }) ?? [];

    expect(claim?.path).toBe("/api/orders");
    expect(claim?.read).toEqual({
      entry: "get",
      url: { at: 0 },
      method: "GET",
      options: { at: 1 },
      base: { path: "/api", host: undefined, joins: "appended" },
      stated: { host: { value: expect.anything(), within: "url" } },
    });
  });

  it("hands back the value the method came from, and the construction's URL a relative path goes under", () => {
    const method = { evaluated: "post" };
    const baseURL = at("https://api.example.com");
    const [claim] =
      readClaimsOf(CONFIGURED, {
        callee: "api",
        from: ["confhttp"],
        args: [{ properties: { url: at("/orders"), method } }],
        writtenAs: callOps({
          callee: "confhttp.create",
          args: [{ properties: { baseURL } }],
        }),
      }) ?? [];

    expect(claim?.method).toBe("POST");
    expect(claim?.read.stated?.method?.evaluated?.()).toBe("post");
    expect(claim?.read.stated?.host?.within).toBe("url");
    expect(claim?.read.stated?.host?.value.url?.()).toEqual(baseURL.url);
  });

  it("reads a call of the client itself as the entry with the same meaning", () => {
    const [claim] =
      readClaimsOf(CONFIGURED, {
        callee: "api",
        from: ["confhttp"],
        args: [{ properties: { url: at("/orders") } }],
      }) ?? [];

    expect(claim?.read).toMatchObject({
      entry: "request",
      url: { at: 0, property: ["url"] },
      method: { at: { at: 0, property: ["method"] }, default: "GET" },
    });
  });

  it("says which construction a request was read under", () => {
    expect(
      readClaimsOf(CONFIGURED, {
        method: "get",
        from: ["confhttp"],
        sites: ["users", "orders"],
        args: [
          {
            url: { path: "{base}", host: undefined },
            bySite: {
              users: { path: "/users", host: undefined },
              orders: { path: "/orders", host: undefined },
            },
          },
        ],
      })?.map((claim) => [claim.site, claim.path]),
    ).toEqual([
      ["users", "/users"],
      ["orders", "/orders"],
    ]);
  });

  it("lists the table's entries in the order the pack wrote them", () => {
    expect(requestRecognizersOf([CONFIGURED])[0]?.entries).toEqual([
      "get",
      "request",
    ]);
  });

  it("makes no request for a URL the client reads without one", () => {
    expect(
      claimsOf(CONFIGURED, {
        method: "get",
        from: ["confhttp"],
        args: [{ url: { path: undefined, host: undefined, local: true } }],
      }),
    ).toEqual([]);
  });

  it("leaves out the path of a base with a hole, and keeps its host", () => {
    expect(
      claimsOf(CONFIGURED, {
        method: "get",
        from: ["confhttp"],
        args: [at("/orders")],
        receiverValue: builtWith({
          baseURL: at("{env}/v1", "api.example.com"),
        }),
      }),
    ).toEqual([{ method: "GET", path: "/orders", host: "api.example.com" }]);
  });
});

describe("a request a branch before the call picks", () => {
  const forkOf = (key: string, extra: Partial<CallFork> = {}): CallFork => ({
    key,
    at: `fork:${key}`,
    arms: 2,
    negated: false,
    under: null,
    ...extra,
  });
  const meeting = (
    forks: readonly CallFork[],
    extra: Partial<CallForks> = {},
  ): CallForks => ({ forks, reached: true, exhausted: false, ...extra });
  /** The forks a run meets: each listed fork until its key is taken. */
  const openForks =
    (...forks: CallFork[]) =>
    (arms: ReadonlyMap<string, number>) =>
      meeting(forks.filter((fork) => !arms.has(fork.key)));
  const urlBy =
    (pick: (arms: ReadonlyMap<string, number>) => string | undefined) =>
    (arms: ReadonlyMap<string, number>) => [at(pick(arms))];
  const byId = urlBy((arms) =>
    arms.has("id") ? ["/x/{id}", "/x"][arms.get("id") ?? 0] : undefined,
  );

  it("gives one request per URL the arms of a fork pick, each under its arm", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at(undefined)],
        forks: openForks(forkOf("id")),
        argsUnder: byId,
      }),
    ).toEqual([
      {
        method: "GET",
        path: "/x/{id}",
        host: undefined,
        arms: [{ at: "fork:id", arm: 0 }],
      },
      {
        method: "GET",
        path: "/x",
        host: undefined,
        arms: [{ at: "fork:id", arm: 1 }],
      },
    ]);
  });

  it("gives one request per method the arms pick, and drops the value it was stated as", () => {
    const claims =
      readClaimsOf(REQUESTS, {
        method: "request",
        from: ["httplib"],
        args: [{}, at("/widgets")],
        forks: openForks(forkOf("on")),
        argsUnder: (arms) =>
          arms.has("on")
            ? [
                { evaluated: arms.get("on") === 0 ? "put" : "delete" },
                at("/widgets"),
              ]
            : undefined,
      }) ?? [];

    expect(claims.map((claim) => claim.method)).toEqual(["PUT", "DELETE"]);
    expect(claims.map((claim) => claim.read.stated?.method)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("reads a negated condition's arms the other way round", () => {
    const [first] =
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at(undefined)],
        forks: openForks(forkOf("id", { negated: true })),
        argsUnder: byId,
      }) ?? [];

    expect(first?.path).toBe("/x/{id}");
    expect(first?.arms).toEqual([{ at: "fork:id", arm: 1 }]);
  });

  it("keeps the plain request when no fork changes it", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at(undefined)],
        forks: openForks(forkOf("debug")),
      }),
    ).toEqual([{ method: "GET", path: null, host: undefined }]);
  });

  it("keeps the plain request when two conditions both change it", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at(undefined)],
        forks: openForks(forkOf("a"), forkOf("b")),
        argsUnder: urlBy((arms) =>
          arms.has("a") || arms.has("b")
            ? `/${arms.get("a") ?? "_"}/${arms.get("b") ?? "_"}`
            : undefined,
        ),
      }),
    ).toEqual([{ method: "GET", path: null, host: undefined }]);
  });

  it("keeps the plain request when a fork beside the one taken starts to change it", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at(undefined)],
        forks: openForks(forkOf("a"), forkOf("b")),
        argsUnder: urlBy((arms) => {
          const a = arms.get("a");
          const b = arms.get("b");
          if (a === undefined) {
            return undefined;
          }
          return b === undefined ? `/a${a}` : `/a${a}/b${b}`;
        }),
      }),
    ).toEqual([{ method: "GET", path: null, host: undefined }]);
  });

  it("splits a fork inside an arm once that arm is taken", () => {
    const inner = forkOf("b", { under: "a" });
    const claims = claimsOf(REQUESTS, {
      method: "get",
      from: ["httplib"],
      args: [at(undefined)],
      forks: (arms) => meeting(forksInside(arms, inner)),
      argsUnder: urlBy((arms) => {
        if (arms.get("a") === 0) {
          return "/a";
        }
        return arms.has("b") ? ["/b", "/c"][arms.get("b") ?? 0] : undefined;
      }),
    });

    expect(claims?.map((claim) => [claim.path, claim.arms])).toEqual([
      ["/a", [{ at: "fork:a", arm: 0 }]],
      [
        "/b",
        [
          { at: "fork:a", arm: 1 },
          { at: "fork:b", arm: 0 },
        ],
      ],
      [
        "/c",
        [
          { at: "fork:a", arm: 1 },
          { at: "fork:b", arm: 1 },
        ],
      ],
    ]);
  });

  /** The fork `a` at the top, and `inner` once `a` took its second arm. */
  function forksInside(
    arms: ReadonlyMap<string, number>,
    inner: CallFork,
  ): CallFork[] {
    if (!arms.has("a")) {
      return [forkOf("a")];
    }
    return arms.get("a") === 1 && !arms.has("b") ? [inner] : [];
  }

  it("leaves out an arm that returns before the call, and shares what arms giving one request share", () => {
    const pick = forkOf("kind", { arms: 4 });
    const claims = claimsOf(REQUESTS, {
      method: "get",
      from: ["httplib"],
      args: [at(undefined)],
      forks: (arms) =>
        meeting(arms.has("kind") ? [] : [pick], {
          reached: arms.get("kind") !== 3,
        }),
      argsUnder: urlBy((arms) =>
        arms.has("kind")
          ? ["/a", "/b", "/a", "/gone"][arms.get("kind") ?? 0]
          : undefined,
      ),
    });

    expect(claims?.map((claim) => [claim.path, claim.arms])).toEqual([
      ["/a", []],
      ["/b", [{ at: "fork:kind", arm: 1 }]],
    ]);
  });

  it("keeps the plain request when an arm's method is only the library's default", () => {
    const FETCH_CALL = {
      sends: { from: { at: 1, property: ["method"] }, default: "GET" },
      url: { at: 0 },
    };
    const FETCH = httpRequests({ client: imported({ from: ["httplib"] }) })
      .methods({ fetch: FETCH_CALL })
      .calls(FETCH_CALL);

    expect(
      claimsOf(FETCH, {
        callee: "fetch",
        from: ["httplib"],
        args: [at(undefined), {}],
        forks: openForks(forkOf("id")),
        argsUnder: (arms) =>
          arms.has("id")
            ? [at(arms.get("id") === 0 ? "/x/{id}" : "/x"), {}]
            : undefined,
      }),
    ).toEqual([{ method: "GET", path: null, host: undefined }]);
  });

  it("keeps the plain request when a reading stopped early or the class is built more than one way", () => {
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at(undefined)],
        forks: () => meeting([forkOf("id")], { exhausted: true }),
        argsUnder: byId,
      }),
    ).toEqual([{ method: "GET", path: null, host: undefined }]);
    expect(
      claimsOf(REQUESTS, {
        method: "get",
        from: ["httplib"],
        args: [at(undefined)],
        sites: ["new A"],
        forks: openForks(forkOf("id")),
        argsUnder: byId,
      }),
    ).toEqual([{ method: "GET", path: null, host: undefined }]);
  });
});
