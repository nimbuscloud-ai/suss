# @suss/framework-prisma-mined

Says which Prisma models a TypeScript service reads and writes, and the fields each call states.

## What this package is

An experiment: a Prisma pack written from Prisma's own documentation, generated client types, and one application, without looking at suss's shipped Prisma pack. It is not meant to replace that pack or to merge. It recognizes `prisma.<model>.<operation>(...)` calls and emits the same `storage-access` effects the other storage packs emit.

```ts
import { prismaMinedFramework } from "@suss/framework-prisma-mined";

const pack = prismaMinedFramework();
```

## How it settles a call

A project almost never imports `PrismaClient` where it uses it; it wraps a singleton in its own module and imports that instead. Nothing at the call site says the receiver is a Prisma delegate, so this pack asks the type checker: `prisma.article`'s type resolves to the generated `ArticleDelegate` interface, and every operation that interface declares (`findMany`, `create`, `update`, ...) is a call this pack recognizes. Reading the type rather than the receiver's spelling is what makes this fire through any wrapper.

## What each call contributes

| Argument | What it becomes |
| --- | --- |
| `select` | the fields a read returns, or `["*"]` for a bare call |
| `include` | `["*", ...include keys]`, since include adds relations on top of every scalar |
| `data` | the fields a write sets |
| `where` | the selector, walked through `AND`/`OR`/`NOT` |
| a unique `where` with one non-`id` key | the binding's `accessPath`, Prisma's own secondary-index shape |

Read operations: `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`. Write operations: `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`.

A partial update commonly builds `data` with a spread per optional field, `data: { ...(email ? { email } : {}), ...(bio && { bio }) }`. Either branch of a ternary or an `&&` could run, so a field named on either side counts; this is what the RealWorld application's own `updateUser` does, and without it every conditionally-set field would have gone unseen and the call would have read as writing the whole row instead.

## Relations

A query that reaches through a relation gets a second effect rather than a folded-in guess at the far model. On a read, `include: { author: { select: { username: true } } }` produces one effect for `Article` and one carrying `interaction.relationPath: ["author"]` with `fields: ["username"]`, walked recursively for a relation nested inside a relation. On a write, `data: { tagList: { connectOrCreate: [...] } }` produces an effect with `relationPath: ["tagList"]` and the fields the `create` side of each entry states, whether that list is written as an array literal or as `tags.map((tag) => ({ create: { name: tag }, where: { name: tag } }))`, the shape the RealWorld application this pack was built against actually writes.

`connect`, `disconnect`, and `set` name the relation and never a field of the far row, so those effects carry `relationKey: true` and an empty `fields` list, matching what `packages/behavioral-ir/src/schemas.ts` documents `relationKey` for. In every case the binding's `container` stays the model the call started from; only a pass that has read the schema knows which model a relation points to, and this pack never reads the schema, so it does not guess.

`include` and `select` cannot both appear at one level, and only `include` is unambiguous: every key there is a relation. `select: { followedBy: true }` reads the same on the page whether `followedBy` is a scalar column or a relation asked for in its whole shape; Prisma's generated `<Model>Select` type tells them apart, and this pack does not read that type. A bare `true` under `select` stays in the enclosing effect's field list and gets no relation effect of its own; only a nested args object (`select: { author: { select: {...} } }`) or a key under `include` does.

## Out of scope, and why

- **`createMany`, `upsert`, `update`, `updateMany`, `delete`, `deleteMany` inside a relation.** Whether the payload is a single object or a list of `{ where, data }` pairs depends on whether the relation is to-one or to-many. That is schema knowledge; a client call site does not carry it.
- **A relation write nested inside another relation write.** `tagList: { connectOrCreate: [{ create: { name, articles: { connect: [...] } } } ] }` is legal Prisma; this pack reads one level of relation and stops.
- **`$queryRaw` / `$executeRaw`.** Raw SQL states physical table names, not Prisma model names, the same seam Drizzle's raw-SQL path has against its query-builder path. Reusing `@suss/sql` the way `@suss/framework-drizzle` does is straightforward, but nothing in the application this pack was built against uses it, so it went untested and unwritten rather than shipped on faith.
- **A custom generator `output` path.** The default generator output (`.prisma/client`, re-exported through `@prisma/client`) is what this pack's declaration check looks for. A project that sets `output` in its `generator client` block to somewhere else is not covered.
- **`_count` in a `select`/`include`.** It is an aggregate count of related rows, not a field of any row, so it is skipped rather than misread as a relation.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the binding it builds. Nothing declares a Prisma model the way CloudFormation declares a table; a contract pack that reads `schema.prisma` would give the storage checker the far side of each `relationPath`, the same way `contract-prisma` does for the shipped pack.
