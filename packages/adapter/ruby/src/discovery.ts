/**
 * Discovers the units a Ruby file defines: GraphQL fields declared through
 * a class DSL, controller actions, and client calls.
 *
 * A field's boundary binding and declared contract come from the
 * arguments of its own DSL call. A field written with one of the pack's
 * wiring keywords declares no type of its own, so its contract and the
 * method behind it are read from the class the keyword points at, one hop
 * away. DESIGN.md describes what a field's summary says about the method
 * behind it and where the reading stops.
 */

import {
  dispatchByType,
  graphqlResolverBinding,
  restBinding,
} from "@suss/behavioral-ir";
import { absentReading, unreadableReading } from "@suss/extractor";

import {
  ancestryOf,
  inheritedStatements,
  methodInAncestry,
  reachConstant,
} from "./ancestry.js";
import {
  booleanLiteralValue,
  field,
  instanceMethodsByName,
  instanceMethodVisibility,
  methodHasStatements,
  rangeOf,
  readCallArgs,
  runStatements,
  spanOf,
  symbolValue,
} from "./ast.js";
import { askClientCallReads, clientCallUnits } from "./clientCalls.js";
import { envReadEffects } from "./envReads.js";
import {
  controllerFilters,
  filterCoversAction,
  filterReference,
  filterUnit,
} from "./filters.js";
import { EVERY_ARGLESS_CALL, invocationEffects } from "./paths/effects.js";
import { responseBranches } from "./responseStatus.js";
import {
  constantRefCandidates,
  graphqlTypeNameFromQualified,
  walkDefinitions,
} from "./scope.js";
import { type RbStorageOptions, storageEffects } from "./storage.js";
import { typeShapeFromNode } from "./typeShape.js";

import type {
  DispatchTable,
  Effect,
  GraphqlDeclaredContract,
  TypeShape,
  WrapperReference,
} from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  BodyContent,
  RawBranch,
  RawCodeStructure,
  RawEffect,
  RawParameter,
  Reading,
} from "@suss/extractor";
import type {
  AncestorLookup,
  Ancestry,
  BodyReading,
  MethodLookup,
  ReachedBody,
} from "./ancestry.js";
import type { BlockConfigures, BodyBlocks, CallArgs, Range } from "./ast.js";
import type { ClientCallOptions } from "./clientCalls.js";
import type { DynamicNames } from "./defineMethod.js";
import type {
  ControllerActions,
  GraphqlObjectFields,
  RubyDiscoveryPattern,
  RubyPack,
} from "./pack.js";
import type { RbNode } from "./parser.js";
import type { InheritedMethods } from "./paths/effects.js";
import type { ClassInfo } from "./scope.js";
import type { TypeReadContext } from "./typeShape.js";

/** Parsed files by absolute path, so a class that several fields refer to is only parsed once. */
export interface FileCache {
  get(absPath: string): Promise<RbNode | null>;
}

export function createFileCache(
  parse: (source: string) => Promise<RbNode>,
  readFile: (absPath: string) => string | null,
): FileCache {
  const trees = new Map<string, RbNode | null>();
  return {
    async get(absPath: string): Promise<RbNode | null> {
      const cached = trees.get(absPath);
      if (cached !== undefined) {
        return cached;
      }
      const source = readFile(absPath);
      const tree = source !== null ? await parse(source) : null;
      trees.set(absPath, tree);
      return tree;
    },
  };
}

/**
 * What reading a method body needs from the run's packs. Any options
 * object that has these fields, `DiscoveryOptions` among them, can be
 * passed straight through.
 */
export interface BodyReadOptions {
  /** The run's facts, which the value evaluator reads names through. Absent in a test that builds one file by hand. */
  readonly facts?: Database | undefined;
  /** The storage patterns that decide whether a call reads or writes the database. Absent when no pack declares any. */
  readonly storage?: RbStorageOptions | undefined;
  /** The methods the run's packs declare their libraries define. Calls to them are left off an effect list. */
  readonly inheritedMethods?: InheritedMethods | undefined;
  /** The calls whose block the run's packs declare runs as part of the surrounding body. */
  readonly bodyBlocks?: BodyBlocks | undefined;
  /** The methods each class defines under a name computed at run time, by class key. */
  readonly dynamicNames?: DynamicNames | undefined;
}

export interface DiscoveryOptions extends BodyReadOptions {
  packs: RubyPack[];
  /** Repo-relative or absolute path recorded on each summary's `location.file`. */
  filePath: string;
  /** Absolute path of the file being read, used for `ReachedBody.file`. Falls back to `filePath` for a source that is not on disk. */
  absoluteFile?: string;
  /** The `location.file` to record for another file, needed when a controller's filters come from an ancestor in another file. */
  displayPathOf?: (absolute: string) => string;
  cache: FileCache;
  /** Called once for each discovered unit whose body is a method, so the reach walk can start from it. */
  onReachSeed?: (raw: RawCodeStructure, seed: ReachSeed) => void;
}

