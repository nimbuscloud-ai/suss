# Where protocol knowledge lives

A protocol's behavior lives in three places: its semantics module
under `packages/ir-core/src/semantics/`, the packs that write its
bindings, and its own checker module. Everything else is generic and
gets protocol behavior by dispatching through the registry. Several
defects we shipped came from the same mistake: a generic file that
compares `semantics.name` to a string, or that reaches into one
protocol's helper to compute something no protocol owns. Below are
the mechanisms that prevent it.

## Two failures that set the rule

**The suppression normalizer ate message-bus rules.** The shared
helper assumed any boundary string with a space was `METHOD path` and
uppercased it. A message-bus key also has a space and is
case-sensitive, so a hand-edited rule got normalized into a key that
could never match, and it silently stopped firing (#145). We did not
fix it with a smarter guess. The definitions gained `ruleBoundary`:
REST claims `METHOD /path` strings and forgives the spellings authors
use, and a string no protocol claims is compared byte for byte.

**A wildcard route swallowed Promise.all.** Units discovered through
a registration call are named after the verb, and name-based call
linking indexed those names like any other, so one `.all` route made
every `Promise.all` call link to it. The first attempted fix reached
into the REST method map to rename the unit, which coupled generic
naming to one protocol's vocabulary and would have left `get` and
`post` colliding. The fix we accepted tracks where a name came from:
discovery marks a coined name as a label (`identity.nameKind`), and
every name index skips labels.

## The mechanisms

**The semantics registry.** One module per protocol declares a schema
and a behavior: `identityKey`, `pairingKey`, `sidesAgree`,
`displayLabel`, `ruleBoundary`, `servesRequest`,
`exchangesHttpResponses`, `reportsUnpairedItself`. The registry
composes them with a compile-time completeness check, and generic code
calls `boundaryKey`, `pairingKey`, `semanticsAgree`, `displayLabel`,
or `normalizeRuleBoundary` without knowing which protocol is
answering. Adding protocol behavior to a generic surface means adding
a member here, not a branch there.

Two of those members are declared rather than optional, because the
question they answer has no safe default. Each protocol says whether
its two sides exchange an HTTP response, which every status-code and
response-body check has to know before it means anything, and whether
its own pass already reports the boundaries that paired with nothing.
A protocol added later has to answer both questions. That way it gets
left out of the HTTP-shaped checks because it said so, not because
someone remembered to exclude it (#150, #148).

**Name provenance.** Discovery records whether a unit's name is a
binding other code can call or a label coined for the reader. The
marker persists on the summary, so cached runs agree with cold ones,
and both name indexes (call linking, inspect's follow references)
skip labels.

**Metadata namespaces as schemas.** The metadata a contract reader
writes and a checker reads back goes through one schema both sides
import: writes are strict and throw next to their cause, and reads
are lenient per field, so an old artifact keeps whatever fields still
parse. `messageBus`, `runtimeContract` and `graphql` are done, and
the rest of #121 follows the same pattern.

**A pack hardcodes only what its library defines.** Method names,
resource types, and decorator names come from the library, and
project names come from per-project config. `npm run check:vocabulary`
enforces it: every identifier a pack ships has to appear in that
pack's vocabulary.json with a note saying where the library defines
it.

## What CI holds

- `check:dispatch` fails the build when a generic file gains a
  protocol-name branch. Packs and per-protocol checker modules are
  allowed outright. The generic sites that already existed have
  counts that only go down, and each one is a place where a registry
  member should replace an if (#147 is the one left). It matches line
  by line rather than parsing, so a comparison split across two lines,
  or a switch on the name, gets past it (#164).
- `check:vocabulary` enforces the hardcoding rule.
- If someone adds a protocol to the union without a definition, or
  the reverse, the registry's completeness check makes it a compile
  error.

No check covers these: whether a new field belongs on the semantics
schema or in a metadata namespace, whether a helper is generic or
secretly built around REST, and when a difference in display is drift
rather than a deliberately richer label. Those stay a matter of review
judgment, and the worked examples above are what you calibrate
against.
