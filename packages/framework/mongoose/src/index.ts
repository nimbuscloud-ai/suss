/**
 * Recognizes Mongoose model calls and records each one as a storage
 * access on the model's collection.
 *
 * One call spreads over two arguments: `User.find({ email }, { name: 1 })`
 * picks documents by the filter and reads the fields in the projection.
 * Which argument is the filter and which is the projection depends on the
 * method, so each entry in `METHODS` gives its own positions.
 *
 * A call counts by where its method is declared, so `User` can have any
 * name. The collection comes from the `model(...)` call behind the
 * receiver. The README covers the order the collection is settled in and
 * what is left out.
 */

import { z } from "zod";

import { scopeOption } from "@suss/extractor";
import {
  constructedFrom,
  declaredBy,
  pack,
  storageCalls,
} from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type {
  CallOps,
  InputRule,
  PatternPack,
  StatedRule,
  StorageMethod,
  ValueOps,
} from "@suss/recognize";

const CLIENT_MODULE = "mongoose";

const WHOLE_DOCUMENT = ["*"];

const BY_ID = ["_id"];

// ---------------------------------------------------------------------------
// Reading the fields out of each argument
// ---------------------------------------------------------------------------

const FILTER_KEYS: InputRule = ({ input }) => keysOf(input);

/**
 * A projection is a map of flags or a space-delimited string. One that
 * only excludes fields still returns the rest of the document, so it
 * counts as reading all of it.
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
 * A `$` key such as `$set` is an operator, and the fields it touches are
 * the keys under it. Any other key assigns the field of that name.
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
 * A payload is one document or a list of them. If any document cannot be
 * read, the write counts as touching every field, since the fields that
 * could be read may not be all of them.
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

const OPERATOR_PREFIX = "$";

function asksForIt(value: ValueOps): boolean {
  return value.flag() === true;
}

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
 * In a string projection, `-name` excludes a field and `+name` includes
 * one the schema hides by default. Only the exclusions are dropped.
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
// Which argument each method reads
// ---------------------------------------------------------------------------

const filter = (at: number): StatedRule => ({ of: { at }, by: FILTER_KEYS });
const projection = (at: number): StatedRule => ({ of: { at }, by: PROJECTED });
const update = (at: number): StatedRule => ({ of: { at }, by: UPDATED });
const payload = (at: number): StatedRule => ({ of: { at }, by: PAYLOAD });

// `countDocuments` and `exists` have no `fields`, since neither returns
// a field.
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
  // The pack does not track changes to a document after it is built, so
  // the constructor's fields may be stale by the save. A save touches
  // every field.
  save: { kind: "write", fields: WHOLE_DOCUMENT },
};

// ---------------------------------------------------------------------------
// The collection behind the receiver
// ---------------------------------------------------------------------------

const MODEL_FACTORY = "model";

/**
 * Checks in Mongoose's own order: the third argument to `model(...)`,
 * then the schema's `collection` option, then the pluralized model name.
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
 * `anchorCall` follows a static call on the model, a document built with
 * `new`, and a document a query returned. It returns null when the
 * receiver comes from somewhere the fact layer cannot follow.
 */
function modelCallIn(call: CallOps): CallOps | null {
  return (
    call.anchorCall?.(
      constructedFrom({ from: [CLIENT_MODULE], named: [MODEL_FACTORY] }),
    ) ?? null
  );
}

/** Reads `collection` from the options in `new Schema(fields, options)`. */
function schemaCollectionOf(model: CallOps): string | null {
  return model.argument(1)?.propertyAt(1, "collection", "nothing") ?? null;
}

/**
 * Covers only the regular English rules of Mongoose's pluralizer. The
 * README lists the irregular nouns this gets wrong.
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

/**
 * The options a `-f mongoose=config.json` file may set. The CLI checks
 * the file against this schema before it calls the factory.
 */
export const optionsSchema = z
  .object({
    /**
     * Scope for the storage binding, `"default"` when unset. Set it when a
     * project has more than one MongoDB connection and their accesses
     * should pair separately.
     */
    scope: scopeOption.optional(),
  })
  .strict();

export type MongooseRecognizerOptions = z.infer<typeof optionsSchema>;

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
 * A model call counts only when Mongoose declares its method, so a
 * `findOne` on a plain object is ignored.
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

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-mongoose",
  dependencies: [{ ecosystem: "npm", name: "mongoose" }],
  reads: `Mongoose model calls. Each one becomes a storage-access interaction on the collection that the model's \`.model(...)\` call declares.`,
};

export default mongooseFramework;
