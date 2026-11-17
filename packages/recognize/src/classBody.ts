/**
 * What a library reads out of a class body, declared as data, and the
 * reader that finds it through the ops every adapter hands out.
 *
 * ActiveRecord's `has_many :items`, `after_commit :sync, on: :create`
 * and `scope :recent, -> { ... }` are calls a model writes in its body,
 * outside every method, and SQLAlchemy's `items = relationship("Item")`
 * is a field assigned from a call. A declaration says which calls and
 * which fields mean what. The reader returns what each class declares
 * and states no fact: the adapter turns the results into the facts its
 * rules read, since only it knows how its language inflects a name or
 * keys a class.
 */

import type {
  AssociationMeaning,
  CallbackMeaning,
  CallOps,
  ClassBodyArgument,
  ClassBodyDeclaration,
  ClassBodyFields,
  ClassBodyMeaning,
  ClassValueOps,
  DeclaredMatch,
  DefinesMethodMeaning,
  Inherits,
  ModuleOps,
  ValueOps,
} from "@suss/extractor";

/** A class-body declaration, with whatever it leaves out read as nothing. */
export function classBody(declared: {
  readonly in?: readonly Inherits[];
  readonly calls?: Readonly<Record<string, ClassBodyMeaning>>;
  readonly fields?: ClassBodyFields;
}): ClassBodyDeclaration {
  return {
    ...(declared.in === undefined ? {} : { in: declared.in }),
    calls: declared.calls ?? {},
    fields: declared.fields ?? {},
  };
}

/** A call that declares an association, `has_many :items`. */
export function association(
  meaning: Omit<AssociationMeaning, "declares">,
): AssociationMeaning {
  return { declares: "association", ...meaning };
}

/** A call that registers the class's own methods to run on an event, `after_commit :sync`. */
export function callback(
  meaning: Omit<CallbackMeaning, "declares">,
): CallbackMeaning {
  return { declares: "callback", ...meaning };
}

/** A call that defines a method from a function it is handed, `scope :recent, -> { ... }`. */
export function definesMethod(
  meaning: Omit<DefinesMethodMeaning, "declares">,
): DefinesMethodMeaning {
  return { declares: "method", ...meaning };
}

/**
 * The class an association reaches: the name the call writes, or the
 * association's own name for the adapter to inflect when it writes none.
 * Null when the call writes something there that is not a plain string,
 * since inflecting then would point the association at the wrong class.
 */
export type AssociationTarget =
  | { readonly written: string }
  | { readonly inflect: string; readonly plural: boolean }
  | null;

/** One thing a class body declares. */
export type ClassDeclaration =
  | {
      readonly kind: "association";
      readonly cls: ClassValueOps;
      readonly name: string;
      readonly target: AssociationTarget;
    }
  | {
      readonly kind: "callback";
      readonly cls: ClassValueOps;
      readonly events: readonly string[];
      readonly methods: readonly string[];
    }
  | {
      readonly kind: "method";
      readonly cls: ClassValueOps;
      readonly name: string;
      readonly body: ValueOps;
    };

/** What every class and module a file writes declares in its body, in source order. */
export function declareClassBodies(
  declaration: ClassBodyDeclaration,
  module: ModuleOps,
): ClassDeclaration[] {
  return module.classes().flatMap((cls) => declareClassBody(declaration, cls));
}

/** What one class's body declares, in source order: its calls, then its fields. */
export function declareClassBody(
  declaration: ClassBodyDeclaration,
  cls: ClassValueOps,
): ClassDeclaration[] {
  if (!readsBodyOf(declaration, cls)) {
    return [];
  }
  const fromCalls = cls.bodyCalls().flatMap((call) => {
    const meaning = meaningOf(declaration, call);
    return meaning === null ? [] : readMeaning(meaning, call, cls);
  });
  return [...fromCalls, ...fieldDeclarations(declaration.fields, cls)];
}

/** A body that writes no base class may be a mixin the library's classes include, so the base cannot rule it out. */
function readsBodyOf(
  declaration: ClassBodyDeclaration,
  cls: ClassValueOps,
): boolean {
  return (
    declaration.in === undefined ||
    !cls.writesBase() ||
    cls.inherits(declaration.in)
  );
}

/**
 * What the declaration says a call means, by the name it is written
 * under. A call written on a receiver, `self.has_many`, is the
 * receiver's and means nothing here.
 */
