// pythonProgram.ts: the generated Python program DSL and its renderers.
//
// A spec describes a small web app in the shapes the shipped Python
// packs read (fastapi's decorated function routes with router
// mounting, flask-restx's decorated resource classes behind a direct
// import, a project wrapper module, or a namespace the app mounts)
// plus the shapes those packs document as abstentions: a path that is
// not a string literal, a computed prefix, a namespace with no path
// of its own or a mount that overrides it, a router or namespace
// variable assigned twice, one mounted twice or never or onto another
// router. Rendering produces the program's files and, alongside them,
// one `PyRouteIntent` per declared route saying where the running app
// will serve it and whether extraction is expected to claim that path
// or abstain.
//
// The two frameworks carry the same dimensions on purpose. A mount
// the generator always writes one way is a mount the differential
// cannot judge: while every generated namespace mounted at "/", a
// pack that ignored namespace paths entirely scored the same as one
// that composed them.
//
// Bodies stay inside what v0 extraction reads, which is declarations
// only: an annotated handler returns a dict matching its annotation,
// and a status-declaring decorator gets a handler that answers with
// that status. A body that contradicts its own declaration is the
// disagreement class, which arrives with the path-engine slice, not
// here.

import { type DispatchTable, dispatchByType } from "../dispatch.js";

export type PyVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * How a fastapi decorator states the response status: not at all
 * (the framework answers 200), a literal the pack reads, or a module
 * constant the pack must decline to read even though the running app
 * answers with the constant's value.
 */
export type PyStatusSpec =
  | { type: "absent" }
  | { type: "literal"; code: number }
  | { type: "computed"; code: number };

/** Which declaration states the response shape, if any. */
export type PyResponseDecl = "none" | "returnAnnotation" | "responseModel";

export interface FastapiRouteSpec {
  verb: PyVerb;
  /** Path segment; the renderer suffixes a running index so no two routes collide. */
  segment: string;
  hasPathParam: boolean;
  /** Writes the path parameter with Starlette's typed-converter spelling (`{x_id:int}`) instead of the bare `{x_id}`. Meaningful only with `hasPathParam`. */
  pathParamTyped: boolean;
  /** Path written as `BASE + "/x"`, which the pack abstains on while the app serves the composed value. */
  pathComputed: boolean;
  status: PyStatusSpec;
  response: PyResponseDecl;
  /** A Pydantic-model body parameter; only meaningful on POST/PUT/PATCH. */
  hasBodyParam: boolean;
  hasQueryParam: boolean;
}

/**
 * One registration context for a set of routes. "app" and "mounted"
 * (and the outer half of "nested") are the shapes the pack claims
 * paths for; every other kind is a documented abstention of the
 * router-prefix reading.
 */
export type FastapiGroupSpec =
  | { type: "app"; routes: FastapiRouteSpec[] }
  | {
      type: "mounted";
      ownPrefix: "literal" | "absent";
      mountPrefix: "literal" | "absent";
      crossFile: boolean;
      routes: FastapiRouteSpec[];
    }
  | { type: "computedOwnPrefix"; routes: FastapiRouteSpec[] }
  | { type: "computedMountPrefix"; routes: FastapiRouteSpec[] }
  | { type: "unmounted"; routes: FastapiRouteSpec[] }
  | {
      type: "reassigned";
      firstRoutes: FastapiRouteSpec[];
      secondRoutes: FastapiRouteSpec[];
    }
  | { type: "mountedTwice"; routes: FastapiRouteSpec[] }
  | {
      type: "nested";
      innerRoutes: FastapiRouteSpec[];
      outerRoutes: FastapiRouteSpec[];
    };

export interface FastapiProgramSpec {
  groups: FastapiGroupSpec[];
}

export interface FlaskMethodSpec {
  verb: PyVerb;
  /**
   * `-> Shape` return annotation, the one declaration the pack reads
   * off a resource method. Annotated methods answer a plain dict
   * (status 200) so the declared 200 stays true; a body contradicting
   * its own annotation is the disagreement class, out of scope here.
   */
  annotated: boolean;
  /** "tuple" answers `return body, status`, which the pack claims nothing about. Never combined with `annotated`. */
  returnStyle: "dict" | "tuple";
  tupleStatus: number;
}

export interface FlaskResourceSpec {
  segment: string;
  /** A werkzeug converter segment (`/<int:x>`), claimed and served at the canonical brace spelling. */
  hasPathParam: boolean;
  /** Writes the converter with Werkzeug's argument spelling (`<int(min=0):x>`) instead of the bare `<int:x>`. Meaningful only with `hasPathParam`. */
  converterArgs: boolean;
  /** Path written as `BASE + "/x"`: discovery drops the whole class, the app serves the composed value. */
  pathComputed: boolean;
  methods: FlaskMethodSpec[];
}

/** How the route decorator reaches the resource file: flask_restx directly, or a project wrapper module, imported plain or aliased. */
export type FlaskImportStyle = "direct" | "wrapper" | "wrapperAliased";

/**
 * How a namespace states the path its resources hang under. The
 * library keeps that path with trailing slashes stripped and falls
 * back to one it derives from the namespace's name, so what the
 * source writes and what the app serves come apart in exactly the
 * ways this union names.
 */
