/**
 * @suss/framework-mongoose: recognize Mongoose model calls in
 * TypeScript and emit `interaction(class: "storage-access")` effects
 * on the transitions that contain them.
 *
 * Recognition is AST-based via ts-morph. A call is recognized by
 * where its METHOD is declared: `User.find(...)` matches because
 * `find` resolves to a declaration inside `node_modules/mongoose/`,
 * whatever `User` is called. The receiver is then walked back to the
 * `mongoose.model(...)` call that produced it to find the collection.
 * See the README for the full method list, the field- and
 * selector-extraction rules, and what v0 leaves out (aggregate,
 * bulkWrite, populate, and document methods other than save()).
 */

import {
  type CallExpression,
  Node as N,
  type NewExpression,
  type Node,
} from "ts-morph";

import { methodDeclaredIn } from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type {
  EffectArg,
  InvocationRecognizer,
  PatternPack,
} from "@suss/extractor";

const RECOGNITION = "@suss/framework-mongoose";
const STORAGE_SYSTEM = "mongodb";

/** Which arguments a static Model method takes its data from. */
interface MethodSpec {
  kind: "read" | "write";
  /** Position of the filter/conditions object. */
  filterArg?: number;
  /** Position of a scalar id, which Mongoose treats as an implicit `{ _id: id }` filter. */
  idArg?: number;
  /** Position of a read projection, an object or a space-delimited string. */
  projectionArg?: number;
  /** Position of an update document, whose `$`-prefixed keys nest the fields they touch. */
  updateArg?: number;
  /** Position of a plain document (or an array of them) a write states in full. */
  payloadArg?: number;
  /** Position of the field name `distinct` reads. */
  fieldArg?: number;
}

const METHODS: Record<string, MethodSpec> = {
  find: { kind: "read", filterArg: 0, projectionArg: 1 },
  findOne: { kind: "read", filterArg: 0, projectionArg: 1 },
  findById: { kind: "read", idArg: 0, projectionArg: 1 },
  countDocuments: { kind: "read", filterArg: 0 },
  exists: { kind: "read", filterArg: 0 },
  distinct: { kind: "read", fieldArg: 0, filterArg: 1 },
  create: { kind: "write", payloadArg: 0 },
  insertMany: { kind: "write", payloadArg: 0 },
  updateOne: { kind: "write", filterArg: 0, updateArg: 1 },
  updateMany: { kind: "write", filterArg: 0, updateArg: 1 },
  replaceOne: { kind: "write", filterArg: 0, payloadArg: 1 },
  deleteOne: { kind: "write", filterArg: 0 },
  deleteMany: { kind: "write", filterArg: 0 },
  findOneAndUpdate: { kind: "write", filterArg: 0, updateArg: 1 },
  findByIdAndUpdate: { kind: "write", idArg: 0, updateArg: 1 },
  findOneAndDelete: { kind: "write", filterArg: 0 },
  findByIdAndDelete: { kind: "write", idArg: 0 },
  findOneAndReplace: { kind: "write", filterArg: 0, payloadArg: 1 },
};

export interface MongooseRecognizerOptions {
  /**
   * Scope label for the storage binding. Defaults to `"default"`. Set
   * this when a project keeps more than one MongoDB connection and
   * wants their accesses paired separately.
   */
  scope?: string;
}

// ---------------------------------------------------------------------------
// Model / collection identity
// ---------------------------------------------------------------------------

interface ModelIdentity {
  modelName: string;
  collection: string;
}

/**
 * Regular-English pluralization, the part of Mongoose's own default
 * naming this pack reproduces. See the README for what it leaves out.
 */
