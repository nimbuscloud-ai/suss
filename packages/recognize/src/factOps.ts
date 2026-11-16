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
  bySourceOrder,
  classMemberName,
  classMemberOf,
  fileOfKey,
  inSourceOrder,
  spanOfKey,
} from "@suss/resolution";

import { factReadOps, handedInAs } from "./factReadOps.js";

import type { Effect, TypeShape } from "@suss/behavioral-ir";
import type {
  ArgumentRead,
  AsCallFollowing,
  ByOrigin,
  CallOps,
  CallScope,
  CallsAndOptions,
  ClassValueOps,
  Comparison,
  ConstructedFrom,
  Declaration,
  DeclaredBy,
  Decoded,
  DecoratedDefinition,
  Decorator,
  EffectArg,
  ElementAttribute,
  ElementOps,
  Encoded,
  FactSource,
  FieldCall,
  Global,
  HandedBy,
  Imported,
  Inheriting,
  Inherits,
  ListedEntry,
  ListedValues,
  Loop,
  MarkedFunction,
  ModuleMember,
  ModuleMemberName,
  ModuleOps,
  PairArg,
  PassedTo,
  ReadOff,
  ReceiverOrigin,
  ReturnedBy,
  RuntimeObject,
  Splats,
  StatedSlot,
  Typed,
  UnsettledName,
  UrlTarget,
  ValueAt,
  ValueEntry,
  ValueForm,
  ValueOps,
  ValueRead,
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
  return valueOpsRead(key, source, null);
}

/** The ops for the value at `key`, noting the argument it was read off when it was. */
function valueOpsRead(
  key: string,
  source: FactSource,
  read: ArgumentRead | null,
): ValueOps {
  const value = new FactValue(key, source);
  const ops = source.extendValue?.(key, value) ?? value;
  keysOfValues.set(ops, key);
  if (read !== null) {
    argumentsRead.set(value, read);
  }
  return ops;
}

/** The key each value the ops handed out was read at, so one value can be compared with another. */
const keysOfValues = new WeakMap<ValueOps, string>();

const NO_SPLATS: Splats = { positionalFrom: null, keywords: false };

/**
 * The call and argument each value read off one was read at. A name in
 * Python or Ruby has a key and no node, and two assignments to one name
 * share the key, so an adapter reads the argument where the call writes it.
 */
const argumentsRead = new WeakMap<ValueOps, ArgumentRead>();

/**
 * The ops for the JSX element at `key`: its tag from its `jsxElement`
 * row, and its attributes from its `jsxAttribute` rows, in the order
 * the adapter stated them, which is the order the source writes them.
 */
export function factElementOps(key: string, source: FactSource): ElementOps {
  return new FactElement(key, source);
}

/**
 * The key a value these ops handed out was read at, or null for one they
 * didn't. A name in Python or Ruby has a key and no node, so an adapter
 * that wants a value back as one of its own takes the key.
 */
export function valueKeyOf(value: ValueOps): string | null {
  return keysOfValues.get(value) ?? null;
}

