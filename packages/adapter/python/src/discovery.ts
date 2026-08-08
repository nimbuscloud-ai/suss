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
  absentReading,
  andThenReading,
  firstWrittenReading,
  mapReading,
  unreadableReading,
  valueToReadFurtherFrom,
  writtenReading,
} from "@suss/extractor";

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
  ChosenReading,
  DefaultedReading,
  RawBranch,
  RawCodeStructure,
  RawParameter,
  Reading,
  SourceRange,
} from "@suss/extractor";
import type { DecoratorClassification } from "./decorators.js";
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

/**
 * The path a route's decorator states, as its first positional string
 * argument. A decorator whose first argument is missing or is written
 * as anything but a string literal reads as unreadable rather than
 * absent: the library requires a path there, so what is missing is the
 * reading, not the path.
 */
function readPathArgument(
  classification: DecoratorClassification,
): Reading<string> {
  const first = classification.args[0];
  if (first?.kind === "string") {
    return writtenReading(first.value, classification.range);
  }

  return unreadableReading(
    "The path in this route's decorator is not a string literal, so the binding names no path and nothing pairs with it",
    classification.range,
  );
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

/**
 * Run the pattern's declared template syntax over a literal path. No
 * declared syntax reads the path as written with no parameters; a
 * declared syntax this adapter has no reader for reads as unreadable
 * rather than guessing at a spelling it cannot parse.
 */
function readPathTemplate(
  pattern: PythonDiscoveryPattern,
  path: string,
  range: SourceRange,
): Reading<PathTemplateReading> {
  const syntax = pattern.pathParamSyntax;
  if (syntax === undefined) {
    return writtenReading({ path, paramNames: NO_PATH_PARAMS }, range);
  }

  const reader = PATH_TEMPLATE_READERS[syntax];
  if (reader === undefined) {
    return unreadableReading(
      `The route's pack declares path-parameter syntax "${syntax}", which this adapter has no reader for, so the binding names no path and nothing pairs with it`,
      range,
    );
  }

  return writtenReading(reader(path), range);
}

function classRouteUnits(
  pattern: DecoratedClassRoute,
  pack: PythonPack,
  classification: DecoratorClassification,
  classNode: PyNode,
  module: ModuleBinding,
  filePath: string,
): RawCodeStructure[] {
  // The path is the whole of what a class decorator says about this
  // route, so a class whose decorator states none readable is not
  // discovered at all rather than discovered with nothing on it.
  const pathArgument = readPathArgument(classification);
  if (pathArgument.kind !== "written") {
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
  const routePath = andThenReading(pathArgument, (path, range) =>
    readPathTemplate(pattern, path, range),
  );

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
        routePath,
        requestBodyFromAnnotatedClass:
          pattern.annotatedClassIsRequestBody === true,
        definitionNode: maybeMethod,
        enclosingScope: classScope,
        module,
        filePath,
        skipReceiverParam: true,
        responseShape: absentReading,
        statusCode: defaultedStatus(absentReading, pattern),
      }),
    );
  }
  return units;
}

/**
 * The path a function route is served at: what its decorator states,
 * with the router's prefix in front of it, spelled the way the IR
 * spells a path template. Each step reads further from what the one
 * before it found, so a step that cannot read hands its reason on and
 * the ones after it never run.
 */
function readRoutePath(
  pattern: DecoratedFunctionRoute,
  classification: DecoratorClassification,
  module: ModuleBinding,
  options: DiscoveryOptions,
): Reading<PathTemplateReading> {
  const composed = andThenReading(
    readPathArgument(classification),
    (literal, range) =>
      composeRoutePath(
        pattern,
        classification,
        module,
        options,
        literal,
        range,
      ),
  );
  return andThenReading(composed, (path, range) =>
    readPathTemplate(pattern, path, range),
  );
}

/** The decorator's own path with the router's prefix in front of it, when the route hangs on a router that composes one. */
function composeRoutePath(
  pattern: DecoratedFunctionRoute,
  classification: DecoratorClassification,
  module: ModuleBinding,
  options: DiscoveryOptions,
  literal: string,
  range: SourceRange,
): Reading<string> {
  const prefix = readRouterPrefix(
    pattern,
    classification,
    module,
    options,
    range,
  );
  if (prefix.kind === "absent") {
    return writtenReading(literal, range);
  }

  return mapReading(prefix, (value) => value + literal);
}