/** The method behind a discovered unit, and where it is, so the reach walk can start there as it does at any `def`. */
export interface ReachSeed {
  readonly file: string;
  readonly node: RbNode;
  /** The class the method is written in, or null for one written outside any class. */
  readonly enclosingQualifiedName: string | null;
}

/** What a bare constant is resolved against: the nesting in effect, plus every class the file defines so shadowing can be detected. */
interface FileScope {
  nesting: readonly string[];
  knownClasses: ReadonlySet<string>;
}

interface FieldReadContext {
  pattern: GraphqlObjectFields;
  cache: FileCache;
  lookup: AncestorLookup;
  bodyRead: BodyReadOptions;
  facts: Database | undefined;
  /** The facts and body options again, in the form an ancestry lookup takes. */
  read: BodyReading;
}

function fieldReadContext(
  pattern: GraphqlObjectFields,
  cache: FileCache,
  fileBlocks: readonly ReachedBody[],
  bodyRead: BodyReadOptions,
  facts?: Database,
): FieldReadContext {
  return {
    pattern,
    cache,
    bodyRead,
    facts,
    read: {
      facts,
      bodyBlocks: bodyRead.bodyBlocks,
      dynamicNames: bodyRead.dynamicNames,
    },
    lookup: {
      root: pattern.root,
      pathConvention: pattern.pathConvention,
      acronyms: pattern.acronyms ?? [],
      ancestryRootClassNames: pattern.ancestryRootClassNames,
      parsedFile: (absPath) => cache.get(absPath),
      localDefinition: (name) => sameFileBlocks(name, fileBlocks),
    },
  };
}

/** The blocks the current file defines under `name`, or null so the walk falls back to the path convention. */
function sameFileBlocks(
  name: string,
  fileBlocks: readonly ReachedBody[],
): ReachedBody[] | null {
  const matches = fileBlocks.filter(
    (block) => block.info.qualifiedName === name,
  );
  return matches.length === 0 ? null : matches;
}

function typeContext(
  scope: FileScope,
  pattern: GraphqlObjectFields,
): TypeReadContext {
  return {
    nesting: scope.nesting,
    knownClasses: scope.knownClasses,
    scalars: pattern.scalars,
    scalarNamePrefixes: pattern.scalarNamePrefixes,
    typeNameConvention: pattern.typeNameConvention,
  };
}

export async function discoverUnits(
  root: RbNode,
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  const classes: ClassInfo[] = [];
  // Modules are included because a graphql-ruby interface is a module
  // that mixes in the interface base and declares fields the same way.
  walkDefinitions(root, (info) => classes.push(info));
  const knownClasses = new Set(classes.map((info) => info.qualifiedName));

  const fileBlocks: ReachedBody[] = classes.map((info) => ({
    info,
    knownClasses,
    file: options.absoluteFile ?? options.filePath,
  }));

  const units: RawCodeStructure[] = [];
  const clientOptions: ClientCallOptions = {
    filePath: options.filePath,
    ...(options.facts === undefined ? {} : { facts: options.facts }),
  };
  askClientCallReads(
    root,
    options.packs.flatMap((pack) => pack.clients ?? []),
    clientOptions,
  );
  for (const pack of options.packs) {
    for (const pattern of pack.clients ?? []) {
      units.push(...clientCallUnits(root, pack, pattern, clientOptions));
    }
  }

  for (const info of classes) {
    // A class reopened in the same file is still one class, so a method in
    // a later block can override a field declared in an earlier one.
    const ownBlocks = fileBlocks.filter(
      (block) => block.info.qualifiedName === info.qualifiedName,
    );
    for (const pack of options.packs) {
      for (const pattern of pack.discovery) {
        units.push(
          ...(await unitsFor(
            pattern,
            pack,
            info,
            ownBlocks,
            fileBlocks,
            options,
          )),
        );
      }
    }
  }
  return units;
}

/**
 * Whether a class or module inherits from, or mixes in, one of the pack's
 * base classes, however many project bases are in between (#247). A base
 * the walk could not open stays in the ancestry under its written name,
 * so it still matches.
 */
function reachesConfiguredBase(
  ancestry: Ancestry,
  self: string,
  baseClassNames: readonly string[],
): boolean {
  return ancestry.some(
    (entry) => entry.name !== self && baseClassNames.includes(entry.name),
  );
}

