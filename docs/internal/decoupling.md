# Where protocol knowledge lives

A protocol's behavior lives in three places: its semantics module
under `packages/ir-core/src/semantics/`, the packs that write its
bindings, and its own checker module. Everything else is generic and
gets protocol behavior by dispatching through the registry. A generic
file that compares `semantics.name` to a string, or reaches into one
protocol's helper to compute something protocol-neutral, is the bug
shape behind several shipped defects, and this page names the
mechanisms that prevent it.

## Two failures that set the rule

**The suppression normalizer ate message-bus rules.** The shared
helper assumed any boundary string with a space was `METHOD path` and
uppercased it. A message-bus key also has a space and is
case-sensitive, so a hand-edited rule normalized into a key that
could never match and silently stopped firing (#145). The fix was
not a smarter guess: the definitions gained `ruleBoundary`, REST
claims `METHOD /path` strings and forgives author spellings, and an
unclaimed string compares byte for byte.

**A wildcard route swallowed Promise.all.** Units discovered through
a registration call are named after the verb, and name-based call
linking indexed those names like any other, so one `.all` route made
every `Promise.all` call link to it. The first attempted fix reached
into the REST method map to rename the unit, which coupled generic
naming to one protocol's vocabulary and would have left `get` and
`post` colliding. The accepted fix is provenance: discovery marks a
coined name as a label (`identity.nameKind`), and every name index
skips labels.

## The mechanisms

**The semantics registry.** One module per protocol declares a schema
and a behavior: `identityKey`, `pairingKey`, `sidesAgree`,
`displayLabel`, `ruleBoundary`, `servesRequest`,
`exchangesHttpResponses`, `reportsUnpairedItself`. The registry
composes them with a compile-time completeness check, and generic code
calls `boundaryKey`, `pairingKey`, `semanticsAgree`, `displayLabel`,
or `normalizeRuleBoundary` without knowing which protocol answers.
Adding protocol behavior to a generic surface means adding a member
here, not a branch there.

Two of those members are declared rather than optional, because the
question they answer has no safe default. A protocol says whether its
two sides exchange an HTTP response, which is what every status-code
and response-body check needs before it means anything, and whether
its own pass already reports the boundaries that paired with nothing.
A protocol added later has to answer both, so it is left out of the
HTTP-shaped checks by saying so rather than by someone remembering to
exclude it (#150, #148).

**Name provenance.** Discovery says whether a unit's name is a
binding other code can call or a label coined for the reader. The
marker persists on the summary, so cached runs agree with cold ones,
and both name indexes (call linking, inspect's follow references)
skip labels.

**Metadata namespaces as schemas.** The metadata a contract reader
writes and a checker reads back goes through one schema both sides
import: strict writes that throw beside their cause, per-field
lenient reads so an old artifact keeps the fields that still parse.
`messageBus`, `runtimeContract`, `graphql` are done; the rest of
#121 follows the same shape.

**A pack hardcodes only what its library defines.** Method names,
resource types, and decorator names come from the library; project
names come from per-project config. `npm run check:vocabulary`
enforces it: every identifier a pack ships has to appear in that
pack's vocabulary.json with a note saying where the library defines
it.

## What CI holds

- `check:dispatch` fails the build when a generic file gains a
  protocol-name branch. Packs and per-protocol checker modules are
  allowed outright; the pre-existing generic sites carry counts that
  only go down, each one a place a registry member should replace an
  if (#147 is the one left). It matches per line rather than parsing,
  so a comparison split across two lines or a switch on the name goes
  past it (#164).
- `check:vocabulary` holds the hardcoding rule.
- The registry's completeness check makes a protocol added to the
  union without a definition, or the reverse, a compile error.

What no check holds: whether a new field belongs on the semantics
schema or in a metadata namespace, whether a helper is generic or
secretly REST-shaped, and when a display difference is drift versus
a deliberate richer label. Those stay review judgment; the worked
examples above are the calibration.
