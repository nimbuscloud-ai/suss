# storage/

Pairs relational database schemas (Prisma, Drizzle, raw SQL) against code's storage-access effects. Verifies that code never reads or writes undeclared columns and surfaces declared columns that no code touches.

## Place in the pipeline

Runs in `checkAll()` after the `InteractionIndex` is built. Consumes summaries with `storage-relational` provider bindings (the schema) and `storage-access` interaction effects (the code reads and writes). Pairs by `(storageSystem, scope, table)`. Emits four field-existence findings (`boundaryFieldUnknown` for read and write aspects, `boundaryFieldUnused`, plus write-only variants).

## Key files

- `relationalPairing.ts:checkRelationalStorage` — main entry. Accepts an optional pre-built `InteractionIndex` to avoid re-walking summaries.
- `relationalPairing.ts:makeFieldUnknownFinding` — generates per-field errors for code touching undeclared columns.
- `relationalPairing.ts:makeFieldUnusedFinding` — warning for schema columns no code accesses.
- Storage contract is read from each provider's `metadata.storageContract` (column list and metadata).

## Non-obvious things

- **Multi-attribution by `(storageSystem, scope, table)`.** A shared utility file hitting `db.user.findMany()` pairs against every Postgres schema declaring a `user` table in scope. Intentional — the same code legitimately serves multiple deployments.
- **Wildcard reads suppress unused checks.** A code call like `db.user.findMany()` (no `select`) reads everything. When the index sees a wildcard read, the unused-column check skips the table entirely — we can't tell whether an unused-looking column is consumed by the wildcard caller.
- **Default scope collapses in display.** `scope === "default"` shows as bare table name (`User`) in finding messages; non-default scopes show as `scope/User` for disambiguation.
- **Writes get their own check.** A column that's declared and only written (never read) is `boundaryFieldUnusedWriteOnly`. Distinct from never-touched.
- **Field findings reuse the generic `boundaryField*` vocabulary.** Same finding kinds as message-bus and runtime-config; the `aspect` field (read/write/construct) discriminates. Cross-domain tooling can group by kind.

## Sibling modules

- `interactions/dispatcher.ts` — `providersOf("storage-relational")` and `interactionsOf("storage-access", "storage-relational")` are the lookups.
- `coverage/responseMatch.ts` — `makeSide` helper for location strings on findings.
