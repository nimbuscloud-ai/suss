import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { httpRequests, verbs } from "./httpRequests.js";
import { anyOf, constructedFrom, imported, modulesOf } from "./ops.js";
import { declarationsIn, pack, requestRecognizersOf } from "./pack.js";

import type {
  AsCallFollowing,
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
}

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
  return {
    url: (site?: string) =>
      (site === undefined ? undefined : stated.bySite?.[site]) ??
      stated.url ??
      null,
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
    ...made,
  } as unknown as ValueOps;
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
  /** What the receiver's import statement and written value say, when the adapter can say. */
  readonly settled?: boolean;
  readonly sites?: readonly string[];
  readonly receiver?: CallOps;
  /** The receiver as the source writes it. */
  readonly receiverValue?: Stated;
  readonly built?: Readonly<Record<number, CallOps>>;
  readonly writtenAs?: CallOps;
  readonly splats?: Splats;
}

function callOps(call: Call, asked: string[] = []): CallOps {
  const comesFrom = (origin: ReceiverOrigin) =>
    modulesOf(origin).some((module) => (call.from ?? []).includes(module));
  return {
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
    valueAt: (index: number) => {
      const stated = call.args?.[index];
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

/** What the chain's hook reads at the call. */
function claimsOf(
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
      }),
    ).toEqual([]);
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

  function joined(joins: "appended" | "resolved", path: string, base = "/v1") {
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
