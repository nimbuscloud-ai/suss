# Where protocol knowledge lives

A protocol's behavior is defined in three places: its semantics module
under `packages/ir-core/src/semantics/`, the packs that write its
bindings, and its own checker module. Everything else is generic and
gets protocol behavior by dispatching through the registry. Several
bugs we shipped came from the same mistake. A generic file compared
`semantics.name` to a string, or reached into one protocol's helper to
compute something that belongs to no protocol. The mechanisms below
prevent that.

## Two failures that set the rule

**The suppression normalizer broke message-bus rules.** The shared
helper assumed any boundary string with a space in it was
`METHOD path`, and uppercased it. A message-bus key also has a space,
and it is case-sensitive. So a hand-edited rule was normalized into a
key that could never match, and it stopped firing without any warning
(#145). We did not fix it with a smarter guess. The definitions gained
`ruleBoundary`. REST claims strings of the form `METHOD /path` and
accepts the variant spellings authors use, and a string no protocol
claims is compared byte for byte.

**A wildcard route captured Promise.all.** Units discovered through a
registration call get the verb as their name, and name-based call
linking indexed those names like any other. So one `.all` route made
every `Promise.all` call link to it. The first attempted fix reached
into the REST method map to rename the unit. That tied generic naming
to one protocol's vocabulary, and it would have left `get` and `post`
colliding. The fix we accepted records where a name came from.
Discovery marks a name it made up as a label (`identity.nameKind`),
and every name index skips labels.

## The mechanisms

**The semantics registry.** Each protocol has one module that declares
a schema and a behavior: `identityKey`, `pairingKey`, `sidesAgree`,
`displayLabel`, `ruleBoundary`, `servesRequest`,
`exchangesHttpResponses`, `reportsUnpairedItself`. The registry
combines them and checks at compile time that every protocol defines
every member. Generic code calls `boundaryKey`, `pairingKey`,
`semanticsAgree`, `displayLabel` or `normalizeRuleBoundary` without
knowing which protocol's implementation runs. To add protocol
behavior to a generic surface, you add a member here instead of a
branch somewhere else.

Two of those members are required, because there is no safe default
for them. Each protocol declares whether its two sides exchange an
HTTP response. Every status-code and response-body check needs to know
that before its result means anything. Each protocol also declares
whether its own pass already reports the boundaries that paired with
nothing. A protocol added later has to declare both. That way, it is
left out of the HTTP checks because it said so, and nobody has to
remember to exclude it (#150, #148).

**Name provenance.** Discovery records whether a unit's name is a
binding other code can call or a label made up for the reader. The
marker is saved on the summary, so cached runs agree with cold ones.
Both name indexes, call linking and inspect's follow references, skip
labels.

**Metadata namespaces as schemas.** The metadata a contract reader
writes and a checker reads back goes through one schema that both
sides import. Writes are strict and throw right where the bad value
came from. Reads are lenient field by field, so an old artifact keeps
whatever fields still parse. `messageBus`, `runtimeContract` and
`graphql` are done, and the rest of #121 follows the same pattern.

**A pack hardcodes only what its library defines.** Method names,
resource types and decorator names come from the library, and project
names come from per-project config. `npm run check:vocabulary`
enforces this. Every identifier a pack ships has to appear in that
pack's vocabulary.json, with a note saying where the library defines
it.

## What CI holds

- `check:dispatch` fails the build when a generic file gains a branch
  on a protocol name. Packs and per-protocol checker modules are
  always allowed. The generic places that already had such a branch
  have counts that can only go down, and each one is a place where a
  registry member should replace an if (#147 is the one left). The
  check matches line by line and does not parse, so it misses a
  comparison split across two lines, or a switch on the name (#164).
- `check:vocabulary` enforces the rule about hardcoded identifiers.
- If someone adds a protocol to the union without a definition, or a
  definition without adding it to the union, the registry's
  completeness check makes that a compile error.

Some questions have no check. Does a new field belong on the semantics
schema or in a metadata namespace? Is a helper generic, or quietly
built around REST? Is a difference in display drift, or a label that
is richer on purpose? Reviewers decide those, and the worked examples
above are the ones to compare against.