function defaultCollectionName(modelName: string): string {
  const lower = modelName.toLowerCase();
  if (/[^aeiou]y$/.test(lower)) {
    return `${lower.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/.test(lower)) {
    return `${lower}es`;
  }
  return `${lower}s`;
}

/** The model a static-call receiver (`User` in `User.find(...)`) refers to. */
function resolveModelIdentity(
  node: Node,
  resolve: (value: Node) => Node | null,
): ModelIdentity | null {
  if (N.isCallExpression(node)) {
    return modelIdentityFromModelCall(node, resolve);
  }
  if (!N.isIdentifier(node)) {
    return null;
  }
  const symbol = node.getSymbol();
  if (symbol === undefined) {
    return null;
  }
  for (const decl of symbol.getDeclarations()) {
    const identity = modelIdentityFromDeclaration(decl, resolve);
    if (identity !== null) {
      return identity;
    }
  }
  return null;
}

/** A declaration reached through an import goes one hop further; a re-export barrel is not chased past that. */
function modelIdentityFromDeclaration(
  decl: Node,
  resolve: (value: Node) => Node | null,
): ModelIdentity | null {
  if (N.isImportSpecifier(decl)) {
    const symbol = decl.getNameNode().getSymbol();
    for (const target of symbol?.getAliasedSymbol()?.getDeclarations() ?? []) {
      const identity = modelIdentityFromDeclaration(target, resolve);
      if (identity !== null) {
        return identity;
      }
    }
    return null;
  }
  if (!N.isVariableDeclaration(decl)) {
    return null;
  }
  const init = decl.getInitializer();
  if (init === undefined || !N.isCallExpression(init)) {
    return null;
  }
  return modelIdentityFromModelCall(init, resolve);
}

/** Whether `call` is `mongoose.model(...)` or a bare `model(...)` import, and which model it declares. */
function modelIdentityFromModelCall(
  call: CallExpression,
  resolve: (value: Node) => Node | null,
): ModelIdentity | null {
  const callee = call.getExpression();
  if (!isModelFactoryCall(callee, resolve)) {
    return null;
  }
  const args = call.getArguments();
  const modelName = literalString(args[0]);
  if (modelName === null) {
    return null;
  }
  const explicitCollection = literalString(args[2]);
  const schemaCollection =
    explicitCollection === null ? collectionFromSchemaArg(args[1]) : null;
  const collection =
    explicitCollection ?? schemaCollection ?? defaultCollectionName(modelName);
  return { modelName, collection };
}

function isModelFactoryCall(
  callee: Node,
  resolve: (value: Node) => Node | null,
): boolean {
  if (N.isPropertyAccessExpression(callee)) {
    return (
      callee.getName() === "model" &&
      methodDeclaredIn(callee, "mongoose", resolve)
    );
  }
  return N.isIdentifier(callee) && isImportedAs(callee, "mongoose", "model");
}

/** Like `isImportedFrom`, but also checks the export's own name, rather than only the local alias. */
function isImportedAs(
  identifier: Node,
  module: string,
  exportName: string,
): boolean {
  const symbol = identifier.getSymbol();
  if (symbol === undefined) {
    return false;
  }
  for (const decl of symbol.getDeclarations()) {
    if (
      N.isImportSpecifier(decl) &&
      decl.getName() === exportName &&
      decl.getImportDeclaration().getModuleSpecifierValue() === module
    ) {
      return true;
    }
  }
  return false;
}

/** The `collection` a schema's own options state, when the model call leaves it to the schema. */
function collectionFromSchemaArg(schemaArg: Node | undefined): string | null {
  if (schemaArg === undefined) {
    return null;
  }
  const ctor = schemaConstructorOf(schemaArg);
  const optionsArg = ctor?.getArguments()[1];
  if (optionsArg === undefined || !N.isObjectLiteralExpression(optionsArg)) {
    return null;
  }
  for (const prop of optionsArg.getProperties()) {
    if (N.isPropertyAssignment(prop) && prop.getName() === "collection") {
      return literalString(prop.getInitializer());
    }
  }
  return null;
}

/** `new Schema(...)`, written inline or bound to a same-file const. */
function schemaConstructorOf(node: Node): NewExpression | null {
  if (N.isNewExpression(node)) {
    return node;
  }
  if (!N.isIdentifier(node)) {
    return null;
  }
  const symbol = node.getSymbol();
  for (const decl of symbol?.getDeclarations() ?? []) {
    if (!N.isVariableDeclaration(decl)) {
      continue;
    }
    const init = decl.getInitializer();
    if (init !== undefined && N.isNewExpression(init)) {
      return init;
    }
  }
  return null;
}

/**
 * The model behind a document receiver (`doc` in `doc.save()`):
 * constructed directly (`new User(...)`), read off a query
 * (`await User.findById(id)`), or bound to a variable holding either.
 */
function resolveDocumentModelIdentity(
  node: Node,
  resolve: (value: Node) => Node | null,
): ModelIdentity | null {
  if (N.isNewExpression(node)) {
    return resolveModelIdentity(node.getExpression(), resolve);
  }
  if (N.isAwaitExpression(node) || N.isParenthesizedExpression(node)) {
    return resolveDocumentModelIdentity(node.getExpression(), resolve);
  }
  if (N.isCallExpression(node)) {
    const callee = node.getExpression();
    if (
      !N.isPropertyAccessExpression(callee) ||
      !(callee.getName() in METHODS)
    ) {
      return null;
    }
    return resolveModelIdentity(callee.getExpression(), resolve);
  }
  if (!N.isIdentifier(node)) {
    return null;
  }
  const symbol = node.getSymbol();
  for (const decl of symbol?.getDeclarations() ?? []) {
    if (!N.isVariableDeclaration(decl)) {
      continue;
    }
    const init = decl.getInitializer();
    const identity =
      init === undefined ? null : resolveDocumentModelIdentity(init, resolve);
    if (identity !== null) {
      return identity;
    }
  }
  return null;
}

function literalString(node: Node | undefined): string | null {
  if (node === undefined) {
    return null;
  }
  return N.isStringLiteral(node) || N.isNoSubstitutionTemplateLiteral(node)
    ? node.getLiteralValue()
    : null;
}

// ---------------------------------------------------------------------------
// Field / selector extraction, from the current call's own arguments
// ---------------------------------------------------------------------------

interface ObjectArg {
  kind: "object";
  fields: Record<string, EffectArg>;
}

function readObjectArg(arg: EffectArg | undefined): ObjectArg | null {
  if (arg === null || arg === undefined || typeof arg !== "object") {
    return null;
  }
  return (arg as { kind?: string }).kind === "object"
    ? (arg as ObjectArg)
    : null;
}

function isTruthyLiteral(value: EffectArg): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (value.kind === "number") {
    return value.value !== 0;
  }
  return value.kind === "boolean" && value.value;
}

function projectionFromString(text: string): string[] {
  const included = text
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0 && !term.startsWith("-"))
    .map((term) => term.replace(/^\+/, ""));
  return included.length > 0 ? included : ["*"];
}

function projectionFields(arg: EffectArg | undefined): string[] {
  if (arg !== null && typeof arg === "object" && arg.kind === "string") {
    return projectionFromString(arg.value);
  }
  const object = readObjectArg(arg);
  if (object === null) {
    return ["*"];
  }
  const included = Object.entries(object.fields)
    .filter(([, value]) => isTruthyLiteral(value))
    .map(([key]) => key);
  return included.length > 0 ? included : ["*"];
}

/** A `$`-prefixed key is an update operator; its own keys are the fields it touches. */
function updateFields(arg: EffectArg | undefined): string[] {
  const object = readObjectArg(arg);
  if (object === null) {
    return ["*"];
  }
  const fields = new Set<string>();
  for (const [key, value] of Object.entries(object.fields)) {
    if (!key.startsWith("$")) {
      fields.add(key);
      continue;
    }
    const operand = readObjectArg(value);
    for (const inner of Object.keys(operand?.fields ?? {})) {
      fields.add(inner);
    }
  }
  return fields.size > 0 ? [...fields] : ["*"];
}

function payloadFields(arg: EffectArg | undefined): string[] {
  const object = readObjectArg(arg);
  if (object !== null) {
    const keys = Object.keys(object.fields);
    return keys.length > 0 ? keys : ["*"];
  }
  if (
    arg === null ||
    arg === undefined ||
    typeof arg !== "object" ||
    arg.kind !== "array"
  ) {
    return ["*"];
  }
  const union = new Set<string>();
  for (const item of arg.items) {
    const row = readObjectArg(item);
    if (row === null) {
      return ["*"];
    }
    for (const key of Object.keys(row.fields)) {
      union.add(key);
    }
  }
  return union.size > 0 ? [...union] : ["*"];
}

function distinctField(arg: EffectArg | undefined): string[] {
  return arg !== null && typeof arg === "object" && arg.kind === "string"
    ? [arg.value]
    : [];
}

function fieldsOf(spec: MethodSpec, args: EffectArg[]): string[] {
  if (spec.projectionArg !== undefined) {
    return projectionFields(args[spec.projectionArg]);
  }
  if (spec.updateArg !== undefined) {
    return updateFields(args[spec.updateArg]);
  }
  if (spec.payloadArg !== undefined) {
    return payloadFields(args[spec.payloadArg]);
  }
  if (spec.fieldArg !== undefined) {
    return distinctField(args[spec.fieldArg]);
  }
  // A bare filter with none of the above is either a delete (the whole
  // document changes) or a count/exists (no document fields at all).
  return spec.kind === "write" ? ["*"] : [];
}

function selectorOf(spec: MethodSpec, args: EffectArg[]): string[] | null {
  if (spec.idArg !== undefined) {
    return args[spec.idArg] !== undefined ? ["_id"] : null;
  }
  if (spec.filterArg === undefined) {
    return null;
  }
  const object = readObjectArg(args[spec.filterArg]);
  if (object === null) {
    return null;
  }
  const keys = Object.keys(object.fields);
  return keys.length > 0 ? keys : null;
}

// ---------------------------------------------------------------------------
// Recognizers
// ---------------------------------------------------------------------------

interface RecognizerContext {
  extractArgs?: () => EffectArg[];
  resolveWrittenValue?: (value: Node) => Node | null;
}

function buildAccess(opts: {
  scope: string;
  collection: string | null;
  calleeText: string;
  operation: string;
  kind: "read" | "write";
  fields: string[];
  selector: string[] | null;
}): Effect {
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: RECOGNITION,
      storageSystem: STORAGE_SYSTEM,
      scope: opts.scope,
      container: opts.collection,
    }),
    callee: opts.calleeText,
    interaction: {
      class: "storage-access",
      kind: opts.kind,
      fields: opts.fields,
      ...(opts.selector !== null ? { selector: opts.selector } : {}),
      operation: opts.operation,
    },
  };
}

function makeStaticRecognizer(scope: string): InvocationRecognizer {
  return (call, ctx) => {
    const callNode = call as CallExpression;
    const recognizerCtx = ctx as RecognizerContext;
    const resolve = recognizerCtx.resolveWrittenValue ?? (() => null);

    const callee = callNode.getExpression();
    if (!N.isPropertyAccessExpression(callee)) {
      return null;
    }
    const method = callee.getName();
    const spec = METHODS[method];
    if (spec === undefined || !methodDeclaredIn(callee, "mongoose", resolve)) {
      return null;
    }

    const identity = resolveModelIdentity(callee.getExpression(), resolve);
    const args = recognizerCtx.extractArgs?.() ?? [];

    return [
      buildAccess({
        scope,
        collection: identity?.collection ?? null,
        calleeText: callee.getText(),
        operation: method,
        kind: spec.kind,
        fields: fieldsOf(spec, args),
        selector: selectorOf(spec, args),
      }),
    ];
  };
}

function makeSaveRecognizer(scope: string): InvocationRecognizer {
  return (call, ctx) => {
    const callNode = call as CallExpression;
    const recognizerCtx = ctx as RecognizerContext;
    const resolve = recognizerCtx.resolveWrittenValue ?? (() => null);

    const callee = callNode.getExpression();
    if (!N.isPropertyAccessExpression(callee) || callee.getName() !== "save") {
      return null;
    }
    if (!methodDeclaredIn(callee, "mongoose", resolve)) {
      return null;
    }

    const identity = resolveDocumentModelIdentity(
      callee.getExpression(),
      resolve,
    );

    return [
      buildAccess({
        scope,
        collection: identity?.collection ?? null,
        calleeText: callee.getText(),
        operation: "save",
        kind: "write",
        fields: ["*"],
        selector: null,
      }),
    ];
  };
}

/**
 * Pack export. Two invocation recognizers, no discovery patterns or
 * terminals (Mongoose calls aren't boundaries themselves: they're
 * effects on already-discovered handlers / services).
 */
export function mongooseFramework(
  options: MongooseRecognizerOptions = {},
): PatternPack {
  const scope = options.scope ?? "default";
  return {
    name: "mongoose",
    protocol: "in-process",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    requiresImport: ["mongoose"],
    invocationRecognizers: [
      makeStaticRecognizer(scope),
      makeSaveRecognizer(scope),
    ],
  };
}

export default mongooseFramework;