function unitsFor(
  pattern: RubyDiscoveryPattern,
  pack: RubyPack,
  info: ClassInfo,
  ownBlocks: readonly ReachedBody[],
  fileBlocks: readonly ReachedBody[],
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  const table: DispatchTable<
    RubyDiscoveryPattern,
    Promise<RawCodeStructure[]>
  > = {
    graphqlObjectFields: (p) =>
      graphqlObjectFieldUnits(p, pack, info, ownBlocks, fileBlocks, options),
    controllerActions: (p) =>
      controllerActionUnits(p, pack, info, ownBlocks, fileBlocks, options),
  };
  return dispatchByType(table, pattern);
}

async function graphqlObjectFieldUnits(
  pattern: GraphqlObjectFields,
  pack: RubyPack,
  info: ClassInfo,
  ownBlocks: readonly ReachedBody[],
  fileBlocks: readonly ReachedBody[],
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  if (
    info.bodyNode === null ||
    pattern.baseClassNames.includes(info.qualifiedName)
  ) {
    return [];
  }
  const ctx = fieldReadContext(
    pattern,
    options.cache,
    fileBlocks,
    options,
    options.facts,
  );
  const ancestry = await ancestryOf(info.qualifiedName, ownBlocks, ctx.lookup);
  if (
    !reachesConfiguredBase(ancestry, info.qualifiedName, pattern.baseClassNames)
  ) {
    return [];
  }
  const typeName = graphqlTypeNameFromQualified(
    info.qualifiedName,
    pattern.typeNameConvention,
  );
  const knownClasses = ownBlocks[0]?.knownClasses ?? new Set<string>();
  const scope: FileScope = { nesting: info.bodyNesting, knownClasses };

  // The library stores fields by name, so a field declared again later in
  // the body replaces the earlier one. Keying on the field name matches that.
  const declsByName = new Map<string, FieldDeclaration>();
  for (const stmt of runStatements(
    info.bodyNode,
    blockConfiguresCall(pattern),
  )) {
    const decl = await readFieldCall(stmt, scope, ctx, ancestry);
    if (decl !== null) {
      declsByName.set(decl.fieldName, decl);
    }
  }
  return [...declsByName.values()].map((decl) => {
    const raw = buildFieldUnit(pack, typeName, decl, options.filePath);
    if (decl.body.reachSeed !== undefined) {
      options.onReachSeed?.(raw, decl.body.reachSeed);
    }
    return raw;
  });
}

/**
 * Every public instance method a controller defines directly is an
 * action. Rails dispatches only to public methods, so a private or
 * protected one is not discovered here, though the reach walk still
 * gives it a summary once something calls it. Each action becomes a unit,
 * bound when `routeFor` finds a route and unbound otherwise, and the
 * reach walk starts from it either way.
 */
async function controllerActionUnits(
  pattern: ControllerActions,
  pack: RubyPack,
  info: ClassInfo,
  ownBlocks: readonly ReachedBody[],
  fileBlocks: readonly ReachedBody[],
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  if (
    info.bodyNode === null ||
    pattern.baseClassNames.includes(info.qualifiedName)
  ) {
    return [];
  }
  const lookup: AncestorLookup = {
    root: pattern.root,
    pathConvention: pattern.pathConvention,
    acronyms: pattern.acronyms ?? [],
    ancestryRootClassNames: pattern.ancestryRootClassNames,
    parsedFile: (absPath) => options.cache.get(absPath),
    localDefinition: (name) => sameFileBlocks(name, fileBlocks),
  };
  const ancestry = await ancestryOf(info.qualifiedName, ownBlocks, lookup);
  // A class that extends one of the library's root classes directly, with
  // no project base in between, is a controller too.
  if (
    !reachesConfiguredBase(ancestry, info.qualifiedName, [
      ...pattern.baseClassNames,
      ...pattern.ancestryRootClassNames,
    ])
  ) {
    return [];
  }

  const filters = controllerFilters(pattern, ancestry, {
    facts: options.facts,
    bodyBlocks: options.bodyBlocks,
    dynamicNames: options.dynamicNames,
  });
  const units: RawCodeStructure[] = [];

  for (const filter of filters) {
    const displayPath = options.displayPathOf?.(filter.file) ?? filter.file;
    const raw = filterUnit(
      filter,
      pattern,
      displayPath,
      bodyOfMethod(filter.method, filter.file, options),
      options.facts,
    );
    units.push(raw);
    options.onReachSeed?.(raw, {
      file: filter.file,
      node: filter.method,
      enclosingQualifiedName: filter.enclosingQualifiedName,
    });
  }

  const emitAction = (
    actionName: string,
    method: RbNode,
    block: ReachedBody,
  ) => {
    const around = filters
      .filter((filter) => filterCoversAction(filter, actionName))
      .map((filter) =>
        filterReference(
          filter,
          options.displayPathOf?.(filter.file) ?? filter.file,
        ),
      );
    const raw = buildControllerActionUnit(
      pack,
      pattern,
      info.qualifiedName,
      actionName,
      method,
      {
        display:
          block.file === (options.absoluteFile ?? options.filePath)
            ? options.filePath
            : (options.displayPathOf?.(block.file) ?? block.file),
        absolute: block.file,
      },
      options,
      around,
    );
    units.push(raw);
    options.onReachSeed?.(raw, {
      file: block.file,
      node: method,
      enclosingQualifiedName: block.info.qualifiedName,
    });
  };

  const own = new Set<string>();
  for (const [actionName, method, block] of publicInstanceMethods(
    ownBlocks,
    options.bodyBlocks,
  )) {
    own.add(actionName);
    emitAction(actionName, method, block);
  }

  // Rails dispatches a routed action to whichever ancestor defines it, so
  // a subclass with a route to `show` and no `show` of its own runs the base's.
  const seen = new Set(own);
  for (const entry of ancestry) {
    if (entry.type !== "bodies" || entry.name === info.qualifiedName) {
      continue;
    }
    for (const [actionName, method, block] of publicInstanceMethods(
      entry.blocks,
      options.bodyBlocks,
    )) {
      if (seen.has(actionName)) {
        continue;
      }
      seen.add(actionName);
      if (pattern.routeFor(info.qualifiedName, actionName) === null) {
        continue;
      }
      emitAction(actionName, method, block);
    }
  }
  return units;
}

