/**
 * A Worker's calls on its store bindings, such as `env.SESSIONS.get(key)`,
 * declared as chains. Each call becomes a `storage-access` interaction on
 * the store the binding's type says it is: `KVNamespace`, `R2Bucket` or
 * `D1Database`, which Cloudflare defines. The container is the binding's
 * name, which is also the identity `wrangler.toml` declares for the
 * store, so the storage check pairs the two sides by name. The README
 * says what a Worker with no such type on a binding gets.
 */

import {
  allOf,
  handedIn,
  readOff,
  sqlStatements,
  storageCalls,
  typed,
} from "@suss/recognize";
import { GLOBAL_MODULE } from "@suss/resolution";

import { ENV } from "./triggers.js";

import type { MemberContainer, StorageMethod } from "@suss/recognize";

/**
 * A binding is a member read off the env a trigger is handed, and its
 * type says which store it is. The read is asked first, since the type
 * asks the checker and the method names are common ones.
 */
function bound(type: string) {
  return allOf(
    readOff(handedIn(ENV)),
    typed({ from: [GLOBAL_MODULE], named: [type] }),
  );
}

/** The binding the call is made on. */
const BINDING: MemberContainer = { of: [{ to: "member" }] };

const KEYED = { at: 0 } as const;

/**
 * KV and R2 share their method names, and a shared method reads or
 * writes on both. The key an operation addresses is its selector.
 */
const OBJECT_STORE: Record<string, StorageMethod> = {
  get: { kind: "read", selector: KEYED },
  getWithMetadata: { kind: "read", selector: KEYED },
  head: { kind: "read", selector: KEYED },
  list: { kind: "read" },
  put: { kind: "write", selector: KEYED },
  delete: { kind: "write", selector: KEYED },
};

const kv = storageCalls({
  system: "cloudflare-kv",
  client: bound("KVNamespace"),
})
  .methods(OBJECT_STORE)
  .container(BINDING)
  .slots("none")
  .example('env.SESSIONS.get("session:current")');

const r2 = storageCalls({ system: "r2", client: bound("R2Bucket") })
  .methods(OBJECT_STORE)
  .container(BINDING)
  .slots("none")
  .example('env.ARCHIVE.get("reports/latest.csv")');

/**
 * D1 takes a statement as text. `batch` takes statements `prepare`
 * built, and each was read at its own call. wrangler declares the
 * database and not its tables, so a call is one access on the binding,
 * a write when the statement writes any table.
 */
const d1 = sqlStatements({
  system: "d1",
  dialect: "sqlite",
  client: bound("D1Database"),
  walk: "invocation",
})
  .methods({ prepare: { statement: KEYED }, exec: { statement: KEYED } })
  .container(BINDING)
  .example('env.LEDGER.prepare("SELECT total FROM entries")');

/** The store chains, in the order their effects are placed at one call. */
export const STORE_CALLS = [kv, r2, d1];
