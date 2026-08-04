// typeShapes.ts — Translate a ts-morph Type into a TypeShape.
//
// This is the type-checker fallback for `extractShape`: when a syntactic walk
// of an expression can't decompose it (e.g. a bare identifier, a call, a
// property chain), we ask the type checker what the expression's type is and
// convert that Type into our language-agnostic shape vocabulary.
//
// Two realities shape the design:
//
//   1. TypeScript types are recursive and can be unboundedly large (think
//      `Window`, `Array<T>`, mutually recursive interfaces). A naive walk will
//      never terminate or explode memory. We cap recursion by depth AND by
//      remembering types we're already expanding on the current path.
//
//   2. Not every type is worth expanding. `Date`, `Buffer`, `RegExp`, DOM
//      classes — their structural shape doesn't match how callers actually
//      use them. We keep those as `ref` with the declared type name and stop.
//      The same goes for every other type the project did not write: the
//      name is what a reader wants, and the fields belong to the library.
//
// The public entry point takes a `Node` so we can resolve types at a specific
// location (generic type params depend on use-site context) without forcing
// callers to plumb Types through themselves.

import { createHash } from "node:crypto";

import { definitionsInProgress } from "./definitions.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { Node, SourceFile, Symbol as TsSymbol, Type } from "ts-morph";

/**
 * Maximum recursion depth when expanding object properties. Beyond this we
 * collapse to an unnamed `ref` — the alternative is stack overflow on deep
 * nominal types (React's `HTMLElement`, etc.).
 */
const MAX_DEPTH = 6;

/**
 * Named types that we intentionally do NOT expand — their structural shape
 * doesn't help anyone reasoning about response bodies. Callers read them as
 * opaque references and trust the name.
 */
const OPAQUE_NAMED_TYPES = new Set([
  "Date",
  "RegExp",
  "Error",
  "Buffer",
  "ArrayBuffer",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "URL",
  "URLSearchParams",
  "FormData",
  "Blob",
  "File",
]);

interface ConvertContext {
  enclosing: Node;
  depth: number;
  seen: Set<string>;
}

/**
 * Convert the type of `node` (as inferred by the type checker at that
 * location) into a `TypeShape`. Returns `null` when the type is too
 * uninformative to bother representing (e.g. `any`).
 */
export function shapeFromNodeType(node: Node): TypeShape | null {
  const type = node.getType();
  return typeToShape(type, {
    enclosing: node,
    depth: 0,
    seen: new Set(),
  });
}

/**
 * Convert an already-obtained `Type` at the given enclosing node into a
 * `TypeShape`. Exposed for callers that already hold a Type — same semantics
 * as `shapeFromNodeType` otherwise.
 */
export function shapeFromType(type: Type, enclosing: Node): TypeShape | null {
  return typeToShape(type, { enclosing, depth: 0, seen: new Set() });
}

