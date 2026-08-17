/**
 * Recognize DynamoDB calls and emit `storage-access` effects.
 *
 * The anchor is `client.send(command)`, and the command says which
 * table, which index, whether the call reads or writes, and which
 * attributes it touches. A command built into a variable is resolved
 * back to where it was built. A project that signs and posts the
 * request itself writes no command class, so a second anchor reads a
 * function the project declares in pack config, and the request object
 * is read the same way from there on.
 *
 * The README says what each input contributes, and why a table name
 * often comes out as a pattern like `{stage}-orders-v1`.
 */

import { type CallExpression, Node as N, type Node } from "ts-morph";

import { readName, rootIdentifier } from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";

import type { BoundaryBinding, Effect } from "@suss/behavioral-ir";
import type { InvocationRecognizer, PatternPack } from "@suss/extractor";

/** The modules a command class can come from. */
const COMMAND_MODULES = [
  "@aws-sdk/lib-dynamodb",
  "@aws-sdk/client-dynamodb",
] as const;

/**
 * Every command this reads, and whether it reads or writes. The
 * document-client name and the raw-client name both appear, since a
 * project picks one and the input shape is the same either way.
 */
const RECOGNITION = "@suss/framework-aws-dynamodb";

const COMMANDS: Record<string, "read" | "write"> = {
  GetCommand: "read",
  GetItemCommand: "read",
  QueryCommand: "read",
  ScanCommand: "read",
  BatchGetCommand: "read",
  BatchGetItemCommand: "read",
  PutCommand: "write",
  PutItemCommand: "write",
  UpdateCommand: "write",
  UpdateItemCommand: "write",
  DeleteCommand: "write",
  DeleteItemCommand: "write",
  BatchWriteCommand: "write",
  BatchWriteItemCommand: "write",
};

interface RecognizerContext {
  isImportedFrom: (identifier: Node, expectedModule: string) => boolean;
  resolveWrittenValue?: (value: Node) => Node | null;
}

export function dynamoRecognizer(call: unknown, ctx: unknown): Effect[] | null {
  const callNode = call as CallExpression;
  const recognizerCtx = ctx as RecognizerContext;
  const resolve = recognizerCtx.resolveWrittenValue ?? (() => null);

  const callee = callNode.getExpression();
  if (!N.isPropertyAccessExpression(callee) || callee.getName() !== "send") {
    return null;
  }
  const firstArg = callNode.getArguments()[0];
  if (firstArg === undefined) {
    return null;
  }
  // `send(command)` where the command was built a few lines up is the
  // usual way a data access class writes one.
  const built = N.isNewExpression(firstArg)
    ? firstArg
    : asNewExpression(resolve(firstArg));
  if (built === null) {
    return null;
  }

  const ctorExpr = built.getExpression();
  const commandName = N.isPropertyAccessExpression(ctorExpr)
    ? ctorExpr.getName()
    : ctorExpr.getText();
  const kind = COMMANDS[commandName];
  if (kind === undefined) {
    return null;
  }
  if (!fromDynamoModule(ctorExpr, recognizerCtx)) {
    return null;
  }

  const input = built.getArguments()[0];
  if (input === undefined || !N.isObjectLiteralExpression(input)) {
    return null;
  }

  return requestEffects({
    input,
    kind,
    operation: commandName,
    callee: callee.getText(),
    transport: "aws-sdk",
    resolve,
  });
}

/** What both anchors have once they have the request object. */
interface RequestRead {
  /** The object literal the request states. */
  input: Node;
  kind: "read" | "write";
  /** What the source calls the operation, reported as it is written. */
  operation: string;
  callee: string;
  /** How the call reaches DynamoDB, left out when it skips the SDK. */
  transport?: string;
  resolve: (value: Node) => Node | null;
}

/**
 * The effects one request produces: one, or one per table when the
 * request is a batch or a transaction.
 */
function requestEffects(read: RequestRead): Effect[] {
  const { input, kind, operation, callee, resolve } = read;

  // A batch or transaction command states its tables inside the request
  // map, one entry per table, so it becomes one effect per table.
  const requestItems = property(input, "RequestItems");
  if (requestItems !== null) {
    return batchEffects(requestItems, read);
  }

  const picked = selector(input);
  return [
    {
      type: "interaction",
      binding: dynamoBinding(read, {
        container: nameOfProperty(input, "TableName", resolve),
        accessPath: nameOfProperty(input, "IndexName", resolve),
      }),
      callee,
      interaction: {
        class: "storage-access",
        kind,
        fields: fieldsOf(input, kind),
        operation,
        ...(picked.length > 0 ? { selector: picked } : {}),
      },
    },
  ];
}

