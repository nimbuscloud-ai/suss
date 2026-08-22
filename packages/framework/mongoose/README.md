# @suss/framework-mongoose

Says which MongoDB collections a TypeScript service reads and writes through Mongoose.

## What this package is

A pattern pack. It recognizes Mongoose model calls and emits the same `storage-access` effects the other storage packs emit, so a writer and a reader of the same collection become two ends of one boundary.

```ts
import { mongooseFramework } from "@suss/framework-mongoose";

const pack = mongooseFramework();
```

## How it settles a call

A call is recognized by where its method is declared, not by what the receiver is called:

```ts
const user = await getUserModel().findOne({ email });
```

Nothing at that call site says `getUserModel()` returns a Mongoose model. What `findOne` resolves to does: Mongoose's own type declarations declare it, so the pack asks the type checker where the declaration lives. A `findOne` on a plain object resolves somewhere else and is left alone.

## The collection a call reaches

The receiver is walked back to the `mongoose.model("User", schema, collection?)` call that produced it, one hop through a same-file variable or a single import:

```ts
const User = mongoose.model("User", userSchema); // collection: "users"
User.find({ email });
```

Three ways a project can settle the collection name, checked in this order:

1. **An explicit third argument** to `.model(...)`: `mongoose.model("User", schema, "accounts")`.
2. **A `collection` option on the schema**: `new Schema(fields, { collection: "accounts" })`.
3. **Mongoose's own default**: the model name, lowercased and pluralized.

This pack reproduces only the regular-English part of Mongoose's own pluralizer: a trailing consonant + `y` becomes `ies`, a trailing `s`/`x`/`z`/`ch`/`sh` gets `es`, everything else gets a plain `s`. Mongoose's pluralizer also special-cases irregular nouns (`person` → `people`, `mouse` → `mice`, `ox` → `oxen`, and others), which this does not reproduce. A model named for one of those gets the wrong default guess here; pass an explicit collection (either of the first two options above) to settle it correctly regardless.

A receiver this cannot trace at all, through a factory function or a value passed across a boundary the pack cannot follow, still gets its effect recorded, with a null collection: the call happened, and the pack says which part it could not settle rather than dropping the crossing.

## What each call contributes

| Input | What it becomes |
| --- | --- |
| the projection argument of a read | the fields, whether written as an object (`{ name: 1 }`) or a space-delimited string (`"name email"`) |
| the payload of `create` / `insertMany` / a replacement | the fields |
| the update document of `updateOne` / `updateMany` / `findOneAndUpdate` / `findByIdAndUpdate` | the fields, reading under any `$`-prefixed operator (`$set`, `$inc`, ...) as well as plain assignment |
| the filter argument | the selector |
| a scalar id (`findById` and its `...AndUpdate` / `...AndDelete` siblings) | a selector of `["_id"]` |

Read methods: `find`, `findOne`, `findById`, `countDocuments`, `exists`, `distinct`. Write methods: `create`, `insertMany`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `findOneAndUpdate`, `findByIdAndUpdate`, `findOneAndDelete`, `findByIdAndDelete`, `findOneAndReplace`, and the document instance method `save()`.

A pure-exclusion projection (every value falsy, `{ password: 0 }`) reads the whole document back, so it comes out as `["*"]`, the same as no projection at all. `deleteOne` / `deleteMany` / `findOneAndDelete` / `findByIdAndDelete` remove the whole document, so they come out as `["*"]` too. `save()` always comes out as `["*"]`: the document can carry mutations made after it was constructed, which this pack does not track, so it does not report the constructor's fields as if they were still current.

`save()` resolves its own model by walking the document backward: through `new User(...)` when the document was constructed directly, or through the query that produced it (`const doc = await User.findById(id); doc.save()`).

## Out of scope for now

- **`aggregate()`.** Its pipeline stages are not walked.
- **`bulkWrite()`.**
- **`populate()` and schema `ref`.** A read across a relation is not resolved to the collection on the other side, unlike the Prisma pack's relation handling.
- **Aggregation-pipeline update syntax**, an array passed to `updateOne` / `updateMany` in place of an update document.
- **Document instance methods other than `save()`**: `doc.deleteOne()`, `doc.updateOne()`, the deprecated `doc.remove()`.
- **`Model.where(...)`** chain-built queries, and **`Model.discriminator(...)`**.
- **The native driver escape hatch**, `Model.collection.find(...)`.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the binding it builds and `@suss/adapter-typescript` for the declaration check and argument extraction. Mongoose has no separate schema-reader package the way Prisma does; what a call's collection pairs against is other code, the same as the Redis and Drizzle packs, through the storage pass in `@suss/checker`.
