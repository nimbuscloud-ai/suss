/**
 * The route discovery the flask-restx pack supplies, for a test that reads
 * a project with resources decorated on a namespace or an API, and the
 * wrappers it reads around them. The adapter cannot depend on the pack,
 * so both are written out again here.
 */

import { constructedFrom } from "@suss/recognize";

import type { RouteTableDeclaration } from "@suss/extractor";
import type {
  DeclaredRoutes,
  DecoratedClassRoute,
  PyWrapperForm,
  RouterUnreadWords,
} from "../pack.js";

/** The route table for an API built by `Api()`, whose resources serve these methods. */
export function flaskRestxTestTable(
  modules: readonly string[] = ["flask_restx"],
  verbs: readonly string[] = ["get", "post"],
): RouteTableDeclaration {
  return {
    roots: {
      kinds: { Api: 0 },
      children: { in: "receiver" },
      in: "file",
      path: [{ keyword: "prefix" }],
      noValue: "unstated",
      carrier: {
        at: { at: 0 },
        handedBy: "init_app",
        from: ["flask"],
        paths: { Blueprint: [{ keyword: "url_prefix" }] },
        noValue: "unstated",
        registeredBy: {
          method: "register_blueprint",
          at: { at: 0 },
          path: [{ keyword: "url_prefix" }],
        },
      },
    },
    from: modules,
    joins: "merged",
    loops: ["for"],
    throughWrappers: true,
    roles: {
      route: {
        role: "serves",
        methods: { members: verbs },
        path: [{ at: 0 }],
        handler: { decorated: true },
      },
      add_namespace: {
        role: "mount",
        table: [{ at: 0 }],
        at: [{ keyword: "path" }],
        prefix: "replaces",
        noValue: "unstated",
      },
      Namespace: {
        role: "scopes",
        path: [{ keyword: "path" }],
        children: { in: "receiver" },
        noValue: "unstated",
        trailingSlash: "trimmed",
        prefixRequired: true,
      },
    },
  };
}

export const FLASK_RESTX_TEST_UNREAD: RouterUnreadWords = {
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
  prefixUnstated:
    "states no prefix where it is constructed, and its library derives one from elsewhere",
  prefixReplaced:
    "is mounted under a prefix that replaces the one it was constructed with, which this reading does not follow",
  root: {
    mountedOn: "is mounted on an object that {reason}",
    rootPrefixUnread: "states a prefix of its own that is not a string literal",
    carrierSeveral: "is built from more than one candidate",
    carrierUnfollowed: "is built from something this reading cannot follow",
    carrierShared:
      "is built from one whose variable name holds a second construction",
    carrierPrefixUnread:
      "is built from one whose prefix is not a string literal",
    carrierRepathed:
      "is built from one registered under a prefix stated where it is registered",
    carrierNested:
      "is built from one registered inside another, one hop past what this reading follows",
    carrierRegisteredTwice: "is built from one registered more than once",
  },
};

/** flask-restx's routes with these modules and methods, as a pattern's `routes` field. */
export function flaskRestxTestRoutes(
  modules?: readonly string[],
  verbs?: readonly string[],
): DeclaredRoutes {
  return {
    table: flaskRestxTestTable(modules, verbs),
    unread: FLASK_RESTX_TEST_UNREAD,
  };
}

/** What Flask and flask-restx run around a resource, as the pack declares it. */
export function flaskRestxTestWrappers(
  modules: readonly string[] = ["flask_restx"],
): PyWrapperForm[] {
  const app = constructedFrom({ from: ["flask"], named: ["Flask"] });
  return [
    {
      type: "decoratedWrapper",
      attribute: "before_request",
      registrars: [{ made: app, covers: "everyRoute" }],
      returnedValueResponds: true,
    },
    {
      type: "decoratedWrapper",
      attribute: "errorhandler",
      registrars: [
        { made: app, covers: "everyRoute" },
        {
          made: constructedFrom({ from: modules, named: ["Api"] }),
          covers: "everyRoute",
        },
        {
          made: constructedFrom({ from: modules, named: ["Namespace"] }),
          covers: "ownRoutes",
        },
      ],
      throwParam: 0,
    },
  ];
}

/** A resource pattern over these modules and methods, with Flask's path syntax and nothing else. */
export function flaskRestxTestPattern(
  modules: readonly string[] = ["flask_restx"],
  verbs?: readonly string[],
): DecoratedClassRoute {
  return {
    type: "decoratedClassRoute",
    importModule: [...modules],
    routes: flaskRestxTestRoutes(modules, verbs),
    pathParamSyntax: "flaskConverters",
  };
}
