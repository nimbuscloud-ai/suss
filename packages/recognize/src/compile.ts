/**
 * Turns a chain into the recognizer hook the adapters already call.
 *
 * Every link is a guard, and the compiled hook checks the cheapest one
 * first. Looking a method up in a table costs nothing, while following
 * a receiver to the library that made it walks declarations. So the
 * hook ignores the order the pack declared its links in. A start that
 * looks past the call's own receiver states the steps it takes there.
 *
 * A chain that states a subject asks its questions of a call next to
 * the one in hand, and the walk to that call is also here. DESIGN.md
 * describes what each step reaches and why the walk is bounded.
 */

import {
  functionCallBinding,
  ioBinding,
  messageBusBinding,
  resourceNameIn,
  storageBinding,
  unitInvocationBinding,
} from "@suss/behavioral-ir";
import { byOrigin, callSiteKey } from "@suss/extractor";
import { readSqlAccess, splitQualifiedTable, sqlFromParts } from "@suss/sql";

import { modulesOf, opsIn } from "./ops.js";
import { type SlotColumns, slotsDeclared } from "./slots.js";

import type { Effect, TypeShape } from "@suss/behavioral-ir";
import type {
  AstCapableValueOps,
  ByOrigin,
  DiscoveredSubUnit,
  EffectArg,
  InvocationRecognizer,
  PatternPack,
  StatedSlot,
  SubUnitOpsCarrier,
  ValueForm,
} from "@suss/extractor";
import type { SqlPlaceholder } from "@suss/sql";
import type {
  AccessKind,
  AccessPathLink,
  ArgumentPick,
  CallbackArgument,
  CallbackMethod,
  CallbackPick,
  CallbackProperty,
  CallStep,
  Chain,
  ChannelPart,
  ContainerLink,
  ContainerMember,
  ContainersLink,
  Ending,
  InputLink,
  InterpolatesLink,
  KindAsAsked,
  Link,
  ManyIn,
  MatchStart,
  MessageLocation,
  MessageSendEnding,
  MessageSendMethod,
  MethodMeaning,
  MethodsLink,
  Naming,
  OneArgument,
  RelatedAccess,
  RelationsLink,
  ScheduleEnding,
  ScheduleUnread,
  ScopeLink,
  SlotsLink,
  SqlEnding,
  SqlMethod,
  StatedInputs,
  StatedRule,
  StorageEnding,
  StorageMethod,
  StorageSystem,
  StreamWriteEnding,
  StreamWriteMethod,
  SubjectLink,
  SubUnitNamePart,
  ToArgument,
  ToReceiver,
  UnitInvokeEnding,
  UnitInvokeMethod,
  UnitWhenInPlaceLink,
} from "./chain.js";
import type {
  CallOps,
  Global,
  ReceiverOrigin,
  UnsettledName,
  ValueOps,
} from "./ops.js";

/**
 * How many receivers a walk climbs before it gives up. A receiver chain
 * can loop back to where it started through a variable, and no pack
 * means a step eight hops away.
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
  /** What the method table says this method does, as its ending reads it. */
  meaning: MethodMeaning;
  chain: Chain<MethodMeaning>;
  recognition: string;
  /** Whether the call matched as a call of the client itself, with no receiver. */
  bare: boolean;
}

/** A chain, as the hook the adapter dispatches to on every call. */
export function compile(
  chain: Chain<MethodMeaning>,
  recognition: string,
): InvocationRecognizer {
  const receiverMethods = methodsWhoseReceiversAreAsked(chain);
  const modules = modulesOfChain(chain);
  return (_call: unknown, ctx: unknown): Effect[] | null => {
    const ops = opsIn(ctx);
    if (ops === null) {
      return null;
    }

    const bare = bareCall(chain, ops, modules);
    if (bare !== null) {
      return YIELD[chain.ending.yields]({
        ops,
        subject: ops,
        method: bare.method,
        meaning: bare.meaning,
        chain,
        recognition,
        bare: true,
      });
    }

    const methods = methodsIn(chain);
    if (methods === null) {
      return null;
    }
    if (receiverMethods !== null) {
      ops.readingReceivers?.(receiverMethods);
    }
    for (const subject of subjectsOf(chain, ops)) {
      const matched = methodMatched(chain, methods, subject, modules);
      if (matched === null) {
        continue;
      }
      return YIELD[chain.ending.yields]({
        ops,
        subject,
        method: matched.method,
        meaning: matched.meaning,
        chain,
        recognition,
        bare: false,
      });
    }
    return null;
  };
}

/**
 * The operation a subject goes to and what the table says it does, once
 * the chain's start accepts the subject. A call with no receiver that the
 * table does not list as written is read as the export its callee was
 * imported as, so `new Get(...)` after `import { GetCommand as Get }` is
 * `GetCommand`. That question asks the store, so it comes last.
 */
function methodMatched(
  chain: Chain<MethodMeaning>,
  methods: MethodsLink<MethodMeaning>,
  subject: CallOps,
  modules: readonly string[],
): { method: string; meaning: MethodMeaning } | null {
  const written = operationOf(subject);
  const meaning = listed(methods, written);
  if (meaning !== null) {
    return startsHere(chain, subject) ? { method: written, meaning } : null;
  }
  if (subject.method() !== null || !startsHere(chain, subject)) {
    return null;
  }
  const exported = subject.calleeImportedAs?.(modules) ?? null;
  const byExport = exported === null ? null : listed(methods, exported);
  return exported === null || byExport === null
    ? null
    : { method: exported, meaning: byExport };
}

/**
 * Every module a chain's origins mention: where its match starts, the
 * command a subject step steps to, and what an interpolated value must
 * come from. A file that imports none of them cannot match the chain.
 */
export function modulesOfChain(chain: Chain<MethodMeaning>): string[] {
  const modules = new Set<string>();
  for (const origin of originsIn(chain)) {
    for (const module of modulesOf(origin)) {
      modules.add(module);
    }
  }
  return [...modules];
}

function originsIn(chain: Chain<MethodMeaning>): ReceiverOrigin[] {
  const found: ReceiverOrigin[] = [];
  for (const link of chain.links) {
    if (link.asks === "start" && link.at.starts === "receiver") {
      found.push(link.at.origin);
    }
    if (link.asks === "interpolates" && link.from !== undefined) {
      found.push(link.from);
    }
    if (link.asks !== "subject") {
      continue;
    }
    for (const step of link.of) {
      if (step.to === "argument" && step.origin !== undefined) {
        found.push(step.origin);
      }
    }
  }
  return found;
}

/**
 * The methods whose receivers the chain asks about, or null when it does
 * not say. A chain asks what made the receiver of every call whose
 * method it lists when the match starts at the receiver of the call in
 * hand and the origin is a construction. A table that ignores case
 * cannot list the spellings, so it says nothing.
 */
