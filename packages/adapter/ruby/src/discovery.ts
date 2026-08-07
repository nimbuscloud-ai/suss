// discovery.ts: find graphql-ruby class DSL fields and turn each into a
// RawCodeStructure.
//
// v0 discovers a `field` call written directly in the body of a class
// whose superclass names a pack-configured base class (graphql-ruby's
// class DSL) and reads no further: the boundary binding and the
// declared contract are what the call's own arguments state, nothing
// traced through a resolver's `resolve` method body. That's the
// existence-class shape the language-adapters proposal calls for: a
// resolver low-confidence enough to state nothing about behavior
// nobody read, transitionless (`branches: []`), enough to pair against
// a client operation by (typeName, fieldName).
//
// `field :x, mutation: Mutations::Y` and `field :x, resolver: Queries::Z`
// are the one-hop exception: the field itself declares no type, so its
// declared contract comes from the referenced class's own `type` call
// (a Resolver's declared return type) or its own `field` calls (a
// Mutation's payload, read as a record). The referenced class is
// located by Rails' constant-to-path convention, parsed once per file
// and cached, and read with the same per-statement reader this module
// already uses for the discovering class's own body. A class reopened
// more than once in that file (ordinary Ruby) contributes every block
// to the same contract, in the order Ruby would evaluate them, and a
// field or argument redefined along the way keeps its last-written
// shape, the same registration semantics graphql-ruby's own field
// storage has.

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

/**
 * A parsed file, kept by absolute path, so a `mutation:` / `resolver:`
 * class referenced from several fields (or a file that is both a
 * project file and someone else's one-hop target) is parsed once. See
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

/** What a one-hop `mutation:` / `resolver:` lookup needs beyond the field's own scope: where to look, and how to read a name once found. */
interface FieldReadContext {
  pattern: GraphqlObjectFields;
  cache: FileCache;
  camelizeDefault: boolean;
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
  const typeName = graphqlTypeNameFromQualified(info.qualifiedName);
  const ctx: FieldReadContext = {
    pattern,
    cache: options.cache,
    camelizeDefault: pattern.camelize ?? true,
  };
  const scope: FileScope = { nesting: info.bodyNesting, knownClasses };

  // graphql-ruby stores fields by name, so a field redefined later in
  // the same body replaces the earlier declaration rather than the two
  // coexisting. A Map keyed by the resolved field name keeps the
  // insertion order of the first sighting while letting a later
  // statement overwrite the stored declaration, so the discovered unit
  // is the one graphql-ruby itself would end up with.
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
 * Read one `field` call from an object type's own body. A field name
 * this module can't read (anything but a plain symbol literal) means
 * there's no unit to discover at all; a field whose declared shape
 * this module can't read still gets discovered, with no declared
 * contract, per the language-adapters proposal's unresolved
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
  if (field(stmt, "method")?.text !== "field") {
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
    fieldName: resolvedName(symbol, callArgs, ctx.camelizeDefault),
    node: stmt,
    contract,
  };
}

/**
 * The field's own declared shape: a literal type argument, or, for
 * `mutation:` / `resolver:` wiring, the referenced class's own
 * declaration read from its file. Null when neither is readable (no
 * type argument and no wiring keyword, or a type expression that
 * isn't a literal constant path).
 */
async function declaredContractFor(
  callArgs: CallArgs,
  scope: FileScope,
  ctx: FieldReadContext,
): Promise<FieldContract | null> {
  const oneHopRef = callArgs.keyword.mutation ?? callArgs.keyword.resolver;
  if (oneHopRef !== undefined) {
    const target = qualifyConstantRef(oneHopRef, scope.nesting);
    return target === null ? null : readReferencedClass(target, ctx);
  }

  const typeArg = callArgs.positional[1];
  if (typeArg === undefined) {
    return null;
  }
  const returnType = typeShapeFromNode(
    typeArg,
    scope.nesting,
    scope.knownClasses,
  );
  return returnType === null ? null : { returnType, args: [] };
}

/**
 * Locate `targetQualifiedName`'s file by the Rails constant-to-path
 * convention, parse it, and read the declared shape off every class in
 * it with that exact qualified name. Null at any step that doesn't
 * resolve: no file at that path, no class in it with the exact
 * qualified name, or the matching class (or classes) states neither a
 * `type` call nor any `field` call.
 */
async function readReferencedClass(
  targetQualifiedName: string,
  ctx: FieldReadContext,
): Promise<FieldContract | null> {
  const filePath = resolveConstantFile(ctx.pattern.root, targetQualifiedName);
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
  return readClassContract(matches, knownClasses, ctx.camelizeDefault);
}

