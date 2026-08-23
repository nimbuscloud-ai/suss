/**
 * Turning a chain into the recognizer hook the adapters already call.
 *
 * The links are guards, so the compiled hook checks the cheap one
 * first: looking a method up in a table costs nothing, while following
 * a receiver to the library that made it walks declarations. The chain
 * says which questions to ask, not the order to ask them in. A link
 * that changes what the receiver is, the way Prisma's model property
 * does, will need that order back, and the note here is where to start.
 *
 * A chain that states a subject asks its questions of a call next to
 * the one in hand, so the walk lives here. The README beside this file
 * says what each step reaches and why the walk is bounded.
 */

import { storageBinding } from "@suss/behavioral-ir";

import { opsIn } from "./ops.js";

import type { Effect } from "@suss/behavioral-ir";
import type { InvocationRecognizer } from "@suss/extractor";
import type {
  AccessKind,
  ArgumentPick,
  CallStep,
  Chain,
  ContainerLink,
  Ending,
  KindAsAsked,
  MatchStart,
  MethodsLink,
  StorageEnding,
  StorageMethod,
  SubjectLink,
  ToArgument,
  ToReceiver,
} from "./chain.js";
import type { CallOps, UnsettledName } from "./ops.js";

/**
 * How many receivers a walk climbs before it gives up. A receiver chain
 * can come back round to where it started through a variable, and a
 * pack that meant eight hops has written something else by mistake.
 */
const MAX_RECEIVER_HOPS = 8;

/** What every ending is handed once the shared links have matched. */
interface Matched {
  /** The call in hand, which is what the effect records as its callee. */
  ops: CallOps;
  /** The call the chain is about, which every question is asked of. */
  subject: CallOps;
  /** The operation as the source spells it. */
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
    const methods = methodsIn(chain);
    if (ops === null || methods === null) {
      return null;
    }
    for (const subject of subjectsOf(chain, ops)) {
      const method = operationOf(subject);
      const meaning = method === null ? null : listed(methods, method);
      if (method === null || meaning === null || !startsHere(chain, subject)) {
        continue;
      }
      return YIELD[chain.ending.yields]({
        ops,
        subject,
        method,
        meaning,
        chain,
        recognition,
      });
    }
    return null;
  };
}

/** The methods link, which every chain that recognizes calls states. */
function methodsIn(
  chain: Chain<StorageMethod>,
): MethodsLink<StorageMethod> | null {
  const link = chain.links.find(
    (candidate): candidate is MethodsLink<StorageMethod> =>
      candidate.asks === "methods",
  );
  return link ?? null;
}

/**
 * The name the call goes to. A method call says it as the method, and a
 * call that reaches for no receiver, `new GetObjectCommand(...)`, says
 * it as the callee.
 */
function operationOf(ops: CallOps): string | null {
  return ops.method() ?? ops.calleeText();
}

/** What the method table says this operation does, or null. */
function listed(
  link: MethodsLink<StorageMethod>,
  method: string,
): StorageMethod | null {
  if (!link.ignoringCase) {
    return link.table[method] ?? null;
  }
  return link.table[method.toLowerCase()] ?? null;
}

/**
 * The calls a chain could be about. Without a subject link that is the
 * call in hand, and with one it is each call the steps reach, tried in
 * turn until the rest of the chain matches.
 */
function subjectsOf(chain: Chain<StorageMethod>, ops: CallOps): CallOps[] {
  const link = chain.links.find(
    (candidate): candidate is SubjectLink => candidate.asks === "subject",
  );
  return link === undefined ? [ops] : walk([ops], link.of);
}

/** One way of stepping from a call to the calls it reaches. */
const STEP: Record<
  CallStep["to"],
  (step: CallStep, ops: CallOps) => CallOps[]
> = {
  receiver: (step, ops) => receiversOf(ops, (step as ToReceiver).method),
  argument: (step, ops) => argumentsOf(ops, (step as ToArgument).at),
};

/** The calls a list of steps reaches from where it starts. */
function walk(from: readonly CallOps[], steps: readonly CallStep[]): CallOps[] {
  let reached = [...from];
  for (const step of steps) {
    reached = reached.flatMap((ops) => STEP[step.to](step, ops));
  }
  return reached;
}

/**
 * The receiver, or the one up the chain that calls the named method.
 * Climbing stops at the bound, so a receiver that comes back round
 * through a variable ends the walk rather than hanging the run.
 */
