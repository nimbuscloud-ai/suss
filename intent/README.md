# Intent specs — suss checking itself

Boundary intent (`kind: boundary`) for the public export surface of the
two checker packages. `npm run check:self` extracts those packages'
exports as `library` summaries and pairs each intent against them by
`fn:<package>::<exportPath>` key.

| File | Boundary | Keyed |
|---|---|---|
| `checker-checkAll.intent.yaml` | `fn:@suss/checker::checkAll` | yes |
| `checker-checkPair.intent.yaml` | `fn:@suss/checker::checkPair` | yes |
| `checker-dedupeFindings.intent.yaml` | `fn:@suss/checker::dedupeFindings` | yes |
| `checker-intent-checkIntentAgreement.intent.yaml` | `fn:@suss/checker-intent::checkIntentAgreement` | yes |
| `checker-intent-applyIntentSuppressions.intent.yaml` | `fn:@suss/checker-intent::applyIntentSuppressions` | yes |
| `checker-describeBinding.intent.yaml` | internal helper (module + exportName) | no — `unkeyableBoundary` |

`self.sussignore.yml` marks the one unkeyable boundary (the accepted
module-level keying gap). `scripts/checkSelf.mjs` copies it into the
generated summaries directory because `suss check` auto-discovers
suppressions there.

Authoring friction and open gaps are logged in
[`docs/internal/dogfood-intent-notes.md`](../docs/internal/dogfood-intent-notes.md).