function typeToShape(type: Type, ctx: ConvertContext): TypeShape | null {
  // `any` tells us nothing. Let callers decide what to do with null (usually
  // keep as source-text ref).
  if (type.isAny()) {
    return null;
  }

  if (type.isUnknown()) {
    return { type: "unknown" };
  }

  // `never` is a no-throughput type. We model it as unknown rather than
  // inventing a new variant — callers shouldn't be reasoning about
  // unreachable values.
  if (type.isNever()) {
    return { type: "unknown" };
  }

  if (type.isNull()) {
    return { type: "null" };
  }

  if (type.isUndefined() || type.isVoid()) {
    return { type: "undefined" };
  }

  // Literal types come through before `isString`/`isNumber`/`isBoolean`
  // (those also return true for literal types). Preserve the literal —
  // consumers can widen to `text`/`number`/`boolean` by inspecting `value`.
  if (type.isStringLiteral()) {
    const v = type.getLiteralValue();
    if (typeof v === "string") {
      return { type: "literal", value: v };
    }
    return { type: "text" };
  }
  if (type.isNumberLiteral()) {
    const v = type.getLiteralValue();
    if (typeof v === "number") {
      // We only have the `number` form from the type checker; `String(v)`
      // is a faithful `raw` for values that fit in double precision.
      // Callers extracting from the AST populate `raw` from actual source
      // text to preserve hex / scientific / big-integer notations.
      return { type: "literal", value: v, raw: String(v) };
    }
    return { type: "number" };
  }
  if (type.isBooleanLiteral()) {
    const text = type.getText(ctx.enclosing);
    return { type: "literal", value: text === "true" };
  }

  if (type.isString()) {
    return { type: "text" };
  }
  if (type.isBoolean()) {
    return { type: "boolean" };
  }
  if (type.isNumber()) {
    // Plain `number` type — we can't tell integer vs float, so surface the
    // wider `number` variant.
    return { type: "number" };
  }

  // BigInt — no dedicated variant; surface as a named ref.
  if (type.isBigInt() || type.isBigIntLiteral()) {
    return { type: "ref", name: "bigint" };
  }

  // Past this point every branch may recurse into typeToShape. The original
  // MAX_DEPTH guard lived only inside objectToShape, so cycles that go through
  // unions or arrays — e.g. `type Json = string | number | Json[] | { [k: string]: Json }`
  // — bypassed it and blew the stack. Gate every compound expansion centrally.
  if (ctx.depth >= MAX_DEPTH) {
    return refFromType(type, ctx);
  }

  // Cycle: a compound type already on the current expansion path collapses to
  // a ref instead of recursing. objectToShape already records itself; doing
  // the same for unions and intersections lets recursive aliases short-circuit
  // before depth runs out.
  const compoundKey = typeKey(type, ctx.enclosing);
  if ((type.isUnion() || type.isIntersection()) && ctx.seen.has(compoundKey)) {
    return refFromType(type, ctx);
  }

  if (type.isUnion()) {
    return unionToShape(type, withSeen(ctx, compoundKey));
  }

  if (type.isIntersection()) {
    // Intersections narrow a type — for records we want the merged property
    // set, so expand each operand and merge resulting records.
    return intersectionToShape(type, withSeen(ctx, compoundKey));
  }

  if (type.isArray() || type.isReadonlyArray()) {
    const elem = type.getArrayElementType();
    if (!elem) {
      return { type: "array", items: { type: "unknown" } };
    }
    const items: TypeShape = typeToShape(elem, descend(ctx)) ?? {
      type: "unknown",
    };
    return { type: "array", items };
  }

  if (type.isTuple()) {
    // Tuples have per-position types; we collapse to array<union<...>> so
    // downstream consumers see the element variety without tracking order.
    // Same-shape tuples (e.g. [string, string, string]) collapse to
    // array<text>.
    const elements = type.getTupleElements();
    if (elements.length === 0) {
      return { type: "array", items: { type: "unknown" } };
    }
    const items: TypeShape[] = elements.map(
      (e): TypeShape => typeToShape(e, descend(ctx)) ?? { type: "unknown" },
    );
    return { type: "array", items: collapseVariants(items) };
  }

  // Callable types (functions) — we don't carry signatures into TypeShape.
  // Represent as a named ref so downstream can at least see "this is a
  // function type called X".
  if (type.getCallSignatures().length > 0) {
    return { type: "ref", name: "function" };
  }

  // Opaque named types — Date, Promise, Error, Map, etc. We don't expand
  // their properties; callers read them as refs.
  const namedRef = opaqueNamedRef(type, ctx);
  if (namedRef !== null) {
    return namedRef;
  }

  // A named type the project did not declare stops at its name. Its
  // property set describes the library rather than this codebase, and a
  // reader who sees `HTMLElement` already knows what came back. Expanding
  // one is also what produced gigabyte summaries: the DOM is a dense graph,
  // and `seen` only guards a single path, so the same type reached through
  // two properties expands twice all the way down to MAX_DEPTH.
  const outsideRef = outsideProjectRef(type, ctx);
  if (outsideRef !== null) {
    return outsideRef;
  }

  if (type.isObject() || type.isClassOrInterface()) {
    return namedOnce(type, ctx) ?? objectToShape(type, ctx);
  }

  // Enum types — each member is a string or number literal. Collect members
  // and surface as a union of primitives.
  if (type.isEnum() || type.isEnumLiteral()) {
    return enumToShape(type, ctx);
  }

  // Fallback: use the printed type text as a ref name.
  const text = type.getText(ctx.enclosing);
  if (text && text.length > 0 && text !== "__type") {
    return { type: "ref", name: text };
  }

  return null;
}