export type FlaskNamespacePath =
  /** `path="/nsK"`, or `path="/nsK/"` with `trailingSlash`, which serves the same paths. */
  | { type: "literal"; trailingSlash: boolean }
  /** `path="/"`, which adds nothing to the paths its routes are served at. */
  | { type: "root" }
  /** No `path` at all: the library serves the namespace under its name. */
  | { type: "absent" }
  /** `path=""`, `path=None`, `path=False`, `path=0`: all falsy, and the library serves all of them under the name, same as writing none. */
  | { type: "noValue"; written: FlaskNoValue }
  /** `path=NS_PATH_K`, a module constant rather than a literal. */
  | { type: "computed" };

/** The spellings of a value flask-restx reads as no value at all, at either site. */
export type FlaskNoValue = "empty" | "none" | "false" | "zero";

/** How the mount call states a path of its own, if it states one. */
export type FlaskNamespaceMountPath =
  /** `add_namespace(ns)`, leaving the namespace where its constructor put it. */
  | { type: "absent" }
  /** `add_namespace(ns, path="/oK")`, which replaces the namespace's own path. */
  | { type: "override" }
  /** A falsy path at the mount, which the library reads as no override at all. */
  | { type: "noValue"; written: FlaskNoValue }
  /** `add_namespace(ns, path=OVERRIDE_K)`, a module constant rather than a literal. */
  | { type: "computed" };

/**
 * One namespace, its resources, and how the app mounts it. "mounted"
 * is the shape the pack claims paths for; the rest are the mount
 * readings it documents as abstentions, the same list the FastAPI
 * router groups cover.
 */
export type FlaskNamespaceSpec =
  | {
      type: "mounted";
      path: FlaskNamespacePath;
      /** What the mount call says about the path, which for this library can override the namespace's own. */
      mountPath: FlaskNamespaceMountPath;
      /** Declares the first resource with an empty route path, the idiom for the mount point itself. */
      emptyPathResource: boolean;
      resources: FlaskResourceSpec[];
    }
  | { type: "unmounted"; resources: FlaskResourceSpec[] }
  | { type: "mountedTwice"; resources: FlaskResourceSpec[] }
  | {
      type: "reassigned";
      firstResources: FlaskResourceSpec[];
      secondResources: FlaskResourceSpec[];
    };

export interface FlaskProgramSpec {
  importStyle: FlaskImportStyle;
  /** Resources decorated through the app's own `Api` or the project wrapper, with no namespace of their own. */
  resources: FlaskResourceSpec[];
  /** Resources declared on a namespace, one module per namespace, mounted from main.py. */
  namespaces: FlaskNamespaceSpec[];
}

export type PythonProgramSpec =
  | { framework: "fastapi"; program: FastapiProgramSpec }
  | { framework: "flask-restx"; program: FlaskProgramSpec };

/**
 * What one declared route means for adjudication: the summary name
 * discovery gives the unit, every path the running app serves it at
 * (empty when it is never served), and whether extraction is expected
 * to claim the path or abstain. Expectations classify the generated
 * shape; the observed truth always comes from running the app.
 */
export interface PyRouteIntent {
  name: string;
  method: PyVerb;
  servedPaths: string[];
  expectation: "claim" | "abstain";
  /** JSON body a well-formed probe request must carry, for routes with a model body parameter. */
  requestBody: Record<string, unknown> | null;
}

export interface RenderedPythonProgram {
  framework: "fastapi" | "flask-restx";
  packageName: string;
  /** Paths relative to the program directory, `__init__.py` files included. */
  files: Record<string, string>;
  intents: PyRouteIntent[];
  /** Wrapper modules the pack must be configured with for this program. */
  wrapperModules: string[];
}

/** The dict a model-shaped handler answers with, matching the rendered model's two fields. */
export const MODEL_BODY: Record<string, unknown> = { id: 1, name: "x" };

const MODEL_BODY_LITERAL = '{"id": 1, "name": "x"}';

const MODEL_FIELDS = ["    id: int", "    name: str"];

// ---------------------------------------------------------------------------
// FastAPI rendering
// ---------------------------------------------------------------------------

interface FastapiRenderState {
  routeIndex: number;
  intents: PyRouteIntent[];
}

interface RenderedRoute {
  /** Constant definitions the route needs ahead of its decorator. */
  constants: string[];
  lines: string[];
}

/** The route's own path suffix as the decorator writes it, typed-converter spelling included. */
function writtenSuffix(route: FastapiRouteSpec, n: number): string {
  const base = `/${route.segment}${n}`;
  if (!route.hasPathParam) {
    return base;
  }
  const param = `${route.segment}${n}_id`;
  return route.pathParamTyped ? `${base}/{${param}:int}` : `${base}/{${param}}`;
}

/** The same suffix in the canonical brace spelling claims and observations use. */
function routeSuffix(route: FastapiRouteSpec, n: number): string {
  const base = `/${route.segment}${n}`;
  return route.hasPathParam ? `${base}/{${route.segment}${n}_id}` : base;
}

function fastapiRouteName(route: FastapiRouteSpec, n: number): string {
  return `${route.verb.toLowerCase()}_${route.segment}${n}`;
}

