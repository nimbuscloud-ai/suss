# storage/

This check pairs relational database schemas (Prisma, Drizzle, raw SQL) against the storage-access effects in the code. It verifies that no code reads or writes an undeclared column, and it points out declared columns that no code touches.

## Place in the pipeline

`checkAll()` runs it after the `InteractionIndex` is built. It takes summaries with `storage-relational` provider bindings (the schema) and summaries with `storage-access` interaction effects (the reads and writes in the code), and it pairs them by `(storageSystem, scope, table)`. It emits four field-existence findings (`boundaryFieldUnknown` for the read and write aspects, `boundaryFieldUnused`, plus the write-only variants).

## Key files

- `relationalPairing.ts:checkRelationalStorage` is the main entry point. It accepts a pre-built `InteractionIndex` as an option, so it does not have to re-walk the summaries.
- `relationalPairing.ts:makeFieldUnknownFinding` generates the per-field errors for code that touches undeclared columns.
- `relationalPairing.ts:makeFieldUnusedFinding` generates the warning for schema columns no code accesses.
- The storage contract comes from each provider's `metadata.storageContract` (the column list and its metadata).

## Non-obvious things

- **Multi-attribution by `(storageSystem, scope, table)`.** A shared utility file that calls `db.user.findMany()` pairs against every Postgres schema declaring a `user` table in scope. That is intentional: the same code legitimately serves several deployments.
- **Wildcard reads suppress unused checks.** A call like `db.user.findMany()` (with no `select`) reads everything. When the index sees a wildcard read, the unused-column check skips the table entirely, because we can't tell whether a column that looks unused is consumed by the wildcard caller.
- **Default scope collapses in display.** A `scope === "default"` shows up as the bare table name (`User`) in finding messages, and other scopes show up as `scope/User` so that you can tell them apart.
- **Writes get their own check.** A column that is declared and only written, never read, is `boundaryFieldUnusedWriteOnly`. That is different from a column nothing touches at all.
- **Field findings reuse the generic `boundaryField*` vocabulary.** These are the same finding kinds message-bus and runtime-config use, and the `aspect` field (read/write/construct) tells them apart. Tooling that spans domains can group by kind.

## Sibling modules

- `interactions/dispatcher.ts` provides the lookups: `providersOf("storage-relational")` and `interactionsOf("storage-access", "storage-relational")`.
- `coverage/responseMatch.ts` provides the `makeSide` helper for the location strings on findings.
