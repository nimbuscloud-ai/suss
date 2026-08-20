/**
 * KV, R2 and D1 calls on a trigger's env argument, as `storage-access`
 * effects.
 *
 * A Worker reaches its stores through bindings: `env.SESSIONS.get(key)`
 * for a KV namespace, `env.ARCHIVE.put(key, body)` for an R2 bucket,
 * `env.LEDGER.prepare(sql)` for a D1 database. The binding name is the
 * identity `wrangler.toml` declares for the same store, so the
 * container is the property's name and the storage check pairs
 * name-to-name. Which store a binding is comes from the type its `Env`
 * declaration states (`KVNamespace`, `R2Bucket`, `D1Database`); the
 * README says why, and what an untyped Worker gets.
 */

import { Node as N } from "ts-morph";

import { readName } from "@suss/adapter-typescript";
import { storageBinding } from "@suss/behavioral-ir";
import { readSqlAccess } from "@suss/sql";

import { isTriggerEnvArgument } from "./envBindings.js";

import type { Effect } from "@suss/behavioral-ir";
import type { CallExpression, Node, PropertyAccessExpression } from "ts-morph";

const RECOGNITION = "@suss/framework-cloudflare-workers";

/** What one call says once a reader has settled it. */
interface StoreAccess {
  kind: "read" | "write";
  /** The key the call addresses, when the call states one. */
  selector?: string;
}

type Resolve = (value: Node) => Node | null;

/** Reads one store's method call, or null for a method it is not. */
type OperationReader = (
  method: string,
  call: CallExpression,
  resolve: Resolve,
) => StoreAccess | null;

/** KV and R2 spell the same five operations, and the kinds line up. */
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

const objectStoreAccess: OperationReader = (method, call, resolve) => {
  const kind = OBJECT_OPERATIONS[method];
  if (kind === undefined) {
    return null;
  }
  const argument = call.getArguments()[0];
  const selector =
    argument !== undefined && KEYED_OPERATIONS.has(method)
      ? readName(argument, { resolve, unsettled: "reference" })
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
 * D1 is SQLite, so the statement says whether the call reads or
 * writes. A statement nobody can read settles neither, and the call
 * goes unrecorded rather than recorded with a guessed kind.
 */
const d1Access: OperationReader = (method, call, resolve) => {
  if (!D1_STATEMENT_METHODS.has(method)) {
    return null;
  }
  const sql = literalText(call.getArguments()[0], resolve);
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
 * One reader per binding type Cloudflare declares for a store. The key
 * is the type the project's `Env` declaration spells.
 */
const STORES: Record<string, { storageSystem: string; read: OperationReader }> =
  {
    KVNamespace: { storageSystem: "cloudflare-kv", read: objectStoreAccess },
    R2Bucket: { storageSystem: "r2", read: objectStoreAccess },
    D1Database: { storageSystem: "d1", read: d1Access },
  };

interface RecognizerContext {
  resolveWrittenValue?: (value: Node) => Node | null;
}

export function storeBindingRecognizer(
  call: unknown,
  ctx: unknown,
): Effect[] | null {
  const callNode = call as CallExpression;
  const resolve =
    (ctx as RecognizerContext).resolveWrittenValue ?? (() => null);

  const callee = callNode.getExpression();
  if (!N.isPropertyAccessExpression(callee)) {
    return null;
  }
  const binding = boundReceiver(callee.getExpression(), resolve);
  if (binding === null) {
    return null;
  }
  const store = STORES[binding.typeName];
  if (store === undefined) {
    return null;
  }
  const method = callee.getName();
  const access = store.read(method, callNode, resolve);
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
        // KV and R2 keep opaque values and a D1 statement is judged at
        // database level, so no call states a field.
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
  /** The type the Env declaration states for it. */
  typeName: string;
}

/**
 * The env binding a call's receiver is, or null when the receiver is
 * something else. A receiver written into a variable first
 * (`const kv = env.SESSIONS`) is followed back to where it was built.
 */
function boundReceiver(subject: Node, resolve: Resolve): BoundReceiver | null {
  let receiver: Node = subject;
  if (N.isIdentifier(receiver)) {
    const written = declaredInitializer(receiver) ?? resolve(receiver);
    if (written !== null && written !== receiver) {
      receiver = written;
    }
  }
  if (!N.isPropertyAccessExpression(receiver)) {
    return null;
  }
  const env = receiver.getExpression();
  if (!N.isIdentifier(env) || !isTriggerEnvArgument(env)) {
    return null;
  }
  const typeName = declaredTypeName(receiver);
  if (typeName === null) {
    return null;
  }
  return { name: receiver.getName(), typeName };
}

/**
 * What a variable was written as, for a binding held in a local const
 * first. The shared resolver follows module-level bindings, and a
 * handler body's own const is one symbol lookup away.
 */
function declaredInitializer(identifier: Node): Node | null {
  for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
    if (N.isVariableDeclaration(declaration)) {
      return declaration.getInitializer() ?? null;
    }
  }
  return null;
}

/** The type the property's own declaration states, as written. */
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

/** A string the argument states, followed through const bindings. */
function literalText(
  argument: Node | undefined,
  resolve: Resolve,
): string | null {
  if (argument === undefined) {
    return null;
  }
  const written = resolve(argument) ?? argument;
  if (
    N.isStringLiteral(written) ||
    N.isNoSubstitutionTemplateLiteral(written)
  ) {
    return written.getLiteralValue();
  }
  return null;
}
