/**
 * `CallOps` and `ValueOps` answered from the facts an adapter states, so
 * a declared pack runs on any adapter that states them.
 *
 * Which call, which argument, which receiver, which property of an
 * object, which entry of a list and which piece of a template all come
 * from the facts the resolution rules read. What a leaf value is (its
 * literal, the name it gives, the effect argument it becomes) comes from
 * the adapter through `FactSource`, since each language reads its own
 * literals. So does what an import resolves to, and the one question a
 * type checker settles, whether a library declared a method.
 *
 * DESIGN.md, under "The ops over the facts", has the fact behind each member.
 */

import { byOrigin, lastValueWins } from "@suss/extractor";
import {
  boundByImport,
  classMemberName,
  classMemberOf,
  fileOfKey,
} from "@suss/resolution";

import { factReadOps } from "./factReadOps.js";

import type { Effect, TypeShape } from "@suss/behavioral-ir";
import type {
  ByOrigin,
  CallOps,
  ClassValueOps,
  ConstructedFrom,
  DeclaredBy,
  EffectArg,
  Encoded,
  FactSource,
  Global,
  HandedBy,
  Imported,
  Inheriting,
  Inherits,
  Loop,
  MarkedFunction,
  ModuleMember,
  ModuleMemberName,
  ModuleOps,
  PairArg,
  ReadOff,
  ReceiverOrigin,
  ReturnedBy,
  StatedSlot,
  Typed,
  UnsettledName,
  ValueEntry,
  ValueForm,
  ValueOps,
} from "@suss/extractor";

export { factReadOps };

export type { FactRows, FactSource } from "@suss/extractor";

/** The ops for the call at `key`, or null when no call is stated there. */
export function factCallOps(key: string, source: FactSource): CallOps | null {
  source.read(key);
  const callee = only(source.db.lookup("call", 0, key), 1);
  if (callee === null) {
    return null;
  }
  const ops = new FactCall(key, callee, source);
  return source.extend?.(key, ops) ?? ops;
}

/** The ops for the value at `key`. */
export function factValueOps(key: string, source: FactSource): ValueOps {
  const value = new FactValue(key, source);
  const ops = source.extendValue?.(key, value) ?? value;
  keysOfValues.set(ops, key);
  return ops;
}

/** The key each value the ops handed out was read at, so one value can be compared with another. */
const keysOfValues = new WeakMap<ValueOps, string>();

/** One column a hook stated a value for, and the key the value was read at. */
export interface HeardSlot {
  readonly slot: StatedSlot["slot"];
  readonly name: string;
  /** Null for a value these ops did not hand out. */
  readonly key: string | null;
}

/**
 * The slots the hooks state about the effects they build from one call,
 * kept until the adapter knows which effect it records for each. A value
 * comes back as its key, since a name in Python or Ruby has a key and no
 * node, and a source walk starts from the key.
 */
export class SlotsHeard {
  private readonly byEffect = new Map<Effect, HeardSlot[]>();

  /** What the ops of the call in hand take as `statesSlots`. */
  readonly listen = (effect: Effect, slots: readonly StatedSlot[]): void => {
    const already = this.byEffect.get(effect) ?? [];
    for (const one of slots) {
      const key = keysOfValues.get(one.value) ?? null;
      already.push({ slot: one.slot, name: one.name, key });
    }
    this.byEffect.set(effect, already);
  };

  /** The slots stated about one effect a hook returned. */
  of(effect: Effect): readonly HeardSlot[] {
    return this.byEffect.get(effect) ?? [];
  }
}

class FactCall implements CallOps {
  private readonly calleeRead: { object: string; name: string } | null;
  private args: Map<number, string> | null = null;

  constructor(
    private readonly key: string,
    private readonly calleeKey: string,
    private readonly source: FactSource,
  ) {
    source.read(calleeKey);
    this.calleeRead = memberRead(calleeKey, source);
  }

  method(): string | null {
    return this.calleeRead?.name ?? null;
  }

  calleeText(): string {
    return this.source.textOf(this.calleeKey);
  }

  argumentCount(): number {
    const stated = this.arguments();
    const counted = only(this.source.db.lookup("callArgCount", 0, this.key), 1);
    return Math.max(stated.size, counted === null ? 0 : Number(counted));
  }

  nameAt(index: number, unsettled: UnsettledName): string | null {
    const argument = this.arguments().get(index);
    return argument === undefined
      ? null
      : this.source.nameOf(argument, unsettled);
  }

  receiver(): CallOps | null {
    if (this.calleeRead === null) {
      return null;
    }
    const made = madeThroughProjectCall(
      settled(this.calleeRead.object, this.source, "namesAndFields"),
      this.source,
    );
    return factCallOps(made, this.source);
  }

  site(): string {
    return this.key;
  }

  /**
   * The call whose callee reads a method off what this call returns, as
   * `.set(v)` does off `db.update(t)`. It is one hop of the
   * `chainedCall` rule, and a result stored in a name first has none.
   */
  chainedOn(): CallOps | null {
    const { db } = this.source;
    const outer = only(
      db
        .lookup("readsProperty", 1, this.key)
        .flatMap((read) => db.lookup("call", 1, String(read[0]))),
      0,
    );
    return outer === null ? null : factCallOps(outer, this.source);
  }

  /**
   * The member read the receiver is, as ops whose callee is that read. A
   * name set to one first counts as that read.
   */
  member(): CallOps | null {
    const key = this.memberKey();
    return key === null ? null : memberOpsAt(key, this.source);
  }

  /**
   * Whether the receiver is a member read off the runtime object, as
   * written or kept in a local first, asked the way a read site is.
   */
  receiverReadOff(origin: ReadOff): boolean {
    const member = this.memberKey();
    if (member === null || memberOpsAt(member, this.source) === null) {
      return false;
    }
    // Ruby writes a member read as a call, and the read is its callee.
    const read =
      memberRead(member, this.source) === null
        ? calleeOf(member, this.source)
        : member;
    return read !== null && factReadOps(read, this.source).isOff(origin.object);
  }

  /**
   * The key the member the receiver is was written at: the receiver
   * itself, or what a name there was set to. A name set to a client,
   * `const db = new Client()`, is the client and not a member of it, so
   * only a value read off something counts.
   */
  private memberKey(): string | null {
    if (this.calleeRead === null) {
      return null;
    }
    const { object } = this.calleeRead;
    this.source.read(object);
    if (!isName(object, this.source)) {
      return object;
    }
    const held = new Set(
      declaredValuesOf(object, this.source).filter((value) =>
        isReadOff(value, this.source),
      ),
    );
    const [only, ...more] = held;
    return only === undefined || more.length > 0 ? null : only;
  }

  file(): string {
    return fileOfKey(this.key);
  }

  argument(index: number): CallOps | null {
    const argument = this.arguments().get(index);
    return argument === undefined
      ? null
      : factCallOps(settled(argument, this.source, "names"), this.source);
  }

