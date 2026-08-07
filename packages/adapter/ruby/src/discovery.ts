// discovery.ts: find class DSL field declarations and turn each into a
// RawCodeStructure.
//
// v0 discovers a field-declaring call written directly in the body of a
// class whose superclass names a pack-configured base class and reads
// no further: the boundary binding and the declared contract are what
// the call's own arguments state, nothing traced through a method
// body. That's the existence-class shape the language-adapters proposal
// calls for: a summary low-confidence enough to state nothing about
// behavior nobody read, transitionless (`branches: []`), enough to pair
// against a client operation by (typeName, fieldName). Every call name,
// keyword, and naming convention read here comes off the pack's
// pattern (see pack.ts); this module hardcodes none of them.
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

import {
  bodyStatements,
  booleanLiteralValue,
  field,
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
import type { RawCodeStructure, RawParameter } from "@suss/extractor";
import type { CallArgs } from "./ast.js";
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
  const declsByName = new Map<string, FieldDeclaration>();
  for (const stmt of bodyStatements(info.bodyNode)) {
    const decl = await readFieldCall(stmt, scope, ctx);
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
  const contract = await declaredContractFor(callArgs, scope, ctx);
  return {
    fieldName: resolvedName(symbol, callArgs, ctx.pattern),
    node: stmt,
    contract,
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
 * The field's own declared shape: a literal type argument, or, for a
 * call carrying one of the pattern's wiring keywords, the referenced
 * class's own declaration read from its file. Null when neither is
 * readable (no type argument and no wiring keyword, or a type
 * expression that isn't a literal constant path).
 */
async function declaredContractFor(
  callArgs: CallArgs,
  scope: FileScope,
  ctx: FieldReadContext,
): Promise<FieldContract | null> {
  const oneHopRef = wiringReference(callArgs, ctx.pattern.wiringKeywords);
  if (oneHopRef !== null) {
    const target = qualifyConstantRef(oneHopRef, scope.nesting);
    return target === null ? null : readReferencedClass(target, ctx);
  }

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
 * Locate `targetQualifiedName`'s file by the pack's constant-to-path
 * convention, parse it, and read the declared shape off every class in
 * it with that exact qualified name. Null at any step that doesn't
 * resolve: no file at that path, no class in it with the exact
 * qualified name, or the matching class (or classes) states neither a
 * type-declaring call nor any field-declaring call.
 */
async function readReferencedClass(
  targetQualifiedName: string,
  ctx: FieldReadContext,
): Promise<FieldContract | null> {
  const filePath = resolveConstantFile(
    ctx.pattern.root,
    targetQualifiedName,
    ctx.pattern.pathConvention,
  );
  if (filePath === null) {
    return null;
  }
  const fileRoot = await ctx.cache.get(filePath);
  if (fileRoot === null) {
    return null;
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
    return null;
  }
  const knownClasses = new Set(allClasses.map((info) => info.qualifiedName));
  return readClassContract(matches, knownClasses, ctx.pattern);
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
    bodyContent: "absent",
    dependencyCalls: [],
    declaredContract: null,
    ...(graphqlDeclaredContract !== undefined
      ? { graphqlDeclaredContract }
      : {}),
  };
}
