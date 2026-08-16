# storage/

This check pairs a store's declared contract (Prisma, Drizzle, raw SQL) against the storage-access effects in the code. It verifies that no code reads or writes a field the contract does not declare, and it points out declared fields that no code touches.

## Place in the pipeline

`checkAll()` runs it after the `InteractionIndex` is built. It takes summaries with `storage` provider bindings (the schema) and summaries with `storage-access` interaction effects (the reads and writes in the code), and it pairs them by `(storageSystem, scope, container, accessPath)`. It emits four field-existence findings (`boundaryFieldUnknown` for the read and write aspects, `boundaryFieldUnused`, plus the write-only variants).

## Key files

- `storagePairing.ts:checkStorage` is the main entry point. It accepts a pre-built `InteractionIndex` as an option, so it does not have to re-walk the summaries.
- `storagePairing.ts:makeFieldUnknownFinding` generates the per-field errors for code that touches undeclared fields.
- `storagePairing.ts:makeFieldUnusedFinding` generates the warning for declared fields no code accesses.
- The storage contract comes from each provider's `metadata.storageContract` (the field list and its metadata).

## Non-obvious things

- **A store says whether its field list is complete.** `metadata.storageContract.fieldSet` is `"exhaustive"` when the contract declares every field an item has, which a SQL schema does. DynamoDB declares its key attributes and lets every other attribute vary, so it says `"partial"`, and a blob says `"none"`. Only an exhaustive contract can call a field it does not declare unknown, so the same pass runs over both without a per-product branch. A contract that says nothing is treated as partial: an unknown-field error is a claim, and nothing should make it on a contract that never said its list was complete.
- **A secondary index is a boundary of its own.** A DynamoDB global secondary index has its own key fields, so a query through it pairs against the index's contract, not the table's. `accessPath` is the index or alias, and null is the container's own primary key. Findings write it as `Orders#byCustomer`.
- **Multi-attribution by the pairing key.** A shared utility file that calls `db.user.findMany()` pairs against every Postgres schema declaring a `user` table in scope. That is intentional: the same code legitimately serves several deployments.
- **Wildcard reads suppress unused checks.** A call like `db.user.findMany()` (with no `select`) reads everything. When the index sees a wildcard read, the unused-field check skips the table entirely, because we can't tell whether a field that looks unused is consumed by the wildcard caller.
- **Default scope collapses in display.** A `scope === "default"` shows up as the bare container name (`User`) in finding messages, and other scopes show up as `scope/User` so that you can tell them apart.
- **Writes get their own check.** A field that is declared and only written, never read, is `boundaryFieldUnusedWriteOnly`. That is different from a field nothing touches at all.
- **Field findings reuse the generic `boundaryField*` vocabulary.** These are the same finding kinds message-bus and runtime-config use, and the `aspect` field (read/write/construct) tells them apart. Tooling that spans domains can group by kind.

## Sibling modules

- `interactions/dispatcher.ts` provides the lookups: `providersOf("storage")` and `interactionsOf("storage-access", "storage")`.
- `coverage/responseMatch.ts` provides the `makeSide` helper for the location strings on findings.