function fastapiRouteLines(
  route: FastapiRouteSpec,
  n: number,
  object: string,
  modelName: string | null,
): RenderedRoute {
  const suffix = writtenSuffix(route, n);
  const constants: string[] = [];
  const pathExpr = route.pathComputed
    ? `BASE_${n} + "${suffix}"`
    : `"${suffix}"`;
  if (route.pathComputed) {
    constants.push(`BASE_${n} = "/c${n}"`);
  }

  const kwargs: string[] = [];
  if (route.status.type === "literal") {
    kwargs.push(`status_code=${route.status.code}`);
  }
  if (route.status.type === "computed") {
    constants.push(`CODE_${n} = ${route.status.code}`);
    kwargs.push(`status_code=CODE_${n}`);
  }
  if (route.response === "responseModel" && modelName !== null) {
    kwargs.push(`response_model=${modelName}`);
  }

  const params: string[] = [];
  if (route.hasPathParam) {
    params.push(`${route.segment}${n}_id: int`);
  }
  if (route.hasBodyParam && modelName !== null) {
    params.push(`payload: ${modelName}`);
  }
  if (route.hasQueryParam) {
    params.push('q: str = "x"');
  }

  const annotation =
    route.response === "returnAnnotation" && modelName !== null
      ? ` -> ${modelName}`
      : "";
  const body =
    route.response === "none" && !route.hasBodyParam
      ? '{"ok": "yes"}'
      : MODEL_BODY_LITERAL;

  const decoratorArgs = [pathExpr, ...kwargs].join(", ");
  return {
    constants,
    lines: [
      `@${object}.${route.verb.toLowerCase()}(${decoratorArgs})`,
      `def ${fastapiRouteName(route, n)}(${params.join(", ")})${annotation}:`,
      `    return ${body}`,
      "",
      "",
    ],
  };
}

function routeNeedsModel(route: FastapiRouteSpec): boolean {
  return route.response !== "none" || route.hasBodyParam;
}

/** The path the app serves a route at under composed prefixes, resolving a computed decorator path to the value its constant holds. */
function servedPath(
  route: FastapiRouteSpec,
  n: number,
  prefixes: string,
): string {
  const suffix = routeSuffix(route, n);
  return route.pathComputed
    ? `${prefixes}/c${n}${suffix}`
    : `${prefixes}${suffix}`;
}

interface GroupRendering {
  /** Lines placed in main.py before the mounts (or nothing when the group lives in its own router file). */
  definitionLines: string[];
  /** Mount calls, placed at the end of main.py after every registration. */
  mountLines: string[];
  /** An extra file this group lives in, when it is a cross-file router. */
  extraFile: { path: string; lines: string[] } | null;
  usesRouterInMain: boolean;
  needsModelInMain: boolean;
}

interface RenderRoutesOptions {
  routes: FastapiRouteSpec[];
  state: FastapiRenderState;
  /** The variable the route decorators hang on ("app", "router_2"). */
  object: string;
  modelName: string | null;
  /** The composed prefix string in front of every route's own suffix at serve time. */
  prefixes: string;
  /** Whether a literal-path route here is one the pack claims a path for. */
  claimable: boolean;
  /** Overrides the served paths, for routes served nowhere or twice. */
  servedPathsOf?: (route: FastapiRouteSpec, n: number) => string[];
}

function renderRoutes(options: RenderRoutesOptions): string[] {
  const { routes, state, object, modelName, prefixes, claimable } = options;
  const constants: string[] = [];
  const bodies: string[] = [];
  for (const route of routes) {
    const n = state.routeIndex;
    state.routeIndex += 1;
    const rendered = fastapiRouteLines(route, n, object, modelName);
    constants.push(...rendered.constants);
    bodies.push(...rendered.lines);
    const paths =
      options.servedPathsOf !== undefined
        ? options.servedPathsOf(route, n)
        : [servedPath(route, n, prefixes)];
    state.intents.push({
      name: fastapiRouteName(route, n),
      method: route.verb,
      servedPaths: paths,
      expectation: claimable && !route.pathComputed ? "claim" : "abstain",
      requestBody: route.hasBodyParam ? MODEL_BODY : null,
    });
  }
  return [...constants.flatMap((line) => [line, ""]), "", ...bodies];
}

function modelLines(name: string): string[] {
  return [`class ${name}(BaseModel):`, ...MODEL_FIELDS, "", ""];
}

function groupModelName(gi: number, routes: FastapiRouteSpec[]): string | null {
  return routes.some(routeNeedsModel) ? `Model${gi}` : null;
}

