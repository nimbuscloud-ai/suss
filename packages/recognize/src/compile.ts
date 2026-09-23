/**
 * Turns a chain into the recognizer hook the adapters already call.
 *
 * Every link is a guard, and the compiled hook checks the cheapest one
 * first. Looking a method up in a table costs nothing, while following
 * a receiver to the library that made it walks declarations. So the
 * hook ignores the order the pack declared its links in. A link that
 * changes what the receiver is, as a Prisma model property would, needs
 * declared order back, and that change goes here.
 *
 * A chain that states a subject asks its questions of a call next to
 * the one in hand, and the walk to that call is also here. DESIGN.md
 * describes what each step reaches and why the walk is bounded.
 */

import {
  messageBusBinding,
  resourceNameIn,
  storageBinding,
  unitInvocationBinding,
} from "@suss/behavioral-ir";
import { unwrapJsonStringify } from "@suss/extractor";
import { readSqlAccess, sqlFromParts } from "@suss/sql";

import { opsIn } from "./ops.js";

import type { Effect } from "@suss/behavioral-ir";
import type { EffectArg, InvocationRecognizer } from "@suss/extractor";
import type {
  AccessKind,
  AccessPathLink,
  ArgumentPick,
  CallStep,
  Chain,
  ChannelPart,
  ContainerLink,
  ContainersLink,
  Ending,
  InputLink,
  InterpolatesLink,
  KindAsAsked,
  Link,
  MatchStart,
  MessageLocation,
  MessageSendEnding,
  MessageSendMethod,
  MethodMeaning,
  MethodsLink,
  OneArgument,
  ScopeLink,
  SqlEnding,
  SqlMethod,
  StatedInputs,
  StatedRule,
  StorageEnding,
  StorageMethod,
  SubjectLink,
  ToArgument,
  ToReceiver,
  UnitInvokeEnding,
  UnitInvokeMethod,
} from "./chain.js";
import type {
  CallOps,
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
}

/** A chain, as the hook the adapter dispatches to on every call. */
export function compile(
  chain: Chain<MethodMeaning>,
  recognition: string,
): InvocationRecognizer {
  return (_call: unknown, ctx: unknown): Effect[] | null => {
    const ops = opsIn(ctx);
    if (ops === null) {
      return null;
    }

    const bare = bareCall(chain, ops);
    if (bare !== null) {
      return YIELD[chain.ending.yields]({
        ops,
        subject: ops,
        method: bare.method,
        meaning: bare.meaning,
        chain,
        recognition,
      });
    }

    const methods = methodsIn(chain);
    if (methods === null) {
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
 * applies. The call matches only when its callee is a bound name whose
 * written value came from the chain's origin.
 */
function bareCall(
  chain: Chain<MethodMeaning>,
  ops: CallOps,
): { method: string; meaning: MethodMeaning } | null {
  const link = linkIn(chain, "calls");
  const start = linkIn(chain, "start");
  if (link === null || start === null || start.at.starts !== "receiver") {
    return null;
  }
  if (ops.method() !== null || ops.namedCallee?.() !== true) {
    return null;
  }
  const written = ops.callee();
  if (written === null || !written.isFrom(start.at.origin)) {
    return null;
  }
  return { method: ops.calleeText(), meaning: link.meaning };
}

/** The methods link, which every chain that recognizes calls states. */
function methodsIn(
  chain: Chain<MethodMeaning>,
): MethodsLink<MethodMeaning> | null {
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
  link: MethodsLink<MethodMeaning>,
  method: string,
): MethodMeaning | null {
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
function subjectsOf(chain: Chain<MethodMeaning>, ops: CallOps): CallOps[] {
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
};

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
  return reachedBy(chain, subject, unsettled).map((reached) =>
    accessEffect(matched, { input, kind, reached, unsettled }),
  );
}

function accessEffect(matched: Matched, access: Access): Effect {
  const { ops, subject, method, chain, recognition } = matched;
  const meaning = matched.meaning as StorageMethod;
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
      scope: scopeOf(chain, subject, unsettled) ?? ending.scope,
      container: reached.stated
        ? reached.container
        : containerOf(chain, selector, subject, unsettled),
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
  stated: Omit<StatedInputs, "input"> & { input: ValueOps | null },
  unsettled: UnsettledName,
): string[] {
  if (says === undefined) {
    return [];
  }
  if (Array.isArray(says)) {
    return [...(says as readonly string[])];
  }
  if (typeof says === "function") {
    const input = stated.input;
    return input === null ? [] : [...says({ ...stated, input })];
  }
  if ("selectorParam" in says) {
    return [...(subject.parameterReadsAt?.(says.selectorParam) ?? [])];
  }
  const pointed = says as ArgumentPick | StatedRule;
  if (!("by" in pointed)) {
    return namesAt(subject, pointed, unsettled);
  }
  const input = statedValue(subject, pointed.of) ?? NOTHING_STATED;
  return [...pointed.by({ ...stated, input })];
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
  const input = statedValue(
    subject,
    (matched.meaning as MessageSendMethod).input,
  );
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
    const channels = channelsOf({ message, input, ending });
    for (const channel of channels) {
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
          ...bodyOf(message, ending),
          ...routingKeyOf(message, ending),
        },
      });
    }
  }
  return effects;
}

/** Each message the call sends, however the library takes them. */
function messagesIn(
  input: ValueOps,
  location: MessageLocation,
): readonly ValueOps[] {
  if (location.each === "theInput") {
    return [input];
  }
  const collection = input.property(location.property);
  return collection === null ? [] : collection.items();
}

/**
 * How many channels one message may go to. A part the source limits to
 * a few strings sends the message once per string, and two such parts
 * multiply. Past this many, the message is read as the one channel it
 * would be if no part had been spelled out string by string.
 */
const CHANNEL_CAP = 16;

/** One message and the call input it was sent with, to read its channel from. */
interface Sending {
  readonly message: ValueOps;
  readonly input: ValueOps;
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
  const holder = part.on === "theInput" ? sending.input : sending.message;
  const written = firstWritten(holder, part.property);
  if (written === null) {
    return part.whenAbsent === undefined ? null : [part.whenAbsent];
  }
  const unsettled = part.unsettled ?? sending.ending.unsettledName;
  return read === "everyString"
    ? everyString(written, unsettled)
    : oneName(written, unsettled);
}

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
 * so the field set a consumer reads pairs against it. A payload written
 * as `JSON.stringify({...})` is recorded as the object that went in,
 * since the consumer reads the fields back after `JSON.parse`.
 */
function bodyOf(
  message: ValueOps,
  ending: MessageSendEnding,
): { body?: EffectArg } {
  if (ending.body === undefined) {
    return {};
  }
  const stated = unwrapJsonStringify(
    message.property(ending.body)?.asArg() ?? null,
  );
  return stated === null ? {} : { body: stated };
}

/** The routing key a message states, when it states one as a literal. */
function routingKeyOf(
  message: ValueOps,
  ending: MessageSendEnding,
): { routingKey?: string } {
  if (ending.routingKey === undefined) {
    return {};
  }
  const stated = message.property(ending.routingKey)?.text() ?? null;
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
  const stated = unwrapJsonStringify(
    input.property(ending.payload)?.asArg() ?? null,
  );
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
  const accesses = readSqlAccess(statement, { dialect: ending.dialect });
  return accesses.length === 0
    ? null
    : accesses.map((access) => ({
        type: "interaction",
        binding: storageBinding({
          recognition,
          storageSystem: ending.system,
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
          ...(access.selector.length > 0 ? { selector: access.selector } : {}),
          operation: method,
        },
      }));
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