  callee(): CallOps | null {
    return factCallOps(
      settled(this.calleeKey, this.source, "names"),
      this.source,
    );
  }

  propertyAt(
    index: number,
    property: string,
    unsettled: UnsettledName,
  ): string | null {
    const object = objectAt(this.arguments().get(index), this.source);
    const held =
      object === null ? null : propertyOf(object, property, this.source);
    return held === null ? null : this.source.nameOf(held, unsettled);
  }

  valueAt(index: number): ValueOps | null {
    const argument = this.arguments().get(index);
    return argument === undefined ? null : factValueOps(argument, this.source);
  }

  keywordAt(name: string): ValueOps | null {
    const passed = only(
      this.source.db
        .lookup("callKeywordArg", 0, this.key)
        .filter((row) => String(row[1]) === name),
      2,
    );
    if (passed === null) {
      return null;
    }
    this.source.read(passed);
    return factValueOps(passed, this.source);
  }

  block(): ValueOps | null {
    const block = only(this.source.db.lookup("callBlock", 0, this.key), 1);
    return block === null ? null : factValueOps(block, this.source);
  }

  pairArgs(): readonly PairArg[] {
    return this.source.db.lookup("callPairArg", 0, this.key).map((row) => ({
      key: factValueOps(String(row[1]), this.source),
      value: factValueOps(String(row[2]), this.source),
    }));
  }

  /**
   * One `elementOf` row off the receiver whose variable is the first
   * parameter of the function the call runs, and the `positionOf` row
   * for that variable.
   */
  loopsOver(): Loop | null {
    const handed = this.handedFunction();
    if (this.calleeRead === null || handed === null) {
      return null;
    }
    const { object } = this.calleeRead;
    const element = firstParameterGiven(object, handed, this.source);
    if (element === null) {
      return null;
    }
    const position = only(this.source.db.lookup("positionOf", 1, element), 0);
    return {
      over: factValueOps(object, this.source),
      element: variableName(element, this.source),
      position: position === null ? null : variableName(position, this.source),
    };
  }

  /** The block the call is written with, or else a function written as its first argument. */
  private handedFunction(): string | null {
    const block = only(this.source.db.lookup("callBlock", 0, this.key), 1);
    if (block !== null) {
      return block;
    }
    const first = this.arguments().get(0);
    return first !== undefined && isFunction(first, this.source) ? first : null;
  }

  receiverIsFrom(origin: ReceiverOrigin): boolean {
    return byOrigin(receiverOrigin(this), origin);
  }

  /**
   * Spelled as one of the paths, or else the one path among those the
   * rules followed into the receiver. A receiver can be spelled as only
   * one path, so a spelling settles it without asking the rules.
   */
  receiverGlobal(paths: readonly string[]): string | null | undefined {
    if (this.calleeRead === null) {
      return undefined;
    }
    const { object } = this.calleeRead;
    const spelled = paths.find(
      (path) => this.source.spellsGlobal?.(object, path) === true,
    );
    if (spelled !== undefined) {
      return spelled;
    }
    const reaching = new Set(
      (this.source.globalsReaching?.(object) ?? []).filter((path) =>
        paths.includes(path),
      ),
    );
    if (reaching.size === 0) {
      return undefined;
    }
    const [one] = reaching;
    return reaching.size === 1 && one !== undefined ? one : null;
  }

  /** Whether the call goes to one of the paths with no receiver, `print(x)`. */
  callsGlobal(origin: Global): boolean {
    return origin.paths.some(
      (path) => this.source.callsGlobal?.(this.key, path) === true,
    );
  }

  isFrom(origin: ReceiverOrigin): boolean {
    return byOrigin(callOrigin(this), origin);
  }

  /** Whether this call is `method` called on a receiver from `on`. */
  returns(origin: ReturnedBy): boolean {
    return this.method() === origin.method && this.receiverIsFrom(origin.on);
  }

  anchorCall(origin: ReceiverOrigin): CallOps | null {
    if (origin.origin !== "constructed") {
      return null;
    }
    const subject = this.calleeRead?.object ?? this.calleeKey;
    const matching = new Set(
      this.source
        .anchorCalls(subject, origin)
        .filter((candidate) => this.madeFrom(origin, candidate)),
    );
    const [one] = matching;
    return matching.size === 1 && one !== undefined
      ? factCallOps(one, this.source)
      : null;
  }

  /**
   * Whether the library behind `origin` declared this call's method. An
   * adapter that cannot read declarations checks what made the receiver
   * instead, which is where TypeScript's own check ends up when a method
   * has no declaration to read.
   */
  declaredBy(origin: DeclaredBy | ConstructedFrom): boolean {
    if (this.calleeRead === null) {
      return false;
    }
    const declares = this.source.declares;
    if (declares === undefined) {
      return this.receiverConstructed(origin);
    }
    return origin.importedFrom.some((module) => declares(this.key, module));
  }

  /** Whether the receiver was made from one of the origin's modules, as written or through a project function. */
  receiverConstructed(origin: DeclaredBy | ConstructedFrom): boolean {
    if (this.source.callsProjectMethod?.(this.key) === true) {
      return false;
    }
    const asWritten = this.madeExpression("asWritten");
    if (this.madeFrom(origin, asWritten)) {
      return true;
    }
    const through = this.madeExpression("throughProjectCalls");
    return through !== asWritten && this.madeFrom(origin, through);
  }

  /**
   * Whether the receiver is declared as one of the origin's types. A
   * language that declares none settles it by what made the receiver.
   */
  receiverTyped(origin: Typed): boolean {
    if (this.calleeRead === null) {
      return false;
    }
    const typedAs = this.source.typedAs;
    if (typedAs === undefined) {
      return this.receiverConstructed({
        origin: "constructed",
        importedFrom: origin.importedFrom,
        ...(origin.named === undefined ? {} : { named: origin.named }),
      });
    }
    return typedAs(this.key, origin);
  }

  /**
   * Whether the receiver is one of a class whose ancestry reaches the
   * origin's base. A language that declares no types reads the class the
   * facts say the receiver is one of, or the class that made it.
   */
  receiverInherits(origin: Inheriting): boolean {
    if (this.calleeRead === null) {
      return false;
    }
    const typedInherits = this.source.typedInherits;
    if (typedInherits !== undefined) {
      return typedInherits(this.key, origin);
    }
    return this.receiverClasses(this.calleeRead.object).some((cls) =>
      inheritsFrom(cls, origin, this.source),
    );
  }

  /** Whether the receiver is the parameter a call the origin accepts hands its callback. */
  receiverHanded(origin: HandedBy): boolean {
    if (this.calleeRead === null) {
      return false;
    }
    return callsHanding(
      this.calleeRead.object,
      origin.parameter,
      this.source,
    ).some((key) => {
      const handing = factCallOps(key, this.source);
      return (
        handing !== null &&
        handing.method() === origin.method &&
        handing.receiverIsFrom(origin.on)
      );
    });
  }

