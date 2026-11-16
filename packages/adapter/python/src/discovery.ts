/**
 * Finds decorated routes and turns each one into a `RawCodeStructure`, and
 * collects the client units for outgoing requests alongside them.
 *
 * Every decorated definition in the file is classified, wherever it is
 * written. One a pack's pattern accepts becomes a unit per HTTP method and
 * per mount. The path is the decorator's first argument with the router
 * prefixes in front of it. The status and body shape come from decorator
 * keywords, the return annotation, and each return or raise in the body.
 * A route that cannot be read keeps its name and gets no path, so it pairs
 * with nothing.
 */

import { dispatchByType, restBinding } from "@suss/behavioral-ir";
import {
  absentReading,
  ambiguousReading,
  andThenReading,
  effectsFiringOn,
  firstWrittenReading,
  unreadableReading,
  valueToReadFurtherFrom,
  walkDescendants,
  writtenReading,
} from "@suss/extractor";
import { joinedTablePath } from "@suss/recognize";
import { constantOf, literalOf, pathOf, takenOverUnread } from "@suss/values";

import {
  aliasValueOf,
  annotationToShape,
  collectedDefinitions,
  createAnnotationContext,
  shapeFromName,
} from "./annotations.js";
import {
  bodyStatements,
  children,
  field,
  parameterNameAndType,
  rangeOf,
  spanOf,
  stringLiteralValue,
  stripDecorators,
} from "./ast.js";
import { clientCallReceivers, clientCallUnits } from "./clientCalls.js";
import { readCallArguments } from "./decorators.js";
import { nodeId } from "./facts/values.js";
import { enqueueEffects, enqueuesAmong } from "./jobQueues.js";
import {
  bodyTerminals,
  enumerateBodyBranches,
  returnStatements,
} from "./paths/bodyBranches.js";
import { effectSitesIn, invocationSites } from "./paths/effects.js";
import {
  raisedResponses,
  returnedResponseStatus,
  statusNumberOf,
} from "./paths/raisedResponses.js";
import { returnedBodyShape } from "./paths/returnedShape.js";
import { askFileSources, slotProvenance } from "./provenance.js";
import { stdlibEffects } from "./stdlib/dispatch.js";
import { bodyStorage, declaredCallIds, type StorageLookup } from "./storage.js";
import {
  askWrittenValues,
  evaluatedValue,
  moduleOf,
  nodeOfResolutionKey,
} from "./values/evaluator.js";
import { originOf } from "./values/origin.js";

import type {
  DispatchTable,
  Effect,
  TypeShape,
  WrapperReference,
} from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  BodyContent,
  ChosenReading,
  DefaultedReading,
  ExtractorOptions,
  PackTally,
  PlacedEffect,
  RawBranch,
  RawCodeStructure,
  RawParameter,
  RawProvenance,
  Reading,
  SourceRange,
} from "@suss/extractor";
import type { DecoratorClassification } from "./decorators.js";
import type { ImportedDefinitionLookup } from "./importedDefinitions.js";
import type {
  DecoratedClassRoute,
  DecoratedFunctionRoute,
  ParameterSource,
  PyStatusCall,
  PythonDiscoveryPattern,
  PythonPack,
} from "./pack.js";
import type { PyNode } from "./parser.js";
import type {
  BodyTerminal,
  InvocationEffect,
  TerminalBranch,
} from "./paths/bodyBranches.js";
import type { EffectAt } from "./paths/effects.js";
import type { DeclaredRoute, DeclaredRouteIndex } from "./routeTables.js";
import type { ModuleBinding, Scope } from "./scope.js";
import type { PythonWrapperIndex, RouteWrapperQuery } from "./wrappers.js";

export interface DiscoveryOptions {
  packs: PythonPack[];
  /** Repo-relative or absolute path recorded on each summary's `location.file`. */
  filePath: string;
  /** The routes the run's route tables found. Without it, no pattern finds any. */
  routes?: DeclaredRouteIndex;
  /** Under "strict" a route whose unit cannot be built stops the run instead of abstaining. */
  gapHandling?: ExtractorOptions["gapHandling"];
  /** What a pack needs to decide that a call talks to the database. Absent when no pack declares storage. */
  storage?: StorageLookup | undefined;
  /** The file's absolute path, which module resolution needs. `filePath` may be shortened for display. */
  absoluteFile?: string | undefined;
  /** The project's facts, so the rules can say what an object no scope has a binding for was built by. */
  facts?: Database | undefined;
  /** What the project registered around its routes. Absent when no pack declares a wrapper form, or when a caller reads one file on its own. */
  wrappers?: PythonWrapperIndex | undefined;
  /** Where a name another file defines is written, so an imported model or alias reads as the class or value behind it. Absent when a caller reads one file on its own. */
  importedDefinition?: ImportedDefinitionLookup | undefined;
  /** Each pack's tally, which a hook that throws is charged to. */
  tallies?: ReadonlyMap<string, PackTally> | undefined;
}

/** One decorated definition, with the decorators written over it, top first. */
interface DecoratedStatement {
  stmt: PyNode;
  decorators: PyNode[];
}

/**
 * What a route's own conventions and its wrappers read off the decorator
 * that declares it, with the key of its call and of the router the route
 * table says it is made on.
 */
export type RouteDecorator = Pick<
  DecoratorClassification,
  "range" | "objectName" | "args" | "keywordArgs"
> & { key: string; router: string | null };

/**
 * Every decorated definition in the file, wherever it is written. A route
 * can be declared anywhere Python allows a statement, so the walk visits
 * every node instead of a list of places a route might be.
 */
function decoratedNodes(root: PyNode): DecoratedStatement[] {
  const found: DecoratedStatement[] = [];
  walkDescendants<PyNode, null>(root, null, children, {
    at: (node) => {
      if (node.type !== "decorated_definition") {
        return;
      }
      found.push({ stmt: node, decorators: stripDecorators(node).decorators });
    },
    into: () => null,
  });
  return found;
}

