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
  AccessPathLink,
  ArgumentPick,
  CallStep,
  Chain,
  ContainerLink,
  ContainersLink,
  Ending,
  InputLink,
  KindAsAsked,
  Link,
  MatchStart,
  MethodsLink,
  OneArgument,
  StatedInputs,
  StorageEnding,
  StorageMethod,
  SubjectLink,
  ToArgument,
  ToReceiver,
} from "./chain.js";
import type {
  CallOps,
  ReceiverOrigin,
  UnsettledName,
  ValueOps,
} from "./ops.js";

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

/** The link for one question, or null when the chain does not ask it. */
function linkIn<TAsks extends Link<StorageMethod>["asks"]>(
  chain: Chain<StorageMethod>,
  asks: TAsks,
): Extract<Link<StorageMethod>, { asks: TAsks }> | null {
  const link = chain.links.find((candidate) => candidate.asks === asks);
  return (link as Extract<Link<StorageMethod>, { asks: TAsks }>) ?? null;
}

/** The methods link, which every chain that recognizes calls states. */
function methodsIn(
  chain: Chain<StorageMethod>,
): MethodsLink<StorageMethod> | null {
  return linkIn(chain, "methods");
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
  const link: SubjectLink | null = linkIn(chain, "subject");
  return link === null ? [ops] : walk([ops], link.of);
}

/** One way of stepping from a call to the calls it reaches. */
const STEP: Record<
  CallStep["to"],
  (step: CallStep, ops: CallOps) => CallOps[]
> = {
  receiver: (step, ops) => receiversOf(ops, (step as ToReceiver).method),
  argument: (step, ops) => argumentsOf(ops, step as ToArgument),
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

/**
 * The calls the picked arguments are, in the order the call passes
 * them, dropping the ones the step's origin rules out.
 */
function argumentsOf(ops: CallOps, step: ToArgument): CallOps[] {
  const found: CallOps[] = [];
  for (const index of positions(ops, step.at)) {
    const argument = ops.argument(index);
    if (argument !== null && cameFrom(argument, step.origin)) {
      found.push(argument);
    }
  }
  return found;
}

/** Whether an argument is the one the step's origin asked for. */
function cameFrom(argument: CallOps, origin: ReceiverOrigin | undefined) {
  return origin === undefined || argument.isFrom(origin);
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

/** One container a call reached, and what the call says about it. */
interface Reached {
  /** What the container is called, when the map's own key says. */
  readonly container: string | null;
  /** The entry, or null when the call reached a single container. */
  readonly entry: ValueOps | null;
}

/** What one storage effect is built from, beyond the links themselves. */
interface Access {
  /** The object the call states its inputs as, when the chain says where. */
  readonly input: ValueOps | null;
  readonly kind: "read" | "write";
  readonly reached: Reached;
  readonly unsettled: UnsettledName;
}

function storageAccess(matched: Matched): Effect[] | null {
  const { subject, meaning, chain } = matched;
  const unsettled = (chain.ending as StorageEnding).unsettledName;
  const kind = kindOf(meaning.kind, subject, unsettled);
  const link: InputLink | null = linkIn(chain, "input");
  const input = link === null ? null : statedValue(subject, link.at);
  if (kind === null || (link !== null && input === null)) {
    return null;
  }
  return reachedBy(chain, subject, unsettled).map((reached) =>
    accessEffect(matched, { input, kind, reached, unsettled }),
  );
}

function accessEffect(matched: Matched, access: Access): Effect {
  const { ops, subject, method, meaning, chain, recognition } = matched;
  const ending = chain.ending as StorageEnding;
  const { input, kind, reached, unsettled } = access;
  const stated = { input, entry: reached.entry, kind };
  const selector = namesFor(meaning.selector, subject, stated, unsettled);
  const fields = namesFor(meaning.fields, subject, stated, unsettled);

  return {
    type: "interaction",
    binding: storageBinding({
      recognition,
      storageSystem: ending.system,
      ...(ending.transport === undefined
        ? {}
        : { transport: ending.transport }),
      scope: ending.scope,
      container:
        reached.entry === null
          ? containerOf(chain, selector, subject, unsettled)
          : reached.container,
      accessPath: accessPathOf(chain, subject, unsettled),
    }),
    callee: ops.calleeText(),
    interaction: {
      class: "storage-access",
      kind,
      fields,
      operation: namesAt(subject, meaning.operation, unsettled)[0] ?? method,
      ...(selector.length > 0 ? { selector } : {}),
    },
  };
}

/**
 * The containers the call reached. A call that states a map of them
 * reached one per entry, and every other call reached the single
 * container the container link picks out.
 */
function reachedBy(
  chain: Chain<StorageMethod>,
  subject: CallOps,
  unsettled: UnsettledName,
): Reached[] {
  const link: ContainersLink | null = linkIn(chain, "containers");
  const map = link === null ? null : statedValue(subject, link.in);
  if (map === null) {
    return [{ container: null, entry: null }];
  }
  return map
    .entries(unsettled)
    .map((entry) => ({ container: entry.key, entry: entry.value }));
}

/**
 * Whether the call reads or writes, or null when one of its arguments
 * says and what it said is not something this chain matches.
 */
function kindOf(
  kind: AccessKind,
  subject: CallOps,
  unsettled: UnsettledName,
): "read" | "write" | null {
  if (typeof kind === "string") {
    return kind;
  }
  const asked = kind as KindAsAsked;
  const [answer] = namesAt(subject, asked.asks, unsettled);
  const said = answer === undefined ? undefined : asked.means[answer];
  return said ?? asked.otherwise ?? null;
}

/** The container the selector belongs to, by the pack's own rule. */
function containerOf(
  chain: Chain<StorageMethod>,
  selector: readonly string[],
  subject: CallOps,
  unsettled: UnsettledName,
): string | null {
  const link: ContainerLink | null = linkIn(chain, "container");
  if (link === null) {
    return selector[0] ?? null;
  }
  if ("from" in link) {
    return link.from(selector, subject);
  }
  return namesAt(subject, link.argument, unsettled)[0] ?? null;
}

/** Which way into the container the call took, when the chain says where. */
function accessPathOf(
  chain: Chain<StorageMethod>,
  subject: CallOps,
  unsettled: UnsettledName,
): string | null {
  const link: AccessPathLink | null = linkIn(chain, "accessPath");
  return link === null
    ? null
    : (namesAt(subject, link.argument, unsettled)[0] ?? null);
}

/** The value the call states where a pick points, or null for none. */
function statedValue(subject: CallOps, pick: OneArgument): ValueOps | null {
  for (const ops of walk([subject], pick.of ?? [])) {
    const stated = ops.valueAt(pick.at);
    if (stated === null) {
      continue;
    }
    if (pick.property === undefined) {
      return stated;
    }
    for (const property of pick.property) {
      const inside = stated.property(property);
      if (inside !== null) {
        return inside;
      }
    }
  }
  return null;
}

/** What the call reached, by the argument it picks or by the pack's rule. */
function namesFor(
  says: StorageMethod["selector"],
  subject: CallOps,
  stated: Omit<StatedInputs, "input"> & { input: ValueOps | null },
  unsettled: UnsettledName,
): string[] {
  if (says === undefined) {
    return [];
  }
  if (typeof says !== "function") {
    return namesAt(subject, says, unsettled);
  }
  const input = stated.input;
  return input === null ? [] : [...says({ ...stated, input })];
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