function mountedGroupRendering(
  group: Extract<FastapiGroupSpec, { type: "mounted" }>,
  gi: number,
  state: FastapiRenderState,
): GroupRendering {
  const ownPrefix = group.ownPrefix === "literal" ? `/g${gi}` : "";
  const mountPrefix = group.mountPrefix === "literal" ? `/m${gi}` : "";
  const constructorArg =
    group.ownPrefix === "literal" ? `prefix="${ownPrefix}"` : "";
  const mountArg =
    group.mountPrefix === "literal" ? `, prefix="${mountPrefix}"` : "";
  const modelName = groupModelName(gi, group.routes);
  const routeLines = (object: string): string[] =>
    renderRoutes({
      routes: group.routes,
      state,
      object,
      modelName,
      prefixes: `${mountPrefix}${ownPrefix}`,
      claimable: true,
    });

  if (!group.crossFile) {
    return {
      definitionLines: [
        ...(modelName !== null ? modelLines(modelName) : []),
        `router_${gi} = APIRouter(${constructorArg})`,
        "",
        "",
        ...routeLines(`router_${gi}`),
      ],
      mountLines: [`app.include_router(router_${gi}${mountArg})`],
      extraFile: null,
      usesRouterInMain: true,
      needsModelInMain: modelName !== null,
    };
  }

  const fileLines = [
    "from fastapi import APIRouter",
    ...(modelName !== null ? ["from pydantic import BaseModel"] : []),
    "",
    "",
    ...(modelName !== null ? modelLines(modelName) : []),
    `router = APIRouter(${constructorArg})`,
    "",
    "",
    ...routeLines("router"),
  ];
  return {
    definitionLines: [],
    mountLines: [`app.include_router(router_${gi}${mountArg})`],
    extraFile: { path: `routers/r${gi}.py`, lines: fileLines },
    usesRouterInMain: false,
    needsModelInMain: false,
  };
}

function fastapiGroupRenderers(
  gi: number,
  state: FastapiRenderState,
): DispatchTable<FastapiGroupSpec, GroupRendering> {
  const routerGroup = (options: {
    routes: FastapiRouteSpec[];
    constructorArg: string;
    prelude: string[];
    mountLines: string[];
    prefixes: string;
    servedPathsOf?: (route: FastapiRouteSpec, n: number) => string[];
  }): GroupRendering => {
    const modelName = groupModelName(gi, options.routes);
    return {
      definitionLines: [
        ...(modelName !== null ? modelLines(modelName) : []),
        ...options.prelude,
        `router_${gi} = APIRouter(${options.constructorArg})`,
        "",
        "",
        ...renderRoutes({
          routes: options.routes,
          state,
          object: `router_${gi}`,
          modelName,
          prefixes: options.prefixes,
          claimable: false,
          ...(options.servedPathsOf !== undefined
            ? { servedPathsOf: options.servedPathsOf }
            : {}),
        }),
      ],
      mountLines: options.mountLines,
      extraFile: null,
      usesRouterInMain: true,
      needsModelInMain: modelName !== null,
    };
  };

  return {
    app: (group) => {
      const modelName = groupModelName(gi, group.routes);
      return {
        definitionLines: [
          ...(modelName !== null ? modelLines(modelName) : []),
          ...renderRoutes({
            routes: group.routes,
            state,
            object: "app",
            modelName,
            prefixes: "",
            claimable: true,
          }),
        ],
        mountLines: [],
        extraFile: null,
        usesRouterInMain: false,
        needsModelInMain: modelName !== null,
      };
    },
    mounted: (group) => mountedGroupRendering(group, gi, state),
    computedOwnPrefix: (group) =>
      routerGroup({
        routes: group.routes,
        constructorArg: `prefix=own_prefix_${gi}()`,
        prelude: [`def own_prefix_${gi}():`, `    return "/po${gi}"`, "", ""],
        mountLines: [`app.include_router(router_${gi}, prefix="/m${gi}")`],
        prefixes: `/m${gi}/po${gi}`,
      }),
    computedMountPrefix: (group) =>
      routerGroup({
        routes: group.routes,
        constructorArg: `prefix="/g${gi}"`,
        prelude: [`def mount_prefix_${gi}():`, `    return "/pm${gi}"`, "", ""],
        mountLines: [
          `app.include_router(router_${gi}, prefix=mount_prefix_${gi}())`,
        ],
        prefixes: `/pm${gi}/g${gi}`,
      }),
    unmounted: (group) =>
      routerGroup({
        routes: group.routes,
        constructorArg: `prefix="/u${gi}"`,
        prelude: [],
        mountLines: [],
        prefixes: "",
        servedPathsOf: () => [],
      }),
    reassigned: (group) => {
      const modelName = groupModelName(gi, [
        ...group.firstRoutes,
        ...group.secondRoutes,
      ]);
      // Decoration binds to whichever object the name holds at that
      // point, so the first construction's routes are lost once the
      // mount only sees the second. Extraction abstains on both.
      return {
        definitionLines: [
          ...(modelName !== null ? modelLines(modelName) : []),
          `router_${gi} = APIRouter(prefix="/ra${gi}")`,
          "",
          "",
          ...renderRoutes({
            routes: group.firstRoutes,
            state,
            object: `router_${gi}`,
            modelName,
            prefixes: "",
            claimable: false,
            servedPathsOf: () => [],
          }),
          `router_${gi} = APIRouter(prefix="/rb${gi}")`,
          "",
          "",
          ...renderRoutes({
            routes: group.secondRoutes,
            state,
            object: `router_${gi}`,
            modelName,
            prefixes: `/m${gi}/rb${gi}`,
            claimable: false,
          }),
        ],
        mountLines: [`app.include_router(router_${gi}, prefix="/m${gi}")`],
        extraFile: null,
        usesRouterInMain: true,
        needsModelInMain: modelName !== null,
      };
    },
    mountedTwice: (group) =>
      routerGroup({
        routes: group.routes,
        constructorArg: `prefix="/g${gi}"`,
        prelude: [],
        mountLines: [
          `app.include_router(router_${gi}, prefix="/ma${gi}")`,
          `app.include_router(router_${gi}, prefix="/mb${gi}")`,
        ],
        prefixes: "",
        servedPathsOf: (route, n) => [
          servedPath(route, n, `/ma${gi}/g${gi}`),
          servedPath(route, n, `/mb${gi}/g${gi}`),
        ],
      }),
    nested: (group) => {
      const modelName = groupModelName(gi, [
        ...group.innerRoutes,
        ...group.outerRoutes,
      ]);
      // The inner router sits two mount hops from the app, one past
      // what the prefix reading follows, so its routes abstain while
      // the outer router's own routes still claim.
      return {
        definitionLines: [
          ...(modelName !== null ? modelLines(modelName) : []),
          `inner_${gi} = APIRouter(prefix="/in${gi}")`,
          "",
          "",
          ...renderRoutes({
            routes: group.innerRoutes,
            state,
            object: `inner_${gi}`,
            modelName,
            prefixes: `/m${gi}/out${gi}/in${gi}`,
            claimable: false,
          }),
          `router_${gi} = APIRouter(prefix="/out${gi}")`,
          "",
          "",
          ...renderRoutes({
            routes: group.outerRoutes,
            state,
            object: `router_${gi}`,
            modelName,
            prefixes: `/m${gi}/out${gi}`,
            claimable: true,
          }),
          `router_${gi}.include_router(inner_${gi})`,
          "",
        ],
        mountLines: [`app.include_router(router_${gi}, prefix="/m${gi}")`],
        extraFile: null,
        usesRouterInMain: true,
        needsModelInMain: modelName !== null,
      };
    },
  };
}

