# Proposal: typed claims

Status: direction decided (2026-08-05), details open where marked.
Came out of a six-angle dispatched review; every bug cited below was
verified, most with executed reproductions.

## The bug this kills, shown three ways

Two services live in one monorepo. Service A declares `users(id,
name)`. Service B declares its own `users(id, email)`. Run `suss
check` over both and it reports, at error severity, that A's code
reads a column that does not exist. It checked A's code against B's
schema. A storage table's identity is `(storageSystem, scope, table)`,
scope defaults to `"default"`, both services left the default, so two
unrelated tables carried one identity.

Storybook has the same failure with different nouns. Two `Button`
components in different folders land in a map keyed on the bare name.
The second silently shadows the first, and a story gets checked
against the wrong component's props.

And inspect draws a false arrow. `Counter`'s click handler calls its
own `onChange` prop, and the rendering links it to `Form`'s unrelated
`onChange` in another file, because the arrow resolves by last name
segment across the whole summary set. The docs describe the arrow as
exact. `identity.id` exists on summaries precisely to fix name
collisions, and nothing in the checker or the CLI reads it.

One more, quieter: the CFN reader writes `metadata.messageBus.queue`
and the checker casts the bag and reads it back. Rename the key on
either side and no error fires anywhere. The finding evaporates.

## The rule

A claim two parties share is a type both import. A convention is a bug
that has not fired yet. The repo has proven both halves of this twice
in one week: the empty-string identity convention failed four times
and died the day identity fields became nullable with the empty string
rejected; the semantics registry moved every protocol's keying and
agreement into one typed module each, and the checkers stopped being
able to disagree about what a protocol means.

## The three surfaces still living on convention

### 1. Metadata namespaces

Today: at least 8 producer sites and 9 consumer sites hand-cast the
same shapes (`metadata.runtimeContract`, `messageBus`, `http`,
`graphql`, `storageContract`, `react`, `component`, `awsLambda`,
`appsync`, `effectsClosure`). The change: one zod schema per
namespace, exported from behavioral-ir, with a builder and a reader:

```ts
// producer
summary.metadata = withMessageBusMetadata(summary.metadata, {
  queue: "OrdersQueue",
  patternResolution: "exact",
});

// consumer
const bus = readMessageBusMetadata(summary);   // typed or undefined
```

A renamed field becomes a compile error at both ends. The namespaces
also become documentable in one place, which closes a hole the
legibility review found: several namespaces the pipeline depends on
appear in no doc at all.

### 2. References by id

Today: `summaryRef` builds `file::name` and ignores `identity.id`;
findings and inspect link by that string; id is stamped on some
discovery paths and absent on contract readers and package discovery.
The change: every producer stamps `id`; `summaryRef` returns it;
finding sides carry it; inspect resolves arrows through it plus an
actual call fact rather than a name match. Parsing backfills a
deterministic id for older artifacts, the same way `schemaVersion`
normalization already works, so published summaries keep reading.

### 3. Identity completeness at the bottom

`storageRelationalBinding` still types `table` as a plain string, so
prisma and drizzle cannot record an access to a table they could not
name; drizzle substitutes raw source text instead, which can pair
wrongly. The builder takes `string | null` through `namedOrNull` like
its siblings. Storage `scope` stops pretending to disambiguate: when
it is the documented default, pairing must also agree on workspace or
deployable unit before it compares fields (details open). Storybook
component identity gains the module path next to the name.

## What this retires

The storage cross-service false errors, the storybook shadowing, the
inspect false arrows, the silent metadata evaporation, and drizzle's
wrong-table pairing. All five are verified, and none is fixable at
its own site without leaving the class alive.

## Sequencing

Metadata schemas first (mechanical, compile-guided, no artifact
change). References second (artifact change, rides the schemaVersion
machinery landed in PR #117). Builder completeness third, with the
storage-scope pairing rule as its design question.

## Open questions

1. Storage scope: agree on workspace, on deployable unit, or make
   scope required when more than one workspace is present?
2. Id shape for contract readers, which have no function to hash:
   file plus logical id is the likely answer, decided in the design
   pass.
