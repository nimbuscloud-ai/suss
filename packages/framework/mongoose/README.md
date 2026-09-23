# @suss/framework-mongoose

This pack records which MongoDB collections a TypeScript service reads and writes through Mongoose.

## What this package is

A pattern pack. It matches Mongoose model calls and records the same `storage-access` effects the other storage packs do, so a writer and a reader of the same collection become two ends of one boundary.

```ts
import { mongooseFramework } from "@suss/framework-mongoose";

const pack = mongooseFramework();
```

The pack is a declaration with no walk over the syntax tree. Through `@suss/recognize` it lists its methods, its receiver, and where each argument is read, as data. Three parts are code: the collection, which needs Mongoose's own pluralizer, and the two rules that read a filter, a projection, an update document and a payload.

## How it settles a call

The pack matches a call by where its method is declared, whatever the receiver is called:

```ts
const user = await getUserModel().findOne({ email });
```

Nothing at that call site shows that `getUserModel()` returns a Mongoose model. The declaration of `findOne` does, since Mongoose's own type declarations declare it. So the pack asks the type checker where the declaration lives. A `findOne` on a plain object resolves somewhere else and is ignored.

## The collection a call reaches

The pack follows the receiver back to the `mongoose.model("User", schema, collection?)` call that produced it, one hop through a variable in the same file or a single import:

```ts
const User = mongoose.model("User", userSchema); // collection: "users"
User.find({ email });
```

A project can set the collection name in three ways, checked in this order:

1. **An explicit third argument** to `.model(...)`: `mongoose.model("User", schema, "accounts")`.
2. **A `collection` option on the schema**: `new Schema(fields, { collection: "accounts" })`.
3. **Mongoose's own default**: the model name, lowercased and pluralized.

The pack only reproduces the regular English part of Mongoose's pluralizer. A trailing consonant + `y` becomes `ies`, a trailing `s`/`x`/`z`/`ch`/`sh` gets `es`, and everything else gets a plain `s`. Mongoose's pluralizer also handles irregular nouns (`person` → `people`, `mouse` → `mice`, `ox` → `oxen`, and others), and this pack does not. A model named after one of those gets the wrong default here. Pass an explicit collection, with either of the first two options above, to get it right.

If the pack cannot trace a receiver at all, because it comes through a factory function or a value passed across a boundary the pack cannot follow, the effect is still recorded with a null collection. The call happened, and the pack records which part it could not settle instead of dropping the access.

## What each call contributes

| Input | What it becomes |
| --- | --- |
| the projection argument of a read | the fields, whether written as an object (`{ name: 1 }`) or a space-delimited string (`"name email"`) |
| the payload of `create` / `insertMany` / a replacement | the fields |
| the update document of `updateOne` / `updateMany` / `findOneAndUpdate` / `findByIdAndUpdate` | the fields, reading under any `$`-prefixed operator (`$set`, `$inc`, ...) as well as plain assignment |
| the filter argument | the selector |
| a scalar id (`findById` and its `...AndUpdate` / `...AndDelete` siblings) | a selector of `["_id"]` |

Read methods: `find`, `findOne`, `findById`, `countDocuments`, `exists`, `distinct`. Write methods: `create`, `insertMany`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `findOneAndUpdate`, `findByIdAndUpdate`, `findOneAndDelete`, `findByIdAndDelete`, `findOneAndReplace`, and the document instance method `save()`.

A projection that only excludes (every value falsy, as in `{ password: 0 }`) returns the whole document, so it comes out as `["*"]`, the same as no projection at all. `deleteOne` / `deleteMany` / `findOneAndDelete` / `findByIdAndDelete` remove the whole document, so they come out as `["*"]` too. `save()` always comes out as `["*"]`. The document may have been changed after it was constructed, and this pack does not track that, so it does not report the constructor's fields as if they were still current.

`save()` finds its model by following the document backward: through `new User(...)` when the document was constructed directly, or through the query that produced it (`const doc = await User.findById(id); doc.save()`). Both are one step further back than a static call's model. So the collection rule tries the receiver first, then whatever created the class the receiver was constructed from, then the receiver's own receiver.

## Out of scope for now

- **`aggregate()`.** Its pipeline stages are not walked.
- **`bulkWrite()`.**
- **`populate()` and schema `ref`.** A read across a relation is not resolved to the collection on the other side, the way the Prisma pack resolves relations.
- **Aggregation-pipeline update syntax**, an array passed to `updateOne` / `updateMany` in place of an update document.
- **Document instance methods other than `save()`**: `doc.deleteOne()`, `doc.updateOne()`, the deprecated `doc.remove()`.
- **`Model.where(...)`** chain-built queries, and **`Model.discriminator(...)`**.
- **The native driver escape hatch**, `Model.collection.find(...)`.

## Where it fits in suss

The pack depends on `@suss/recognize`, which compiles the declaration into the recognizer hook an adapter calls, and asks the adapter's own operations about each call. Mongoose has no separate schema-reader package the way Prisma does. So a call's collection pairs with other code through the storage pass in `@suss/checker`, the way a Redis key does. Drizzle is different, because its accesses pair with a schema provider such as a Prisma schema.
