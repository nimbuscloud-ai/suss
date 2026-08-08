// discovery.ts: find decorated routes and turn each into a RawCodeStructure.
//
// v0 discovers unconditionally-declared, decorated module-level
// functions and classes (see scope.ts's doc comment for the same
// "unconditional" boundary the binder draws) and reads no further into
// a unit's body: no path-engine work happens here, so a route's
// summary carries `branches: []` (nothing declared about its response)
// or exactly one branch describing what an annotation or a decorator
// keyword already states (a FastAPI `response_model` / `status_code`,
// or a return annotation). That is the existence-class shape the
// language-adapters proposal calls for: enough to pair a route against
// a caller by method and path, nothing claimed about behavior nobody
// read.

import { dispatchByType, restBinding } from "@suss/behavioral-ir";

import {
  annotationToShape,
  collectedDefinitions,
  createAnnotationContext,
  shapeFromName,
} from "./annotations.js";
import { bodyStatements, field, rangeOf, stripDecorators } from "./ast.js";
import { classifyDecorator } from "./decorators.js";

import type { DispatchTable, TypeShape } from "@suss/behavioral-ir";
import type {
  BodyContent,
  RawBranch,
  RawCodeStructure,
  RawParameter,
} from "@suss/extractor";
import type {
  DecoratedClassRoute,
  DecoratedFunctionRoute,
  PythonDiscoveryPattern,
  PythonPack,
} from "./pack.js";
import type { PyNode } from "./parser.js";
import type { RouterIndex } from "./routers.js";
import type { ModuleBinding, Scope } from "./scope.js";

export interface DiscoveryOptions {
  packs: PythonPack[];
  /** Repo-relative or absolute path recorded on each summary's `location.file`. */
  filePath: string;
  /**
   * Cross-file router mounts, built once per project by
   * `extractPythonProject` (see routers.ts). Without it, a pattern's
   * `routerComposition` has nothing to consult and every route object
   * reads as the app itself, paths as written.
   */
  routerIndex?: RouterIndex;
}

export function discoverUnits(
  root: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  const units: RawCodeStructure[] = [];
  for (const stmt of bodyStatements(root)) {
    if (stmt.type !== "decorated_definition") {
      continue;
    }
    const { definition, decorators } = stripDecorators(stmt);
    for (const decoratorNode of decorators) {
      const classification = classifyDecorator(
        decoratorNode,
        module.moduleScope,
      );
      if (classification.module === null) {
        continue;
      }
      const decoratorModule = classification.module;
      for (const pack of options.packs) {
        for (const pattern of pack.discovery) {
          units.push(
            ...unitsFor(
              pattern,
              pack,
              decoratorModule,
              classification,
              definition,
              module,
              options,
            ),
          );
        }
      }
    }
  }
  return units;
}

function unitsFor(
  pattern: PythonDiscoveryPattern,
  pack: PythonPack,
  decoratorModule: string,
  classification: ReturnType<typeof classifyDecorator>,
  definition: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  if (!pattern.importModule.includes(decoratorModule)) {
    return [];
  }
  // Each pattern variant owns its own shape of match (a class decorator
  // naming a path plus method-name verbs, versus a function decorator
  // whose own attribute name is the verb), so dispatch on the variant
  // rather than an if-chain repeating `pattern.type ===`.
  const table: DispatchTable<PythonDiscoveryPattern, RawCodeStructure[]> = {
    decoratedClassRoute: (p) => {
      if (
        definition.type !== "class_definition" ||
        classification.importedName !== p.decoratorName
      ) {
        return [];
      }
      return classRouteUnits(
        p,
        pack,
        classification,
        definition,
        module,
        options.filePath,
      );
    },
    decoratedFunctionRoute: (p) => {
      if (definition.type !== "function_definition") {
        return [];
      }
      const verb =
        classification.importedName !== null
          ? p.verbAttributeNames[classification.importedName]
          : undefined;
      if (verb === undefined) {
        return [];
      }
      return functionRouteUnits(
        p,
        pack,
        verb,
        classification,
        definition,
        module,
        options,
      );
    },
  };
  return dispatchByType(table, pattern);
}

