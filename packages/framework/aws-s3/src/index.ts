/**
 * Recognize S3 object calls and emit `storage-access` effects.
 *
 * The anchor is the command, wherever a call takes one. `send` runs it
 * now and `getSignedUrl` hands back a URL that runs it later, and both
 * address the same object.
 *
 * A bucket's objects have no fields to compare a read against, so what
 * a call says is the key it addressed. A key built from a template
 * becomes a pattern, `uploads/{tenant}/{id}`, which is the shape a
 * bucket's key convention would be compared against.
 */

import {
  type CallExpression,
  Node as N,
  type Node,
  SyntaxKind,
} from "ts-morph";

import { rootIdentifier } from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type { InvocationRecognizer, PatternPack } from "@suss/extractor";

const RECOGNITION = "@suss/framework-aws-s3";

/** The module a command class comes from. */
const COMMAND_MODULE = "@aws-sdk/client-s3";

/** Every command this reads, and whether it reads or writes. */
const COMMANDS: Record<string, "read" | "write"> = {
  GetObjectCommand: "read",
  HeadObjectCommand: "read",
  ListObjectsV2Command: "read",
  ListObjectsCommand: "read",
  PutObjectCommand: "write",
  DeleteObjectCommand: "write",
  DeleteObjectsCommand: "write",
  CopyObjectCommand: "write",
  // A large object goes up in parts, and each command in that sequence
  // writes the same object.
  CreateMultipartUploadCommand: "write",
  UploadPartCommand: "write",
  CompleteMultipartUploadCommand: "write",
  AbortMultipartUploadCommand: "write",
};

interface RecognizerContext {
  isImportedFrom: (identifier: Node, expectedModule: string) => boolean;
  resolveWrittenValue?: (value: Node) => Node | null;
}

export function s3Recognizer(call: unknown, ctx: unknown): Effect[] | null {
  const callNode = call as CallExpression;
  const recognizerCtx = ctx as RecognizerContext;
  const resolve = recognizerCtx.resolveWrittenValue ?? (() => null);

  const built = commandArgument(callNode, resolve);
  if (built === null) {
    return null;
  }

  const ctorExpr = built.getExpression();
  const commandName = N.isPropertyAccessExpression(ctorExpr)
    ? ctorExpr.getName()
    : ctorExpr.getText();
  const kind = COMMANDS[commandName];
  if (kind === undefined || !fromS3Module(ctorExpr, recognizerCtx)) {
    return null;
  }

  const input = built.getArguments()[0];
  if (input === undefined || !N.isObjectLiteralExpression(input)) {
    return null;
  }

  const key = nameOf(property(input, "Key"), resolve);
  const prefix = nameOf(property(input, "Prefix"), resolve);
  const addressed = key ?? prefix;
  return [
    {
      type: "interaction",
      binding: storageBinding({
        recognition: RECOGNITION,
        storageSystem: "s3",
        transport: "aws-sdk",
        scope: "default",
        container: nameOf(property(input, "Bucket"), resolve),
        accessPath: null,
      }),
      callee: callNode.getExpression().getText(),
      interaction: {
        class: "storage-access",
        kind,
        // An object has no fields, so a call says nothing about any.
        fields: [],
        operation: commandName,
        ...(addressed !== null ? { selector: [addressed] } : {}),
      },
    },
  ];
}

type NewExpression = Node & {
  getExpression(): Node;
  getArguments(): Node[];
};

/**
 * The command a call was handed. A command written into the call
 * belongs to that call, and a nested call gets it first, so a command
 * is read once however many calls it passes through.
 */
function commandArgument(
  call: CallExpression,
  resolve: (value: Node) => Node | null,
): NewExpression | null {
  for (const arg of call.getArguments()) {
    if (N.isNewExpression(arg)) {
      return arg;
    }
    if (!N.isIdentifier(arg)) {
      continue;
    }
    const written = resolve(arg);
    if (written !== null && N.isNewExpression(written)) {
      return written;
    }
  }
  return null;
}

/** Whether the command class is the SDK's rather than a same-named local one. */
function fromS3Module(ctorExpr: Node, ctx: RecognizerContext): boolean {
  const target = N.isPropertyAccessExpression(ctorExpr)
    ? rootIdentifier(ctorExpr)
    : ctorExpr;
  return target !== null && ctx.isImportedFrom(target, COMMAND_MODULE);
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
 * The name an expression states, with a part built at deploy time or at
 * request time written as a hole. A field is followed to what the
 * constructor set it to, and a value that falls back to a default reads
 * as the default.
 */
function nameOf(
  expr: Node | null,
  resolve: (value: Node) => Node | null,
): string | null {
  if (expr === null) {
    return null;
  }
  const settled = defaultOf(
    N.isStringLiteral(expr) || N.isTemplateExpression(expr)
      ? expr
      : (resolve(expr) ?? expr),
  );

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

/**
 * What a value falls back to when nothing was passed in. A repository
 * class takes an override and ships a default, and the default is the
 * bucket the service reads unless a caller says otherwise.
 */
function defaultOf(expr: Node): Node {
  if (!N.isBinaryExpression(expr)) {
    return expr;
  }
  const operator = expr.getOperatorToken().getKind();
  if (
    operator !== SyntaxKind.BarBarToken &&
    operator !== SyntaxKind.QuestionQuestionToken
  ) {
    return expr;
  }
  return defaultOf(expr.getRight());
}

/** `` `uploads/${tenant}/${id}` `` reads as `uploads/{tenant}/{id}`. */
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

/** What the source calls the part it fills in at run time. */
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
 * Pack export. One recognizer, gated on a file importing the S3 client,
 * which is where a command class can come from.
 */
export function s3Framework(): PatternPack {
  return {
    name: "aws-s3",
    protocol: "s3",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    requiresImport: [COMMAND_MODULE],
    invocationRecognizers: [s3Recognizer as InvocationRecognizer],
  };
}

export default s3Framework;
