/**
 * What a GraphQL field resolves to on each path through its method.
 *
 * The field's declared type comes first: the named type, a list of it or
 * a type the library generates from it, and whether it can be null. The
 * object type's fields go into the summary's definitions. Each path then
 * records what its code returns where that says more: nil becomes null,
 * a hash keeps its keys, and an instance of the library's error class
 * becomes a throw. What the code leaves unread takes the declared type.
 * The pack says which calls and keywords mean what.
 */

import { withChildShapes } from "@suss/ir-core";
import { shapeOfValue } from "@suss/values";

import { inheritedStatements } from "./ancestry.js";
import {
  booleanLiteralValue,
  children,
  field,
  hashKeySymbolName,
  rangeOf,
  readCallArgs,
  runStatements,
  stringLiteralValue,
  symbolValue,
} from "./ast.js";
import { rescuedValues } from "./facts/values.js";
import { withSlotSources } from "./provenance.js";
import { constructedClassOf } from "./raises.js";
import { valuesReturnedAt } from "./resolverHooks.js";
import { raiseEndings } from "./responseHandOff.js";
import {
  returnPathBranches,
  returnTerminal,
  withEffectsThatRun,
} from "./responseStatus.js";
import { compoundName, graphqlTypeNameFromQualified } from "./scope.js";
import {
  typeShapeFromNode,
  typeWrapperCall,
  WRAPPED_TYPE,
  wrappedTypeName,
} from "./typeShape.js";
import { evaluatedValue, possibleValueNodes } from "./values/evaluator.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawBranch, RawTerminal } from "@suss/extractor";
import type { Ancestry, ReachedBody } from "./ancestry.js";
import type { BlockConfigures, CallArgs, Range } from "./ast.js";
import type { BodyReport } from "./discovery.js";
import type { GraphqlObjectFields, RbGraphqlTypeWrapper } from "./pack.js";
import type { RbNode } from "./parser.js";
import type { TypeReadContext } from "./typeShape.js";

/** What a bare constant is resolved against: the nesting in effect, plus every class the file defines so shadowing can be detected. */
export interface FileScope {
  nesting: readonly string[];
  knownClasses: ReadonlySet<string>;
}

/** A type expression with the place it is written, so a constant in it is looked up from that file and nesting. */
export interface WrittenType {
  node: RbNode;
  scope: FileScope;
  file: string;
}

/** The shape a field declares it resolves to, and the records of the object types that shape refers to. */
export interface DeclaredOutput {
  shape: TypeShape;
  definitions: Record<string, TypeShape>;
}

/** A class the run reads, with its ancestry. */
export interface TypeClass {
  name: string;
  blocks: readonly ReachedBody[];
  ancestry: Ancestry;
}

/** What reading a declared type needs from discovery. */
export interface TypeClassReader {
  pattern: GraphqlObjectFields;
  /** The class a constant refers to where it is written, or null when the run does not read it. */
  classAt(written: WrittenType): Promise<TypeClass | null>;
  /** The `location.file` a summary written in `file` gets. */
  displayPath(file: string): string;
  /** A block on one of the pack's DSL calls configures that call, so its statements are not the class's. */
  blockConfigures: BlockConfigures;
}

export function typeContext(
  scope: FileScope,
  pattern: GraphqlObjectFields,
): TypeReadContext {
  return {
    nesting: scope.nesting,
    knownClasses: scope.knownClasses,
    scalars: pattern.scalars,
    scalarNamePrefixes: pattern.scalarNamePrefixes,
    typeNameConvention: pattern.typeNameConvention,
    ...(pattern.typeWrappers === undefined
      ? {}
      : {
          typeWrapperNames: Object.fromEntries(
            Object.entries(pattern.typeWrappers).map(([method, wrapper]) => [
              method,
              wrapper.name,
            ]),
          ),
        }),
  };
}

