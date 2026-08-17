/**
 * Recognize DynamoDB calls and emit `storage-access` effects.
 *
 * The anchor is `client.send(command)`, and the command says everything
 * else: which table, which index, whether the call reads or writes, and
 * which attributes it touches. A command built into a variable first is
 * resolved back to where it was built, since that is how a data access
 * class usually writes one.
 *
 * A table name is often built at deploy time, so the container becomes
 * a name pattern (`{stage}-orders-v1`) that pairs against the template's
 * own `Fn::Sub`. Its README says what each command contributes.
 */

import { type CallExpression, Node as N, type Node } from "ts-morph";

import { rootIdentifier } from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
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
  const calleeText = callNode.getExpression().getText();

  // A batch or transaction command states its tables inside the request
  // map, one entry per table, so it becomes one effect per table.
  const requestItems = property(input, "RequestItems");
  if (requestItems !== null) {
    return batchEffects({
      requestItems,
      kind,
      commandName,
      callee: calleeText,
      resolve,
    });
  }

  return [
    {
      type: "interaction",
      binding: storageBinding({
        recognition: RECOGNITION,
        storageSystem: "dynamodb",
        transport: "aws-sdk",
        scope: "default",
        container: nameOf(property(input, "TableName"), resolve),
        accessPath: nameOf(property(input, "IndexName"), resolve),
      }),
      callee: calleeText,
      interaction: {
        class: "storage-access",
        kind,
        fields: fieldsOf(input, kind),
        operation: commandName,
        ...(selector(input).length > 0 ? { selector: selector(input) } : {}),
      },
    },
  ];
}

/**
 * One effect per table in a request map. Each entry is a table and the
 * requests against it, so the table is the entry's own key, which a
 * project often writes as a computed name.
 */
function batchEffects(opts: {
  requestItems: Node;
  kind: "read" | "write";
  commandName: string;
  callee: string;
  resolve: (value: Node) => Node | null;
}): Effect[] {
  const { requestItems, kind, commandName, callee, resolve } = opts;
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
      binding: storageBinding({
        recognition: RECOGNITION,
        storageSystem: "dynamodb",
        transport: "aws-sdk",
        scope: "default",
        container: entryName(entry, resolve),
        accessPath: null,
      }),
      callee,
      interaction: {
        class: "storage-access",
        kind,
        fields: requests === undefined ? [] : requestedFields(requests, kind),
        operation: commandName,
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
    return nameOf(nameNode.getExpression(), resolve);
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

/**
 * The name an expression states, with a deploy-time part written as a
 * hole. A field is followed to what the constructor set it to first,
 * which is where a table name usually is.
 */
function nameOf(
  expr: Node | null,
  resolve: (value: Node) => Node | null,
): string | null {
  if (expr === null) {
    return null;
  }
  const settled =
    N.isStringLiteral(expr) || N.isTemplateExpression(expr)
      ? expr
      : (resolve(expr) ?? expr);

  if (
    N.isStringLiteral(settled) ||
    N.isNoSubstitutionTemplateLiteral(settled)
  ) {
    return settled.getLiteralValue();
  }
  if (N.isTemplateExpression(settled)) {
    return patternOf(settled);
  }
  return null;
}

/** `` `${stage}-orders-v1` `` reads as `{stage}-orders-v1`. */
function patternOf(template: Node): string | null {
  if (!N.isTemplateExpression(template)) {
    return null;
  }
  let name = template.getHead().getLiteralText();
  for (const span of template.getTemplateSpans()) {
    name += `{${holeName(span.getExpression())}}`;
    name += span.getLiteral().getLiteralText();
  }
  return name;
}

/** What the source calls the part it left for deploy time to fill. */
function holeName(expr: Node): string {
  if (N.isIdentifier(expr)) {
    return expr.getText();
  }
  if (N.isPropertyAccessExpression(expr)) {
    return expr.getName();
  }
  return "param";
}

/**
 * The attributes a call touches. A read states them in its projection,
 * and a write states them as the item it puts, so an absent projection
 * is a read of everything the item has.
 */
function fieldsOf(input: Node, kind: "read" | "write"): string[] {
  const projection = property(input, "ProjectionExpression");
  if (projection !== null) {
    const text =
      N.isStringLiteral(projection) ||
      N.isNoSubstitutionTemplateLiteral(projection)
        ? projection.getLiteralValue()
        : null;
    if (text !== null) {
      return text
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field !== "");
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
  const text =
    condition !== null &&
    (N.isStringLiteral(condition) ||
      N.isNoSubstitutionTemplateLiteral(condition))
      ? condition.getLiteralValue()
      : null;
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
    if (
      value === undefined ||
      !(N.isStringLiteral(value) || N.isNoSubstitutionTemplateLiteral(value))
    ) {
      continue;
    }
    names.set(
      prop.getName().replace(/^["']|["']$/g, ""),
      value.getLiteralValue(),
    );
  }
  return names;
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
 * Pack export. One recognizer, gated on a file importing a DynamoDB
 * client module, which is where a command class can come from.
 */
export function dynamoFramework(): PatternPack {
  return {
    name: "aws-dynamodb",
    protocol: "dynamodb",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    requiresImport: [...COMMAND_MODULES],
    invocationRecognizers: [dynamoRecognizer as InvocationRecognizer],
  };
}

export default dynamoFramework;
