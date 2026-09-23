# Proposal: typed claims

Status: direction decided (2026-08-05), details open where marked.
This came out of a six-angle dispatched review. We verified every bug
cited below, most of them by running a reproduction.

## The bug this fixes, shown three ways

Two services live in one monorepo. Service A declares `users(id,
name)`. Service B declares its own `users(id, email)`. Run `suss
check` over both and it reports, at error severity, that A's code
reads a column that does not exist. It checked A's code against B's
schema. A storage table's identity is `(storageSystem, scope, table)`,
and scope defaults to `"default"`. Both services left the default, so
two unrelated tables ended up with one identity.

Storybook fails the same way with different names. Two `Button`
components in different folders land in a map keyed on the bare name.
The second silently shadows the first, and a story gets checked
against the wrong component's props.

And inspect draws a false arrow. `Counter`'s click handler calls its
own `onChange` prop, and the rendering links it to `Form`'s unrelated
`onChange` in another file, because the arrow resolves by last name
segment across the whole summary set. The docs describe the arrow as
exact. `identity.id` exists on summaries to fix exactly this kind of
name collision, and nothing in the checker or the CLI reads it.

A fourth case is quieter. The CFN reader writes
`metadata.messageBus.queue`, and the checker casts the metadata bag and
reads it back. If someone renames the key on either side, no error
fires anywhere, and the finding silently disappears.

## The rule

When two parties share a claim, it should be a type both import. A
convention is a bug that has not fired yet. We proved both halves of
this twice in one week. The empty-string identity convention failed
four times, and it ended the day identity fields became nullable and
the empty string was rejected. Then the semantics registry moved each
protocol's keying and agreement into one typed module, and after that
the checkers could no longer disagree about what a protocol means.

## Three places that still rely on convention

### 1. Metadata namespaces

Today at least 8 producer sites and 9 consumer sites hand-cast the
same structures (`metadata.runtimeContract`, `messageBus`, `http`,
`graphql`, `storageContract`, `react`, `component`, `awsLambda`,
`appsync`). The change is one zod schema per
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

A renamed field becomes a compile error at both ends. We can also
document the namespaces in one place. That fixes a gap the legibility
review found: several namespaces the pipeline depends on are not
documented anywhere.

### 2. References by id

Today `summaryRef` builds `file::name` and ignores `identity.id`, and
findings and inspect link by that string. Some discovery paths stamp an
id, and contract readers and package discovery do not. The change is
that every producer stamps `id`, `summaryRef` returns it, and finding
sides include it. Inspect then resolves arrows through the id plus an
actual call fact, instead of by matching names. Parsing backfills a
deterministic id for older artifacts, the same way `schemaVersion`
normalization already works, so published summaries can still be read.

### 3. Identity completeness at the bottom

`storageRelationalBinding` still types `table` as a plain string, so
prisma and drizzle cannot record an access to a table whose name they
could not read. Drizzle puts raw source text there instead, which can
pair wrongly. The builder should take `string | null` through
`namedOrNull`, like its siblings. Storage `scope` stops being treated
as though it tells tables apart: when it is the documented default,
pairing must also agree on workspace or deployable unit before it
compares fields (details open). Storybook component identity gains the
module path next to the name.

## What this retires

This retires five bugs: the storage cross-service false errors, the
storybook shadowing, the inspect false arrows, the metadata that
silently disappears, and drizzle's wrong-table pairing. We verified all
five. Fixing any one of them where it happens would leave the rest of
the class in place.

## Sequencing

Metadata schemas go first. The work is mechanical, the compiler guides
it, and the artifact does not change. References go second, because
they change the artifact; they use the `schemaVersion` machinery that
landed in PR #117. Builder completeness goes third, and its design
question is the storage-scope pairing rule.

## Open questions

1. Storage scope: agree on workspace, on deployable unit, or make
   scope required when more than one workspace is present?
2. What an id looks like for contract readers, which have no function
   to hash. File plus logical id is the likely answer, and the design
   pass decides it.