function unionToShape(type: Type, ctx: ConvertContext): TypeShape | null {
  // `boolean` is a union of `true | false` at the type level. Normalize that
  // back to a single boolean variant instead of emitting a union.
  if (type.isBoolean()) {
    return { type: "boolean" };
  }

  const variants = type.getUnionTypes();
  const shapes: TypeShape[] = [];
  for (const variant of variants) {
    const shape = typeToShape(variant, descend(ctx));
    if (shape !== null) {
      shapes.push(shape);
    }
  }

  if (shapes.length === 0) {
    return { type: "unknown" };
  }
  return collapseVariants(shapes);
}

function intersectionToShape(
  type: Type,
  ctx: ConvertContext,
): TypeShape | null {
  const parts = type.getIntersectionTypes();
  const records: Array<Extract<TypeShape, { type: "record" }>> = [];
  const nonRecords: TypeShape[] = [];

  for (const part of parts) {
    const shape = typeToShape(part, descend(ctx));
    if (!shape) {
      continue;
    }
    if (shape.type === "record") {
      records.push(shape);
    } else {
      nonRecords.push(shape);
    }
  }

  // If every operand produced a record, merge their properties.
  if (records.length === parts.length && records.length > 0) {
    const merged: Record<string, TypeShape> = {};
    for (const r of records) {
      Object.assign(merged, r.properties);
    }
    return { type: "record", properties: merged };
  }

  // Otherwise surface the intersection as the widest single operand or a
  // named ref — intersections between non-records don't have a clean TypeShape
  // equivalent.
  if (nonRecords.length === 1 && records.length === 0) {
    return nonRecords[0];
  }

  const text = type.getText(ctx.enclosing);
  return { type: "ref", name: text };
}

function objectToShape(type: Type, ctx: ConvertContext): TypeShape | null {
  const key = typeKey(type, ctx.enclosing);

  // Cycle: we're already expanding this type on the current path. Collapse
  // to a ref rather than recursing forever.
  if (ctx.seen.has(key)) {
    return refFromType(type, ctx);
  }

  if (ctx.depth >= MAX_DEPTH) {
    return refFromType(type, ctx);
  }

  const nextSeen = new Set(ctx.seen);
  nextSeen.add(key);
  const childCtx: ConvertContext = {
    enclosing: ctx.enclosing,
    depth: ctx.depth + 1,
    seen: nextSeen,
  };

  const symbols = type.getProperties();

  // Dictionary types: an index signature (`{ [key: string]: T }`,
  // `Record<string, T>`) without named properties. The key set is open.
  // If both a string and number index are present (rare — e.g. `Array`-like
  // structural types), prefer the string index since JSON dictionaries are
  // string-keyed on the wire.
  const indexType = type.getStringIndexType() ?? type.getNumberIndexType();
  if (symbols.length === 0 && indexType) {
    const values: TypeShape = typeToShape(indexType, childCtx) ?? {
      type: "unknown",
    };
    return { type: "dictionary", values };
  }

  const properties: Record<string, TypeShape> = {};
  for (const sym of symbols) {
    const name = sym.getName();
    const propType = propertyTypeOf(sym, ctx.enclosing);
    if (!propType) {
      properties[name] = { type: "unknown" };
      continue;
    }
    const propShape: TypeShape = typeToShape(propType, childCtx) ?? {
      type: "unknown",
    };
    properties[name] = sym.isOptional()
      ? addUndefinedVariant(propShape)
      : propShape;
  }

  // Some "object" types have no enumerable properties AND no index signature
  // (e.g. empty object literal type `{}`, structural types we can't
  // introspect). Emitting an empty record is misleading — it asserts
  // "definitely no fields" when we really mean "we don't know." Surface as a
  // ref in that case.
  if (symbols.length === 0) {
    return refFromType(type, ctx);
  }

  return { type: "record", properties };
}

