// discovery.ts: find class DSL field declarations and turn each one into
// a RawCodeStructure.
//
// A field's boundary binding and its declared contract both come from
// the arguments of its own DSL call. A field written with one of the
// pack's wiring keywords is the exception. It declares no type of its
// own, so its contract and the method behind it are read from the class
// it points at, one hop away.
//
// See this package's README for what a field's summary says about the
// method behind it and where the reading stops.

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
  reachDefinition,
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
import { envReadEffects } from "./envReads.js";
import { invocationEffects } from "./paths/effects.js";
import { responseBranches } from "./responseStatus.js";
import {
  graphqlTypeNameFromQualified,
  qualifyConstantRef,
  walkDefinitions,
} from "./scope.js";
import { type RbStorageOptions, storageEffects } from "./storage.js";
import { typeShapeFromNode } from "./typeShape.js";

import type {
  DispatchTable,
  Effect,
  GraphqlDeclaredContract,
  TypeShape,
} from "@suss/behavioral-ir";
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
  MethodLookup,
  ReachedBody,
} from "./ancestry.js";
import type { BlockConfigures, CallArgs, Range } from "./ast.js";
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
 * What the run's packs said that reading a method body needs. An
 * options object that already declares both fields, `DiscoveryOptions`
 * among them, is one of these and can be passed straight through.
 */
export interface BodyReadOptions {
  /** What a pack needs to say a call talks to the database. Absent when no pack does. */
  readonly storage?: RbStorageOptions | undefined;
  /** The methods every pack in the run said its own library defines, which are left off an effect list. */
  readonly inheritedMethods?: InheritedMethods | undefined;
}

export interface DiscoveryOptions extends BodyReadOptions {
  packs: RubyPack[];
  /** Repo-relative or absolute path recorded on each summary's `location.file`. */
  filePath: string;
  /** Absolute path of the file being read, for a block's own `ReachedBody.file`. Falls back to `filePath` when nothing was written to disk. */
  absoluteFile?: string;
  cache: FileCache;
  /** Called once per discovered unit whose own body is a method this run can follow calls out of, so the reach walk has a place to start. */
  onReachSeed?: (raw: RawCodeStructure, seed: ReachSeed) => void;
}

/** The method behind a discovered unit's own body, and where it lives, so the reach walk can start there the way it starts at a `def` it found directly. */
export interface ReachSeed {
  readonly file: string;
  readonly node: RbNode;
  /** The class the method is written in, or null for one written outside any class. */
  readonly enclosingQualifiedName: string | null;
}

/** What a bare constant is resolved against: the nesting chain in effect, plus every class the file defines, so we can spot shadowing. */
interface FileScope {
  nesting: readonly string[];
  knownClasses: ReadonlySet<string>;
}

interface FieldReadContext {
  pattern: GraphqlObjectFields;
  cache: FileCache;
  lookup: AncestorLookup;
  bodyRead: BodyReadOptions;
}