/** The name the schema exposes a field or argument under. */
export function resolvedName(
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

/** The type a field call gives itself, positionally or under the pack's type keyword. */
export function ownTypeNode(
  callArgs: CallArgs,
  pattern: GraphqlObjectFields,
): RbNode | undefined {
  return (
    callArgs.positional[1] ??
    (pattern.typeKeyword === undefined
      ? undefined
      : callArgs.keyword[pattern.typeKeyword])
  );
}

/** What a call's null keyword says, or null when it says nothing a reader can settle. */
export function nullKeywordOf(
  callArgs: CallArgs,
  pattern: GraphqlObjectFields,
): boolean | null {
  const keyword = pattern.nullability?.keyword;
  const node = keyword === undefined ? undefined : callArgs.keyword[keyword];
  return node === undefined ? null : booleanLiteralValue(node);
}

/** Whether a field can be null, from its own call, then its wired class, then the library's default. */
export function fieldIsNullable(
  own: boolean | null,
  wired: boolean | null,
  pattern: GraphqlObjectFields,
): boolean {
  if (pattern.nullability === undefined) {
    return false;
  }
  return own ?? wired ?? pattern.nullability.nullableByDefault;
}

/** The name a class sets for itself with the pack's naming call, or null when it sets none. */
export function ownGraphqlName(
  blocks: readonly ReachedBody[],
  pattern: GraphqlObjectFields,
  blockConfigures: BlockConfigures,
): string | null {
  const callName = pattern.typeNameCallName;
  if (callName === undefined) {
    return null;
  }
  for (const block of blocks) {
    const body = block.info.bodyNode;
    if (body === null) {
      continue;
    }
    for (const statement of runStatements(body, blockConfigures)) {
      const name = namingCallValue(statement, callName);
      if (name !== null) {
        return name;
      }
    }
  }
  return null;
}

function namingCallValue(statement: RbNode, callName: string): string | null {
  if (
    statement.type !== "call" ||
    field(statement, "receiver") !== null ||
    field(statement, "method")?.text !== callName
  ) {
    return null;
  }
  const first = readCallArgs(field(statement, "arguments")).positional[0];
  return first === undefined ? null : stringLiteralValue(first);
}

/** The GraphQL name of a class the run read: its own naming call, or the convention. */
function graphqlNameOfClass(found: TypeClass, reader: TypeClassReader): string {
  return (
    ownGraphqlName(found.blocks, reader.pattern, reader.blockConfigures) ??
    graphqlTypeNameFromQualified(found.name, reader.pattern.typeNameConvention)
  );
}

export function orNull(shape: TypeShape, nullable: boolean): TypeShape {
  return nullable
    ? { type: "union", variants: [shape, { type: "null" }] }
    : shape;
}

/** The fields an object type class declares across its ancestry, each with null where the schema allows it. */
export function objectTypeFields(
  ancestry: Ancestry,
  reader: TypeClassReader,
): Record<string, TypeShape> {
  const pattern = reader.pattern;
  const properties: Record<string, TypeShape> = {};
  for (const { block, statement } of inheritedStatements(
    ancestry,
    reader.blockConfigures,
  )) {
    if (
      statement.type !== "call" ||
      field(statement, "receiver") !== null ||
      field(statement, "method")?.text !== pattern.fieldCallName
    ) {
      continue;
    }
    const callArgs = readCallArgs(field(statement, "arguments"));
    const nameArg = callArgs.positional[0];
    const symbol = nameArg === undefined ? null : symbolValue(nameArg);
    if (symbol === null) {
      continue;
    }
    const scope: FileScope = {
      nesting: block.info.bodyNesting,
      knownClasses: block.knownClasses,
    };
    const typeNode = ownTypeNode(callArgs, pattern);
    const shape =
      typeNode === undefined
        ? null
        : itemsMarked(typeNode, typeContext(scope, pattern), pattern);
    properties[resolvedName(symbol, callArgs, pattern)] = orNull(
      shape ?? { type: "unknown" },
      fieldIsNullable(nullKeywordOf(callArgs, pattern), null, pattern),
    );
  }
  return properties;
}

/** A type shape whose lists say whether their items can be null, read without opening any class. */
function itemsMarked(
  node: RbNode,
  ctx: TypeReadContext,
  pattern: GraphqlObjectFields,
): TypeShape | null {
  if (node.type !== "array") {
    return typeShapeFromNode(node, ctx);
  }
  const inner = listItemNode(node);
  const items = inner === null ? null : itemsMarked(inner, ctx, pattern);
  return items === null
    ? null
    : { type: "array", items: orNull(items, listItemsNullable(node, pattern)) };
}

/** The item type in `[Types::X]` or `[Types::X, null: true]`. */
function listItemNode(list: RbNode): RbNode | null {
  return (
    children(list).find(
      (child) => child.type !== "pair" && child.type !== "hash",
    ) ?? null
  );
}

/** Whether `[Types::X, null: true]` lets its items be null. */
function listItemsNullable(
  list: RbNode,
  pattern: GraphqlObjectFields,
): boolean {
  const nullability = pattern.nullability;
  if (nullability === undefined) {
    return false;
  }
  const pairs = children(list).flatMap((child) =>
    child.type === "hash" ? children(child) : [child],
  );
  for (const pair of pairs) {
    const key = field(pair, "key");
    const value = field(pair, "value");
    if (
      pair.type === "pair" &&
      key !== null &&
      value !== null &&
      hashKeySymbolName(key) === nullability.keyword
    ) {
      return (
        booleanLiteralValue(value) ?? nullability.listItemsNullableByDefault
      );
    }
  }
  return nullability.listItemsNullableByDefault;
}

/** The output a type expression declares, with its object type read from its class. Null when the pack does not read the expression. */
export async function declaredOutput(
  written: WrittenType,
  nullable: boolean,
  reader: TypeClassReader,
): Promise<DeclaredOutput | null> {
  const definitions: Record<string, TypeShape> = {};
  const shape = await coreShape(written, reader, definitions);
  return shape === null
    ? null
    : { shape: orNull(shape, nullable), definitions };
}

async function coreShape(
  written: WrittenType,
  reader: TypeClassReader,
  definitions: Record<string, TypeShape>,
): Promise<TypeShape | null> {
  const { node } = written;
  const pattern = reader.pattern;
  if (node.type === "array") {
    const inner = listItemNode(node);
    const items =
      inner === null
        ? null
        : await coreShape({ ...written, node: inner }, reader, definitions);
    return items === null
      ? null
      : {
          type: "array",
          items: orNull(items, listItemsNullable(node, pattern)),
        };
  }

  const ctx = typeContext(written.scope, pattern);
  const wrapperCall = typeWrapperCall(node, ctx.typeWrapperNames);
  const wrapper =
    wrapperCall === null
      ? undefined
      : pattern.typeWrappers?.[wrapperCall.method];
  if (wrapperCall !== null && wrapper !== undefined) {
    const wrapped = await coreShape(
      { ...written, node: wrapperCall.wrapped },
      reader,
      definitions,
    );
    if (wrapped?.type !== "ref") {
      return null;
    }
    const passed = readCallArgs(field(node, "arguments")).keyword;
    const typeArguments: Record<string, TypeShape> = {};
    for (const [keyword, fallback] of Object.entries(
      wrapper.typeArguments ?? {},
    )) {
      const given = passed[keyword];
      const read =
        given === undefined
          ? null
          : await coreShape({ ...written, node: given }, reader, definitions);
      typeArguments[`{${keyword}}`] = read ?? {
        type: "ref",
        name: fallback,
        def: fallback,
      };
    }
    return generatedType(
      wrapper,
      { wrapped, typeArguments },
      definitions,
      pattern,
    );
  }

  const plain = typeShapeFromNode(node, ctx);
  if (plain?.type !== "ref") {
    return plain;
  }
  const found = await reader.classAt(written);
  if (found === null) {
    return plain;
  }
  const name = graphqlNameOfClass(found, reader);
  definitions[name] ??= {
    type: "record",
    properties: objectTypeFields(found.ancestry, reader),
  };
  const file = found.blocks[0]?.file;
  return {
    type: "ref",
    name,
    def: name,
    ...(file === undefined ? {} : { from: reader.displayPath(file) }),
  };
}

type RefShape = Extract<TypeShape, { type: "ref" }>;

/** The type a wrapper generates around `wrapped`, with the types it generates and the library types they use in `definitions`. */
function generatedType(
  wrapper: RbGraphqlTypeWrapper,
  around: { wrapped: RefShape; typeArguments: Record<string, TypeShape> },
  definitions: Record<string, TypeShape>,
  pattern: GraphqlObjectFields,
): TypeShape {
  const { wrapped, typeArguments } = around;
  const named = (template: string) => wrappedTypeName(template, wrapped.name);
  const generated = new Set(Object.keys(wrapper.types).map(named));
  const library = pattern.libraryTypes ?? {};
  const placed = (shape: TypeShape): TypeShape =>
    mapRefs(shape, (ref) => {
      if (ref.name === WRAPPED_TYPE) {
        return wrapped;
      }
      const argument = typeArguments[ref.name];
      if (argument !== undefined) {
        return argument;
      }
      const name = named(ref.name);
      return generated.has(name) || library[name] !== undefined
        ? { type: "ref", name, def: name }
        : { type: "ref", name };
    });
  for (const [template, fields] of Object.entries(wrapper.types)) {
    definitions[named(template)] = placed({
      type: "record",
      properties: fields,
    });
  }
  for (const [name, fields] of Object.entries(library)) {
    if (refersTo(Object.values(definitions), name)) {
      definitions[name] = { type: "record", properties: fields };
    }
  }
  const name = named(wrapper.name);
  return { type: "ref", name, def: name };
}

/** The shape with every ref replaced by what `replace` gives for it. */
function mapRefs(
  shape: TypeShape,
  replace: (ref: RefShape) => TypeShape,
): TypeShape {
  if (shape.type === "ref") {
    return replace(shape);
  }
  return withChildShapes(shape, (inner) => mapRefs(inner, replace));
}

function refersTo(shapes: readonly TypeShape[], name: string): boolean {
  let found = false;
  for (const shape of shapes) {
    mapRefs(shape, (ref) => {
      found ||= ref.name === name;
      return ref;
    });
  }
  return found;
}

/** The declared output as a contract writes it: null left out and refs back to names alone, the way a contract read from SDL writes the field. */
export function contractShapeOf(output: TypeShape): TypeShape {
  const inner = withoutNull(output);
  if (inner.type === "ref") {
    return { type: "ref", name: inner.name };
  }
  return withChildShapes(inner, contractShapeOf);
}

function withoutNull(shape: TypeShape): TypeShape {
  if (shape.type !== "union") {
    return shape;
  }
  const kept = shape.variants.filter((variant) => variant.type !== "null");
  return kept.length === 1
    ? (kept[0] as TypeShape)
    : { type: "union", variants: kept };
}

/** What reading a resolver's paths needs. */
export interface ResolverRead {
  method: RbNode;
  body: BodyReport;
  declared: DeclaredOutput | null;
  facts: Database | undefined;
  errorClassNames: readonly string[];
}

/**
 * One branch per path through the method behind a field: a raise throws,
 * and every other ending resolves the field to what it returns. An ending
 * that can return an error instance gets a throw beside its return.
 */
export function resolverBranches(read: ResolverRead): RawBranch[] {
  const { method, body, facts } = read;
  const effects = body.effects ?? [];
  const range = rangeOf(method);
  const endings = new Map<RawTerminal, Ending>();
  const endingAt = (values: readonly RbNode[], location: Range) => {
    const ending = resolverEnding(values, location, read);
    endings.set(ending.terminal, ending);
    return ending.terminal;
  };
  const branches = returnPathBranches(
    method,
    effects,
    [],
    facts,
    undefined,
    raiseEndings(method, facts),
    (statement, location) =>
      endingAt(possibleEndings(method, statement), location),
  ) ?? [
    {
      conditions: [],
      terminal: endingAt([], range),
      effects: [],
      location: range,
      isDefault: true,
    },
  ];
  return withSlotSources(
    branches
      .flatMap((branch) => withReturnedErrors(branch, endings))
      .map((branch) =>
        withEffectsThatRun(branch, {
          effects,
          extraEffects: body.extraEffects,
        }),
      ),
    body.provenance,
  );
}

/** What one ending resolves the field to, and the error classes it can return in place of a value. */
interface Ending {
  terminal: RawTerminal;
  errors: readonly string[];
  /** False when every value the ending can return is an error. */
  valueToo: boolean;
}

/** The branch, preceded by one throw for each error its ending can return, and left out when it returns nothing else. */
function withReturnedErrors(
  branch: RawBranch,
  endings: ReadonlyMap<RawTerminal, Ending>,
): RawBranch[] {
  const ending = endings.get(branch.terminal);
  if (ending === undefined || ending.errors.length === 0) {
    return [branch];
  }
  const throws = ending.errors.map(
    (exceptionType): RawBranch => ({
      ...branch,
      terminal: {
        ...returnTerminal(branch.terminal.location),
        kind: "throw",
        exceptionType,
      },
      isDefault: false,
    }),
  );
  return ending.valueToo ? [...throws, branch] : throws;
}

/**
 * The values a path can end on: what its `return` writes, or for the end
 * of the body its last statement and what each of its `rescue` clauses
 * ends on, since a raise the path does not show can land in one.
 */
function possibleEndings(method: RbNode, statement: RbNode | null): RbNode[] {
  const [value] = valuesReturnedAt(method, statement);
  const body = field(method, "body");
  const rescued =
    statement === null && body?.type === "body_statement"
      ? rescuedValues(body)
      : [];
  return [...(value === undefined ? [] : [value]), ...rescued];
}

/** What a path that ends on one of these values resolves the field to. The first is the value the path itself ends on. */
function resolverEnding(
  values: readonly RbNode[],
  location: Range,
  read: ResolverRead,
): Ending {
  const first = values[0];
  if (first === undefined) {
    return {
      terminal: returnWith({ type: "null" }, location),
      errors: [],
      valueToo: true,
    };
  }
  const code = shapeOfValue(evaluatedValue(first, read.facts));
  const shape = outputShape(code, read.declared);
  const each = values.map((value) => returnedErrors(value, read));
  return {
    terminal:
      shape === null ? returnTerminal(location) : returnWith(shape, location),
    errors: [...new Set(each.flatMap((one) => one.errors))],
    valueToo: each.some((one) => one.valueToo),
  };
}

function returnWith(shape: TypeShape, location: Range): RawTerminal {
  return { ...returnTerminal(location), body: { typeText: null, shape } };
}

/** The error classes the pack lists that a returned value can be an instance of, and whether it can be anything else. */
function returnedErrors(
  value: RbNode,
  read: ResolverRead,
): { errors: string[]; valueToo: boolean } {
  const direct = constructedClassOf(value, undefined);
  const written =
    direct === null ? possibleValueNodes(value, read.facts) : [value];
  const errors = new Set<string>();
  let valueToo = written.length === 0;
  for (const node of written) {
    const built = node === null ? null : constructedClassOf(node, undefined);
    const name = built === null ? null : compoundName(built);
    if (name !== null && read.errorClassNames.includes(name)) {
      errors.add(name);
    } else {
      valueToo = true;
    }
  }
  return { errors: [...errors], valueToo };
}

/** What a path's code returns, with the declared type filling in each part the code leaves unread. Null when neither says anything. */
export function outputShape(
  code: TypeShape,
  declared: DeclaredOutput | null,
): TypeShape | null {
  if (declared === null) {
    return code.type === "unknown" ? null : code;
  }
  return filledIn(code, declared.shape, declared.definitions);
}

type Fill = (
  code: TypeShape,
  declared: TypeShape,
  definitions: Record<string, TypeShape>,
) => TypeShape;

const FILLERS: { [K in TypeShape["type"]]?: Fill } = {
  unknown: (_code, declared) => declared,
  union: (code, declared, definitions) =>
    withChildShapes(code, (variant) =>
      filledIn(variant, declared, definitions),
    ),
  record: (code, declared, definitions) => {
    const target = definedShape(declared, definitions);
    if (code.type !== "record" || target?.type !== "record") {
      return code;
    }
    return {
      ...code,
      properties: Object.fromEntries(
        Object.entries(code.properties).map(([key, inner]) => {
          const wanted = target.properties[key];
          return [
            key,
            wanted === undefined ? inner : filledIn(inner, wanted, definitions),
          ];
        }),
      ),
    };
  },
  array: (code, declared, definitions) => {
    const target = definedShape(declared, definitions);
    return code.type === "array" && target?.type === "array"
      ? {
          type: "array",
          items: filledIn(code.items, target.items, definitions),
        }
      : code;
  },
};

function filledIn(
  code: TypeShape,
  declared: TypeShape,
  definitions: Record<string, TypeShape>,
): TypeShape {
  return FILLERS[code.type]?.(code, declared, definitions) ?? code;
}

/** The declared shape with null left out and a ref replaced by its definition, to set the code's own structure against. */
function definedShape(
  declared: TypeShape,
  definitions: Record<string, TypeShape>,
): TypeShape | null {
  const only = withoutNull(declared);
  if (only.type === "union") {
    return null;
  }
  if (only.type !== "ref") {
    return only;
  }
  return only.def === undefined ? null : (definitions[only.def] ?? null);
}