function dynamoBinding(
  read: RequestRead,
  addressed: { container: string | null; accessPath: string | null },
): BoundaryBinding {
  return storageBinding({
    recognition: RECOGNITION,
    storageSystem: "dynamodb",
    ...(read.transport === undefined ? {} : { transport: read.transport }),
    scope: "default",
    container: addressed.container,
    accessPath: addressed.accessPath,
  });
}

/**
 * One effect per table in a request map. Each entry is a table and the
 * requests against it, so the table is the entry's own key, which a
 * project often writes as a computed name.
 */
function batchEffects(requestItems: Node, read: RequestRead): Effect[] {
  const { kind, operation, callee, resolve } = read;
  if (!N.isObjectLiteralExpression(requestItems)) {
    return [];
  }
  const effects: Effect[] = [];
  for (const entry of requestItems.getProperties()) {
    if (!N.isPropertyAssignment(entry)) {
      continue;
    }
    const requests = entry.getInitializer();
    effects.push({
      type: "interaction",
      binding: dynamoBinding(read, {
        container: entryName(entry, resolve),
        accessPath: null,
      }),
      callee,
      interaction: {
        class: "storage-access",
        kind,
        fields: requests === undefined ? [] : requestedFields(requests, kind),
        operation,
      },
    });
  }
  return effects;
}