function fieldReadContext(
  pattern: GraphqlObjectFields,
  cache: FileCache,
  fileBlocks: readonly ReachedBody[],
  bodyRead: BodyReadOptions,
): FieldReadContext {
  return {
    pattern,
    cache,
    bodyRead,
    lookup: {
      root: pattern.root,
      pathConvention: pattern.pathConvention,
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
  // Modules are visited too: a graphql-ruby interface is a module that
  // mixes in the interface base, and its fields are declared the same way.
  walkDefinitions(root, (info) => classes.push(info));
  const knownClasses = new Set(classes.map((info) => info.qualifiedName));

  const fileBlocks: ReachedBody[] = classes.map((info) => ({
    info,
    knownClasses,
    file: options.absoluteFile ?? options.filePath,
  }));

  const units: RawCodeStructure[] = [];
  for (const info of classes) {
    // A class reopened in one file is one class, so a method written in
    // a later block redeclares a field declared in an earlier one.
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
 * Whether a class or module inherits from, or mixes in, one of the
 * pack's base classes, however many project bases are in between
 * (#247). The ancestry keeps a base it could not open as an entry
 * under its written name, so an unread base still matches.
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
  const ctx = fieldReadContext(pattern, options.cache, fileBlocks, options);
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

  // The class DSL stores fields by name, so a field redefined later in the same
  // body replaces the earlier declaration. Keying this Map on the resolved field
  // name gives the same last-write-wins result.
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
 * Every public instance method a controller defines directly is one
 * of its actions; Rails dispatches to a public method only, so a
 * private or protected one is not discovered here at all, though it
 * still gets a summary through the reach walk once something calls
 * it. Each action becomes its own unit, bound when `routeFor` finds a
 * route for it and left unbound otherwise, with its calls seeded into
 * the reach walk either way.
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
    ancestryRootClassNames: pattern.ancestryRootClassNames,
    parsedFile: (absPath) => options.cache.get(absPath),
    localDefinition: (name) => sameFileBlocks(name, fileBlocks),
  };
  const ancestry = await ancestryOf(info.qualifiedName, ownBlocks, lookup);
  if (
    !reachesConfiguredBase(ancestry, info.qualifiedName, pattern.baseClassNames)
  ) {
    return [];
  }

  const units: RawCodeStructure[] = [];
  for (const block of ownBlocks) {
    if (block.info.bodyNode === null) {
      continue;
    }
    const visibility = instanceMethodVisibility(block.info.bodyNode);
    for (const [actionName, method] of instanceMethodsByName(
      block.info.bodyNode,
    )) {
      if ((visibility.get(actionName) ?? "public") !== "public") {
        continue;
      }
      const raw = buildControllerActionUnit(
        pack,
        pattern,
        info.qualifiedName,
        actionName,
        method,
        options.filePath,
        options,
      );
      units.push(raw);
      options.onReachSeed?.(raw, {
        file: block.file,
        node: method,
        enclosingQualifiedName: info.qualifiedName,
      });
    }
  }
  return units;
}

function buildControllerActionUnit(
  pack: RubyPack,
  pattern: ControllerActions,
  controllerQualifiedName: string,
  actionName: string,
  method: RbNode,
  filePath: string,
  bodyRead: BodyReadOptions,
): RawCodeStructure {
  const range = rangeOf(method);
  const route = pattern.routeFor(controllerQualifiedName, actionName);
  const body = bodyOfMethod(method, bodyRead);
  const perResponse = responseBranches(
    method,
    pattern,
    body.effects ?? [],
    body.extraEffects,
  );
  return {
    identity: {
      name: actionName,
      nameKind: "binding",
      kind: "handler",
      file: filePath,
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
  };
}

/** One unit, with no boundary and nothing to call, saying what a run of this pattern's own routing read left uncovered. `project.ts` builds this once per pattern, after discovery has read every file, rather than once per controller. */
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
 * A block on one of the pack's own DSL calls configures that call.
 * `field :x, String do argument :q, String end` declares an argument on
 * the field, so reading it as a statement of the class body would put
 * the argument on the wrong thing.
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
   * method, so the method's parameters follow these, not `args`.
   */
  methodArgs?: ArgDeclaration[];
}

interface FieldDeclaration {
  fieldName: string;
  /** False when the name was computed, so nothing on the wire can be matched against it. */
  namedOnTheWire: boolean;
  node: RbNode;
  contract: FieldContract | null;
  body: BodyReport;
}

/** What one field's declaration and the method behind it come to together, since a wiring keyword settles both at once. */
/** One branch recording what the resolver does, when anything was read of it. */
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

interface FieldReading {
  contract: FieldContract | null;
  body: BodyReport;
}

export interface BodyReport {
  /** Left unset when no value of it would be true: the extractor writes its own sentence from this one, and there is a truer sentence in `readings`. */
  bodyContent?: BodyContent;
  readings: Reading<unknown>[];
  /** The calls the method makes, each with what gates it. */
  effects?: RawEffect[];
  /** Effects a recognizer built in IR form, the database work among them. */
  extraEffects?: Effect[];
  /** Set when this body came from an actual method, so the reach walk can follow the calls it makes. */
  reachSeed?: ReachSeed;
}

export function bodyOfMethod(
  method: RbNode,
  bodyRead: BodyReadOptions = {},
): BodyReport {
  const effects = invocationEffects(method, bodyRead.inheritedMethods);
  const storage = bodyRead.storage;
  const extra = [
    ...envReadEffects(method),
    ...(storage === undefined
      ? []
      : storageEffects(callsUnder(method), storage)),
  ];
  return {
    bodyContent: methodHasStatements(method) ? "statements" : "empty",
    readings: [],
    ...(effects.length > 0 ? { effects } : {}),
    ...(extra.length > 0 ? { extraEffects: extra } : {}),
  };
}

/** Every call written under a node. */
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

/** The library resolves a field with no method behind it by reading the attribute off the object it was resolved against, so there is no body anywhere to read. */
const NO_METHOD_BEHIND_IT: BodyReport = {
  bodyContent: "absent",
  readings: [],
};

function methodNotSettled(reason: string, range: Range): BodyReport {
  return { readings: [unreadableReading(reason, range)] };
}

/**
 * What a search of an ancestry says about the body, given what it
 * should say when the search read everything and found nothing.
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
      ...bodyOfMethod(lookup.method, bodyRead),
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
 * A field whose type we cannot read is still discovered with no declared
 * contract, since the symbol alone tells you the field exists. A field
 * whose name we cannot read is discovered too, under the expression it
 * was written as and bound to nothing, because a declaration nobody
 * mentions is indistinguishable from one that was never written.
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

/** A field whose name is worked out when the class body runs, so the schema's own name for it is not in this file. */
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

/** A contract of null means the shape wasn't readable, which is not the same as a field that declares none. */
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
      methodInAncestry(ancestry, symbol),
      range,
      "This field",
      NO_METHOD_BEHIND_IT,
      ctx.bodyRead,
    ),
  };
}

