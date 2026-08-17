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

import { type CallExpression, Node as N, type Node } from "ts-morph";

import { readName, rootIdentifier } from "@suss/adapter-typescript";
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

  const key = nameOfProperty(input, "Key", resolve);
  const prefix = nameOfProperty(input, "Prefix", resolve);
  const addressed = key ?? prefix;
  return [
    {
      type: "interaction",
      binding: storageBinding({
        recognition: RECOGNITION,
        storageSystem: "s3",
        transport: "aws-sdk",
        scope: "default",
        container: nameOfProperty(input, "Bucket", resolve),
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
    // Asking where a value was written costs a pass over the run's
    // facts, and nearly every call in a codebase takes an argument that
    // is not a command. The type says which ones are worth asking about.
    if (!N.isIdentifier(arg) || !typedAsCommand(arg)) {
      continue;
    }
    const written = resolve(arg);
    if (written !== null && N.isNewExpression(written)) {
      return written;
    }
  }
  return null;
}

/** Whether a value is one of the command classes this reads. */
function typedAsCommand(value: Node): boolean {
  const declared = (
    value as Node & {
      getType(): { getSymbol(): { getName(): string } | undefined };
    }
  )
    .getType()
    .getSymbol();
  return declared !== undefined && COMMANDS[declared.getName()] !== undefined;
}

/** Whether the command class is the SDK's rather than a same-named local one. */
function fromS3Module(ctorExpr: Node, ctx: RecognizerContext): boolean {
  const target = N.isPropertyAccessExpression(ctorExpr)
    ? rootIdentifier(ctorExpr)
    : ctorExpr;
  return target !== null && ctx.isImportedFrom(target, COMMAND_MODULE);
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