/** Every public instance method the blocks define, with the block it is written in, in source order. */
function publicInstanceMethods(
  blocks: readonly ReachedBody[],
  bodyBlocks: BodyBlocks | undefined,
): Array<[string, RbNode, ReachedBody]> {
  const found: Array<[string, RbNode, ReachedBody]> = [];
  for (const block of blocks) {
    if (block.info.bodyNode === null) {
      continue;
    }
    const visibility = instanceMethodVisibility(block.info.bodyNode);
    for (const [name, method] of instanceMethodsByName(
      block.info.bodyNode,
      bodyBlocks,
    )) {
      if ((visibility.get(name) ?? "public") === "public") {
        found.push([name, method, block]);
      }
    }
  }
  return found;
}

function buildControllerActionUnit(
  pack: RubyPack,
  pattern: ControllerActions,
  controllerQualifiedName: string,
  actionName: string,
  method: RbNode,
  file: { display: string; absolute: string },
  bodyRead: BodyReadOptions,
  wrappers: readonly WrapperReference[] = [],
): RawCodeStructure {
  const range = rangeOf(method);
  const route = pattern.routeFor(controllerQualifiedName, actionName);
  const body = bodyOfMethod(method, file.absolute, bodyRead);
  const perResponse = responseBranches(
    method,
    pattern,
    body.effects ?? [],
    body.extraEffects,
    { facts: bodyRead.facts },
  );
  return {
    identity: {
      name: actionName,
      nameKind: "binding",
      kind: "handler",
      file: file.display,
      range,
      span: spanOf(method),
      exportName: actionName,
      exportPath: [controllerQualifiedName, actionName],
    },
    boundaryBinding:
      route === null
        ? null
        : restBinding({
            transport: pack.protocol,
            method: route.method,
            path: route.path,
            recognition: pack.name,
          }),
    parameters: [],
    branches: perResponse ?? [
      {
        conditions: [],
        terminal: {
          kind: "response",
          statusCode: null,
          body: null,
          exceptionType: null,
          message: null,
          component: null,
          renderTree: null,
          delegateTarget: null,
          emitEvent: null,
          location: range,
        },
        statusCodeReading: {
          reading: absentReading,
          libraryDefault: pattern.defaultStatusCode,
        },
        effects: body.effects ?? [],
        ...(body.extraEffects === undefined
          ? {}
          : { extraEffects: body.extraEffects }),
        location: range,
        isDefault: true,
      },
    ],
    bodyContent: body.bodyContent ?? "absent",
    dependencyCalls: [],
    declaredContract: null,
    ...(wrappers.length > 0 ? { wrappers: [...wrappers] } : {}),
  };
}

/**
 * A unit with no boundary and no calls, recording the routing
 * declarations this pattern could not read. Build it once per pattern,
 * after every file has been discovered, and not once per controller.
 */
