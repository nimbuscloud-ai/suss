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

import { dispatchByType, graphqlResolverBinding } from "@suss/behavioral-ir";
import { unreadableReading } from "@suss/extractor";

import {
  ancestryOf,
  inheritedStatements,
  methodInAncestry,
  reachDefinition,
} from "./ancestry.js";
import {
  bodyStatements,
  booleanLiteralValue,
  field,
  methodHasStatements,
  rangeOf,
  readCallArgs,
  symbolValue,
} from "./ast.js";
import { invocationEffects } from "./paths/effects.js";
import {
  graphqlTypeNameFromQualified,
  qualifyConstantRef,
  walkClasses,
} from "./scope.js";
import { typeShapeFromNode } from "./typeShape.js";

import type {
  DispatchTable,
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
import type { CallArgs, Range } from "./ast.js";
import type {
  GraphqlObjectFields,
  RubyDiscoveryPattern,
  RubyPack,
} from "./pack.js";
import type { RbNode } from "./parser.js";
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

export interface DiscoveryOptions {
  packs: RubyPack[];
  /** Repo-relative or absolute path recorded on each summary's `location.file`. */
  filePath: string;
  cache: FileCache;
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
}

function fieldReadContext(
  pattern: GraphqlObjectFields,
  cache: FileCache,
): FieldReadContext {
  return {
    pattern,
    cache,
    lookup: {
      root: pattern.root,
      pathConvention: pattern.pathConvention,
      ancestryRootClassNames: pattern.ancestryRootClassNames,
      parsedFile: (absPath) => cache.get(absPath),
    },
  };
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
  walkClasses(root, (info) => classes.push(info));
  const knownClasses = new Set(classes.map((info) => info.qualifiedName));

  const units: RawCodeStructure[] = [];
  for (const info of classes) {
    // A class reopened in one file is one class, so a method written in
    // a later block redeclares a field declared in an earlier one.
    const ownBlocks: ReachedBody[] = classes
      .filter((other) => other.qualifiedName === info.qualifiedName)
      .map((other) => ({ info: other, knownClasses }));
    for (const pack of options.packs) {
      for (const pattern of pack.discovery) {
        units.push(
          ...(await unitsFor(pattern, pack, info, ownBlocks, options)),
        );
      }
    }
  }
  return units;
}

function unitsFor(
  pattern: RubyDiscoveryPattern,
  pack: RubyPack,
  info: ClassInfo,
  ownBlocks: readonly ReachedBody[],
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  const table: DispatchTable<
    RubyDiscoveryPattern,
    Promise<RawCodeStructure[]>
  > = {
    graphqlObjectFields: (p) =>
      graphqlObjectFieldUnits(p, pack, info, ownBlocks, options),
  };
  return dispatchByType(table, pattern);
}

async function graphqlObjectFieldUnits(
  pattern: GraphqlObjectFields,
  pack: RubyPack,
  info: ClassInfo,
  ownBlocks: readonly ReachedBody[],
  options: DiscoveryOptions,
): Promise<RawCodeStructure[]> {
  if (
    info.superclassQualifiedName === null ||
    !pattern.baseClassNames.includes(info.superclassQualifiedName) ||
    info.bodyNode === null
  ) {
    return [];
  }
  const typeName = graphqlTypeNameFromQualified(
    info.qualifiedName,
    pattern.typeNameConvention,
  );
  const ctx = fieldReadContext(pattern, options.cache);
  const knownClasses = ownBlocks[0]?.knownClasses ?? new Set<string>();
  const scope: FileScope = { nesting: info.bodyNesting, knownClasses };
  const ancestry = await ancestryOf(info.qualifiedName, ownBlocks, ctx.lookup);

  // The class DSL stores fields by name, so a field redefined later in the same
  // body replaces the earlier declaration. Keying this Map on the resolved field
  // name gives the same last-write-wins result.
  const declsByName = new Map<string, FieldDeclaration>();
  for (const stmt of bodyStatements(info.bodyNode)) {
    const decl = await readFieldCall(stmt, scope, ctx, ancestry);
    if (decl !== null) {
      declsByName.set(decl.fieldName, decl);
    }
  }
  return [...declsByName.values()].map((decl) =>
    buildFieldUnit(pack, typeName, decl, options.filePath),
  );
}

interface ArgDeclaration {
  name: string;
  type: TypeShape;
  required: boolean;
  typeText: string | null;
}

interface FieldContract {
  returnType: TypeShape;
  args: ArgDeclaration[];
}

interface FieldDeclaration {
  fieldName: string;
  node: RbNode;
  contract: FieldContract | null;
  body: BodyReport;
}

/** What one field's declaration and the method behind it come to together, since a wiring keyword settles both at once. */
/** One branch recording what the resolver does, when anything was read of it. */
function branchesFor(body: BodyReport, range: Range): RawBranch[] {
  if (body.effects === undefined) {
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
      effects: body.effects,
      location: range,
      isDefault: true,
    },
  ];
}

interface FieldReading {
  contract: FieldContract | null;
  body: BodyReport;
}

interface BodyReport {
  /** Left unset when no value of it would be true: the extractor writes its own sentence from this one, and there is a truer sentence in `readings`. */
  bodyContent?: BodyContent;
  readings: Reading<unknown>[];
  /** The calls the method makes, each with what gates it. */
  effects?: RawEffect[];
}

function bodyOfMethod(method: RbNode): BodyReport {
  const effects = invocationEffects(method);
  return {
    bodyContent: methodHasStatements(method) ? "statements" : "empty",
    readings: [],
    ...(effects.length > 0 ? { effects } : {}),
  };
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
): BodyReport {
  const table: DispatchTable<MethodLookup, BodyReport> = {
    found: (lookup) => bodyOfMethod(lookup.method),
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
 * If we cannot read the field's name there is no unit to discover at all. If we
 * can read the name but not the type, the field is still discovered with no
 * declared contract, since the symbol alone tells you the field exists.
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
  const symbol = nameArg !== undefined ? symbolValue(nameArg) : null;
  if (symbol === null) {
    return null;
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
    node: stmt,
    contract: read.contract,
    body: read.body,
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

  for (const { block, statement } of inheritedStatements(ancestry)) {
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
  return returnType === null
    ? null
    : { returnType, args: [...out.args.values()] };
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
  const parameters: RawParameter[] = (decl.contract?.args ?? []).map(
    (arg, position) => ({
      name: arg.name,
      position,
      role: "args",
      typeText: arg.typeText,
    }),
  );

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
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: graphqlResolverBinding({
      transport: pack.protocol,
      recognition: pack.name,
      typeName,
      fieldName: decl.fieldName,
    }),
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