function enumToShape(type: Type, ctx: ConvertContext): TypeShape {
  // If the enum type is a union of its member literal types, unionToShape
  // will already have deduped them. For a single-value enum, walk via
  // unionToShape semantics.
  if (type.isUnion()) {
    return unionToShape(type, ctx) ?? { type: "unknown" };
  }
  // Non-union enum literal — just a literal, already handled above. Defensive.
  return (
    typeToShape(type.getBaseTypeOfLiteralType(), descend(ctx)) ?? {
      type: "unknown",
    }
  );
}

function opaqueNamedRef(type: Type, ctx: ConvertContext): TypeShape | null {
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (!symbol) {
    return null;
  }
  const name = symbol.getName();
  if (!OPAQUE_NAMED_TYPES.has(name)) {
    return null;
  }
  // Include type args for generic containers (Map<K, V>, Promise<T>) so the
  // ref retains the observable type text. Fall back to the bare name if
  // getText() produces noise.
  const text = type.getText(ctx.enclosing);
  return { type: "ref", name: text && text.length > 0 ? text : name };
}

/**
 * A `ref` for a named type that every one of its declarations places
 * outside the project, or `null` when the type is one the project wrote and
 * is worth expanding.
 *
 * Anonymous types are expanded whatever file they were written in. The
 * compiler names a type literal or a mapped type `__type`, so `Partial<T>`
 * and the object type behind a schema builder land here with no name to
 * report, and a `ref` would say less than their fields do.
 */
function outsideProjectRef(type: Type, ctx: ConvertContext): TypeShape | null {
  const symbol = type.getSymbol();
  if (!symbol) {
    return null;
  }
  const name = symbol.getName();
  if (!name || name === "__type" || name === "__object") {
    return null;
  }
  const declarations = symbol.getDeclarations();
  if (declarations.length === 0) {
    return null;
  }
  const outside = declarations.every((d) =>
    isOutsideProject(d.getSourceFile()),
  );
  return outside ? refFromType(type, ctx) : null;
}

/** One answer per file: a run asks about the same library files constantly. */
const outsideProjectByFile = new WeakMap<object, boolean>();

/**
 * Whether a file belongs to something other than the code being read: the
 * default library, or a dependency. The compiler already tracks both, so
 * this asks it rather than matching paths.
 */
function isOutsideProject(file: SourceFile): boolean {
  const key = file.compilerNode;
  const memoised = outsideProjectByFile.get(key);
  if (memoised !== undefined) {
    return memoised;
  }
  const program = file.getProject().getProgram().compilerObject;
  const outside =
    program.isSourceFileDefaultLibrary(key) ||
    file.isFromExternalLibrary() ||
    file.isInNodeModules();
  outsideProjectByFile.set(key, outside);
  return outside;
}

/**
 * A name for a type we are not expanding, and where that name was
 * declared.
 *
 * Two modules each declaring a `User` used to produce the same ref, so
 * anything comparing them was comparing spellings. The declaring file
 * is what tells them apart, and it is left off for a name the language
 * or a dependency owns, since those do mean the same thing everywhere.
 */
/**
 * A named type written down once, and named here.
 *
 * A reader following the name finds it in the summary's table, and a
 * type mentioned twenty times costs one expansion rather than twenty.
 * Answers null when nothing is collecting definitions, or when the type
 * has no name to file it under, and the caller expands as before.
 */
function namedOnce(type: Type, ctx: ConvertContext): TypeShape | null {
  const table = definitionsInProgress();
  if (table === null) {
    return null;
  }
  const named = refFromType(type, ctx);
  if (named.type !== "ref") {
    return null;
  }
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  const name = symbol?.getName();
  if (name === undefined || name === "__type" || name === "__object") {
    return null;
  }

  const key = definitionKeyFor(type, named.name);
  const filed: TypeShape = { ...named, def: key };
  if (!table.has(key)) {
    // Reserved before expanding, so a type that refers to itself meets
    // its own key and stops rather than going round again.
    table.reserve(key);
    // Expanded as though nothing had been read yet. A definition read
    // at depth five and reused everywhere would make the summary
    // depend on which mention the walk reached first, which is a thing
    // suss is supposed to be free of.
    const expanded = objectToShape(type, {
      enclosing: ctx.enclosing,
      depth: 0,
      seen: new Set(),
    });
    if (expanded === null) {
      return null;
    }
    table.define(key, expanded);
  }
  return filed;
}