export function discoverUnits(
  root: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  const decorated = decoratedNodes(root);
  askWrittenValues(clientCallReceivers(root, module), options.facts);
  if (options.facts !== undefined) {
    askFileSources(
      routedFunctions(decorated, options),
      options.facts,
      options.storage,
    );
  }
  return [
    ...decorated.flatMap((decoratedStatement) =>
      decoratedUnits(decoratedStatement, module, options),
    ),
    ...clientCallUnits(root, options.packs, {
      filePath: options.filePath,
      factsPath: options.absoluteFile,
      facts: options.facts,
      tallies: options.tallies,
    }),
  ];
}

/**
 * The functions a pattern's decorator is written on, and the methods of
 * a class one is written on: the bodies whose units ask where their
 * values came from.
 */
function routedFunctions(
  decorated: readonly DecoratedStatement[],
  options: DiscoveryOptions,
): PyNode[] {
  return decorated.flatMap(({ stmt, decorators }) => {
    const { definition } = stripDecorators(stmt);
    const routed = decorators.some(
      (decorator) =>
        declaredRoutesOf(decorator, definition, options).length > 0,
    );
    if (!routed) {
      return [];
    }
    return definition.type === "class_definition"
      ? definition.descendantsOfType("function_definition")
      : [definition];
  });
}

function decoratedUnits(
  decoratedStatement: DecoratedStatement,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  const { stmt, decorators } = decoratedStatement;
  const units: RawCodeStructure[] = [];
  const { definition } = stripDecorators(stmt);
  for (const decorator of decorators) {
    for (const pack of options.packs) {
      for (const pattern of pack.discovery) {
        units.push(
          ...unitsFor(pattern, pack, decorator, definition, module, options),
        );
      }
    }
  }
  return units;
}

/** What the run's route tables say a decorator declares, for every pattern. */
function declaredRoutesOf(
  decoratorNode: PyNode,
  definition: PyNode,
  options: DiscoveryOptions,
): DeclaredRoute[] {
  return options.packs.flatMap((pack) =>
    pack.discovery.flatMap((pattern) =>
      routesDeclaredBy(pattern, decoratorNode, definition, options),
    ),
  );
}

/** The definition each pattern's routes are written as: a function for FastAPI's, a class for flask-restx's. */
const ROUTE_DEFINITIONS: Readonly<
  Record<PythonDiscoveryPattern["type"], string>
> = {
  decoratedFunctionRoute: "function_definition",
  decoratedClassRoute: "class_definition",
};

/** What one pattern's route table says a decorator declares, which is nothing unless it is a call written over the kind of definition the pattern routes. */
function routesDeclaredBy(
  pattern: PythonDiscoveryPattern,
  decoratorNode: PyNode,
  definition: PyNode,
  options: DiscoveryOptions,
): DeclaredRoute[] {
  const call = decoratorNode.namedChild(0);
  if (
    options.routes === undefined ||
    call?.type !== "call" ||
    definition.type !== ROUTE_DEFINITIONS[pattern.type]
  ) {
    return [];
  }
  return options.routes.routesAt(
    pattern,
    nodeId(options.absoluteFile ?? options.filePath, call),
  );
}

function unitsFor(
  pattern: PythonDiscoveryPattern,
  pack: PythonPack,
  decorator: PyNode,
  definition: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  const routes = routesDeclaredBy(pattern, decorator, definition, options);
  if (routes.length === 0) {
    return [];
  }
  const declared = routeDecoratorOf(decorator, routes, options);
  const table: DispatchTable<PythonDiscoveryPattern, RawCodeStructure[]> = {
    decoratedClassRoute: (p) =>
      classRouteUnits(p, pack, routes, declared, definition, module, options),
    decoratedFunctionRoute: (p) =>
      functionRouteUnits(
        p,
        pack,
        routes,
        declared,
        definition,
        module,
        options,
      ),
  };
  return dispatchByType(table, pattern);
}

/**
 * What a route's conventions read off the decorator: its own arguments,
 * with the object the library call is made on, which is the decorator's
 * own receiver, or the one the call a project wrapper returns is made on.
 */
function routeDecoratorOf(
  decoratorNode: PyNode,
  routes: readonly DeclaredRoute[],
  options: DiscoveryOptions,
): RouteDecorator {
  const call = decoratorNode.namedChild(0);
  const argumentList = call === null ? null : field(call, "arguments");
  const written =
    argumentList?.type === "argument_list"
      ? readCallArguments(argumentList)
      : { args: [], keywordArgs: {} };
  const through = routes[0]?.through;
  const made =
    through === undefined ? call : nodeOfResolutionKey(through, options.facts);
  const object = made === null ? null : calledOn(made);
  return {
    range: rangeOf(decoratorNode),
    objectName: object?.type === "identifier" ? object.text : null,
    key:
      call === null
        ? ""
        : nodeId(options.absoluteFile ?? options.filePath, call),
    router: routes[0]?.router ?? null,
    ...written,
  };
}

/** The object a call is made on, `ns` in `ns.route(path)`, or null for a call made on none. */
function calledOn(call: PyNode): PyNode | null {
  const callee = call.type === "call" ? field(call, "function") : null;
  return callee?.type === "attribute" ? field(callee, "object") : null;
}

