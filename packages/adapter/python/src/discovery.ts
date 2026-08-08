/**
 * Finds decorated routes and turns each one into a `RawCodeStructure`.
 *
 * Only decorated module-level functions and classes that are declared
 * unconditionally get discovered, the same boundary the binder in scope.ts
 * draws. Nothing here reads into a unit's body, so a route's summary comes out
 * with no branches at all, or with exactly one branch describing what an
 * annotation or a decorator keyword already states, such as a FastAPI
 * `response_model` or `status_code`, or a return annotation.
 *
 * That is enough to pair a route against a caller by method and path, and it
 * claims nothing about behavior nobody read.
 */

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
  ExtractorOptions,
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
  PathRepeatedSlashes,
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
  /** Without it, every route object looks like the app itself and paths stand as written. */
  routerIndex?: RouterIndex;
  /** Under "strict" a route whose unit cannot be built stops the run instead of abstaining. */
  gapHandling?: ExtractorOptions["gapHandling"];
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
        options,
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

/** The library requires a path here, so a first argument nobody can read is unreadable rather than absent. */
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

interface PathTemplateReading {
  path: string;
  paramNames: ReadonlySet<string>;
}

type PathTemplateReader = (path: string) => PathTemplateReading;

const NO_PATH_PARAMS: ReadonlySet<string> = new Set();

/** `template` has to capture the parameter name in its first group. */
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

/** `braces` follows Starlette's `PARAM_REGEX`, `flaskConverters` follows Werkzeug's `_part_re`. */
const PATH_TEMPLATE_READERS: Record<string, PathTemplateReader> = {
  braces: templateReader(/\{([A-Za-z_]\w*)(?::[A-Za-z_]\w*)?\}/g),
  flaskConverters: templateReader(
    /<(?:[A-Za-z_]\w*(?:\(.*?\))?:)?([A-Za-z_]\w*)>/g,
  ),
};

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
  options: DiscoveryOptions,
): RawCodeStructure[] {
  // The path is all a class decorator says about the route, so if we cannot
  // read one, the class is not discovered at all.
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
  const routePath = readRoutePath(
    pattern,
    pathArgument,
    classification,
    module,
    options,
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
      ...routeUnitOrAbstention(
        {
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
          filePath: options.filePath,
          skipReceiverParam: true,
          responseShape: absentReading,
          statusCode: defaultedStatus(absentReading, pattern),
        },
        options,
      ),
    );
  }
  return units;
}

/** The path a route is served at, spelled the way the IR spells a path template. */
function readRoutePath(
  pattern: PythonDiscoveryPattern,
  pathArgument: Reading<string>,
  classification: DecoratorClassification,
  module: ModuleBinding,
  options: DiscoveryOptions,
): Reading<PathTemplateReading> {
  const composed = andThenReading(pathArgument, (literal, range) =>
    composeRoutePath(pattern, classification, module, options, literal, range),
  );
  return andThenReading(composed, (path, range) =>
    readPathTemplate(pattern, path, range),
  );
}

function composeRoutePath(
  pattern: PythonDiscoveryPattern,
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
    return writtenReading(servedSpelling(pattern, literal), range);
  }

  return mapReading(prefix, (value) =>
    servedSpelling(pattern, value + literal),
  );
}

/**
 * What a library serves for a path carrying repeated slashes, which
 * composing a prefix written with a trailing slash is how you get.
 */
const REPEATED_SLASH_READERS: Record<
  PathRepeatedSlashes,
  (path: string) => string
> = {
  kept: (path) => path,
  merged: (path) => path.replace(/\/{2,}/g, "/"),
};

function servedSpelling(pattern: PythonDiscoveryPattern, path: string): string {
  return REPEATED_SLASH_READERS[pattern.pathRepeatedSlashes ?? "kept"](path);
}

/** Absent when the decorator hangs on something that composes no prefix, the app itself included. */
function readRouterPrefix(
  pattern: PythonDiscoveryPattern,
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

/** If the status keyword is written as anything but a literal number, falling back to the library's default would claim a status the running app does not return. */
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
  return routeUnitOrAbstention(
    {
      pack,
      name: functionName,
      exportPath: [functionName],
      method: verb,
      routePath: readRoutePath(
        pattern,
        readPathArgument(classification),
        classification,
        module,
        options,
      ),
      requestBodyFromAnnotatedClass:
        pattern.annotatedClassIsRequestBody === true,
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
    },
    options,
  );
}