/**
 * What a type is, as a key.
 *
 * The name alone is not it. Every instantiation of one generic reports
 * the generic's own name, so `Omit<User, "secret">` and `Omit<Order,
 * "total">` are both `Omit`. The printed type says which is which, and
 * it is read from nowhere so two files spell the same type the same
 * way. The name stays on the front so a person reading the table can
 * still tell what they are looking at.
 */
function definitionKeyFor(type: Type, name: string): string {
  const written = withoutImportQualifiers(type.getText());
  return `${name}@${shortHash(written)}`;
}

function shortHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function refFromType(type: Type, ctx: ConvertContext): TypeShape {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol) {
    const name = symbol.getName();
    if (name && name !== "__type" && name !== "__object") {
      const declaredIn = declaringFileOf(symbol);
      return declaredIn === null
        ? { type: "ref", name }
        : { type: "ref", name, from: declaredIn };
    }
  }
  // An anonymous type has no declaration to point at, so its text is
  // the name. That text is read without an enclosing node: what
  // `getText` prints for a name depends on what is in scope where you
  // are standing, and the same type reached from two files has to come
  // out the same. Reading it from nowhere qualifies an imported name
  // with the absolute path it came from, which is one machine's
  // answer, so that qualifier comes back off.
  return { type: "ref", name: withoutImportQualifiers(type.getText()) };
}

const IMPORT_QUALIFIER = /import\("[^"]*"\)\./g;

const withoutImportQualifiers = (text: string): string =>
  text.replace(IMPORT_QUALIFIER, "");

/** The project file declaring this symbol, or null when nothing in the project does. */
function declaringFileOf(symbol: TsSymbol): string | null {
  for (const declaration of symbol.getDeclarations()) {
    const file = declaration.getSourceFile();
    if (!isOutsideProject(file)) {
      return file.getFilePath();
    }
  }
  return null;
}

function propertyTypeOf(sym: TsSymbol, enclosing: Node): Type | null {
  const decl = sym.getValueDeclaration() ?? sym.getDeclarations()[0];
  if (decl) {
    return sym.getTypeAtLocation(decl);
  }
  try {
    return sym.getTypeAtLocation(enclosing);
  } catch {
    return null;
  }
}

function addUndefinedVariant(shape: TypeShape): TypeShape {
  if (shape.type === "union") {
    if (shape.variants.some((v) => v.type === "undefined")) {
      return shape;
    }
    return {
      type: "union",
      variants: [...shape.variants, { type: "undefined" }],
    };
  }
  if (shape.type === "undefined") {
    return shape;
  }
  return { type: "union", variants: [shape, { type: "undefined" }] };
}

function collapseVariants(shapes: TypeShape[]): TypeShape {
  const deduped: TypeShape[] = [];
  const seen = new Set<string>();
  for (const shape of shapes) {
    const key = JSON.stringify(shape);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(shape);
  }
  if (deduped.length === 1) {
    return deduped[0];
  }
  return { type: "union", variants: deduped };
}

function descend(ctx: ConvertContext): ConvertContext {
  return { ...ctx, depth: ctx.depth + 1 };
}

function withSeen(ctx: ConvertContext, key: string): ConvertContext {
  if (ctx.seen.has(key)) {
    return ctx;
  }
  const seen = new Set(ctx.seen);
  seen.add(key);
  return { ...ctx, seen };
}

function typeKey(type: Type, enclosing: Node): string {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol) {
    const name = symbol.getName();
    const decls = symbol.getDeclarations();
    if (decls.length > 0) {
      const d = decls[0];
      return `${name}@${d.getSourceFile().getFilePath()}:${d.getStart()}`;
    }
    return `sym:${name}`;
  }
  return type.getText(enclosing);
}