function meaningOf(
  declaration: ClassBodyDeclaration,
  call: CallOps,
): ClassBodyMeaning | null {
  const written = call.calleeText();
  if ((call.method() ?? written) !== written) {
    return null;
  }
  return Object.hasOwn(declaration.calls, written)
    ? (declaration.calls[written] ?? null)
    : null;
}

type MeaningReader<M extends ClassBodyMeaning> = (
  meaning: M,
  call: CallOps,
  cls: ClassValueOps,
) => ClassDeclaration[];

const READ_MEANING: {
  readonly [K in ClassBodyMeaning["declares"]]: MeaningReader<
    Extract<ClassBodyMeaning, { declares: K }>
  >;
} = {
  association: readAssociation,
  callback: readCallback,
  method: readDefinedMethod,
};

function readMeaning(
  meaning: ClassBodyMeaning,
  call: CallOps,
  cls: ClassValueOps,
): ClassDeclaration[] {
  const read = READ_MEANING[
    meaning.declares
  ] as MeaningReader<ClassBodyMeaning>;
  return read(meaning, call, cls);
}

function argumentOf(call: CallOps, place: ClassBodyArgument): ValueOps | null {
  return "at" in place
    ? call.valueAt(place.at)
    : (call.keywordAt?.(place.keyword) ?? null);
}

function readAssociation(
  meaning: AssociationMeaning,
  call: CallOps,
  cls: ClassValueOps,
): ClassDeclaration[] {
  const name = argumentOf(call, meaning.name)?.name("nothing") ?? null;
  if (name === null) {
    return [];
  }
  const written =
    meaning.target === undefined ? null : argumentOf(call, meaning.target);
  return [
    {
      kind: "association",
      cls,
      name,
      target: targetOf(written, name, meaning.plural ?? false),
    },
  ];
}

function targetOf(
  written: ValueOps | null,
  name: string,
  plural: boolean,
): AssociationTarget {
  if (written === null) {
    return { inflect: name, plural };
  }
  const text = written.text();
  return text === null ? null : { written: text };
}

function readCallback(
  meaning: CallbackMeaning,
  call: CallOps,
  cls: ClassValueOps,
): ClassDeclaration[] {
  const methods: string[] = [];
  for (let at = meaning.methods.from; at < call.argumentCount(); at++) {
    const method = call.nameAt(at, "nothing");
    if (method !== null) {
      methods.push(method);
    }
  }
  const narrowing =
    meaning.narrowedBy === undefined
      ? null
      : argumentOf(call, meaning.narrowedBy);
  const named = narrowing === null ? null : namesIn(narrowing);
  const events =
    named === null
      ? meaning.events
      : meaning.events.filter((event) => named.includes(event));
  return [{ kind: "callback", cls, events, methods }];
}

/**
 * The one name a value settles to, or the name of every item of the
 * list it is. Null when neither settles, which leaves every event in.
 */
function namesIn(value: ValueOps): string[] | null {
  const single = value.evaluated?.() ?? null;
  if (typeof single === "string") {
    return [single];
  }
  const names = value.items().map((item) => item.name("nothing"));
  return names.length === 0 || names.some((name) => name === null)
    ? null
    : (names as string[]);
}

function readDefinedMethod(
  meaning: DefinesMethodMeaning,
  call: CallOps,
  cls: ClassValueOps,
): ClassDeclaration[] {
  const name = argumentOf(call, meaning.name)?.name("nothing") ?? null;
  const body = argumentOf(call, meaning.body);
  return name === null || body === null || body.form?.() !== "function"
    ? []
    : [{ kind: "method", cls, name, body }];
}

/** A field assigned from a call the declaration's origin made declares an association under the field's name. */
function fieldDeclarations(
  fields: ClassBodyFields,
  cls: ClassValueOps,
): ClassDeclaration[] {
  const association = fields.association;
  if (association === undefined) {
    return [];
  }
  return cls.fieldCalls().flatMap(({ name, call }) => {
    if (!call.isFrom(association.madeBy)) {
      return [];
    }
    const text = call.valueAt(0)?.text() ?? null;
    return [
      {
        kind: "association" as const,
        cls,
        name,
        target: text === null ? null : { written: text },
      },
    ];
  });
}

/** A class-body declaration, counted for the pack health report: one data link per call and field it reads. */
export function describeClassBody(
  declaration: ClassBodyDeclaration,
): DeclaredMatch {
  return {
    name: "classBody",
    dataLinks:
      Object.keys(declaration.calls).length +
      Object.keys(declaration.fields).length,
    functionLinks: [],
    astLinks: [],
    example: null,
  };
}
