// discovery.ts: find class DSL field declarations and turn each into a
// RawCodeStructure.
//
// v0 discovers a field-declaring call written directly in the body of a
// class whose superclass names a pack-configured base class: the
// boundary binding and the declared contract are what the call's own
// arguments state. That's the existence-class shape the
// language-adapters proposal calls for, enough to pair against a client
// operation by (typeName, fieldName). Every call name, keyword, and
// naming convention read here comes off the pack's pattern (see
// pack.ts); this module hardcodes none of them.
//
// A field is also looked up against the method that answers it, since
// most of them have one: a method of the field's own name in the same
// class, or, for a field carrying a wiring keyword, the pack-named
// resolver method on the class it points at. The summary reports what
// is there (a body with work in it, a body with nothing in it, no
// method at all) and, when the lookup fails, what stopped it. What that
// body does is still not traced: transitions stay empty until the path
// engine runs for Ruby.
//
// A field carrying one of the pack's wiring keywords is the one-hop
// exception: the field itself declares no type, so its declared
// contract comes from the referenced class's own type-declaring call
// (a declared return type) or its own field-declaring calls (a payload,
// read as a record). The referenced class is located by the pack's
// constant-to-path convention, parsed once per file and cached, and
// read with the same per-statement reader this module already uses for
// the discovering class's own body. A class reopened more than once in
// that file (ordinary Ruby) contributes every block to the same
// contract, in the order Ruby would evaluate them, and a field or
// argument redefined along the way keeps its last-written shape, the
// same last-wins registration the class DSL itself has.

import { dispatchByType, graphqlResolverBinding } from "@suss/behavioral-ir";
import { unreadableReading } from "@suss/extractor";