/**
 * The prefix the router a route is declared on puts in front of every
 * path on it. Absent when the decorator hangs on something that
 * composes no prefix: the app itself, an object this reading never saw
 * constructed, or a pack that declares no router mounting at all.
 */
function readRouterPrefix(
  pattern: DecoratedFunctionRoute,
  classification: DecoratorClassification,
  module: ModuleBinding,
  options: DiscoveryOptions,
  range: SourceRange,
): Reading<string> {
  if (
    pattern.routerComposition === undefined ||
    options.routerIndex === undefined ||
    classification.objectName === null
  ) {
    return absentReading;
  }

  const resolution = options.routerIndex.resolve(
    pattern,
    module,
    classification.objectName,
  );
  if (resolution.kind === "abstain") {
    return unreadableReading(
      `The router this route is declared on ${resolution.reason}, so the binding names no path and nothing pairs with it`,
      range,
    );
  }

  if (resolution.kind === "composed") {
    return writtenReading(resolution.value, range);
  }

  return absentReading;
}

/**
 * The status a route's decorator states under its pack's status
 * keyword. A keyword written as anything but a literal number reads as
 * unreadable: taking the library's default there would claim a status
 * the running app contradicts whenever that value is anything else.
 */
function readStatusCode(
  pattern: DecoratedFunctionRoute,
  classification: DecoratorClassification,
): Reading<number> {
  if (pattern.statusCodeKeyword === undefined) {
    return absentReading;
  }

  const arg = classification.keywordArgs[pattern.statusCodeKeyword];
  if (arg === undefined) {
    return absentReading;
  }

  if (arg.kind === "number") {
    return writtenReading(arg.value, classification.range);
  }

  return unreadableReading(
    "The status this route's decorator states is not a literal number, so the response claims no status",
    classification.range,
  );
}

/** A status reading alongside the default the pattern's library declares for a route that states none. */
function defaultedStatus(
  reading: Reading<number>,
  pattern: PythonDiscoveryPattern,
): DefaultedReading<number> {
  return {
    reading,
    ...(pattern.defaultStatusCode !== undefined
      ? { libraryDefault: pattern.defaultStatusCode }
      : {}),
  };
}

/**
 * The response body shape a route's decorator states under its pack's
 * response-model keyword. A keyword written as anything but a name
 * reads as unreadable, so a shape nobody could read does not pass for
 * a route that declares none.
 */
function readResponseModel(
  pattern: DecoratedFunctionRoute,
  classification: DecoratorClassification,
  module: ModuleBinding,
  ctx: ReturnType<typeof createAnnotationContext>,
): Reading<TypeShape> {
  if (pattern.responseModelKeyword === undefined) {
    return absentReading;
  }

  const arg = classification.keywordArgs[pattern.responseModelKeyword];
  if (arg === undefined) {
    return absentReading;
  }

  if (arg.kind === "identifier") {
    // A response_model naming a class the binder can see resolves to
    // its record shape; one it can't (imported from elsewhere, or not
    // a class at all) stays an opaque ref by name.
    return writtenReading(
      shapeFromName(arg.name, module.moduleScope, ctx),
      classification.range,
    );
  }

  return unreadableReading(
    "The response model this route's decorator states is not a name, so the response claims no body shape",
    classification.range,
  );
}

/** The shape a function's return annotation states. */
function readReturnAnnotation(
  definitionNode: PyNode,
  scope: Scope,
  ctx: ReturnType<typeof createAnnotationContext>,
): Reading<TypeShape> {
  const returnTypeNode = field(definitionNode, "return_type");
  if (returnTypeNode === null) {
    return absentReading;
  }

  return writtenReading(
    annotationToShape(returnTypeNode, scope, ctx),
    rangeOf(returnTypeNode),
  );
}