export function routingGapUnit(
  pattern: ControllerActions,
  gaps: readonly string[],
): RawCodeStructure {
  const range = { start: 1, end: 1 };
  return {
    identity: {
      name: "routes",
      kind: "module-init",
      file: pattern.routesFile,
      range,
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: null,
    parameters: [],
    branches: [
      {
        conditions: [],
        terminal: {
          kind: "void",
          statusCode: null,
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
        isDefault: true,
      },
    ],
    readings: gaps.map((gap) => unreadableReading(gap, range)),
    dependencyCalls: [],
    declaredContract: null,
  };
}

/**
 * A block on one of the pack's DSL calls configures that call.
 * `field :x, String do argument :q, String end` declares an argument on
 * the field, so reading the block as part of the class body would put the
 * argument on the class.
 */
function blockConfiguresCall(pattern: GraphqlObjectFields): BlockConfigures {
  const names = new Set([
    pattern.fieldCallName,
    pattern.typeCallName,
    pattern.argumentCallName,
  ]);
  return (call) => {
    const method = field(call, "method")?.text;
    return (
      field(call, "receiver") === null &&
      method !== undefined &&
      names.has(method)
    );
  };
}

interface ArgDeclaration {
  name: string;
  type: TypeShape;
  required: boolean;
  typeText: string | null;
}

interface FieldContract {
  returnType: TypeShape;
  /** The arguments the schema exposes on the wire. */
  args: ArgDeclaration[];
  /**
   * When argument wrapping applies, the declared arguments as written.
   * The library unwraps the input object before calling the resolver
   * method, so the method's parameters match these instead of `args`.
   */
  methodArgs?: ArgDeclaration[];
}

interface FieldDeclaration {
  fieldName: string;
  /** False when the name is computed at run time, so no wire name can be matched against it. */
  namedOnTheWire: boolean;
  node: RbNode;
  contract: FieldContract | null;
  body: BodyReport;
}

/** One branch recording what the resolver does, or none when nothing was read of it. */
function branchesFor(body: BodyReport, range: Range): RawBranch[] {
  if (body.effects === undefined && body.extraEffects === undefined) {
    return [];
  }
  return [
    {
      conditions: [],
      terminal: {
        kind: "void",
        statusCode: null,
        body: null,
        exceptionType: null,
        message: null,
        component: null,
        renderTree: null,
        delegateTarget: null,
        emitEvent: null,
        location: range,
      },
      effects: body.effects ?? [],
      ...(body.extraEffects === undefined
        ? {}
        : { extraEffects: body.extraEffects }),
      location: range,
      isDefault: true,
    },
  ];
}

/** A field's contract and the method behind it, read together because a wiring keyword decides both. */
interface FieldReading {
  contract: FieldContract | null;
  body: BodyReport;
}

export interface BodyReport {
  /**
   * Left unset when no value would be accurate. The extractor writes its
   * own sentence from this field, and `readings` has a more accurate one.
   */
  bodyContent?: BodyContent;
  readings: Reading<unknown>[];
  /** The calls the method makes, each with the conditions it runs under. */
  effects?: RawEffect[];
  /** Effects a recognizer built in IR form, such as database work. */
  extraEffects?: Effect[];
  /** Set when this body came from a method, so the reach walk can follow the calls it makes. */
  reachSeed?: ReachSeed;
}

/** `file` is the absolute path the method was read from, which the storage recognizer keys constant bindings on. */
export function bodyOfMethod(
  method: RbNode,
  file: string,
  bodyRead: BodyReadOptions = {},
): BodyReport {
  // Every call with no arguments goes on the list, and the reach walk
  // removes the ones that turn out to be property reads.
  const effects = invocationEffects(
    method,
    bodyRead.inheritedMethods,
    EVERY_ARGLESS_CALL,
    bodyRead.facts,
  );
  const storage = bodyRead.storage;
  const facts = bodyRead.facts;
  const extra = [
    ...envReadEffects(
      method,
      facts === undefined ? undefined : { db: facts, file },
    ),
    ...(storage === undefined
      ? []
      : storageEffects(callsUnder(method), file, storage, method)),
  ];
  return {
    bodyContent: methodHasStatements(method) ? "statements" : "empty",
    readings: [],
    ...(effects.length > 0 ? { effects } : {}),
    ...(extra.length > 0 ? { extraEffects: extra } : {}),
  };
}

function callsUnder(node: RbNode, found: RbNode[] = []): RbNode[] {
  for (const child of node.namedChildren) {
    if (child === null) {
      continue;
    }
    if (child.type === "call") {
      found.push(child);
    }
    callsUnder(child, found);
  }
  return found;
}

/** A field with no method behind it: the library reads the attribute off the object the field was resolved against, so there is no body to read. */
const NO_METHOD_BEHIND_IT: BodyReport = {
  bodyContent: "absent",
  readings: [],
};

function methodNotSettled(reason: string, range: Range): BodyReport {
  return { readings: [unreadableReading(reason, range)] };
}

/**
 * The body report for an ancestry lookup. `nothingThere` is the report to
 * give when the lookup read the whole ancestry and found no method.
 */
function bodyFromLookup(
  found: MethodLookup,
  range: Range,
  subject: string,
  nothingThere: BodyReport,
  bodyRead: BodyReadOptions,
): BodyReport {
  const table: DispatchTable<MethodLookup, BodyReport> = {
    found: (lookup) => ({
      ...bodyOfMethod(lookup.method, lookup.block.file, bodyRead),
      reachSeed: {
        file: lookup.block.file,
        node: lookup.method,
        enclosingQualifiedName: lookup.block.info.qualifiedName,
      },
    }),
    unsettled: (lookup) =>
      methodNotSettled(
        `${subject} could be answered by a method ${lookup.reason}, so whether one exists was not settled here`,
        range,
      ),
    none: () => nothingThere,
  };
  return dispatchByType(table, found);
}

/**
 * A field whose type cannot be read is still discovered, with no declared
 * contract, since the symbol alone shows the field exists. A field whose
 * name cannot be read is discovered too, under the expression it was
 * written as and with no binding. Dropping it would make the declaration
 * look as if it had never been written.
 */
async function readFieldCall(
  stmt: RbNode,
  scope: FileScope,
  ctx: FieldReadContext,
  ancestry: Ancestry,
): Promise<FieldDeclaration | null> {
  if (stmt.type !== "call" || field(stmt, "receiver") !== null) {
    return null;
  }
  if (field(stmt, "method")?.text !== ctx.pattern.fieldCallName) {
    return null;
  }
  const callArgs = readCallArgs(field(stmt, "arguments"));
  const nameArg = callArgs.positional[0];
  if (nameArg === undefined) {
    return null;
  }
  const symbol = symbolValue(nameArg);
  if (symbol === null) {
    return computedNameDeclaration(stmt, nameArg);
  }
  const read = await readFieldShape(
    symbol,
    callArgs,
    scope,
    ctx,
    ancestry,
    rangeOf(stmt),
  );
  return {
    fieldName: resolvedName(symbol, callArgs, ctx.pattern),
    namedOnTheWire: true,
    node: stmt,
    contract: read.contract,
    body: read.body,
  };
}

/** A field whose name is computed when the class body runs, so the file does not contain the name the schema uses. */
function computedNameDeclaration(
  stmt: RbNode,
  nameArg: RbNode,
): FieldDeclaration {
  const range = rangeOf(stmt);
  return {
    fieldName: nameArg.text,
    namedOnTheWire: false,
    node: stmt,
    contract: null,
    body: {
      readings: [
        unreadableReading(
          `This field is named by ${nameArg.text}, which is worked out when the class body runs, so the name the schema exposes it under was not read here`,
          range,
        ),
      ],
    },
  };
}

/** When a call uses more than one of the pattern's wiring keywords, the first one listed in the pattern wins. */
function wiringReference(
  callArgs: CallArgs,
  wiringKeywords: readonly string[],
): RbNode | null {
  for (const keyword of wiringKeywords) {
    const ref = callArgs.keyword[keyword];
    if (ref !== undefined) {
      return ref;
    }
  }
  return null;
}

/** The contract is null when no shape could be read for the field, whether it wrote no type or one this reader does not follow. */
async function readFieldShape(
  symbol: string,
  callArgs: CallArgs,
  scope: FileScope,
  ctx: FieldReadContext,
  ancestry: Ancestry,
  range: Range,
): Promise<FieldReading> {
  const oneHopRef = wiringReference(callArgs, ctx.pattern.wiringKeywords);
  if (oneHopRef !== null) {
    return readWiredClass(oneHopRef, scope, ctx);
  }

  return {
    contract: literalContract(callArgs, scope, ctx),
    body: bodyFromLookup(
      methodInAncestry(ancestry, symbol, ctx.read),
      range,
      "This field",
      NO_METHOD_BEHIND_IT,
      ctx.bodyRead,
    ),
  };
}

/** The shape given by a field's own type argument, or null when it has none or the type cannot be read. */
function literalContract(
  callArgs: CallArgs,
  scope: FileScope,
  ctx: FieldReadContext,
): FieldContract | null {
  const typeArg = callArgs.positional[1];
  if (typeArg === undefined) {
    return null;
  }
  const returnType = typeShapeFromNode(
    typeArg,
    typeContext(scope, ctx.pattern),
  );
  return returnType === null ? null : { returnType, args: [] };
}

/** A wiring keyword points at the class that resolves the field, so that class's ancestry gives both the declared shape and the resolver method. */
async function readWiredClass(
  ref: RbNode,
  scope: FileScope,
  ctx: FieldReadContext,
): Promise<FieldReading> {
  const range = rangeOf(ref);

  const candidates = constantRefCandidates(ref, scope.nesting);
  if (candidates.length === 0) {
    return {
      contract: null,
      body: methodNotSettled(
        `This field is wired to ${ref.text}, which is not a constant path this reader follows, so nothing about what it does was read here`,
        range,
      ),
    };
  }

  const reached = await reachConstant(candidates, ctx.lookup);
  if (reached === null) {
    return {
      contract: null,
      body: methodNotSettled(
        `This field is wired to ${ref.text}, which this run did not read, so nothing about what it does was read here`,
        range,
      ),
    };
  }

  const targetQualifiedName = reached.name;
  const ancestry = await ancestryOf(
    targetQualifiedName,
    reached.blocks,
    ctx.lookup,
  );
  return {
    contract: readClassContract(ancestry, ctx.pattern),
    body: bodyFromLookup(
      methodInAncestry(ancestry, ctx.pattern.resolverMethodName, ctx.read),
      range,
      `This field's ${targetQualifiedName}`,
      methodNotSettled(
        `This field is wired to ${targetQualifiedName}, which defines no ${ctx.pattern.resolverMethodName} method anywhere in its ancestry, so nothing about what it does was read here`,
        range,
      ),
      ctx.bodyRead,
    ),
  };
}

interface ClassContractAccumulator {
  /** Set by the type call, which a referenced class uses to declare its own return type. */
  typeCallShape: TypeShape | null;
  /** Built from field calls, which a referenced class uses to describe its payload. */
  fieldProperties: Record<string, TypeShape>;
  args: Map<string, ArgDeclaration>;
}

type ClassCallHandler = (
  callArgs: CallArgs,
  scope: FileScope,
  pattern: GraphqlObjectFields,
  out: ClassContractAccumulator,
) => void;

function readTypeCall(
  callArgs: CallArgs,
  scope: FileScope,
  pattern: GraphqlObjectFields,
  out: ClassContractAccumulator,
): void {
  const typeArg = callArgs.positional[0];
  if (typeArg !== undefined) {
    out.typeCallShape = typeShapeFromNode(typeArg, typeContext(scope, pattern));
  }
}

function readPayloadFieldCall(
  callArgs: CallArgs,
  scope: FileScope,
  pattern: GraphqlObjectFields,
  out: ClassContractAccumulator,
): void {
  const nameArg = callArgs.positional[0];
  const symbol = nameArg !== undefined ? symbolValue(nameArg) : null;
  const typeArg = callArgs.positional[1];
  if (symbol === null || typeArg === undefined) {
    return;
  }
  const name = resolvedName(symbol, callArgs, pattern);
  out.fieldProperties[name] = typeShapeFromNode(
    typeArg,
    typeContext(scope, pattern),
  ) ?? { type: "unknown" };
}

function readArgumentCall(
  callArgs: CallArgs,
  scope: FileScope,
  pattern: GraphqlObjectFields,
  out: ClassContractAccumulator,
): void {
  const nameArg = callArgs.positional[0];
  const symbol = nameArg !== undefined ? symbolValue(nameArg) : null;
  if (symbol === null) {
    return;
  }
  const typeArg = callArgs.positional[1];
  const shape =
    typeArg !== undefined
      ? typeShapeFromNode(typeArg, typeContext(scope, pattern))
      : null;
  const requiredNode = callArgs.keyword[pattern.requiredKeyword];
  const required =
    requiredNode !== undefined
      ? (booleanLiteralValue(requiredNode) ?? pattern.requiredDefault)
      : pattern.requiredDefault;
  const name = resolvedName(symbol, callArgs, pattern);
  out.args.set(name, {
    name,
    type: shape ?? { type: "unknown" },
    required,
    typeText: typeArg?.text ?? null,
  });
}

function classCallHandlers(
  pattern: GraphqlObjectFields,
): Record<string, ClassCallHandler> {
  return {
    [pattern.typeCallName]: readTypeCall,
    [pattern.fieldCallName]: readPayloadFieldCall,
    [pattern.argumentCallName]: readArgumentCall,
  };
}

/** The contract declared across an ancestry, or null when nothing in it declares a shape. */
function readClassContract(
  ancestry: Ancestry,
  pattern: GraphqlObjectFields,
): FieldContract | null {
  const out: ClassContractAccumulator = {
    typeCallShape: null,
    fieldProperties: {},
    args: new Map(),
  };
  const handlers = classCallHandlers(pattern);

  for (const { block, statement } of inheritedStatements(
    ancestry,
    blockConfiguresCall(pattern),
  )) {
    if (statement.type !== "call" || field(statement, "receiver") !== null) {
      continue;
    }
    const method = field(statement, "method")?.text;
    const handler = method !== undefined ? handlers[method] : undefined;
    if (handler === undefined) {
      continue;
    }
    const scope: FileScope = {
      nesting: block.info.bodyNesting,
      knownClasses: block.knownClasses,
    };
    handler(readCallArgs(field(statement, "arguments")), scope, pattern, out);
  }

  const returnType =
    out.typeCallShape ??
    (Object.keys(out.fieldProperties).length > 0
      ? { type: "record" as const, properties: out.fieldProperties }
      : null);
  if (returnType === null) {
    return null;
  }

  const args = [...out.args.values()];
  const wrapping = pattern.argumentWrapping;
  if (wrapping !== undefined && ancestryReaches(ancestry, wrapping)) {
    return {
      returnType,
      args: [wrapInputArgument(args, wrapping)],
      methodArgs: args,
    };
  }

  return { returnType, args };
}

type ArgumentWrapping = NonNullable<GraphqlObjectFields["argumentWrapping"]>;

/** Checked by name, so the wrapping base matches even when its file was not read. */
function ancestryReaches(
  ancestry: Ancestry,
  wrapping: ArgumentWrapping,
): boolean {
  return ancestry.some((entry) => entry.name === wrapping.ancestorClassName);
}

/**
 * The wire shape the wrapping base class gives a mutation: one required
 * input-object argument. Its fields are the declared arguments, with
 * optional ones unioned with undefined, plus the fields the library adds.
 */
function wrapInputArgument(
  args: readonly ArgDeclaration[],
  wrapping: ArgumentWrapping,
): ArgDeclaration {
  const properties: Record<string, TypeShape> = {};
  for (const arg of args) {
    properties[arg.name] = arg.required ? arg.type : optionalShape(arg.type);
  }
  for (const [name, extra] of Object.entries(wrapping.extraFields)) {
    properties[name] = extra.required ? extra.type : optionalShape(extra.type);
  }
  return {
    name: wrapping.argumentName,
    type: { type: "record", properties },
    required: true,
    typeText: null,
  };
}

function optionalShape(shape: TypeShape): TypeShape {
  return { type: "union", variants: [shape, { type: "undefined" }] };
}

/** The name the schema exposes a field or argument under. */
function resolvedName(
  symbol: string,
  callArgs: CallArgs,
  pattern: GraphqlObjectFields,
): string {
  const override = callArgs.keyword[pattern.camelizeKeyword];
  const camelizeThis =
    override !== undefined
      ? (booleanLiteralValue(override) ?? pattern.camelizeDefault)
      : pattern.camelizeDefault;
  return camelizeThis ? toCamelCase(symbol) : symbol;
}

function toCamelCase(name: string): string {
  const [first, ...rest] = name.split("_");
  return [
    first,
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)),
  ].join("");
}