import {
  bodyStatements,
  booleanLiteralValue,
  field,
  instanceMethodsByName,
  methodHasStatements,
  rangeOf,
  readCallArgs,
  symbolValue,
} from "./ast.js";
import { resolveConstantFile } from "./constantPath.js";
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
    for (const pack of options.packs) {
      for (const pattern of pack.discovery) {
        units.push(
          ...(await unitsFor(pattern, pack, info, options, knownClasses)),
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
  options: DiscoveryOptions,
  knownClasses: ReadonlySet<string>,
): Promise<RawCodeStructure[]> {
  // One variant today; kept as a dispatch table (docs/internal/style.md,
  // decision 8) so a second Ruby discovery shape adds a case here
  // rather than an if-chain.
  const table: DispatchTable<
    RubyDiscoveryPattern,
    Promise<RawCodeStructure[]>
  > = {
    graphqlObjectFields: (p) =>
      graphqlObjectFieldUnits(p, pack, info, options, knownClasses),
  };
  return dispatchByType(table, pattern);
}

async function graphqlObjectFieldUnits(
  pattern: GraphqlObjectFields,
  pack: RubyPack,
  info: ClassInfo,
  options: DiscoveryOptions,
  knownClasses: ReadonlySet<string>,
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
  const ctx: FieldReadContext = { pattern, cache: options.cache };
  const scope: FileScope = { nesting: info.bodyNesting, knownClasses };

  // The class DSL stores fields by name, so a field redefined later in
  // the same body replaces the earlier declaration rather than the two
  // coexisting. A Map keyed by the resolved field name keeps the
  // insertion order of the first sighting while letting a later
  // statement overwrite the stored declaration, so the discovered unit
  // is the one the library itself would end up with.
  const ownMethods = instanceMethodsByName(info.bodyNode);
  const declsByName = new Map<string, FieldDeclaration>();
  for (const stmt of bodyStatements(info.bodyNode)) {
    const decl = await readFieldCall(stmt, scope, ctx, ownMethods);
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

/** What a summary says about the method behind a field: what was found where its body should be, and any sentence about why nothing was. */
interface BodyReport {
  bodyContent: BodyContent;
  readings: Reading<unknown>[];
}

/** A field answered by a method this run read. */
function bodyOfMethod(method: RbNode): BodyReport {
  return {
    bodyContent: methodHasStatements(method) ? "statements" : "empty",
    readings: [],
  };
}

/**
 * A field with no method behind it. The library answers it by reading
 * the attribute off whatever object the field is resolved against, so
 * there is no body anywhere to read and the summary says so.
 */
const NO_METHOD_BEHIND_IT: BodyReport = {
  bodyContent: "absent",
  readings: [],
};

/** A method the reader was sent to and could not reach. Its body is somewhere this run did not read, and the sentence says what stopped it. */
function unreachableMethod(reason: string, range: Range): BodyReport {
  return {
    bodyContent: "elsewhere",
    readings: [unreadableReading(reason, range)],
  };
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
  ownMethods: ReadonlyMap<string, RbNode>,
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
  const read = await readFieldShape(symbol, callArgs, scope, ctx, ownMethods);
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

/**
 * The field's own declared shape and the method behind it. A call
 * carrying one of the pattern's wiring keywords answers both from the
 * referenced class's file; any other call declares its shape in a
 * literal type argument and is answered by a method of its own name in
 * the class it was declared in.
 *
 * A contract of null means the shape wasn't readable (no type argument
 * and no wiring keyword, or a type expression that isn't a literal
 * constant path).
 */
async function readFieldShape(
  symbol: string,
  callArgs: CallArgs,
  scope: FileScope,
  ctx: FieldReadContext,
  ownMethods: ReadonlyMap<string, RbNode>,
): Promise<FieldReading> {
  const oneHopRef = wiringReference(callArgs, ctx.pattern.wiringKeywords);
  if (oneHopRef !== null) {
    return readWiredClass(oneHopRef, scope, ctx);
  }

  const ownMethod = ownMethods.get(symbol);
  return {
    contract: literalContract(callArgs, scope, ctx),
    body:
      ownMethod !== undefined ? bodyOfMethod(ownMethod) : NO_METHOD_BEHIND_IT,
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

/**
 * Everything a wiring keyword's referenced class answers: its declared
 * shape, and the resolver method it defines. The class's file is
 * located by the pack's constant-to-path convention and parsed, and
 * every class in it with that exact qualified name is read.
 *
 * Each step that doesn't resolve says so against the reference itself,
 * so a field wired to a class nobody could reach carries the reason
 * rather than reading as a field with nothing behind it.
 */
async function readWiredClass(
  ref: RbNode,
  scope: FileScope,
  ctx: FieldReadContext,
): Promise<FieldReading> {
  const range = rangeOf(ref);
  const unread = (subject: string, detail: string): FieldReading => ({
    contract: null,
    body: unreachableMethod(
      `This field is wired to ${subject}, ${detail}, so nothing about what it does was read here`,
      range,
    ),
  });

  const targetQualifiedName = qualifyConstantRef(ref, scope.nesting);
  if (targetQualifiedName === null) {
    return unread(ref.text, "which is not a constant path this reader follows");
  }
  const filePath = resolveConstantFile(
    ctx.pattern.root,
    targetQualifiedName,
    ctx.pattern.pathConvention,
  );
  const fileRoot = filePath === null ? null : await ctx.cache.get(filePath);
  if (fileRoot === null) {
    return unread(
      targetQualifiedName,
      "and no file for it sits where the constant-to-path convention says to look",
    );
  }

  const allClasses: ClassInfo[] = [];
  walkClasses(fileRoot, (info) => allClasses.push(info));
  // A class can be reopened more than once in the same file, ordinary
  // Ruby; every block with this exact qualified name contributes to
  // the one contract rather than the last block silently replacing
  // whatever an earlier block declared.
  const matches = allClasses.filter(
    (info) => info.qualifiedName === targetQualifiedName,
  );
  if (matches.length === 0) {
    return unread(
      targetQualifiedName,
      "and the file it should be in defines no class by that name",
    );
  }

  const knownClasses = new Set(allClasses.map((info) => info.qualifiedName));
  const contract = readClassContract(matches, knownClasses, ctx.pattern);
  const method = resolverMethodIn(matches, ctx.pattern.resolverMethodName);
  if (method === null) {
    return {
      contract,
      body: unreachableMethod(
        `This field is wired to ${targetQualifiedName}, which defines no ${ctx.pattern.resolverMethodName} method of its own, so nothing about what it does was read here`,
        range,
      ),
    };
  }
  return { contract, body: bodyOfMethod(method) };
}

/** The resolver method a wired class defines, taking the last definition when the class is reopened, the way Ruby itself would. */
function resolverMethodIn(
  matches: readonly ClassInfo[],
  methodName: string,
): RbNode | null {
  let found: RbNode | null = null;
  for (const match of matches) {
    if (match.bodyNode === null) {
      continue;
    }
    found = instanceMethodsByName(match.bodyNode).get(methodName) ?? found;
  }
  return found;
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

/**
 * Read every matching block's type-, field-, and argument-declaring
 * calls into one declared contract, processed in the order `matches`
 * lists them (source order, since `walkClasses` walks top to bottom):
 * a type-declaring call wins when present; otherwise the field calls
 * found become a record. A field or argument named more than once,
 * whether across reopened blocks or within one, keeps its last-written
 * declaration, both `Map`- and object-key assignment naturally doing
 * that as later statements overwrite earlier ones under the same name.
 * Null when nothing matching states either shape.
 */
function readClassContract(
  matches: ClassInfo[],
  knownClasses: ReadonlySet<string>,
  pattern: GraphqlObjectFields,
): FieldContract | null {
  const out: ClassContractAccumulator = {
    typeCallShape: null,
    fieldProperties: {},
    args: new Map(),
  };
  const handlers = classCallHandlers(pattern);

  for (const match of matches) {
    if (match.bodyNode === null) {
      continue;
    }
    const scope: FileScope = { nesting: match.bodyNesting, knownClasses };
    for (const stmt of bodyStatements(match.bodyNode)) {
      if (stmt.type !== "call" || field(stmt, "receiver") !== null) {
        continue;
      }
      const method = field(stmt, "method")?.text;
      const handler = method !== undefined ? handlers[method] : undefined;
      if (handler === undefined) {
        continue;
      }
      handler(readCallArgs(field(stmt, "arguments")), scope, pattern, out);
    }
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
    bodyContent: decl.body.bodyContent,
    dependencyCalls: [],
    declaredContract: null,
    ...(decl.body.readings.length > 0 ? { readings: decl.body.readings } : {}),
    ...(graphqlDeclaredContract !== undefined
      ? { graphqlDeclaredContract }
      : {}),
  };
}
