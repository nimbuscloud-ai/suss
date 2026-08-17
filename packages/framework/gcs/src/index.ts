/**
 * Recognize Google Cloud Storage calls and emit `storage-access`
 * effects.
 *
 * A caller reaches an object through a chain rather than a command:
 * `storage.bucket(name).file(path).download()`. The operation at the
 * end says whether it reads or writes, and the chain behind it says
 * which bucket and which object. The README says which operations it
 * reads and what a signed URL counts as.
 */

import { type CallExpression, Node as N, type Node } from "ts-morph";

import { methodDeclaredIn, readName } from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type { InvocationRecognizer, PatternPack } from "@suss/extractor";

const RECOGNITION = "@suss/framework-gcs";

/** The library a call has to come from. */
const CLIENT_MODULE = "@google-cloud/storage";

/** Every operation this reads, and whether it reads or writes. */
const OPERATIONS: Record<string, "read" | "write"> = {
  download: "read",
  createReadStream: "read",
  getMetadata: "read",
  exists: "read",
  isPublic: "read",
  getFiles: "read",
  save: "write",
  upload: "write",
  createWriteStream: "write",
  delete: "write",
  copy: "write",
  move: "write",
  rename: "write",
  setMetadata: "write",
  makePublic: "write",
  makePrivate: "write",
};

/**
 * A signed URL reaches the object later, and what it does then is
 * whatever the caller asked to sign for.
 */
const SIGNED_URL = "getSignedUrl";

/** What the caller asked a signed URL to allow. */
const SIGNED_ACTIONS: Record<string, "read" | "write"> = {
  read: "read",
  write: "write",
  delete: "write",
  resumable: "write",
};

/** The calls in the chain that say what the operation is addressing. */
const BUCKET_STEP = "bucket";
const FILE_STEP = "file";

interface RecognizerContext {
  resolveWrittenValue?: (value: Node) => Node | null;
}

export function gcsRecognizer(call: unknown, ctx: unknown): Effect[] | null {
  const callNode = call as CallExpression;
  const resolve =
    (ctx as RecognizerContext).resolveWrittenValue ?? (() => null);

  const callee = callNode.getExpression();
  if (!N.isPropertyAccessExpression(callee)) {
    return null;
  }
  const operation = callee.getName();
  const kind = kindOf(operation, callNode, resolve);
  if (kind === null || !methodDeclaredIn(callee, CLIENT_MODULE)) {
    return null;
  }

  const chain = walkChain(callee.getExpression(), resolve);
  return [
    {
      type: "interaction",
      binding: storageBinding({
        recognition: RECOGNITION,
        storageSystem: "gcs",
        scope: "default",
        container: chain.bucket,
        accessPath: null,
      }),
      callee: callee.getText(),
      interaction: {
        class: "storage-access",
        kind,
        // An object has no fields, so a call says nothing about any.
        fields: [],
        operation,
        ...(chain.object !== null ? { selector: [chain.object] } : {}),
      },
    },
  ];
}

/**
 * Whether an operation reads or writes. A signed URL is whichever the
 * caller signed for, and a request that says nothing signs for a read,
 * which is what the library does with it.
 */
function kindOf(
  operation: string,
  call: CallExpression,
  resolve: (value: Node) => Node | null,
): "read" | "write" | null {
  if (operation !== SIGNED_URL) {
    return OPERATIONS[operation] ?? null;
  }
  const config = call.getArguments()[0];
  const asked = config === undefined ? null : property(config, "action");
  const action = asked === null ? null : readName(asked, { resolve });
  return action === null ? "read" : (SIGNED_ACTIONS[action] ?? "read");
}

interface Addressed {
  bucket: string | null;
  object: string | null;
}

/**
 * The bucket and the object a chain reaches. A step written into a
 * variable is followed back to where it was built, since a repository
 * class usually keeps the bucket and reaches for a file per call.
 */
function walkChain(
  subject: Node,
  resolve: (value: Node) => Node | null,
): Addressed {
  let step: Node | null = subject;
  const found: Addressed = { bucket: null, object: null };

  for (let hops = 0; step !== null && hops < MAX_CHAIN_STEPS; hops++) {
    if (N.isIdentifier(step) || N.isPropertyAccessExpression(step)) {
      const written = resolve(step);
      step = written === step ? null : written;
      continue;
    }
    if (!N.isCallExpression(step)) {
      return found;
    }
    const callee: Node = step.getExpression();
    if (!N.isPropertyAccessExpression(callee)) {
      return found;
    }
    const named = callee.getName();
    const argument = step.getArguments()[0];
    if (named === FILE_STEP && found.object === null) {
      found.object =
        argument === undefined ? null : readName(argument, { resolve });
    }
    if (named === BUCKET_STEP && found.bucket === null) {
      found.bucket =
        argument === undefined ? null : readName(argument, { resolve });
      return found;
    }
    step = callee.getExpression();
  }
  return found;
}

/** How far back a chain is followed before it stops. */
const MAX_CHAIN_STEPS = 8;

/** What one property of a request says, when it says. */
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
 * Pack export. One recognizer, gated on a file reaching the client
 * library, which is where an operation can come from.
 */
export function gcsFramework(): PatternPack {
  return {
    name: "gcs",
    protocol: "gcs",
    languages: ["typescript", "javascript"],
    discovery: [],
    terminals: [],
    inputMapping: { type: "positionalParams", params: [] },
    requiresImport: [CLIENT_MODULE],
    invocationRecognizers: [gcsRecognizer as InvocationRecognizer],
  };
}

export default gcsFramework;