/** The table an entry in a request map is for. */
function entryName(
  entry: Node,
  resolve: (value: Node) => Node | null,
): string | null {
  if (!N.isPropertyAssignment(entry)) {
    return null;
  }
  const nameNode = entry.getNameNode();
  // `{ [this.tableName]: [...] }` puts the table behind an expression,
  // which is the same question the TableName property asks.
  if (N.isComputedPropertyName(nameNode)) {
    return readName(nameNode.getExpression(), { resolve });
  }
  if (N.isStringLiteral(nameNode) || N.isIdentifier(nameNode)) {
    return nameNode.getText().replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * The attributes a batch's requests touch: what a put writes, and the
 * keys a get or a delete states.
 */
function requestedFields(requests: Node, kind: "read" | "write"): string[] {
  const found = new Set<string>();
  requests.forEachDescendant((node) => {
    if (!N.isPropertyAssignment(node)) {
      return;
    }
    const name = node.getName();
    if (name !== "Item" && name !== "Key" && name !== "Keys") {
      return;
    }
    const value = node.getInitializer();
    if (value === undefined) {
      return;
    }
    for (const key of N.isArrayLiteralExpression(value)
      ? value.getElements().flatMap((element) => objectKeys(element))
      : objectKeys(value)) {
      found.add(key);
    }
  });
  return found.size > 0 ? [...found] : kind === "read" ? ["*"] : [];
}

/** A resolved value, when what it resolved to was a `new` expression. */
function asNewExpression(
  resolved: Node | null,
): (Node & { getExpression(): Node; getArguments(): Node[] }) | null {
  return resolved !== null && N.isNewExpression(resolved) ? resolved : null;
}

/** Whether the command class is the SDK's rather than a same-named local one. */
function fromDynamoModule(ctorExpr: Node, ctx: RecognizerContext): boolean {
  const target = N.isPropertyAccessExpression(ctorExpr)
    ? rootIdentifier(ctorExpr)
    : ctorExpr;
  if (target === null) {
    return false;
  }
  return COMMAND_MODULES.some((module) => ctx.isImportedFrom(target, module));
}

function property(input: Node, name: string): Node | null {
  if (!N.isObjectLiteralExpression(input)) {
    return null;
  }
  for (const prop of input.getProperties()) {
    if (N.isPropertyAssignment(prop) && prop.getName() === name) {
      return prop.getInitializer() ?? null;
    }
  }
  return null;
}

/** What one input of a command is called, when it says. */
function nameOfProperty(
  input: Node,
  name: string,
  resolve: (value: Node) => Node | null,
): string | null {
  const written = property(input, name);
  return written === null
    ? null
    : readName(written, { resolve, unsettled: "reference" });
}

/**
 * The attributes a call touches. A read states them in its projection,
 * and a write states them as the item it puts, so an absent projection
 * is a read of everything the item has.
 */
function fieldsOf(input: Node, kind: "read" | "write"): string[] {
  const projection = property(input, "ProjectionExpression");
  if (projection !== null) {
    const text = literalText(projection);
    if (text !== null) {
      const aliases = expressionNames(input);
      return text
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field !== "")
        .map((field) => aliases.get(field) ?? field);
    }
  }
  if (kind === "write") {
    const item = property(input, "Item");
    if (item !== null && N.isObjectLiteralExpression(item)) {
      return objectKeys(item);
    }
  }
  return kind === "read" ? ["*"] : [];
}

/**
 * What a call gives DynamoDB to pick items by: the key an item-level
 * command states, or the attributes a query's key condition uses.
 */
function selector(input: Node): string[] {
  const key = property(input, "Key");
  if (key !== null && N.isObjectLiteralExpression(key)) {
    return objectKeys(key);
  }
  const condition = property(input, "KeyConditionExpression");
  const text = condition === null ? null : literalText(condition);
  if (text === null) {
    return [];
  }
  return keyConditionAttributes(text, expressionNames(input));
}

/**
 * What DynamoDB calls a name in an expression, when the code hides it
 * behind an alias to keep clear of the reserved words.
 */
function expressionNames(input: Node): Map<string, string> {
  const names = new Map<string, string>();
  const declared = property(input, "ExpressionAttributeNames");
  if (declared === null || !N.isObjectLiteralExpression(declared)) {
    return names;
  }
  for (const prop of declared.getProperties()) {
    if (!N.isPropertyAssignment(prop)) {
      continue;
    }
    const value = prop.getInitializer();
    const written = value === undefined ? null : literalText(value);
    if (written === null) {
      continue;
    }
    names.set(prop.getName().replace(/^["']|["']$/g, ""), written);
  }
  return names;
}

/** The text of a string the source writes out, or null for anything else. */
function literalText(value: Node): string | null {
  return N.isStringLiteral(value) || N.isNoSubstitutionTemplateLiteral(value)
    ? value.getLiteralValue()
    : null;
}

/**
 * Where an attribute appears in a key condition: before a comparison,
 * as the first argument of a function, or before a range keyword and
 * the value it compares against. Matching on position rather than on a
 * list of keywords keeps DynamoDB's own words out of this source.
 */
const ATTRIBUTE_POSITIONS = [
  /([#\w.]+)\s*(?:<>|<=|>=|=|<|>)/g,
  /\(\s*([#\w.]+)\s*,/g,
  /([#\w.]+)\s+[A-Za-z_]+\s+:/g,
];

/**
 * The attributes a key condition keys on, with an alias looked up
 * through what the call says each one is written as.
 */
function keyConditionAttributes(
  expression: string,
  names: Map<string, string>,
): string[] {
  const found: string[] = [];
  const add = (token: string | undefined): void => {
    if (token === undefined) {
      return;
    }
    const name = token.startsWith("#") ? names.get(token) : token;
    if (name !== undefined && !found.includes(name)) {
      found.push(name);
    }
  };
  for (const pattern of ATTRIBUTE_POSITIONS) {
    for (const match of expression.matchAll(pattern)) {
      add(match[1]);
    }
  }
  return found;
}

function objectKeys(literal: Node): string[] {
  if (!N.isObjectLiteralExpression(literal)) {
    return [];
  }
  const keys: string[] = [];
  for (const prop of literal.getProperties()) {
    if (N.isPropertyAssignment(prop) || N.isShorthandPropertyAssignment(prop)) {
      keys.push(prop.getName().replace(/^["']|["']$/g, ""));
    }
  }
  return keys;
}

/**
 * A function of the project's own that sends a DynamoDB request. The
 * pack recognizes the SDK's command classes, and a service that signs
 * and posts the request itself writes none of them, so the project says
 * which of its own functions does that. The README gives an example.
 */
export interface DynamoRequestFunction {
  /** What the function is called where it is called. */
  name: string;
  /**
   * The module specifier a call site imports it from. Leave it out when
   * call sites reach it by different relative paths; then the name
   * alone picks it out among the files the import gate admits.
   */
  module?: string;
  /** Which argument says which operation the request performs. */
  operationArg: number;
  /** Which argument is the request itself. */
  requestArg: number;
  /** What each operation the function accepts does to the table. */
  operations: Record<string, "read" | "write">;
}

export interface DynamoPackOptions {
  requestFunctions?: DynamoRequestFunction[];
  /**
   * Further modules whose presence makes a file worth reading. A helper
   * imported by a relative path gives the gate nothing to match on; the
   * signing library that helper imports gives it something.
   */
  requiresImport?: string[];
}

/**
 * Read a call to a configured request function. The operation argument
 * decides whether the call reads or writes, and the request argument is
 * the same object a command class takes.
 */
function requestFunctionRecognizer(
  spec: DynamoRequestFunction,
): InvocationRecognizer {
  return ((call: unknown, ctx: unknown): Effect[] | null => {
    const callNode = call as CallExpression;
    const recognizerCtx = ctx as RecognizerContext;
    const resolve = recognizerCtx.resolveWrittenValue ?? (() => null);

    const callee = callNode.getExpression();
    if (calledName(callee) !== spec.name) {
      return null;
    }
    if (
      spec.module !== undefined &&
      !declaredIn(callee, spec.module, recognizerCtx)
    ) {
      return null;
    }

    const args = callNode.getArguments();
    const operation = argumentText(args[spec.operationArg], resolve);
    if (operation === null) {
      return null;
    }

    const kind = spec.operations[operation];
    if (kind === undefined) {
      return null;
    }

    const input = objectArgument(args[spec.requestArg], resolve);
    if (input === null) {
      return null;
    }

    return requestEffects({
      input,
      kind,
      operation,
      callee: callee.getText(),
      resolve,
    });
  }) as InvocationRecognizer;
}

/** The name a call goes to, whether it is written bare or on an object. */
function calledName(callee: Node): string | null {
  if (N.isPropertyAccessExpression(callee)) {
    return callee.getName();
  }
  return N.isIdentifier(callee) ? callee.getText() : null;
}

/** Whether the function is the configured one and not a same-named other. */
function declaredIn(
  callee: Node,
  module: string,
  ctx: RecognizerContext,
): boolean {
  const target = N.isPropertyAccessExpression(callee)
    ? rootIdentifier(callee)
    : callee;
  return target !== null && ctx.isImportedFrom(target, module);
}

/** A string an argument is written as, following the const it came from. */
function argumentText(
  arg: Node | undefined,
  resolve: (value: Node) => Node | null,
): string | null {
  if (arg === undefined) {
    return null;
  }
  const direct = literalText(arg);
  if (direct !== null) {
    return direct;
  }
  const written = resolve(arg);
  return written === null ? null : literalText(written);
}

/** The object literal an argument is written as, or null. */
function objectArgument(
  arg: Node | undefined,
  resolve: (value: Node) => Node | null,
): Node | null {
  if (arg === undefined) {
    return null;
  }
  if (N.isObjectLiteralExpression(arg)) {
    return arg;
  }
  const written = resolve(arg);
  return written !== null && N.isObjectLiteralExpression(written)
    ? written
    : null;
}

const isArgumentPosition = (index: unknown): boolean =>
  Number.isInteger(index) && (index as number) >= 0;

/**
 * Rejecting a half-written entry here rather than reading nothing later
 * turns a typo into a message from the CLI that says which file to fix.
 */
function checkRequestFunction(spec: DynamoRequestFunction, at: number): void {
  const complain = (problem: string): never => {
    throw new Error(`requestFunctions[${at}] ${problem}`);
  };
  if (typeof spec.name !== "string" || spec.name === "") {
    complain("needs the name of a function to read.");
  }
  if (!isArgumentPosition(spec.operationArg)) {
    complain("needs operationArg: which argument says the operation, from 0.");
  }
  if (!isArgumentPosition(spec.requestArg)) {
    complain("needs requestArg: which argument is the request, from 0.");
  }
  const operations = Object.entries(spec.operations ?? {});
  if (operations.length === 0) {
    complain("needs operations, saying what each one does to the table.");
  }
  for (const [operation, kind] of operations) {
    if (kind !== "read" && kind !== "write") {
      complain(`gives ${operation} as ${String(kind)}, not read or write.`);
    }
  }
}

/**
 * Pack export. One recognizer per anchor, gated on a file importing a
 * DynamoDB client module, which is where a command class comes from,
 * or any further module the project configured.
 */
export function dynamoFramework(options: DynamoPackOptions = {}): PatternPack {
  const requestFunctions = options.requestFunctions ?? [];
  requestFunctions.forEach(checkRequestFunction);

  return {
    name: "aws-dynamodb",
    protocol: "dynamodb",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    requiresImport: [
      ...new Set([
        ...COMMAND_MODULES,
        ...(options.requiresImport ?? []),
        ...requestFunctions
          .map((spec) => spec.module)
          .filter((module) => module !== undefined),
      ]),
    ],
    invocationRecognizers: [
      dynamoRecognizer as InvocationRecognizer,
      ...requestFunctions.map(requestFunctionRecognizer),
    ],
  };
}

export default dynamoFramework;