  /** Whether the receiver is a value the file imported as the origin says. */
  receiverImported(origin: Imported): boolean {
    return (
      this.calleeRead !== null &&
      importedAsAsked(origin, this.calleeRead.object, this.source)
    );
  }

  /** Whether the callee is a value the file imported as the origin says. */
  calleeImported(origin: Imported): boolean {
    return importedAsAsked(origin, this.calleeKey, this.source);
  }

  /** Whether the call goes to a name rather than to an expression written in place. */
  namedCallee(): boolean {
    return isName(this.calleeKey, this.source);
  }

  /** Whether the callee as the source wrote it came from one of the origin's modules. */
  calleeConstructed(origin: ConstructedFrom): boolean {
    return writtenFrom(origin, this.calleeKey, this.source);
  }

  calleeImportedAs(modules: readonly string[]): string | null {
    if (!importBinds(this.calleeKey, this.source)) {
      return null;
    }
    const names = new Set(
      modules.flatMap((module) =>
        this.source
          .importedAs(this.calleeKey, module)
          .filter((name) => !WHOLE_MODULE.has(name)),
      ),
    );
    const [one] = names;
    return names.size === 1 && one !== undefined ? one : null;
  }

  private madeExpression(reading: "asWritten" | "throughProjectCalls"): string {
    if (this.calleeRead === null) {
      return this.calleeKey;
    }
    const { object } = this.calleeRead;
    // `PG.connect(url).exec(sql)` writes the call that made the receiver
    // in place, so nothing was written to a name for the facts to settle.
    const asWritten =
      this.source.writtenAs(object) ??
      (isCall(object, this.source) ? object : null);
    const written =
      reading === "asWritten"
        ? asWritten
        : madeThroughProjectCall(asWritten, this.source);
    if (written === null || !isCall(written, this.source)) {
      return this.calleeKey;
    }
    return written;
  }

  /**
   * The classes the receiver is one of: those the facts say it is, such
   * as an annotated name's, and the class each construction it was
   * written as makes, with what each name leads to.
   */
  private receiverClasses(receiver: string): string[] {
    const said = this.source.db
      .lookup("instanceOf", 0, receiver)
      .map((row) => String(row[1]));
    const made = [
      this.madeExpression("asWritten"),
      this.madeExpression("throughProjectCalls"),
    ].flatMap((made) => {
      const callee = calleeOf(made, this.source);
      return callee === null ? [] : [classConstructed(callee, this.source)];
    });
    return [...new Set([...said, ...made])].flatMap((cls) => [
      cls,
      ...(this.source.comesTo?.(cls) ?? []),
    ]);
  }

  /** Whether `made`, a construction or a callee, came from one of the origin's modules. */
  private madeFrom(
    origin: DeclaredBy | ConstructedFrom,
    made: string,
  ): boolean {
    const callee = calleeOf(made, this.source);
    return writtenFrom(origin, callee ?? made, this.source);
  }

  private arguments(): Map<number, string> {
    if (this.args === null) {
      this.args = new Map(
        this.source.db
          .lookup("callArg", 0, this.key)
          .map((row) => [Number(row[1]), String(row[2])]),
      );
      for (const argument of this.args.values()) {
        this.source.read(argument);
      }
    }
    return this.args;
  }
}

/**
 * The class a construction's callee makes one of: the callee itself, or
 * the class a language that constructs through a method calls it on, as
 * `Db` in Ruby's `Db.new`.
 */
function classConstructed(callee: string, source: FactSource): string {
  const throughMethod = source.constructedClass?.(callee) ?? null;
  const onClass = throughMethod === null ? null : memberRead(callee, source);
  return onClass?.object ?? callee;
}

/**
 * The calls that hand over the function whose parameter at `position`
 * the value is, as their first argument or as a Ruby block. A function
 * passed by name is found through the names bound to it.
 */
function callsHanding(
  value: string,
  position: number,
  source: FactSource,
): string[] {
  const parameters = [
    value,
    ...source.db.lookup("binds", 0, value).map((row) => String(row[1])),
  ];
  const functions = parameters.flatMap((parameter) => [
    ...source.db
      .lookup("paramOf", 2, parameter)
      .filter((row) => String(row[1]) === String(position))
      .map((row) => String(row[0])),
    ...unstatedOwner(parameter, position, source),
  ]);
  return [
    ...new Set(
      functions.flatMap((func) => [
        ...callsTaking(func, source),
        ...source.db.lookup("callBlock", 1, func).map((row) => String(row[0])),
        ...namesBoundTo(func, source).flatMap((name) =>
          callsTaking(name, source),
        ),
      ]),
    ),
  ];
}

/**
 * The variable a loop gives each element of `over` in, the first
 * parameter of `func`: by its `paramOf` row, or by the adapter's
 * `parameterOf` where it states none, as Ruby does for a block's.
 */
function firstParameterGiven(
  over: string,
  func: string,
  source: FactSource,
): string | null {
  const given = source.db
    .lookup("elementOf", 1, over)
    .map((row) => String(row[0]))
    .filter(
      (variable) =>
        source.db
          .lookup("paramOf", 2, variable)
          .some((row) => String(row[0]) === func && String(row[1]) === "0") ||
        unstatedOwner(variable, 0, source).includes(func),
    );
  return onlyKey(given);
}

/** A variable's name: the one `paramNamed` gives it, or else its source text. */
function variableName(variable: string, source: FactSource): string {
  return (
    only(source.db.lookup("paramNamed", 2, variable), 1) ??
    source.textOf(variable)
  );
}

