/**
 * The route discovery the FastAPI pack supplies, for a test that reads a
 * project with `@app.get` and `@app.post` routes on an app and its
 * routers, and the wrappers it reads around them. The adapter cannot
 * depend on the pack, so both are written out again here.
 */

import { callbacks, constructedFrom, imported } from "@suss/recognize";

import type { RouteTableDeclaration, ServesRole } from "@suss/extractor";
import type { CallbackMethod } from "@suss/recognize";
import type {
  DeclaredRoutes,
  PythonPack,
  PyWrapperForm,
  RouterUnreadWords,
} from "../pack.js";

const SERVES = (method: string): ServesRole => ({
  role: "serves",
  methods: [method],
  path: [{ at: 0 }],
  handler: { decorated: true },
});

/** The route table for an app built by `FastAPI()` whose routes use these verbs. */
export function fastapiTestTable(
  verbs: Readonly<Record<string, string>> = { get: "GET", post: "POST" },
  modules: readonly string[] = ["fastapi"],
): RouteTableDeclaration {
  return {
    roots: {
      kinds: { FastAPI: 0 },
      children: { in: "receiver" },
      in: "file",
      unlessDropped: { owned: ["middleware", "exception_handler"] },
    },
    from: modules,
    joins: "asWritten",
    loops: ["for"],
    throughWrappers: true,
    roles: {
      ...Object.fromEntries(
        Object.entries(verbs).map(([name, method]) => [name, SERVES(method)]),
      ),
      include_router: {
        role: "mount",
        table: [{ at: 0 }, { keyword: "router" }],
        at: [{ keyword: "prefix" }],
        prefix: "inFront",
      },
      APIRouter: {
        role: "scopes",
        path: [{ keyword: "prefix" }],
        children: { in: "receiver" },
        noValue: "unreadable",
        trailingSlash: "kept",
      },
    },
  };
}

export const FASTAPI_TEST_UNREAD: RouterUnreadWords = {
  unreached:
    "is never mounted through a single variable binding in the files read",
  shared: "shares its variable name with a second router construction",
  unlistedLoop:
    "is not mounted by name in the files read, and {loops} routers read out of a call this reading does not follow",
  rivalledMount:
    "is mounted inside a function, while {loops} routers this reading cannot name, and which of them the app runs is not written down",
  mountUnread: "is mounted with a prefix that is not a string literal",
  prefixUnread: "declares a prefix that is not a string literal",
  ontoPrefixUnread:
    "is mounted onto a router that declares a prefix that is not a string literal",
  chain: "is mounted through a chain of routers this reading cannot compose",
};

/** FastAPI's routes with these verbs, as a pattern's `routes` field. */
export function fastapiTestRoutes(
  verbs?: Readonly<Record<string, string>>,
  modules?: readonly string[],
): DeclaredRoutes {
  return {
    table: fastapiTestTable(verbs, modules),
    unread: FASTAPI_TEST_UNREAD,
  };
}

const HANDED_FIRST: CallbackMethod = {
  callback: { written: "callback", at: 0 },
};

/** What FastAPI runs around a route, as the pack declares it. */
export function fastapiTestWrappers(
  modules: readonly string[] = ["fastapi"],
): PyWrapperForm[] {
  const app = constructedFrom({ from: modules, named: ["FastAPI"] });
  const router = constructedFrom({ from: modules, named: ["APIRouter"] });
  return [
    {
      type: "dependency",
      handedTo: callbacks({
        client: imported({
          from: modules,
          named: ["*", "Depends", "Security"],
        }),
      }).methods({ Depends: HANDED_FIRST, Security: HANDED_FIRST }).declared,
      keyword: "dependencies",
      registrars: [
        { made: app, covers: "everyRoute" },
        { made: router, covers: "ownRoutes" },
      ],
    },
    {
      type: "decoratedWrapper",
      attribute: "middleware",
      registrars: [{ made: app, covers: "everyRoute" }],
      continuationParam: 1,
    },
    {
      type: "decoratedWrapper",
      attribute: "exception_handler",
      registrars: [{ made: app, covers: "everyRoute" }],
      throwParam: 1,
    },
  ];
}

export function fastapiTestPack(): PythonPack {
  return {
    name: "fastapi",
    protocol: "http",
    discovery: [
      {
        type: "decoratedFunctionRoute",
        importModule: ["fastapi"],
        routes: fastapiTestRoutes(),
        pathParamSyntax: "braces",
        defaultStatusCode: 200,
      },
    ],
  };
}
