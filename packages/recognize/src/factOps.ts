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

import type {
  ByOrigin,
  CallOps,
  ConstructedFrom,
  DeclaredBy,
  EffectArg,
  FactSource,
  Imported,
  ReceiverOrigin,
  ReturnedBy,
  Typed,
  UnsettledName,
  ValueEntry,
  ValueOps,
} from "@suss/extractor";

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
  const ops = new FactValue(key, source);
  return source.extendValue?.(key, ops) ?? ops;
}

class FactCall implements CallOps {
  private readonly member: { object: string; name: string } | null;
  private args: Map<number, string> | null = null;

  constructor(
    private readonly key: string,
    private readonly calleeKey: string,
    private readonly source: FactSource,
  ) {
    source.read(calleeKey);
    this.member = memberRead(calleeKey, source);
  }

  method(): string | null {
    return this.member?.name ?? null;
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
    if (this.member === null) {
      return null;
    }
    const made = madeThroughProjectCall(
      settled(this.member.object, this.source, "namesAndFields"),
      this.source,
    );
    return factCallOps(made, this.source);
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

  receiverIsFrom(origin: ReceiverOrigin): boolean {
    return byOrigin(receiverOrigin(this), origin);
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
    const subject = this.member?.object ?? this.calleeKey;
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
    if (this.member === null) {
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
    if (this.member === null) {
      return false;
    }
    const typedAs = this.source.typedAs;
    if (typedAs === undefined) {
      return this.receiverConstructed({
        origin: "constructed",
        importedFrom: origin.importedFrom,
        named: origin.named,
      });
    }
    return typedAs(this.key, origin);
  }

  /** Whether the receiver is a value the file imported as the origin says. */
  receiverImported(origin: Imported): boolean {
    return (
      this.member !== null &&
      importedAsAsked(origin, this.member.object, this.source)
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
    if (this.member === null) {
      return this.calleeKey;
    }
    const asWritten = this.source.writtenAs(this.member.object);
    const written =
      reading === "asWritten"
        ? asWritten
        : madeThroughProjectCall(asWritten, this.source);
    if (written === null || !isCall(written, this.source)) {
      return this.calleeKey;
    }
    return written;
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
    imported: (origin) => call.receiverImported(origin),
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
    imported: (origin) => call.calleeImported(origin),
  };
}

class FactValue implements ValueOps {
  private settledKey: string | null = null;

  constructor(
    private readonly key: string,
    private readonly source: FactSource,
  ) {
    source.read(key);
  }

  text(): string | null {
    const literal = this.source.literalOf(this.written());
    return typeof literal === "string" ? literal : null;
  }

  name(unsettled: UnsettledName): string | null {
    return this.source.nameOf(this.written(), unsettled);
  }

  names(cap: number): readonly string[] | null {
    return this.source.namesOf?.(this.key, cap) ?? null;
  }

  flag(): boolean | null {
    const literal = this.source.literalOf(this.written());
    if (typeof literal === "boolean") {
      return literal;
    }
    return typeof literal === "number" ? literal !== 0 : null;
  }

  entries(unsettled: UnsettledName): readonly ValueEntry[] {
    return lastValueWins(
      spreadEntries(this.written(), unsettled, this.source),
    ).map(({ key, held }) => ({ key, value: factValueOps(held, this.source) }));
  }

  items(): readonly ValueOps[] {
    const list = this.written();
    if (this.source.shapeOf(list) !== "list") {
      return [];
    }
    return entriesInOrder(list, this.source).map((held) =>
      factValueOps(held, this.source),
    );
  }

  property(name: string): ValueOps | null {
    const held = propertyOf(this.written(), name, this.source);
    return held === null ? null : factValueOps(held, this.source);
  }

  asArg(): EffectArg | null {
    return this.source.argOf(this.written());
  }

  parts(): readonly string[] | null {
    const written = this.written();
    const literal = this.source.literalOf(written);
    if (typeof literal === "string") {
      return [literal];
    }
    const pieces = templatePieces(written, this.source);
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
      factCallOps(settled(hole, this.source, "names"), this.source),
    );
  }

  interpolated(): readonly ValueOps[] {
    return this.holeKeys().map((hole) => factValueOps(hole, this.source));
  }

  private holeKeys(): string[] {
    return templatePieces(this.written(), this.source).flatMap((piece) =>
      piece.hole === null ? [] : [piece.hole],
    );
  }

  private written(): string {
    this.settledKey ??= settled(this.key, this.source, "names");
    return this.settledKey;
  }
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
 * turn.
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
  const turns = new Map<string, number>();
  return [...source.db.lookup("writtenEntryAt", 0, object)]
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .flatMap((row): WrittenEntry[] => {
      const held = String(row[2]);
      if (row[3] === "spread") {
        return [{ spread: held }];
      }
      const turn = turns.get(held) ?? 0;
      turns.set(held, turn + 1);
      const name = names.get(held)?.[turn];
      if (name !== undefined) {
        return [{ key: name, held }];
      }
      return computed.has(held)
        ? [{ key: computedKeyOf(held, computedKeys, source), held }]
        : [];
    });
}

function computedKeyOf(
  held: string,
  computedKeys: ComputedKeys,
  source: FactSource,
): string | null {
  if (computedKeys === "unread") {
    return null;
  }
  return source.computedKeyOf?.(held, computedKeys) ?? null;
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

/** The object a spread unpacks, settled the way any value is: a name is what the source wrote it as. */
function spreadObject(spread: string, source: FactSource): string {
  source.read(spread);
  return settled(spread, source, "names");
}

/**
 * The object an argument states. A command puts its inputs in the object
 * it was constructed with, so a construction is read as the object in it.
 */
function objectAt(
  argument: string | undefined,
  source: FactSource,
): string | null {
  if (argument === undefined) {
    return null;
  }
  const written = settled(argument, source, "names");
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
    source.importedAs(written, module).some((name) => asked.includes(name))
  );
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