function methodsWhoseReceiversAreAsked(
  chain: Chain<MethodMeaning>,
): ReadonlySet<string> | null {
  const start = linkIn(chain, "start");
  const table = methodsIn(chain);
  if (
    start === null ||
    start.at.starts !== "receiver" ||
    start.at.origin.origin !== "constructed" ||
    start.at.of !== undefined ||
    linkIn(chain, "subject") !== null ||
    table === null ||
    table.ignoringCase
  ) {
    return null;
  }
  return new Set(Object.keys(table.table));
}

/** The link for one question, or null when the chain does not ask it. */
function linkIn<TAsks extends Link<MethodMeaning>["asks"]>(
  chain: Chain<MethodMeaning>,
  asks: TAsks,
): Extract<Link<MethodMeaning>, { asks: TAsks }> | null {
  const link = chain.links.find((candidate) => candidate.asks === asks);
  return (link as Extract<Link<MethodMeaning>, { asks: TAsks }>) ?? null;
}

/**
 * A bare call of the tracked client itself, when the chain has a calls
 * link. There is no method name to look up, so the link's one meaning
 * applies. The call matches only when its callee is a bound name that
 * came from the chain's origin.
 */
function bareCall(
  chain: Chain<MethodMeaning>,
  ops: CallOps,
  modules: readonly string[],
): { method: string; meaning: MethodMeaning } | null {
  const start = linkIn(chain, "start");
  if (start?.at.origin.origin === "global") {
    return globalCalled(chain, ops, start.at.origin);
  }
  const link = linkIn(chain, "calls");
  if (link === null || start === null || start.at.starts !== "receiver") {
    return null;
  }
  if (ops.method() !== null || ops.namedCallee?.() !== true) {
    return null;
  }
  if (!byOrigin(BARE_CALL_FROM, start.at.origin, ops)) {
    return null;
  }
  return {
    method: ops.calleeImportedAs?.(modules) ?? ops.calleeText(),
    meaning: link.meaning,
  };
}

/**
 * A call with no receiver to the global a chain starts from, `print(x)`
 * or `puts x`, read as a method on that global: the callee is looked up
 * in the methods table, whatever the adapter says the method is. Ruby
 * says `puts` is a method on `self`.
 */
function globalCalled(
  chain: Chain<MethodMeaning>,
  ops: CallOps,
  origin: Global,
): { method: string; meaning: MethodMeaning } | null {
  const methods = methodsIn(chain);
  const callee = ops.calleeText();
  const meaning = methods === null ? null : listed(methods, callee);
  if (meaning === null || !ops.isFrom(origin)) {
    return null;
  }
  return { method: callee, meaning };
}

/**
 * Where a bare call's callee came from. An imported function is the
 * name itself, a global is spelled as itself, and anything else is the
 * call the name was written as, such as the `create(...)` behind a
 * store hook.
 */
const BARE_CALL_FROM: ByOrigin<boolean, [CallOps]> = {
  imported: (origin, ops) => ops.isFrom(origin),
  declaredBy: (origin, ops) => writtenFrom(origin, ops),
  constructed: (origin, ops) => writtenFrom(origin, ops),
  returnedBy: (origin, ops) => writtenFrom(origin, ops),
  typed: (origin, ops) => writtenFrom(origin, ops),
  inherits: (origin, ops) => writtenFrom(origin, ops),
  handedBy: (origin, ops) => writtenFrom(origin, ops),
  anyOf: (origin, ops) =>
    origin.of.some((one) => byOrigin(BARE_CALL_FROM, one, ops)),
  global: (origin, ops) => ops.isFrom(origin),
};

/** Whether the call the callee was written as came from the origin. */
function writtenFrom(origin: ReceiverOrigin, ops: CallOps): boolean {
  return ops.callee()?.isFrom(origin) === true;
}

/** The methods link, which every chain that recognizes calls states. */
function methodsIn(
  chain: Chain<MethodMeaning>,
): MethodsLink<MethodMeaning> | null {
  return linkIn(chain, "methods");
}

/**
 * The name the call goes to, as written. A method call says it as the
 * method, and a call that reaches for no receiver, `new
 * GetObjectCommand(...)`, says it as the callee.
 */
function operationOf(ops: CallOps): string {
  return ops.method() ?? ops.calleeText();
}

/**
 * What the method table says this operation does, or null. Only the
 * table's own keys count, so `client.toString()` never finds the method
 * every object inherits.
 */
function listed(
  link: MethodsLink<MethodMeaning>,
  method: string,
): MethodMeaning | null {
  const key = link.ignoringCase ? method.toLowerCase() : method;
  return Object.hasOwn(link.table, key) ? (link.table[key] ?? null) : null;
}

/**
 * The calls a chain could be about. Without a subject link that is the
 * call in hand, and with one it is each call the steps reach, tried in
 * turn until the rest of the chain matches.
 */
function subjectsOf(chain: Chain<MethodMeaning>, ops: CallOps): CallOps[] {
  const link: SubjectLink | null = linkIn(chain, "subject");
  if (link === null) {
    return [ops];
  }
  announceArgumentReads(link.of, ops);
  return walk([ops], link.of);
}

/**
 * A subject walk that starts at the arguments reads them at every call
 * the walk visits, since this hook runs on each of those calls. Saying
 * so before the first read lets the adapter ask about them together.
 */
function announceArgumentReads(steps: readonly CallStep[], ops: CallOps): void {
  const first = steps[0];
  if (first === undefined || first.to !== "argument") {
    return;
  }
  const at = first.at;
  if (typeof at === "number") {
    ops.readingArguments?.(at, at);
    return;
  }
  ops.readingArguments?.(at.from);
}

/** One way of stepping from a call to the calls it reaches. */
const STEP: Record<
  CallStep["to"],
  (step: CallStep, ops: CallOps) => CallOps[]
> = {
  receiver: (step, ops) => receiversOf(ops, (step as ToReceiver).method),
  argument: (step, ops) => argumentsOf(ops, step as ToArgument),
  member: (_step, ops) => {
    const member = ops.member?.() ?? null;
    return member === null ? [] : [member];
  },
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
  receiver: (start, ops) =>
    walk([ops], start.of ?? []).some((at) => at.receiverIsFrom(start.origin)),
};

/** Whether the call is where the chain says its match starts. */
function startsHere(chain: Chain<MethodMeaning>, subject: CallOps): boolean {
  return chain.links.every((link) =>
    link.asks === "start" ? START[link.at.starts](link.at, subject) : true,
  );
}

/** One ending per thing a chain can produce. */
const YIELD: Record<Ending["yields"], (matched: Matched) => Effect[] | null> = {
  storageAccess: storageAccess,
  sqlAccess: sqlAccess,
  messageSend: messageSend,
  unitInvoke: unitInvoke,
  schedule: schedule,
  streamWrite: streamWrite,
};

/** The `to` of a method that writes to the stream it is called on. */
const RECEIVER_STREAM = "receiver";

