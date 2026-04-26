# Storage → schema pairing (Phase 6)

Plan for the storage-access pairing capability. PR-time gate; OSS
scope only (cross-repo data-flow audits stay product-side per
[OSS vs product scope](https://...)).

## Why this is in scope (not a tangent)

Storage reads and writes are the dominant external interaction in
backend code. The shape of a write — `db.user.create({ data: { email,
role } })` — is what the code does at the data-store boundary. The
shape of a read — `db.user.findUnique({ where: { id }, select: { email,
deletedAt } })` — is what the code expects to be available. Both
gate execution paths the same way HTTP responses or env vars do: a
missing column resolves to `undefined`, flips truthy checks, and
diverts which branches run; a typo in `data: { roe: "admin" }`
creates an unindexed field on insert and silent data loss. The
storage contract is an input to the same execution-path graph the
rest of suss models; verifying it keeps the simulacrum aligned with
execution.

## Boundary framing

The boundary is the **storage system + its addressable unit**
(table, collection, document). Field names (columns, properties) are
**fields on that unit's contract** — same granularity as `body.email`
on a REST endpoint or `STRIPE_API_KEY` on a runtime-config channel.

Pairing key: `(storageSystem, scope, table)` — e.g.
`("postgres", "default", "User")` — with field-level access tracking
on top.

Producers: schema declarations (Prisma `model User { ... }`, SQL
DDL `CREATE TABLE users (...)`, TypeORM `@Entity` classes, …). One
provider summary per declared table.

Consumers: code that reads or writes the table. One per call site
(or aggregated per code unit, TBD during impl).

### What the boundary collapses

For a typed ORM like Prisma there's effectively one link: the
schema declares the columns; the generated client gives the code
typed access; the database stores rows whose shape conforms. The
schema *is* the contract because the migration (or `db push`)
materialised the actual database from it. We collapse to one
boundary because for pairing purposes the chain is transitive —
schema declares X → migration materialises X → client typed against
X → code reads/writes X.

The collapse hides one thing: **schema drift** between what the
schema declares and what the live database actually has. A column
added in a migration but not in `schema.prisma`, or vice versa,
isn't detected by suss — we only see the schema file. Same trade-off
TypeScript's type-checker accepts ("trust your declarations"). A
follow-up could parse the migration history for cross-check.

## Demo

```
prisma/
  schema.prisma                  # User model: id, email, name, deletedAt
src/
  user/
    getUser.ts                   # db.user.findUnique({ where: { id },
                                 #   select: { email: true, deltedAt: true } })
                                 # ^^ typo in deletedAt
  admin/
    createUser.ts                # db.user.create({ data: { email, name,
                                 #   role: "admin" } })
                                 # ^^ role not in schema
  reports/
    listUsers.ts                 # db.user.findMany({ select: { email, name } })
                                 # never selects deletedAt anywhere
```

```
suss extract -p tsconfig.json -f prisma -o code-summaries.json
suss stub --from prisma prisma/schema.prisma -o schema-summaries.json
suss check --dir .suss-summaries
```

Expected output:

```
[error] storageReadFieldUnknown in src/user/getUser.ts:14
   db.user.findUnique selects "deltedAt" — User has no deltedAt column
   (did you mean deletedAt?)
[error] storageWriteFieldUnknown in src/admin/createUser.ts:8
   db.user.create writes "role" — User has no role column
[warning] storageFieldUnused on User.deletedAt
   schema declares deletedAt but no code in the project reads or writes it
```

Three categories: typo, omission, dead column. Same shape as the
env-var demo (and that's intentional — the architectural pattern
generalises across boundary kinds).

## Audience

**Primary: backend developer on a Prisma codebase, on the PR before
merge.** Recurring pain: rename a column in `schema.prisma`,
migration succeeds but a query in some service still references the
old name. Today: TypeScript catches it IF the query uses the
generated typed client AND the dev re-runs `prisma generate` AND no
code escapes the type system via `as any` for any reason. With
suss: caught at PR review based on the source-of-truth schema, not
generated types that could be stale.

**Secondary, marginal-addition story:** teams already running suss
for HTTP/GraphQL/env-var contracts gain DB drift checks for free.
Not a beachhead use case; a coverage broadener.

## Scope

In:
- **Prisma AND Drizzle.** The two dominant TS ORMs. Each gets its
  own contract-source pack (schema reader) and access pack
  (call-site / builder-chain analysis). Forces the IR + checker
  abstractions to stay ORM-agnostic.
- Four finding kinds: `storageReadFieldUnknown`,
  `storageWriteFieldUnknown`, `storageFieldUnused`,
  `storageWriteOnlyField`.
- Field-level granularity (`User.deletedAt`).
- Multi-table access per call site (joins / nested selects emit one
  storage effect per touched table).
- Stable summary artifact (substrate for product cross-repo
  audit features later).

Out (deferred, each its own follow-up):
- **Other ORMs** — TypeORM, Drizzle, Knex, Mongoose, Sequelize,
  raw pg/mysql2. Each its own pack. Most users today use one ORM
  per service; shipping Prisma alone covers the common case while
  proving the model.
- **Raw SQL parsing.** Would need a SQL parser; out of scope for
  v0. Affects raw-pg / raw-mysql users.
- **NoSQL with arbitrary attribute sets** (DynamoDB, MongoDB
  without a Mongoose schema). The "schema" is more vague — code
  defines what attributes exist. Different model; separate phase.
- **JSON column inference** (`metadata: Json` in Prisma). Code
  reads `user.metadata.flags`; suss only knows the column is
  `Json`. Could pair against Zod / TypeBox schemas declared on
  the JSON shape later.
- **Type mismatches** (`code writes "x" to an Int column`).
  TypeScript already catches this through Prisma's typed client.
  Skip; we'd duplicate.
- **Migrations as a separate source.** Prisma's declarative
  schema is the source of truth in Prisma-land. SQL-first projects
  using Knex / TypeORM migrations would need their own stub
  reading the migration history.
- **Transitive consumer contracts.** A function that returns
  `db.user.findUnique(...)` becomes a function whose output shape
  depends on the User table; callers of THAT function transitively
  consume the contract. The "consumer contract is the unlock"
  pattern from the storage memory note. Reserved for v1 — needs
  IR work to thread shape information through summary chains.
- **Audit-flavored CLI surface** (e.g. `suss list-readers
  users.email`). Product scope, not OSS.

## Implementation

### IR (Phase 6.1)

`packages/ir/src/schemas.ts`:
- Add `storage` variant to `BoundarySemantics`:
  ```ts
  z.object({
    name: z.literal("storage"),
    storageSystem: z.enum(["postgres", "mysql", "sqlite", "mongodb",
                            "dynamodb", "redis", "other"]),
    /** ORM / driver scope (defaults to "default" for single-DB setups). */
    scope: z.string(),
    /** Table / collection / model name. */
    table: z.string(),
  })
  ```
- New `metadata.storageContract` shape on the provider summary:
  ```ts
  {
    columns: Array<{ name: string; type: string; nullable: boolean; primary?: boolean; unique?: boolean }>;
    indexes: Array<{ fields: string[]; unique: boolean }>;  // optional, for future drift checks
  }
  ```
- New `storageAccess` variant added to `EffectSchema` — every
  storage read/write captured as an effect on the transition that
  performs it (NOT as `metadata.storageAccess` on the summary).
  This gives storage accesses the same execution-path attribution
  invocation effects already have (preconditions, location). One
  call site can emit MULTIPLE storageAccess effects when the query
  joins or nests across tables.
  ```ts
  {
    type: "storageAccess",
    kind: "read" | "write",
    storageSystem: string,            // matches the boundary semantics
    table: string,
    fields: string[],                 // ["*"] for default-shape reads
    selector?: string[],              // where-clause fields (reads)
    operation?: string,               // findUnique / create / select — informational
    preconditions?: Predicate[]       // gating conditions, like invocation
  }
  ```
  The pre-existing `mutation` effect (`{ type: "mutation", target,
  operation }`) stays for non-DB state mutations (Redux dispatch,
  in-memory state changes) — it's coarser by design and predates
  storage support.
- Add finding kinds: `storageReadFieldUnknown`,
  `storageWriteFieldUnknown`, `storageFieldUnused`,
  `storageWriteOnlyField`.

`packages/ir/src/index.ts`:
- New helper `storageBinding({ recognition, storageSystem, scope, table })`.

### Checker (Phase 6.1)

`packages/checker/src/storage/storagePairing.ts`:
- Per-table pairing: collect provider (schema) and consumers (code
  with `metadata.storageAccess` matching the table).
- For each consumer's read fields not in provider's column set →
  `storageReadFieldUnknown`.
- For each consumer's write fields not in provider's column set →
  `storageWriteFieldUnknown`.
- For each provider column referenced by no consumer → `storageFieldUnused`.
- For each provider column referenced by writes only (no reads) →
  `storageWriteOnlyField` (warning — likely dead data).
- Wire into `checkAll`.

### Schema readers (Phase 6.2)

Two parallel packs reading their respective schema declarations.

**`packages/stub/prisma/`** (or `packages/contract/prisma/` if we
rename per the in-flight stub→contract discussion):
- Parse `schema.prisma` via `@prisma/internals` (their own parser,
  exposed as a library) — avoids hand-rolling a Prisma DSL parser.
- Emit one provider summary per `model`. Storage system inferred
  from the `datasource db { provider = "postgresql" }` block.
- Carry `metadata.storageContract.columns` from the model's field
  list (name, type, nullable, primary, unique).

**`packages/stub/drizzle/`**:
- Drizzle's schema lives in TS source — `pgTable("users",
  { id: serial(...), email: varchar(...).notNull(), … })`. There's
  no separate schema file.
- Discovery walks for `pgTable("name", { ... })` /
  `mysqlTable(...)` / `sqliteTable(...)` calls in the project's
  `src/` (configurable). The first arg is the table name; the
  second is an object literal whose keys are columns and whose
  values are column-type call expressions (`serial`, `varchar`,
  etc.) carrying nullability / uniqueness via chained methods.
- Emit one provider summary per detected table call. Storage
  system inferred from which builder (`pgTable` → postgres,
  `mysqlTable` → mysql, etc.).

### Access packs (Phase 6.3)

Both packs feed into the SAME `storage` boundary semantics; the
checker doesn't know or care which produced an effect.

**`packages/framework/prisma/`**:
- Discovery: any function calling `<client>.<model>.<method>(args)`
  where `<client>` is an imported `PrismaClient` instance. Methods:
  `findUnique`, `findFirst`, `findMany`, `create`, `update`,
  `delete`, `upsert`, `createMany`, `updateMany`, `deleteMany`,
  `count`, `aggregate`.
- Per call: emit one `storageAccess` effect on the enclosing
  transition with:
  - `table`: the `<model>` segment
  - `kind`: read for find/count/aggregate, write for everything else
  - `fields`: extracted from `select`, `include`, `data`, `update`
    object literals at the call site (literal-shape extraction
    similar to ts-rest contract reading)
  - `selector`: extracted from `where`
- Nested `select` / `include` walking emits ADDITIONAL
  `storageAccess` effects for each related table touched. One
  `db.user.findUnique({ select: { email: true, orders: { select:
  { total: true } } } })` produces two effects: User reads `email`,
  Order reads `total`.
- Default-shape handling: a `findUnique({ where: { id } })` with no
  `select` reads ALL scalar fields by default. Record this as
  `fields: ["*"]`. The unused-column check has to conservatively
  treat any column as potentially read when ANY caller uses
  default-shape on that table — which means in practice the
  unused-column finding only fires when EVERY caller uses explicit
  `select` and none mention the column.

**`packages/framework/drizzle/`**:
- Discovery: any function calling `<db>.select(...)`,
  `<db>.insert(...)`, `<db>.update(...)`, `<db>.delete(...)` where
  `<db>` resolves to a `drizzle(...)` factory output.
- Builder-chain analysis: walk the chain to extract structure.
  - `.from(usersTable)` → table name (resolved via the `pgTable`
    declaration).
  - `.select({ email: users.email, total: orders.total })` → field
    set, with table attribution per field.
  - `.innerJoin(ordersTable, ...)` / `.leftJoin(...)` → additional
    tables in scope; their selected fields belong to them.
  - `.where(eq(users.id, x))` → selector fields.
  - `.values({ email, name })` after `.insert(table)` → write
    fields.
  - `.set({ status: "active" })` after `.update(table)` → write
    fields.
- Emit one `storageAccess` effect per touched table per call
  (joins → multiple effects, just like Prisma's nested selects).
- Default-shape (`db.select().from(usersTable)` with no explicit
  field list) reads `fields: ["*"]`, same convention as Prisma.

### End-to-end (Phase 6.4)

- Wire stub-to-checker integration.
- Fixture project (the demo above).
- Snapshot test asserting the three findings.

## Open questions

1. **Default-shape reads.** A `findUnique({ where: { id } })` returns
   all scalar fields. Do we record it as "potentially reads
   everything," or do we skip the unused-column check when any caller
   uses default-shape? Likely the latter — explicit `select` is
   strong signal; default-shape tells us nothing useful about
   field-level usage.
2. **Multiple schemas in one project.** Monorepos with multiple
   Prisma schemas. Pack accepts a `schemaPath` config; the `scope`
   field on the boundary distinguishes them. One pairing pass per
   scope.
3. **Includes / nested selects.** `select: { posts: { select:
   { title: true } } }` reads `post.title`, not just from the User
   table. Recursive — pairing has to follow the relation. v0:
   capture only the top-level select, defer relation traversal.
4. **Raw SQL escapes.** Prisma's `$queryRaw` / `$executeRaw` bypass
   the typed client. v0: skip; document as a limitation.
5. **Migration history as cross-check.** Out of scope for v0 but
   worth noting. The schema file is the declared contract; the
   migration history is the authoritative deployment record. Drift
   between them is a real bug class. Same family as env vars'
   `template-declared` vs `platform-injected` provenance.

## Status

Plan: drafted, awaiting review.
Work: not started.
Owner: shipping under a future #168 (Phase 6).
