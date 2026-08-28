/**
 * @suss/framework-zustand: the PatternPack for zustand stores.
 *
 * A store is client-side state with readers and writers the way a
 * table has them, so its accesses come out as `storage-access`
 * effects against `client-store:<name>`, and `ask "what writes
 * client-store:useAppStore"` reads like the same question about a
 * database. The client is anything built from zustand's `create`, and
 * the store's variable name is the container, since that is what a
 * person calls the store. This covers the imperative surface
 * (`setState`, `getState`, `subscribe`); the hook's selector form
 * (`useAppStore((s) => s.bears)`) waits on the two recognize links
 * described in the pack's issue.
 */

import { constructedFrom, pack, storageCalls } from "@suss/recognize";

import type {
  CallOps,
  InputRule,
  PatternPack,
  StatedRule,
  StorageMethod,
} from "@suss/recognize";

/** What an object's properties are called. */
const WRITTEN: InputRule = ({ input }) => {
  const found: string[] = [];
  for (const entry of input.entries("nothing")) {
    if (entry.key !== null) {
      found.push(entry.key);
    }
  }
  return found;
};

const payload = (at: number): StatedRule => ({ of: { at }, by: WRITTEN });

/**
 * The imperative store surface. A functional `setState((s) => ...)`
 * states its fields in the lambda's return, which the payload rule
 * cannot see, so such a write comes out with no fields rather than
 * wrong ones.
 */
const METHODS: Record<string, StorageMethod> = {
  setState: { kind: "write", fields: payload(0) },
  getState: { kind: "read" },
  subscribe: { kind: "read" },
};

/**
 * The store's own name, read off the callee. `useAppStore.setState`
 * is a call on the store, so everything before the method is what the
 * project calls it.
 */
function storeNameOf(_names: readonly string[], call: CallOps): string | null {
  const callee = call.calleeText();
  const dot = callee.lastIndexOf(".");
  return dot > 0 ? callee.slice(0, dot) : null;
}

const STORE_CALLS = storageCalls({
  system: "client-store",
  client: constructedFrom("zustand", "zustand/vanilla"),
})
  .methods(METHODS)
  .container(storeNameOf)
  .example("useAppStore.setState({ bears: 5 })");

export function zustandFramework(): PatternPack {
  return pack("zustand", [STORE_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-zustand",
  });
}

export default zustandFramework;