/** The calls `bodyCallAt` places as the statements of the body at `key`, in order. */
function bodyCallsOf(key: string, source: FactSource): CallOps[] {
  return [...source.db.lookup("bodyCallAt", 0, key)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .flatMap((row) => {
      const ops = factCallOps(String(row[2]), source);
      return ops === null ? [] : [ops];
    });
}

/** The function a parameter with no `paramOf` row belongs to, when it is at this position. */
function unstatedOwner(
  parameter: string,
  position: number,
  source: FactSource,
): string[] {
  const owner = source.parameterOf?.(parameter) ?? null;
  return owner !== null && owner.position === position ? [owner.func] : [];
}

/** The calls that pass the value at this key as their first argument. */
function callsTaking(key: string, source: FactSource): string[] {
  return source.db
    .lookup("callArg", 2, key)
    .filter((row) => String(row[1]) === "0")
    .map((row) => String(row[0]));
}

/**
 * The names bound to a function, and the names bound to those: a
 * reference to a declared function, or to the variable an arrow is
 * assigned to.
 */
function namesBoundTo(func: string, source: FactSource): string[] {
  const bound = (key: string): string[] =>
    source.db.lookup("binds", 1, key).map((row) => String(row[0]));
  const direct = bound(func);
  return [...direct, ...direct.flatMap(bound)];
}

/** How each kind of origin checks a call's receiver. */
function receiverOrigin(call: FactCall): ByOrigin<boolean> {
  return {
    declaredBy: (origin) => call.declaredBy(origin),
    constructed: (origin) => call.receiverConstructed(origin),
    anyOf: (origin) => origin.of.some((one) => call.receiverIsFrom(one)),
    returnedBy: (origin) => {
      const made = call.receiver();
      return (
        made !== null &&
        made.method() === origin.method &&
        made.receiverIsFrom(origin.on)
      );
    },
    typed: (origin) => call.receiverTyped(origin),
    inherits: (origin) => call.receiverInherits(origin),
    handedBy: (origin) => call.receiverHanded(origin),
    imported: (origin) => call.receiverImported(origin),
    global: (origin) => call.receiverGlobal(origin.paths) !== undefined,
    allOf: (origin) => origin.of.every((one) => call.receiverIsFrom(one)),
    readOff: (origin) => call.receiverReadOff(origin),
  };
}

/** How each kind of origin checks the call itself. */
function callOrigin(call: FactCall): ByOrigin<boolean> {
  return {
    declaredBy: (origin) => call.declaredBy(origin),
    constructed: (origin) => call.calleeConstructed(origin),
    anyOf: (origin) => origin.of.some((one) => call.isFrom(one)),
    returnedBy: (origin) => call.returns(origin),
    typed: (origin) => call.receiverTyped(origin),
    inherits: (origin) => call.receiverInherits(origin),
    handedBy: (origin) => call.receiverHanded(origin),
    imported: (origin) => call.calleeImported(origin),
    global: (origin) => call.callsGlobal(origin),
    allOf: (origin) => origin.of.every((one) => call.isFrom(one)),
    readOff: (origin) => call.receiverReadOff(origin),
  };
}

class FactValue implements ValueOps {
  private settledKey: string | null = null;
  private shapedKey: string | null = null;

  constructor(
    private readonly key: string,
    private readonly facts: FactSource,
  ) {
    facts.read(key);
  }

  text(): string | null {
    const literal = this.facts.literalOf(this.written());
    return typeof literal === "string" ? literal : null;
  }

  name(unsettled: UnsettledName): string | null {
    return this.facts.nameOf(this.written(), unsettled);
  }

  names(cap: number): readonly string[] | null {
    return this.facts.namesOf?.(this.key, cap) ?? null;
  }

  flag(): boolean | null {
    const literal = this.facts.literalOf(this.written());
    if (typeof literal === "boolean") {
      return literal;
    }
    return typeof literal === "number" ? literal !== 0 : null;
  }

  entries(unsettled: UnsettledName): readonly ValueEntry[] {
    return lastValueWins(
      spreadEntries(this.shaped(), unsettled, this.facts),
    ).map(({ key, held }) => ({ key, value: factValueOps(held, this.facts) }));
  }

  /**
   * A list written out gives its items. A list built by mapping gives
   * one item, the value every element is built as, since each element
   * has that one shape.
   */
  items(): readonly ValueOps[] {
    const list = this.shaped();
    if (this.facts.shapeOf(list) === "list") {
      return entriesInOrder(list, this.facts).map((held) =>
        factValueOps(held, this.facts),
      );
    }
    const element = builtElement(list, this.facts);
    return element === null ? [] : [factValueOps(element, this.facts)];
  }

  property(name: string): ValueOps | null {
    const held = propertyOf(this.shaped(), name, this.facts);
    return held === null ? null : factValueOps(held, this.facts);
  }

  asArg(): EffectArg | null {
    return this.facts.argOf(this.written());
  }

  parts(): readonly string[] | null {
    const written = this.shaped();
    const literal = this.facts.literalOf(written);
    if (typeof literal === "string") {
      return [literal];
    }
    const pieces = templatePieces(written, this.facts);
    if (pieces.length === 0) {
      return null;
    }
    const parts = [""];
    for (const piece of pieces) {
      if (piece.hole === null) {
        parts[parts.length - 1] += piece.text;
      } else {
        parts.push("");
      }
    }
    return parts;
  }

  holes(): readonly (CallOps | null)[] {
    return this.holeKeys().map((hole) =>
      factCallOps(settled(hole, this.facts, "names"), this.facts),
    );
  }

  interpolated(): readonly ValueOps[] {
    return this.holeKeys().map((hole) => factValueOps(hole, this.facts));
  }

  evaluated(): string | number | boolean | null {
    return this.facts.evaluatedOf?.(this.key) ?? null;
  }

  evaluatedWith(
    bindings: ReadonlyMap<string, string>,
  ): string | number | boolean | null {
    const evaluate = this.facts.evaluatedWith;
    return evaluate === undefined
      ? this.name("nothing")
      : evaluate(this.key, bindings);
  }

  bodyCalls(): readonly CallOps[] {
    return bodyCallsOf(this.key, this.facts);
  }

  object(): ValueOps | null {
    const object = objectBehind(this.key, this.facts);
    return object === null ? null : factValueOps(object, this.facts);
  }

  function(): ValueOps | null {
    const found = functionBehind(this.key, this.facts);
    return found === null ? null : factValueOps(found, this.facts);
  }

  source(): string {
    return this.facts.textOf(this.key);
  }

  form(): ValueForm {
    return this.facts.formOf?.(this.key) ?? "other";
  }

  ownProperty(name: string): ValueOps | null {
    if (this.facts.shapeOf(this.key) !== "object") {
      return null;
    }
    const own = writtenEntries(this.key, "unread", this.facts).filter(
      (entry): entry is HeldEntry => !("spread" in entry) && entry.key === name,
    );
    const last = own[own.length - 1];
    return last === undefined ? null : factValueOps(last.held, this.facts);
  }

  importedFrom(): string | null {
    return this.facts.importSpecifierOf?.(this.key) ?? null;
  }

  /** Asked of the value as written here, since a shape follows no name. */
  shape(): TypeShape | null {
    return this.facts.typeShapeOf?.(this.key) ?? null;
  }

  /**
   * Read from the value as written here, so a condition kept in a name
   * reads nothing. The object matches when it is a name that settles to
   * what the other value settles to, so `u` after `const u = users` is
   * `users`. Where neither settles, a parameter for instance, it matches
   * when it is written the same way.
   */
  readsOff(object: ValueOps): readonly string[] {
    const other = keysOfValues.get(object) ?? null;
    const target = other === null ? null : nameWrittenAs(other, this.facts);
    const written = object.source?.() ?? null;
    return propertiesReadOff(
      this.key,
      (key) => {
        const settled = nameWrittenAs(key, this.facts);
        if (settled !== null || target !== null) {
          return settled === target;
        }
        return written !== null && this.facts.textOf(key) === written;
      },
      this.facts,
    );
  }

  /** Asked of the settled value, as `asArg` is, so an encoding kept in a name is still read. */
  encoded(): Encoded | null {
    const found = this.facts.encodedOf?.(this.written()) ?? null;
    return found === null
      ? null
      : { codec: found.codec, value: factValueOps(found.value, this.facts) };
  }

  member(name: string, singleton = false): ValueOps | null {
    const held = heldMember(
      this.key,
      spelledMember(name, singleton),
      this.facts,
    );
    return held === null ? null : factValueOps(held, this.facts);
  }

  returns(): readonly ValueOps[] {
    const found = functionBehind(this.key, this.facts);
    return found === null
      ? []
      : this.facts.db
          .lookup("returnsValue", 0, found)
          .map((row) => factValueOps(String(row[1]), this.facts));
  }

  marked(word: string): boolean {
    const found = functionBehind(this.key, this.facts);
    return found !== null && marks(found, word, this.facts);
  }

  tag(): ValueOps | null {
    const [element] = this.facts.db.lookup("jsxElement", 0, this.written());
    return element === undefined
      ? null
      : factValueOps(String(element[1]), this.facts);
  }

  asClass(): ClassValueOps | null {
    const cls = classBehind(this.key, this.facts);
    return cls === null ? null : new FactClass(cls, this.facts);
  }

  private holeKeys(): string[] {
    return templatePieces(this.shaped(), this.facts).flatMap((piece) =>
      piece.hole === null ? [] : [piece.hole],
    );
  }

  private written(): string {
    this.settledKey ??= settled(this.key, this.facts, "names");
    return this.settledKey;
  }

  /**
   * What an object, a list or a template's pieces are read off: the value
   * as written, or the one value a call into a project function returns.
   * A text or a name is read off `written()` instead, since the adapter
   * settles a call there with the call's arguments in place, which
   * reading what the function returns would lose.
   */
  private shaped(): string {
    this.shapedKey ??= followedCall(this.written(), this.facts);
    return this.shapedKey;
  }
}

/**
 * Every property the value at `key` reads off an object `matches`
 * accepts, each once, in source order. The walk goes into what the value
 * is written from and nowhere else, so a function written in it, or a
 * helper that built it, adds nothing.
 */
function propertiesReadOff(
  key: string,
  matches: (object: string) => boolean,
  source: FactSource,
): string[] {
  const names = new Set<string>();
  const seen = new Set<string>();
  const visit = (at: string): void => {
    if (seen.has(at)) {
      return;
    }
    seen.add(at);
    source.read(at);
    for (const row of source.db.lookup("readsProperty", 0, at)) {
      const object = String(row[1]);
      const name =
        source.memberName === undefined
          ? String(row[2])
          : source.memberName(String(row[2]));
      if (name !== null && matches(object)) {
        names.add(name);
      }
      visit(object);
    }
    for (const inside of builtFrom(at, source)) {
      visit(inside);
    }
  };
  visit(key);
  return [...names];
}

/**
 * The values one value is built from, in source order: a call's callee
 * and arguments, the two sides of a comparison, a template's holes, the
 * branches of a conditional or a fallback, and an object's or a list's
 * entries.
 */
function builtFrom(key: string, source: FactSource): string[] {
  const rows = (relation: string) => source.db.lookup(relation, 0, key);
  const inOrder = (relation: string, value: number) =>
    [...rows(relation)]
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((row) => String(row[value]));
  return [
    ...rows("call").map((row) => String(row[1])),
    ...inOrder("callArg", 2),
    ...rows("callKeywordArg").map((row) => String(row[2])),
    ...rows("callBlock").map((row) => String(row[1])),
    ...rows("compares").flatMap((row) => [String(row[1]), String(row[2])]),
    ...inOrder("holeAt", 2),
    ...rows("conditionalBranch").map((row) => String(row[1])),
    ...rows("fallbackBranch").map((row) => String(row[1])),
    ...inOrder("writtenEntryAt", 2),
  ];
}

/**
 * A value, or the one value a call into a project function returns. A
 * library call, a construction and a function with two returns have no
 * one value, and stay as written, so a command is still read off the
 * object it was constructed with.
 */
function followedCall(key: string, source: FactSource): string {
  if (!isCall(key, source)) {
    return key;
  }
  const returned = source.writtenAs(key) ?? key;
  source.read(returned);
  return returned;
}

/**
 * What every element of a mapped collection is built as, or null. A
 * call builds each element from what the function it hands over
 * returns, and a comprehension writes the element in place. A callback
 * with two returns, or one that comes to no function, builds nothing
 * the ops can read.
 */
function builtElement(collection: string, source: FactSource): string | null {
  const each = only(source.db.lookup("eachElement", 0, collection), 1);
  if (each === null) {
    return null;
  }
  source.read(each);
  if (!isCall(collection, source)) {
    return each;
  }
  const callback = functionBehind(each, source);
  if (callback === null) {
    return null;
  }
  source.read(callback);
  return only(source.db.lookup("returnsValue", 0, callback), 1);
}

/**
 * The object a value comes to, or null. An object written out here is
 * itself, and nothing is asked. Otherwise it is the one object among
 * what the value comes to, with any function there left out, as the
 * TypeScript store's `resolveObject` leaves one out.
 */
function objectBehind(key: string, source: FactSource): string | null {
  if (source.shapeOf(key) === "object") {
    return key;
  }
  const object = onlyKey(
    (source.comesTo?.(key) ?? []).filter((to) => !isFunction(to, source)),
  );
  return object !== null && source.shapeOf(object) === "object" ? object : null;
}

/**
 * The function a value is, or null: one written out here, the one
 * function among what the value comes to, or else the one a factory
 * call gives back.
 */
export function functionBehind(key: string, source: FactSource): string | null {
  if (isFunction(key, source)) {
    return key;
  }
  const comesTo = onlyKey(
    (source.comesTo?.(key) ?? []).filter((to) => isFunction(to, source)),
  );
  return comesTo ?? source.givesBack?.(key) ?? null;
}

function isFunction(key: string, source: FactSource): boolean {
  return source.db.lookup("func", 0, key).length > 0;
}

/** The key a member is stated under: a class's own member is spelled apart from an instance's. */
function spelledMember(name: string, singleton: boolean): string {
  return singleton ? classMemberName(name) : name;
}

/**
 * What the value, or the one thing it comes to, states under the name.
 * The last statement wins, as the last write to a property does.
 */
function heldMember(
  key: string,
  spelled: string,
  source: FactSource,
): string | null {
  for (const holder of [key, ...(source.comesTo?.(key) ?? [])]) {
    const held = source.db
      .lookup("holdsProperty", 0, holder)
      .filter((row) => row[1] === spelled);
    const last = held[held.length - 1];
    if (last !== undefined) {
      return String(last[2]);
    }
  }
  return null;
}

function marks(scope: string, word: string, source: FactSource): boolean {
  return source.db.lookup("marks", 0, scope).some((row) => row[1] === word);
}

/**
 * The class a value is, or comes to: something the facts state as an
 * object that is neither written out as one nor a function. A Ruby
 * module counts, and reaches a base only through what it includes.
 */
function classBehind(key: string, source: FactSource): string | null {
  for (const candidate of [key, ...(source.comesTo?.(key) ?? [])]) {
    if (
      source.db.lookup("objectValue", 0, candidate).length > 0 &&
      source.shapeOf(candidate) === null &&
      !isFunction(candidate, source)
    ) {
      return candidate;
    }
  }
  return null;
}

class FactClass implements ClassValueOps {
  constructor(
    private readonly key: string,
    private readonly facts: FactSource,
  ) {}

  inherits(spec: Inherits): boolean {
    return inheritsFrom(this.key, spec, this.facts);
  }

  members(kind: "instance" | "singleton"): readonly ModuleMember[] {
    return this.facts.db.lookup("holdsProperty", 0, this.key).flatMap((row) => {
      const stated = String(row[1]);
      const own = classMemberOf(stated);
      const name = kind === "singleton" ? own : own === null ? stated : null;
      const held = String(row[2]);
      return name === null || !isFunction(held, this.facts)
        ? []
        : [{ name, value: factValueOps(held, this.facts) }];
    });
  }

  /** `rbConstantName` in Ruby, which gives a nested class its full name, and `exportsAs` elsewhere. */
  name(): string | null {
    const { db } = this.facts;
    return (
      only(db.lookup("rbConstantName", 0, this.key), 1) ??
      only(db.lookup("exportsAs", 2, this.key), 1)
    );
  }

  bodyCalls(): readonly CallOps[] {
    return bodyCallsOf(this.key, this.facts);
  }
}

/**
 * Whether the class's ancestry reaches one of the bases the spec lists:
 * a base imported from one of its modules under one of its names, or a
 * project class that reaches one. The receiver origin that matches an
 * instance of such a class reads the same walk.
 */
export function inheritsFrom(
  cls: string,
  spec: Inherits,
  source: FactSource,
): boolean {
  const seen = new Set<string>();
  const reaches = (key: string): boolean => {
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return source.db.lookup("extends", 0, key).some((row) => {
      const base = String(row[1]);
      return (
        isListedBase(base, spec, source) ||
        (source.comesTo?.(base) ?? []).some(reaches)
      );
    });
  };
  return reaches(cls);
}

function isListedBase(
  base: string,
  spec: Inherits,
  source: FactSource,
): boolean {
  return spec.from.some((module) =>
    source.importedAs(base, module).some((name) => spec.named.includes(name)),
  );
}

/**
 * What only the adapter can list about one file, since no fact is keyed
 * by file for it. The rest of the module ops read the facts.
 */
export interface ModuleWritten {
  /** States what the file says about itself, for an adapter that states facts on demand. */
  state?(): void;
  /** The file's exports, for an adapter whose export table follows a re-export, as TypeScript's does. Unset reads `exportsAs`. */
  exports?(): readonly { readonly name: string; readonly key: string }[];
  /** The calls the module body runs outside every function, in source order. */
  calls(): readonly CallOps[];
  /** The keys of the classes and modules the file writes, nested ones included, in source order. Unset lists none. */
  classes?(): readonly string[];
  /** Every function the file writes, with the variable or property it is assigned to. Unset where the language writes no directive. */
  functions?(): readonly {
    readonly key: string;
    readonly assignedName: string | null;
  }[];
  /** How the language writes a nested name in one piece, `::` in Ruby, so `class Reports::Nightly` is found at the path `Reports`, `Nightly`. */
  qualifier?: string;
  /**
   * Whether the file's own text has the word anywhere, asked before any
   * fact is stated. A file that never writes `use server` has no mark,
   * and stating every function in it to learn that costs more than the
   * rest of the run. Unset reads the facts.
   */
  mentions?(word: string): boolean;
}

/** The module ops for one file, over the facts and what the adapter lists about the file. */
export function factModuleOps(
  file: string,
  source: FactSource,
  written: ModuleWritten,
): ModuleOps {
  return new FactModule(file, source, written);
}

class FactModule implements ModuleOps {
  private stated = false;
  private exported: readonly ModuleMember[] | null = null;

  constructor(
    private readonly file: string,
    private readonly facts: FactSource,
    private readonly written: ModuleWritten,
  ) {}

  path(): string {
    return this.file;
  }

  exports(): readonly ModuleMember[] {
    this.exported ??= this.listExports();
    return this.exported;
  }

  export(path: readonly string[], member?: ModuleMemberName): ValueOps | null {
    for (const value of this.valuesAt(path)) {
      const found =
        member === undefined
          ? value
          : (value.member?.(member.name, member.singleton) ?? null);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  /**
   * Every value at the path: its first names as one export, the fewest
   * first, then each name after them as a member. A class written twice
   * in the file is two values, and the member can be in either.
   */
  private valuesAt(path: readonly string[]): ValueOps[] {
    const { qualifier } = this.written;
    const heads = qualifier === undefined ? 1 : path.length;
    const values: ValueOps[] = [];
    for (let take = 1; take <= heads; take++) {
      const head = path.slice(0, take).join(qualifier ?? "");
      for (const exported of this.exports()) {
        let found: ValueOps | null =
          exported.name === head ? exported.value : null;
        for (const step of path.slice(take)) {
          found = found?.member?.(step) ?? null;
        }
        if (found !== null) {
          values.push(found);
        }
      }
    }
    return values;
  }

  calls(): readonly CallOps[] {
    return this.written.calls();
  }

  /** `bodyCallAt` keys a file's own statements by the file's path, as `exportsAs` keys its exports. */
  bodyCalls(): readonly CallOps[] {
    this.state();
    return bodyCallsOf(this.file, this.facts);
  }

  classes(): readonly ClassValueOps[] {
    return (this.written.classes?.() ?? []).map((key) => {
      this.facts.read(key);
      return new FactClass(key, this.facts);
    });
  }

  marked(word: string): boolean {
    if (!this.mentions(word)) {
      return false;
    }
    this.state();
    return marks(this.file, word, this.facts);
  }

  markedFunctions(word: string): readonly MarkedFunction[] {
    if (!this.mentions(word)) {
      return [];
    }
    return (this.written.functions?.() ?? []).flatMap(
      ({ key, assignedName }) => {
        this.facts.read(key);
        return marks(key, word, this.facts)
          ? [{ value: factValueOps(key, this.facts), assignedName }]
          : [];
      },
    );
  }

  private listExports(): ModuleMember[] {
    this.state();
    const named =
      this.written.exports?.() ??
      this.facts.db
        .lookup("exportsAs", 0, this.file)
        .map((row) => ({ name: String(row[1]), key: String(row[2]) }));
    return named.map(({ name, key }) => ({
      name,
      value: factValueOps(key, this.facts),
    }));
  }

  mentions(word: string): boolean {
    return this.written.mentions?.(word) ?? true;
  }

  private state(): void {
    if (!this.stated) {
      this.stated = true;
      this.written.state?.();
    }
  }
}

/** The one key in a list, or null for none or several. */
function onlyKey(keys: readonly string[]): string | null {
  const distinct = new Set(keys);
  const [one] = distinct;
  return distinct.size === 1 && one !== undefined ? one : null;
}

/** One piece of a template, in source order: text, or the key of a hole. */
interface TemplatePiece {
  readonly text: string;
  readonly hole: string | null;
}

function templatePieces(key: string, source: FactSource): TemplatePiece[] {
  const pieces = [
    ...source.db.lookup("partAt", 0, key).map((row) => ({
      at: Number(row[1]),
      text: String(row[2]),
      hole: null,
    })),
    ...source.db.lookup("holeAt", 0, key).map((row) => ({
      at: Number(row[1]),
      text: "",
      hole: String(row[2]),
    })),
  ];
  return pieces.sort((a, b) => a.at - b.at);
}

/** The values in an object or list, in the order the source wrote them, spreads left out. */
function entriesInOrder(key: string, source: FactSource): string[] {
  return source.db
    .lookup("writtenEntryAt", 0, key)
    .filter((row) => row[3] === "value")
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((row) => String(row[2]));
}

/** One value an object is written with, and the key it is under, null for a computed key nothing settles. */
interface HeldEntry {
  readonly key: string | null;
  readonly held: string;
}

/** An entry of an object as the source wrote it: a value under a key, or a spread of another collection. */
type WrittenEntry = HeldEntry | { readonly spread: string };

/**
 * How a key the source computes is read: the way `nameOf` reads a name
 * nothing settles, or not at all, which leaves the key null. A reader
 * after one named property has no use for a computed key, and settling
 * one can cost a question to the store.
 */
type ComputedKeys = UnsettledName | "unread";

/**
 * The entries an object is written with, in source order. A value is
 * under the key the source writes for it, or under a key the source
 * computes, read the way `computedKeys` says. Python and Ruby key a name
 * by its scope, so in `{"a": x, "b": x}` both entries have the same value
 * key, and each place where it is written takes the next of its keys in
 * turn. A computed key is stated by the entry's position, so it never
 * takes one of those turns.
 */
function writtenEntries(
  object: string,
  computedKeys: ComputedKeys,
  source: FactSource,
): WrittenEntry[] {
  const names = new Map<string, string[]>();
  for (const row of source.db.lookup("holdsProperty", 0, object)) {
    const held = String(row[2]);
    names.set(held, [...(names.get(held) ?? []), String(row[1])]);
  }
  const computed = new Set(
    source.db.lookup("holdsUnderKey", 0, object).map((row) => String(row[1])),
  );
  const keyedAt = computedKeysByPosition(object, source);
  const turns = new Map<string, number>();
  return [...source.db.lookup("writtenEntryAt", 0, object)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .flatMap((row): WrittenEntry[] => {
      const held = String(row[2]);
      if (row[3] === "spread") {
        return [{ spread: held }];
      }
      const computedKey = keyedAt.get(String(row[1]));
      if (computedKey !== undefined) {
        return [
          { key: computedKeyName(computedKey, computedKeys, source), held },
        ];
      }
      const turn = turns.get(held) ?? 0;
      turns.set(held, turn + 1);
      const name = names.get(held)?.[turn];
      if (name !== undefined) {
        return [{ key: name, held }];
      }
      return computed.has(held) ? [{ key: null, held }] : [];
    });
}

/**
 * The expression that computes the key of each entry the source wrote
 * one for, by the entry's position. An entry stated with two has no one
 * key, and is read as unsettled.
 */
function computedKeysByPosition(
  object: string,
  source: FactSource,
): Map<string, string | null> {
  const keys = new Map<string, Set<string>>();
  for (const row of source.db.lookup("computedKeyAt", 0, object)) {
    const position = String(row[1]);
    keys.set(position, (keys.get(position) ?? new Set()).add(String(row[2])));
  }
  return new Map(
    [...keys].map(([position, written]) => {
      const [one] = written;
      return [position, written.size === 1 && one !== undefined ? one : null];
    }),
  );
}

function computedKeyName(
  key: string | null,
  computedKeys: ComputedKeys,
  source: FactSource,
): string | null {
  if (key === null || computedKeys === "unread") {
    return null;
  }
  return source.nameOf(key, computedKeys);
}

/**
 * Every entry an object is written with, a spread replaced by the
 * entries of the object it unpacks, in source order. A spread of
 * anything but an object adds nothing, and an object that spreads its
 * way back into itself adds nothing the second time.
 */
function spreadEntries(
  object: string,
  unsettled: UnsettledName,
  source: FactSource,
  within: ReadonlySet<string> = new Set(),
): HeldEntry[] {
  if (within.has(object) || source.shapeOf(object) !== "object") {
    return [];
  }
  const inside = new Set(within).add(object);
  return writtenEntries(object, unsettled, source).flatMap((entry) =>
    "spread" in entry
      ? spreadEntries(
          spreadObject(entry.spread, source),
          unsettled,
          source,
          inside,
        )
      : [entry],
  );
}

/**
 * The value an object has under a name, or null. The last entry written
 * under it wins, a spread counting as the entries of the object it
 * unpacks. Reading from the end means a spread before the last entry of
 * that name is never settled.
 */
function propertyOf(
  object: string,
  name: string,
  source: FactSource,
  within: ReadonlySet<string> = new Set(),
): string | null {
  if (within.has(object) || source.shapeOf(object) !== "object") {
    return null;
  }
  const inside = new Set(within).add(object);
  const entries = writtenEntries(object, "unread", source);
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at] as WrittenEntry;
    if (!("spread" in entry)) {
      if (entry.key === name) {
        return entry.held;
      }
      continue;
    }
    const found = propertyOf(
      spreadObject(entry.spread, source),
      name,
      source,
      inside,
    );
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * The object a spread unpacks: what a name was written as, or what a
 * project call returns, or failing those the object the spread comes
 * to. The last reaches an object passed through a call that returns its
 * argument, `...meta(base)`, which the first two stop at.
 */
function spreadObject(spread: string, source: FactSource): string {
  source.read(spread);
  const written = followedCall(settled(spread, source, "names"), source);
  if (source.shapeOf(written) === "object") {
    return written;
  }
  return objectBehind(spread, source) ?? written;
}

/**
 * The object an argument states. A project call is read as the object it
 * returns. A command puts its inputs in the object it was constructed
 * with, so a construction is read as the object in it.
 */
function objectAt(
  argument: string | undefined,
  source: FactSource,
): string | null {
  if (argument === undefined) {
    return null;
  }
  const written = followedCall(settled(argument, source, "names"), source);
  if (isCall(written, source)) {
    const first = only(
      source.db.lookup("callArg", 0, written).filter((row) => row[1] === "0"),
      2,
    );
    return objectAt(first ?? undefined, source);
  }
  return source.shapeOf(written) === "object" ? written : null;
}

/**
 * A value, or what the source wrote it as when it is a name. A receiver
 * kept on a field is followed too, since a client kept on `this.orders`
 * is the call the field was written as.
 */
function settled(
  key: string,
  source: FactSource,
  following: "names" | "namesAndFields",
): string {
  const field = memberRead(key, source) !== null;
  const followed =
    isName(key, source) || (following === "namesAndFields" && field);
  if (!followed) {
    return key;
  }
  return source.writtenAs(key) ?? key;
}

/** What a call into one of the project's own functions returns. Anything else comes back as it is. */
function madeThroughProjectCall<K extends string | null>(
  written: K,
  source: FactSource,
): K | string {
  if (written === null || !isCall(written, source)) {
    return written;
  }
  return source.returnedBy?.(written) ?? written;
}

/** What a name was written as, or null for a key that is not a name or that nothing settles. */
function nameWrittenAs(key: string, source: FactSource): string | null {
  return isName(key, source) ? source.writtenAs(key) : null;
}

/** Whether the key is a name: stated as none of a call, a read, an object or a written value. */
function isName(key: string, source: FactSource): boolean {
  const { db } = source;
  return (
    db.lookup("call", 0, key).length === 0 &&
    db.lookup("readsProperty", 0, key).length === 0 &&
    db.lookup("objectValue", 0, key).length === 0 &&
    db.lookup("writtenValue", 0, key).length === 0 &&
    db.lookup("func", 0, key).length === 0
  );
}

function isCall(key: string, source: FactSource): boolean {
  return source.db.lookup("call", 0, key).length > 0;
}

/** The callee of the call at `key`, or null when it is not a call. */
function calleeOf(key: string, source: FactSource): string | null {
  return only(source.db.lookup("call", 0, key), 1);
}

/** The object and the name a member read is written with, `o.n`, or null. */
function memberRead(
  key: string,
  source: FactSource,
): { object: string; name: string } | null {
  const reads = new Map<string, { object: string; name: string }>();
  for (const row of source.db.lookup("readsProperty", 0, key)) {
    const stated = String(row[2]);
    const name =
      source.memberName === undefined ? stated : source.memberName(stated);
    if (name !== null) {
      const read = { object: String(row[1]), name };
      reads.set(`${read.object}\u0000${name}`, read);
    }
  }
  const [only, ...more] = reads.values();
  return only === undefined || more.length > 0 ? null : only;
}

/**
 * The member read at `key` as ops whose callee is that read, or null. A
 * call with no arguments counts as one, since Ruby writes `db.users`
 * that way.
 */
function memberOpsAt(key: string, source: FactSource): CallOps | null {
  source.read(key);
  if (memberRead(key, source) !== null) {
    const read = new FactCall(key, key, source);
    return source.extend?.(key, read) ?? read;
  }
  const called = factCallOps(key, source);
  return called !== null && called.argumentCount() === 0 ? called : null;
}

/** Whether the value is read off an object: a member read, or a call made on a receiver. */
function isReadOff(key: string, source: FactSource): boolean {
  source.read(key);
  if (memberRead(key, source) !== null) {
    return true;
  }
  const callee = calleeOf(key, source);
  if (callee === null) {
    return false;
  }
  source.read(callee);
  return memberRead(callee, source) !== null;
}

/**
 * What a name is bound to through its declaration, so a member read kept
 * in a local is read as if written in its place. TypeScript binds a
 * reference to its declaration and the declaration to its value, so both
 * rows count, and a read copied into a second name is not reached. Python
 * and Ruby bind a name to its value directly, so there the second row
 * reaches through one copy.
 */
function declaredValuesOf(name: string, source: FactSource): string[] {
  const bound = (key: string): string[] => {
    source.read(key);
    return source.db.lookup("binds", 0, key).map((row) => String(row[1]));
  };
  const direct = bound(name);
  return [
    ...direct,
    ...direct.filter((key) => isName(key, source)).flatMap(bound),
  ];
}

/** The leftmost name of a member read, `aws` in `aws.sqs.send`. */
function rootOf(key: string, source: FactSource): string {
  let at = key;
  for (let read = memberRead(at, source); read !== null; ) {
    at = read.object;
    read = memberRead(at, source);
  }
  return at;
}

/**
 * The rightmost name an expression is written with: the member for a
 * read, else the text. A class called through the language's constructor
 * method, `PG::Connection.new`, is named after the class.
 */
function constructorName(key: string, source: FactSource): string {
  return (
    source.constructedClass?.(key) ??
    memberRead(key, source)?.name ??
    source.textOf(key)
  );
}

/** Whether the value at `key` was imported from one of the origin's modules under a name it asks for. */
function importedAsAsked(
  origin: Imported,
  key: string,
  source: FactSource,
): boolean {
  return origin.importedFrom.some((module) =>
    source
      .importedAs(key, module)
      .some(
        (name) => origin.named === undefined || origin.named.includes(name),
      ),
  );
}

/**
 * Whether `written`, the callee a value was made by, came from one of the
 * origin's modules under an export the origin asks for.
 */
function writtenFrom(
  origin: DeclaredBy | ConstructedFrom,
  written: string,
  source: FactSource,
): boolean {
  const root = rootOf(written, source);
  return origin.importedFrom.some(
    (module) =>
      namedAs(origin, written, module, source) &&
      source.importedFrom(root, module),
  );
}

/**
 * Whether the export a value was made from is one the origin asks for:
 * the name the callee is written with, or the export it was imported as,
 * so an alias matches. Unset takes any.
 */
function namedAs(
  origin: ReceiverOrigin,
  written: string,
  module: string,
  source: FactSource,
): boolean {
  if (origin.origin !== "constructed" || origin.named === undefined) {
    return true;
  }
  const asked = origin.named;
  return (
    asked.includes(constructorName(written, source)) ||
    (importBinds(written, source) &&
      source.importedAs(written, module).some((name) => asked.includes(name)))
  );
}

/**
 * Whether an import binds the name written at `key`. Only such a name
 * can be an export under another name, and asking what a parameter was
 * imported as would follow it through every caller.
 */
function importBinds(key: string, source: FactSource): boolean {
  source.read(key);
  return boundByImport(source.db, key);
}

/** The names an import of the whole module goes by, which say nothing about which export a callee is. */
const WHOLE_MODULE: ReadonlySet<string> = new Set(["*", "default"]);

/** The one value in a column of these rows, or null for none or several. */
function only(
  rows: readonly (readonly unknown[])[],
  column: number,
): string | null {
  const values = new Set(rows.map((row) => String(row[column])));
  const [one] = values;
  return values.size === 1 && one !== undefined ? one : null;
}
