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

  return [
    {
      type: "interaction",
      binding: storageBinding({
        recognition: "@suss/framework-aws-dynamodb",
        storageSystem: "dynamodb",
        transport: "aws-sdk",
        scope: "default",
        container: nameOf(property(input, "TableName"), resolve),
        accessPath: nameOf(property(input, "IndexName"), resolve),
      }),
      callee: callNode.getExpression().getText(),
      interaction: {
        class: "storage-access",
        kind,
        fields: fieldsOf(input, kind),
        operation: commandName,
        ...(selectorOf(input).length > 0
          ? { selector: selectorOf(input) }
          : {}),
      },
    },
  ];
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

/** What a call gives DynamoDB to pick items by. */
function selectorOf(input: Node): string[] {
  const key = property(input, "Key");
  if (key !== null && N.isObjectLiteralExpression(key)) {
    return objectKeys(key);
  }
  return [];
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
