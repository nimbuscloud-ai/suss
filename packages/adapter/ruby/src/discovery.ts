// discovery.ts: find class DSL field declarations and turn each into a
// RawCodeStructure.
//
// See this package's README for what a field's summary says about the
// method behind it and where the reading stops.

import { dispatchByType, graphqlResolverBinding } from "@suss/behavioral-ir";
import { unreadableReading } from "@suss/extractor";

import {
  ancestryOf,
  definesMethodsDynamically,
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
  RawCodeStructure,
  RawParameter,
  Reading,
} from "@suss/extractor";
import type { AncestorLookup, Ancestry, ReachedBody } from "./ancestry.js";
import type { CallArgs, Range } from "./ast.js";
import type {
  GraphqlObjectFields,
  RubyDiscoveryPattern,
  RubyPack,
} from "./pack.js";
import type { RbNode } from "./parser.js";
import type { ClassInfo } from "./scope.js";
import type { TypeReadContext } from "./typeShape.js";

/**
 * A parsed file, kept by absolute path, so a class referenced through a
 * wiring keyword from several fields (or a file that is both a project
 * file and someone else's one-hop target) is parsed once. See
 * `createFileCache`.
 */
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

/** Where a bare constant is read from: the `Module.nesting` chain in effect, and every class the file it sits in defines, for shadow detection (see typeShape.ts). */
interface FileScope {
  nesting: readonly string[];
  knownClasses: ReadonlySet<string>;
}

/** What a one-hop wiring lookup needs beyond the field's own scope: the pattern whose vocabulary is being read, and the parse cache. */
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

/** The pattern's scalar and naming vocabulary joined with one scope, the shape typeShape.ts reads against. */
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
    // a later block answers a field declared in an earlier one.
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
  // One variant today; kept as a dispatch table (docs/internal/style.md,
  // decision 8) so a second Ruby discovery shape adds a case here
  // rather than an if-chain.
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
  const ancestry = await ancestryOf(ownBlocks, ctx.lookup);

  // The class DSL stores fields by name, so a field redefined later in
  // the same body replaces the earlier declaration rather than the two
  // coexisting. A Map keyed by the resolved field name keeps the
  // insertion order of the first sighting while letting a later
  // statement overwrite the stored declaration, so the discovered unit
  // is the one the library itself would end up with.
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

/** What one field's declaration and the method behind it come to together, since a wiring keyword answers both at once. */
interface FieldReading {
  contract: FieldContract | null;
  body: BodyReport;
}

interface BodyReport {
  /** Left unset when no value of it would be true: the extractor writes its own sentence from this one, and there is a truer sentence in `readings`. */
  bodyContent?: BodyContent;
  readings: Reading<unknown>[];
}

function bodyOfMethod(method: RbNode): BodyReport {
  return {
    bodyContent: methodHasStatements(method) ? "statements" : "empty",
    readings: [],
  };
}

/** The library answers a field with no method behind it by reading the attribute off the object it was resolved against, so there is no body anywhere to read. */
const NO_METHOD_BEHIND_IT: BodyReport = {
  bodyContent: "absent",
  readings: [],
};

function methodNotSettled(reason: string, range: Range): BodyReport {
  return { readings: [unreadableReading(reason, range)] };
}

/** Why a search that found no method cannot claim there is none, or null when it searched every ancestor and there is none. */
function unsettledMethod(
  ancestry: Ancestry,
  range: Range,
  subject: string,
): BodyReport | null {
  if (ancestry.unfollowed !== null) {
    return methodNotSettled(
      `${subject} could be answered by a method inherited from ${ancestry.unfollowed}, which this run did not read, so whether one exists was not settled here`,
      range,
    );
  }
  if (definesMethodsDynamically(ancestry)) {
    return methodNotSettled(
      `${subject} could be answered by a method defined with define_method, which this reader does not follow, so whether one exists was not settled here`,
      range,
    );
  }
  return null;
}

/**
 * Read one field-declaring call from an object type's own body. A
 * field name this module can't read (anything but a plain symbol
 * literal) means there's no unit to discover at all; a field whose
 * declared shape this module can't read still gets discovered, with no
 * declared contract, per the language-adapters proposal's unresolved
 * convention: existence is known from the symbol alone, the shape is
 * not.
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

/** The referenced-class node named by the first of the pattern's wiring keywords present on this call, or null when none is. */
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

  const method = methodInAncestry(ancestry, symbol);
  return {
    contract: literalContract(callArgs, scope, ctx),
    body:
      method !== null
        ? bodyOfMethod(method)
        : (unsettledMethod(ancestry, range, "This field") ??
          NO_METHOD_BEHIND_IT),
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

/** A wiring keyword names the class that answers the field, so its ancestry supplies both the declared shape and the resolver method. */
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

  const ancestry = await ancestryOf(reached, ctx.lookup);
  const contract = readClassContract(ancestry, ctx.pattern);
  const method = methodInAncestry(ancestry, ctx.pattern.resolverMethodName);
  if (method === null) {
    return {
      contract,
      body:
        unsettledMethod(
          ancestry,
          range,
          `This field's ${targetQualifiedName}`,
        ) ??
        methodNotSettled(
          `This field is wired to ${targetQualifiedName}, which defines no ${ctx.pattern.resolverMethodName} method anywhere in its ancestry, so nothing about what it does was read here`,
          range,
        ),
    };
  }
  return { contract, body: bodyOfMethod(method) };
}

interface ClassContractAccumulator {
  /** Set by a type-declaring call (a referenced class's own declared return type). */
  typeCallShape: TypeShape | null;
  /** Built from field-declaring calls (a referenced class's own payload). */
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
  // What an argument defaults to when the keyword is absent is the
  // library's own registration default, so the pack states it.
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

/** The per-call-name handler table for one pattern, keyed by the call names the pack declares. */
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

/**
 * The schema name a field/argument symbol resolves to. Whether a
 * snake_case symbol is exposed in camelCase by default, and which
 * keyword overrides that default for one call, are both the pack's to
 * state; the camelization itself is the ordinary snake_case-to-
 * camelCase transform and stays here.
 */
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
    branches: [],
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
