/**
 * Recognize Mongoose model calls and emit `storage-access` effects.
 *
 * A model spreads what one call does over two arguments rather than
 * one: `User.find({ email }, { name: 1 })` picks documents by the
 * filter and reads the fields the projection asks for. So each rule
 * says which argument it reads, and which argument that is changes with
 * the method.
 *
 * A call is settled by where its method is declared, so `User` can be
 * called anything. The collection comes from the `model(...)` call the
 * receiver was written as, and the README says how the three ways of
 * settling one are ordered and what v0 leaves out.
 */

import {
  constructedFrom,
  declaredBy,
  pack,
  storageCalls,
} from "@suss/recognize";

import type {
  CallOps,
  InputRule,
  PatternPack,
  StatedRule,
  StorageMethod,
  ValueOps,
} from "@suss/recognize";

/** The library whose method declarations settle a call. */
const CLIENT_MODULE = "mongoose";

/** What a call touches when it states no fields: every field there is. */
const WHOLE_DOCUMENT = ["*"];

/** What the ...ById methods pick documents by, whatever the id is called. */
const BY_ID = ["_id"];

// ---------------------------------------------------------------------------
// What one call states, argument by argument
// ---------------------------------------------------------------------------

/** The fields a filter picks documents by. */
const FILTER_KEYS: InputRule = ({ input }) => keysOf(input);

/**
 * The fields a read asks for. A projection states them as a map of
 * flags or as a space-delimited string, and one that only says which
 * fields to leave out still reads the rest of the document back.
 */
const PROJECTED: InputRule = ({ input }) => {
  const written = input.text();
  if (written !== null) {
    return namedInProjection(written);
  }
  const asked = keysOf(input, asksForIt);
  return asked.length > 0 ? asked : WHOLE_DOCUMENT;
};

/**
 * The fields an update touches. A `$`-prefixed key is an operator and
 * the fields are the keys under it; every other key is an assignment to
 * the field the key is written as.
 */
const UPDATED: InputRule = ({ input }) => {
  const touched = new Set<string>();
  for (const entry of input.entries("nothing")) {
    if (entry.key === null) {
      continue;
    }
    if (!entry.key.startsWith(OPERATOR_PREFIX)) {
      touched.add(entry.key);
      continue;
    }
    for (const name of keysOf(entry.value)) {
      touched.add(name);
    }
  }
  return touched.size > 0 ? [...touched] : WHOLE_DOCUMENT;
};

/**
 * The fields a write states in full, as the one document it passes or
 * as every document of a list. A document this cannot read leaves the
 * write touching the whole row, since the fields it states are not all
 * of them.
 */
const PAYLOAD: InputRule = ({ input }) => {
  const documents = input.items();
  if (documents.length === 0) {
    const written = keysOf(input);
    return written.length > 0 ? written : WHOLE_DOCUMENT;
  }
  const union = new Set<string>();
  for (const document of documents) {
    const written = keysOf(document);
    if (written.length === 0) {
      return WHOLE_DOCUMENT;
    }
    for (const name of written) {
      union.add(name);
    }
  }
  return [...union];
};

/** What marks a key as one of MongoDB's update operators. */
const OPERATOR_PREFIX = "$";

/** Whether a projection's flag asks for the field back. */
function asksForIt(value: ValueOps): boolean {
  return value.flag() === true;
}

/** What an object's properties are called, keeping the ones a test allows. */
function keysOf(
  value: ValueOps,
  keep: (value: ValueOps) => boolean = () => true,
): string[] {
  const found: string[] = [];
  for (const entry of value.entries("nothing")) {
    if (entry.key !== null && keep(entry.value)) {
      found.push(entry.key);
    }
  }
  return found;
}

/**
 * The fields a space-delimited projection asks for. A leading `-`
 * leaves a field out and a leading `+` brings back one the schema hides
 * by default, so only the exclusions drop out.
 */
function namedInProjection(written: string): readonly string[] {
  const asked = written
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0 && !term.startsWith("-"))
    .map((term) => term.replace(/^\+/, ""));
  return asked.length > 0 ? asked : WHOLE_DOCUMENT;
}

// ---------------------------------------------------------------------------
// The methods, and which argument each of them states what in
// ---------------------------------------------------------------------------

const filter = (at: number): StatedRule => ({ of: { at }, by: FILTER_KEYS });
const projection = (at: number): StatedRule => ({ of: { at }, by: PROJECTED });
const update = (at: number): StatedRule => ({ of: { at }, by: UPDATED });
const payload = (at: number): StatedRule => ({ of: { at }, by: PAYLOAD });