function renderFastapiProgram(
  spec: FastapiProgramSpec,
  packageName: string,
): RenderedPythonProgram {
  const state: FastapiRenderState = { routeIndex: 0, intents: [] };

  const renderings = spec.groups.map((group, gi) =>
    dispatchByType(fastapiGroupRenderers(gi, state), group),
  );

  const usesRouter = renderings.some(
    (r) => r.usesRouterInMain || r.extraFile !== null,
  );
  const needsModel = renderings.some((r) => r.needsModelInMain);
  const crossFileImports = renderings.flatMap((r, gi) =>
    r.extraFile !== null
      ? [`from ${packageName}.routers.r${gi} import router as router_${gi}`]
      : [],
  );

  const mainLines = [
    usesRouter
      ? "from fastapi import APIRouter, FastAPI"
      : "from fastapi import FastAPI",
    ...(needsModel ? ["from pydantic import BaseModel"] : []),
    ...crossFileImports,
    "",
    "app = FastAPI()",
    "",
    "",
    ...renderings.flatMap((r) => r.definitionLines),
    ...renderings.flatMap((r) => r.mountLines),
    "",
  ];

  const files: Record<string, string> = {
    [`${packageName}/__init__.py`]: "",
    [`${packageName}/main.py`]: joinLines(mainLines),
  };
  const extras = renderings.flatMap((r) =>
    r.extraFile !== null ? [r.extraFile] : [],
  );
  if (extras.length > 0) {
    files[`${packageName}/routers/__init__.py`] = "";
  }
  for (const extra of extras) {
    files[`${packageName}/${extra.path}`] = joinLines(extra.lines);
  }

  return {
    framework: "fastapi",
    packageName,
    files,
    intents: state.intents,
    wrapperModules: [],
  };
}

// ---------------------------------------------------------------------------
// flask-restx rendering
// ---------------------------------------------------------------------------