/**
 * One write to a stream the process owns. Its id is the callee and a
 * hash of what it writes, so a second site writing something else in
 * the same unit gets its own.
 */
function streamWrite(matched: Matched): Effect[] {
  const { ops, subject, recognition } = matched;
  const effect: Extract<Effect, { type: "interaction" }> = {
    type: "interaction",
    binding: ioBinding({ recognition, target: streamTarget(matched) }),
    callee: ops.calleeText(),
    interaction: { class: "stream-write", ...writtenPayload(subject) },
  };
  return [{ ...effect, groupId: callSiteKey(effect) }];
}

/**
 * The stream a write goes to, or null when the source does not settle
 * one. A method's own `to` is where the global itself sends that method,
 * so a receiver matched only by its type, some instance the source does
 * not say more about, writes to no stream in particular. So does a
 * receiver two of the globals reach.
 */
function streamTarget(matched: Matched): string | null {
  const { subject, chain } = matched;
  const { to } = matched.meaning as StreamWriteMethod;
  if (matched.bare) {
    return to === RECEIVER_STREAM ? null : to;
  }
  const start = linkIn(chain, "start");
  const paths = start === null ? [] : byOrigin(GLOBAL_PATHS, start.at.origin);
  const path = subject.receiverGlobal?.(paths) ?? null;
  if (path === null) {
    return null;
  }
  const { streams } = chain.ending as StreamWriteEnding;
  return to === RECEIVER_STREAM ? (streams[path] ?? null) : to;
}

/** The global paths an origin accepts a receiver spelled as. */
const GLOBAL_PATHS: ByOrigin<readonly string[]> = {
  global: (origin) => origin.paths,
  anyOf: (origin) => origin.of.flatMap((one) => byOrigin(GLOBAL_PATHS, one)),
  declaredBy: () => [],
  constructed: () => [],
  returnedBy: () => [],
  typed: () => [],
  inherits: () => [],
  handedBy: () => [],
  imported: () => [],
};

/**
 * What a write writes, as the shape the source writes it in. One value
 * written through an encoder is recorded as what went in, and so is one
 * a template puts nothing but whitespace around, the way a command ends
 * its JSON report with a newline. Several values are written one after
 * another, so their shapes are keyed by position.
 */
function writtenPayload(subject: CallOps): {
  payload: TypeShape | null;
  serialized: "json" | "text";
} {
  const count = subject.argumentCount();
  if (count !== 1) {
    const properties: Record<string, TypeShape> = {};
    for (let at = 0; at < count; at += 1) {
      properties[String(at)] = subject.valueAt(at)?.shape?.() ?? {
        type: "unknown",
      };
    }
    return { payload: { type: "record", properties }, serialized: "text" };
  }
  const only = subject.valueAt(0);
  for (const written of [heldInWhitespace(only), only]) {
    const encoded = written?.encoded?.() ?? null;
    if (encoded?.codec === "json") {
      return { payload: encoded.value.shape?.() ?? null, serialized: "json" };
    }
  }
  return { payload: only?.shape?.() ?? null, serialized: "text" };
}

/** The one value a template puts nothing but whitespace around, or null. */
function heldInWhitespace(value: ValueOps | null): ValueOps | null {
  const parts = value?.parts() ?? null;
  const [hole] = value?.interpolated?.() ?? [];
  if (
    parts === null ||
    parts.length !== 2 ||
    hole === undefined ||
    parts.some((part) => part.trim() !== "")
  ) {
    return null;
  }
  return hole;
}

/**
 * One effect for the callback a call hands over, saying which function
 * runs: one written in place, one the source names, or a reason the run
 * cannot tell.
 */
function schedule(matched: Matched): Effect[] {
  const { ops, subject, chain, recognition } = matched;
  const ending = chain.ending as ScheduleEnding;
  const callee = ops.calleeText();
  const found = callbackIn(
    subject,
    (matched.meaning as CallbackMethod).callback,
  );
  return [
    {
      type: "interaction",
      binding: functionCallBinding({ transport: "in-process", recognition }),
      callee,
      interaction: {
        class: "schedule",
        via: callee,
        callbackRef:
          found === null
            ? { type: "opaque", reason: ending.unread.missing }
            : CALLBACK_REF[formOf(found)](found, ending.unread),
        hasDelay: false,
      },
    },
  ];
}

type CallbackRef = Extract<
  Extract<Effect, { type: "interaction" }>["interaction"],
  { class: "schedule" }
>["callbackRef"];

/** What the effect says about the callback, by how the source wrote it. */
const CALLBACK_REF: Record<
  ValueForm,
  (found: ValueOps, unread: ScheduleUnread) => CallbackRef
> = {
  function: () => ({ type: "literal" }),
  name: (found) => ({ type: "identifier", name: found.source?.() ?? "" }),
  object: (_found, unread) => ({ type: "opaque", reason: unread.other }),
  element: (_found, unread) => ({ type: "opaque", reason: unread.other }),
  other: (_found, unread) => ({ type: "opaque", reason: unread.other }),
};

function formOf(value: ValueOps): ValueForm {
  return value.form?.() ?? "other";
}