function receiversOf(ops: CallOps, method: string | undefined): CallOps[] {
  let step = ops.receiver();
  for (let hops = 0; step !== null && hops < MAX_RECEIVER_HOPS; hops += 1) {
    if (method === undefined || step.method() === method) {
      return [step];
    }
    step = step.receiver();
  }
  return [];
}

/** The calls the picked arguments are, in the order the call passes them. */
function argumentsOf(ops: CallOps, at: ToArgument["at"]): CallOps[] {
  const found: CallOps[] = [];
  for (const index of positions(ops, at)) {
    const argument = ops.argument(index);
    if (argument !== null) {
      found.push(argument);
    }
  }
  return found;
}

/** The argument positions a pick covers. */
function positions(
  ops: CallOps,
  pick: number | { readonly from: number } | ArgumentPick,
): number[] {
  if (typeof pick === "number") {
    return [pick];
  }
  const first = "at" in pick ? pick.at : pick.from;
  const last = "at" in pick ? pick.at + 1 : ops.argumentCount();
  const found: number[] = [];
  for (let index = first; index < last; index += 1) {
    found.push(index);
  }
  return found;
}

/** One check per place a match can start from. */
const START: Record<
  MatchStart["starts"],
  (start: MatchStart, ops: CallOps) => boolean
> = {
  receiver: (start, ops) => ops.receiverIsFrom(start.origin),
};

/** Whether the call is where the chain says its match starts. */
function startsHere(chain: Chain<StorageMethod>, subject: CallOps): boolean {
  return chain.links.every((link) =>
    link.asks === "start" ? START[link.at.starts](link.at, subject) : true,
  );
}

/** One ending per thing a chain can produce. */
const YIELD: Record<Ending["yields"], (matched: Matched) => Effect[] | null> = {
  storageAccess: storageAccess,
};

function storageAccess(matched: Matched): Effect[] {
  const { ops, subject, method, meaning, chain, recognition } = matched;
  const ending = chain.ending as StorageEnding;
  const unsettled = ending.unsettledName;
  const selector = namesAt(subject, meaning.selector, unsettled);
  const fields = namesAt(subject, meaning.fields, unsettled);
  const container = containerOf(chain, selector, subject, unsettled);

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
        kind: kindOf(meaning.kind, subject, unsettled),
        fields,
        operation: method,
        ...(selector.length > 0 ? { selector } : {}),
      },
    },
  ];
}

/** Whether the call reads or writes, when one of its arguments says. */
function kindOf(
  kind: AccessKind,
  subject: CallOps,
  unsettled: UnsettledName,
): "read" | "write" {
  if (typeof kind === "string") {
    return kind;
  }
  const asked = kind as KindAsAsked;
  const [answer] = namesAt(subject, asked.asks, unsettled);
  return answer === undefined
    ? asked.otherwise
    : (asked.means[answer] ?? asked.otherwise);
}

/** The container the selector belongs to, by the pack's own rule. */
function containerOf(
  chain: Chain<StorageMethod>,
  selector: readonly string[],
  subject: CallOps,
  unsettled: UnsettledName,
): string | null {
  const link = chain.links.find(
    (candidate): candidate is ContainerLink => candidate.asks === "container",
  );
  if (link === undefined) {
    return selector[0] ?? null;
  }
  if ("from" in link) {
    return link.from(selector, subject);
  }
  return namesAt(subject, link.argument, unsettled)[0] ?? null;
}

/** The name each picked argument gives, dropping the ones nothing settles. */
function namesAt(
  subject: CallOps,
  pick: ArgumentPick | undefined,
  unsettled: UnsettledName,
): string[] {
  if (pick === undefined) {
    return [];
  }
  const names: string[] = [];
  for (const ops of walk([subject], pick.of ?? [])) {
    for (const index of positions(ops, pick)) {
      const name = nameOf(ops, pick, index, unsettled);
      if (name !== null) {
        names.push(name);
      }
    }
  }
  return names;
}

/** What one argument says: the argument itself, or a property inside it. */
function nameOf(
  ops: CallOps,
  pick: ArgumentPick,
  index: number,
  unsettled: UnsettledName,
): string | null {
  if (pick.property === undefined) {
    return ops.nameAt(index, unsettled);
  }
  for (const property of pick.property) {
    const name = ops.propertyAt(index, property, unsettled);
    if (name !== null) {
      return name;
    }
  }
  return null;
}
