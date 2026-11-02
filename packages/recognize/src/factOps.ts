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

import type { Database } from "@suss/datalog";
import type {
  CallOps,
  EffectArg,
  ReceiverOrigin,
  UnsettledName,
  ValueEntry,
  ValueOps,
} from "@suss/extractor";

/** What an adapter hands the ops: its facts, and the reads only it can make. */
export interface FactSource {
  readonly db: Database;
  /** Make sure the facts about this key are in `db`. An adapter that states every fact up front does nothing. */
  read(key: string): void;
  /** The key a name or field was written as, by the adapter's own rules, or null. */
  writtenAs(key: string): string | null;
  /** Every call the anchor rules reach behind a value. */
  anchorCalls(key: string): readonly string[];
  /** Whether the value at this key was imported from the module. */
  importedFrom(key: string, module: string): boolean;
  /** Whether a written-out value is an object, a list, or neither. */
  shapeOf(key: string): "object" | "list" | null;
  /** The source text at the key. */
  textOf(key: string): string;
  /** The literal written at the key, or null when it is not one. */
  literalOf(key: string): string | number | boolean | null;
  /** The name the value gives, read the adapter's way. */
  nameOf(key: string, unsettled: UnsettledName): string | null;
  /** The name the key of an object entry gives when the source computes it, `{ [table]: ... }`, read the way `nameOf` reads. */
  computedKeyOf?(held: string, unsettled: UnsettledName): string | null;
  /** Every string the value can be, when the adapter limits it to a few. */
  namesOf?(key: string, cap: number): readonly string[] | null;
  /** The value as an effect argument. */
  argOf(key: string): EffectArg | null;
  /** Whether the call goes to a method the project wrote, which no library made. */
  callsProjectMethod?(call: string): boolean;
  /** What a call into one of the project's own functions returns, as written. */
  returnedBy?(call: string): string | null;
  /** Whether a library declared the method the call reaches for, when the adapter can tell. */
  declares?(call: string, module: string): boolean;
}

/** The ops for the call at `key`, or null when no call is stated there. */
export function factCallOps(key: string, source: FactSource): CallOps | null {
  source.read(key);
  const callee = only(source.db.lookup("call", 0, key), 1);
  if (callee === null) {
    return null;
  }
  return new FactCall(key, callee, source);
}

/** The ops for the value at `key`. */
export function factValueOps(key: string, source: FactSource): ValueOps {
  return new FactValue(key, source);
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

  receiverIsFrom(origin: ReceiverOrigin): boolean {
    return RECEIVER_ORIGIN[origin.origin](origin, this);
  }

  isFrom(origin: ReceiverOrigin): boolean {
    return CALL_ORIGIN[origin.origin](origin, this);
  }

  anchorCall(origin: ReceiverOrigin): CallOps | null {
    if (origin.origin !== "constructed") {
      return null;
    }
    const subject = this.member?.object ?? this.calleeKey;
    const matching = new Set(
      this.source
        .anchorCalls(subject)
        .filter((candidate) => this.madeFrom(origin, candidate)),
    );
    const [one] = matching;
    return matching.size === 1 && one !== undefined
      ? factCallOps(one, this.source)
      : null;
  }

  /** Whether the library behind `origin` declared this call's method. */
  declaredBy(origin: ReceiverOrigin): boolean {
    const declares = this.source.declares;
    return (
      this.member !== null &&
      declares !== undefined &&
      origin.importedFrom.some((module) => declares(this.key, module))
    );
  }

  /** Whether the receiver was made from one of the origin's modules, as written or through a project function. */
  receiverConstructed(origin: ReceiverOrigin): boolean {
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

  /** Whether the callee as the source wrote it came from one of the origin's modules. */
  calleeConstructed(origin: ReceiverOrigin): boolean {
    return (
      namedAs(origin, constructorName(this.calleeKey, this.source)) &&
      origin.importedFrom.some((module) =>
        this.source.importedFrom(rootOf(this.calleeKey, this.source), module),
      )
    );
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
  private madeFrom(origin: ReceiverOrigin, made: string): boolean {
    const callee = calleeOf(made, this.source);
    const written = callee ?? made;
    if (!namedAs(origin, constructorName(written, this.source))) {
      return false;
    }
    const root = rootOf(written, this.source);
    return origin.importedFrom.some((module) =>
      this.source.importedFrom(root, module),
    );
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
const RECEIVER_ORIGIN: Record<
  ReceiverOrigin["origin"],
  (origin: ReceiverOrigin, call: FactCall) => boolean
> = {
  declaredBy: (origin, call) => call.declaredBy(origin),
  constructed: (origin, call) => call.receiverConstructed(origin),
};

/** How each kind of origin checks the call itself. */
const CALL_ORIGIN: Record<
  ReceiverOrigin["origin"],
  (origin: ReceiverOrigin, call: FactCall) => boolean
> = {
  declaredBy: (origin, call) => call.declaredBy(origin),
  constructed: (origin, call) => call.calleeConstructed(origin),
};

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
    const object = this.written();
    if (this.source.shapeOf(object) !== "object") {
      return [];
    }
    const named = new Map(
      this.source.db
        .lookup("holdsProperty", 0, object)
        .map((row) => [String(row[2]), String(row[1])]),
    );
    const computed = new Set(
      this.source.db
        .lookup("holdsUnderKey", 0, object)
        .map((row) => String(row[1])),
    );
    return entriesInOrder(object, this.source).flatMap((held) => {
      const value = factValueOps(held, this.source);
      const key = named.get(held);
      if (key !== undefined) {
        return [{ key, value }];
      }
      return computed.has(held)
        ? [{ key: this.source.computedKeyOf?.(held, unsettled) ?? null, value }]
        : [];
    });
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
    const object = this.written();
    if (this.source.shapeOf(object) !== "object") {
      return null;
    }
    const held = propertyOf(object, name, this.source);
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

/** The value an object has under a name, or null. */
function propertyOf(
  object: string,
  name: string,
  source: FactSource,
): string | null {
  const held = source.db
    .lookup("holdsProperty", 0, object)
    .filter((row) => row[1] === name)
    .map((row) => String(row[2]));
  return held.length === 1 ? (held[0] as string) : null;
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
  const [row, ...more] = source.db.lookup("readsProperty", 0, key);
  if (row === undefined || more.length > 0) {
    return null;
  }
  return { object: String(row[1]), name: String(row[2]) };
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

/** The rightmost name an expression is written with: the member for a read, else the text. */
function constructorName(key: string, source: FactSource): string {
  return memberRead(key, source)?.name ?? source.textOf(key);
}

/** Whether the export a value was made from is one the origin asks for. Unset takes any. */
function namedAs(origin: ReceiverOrigin, name: string): boolean {
  return (
    origin.origin !== "constructed" ||
    origin.named === undefined ||
    origin.named.includes(name)
  );
}

/** The one value in a column of these rows, or null for none or several. */
function only(
  rows: readonly (readonly unknown[])[],
  column: number,
): string | null {
  const values = new Set(rows.map((row) => String(row[column])));
  const [one] = values;
  return values.size === 1 && one !== undefined ? one : null;
}
