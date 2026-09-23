# Intent specs, suss checking itself

Boundary intent (`kind: boundary`) for the public exports of the two
checker packages. `npm run check:self` extracts those packages' exports
with the `package-exports` pack, and pairs each intent with them by the
key `fn:<package>::<exportPath>`. Every step goes through the published
CLI, so a change that breaks `suss extract` or `suss check` breaks this
too.

| File | Boundary |
|---|---|
| `checker-checkAll.intent.yaml` | `fn:@suss/checker::checkAll` |
| `checker-checkPair.intent.yaml` | `fn:@suss/checker::checkPair` |
| `checker-dedupeFindings.intent.yaml` | `fn:@suss/checker::dedupeFindings` |
| `checker-intent-checkIntentAgreement.intent.yaml` | `fn:@suss/checker-intent::checkIntentAgreement` |
| `checker-intent-applyIntentSuppressions.intent.yaml` | `fn:@suss/checker-intent::applyIntentSuppressions` |

These are the boundaries another package can call. A module-level
helper inside one of these packages has no intent document, because
nothing outside the module sees it, and the self-check only extracts
what the package publishes. Issue #760 has the history.

Problems writing these documents, and open gaps, are logged in
[`design/dogfood-intent-notes.md`](../design/dogfood-intent-notes.md).