/**
 * Every method this reads. `countDocuments` and `exists` state no
 * fields at all, since neither reads one back.
 */
const METHODS: Record<string, StorageMethod> = {
  find: { kind: "read", selector: filter(0), fields: projection(1) },
  findOne: { kind: "read", selector: filter(0), fields: projection(1) },
  findById: { kind: "read", selector: BY_ID, fields: projection(1) },
  countDocuments: { kind: "read", selector: filter(0) },
  exists: { kind: "read", selector: filter(0) },
  distinct: { kind: "read", selector: filter(1), fields: { at: 0 } },
  create: { kind: "write", fields: payload(0) },
  insertMany: { kind: "write", fields: payload(0) },
  updateOne: { kind: "write", selector: filter(0), fields: update(1) },
  updateMany: { kind: "write", selector: filter(0), fields: update(1) },
  replaceOne: { kind: "write", selector: filter(0), fields: payload(1) },
  deleteOne: { kind: "write", selector: filter(0), fields: WHOLE_DOCUMENT },
  deleteMany: { kind: "write", selector: filter(0), fields: WHOLE_DOCUMENT },
  findOneAndUpdate: { kind: "write", selector: filter(0), fields: update(1) },
  findByIdAndUpdate: { kind: "write", selector: BY_ID, fields: update(1) },
  findOneAndDelete: {
    kind: "write",
    selector: filter(0),
    fields: WHOLE_DOCUMENT,
  },
  findByIdAndDelete: { kind: "write", selector: BY_ID, fields: WHOLE_DOCUMENT },
  findOneAndReplace: { kind: "write", selector: filter(0), fields: payload(1) },
  // A document can be changed after it was built, which this does not
  // track, so a save is not reported as touching the fields the
  // constructor happened to state.
  save: { kind: "write", fields: WHOLE_DOCUMENT },
};

// ---------------------------------------------------------------------------
// The collection behind the receiver
// ---------------------------------------------------------------------------

/** What a model call is called, whether it goes through the library or not. */
const MODEL_FACTORY = "model";

/**
 * The collection the call reaches. Mongoose takes an explicit third
 * argument to `model(...)` first, then the schema's own `collection`
 * option, and pluralizes the model name when neither is there, so this
 * takes them in the same order.
 */
function collectionOf(
  _selector: readonly string[],
  call: CallOps,
): string | null {
  const model = modelCallIn(call);
  const modelName = model?.nameAt(0, "nothing") ?? null;
  if (model === null || modelName === null) {
    return null;
  }
  return (
    model.nameAt(2, "nothing") ??
    schemaCollectionOf(model) ??
    pluralized(modelName)
  );
}

/**
 * The `model(...)` call behind the receiver, or null where the receiver
 * came from somewhere this cannot follow. A static call is made on the
 * model itself, a construction and a query result are hops further
 * along, and the anchor op follows all of them through the fact layer.
 */
function modelCallIn(call: CallOps): CallOps | null {
  return (
    call.anchorCall?.(
      constructedFrom({ from: [CLIENT_MODULE], named: [MODEL_FACTORY] }),
    ) ?? null
  );
}

/** The collection a schema's options state, when the model call leaves it there. */
function schemaCollectionOf(model: CallOps): string | null {
  return model.argument(1)?.propertyAt(1, "collection", "nothing") ?? null;
}

/**
 * Regular-English pluralization, the part of Mongoose's own default
 * naming this pack reproduces. The README says what it leaves out.
 */
function pluralized(modelName: string): string {
  const lower = modelName.toLowerCase();
  if (/[^aeiou]y$/.test(lower)) {
    return `${lower.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/.test(lower)) {
    return `${lower}es`;
  }
  return `${lower}s`;
}

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

export interface MongooseRecognizerOptions {
  /**
   * Scope label for the storage binding. Defaults to `"default"`. Set
   * this when a project keeps more than one MongoDB connection and
   * wants their accesses paired separately.
   */
  scope?: string;
}

/** Every model call, whichever of the methods above it goes to. */
function modelCalls(scope: string) {
  return storageCalls({
    system: "mongodb",
    scope,
    client: declaredBy(CLIENT_MODULE),
    unsettledName: "nothing",
  })
    .methods(METHODS)
    .container(collectionOf)
    .example('User.find({ email: "a@b.c" }, { name: 1 })');
}

/**
 * Pack export. One declaration, gated on a file reaching Mongoose,
 * since that is where a model method can be declared.
 */
export function mongooseFramework(
  options: MongooseRecognizerOptions = {},
): PatternPack {
  return pack("mongoose", [modelCalls(options.scope ?? "default")], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-mongoose",
    protocol: "in-process",
  });
}

export default mongooseFramework;