function functionRouteUnits(
  pattern: DecoratedFunctionRoute,
  pack: PythonPack,
  verb: string,
  classification: DecoratorClassification,
  functionNode: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  const functionName = field(functionNode, "name")?.text;
  if (functionName === undefined) {
    return [];
  }

  const ctx = createAnnotationContext(module.scopeFor);
  const unit = buildRouteUnit({
    pack,
    name: functionName,
    exportPath: [functionName],
    method: verb,
    routePath: readRoutePath(pattern, classification, module, options),
    requestBodyFromAnnotatedClass: pattern.annotatedClassIsRequestBody === true,
    definitionNode: functionNode,
    enclosingScope: module.moduleScope,
    module,
    filePath: options.filePath,
    skipReceiverParam: false,
    responseShape: readResponseModel(pattern, classification, module, ctx),
    statusCode: defaultedStatus(
      readStatusCode(pattern, classification),
      pattern,
    ),
    definitionsCtx: ctx,
  });
  return [unit];
}

interface BuildRouteUnitOptions {
  pack: PythonPack;
  name: string;
  exportPath: string[];
  method: string;
  /** Where the route is served, as the readers left it. The binding names a path only when this came back written. */
  routePath: Reading<PathTemplateReading>;
  /** Whether the pattern declares an annotated-local-class parameter as the request body (see `RouteConventions` in pack.ts). */
  requestBodyFromAnnotatedClass: boolean;
  definitionNode: PyNode;
  enclosingScope: Scope;
  module: ModuleBinding;
  filePath: string;
  skipReceiverParam: boolean;
  /** The shape the route's decorator declares for its response body, before the return annotation gets its say. */
  responseShape: Reading<TypeShape>;
  /** The status the route declares, with the default its library applies when it declares none. Handed to the extractor uncollapsed. */
  statusCode: DefaultedReading<number>;
  definitionsCtx?: ReturnType<typeof createAnnotationContext>;
}

/**
 * The shape a route declares for its response body: what its decorator
 * states, and otherwise its return annotation. The annotation is read
 * only when the decorator did not answer, so a class the route never
 * declares does not land in `definitions` on the way past.
 */
function readResponseShape(
  declared: Reading<TypeShape>,
  readAnnotation: () => Reading<TypeShape>,
): ChosenReading<TypeShape> {
  if (declared.kind === "written") {
    return { reading: declared, passedOver: [] };
  }

  return firstWrittenReading([declared, readAnnotation()]);
}

function buildRouteUnit(options: BuildRouteUnitOptions): RawCodeStructure {
  const {
    pack,
    name,
    exportPath,
    method,
    routePath,
    requestBodyFromAnnotatedClass,
    definitionNode,
    enclosingScope,
    module,
    filePath,
    skipReceiverParam,
    statusCode,
    definitionsCtx,
  } = options;

  // The path template names which of the handler's parameters are path
  // parameters, and that has to be settled before there is a summary
  // field to fill, so this is read further from rather than claimed.
  const template = valueToReadFurtherFrom(routePath);
  const ctx = definitionsCtx ?? createAnnotationContext(module.scopeFor);
  const parameters = readParameters(
    definitionNode,
    enclosingScope,
    ctx,
    template?.paramNames ?? NO_PATH_PARAMS,
    requestBodyFromAnnotatedClass,
    skipReceiverParam,
  );

  const responseShape = readResponseShape(options.responseShape, () =>
    readReturnAnnotation(definitionNode, enclosingScope, ctx),
  );

  // The route declares a response when it says anything at all about
  // the body shape or the status, including something nobody could
  // read. A route that says neither declares nothing, and the library's
  // default status has nothing to apply to.
  const branches: RawBranch[] = [];
  if (
    responseShape.reading.kind !== "absent" ||
    statusCode.reading.kind !== "absent"
  ) {
    branches.push({
      conditions: [],
      terminal: {
        kind: "response",
        // What this branch answers with rides along as readings in
        // `statusCodeReading` and `bodyShapeReading`, and the extractor
        // is what turns either into a claim.
        statusCode: null,
        body: { typeText: null, shape: null },
        exceptionType: null,
        message: null,
        component: null,
        renderTree: null,
        delegateTarget: null,
        emitEvent: null,
        location: rangeOf(definitionNode),
      },
      statusCodeReading: statusCode,
      bodyShapeReading: { reading: responseShape.reading },
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
      path: template?.path ?? null,
      recognition: pack.name,
    }),
    parameters,
    branches,
    bodyContent: bodyNode !== null ? bodyContentOf(bodyNode) : "statements",
    dependencyCalls: [],
    declaredContract: null,
    // The chosen shape reading rides on the branch; what the choice
    // passed over and could not read has no branch to ride on and is
    // stated here.
    readings: [routePath, ...responseShape.passedOver],
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
