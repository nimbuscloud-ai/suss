/**
 * Which values in a method are its own receiver, or are made from it.
 *
 * A class method called on a subclass runs with that subclass as its
 * receiver, so `new` inside `def self.call = new(...).call` makes one of
 * whichever class the caller sent `call` to. One body serves every
 * caller, so the rules cannot know that class. They say which values
 * come from the receiver, and the walk that follows a call puts the
 * caller's class in their place. A variant is the walk's body for one
 * method on one subclass.
 *
 * DESIGN.md, under "A method that runs on a subclass", has the facts.
 */

import { constant, lit, rule, variable as v } from "@suss/datalog";

import type { Database, Rule } from "@suss/datalog";

/** What a caller asks through to list a class's members, its bases' included. */
export const MEMBERS_QUESTION = "wantedMembers";

/** The form a receiver takes when the method runs on the class itself. */
export const SELF_AS_CLASS_NAME = "class";
export const SELF_AS_CLASS = constant(SELF_AS_CLASS_NAME);

/** The form a receiver takes when the method runs on an instance. */
export const SELF_AS_INSTANCE_NAME = "instance";
export const SELF_AS_INSTANCE = constant(SELF_AS_INSTANCE_NAME);

export type SelfForm = typeof SELF_AS_CLASS_NAME | typeof SELF_AS_INSTANCE_NAME;

export const SELF_RULES: readonly Rule[] = [
  rule(
    "selfBehind",
    [v("s"), v("s"), v("form")],
    [lit("selfReceiver", v("f"), v("s"), v("form"))],
    "the receiver",
  ),
  // `klass = self` or `job = new(...)`. Only names, so a receiver passed
  // into another method is that method's parameter and never its own.
  rule(
    "selfBehind",
    [v("x"), v("s"), v("form")],
    [
      lit("nameHop", v("x"), v("y")),
      lit("selfBehind", v("y"), v("s"), v("form")),
    ],
    "a name for the receiver",
  ),
  // Calling the class makes one of it: Python's `cls(...)` and
  // TypeScript's `new this(...)`.
  rule(
    "selfBehind",
    [v("r"), v("s"), SELF_AS_INSTANCE],
    [
      lit("call", v("r"), v("c")),
      lit("selfBehind", v("c"), v("s"), SELF_AS_CLASS),
    ],
    "made from the receiver's class",
  ),

  // A method that returns its receiver, or one made from it, returns the
  // caller's: `Report.build(x)` is a Report when `build` is
  // `def self.build(x) = new(x)`, whichever class `build` is written in.
  rule(
    "selfResult",
    [v("r"), v("o"), v("form")],
    [
      lit("call", v("r"), v("c")),
      lit("readsProperty", v("c"), v("o"), v("n")),
      lit("invokes", v("r"), v("f")),
      lit("returnsValue", v("f"), v("ret")),
      lit("selfReceiver", v("f"), v("s"), v("any")),
      lit("selfBehind", v("ret"), v("s"), v("form")),
    ],
    "returns its receiver",
  ),
  rule(
    "selfResult",
    [v("x"), v("o"), v("form")],
    [
      lit("nameHop", v("x"), v("y")),
      lit("selfResult", v("y"), v("o"), v("form")),
    ],
    "a name for what it returned",
  ),
];

/** What asking `wanted` about a key says about the receivers behind it. */
export const SELF_QUESTIONS: readonly Rule[] = [
  rule(
    "wantedSelfBehind",
    [v("x"), v("s"), v("form")],
    [lit("wanted", v("x")), lit("selfBehind", v("x"), v("s"), v("form"))],
  ),
  rule(
    "wantedSelfResult",
    [v("x"), v("o"), v("form")],
    [lit("wanted", v("x")), lit("selfResult", v("x"), v("o"), v("form"))],
  ),
  // Every member a class has, its bases' included, and the ones a nearer
  // member overrides, for a walk that looks a method up on a subclass.
  rule(
    "wantedMemberOf",
    [v("cls"), v("n"), v("held")],
    [
      lit(MEMBERS_QUESTION, v("cls")),
      lit("contains", v("cls"), v("n"), v("held")),
    ],
  ),
  rule(
    "wantedMemberOverridden",
    [v("cls"), v("n"), v("h")],
    [
      lit(MEMBERS_QUESTION, v("cls")),
      lit("contains", v("cls"), v("n"), v("m")),
      lit("overrides", v("m"), v("n"), v("h")),
    ],
  ),
];

/**
 * The receiver a call was sent to when the method it ran returns that
 * receiver, or one made from it, and the form it returns. Null when the
 * key is no such call, or could be more than one.
 */
export function selfResultOf(
  db: Database,
  key: string,
): { readonly receiver: string; readonly form: SelfForm } | null {
  const rows = db.lookup("wantedSelfResult", 0, key);
  const [only] = rows;
  return rows.length === 1 && only !== undefined
    ? { receiver: String(only[1]), form: String(only[2]) as SelfForm }
    : null;
}

/**
 * The form in which a key asked about with `wanted` comes from this
 * receiver, or null when it does not, or when it comes from it both as
 * the class and as an instance.
 */
export function selfFormOf(
  db: Database,
  key: string,
  receiver: string,
): SelfForm | null {
  const forms = new Set(
    db
      .lookup("wantedSelfBehind", 0, key)
      .filter((row) => String(row[1]) === receiver)
      .map((row) => String(row[2]) as SelfForm),
  );
  const [only] = forms;
  return forms.size === 1 && only !== undefined ? only : null;
}

/** A class that inherits a method, by a file that declares it and its name. */
export interface SubclassPlace {
  readonly file: string;
  readonly name: string;
}

/**
 * Marks the end of a method's own key in a variant's key. A variant key
 * still starts with the method's key, so `fileOfKey` and the cache group
 * it with the method's file.
 */
const ON_SUBCLASS = "#on=";

/** The walk's key for a method running on a subclass. */
export function variantKey(key: string, subclass: SubclassPlace): string {
  return `${key}${ON_SUBCLASS}${encodeURIComponent(subclass.name)}@${encodeURIComponent(subclass.file)}`;
}

/** The method's own key, from its key or one of its variants' keys. */
export function plainKeyOf(key: string): string {
  const at = key.indexOf(ON_SUBCLASS);
  return at === -1 ? key : key.slice(0, at);
}

/** A method a walk reached on a subclass, as one of the walk's bodies. */
export interface ReceiverVariant {
  readonly key: string;
  /** Whether one of its calls goes somewhere else on the subclass than on the class the method is written in. */
  readonly differs: boolean;
  /** The keys of the bodies its calls reach. */
  readonly calls: readonly string[];
}

/**
 * The variants worth a summary of their own: one whose calls go
 * somewhere else on the subclass, and one that calls such a variant. Any
 * other variant does what the method does on its own class, so its
 * callers link to that summary instead.
 */
export function keptVariants(
  variants: readonly ReceiverVariant[],
): Set<string> {
  const callers = new Map<string, string[]>();
  for (const variant of variants) {
    for (const callee of variant.calls) {
      const known = callers.get(callee) ?? [];
      known.push(variant.key);
      callers.set(callee, known);
    }
  }
  const kept = new Set<string>();
  const queue = variants
    .filter((variant) => variant.differs)
    .map((variant) => variant.key);
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    if (kept.has(key)) {
      continue;
    }
    kept.add(key);
    queue.push(...(callers.get(key) ?? []));
  }
  return kept;
}