function firstStringArg(
  args: ReturnType<typeof classifyDecorator>["args"],
): string | null {
  const first = args[0];
  return first?.kind === "string" ? first.value : null;
}

/** A path template read under one syntax: the path in the IR's canonical brace spelling, and the parameter names the template binds. */
interface PathTemplateReading {
  path: string;
  paramNames: ReadonlySet<string>;
}

type PathTemplateReader = (path: string) => PathTemplateReading;

const NO_PATH_PARAMS: ReadonlySet<string> = new Set();

/** A reader that rewrites every match of `template` to the canonical `{name}` spelling, collecting the names, with the parameter name in the pattern's first capture group. */
function templateReader(template: RegExp): PathTemplateReader {
  return (path) => {
    const names: string[] = [];
    const canonical = path.replace(template, (_match, name: string) => {
      names.push(name);
      return `{${name}}`;
    });
    return { path: canonical, paramNames: new Set(names) };
  };
}

/**
 * One reader per template syntax a pack can declare (see
 * `RouteConventions.pathParamSyntax` in pack.ts). Both canonicalize to
 * the IR's bare-brace spelling, so a claim compares against a
 * consumer's path without a spelling mismatch.
 *
 * The braces grammar is Starlette's `PARAM_REGEX`: `{name}` with an
 * optional `:converter` after the name (`{item_id:int}`,
 * `{file_path:path}`), the converter dropped from the canonical
 * spelling. The Flask grammar is Werkzeug's `_part_re`: `<name>`,
 * `<converter:name>`, or `<converter(arguments):name>`, the arguments
 * matched lazily to the first closing parenthesis the way Werkzeug's
 * own pattern matches them.
 */
const PATH_TEMPLATE_READERS: Record<string, PathTemplateReader> = {
  braces: templateReader(/\{([A-Za-z_]\w*)(?::[A-Za-z_]\w*)?\}/g),
  flaskConverters: templateReader(
    /<(?:[A-Za-z_]\w*(?:\(.*?\))?:)?([A-Za-z_]\w*)>/g,
  ),
};

type PathTemplateResolution =
  | { kind: "read"; path: string; paramNames: ReadonlySet<string> }
  | { kind: "abstain"; unreadBinding: string };

/**
 * Run the pattern's declared template syntax over a literal path. No
 * declared syntax reads the path as written with no parameters; a
 * declared syntax this adapter has no reader for abstains with a
 * stated gap rather than guessing at a spelling it cannot parse.
 */
function readPathTemplate(
  pattern: PythonDiscoveryPattern,
  path: string,
): PathTemplateResolution {
  const syntax = pattern.pathParamSyntax;
  if (syntax === undefined) {
    return { kind: "read", path, paramNames: NO_PATH_PARAMS };
  }

  const reader = PATH_TEMPLATE_READERS[syntax];
  if (reader === undefined) {
    return {
      kind: "abstain",
      unreadBinding: `The route's pack declares path-parameter syntax "${syntax}", which this adapter has no reader for, so the binding names no path and nothing pairs with it`,
    };
  }

  const reading = reader(path);
  return { kind: "read", path: reading.path, paramNames: reading.paramNames };
}

function classRouteUnits(
  pattern: DecoratedClassRoute,
  pack: PythonPack,
  classification: ReturnType<typeof classifyDecorator>,
  classNode: PyNode,
  module: ModuleBinding,
  filePath: string,
): RawCodeStructure[] {
  const writtenPath = firstStringArg(classification.args);
  if (writtenPath === null) {
    return [];
  }
  const className = field(classNode, "name")?.text;
  const bodyNode = field(classNode, "body");
  const classScope = module.scopeFor.get(classNode.id);
  if (
    className === undefined ||
    bodyNode === null ||
    classScope === undefined
  ) {
    return [];
  }
  const template = readPathTemplate(pattern, writtenPath);

  const units: RawCodeStructure[] = [];
  for (const stmt of bodyStatements(bodyNode)) {
    const { definition: maybeMethod } = stripDecorators(stmt);
    if (maybeMethod.type !== "function_definition") {
      continue;
    }
    const methodName = field(maybeMethod, "name")?.text;
    const verb =
      methodName !== undefined
        ? pattern.verbMethodNames[methodName]
        : undefined;
    if (verb === undefined || methodName === undefined) {
      continue;
    }
    units.push(
      buildRouteUnit({
        pack,
        name: `${className}.${methodName}`,
        exportPath: [className, methodName],
        method: verb,
        path: template.kind === "read" ? template.path : null,
        ...(template.kind === "abstain"
          ? { unreadBinding: template.unreadBinding }
          : {}),
        pathParamNames:
          template.kind === "read" ? template.paramNames : NO_PATH_PARAMS,
        requestBodyFromAnnotatedClass:
          pattern.annotatedClassIsRequestBody === true,
        definitionNode: maybeMethod,
        enclosingScope: classScope,
        module,
        filePath,
        skipReceiverParam: true,
        responseShape: null,
        statusCode: null,
      }),
    );
  }
  return units;
}