function buildFieldUnit(
  pack: RubyPack,
  typeName: string,
  decl: FieldDeclaration,
  filePath: string,
): RawCodeStructure {
  const parameters: RawParameter[] = (
    decl.contract?.methodArgs ??
    decl.contract?.args ??
    []
  ).map((arg, position) => ({
    name: arg.name,
    position,
    role: "args",
    typeText: arg.typeText,
  }));

  const graphqlDeclaredContract:
    | (GraphqlDeclaredContract & { provenance: "derived" })
    | undefined =
    decl.contract !== null
      ? {
          returnType: decl.contract.returnType,
          args: decl.contract.args.map((a) => ({
            name: a.name,
            type: a.type,
            required: a.required,
          })),
          provenance: "derived",
          framework: pack.name,
        }
      : undefined;

  return {
    identity: {
      name: `${typeName}.${decl.fieldName}`,
      nameKind: "label",
      kind: "resolver",
      file: filePath,
      range: rangeOf(decl.node),
      span: spanOf(decl.node),
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: decl.namedOnTheWire
      ? graphqlResolverBinding({
          transport: pack.protocol,
          recognition: pack.name,
          typeName,
          fieldName: decl.fieldName,
        })
      : null,
    parameters,
    branches: branchesFor(decl.body, rangeOf(decl.node)),
    ...(decl.body.bodyContent !== undefined
      ? { bodyContent: decl.body.bodyContent }
      : {}),
    dependencyCalls: [],
    declaredContract: null,
    ...(decl.body.readings.length > 0 ? { readings: decl.body.readings } : {}),
    ...(graphqlDeclaredContract !== undefined
      ? { graphqlDeclaredContract }
      : {}),
  };
}