/** The shape a field states outright in its own type argument, or null when it states none this module can read. */
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

/** A wiring keyword points at the class that resolves the field, so its ancestry supplies both the declared shape and the resolver method. */
async function readWiredClass(
  ref: RbNode,
  scope: FileScope,
  ctx: FieldReadContext,
): Promise<FieldReading> {
  const range = rangeOf(ref);

  const targetQualifiedName = qualifyConstantRef(ref, scope.nesting);
  if (targetQualifiedName === null) {
    return {
      contract: null,
      body: methodNotSettled(
        `This field is wired to ${ref.text}, which is not a constant path this reader follows, so nothing about what it does was read here`,
        range,
      ),
    };
  }

  const reached = await reachDefinition(targetQualifiedName, ctx.lookup);
  if (reached === null) {
    return {
      contract: null,
      body: methodNotSettled(
        `This field is wired to ${targetQualifiedName}, which this run did not read, so nothing about what it does was read here`,
        range,
      ),
    };
  }

  const ancestry = await ancestryOf(targetQualifiedName, reached, ctx.lookup);
  return {
    contract: readClassContract(ancestry, ctx.pattern),
    body: bodyFromLookup(
      methodInAncestry(ancestry, ctx.pattern.resolverMethodName),
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
  /** Set by a type-declaring call, which is how a referenced class declares its own return type. */
  typeCallShape: TypeShape | null;
  /** Built up from field-declaring calls, which is how a referenced class describes its own payload. */
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

/** The declared contract an ancestry states. Null when nothing in it states a shape. */
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

/** Followed or not, the wrapping ancestor's name is in the chain. */
function ancestryReaches(
  ancestry: Ancestry,
  wrapping: ArgumentWrapping,
): boolean {
  return ancestry.some((entry) => entry.name === wrapping.ancestorClassName);
}

/**
 * The wire shape the wrapping base class gives a mutation: one
 * required input-object argument whose fields are the declared
 * arguments, optional ones unioned with undefined, plus the fields
 * the library adds on its own.
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

/** The name the schema exposes a field or argument symbol under. */
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