/** What a function route ends up claiming for its path: a read path with its template parameters, or the abstention that keeps the route pathless. */
interface RoutePathReading {
  path: string | null;
  paramNames: ReadonlySet<string>;
  unreadBinding?: string;
}

/**
 * The path a function route claims once composition and the pattern's
 * template syntax have their say, or the abstention that keeps the
 * route pathless.
 */
function readRoutePath(
  pattern: DecoratedFunctionRoute,
  classification: ReturnType<typeof classifyDecorator>,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RoutePathReading {
  const literal = firstStringArg(classification.args);
  if (literal === null) {
    return {
      path: null,
      paramNames: NO_PATH_PARAMS,
      unreadBinding:
        "The path in this route's decorator is not a string literal, so the binding names no path and nothing pairs with it",
    };
  }
  const composed = composeRoutePath(pattern, classification, module, options);
  if (composed.path === null) {
    return composed;
  }

  const template = readPathTemplate(pattern, composed.path);
  if (template.kind === "abstain") {
    return {
      path: null,
      paramNames: NO_PATH_PARAMS,
      unreadBinding: template.unreadBinding,
    };
  }
  return { path: template.path, paramNames: template.paramNames };
}

/** The literal path with the router's composed prefix in front, when the pattern composes one; abstention reasons pass through as a pathless reading. */
function composeRoutePath(
  pattern: DecoratedFunctionRoute,
  classification: ReturnType<typeof classifyDecorator>,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RoutePathReading {
  const literal = firstStringArg(classification.args) ?? "";

  if (
    pattern.routerComposition === undefined ||
    options.routerIndex === undefined ||
    classification.objectName === null
  ) {
    return { path: literal, paramNames: NO_PATH_PARAMS };
  }

  const resolution = options.routerIndex.resolve(
    pattern,
    module,
    classification.objectName,
  );
  if (resolution.kind === "abstain") {
    return {
      path: null,
      paramNames: NO_PATH_PARAMS,
      unreadBinding: `The router this route is declared on ${resolution.reason}, so the binding names no path and nothing pairs with it`,
    };
  }

  if (resolution.kind === "composed") {
    return { path: resolution.value + literal, paramNames: NO_PATH_PARAMS };
  }

  return { path: literal, paramNames: NO_PATH_PARAMS };
}

function functionRouteUnits(
  pattern: DecoratedFunctionRoute,
  pack: PythonPack,
  verb: string,
  classification: ReturnType<typeof classifyDecorator>,
  functionNode: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  const functionName = field(functionNode, "name")?.text;
  if (functionName === undefined) {
    return [];
  }

  const { path, paramNames, unreadBinding } = readRoutePath(
    pattern,
    classification,
    module,
    options,
  );

  const ctx = createAnnotationContext(module.scopeFor);
  let responseShape: TypeShape | null = null;
  if (pattern.responseModelKeyword !== undefined) {
    const modelArg = classification.keywordArgs[pattern.responseModelKeyword];
    if (modelArg?.kind === "identifier") {
      // A response_model naming a class the binder can see resolves to
      // its record shape; one it can't (imported from elsewhere, or
      // not a class at all) stays an opaque ref by name.
      responseShape = shapeFromName(modelArg.name, module.moduleScope, ctx);
    }
  }

  const statusArg =
    pattern.statusCodeKeyword !== undefined
      ? classification.keywordArgs[pattern.statusCodeKeyword]
      : undefined;
  const statusCode = statusArg?.kind === "number" ? statusArg.value : null;

  const unit = buildRouteUnit({
    pack,
    name: functionName,
    exportPath: [functionName],
    method: verb,
    path,
    unreadBinding,
    pathParamNames: paramNames,
    requestBodyFromAnnotatedClass: pattern.annotatedClassIsRequestBody === true,
    definitionNode: functionNode,
    enclosingScope: module.moduleScope,
    module,
    filePath: options.filePath,
    skipReceiverParam: false,
    responseShape,
    statusCode,
    // The decorator wrote a status the reader could not turn into a
    // number (a variable, a call). Falling back to the framework's
    // default 200 would fabricate a claim the running app contradicts
    // whenever that value is anything else, so the status stays
    // unclaimed instead.
    statusDeclaredUnread:
      statusArg !== undefined && statusArg.kind !== "number",
    definitionsCtx: ctx,
  });
  return [unit];
}

interface BuildRouteUnitOptions {
  pack: PythonPack;
  name: string;
  exportPath: string[];
  method: string;
  /** Null when the route abstained from naming one; `unreadBinding` then says why. */
  path: string | null;
  unreadBinding?: string | undefined;
  /** Parameter names the path template binds, read by the pattern's declared syntax. Empty for a pathless route, which names no path parameters either. */
  pathParamNames: ReadonlySet<string>;
  /** Whether the pattern declares an annotated-local-class parameter as the request body (see `RouteConventions` in pack.ts). */
  requestBodyFromAnnotatedClass: boolean;
  definitionNode: PyNode;
  enclosingScope: Scope;
  module: ModuleBinding;
  filePath: string;
  skipReceiverParam: boolean;
  responseShape: TypeShape | null;
  statusCode: number | null;
  /** True when the decorator states a status the reader could not read as a literal, which suppresses the 200 default below. */
  statusDeclaredUnread?: boolean;
  definitionsCtx?: ReturnType<typeof createAnnotationContext>;
}

function buildRouteUnit(options: BuildRouteUnitOptions): RawCodeStructure {
  const {
    pack,
    name,
    exportPath,
    method,
    path,
    unreadBinding,
    pathParamNames,
    requestBodyFromAnnotatedClass,
    definitionNode,
    enclosingScope,
    module,
    filePath,
    skipReceiverParam,
    definitionsCtx,
  } = options;

  const ctx = definitionsCtx ?? createAnnotationContext(module.scopeFor);
  const parameters = readParameters(
    definitionNode,
    enclosingScope,
    ctx,
    pathParamNames,
    requestBodyFromAnnotatedClass,
    skipReceiverParam,
  );

  let { responseShape, statusCode } = options;
  const returnTypeNode = field(definitionNode, "return_type");
  if (responseShape === null && returnTypeNode !== null) {
    responseShape = annotationToShape(returnTypeNode, enclosingScope, ctx);
  }
  if (
    statusCode === null &&
    responseShape !== null &&
    options.statusDeclaredUnread !== true
  ) {
    statusCode = 200;
  }

  const branches: RawBranch[] = [];
  if (responseShape !== null || statusCode !== null) {
    branches.push({
      conditions: [],
      terminal: {
        kind: "response",
        statusCode:
          statusCode !== null ? { type: "literal", value: statusCode } : null,
        body: { typeText: null, shape: responseShape },
        exceptionType: null,
        message: null,
        component: null,
        renderTree: null,
        delegateTarget: null,
        emitEvent: null,
        location: rangeOf(definitionNode),
      },
      effects: [],
      location: rangeOf(definitionNode),
      isDefault: true,
    });
  }

  const bodyNode = field(definitionNode, "body");

  return {
    identity: {
      name,
      nameKind: "binding",
      kind: "handler",
      file: filePath,
      range: rangeOf(definitionNode),
      exportName: exportPath[0] ?? name,
      exportPath,
    },
    boundaryBinding: restBinding({
      transport: pack.protocol,
      method,
      path,
      recognition: pack.name,
    }),
    parameters,
    branches,
    bodyContent: bodyNode !== null ? bodyContentOf(bodyNode) : "statements",
    dependencyCalls: [],
    declaredContract: null,
    ...(unreadBinding !== undefined ? { unreadBinding } : {}),
    ...(collectedDefinitions(ctx) !== null
      ? { definitions: collectedDefinitions(ctx) }
      : {}),
  };
}

/** Whether a body holds only a docstring and/or a bare `pass`, or something more. v0 doesn't read past this: the distinction only feeds `bodyContent`, not what a transition claims. */
function bodyContentOf(bodyNode: PyNode): BodyContent {
  for (const stmt of bodyStatements(bodyNode)) {
    if (stmt.type === "pass_statement") {
      continue;
    }
    if (
      stmt.type === "expression_statement" &&
      stmt.namedChild(0)?.type === "string"
    ) {
      continue;
    }
    return "statements";
  }
  return "empty";
}

function readParameters(
  definitionNode: PyNode,
  scope: Scope,
  ctx: ReturnType<typeof createAnnotationContext>,
  pathParamNames: ReadonlySet<string>,
  requestBodyFromAnnotatedClass: boolean,
  skipReceiverParam: boolean,
): RawParameter[] {
  const parametersNode = field(definitionNode, "parameters");
  if (parametersNode === null) {
    return [];
  }

  const out: RawParameter[] = [];
  let position = 0;
  for (const param of parametersNode.namedChildren) {
    if (param === null) {
      continue;
    }
    if (skipReceiverParam && position === 0 && isReceiverParam(param)) {
      position += 1;
      continue;
    }
    const parsed = readParameter(
      param,
      scope,
      ctx,
      pathParamNames,
      requestBodyFromAnnotatedClass,
      position,
    );
    if (parsed !== null) {
      out.push(parsed);
    }
    position += 1;
  }
  return out;
}

function isReceiverParam(param: PyNode): boolean {
  return (
    param.type === "identifier" &&
    (param.text === "self" || param.text === "cls")
  );
}

function readParameter(
  param: PyNode,
  scope: Scope,
  ctx: ReturnType<typeof createAnnotationContext>,
  pathParamNames: ReadonlySet<string>,
  requestBodyFromAnnotatedClass: boolean,
  position: number,
): RawParameter | null {
  const info = parameterNameAndType(param);
  if (info === null) {
    return null;
  }
  const { name, typeNode } = info;
  const shape =
    typeNode !== null ? annotationToShape(typeNode, scope, ctx) : null;
  const role = roleOf(
    name,
    shape,
    pathParamNames,
    requestBodyFromAnnotatedClass,
  );
  return {
    name,
    position,
    role,
    typeText: typeNode !== null ? typeNode.text : null,
  };
}

/**
 * A parameter the path template names is a path parameter. A
 * parameter annotated with a locally-defined class (the only case
 * `annotationToShape` files under `def`, per `recordShapeRef`) is a
 * request body only when the pattern declares that convention (see
 * `RouteConventions` in pack.ts); a library without it leaves such a
 * parameter a query parameter, like everything else here.
 */
function roleOf(
  name: string,
  shape: TypeShape | null,
  pathParamNames: ReadonlySet<string>,
  requestBodyFromAnnotatedClass: boolean,
): string {
  if (pathParamNames.has(name)) {
    return "pathParams";
  }
  if (
    requestBodyFromAnnotatedClass &&
    shape !== null &&
    shape.type === "ref" &&
    shape.def !== undefined
  ) {
    return "requestBody";
  }
  return "queryParams";
}

function parameterNameAndType(
  param: PyNode,
): { name: string; typeNode: PyNode | null } | null {
  if (param.type === "identifier") {
    return { name: param.text, typeNode: null };
  }
  if (param.type === "typed_parameter") {
    const inner = param.namedChildren.find(
      (child) => child !== null && child.type === "identifier",
    );
    return inner !== undefined
      ? { name: inner.text, typeNode: field(param, "type") }
      : null;
  }
  if (param.type === "default_parameter") {
    const nameNode = field(param, "name");
    return nameNode?.type === "identifier"
      ? { name: nameNode.text, typeNode: null }
      : null;
  }
  if (param.type === "typed_default_parameter") {
    const nameNode = field(param, "name");
    return nameNode !== null
      ? { name: nameNode.text, typeNode: field(param, "type") }
      : null;
  }
  return null;
}
