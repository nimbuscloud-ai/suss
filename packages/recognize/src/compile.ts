/**
 * Turning a chain into the recognizer hook the adapters already call.
 *
 * The links are guards, so the compiled hook checks the cheap one
 * first: looking a method up in a table costs nothing, while following
 * a receiver to the library that made it walks declarations. The chain
 * says which questions to ask, not the order to ask them in. A link
 * that changes what the receiver is, the way Prisma's model property
 * does, will need that order back, and the note here is where to start.
 */

import { storageBinding } from "@suss/behavioral-ir";

import { opsIn } from "./ops.js";

import type { Effect } from "@suss/behavioral-ir";
import type { InvocationRecognizer } from "@suss/extractor";
import type {
  ArgumentPick,
  Chain,
  ContainerLink,
  Ending,
  MatchStart,
  MethodsLink,
  StorageEnding,
  StorageMethod,
} from "./chain.js";
import type { CallOps } from "./ops.js";

/** What every ending is handed once the shared links have matched. */
interface Matched {
  ops: CallOps;
  /** The method as the source spells it. */
  method: string;
  meaning: StorageMethod;
  chain: Chain<StorageMethod>;
  recognition: string;
}

/** A chain, as the hook the adapter dispatches to on every call. */
export function compile(
  chain: Chain<StorageMethod>,
  recognition: string,
): InvocationRecognizer {
  return (_call: unknown, ctx: unknown): Effect[] | null => {
    const ops = opsIn(ctx);
    if (ops === null) {
      return null;
    }
    const method = ops.method();
    if (method === null) {
      return null;
    }
    const meaning = meaningOf(chain, method);
    if (meaning === null || !startsHere(chain, ops)) {
      return null;
    }
    return YIELD[chain.ending.yields]({
      ops,
      method,
      meaning,
      chain,
      recognition,
    });
  };
}

/** What the method table says this method does, or null when it says nothing. */
function meaningOf(
  chain: Chain<StorageMethod>,
  method: string,
): StorageMethod | null {
  const link = chain.links.find(
    (candidate): candidate is MethodsLink<StorageMethod> =>
      candidate.asks === "methods",
  );
  if (link === undefined) {
    return null;
  }
  if (!link.ignoringCase) {
    return link.table[method] ?? null;
  }
  return link.table[method.toLowerCase()] ?? null;
}

/** One check per place a match can start from. */
const START: Record<
  MatchStart["starts"],
  (start: MatchStart, ops: CallOps) => boolean
> = {
  receiver: (start, ops) => ops.receiverIsFrom(start.origin),
};

/** Whether the call is where the chain says its match starts. */
function startsHere(chain: Chain<StorageMethod>, ops: CallOps): boolean {
  return chain.links.every((link) =>
    link.asks === "start" ? START[link.at.starts](link.at, ops) : true,
  );
}

/** One ending per thing a chain can produce. */
const YIELD: Record<Ending["yields"], (matched: Matched) => Effect[] | null> = {
  storageAccess: storageAccess,
};

function storageAccess(matched: Matched): Effect[] {
  const { ops, method, meaning, chain, recognition } = matched;
  const ending = chain.ending as StorageEnding;
  const selector = namesAt(ops, meaning.selector, ending.unsettledName);
  const fields = namesAt(ops, meaning.fields, ending.unsettledName);
  const container = containerOf(chain, selector, ops);

  return [
    {
      type: "interaction",
      binding: storageBinding({
        recognition,
        storageSystem: ending.system,
        ...(ending.transport === undefined
          ? {}
          : { transport: ending.transport }),
        scope: ending.scope,
        container,
        accessPath: null,
      }),
      callee: ops.calleeText(),
      interaction: {
        class: "storage-access",
        kind: meaning.kind,
        fields,
        operation: method,
        ...(selector.length > 0 ? { selector } : {}),
      },
    },
  ];
}

/** The container the selector belongs to, by the pack's own rule. */
function containerOf(
  chain: Chain<StorageMethod>,
  selector: readonly string[],
  ops: CallOps,
): string | null {
  const link = chain.links.find(
    (candidate): candidate is ContainerLink => candidate.asks === "container",
  );
  if (link === undefined) {
    return selector[0] ?? null;
  }
  return link.from(selector, ops);
}

/** The name each picked argument gives, dropping the ones nothing settles. */
function namesAt(
  ops: CallOps,
  pick: ArgumentPick | undefined,
  unsettled: "nothing" | "reference",
): string[] {
  if (pick === undefined) {
    return [];
  }
  const last = "at" in pick ? pick.at + 1 : ops.argumentCount();
  const first = "at" in pick ? pick.at : pick.from;
  const names: string[] = [];
  for (let index = first; index < last; index += 1) {
    const name = ops.nameAt(index, unsettled);
    if (name !== null) {
      names.push(name);
    }
  }
  return names;
}
