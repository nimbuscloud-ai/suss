/**
 * Records KV, R2 and D1 calls on a trigger's env argument, such as
 * `env.SESSIONS.get(key)`, as `storage-access` interactions. The
 * container is the binding name, which is also the identity
 * `wrangler.toml` declares for the store, so the storage check pairs the
 * two sides by name.
 *
 * The type on the binding's `Env` declaration (`KVNamespace`, `R2Bucket`
 * or `D1Database`) shows which store it is. The README explains why, and
 * what a Worker without those types gets.
 */

import { Node as N } from "ts-morph";

import { readName, stringValueOf } from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";
import { readSqlAccess } from "@suss/sql";

import { isTriggerEnvArgument } from "./envBindings.js";

import type { ResolutionStore } from "@suss/adapter-typescript";
import type { Effect } from "@suss/behavioral-ir";
import type { CallExpression, Node, PropertyAccessExpression } from "ts-morph";

const RECOGNITION = "@suss/framework-cloudflare-workers";

interface StoreAccess {
  kind: "read" | "write";
  /** The key the call addresses, when the call states one. */
  selector?: string;
}

type Resolve = (value: Node) => Node | null;

interface Reading {
  /** One hop from a name to what it was written as, for `readName`. */
  resolve: Resolve;
  /** The run's store, for the adapter's shared resolvers. */
  resolution: ResolutionStore | undefined;
}

/** Returns null for a method the store does not have. */
type OperationReader = (
  method: string,
  call: CallExpression,
  reading: Reading,
) => StoreAccess | null;

/**
 * KV and R2 share most of their method names, and a shared method reads
 * or writes on both.
 */
const OBJECT_OPERATIONS: Record<string, "read" | "write"> = {
  get: "read",
  getWithMetadata: "read",
  head: "read",
  list: "read",
  put: "write",
  delete: "write",
};

/** Operations whose first argument is the key they address. */
const KEYED_OPERATIONS = new Set([
  "get",
  "getWithMetadata",
  "head",
  "put",
  "delete",
]);

const objectStoreAccess: OperationReader = (method, call, reading) => {
  const kind = OBJECT_OPERATIONS[method];
  if (kind === undefined) {
    return null;
  }
  const argument = call.getArguments()[0];
  const selector =
    argument !== undefined && KEYED_OPERATIONS.has(method)
      ? readName(argument, {
          resolve: reading.resolve,
          unsettled: "reference",
        })
      : null;
  return { kind, ...(selector !== null ? { selector } : {}) };
};

/**
 * The methods that take a D1 statement as text. `batch` is left out:
 * it takes statements `prepare` built, and each was read at its own
 * call.
 */
const D1_STATEMENT_METHODS = new Set(["prepare", "exec"]);

/**
 * D1 is SQLite, so the statement shows whether the call reads or writes.
 * When the SQL reader cannot parse the statement, the call is left
 * unrecorded so that no access gets a guessed kind.
 */
const d1Access: OperationReader = (method, call, reading) => {
  if (!D1_STATEMENT_METHODS.has(method)) {
    return null;
  }
  const statement = call.getArguments()[0];
  const sql =
    statement === undefined
      ? null
      : stringValueOf(statement, reading.resolution);
  if (sql === null) {
    return null;
  }
  const accesses = readSqlAccess(sql, { dialect: "sqlite" });
  if (accesses.length === 0) {
    return null;
  }
  const kind = accesses.some((access) => access.kind === "write")
    ? "write"
    : "read";
  return { kind };
};

/**
 * Keyed by the type a project writes on its `Env` declaration.
 * Cloudflare defines these type names.
 */
const STORES: Record<string, { storageSystem: string; read: OperationReader }> =
  {
    KVNamespace: { storageSystem: "cloudflare-kv", read: objectStoreAccess },
    R2Bucket: { storageSystem: "r2", read: objectStoreAccess },
    D1Database: { storageSystem: "d1", read: d1Access },
  };

interface RecognizerContext {
  resolveWrittenValue?: (value: Node) => Node | null;
  resolution?: ResolutionStore;
}

export function storeBindingRecognizer(
  call: unknown,
  ctx: unknown,
): Effect[] | null {
  const callNode = call as CallExpression;
  const given = ctx as RecognizerContext;
  const reading: Reading = {
    resolve: given.resolveWrittenValue ?? (() => null),
    resolution: given.resolution,
  };

  const callee = callNode.getExpression();
  if (!N.isPropertyAccessExpression(callee)) {
    return null;
  }
  const binding = boundReceiver(callee.getExpression(), reading);
  if (binding === null) {
    return null;
  }
  const store = STORES[binding.typeName];
  if (store === undefined) {
    return null;
  }
  const method = callee.getName();
  const access = store.read(method, callNode, reading);
  if (access === null) {
    return null;
  }

  return [
    {
      type: "interaction",
      binding: storageBinding({
        recognition: RECOGNITION,
        storageSystem: store.storageSystem,
        scope: "default",
        container: binding.name,
        accessPath: null,
      }),
      callee: callee.getText(),
      interaction: {
        class: "storage-access",
        kind: access.kind,
        // KV and R2 values are opaque, and a D1 statement is read at the
        // database level, so a call never records a field.
        fields: [],
        operation: method,
        ...(access.selector !== undefined
          ? { selector: [access.selector] }
          : {}),
      },
    },
  ];
}

interface BoundReceiver {
  /** The binding's name, which is the property read off env. */
  name: string;
  /** The type written for it on the Env declaration. */
  typeName: string;
}

/**
 * Returns null when the receiver is not an env binding. A receiver put
 * in a variable first (`const kv = env.SESSIONS`) is followed back to
 * where it was built.
 */
function boundReceiver(subject: Node, reading: Reading): BoundReceiver | null {
  let receiver: Node = subject;
  if (N.isIdentifier(receiver)) {
    // The resolution store stops at module scope, and a binding is
    // usually put in a local inside the handler body.
    const written = declaredInitializer(receiver) ?? reading.resolve(receiver);
    if (written !== null && written !== receiver) {
      receiver = written;
    }
  }
  if (!N.isPropertyAccessExpression(receiver)) {
    return null;
  }
  const env = receiver.getExpression();
  if (!N.isIdentifier(env) || !isTriggerEnvArgument(env, reading.resolution)) {
    return null;
  }
  const typeName = declaredTypeName(receiver);
  if (typeName === null) {
    return null;
  }
  return { name: receiver.getName(), typeName };
}

/** A local variable's initializer, for a binding assigned to one first. */
function declaredInitializer(identifier: Node): Node | null {
  for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
    if (N.isVariableDeclaration(declaration)) {
      return declaration.getInitializer() ?? null;
    }
  }
  return null;
}

/**
 * The type is read as source text, so it works whether or not
 * `@cloudflare/workers-types` is installed.
 */
function declaredTypeName(receiver: PropertyAccessExpression): string | null {
  const declarations =
    receiver.getNameNode().getSymbol()?.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (!N.isPropertySignature(declaration)) {
      continue;
    }
    const typeNode = declaration.getTypeNode();
    if (typeNode !== undefined) {
      return typeNode.getText();
    }
  }
  return null;
}