/** The first value one of the picks finds, in the order the method lists them. */
function callbackIn(
  subject: CallOps,
  says: CallbackMethod["callback"],
): ValueOps | null {
  const picks: readonly CallbackPick[] = Array.isArray(says)
    ? says
    : [says as CallbackPick];
  for (const pick of picks) {
    const found = CALLBACK_PICKED[pick.written](subject, pick);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/** How each kind of pick reads the call. */
const CALLBACK_PICKED: Record<
  CallbackPick["written"],
  (subject: CallOps, pick: CallbackPick) => ValueOps | null
> = {
  callback: (subject, pick) =>
    callbackWrittenAt(subject, pick as CallbackArgument),
  here: (subject, pick) => propertyWrittenAt(subject, pick as CallbackProperty),
  block: (subject) => subject.block?.() ?? null,
};

/**
 * The argument, when it is a function written in place or a name for
 * something other than an object. A name for an object is the call's
 * options rather than its callback.
 */
function callbackWrittenAt(
  subject: CallOps,
  pick: CallbackArgument,
): ValueOps | null {
  const value = pickedIn(subject, pick, pick.at);
  if (value === null) {
    return null;
  }
  const form = formOf(value);
  if (form === "function") {
    return value;
  }
  return form === "name" && (value.object?.() ?? null) === null ? value : null;
}

/** One of the properties the object written out at the pick states, the first the pick lists. */
function propertyWrittenAt(
  subject: CallOps,
  pick: CallbackProperty,
): ValueOps | null {
  const value = pickedIn(subject, pick, pick.at);
  if (value === null || formOf(value) !== "object") {
    return null;
  }
  for (const property of pick.property) {
    const held = value.ownProperty?.(property) ?? null;
    if (held !== null) {
      return held;
    }
  }
  return null;
}

/**
 * The `subUnits` hook for the chains that say what a callback written in
 * place becomes. It reads the calls the adapter says the parent runs,
 * matches each the way the recognizer does, and claims the callback
 * when the source writes it in place. Null when no chain says.
 */
export function compileSubUnits(
  chains: readonly Chain<MethodMeaning>[],
): NonNullable<PatternPack["subUnits"]> | null {
  const claiming = chains.flatMap((chain) => {
    const link: UnitWhenInPlaceLink | null = linkIn(chain, "unitWhenInPlace");
    const methods = methodsIn(chain);
    return link === null || methods === null
      ? []
      : [{ chain, link, methods, modules: modulesOfChain(chain) }];
  });
  if (claiming.length === 0) {
    return null;
  }
  return (parent, ctx) => {
    const calls = (ctx as SubUnitOpsCarrier | null)?.calls?.(parent) ?? [];
    const counts = new Map<string, number>();
    const claims: DiscoveredSubUnit[] = [];
    for (const call of calls) {
      const claim = claiming
        .map((one) => ({ one, func: claimedIn(one, call) }))
        .find(({ func }) => func !== null);
      if (claim === undefined) {
        continue;
      }
      const callee = call.calleeText();
      const count = counts.get(callee) ?? 0;
      counts.set(callee, count + 1);
      claims.push({
        func: claim.func,
        kind: claim.one.link.kind,
        name: claim.one.link.name
          .map((part) =>
            NAME_PART[part]({ parent: parent.name, callee, count }),
          )
          .join(""),
        inputMapping: { type: "positionalParams", params: [] },
      });
    }
    return claims;
  };
}

/** What a claimed callback's name is built from. */
interface ClaimNaming {
  readonly parent: string;
  readonly callee: string;
  readonly count: number;
}

const NAME_PART: Record<SubUnitNamePart, (naming: ClaimNaming) => string> = {
  parent: (naming) => naming.parent,
  callee: (naming) => `.${naming.callee}`,
  countPerCallee: (naming) => `#${naming.count}`,
};

/** The adapter's own node for the callback a call writes in place, when this chain matches the call. */
function claimedIn(
  claiming: {
    chain: Chain<MethodMeaning>;
    methods: MethodsLink<MethodMeaning>;
    modules: readonly string[];
  },
  call: CallOps,
): unknown {
  const matched = methodMatched(
    claiming.chain,
    claiming.methods,
    call,
    claiming.modules,
  );
  const found =
    matched === null
      ? null
      : callbackIn(call, (matched.meaning as CallbackMethod).callback);
  if (found === null || formOf(found) !== "function") {
    return null;
  }
  return (found as Partial<AstCapableValueOps>).ast?.() ?? null;
}

/** One container a call reached, and what the call says about it. */
interface Reached {
  /** What the container is called, when the map's own key says. */
  readonly container: string | null;
  /** The entry, or null when the call reached a single container. */
  readonly entry: ValueOps | null;
  /** Whether the chain's containers link is what said. */
  readonly stated: boolean;
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
  const { subject, chain } = matched;
  const meaning = matched.meaning as StorageMethod;
  const unsettled = (chain.ending as StorageEnding).unsettledName;
  const kind = kindOf(meaning.kind, subject, unsettled);
  const link: InputLink | null = linkIn(chain, "input");
  const input = link === null ? null : statedValue(subject, link.at);
  if (kind === null || (link !== null && input === null)) {
    return null;
  }
  const effects = reachedBy(chain, subject, unsettled).flatMap((reached) =>
    accessEffects(matched, { input, kind, reached, unsettled }),
  );
  return effects.length > 0 ? effects : null;
}

/** The store a call reached: the one the ending states, or the one the call's project says. */
function systemOf(system: StorageSystem, ops: CallOps): string {
  if (typeof system === "string") {
    return system;
  }
  const file = ops.file?.() ?? null;
  return (file === null ? null : system.byFile(file)) ?? system.otherwise;
}

/** The namespace and the container one access reached. */
interface Address {
  readonly scope: string;
  readonly container: string | null;
}

/**
 * Where one access landed. A container the chain reads as a qualified
 * name gives its own namespace, the way a table written in a statement
 * does, and a name that does not settle leaves the access with no
 * address at all.
 */
function addressOf(
  matched: Matched,
  access: Access,
  selector: readonly string[],
  settled: string | null,
): Address | null {
  const { subject, chain } = matched;
  const { reached, unsettled } = access;
  const scope =
    scopeOf(chain, subject, unsettled) ?? (chain.ending as StorageEnding).scope;
  if (reached.stated || settled !== null) {
    return { scope, container: settled };
  }
  const link: ContainerLink | null = linkIn(chain, "container");
  if (link === null || !("argument" in link) || link.qualified !== true) {
    return {
      scope,
      container: containerOf(chain, selector, subject, unsettled),
    };
  }
  const [name] = namesAt(subject, link.argument, unsettled);
  const split = name === undefined ? null : splitQualifiedTable(name);
  if (split === null) {
    return null;
  }
  return {
    scope: split.qualifier[split.qualifier.length - 1] ?? scope,
    container: split.table,
  };
}

/**
 * The effect one access is, and one more for each access the call makes
 * through a relation of its container, on the same binding.
 */
function accessEffects(matched: Matched, access: Access): Effect[] {
  const settled = settledContainer(matched, access);
  const stated: StatedValues = {
    input: access.input,
    entry: access.reached.entry,
    kind: access.kind,
    container: settled,
    call: matched.subject,
  };
  const own = accessEffect(matched, access, stated);
  if (own === null) {
    return [];
  }
  const link: RelationsLink | null = linkIn(matched.chain, "relations");
  if (link === null) {
    return [own.effect];
  }
  const related = link.by({
    ...stated,
    input: statedValue(matched.subject, link.of) ?? NOTHING_STATED,
    container: own.container,
  });
  return [own.effect, ...related.map((one) => relatedEffect(own.effect, one))];
}

/** What a rule is handed, before the chain has found the value it reads. */
type StatedValues = Omit<StatedInputs, "input"> & { input: ValueOps | null };

/**
 * The container a link settles without reading the call's inputs: the
 * entry of a call that reaches several, or the member the call is made
 * on. Null otherwise, and the selector decides it once the rules have run.
 */
function settledContainer(matched: Matched, access: Access): string | null {
  if (access.reached.stated) {
    return access.reached.container;
  }
  const link: ContainerLink | null = linkIn(matched.chain, "container");
  return link !== null && "of" in link
    ? memberNamed(matched.subject, link)
    : null;
}

/** The name of the member the link's steps reach, spelled as the link says. */
function memberNamed(subject: CallOps, link: ContainerMember): string | null {
  const name = walk([subject], link.of)[0]?.method() ?? null;
  return name === null || name === ""
    ? null
    : SPELLED[link.naming ?? "asWritten"](name);
}

const SPELLED: Record<Naming, (name: string) => string> = {
  asWritten: (name) => name,
  upperFirst: (name) => name.slice(0, 1).toUpperCase() + name.slice(1),
};

type Interaction = Extract<Effect, { type: "interaction" }>;

/** An effect that records one storage access. */
type StorageAccessEffect = Interaction & {
  interaction: Extract<Interaction["interaction"], { class: "storage-access" }>;
};

/** One access through a relation, recorded the way the container's own access is. */
function relatedEffect(
  own: StorageAccessEffect,
  related: RelatedAccess,
): Effect {
  return {
    type: "interaction",
    binding: own.binding,
    callee: own.callee,
    interaction: {
      class: "storage-access",
      kind: related.kind,
      fields: [...related.fields],
      operation: related.operation ?? own.interaction.operation,
      ...(related.selector !== undefined && related.selector.length > 0
        ? { selector: [...related.selector] }
        : {}),
      relationPath: [...related.path],
      ...(related.relationKey === true ? { relationKey: true } : {}),
    },
  };
}

function accessEffect(
  matched: Matched,
  access: Access,
  stated: StatedValues,
): { effect: StorageAccessEffect; container: string | null } | null {
  const { ops, subject, method, chain, recognition } = matched;
  const meaning = matched.meaning as StorageMethod;
  const ending = chain.ending as StorageEnding;
  const { input, kind, unsettled } = access;
  const declared: SlotsLink | null = linkIn(chain, "slots");
  // A chain that declares its slots has no use for what its rules read.
  const recordsReads = ops.statesSlots !== undefined && declared === null;
  const selectorRead: ReadValues | null = recordsReads ? new Map() : null;
  const fieldsRead: ReadValues | null = recordsReads ? new Map() : null;
  const selector = namesFor(
    meaning.selector,
    subject,
    stated,
    unsettled,
    selectorRead,
  );
  const fields = namesFor(
    meaning.fields,
    subject,
    stated,
    unsettled,
    fieldsRead,
  );
  const address = addressOf(matched, access, selector, stated.container);
  if (address === null) {
    return null;
  }

  const effect: StorageAccessEffect = {
    type: "interaction",
    binding: storageBinding({
      recognition,
      storageSystem: systemOf(ending.system, ops),
      ...(ending.transport === undefined
        ? {}
        : { transport: ending.transport }),
      scope: address.scope,
      container: address.container,
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
  const slots =
    declared === null
      ? [
          ...slotsRead("selector", selector, selectorRead),
          ...slotsRead("field", fields, fieldsRead),
        ]
      : slotsHeard(ops, declared, input ?? subject.valueAt(0), {
          selector,
          fields,
          kind,
        });
  if (slots.length > 0) {
    ops.statesSlots?.(effect, slots);
  }
  return { effect, container: address.container };
}

/** The slots a chain declares, read off the call only when somebody listens. */
function slotsHeard(
  ops: CallOps,
  declared: SlotsLink,
  input: ValueOps | null,
  columns: SlotColumns,
): StatedSlot[] {
  if (ops.statesSlots === undefined) {
    return [];
  }
  return slotsDeclared(input, declared.says, columns);
}

/**
 * The values a pack's rule read, by the entry or property name it read
 * each one under. A column the rule reported is given every value it
 * read under that name, which is how a slot finds its value without the
 * pack saying anything more than the names.
 */
type ReadValues = Map<string, ValueOps[]>;

function slotsRead(
  slot: StatedSlot["slot"],
  names: readonly string[],
  read: ReadValues | null,
): StatedSlot[] {
  if (read === null) {
    return [];
  }
  return [...new Set(names)].flatMap((name) =>
    (read.get(name) ?? []).map((value) => ({ slot, name, value })),
  );
}

function noteRead(read: ReadValues, name: string, value: ValueOps): void {
  const already = read.get(name);
  if (already === undefined) {
    read.set(name, [value]);
    return;
  }
  if (!already.includes(value)) {
    already.push(value);
  }
}

/**
 * The same value, noting every entry and property a rule reads off it.
 * An optional member the value has is passed through, and one it lacks
 * stays missing, so a rule sees the same ops it would see unwatched.
 */
function recording(value: ValueOps, read: ReadValues): ValueOps {
  const watchedValue = (inside: ValueOps | null): ValueOps | null =>
    inside === null ? null : recording(inside, read);
  return {
    text: () => value.text(),
    name: (unsettled) => value.name(unsettled),
    flag: () => value.flag(),
    entries: (unsettled) =>
      value.entries(unsettled).map((entry) => {
        if (entry.key !== null) {
          noteRead(read, entry.key, entry.value);
        }
        return { key: entry.key, value: recording(entry.value, read) };
      }),
    items: () => value.items().map((item) => recording(item, read)),
    property: (name) => {
      const inside = value.property(name);
      if (inside === null) {
        return null;
      }
      noteRead(read, name, inside);
      return recording(inside, read);
    },
    asArg: () => value.asArg(),
    parts: () => value.parts(),
    holes: () => value.holes(),
    ...optionalMember(
      value,
      "names",
      (cap: number) => value.names?.(cap) ?? null,
    ),
    ...optionalMember(
      value,
      "interpolated",
      () => value.interpolated?.() ?? [],
    ),
    ...optionalMember(value, "evaluated", () => value.evaluated?.() ?? null),
    ...optionalMember(value, "object", () =>
      watchedValue(value.object?.() ?? null),
    ),
    ...optionalMember(value, "function", () =>
      watchedValue(value.function?.() ?? null),
    ),
    ...optionalMember(value, "source", () => value.source?.() ?? ""),
    ...optionalMember(value, "form", () => value.form?.() ?? "other"),
    ...optionalMember(value, "ownProperty", (name: string) => {
      const inside = value.ownProperty?.(name) ?? null;
      if (inside === null) {
        return null;
      }
      noteRead(read, name, inside);
      return recording(inside, read);
    }),
    ...optionalMember(
      value,
      "importedFrom",
      () => value.importedFrom?.() ?? null,
    ),
    ...optionalMember(value, "shape", () => value.shape?.() ?? null),
    ...optionalMember(value, "encoded", () => {
      const found = value.encoded?.() ?? null;
      return found === null
        ? null
        : { codec: found.codec, value: recording(found.value, read) };
    }),
  };
}

/** The optional members of `ValueOps`, which an adapter may leave out. */
type OptionalValueMember = {
  [K in keyof ValueOps]-?: undefined extends ValueOps[K] ? K : never;
}[keyof ValueOps];

/** `{ [member]: reads }` when the value has that member, and nothing when it does not. */
function optionalMember<K extends OptionalValueMember>(
  value: ValueOps,
  member: K,
  reads: NonNullable<ValueOps[K]>,
): Partial<Pick<ValueOps, K>> {
  return value[member] === undefined
    ? {}
    : ({ [member]: reads } as Partial<Pick<ValueOps, K>>);
}

/** A rule's inputs, noting what the rule reads when somebody listens. */
function watched(inputs: StatedInputs, read: ReadValues | null): StatedInputs {
  if (read === null) {
    return inputs;
  }
  return {
    ...inputs,
    input: recording(inputs.input, read),
    entry: inputs.entry === null ? null : recording(inputs.entry, read),
  };
}

/**
 * The containers the call reached. A call that states a map of them
 * reached one per entry, and every other call reached the single
 * container the container link picks out.
 */
function reachedBy(
  chain: Chain<MethodMeaning>,
  subject: CallOps,
  unsettled: UnsettledName,
): Reached[] {
  const link: ContainersLink | null = linkIn(chain, "containers");
  const alone: Reached[] = [{ container: null, entry: null, stated: false }];
  const stated = link === null ? null : statedValue(subject, link.in);
  if (link === null || stated === null) {
    return alone;
  }
  if (link.each === "name") {
    const named = stated.items().map((item) => ({
      container: item.name(unsettled),
      entry: null,
      stated: true,
    }));
    // A list this run cannot read is still a call against the store.
    // Dropping it would make a unit that reads look like one that does not.
    return named.length === 0 ? alone : named;
  }
  return stated.entries(unsettled).map((entry) => ({
    container: entry.key,
    entry: entry.value,
    stated: true,
  }));
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
  chain: Chain<MethodMeaning>,
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
  if ("of" in link) {
    return memberNamed(subject, link);
  }
  return namesAt(subject, link.argument, unsettled)[0] ?? null;
}

/** Which way into the container the call took, when the chain says where. */
function accessPathOf(
  chain: Chain<MethodMeaning>,
  subject: CallOps,
  unsettled: UnsettledName,
): string | null {
  const link: AccessPathLink | null = linkIn(chain, "accessPath");
  return link === null
    ? null
    : (namesAt(subject, link.argument, unsettled)[0] ?? null);
}

/** Which namespace the call reached, when a scope link picks the argument. */
function scopeOf(
  chain: Chain<MethodMeaning>,
  subject: CallOps,
  unsettled: UnsettledName,
): string | null {
  const link: ScopeLink | null = linkIn(chain, "scope");
  return link === null
    ? null
    : (namesAt(subject, link.argument, unsettled)[0] ?? null);
}

/** The value the call states where a pick points, or null for none. */
function statedValue(subject: CallOps, pick: OneArgument): ValueOps | null {
  for (const ops of walk([subject], pick.of ?? [])) {
    const stated = pickedIn(ops, pick, pick.at);
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

/**
 * What a call passed nowhere. A rule pointed at an argument the call
 * left out still runs, because only the pack knows what leaving it out
 * means: a Mongoose read with no projection reads every field there is.
 */
const NOTHING_STATED: ValueOps = {
  text: () => null,
  name: () => null,
  asArg: () => null,
  flag: () => null,
  entries: () => [],
  items: () => [],
  property: () => null,
  parts: () => null,
  holes: () => [],
};

/** What the call reached, by the argument it picks or by the pack's rule. */
function namesFor(
  says: StorageMethod["selector"],
  subject: CallOps,
  stated: StatedValues,
  unsettled: UnsettledName,
  read: ReadValues | null = null,
): string[] {
  if (says === undefined) {
    return [];
  }
  if (Array.isArray(says)) {
    return [...(says as readonly string[])];
  }
  if (typeof says === "function") {
    const input = stated.input;
    return input === null ? [] : [...says(watched({ ...stated, input }, read))];
  }
  if ("selectorParam" in says) {
    return [...(subject.parameterReadsAt?.(says.selectorParam) ?? [])];
  }
  const pointed = says as ArgumentPick | StatedRule;
  if (!("by" in pointed)) {
    return namesAt(subject, pointed, unsettled);
  }
  const input = statedValue(subject, pointed.of) ?? NOTHING_STATED;
  return [...pointed.by(watched({ ...stated, input }, read))];
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

/**
 * The value a pick points at in one call: under its keyword when the call
 * passes one there, else at `index`, then down its path.
 */
function pickedIn(
  ops: CallOps,
  pick: ArgumentPick,
  index: number,
): ValueOps | null {
  const keyword = "keyword" in pick ? pick.keyword : undefined;
  const passed =
    (keyword === undefined ? null : (ops.keywordAt?.(keyword) ?? null)) ??
    ops.valueAt(index);
  let at = passed;
  for (const key of ("path" in pick ? pick.path : undefined) ?? []) {
    at = at?.property(key) ?? null;
  }
  return at;
}

/** Whether a pick reads past the plain argument, so only the value ops can follow it. */
function readsPastArgument(pick: ArgumentPick): boolean {
  return (
    "at" in pick && (pick.keyword !== undefined || pick.path !== undefined)
  );
}

/** What one argument says: the argument itself, or a property inside it. */
function nameOf(
  ops: CallOps,
  pick: ArgumentPick,
  index: number,
  unsettled: UnsettledName,
): string | null {
  if (readsPastArgument(pick)) {
    const value = pickedIn(ops, pick, index);
    return value === null ? null : nameIn(value, pick.property, unsettled);
  }
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

/** The name a value gives, or the first of its properties that gives one. */
function nameIn(
  value: ValueOps,
  properties: readonly string[] | undefined,
  unsettled: UnsettledName,
): string | null {
  if (properties === undefined) {
    return value.name(unsettled);
  }
  for (const property of properties) {
    const name = value.property(property)?.name(unsettled) ?? null;
    if (name !== null) {
      return name;
    }
  }
  return null;
}

/**
 * One effect per message the call sends.
 *
 * A library either takes the message as the call's input or takes a
 * collection of them under a property, and the ending says which. The
 * channel is read off each message, so a batch of sends to different
 * queues records one effect per queue.
 */
function messageSend(matched: Matched): Effect[] | null {
  const { ops, subject, chain, recognition } = matched;
  const ending = chain.ending as MessageSendEnding;
  const input = inputOf(matched, ending);
  if (input === null) {
    return null;
  }

  // A batch whose messages this run cannot read is still a send. Record
  // it once, with only the channel parts on the input, so a service that
  // sends never looks like one that sends nothing.
  const messages = messagesIn(input, ending.messages);
  const sent = messages.length === 0 ? [NOTHING_STATED] : messages;
  const effects: Effect[] = [];
  for (const message of sent) {
    const sending = { message, input, subject, ending };
    for (const channel of channelsOf(sending)) {
      effects.push({
        type: "interaction",
        binding: messageBusBinding({
          recognition,
          messageBus: ending.wire,
          channel,
        }),
        callee: ops.calleeText(),
        interaction: {
          class: "message-send",
          ...bodyOf(sending),
          ...routingKeyOf(sending),
        },
      });
    }
  }
  return effects;
}

/**
 * The value the call states its messages in. A call whose own arguments
 * are the message states no such value, so nothing is read off one.
 */
function inputOf(matched: Matched, ending: MessageSendEnding): ValueOps | null {
  const { input } = matched.meaning as MessageSendMethod;
  if (input === undefined) {
    return ending.messages.each === "theCall" ? NOTHING_STATED : null;
  }
  return statedValue(matched.subject, input);
}

/** One reading per way a library takes the messages a call sends. */
const MESSAGES_IN: Record<
  MessageLocation["each"],
  (input: ValueOps, location: MessageLocation) => readonly ValueOps[]
> = {
  theInput: (input) => [input],
  in: (input, location) =>
    input.property((location as ManyIn).property)?.items() ?? [],
  inTheInput: (input) => input.items(),
  theCall: (input) => [input],
};

/** Each message the call sends, however the library takes them. */
function messagesIn(
  input: ValueOps,
  location: MessageLocation,
): readonly ValueOps[] {
  return MESSAGES_IN[location.each](input, location);
}

/**
 * How many channels one message may go to. A part the source limits to
 * a few strings sends the message once per string, and two such parts
 * multiply. Past this many, the message is read as the one channel it
 * would be if no part had been spelled out string by string.
 */
const CHANNEL_CAP = 16;

/** One message, the call input it was sent with, and the call itself. */
interface Sending {
  readonly message: ValueOps;
  readonly input: ValueOps;
  readonly subject: CallOps;
  readonly ending: MessageSendEnding;
}

/**
 * Whether a written part is read as every string it can be, or as the
 * one name it states.
 */
type PartReading = "everyString" | "oneName";

function oneName(
  written: ValueOps,
  unsettled: UnsettledName,
): readonly string[] | null {
  const stated = written.name(unsettled);
  return stated === null || stated === "" ? null : [stated];
}

/**
 * `` `record.${op}` `` with `op` typed `"a" | "b"` is two strings, so
 * the send is two sends. A value that is only ever one string, or that
 * could be anything, is read as one name.
 */
function everyString(
  written: ValueOps,
  unsettled: UnsettledName,
): readonly string[] | null {
  const each = written.names?.(CHANNEL_CAP) ?? null;
  if (each === null || each.length < 2 || each.includes("")) {
    return oneName(written, unsettled);
  }
  return each;
}

/** Every channel one message goes to, one per string a part can be. */
function channelsOf(sending: Sending): readonly (string | null)[] {
  const each = channelsRead(sending, "everyString");
  return each.length > CHANNEL_CAP ? channelsRead(sending, "oneName") : each;
}

/**
 * The channels one message states, or a lone null when the source
 * leaves a part of it unsaid. A channel spelled by half of itself would
 * pair across wires, so a message missing a part records the send with
 * nothing claimed about where it went.
 */
function channelsRead(
  sending: Sending,
  read: PartReading,
): readonly (string | null)[] {
  const separator = sending.ending.channelSeparator ?? "#";
  let channels: readonly string[] | null = null;
  for (const part of sending.ending.channel) {
    const values = partValues(part, sending, read);
    if (values === null) {
      return [null];
    }
    channels =
      channels === null ? values : crossed(channels, values, separator);
  }
  return channels ?? [""];
}

/** Each head followed by each value. */
function crossed(
  heads: readonly string[],
  values: readonly string[],
  separator: string,
): readonly string[] {
  return heads.flatMap((head) =>
    values.map((value) => `${head}${separator}${value}`),
  );
}

/**
 * The strings one part of a channel can be, or null when it is unsaid.
 *
 * A part that is absent and a part that is written but unsettled mean
 * different things. When the part is absent the library fills it in,
 * and `whenAbsent` gives that value. When it is written but unsettled,
 * the code set it somewhere this run cannot read, and using the
 * library's default would put the send on a channel it never goes to.
 */
function partValues(
  part: ChannelPart,
  sending: Sending,
  read: PartReading,
): readonly string[] | null {
  const unsettled = part.unsettled ?? sending.ending.unsettledName;
  if ("argument" in part) {
    const stated = statedValue(sending.subject, part.argument);
    return stated === null ? null : READ_PART[read](stated, unsettled);
  }
  const holder = part.on === "theInput" ? sending.input : sending.message;
  const written = firstWritten(holder, part.property);
  if (written === null) {
    return part.whenAbsent === undefined ? null : [part.whenAbsent];
  }
  return READ_PART[read](written, unsettled);
}

const READ_PART: Record<
  PartReading,
  (written: ValueOps, unsettled: UnsettledName) => readonly string[] | null
> = {
  everyString,
  oneName,
};

/**
 * The first of these properties the message wrote. Trying them in order
 * means the pack decides which spelling wins when a message writes two
 * of them, whatever order the source wrote them in.
 */
function firstWritten(
  holder: ValueOps,
  properties: readonly string[],
): ValueOps | null {
  for (const property of properties) {
    const written = holder.property(property);
    if (written !== null) {
      return written;
    }
  }
  return null;
}

/**
 * The body a message states, in the form an effect records an argument,
 * so the field set a consumer reads pairs against it.
 */
function bodyOf(sending: Sending): { body?: EffectArg } {
  const stated = decodedArg(bodyWritten(sending));
  return stated === null ? {} : { body: stated };
}

/**
 * A value as an effect argument, read as what went into it when the
 * source encodes it. A consumer reads the fields of `JSON.stringify({...})`
 * back after `JSON.parse`, so the object is what pairs.
 */
function decodedArg(written: ValueOps | null): EffectArg | null {
  if (written === null) {
    return null;
  }
  return (written.encoded?.()?.value ?? written).asArg();
}

/** Where the body is: a property of the message, the message, or an argument of the call. */
function bodyWritten({ message, subject, ending }: Sending): ValueOps | null {
  const where = ending.body;
  if (where === undefined) {
    return null;
  }
  if (typeof where === "string") {
    return message.property(where);
  }
  return "argument" in where ? statedValue(subject, where.argument) : message;
}

/**
 * The routing key a send states, when it states one as a literal: on
 * the message, or as an argument of the call.
 */
function routingKeyOf({ message, subject, ending }: Sending): {
  routingKey?: string;
} {
  const where = ending.routingKey;
  if (where === undefined) {
    return {};
  }
  const written =
    typeof where === "string"
      ? message.property(where)
      : statedValue(subject, where);
  const stated = written?.text() ?? null;
  return stated === null || stated === "" ? {} : { routingKey: stated };
}

/**
 * One effect for the unit a call invokes.
 *
 * A call reaches one callee however much it hands over, so this yields
 * a single effect and reads the name off the call's own request object.
 * A call whose request this run cannot read does not match. A call that
 * states a name nothing settles is recorded with no name, so a service
 * that invokes never looks like one that invokes nothing.
 */
function unitInvoke(matched: Matched): Effect[] | null {
  const { ops, subject, chain, recognition } = matched;
  const ending = chain.ending as UnitInvokeEnding;
  const input = statedValue(
    subject,
    (matched.meaning as UnitInvokeMethod).input,
  );
  if (input === null) {
    return null;
  }
  return [
    {
      type: "interaction",
      binding: unitInvocationBinding({
        recognition,
        deploymentTarget: ending.platform,
        instanceName: invokedUnitIn(input, ending),
      }),
      callee: ops.calleeText(),
      interaction: {
        class: "unit-invoke",
        ...payloadOf(input, ending),
      },
    },
  ];
}

/** The unit a call states, reduced from whatever id it was written as. */
function invokedUnitIn(
  input: ValueOps,
  ending: UnitInvokeEnding,
): string | null {
  for (const property of ending.named) {
    const stated = input.property(property)?.name(ending.unsettledName) ?? null;
    if (stated !== null && stated !== "") {
      return resourceNameIn(stated);
    }
  }
  return null;
}

/** The payload a call hands over, in the form an effect records an argument. */
function payloadOf(
  input: ValueOps,
  ending: UnitInvokeEnding,
): { payload?: EffectArg } {
  if (ending.payload === undefined) {
    return {};
  }
  const stated = decodedArg(input.property(ending.payload));
  return stated === null ? {} : { payload: stated };
}

/**
 * Every table the statement touches, as one effect each.
 *
 * The kind, the fields and the selector come from the parse, so the
 * method table is read only to find where the call put the statement.
 * A statement the parser cannot read yields nothing, and the call goes
 * unrecorded instead of recorded with a guessed kind.
 */
function sqlAccess(matched: Matched): Effect[] | null {
  const { ops, subject, method, chain, recognition } = matched;
  const ending = chain.ending as SqlEnding;
  const stated = statementIn(subject, (matched.meaning as SqlMethod).statement);
  if (stated === null) {
    return null;
  }
  const statement = sqlFromParts(
    stated.parts,
    namesInHoles(chain, stated.value),
    settledHoles(stated.value),
  );
  const accesses = readSqlAccess(statement, {
    dialect: systemOf(ending.dialect, ops),
    placeholders: ops.statesSlots !== undefined,
  });
  if (accesses.length === 0) {
    return null;
  }
  const values = placeholderValues(
    stated,
    subject,
    (matched.meaning as SqlMethod).parameters,
  );
  const system = systemOf(ending.system, ops);
  return accesses.map((access) => {
    const effect: Effect = {
      type: "interaction",
      binding: storageBinding({
        recognition,
        storageSystem: system,
        ...(ending.transport === undefined
          ? {}
          : { transport: ending.transport }),
        // A statement that qualifies its table says which namespace
        // the access is in, and the pack's own scope is the fallback
        // for a statement that leaves it out.
        scope: access.qualifier[access.qualifier.length - 1] ?? ending.scope,
        container: access.table,
      }),
      callee: ops.calleeText(),
      interaction: {
        class: "storage-access",
        kind: access.kind,
        fields: access.fields,
        operation: method,
        ...(access.selector.length > 0 ? { selector: access.selector } : {}),
      },
    };
    const slots = (access.placeholders ?? []).flatMap((one) => {
      const value = placeholderValue(values, one.placeholder);
      return value === null
        ? []
        : [{ slot: SLOT_OF[one.clause], name: one.field, value }];
    });
    if (slots.length > 0) {
      ops.statesSlots?.(effect, slots);
    }
    return effect;
  });
}

const SLOT_OF: Record<SqlPlaceholder["clause"], StatedSlot["slot"]> = {
  fields: "field",
  selector: "selector",
};

/**
 * The value the call passes for each placeholder. A template's holes are
 * numbered in order, unless its text writes placeholders of its own, as
 * `` `SELECT id FROM ${USERS} WHERE id = $1` `` does. Those, and every
 * placeholder in plain text, take their values from where the method
 * says the call puts them.
 */
function placeholderValues(
  stated: Statement,
  subject: CallOps,
  says: SqlMethod["parameters"],
): PlaceholderValues {
  const writesItsOwn = stated.parts.some((part) => /\$\d/.test(part));
  if (stated.parts.length > 1 && !writesItsOwn) {
    return { numbered: stated.value.interpolated?.() ?? [], named: null };
  }
  const picks = says === undefined ? [] : Array.isArray(says) ? says : [says];
  const given = picks
    .map((pick) => statedValue(subject, pick as OneArgument))
    .find((value): value is ValueOps => value !== null);
  return given === undefined
    ? { numbered: [], named: null }
    : { numbered: given.items(), named: given };
}

/** The values a statement's `$n` placeholders take, and the object its `:name` ones read. */
interface PlaceholderValues {
  numbered: readonly ValueOps[];
  named: ValueOps | null;
}

function placeholderValue(
  values: PlaceholderValues,
  placeholder: number | string,
): ValueOps | null {
  if (typeof placeholder === "number") {
    return values.numbered[placeholder - 1] ?? null;
  }
  return values.named?.property(placeholder) ?? null;
}

/** The statement one of a method's picks reaches, in the pieces it was written in. */
interface Statement {
  readonly value: ValueOps;
  readonly parts: readonly string[];
}

/**
 * The first of a method's picks that reaches text. A pick that lands on
 * something with no text means the call was written the other way, so
 * the next pick is tried.
 */
function statementIn(
  subject: CallOps,
  says: SqlMethod["statement"],
): Statement | null {
  const picks = Array.isArray(says) ? says : [says as OneArgument];
  for (const pick of picks) {
    const value = statedValue(subject, pick);
    const parts = value?.parts() ?? null;
    if (value !== null && parts !== null) {
      return { value, parts };
    }
  }
  return null;
}

/**
 * What the source itself settled each hole to. A table kept in a module
 * constant reads here, and `@suss/sql` uses it only where the statement
 * quoted the hole as a name.
 */
function settledHoles(stated: ValueOps): (string | null)[] {
  return (stated.interpolated?.() ?? []).map((hole) => hole.name("nothing"));
}

/**
 * The table name each hole in the statement gives, in source order. A
 * chain without an interpolates link leaves every hole as a parameter,
 * the same as any interpolated value.
 */
function namesInHoles(
  chain: Chain<MethodMeaning>,
  stated: ValueOps,
): (string | null)[] {
  const link: InterpolatesLink | null = linkIn(chain, "interpolates");
  if (link === null) {
    return [];
  }
  return stated.holes().map((hole) => nameInHole(hole, link));
}

/** The name one hole gives, or null for a hole the pack does not read. */
function nameInHole(
  hole: CallOps | null,
  link: InterpolatesLink,
): string | null {
  if (hole === null || (link.from !== undefined && !hole.isFrom(link.from))) {
    return null;
  }
  return namesAt(hole, link.named, "nothing")[0] ?? null;
}