/** The key a value these ops handed out was read at, and the argument it was read off, or null for a value they didn't hand out. */
function valueAtOf(value: ValueOps): ValueAt | null {
  const key = keysOfValues.get(value);
  return key === undefined ? null : { key, at: argumentsRead.get(value) };
}

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

  positionalCount(): number {
    return this.source.positionalCount?.(this.key) ?? this.argumentCount();
  }

  decodes(): Decoded | null {
    const found = this.source.decodedOf?.(this.key) ?? null;
    return found === null
      ? null
      : {
          codec: found.codec,
          value: factValueOps(found.value, this.source),
          result: factValueOps(this.key, this.source),
        };
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

  receiverCalls(): readonly CallOps[] {
    if (this.calleeRead === null || this.receiver() !== null) {
      return [];
    }
    return (this.source.writtenAsEach?.(this.calleeRead.object) ?? []).flatMap(
      (key) => factCallOps(key, this.source) ?? [],
    );
  }

  /** The object the callee reads the method off, as written, without following a name. */
  receiverValue(): ValueOps | null {
    return this.calleeRead === null
      ? null
      : factValueOps(this.calleeRead.object, this.source);
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
    return argument === undefined
      ? null
      : valueOpsRead(argument, this.source, { call: this.key, at: index });
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
    return valueOpsRead(passed, this.source, {
      call: this.key,
      at: { keyword: name },
    });
  }

  constructionSites(): readonly string[] {
    return this.source.constructionSitesOf?.(this.key) ?? [];
  }

  splats(): Splats {
    return this.source.splatsOf?.(this.key) ?? NO_SPLATS;
  }

  /** The `callKeywordArg` rows, which each adapter states in the order the call writes them. */
  keywordNames(): readonly string[] {
    return [
      ...new Set(
        this.source.db
          .lookup("callKeywordArg", 0, this.key)
          .map((row) => String(row[1])),
      ),
    ];
  }

  /** The one `callArg` or `callKeywordArg` row whose value is this call. */
  passedTo(): PassedTo | null {
    const { db } = this.source;
    const rows = [
      ...db.lookup("callArg", 2, this.key).map((row) => ({
        call: String(row[0]),
        at: Number(row[1]) as PassedTo["at"],
      })),
      ...db.lookup("callKeywordArg", 2, this.key).map((row) => ({
        call: String(row[0]),
        at: { keyword: String(row[1]) },
      })),
    ];
    const [one, ...more] = rows;
    if (one === undefined || more.length > 0) {
      return null;
    }
    const call = factCallOps(one.call, this.source);
    return call === null ? null : { call, at: one.at };
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

  /** The receiver's import rows and the construction it was written as, read as `importSettled` and `madeSettled` say. */
  receiverSettledFrom(origin: Imported | ConstructedFrom): boolean | undefined {
    if (this.calleeRead === null) {
      return false;
    }
    if (origin.origin === "imported") {
      return importSettled(origin, this.calleeRead.object, this.source);
    }
    if (this.source.callsProjectMethod?.(this.key) === true) {
      return false;
    }
    const asWritten = this.madeExpression("asWritten");
    const settled = madeSettled(origin, asWritten, this.source);
    const through = this.madeExpression("throughProjectCalls");
    return settled === false && through !== asWritten
      ? madeSettled(origin, through, this.source)
      : settled;
  }

  /**
   * Spelled as one of the paths, or else the one path among those the
   * rules followed into the receiver. A receiver can be spelled as only
   * one path, so a spelling settles it without asking the rules.
   */
  receiverGlobal(paths: readonly string[]): string | null | undefined {
    return this.calleeRead === null
      ? undefined
      : globalAt(this.calleeRead.object, paths, this.source);
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

  calleeImport(modules: readonly string[]): string | null {
    const imported =
      this.source.importedUnder === undefined
        ? importedUnder(this.calleeKey, modules, this.source.db)
        : this.source.importedUnder(this.calleeKey, modules);
    const names = new Set(imported.filter((name) => !WHOLE_MODULE.has(name)));
    const [one] = names;
    return names.size === 1 && one !== undefined ? one : null;
  }

  callsInCallee(): readonly CallOps[] {
    const adapters = this.source.callsInCallee;
    if (adapters !== undefined) {
      return adapters(this.key);
    }
    const func = functionBehind(this.calleeKey, this.source);
    return func === null
      ? []
      : callsWrittenIn(func, this.source).flatMap((call) => {
          const ops = factCallOps(call, this.source);
          return ops === null ? [] : [ops];
        });
  }

  /** The one call `returnsValue` gives the callee's function, when its positional `callArg` rows are the function's parameters in order. */
  returnedCall(): CallOps | null {
    const func = functionBehind(this.calleeKey, this.source);
    const returned =
      func === null
        ? null
        : onlyKey(
            this.source.db
              .lookup("returnsValue", 0, func)
              .map((row) => String(row[1])),
          );
    if (
      func === null ||
      returned === null ||
      !isCall(returned, this.source) ||
      !passesParametersInOrder(returned, func, this.source)
    ) {
      return null;
    }
    return factCallOps(returned, this.source);
  }

  dropped(owned: ReadonlySet<string>): boolean {
    return this.source.dropped?.(this.key, owned) ?? false;
  }

  /** The function `makesCall` says writes the call. */
  callerSite(): string | null {
    return only(this.source.db.lookup("makesCall", 1, this.key), 0);
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

  literal(): string | number | boolean | null {
    return this.facts.literalOf(this.key);
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
      return this.facts.partsOf?.(written) ?? null;
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

  url(site?: string): UrlTarget | null {
    return this.facts.urlOf?.(this.key, site, argumentsRead.get(this)) ?? null;
  }

  host(port: ValueOps | null, site?: string): string | undefined {
    const portAt = port === null ? null : valueAtOf(port);
    return port !== null && portAt === null
      ? undefined
      : this.facts.hostOf?.(
          { key: this.key, at: argumentsRead.get(this) },
          portAt,
          site,
        );
  }

  isString(site?: string): boolean {
    return (
      this.facts.isStringOf?.(this.key, site, argumentsRead.get(this)) ?? false
    );
  }

  /**
   * With nothing bound, the adapter's own evaluator reads the value where
   * it has one, so a template with a hole nothing settles is no word.
   * Reading it as a name would give a word with a made-up segment.
   */
  evaluatedWith(
    bindings: ReadonlyMap<string, string>,
  ): string | number | boolean | null {
    const evaluate = this.facts.evaluatedWith;
    if (evaluate !== undefined) {
      return evaluate(this.key, bindings);
    }
    if (bindings.size === 0 && this.facts.evaluatedOf !== undefined) {
      return this.evaluated();
    }
    return this.name("nothing");
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

  writtenItems(): readonly string[] | null {
    return this.facts.writtenItemsOf?.(this.key) ?? null;
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

  /** The `comparesWith` rows on the value's own key, in the order stated. */
  comparisons(): readonly Comparison[] {
    return this.facts.db.lookup("comparesWith", 0, this.key).map((row) => ({
      left: factValueOps(String(row[1]), this.facts),
      operator: String(row[2]),
      right: factValueOps(String(row[3]), this.facts),
    }));
  }

  /** The adapter's reading where it has one, and otherwise the name of the class the facts settle the value to. */
  className(notFrom: readonly string[]): string | null {
    const adapters = this.facts.classNameOf;
    if (adapters !== undefined) {
      return adapters(this.key, notFrom);
    }
    return this.asClass()?.name() ?? null;
  }

  /** Read off the class the adapter's `classKeyOf` gives where it has one, so it is the class `className` read. */
  classAttribute(attribute: string, notFrom: readonly string[]): string | null {
    const adapters = this.facts.classKeyOf;
    if (adapters === undefined) {
      return this.asClass()?.attribute(attribute) ?? null;
    }
    const cls = adapters(this.key, notFrom);
    return cls === null
      ? null
      : new FactClass(cls, this.facts).attribute(attribute);
  }

  /** Asked of the settled value, as `asArg` is, so an encoding kept in a name is still read. */
  encoded(): Encoded | null {
    const found = this.facts.encodedOf?.(this.written()) ?? null;
    return found === null
      ? null
      : { codec: found.codec, value: factValueOps(found.value, this.facts) };
  }

  read(): ValueRead | null {
    const found = readThrough(this.key, this.facts);
    return found === null
      ? null
      : { key: found.name, object: factValueOps(found.object, this.facts) };
  }

  /** The read at the value's own key, or the one its callee is when the language writes a member read as a call. */
  memberRead(): ValueRead | null {
    const found =
      keyedRead(this.key, this.facts) ?? readAsCall(this.key, this.facts);
    return found === null
      ? null
      : { key: found.name, object: factValueOps(found.object, this.facts) };
  }

  /** `elementOf` on the value, or on what its one `binds` row takes it to, as TypeScript binds a reference to its declaration. */
  element(): ValueOps | null {
    const over =
      only(this.facts.db.lookup("elementOf", 0, this.key), 1) ??
      elementOfBound(this.key, this.facts);
    return over === null ? null : factValueOps(over, this.facts);
  }

  returnedItems(): readonly ValueOps[] | null {
    const keys = this.facts.returnedItemsOf?.(this.key) ?? null;
    return keys === null
      ? null
      : keys.map((key) => factValueOps(key, this.facts));
  }

  elementPart(): ValueOps | null {
    const over = only(this.facts.db.lookup("elementPartOf", 0, this.key), 1);
    return over === null ? null : factValueOps(over, this.facts);
  }

  /**
   * Whether the program declares the value as one of the origin's types.
   * A language that declares none settles it by the construction the
   * value was written as, as `receiverTyped` does.
   */
  typed(origin: Typed): boolean {
    const typedAs = this.facts.valueTypedAs;
    if (typedAs !== undefined) {
      return typedAs(this.key, origin);
    }
    const made = this.written();
    const callee = calleeOf(made, this.facts);
    return (
      callee !== null &&
      writtenFrom(
        {
          origin: "constructed",
          importedFrom: origin.importedFrom,
          ...(origin.named === undefined ? {} : { named: origin.named }),
        },
        callee,
        this.facts,
      )
    );
  }

  keysRead(): readonly string[] {
    return keysReadOff(this.key, this.facts);
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

  attributes(): readonly ValueEntry[] {
    const named = new Set<string>();
    return [...this.facts.db.lookup("jsxAttribute", 0, this.written())]
      .sort((a, b) => bySourceOrder(String(a[2]), String(b[2])))
      .flatMap((row) => {
        const name = String(row[1]);
        if (named.has(name)) {
          return [];
        }
        named.add(name);
        return [{ key: name, value: factValueOps(String(row[2]), this.facts) }];
      });
  }

  elementsWithin(): readonly ValueOps[] {
    return inSourceOrder(
      this.facts.db
        .lookup("jsxParent", 1, this.written())
        .map((row) => String(row[0])),
    ).map((element) => factValueOps(element, this.facts));
  }

  /** Read off the value a name was written as, never off what a call returns, so a list a function builds is not this one. */
  listed(): ListedValues | null {
    const list = this.written();
    if (this.facts.shapeOf(list) !== "list") {
      return null;
    }
    return {
      key: list,
      entries: [...this.facts.db.lookup("writtenEntryAt", 0, list)]
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map(
          (row): ListedEntry => ({
            form: row[3] === "spread" ? "spread" : "value",
            value: factValueOps(String(row[2]), this.facts),
          }),
        ),
    };
  }

  asClass(): FactClass | null {
    const cls = classBehind(this.key, this.facts);
    return cls === null ? null : new FactClass(cls, this.facts);
  }

  /** Asked of the value as written here, as a read site's object is. */
  runtimePath(object: RuntimeObject): string | undefined {
    const adapters = this.facts.runtimePathOf;
    if (adapters !== undefined) {
      return adapters(this.key, object);
    }
    return RUNTIME_PATH[object.origin](this.key, object as never, this.facts);
  }

  globalPath(paths: readonly string[]): string | null | undefined {
    return globalAt(this.key, paths, this.facts);
  }

  /** Asked of the value as written here, so a name for a schema says nothing. */
  mentions(words: CallsAndOptions): boolean {
    return mentionsWords(this.key, words, this.facts);
  }

  /** Followed, the value is read the way `receiver()` reads a receiver, so the two give one site for one construction. */
  asCall(how?: AsCallFollowing): CallOps | null {
    const key =
      how === undefined
        ? this.key
        : madeThroughProjectCall(
            settled(
              this.key,
              this.facts,
              how.follow,
              "site" in how ? how.site : undefined,
            ),
            this.facts,
          );
    return factCallOps(key, this.facts);
  }

  asCalls(): readonly CallOps[] {
    if (this.asCall({ follow: "namesAndFields" }) !== null) {
      return [];
    }
    return (this.facts.writtenAsEach?.(this.key) ?? []).flatMap(
      (key) => factCallOps(key, this.facts) ?? [],
    );
  }

  nothing(): boolean {
    return this.facts.writesNothing?.(this.key) ?? false;
  }

  elements(tag: string): readonly ElementOps[] {
    const found = functionBehind(this.key, this.facts);
    const written =
      found === null ? [] : (this.facts.elementsOf?.(found) ?? []);
    return written
      .filter((element) =>
        this.facts.db
          .lookup("jsxElement", 0, element)
          .some((row) => this.facts.textOf(String(row[1])) === tag),
      )
      .map((element) => new FactElement(element, this.facts));
  }

  parameterAt(fn: ValueOps): number | null {
    const written = keysOfValues.get(fn) ?? null;
    const func = written === null ? null : functionBehind(written, this.facts);
    return func === null ? null : parameterPosition(this.key, func, this.facts);
  }

  declaration(): Declaration | null {
    return declarationAt(this.key, this.facts, new Set());
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

class FactElement implements ElementOps {
  constructor(
    private readonly key: string,
    private readonly facts: FactSource,
  ) {}

  tag(): string {
    const [row] = this.facts.db.lookup("jsxElement", 0, this.key);
    return row === undefined ? "" : this.facts.textOf(String(row[1]));
  }

  attributes(): readonly ElementAttribute[] {
    return this.facts.db.lookup("jsxAttribute", 0, this.key).map((row) => ({
      name: String(row[1]),
      value: factValueOps(String(row[2]), this.facts),
    }));
  }

  props(): readonly string[] {
    return this.facts.db
      .lookup("jsxAttribute", 0, this.key)
      .map((row) => String(row[1]));
  }

  spreads(): readonly ValueOps[] {
    return this.facts.db
      .lookup("jsxSpread", 0, this.key)
      .map((row) => factValueOps(String(row[1]), this.facts));
  }

  hasChildren(): boolean {
    return this.facts.db.lookup("jsxChild", 0, this.key).length > 0;
  }
}

/**
 * The position of the function's parameter the value at `key` is: the
 * parameter itself, which is how Python and Ruby key a name for one, the
 * declaration the name binds to, or the parameter whose destructure has
 * that declaration as its rest. Null when it is none, or more than one.
 */
/**
 * Where the value at `key` is declared: by the adapter's own reading or
 * the facts, and failing both, for a member read off an object the
 * module writes out, `Card.Root` with `Card = { Root: CardRoot }`, where
 * the value the object has under that name is declared.
 */
function declarationAt(
  key: string,
  source: FactSource,
  seen: Set<string>,
): Declaration | null {
  if (seen.has(key)) {
    return null;
  }
  seen.add(key);
  const declared =
    source.declarationOf === undefined
      ? declarationInFacts(key, source, new Set())
      : source.declarationOf(key);
  return declared ?? memberDeclaration(key, source, seen);
}

function memberDeclaration(
  key: string,
  source: FactSource,
  seen: Set<string>,
): Declaration | null {
  for (const [, object, name] of source.db.lookup("readsProperty", 0, key)) {
    const member =
      factValueOps(String(object), source).object?.()?.property(String(name)) ??
      null;
    const memberKey = member === null ? undefined : keysOfValues.get(member);
    if (memberKey !== undefined) {
      return declarationAt(memberKey, source, seen);
    }
  }
  return null;
}

/**
 * Where the value at `key` is declared, for an adapter that states every
 * fact up front: through `imports` to what the module exports, or else the
 * `exportsAs` row of the value or what it `binds` to in its own file.
 */
function declarationInFacts(
  key: string,
  source: FactSource,
  seen: Set<string>,
): Declaration | null {
  if (seen.has(key)) {
    return null;
  }
  seen.add(key);
  const imported = source.db.lookup("imports", 0, key);
  if (imported.length > 0) {
    return importedDeclaration(imported, source, seen);
  }
  for (const declared of [
    key,
    ...source.db.lookup("binds", 0, key).map((row) => String(row[1])),
  ]) {
    const [row] = source.db.lookup("exportsAs", 2, declared);
    if (row !== undefined) {
      return { file: String(row[0]), name: String(row[1]) };
    }
  }
  return null;
}

/**
 * What one of the modules a name was imported from exports under the
 * imported name. A module that imports that name in turn passes it on,
 * and the module that writes it is the declaration.
 */
function importedDeclaration(
  imported: readonly (readonly unknown[])[],
  source: FactSource,
  seen: Set<string>,
): Declaration | null {
  for (const [, module, name] of imported) {
    const exported = source.db
      .lookup("exportsAs", 0, String(module))
      .find((row) => row[1] === name);
    if (exported === undefined) {
      continue;
    }
    const value = String(exported[2]);
    return source.db.lookup("imports", 0, value).length > 0
      ? declarationInFacts(value, source, seen)
      : { file: String(module), name: String(name) };
  }
  return null;
}

/** Whether the call passes `func`'s parameters at their own positions, and nothing else by position. */
function passesParametersInOrder(
  call: string,
  func: string,
  source: FactSource,
): boolean {
  const parameters = source.db.lookup("paramOf", 0, func).length;
  const passed = source.db.lookup("callArg", 0, call);
  return (
    passed.length === parameters &&
    passed.every(
      (row) =>
        parameterPosition(String(row[2]), func, source) === Number(row[1]),
    )
  );
}

function parameterPosition(
  key: string,
  func: string,
  source: FactSource,
): number | null {
  const declared = [
    key,
    ...source.db.lookup("binds", 0, key).map((row) => String(row[1])),
  ];
  const parameters = new Set(
    declared.flatMap((declaration) => [
      declaration,
      ...source.db
        .lookup("restOf", 0, declaration)
        .map((row) => String(row[1])),
    ]),
  );
  const positions = new Set(
    source.db
      .lookup("paramOf", 0, func)
      .filter((row) => parameters.has(String(row[2])))
      .map((row) => Number(row[1])),
  );
  const [one] = positions;
  return positions.size === 1 && one !== undefined ? one : null;
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

/**
 * The one path among `paths` the value at the key is: the one it is
 * spelled as, or else the one the rules followed into it, such as a
 * parameter a caller passed `sys.stderr` to. Null when two of them reach
 * it, and undefined when none does.
 */
function globalAt(
  key: string,
  paths: readonly string[],
  facts: FactSource,
): string | null | undefined {
  const spelled = paths.find(
    (path) => facts.spellsGlobal?.(key, path) === true,
  );
  if (spelled !== undefined) {
    return spelled;
  }
  const reaching = new Set(
    (facts.globalsReaching?.(key) ?? []).filter((path) => paths.includes(path)),
  );
  if (reaching.size === 0) {
    return undefined;
  }
  const [one] = reaching;
  return reaching.size === 1 && one !== undefined ? one : null;
}

/**
 * The path a value is among a runtime object's, for an adapter that does
 * not work it out itself: the one it is spelled as, or the first when
 * the rules followed one of them into it.
 */
const RUNTIME_PATH: {
  readonly [K in RuntimeObject["origin"]]: (
    key: string,
    object: Extract<RuntimeObject, { origin: K }>,
    facts: FactSource,
  ) => string | undefined;
} = {
  global: (key, object, facts) => {
    const spelled = object.paths.find(
      (path) => facts.spellsGlobal?.(key, path) === true,
    );
    if (spelled !== undefined) {
      return spelled;
    }
    const reached = (facts.globalsReaching?.(key) ?? []).some((path) =>
      object.paths.includes(path),
    );
    return reached ? object.paths[0] : undefined;
  },
  handedIn: (key, object, facts) =>
    handedInAs(key, object.name, facts) ? object.name : undefined,
};

/**
 * The calls written in a function, the ones in every function inside it
 * included, in source order: `makesCall` closed over `containsFn`, the
 * way the `callInBody` rule reads them.
 */
function callsWrittenIn(func: string, source: FactSource): string[] {
  const calls: string[] = [];
  const seen = new Set<string>();
  const visit = (fn: string): void => {
    if (seen.has(fn)) {
      return;
    }
    seen.add(fn);
    source.read(fn);
    for (const row of source.db.lookup("makesCall", 0, fn)) {
      calls.push(String(row[1]));
    }
    for (const row of source.db.lookup("containsFn", 0, fn)) {
      visit(String(row[1]));
    }
  };
  visit(func);
  return inSourceOrder(calls);
}

/**
 * Whether a value is written with a call to one of the words' calls, or
 * sets one of their options. The walk goes from a call to its callee and
 * from a member read to its object, which is the receiver, and into
 * arguments, entries and the branches of a fallback or a conditional. A
 * method's name is the member read's, and a bare callee's is the export
 * its import binds. A function written in the value runs later, so the
 * walk does not go into one.
 */
function mentionsWords(
  key: string,
  words: CallsAndOptions,
  source: FactSource,
): boolean {
  const { db } = source;
  const seen = new Set<string>();
  const pending = [key];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (seen.has(at)) {
      continue;
    }
    seen.add(at);
    source.read(at);
    if (isFunction(at, source)) {
      continue;
    }
    for (const row of db.lookup("call", 0, at)) {
      const callee = String(row[1]);
      if (calleeNames(callee, source).some((n) => words.calls.includes(n))) {
        return true;
      }
      pending.push(callee);
    }
    for (const relation of NAMED_ENTRIES) {
      for (const row of db.lookup(relation, 0, at)) {
        if (words.options.includes(String(row[1]))) {
          return true;
        }
        pending.push(String(row[2]));
      }
    }
    pending.push(
      ...MENTION_STEPS.flatMap(([relation, column]) =>
        db.lookup(relation, 0, at).map((row) => String(row[column])),
      ),
    );
  }
  return false;
}

/**
 * The relations whose rows state a value under a name: an object's
 * entry, and an argument passed under a keyword, which is how Python and
 * Ruby set an option.
 */
const NAMED_ENTRIES = ["holdsProperty", "callKeywordArg"] as const;

/** The other relations `mentionsWords` follows from a value, and the column each one leads on to. */
const MENTION_STEPS: readonly (readonly [string, number])[] = [
  ["readsProperty", 1],
  ["callArg", 2],
  ["fallbackBranch", 1],
  ["conditionalBranch", 1],
];

/** The names a callee is called by: a member read's name, or the export a bare name's import binds. */
function calleeNames(callee: string, source: FactSource): string[] {
  source.read(callee);
  const read = memberRead(callee, source);
  if (read !== null) {
    return [read.name];
  }
  return importRowsOf(callee, source.db).map((row) => String(row[2]));
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
    if (isClassWritten(candidate, source)) {
      return candidate;
    }
  }
  return null;
}

/** An object with no written shape that is no function is a class, since every adapter states a class as an `objectValue`. */
function isClassWritten(key: string, source: FactSource): boolean {
  return (
    source.db.lookup("objectValue", 0, key).length > 0 &&
    source.shapeOf(key) === null &&
    !isFunction(key, source)
  );
}

/** The string the class at the key assigns to the attribute in its body, for an adapter that names a class outside a chain. */
export function classAttributeAt(
  classKey: string,
  attribute: string,
  facts: FactSource,
): string | null {
  return new FactClass(classKey, facts).attribute(attribute);
}

class FactClass implements ClassValueOps {
  constructor(
    private readonly key: string,
    private readonly facts: FactSource,
  ) {}

  inherits(spec: Inherits): boolean {
    return inheritsFrom(this.key, spec, this.facts);
  }

  /** `extendsNamed`, which every adapter states for a written base and none for a mixin. */
  writesBase(): boolean {
    return this.facts.db.lookup("extendsNamed", 0, this.key).length > 0;
  }

  members(kind: "instance" | "singleton"): readonly ModuleMember[] {
    return this.facts.db.lookup("holdsProperty", 0, this.key).flatMap((row) => {
      const stated = String(row[1]);
      const own = classMemberOf(stated);
      const name = kind === "singleton" ? own : own === null ? stated : null;
      const held = String(row[2]);
      return name === null || !isFunction(held, this.facts)
        ? []
        : [memberAt(name, held, this.facts)];
    });
  }

  /** The `holdsProperty` rows whose value is a class written at that spot, as a nested class statement states one. */
  classes(): readonly ModuleMember[] {
    return this.facts.db
      .lookup("holdsProperty", 0, this.key)
      .filter((row) => isClassWritten(String(row[2]), this.facts))
      .sort((a, b) => bySourceOrder(String(a[2]), String(b[2])))
      .map((row) => memberAt(String(row[1]), String(row[2]), this.facts));
  }

  /** The string the `holdsProperty` rows under the name state, shared or the class's own, when they agree on one. */
  attribute(name: string): string | null {
    const strings = new Set(
      this.facts.db
        .lookup("holdsProperty", 0, this.key)
        .filter((row) => {
          const stated = String(row[1]);
          return stated === name || classMemberOf(stated) === name;
        })
        .map((row) => this.facts.literalOf(String(row[2])))
        .flatMap((literal) => (typeof literal === "string" ? [literal] : [])),
    );
    const [one] = strings;
    return strings.size === 1 && one !== undefined ? one : null;
  }

  /** `rbConstantName` in Ruby, which gives a nested class its full name, and `exportsAs` elsewhere. */
  name(): string | null {
    const { db } = this.facts;
    return (
      only(db.lookup("rbConstantName", 0, this.key), 1) ??
      only(db.lookup("exportsAs", 2, this.key), 1)
    );
  }

  /** `classBodyCall` through the adapter, which asks the rules, or the body's own statements without it. */
  bodyCalls(): readonly CallOps[] {
    const asked = this.facts.classBodyCalls?.(this.key);
    if (asked === undefined) {
      return bodyCallsOf(this.key, this.facts);
    }
    return asked.flatMap((key) => {
      const ops = factCallOps(key, this.facts);
      return ops === null ? [] : [ops];
    });
  }

  /** The `holdsProperty` and `declaresDefault` rows on the class whose value is a call. */
  fieldCalls(): readonly FieldCall[] {
    const { db } = this.facts;
    const assigned = [
      ...db.lookup("holdsProperty", 0, this.key),
      ...db.lookup("declaresDefault", 0, this.key),
    ].sort((a, b) => bySourceOrder(String(a[2]), String(b[2])));
    return assigned.flatMap((row) => {
      const call = factCallOps(String(row[2]), this.facts);
      const stated = String(row[1]);
      return call === null
        ? []
        : [{ name: classMemberOf(stated) ?? stated, call }];
    });
  }
}

/** The value comes first, since making it states the facts the line is read from. */
function memberAt(name: string, key: string, source: FactSource): ModuleMember {
  const value = factValueOps(key, source);
  return { name, value, line: source.lineOf?.(key) ?? null };
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
    return (
      writesListedBase(key, spec, source) ||
      source.db.lookup("extends", 0, key).some((row) => {
        const base = String(row[1]);
        return (
          isListedBase(base, spec, source) ||
          (source.comesTo?.(base) ?? []).some(reaches)
        );
      })
    );
  };
  return reaches(cls);
}

/** Whether a base the class writes by name, `extendsNamed`, is one the adapter says the spec spells. */
function writesListedBase(
  cls: string,
  spec: Inherits,
  source: FactSource,
): boolean {
  const spells = source.spellsBase;
  return (
    spells !== undefined &&
    source.db
      .lookup("extendsNamed", 0, cls)
      .some((row) => spells(String(row[1]), spec))
  );
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
  /** The calls the module body runs outside every function, or every call the file writes for `file`, in source order. */
  calls(scope: CallScope): readonly CallOps[];
  /** The keys of the classes and modules the file writes, nested ones included, in source order. Unset lists none. */
  classes?(): readonly string[];
  /** The keys of every JSX element the file writes, in source order, with their rows stated. Unset where the language writes no JSX. */
  elements?(): readonly string[];
  /** The file's named imports of the modules, the name the file uses to the name the module exports. Unset lists none. */
  importedNames?(modules: readonly string[]): ReadonlyMap<string, string>;
  /** The names the file binds to one of the modules imported whole. Unset lists none. */
  importedWhole?(modules: readonly string[]): ReadonlySet<string>;
  /** Every function the file writes, with the variable or property it is assigned to. Unset where the language writes no directive. */
  functions?(): readonly {
    readonly key: string;
    readonly assignedName: string | null;
  }[];
  /**
   * The functions and classes the file writes under a decorator, nested
   * ones included, in source order, each with the name it is declared
   * under and its `decoratedWith` rows stated. Unset where the language
   * writes no decorators.
   */
  decorated?(): readonly {
    readonly key: string;
    readonly name: string | null;
  }[];
  /** Asks about the receivers of the file's decorators or calls with these methods in one go, as `ModuleOps.readingReceivers` says. Unset asks about each when it is read. */
  readingReceivers?(
    methods: ReadonlySet<string>,
    of: "decorators" | "calls",
  ): void;
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

  calls(scope: CallScope = "moduleBody"): readonly CallOps[] {
    return this.written.calls(scope);
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

  elements(): readonly ValueOps[] {
    return (this.written.elements?.() ?? [])
      .filter((key) => this.facts.db.lookup("jsxParent", 0, key).length === 0)
      .map((key) => factValueOps(key, this.facts));
  }

  importedNames(modules: readonly string[]): ReadonlyMap<string, string> {
    return this.written.importedNames?.(modules) ?? new Map();
  }

  importedWhole(modules: readonly string[]): ReadonlySet<string> {
    return this.written.importedWhole?.(modules) ?? new Set();
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

  decorated(): readonly DecoratedDefinition[] {
    return (this.written.decorated?.() ?? []).flatMap(({ key, name }) => {
      const decorators = inSourceOrder(
        this.facts.db
          .lookup("decoratedWith", 0, key)
          .map((row) => String(row[1])),
      );
      return decorators.length === 0
        ? []
        : [
            {
              definition: factValueOps(key, this.facts),
              name,
              decorators: decorators.map((decorator) =>
                decoratorAt(decorator, this.facts),
              ),
            },
          ];
    });
  }

  readingReceivers(
    methods: ReadonlySet<string>,
    of: "decorators" | "calls",
  ): void {
    this.written.readingReceivers?.(methods, of);
  }

  private listExports(): ModuleMember[] {
    this.state();
    const named =
      this.written.exports?.() ??
      this.facts.db
        .lookup("exportsAs", 0, this.file)
        .map((row) => ({ name: String(row[1]), key: String(row[2]) }));
    return named.map(({ name, key }) => memberAt(name, key, this.facts));
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

/** A decorator's expression as call ops when it is a call, and as value ops otherwise. */
function decoratorAt(key: string, source: FactSource): Decorator {
  const call = isCall(key, source) ? factCallOps(key, source) : null;
  return call === null
    ? { form: "value", value: factValueOps(key, source) }
    : { form: "call", call };
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
 * is the call the field was written as. `writtenAs` follows any value,
 * so a call goes to what the adapter's rules say it was written as, as
 * the construction at `site` made the instance when one is given.
 */
function settled(
  key: string,
  source: FactSource,
  following: "names" | "namesAndFields" | "writtenAs",
  site?: string,
): string {
  const followed =
    following === "writtenAs" ||
    isName(key, source) ||
    (following === "namesAndFields" && memberRead(key, source) !== null);
  if (!followed) {
    return key;
  }
  return writtenUnderSite(key, source, site) ?? key;
}

/** What the key was written as, under the construction at `site` when the adapter can read one. */
function writtenUnderSite(
  key: string,
  source: FactSource,
  site: string | undefined,
): string | null {
  return site === undefined || source.writtenUnder === undefined
    ? source.writtenAs(key)
    : source.writtenUnder(key, site);
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

/**
 * The one read written at the value, `o.n` or `o["n"]`, or the one a name
 * set to a read was written as, `text` after `const text = record.body`,
 * the way a member read kept in a local is read. Null for anything else.
 */
function readThrough(key: string, source: FactSource): KeyedRead | null {
  const direct = keyedRead(key, source);
  if (direct !== null || !isName(key, source)) {
    return direct;
  }
  const reads = declaredValuesOf(key, source).flatMap((value) => {
    const read = keyedRead(value, source);
    return read === null ? [] : [read];
  });
  const [one, ...more] = reads;
  return one === undefined || more.length > 0 ? null : one;
}

/**
 * The read a call with no arguments is, in a language that writes a
 * member read that way: Ruby's `Entry.id` reads `id` off `Entry` through
 * its callee. Null for a call that passes anything.
 */
function readAsCall(key: string, source: FactSource): KeyedRead | null {
  const callee = only(source.db.lookup("call", 0, key), 1);
  const { db } = source;
  if (
    source.readsMembersAsCalls !== true ||
    callee === null ||
    db.lookup("callArg", 0, key).length > 0 ||
    db.lookup("callKeywordArg", 0, key).length > 0 ||
    db.lookup("callBlock", 0, key).length > 0
  ) {
    return null;
  }
  return keyedRead(callee, source);
}

/** A read of one key off an object, as the facts key both. */
interface KeyedRead {
  readonly object: string;
  readonly name: string;
}

/** The object and the key a read is written with, a property or an entry, or null. */
function keyedRead(key: string, source: FactSource): KeyedRead | null {
  source.read(key);
  const reads = new Map<string, KeyedRead>();
  for (const read of [
    ...propertiesReadAt(key, source),
    ...entriesReadAt(key, source),
  ]) {
    reads.set(`${read.object}\u0000${read.name}`, read);
  }
  const [one, ...more] = reads.values();
  return one === undefined || more.length > 0 ? null : one;
}

function propertiesReadAt(key: string, source: FactSource): KeyedRead[] {
  return source.db.lookup("readsProperty", 0, key).flatMap((row) => {
    const stated = String(row[2]);
    const name =
      source.memberName === undefined ? stated : source.memberName(stated);
    return name === null ? [] : [{ object: String(row[1]), name }];
  });
}

function entriesReadAt(key: string, source: FactSource): KeyedRead[] {
  return source.db
    .lookup("readsEntry", 0, key)
    .map((row) => ({ object: String(row[1]), name: String(row[2]) }));
}

/** The collection the one name a value's `binds` row takes it to is given an element of. */
function elementOfBound(key: string, source: FactSource): string | null {
  const bound = only(source.db.lookup("binds", 0, key), 1);
  if (bound === null) {
    return null;
  }
  source.read(bound);
  return only(source.db.lookup("elementOf", 0, bound), 1);
}

/**
 * The keys the program reads off the value, each once, in the order the
 * reads are written. A read that is a call's callee or an assignment's
 * target is not a key the program reads.
 */
function keysReadOff(key: string, source: FactSource): string[] {
  const sites = source.readSitesOf?.(key) ?? readSitesOff(key, source);
  const keys = [...new Set(sites)]
    .filter(
      (site) =>
        source.db.lookup("call", 1, site).length === 0 &&
        source.db.lookup("assigns", 0, site).length === 0,
    )
    .sort(sitesByFileAndStart)
    .flatMap((site) =>
      [...propertiesReadAt(site, source), ...entriesReadAt(site, source)].map(
        (read) => read.name,
      ),
    );
  return [...new Set(keys)];
}

/**
 * The read sites off the value, off each name `binds` takes to it, and
 * off each reference `binds` takes to that name, for an adapter that
 * states every read up front.
 */
function readSitesOff(key: string, source: FactSource): string[] {
  const names = boundTo(key, source);
  const holders = [
    key,
    ...names,
    ...names.flatMap((name) => boundTo(name, source)),
  ];
  return holders.flatMap((holder) => [
    ...(source.readsOff?.(holder) ?? []),
    ...source.db
      .lookup("readsProperty", 1, holder)
      .map((row) => String(row[0])),
    ...source.db.lookup("readsEntry", 1, holder).map((row) => String(row[0])),
  ]);
}

/** The keys whose `binds` row takes them to this one: the names it is kept in. */
function boundTo(key: string, source: FactSource): string[] {
  return source.db.lookup("binds", 1, key).map((row) => String(row[0]));
}

/**
 * Two read sites in the order the source writes them, file by file. A
 * site with no span keeps the place the adapter listed it in.
 */
function sitesByFileAndStart(a: string, b: string): number {
  const first = spanOfKey(a);
  const second = spanOfKey(b);
  if (first === null || second === null) {
    return 0;
  }
  return first.file === second.file
    ? first.start - second.start
    : first.file.localeCompare(second.file);
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

/**
 * Whether the value at `key` was imported as the origin asks, by the
 * file's own import statements: a name an import binds, a member read
 * off a whole module, or a name written as one of those. A parameter is
 * from no import, as a callee is, since following one through its
 * callers would ask the rules at every site. Undefined only when an
 * import binds the name to a project file, whose own names the rules
 * follow.
 */
function importSettled(
  origin: Imported,
  key: string,
  source: FactSource,
): boolean | undefined {
  const rows = importRowsOf(key, source.db);
  if (rows.length > 0) {
    return importsSettle(rows, importsAsked(origin, key, source), source);
  }
  const read = memberRead(key, source);
  const objectRows = read === null ? [] : importRowsOf(read.object, source.db);
  if (read !== null && objectRows.length > 0) {
    const whole = importNamesOf(read.object, origin.importedFrom, source);
    return importsSettle(
      objectRows,
      whole.includes("*") && namesAsked(origin, read.name),
      source,
    );
  }
  const written = source.writtenAs(key);
  return written !== null && importRowsOf(written, source.db).length > 0
    ? importSettled(origin, written, source)
    : false;
}

/** Whether a name an import binds is one the origin asks for. */
function importsAsked(
  origin: Imported,
  key: string,
  source: FactSource,
): boolean {
  return importNamesOf(key, origin.importedFrom, source).some((name) =>
    namesAsked(origin, name),
  );
}

function namesAsked(origin: Imported, name: string): boolean {
  return origin.named === undefined || origin.named.includes(name);
}

/** True when the imports say yes, and otherwise false, unless one of them is of a project file. */
function importsSettle(
  rows: readonly (readonly unknown[])[],
  asked: boolean,
  source: FactSource,
): boolean | undefined {
  if (asked) {
    return true;
  }
  return rows.some((row) => importsProjectFile(String(row[1]), source))
    ? undefined
    : false;
}

/** Whether a file in the run is the module an import row names. */
function importsProjectFile(module: string, source: FactSource): boolean {
  return source.db.lookup("importsFile", 1, module).length > 0;
}

/** The exports of the modules the file's own import statements bind the name at `key` to, `*` for a whole module. */
function importNamesOf(
  key: string,
  modules: readonly string[],
  source: FactSource,
): readonly string[] {
  return source.importedUnder === undefined
    ? importedUnder(key, modules, source.db)
    : source.importedUnder(key, modules);
}

/**
 * Whether `made`, a construction or a callee, came from one of the
 * origin's modules under an export it asks for, by the import rows of
 * the name it starts from, as `writtenFrom` asks the rules. Undefined
 * when that name has no import and the export is one the origin asks for.
 */
function madeSettled(
  origin: ConstructedFrom,
  made: string,
  source: FactSource,
): boolean | undefined {
  const written = calleeOf(made, source) ?? made;
  const modules = origin.importedFrom.filter((module) =>
    namedAs(origin, written, module, source),
  );
  if (modules.length === 0) {
    return false;
  }
  const root = rootOf(written, source);
  const rows = importRowsOf(root, source.db);
  return rows.length === 0
    ? undefined
    : importsSettle(
        rows,
        importNamesOf(root, modules, source).length > 0,
        source,
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

/** The names the name at `key` was imported under from one of the modules. */
function importedUnder(
  key: string,
  modules: readonly string[],
  db: FactSource["db"],
): string[] {
  return importRowsOf(key, db)
    .filter((row) => modules.includes(String(row[1])))
    .map((row) => String(row[2]));
}

/** The `imports` rows of the name at `key`, or of what it binds to, as `boundByImport` reads them. */
function importRowsOf(
  key: string,
  db: FactSource["db"],
): readonly (readonly unknown[])[] {
  return [
    key,
    ...db.lookup("binds", 0, key).map((row) => String(row[1])),
  ].flatMap((one) => db.lookup("imports", 0, one));
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