interface ClassContractAccumulator {
  /** Set by a `type` call (a Resolver's own declared return type). */
  typeCallShape: TypeShape | null;
  /** Built from `field` calls (a Mutation's own payload). */
  fieldProperties: Record<string, TypeShape>;
  args: Map<string, ArgDeclaration>;
}

type ClassCallHandler = (
  callArgs: CallArgs,
  scope: FileScope,
  camelizeDefault: boolean,
  out: ClassContractAccumulator,
) => void;

const CLASS_CALL_HANDLERS: Record<string, ClassCallHandler> = {
  type: (callArgs, scope, _camelizeDefault, out) => {
    const typeArg = callArgs.positional[0];
    if (typeArg !== undefined) {
      out.typeCallShape = typeShapeFromNode(
        typeArg,
        scope.nesting,
        scope.knownClasses,
      );
    }
  },
  field: (callArgs, scope, camelizeDefault, out) => {
    const nameArg = callArgs.positional[0];
    const symbol = nameArg !== undefined ? symbolValue(nameArg) : null;
    const typeArg = callArgs.positional[1];
    if (symbol === null || typeArg === undefined) {
      return;
    }
    const name = resolvedName(symbol, callArgs, camelizeDefault);
    out.fieldProperties[name] = typeShapeFromNode(
      typeArg,
      scope.nesting,
      scope.knownClasses,
    ) ?? { type: "unknown" };
  },
  argument: (callArgs, scope, camelizeDefault, out) => {
    const nameArg = callArgs.positional[0];
    const symbol = nameArg !== undefined ? symbolValue(nameArg) : null;
    if (symbol === null) {
      return;
    }
    const typeArg = callArgs.positional[1];
    const shape =
      typeArg !== undefined
        ? typeShapeFromNode(typeArg, scope.nesting, scope.knownClasses)
        : null;
    const requiredNode = callArgs.keyword.required;
    // graphql-ruby arguments are required by default; `required: false`
    // is how a project opts out. Not a guess about project code, the
    // library's own default.
    const required =
      requiredNode !== undefined
        ? (booleanLiteralValue(requiredNode) ?? true)
        : true;
    const name = resolvedName(symbol, callArgs, camelizeDefault);
    out.args.set(name, {
      name,
      type: shape ?? { type: "unknown" },
      required,
      typeText: typeArg?.text ?? null,
    });
  },
};

/**
 * Read every matching block's `type` / `field` / `argument` calls into
 * one declared contract, processed in the order `matches` lists them
 * (source order, since `walkClasses` walks top to bottom): a `type`
 * call wins when present (the Resolver shape); otherwise the `field`
 * calls found become a record (the Mutation payload shape). A field or
 * argument named more than once, whether across reopened blocks or
 * within one, keeps its last-written declaration, both `Map`- and
 * object-key assignment naturally doing that as later statements
 * overwrite earlier ones under the same name. Null when nothing
 * matching states either shape.
 */
function readClassContract(
  matches: ClassInfo[],
  knownClasses: ReadonlySet<string>,
  camelizeDefault: boolean,
): FieldContract | null {
  const out: ClassContractAccumulator = {
    typeCallShape: null,
    fieldProperties: {},
    args: new Map(),
  };

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
      const handler =
        method !== undefined ? CLASS_CALL_HANDLERS[method] : undefined;
      if (handler === undefined) {
        continue;
      }
      handler(
        readCallArgs(field(stmt, "arguments")),
        scope,
        camelizeDefault,
        out,
      );
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
 * graphql-ruby's own default field/argument naming: a symbol written
 * in Ruby's snake_case convention is exposed on the schema in
 * camelCase (`field :campaign_update` becomes the `campaignUpdate`
 * field, `argument :campaign_id` becomes `campaignId`). `camelizeDefault`
 * is the pack's own configured default (graphql-ruby's own default is
 * `true`; a project's schema-wide `camelize: false` sets it to
 * `false` through the pack's own `camelize` option); a `camelize:`
 * keyword on this specific call overrides that default for this one
 * name, the same as it overrides graphql-ruby's own schema-wide
 * setting at runtime.
 */
function resolvedName(
  symbol: string,
  callArgs: CallArgs,
  camelizeDefault: boolean,
): string {
  const override = callArgs.keyword.camelize;
  const camelizeThis =
    override !== undefined
      ? (booleanLiteralValue(override) ?? camelizeDefault)
      : camelizeDefault;
  return camelizeThis ? camelize(symbol) : symbol;
}

function camelize(name: string): string {
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
