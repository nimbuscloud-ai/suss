// pythonProgram.ts: the generated Python program DSL and its renderers.
//
// A spec describes a small web app in the shapes the shipped Python
// packs read (fastapi's decorated function routes with router
// mounting, flask-restx's decorated resource classes behind a direct
// import or a project wrapper module) plus the shapes those packs
// document as abstentions: a path that is not a string literal, a
// computed prefix, a router variable assigned twice, a router mounted
// twice or never or onto another router. Rendering produces the
// program's files and, alongside them, one `PyRouteIntent` per
// declared route saying where the running app will serve it and
// whether extraction is expected to claim that path or abstain.
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
  /** A werkzeug converter segment (`/<int:x>`), claimed and served verbatim. */
  hasPathParam: boolean;
  /** Path written as `BASE + "/x"`: discovery drops the whole class, the app serves the composed value. */
  pathComputed: boolean;
  methods: FlaskMethodSpec[];
}

/** How the route decorator reaches the resource file: flask_restx directly, or a project wrapper module, imported plain or aliased. */
export type FlaskImportStyle = "direct" | "wrapper" | "wrapperAliased";

export interface FlaskProgramSpec {
  importStyle: FlaskImportStyle;
  resources: FlaskResourceSpec[];
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
  const suffix = routeSuffix(route, n);
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
  return resource.hasPathParam
    ? `${base}/<int:${resource.segment}${ri}_id>`
    : base;
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
): string[] {
  const className = flaskResourceName(resource, ri);
  const path = flaskResourcePath(resource, ri);
  const needsShape = resource.methods.some((m) => m.annotated);
  const shapeName = needsShape ? `Shape${ri}` : null;
  const pathExpr = resource.pathComputed
    ? `BASE_${ri} + "${path}"`
    : `"${path}"`;

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

function flaskIntents(spec: FlaskProgramSpec): PyRouteIntent[] {
  return spec.resources.flatMap((resource, ri) => {
    const className = flaskResourceName(resource, ri);
    const path = flaskResourcePath(resource, ri);
    const served = resource.pathComputed ? `/b${ri}${path}` : path;
    return resource.methods.map(
      (method): PyRouteIntent => ({
        name: `${className}.${method.verb.toLowerCase()}`,
        method: method.verb,
        servedPaths: [served],
        expectation: resource.pathComputed ? "abstain" : "claim",
        requestBody: null,
      }),
    );
  });
}

const FLASK_ROUTE_DECORATORS: Record<FlaskImportStyle, string> = {
  direct: "api.route",
  wrapper: "route",
  wrapperAliased: "api_route",
};

function renderFlaskProgram(
  spec: FlaskProgramSpec,
  packageName: string,
): RenderedPythonProgram {
  const routeDecorator = FLASK_ROUTE_DECORATORS[spec.importStyle];
  const resourceLines = spec.resources.flatMap((resource, ri) =>
    flaskResourceLines(resource, ri, routeDecorator),
  );

  if (spec.importStyle === "direct") {
    const mainLines = [
      "from flask import Flask",
      "from flask_restx import Api, Resource",
      "",
      "app = Flask(__name__)",
      "api = Api(app, doc=False)",
      "",
      "",
      ...resourceLines,
    ];
    return {
      framework: "flask-restx",
      packageName,
      files: {
        [`${packageName}/__init__.py`]: "",
        [`${packageName}/main.py`]: joinLines(mainLines),
      },
      intents: flaskIntents(spec),
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
    "",
    "app = Flask(__name__)",
    "restx_api = Api(app, doc=False)",
    "restx_api.add_namespace(resource_namespace)",
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
    },
    intents: flaskIntents(spec),
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
