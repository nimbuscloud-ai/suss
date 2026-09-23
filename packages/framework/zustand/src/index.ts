/**
 * Records each read and write of a zustand store as a storage access on
 * `client-store:<name>`, where the name is the store's variable name.
 * The README shows the forms it reads and what it leaves out.
 */

import { constructedFrom, pack, storageCalls } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type {
  CallOps,
  InputRule,
  PatternPack,
  StatedRule,
  StorageMethod,
} from "@suss/recognize";

/** The property names of the object a write passes, one field each. */
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
 * A functional `setState((s) => ...)` sets its fields in the lambda's
 * return value, which the payload rule cannot read, so that write records
 * no fields at all.
 */
const METHODS: Record<string, StorageMethod> = {
  setState: { kind: "write", fields: payload(0) },
  getState: { kind: "read" },
  subscribe: { kind: "read" },
};

/**
 * In `useAppStore.setState(...)` the store's name is everything before
 * the method, and a bare `useAppStore(...)` call is the store itself.
 */
function storeNameOf(_names: readonly string[], call: CallOps): string | null {
  const callee = call.calleeText();
  const dot = callee.lastIndexOf(".");
  return dot > 0 ? callee.slice(0, dot) : callee;
}

const STORE_CALLS = storageCalls({
  system: "client-store",
  client: constructedFrom("zustand", "zustand/vanilla"),
})
  .methods(METHODS)
  .calls({ kind: "read", fields: { selectorParam: 0 } })
  .container(storeNameOf)
  .example("useAppStore((s) => s.bears)");

export function zustandFramework(): PatternPack {
  return pack("zustand", [STORE_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-zustand",
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-zustand",
  dependencies: [{ ecosystem: "npm", name: "zustand" }],
  reads:
    "zustand stores: \`setState\` writes and \`getState\` reads against the store as a client-side container.",
};

export default zustandFramework;