/** The library requires a path here, so a first argument nobody can read is unreadable rather than absent. */
function readPathArgument(
  classification: Pick<RouteDecorator, "args" | "range">,
  options: DiscoveryOptions,
): Reading<string> {
  const first = classification.args[0];
  if (first !== undefined) {
    const value = evaluatedValue(first.node, options.facts);
    const path = literalOf(value) ?? pathOf(value);
    if (path !== undefined) {
      return writtenReading(path, classification.range);
    }
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

/**
 * One unit for each method of the class the table serves, under each
 * prefix its route is served at. The table serves a method under its
 * name upper-cased, which is how its routes are told apart here.
 */
function classRouteUnits(
  pattern: DecoratedClassRoute,
  pack: PythonPack,
  routes: readonly DeclaredRoute[],
  classification: RouteDecorator,
  classNode: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  // The path is all a class decorator says about the route, so a class
  // whose path cannot be read is not discovered at all.
  const pathArgument = readPathArgument(classification, options);
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

  const units: RawCodeStructure[] = [];
  for (const stmt of bodyStatements(bodyNode)) {
    const { definition: maybeMethod } = stripDecorators(stmt);
    if (maybeMethod.type !== "function_definition") {
      continue;
    }
    const methodName = field(maybeMethod, "name")?.text;
    const route =
      methodName === undefined
        ? undefined
        : routes.find((one) => one.method === methodName.toUpperCase());
    if (route === undefined || methodName === undefined) {
      continue;
    }
    for (const entry of declaredRoutePaths(pattern, pathArgument, route)) {
      units.push(
        ...routeUnitOrAbstention(
          {
            pack,
            name: `${className}.${methodName}`,
            exportPath: [className, methodName],
            method: route.method,
            routePath: entry.routePath,
            ...(entry.mount !== undefined ? { mount: entry.mount } : {}),
            requestBodyFromAnnotatedClass:
              pattern.annotatedClassIsRequestBody === true,
            pattern,
            responseStatusCalls: pattern.responseStatusCalls ?? [],
            facts: options.facts,
            injectedCallees: new Set(pattern.injectedParameterCallees ?? []),
            definitionNode: maybeMethod,
            enclosingScope: classScope,
            module,
            filePath: options.filePath,
            skipReceiverParam: true,
            responseShape: absentReading,
            statusCode: defaultedStatus(
              readReturnedStatus(pattern, maybeMethod, {
                module,
                facts: options.facts,
              }),
              pattern,
            ),
            storage: options.storage,
            importedDefinition: options.importedDefinition,
            wrappers: wrappersAround(
              pattern,
              pack,
              classification,
              maybeMethod,
              module,
              options,
            ),
          },
          options,
        ),
      );
    }
  }
  return units;
}

interface RoutePathEntry {
  routePath: Reading<PathTemplateReading>;
  mount?: { siblings: number; prefix: string };
}

/** What a route says when the router it is declared on gives it no path, with the reason worded to follow "the router this route is declared on". */
function routerUnread(reason: string): string {
  return `The router this route is declared on ${reason}, so the binding names no path and nothing pairs with it`;
}

/**
 * The paths a route a table found is served at: one for each prefix it
 * is served under, each saying which mount it is when there are several
 * (#689), or no path, saying why.
 */
function declaredRoutePaths(
  pattern: PythonDiscoveryPattern,
  pathArgument: Reading<string>,
  route: DeclaredRoute,
): RoutePathEntry[] {
  if (route.kind === "unread") {
    return [
      {
        routePath: andThenReading(pathArgument, (_literal, range) =>
          unreadableReading(routerUnread(route.reason), range),
        ),
      },
    ];
  }
  const servedUnder = (prefix: string): Reading<PathTemplateReading> =>
    andThenReading(
      andThenReading(pathArgument, (literal, range) =>
        writtenReading(
          joinedTablePath(pattern.routes.table, prefix, literal),
          range,
        ),
      ),
      (path, range) => readPathTemplate(pattern, path, range),
    );
  const [only] = route.prefixes;
  if (only !== undefined && route.prefixes.length === 1) {
    return [{ routePath: servedUnder(only) }];
  }
  return route.prefixes.map((prefix) => ({
    routePath: servedUnder(prefix),
    mount: { siblings: route.prefixes.length, prefix },
  }));
}

/** If the status keyword does not come to a number, falling back to the library's default would claim a status the running app does not return. */
function readStatusCode(
  pattern: DecoratedFunctionRoute,
  classification: RouteDecorator,
  options: { module: ModuleBinding; facts: Database | undefined },
): Reading<number> {
  if (pattern.statusCodeKeyword === undefined) {
    return absentReading;
  }

  const arg = classification.keywordArgs[pattern.statusCodeKeyword];
  if (arg === undefined) {
    return absentReading;
  }

  const status = statusNumberOf(arg.node, {
    ...options,
    constants: pattern.statusCodeConstants ?? {},
  });
  if (status !== null) {
    return writtenReading(status, classification.range);
  }

  return unreadableReading(
    "The status this route's decorator states does not come to a number here, so the response claims no status",
    classification.range,
  );
}

/** Flask takes the status off the tuple as an int, or off the front of a string like "201 CREATED". */
function statusFromReturnedValue(
  node: PyNode | undefined,
  facts: Database | undefined,
): number | null {
  if (node === undefined) {
    return null;
  }
  const value = evaluatedValue(node, facts);
  if (takenOverUnread(value)) {
    return null;
  }
  const number = constantOf(value);
  if (typeof number === "number") {
    return Number.isInteger(number) ? number : null;
  }

  const text = literalOf(value);
  if (text === null) {
    return null;
  }
  const digits = /^(\d{3})\b/.exec(text.trim());
  return digits === null ? null : Number.parseInt(digits[1] as string, 10);
}

/** What one `return` says about the status: a number, nothing, or unreadable. */
function statusOfReturn(
  statement: PyNode,
  facts: Database | undefined,
):
  | { kind: "status"; value: number }
  | { kind: "none" }
  | { kind: "unreadable" } {
  const returned = statement.namedChild(0);
  if (returned?.type !== "expression_list") {
    return { kind: "none" };
  }

  const status = statusFromReturnedValue(
    returned.namedChild(1) ?? undefined,
    facts,
  );
  return status === null
    ? { kind: "unreadable" }
    : { kind: "status", value: status };
}

/** What every terminal in one body reads the same way. */
export interface TerminalContext {
  pattern: PythonDiscoveryPattern;
  responseShape: DefaultedReading<TypeShape>;
  declaredStatus: DefaultedReading<number>;
  module: ModuleBinding;
  facts: Database | undefined;
}

/**
 * The status a return states: one a returned response object was built
 * with, or one off the tuple where the library reads that. A return that
 * says nothing keeps whatever the decorator declared, unless the library
 * reads the tuple, in which case a bare return is the library default.
 */
function returnStatusReading(
  statement: PyNode,
  ctx: TerminalContext,
): Reading<number> {
  const read = statusOfReturnIn(statement, ctx.pattern, ctx);
  const range = rangeOf(statement);
  if (read.kind === "status") {
    return writtenReading(read.value, range);
  }
  if (read.kind === "unreadable") {
    return unreadableReading(
      "This return gives a status this reading cannot resolve to a number, so this outcome claims none",
      range,
    );
  }
  return ctx.pattern.statusFromReturnedTuple === true
    ? absentReading
    : ctx.declaredStatus.reading;
}

export function returnBranch(
  statement: PyNode,
  ctx: TerminalContext,
): TerminalBranch {
  const range = rangeOf(statement);
  const writtenBody = returnedBodyShape(statement);
  return responseBranchAt(
    range,
    returnStatusReading(statement, ctx),
    writtenBody === null
      ? ctx.responseShape.reading
      : writtenReading(writtenBody, range),
    ctx,
  );
}

/**
 * A route body that runs off its end returns None, which the library
 * sends the same way as a bare `return`.
 */
function fallthroughBranch(
  definitionNode: PyNode,
  ctx: TerminalContext,
): TerminalBranch {
  return responseBranchAt(
    rangeOf(definitionNode),
    ctx.pattern.statusFromReturnedTuple === true
      ? absentReading
      : ctx.declaredStatus.reading,
    ctx.responseShape.reading,
    ctx,
  );
}

function responseBranchAt(
  range: SourceRange,
  status: Reading<number>,
  body: Reading<TypeShape>,
  ctx: TerminalContext,
): TerminalBranch {
  return {
    terminal: {
      kind: "response",
      // These stay null here. The extractor fills them in from the two
      // readings below.
      statusCode: null,
      body: { typeText: null, shape: null },
      exceptionType: null,
      message: null,
      component: null,
      renderTree: null,
      delegateTarget: null,
      emitEvent: null,
      location: range,
    },
    statusCodeReading: {
      reading: status,
      ...(ctx.declaredStatus.libraryDefault !== undefined
        ? { libraryDefault: ctx.declaredStatus.libraryDefault }
        : {}),
    },
    bodyShapeReading: { reading: body },
    location: range,
  };
}

/**
 * A raise says its own status, so no reading is handed over for the
 * extractor to collapse and the library default has nothing to apply to.
 */
function terminalBranchOf(
  found: BodyTerminal,
  ctx: TerminalContext,
): TerminalBranch {
  const table: DispatchTable<BodyTerminal, TerminalBranch> = {
    return: (variant) => returnBranch(variant.statement, ctx),
    raise: (variant) => ({
      terminal: variant.terminal,
      location: rangeOf(variant.statement),
    }),
    // A route has no continuation, so none is ever collected for it.
    continuation: (variant) => returnBranch(variant.statement, ctx),
  };
  return dispatchByType(table, found);
}

interface PerTerminalOptions {
  definitionNode: PyNode;
  effects: readonly PlacedEffect<InvocationEffect>[];
  responseStatusCalls: readonly PyStatusCall[];
  ctx: TerminalContext;
}

/**
 * One branch per terminal the body writes, and one for running off its
 * end, with the conditions that gate each. Null when that comes to a
 * single branch, and then the caller keeps the single declared branch.
 */
function branchesPerTerminal(options: PerTerminalOptions): RawBranch[] | null {
  const body = field(options.definitionNode, "body");
  const raised = raisedResponses(body, {
    calls: options.responseStatusCalls,
    module: options.ctx.module,
    facts: options.ctx.facts,
    constants: options.ctx.pattern.statusCodeConstants ?? {},
  });
  const terminals = bodyTerminals(body, raised);
  // A lone `return {"status": "ok"}` says what the response is even though
  // the decorator says nothing, so it is read the same as a body with
  // several exits.
  const soleReturnWritesBody =
    terminals.length === 1 &&
    terminals[0]?.type === "return" &&
    returnedBodyShape(terminals[0].statement) !== null;
  if (terminals.length === 0) {
    return null;
  }

  const branches = enumerateBodyBranches({
    body,
    terminals,
    raised,
    effects: options.effects,
    branchOf: (found) => terminalBranchOf(found, options.ctx),
    fallthrough: fallthroughBranch(options.definitionNode, options.ctx),
    facts: options.ctx.facts,
  });
  return branches.length > 1 || soleReturnWritesBody ? branches : null;
}

/** What one return says about the status, through a response the library builds first and the returned tuple second. */
function statusOfReturnIn(
  statement: PyNode,
  pattern: PythonDiscoveryPattern,
  options: ReturnedStatusOptions,
): ReturnType<typeof statusOfReturn> {
  const constructed = returnedResponseStatus(statement, {
    calls: pattern.responseConstructors ?? [],
    module: options.module,
    facts: options.facts,
    constants: pattern.statusCodeConstants ?? {},
  });
  if (constructed !== null) {
    return constructed.type === "literal"
      ? { kind: "status", value: constructed.value }
      : { kind: "unreadable" };
  }
  if (pattern.statusFromReturnedTuple !== true) {
    return { kind: "none" };
  }
  return statusOfReturn(statement, options.facts);
}

interface ReturnedStatusOptions {
  module: ModuleBinding;
  facts: Database | undefined;
}

/**
 * The status a handler's own returns write: one built into a returned
 * response object, or one off the returned tuple for a library that reads
 * that. Anything less definite than a single status every return agrees
 * on claims nothing, so the library default does not take the place of a
 * status the body actually sets.
 */
function readReturnedStatus(
  pattern: PythonDiscoveryPattern,
  definitionNode: PyNode,
  options: ReturnedStatusOptions,
): Reading<number> {
  if (
    pattern.statusFromReturnedTuple !== true &&
    (pattern.responseConstructors ?? []).length === 0
  ) {
    return absentReading;
  }

  const range = rangeOf(definitionNode);
  const statuses = new Set<number>();
  let plainReturns = 0;
  let unreadable = 0;
  for (const statement of returnStatements(field(definitionNode, "body"))) {
    const read = statusOfReturnIn(statement, pattern, options);
    if (read.kind === "status") {
      statuses.add(read.value);
    } else if (read.kind === "none") {
      plainReturns += 1;
    } else {
      unreadable += 1;
    }
  }

  if (unreadable > 0) {
    return unreadableReading(
      "This route returns a status this reading cannot resolve to a number, so no status is claimed for it",
      range,
    );
  }

  if (statuses.size === 0) {
    return absentReading;
  }

  const candidates = [...statuses];
  if (statuses.size > 1 || plainReturns > 0) {
    return ambiguousReading(
      candidates,
      "This route returns more than one status depending on which branch runs, and nothing here reads which, so no status is claimed for it",
      range,
    );
  }

  return writtenReading(candidates[0] as number, range);
}

/** A status the decorator writes wins; otherwise whatever the body's returns say. */
function declaredOrReturnedStatus(
  declared: Reading<number>,
  returned: Reading<number>,
): Reading<number> {
  return declared.kind === "absent" ? returned : declared;
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
  classification: RouteDecorator,
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
  routes: readonly DeclaredRoute[],
  classification: RouteDecorator,
  functionNode: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RawCodeStructure[] {
  const functionName = field(functionNode, "name")?.text;
  if (functionName === undefined) {
    return [];
  }

  const ctx = createAnnotationContext(
    module.scopeFor,
    options.importedDefinition ?? null,
  );
  const wrappers = wrappersAround(
    pattern,
    pack,
    classification,
    functionNode,
    module,
    options,
  );
  const dependencyParameters = options.wrappers?.dependencyParameters(
    wrappers,
  ) ?? { names: new Set<string>(), declaresSource: false };
  const declaredStatuses = declaredStatusesOf(
    pattern,
    pack,
    classification,
    functionNode,
    module,
    options,
  );
  const pathArgument = readPathArgument(classification, options);
  const served = routes.flatMap((route) =>
    declaredRoutePaths(pattern, pathArgument, route).map((entry) => ({
      method: route.method,
      ...entry,
    })),
  );
  return served.flatMap((entry) =>
    routeUnitOrAbstention(
      {
        pack,
        name: functionName,
        exportPath: [functionName],
        dependencyParameters,
        declaredStatuses,
        method: entry.method,
        routePath: entry.routePath,
        ...(entry.mount !== undefined ? { mount: entry.mount } : {}),
        requestBodyFromAnnotatedClass:
          pattern.annotatedClassIsRequestBody === true,
        pattern,
        responseStatusCalls: pattern.responseStatusCalls ?? [],
        facts: options.facts,
        injectedCallees: new Set(pattern.injectedParameterCallees ?? []),
        definitionNode: functionNode,
        enclosingScope: module.moduleScope,
        module,
        filePath: options.filePath,
        skipReceiverParam: false,
        responseShape: readResponseModel(pattern, classification, module, ctx),
        statusCode: defaultedStatus(
          declaredOrReturnedStatus(
            readStatusCode(pattern, classification, {
              module,
              facts: options.facts,
            }),
            readReturnedStatus(pattern, functionNode, {
              module,
              facts: options.facts,
            }),
          ),
          pattern,
        ),
        definitionsCtx: ctx,
        storage: options.storage,
        importedDefinition: options.importedDefinition,
        wrappers,
      },
      options,
    ),
  );
}

/** The wrappers reaching one route, or none when the run has no wrapper index. */
function wrappersAround(
  pattern: PythonDiscoveryPattern,
  pack: PythonPack,
  classification: RouteDecorator,
  definitionNode: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): WrapperReference[] {
  if (options.wrappers === undefined) {
    return [];
  }
  return options.wrappers.wrappersFor(
    wrapperQuery(
      pattern,
      pack,
      classification,
      definitionNode,
      module,
      options,
    ),
  );
}

/** The route as the wrapper index asks about it. */
function wrapperQuery(
  pattern: PythonDiscoveryPattern,
  pack: PythonPack,
  classification: RouteDecorator,
  definitionNode: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): RouteWrapperQuery {
  return {
    pack,
    pattern,
    file: options.absoluteFile ?? options.filePath,
    module,
    classification,
    definitionNode,
  };
}

/**
 * The statuses the route's own code lists through the pattern's
 * `responsesKeyword`: on its decorator, and on each call the wrapper index
 * finds above it. A key that does not come to a number is left out.
 */
function declaredStatusesOf(
  pattern: DecoratedFunctionRoute,
  pack: PythonPack,
  classification: RouteDecorator,
  definitionNode: PyNode,
  module: ModuleBinding,
  options: DiscoveryOptions,
): number[] {
  const keyword = pattern.responsesKeyword;
  if (keyword === undefined) {
    return [];
  }
  const above =
    options.wrappers?.callsAbove(
      wrapperQuery(
        pattern,
        pack,
        classification,
        definitionNode,
        module,
        options,
      ),
    ) ?? [];
  const dictionaries = [
    classification.keywordArgs[keyword]?.node,
    ...above.map(
      (call) =>
        readCallArguments(field(call, "arguments")).keywordArgs[keyword]?.node,
    ),
  ].filter((node): node is PyNode => node?.type === "dictionary");
  const statuses = dictionaries.flatMap((dictionary) =>
    children(dictionary).flatMap((pair) => {
      const key = pair?.type === "pair" ? field(pair, "key") : null;
      const status =
        key === null
          ? null
          : statusNumberOf(key, {
              module: moduleOf(key),
              facts: options.facts,
              constants: pattern.statusCodeConstants ?? {},
            });
      return status === null ? [] : [status];
    }),
  );
  return [...new Set(statuses)].sort((a, b) => a - b);
}

interface BuildRouteUnitOptions {
  pack: PythonPack;
  name: string;
  exportPath: string[];
  method: string;
  /** The boundary binding only gets a path when this came back written. */
  routePath: Reading<PathTemplateReading>;
  requestBodyFromAnnotatedClass: boolean;
  /** The pattern the route matched, for what its returns say about the status. */
  pattern: PythonDiscoveryPattern;
  /** What the route's own decorator and parameters register around it, or nothing when the pack declares no wrapper forms. */
  wrappers?: WrapperReference[];
  /** The parameters the route's dependencies declare, which the library reads off the request too. */
  dependencyParameters?: {
    names: ReadonlySet<string>;
    declaresSource: boolean;
  };
  /** Statuses the route's own code lists as possible responses. */
  declaredStatuses?: number[];
  /** The library's own callables that end the request with a status. Empty when its pack declares none. */
  responseStatusCalls: readonly PyStatusCall[];
  /** The project's facts, so a status written as a name resolves the same way a path does. */
  facts?: Database | undefined;
  /** Names the pack says the library injects with, so those parameters claim no role. */
  injectedCallees: ReadonlySet<string>;
  definitionNode: PyNode;
  enclosingScope: Scope;
  module: ModuleBinding;
  filePath: string;
  skipReceiverParam: boolean;
  /** What the decorator declares. It takes precedence over the return annotation. */
  responseShape: Reading<TypeShape>;
  /** Handed to the extractor uncollapsed, so it applies the library default itself. */
  statusCode: DefaultedReading<number>;
  /** What a pack needs to decide that a call talks to the database. Absent when no pack declares storage. */
  storage?: StorageLookup | undefined;
  importedDefinition?: ImportedDefinitionLookup | undefined;
  definitionsCtx?: ReturnType<typeof createAnnotationContext>;
  /** Set when several mounts serve the router and this unit is one of them. */
  mount?: { siblings: number; prefix: string };
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

/** A route that cannot be turned into a unit costs that route alone, and the run goes on. */
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
    pattern,
    injectedCallees,
    definitionNode,
    enclosingScope,
    module,
    filePath,
    skipReceiverParam,
    statusCode,
    definitionsCtx,
    storage: storageLookup,
  } = options;

  const template = valueToReadFurtherFrom(routePath);
  const ctx =
    definitionsCtx ??
    createAnnotationContext(
      module.scopeFor,
      options.importedDefinition ?? null,
    );
  const parameters = readParameters(
    definitionNode,
    {
      scope: enclosingScope,
      ctx,
      pathParamNames: template?.paramNames ?? null,
      requestBodyFromAnnotatedClass,
      injectedCallees,
      injectedTypes: new Set(pattern.injectedParameterTypes ?? []),
      module,
      sources: pattern.parameterSources ?? {},
      aliasKeyword: pattern.parameterAliasKeyword,
    },
    skipReceiverParam,
  );

  const responseShape = readResponseShape(options.responseShape, () =>
    readReturnAnnotation(definitionNode, enclosingScope, ctx),
  );

  const calls = invocationSites(definitionNode, options.facts);
  const effects = calls.map((call) => call.effect);
  const extra = recognizedBodyEffects(
    definitionNode,
    storageLookup,
    options.facts,
  );
  const perTerminal = branchesPerTerminal({
    definitionNode,
    effects: calls,
    responseStatusCalls: options.responseStatusCalls,
    ctx: {
      pattern,
      responseShape,
      declaredStatus: statusCode,
      module,
      facts: options.facts,
    },
  });
  const branches: RawBranch[] = (perTerminal ?? []).map((branch) =>
    withBodyEffects(branch, extra),
  );
  // A route declaring neither a body shape nor a status still gets a default
  // branch when its body has effects, since an effect with no transition to
  // go on would be dropped.
  if (
    perTerminal === null &&
    (responseShape.reading.kind !== "absent" ||
      statusCode.reading.kind !== "absent" ||
      extra.effects.length > 0 ||
      effects.length > 0)
  ) {
    const bare: RawBranch = {
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
      effects,
      location: rangeOf(definitionNode),
      isDefault: true,
    };
    branches.push(withBodyEffects(bare, extra));
  }
  if (branches.length > 0) {
    branches.push(
      ...validationFailureBranches(
        pattern,
        readsTheRequest(
          parameters,
          template,
          options.dependencyParameters ?? {
            names: new Set(),
            declaresSource: false,
          },
        ),
        rangeOf(definitionNode),
      ),
    );
  }

  const bodyNode = field(definitionNode, "body");

  return {
    identity: {
      name,
      nameKind: "binding",
      kind: "handler",
      file: filePath,
      range: rangeOf(definitionNode),
      span: spanOf(definitionNode),
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
      ...(template === null
        ? unreadRoleReadings(parameters, rangeOf(definitionNode))
        : []),
      ...responseShape.passedOver,
    ],
    ...(collectedDefinitions(ctx) !== null
      ? { definitions: collectedDefinitions(ctx) }
      : {}),
    ...(options.mount !== undefined ? { mount: options.mount } : {}),
    ...(options.wrappers !== undefined && options.wrappers.length > 0
      ? { wrappers: options.wrappers }
      : {}),
    ...(pack.requestSpelling === undefined
      ? {}
      : { requestSpelling: pack.requestSpelling }),
    ...(options.declaredStatuses !== undefined &&
    options.declaredStatuses.length > 0
      ? { declaredStatuses: options.declaredStatuses }
      : {}),
  };
}

/**
 * Whether the route reads anything the library validates first: one of
 * its own parameters, or one a dependency declares as a source or as a
 * parameter of the route's path. A path parameter nothing declares is not.
 */
function readsTheRequest(
  parameters: readonly RawParameter[],
  template: PathTemplateReading | null,
  dependencies: { names: ReadonlySet<string>; declaresSource: boolean },
): boolean {
  if (
    dependencies.declaresSource ||
    parameters.some((parameter) => parameter.role !== null)
  ) {
    return true;
  }
  return [...(template?.paramNames ?? [])].some((name) =>
    dependencies.names.has(name),
  );
}

/**
 * The response the library sends on its own when a request input the
 * route reads fails validation. The body never runs on that path, so the
 * branch has no effects. None when the route reads nothing off the request.
 */
function validationFailureBranches(
  pattern: PythonDiscoveryPattern,
  readsRequest: boolean,
  range: SourceRange,
): RawBranch[] {
  const status = pattern.validationFailureStatus;
  if (status === undefined || !readsRequest) {
    return [];
  }
  return [
    {
      conditions: [
        {
          sourceText: "request input fails validation",
          structured: null,
          polarity: "positive",
          source: "earlyThrow",
        },
      ],
      terminal: {
        kind: "response",
        statusCode: { type: "literal", value: status },
        body: null,
        exceptionType: null,
        message: null,
        component: null,
        renderTree: null,
        delegateTarget: null,
        emitEvent: null,
        location: range,
      },
      effects: [],
      location: range,
      isDefault: false,
    },
  ];
}

/** One reading covers every parameter, because an unread path is the same reason for all of them. An injected parameter also has no role, but for a different reason, and it does not trigger this. */
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

/** What a body does besides calling, and where the values its effects are given came from. */
export interface BodyEffects {
  effects: PlacedEffect<Effect>[];
  provenance: RawProvenance[];
}

/** What a body does besides calling: config it reads, database work, SQL it writes itself, jobs it enqueues. */
export function recognizedBodyEffects(
  definitionNode: PyNode,
  storageLookup: StorageLookup | undefined,
  facts: Database | undefined,
): BodyEffects {
  const storage =
    storageLookup === undefined
      ? { effects: [], slots: [] }
      : bodyStorage(definitionNode, storageLookup);
  const found = besidesCallsWith(definitionNode, storage, facts);
  const siteOf = effectSitesIn(
    field(definitionNode, "body"),
    found.map((one) => one.at),
  );
  return {
    effects: found.map(({ effect, at }) => ({ effect, site: siteOf(at) })),
    provenance:
      storage.slots.length === 0 || storageLookup === undefined
        ? []
        : slotProvenance(storage.slots, {
            facts: storageLookup.facts,
            unit: definitionNode,
          }),
  };
}

/**
 * Each effect a function's body makes besides calling, beside the node it
 * was read at: a def's, or a lambda's, such as one a pack claims as a
 * unit of its own.
 */
export function effectsBesidesCalls(
  definitionNode: PyNode,
  storageLookup: StorageLookup | undefined,
  facts: Database | undefined,
): EffectAt[] {
  const storage =
    storageLookup === undefined
      ? { effects: [] }
      : bodyStorage(definitionNode, storageLookup);
  return besidesCallsWith(definitionNode, storage, facts);
}

function besidesCallsWith(
  definitionNode: PyNode,
  storage: { effects: readonly EffectAt[] },
  facts: Database | undefined,
): EffectAt[] {
  const stdlib =
    facts === undefined
      ? { reads: [], writes: [] }
      : stdlibEffects(definitionNode, facts);
  return [
    ...stdlib.reads,
    ...storage.effects,
    ...stdlib.writes,
    ...enqueueEffects(definitionNode, facts),
  ];
}

/** A branch with the body's own effects that run before its terminal, and where their values came from. */
export function withBodyEffects(
  branch: RawBranch,
  extra: BodyEffects,
): RawBranch {
  const effects = effectsFiringOn(extra.effects, branch);
  if (effects.length === 0) {
    return branch;
  }
  return {
    ...branch,
    extraEffects: effects,
    ...(extra.provenance.length === 0 ? {} : { provenance: extra.provenance }),
  };
}

/** Which of these calls a pack already read the meaning of, by node id, so the reach walk does not report them as lost. */
export function recognizedCallIds(
  calls: readonly PyNode[],
  storageLookup: StorageLookup | undefined,
  facts: Database | undefined,
): ReadonlySet<number> {
  const enqueues = enqueuesAmong(calls, facts).map(({ call }) => call.id);
  if (storageLookup === undefined) {
    return new Set(enqueues);
  }
  return new Set([...declaredCallIds(calls, storageLookup), ...enqueues]);
}

/** Whether a body contains only a docstring and/or a bare `pass`, or something more. */
export function bodyContentOf(bodyNode: PyNode): BodyContent {
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

/** What reading a route's parameters needs besides the parameters themselves. */
interface ParameterReading {
  scope: Scope;
  ctx: ReturnType<typeof createAnnotationContext>;
  pathParamNames: ReadonlySet<string> | null;
  requestBodyFromAnnotatedClass: boolean;
  injectedCallees: ReadonlySet<string>;
  injectedTypes: ReadonlySet<string>;
  module: ModuleBinding;
  sources: Readonly<Record<string, ParameterSource>>;
  aliasKeyword: string | undefined;
}

function readParameters(
  definitionNode: PyNode,
  reading: ParameterReading,
  skipReceiverParam: boolean,
): RawParameter[] {
  const parametersNode = field(definitionNode, "parameters");
  if (parametersNode === null) {
    return [];
  }

  const out: RawParameter[] = [];
  let position = 0;
  for (const param of children(parametersNode)) {
    if (skipReceiverParam && position === 0 && isReceiverParam(param)) {
      position += 1;
      continue;
    }
    const parsed = readParameter(param, reading, position);
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
  reading: ParameterReading,
  position: number,
): RawParameter | null {
  const info = parameterNameAndType(param);
  if (info === null) {
    return null;
  }
  const { name, typeNode } = info;
  const shape =
    typeNode !== null
      ? annotationToShape(typeNode, reading.scope, reading.ctx)
      : null;
  const typeText = typeNode !== null ? typeNode.text : null;
  if (
    isInjectedParameter(param, reading) ||
    isInjectedType(typeNode, reading)
  ) {
    return { name, position, role: null, typeText };
  }
  const declared = declaringCall(
    param,
    new Set(Object.keys(reading.sources)),
    reading,
  );
  const source =
    declared === null ? undefined : reading.sources[calleeName(declared) ?? ""];
  const role =
    source?.role ??
    roleOf(
      name,
      shape,
      reading.pathParamNames,
      reading.requestBodyFromAnnotatedClass,
    );
  const which =
    role === null ? null : fieldOf(name, shape, declared, source, reading);
  return {
    name,
    position,
    role,
    ...(which === null ? {} : { field: which }),
    typeText,
  };
}

/**
 * Which field of the request part the parameter is: the name the call
 * gives under the alias keyword, or the parameter's own name as the
 * library writes it. A class annotation on the body is the whole body.
 */
function fieldOf(
  name: string,
  shape: TypeShape | null,
  declared: PyNode | null,
  source: ParameterSource | undefined,
  reading: ParameterReading,
): string | null {
  const alias =
    declared === null || reading.aliasKeyword === undefined
      ? null
      : keywordString(declared, reading.aliasKeyword);
  if (alias !== null) {
    return alias;
  }
  if (isModel(shape) && (source === undefined || isBody(source))) {
    return null;
  }
  return source?.underscoresAs === undefined
    ? name
    : name.replaceAll("_", source.underscoresAs);
}

function isModel(shape: TypeShape | null): boolean {
  return shape?.type === "ref" && shape.def !== undefined;
}

function isBody(source: ParameterSource): boolean {
  return source.role === REQUEST_BODY_ROLE;
}

/** The string a call passes under a keyword, or null when it passes none written out. */
function keywordString(call: PyNode, keyword: string): string | null {
  const args = field(call, "arguments");
  for (const argument of args === null ? [] : children(args)) {
    if (
      argument.type === "keyword_argument" &&
      field(argument, "name")?.text === keyword
    ) {
      const value = field(argument, "value");
      return value === null ? null : stringLiteralValue(value);
    }
  }
  return null;
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
  if (requestBodyFromAnnotatedClass && isModel(shape)) {
    return REQUEST_BODY_ROLE;
  }
  if (pathParamNames === null) {
    return null;
  }

  return "queryParams";
}

/** The role of the parameter a route is handed the request body in. */
const REQUEST_BODY_ROLE = "requestBody";

/** How far into an annotation the search for an injector call goes. `Annotated[T, Depends(f)]` needs three, and the rest is headroom. */
const MAX_ANNOTATION_DEPTH = 6;

/** The callee's own name, for `Depends(...)` and for `fastapi.Depends(...)` alike. */
function calleeName(call: PyNode): string | null {
  const callee = field(call, "function");
  if (callee === null) {
    return null;
  }
  if (callee.type === "identifier") {
    return callee.text;
  }
  if (callee.type === "attribute") {
    return field(callee, "attribute")?.text ?? null;
  }
  return null;
}

/**
 * Whether the library supplies this parameter itself. The value is written
 * either as the default (`user: User = Depends(get_user)`) or inside an
 * `Annotated[...]` annotation, which is the spelling FastAPI's own docs
 * moved to, and both mean the client sends nothing. The annotation may
 * also be a name for one of those, `db: SessionDep` with
 * `SessionDep = Annotated[Session, Depends(get_db)]` assigned in this
 * file or another, and that is read the same way.
 */
function isInjectedParameter(
  param: PyNode,
  reading: ParameterReading,
): boolean {
  return declaringCall(param, reading.injectedCallees, reading) !== null;
}

/**
 * Whether the parameter's annotation is a class the library supplies a
 * value for, `resp: Response`, read through what the file imported the
 * name from so a project's own `Response` class is not mistaken for it.
 */
function isInjectedType(
  typeNode: PyNode | null,
  reading: ParameterReading,
): boolean {
  if (typeNode === null || reading.injectedTypes.size === 0) {
    return false;
  }
  // The grammar wraps an annotation's expression in a `type` node.
  const written =
    typeNode.type === "type" ? (typeNode.namedChild(0) ?? null) : typeNode;
  const origin = written === null ? null : originOf(written, reading.module);
  return (
    origin !== null &&
    reading.injectedTypes.has(`${origin.module}.${origin.name}`)
  );
}

/**
 * The call of one of `callees` a parameter is declared with, as its
 * default or inside its annotation, the way `isInjectedParameter` reads
 * `Depends`. Null when it is declared with none of them.
 */
function declaringCall(
  param: PyNode,
  callees: ReadonlySet<string>,
  reading: Pick<ParameterReading, "scope" | "ctx">,
): PyNode | null {
  if (callees.size === 0) {
    return null;
  }

  const isOne = (node: PyNode): boolean => {
    const name = calleeName(node);
    return node.type === "call" && name !== null && callees.has(name);
  };

  const byDefault = field(param, "value");
  if (byDefault !== null && isOne(byDefault)) {
    return byDefault;
  }

  // `Annotated[User, Depends(get_user)]` wraps the call in a generic type
  // and a type parameter, so the search has to go down rather than read
  // the annotation's own children.
  const followed = new Set<number>();
  const inside = (
    node: PyNode | null,
    nodeScope: Scope,
    depth: number,
  ): PyNode | null => {
    if (node === null || depth > MAX_ANNOTATION_DEPTH) {
      return null;
    }
    if (isOne(node)) {
      return node;
    }
    if (node.type === "identifier" && !followed.has(node.id)) {
      followed.add(node.id);
      const alias = aliasValueOf(node.text, nodeScope, reading.ctx);
      const found = alias === null ? null : inside(alias.node, alias.scope, 0);
      if (found !== null) {
        return found;
      }
    }
    for (const child of children(node)) {
      const found = inside(child, nodeScope, depth + 1);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };

  return inside(field(param, "type"), reading.scope, 0);
}