interface BuildRouteUnitOptions {
  pack: PythonPack;
  name: string;
  exportPath: string[];
  method: string;
  /** The boundary binding only gets a path when this came back written. */
  routePath: Reading<PathTemplateReading>;
  requestBodyFromAnnotatedClass: boolean;
  definitionNode: PyNode;
  enclosingScope: Scope;
  module: ModuleBinding;
  filePath: string;
  skipReceiverParam: boolean;
  /** What the decorator declares, before the return annotation gets a say. */
  responseShape: Reading<TypeShape>;
  /** Handed to the extractor uncollapsed, so it applies the library default itself. */
  statusCode: DefaultedReading<number>;
  definitionsCtx?: ReturnType<typeof createAnnotationContext>;
}

/**
 * The return annotation is only read when the decorator gave nothing back, so a
 * class the route never declares does not get added to `definitions` as a side
 * effect of looking.
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

/** When a route cannot be turned into a unit, we lose that route rather than the whole run. */
function routeUnitOrAbstention(
  unitOptions: BuildRouteUnitOptions,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  try {
    return [buildRouteUnit(unitOptions)];
  } catch (error) {
    if (options.gapHandling === "strict") {
      throw error;
    }

    return [unbuiltRouteUnit(unitOptions, error)];
  }
}

function nullIfEmpty(value: string): string | null {
  return value === "" ? null : value;
}

/** Nothing in here reads the route again, so whatever threw the first time has nothing to throw from a second time. */
function unbuiltRouteUnit(
  unitOptions: BuildRouteUnitOptions,
  error: unknown,
): RawCodeStructure {
  const range = rangeOf(unitOptions.definitionNode);
  const message = error instanceof Error ? error.message : String(error);
  return {
    identity: {
      name: unitOptions.name,
      nameKind: "binding",
      kind: "handler",
      file: unitOptions.filePath,
      range,
      exportName: unitOptions.exportPath[0] ?? unitOptions.name,
      exportPath: unitOptions.exportPath,
    },
    boundaryBinding: restBinding({
      transport: unitOptions.pack.protocol,
      method: nullIfEmpty(unitOptions.method),
      path: null,
      recognition: unitOptions.pack.name,
    }),
    parameters: [],
    branches: [],
    bodyContent: "statements",
    dependencyCalls: [],
    declaredContract: null,
    readings: [
      unreadableReading(
        `This route could not be read into a unit (${message}), so the binding names no path and nothing pairs with it`,
        range,
      ),
    ],
  };
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

  const template = valueToReadFurtherFrom(routePath);
  const ctx = definitionsCtx ?? createAnnotationContext(module.scopeFor);
  const parameters = readParameters(
    definitionNode,
    enclosingScope,
    ctx,
    template?.paramNames ?? null,
    requestBodyFromAnnotatedClass,
    skipReceiverParam,
  );

  const responseShape = readResponseShape(options.responseShape, () =>
    readReturnAnnotation(definitionNode, enclosingScope, ctx),
  );

  // A route that says nothing about the body shape and nothing about the
  // status declares no response at all, so the library's default status has
  // nothing to apply to.
  const branches: RawBranch[] = [];
  if (
    responseShape.reading.kind !== "absent" ||
    statusCode.reading.kind !== "absent"
  ) {
    branches.push({
      conditions: [],
      terminal: {
        kind: "response",
        // These stay null here. The extractor fills them in from
        // `statusCodeReading` and `bodyShapeReading` below.
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
    readings: [
      routePath,
      ...unreadRoleReadings(parameters, rangeOf(definitionNode)),
      ...responseShape.passedOver,
    ],
    ...(collectedDefinitions(ctx) !== null
      ? { definitions: collectedDefinitions(ctx) }
      : {}),
  };
}

/** One sentence covers every parameter, because an unread path is the same reason for all of them. */
function unreadRoleReadings(
  parameters: RawParameter[],
  range: SourceRange,
): Reading<never>[] {
  if (!parameters.some((parameter) => parameter.role === null)) {
    return [];
  }

  return [
    unreadableReading(
      "Nothing read this route's path, so its parameters name no role and a path parameter here does not read as one",
      range,
    ),
  ];
}

/** Whether a body contains only a docstring and/or a bare `pass`, or something more. */
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
  pathParamNames: ReadonlySet<string> | null,
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
  pathParamNames: ReadonlySet<string> | null,
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
 * A null `pathParamNames` means nobody could read the path. A parameter that the
 * request-body convention does not cover then gets no role at all, because
 * calling it a query parameter could hide a path parameter behind a guess.
 */
function roleOf(
  name: string,
  shape: TypeShape | null,
  pathParamNames: ReadonlySet<string> | null,
  requestBodyFromAnnotatedClass: boolean,
): string | null {
  if (pathParamNames?.has(name) === true) {
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
  if (pathParamNames === null) {
    return null;
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