function pascal(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

function flaskResourceName(resource: FlaskResourceSpec, ri: number): string {
  return `${pascal(resource.segment)}${ri}`;
}

function flaskResourcePath(resource: FlaskResourceSpec, ri: number): string {
  const base = `/${resource.segment}${ri}`;
  if (!resource.hasPathParam) {
    return base;
  }
  // min=0 keeps the observer's fill-in value of 1 inside the
  // converter's accepted range, so the probe still reaches the route.
  const converter = resource.converterArgs ? "int(min=0)" : "int";
  return `${base}/<${converter}:${resource.segment}${ri}_id>`;
}

function flaskMethodLines(
  method: FlaskMethodSpec,
  resource: FlaskResourceSpec,
  ri: number,
  shapeName: string | null,
): string[] {
  const params = resource.hasPathParam
    ? `self, ${resource.segment}${ri}_id`
    : "self";
  const annotation =
    method.annotated && shapeName !== null ? ` -> ${shapeName}` : "";
  const returnLine =
    method.returnStyle === "tuple"
      ? `        return {"ok": "yes"}, ${method.tupleStatus}`
      : '        return {"ok": "yes"}';
  return [
    `    def ${method.verb.toLowerCase()}(${params})${annotation}:`,
    returnLine,
    "",
  ];
}

function flaskResourceLines(
  resource: FlaskResourceSpec,
  ri: number,
  routeDecorator: string,
  writtenPath: string,
): string[] {
  const className = flaskResourceName(resource, ri);
  const needsShape = resource.methods.some((m) => m.annotated);
  const shapeName = needsShape ? `Shape${ri}` : null;
  const pathExpr = resource.pathComputed
    ? `BASE_${ri} + "${writtenPath}"`
    : `"${writtenPath}"`;

  return [
    ...(shapeName !== null
      ? [`class ${shapeName}:`, "    ok: str", "", ""]
      : []),
    ...(resource.pathComputed ? [`BASE_${ri} = "/b${ri}"`, "", ""] : []),
    `@${routeDecorator}(${pathExpr})`,
    `class ${className}(Resource):`,
    ...resource.methods.flatMap((method) =>
      flaskMethodLines(method, resource, ri, shapeName),
    ),
    "",
  ];
}

/**
 * The rendered source spells a template parameter the way Werkzeug
 * does (`<int:orders0_id>`, `<int(min=0):orders0_id>`); intents and
 * observations both speak the IR's canonical brace spelling, the one
 * an extracted claim carries, so the judge compares one spelling
 * everywhere.
 */
function canonicalFlaskPath(path: string): string {
  return path.replace(/<(?:\w+(?:\(.*?\))?:)?(\w+)>/g, "{$1}");
}

interface FlaskRenderState {
  resourceIndex: number;
  intents: PyRouteIntent[];
}

interface RenderFlaskResourcesOptions {
  resources: FlaskResourceSpec[];
  state: FlaskRenderState;
  /** What the resource decorator is written as at this site (`api.route`, `route`, `ns.route`). */
  routeDecorator: string;
  /** What the app puts in front of every resource's own path here, already as the library holds it. */
  prefix: string;
  /** Whether a literal-path resource here is one the pack claims a path for. */
  claimable: boolean;
  /** Declares the first resource with an empty route path, which serves the prefix itself. Ignored when the prefix is empty, since the app refuses a rule with no path at all. */
  emptyFirstPath?: boolean;
  /** Overrides where the app serves these, for resources served nowhere. */
  servedPathsOf?: (served: string) => string[];
}

/** Render a set of resources, recording one intent per declared method as it goes. */
function renderFlaskResources(options: RenderFlaskResourcesOptions): string[] {
  const lines: string[] = [];
  for (const [index, resource] of options.resources.entries()) {
    const ri = options.state.resourceIndex;
    options.state.resourceIndex += 1;

    const empty =
      index === 0 && options.emptyFirstPath === true && options.prefix !== "";
    // An empty route path states no parameter, so the methods must
    // take none either: a handler asking for one the rule never binds
    // is a program that answers 500, not a program under test.
    const declared = empty ? { ...resource, hasPathParam: false } : resource;
    const writtenPath = empty ? "" : flaskResourcePath(declared, ri);
    lines.push(
      ...flaskResourceLines(declared, ri, options.routeDecorator, writtenPath),
    );

    const suffix = declared.pathComputed
      ? `/b${ri}${writtenPath}`
      : writtenPath;
    const served = canonicalFlaskPath(`${options.prefix}${suffix}`);
    const className = flaskResourceName(declared, ri);
    for (const method of declared.methods) {
      options.state.intents.push({
        name: `${className}.${method.verb.toLowerCase()}`,
        method: method.verb,
        servedPaths:
          options.servedPathsOf !== undefined
            ? options.servedPathsOf(served)
            : [served],
        expectation:
          options.claimable && !declared.pathComputed ? "claim" : "abstain",
        requestBody: null,
      });
    }
  }
  return lines;
}

/** One namespace module, the import that reaches it from main.py, and the mount calls that put it on the app. */
interface NamespaceRendering {
  file: { path: string; lines: string[] };
  mainImport: string;
  mountLines: string[];
}

/** What the library holds a namespace's path as, and what the source writes to get it. */
interface NamespacePathRendering {
  /** The keyword argument on the constructor call, empty when the source writes none. */
  constructorArg: string;
  /** A module constant the constructor reads its path from, for the non-literal shape. */
  prelude: string[];
  /** The path the app serves this namespace's resources under. */
  prefix: string;
  /** Whether the pack reads this path, as opposed to documenting an abstention over it. */
  readable: boolean;
}

function namespacePathRenderings(
  k: number,
): DispatchTable<FlaskNamespacePath, NamespacePathRendering> {
  return {
    literal: (path) => ({
      constructorArg: `, path="/ns${k}${path.trailingSlash ? "/" : ""}"`,
      prelude: [],
      prefix: `/ns${k}`,
      readable: true,
    }),
    root: () => ({
      constructorArg: ', path="/"',
      prelude: [],
      prefix: "",
      readable: true,
    }),
    // No path at all: the library serves the namespace under a path it
    // derives from the name, which the pack declines to derive.
    absent: () => ({
      constructorArg: "",
      prelude: [],
      prefix: `/ns${k}`,
      readable: false,
    }),
    // A falsy path is no path as far as the library is concerned, so
    // all four spellings serve exactly where the absent one does.
    noValue: (path) => ({
      constructorArg: `, path=${FLASK_NO_VALUE_SOURCE[path.written]}`,
      prelude: [],
      prefix: `/ns${k}`,
      readable: false,
    }),
    computed: () => ({
      constructorArg: `, path=NS_PATH_${k}`,
      prelude: [`NS_PATH_${k} = "/c${k}"`, ""],
      prefix: `/c${k}`,
      readable: false,
    }),
  };
}

function namespaceFileLines(body: string[]): string[] {
  return ["from flask_restx import Namespace, Resource", "", "", ...body];
}

/** How each no-value spelling is written in Python. All four are falsy, which is the only thing the library asks. */
const FLASK_NO_VALUE_SOURCE: Record<FlaskNoValue, string> = {
  empty: '""',
  none: "None",
  false: "False",
  zero: "0",
};

/** What the mount call writes, and what the app serves the namespace under once it has. */
interface MountPathRendering {
  /** The keyword argument on `add_namespace`, empty when the call states none. */
  mountArg: string;
  /** A module constant the mount reads its path from, for the non-literal shape. */
  prelude: string[];
  /** The path the app serves under, when the mount overrides the namespace's own; null when it leaves the namespace where it was. */
  overridePrefix: string | null;
  /** Whether the pack reads this mount, as opposed to documenting an abstention over it. */
  readable: boolean;
}

function mountPathRenderings(
  k: number,
): DispatchTable<FlaskNamespaceMountPath, MountPathRendering> {
  return {
    absent: () => ({
      mountArg: "",
      prelude: [],
      overridePrefix: null,
      readable: true,
    }),
    // The mount states a path of its own, which replaces the
    // namespace's rather than going in front of it. The library does
    // not strip a trailing slash here, and the pack abstains anyway.
    override: () => ({
      mountArg: `, path="/o${k}"`,
      prelude: [],
      overridePrefix: `/o${k}`,
      readable: false,
    }),
    // Falsy at the mount is no override at all, so the namespace
    // stays where its constructor put it and the pack composes.
    noValue: (mount) => ({
      mountArg: `, path=${FLASK_NO_VALUE_SOURCE[mount.written]}`,
      prelude: [],
      overridePrefix: null,
      readable: true,
    }),
    computed: () => ({
      mountArg: `, path=OVERRIDE_${k}`,
      prelude: [`OVERRIDE_${k} = "/mo${k}"`, ""],
      overridePrefix: `/mo${k}`,
      readable: false,
    }),
  };
}

function namespaceRenderers(
  k: number,
  state: FlaskRenderState,
  apiVariable: string,
): DispatchTable<FlaskNamespaceSpec, NamespaceRendering> {
  const file = (lines: string[]) => ({
    path: `namespaces/ns${k}.py`,
    lines: namespaceFileLines(lines),
  });
  const mainImport = `from PACKAGE.namespaces.ns${k} import ns as ns_${k}`;
  const constructed = (name: string, arg: string) =>
    `ns = Namespace("${name}"${arg})`;

  return {
    mounted: (namespace) => {
      const path = dispatchByType(namespacePathRenderings(k), namespace.path);
      const mount = dispatchByType(mountPathRenderings(k), namespace.mountPath);
      // A mount that overrides the path serves under that one; a
      // mount that states nothing leaves the namespace where its
      // constructor put it.
      const prefix = mount.overridePrefix ?? path.prefix;
      // The composed path is readable only when both ends are: an
      // override the pack declines to follow costs the namespace's
      // own readable path too.
      const claimable = path.readable && mount.readable;
      return {
        file: file([
          ...path.prelude,
          constructed(`ns${k}`, path.constructorArg),
          "",
          "",
          ...renderFlaskResources({
            resources: namespace.resources,
            state,
            routeDecorator: "ns.route",
            prefix,
            claimable,
            emptyFirstPath: namespace.emptyPathResource,
          }),
        ]),
        mainImport,
        mountLines: [
          ...mount.prelude,
          `${apiVariable}.add_namespace(ns_${k}${mount.mountArg})`,
        ],
      };
    },
    unmounted: (namespace) => ({
      file: file([
        constructed(`ns${k}`, `, path="/u${k}"`),
        "",
        "",
        ...renderFlaskResources({
          resources: namespace.resources,
          state,
          routeDecorator: "ns.route",
          prefix: `/u${k}`,
          claimable: false,
          servedPathsOf: () => [],
        }),
      ]),
      mainImport,
      mountLines: [],
    }),
    // Both mounts register the same resources at the same path, so the
    // app serves one path and which mount put it there is not written
    // down: the pack abstains rather than pick one.
    mountedTwice: (namespace) => ({
      file: file([
        constructed(`ns${k}`, `, path="/t${k}"`),
        "",
        "",
        ...renderFlaskResources({
          resources: namespace.resources,
          state,
          routeDecorator: "ns.route",
          prefix: `/t${k}`,
          claimable: false,
        }),
      ]),
      mainImport,
      mountLines: [
        `${apiVariable}.add_namespace(ns_${k})`,
        `${apiVariable}.add_namespace(ns_${k})`,
      ],
    }),
    // Decoration binds to whichever namespace the name holds at that
    // point, so the first construction's resources are never mounted
    // and never served. Extraction abstains on both sets.
    reassigned: (namespace) => ({
      file: file([
        constructed(`ns${k}a`, `, path="/ra${k}"`),
        "",
        "",
        ...renderFlaskResources({
          resources: namespace.firstResources,
          state,
          routeDecorator: "ns.route",
          prefix: `/ra${k}`,
          claimable: false,
          servedPathsOf: () => [],
        }),
        constructed(`ns${k}b`, `, path="/rb${k}"`),
        "",
        "",
        ...renderFlaskResources({
          resources: namespace.secondResources,
          state,
          routeDecorator: "ns.route",
          prefix: `/rb${k}`,
          claimable: false,
        }),
      ]),
      mainImport,
      mountLines: [`${apiVariable}.add_namespace(ns_${k})`],
    }),
  };
}

const FLASK_ROUTE_DECORATORS: Record<FlaskImportStyle, string> = {
  direct: "api.route",
  wrapper: "route",
  wrapperAliased: "api_route",
};

/** The `Api` variable main.py mounts namespaces on, which each import style names differently. */
const FLASK_API_VARIABLES: Record<FlaskImportStyle, string> = {
  direct: "api",
  wrapper: "restx_api",
  wrapperAliased: "restx_api",
};

function renderFlaskProgram(
  spec: FlaskProgramSpec,
  packageName: string,
): RenderedPythonProgram {
  const state: FlaskRenderState = { resourceIndex: 0, intents: [] };
  const routeDecorator = FLASK_ROUTE_DECORATORS[spec.importStyle];
  const apiVariable = FLASK_API_VARIABLES[spec.importStyle];

  // Resources with no namespace of their own hang on whatever the
  // import style gives them, and are served at the paths their
  // decorators write.
  const resourceLines = renderFlaskResources({
    resources: spec.resources,
    state,
    routeDecorator,
    prefix: "",
    claimable: true,
  });

  const namespaces = spec.namespaces.map((namespace, k) =>
    dispatchByType(namespaceRenderers(k, state, apiVariable), namespace),
  );
  const namespaceImports = namespaces.map((rendering) =>
    rendering.mainImport.replace("PACKAGE", packageName),
  );
  const namespaceMounts = namespaces.flatMap(
    (rendering) => rendering.mountLines,
  );
  const namespaceFiles: Record<string, string> =
    namespaces.length > 0
      ? { [`${packageName}/namespaces/__init__.py`]: "" }
      : {};
  for (const rendering of namespaces) {
    namespaceFiles[`${packageName}/${rendering.file.path}`] = joinLines(
      rendering.file.lines,
    );
  }

  if (spec.importStyle === "direct") {
    const mainLines = [
      "from flask import Flask",
      "from flask_restx import Api, Resource",
      ...namespaceImports,
      "",
      "app = Flask(__name__)",
      "api = Api(app, doc=False)",
      "",
      "",
      ...resourceLines,
      ...namespaceMounts,
      "",
    ];
    return {
      framework: "flask-restx",
      packageName,
      files: {
        [`${packageName}/__init__.py`]: "",
        [`${packageName}/main.py`]: joinLines(mainLines),
        ...namespaceFiles,
      },
      intents: state.intents,
      wrapperModules: [],
    };
  }

  const wrapperModule = `${packageName}.wrappers.restx`;
  const wrapperImport =
    spec.importStyle === "wrapperAliased"
      ? `from ${wrapperModule} import route as api_route`
      : `from ${wrapperModule} import route`;

  // The wrapper mirrors the corpus shape the flask-restx pack exists
  // for: one project module re-exporting the route decorator, resource
  // files importing that instead of flask_restx. The namespace mounts
  // at "/" so decorator paths serve verbatim.
  const wrapperLines = [
    "from flask_restx import Namespace",
    "",
    'api = Namespace("generated", path="/")',
    "",
    "",
    "def route(path):",
    "    return api.route(path)",
    "",
  ];

  const resourcesFileLines = [
    "from flask_restx import Resource",
    "",
    wrapperImport,
    "",
    "",
    ...resourceLines,
  ];

  const mainLines = [
    "from flask import Flask",
    "from flask_restx import Api",
    "",
    `from ${packageName}.routes import resources as _resources`,
    `from ${packageName}.wrappers.restx import api as resource_namespace`,
    ...namespaceImports,
    "",
    "app = Flask(__name__)",
    "restx_api = Api(app, doc=False)",
    "restx_api.add_namespace(resource_namespace)",
    ...namespaceMounts,
    "",
  ];

  return {
    framework: "flask-restx",
    packageName,
    files: {
      [`${packageName}/__init__.py`]: "",
      [`${packageName}/wrappers/__init__.py`]: "",
      [`${packageName}/wrappers/restx.py`]: joinLines(wrapperLines),
      [`${packageName}/routes/__init__.py`]: "",
      [`${packageName}/routes/resources.py`]: joinLines(resourcesFileLines),
      [`${packageName}/main.py`]: joinLines(mainLines),
      ...namespaceFiles,
    },
    intents: state.intents,
    wrapperModules: [wrapperModule],
  };
}

function joinLines(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}$/u, "\n");
}

export function renderPythonProgram(
  spec: PythonProgramSpec,
  packageName: string,
): RenderedPythonProgram {
  if (spec.framework === "fastapi") {
    return renderFastapiProgram(spec.program, packageName);
  }
  return renderFlaskProgram(spec.program, packageName);
}
